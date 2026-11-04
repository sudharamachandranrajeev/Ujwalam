// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/livelock: attacks from the independent E4b review (docs/evidence/2026-10-28-p3-e4b-opus-review.md),
// ported from the reviewer's scratch file. Each test asserts the SECURE behaviour, so a failure means the attack works.
// Before the review fixes (2026-10-29) A1, A2, A3, A4, A5 and A5b failed; A6 to A12 passed. The tests after A12 cover
// the same fixes from other angles (findings 1 to 5 and 8). All text, ids and names are invented. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as L from '../services/event-core/livelock/index.mjs';
import { createEventCore } from '../services/event-core/index.mjs';
import { METHODS, validateParams } from '../services/event-core/api/methods.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = () => JSON.parse(readFileSync(path.join(repo, 'data', 'actions', 'catalogue.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'e4b-attack-')); dirs.push(d); return d; };

function gateWith(persist, extra = {}, wrapperExtra = {}) {
  const ran = [];
  const idem = L.createIdempotentExecutor({
    executor: { execute: (a) => { ran.push({ id: a.id, liveState: a.liveState }); return 'ran'; } },
    persist, startTimeoutMs: 250, ...wrapperExtra,
  });
  const gate = L.createActionGate({ catalogue: doc(), executor: idem, liveStaleMs: 10_000_000, ...extra });
  return { gate, ran, idem };
}
const stalled = { start: () => new Promise(() => {}), done: () => {} };
const slowOk = (ms) => ({ start: () => sleep(ms), done: () => {} });
// Confirms every step (one, or two for an on-air write while live) with the right phrase.
const confirmAll = (h, r) => {
  let c = h.confirm(r.confirm.confirmId, r.confirm.phrase, r.confirm.actionHash);
  while (c.verdict === 'confirm') c = h.confirm(c.confirm.confirmId, c.confirm.phrase, c.confirm.actionHash);
  return c;
};

// A1: offline confirmation + keyed dispatch waits on the durable start; stream goes live meanwhile; the write must not
// run while live with no durable audit and only the offline "yes".
test('A1 TOCTOU: offline-confirmed keyed on-air write must not run after the stream went live without a durable audit', async () => {
  const { gate, ran } = gateWith(stalled);
  const sys = gate.forSource('system');
  const api = gate.forSource('api');
  sys.setLiveState('offline');
  const r = api.request({ id: 'scene.switch', params: { scene: 'x' }, idempotencyKey: 'client-key-0001' });
  assert.equal(r.verdict, 'confirm');
  assert.equal(r.confirm.step, undefined, 'offline: single step');
  const c = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  assert.equal(c.verdict, 'allow');
  sys.setLiveState('live'); // the stream starts while the dispatch waits for the marker
  const d = await c.dispatch;
  assert.equal(gate.state().liveState, 'live');
  assert.deepEqual(ran, [], `ran while live, unaudited: ${JSON.stringify(ran)} dispatch=${JSON.stringify(d)}`);
  assert.deepEqual(d, { ok: false, error: L.AUDIT_UNAVAILABLE });
});

// A2: a confirmed strict live write is waiting for its durable start; panic is engaged; the write must not run.
test('A2 TOCTOU: panic engaged while a confirmed live write waits for its audit must stop it', async () => {
  const { gate, ran } = gateWith(slowOk(100));
  gate.forSource('system').setLiveState('live');
  const api = gate.forSource('api');
  const r = api.request({ id: 'scene.create', params: { name: 'x' } }); // class write, live: one "yes, on air"
  const c = api.confirm(r.confirm.confirmId, 'yes, on air', r.confirm.actionHash);
  assert.equal(c.verdict, 'allow');
  await sleep(10);
  assert.equal(api.panic({ reason: 'stop' }).ok, true);
  const d = await c.dispatch;
  assert.deepEqual(ran, [], 'ran after panic');
  assert.deepEqual(d, { ok: false, error: L.PANIC_REFUSED });
});

