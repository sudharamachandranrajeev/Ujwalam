// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI server security tests (v1 F2): Host/Origin/CSRF/cookie, login key, confirmation channel, no backend token
// reaches the page, static path traversal. Uses a stub core and the in-memory fake host; no real backend, no network
// beyond 127.0.0.1.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { audioReadiness, createStudioServer, HOST_CALLS } from '../services/studio-ui/server.mjs';
import { writeSettings } from '../services/studio-ui/user-settings.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const REPO = path.resolve(UI, '..');
const KEY = 'k'.repeat(48);
const CORE_TOKEN = 'c0ffee'.repeat(10) + 'abcd'; // a stand-in backend token: must never appear in any response
const CONFIRM_ID = 'a'.repeat(32);
const ACTION_HASH = 'b'.repeat(64);

function raw(port, { method = 'GET', url = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: host ?? `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) { h['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function setup({ outputsReady = true, limits } = {}) {
  const calls = { core: [], host: [] };
  let live = false;
  const fake = createFakeHost({ outputsReady });
  const host = {
    describe: () => fake.describe(),
    call: async (m, p) => { calls.host.push(m); const r = await fake.call(m, p); if (m === 'stream.start') live = true; return m === 'host.status' ? { ...r, live } : r; },
  };
  const core = {
    describe: () => ({ available: true, reachable: true }),
    call: async (m, p) => { calls.core.push([m, p]); if (m === 'core.status') return { live: { liveState: 'offline', panic: false }, secret: CORE_TOKEN }; return { verdict: 'confirm', reason: 'confirmation-required', confirm: { confirmId: CONFIRM_ID, phrase: 'yes', actionHash: ACTION_HASH } }; },
    confirm: async (c) => { calls.core.push(['actions.confirm', c]); return { verdict: 'allow', reason: 'confirmed', dispatch: { ok: true } }; },
  };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, limits });
  return { srv, calls };
}

async function login(port) {
  const r = await raw(port, { url: `/login?k=${KEY}` });
  assert.equal(r.status, 302);
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: JSON.parse(s.text).csrf, loginHeaders: r.headers };
}
const post = (port, a, route, body, extra = {}) => raw(port, {
  method: 'POST', url: route, body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { cookie: a.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf, ...extra },
});

describe('login and session', () => {
  let ctx, port;
  before(async () => { ctx = setup(); ({ port } = await ctx.srv.listen()); });
  after(() => ctx.srv.close());

  test('no cookie: 401 for the page and the API', async () => {
    assert.equal((await raw(port, { url: '/' })).status, 401);
    assert.equal((await raw(port, { url: '/ui/api/status' })).status, 401);
    assert.equal((await raw(port, { url: '/js/app.js' })).status, 401);
  });
  test('wrong Host header refused (DNS rebinding)', async () => {
    assert.equal((await raw(port, { url: `/login?k=${KEY}`, host: `evil.test:${port}` })).status, 403);
    assert.equal((await raw(port, { url: '/', host: `localhost:${port}` })).status, 403);
  });
  test('cross-site navigation refused', async () => {
    assert.equal((await raw(port, { url: `/login?k=${KEY}`, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });
  test('OPTIONS refused and no CORS headers anywhere', async () => {
    const r = await raw(port, { method: 'OPTIONS', url: '/ui/api/host', headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' } });
    assert.equal(r.status, 405);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });
  test('wrong key 401; correct key sets an HttpOnly SameSite=Strict cookie; key is single use', async () => {
    assert.equal((await raw(port, { url: `/login?k=${'x'.repeat(48)}` })).status, 401);
    const r = await raw(port, { url: `/login?k=${KEY}` });
    assert.equal(r.status, 302);
    const c = r.headers['set-cookie'][0];
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Path=\//);
    assert.doesNotMatch(c, new RegExp(KEY));
    assert.equal((await raw(port, { url: `/login?k=${KEY}` })).status, 401);
  });
  test('cookie works; a forged cookie does not', async () => {
    const r = await raw(port, { url: `/login?k=${KEY}` }); // key already used above: this is 401, so build a new server
    assert.equal(r.status, 401);
    const c2 = setup(); const { port: p2 } = await c2.srv.listen();
    try {
      const a = await login(p2);
      assert.equal((await raw(p2, { url: '/', headers: { cookie: a.cookie } })).status, 200);
      assert.equal((await raw(p2, { url: '/', headers: { cookie: `ujwalam_ui=${'0'.repeat(64)}` } })).status, 401);
    } finally { await c2.srv.close(); }
  });
  test('security headers on every kind of response', async () => {
    const r = await raw(port, { url: '/' });
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
  });
});

describe('login rate limit and key expiry', () => {
  test('five wrong keys lock login, even for the right key', async () => {
    const c = setup(); const { port } = await c.srv.listen();
    try {
      for (let i = 0; i < 5; i++) assert.equal((await raw(port, { url: `/login?k=${'x'.repeat(48)}` })).status, 401);
      assert.equal((await raw(port, { url: `/login?k=${KEY}` })).status, 429);
    } finally { await c.srv.close(); }
  });
  test('an expired launch key is refused', async () => {
    let t = 1_000_000;
    const host = createFakeHost();
    const srv = createStudioServer({ uiRoot: UI, core: { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } }, host, launchKey: KEY, now: () => t, limits: { launchKeyTtlMs: 1000 } });
    const { port } = await srv.listen();
    try { t += 5000; assert.equal((await raw(port, { url: `/login?k=${KEY}` })).status, 401); } finally { await srv.close(); }
  });
});

describe('mutating API', () => {
  let ctx, port, a;
  before(async () => { ctx = setup(); ({ port } = await ctx.srv.listen()); a = await login(port); });
  after(() => ctx.srv.close());

  test('POST needs Origin, CSRF header, JSON, size limit', async () => {
    const route = '/ui/api/host', body = { method: 'scenes.list' };
    assert.equal((await post(port, a, route, body, { origin: 'http://evil.test' })).status, 403);
    assert.equal((await raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf } })).status, 403, 'no Origin');
    assert.equal((await post(port, a, route, body, { 'x-ujwalam-csrf': 'nope' })).status, 403);
    assert.equal((await raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie: a.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } })).status, 403, 'no csrf');
    assert.equal((await post(port, a, route, body, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(port, a, route, 'x'.repeat(20_000))).status, 413);
    assert.equal((await post(port, a, route, '{not json')).status, 400);
    assert.equal((await post(port, a, route, body)).status, 200);
  });
  test('a CSRF header without the cookie is not enough', async () => {
    const r = await raw(port, { method: 'POST', url: '/ui/api/host', body: '{"method":"scenes.list"}', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf } });
    assert.equal(r.status, 401);
  });
  test('only allowlisted host methods with valid params', async () => {
    const route = '/ui/api/host';
    for (const method of ['host.shutdown', 'project.load', 'outputs.configure', 'encoders.probe', '__proto__', 'constructor']) assert.equal((await post(port, a, route, { method })).status, 400, method);
    assert.equal((await post(port, a, route, { method: 'layers.move', params: { scene: 's', layer: 'l', index: -1 } })).status, 400);
    assert.equal((await post(port, a, route, { method: 'scenes.activate', params: { scene: '../x' } })).status, 400);
    assert.equal((await post(port, a, route, { method: 'scenes.list', params: { extra: 1 } })).status, 400);
    assert.equal((await post(port, a, route, { method: 'mixer.setVolume', params: { id: 'scene-1/cam', db: 12 } })).status, 400);
    assert.equal((await post(port, a, route, { method: 'mixer.setVolume', params: { id: 'nocolon', db: -3 } })).status, 400);
    assert.equal((await post(port, a, route, { method: 'mixer.setVolume', params: { id: 'scene-1/cam', db: -3 } })).status, 200);
    // inspector: nested placement patch, every field range-checked; no unknown keys, no empty patch
    const sp = (placement) => post(port, a, route, { method: 'layers.setPlacement', params: { scene: 's', layer: 'l', placement } });
    for (const bad of [{}, { width: 0 }, { x: 1e6 }, { opacity: 0.5 }, { crop: { left: -1 } }, { crop: { inner: 1 } }, { crop: {} }, { rotation: '5' }, []]) assert.equal((await sp(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post(port, a, route, { method: 'layers.setPlacement', params: { scene: 's', layer: 'l' } })).status, 400, 'placement required');
    assert.ok(Object.keys(HOST_CALLS).every((k) => !/^(host|project|outputs|encoders)\./.test(k)));
  });
  test('stream start acts on the click (D332): no phrase, no pending entry; the host is called once', async () => {
    const before = ctx.calls.host.filter((m) => m === 'stream.start').length;
    const ok = JSON.parse((await post(port, a, '/ui/api/host', { method: 'stream.start' })).text);
    assert.equal(ok.verdict, 'allow');
    assert.equal(ok.pending, undefined);
    assert.equal(ctx.calls.host.filter((m) => m === 'stream.start').length, before + 1);
  });
  test('confirm and cancel need a known pending id: unknown, used or cancelled ids get 410', async () => {
    const r = JSON.parse((await post(port, a, '/ui/api/core/request', { id: 'chat.raw.purge', params: {} })).text);
    assert.equal(r.verdict, 'confirm');
    assert.equal((await post(port, a, '/ui/api/cancel', { pendingId: r.pending.pendingId })).status, 200);
    assert.equal((await post(port, a, '/ui/api/confirm', { pendingId: r.pending.pendingId })).status, 410);
    assert.equal((await post(port, a, '/ui/api/confirm', { pendingId: 'f'.repeat(32) })).status, 410);
  });
  test('core approval: ids and hashes stay server-side; one Allow click (pendingId only) triggers actions.confirm', async () => {
    const r = await post(port, a, '/ui/api/core/request', { id: 'chat.raw.purge', params: { all: true } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(CONFIRM_ID) && !r.text.includes(ACTION_HASH), 'confirmId/actionHash must not reach the page');
    const j = JSON.parse(r.text);
    assert.equal(j.verdict, 'confirm'); assert.equal(j.pending.phrase, undefined, 'no phrase');
    assert.ok(!ctx.calls.core.some(([m]) => m === 'actions.confirm'));
    const ok = JSON.parse((await post(port, a, '/ui/api/confirm', { pendingId: j.pending.pendingId })).text);
    assert.equal(ok.verdict, 'allow');
    const c = ctx.calls.core.find(([m]) => m === 'actions.confirm');
    assert.deepEqual(c[1], { confirmId: CONFIRM_ID, actionHash: ACTION_HASH });
    assert.equal((await post(port, a, '/ui/api/confirm', { pendingId: j.pending.pendingId })).status, 410, 'single use');
    assert.equal((await post(port, a, '/ui/api/core/request', { id: 'Bad Id' })).status, 400);
  });
});

describe('no backend token reaches the page', () => {
  test('session, status, events, static files and errors never contain backend secrets', async () => {
    const c = setup(); const { port } = await c.srv.listen();
    try {
      const a = await login(port);
      const texts = [];
      for (const u of ['/', '/index.html', '/js/app.js', '/js/api.js', '/js/dom.js', '/css/app.css', '/ui/api/session', '/ui/api/status']) texts.push((await raw(port, { url: u, headers: { cookie: a.cookie } })).text);
      texts.push(JSON.stringify(a.loginHeaders));
      await new Promise((r) => setTimeout(r, 50));
      const sse = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/ui/api/events', headers: { host: `127.0.0.1:${port}`, cookie: a.cookie } }, (res) => {
          let buf = '';
          res.on('data', (d) => { buf += d; if (buf.includes('event: status')) { req.destroy(); resolve(buf); } });
          setTimeout(() => { req.destroy(); resolve(buf); }, 1500);
        });
        req.on('error', () => {});
      });
      texts.push(sse);
      assert.match(sse, /event: status/);
      for (const t of texts) { assert.ok(!t.includes(CORE_TOKEN), 'core secret leaked'); assert.ok(!t.includes(KEY), 'launch key leaked'); }
      // the page code itself holds no credential material and never uses innerHTML
      for (const u of ['/js/app.js', '/js/api.js', '/js/dom.js']) {
        const t = (await raw(port, { url: u, headers: { cookie: a.cookie } })).text;
        assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(t), `${u} uses unsafe DOM`);
        assert.ok(!/Authorization|Bearer/i.test(t), `${u} handles an auth header`);
      }
    } finally { await c.srv.close(); }
  });
  test('status snapshot is text-free (only known fields)', async () => {
    const c = setup(); const { port } = await c.srv.listen();
    try {
      const a = await login(port);
      const s = JSON.parse((await raw(port, { url: '/ui/api/status', headers: { cookie: a.cookie } })).text);
      assert.deepEqual(Object.keys(s.core).sort(), ['available', 'liveState', 'panic']);
      assert.ok(!JSON.stringify(s).includes('secret'));
    } finally { await c.srv.close(); }
  });
});

describe('static files', () => {
  let ctx, port, a;
  before(async () => { ctx = setup(); ({ port } = await ctx.srv.listen()); a = await login(port); });
  after(() => ctx.srv.close());
  const get = (u) => raw(port, { url: u, headers: { cookie: a.cookie } });

  test('serves the page and assets with the right type', async () => {
    const r = await get('/');
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/html/);
    assert.match((await get('/css/tokens.css')).headers['content-type'], /text\/css/);
  });
  test('path traversal and odd paths are refused', async () => {
    for (const u of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/css/../../package.json', '/js/%2e%2e/%2e%2e/package.json', '/..\\package.json', '/css%5c..%5c..%5cpackage.json', '/%00', '/index.html%00.js', '/.git/config', '/js/.hidden.js', '//etc/passwd', '/css//tokens.css']) {
      const r = await get(u);
      assert.ok([400, 404].includes(r.status), `${u} -> ${r.status}`);
      assert.ok(!r.text.includes('"name": "ujwalam"'), `${u} leaked package.json`);
    }
  });
  test('only allowlisted extensions; directories and POST refused', async () => {
    assert.equal((await get('/js')).status, 404);
    assert.equal((await get('/js/')).status, 404);
    assert.equal((await get('/js/app.js.map')).status, 404);
    assert.equal((await raw(port, { method: 'POST', url: '/index.html', headers: { cookie: a.cookie } })).status, 405);
    assert.equal((await get('/ui/secret')).status, 404);
  });
});

describe('listening address and SSE cap', () => {
  test('binds 127.0.0.1 only', async () => {
    const c = setup(); const { port } = await c.srv.listen();
    try { assert.equal(c.srv.server.address().address, '127.0.0.1'); assert.ok(port > 0); } finally { await c.srv.close(); }
  });
  test('SSE client cap returns 429', async () => {
    const c = setup({ limits: { sseMaxClients: 1 } }); const { port } = await c.srv.listen();
    try {
      const a = await login(port);
      const first = http.get({ host: '127.0.0.1', port, path: '/ui/api/events', headers: { host: `127.0.0.1:${port}`, cookie: a.cookie } });
      await new Promise((resolve) => first.on('response', resolve));
      const second = await raw(port, { url: '/ui/api/events', headers: { cookie: a.cookie } });
      assert.equal(second.status, 429);
      first.destroy();
    } finally { await c.srv.close(); }
  });
});

describe('Meld import and project.load', () => {
  const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project', 'meld-minimal.session.json');
  async function importSetup({ sessionFile = FIXTURE } = {}) {
    const { mkdtempSync, readdirSync } = await import('node:fs');
    const os = await import('node:os');
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-ui-'));
    const calls = [];
    let conflicts = 2;
    const host = {
      describe: () => ({ kind: 'host', available: true }),
      call: async (m, p) => {
        calls.push([m, p]);
        if (m === 'host.status') return { live: false, recording: false };
        if (m === 'project.plan') return { unavailable: [{ x: 1 }, { x: 2 }], warnings: [], devicesListed: [{ name: 'PERSONAL DEVICE NAME' }], flags: { devices: false } };
        if (m === 'project.load') { if (conflicts-- > 0) throw Object.assign(new Error('conflict'), { code: 'RPC_-32009' }); return { built: { scenes: 2, sources: 3 }, unavailable: [1, 2] }; }
        return {};
      },
    };
    const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, sessionFile, limits: { loadRetryMs: [1, 1, 1] } });
    const { port } = await srv.listen();
    const a = await login(port);
    return { srv, port, a, calls, dataDir, files: () => readdirSync(path.join(dataDir, 'projects')) };
  }

  test('import creates a NEW project file, plans on the host, returns counts only', async () => {
    const c = await importSetup();
    try {
      const r = await post(c.port, c.a, '/ui/api/project/import-meld', {});
      assert.equal(r.status, 200, r.text);
      const j = JSON.parse(r.text);
      assert.equal(j.plan.unavailable, 2); assert.equal(j.plan.warnings, 0);
      assert.ok(j.imported.counts.scenes >= 1);
      assert.ok(!r.text.includes('PERSONAL DEVICE NAME'), 'device names must not reach the page');
      const f1 = c.files(); assert.equal(f1.filter((n) => n.endsWith('.project.json')).length, 1);
      assert.ok(c.calls.some(([m, p]) => m === 'project.plan' && p.project));
      assert.ok(!c.calls.some(([m]) => m === 'project.load'), 'import alone never loads');
    } finally { await c.srv.close(); }
  });
  test('the page cannot choose the session path; no session configured -> 503', async () => {
    const c = await importSetup({ sessionFile: null });
    try {
      assert.equal((await post(c.port, c.a, '/ui/api/project/import-meld', { path: 'C:/x.json' })).status, 503);
    } finally { await c.srv.close(); }
  });
  test('load needs an import first, then acts on the click (D332); retries on -32009; project stays server-side', async () => {
    const c = await importSetup();
    try {
      assert.equal((await post(c.port, c.a, '/ui/api/project/load', {})).status, 409);
      await post(c.port, c.a, '/ui/api/project/import-meld', {});
      assert.equal((await post(c.port, c.a, '/ui/api/project/load', { project: {} })).status, 400);
      assert.ok(!c.calls.some(([m]) => m === 'project.load'), 'nothing loaded before the Load click');
      const r = await post(c.port, c.a, '/ui/api/project/load', { skipUnavailable: true });
      const ok = JSON.parse(r.text);
      assert.ok(!r.text.includes('"scenes"'), 'project document must not reach the page');
      assert.equal(ok.verdict, 'allow');
      assert.equal(c.calls.filter(([m]) => m === 'project.load').length, 3, 'two conflicts then success');
      assert.equal(c.calls.find(([m]) => m === 'project.load')[1].skipUnavailable, true);
    } finally { await c.srv.close(); }
  });
  test('canvas and device-audio mixer ids are accepted; bad ones are not', async () => {
    const c = setup(); const { port } = await c.srv.listen();
    try {
      const a = await login(port);
      const h = (method, params) => post(port, a, '/ui/api/host', { method, params }).then((r) => r.status);
      assert.equal(await h('layers.list', { scene: 'scene-1', canvas: 'h' }), 200);
      assert.equal(await h('layers.list', { scene: 'scene-1', canvas: 'x' }), 400);
      assert.notEqual(await h('mixer.setMute', { id: 'audio:mic-1', muted: true }), 400, 'valid id passes validation (the fake host may still not know it)');
      assert.equal(await h('mixer.setMute', { id: 'audio:', muted: true }), 400);
    } finally { await c.srv.close(); }
  });
});

// Settings and clip answers (D284): plain choices validated, folders inside the app refused, no change while live,
// the answer to "make clips?" handed to the launcher as a file.
describe('settings and clip answers', () => {
  let srv, port, a, dataDir, hostLive = false;
  before(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-set-srv-'));
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: async (m, p) => { const r = await fake.call(m, p); return m === 'host.status' ? { ...r, live: hostLive } : r; } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 20 } });
    ({ port } = await srv.listen());
    a = await login(port);
  });
  after(() => { srv.close(); rmSync(dataDir, { recursive: true, force: true }); });

  test('GET: defaults "ask" for both, not saved yet, default clips folder', async () => {
    const r = JSON.parse((await raw(port, { url: '/ui/api/settings', headers: { cookie: a.cookie } })).text);
    assert.deepEqual(r.settings.clips, { recording: 'ask', live: 'ask', recordLive: true, matchGate: { top3: true, minKills: null } });
    assert.equal(r.clips.settingsSaved, false);
    assert.equal(r.clips.folder, path.join(dataDir, 'clips'));
  });
  test('POST: a good choice is saved; a bad mode, a relative folder or a folder inside the app is refused', async () => {
    const clips = path.join(dataDir, 'out clips');
    assert.equal((await post(port, a, '/ui/api/settings', { clips: { recording: 'after', live: 'while' }, folders: { clips } })).status, 200);
    const s = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual([s.clips, s.folders.clips], [{ recording: 'after', live: 'while', recordLive: true, matchGate: { top3: true, minKills: null } }, clips]);
    for (const bad of [{ clips: { recording: 'maybe' } }, { clips: { recordLive: 'on' } }, { folders: { clips: 'rel' } }, { folders: { recordings: path.join(REPO, 'services') } }, { other: 1 }]) {
      const r = await post(port, a, '/ui/api/settings', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(JSON.parse(r.text).error, 'bad-settings');
    }
  });
  test('answer: written for the launcher; extra or wrong fields refused', async () => {
    assert.equal((await post(port, a, '/ui/api/clips/answer', { id: 'x-1', make: true, remember: true })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'clips', 'answer.json'), 'utf8')), { id: 'x-1', make: true, remember: true });
    assert.equal((await post(port, a, '/ui/api/clips/answer', { id: 'x-1', make: 'yes' })).status, 400);
    assert.equal((await post(port, a, '/ui/api/clips/answer', { id: 'x-1', make: true, path: 'C:/' })).status, 400);
  });
  test('while live: settings refused with a plain reason', async () => {
    hostLive = true;
    await new Promise((r) => setTimeout(r, 200)); // the status poll sees the stream
    const r = await post(port, a, '/ui/api/settings', { clips: { recording: 'off' } });
    hostLive = false;
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.text).detail, 'Change settings after the stream.');
  });
});

describe('audio readiness (D297 proposed)', () => {
  const AH = { ok: false, warnings: ['Game audio missing'], sources: [{ id: 'audio:aud-game', name: 'Game', state: 'missing', receiving: false, lastDataMs: 12000, recreates: 3, extra: 'x' }, { id: 'audio:aud-mic', name: 'Mic', state: 'ok', receiving: true, lastDataMs: 4, recreates: 0 }], events: [{ text: 'not for the page' }], rtwqHeld: true };
  test('audioReadiness keeps ok, warnings and per-source state only', () => {
    const r = audioReadiness(AH);
    assert.deepEqual(r, { ok: false, warnings: ['Game audio missing'], sources: [
      { id: 'audio:aud-game', name: 'Game', state: 'missing', receiving: false, lastDataMs: 12000, recreates: 3 },
      { id: 'audio:aud-mic', name: 'Mic', state: 'ok', receiving: true, lastDataMs: 4, recreates: 0 }] });
    assert.deepEqual(audioReadiness(undefined), { ok: true, warnings: [], sources: [] });
    assert.deepEqual(audioReadiness({ warnings: [5, 'X audio missing'], sources: 'no' }), { ok: false, warnings: ['X audio missing'], sources: [] });
  });
  test('status snapshot and the record/stream answer name the missing sound (D332: a warning, not a stop)', async () => {
    const fake = createFakeHost({ outputsReady: true });
    let ah = AH;
    const host = { describe: () => fake.describe(), call: async (m, p) => { const r = await fake.call(m, p); return m === 'host.status' ? { ...r, audioHealth: ah } : r; } };
    const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY });
    const { port } = await srv.listen();
    try {
      const a = await login(port);
      const st = JSON.parse((await raw(port, { url: '/ui/api/status', headers: { cookie: a.cookie } })).text);
      assert.deepEqual(st.host.audioHealth, audioReadiness(AH));
      for (const method of ['record.start', 'stream.start']) {
        const r = JSON.parse((await post(port, a, '/ui/api/host', { method })).text);
        assert.equal(r.verdict, 'allow', method);
        assert.match(r.warning, /^WARNING: Game audio missing$/, method);
      }
      const stop = JSON.parse((await post(port, a, '/ui/api/host', { method: 'record.stop' })).text);
      assert.equal(stop.warning, undefined, 'only starts carry the audio warning');
      ah = { ok: true, warnings: [], sources: [] };
      const r2 = JSON.parse((await post(port, a, '/ui/api/host', { method: 'record.start' })).text);
      assert.equal(r2.verdict, 'allow');
      assert.equal(r2.warning, undefined);
    } finally { await srv.close(); }
  });
});

describe('record while live (LC2, D334 proposed)', () => {
  const SINKS = ['youtube-h', 'youtube-v', 'twitch', 'kick', 'record', 'record-v'];
  async function rig({ recordLive, failRecordStart = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-reclive-'));
    if (recordLive !== undefined) writeSettings(dataDir, { clips: { recordLive } });
    const fake = createFakeHost({ outputsReady: true, sinks: SINKS });
    const calls = [];
    const r = { fake, calls, hold: null, failRecordStart };
    const host = {
      describe: () => fake.describe(),
      call: async (m, p) => {
        if (m !== 'outputs.status' && m !== 'host.status') calls.push(m);
        if (m === 'record.start' && r.hold) await r.hold;
        if (m === 'record.start' && r.failRecordStart) { r.failRecordStart = false; throw Object.assign(new Error('disk'), { code: 'RECORD_FAILED' }); }
        return fake.call(m, p);
      },
    };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    r.srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 20 } });
    ({ port: r.port } = await r.srv.listen());
    r.a = await login(r.port);
    r.click = async (route, body) => JSON.parse((await post(r.port, r.a, route, body)).text);
    r.state = async () => Object.fromEntries((await fake.call('outputs.status')).sinks.map((s) => [s.id, s.state]));
    r.count = (m) => calls.filter((x) => x === m).length;
    r.tasks = async () => JSON.parse((await raw(r.port, { url: '/ui/api/tasks', headers: { cookie: r.a.cookie } })).text).tasks;
    r.close = async () => { await r.srv.close(); rmSync(dataDir, { recursive: true, force: true }); };
    return r;
  }
  const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((x) => setTimeout(x, 20)); } return false; };

  test('on by default: Start stream records H and V; Stop stream stops that recording (the reels can be made)', async () => {
    const r = await rig();
    try {
      const ok = await r.click('/ui/api/host', { method: 'stream.start' });
      assert.equal(ok.verdict, 'allow');
      assert.equal(ok.warning, undefined);
      assert.deepEqual(r.calls.filter((m) => /^(stream|record)\./.test(m)), ['stream.start', 'record.start'], 'the recording starts after the accepted stream start');
      const live = await r.state();
      assert.deepEqual([live.record, live['record-v'], live['youtube-h']], ['live', 'live', 'live']);
      const t = (await r.tasks()).find((x) => x.title === 'Recording the stream for reels');
      assert.deepEqual([t?.state, t?.note], ['done', 'Started with the stream; it stops when the stream ends, then the reels are made.']);
      const stop = await r.click('/ui/api/host', { method: 'stream.stop' });
      assert.equal(stop.verdict, 'allow');
      assert.equal(r.count('record.stop'), 1);
      const end = await r.state();
      assert.deepEqual([end.record, end['record-v'], end['youtube-h']], ['stopped', 'stopped', 'stopped']);
    } finally { await r.close(); }
  });

  test('a recording started by hand is never started again or stopped by the stream', async () => {
    const r = await rig();
    try {
      await r.click('/ui/api/host', { method: 'record.start' });
      await r.click('/ui/api/host', { method: 'stream.start' });
      assert.equal(r.count('record.start'), 1, 'already recording: not started again');
      await r.click('/ui/api/host', { method: 'stream.stop' });
      await new Promise((x) => setTimeout(x, 120)); // a few status polls
      assert.equal(r.count('record.stop'), 0);
      assert.equal((await r.state()).record, 'live', 'the hand-started recording keeps running');
      // a Record click during a recording started with the stream hands it back to the user
      await r.click('/ui/api/host', { method: 'record.stop' });
      await r.click('/ui/api/host', { method: 'stream.start' });
      assert.equal(r.count('record.start'), 2, 'started with the stream');
      await r.click('/ui/api/host', { method: 'record.stop' });
      await r.click('/ui/api/host', { method: 'record.start' });
      await r.click('/ui/api/host', { method: 'stream.stop' });
      await new Promise((x) => setTimeout(x, 120));
      assert.equal((await r.state()).record, 'live', 'taken over by the Record click: kept');
    } finally { await r.close(); }
  });

  test('record.start fails: the stream stays live, the answer warns and the task panel says why', async () => {
    const r = await rig({ failRecordStart: true });
    try {
      const ok = await r.click('/ui/api/host', { method: 'stream.start' });
      assert.equal(ok.verdict, 'allow', 'the start itself succeeded');
      assert.equal(ok.warning, 'The stream is live, but it is not being recorded (the recording did not start: RECORD_FAILED), so no reels will be made from it. Press Record to record it.');
      const st = await r.state();
      assert.deepEqual([st['youtube-h'], st.twitch, st.record], ['live', 'live', 'idle']);
      assert.equal(r.count('stream.stop'), 0, 'never stops the stream');
      const t = (await r.tasks()).find((x) => x.title === 'Recording the stream for reels');
      assert.deepEqual([t?.state, t?.note], ['failed', 'Not recorded: the recording did not start: RECORD_FAILED. The stream is live; press Record to record it.']);
    } finally { await r.close(); }
  });

  test('setting off: the old behaviour (no recording with the stream)', async () => {
    const r = await rig({ recordLive: false });
    try {
      const ok = await r.click('/ui/api/host', { method: 'stream.start' });
      assert.equal(ok.verdict, 'allow');
      assert.equal(r.count('record.start'), 0);
      await r.click('/ui/api/host', { method: 'stream.stop' });
      assert.equal(r.count('record.stop'), 0);
    } finally { await r.close(); }
  });

  test('End all stops the recording started with the stream; the host reporting every stream stopped does too', async () => {
    const r = await rig();
    try {
      await r.click('/ui/api/host', { method: 'stream.start' });
      const end = await r.click('/ui/api/streams/end-all', {});
      assert.equal(end.verdict, 'allow');
      assert.deepEqual([end.endAll.allStopped, end.endAll.recording, end.endAll.recordingStopped], [true, false, true]);
      assert.equal((await r.state()).record, 'stopped');
      // the streams end without a click (the host stopped them): the next status poll stops the recording
      await r.click('/ui/api/host', { method: 'stream.start' });
      assert.equal((await r.state())['record-v'], 'live');
      await new Promise((x) => setTimeout(x, 120)); // status polls see the stream running (until then a 30 s grace applies)
      await r.fake.call('stream.stop', {});
      assert.ok(await waitFor(async () => (await r.state()).record === 'stopped'), 'stopped by the status poll');
      assert.equal(r.count('record.stop'), 2);
    } finally { await r.close(); }
  });

  test('a Stop that arrives while record.start is on its way wins: the recording is stopped again', async () => {
    const r = await rig();
    try {
      let release; r.hold = new Promise((x) => { release = x; });
      const starting = r.click('/ui/api/host', { method: 'stream.start' });
      assert.ok(await waitFor(() => r.count('record.start') === 1), 'record.start sent');
      const stop = await r.click('/ui/api/host', { method: 'stream.stop' });
      assert.equal(stop.verdict, 'allow');
      release();
      assert.equal((await starting).verdict, 'allow');
      assert.equal(r.count('record.stop'), 1, 'stopped again at once');
      const st = await r.state();
      assert.deepEqual([st.record, st['youtube-h']], ['stopped', 'stopped']);
    } finally { await r.close(); }
  });
});

describe('record while live: Codex review of LC2 (server)', () => {
  test('P1: Stop or End all that leave an output running keep the recording; it stops once every output has stopped', async () => {
    const SINKS = ['youtube-h', 'youtube-v', 'twitch', 'kick', 'record', 'record-v'];
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-reclive-p1-'));
    const fake = createFakeHost({ outputsReady: true, sinks: SINKS });
    const calls = []; let keepLive = 'kick';
    const host = {
      describe: () => fake.describe(),
      call: async (m, p) => {
        if (m !== 'outputs.status' && m !== 'host.status') calls.push(m);
        const out = await fake.call(m, p);
        if (m === 'stream.stop' && keepLive) await fake.call('stream.start', { sinks: [keepLive] }); // that output did not stop
        return out;
      },
    };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 20 },
      readiness: { config: { endAll: { waitMs: 300, pollMs: 50 } }, run: async () => ({ ok: true, items: [] }) } });
    try {
      const { port } = await srv.listen();
      const a = await login(port);
      const click = async (route, body) => JSON.parse((await post(port, a, route, body)).text);
      const state = async () => Object.fromEntries((await fake.call('outputs.status')).sinks.map((s) => [s.id, s.state]));
      await click('/ui/api/host', { method: 'stream.start' });
      assert.equal((await state()).record, 'live');
      await click('/ui/api/host', { method: 'stream.stop' });
      assert.equal((await state()).kick, 'live', 'one output still running');
      assert.equal(calls.filter((m) => m === 'record.stop').length, 0, 'Stop stream left an output running: the recording keeps going');
      const end = await click('/ui/api/streams/end-all', {});
      assert.equal(end.endAll.allStopped, false);
      assert.equal(end.endAll.recordingStopped, undefined);
      assert.equal((await state()).record, 'live', 'End all not finished: the recording keeps going');
      keepLive = null;
      await fake.call('stream.stop', { sinks: ['kick'] });
      for (let i = 0; i < 150 && (await state()).record !== 'stopped'; i++) await new Promise((x) => setTimeout(x, 20));
      assert.equal((await state()).record, 'stopped', 'the status poll stops it once every output has stopped');
    } finally { await srv.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
