// SPDX-License-Identifier: GPL-2.0-or-later
// Studio UI server security tests (v1 F2): Host/Origin/CSRF/cookie, login key, confirmation channel, no backend token
// reaches the page, static path traversal. Uses a stub core and the in-memory fake host; no real backend, no network
// beyond 127.0.0.1.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer, HOST_CALLS } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
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
    assert.ok(Object.keys(HOST_CALLS).every((k) => !/^(host|project|outputs|encoders)\./.test(k)));
  });
  test('stream start needs the typed phrase; the host is not called before it', async () => {
    const before = ctx.calls.host.filter((m) => m === 'stream.start').length;
    const r = JSON.parse((await post(port, a, '/ui/api/host', { method: 'stream.start' })).text);
    assert.equal(r.verdict, 'confirm');
    assert.equal(r.pending.phrase, 'yes, on air');
    assert.equal(ctx.calls.host.filter((m) => m === 'stream.start').length, before);
    const id = r.pending.pendingId;
    const wrong = JSON.parse((await post(port, a, '/ui/api/confirm', { pendingId: id, text: 'yes' })).text);
    assert.equal(wrong.verdict, 'wrong-phrase');
    assert.equal(ctx.calls.host.filter((m) => m === 'stream.start').length, before);
    const ok = JSON.parse((await post(port, a, '/ui/api/confirm', { pendingId: id, text: '  Yes,  ON air ' })).text);
    assert.equal(ok.verdict, 'allow');
    assert.equal(ctx.calls.host.filter((m) => m === 'stream.start').length, before + 1);
    assert.equal((await post(port, a, '/ui/api/confirm', { pendingId: id, text: 'yes, on air' })).status, 410, 'single use');
  });
  test('cancel removes a pending confirmation', async () => {
    const r = JSON.parse((await post(port, a, '/ui/api/host', { method: 'record.start' })).text);
    assert.equal((await post(port, a, '/ui/api/cancel', { pendingId: r.pending.pendingId })).status, 200);
    assert.equal((await post(port, a, '/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes' })).status, 410);
  });
  test('core action: ids and hashes stay server-side; the typed phrase triggers actions.confirm', async () => {
    const r = await post(port, a, '/ui/api/core/request', { id: 'chat.raw.purge', params: { all: true } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(CONFIRM_ID) && !r.text.includes(ACTION_HASH), 'confirmId/actionHash must not reach the page');
    const j = JSON.parse(r.text);
    assert.equal(j.verdict, 'confirm'); assert.equal(j.pending.phrase, 'yes');
    assert.ok(!ctx.calls.core.some(([m]) => m === 'actions.confirm'));
    const ok = JSON.parse((await post(port, a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'yes' })).text);
    assert.equal(ok.verdict, 'allow');
    const c = ctx.calls.core.find(([m]) => m === 'actions.confirm');
    assert.deepEqual(c[1], { confirmId: CONFIRM_ID, phrase: 'yes', actionHash: ACTION_HASH });
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
  test('load needs an import first, then the typed phrase; retries on -32009; project stays server-side', async () => {
    const c = await importSetup();
    try {
      assert.equal((await post(c.port, c.a, '/ui/api/project/load', {})).status, 409);
      await post(c.port, c.a, '/ui/api/project/import-meld', {});
      assert.equal((await post(c.port, c.a, '/ui/api/project/load', { project: {} })).status, 400);
      const r = await post(c.port, c.a, '/ui/api/project/load', { skipUnavailable: true });
      const j = JSON.parse(r.text);
      assert.equal(j.verdict, 'confirm'); assert.ok(!r.text.includes('"scenes"'), 'project document must not reach the page');
      assert.ok(!c.calls.some(([m]) => m === 'project.load'));
      const ok = JSON.parse((await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'yes' })).text);
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