// A3: same, but the live epoch changes (offline, then live) while the strict write waits.
test('A3 TOCTOU: a live-epoch change while a confirmed write waits for its audit must stop it', async () => {
  const { gate, ran } = gateWith(slowOk(100));
  const sys = gate.forSource('system');
  sys.setLiveState('live');
  const api = gate.forSource('api');
  const r = api.request({ id: 'scene.create', params: { name: 'x' } });
  const c = api.confirm(r.confirm.confirmId, 'yes, on air', r.confirm.actionHash);
  await sleep(10);
  sys.setLiveState('offline'); sys.setLiveState('live'); // epoch +2, same state as confirmed
  const d = await c.dispatch;
  assert.deepEqual(ran, [], 'ran in another epoch than the one confirmed');
  assert.deepEqual(d, { ok: false, error: L.LIVE_STATE_CHANGED });
});

// A4: the core without an audit attached must refuse a live write (requirement 3).
test('A4 fail-open: createEventCore without an audit must refuse a live write (nothing can be durably audited)', async () => {
  const ran = [];
  const core = createEventCore({ key: Buffer.alloc(32, 3), moderation: false, actions: { catalogue: doc(), executor: { execute: (a) => { ran.push(a.id); return 'ran'; } } } });
  await core.ready;
  core.actions.setLiveState('live', { source: 'system' });
  const api = core.actions.forSource('api');
  const r = api.request({ id: 'scene.create', params: {} });
  const c = api.confirm(r.confirm.confirmId, 'yes, on air', r.confirm.actionHash);
  assert.deepEqual(await c.dispatch, { ok: false, error: L.AUDIT_UNAVAILABLE });
  assert.deepEqual(ran, [], 'live write ran with no audit attached');
  assert.equal(core.stats().refusedNoAudit, 1);
});

// A5: the client idempotency key must not be spent by a fail-closed refusal; once the audit recovers, the retry runs.
test('A5 key poisoning: a retry after an audit-unavailable refusal must be able to run (nothing ran the first time)', async () => {
  let fail = true;
  const persist = { start: () => (fail ? Promise.reject(Object.assign(new Error('x'), { code: 'QUEUE_FULL' })) : Promise.resolve()), done: () => {} };
  const { gate, ran } = gateWith(persist);
  gate.forSource('system').setLiveState('live');
  const api = gate.forSource('api');
  const go = async () => {
    const r = api.request({ id: 'scene.create', params: { name: 'a' }, idempotencyKey: 'retry-key-0001' });
    const c = api.confirm(r.confirm.confirmId, 'yes, on air', r.confirm.actionHash);
    return c.dispatch;
  };
  const d1 = await go();
  assert.equal(d1.ok, false);
  assert.equal(d1.error, 'audit-unavailable');
  fail = false;
  const d2 = await go();
  assert.deepEqual(ran.map((x) => x.id), ['scene.create'], `retry did not run: ${JSON.stringify(d2)}`);
  assert.deepEqual(d2, { ok: true, result: 'ran' });
  // ...and the key is spent now: a third try is skipped, reported as not ok
  assert.deepEqual(await go(), { ok: false, error: 'skipped', skipped: 'completed' });
});

// A5b: a skipped dispatch must not be reported as ok:true.
test('A5b reporting: a skipped dispatch must not be reported as ok:true', async () => {
  const { gate } = gateWith(null);
  gate.forSource('system').setLiveState('offline');
  const api = gate.forSource('api');
  const once = () => { const r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'dup-key-00001' }); return api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).dispatch; };
  assert.deepEqual(await once(), { ok: true, result: 'ran' });
  const d = await once();
  assert.notEqual(d.ok === true && d.result?.skipped, 'completed', `second dispatch: ${JSON.stringify(d)}`);
  assert.deepEqual(d, { ok: false, error: 'skipped', skipped: 'completed' });
});

