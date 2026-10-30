// SPDX-License-Identifier: GPL-2.0-or-later
// Idempotent actions (P3 E7 follow-up): executor wrapper, gate key derivation, persistence across a restart, API key.
// All text, ids and names are invented. Temp dirs only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventCore, createIdempotentExecutor, idempotencyKeyFor, createAudit } from '../services/event-core/index.mjs';
import { dedupeKey } from '../services/event-core/dedupe.mjs';
import { openStore, DB_NAME, ACTION_KEEP_MS } from '../services/event-core/audit/store.mjs';
import { rig, rpc, cleanup as apiCleanup } from './event-core-api-helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = () => {
  const d = JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.json'), 'utf8'));
  return d;
};
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evidem-')); dirs.push(d); return d; };
after(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); apiCleanup(); });
const K = (c) => c.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- executor wrapper ------------------------------------------------------------------------------------

test('wrapper: a completed key is skipped, unkeyed actions always run, a bad key counts as unkeyed', () => {
  const ran = [];
  const x = createIdempotentExecutor({ executor: { execute: (a) => { ran.push(a.id); return 'r'; } } });
  assert.equal(x.execute({ id: 'a', idempotencyKey: K('a') }), 'r'); // synchronous without persistence
  assert.deepEqual(x.execute({ id: 'a', idempotencyKey: K('a') }), { skipped: 'completed' });
  x.execute({ id: 'b' }); x.execute({ id: 'b' });
  x.execute({ id: 'c', idempotencyKey: 'not-hex' }); x.execute({ id: 'c', idempotencyKey: 'not-hex' });
  assert.deepEqual(ran, ['a', 'b', 'b', 'c', 'c']);
  const s = x.stats();
  assert.deepEqual([s.executed, s.skippedCompleted, s.unkeyed, s.size], [1, 1, 4, 1]);
});

test('wrapper: a key in flight is skipped (running); a throwing action still completes its key', async () => {
  let release;
  const x = createIdempotentExecutor({ executor: { execute: (a) => (a.id === 'slow' ? new Promise((r) => { release = r; }) : (() => { throw new Error('boom'); })()) } });
  const first = x.execute({ id: 'slow', idempotencyKey: K('1') });
  assert.deepEqual(x.execute({ id: 'slow', idempotencyKey: K('1') }), { skipped: 'running' });
  release('done');
  assert.equal(await first, 'done');
  assert.equal(x.stateOf(K('1')), 'completed');
  assert.throws(() => x.execute({ id: 'err', idempotencyKey: K('2') }), /boom/);
  assert.deepEqual(x.execute({ id: 'err', idempotencyKey: K('2') }), { skipped: 'completed' });
});

test('wrapper: with persistence the start marker is awaited before the action runs, then done is queued', async () => {
  const log = [];
  const x = createIdempotentExecutor({
    executor: { execute: () => { log.push('execute'); return 1; } },
    persist: { start: async (k) => { log.push(`start:${k.slice(0, 2)}`); await sleep(5); log.push('committed'); }, done: (k, at, o) => log.push(`done:${o}`) },
  });
  const p = x.execute({ id: 'a', idempotencyKey: K('e') });
  assert.equal(typeof p.then, 'function');
  assert.deepEqual(log, ['start:ee']); // nothing ran yet: the loop is free while the marker commits
  assert.equal(await p, 1);
  assert.deepEqual(log, ['start:ee', 'committed', 'execute', 'done:ok']);
  assert.equal(x.stats().startDurable, 1);
});

