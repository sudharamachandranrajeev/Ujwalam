// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI server: platform sign-in routes (D327 PC1-PC3, flag `platform-connect`). Fake host, stub core, an in-memory
// credential store and loopback platform mocks: never the real Credential Manager, never a real platform.
// Secret-leak checks: no key, token, client secret or server address in any HTTP response, server log line or file
// under the data folder. Redaction check: tools/diag/redact.mjs removes every sign-in value shape.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../services/posting/oauth.mjs';
import { TARGETS, createMemoryStores } from '../services/platform-connect/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createReadiness, loadReadinessConfig, planTargets } from '../services/studio-ui/readiness.mjs';
import { makeRedactor } from '../tools/diag/redact.mjs';
import { SECRETS, googleBrowser, startPlatformMock } from './helpers/platform-mocks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pcs-')); tmpDirs.push(d); return d; };
const servers = [];
const mocks = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const m of mocks.splice(0)) await m.close(); });
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const responses = []; // every response body of every test, for the leak check
function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        responses.push(text);
        resolve({ status: res.statusCode, text, json() { return JSON.parse(text); } });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function login(port) {
  const r = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res); }).on('error', reject));
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
const get = (c, url) => raw(c.port, { url, headers: { cookie: c.a.cookie } });
const post = (c, route, body, extra = {}) => raw(c.port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': c.a.csrf, ...extra },
});

async function boot({ flagOn = true, live = false, liveSinks = [], stores = {}, browser, storeWrap, hostWrap } = {}) {
  const dataDir = mk();
  if (flagOn) createFlags({ dataDir }).set('platform-connect', true);
  const mock = await startPlatformMock();
  mocks.push(mock);
  const mem = createMemoryStores({ [CLIENT_ID_TARGET]: 'mock-google-client.apps.example', [CLIENT_SECRET_TARGET]: SECRETS.googleClientSecret, ...stores });
  const fake = createFakeHost({ outputsReady: true });
  const state = { live, liveSinks };
  const host = {
    describe: () => fake.describe(),
    call: async (m, p) => {
      if (m === 'outputs.status') return { configured: true, sinks: state.liveSinks.map((id) => ({ id, kind: 'stream', state: 'live' })) };
      if (hostWrap) await hostWrap(m);
      const r = await fake.call(m, p);
      return m === 'host.status' ? { ...r, live: state.live } : r;
    },
  };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const logs = [];
  const srv = createStudioServer({
    uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 30 }, log: (m) => logs.push(String(m)),
    connect: { storeFor: storeWrap ? (t) => storeWrap(t, mem.storeFor(t)) : mem.storeFor, endpoints: mock.endpoints, sleep: async () => {}, browserOpen: (browser ?? googleBrowser)(mock) },
  });
  servers.push(srv);
  const { port } = await srv.listen();
  if (live) await new Promise((r) => setTimeout(r, 150));
  return { srv, port, a: await login(port), dataDir, mem, mock, logs, state };
}
async function waitJob(c, until = (j) => ['choose', 'done', 'failed', 'cancelled'].includes(j?.state)) {
  for (let i = 0; i < 200; i++) {
    const j = (await get(c, '/ui/api/connect')).json().job;
    if (until(j)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
}
function allFiles(dir) { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }
function assertNoSecret(text, where) { for (const [name, v] of Object.entries(SECRETS)) assert.ok(!String(text).includes(v), `${name} leaked into ${where}`); }
function leakCheck(c) {
  for (const r of responses) assertNoSecret(r, 'an HTTP response');
  for (const l of c.logs) assertNoSecret(l, 'a log line');
  for (const f of allFiles(c.dataDir)) assertNoSecret(readFileSync(f, 'utf8'), f);
}

describe('flag gate', () => {
  test('off by default: every connect route is 404 and nothing is read or written', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    assert.equal(defs.find((f) => f.id === 'platform-connect').default, false);
    const c = await boot({ flagOn: false });
    assert.equal((await get(c, '/ui/api/connect')).status, 404);
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey })).status, 404);
    assert.equal((await post(c, '/ui/api/connect/sign-in', { output: 'youtube-h', platform: 'youtube' })).status, 404);
    assert.deepEqual(c.mem.calls, []);
  });
  test('writes need Origin and the CSRF header (local API rules unchanged)', async () => {
    const c = await boot();
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey }, { 'x-ujwalam-csrf': 'wrong' })).status, 403);
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey }, { origin: 'http://evil.example' })).status, 403);
    assert.deepEqual(c.mem.calls.filter(([op]) => op !== 'get'), []);
  });
});