// A6: two-step ordering, replay, rebinding, forgery (held before the fixes).
test('A6 two-step: replay, skip, rebind, cross-source, epoch, expiry, chat-tainted confirmer are all refused', () => {
  let t = 0;
  const ran = [];
  const gate = L.createActionGate({ catalogue: doc(), executor: { execute: (a) => { ran.push(a.id); return 1; } }, now: () => t, liveStaleMs: 1e9 });
  gate.forSource('system').setLiveState('live');
  const api = gate.forSource('api');
  const ui = gate.forSource('ui');
  const req = () => api.request({ id: 'scene.switch', params: { scene: 'a' } });
  let r = req();
  assert.equal(r.confirm.step, 1);
  assert.equal(api.confirm(r.confirm.confirmId, 'yes, on air', r.confirm.actionHash).reason, 'wrong-phrase'); // skip step 1
  r = req();
  const s2 = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  assert.equal(s2.confirm.step, 2);
  assert.equal(api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).reason, 'replayed');
  assert.equal(api.confirm(s2.confirm.confirmId, 'yes, on air', r.confirm.actionHash).reason, 'hash-mismatch'); // step-1 hash
  r = req();
  let s = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  assert.equal(ui.confirm(s.confirm.confirmId, 'yes, on air', s.confirm.actionHash).reason, 'step-source-mismatch');
  r = req();
  for (const src of ['chat', 'remote', 'system', 'rule']) assert.notEqual(gate.forSource(src).confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).verdict, 'confirm', src);
  assert.equal(gate.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash, { source: 'api', provenance: { kind: 'chat.message' } }).reason, 'tainted-confirmation');
  assert.equal(gate.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash, { source: 'api', provenance: { kind: 'rule', parent: { kind: 'alert.sub' } } }).reason, 'tainted-confirmation');
  s = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  assert.equal(s.confirm.step, 2, 'refused attempts did not spend step 1');
  gate.forSource('system').setLiveState('unknown');
  assert.equal(api.confirm(s.confirm.confirmId, 'yes, on air', s.confirm.actionHash).reason, 'live-state-changed');
  gate.forSource('system').setLiveState('live');
  r = req();
  s = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  t += 30_000;
  assert.equal(api.confirm(s.confirm.confirmId, 'yes, on air', s.confirm.actionHash).reason, 'expired');
  r = req();
  s = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  const forged = L.actionHash({ id: 'scene.switch', params: { scene: 'b' }, source: 'api', actor: 'invalid', phrase: 'yes, on air', step: 2, epoch: gate.state().liveEpoch, prev: r.confirm.actionHash });
  assert.equal(api.confirm(s.confirm.confirmId, 'yes, on air', forged).reason, 'hash-mismatch');
  assert.deepEqual(ran, []);
});

// A7: API params cannot set source, provenance, actor or ruleId.
test('A7 API: actions.request refuses source/provenance/actor/ruleId fields; actions.confirm refuses ctx fields', () => {
  const m = METHODS['actions.request'];
  for (const f of ['source', 'provenance', 'actor', 'ruleId', 'tainted']) assert.match(validateParams(m.schema, { id: 'scene.switch', [f]: 'x' }) ?? '', /unknown field/, f);
  for (const f of ['source', 'provenance', 'ctx']) assert.match(validateParams(METHODS['actions.confirm'].schema, { confirmId: 'a'.repeat(32), phrase: 'yes', actionHash: 'b'.repeat(64), [f]: 'x' }) ?? '', /unknown field/, f);
  assert.deepEqual(METHODS['actions.confirm'].roles, ['api']);
  assert.deepEqual(METHODS['live.set'].roles, ['system']);
});

// A8: chat-tainted requests never dispatch for any id, even with every non-deny action opened to dry-run.
test('A8 chat: no catalogue id dispatches or issues a confirmation for a chat-tainted request', () => {
  const d = doc();
  for (const a of d.actions) if (!L.isChatDenied(a.id, a.target)) { a.chatAllowed = true; a.chatMode = 'dry-run'; }
  const ran = [];
  const gate = L.createActionGate({ catalogue: d, executor: { execute: (a) => ran.push(a.id) }, liveStaleMs: 1e9 });
  const provs = [undefined, { kind: 'chat.message' }, { kind: 'rule' }, { kind: 'rule', parent: { kind: 'chat.message' } }, { kind: 'system.livestate', parent: { kind: 'chat.message' } }, { kind: 'hotkey', parent: { kind: 'alert.sub' } }];
  for (const st of ['offline', 'live']) {
    gate.forSource('system').setLiveState(st);
    for (const a of d.actions) for (const p of provs) for (const src of ['chat', 'rule', 'api', 'ui']) {
      if ((src === 'api' || src === 'ui') && p === undefined) continue; // untainted
      if (src !== 'chat' && src !== 'rule' && p && (p.kind === 'rule' && !p.parent)) continue;
      const r = gate.forSource(src).request({ id: a.id, params: {}, provenance: p });
      if (src === 'rule' && p === undefined) assert.ok(['dry-run', 'refuse'].includes(r.verdict));
      assert.ok(!['allow', 'confirm'].includes(r.verdict) || !(src === 'chat' || p), `${src} ${a.id} ${JSON.stringify(p)} -> ${r.verdict}`);
      assert.equal(r.dispatch, undefined);
    }
  }
  assert.deepEqual(ran, []);
  assert.equal(gate.state().panic, false, 'chat could not engage panic');
});