test('wrapper: fail open when the start marker is late or fails (counted), never blocks', async () => {
  let n = 0;
  const late = createIdempotentExecutor({ executor: { execute: () => ++n }, startTimeoutMs: 20, persist: { start: () => new Promise(() => {}), done: () => {} } });
  const t0 = performance.now();
  assert.equal(await late.execute({ id: 'a', idempotencyKey: K('f') }), 1);
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(late.stats().startUnconfirmed, 1);
  const bad = createIdempotentExecutor({ executor: { execute: () => ++n }, persist: { start: () => Promise.reject(new Error('disk')), done: () => { throw new Error('x'); } } });
  assert.equal(await bad.execute({ id: 'a', idempotencyKey: K('f') }), 2);
  assert.equal(bad.stats().startFailed, 1);
  assert.deepEqual(await bad.execute({ id: 'a', idempotencyKey: K('f') }), { skipped: 'completed' });
});

test('wrapper: seed marks completed and ambiguous keys; retention and the key cap are bounded', () => {
  let t = 1_000_000;
  const ran = [];
  const x = createIdempotentExecutor({ executor: { execute: (a) => ran.push(a.idempotencyKey[0]) }, now: () => t, retentionMs: 1000, maxKeys: 3 });
  assert.equal(x.seed([
    { key: K('1'), started_at: t - 100, completed_at: t - 90 },
    { key: K('2'), started_at: t - 50, completed_at: null },
    { key: K('3'), started_at: t - 5000, completed_at: t - 4999 }, // older than retention: ignored
    { key: 'bad', started_at: t },
  ]), 2);
  assert.deepEqual(x.execute({ id: 'a', idempotencyKey: K('1') }), { skipped: 'completed' });
  assert.deepEqual(x.execute({ id: 'a', idempotencyKey: K('2') }), { skipped: 'ambiguous' });
  x.execute({ id: 'a', idempotencyKey: K('3') });
  assert.equal(x.stats().seededAmbiguous, 1);
  t += 10; x.execute({ id: 'a', idempotencyKey: K('4') });
  t += 10; x.execute({ id: 'a', idempotencyKey: K('5') }); // cap 3: the oldest (K1) is evicted
  assert.equal(x.has(K('1')), false);
  assert.equal(x.stats().evicted, 2);
  t += 2000; // past retention: everything expires on the next call
  x.execute({ id: 'a', idempotencyKey: K('5') });
  assert.deepEqual(ran, ['3', '4', '5', '5']);
  assert.ok(x.stats().expired >= 2);
});

// ---- gate key derivation ---------------------------------------------------------------------------------

test('key: platform origin is stable across processes; action, params, source and actor change it', () => {
  const pm = dedupeKey('twitch', 'msg-1');
  const base = (over = {}) => ({ id: 'effect.fire', source: 'rule', actor: 'a'.repeat(32), prov: { eventIds: ['rule-0', 'e-new-each-time'] }, ...over });
  const originOf = (id) => (id === 'e-new-each-time' ? pm : undefined);
  const k1 = idempotencyKeyFor(base(), { fx: 1 }, null, originOf);
  const k2 = idempotencyKeyFor(base({ prov: { eventIds: ['rule-0', 'other-id'] } }), { fx: 1 }, null, (id) => (id === 'other-id' ? pm : undefined));
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(k1, k2); // a resend gets a new internal event id but the same platform message id
  assert.notEqual(idempotencyKeyFor(base(), { fx: 2 }, null, originOf), k1);
  assert.notEqual(idempotencyKeyFor(base({ id: 'marker.drop' }), { fx: 1 }, null, originOf), k1);
  assert.notEqual(idempotencyKeyFor(base({ actor: 'b'.repeat(32) }), { fx: 1 }, null, originOf), k1);
  assert.notEqual(idempotencyKeyFor(base({ source: 'ui' }), { fx: 1 }, null, originOf), k1);
  // no platform origin: the nearest event id; no provenance and no client key: no key
  assert.notEqual(idempotencyKeyFor(base(), { fx: 1 }, null, () => undefined), k1);
  assert.equal(idempotencyKeyFor(base({ prov: { eventIds: [] } }), {}, null, originOf), null);
  // a client key is scoped by source
  assert.notEqual(idempotencyKeyFor(base({ source: 'ui' }), {}, 'client-key-1', originOf), idempotencyKeyFor(base({ source: 'api' }), {}, 'client-key-1', originOf));
});

