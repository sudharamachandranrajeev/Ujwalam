// SPDX-License-Identifier: GPL-3.0-or-later
// D327: an output added in Settings > Stream (stream-setup.json, flag stream-settings) is known to the platform sign-in
// service (flag platform-connect): it can be connected (paste) under Ujwalam/stream/<id>, without a restart. Fake host, an
// in-memory credential store: never the real Credential Manager, never a real platform.
// Leak check: no pasted key or server address in any HTTP response, server log line or file under the data folder.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createMemoryStores } from '../services/platform-connect/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { readSetup, writeSetup } from '../services/studio-ui/stream-setup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const NEW_KEY = 'sk_us-west-2_MockSetupKeyQQ7abcdef'; // lint-allow: secret (a made-up test marker, not a credential)
const NEW_SERVER = 'rtmps://qq7-mock-ingest.example.net:443/app';
const tmpDirs = [];
const servers = [];
const responses = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); responses.push(text); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
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
const post = (c, route, body) => raw(c.port, { method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': c.a.csrf } });

function addOutput(dataDir, extra) {
  const { setup } = readSetup(dataDir);
  const res = writeSetup(dataDir, { ...setup, outputs: [...setup.outputs, ...extra] });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
}
async function boot({ streamSettings = true, setupOutputs = [{ id: 'kick-2', name: 'Kick 2', platform: 'kick', canvas: 'H', enabled: true, video: { output: '1080p', bitrateKbps: 6000 } }] } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-pcset-')); tmpDirs.push(dataDir);
  const flags = createFlags({ dataDir });
  flags.set('platform-connect', true);
  if (streamSettings) flags.set('stream-settings', true);
  if (setupOutputs.length) addOutput(dataDir, setupOutputs);
  const mem = createMemoryStores({});
  const fake = createFakeHost({ outputsReady: true });
  const host = { describe: () => fake.describe(), call: async (m, p) => (m === 'outputs.status' ? { configured: true, sinks: [] } : fake.call(m, p)) };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const logs = [];
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 30 }, log: (m) => logs.push(String(m)),
    connect: { storeFor: mem.storeFor, sleep: async () => {} } });
  servers.push(srv);
  const { port } = await srv.listen();
  return { srv, port, a: await login(port), dataDir, mem, logs };
}
function allFiles(dir) { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }
function leakCheck(c) {
  for (const v of [NEW_KEY, NEW_SERVER]) {
    for (const r of responses) assert.ok(!r.includes(v), 'a pasted value leaked into an HTTP response');
    for (const l of c.logs) assert.ok(!l.includes(v), 'a pasted value leaked into a log line');
    for (const f of allFiles(c.dataDir)) assert.ok(!readFileSync(f, 'utf8').includes(v), `a pasted value leaked into ${path.basename(f)}`);
  }
}

describe('connect knows the Settings > Stream outputs (D327)', () => {
  test('a setup-only output is listed, can be pasted under Ujwalam/stream/<id>, and shows only the last 4', async () => {
    const c = await boot();
    const st = (await get(c, '/ui/api/connect?fresh=1')).json();
    const o = st.outputs.find((x) => x.id === 'kick-2');
    assert.ok(o, JSON.stringify(st.outputs.map((x) => x.id)));
    assert.equal(o.state, 'missing');
    assert.equal(o.label, 'Kick');
    const r = await post(c, '/ui/api/connect/paste', { output: 'kick-2', key: NEW_KEY, server: NEW_SERVER });
    assert.equal(r.json().verdict, 'allow', 'stored on the click (D331), no phrase');
    assert.equal(c.mem.map.get('Ujwalam/stream/kick-2'), NEW_KEY);
    assert.equal(c.mem.map.get('Ujwalam/stream/kick-2-server'), NEW_SERVER);
    const k = (await get(c, '/ui/api/connect?fresh=1')).json().outputs.find((x) => x.id === 'kick-2');
    assert.equal(k.state, 'connected');
    assert.equal(k.key.last4, NEW_KEY.slice(-4));
    assert.deepEqual(Object.keys(k.key).sort(), ['last4', 'present']);
    leakCheck(c);
  });
  test('an output saved after the server started is known without a restart', async () => {
    const c = await boot({ setupOutputs: [] });
    assert.equal((await get(c, '/ui/api/connect')).json().outputs.some((x) => x.id === 'kick-2'), false);
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'kick-2', key: NEW_KEY })).status, 404);
    addOutput(c.dataDir, [{ id: 'kick-2', name: 'Kick 2', platform: 'kick', canvas: 'H', enabled: true, video: { output: '1080p', bitrateKbps: 6000 } }]);
    assert.equal((await get(c, '/ui/api/connect')).json().outputs.some((x) => x.id === 'kick-2'), true, 'the 10 s status cache does not hide it');
    const r = await post(c, '/ui/api/connect/paste', { output: 'kick-2', key: NEW_KEY });
    assert.equal(r.json().verdict, 'allow');
    assert.equal(c.mem.map.get('Ujwalam/stream/kick-2'), NEW_KEY);
    leakCheck(c);
  });
  test('flag stream-settings off: the setup is not used (the live plan outputs only)', async () => {
    const c = await boot({ streamSettings: false });
    assert.equal((await get(c, '/ui/api/connect')).json().outputs.some((x) => x.id === 'kick-2'), false);
    assert.equal((await post(c, '/ui/api/connect/paste', { output: 'kick-2', key: NEW_KEY })).status, 404);
    assert.equal(c.mem.map.has('Ujwalam/stream/kick-2'), false);
  });
  test('the platform of a setup output comes from the setup, not from its id', async () => {
    const c = await boot({ setupOutputs: [{ id: 'extra-1', name: 'Twitch backup', platform: 'twitch', canvas: 'H', enabled: false, video: { output: '1080p', bitrateKbps: 6000 } }] });
    const o = (await get(c, '/ui/api/connect?fresh=1')).json().outputs.find((x) => x.id === 'extra-1');
    assert.equal(o.platform, 'twitch');
    assert.equal(o.signIn, 'twitch');
  });
});