describe('paste (PC1, PC2)', () => {
  test('stored on the click (D332, no phrase); the key is never echoed; stored under the host target names; status masked', async () => {
    const c = await boot();
    const ok = (await post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey, server: SECRETS.kickServer })).json();
    assert.equal(ok.verdict, 'allow');
    assert.equal(ok.pending, undefined);
    assert.equal(c.mem.map.get('Ujwalam/stream/kick'), SECRETS.kickKey);
    assert.equal(c.mem.map.get('Ujwalam/stream/kick-server'), SECRETS.kickServer);
    const st = (await get(c, '/ui/api/connect?fresh=1')).json();
    const k = st.outputs.find((o) => o.id === 'kick');
    assert.equal(k.state, 'connected');
    assert.equal(k.key.last4, SECRETS.kickKey.slice(-4));
    assert.deepEqual(Object.keys(k.server).sort(), ['present', 'scheme', 'schemes']);
    leakCheck(c);
  });
  test('a paste leaves no pending record behind (the key is never kept in one) and never echoes the key', async () => {
    const c = await boot();
    const r = await post(c, '/ui/api/connect/paste', { output: 'youtube-h', key: SECRETS.ytKeyH });
    assert.equal(r.json().verdict, 'allow');
    assert.equal(c.srv._pending().size, 0, 'nothing held in the pending map');
    assert.equal(r.text.includes(SECRETS.ytKeyH), false);
    assert.equal(c.mem.map.get('Ujwalam/stream/youtube-h'), SECRETS.ytKeyH);
  });
  test('bad values refused before any confirm, with a plain message', async () => {
    const c = await boot();
    const r = await post(c, '/ui/api/connect/paste', { output: 'kick', server: 'rtmp://zz9.example.net/app' });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, 'server-wrong-scheme');
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey, extra: 1 })).status, 400);
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'nope', key: SECRETS.kickKey })).status, 404);
  });
});

describe('live rules', () => {
  test('the live output itself is refused; another output is stored on the click (no "yes, on air")', async () => {
    const c = await boot({ live: true, liveSinks: ['youtube-h'] });
    const r = await post(c, '/ui/api/connect/paste', { output: 'youtube-h', key: SECRETS.ytKeyH });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'output-live');
    const d = await post(c, '/ui/api/connect/disconnect', { output: 'youtube-h' });
    assert.equal(d.json().error, 'output-live');
    const v = await post(c, '/ui/api/connect/paste', { output: 'youtube-v', key: SECRETS.ytKeyNew });
    assert.equal(v.json().verdict, 'allow');
    assert.equal(c.mem.map.get('Ujwalam/stream/youtube-v'), SECRETS.ytKeyNew);
  });
  test('an output that went live since the last status is refused at the click, nothing written', async () => {
    const c = await boot();
    c.state.liveSinks = ['twitch'];
    c.state.live = true;
    await new Promise((res) => setTimeout(res, 120));
    const out = await post(c, '/ui/api/connect/paste', { output: 'twitch', key: SECRETS.twitchKey });
    assert.equal(out.status, 409);
    assert.equal(out.json().error, 'output-live');
    assert.equal(c.mem.map.has('Ujwalam/stream/twitch'), false);
  });
});

describe('sign-in through the server (PC1)', () => {
  test('YouTube: sign-in on the click, browser sign-in, pick a stream; the key is stored and never in a response or log', async () => {
    const c = await boot();
    const ok = (await post(c, '/ui/api/connect/sign-in', { output: 'youtube-h', platform: 'youtube' })).json();
    assert.equal(ok.verdict, 'allow');
    const j = await waitJob(c);
    assert.equal(j.state, 'choose', JSON.stringify(j));
    const done = (await post(c, '/ui/api/connect/choose', { jobId: j.id, streamId: 'stream-h' })).json();
    assert.equal(done.job.state, 'done');
    assert.equal(c.mem.map.get('Ujwalam/stream/youtube-h'), SECRETS.ytKeyH);
    assert.equal((await get(c, '/ui/api/connect?fresh=1')).json().outputs.find((o) => o.id === 'youtube-h').state, 'connected');
    leakCheck(c);
  });
  test('Twitch: the client id is set on the click; device code shown; key stored', async () => {
    const c = await boot({ browser: () => async () => {} });
    const s = await post(c, '/ui/api/connect/twitch-client', { clientId: 'mocktwitchclientid0000000000zz' });
    assert.equal(s.json().verdict, 'allow');
    assert.equal(c.mem.map.get(TARGETS.twitchClientId), 'mocktwitchclientid0000000000zz');
    await post(c, '/ui/api/connect/sign-in', { output: 'twitch', platform: 'twitch' });
    const j = await waitJob(c);
    assert.equal(j.state, 'done', JSON.stringify(j));
    assert.equal(c.mem.map.get('Ujwalam/stream/twitch'), SECRETS.twitchKey);
    leakCheck(c);
  });
  test('disconnect (PC3): on the click, deletes key and token, status missing', async () => {
    const c = await boot({ stores: { [TARGETS.twitchClientId]: 'mocktwitchclientid0000000000zz' }, browser: () => async () => {} });
    await post(c, '/ui/api/connect/sign-in', { output: 'twitch', platform: 'twitch' });
    await waitJob(c);
    const out = (await post(c, '/ui/api/connect/disconnect', { output: 'twitch' })).json();
    assert.deepEqual(out.result.removed, { key: true, server: true, token: true, revoke: 'revoked' });
    assert.ok(!c.mem.map.has('Ujwalam/stream/twitch') && !c.mem.map.has(TARGETS.twitchRefresh));
    assert.equal((await get(c, '/ui/api/connect?fresh=1')).json().outputs.find((o) => o.id === 'twitch').state, 'missing');
    leakCheck(c);
  });
});

