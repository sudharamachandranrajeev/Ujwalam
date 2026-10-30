// SPDX-License-Identifier: GPL-2.0-or-later
// services/event-core/api: Server-Sent Events. Auth and browser checks, kind filter, raw-text path, heartbeat,
// slow-client drop with an unblocked bus, stall cut-off. All text is invented and never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseClient, parseKinds } from '../services/event-core/api/index.mjs';
import { createBus } from '../services/event-core/bus.mjs';
import { rig, raw, openSse, chat, tick, sleep, cleanup } from './event-core-api-helpers.mjs';

test.after(cleanup);

test('SSE auth and browser checks: same Bearer header, Host, Origin, Sec-Fetch; query and method rules', async () => {
  const r = await rig();
  try {
    const p = r.port;
    assert.equal((await openSse({ port: p })).status, 401);
    assert.equal((await openSse({ port: p, token: 'f'.repeat(64) })).status, 401);
    assert.equal((await openSse({ port: p, token: r.tokens.api, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await openSse({ port: p, token: r.tokens.api, headers: { 'sec-fetch-site': 'same-origin' } })).status, 403);
    assert.equal((await openSse({ port: p, token: r.tokens.api, headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await openSse({ port: p, token: r.tokens.api, query: '?token=x' })).status, 400);
    assert.equal((await openSse({ port: p, token: r.tokens.api, query: '?kinds=Chat' })).status, 400);
    assert.equal((await openSse({ port: p, token: r.tokens.api, query: `?kinds=${'a,'.repeat(9)}a` })).status, 400);
    assert.equal((await raw({ port: p, method: 'POST', path: '/events', token: r.tokens.api })).status, 405);
    const ok = await openSse({ port: p, token: r.tokens.api });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /^text\/event-stream/);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.ok(!Object.keys(ok.headers).some((h) => h.startsWith('access-control-')));
    await ok.waitFor(() => ok.comments.includes(': connected'));
    ok.close();
  } finally { await r.close(); }
});

test('SSE kind filter; chat text goes to the api role (the one intended raw-text path)', async () => {
  const r = await rig();
  try {
    const all = await openSse({ port: r.port, token: r.tokens.api });
    const alerts = await openSse({ port: r.port, token: r.tokens.api, query: '?kinds=alert.' });
    const both = await openSse({ port: r.port, token: r.tokens.api, query: '?kinds=alert.follow,system.' });
    await all.waitFor(() => all.comments.length > 0);
    const MARK = 'zq-sse-marker-text';
    chat(r.core, MARK);
    r.core.ingest({ kind: 'alert.follow', platform: 'twitch', source: 'mock', platformMessageId: 'sse-a1', user: { platformUserId: 'u1', displayName: 'Viewer1', roles: ['viewer'] } });
    r.core.ingest({ kind: 'alert.raid', platform: 'twitch', source: 'mock', platformMessageId: 'sse-a2', user: { platformUserId: 'u2', displayName: 'Viewer2', roles: ['viewer'] }, viewers: 5 });
    await all.waitFor(() => all.frames.length >= 3);
    await alerts.waitFor(() => alerts.frames.length >= 2);
    await both.waitFor(() => both.frames.length >= 1);
    await sleep(50);
    assert.deepEqual(all.frames.map((f) => f.event), ['chat.message', 'alert.follow', 'alert.raid']);
    assert.deepEqual(alerts.frames.map((f) => f.event), ['alert.follow', 'alert.raid']);
    assert.deepEqual(both.frames.map((f) => f.event), ['alert.follow']);
    assert.equal(all.frames[0].json.text, MARK); // authenticated local client gets the text
    assert.equal(all.frames[0].id, all.frames[0].json.id);
    assert.equal(r.api.stats().sseClients, 3);
    for (const c of [all, alerts, both]) c.close();
    // disconnect removes the subscriber
    for (let i = 0; i < 50 && r.api.stats().sseClients > 0; i++) await sleep(20);
    assert.equal(r.api.stats().sseClients, 0);
    assert.deepEqual(Object.keys(r.core.bus.stats().subscribers).filter((n) => n.startsWith('sse-')), []);
  } finally { await r.close(); }
});

test('SSE system role: system.* events only, never chat or alert text', async () => {
  const r = await rig();
  try {
    const def = await openSse({ port: r.port, token: r.tokens.system });
    assert.equal(def.status, 200);
    assert.equal((await openSse({ port: r.port, token: r.tokens.system, query: '?kinds=chat.' })).status, 403);
    const mixed = await openSse({ port: r.port, token: r.tokens.system, query: '?kinds=chat.,system.livestate' });
    await def.waitFor(() => def.comments.length > 0);
    chat(r.core, 'zq-system-role-text');
    r.core.actions.forSource('system').setLiveState('live', {});
    await def.waitFor(() => def.frames.length >= 1);
    await mixed.waitFor(() => mixed.frames.length >= 1);
    await sleep(50);
    assert.deepEqual(def.frames.map((f) => f.event), ['system.livestate']);
    assert.deepEqual(mixed.frames.map((f) => f.event), ['system.livestate']);
    assert.ok(!JSON.stringify(def.frames).includes('zq-system-role-text'));
    def.close(); mixed.close();
  } finally { await r.close(); }
});

test('SSE heartbeat comment arrives on the configured interval (real server)', async () => {
  const r = await rig({ limits: { sseHeartbeatMs: 40 } });
  try {
    const c = await openSse({ port: r.port, token: r.tokens.api });
    await c.waitFor(() => c.comments.filter((x) => x === ': hb').length >= 3, 3000);
    c.close();
  } finally { await r.close(); }
  assert.equal((await import('../services/event-core/api/server.mjs')).DEFAULT_LIMITS.sseHeartbeatMs, 15_000);
});

test('SSE max clients', async () => {
  const r = await rig({ limits: { sseMaxClients: 2 } });
  try {
    const a = await openSse({ port: r.port, token: r.tokens.api });
    const b = await openSse({ port: r.port, token: r.tokens.api });
    const c = await openSse({ port: r.port, token: r.tokens.api });
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 503]);
    a.close(); b.close();
  } finally { await r.close(); }
});

// ---- unit tests with a fake response and injected timers -------------------------------------------------------

function fakeRes({ blocked = false } = {}) {
  const res = new EventEmitter();
  res.writes = [];
  res.blocked = blocked;
  res.destroyed = false;
  res.write = (s) => { res.writes.push(s); return !res.blocked; };
  res.destroy = () => { res.destroyed = true; };
  res.unblock = () => { res.blocked = false; res.emit('drain'); };
  return res;
}
function fakeTimers() {
  const t = { intervals: [], timeouts: [], cleared: [] };
  const mk = (list) => (fn, ms) => { const h = { fn, ms, unref() {} }; list.push(h); return h; };
  t.setInterval = mk(t.intervals);
  t.setTimeout = mk(t.timeouts);
  t.clearInterval = (h) => t.cleared.push(h);
  t.clearTimeout = (h) => t.cleared.push(h);
  return t;
}
const ev = (n, kind = 'chat.message') => Object.freeze({ id: `e${String(n).padStart(12, '0')}-00000000-aaaaaaaa`, kind, text: `invented ${n}` });

test('slow client: oldest events dropped and counted, announced as a comment, the bus never waits', async () => {
  const bus = createBus();
  const res = fakeRes({ blocked: true });
  const timers = fakeTimers();
  const c = createSseClient({ res, bus, name: 'sse-t', prefixes: ['chat.'], queueMax: 3, heartbeatMs: 1000, stallMs: 5000, timers });
  const t0 = performance.now();
  for (let i = 1; i <= 2000; i++) bus.publish(ev(i));
  const publishMs = performance.now() - t0;
  await tick(); await tick();
  assert.ok(publishMs < 1000, `publish took ${publishMs} ms`);
  const s = c.stats();
  // event 1 was written (and blocked the socket); of the other 1999, the newest 3 are queued and 1996 were dropped
  assert.equal(res.writes.length, 1);
  assert.equal(s.queued, 3);
  assert.equal(s.dropped, 1996);
  assert.equal(bus.stats().subscribers['sse-t'].queued, 0);
  assert.equal(bus.stats().subscribers['sse-t'].dropped, 0);
  assert.equal(bus.stats().published, 2000);
  res.unblock();
  assert.equal(res.writes[1], ': dropped 1996 events (slow client)\n\n');
  assert.deepEqual(res.writes.slice(2).map((w) => JSON.parse(w.split('data: ')[1]).text), ['invented 1998', 'invented 1999', 'invented 2000']);
  assert.equal(c.stats().dropped, 1996);
  c.close();
  assert.deepEqual(Object.keys(bus.stats().subscribers), []);
});

test('slow client does not block a second, fast client on the same bus', async () => {
  const bus = createBus();
  const slow = fakeRes({ blocked: true });
  const fast = fakeRes();
  const a = createSseClient({ res: slow, bus, name: 'sse-a', prefixes: [], queueMax: 2, heartbeatMs: 1000, stallMs: 5000, timers: fakeTimers() });
  const b = createSseClient({ res: fast, bus, name: 'sse-b', prefixes: [], queueMax: 2, heartbeatMs: 1000, stallMs: 5000, timers: fakeTimers() });
  for (let i = 1; i <= 50; i++) { bus.publish(ev(i)); await tick(); }
  assert.equal(fast.writes.length, 50);
  assert.equal(b.stats().dropped, 0);
  assert.equal(a.stats().dropped, 47);
  a.close(); b.close();
});

test('stall: a socket blocked for stallMs is destroyed; a drain before then cancels the timer', async () => {
  const bus = createBus();
  const res = fakeRes({ blocked: true });
  const timers = fakeTimers();
  const c = createSseClient({ res, bus, name: 'sse-s', prefixes: [], queueMax: 3, heartbeatMs: 1000, stallMs: 5000, timers });
  bus.publish(ev(1));
  await tick();
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0].ms, 5000);
  res.unblock();
  assert.ok(timers.cleared.includes(timers.timeouts[0]));
  res.blocked = true;
  bus.publish(ev(2));
  await tick();
  assert.equal(timers.timeouts.length, 2);
  timers.timeouts[1].fn();
  assert.equal(res.destroyed, true);
  assert.equal(c.stats().stalled, true);
  assert.equal(c.stats().closed, true);
  assert.deepEqual(Object.keys(bus.stats().subscribers), []);
});