test('gate: a malformed client key is refused; the act carries idempotencyKey only when there is an origin', () => {
  const acts = [];
  const core = createEventCore({ key: Buffer.alloc(32, 9), moderation: false, actions: { catalogue: catalogue(), executor: { execute: (a) => acts.push(a) } } });
  for (const bad of ['short', 'has space in it', 'x'.repeat(129), 42]) {
    assert.equal(core.actions.request({ id: 'state.read', params: {}, source: 'api', actor: 'api', idempotencyKey: bad }).reason, 'bad-idempotency-key');
  }
  core.actions.request({ id: 'state.read', params: {}, source: 'api', actor: 'api' });
  core.actions.request({ id: 'state.read', params: {}, source: 'api', actor: 'api', idempotencyKey: 'client-key-1' });
  core.actions.request({ id: 'state.read', params: {}, source: 'api', actor: 'api', idempotencyKey: 'client-key-1' }); // skipped
  assert.equal(acts.length, 2);
  assert.equal('idempotencyKey' in acts[0], false);
  assert.match(acts[1].idempotencyKey, /^[0-9a-f]{64}$/);
  assert.equal(core.stats().idempotency.skippedCompleted, 1);
});

// ---- across a restart, with the real audit database ------------------------------------------------------

function mkCore(dataDir, ran, extra = {}) {
  const core = createEventCore({
    key: Buffer.alloc(32, 5), moderation: false, dedupe: { windowMs: 1 }, // windowMs 1: the dedupe misses the resend on purpose
    audit: { dataDir, purgeOnStart: false },
    actions: { catalogue: catalogue(), executor: { execute: (a) => { ran.push(a.idempotencyKey); return 'ok'; } }, ...extra },
  });
  const results = [];
  // P3 dry-run: a chat-triggered action never executes, so a chat origin cannot reach the executor. The restart tests use an
  // untainted API request whose client key is derived from the message id (a resend of the same message = the same key).
  core.bus.subscribe({
    name: 'idem-rule', kinds: ['chat.'],
    handler: (ev) => results.push(core.actions.request({ id: 'state.read', params: {}, source: 'api', actor: 'api', idempotencyKey: `msg-${ev.platformMessageId}` })),
  });
  // the bus delivers on a later turn: wait for the rule to have made its request
  const next = async (n) => { for (let i = 0; i < 1000 && results.length < n; i++) await new Promise((r) => setImmediate(r)); return results[n - 1]; };
  return { core, results, next };
}
const ingest = (core, id) => core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: id, user: { platformUserId: 'u1', displayName: 'ViewerOne' }, text: '!fx' });

test('restart: a completed action is not run again when the same platform message is resent', async () => {
  const dir = tmp();
  const ran = [];
  const a = mkCore(dir, ran);
  await a.core.ready;
  a.core.actions.setLiveState('live', { source: 'system' });
  ingest(a.core, 'resend-1');
  const d1 = await (await a.next(1)).dispatch;
  assert.deepEqual([a.results[0].verdict, d1.ok, d1.result], ['allow', true, 'ok']);
  await a.core.audit.close();

  const b = mkCore(dir, ran);
  await b.core.ready;
  assert.equal(b.core.stats().idempotency.load.seeded, 1);
  b.core.actions.setLiveState('live', { source: 'system' });
  assert.equal(ingest(b.core, 'resend-1').status, 'published'); // the dedupe let it through
  const d2 = await (await b.next(1)).dispatch;
  assert.deepEqual(d2, { ok: false, error: 'skipped', skipped: 'completed' });
  ingest(b.core, 'resend-2'); // a different message still runs
  await (await b.next(2)).dispatch;
  assert.equal(ran.length, 2);
  assert.equal(new Set(ran).size, 2);
  await b.core.audit.close();
});

