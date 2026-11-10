// SPDX-License-Identifier: GPL-3.0-or-later
// D327: Settings > Stream (OS1/OS2), the Outputs panel (OS3), Settings > Integrations (IN1) and Force complete
// transition (TR1) over the UI server. Fake host (per-sink states), stub core, mocked TCP test, 127.0.0.1 only.
// Never contacts a bot port or a platform.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ss-')); tmpDirs.push(d); return d; };
const servers = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function session(port) {
  const r = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
  });
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
const get = (c, url) => raw(c.port, { url, headers: { cookie: c.a.cookie } });
const post = (c, route, body) => raw(c.port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': c.a.csrf },
});

async function boot({ flagsOn = ['stream-settings', 'outputs-panel', 'integrations'], tcp, authority = null, startPauseMs = 0, beforeHost = null } = {}) {
  const dataDir = mk();
  const f = createFlags({ dataDir });
  for (const id of flagsOn) f.set(id, true);
  const fake = createFakeHost({ outputsReady: true });
  const calls = [];
  // beforeHost(m, p): awaited before the fake host runs a call (race tests: a slow start on its way to the host).
  const host = { describe: () => fake.describe(), call: async (m, p) => { if (m !== 'host.status' && m !== 'outputs.status') calls.push([m, p]); if (beforeHost) await beforeHost(m, p); return fake.call(m, p); } };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const tcpCalls = [];
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, limits: { statusPollMs: 30 }, authority, startPauseMs,
    tcpAnswers: async (port) => { tcpCalls.push(port); return tcp ? tcp(port) : false; }, botConfig: () => ({}) });
  servers.push(srv);
  const { port } = await srv.listen();
  return { srv, port, a: await session(port), dataDir, fake, calls, tcpCalls };
}
const settle = () => new Promise((r) => setTimeout(r, 120)); // one status poll

describe('flags', () => {
  test('the three flags are defined, off by default, and every route is 404 while off', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    for (const id of ['stream-settings', 'outputs-panel', 'integrations']) assert.equal(defs.find((x) => x.id === id)?.default, false, id);
    const c = await boot({ flagsOn: [] });
    for (const u of ['/ui/api/stream/setup', '/ui/api/outputs/panel', '/ui/api/integrations']) assert.equal((await get(c, u)).status, 404, u);
    for (const [u, b] of [['/ui/api/stream/setup', { setup: {} }], ['/ui/api/outputs/toggle', { id: 'twitch', on: false }], ['/ui/api/integrations', { value: {} }], ['/ui/api/transitions/force', { canvas: 'h' }], ['/ui/api/integrations/remote-token', {}]]) {
      assert.equal((await post(c, u, b)).status, 404, u);
    }
  });
});

describe('Stream settings (OS1/OS2)', () => {
  test('GET gives the seed; POST round-trips; a value over a platform limit is refused with the limit shown', async () => {
    const c = await boot();
    const g = (await get(c, '/ui/api/stream/setup')).json();
    assert.equal(g.exists, false);
    assert.equal(g.setup.video.bitrateKbps, 17000);
    assert.equal(g.summaries.twitch, '1080p @ 60fps 6,000 kbps · Main canvas');
    assert.deepEqual(g.problems, []);
    const s = structuredClone(g.setup);
    s.video.bitrateKbps = 12000;
    s.outputs.push({ id: 'twitch-2', name: 'Twitch (second)', platform: 'twitch', canvas: 'H', enabled: false, video: { output: '720p', bitrateKbps: 3000 } });
    const w = await post(c, '/ui/api/stream/setup', { setup: s });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json().appliesAt, 'next-start');
    const back = (await get(c, '/ui/api/stream/setup')).json();
    assert.equal(back.exists, true);
    assert.deepEqual(back.setup, s);
    const bad = structuredClone(s); bad.outputs.find((o) => o.id === 'kick').video.bitrateKbps = 9000;
    const r = await post(c, '/ui/api/stream/setup', { setup: bad });
    assert.equal(r.status, 422);
    assert.ok(r.json().problems.some((p) => /kick max 8000/.test(p.message)), r.text);
    assert.deepEqual((await get(c, '/ui/api/stream/setup')).json().setup, s, 'nothing written');
    const chk = (await post(c, '/ui/api/stream/check', { setup: bad })).json();
    assert.ok(chk.problems.length > 0);
    assert.equal((await post(c, '/ui/api/stream/setup', { setup: s, extra: 1 })).status, 400);
  });
});