test('heartbeat (injected timer): comment each interval, skipped while the socket is blocked', async () => {
  const bus = createBus();
  const res = fakeRes();
  const timers = fakeTimers();
  const c = createSseClient({ res, bus, name: 'sse-h', prefixes: [], queueMax: 3, heartbeatMs: 15_000, stallMs: 5000, timers });
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 15_000);
  timers.intervals[0].fn();
  timers.intervals[0].fn();
  assert.deepEqual(res.writes, [': hb\n\n', ': hb\n\n']);
  res.blocked = true;
  bus.publish(ev(1));
  await tick();
  const n = res.writes.length;
  timers.intervals[0].fn();
  assert.equal(res.writes.length, n);
  c.close();
  assert.ok(timers.cleared.includes(timers.intervals[0]));
  timers.intervals[0].fn();
  assert.equal(res.writes.length, n);
});

test('a write that throws closes the client; event ids and kinds cannot inject SSE fields', async () => {
  const bus = createBus();
  const bad = fakeRes();
  bad.write = () => { throw new Error('socket gone'); };
  const c = createSseClient({ res: bad, bus, name: 'sse-x', prefixes: [], queueMax: 3, heartbeatMs: 1000, stallMs: 5000, timers: fakeTimers() });
  bus.publish(ev(1));
  await tick();
  assert.equal(c.stats().closed, true);
  const res = fakeRes();
  const c2 = createSseClient({ res, bus, name: 'sse-y', prefixes: [], queueMax: 3, heartbeatMs: 1000, stallMs: 5000, timers: fakeTimers() });
  bus.publish(Object.freeze({ id: 'a\nevent: evil', kind: 'chat.message\ndata: x', text: 'line1\nline2' }));
  await tick();
  const frame = res.writes[0];
  assert.equal(frame.split('\n\n').length, 2);
  assert.equal(frame.split('\n').filter((l) => l.startsWith('data:')).length, 1);
  assert.equal(frame.split('\n').filter((l) => l.startsWith('event:')).length, 1);
  c2.close();
});

test('parseKinds', () => {
  assert.deepEqual(parseKinds(null), []);
  assert.deepEqual(parseKinds(''), []);
  assert.deepEqual(parseKinds('chat.,alert.sub'), ['chat.', 'alert.sub']);
  for (const bad of ['Chat', 'chat. ', ',', 'a,,b', '1abc', 'a/b', 'x'.repeat(33), 'a,a,a,a,a,a,a,a,a']) assert.equal(parseKinds(bad), null, bad);
});
