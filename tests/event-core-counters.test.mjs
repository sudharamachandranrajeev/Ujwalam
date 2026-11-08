// SPDX-License-Identifier: GPL-3.0-or-later
// Audience counters (D250): read-only Streamer.bot globals -> system.counter -> overlay server -> counter page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createEventCore } from '../services/event-core/index.mjs';
import { checkCounterConfig, COUNTERS_FLAG, createAudienceCounters, loadCounterConfig, toCount } from '../services/event-core/counters.mjs';
import { createStreamerbotConnector } from '../services/event-core/streamerbot/connector.mjs';
import { startMockStreamerbot } from '../tools/mock/mock-streamerbot.mjs';
import { createCounterCache, createRemoteBus, OWN_OVERLAYS_DIR } from '../services/overlay-server/index.mjs';
import { createStaticServer } from '../services/overlay-server/static.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';

const flagsOn = { isOn: (id) => id === COUNTERS_FLAG };
const flagsOff = { isOn: () => false };
const CFG = { pollMs: 60000, variables: { twitch: { followers: 'tw_f' }, youtube: { subscribers: 'yt_s' }, kick: { followers: 'k_f' } } };
async function waitFor(cond, ms = 4000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
}
function rig(globals, flags = flagsOn) {
  const core = createEventCore({ key: randomBytes(32) });
  const events = [];
  core.bus.subscribe({ name: 'collect', kinds: ['system.counter'], handler: (e) => { events.push(e); } });
  const reads = [];
  const c = createAudienceCounters({ core, flags, config: CFG, setTimer: () => null, clearTimer: () => {}, readGlobal: async (n) => { reads.push(n); return globals[n] ?? null; } });
  return { core, events, reads, c };
}

test('config: the committed file loads; the flag exists and is off by default; bad configs are refused', () => {
  const cfg = loadCounterConfig();
  assert.deepEqual(cfg.entries.map((e) => `${e.platform}.${e.counter}`), ['twitch.followers', 'youtube.subscribers', 'kick.followers']);
  const def = loadDefinitions().find((f) => f.id === COUNTERS_FLAG);
  assert.equal(def.default, false);
  assert.throws(() => checkCounterConfig({ ...CFG, pollMs: 100 }), /pollMs/);
  assert.throws(() => checkCounterConfig({ ...CFG, variables: { discord: { followers: 'x' } } }), /platform/);
  assert.throws(() => checkCounterConfig({ ...CFG, variables: { twitch: { viewers: 'x' } } }), /counter/);
  assert.throws(() => checkCounterConfig({ ...CFG, variables: { twitch: { followers: 'bad name!' } } }), /variable name/);
});

test('toCount: whole numbers and digit strings only', () => {
  assert.equal(toCount(339), 339);
  assert.equal(toCount(' 546 '), 546);
  assert.equal(toCount(0), 0);
  for (const v of [null, undefined, -1, 1.5, '12a', '', 'NaN', 2e9, {}, [], true]) assert.equal(toCount(v), null, String(v));
});

test('poll: publishes system.counter on a change only; unknown or junk globals publish nothing', async () => {
  const g = { tw_f: 339, yt_s: '546', k_f: 'lots' };
  const r = rig(g);
  r.c.start();
  await waitFor(() => r.events.length === 2, 2000, 'two counters');
  assert.deepEqual(r.events.map((e) => [e.kind, e.platform, e.source, e.counter, e.value]),
    [['system.counter', 'twitch', 'streamerbot', 'followers', 339], ['system.counter', 'youtube', 'streamerbot', 'subscribers', 546]]);
  await r.c.poll();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.events.length, 2, 'same values: nothing new');
  g.tw_f = 340;
  await r.c.poll();
  await waitFor(() => r.events.length === 3);
  assert.equal(r.events[2].value, 340);
  r.c.stop();
});

test('live follow adds 1 to a known count; never guesses an unknown one; the next read wins', async () => {
  const g = { tw_f: 339 };
  const r = rig(g);
  r.c.start();
  await waitFor(() => r.events.length === 1);
  const follow = (platform) => r.core.ingest({ kind: 'alert.follow', platform, source: 'mock', platformMessageId: `f-${Math.random()}`, user: { platformUserId: '1', displayName: 'Viewer', roles: ['viewer'] } });
  follow('twitch');
  await waitFor(() => r.events.length === 2, 2000, 'follow bump');
  assert.equal(r.events[1].value, 340);
  follow('kick'); // kick count never read: nothing
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.events.length, 2);
  await r.c.poll(); // the global still says 339: it replaces the bumped value
  await waitFor(() => r.events.length === 3);
  assert.equal(r.events[2].value, 339);
  r.c.stop();
});

test('flag off: no reads, no events, follows ignored', async () => {
  const r = rig({ tw_f: 339 }, flagsOff);
  r.c.start();
  await r.c.poll();
  await new Promise((res) => setTimeout(res, 30));
  assert.deepEqual([r.reads, r.events], [[], []]);
  r.c.stop();
});

