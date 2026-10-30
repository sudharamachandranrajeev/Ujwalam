// SPDX-License-Identifier: GPL-2.0-or-later
// services/event-core: dedupe window, bus (bounded queues, filters, counters) and the ingest pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBus } from '../services/event-core/bus.mjs';
import { createDedupe } from '../services/event-core/dedupe.mjs';
import { createEventCore } from '../services/event-core/index.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evbus-')); dirs.push(d); return d; };
const tick = () => new Promise((r) => setImmediate(r));
const ev = (kind, extra = {}) => ({ kind, platform: 'twitch', platformMessageId: null, ...extra });

test('dedupe: same (platform, id) is a duplicate; other platform or id is not', () => {
  const d = createDedupe();
  assert.equal(d.isDuplicate(ev('chat.message', { platformMessageId: 'a' }), 0), false);
  assert.equal(d.isDuplicate(ev('chat.message', { platformMessageId: 'a' }), 1), true);
  assert.equal(d.isDuplicate(ev('chat.message', { platformMessageId: 'a', platform: 'youtube' }), 2), false);
  assert.equal(d.isDuplicate(ev('chat.message', { platformMessageId: 'b' }), 3), false);
  assert.equal(d.stats().duplicates, 1);
});

test('dedupe: window by time, measured from the first sighting', () => {
  const d = createDedupe({ windowMs: 1000 });
  const m = ev('chat.message', { platformMessageId: 'a' });
  assert.equal(d.isDuplicate(m, 0), false);
  assert.equal(d.isDuplicate(m, 999), true);      // inside the window
  assert.equal(d.isDuplicate(m, 1000), false);    // expired (and re-recorded from 1000)
  assert.equal(d.isDuplicate(m, 1500), true);
  assert.equal(d.stats().expired, 1);
});

test('dedupe: a repeat does not extend the window', () => {
  const d = createDedupe({ windowMs: 1000 });
  const m = ev('chat.message', { platformMessageId: 'a' });
  d.isDuplicate(m, 0);
  d.isDuplicate(m, 900);
  assert.equal(d.isDuplicate(m, 1100), false);
});

test('dedupe: window by count evicts the oldest', () => {
  const d = createDedupe({ windowMs: 1e9, maxEntries: 3 });
  for (const id of ['a', 'b', 'c', 'd']) d.isDuplicate(ev('chat.message', { platformMessageId: id }), 0);
  assert.equal(d.size(), 3);
  assert.equal(d.stats().evictedByCount, 1);
  assert.equal(d.isDuplicate(ev('chat.message', { platformMessageId: 'a' }), 1), false); // evicted, so new again
  assert.equal(d.isDuplicate(ev('chat.message', { platformMessageId: 'd' }), 1), true);
});

test('dedupe: events without a platform id are never deduped and are counted', () => {
  const d = createDedupe();
  for (let i = 0; i < 5; i++) assert.equal(d.isDuplicate(ev('alert.follow'), i), false);
  assert.equal(d.stats().noId, 5);
  assert.equal(d.size(), 0);
});

test('bus: delivers in order to every matching subscriber', async () => {
  const bus = createBus();
  const a = []; const b = [];
  bus.subscribe({ name: 'a', handler: (e) => a.push(e.n) });
  bus.subscribe({ name: 'b', handler: (e) => b.push(e.n) });
  for (let i = 0; i < 10; i++) bus.publish({ kind: 'chat.message', n: i });
  await tick();
  assert.deepEqual(a, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(b, a);
  assert.equal(bus.stats().published, 10);
});

test('bus: publish never runs a handler on the publisher call stack', () => {
  const bus = createBus();
  let ran = false;
  bus.subscribe({ handler: () => { ran = true; } });
  bus.publish({ kind: 'chat.message' });
  assert.equal(ran, false);
});

test('bus: filters by kind prefix', async () => {
  const bus = createBus();
  const got = { chat: [], alert: [], sub: [], all: [], many: [] };
  bus.subscribe({ name: 'chat', kinds: 'chat.', handler: (e) => got.chat.push(e.kind) });
  bus.subscribe({ name: 'alert', kinds: ['alert'], handler: (e) => got.alert.push(e.kind) });
  bus.subscribe({ name: 'sub', kinds: ['alert.sub'], handler: (e) => got.sub.push(e.kind) });
  bus.subscribe({ name: 'all', handler: (e) => got.all.push(e.kind) });
  bus.subscribe({ name: 'many', kinds: ['system.panic', 'alert.raid'], handler: (e) => got.many.push(e.kind) });
  for (const kind of ['chat.message', 'alert.sub', 'alert.resub', 'alert.raid', 'system.panic', 'system.connected']) bus.publish({ kind });
  await tick();
  assert.deepEqual(got.chat, ['chat.message']);
  assert.deepEqual(got.alert, ['alert.sub', 'alert.resub', 'alert.raid']);
  assert.deepEqual(got.sub, ['alert.sub']); // prefix: 'alert.sub' would also match 'alert.subx'
  assert.equal(got.all.length, 6);
  assert.deepEqual(got.many, ['alert.raid', 'system.panic']);
  assert.equal(bus.stats().subscribers.chat.matched, 1);
});

test('bus: a stuck subscriber drops its own oldest events and never blocks others or the publisher', async () => {
  const bus = createBus();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowSeen = [];
  const fastSeen = [];
  bus.subscribe({ name: 'slow', limit: 5, handler: async (e) => { slowSeen.push(e.n); await gate; } });
  bus.subscribe({ name: 'fast', limit: 1000, handler: (e) => fastSeen.push(e.n) });
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) bus.publish({ kind: 'chat.message', n: i });
  assert.ok(performance.now() - t0 < 200, 'publish returned without waiting for the stuck handler');
  await tick();
  assert.equal(fastSeen.length, 100);
  const mid = bus.stats().subscribers;
  assert.equal(mid.fast.dropped, 0);
  // The drain starts after the synchronous burst, so 95 oldest were dropped, 1 is in the handler, 4 wait.
  assert.equal(mid.slow.queued, 4);
  assert.equal(mid.slow.dropped, 95);
  release();
  await tick(); await tick();
  assert.deepEqual(slowSeen, [95, 96, 97, 98, 99]); // only the newest 5 survive
  const end = bus.stats().subscribers.slow;
  assert.equal(end.delivered, 5);
  assert.equal(end.delivered + end.dropped, 100);
});