describe('Outputs panel (OS3)', () => {
  test('offline: a switch only saves; Start stream then starts the switched-on outputs only', async () => {
    const c = await boot();
    const p = (await get(c, '/ui/api/outputs/panel')).json();
    assert.deepEqual(p.outputs.map((o) => [o.id, o.enabled, o.state]), [['youtube-h', true, 'idle'], ['youtube-v', true, 'idle'], ['twitch', true, 'idle'], ['kick', true, 'idle']]);
    assert.equal(p.virtualCamera.available, false);
    const t = await post(c, '/ui/api/outputs/toggle', { id: 'kick', on: false });
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json().live, false);
    assert.equal(c.calls.filter(([m]) => m.startsWith('stream.')).length, 0, 'no host call offline');
    const st = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(st.verdict, 'confirm');
    const ok = (await post(c, '/ui/api/confirm', { pendingId: st.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(ok.verdict, 'allow', JSON.stringify(ok));
    assert.deepEqual(c.calls.find(([m]) => m === 'stream.start')[1], { sinks: ['youtube-h', 'youtube-v', 'twitch'] });
    const after = (await get(c, '/ui/api/outputs/panel')).json();
    assert.deepEqual(after.outputs.map((o) => [o.id, o.state]), [['youtube-h', 'live'], ['youtube-v', 'live'], ['twitch', 'live'], ['kick', 'idle']]);
  });

  test('live: one output needs "yes, on air" and only that sink starts or stops', async () => {
    const c = await boot();
    await c.fake.call('stream.start', {});
    await settle();
    const t = (await post(c, '/ui/api/outputs/toggle', { id: 'twitch', on: false })).json();
    assert.equal(t.verdict, 'confirm');
    assert.equal(t.pending.phrase, 'yes, on air');
    assert.match(t.pending.summary, /Stop Twitch only/);
    const wrong = (await post(c, '/ui/api/confirm', { pendingId: t.pending.pendingId, text: 'yes' })).json();
    assert.equal(wrong.verdict, 'wrong-phrase');
    assert.equal(c.calls.length, 0, 'nothing sent before the phrase');
    const ok = (await post(c, '/ui/api/confirm', { pendingId: t.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(ok.verdict, 'allow', JSON.stringify(ok));
    assert.deepEqual(c.calls, [['stream.stop', { sinks: ['twitch'] }]]);
    const s = (await c.fake.call('outputs.status', {})).sinks;
    assert.deepEqual(s.map((x) => [x.id, x.state]), [['youtube-h', 'live'], ['youtube-v', 'live'], ['twitch', 'stopped'], ['kick', 'live'], ['record', 'idle']]);
    // back on
    const t2 = (await post(c, '/ui/api/outputs/toggle', { id: 'twitch', on: true })).json();
    await post(c, '/ui/api/confirm', { pendingId: t2.pending.pendingId, text: 'yes, on air' });
    assert.deepEqual(c.calls.at(-1), ['stream.start', { sinks: ['twitch'] }]);
  });

  test('live: an output the host does not have is refused (added at the next start); a confirm after the stream ended is refused', async () => {
    const c = await boot();
    const g = (await get(c, '/ui/api/stream/setup')).json();
    const s = structuredClone(g.setup);
    // (on the main 17000 kbps rung it would be refused: twitch max 6000)
    s.outputs.push({ id: 'twitch-2', name: 'Twitch 2', platform: 'twitch', canvas: 'H', enabled: true, video: { output: '1080p', bitrateKbps: 6000 } });
    assert.equal((await post(c, '/ui/api/stream/setup', { setup: s })).status, 200);
    await c.fake.call('stream.start', {});
    await settle();
    const r = await post(c, '/ui/api/outputs/toggle', { id: 'twitch-2', on: true });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'not-in-this-stream');
    const t = (await post(c, '/ui/api/outputs/toggle', { id: 'kick', on: true })).json();
    await c.fake.call('stream.stop', {});
    const late = (await post(c, '/ui/api/confirm', { pendingId: t.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(late.verdict, 'refuse');
    assert.equal(late.reason, 'not-live');
    assert.ok(!c.calls.some(([m]) => m === 'stream.start'), 'never a go-live from an output switch');
  });

  // Codex review P1 (2026-11-10): a switch-on confirmed live must not outlive a newer End all / Stop.
  const states = async (c) => Object.fromEntries((await c.fake.call('outputs.status', {})).sinks.map((x) => [x.id, x.state]));
  async function kickOffLive(c) {
    const seed = (await get(c, '/ui/api/stream/setup')).json().setup;
    assert.equal((await post(c, '/ui/api/stream/setup', { setup: seed })).status, 200); // saved: live switches are remembered
    await c.fake.call('stream.start', {});
    await settle();
    const off = (await post(c, '/ui/api/outputs/toggle', { id: 'kick', on: false })).json();
    assert.equal((await post(c, '/ui/api/confirm', { pendingId: off.pending.pendingId, text: 'yes, on air' })).json().verdict, 'allow');
    return (await post(c, '/ui/api/outputs/toggle', { id: 'kick', on: true })).json();
  }
  async function endAll(c) {
    const e = (await post(c, '/ui/api/streams/end-all', {})).json();
    return (await post(c, '/ui/api/confirm', { pendingId: e.pending.pendingId, text: 'yes, on air' })).json();
  }

  test('race: End all confirmed while a switch-on waits -> the switch-on is not sent; nothing restarts', async () => {
    const c = await boot({ startPauseMs: 400 });
    const on = await kickOffLive(c);
    const pendingOn = post(c, '/ui/api/confirm', { pendingId: on.pending.pendingId, text: 'yes, on air' });
    await new Promise((r) => setTimeout(r, 100)); // the switch-on has its token and waits
    assert.equal((await endAll(c)).verdict, 'allow');
    const r = (await pendingOn).json();
    assert.equal(r.verdict, 'refuse', JSON.stringify(r));
    assert.equal(r.reason, 'stopped-meanwhile');
    assert.ok(!c.calls.some(([m, p]) => m === 'stream.start' && p?.sinks?.[0] === 'kick'), 'the start never reached the host');
    const s = await states(c);
    for (const id of ['youtube-h', 'youtube-v', 'twitch', 'kick']) assert.notEqual(s[id], 'live', `${id} after End all`);
    const setup = JSON.parse(readFileSync(path.join(c.dataDir, 'stream-setup.json'), 'utf8'));
    assert.equal(setup.outputs.find((o) => o.id === 'kick').enabled, false, 'a refused switch-on is not remembered');
  });

  test('race: End all lands while the switch-on is on its way to the host -> that output is stopped again', async () => {
    let gate = null;
    const c = await boot({ beforeHost: async (m, p) => { if (m === 'stream.start' && p?.sinks?.[0] === 'kick' && gate) await gate; } });
    const on = await kickOffLive(c);
    let open; gate = new Promise((r) => { open = r; });
    const pendingOn = post(c, '/ui/api/confirm', { pendingId: on.pending.pendingId, text: 'yes, on air' });
    await new Promise((r) => setTimeout(r, 100)); // the start is held at the host's door
    const ended = endAll(c);
    await new Promise((r) => setTimeout(r, 100));
    open(); // the start reaches the host after End all's stop
    assert.equal((await ended).verdict, 'allow');
    const r = (await pendingOn).json();
    assert.equal(r.verdict, 'refuse', JSON.stringify(r));
    assert.equal(r.stoppedAgain, true);
    assert.deepEqual(c.calls.at(-1), ['stream.stop', { sinks: ['kick'] }]);
    assert.notEqual((await states(c)).kick, 'live');
  });

  test('race, no launcher: End all confirmed while Start stream waits -> the start is not sent', async () => {
    const c = await boot({ startPauseMs: 400 });
    const st = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    const going = post(c, '/ui/api/confirm', { pendingId: st.pending.pendingId, text: 'yes, on air' });
    await new Promise((r) => setTimeout(r, 100));
    const e = (await post(c, '/ui/api/streams/end-all', {})).json();
    assert.equal((await post(c, '/ui/api/confirm', { pendingId: e.pending.pendingId, text: 'yes' })).json().verdict, 'allow');
    const r = (await going).json();
    assert.equal(r.reason, 'stopped-meanwhile', JSON.stringify(r));
    assert.ok(!c.calls.some(([m]) => m === 'stream.start'), 'the start never reached the host');
    assert.ok(!Object.values(await states(c)).includes('live'));
  });

  test('race, no launcher: End all lands while Start stream is on its way to the host -> stopped again', async () => {
    let gate = null;
    const c = await boot({ beforeHost: async (m) => { if (m === 'stream.start' && gate) await gate; } });
    let open; gate = new Promise((r) => { open = r; });
    const st = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    const going = post(c, '/ui/api/confirm', { pendingId: st.pending.pendingId, text: 'yes, on air' });
    await new Promise((r) => setTimeout(r, 100));
    const e = (await post(c, '/ui/api/streams/end-all', {})).json();
    const ended = post(c, '/ui/api/confirm', { pendingId: e.pending.pendingId, text: 'yes' });
    await new Promise((r) => setTimeout(r, 100));
    open();
    await ended;
    const r = (await going).json();
    assert.equal(r.verdict, 'refuse', JSON.stringify(r));
    assert.equal(r.stoppedAgain, true);
    assert.deepEqual(c.calls.at(-1), ['stream.stop', {}]);
    assert.ok(!Object.values(await states(c)).includes('live'));
  });

  test('race: a launcher revoke (go-live authority) while a switch-on waits also wins', async () => {
    let gen = 0;
    const authority = { begin: async () => gen, arm: async (g) => g === gen, revoke: async () => { gen += 1; return true; } };
    const c = await boot({ authority, startPauseMs: 300 });
    const on = await kickOffLive(c);
    const pendingOn = post(c, '/ui/api/confirm', { pendingId: on.pending.pendingId, text: 'yes, on air' });
    await new Promise((r) => setTimeout(r, 100));
    await authority.revoke('live-test-guard');
    const r = (await pendingOn).json();
    assert.equal(r.reason, 'stopped-meanwhile', JSON.stringify(r));
    assert.ok(!c.calls.some(([m, p]) => m === 'stream.start' && p?.sinks?.[0] === 'kick'));
  });
});

describe('Start stream honours switched-off outputs (Codex review P1)', () => {
  test('stream-settings on, outputs-panel off: a disabled output is not started; none enabled refuses with a message', async () => {
    const c = await boot({ flagsOn: ['stream-settings'] });
    const s = structuredClone((await get(c, '/ui/api/stream/setup')).json().setup);
    s.outputs.find((o) => o.id === 'kick').enabled = false;
    assert.equal((await post(c, '/ui/api/stream/setup', { setup: s })).status, 200);
    const st = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    const ok = (await post(c, '/ui/api/confirm', { pendingId: st.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(ok.verdict, 'allow', JSON.stringify(ok));
    assert.deepEqual(c.calls.find(([m]) => m === 'stream.start')[1], { sinks: ['youtube-h', 'youtube-v', 'twitch'] });
    assert.notEqual((await c.fake.call('outputs.status', {})).sinks.find((x) => x.id === 'kick').state, 'live');
    await c.fake.call('stream.stop', {});
    await settle();
    for (const o of s.outputs) o.enabled = false;
    assert.equal((await post(c, '/ui/api/stream/setup', { setup: s })).status, 200);
    const n = c.calls.length;
    const st2 = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    const no = (await post(c, '/ui/api/confirm', { pendingId: st2.pending.pendingId, text: 'yes, on air' })).json();
    assert.equal(no.verdict, 'refuse');
    assert.equal(no.reason, 'no-outputs-enabled');
    assert.match(no.detail, /No output is switched on/);
    assert.ok(!c.calls.slice(n).some(([m]) => m === 'stream.start'), 'nothing started');
  });

  test('both flags off: a saved setup is not in effect; Start stream starts the plan as before', async () => {
    const c = await boot({ flagsOn: ['stream-settings'] });
    const s = structuredClone((await get(c, '/ui/api/stream/setup')).json().setup);
    s.outputs.find((o) => o.id === 'kick').enabled = false;
    assert.equal((await post(c, '/ui/api/stream/setup', { setup: s })).status, 200);
    createFlags({ dataDir: c.dataDir }).set('stream-settings', false);
    const st = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal((await post(c, '/ui/api/confirm', { pendingId: st.pending.pendingId, text: 'yes, on air' })).json().verdict, 'allow');
    assert.deepEqual(c.calls.find(([m]) => m === 'stream.start')[1], {});
  });
});

describe('Integrations (IN1)', () => {
  test('defaults; ports saved; bad port, same ports and public/0.0.0.0 remote address refused', async () => {
    const c = await boot();
    const g = (await get(c, '/ui/api/integrations')).json();
    assert.deepEqual(g.value, { version: 1, bots: { streamerbot: { port: 8093 }, speakerbot: { port: 8083 } }, remote: { enabled: false, address: null } });
    assert.equal(g.bots.streamerbot.address, '127.0.0.1');
    assert.equal(g.remote.running, false);
    const v = structuredClone(g.value); v.bots.streamerbot.port = 8094;
    assert.equal((await post(c, '/ui/api/integrations', { value: v })).status, 200);
    assert.equal((await get(c, '/ui/api/integrations')).json().value.bots.streamerbot.port, 8094);
    for (const mutate of [(x) => { x.bots.streamerbot.port = 80; }, (x) => { x.bots.speakerbot.port = x.bots.streamerbot.port; },
      (x) => { x.remote.address = '0.0.0.0'; }, (x) => { x.remote.address = '8.8.8.8'; }, (x) => { x.bots.streamerbot.address = '192.168.1.5'; }]) {
      const b = structuredClone(v); mutate(b);
      assert.equal((await post(c, '/ui/api/integrations', { value: b })).status, 422, JSON.stringify(b));
    }
    const on = structuredClone(v); on.remote = { enabled: true, address: '192.168.1.20' };
    assert.equal((await post(c, '/ui/api/integrations', { value: on })).status, 200);
  });

  test('Test button: TCP connect to 127.0.0.1:<port> through the mock; remote token only while the listener runs', async () => {
    const c = await boot({ tcp: (port) => port === 8093 });
    assert.deepEqual((await post(c, '/ui/api/integrations/test', { bot: 'streamerbot' })).json(), { bot: 'streamerbot', address: '127.0.0.1', port: 8093, answered: true });
    assert.equal((await post(c, '/ui/api/integrations/test', { bot: 'speakerbot' })).json().answered, false);
    assert.equal((await post(c, '/ui/api/integrations/test', { bot: 'speakerbot', port: 9000 })).json().port, 9000);
    assert.equal((await post(c, '/ui/api/integrations/test', { bot: 'other' })).status, 400);
    assert.deepEqual(c.tcpCalls, [8093, 8083, 9000]);
    assert.equal((await post(c, '/ui/api/integrations/remote-token', {})).status, 409);
  });
});

describe('Force complete transition (TR1)', () => {
  test('calls the host for that canvas only', async () => {
    const c = await boot();
    assert.equal((await post(c, '/ui/api/transitions/force', { canvas: 'v' })).status, 200);
    assert.deepEqual(c.calls, [['transitions.forceComplete', { canvas: 'V' }]]);
    assert.equal((await post(c, '/ui/api/transitions/force', { canvas: 'x' })).status, 400);
  });
});