test('connector readGlobal: GetGlobal (persisted) against the mock; missing -> null; never writes', async () => {
  const mock = await startMockStreamerbot();
  const core = createEventCore({ key: randomBytes(32) });
  const sb = createStreamerbotConnector({ core, url: mock.url, backoff: { baseMs: 20, capMs: 80 }, helloTimeoutMs: 1000, authTimeoutMs: 1000 });
  try {
    assert.equal(await sb.readGlobal('tw_f'), null, 'not connected yet');
    sb.start();
    await waitFor(() => sb.state() === 'connected');
    mock.setGlobal('tw_f', 339);
    assert.equal(await sb.readGlobal('tw_f'), 339);
    assert.equal(await sb.readGlobal('nope'), null);
    assert.deepEqual(mock.globalReads, [{ variable: 'tw_f', persisted: true }, { variable: 'nope', persisted: true }]);
    assert.deepEqual(mock.doActions, [], 'nothing sent');
    await assert.rejects(() => sb.readGlobal('bad name!'), RangeError);
  } finally { sb.stop(); await mock.close(); }
});

test('overlay server: counters.json serves the latest counts only while the flag is on', async () => {
  const cache = createCounterCache();
  let on = false;
  const flags = { isOn: (id) => id === COUNTERS_FLAG && on };
  cache.onEvent({ kind: 'system.counter', platform: 'twitch', counter: 'followers', value: 339 });
  cache.onEvent({ kind: 'system.counter', platform: 'twitch', counter: 'followers', value: -3 }); // junk: ignored
  cache.onEvent({ kind: 'chat.message', platform: 'twitch', counter: 'followers', value: 1 });
  const stat = createStaticServer({ root: path.resolve('legacy'), port: 0, ownOverlays: OWN_OVERLAYS_DIR, countersJson: () => cache.json(flags) });
  await stat.listen();
  const get = () => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: stat.port, path: '/_ujwalam/counters.json', headers: { host: `127.0.0.1:${stat.port}` } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b), cache: r.headers['cache-control'] })); }).on('error', rej));
  try {
    assert.deepEqual((await get()).json, { on: false });
    on = true;
    const r = await get();
    assert.deepEqual([r.status, r.json, r.cache], [200, { on: true, counters: { twitch: { followers: 339 } } }, 'no-store']);
  } finally { await stat.close(); }
});

test('remote bus: a subscriber gets only its kinds (counter events never reach chat handlers)', async () => {
  const frames = [{ kind: 'system.counter' }, { kind: 'chat.message' }].map((e) => `data: ${JSON.stringify(e)}

`);
  let served = false;
  const fetchFn = async () => {
    if (served) return new Promise(() => {}); // later reconnects never answer
    served = true;
    return { ok: true, status: 200, body: (async function* () { for (const f of frames) yield Buffer.from(f); })() };
  };
  const bus = createRemoteBus({ url: 'http://127.0.0.1:1/events', token: 'x'.repeat(64), fetchFn, log: () => {} });
  const chat = [];
  const all = [];
  bus.subscribe({ kinds: ['chat.'], handler: (e) => chat.push(e.kind) });
  bus.subscribe({ handler: (e) => all.push(e.kind) });
  bus.start();
  try {
    await waitFor(() => all.length === 2, 2000, 'two frames');
    assert.deepEqual(chat, ['chat.message']);
    assert.deepEqual(all, ['system.counter', 'chat.message']);
  } finally { bus.stop(); }
});

test('counter page: params, value pick, text; nothing shown when off, unknown or junk', () => {
  const src = readFileSync(path.join(OWN_OVERLAYS_DIR, 'ujwalam-counter', 'counter.js'), 'utf8');
  const ctx = { URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const U = ctx.UjwCounter;
  const p = U.parseParams('?platform=twitch&counter=followers&label=Twitch&noun=Followers');
  assert.deepEqual({ ...p }, { platform: 'twitch', counter: 'followers', label: 'Twitch', noun: 'Followers' });
  assert.equal(U.parseParams('?platform=discord&counter=followers'), null);
  assert.equal(U.parseParams('?platform=twitch&counter=viewers'), null);
  const j = { on: true, counters: { twitch: { followers: 339 } } };
  assert.equal(U.pick(j, p), 339);
  assert.equal(U.text(p, 339), 'Twitch 339 Followers');
  assert.equal(U.pick({ on: false }, p), null);
  assert.equal(U.pick({ on: true, counters: {} }, p), null);
  assert.equal(U.pick({ on: true, counters: { twitch: { followers: '339' } } }, p), null);
  assert.equal(U.text({ label: '', noun: '' }, 5), '5');
  assert.ok(!/innerHTML|eval\(|https?:\/\//.test(src), 'safe DOM, no remote loads');
});
