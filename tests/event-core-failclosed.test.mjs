// SPDX-License-Identifier: GPL-3.0-or-later
// Fail closed for writes when the audit is slow or down (user decisions 2026-10-28: on-air writes, then every write):
// a write of class write or on-air-write while not offline runs only after a durable audit record; otherwise it is
// refused 'audit-unavailable', never run, and shown (system.refused on the bus and SSE, an audit row once the audit
// writes, a log line). Reads keep the fail-open rule. E4b review fixes (2026-10-29): with an audit attached every write is
// strict, offline too (finding 1); a refusal does not spend the key (finding 4); without an audit a write while not
// offline is refused unless allowUnaudited (finding 3). All text, ids and names are invented. Temp dirs only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEventCore, createIdempotentExecutor, requiresDurableAudit, AUDIT_UNAVAILABLE } from '../services/event-core/index.mjs';
import { startService } from '../services/event-core/api/service.mjs';
import { rpc, openSse } from './event-core-api-helpers.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evfc-')); dirs.push(d); return d; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const K = (c) => c.repeat(64);
const never = () => new Promise(() => {});
const ON_AIR_LIVE = { id: 'scene.switch', source: 'ui', class: 'on-air-write', liveState: 'live' };

// ---- wrapper ---------------------------------------------------------------------------------------------

test('rule: every write (write and on-air-write) is strict unless offline; reads never are', () => {
  for (const cls of ['on-air-write', 'write']) {
    assert.equal(requiresDurableAudit({ class: cls, liveState: 'live' }), true, cls);
    assert.equal(requiresDurableAudit({ class: cls, liveState: 'unknown' }), true, cls);
    assert.equal(requiresDurableAudit({ class: cls }), true, cls); // absent live state counts as live
    assert.equal(requiresDurableAudit({ class: cls, liveState: 'offline' }), false, cls);
  }
  for (const ls of ['live', 'unknown', 'offline', undefined]) assert.equal(requiresDurableAudit({ class: 'read', liveState: ls }), false);
  assert.equal(requiresDurableAudit({ class: 'other', liveState: 'live' }), false);
  assert.equal(requiresDurableAudit(null), false);
});

test('wrapper: a stalled or failing audit refuses a live write (class write; keyed, unkeyed, unknown state)', async () => {
  let ran = 0;
  const refused = [];
  const starts = [];
  const WRITE_LIVE = { id: 'scene.create', source: 'ui', class: 'write', liveState: 'live' };
  const x = createIdempotentExecutor({
    executor: { execute: () => ++ran }, startTimeoutMs: 30,
    persist: { start: (k, at, info) => { starts.push(info); return never(); }, done: () => {} },
    onRefused: (act, cause) => refused.push([act.id, cause]),
  });
  await assert.rejects(x.execute({ ...WRITE_LIVE, idempotencyKey: K('c') }), (e) => e.code === AUDIT_UNAVAILABLE);
  await assert.rejects(x.execute({ ...WRITE_LIVE }), (e) => e.code === AUDIT_UNAVAILABLE);
  await assert.rejects(x.execute({ ...WRITE_LIVE, liveState: 'unknown' }), (e) => e.code === AUDIT_UNAVAILABLE);
  assert.equal(ran, 0);
  assert.deepEqual(refused, [['scene.create', 'timeout'], ['scene.create', 'timeout'], ['scene.create', 'timeout']]);
  assert.deepEqual(starts.map((s) => [s.class, s.liveState, s.keyed]), [['write', 'live', true], ['write', 'live', false], ['write', 'unknown', false]]);
  // E4b finding 4: the refusal did not spend the key, so the same key is tried again (and refused again: still stalled)
  await assert.rejects(x.execute({ ...WRITE_LIVE, idempotencyKey: K('c') }), (e) => e.code === AUDIT_UNAVAILABLE);
  const failing = createIdempotentExecutor({
    executor: { execute: () => ++ran },
    persist: { start: () => Promise.reject(Object.assign(new Error('x'), { code: 'CLOSED' })), done: () => {} },
  });
  await assert.rejects(failing.execute({ ...WRITE_LIVE }), (e) => e.code === AUDIT_UNAVAILABLE && e.auditCause === 'failed:CLOSED');
  assert.equal(ran, 0);
  assert.equal(x.stats().refusedNoAudit + failing.stats().refusedNoAudit, 5);
});