test('bus: a throwing or rejecting handler is counted and the subscriber keeps going', async () => {
  const bus = createBus();
  const seen = [];
  bus.subscribe({ name: 'bad', handler: (e) => { seen.push(e.n); if (e.n % 2 === 0) throw new Error('x'); return Promise.reject(new Error('y')); } });
  for (let i = 0; i < 4; i++) bus.publish({ kind: 'chat.message', n: i });
  await tick();
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.equal(bus.stats().subscribers.bad.errors, 4);
});

test('bus: unsubscribe stops delivery; names must be unique; bad args throw', async () => {
  const bus = createBus();
  const seen = [];
  const off = bus.subscribe({ name: 'x', handler: (e) => seen.push(e.n) });
  assert.throws(() => bus.subscribe({ name: 'x', handler: () => {} }), /duplicate/);
  assert.throws(() => bus.subscribe({ name: 'y' }), TypeError);
  assert.throws(() => bus.subscribe({ name: 'z', handler: () => {}, limit: 0 }), RangeError);
  bus.publish({ kind: 'chat.message', n: 1 });
  off();
  bus.publish({ kind: 'chat.message', n: 2 });
  await tick();
  assert.deepEqual(seen, []); // the first was still queued when unsubscribed, so it is discarded too
  assert.deepEqual(bus.stats().subscribers, {});
  assert.equal(bus.stats().published, 2);
});

test('core: ingest builds, validates, dedupes, publishes; counters add up', async () => {
  const core = createEventCore({ dataDir: tmp() });
  const chat = []; const all = [];
  core.bus.subscribe({ name: 'chat', kinds: ['chat.'], handler: (e) => chat.push(e) });
  core.bus.subscribe({ name: 'all', handler: (e) => all.push(e) });
  const msg = (id, extra = {}) => ({
    kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: id,
    user: { platformUserId: 'u1', displayName: 'A' }, text: 'hi', ...extra,
  });
  assert.equal(core.ingest(msg('m1')).status, 'published');
  assert.equal(core.ingest(msg('m1')).status, 'deduped');
  assert.equal(core.ingest(msg('m1', { platform: 'kick' })).status, 'published');
  assert.equal(core.ingest(msg(null)).status, 'published');
  assert.equal(core.ingest(msg(null)).status, 'published'); // no id: not deduped
  const bad = core.ingest(msg('m9', { text: '' }));
  assert.equal(bad.status, 'invalid');
  assert.ok(bad.errors.some((e) => e.path === 'text'));
  assert.equal(core.ingest({ kind: 'alert.follow', platform: 'twitch', source: 'mock', user: { platformUserId: 'u2', displayName: 'B' } }).status, 'published');
  assert.equal(core.ingest({ kind: 'system.panic', platform: 'local', source: 'system', reason: 'r' }).status, 'published');
  await tick();
  const s = core.stats();
  assert.equal(s.published, 6);
  assert.equal(s.deduped, 1);
  assert.equal(s.noPlatformId, 4); // two null-id chats, one follow, one panic
  assert.equal(s.invalid, 1);
  assert.equal(chat.length, 4);
  assert.equal(all.length, 6);
  assert.equal(s.subscribers.chat.dropped, 0);
  const ids = all.map((e) => e.id);
  assert.deepEqual([...ids].sort(), ids, 'delivery order is creation order');
  assert.equal(all[0].user.pseudoId, core.pseudoId('twitch', 'u1'));
});

test('core: uses and reuses the key file in the data dir', () => {
  const dir = tmp();
  const a = createEventCore({ dataDir: dir }).pseudoId('twitch', 'u1');
  const b = createEventCore({ dataDir: dir }).pseudoId('twitch', 'u1');
  const c = createEventCore({ dataDir: tmp() }).pseudoId('twitch', 'u1');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(existsSync(path.join(dir, 'pseudo.key')));
});

test('core: needs a data dir (explicit or from the profile)', () => {
  assert.throws(() => createEventCore({ profilePath: path.join(tmp(), 'none.json') }), /needs a data dir/);
});

test('core: dedupe limits are configurable', () => {
  const core = createEventCore({ key: Buffer.alloc(32, 1), dedupe: { maxEntries: 2, windowMs: 1e9 } });
  const m = (id) => ({ kind: 'alert.bits', platform: 'twitch', source: 'mock', platformMessageId: id, user: { platformUserId: 'u', displayName: 'A' }, amount: 5 });
  for (const id of ['a', 'b', 'c']) core.ingest(m(id));
  assert.equal(core.ingest(m('a')).status, 'published'); // evicted by count
  assert.equal(core.ingest(m('c')).status, 'deduped');
});