describe('readiness (PC3)', () => {
  test('with the flag on, a missing key points at Settings > Connections; an expired sign-in is a warning', async () => {
    const mem = createMemoryStores({ 'Ujwalam/stream/youtube-h': SECRETS.ytKeyH });
    const r = createReadiness({
      host: { describe: () => ({ kind: 'fake' }), call: async () => { throw new Error('down'); } }, config: loadReadinessConfig(),
      flagOn: () => false, store: (ref) => mem.storeFor(ref), listProcesses: async () => [], diskFree: () => 1e12, tcp: async () => false,
      botPorts: {}, ciPass: async () => null, clipTools: () => ({}), planTargets: planTargets(),
      connect: () => ({ fix: 'Studio: Settings > Connections (sign in, or paste the key)', warnings: async () => ['Twitch: The Twitch sign-in has expired.'] }),
    });
    const res = await r.run({ maxAgeMs: 0 });
    const cred = res.items.find((i) => i.id === 'credentials');
    assert.match(cred.fix, /Settings > Connections/);
    assert.match(cred.message, /Twitch sign-in has expired/);
    assertNoSecret(JSON.stringify(res), 'readiness');
  });
});

describe('redaction (PC2)', () => {
  test('tools/diag/redact.mjs removes every sign-in value shape', () => {
    const red = makeRedactor({});
    const lines = [
      `Authorization: Bearer ${SECRETS.googleAccess}`,
      `Authorization: OAuth ${SECRETS.twitchAccess}`,
      `{"refresh_token":"${SECRETS.googleRefresh}","access_token":"${SECRETS.googleAccess}"}`,
      `device_code=${SECRETS.deviceCode}&client_secret=${SECRETS.googleClientSecret}`,
      `token ${SECRETS.twitchRefresh2}`, `got ${SECRETS.twitchAccess} back`, `stream key ${SECRETS.twitchKey}`,
      `kick ${SECRETS.kickKey} at ${SECRETS.kickServer}`, `yt ${SECRETS.ytKeyH}`, `refresh ${SECRETS.googleRefresh}`, `access ${SECRETS.googleAccess}`,
    ];
    for (const l of lines) assertNoSecret(red(l), `redacted line "${l.slice(0, 20)}..."`);
    assert.equal(red('exit code 1168, 42 frames dropped'), 'exit code 1168, 42 frames dropped', 'ordinary text stays');
  });
});

// Codex second review of D327, finding 1: a key update and a stream start never overlap (start gate in the server).
describe('start gate (key writes and stream starts)', () => {
  const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  test('while a key is being written, a confirmed stream start is refused (409 credentials-updating)', async () => {
    const hold = deferred(); let writing = false;
    const c = await boot({ storeWrap: (t, s) => ({ ...s, set: async (v) => { if (t === 'Ujwalam/stream/kick') { writing = true; await hold.p; } return s.set(v); } }) });
    const pasting = post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey, server: SECRETS.kickServer });
    while (!writing) await new Promise((r) => setTimeout(r, 5));
    const r = await post(c, '/ui/api/host', { method: 'stream.start', params: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'credentials-updating');
    hold.open();
    assert.equal((await pasting).json().verdict, 'allow');
    leakCheck(c);
  });
  test('while a stream start is on its way, a key write is refused (409 output-starting) and nothing is stored', async () => {
    const hold = deferred(); let starting = false;
    const c = await boot({ hostWrap: async (m) => { if (m === 'stream.start') { starting = true; await hold.p; } } });
    const going = post(c, '/ui/api/host', { method: 'stream.start', params: {} });
    while (!starting) await new Promise((r) => setTimeout(r, 5));
    const r = await post(c, '/ui/api/connect/paste', { output: 'kick', key: SECRETS.kickKey, server: SECRETS.kickServer });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'output-starting');
    assert.ok(!c.mem.map.has('Ujwalam/stream/kick'));
    hold.open();
    await going;
  });
});