test('wrapper: a stalled audit refuses a live on-air write (keyed); the executor never runs; the key is NOT spent', async () => {
  let ran = 0;
  const refused = [];
  const done = [];
  const x = createIdempotentExecutor({
    executor: { execute: () => ++ran }, startTimeoutMs: 30,
    persist: { start: never, done: (k, at, o) => done.push(o) },
    onRefused: (act, cause) => refused.push([act.id, cause]),
  });
  const t0 = performance.now();
  await assert.rejects(x.execute({ ...ON_AIR_LIVE, idempotencyKey: K('a') }), (e) => e.code === AUDIT_UNAVAILABLE && e.message === AUDIT_UNAVAILABLE);
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(ran, 0);
  assert.deepEqual(refused, [['scene.switch', 'timeout']]);
  assert.deepEqual(done, ['refused']); // a 'refused' outcome, which seed() ignores
  assert.equal(x.stateOf(K('a')), null); // forgotten: an honest retry may run
  await assert.rejects(x.execute({ ...ON_AIR_LIVE, idempotencyKey: K('a') }), (e) => e.code === AUDIT_UNAVAILABLE);
  assert.equal(ran, 0);
  const s = x.stats();
  assert.deepEqual([s.failClosed, s.refusedNoAudit, s.startUnconfirmed], [2, 2, 2]);
});

test('wrapper: a failing audit refuses (unkeyed too); a one-off key and the start info go to the audit', async () => {
  let ran = 0;
  const starts = [];
  const refused = [];
  const x = createIdempotentExecutor({
    executor: { execute: () => ++ran },
    persist: { start: (k, at, info) => { starts.push([k, info]); return Promise.reject(Object.assign(new Error('x'), { code: 'CLOSED' })); }, done: () => {} },
    onRefused: (act, cause) => refused.push(cause),
  });
  await assert.rejects(x.execute({ ...ON_AIR_LIVE }), (e) => e.code === AUDIT_UNAVAILABLE);
  await assert.rejects(x.execute({ ...ON_AIR_LIVE, liveState: 'unknown', idempotencyKey: K('b') }), (e) => e.code === AUDIT_UNAVAILABLE);
  assert.equal(ran, 0);
  assert.deepEqual(refused, ['failed:CLOSED', 'failed:CLOSED']);
  assert.match(starts[0][0], /^[0-9a-f]{64}$/);
  assert.deepEqual(starts[0][1], { id: 'scene.switch', source: 'ui', class: 'on-air-write', liveState: 'live', keyed: false });
  assert.deepEqual(starts[1][1], { id: 'scene.switch', source: 'ui', class: 'on-air-write', liveState: 'unknown', keyed: true });
});

test('wrapper: reads still run with a stalled audit (fail open); writes of both classes are refused while offline too (E4b finding 1)', async () => {
  const ran = [];
  const x = createIdempotentExecutor({ executor: { execute: (a) => { ran.push(a.id); return 'ok'; } }, startTimeoutMs: 20, persist: { start: never, done: () => {} } });
  assert.equal(x.execute({ id: 'state.read', class: 'read', liveState: 'live' }), 'ok'); // unkeyed read: no marker at all
  assert.equal(x.execute({ id: 'state.read', class: 'read', liveState: 'unknown' }), 'ok');
  assert.equal(await x.execute({ id: 'state.read', class: 'read', liveState: 'live', idempotencyKey: K('1') }), 'ok');
  // With persistence attached every write is strict, whatever the live state at dispatch: no decision from a stale state.
  const no = (e) => e.code === AUDIT_UNAVAILABLE;
  await assert.rejects(x.execute({ id: 'scene.create', class: 'write', liveState: 'offline', idempotencyKey: K('2') }), no);
  await assert.rejects(x.execute({ id: 'scene.create', class: 'write', liveState: 'offline' }), no); // unkeyed write, offline
  await assert.rejects(x.execute({ id: 'scene.switch', class: 'on-air-write', liveState: 'offline', idempotencyKey: K('3') }), no);
  await assert.rejects(x.execute({ id: 'scene.switch', class: 'on-air-write', liveState: 'offline' }), no); // unkeyed, offline
  assert.deepEqual(ran, ['state.read', 'state.read', 'state.read']);
  assert.deepEqual([x.stats().refusedNoAudit, x.stats().failClosed, x.stats().startUnconfirmed], [4, 4, 5]);
});