// A9: catalogue loaded straight into createActionGate with an accessor on id.
test('A9 catalogue: an accessor id must not let a deny-set id be stored as class read', () => {
  const d = doc();
  const idx = d.actions.findIndex((a) => a.id === 'state.read');
  let n = 0;
  Object.defineProperty(d.actions[idx], 'id', { enumerable: true, get: () => (n++ < 4 ? 'state.read' : 'stream.start') });
  d.actions.splice(d.actions.findIndex((a) => a.id === 'stream.start'), 1);
  let gate;
  try { gate = L.createActionGate({ catalogue: d, executor: { execute: () => 'started' } }); } catch { return; }
  const e = gate.catalogue.get('stream.start');
  assert.notEqual(e?.class, 'read', `stream.start stored as ${JSON.stringify(e)}`);
});

// A10: dry-run row privacy + raw purge + chain, with chat text also put in params, the rule label and the actor.
test('A10 dry-run audit: no text/name/platform id even when a rule copies chat text into params/actor/ruleId; survives purge', async () => {
  const TEXT = 'invented viewer words qq77';
  const NAME = 'InventedNameQQ';
  const PUID = 'invented-platform-user-qq';
  const d = doc();
  for (const a of d.actions) if (a.id === 'effect.fire') { a.chatAllowed = true; a.chatMode = 'dry-run'; }
  const core = createEventCore({ key: Buffer.alloc(32, 5), moderation: false, audit: { dataDir: tmp(), purgeOnStart: false }, actions: { catalogue: d, executor: { execute: () => 'x' } } });
  await core.ready;
  const res = core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'm-qq-1', user: { platformUserId: PUID, displayName: NAME }, text: TEXT });
  assert.equal(res.status, 'published');
  const ev = res.event;
  const r = core.actions.forSource('rule').request({ id: 'effect.fire', params: { text: TEXT, name: NAME, uid: PUID }, actor: NAME, ruleId: TEXT, provenance: { kind: 'rule', parent: { kind: 'chat.message', eventId: ev.id } } });
  assert.equal(r.verdict, 'dry-run');
  await core.audit.flush();
  await core.audit.purge({ all: true, mode: 'api' });
  const v = await core.audit.verify();
  assert.equal(v.ok, true);
  const page = await core.audit.exportPage({ limit: 500 });
  const rows = page.rows ?? page;
  const blob = JSON.stringify(rows);
  for (const s of [TEXT, NAME, PUID, 'qq77', 'QQ']) assert.equal(blob.includes(s), false, s);
  assert.equal(rows.filter((x) => x.verdict === 'dry-run').length, 1);
  assert.equal(core.stats().idempotency.executed, 0);
  await core.audit.close();
});

// A11: the same client key from different roles or with different params does not collide (source in the key).
test('A11 keys: the same client key from api and system roles, and from api with different params, do not collide', async () => {
  const { gate, ran } = gateWith(null);
  gate.forSource('system').setLiveState('offline');
  const run = async (src, params) => {
    const r = gate.forSource(src).request({ id: 'scene.create', params, idempotencyKey: 'shared-key-0001' });
    return gate.forSource('api').confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).dispatch;
  };
  await run('system', { name: 'a' });
  await run('api', { name: 'a' });
  await run('api', { name: 'b' });
  assert.equal(ran.length, 3);
});

// A12: pending/used/dry-key memory stays bounded under a flood.
test('A12 memory: pending stays bounded per source under 10 000 requests', () => {
  const d = doc();
  for (const a of d.actions) if (a.id === 'effect.fire') { a.chatAllowed = true; a.chatMode = 'dry-run'; }
  const gate = L.createActionGate({ catalogue: d, executor: { execute: () => 1 }, liveStaleMs: 1e9 });
  for (let i = 0; i < 10_000; i++) for (const s of ['api', 'ui', 'system', 'remote']) gate.forSource(s).request({ id: 'scene.create', params: { i } });
  assert.ok(gate.state().pending <= 4 * L.DEFAULT_MAX_PENDING, String(gate.state().pending));
});