test('restart: a started-but-not-completed key is ambiguous, skipped, counted and audited', async () => {
  const dir = tmp();
  const ran = [];
  // Write only the start marker for the key the rule will derive, as a crash after the commit would leave it.
  const probe = mkCore(dir, ran);
  await probe.core.ready;
  probe.core.actions.setLiveState('live', { source: 'system' });
  const key = idempotencyKeyFor({ id: 'state.read', source: 'api', actor: 'api', prov: { eventIds: [] } }, {}, 'msg-amb-1', () => undefined);
  await probe.core.audit.recordActionStart(key, Date.now());
  await probe.core.audit.close();

  const b = mkCore(dir, ran);
  await b.core.ready;
  assert.deepEqual([b.core.stats().idempotency.load.seeded, b.core.stats().idempotency.load.ambiguous], [1, 1]);
  b.core.actions.setLiveState('live', { source: 'system' });
  ingest(b.core, 'amb-1');
  assert.deepEqual(await (await b.next(1)).dispatch, { ok: false, error: 'skipped', skipped: 'ambiguous' });
  assert.equal(ran.length, 0);
  await b.core.audit.flush();
  const page = await b.core.audit.exportPage({ limit: 500 });
  const rows = (page.rows ?? page).filter((r) => r.subtype === 'action-ambiguous');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].detail).count, 1);
  await b.core.audit.close();
});

test('audit: action keys persist with started_at/completed_at and only hash keys are accepted', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, purgeOnStart: false });
  await a.ready;
  const now = Date.now();
  await a.recordActionStart(K('a'), now - 10);
  a.recordActionDone(K('a'), now - 5, 'ok');
  await a.recordActionStart(K('b'), now - 4);
  await assert.rejects(a.recordActionStart('raw-id-not-a-hash', now), /BAD_KEY/);
  const rows = await a.loadActionKeys(60_000);
  assert.deepEqual(rows.map((r) => [r.key[0], r.completed_at != null]), [['a', true], ['b', false]]);
  assert.equal((await a.loadActionKeys(1)).length, 0); // only inside the window
  await a.close();
});

test('store: action keys older than the retention (1 h) are pruned by the writer', () => {
  const s = openStore({ file: path.join(tmp(), DB_NAME) });
  const t = 10 * ACTION_KEEP_MS;
  s.appendBatch([], [], [], [{ key: K('1'), op: 'start', at: t - 2 * ACTION_KEEP_MS }, { key: K('1'), op: 'done', at: t - 2 * ACTION_KEEP_MS, outcome: 'ok' }]);
  assert.equal(s.loadActionKeys(0).length, 1);
  s.appendBatch([], [], [], [{ key: K('2'), op: 'start', at: t }]);
  assert.deepEqual(s.loadActionKeys(0).map((r) => r.key[0]), ['2']);
  s.close();
});

// ---- API ------------------------------------------------------------------------------------------------

test('api: actions.request with an idempotencyKey runs once per key; a bad key is invalid params', async () => {
  let n = 0;
  const r = await rig({ executor: { execute: () => ({ n: ++n }) } });
  try {
    const one = await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read', idempotencyKey: 'client-retry-0001' });
    const two = await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read', idempotencyKey: 'client-retry-0001' });
    const other = await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read', idempotencyKey: 'client-retry-0002' });
    const none = await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read' });
    assert.deepEqual(one.result.dispatch, { ok: true, result: { n: 1 } });
    assert.deepEqual(two.result.dispatch, { ok: false, error: 'skipped', skipped: 'completed' });
    assert.deepEqual(other.result.dispatch.result, { n: 2 });
    assert.deepEqual(none.result.dispatch.result, { n: 3 });
    const bad = await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read', idempotencyKey: 'bad key' });
    assert.equal(bad.error.code, -32602);
  } finally { await r.close(); }
});