test('wrapper: a healthy audit lets a live on-air write run after the record commits; no persistence refuses live writes unless allowUnaudited', async () => {
  const log = [];
  const x = createIdempotentExecutor({
    executor: { execute: () => { log.push('execute'); return 1; } },
    persist: { start: async (k, at, info) => { log.push(`start:${info.keyed}`); await new Promise((r) => setTimeout(r, 5)); log.push('committed'); }, done: (k, at, o) => log.push(`done:${o}`) },
  });
  assert.equal(await x.execute({ ...ON_AIR_LIVE }), 1);
  assert.deepEqual(log, ['start:false', 'committed', 'execute', 'done:ok']);
  // E4b finding 3: no audit attached -> a write while not offline is refused (synchronously); offline and reads run.
  const bare = createIdempotentExecutor({ executor: { execute: () => 'sync' } });
  assert.throws(() => bare.execute({ ...ON_AIR_LIVE }), (e) => e.code === AUDIT_UNAVAILABLE && e.auditCause === 'no-audit');
  assert.throws(() => bare.execute({ ...ON_AIR_LIVE, class: 'write', liveState: 'unknown' }), (e) => e.code === AUDIT_UNAVAILABLE);
  assert.equal(bare.execute({ ...ON_AIR_LIVE, liveState: 'offline' }), 'sync');
  assert.equal(bare.execute({ ...ON_AIR_LIVE, class: 'read' }), 'sync');
  const testOnly = createIdempotentExecutor({ executor: { execute: () => 'sync' }, allowUnaudited: true });
  assert.equal(testOnly.execute({ ...ON_AIR_LIVE }), 'sync');
});

// ---- core with the real audit ----------------------------------------------------------------------------

function mkCore(over = {}) {
  const calls = [];
  const lines = [];
  const dataDir = tmp();
  const core = createEventCore({
    key: Buffer.alloc(32, 5), moderation: false, audit: { dataDir, purgeOnStart: false },
    actions: { executor: over.executor ?? { execute: (a) => { calls.push(a.id); return { done: a.id }; } }, idempotency: { startTimeoutMs: 60 } },
    log: (l) => lines.push(l),
  });
  return { core, calls, lines, dataDir };
}
// D332: the two ways a write reaches dispatch. 'direct': the user's own ui click runs it on the request. 'approved': an
// untainted automatic rule (a hotkey) asks, and one ui click approves it (no phrase, no second step).
const confirmed = (core, id, path = 'direct') => {
  if (path === 'direct') {
    const r = core.actions.request({ id, params: { scene: 'Main' }, source: 'ui', actor: 'u' });
    assert.deepEqual([r.verdict, r.reason], ['allow', 'ui-direct'], id);
    return r.dispatch;
  }
  const r = core.actions.request({ id, params: { scene: 'Main' }, source: 'rule', provenance: { kind: 'hotkey' }, actor: 'u' });
  assert.equal(r.verdict, 'confirm', `${id}: ${r.reason}`);
  const c = core.actions.confirm(r.confirm.confirmId, undefined, r.confirm.actionHash, { source: 'ui' });
  assert.equal(c.verdict, 'allow');
  return c.dispatch;
};

test('core: the audit row and the start marker are durable BEFORE a live on-air write or live write executes', async () => {
  let seen = null;
  const { core } = mkCore({
    executor: {
      execute: (a) => {
        const db = new DatabaseSync(core.audit.file, { readOnly: true });
        try {
          seen = {
            row: db.prepare("SELECT action_id, source, verdict, reason, detail FROM audit WHERE type = 'action' AND subtype = 'start'").all(),
            keys: db.prepare('SELECT COUNT(*) AS n FROM action_keys WHERE completed_at IS NULL').get().n,
          };
        } finally { db.close(); }
        return a.id;
      },
    },
  });
  await core.ready;
  core.actions.setLiveState('live', { source: 'system' });
  assert.deepEqual(await confirmed(core, 'scene.switch'), { ok: true, result: 'scene.switch' });
  assert.equal(seen.keys, 1);
  assert.equal(seen.row.length, 1);
  const { detail, ...row } = seen.row[0];
  assert.deepEqual({ ...row }, { action_id: 'scene.switch', source: 'ui', verdict: 'start', reason: 'on-air-write' });
  const d = JSON.parse(detail);
  assert.deepEqual([d.liveState, d.keyed], ['live', false]);
  assert.match(d.key, /^[0-9a-f]{16}$/);
  // class write while live: its own start row (reason 'write') is durable before it executes too
  assert.deepEqual(await confirmed(core, 'scene.create'), { ok: true, result: 'scene.create' });
  assert.equal(seen.keys, 1);
  assert.deepEqual(seen.row.map((x) => [x.action_id, x.verdict, x.reason]), [['scene.switch', 'start', 'on-air-write'], ['scene.create', 'start', 'write']]);
  // a rule's on-air write approved by one ui click: its start row is durable before it executes too
  assert.deepEqual(await confirmed(core, 'scene.switch', 'approved'), { ok: true, result: 'scene.switch' });
  assert.equal(seen.keys, 1);
  assert.deepEqual(seen.row.map((x) => [x.action_id, x.source, x.reason]).at(-1), ['scene.switch', 'rule', 'on-air-write']);
  assert.equal(seen.row.length, 3);
  assert.equal((await core.audit.verify()).ok, true);
  await core.audit.close();
});