// ---- the same fixes from other angles ------------------------------------------------------------------------

test('finding 1: a healthy but slow audit and an offline confirmation; the stream goes live during the wait -> refused live-state-changed', async () => {
  const { gate, ran } = gateWith(slowOk(40));
  const sys = gate.forSource('system');
  const api = gate.forSource('api');
  sys.setLiveState('offline');
  for (const id of ['scene.switch', 'scene.create']) { // on-air write and write, keyed and unkeyed
    for (const key of [undefined, `k1-${id}-0001`]) {
      const r = api.request({ id, params: {}, ...(key ? { idempotencyKey: key } : {}) });
      const c = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
      sys.setLiveState('live');
      assert.deepEqual(await c.dispatch, { ok: false, error: L.LIVE_STATE_CHANGED }, `${id} ${key ?? 'unkeyed'}`);
      sys.setLiveState('offline');
    }
  }
  assert.deepEqual(ran, []);
  // the same keyed request with no state change in between runs (the refusal did not spend its key)
  const r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'k1-scene.create-0001' });
  assert.deepEqual(await api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).dispatch, { ok: true, result: 'ran' });
});

test('finding 1: the live state going stale (offline -> unknown, no epoch change) during the wait also refuses', async () => {
  let t = 0;
  const { gate, ran } = gateWith(slowOk(30), { now: () => t, liveStaleMs: 1000 });
  gate.forSource('system').setLiveState('offline');
  const api = gate.forSource('api');
  const r = api.request({ id: 'scene.create', params: {} });
  const c = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  t += 2000; // no live-state update for 2 s: the effective state is 'unknown', which counts as live
  assert.equal(gate.state().liveState, 'unknown');
  assert.deepEqual(await c.dispatch, { ok: false, error: L.LIVE_STATE_CHANGED });
  assert.deepEqual(ran, []);
});

test('finding 1: with an audit attached, offline writes are strict too (stalled audit -> refused); reads still run', async () => {
  const { gate, ran } = gateWith(stalled);
  gate.forSource('system').setLiveState('offline');
  const api = gate.forSource('api');
  for (const id of ['scene.create', 'scene.switch']) {
    const r = api.request({ id, params: {} });
    assert.deepEqual(await api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).dispatch, { ok: false, error: L.AUDIT_UNAVAILABLE }, id);
  }
  const read = api.request({ id: 'state.read', params: {} });
  assert.deepEqual(read.dispatch, { ok: true, result: 'ran' });
  assert.deepEqual(ran.map((x) => x.id), ['state.read']);
});

test('finding 2: panic engaged while the write waits refuses it even when panic is cleared again before the commit', async () => {
  let t = 0;
  const { gate, ran } = gateWith(slowOk(60), { now: () => t });
  gate.forSource('system').setLiveState('offline');
  const api = gate.forSource('api');
  const r = api.request({ id: 'scene.create', params: {} });
  const c = api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash);
  api.panic({ reason: 'oops' });
  const pc = api.request({ id: 'panic.clear', params: {} });
  assert.equal(api.confirm(pc.confirm.confirmId, pc.confirm.phrase, pc.confirm.actionHash).reason, 'panic-cleared');
  assert.equal(gate.state().panic, false);
  assert.deepEqual(await c.dispatch, { ok: false, error: L.PANIC_REFUSED });
  assert.deepEqual(ran, []);
  // a write confirmed after the clear runs normally
  const r2 = api.request({ id: 'scene.create', params: {} });
  assert.deepEqual(await api.confirm(r2.confirm.confirmId, 'yes', r2.confirm.actionHash).dispatch, { ok: true, result: 'ran' });
});