test('core: audit stalled -> live on-air write and live write refused and shown; read runs; offline writes refused too, run once it recovers', async () => {
  const { core, calls, lines } = mkCore();
  await core.ready;
  const events = [];
  core.bus.subscribe({ name: 'watch', kinds: ['system.refused'], handler: (e) => events.push(e) });
  const realStart = core.audit.recordActionStart;
  core.audit.recordActionStart = never; // the writer is stuck: no commit ever arrives
  core.actions.setLiveState('live', { source: 'system' });

  assert.deepEqual(await confirmed(core, 'scene.switch'), { ok: false, error: AUDIT_UNAVAILABLE });
  assert.deepEqual(calls, []); // no execution
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].kind, events[0].action, events[0].reason, events[0].source], ['system.refused', 'scene.switch', AUDIT_UNAVAILABLE, 'system']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[event-core\] warn: action-refused reason=audit-unavailable action=scene\.switch cause=timeout$/);

  // class write while live, approved from a rule: refused the same way (user decision 2026-10-28: every write fails
  // closed while live)
  assert.deepEqual(await confirmed(core, 'scene.create', 'approved'), { ok: false, error: AUDIT_UNAVAILABLE });
  assert.deepEqual(calls, []);
  assert.equal(events.length, 2);
  assert.deepEqual([events[1].kind, events[1].action, events[1].reason, events[1].source], ['system.refused', 'scene.create', AUDIT_UNAVAILABLE, 'system']);
  assert.equal(lines.length, 1); // the second log line falls inside the 1 s rate limit

  const read = core.actions.request({ id: 'state.read', params: {}, source: 'api', actor: 'api' });
  assert.deepEqual([read.verdict, read.dispatch.ok], ['allow', true]); // unkeyed read: synchronous, as before
  core.actions.setLiveState('offline', { source: 'system' });
  // E4b review finding 1: with an audit attached every write is strict, offline too (no decision from a stale state)
  assert.deepEqual(await confirmed(core, 'scene.create'), { ok: false, error: AUDIT_UNAVAILABLE }); // write, not live
  assert.deepEqual(await confirmed(core, 'scene.switch', 'approved'), { ok: false, error: AUDIT_UNAVAILABLE }); // not live
  assert.deepEqual(calls, ['state.read']);
  assert.equal(core.stats().refusedNoAudit, 4);
  assert.equal(core.stats().idempotency.refusedNoAudit, 4);

  // the audit recovers: the four refusals are in the chain as system rows; offline writes run again
  core.audit.recordActionStart = realStart;
  assert.deepEqual(await confirmed(core, 'scene.create'), { ok: true, result: { done: 'scene.create' } });
  assert.deepEqual(calls, ['state.read', 'scene.create']);
  const page = await core.audit.exportPage({ limit: 500 });
  const rows = page.rows.filter((r) => r.subtype === 'system.refused');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((x) => [x.type, x.action_id, x.reason]).sort(), [
    ['system', 'scene.create', AUDIT_UNAVAILABLE], ['system', 'scene.create', AUDIT_UNAVAILABLE],
    ['system', 'scene.switch', AUDIT_UNAVAILABLE], ['system', 'scene.switch', AUDIT_UNAVAILABLE],
  ]);
  assert.equal((await core.audit.verify()).ok, true);
  await core.audit.close();
});

test('core: audit down (closed) -> live on-air write refused with a log line; unknown live state counts as live', async () => {
  const { core, calls, lines } = mkCore();
  await core.ready;
  await core.audit.close(); // the writer is gone: every queue push now fails
  // live state never set: 'unknown', which counts as live
  const api = core.actions.forSource('api');
  const r = api.request({ id: 'scene.switch', params: {}, idempotencyKey: 'client-key-001' });
  assert.deepEqual([r.verdict, r.reason], ['allow', 'ui-direct']); // the user's click (D332)
  assert.deepEqual(await r.dispatch, { ok: false, error: AUDIT_UNAVAILABLE });
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /action=scene\.switch cause=failed:CLOSED$/);
  // the same client key again: NOT spent by the refusal (E4b finding 4), so it is tried again and refused again (audit
  // still closed); still not run
  const r2 = api.request({ id: 'scene.switch', params: {}, idempotencyKey: 'client-key-001' });
  assert.deepEqual(await r2.dispatch, { ok: false, error: AUDIT_UNAVAILABLE });
  // a rule's request approved by one api click is refused the same way
  const rr = core.actions.forSource('rule').request({ id: 'scene.switch', params: {}, provenance: { kind: 'hotkey' } });
  assert.equal(rr.confirm.liveStateAtRequest, 'unknown');
  assert.deepEqual(await api.confirm(rr.confirm.confirmId, undefined, rr.confirm.actionHash).dispatch, { ok: false, error: AUDIT_UNAVAILABLE });
  assert.deepEqual(calls, []);
});

test('core: log lines are rate limited to one per second and carry codes only', async () => {
  const { core, lines } = mkCore();
  await core.ready;
  await core.audit.close();
  core.actions.setLiveState('live', { source: 'system' });
  for (let i = 0; i < 3; i++) await confirmed(core, 'scene.switch');
  assert.equal(lines.length, 1);
  assert.equal(core.stats().refusedNoAudit, 3);
  for (const l of lines) assert.match(l, /^\[event-core\] warn: action-refused reason=[a-z-]+ action=[a-z.]+ cause=[A-Za-z:_-]+( suppressed=\d+)?$/);
});

// ---- over the API (SSE) ----------------------------------------------------------------------------------

test('api: a refused live on-air write and live write are visible over SSE (api and system roles); nothing executes', async () => {
  const calls = [];
  const svc = await startService({
    dataDir: tmp(), noStreamerbot: true, stallTracer: false, out: () => {},
    core: { actions: { executor: { execute: (a) => { calls.push(a.id); return { mock: true }; } }, idempotency: { startTimeoutMs: 60 } } },
  });
  const r = { port: svc.port };
  const sseApi = await openSse({ port: svc.port, token: svc.tokens.api });
  const sseSys = await openSse({ port: svc.port, token: svc.tokens.system });
  try {
    assert.equal((await rpc(r, svc.tokens.system, 'live.set', { state: 'live' })).result.ok, true);
    svc.core.audit.recordActionStart = never; // stalled writer
    // D332: the api client's own write runs on its request; the stalled audit refuses it before it executes
    const req = await rpc(r, svc.tokens.api, 'actions.request', { id: 'scene.switch', params: { scene: 'Main' } });
    assert.deepEqual(req.result, { verdict: 'allow', reason: 'ui-direct', dispatch: { ok: false, error: AUDIT_UNAVAILABLE } });
    const isRefusal = (f) => f.json?.kind === 'system.refused' && f.json.action === 'scene.switch' && f.json.reason === AUDIT_UNAVAILABLE;
    await sseApi.waitFor(() => sseApi.frames.some(isRefusal));
    await sseSys.waitFor(() => sseSys.frames.some(isRefusal));
    assert.equal(sseApi.frames.find(isRefusal).event, 'system.refused');
    assert.deepEqual(calls, []);
    // class write while live, asked by the system role and approved by one api click: refused and shown the same way
    const wreq = await rpc(r, svc.tokens.system, 'actions.request', { id: 'scene.create', params: { scene: 'Main' } });
    assert.equal(wreq.result.verdict, 'confirm');
    const wc = (await rpc(r, svc.tokens.api, 'actions.confirm', { confirmId: wreq.result.confirm.confirmId, actionHash: wreq.result.confirm.actionHash })).result;
    assert.deepEqual(wc, { verdict: 'allow', reason: 'confirmed', dispatch: { ok: false, error: AUDIT_UNAVAILABLE } });
    const isWriteRefusal = (f) => f.json?.kind === 'system.refused' && f.json.action === 'scene.create' && f.json.reason === AUDIT_UNAVAILABLE;
    await sseApi.waitFor(() => sseApi.frames.some(isWriteRefusal));
    await sseSys.waitFor(() => sseSys.frames.some(isWriteRefusal));
    assert.deepEqual(calls, []);
  } finally {
    sseApi.close(); sseSys.close();
    await svc.stop();
  }
});