test('findings 1 to 4 in the core: refusals are shown with their reason, keys are not spent, and nothing runs', async () => {
  const ran = [];
  const lines = [];
  const core = createEventCore({
    key: Buffer.alloc(32, 7), moderation: false, audit: { dataDir: tmp(), purgeOnStart: false }, log: (l) => lines.push(l),
    actions: { catalogue: doc(), executor: { execute: (a) => { ran.push(a.id); return 'ran'; } } },
  });
  await core.ready;
  const events = [];
  core.bus.subscribe({ name: 'w', kinds: ['system.refused'], handler: (e) => events.push(e) });
  const realStart = core.audit.recordActionStart;
  core.audit.recordActionStart = (...a) => sleep(40).then(() => realStart(...a)); // slow but healthy audit
  const sys = core.actions.forSource('system');
  const api = core.actions.forSource('api');
  sys.setLiveState('live');
  let r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'core-key-0001' });
  let c = confirmAll(api, r);
  api.panic({ reason: 'stop' });
  assert.deepEqual(await c.dispatch, { ok: false, error: L.PANIC_REFUSED });
  const pc = api.request({ id: 'panic.clear', params: {} });
  confirmAll(api, pc);
  r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'core-key-0001' });
  c = confirmAll(api, r);
  sys.setLiveState('offline');
  assert.deepEqual(await c.dispatch, { ok: false, error: L.LIVE_STATE_CHANGED });
  assert.deepEqual(ran, []);
  assert.deepEqual(events.map((e) => [e.action, e.reason]), [['scene.create', L.PANIC_REFUSED], ['scene.create', L.LIVE_STATE_CHANGED]]);
  assert.equal(core.stats().refusedRecheck, 2);
  assert.match(lines[0], /reason=panic action=scene\.create cause=revalidate$/);
  // the same key, nothing changing: runs once
  r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'core-key-0001' });
  assert.deepEqual(await confirmAll(api, r).dispatch, { ok: true, result: 'ran' });
  assert.deepEqual(ran, ['scene.create']);
  assert.equal((await core.audit.verify()).ok, true);
  await core.audit.close();
});

test('finding 4: a persisted "refused" outcome is ignored after a restart, so the honest retry runs; then it is completed', async () => {
  const dataDir = tmp();
  const ran = [];
  const mk = () => createEventCore({
    key: Buffer.alloc(32, 8), moderation: false, audit: { dataDir, purgeOnStart: false },
    actions: { catalogue: doc(), executor: { execute: (a) => { ran.push(a.id); return 'ran'; } } },
  });
  let core = mk();
  await core.ready;
  let api = core.actions.forSource('api');
  core.actions.forSource('system').setLiveState('offline');
  let r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'restart-key-0001' });
  const c = confirmAll(api, r);
  core.actions.forSource('system').setLiveState('live'); // refused live-state-changed after its start row committed
  assert.deepEqual(await c.dispatch, { ok: false, error: L.LIVE_STATE_CHANGED });
  await core.audit.flush();
  const rowsOf = (file) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT outcome, completed_at FROM action_keys').all(); } finally { db.close(); } };
  assert.deepEqual(rowsOf(core.audit.file).map((x) => x.outcome), ['refused']);
  await core.audit.close();

  core = mk();
  await core.ready;
  assert.equal(core.stats().idempotency.load.seeded, 0, 'the refused key is not seeded');
  assert.equal(core.stats().idempotency.load.ambiguous, 0, 'and never ambiguous');
  api = core.actions.forSource('api');
  core.actions.forSource('system').setLiveState('offline');
  r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'restart-key-0001' });
  assert.deepEqual(await confirmAll(api, r).dispatch, { ok: true, result: 'ran' });
  assert.deepEqual(ran, ['scene.create']);
  await core.audit.flush();
  assert.deepEqual(rowsOf(core.audit.file).map((x) => x.outcome), ['ok'], 'the retry turned the row into a completed one');
  await core.audit.close();
});

test('finding 4: seed() ignores refused rows; a start row with no done row is still ambiguous', () => {
  const x = L.createIdempotentExecutor({ executor: { execute: () => 1 } });
  const now = Date.now();
  const n = x.seed([
    { key: 'a'.repeat(64), started_at: now - 10, completed_at: now - 5, outcome: 'refused' },
    { key: 'b'.repeat(64), started_at: now - 10, completed_at: null, outcome: null },
    { key: 'c'.repeat(64), started_at: now - 10, completed_at: now - 5, outcome: 'ok' },
  ], now);
  assert.equal(n, 2);
  assert.deepEqual([x.stateOf('a'.repeat(64)), x.stateOf('b'.repeat(64)), x.stateOf('c'.repeat(64))], [null, 'ambiguous', 'completed']);
  assert.equal(x.stats().seededRefused, 1);
});

test('finding 3: without an audit, offline writes and reads run; allowUnaudited (test only) lets a live write run', async () => {
  const ran = [];
  const ex = { execute: (a) => { ran.push(a.id); return 'ran'; } };
  const core = createEventCore({ key: Buffer.alloc(32, 9), moderation: false, actions: { catalogue: doc(), executor: ex } });
  await core.ready;
  const api = core.actions.forSource('api');
  core.actions.forSource('system').setLiveState('offline');
  assert.deepEqual(await confirmAll(api, api.request({ id: 'scene.create', params: {} })).dispatch, { ok: true, result: 'ran' });
  core.actions.forSource('system').setLiveState('live');
  assert.deepEqual(api.request({ id: 'state.read', params: {} }).dispatch, { ok: true, result: 'ran' });
  assert.deepEqual(await confirmAll(api, api.request({ id: 'scene.switch', params: {} })).dispatch, { ok: false, error: L.AUDIT_UNAVAILABLE });
  assert.deepEqual(ran, ['scene.create', 'state.read']);
  const testOnly = createEventCore({ key: Buffer.alloc(32, 9), moderation: false, actions: { catalogue: doc(), executor: ex, allowUnaudited: true } });
  await testOnly.ready;
  testOnly.actions.forSource('system').setLiveState('live');
  const t = testOnly.actions.forSource('api');
  assert.deepEqual(await confirmAll(t, t.request({ id: 'scene.switch', params: {} })).dispatch, { ok: true, result: 'ran' });
});

test('finding 5: the dry-run row records the would-be result of the non-chat rules, not always "allow"', () => {
  const d = doc();
  for (const a of d.actions) if (['effect.fire', 'marker.drop', 'state.read'].includes(a.id)) { a.chatAllowed = true; a.chatMode = 'dry-run'; }
  const recs = [];
  const gate = L.createActionGate({ catalogue: d, executor: { execute: () => 1 }, onDecision: (r) => recs.push(r), liveStaleMs: 1e9 });
  const sys = gate.forSource('system');
  const chat = (id) => { recs.length = 0; gate.request({ id, params: {}, source: 'chat', actor: '0123456789abcdef0123456789abcdef' }); return recs.find((r) => r.dryRun); };
  const pick = (r) => [r.wouldDecision, r.wouldReason, r.wouldSteps, r.liveState];
  sys.setLiveState('live');
  assert.deepEqual(pick(chat('effect.fire')), ['confirm', 'two-step-confirmation', 2, 'live']);
  assert.deepEqual(pick(chat('marker.drop')), ['confirm', 'confirmation-required', 1, 'live']);
  assert.deepEqual(pick(chat('state.read')), ['allow', 'read', undefined, 'live']);
  sys.setLiveState('offline');
  assert.deepEqual(pick(chat('effect.fire')), ['confirm', 'confirmation-required', 1, 'offline']);
});

test('finding 8: a key still running is reported ok:false skipped:running', async () => {
  const { gate } = gateWith(slowOk(40));
  gate.forSource('system').setLiveState('offline');
  const api = gate.forSource('api');
  const go = () => { const r = api.request({ id: 'scene.create', params: {}, idempotencyKey: 'running-key-01' }); return api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).dispatch; };
  const first = go();
  assert.deepEqual(await go(), { ok: false, error: 'skipped', skipped: 'running' });
  assert.deepEqual(await first, { ok: true, result: 'ran' });
});

test('guard: a raw executor (no wrapper) ignores the guard; dispatch is unchanged and synchronous', () => {
  const seen = [];
  const gate = L.createActionGate({ catalogue: doc(), executor: { execute: (a, g) => { seen.push([a.liveEpoch, typeof g?.revalidate, g.revalidate()]); return 'raw'; } }, liveStaleMs: 1e9 });
  gate.forSource('system').setLiveState('offline');
  const api = gate.forSource('api');
  const r = api.request({ id: 'scene.create', params: {} });
  assert.deepEqual(api.confirm(r.confirm.confirmId, 'yes', r.confirm.actionHash).dispatch, { ok: true, result: 'raw' });
  assert.deepEqual(seen, [[gate.state().liveEpoch, 'function', null]]);
});
