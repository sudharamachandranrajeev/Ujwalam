// SPDX-License-Identifier: GPL-3.0-or-later
// Idempotent action execution (P3 E7 follow-up). Node stdlib only.
//
// Delivery into the event core is at-least-once: after a crash, Streamer.bot resends recent events, and the persisted
// dedupe can miss a key that was still in the audit batch window (E7: 3 duplicate dispatches in 25 kills). So every
// dispatched action carries an idempotency key and the executor runs a key at most once, across restarts too.
//
// Key (computed by the gate, livelock/gate.mjs idempotencyKeyFor): SHA-256 hex of canonical JSON
//   { v: 1, origin, id (action id), source, actor, params }
// origin, first match wins:
//   'ck:<source>:<client key>'  a caller-supplied idempotencyKey (API clients: params.idempotencyKey of actions.request)
//   'pm:<dedupe key>'           the nearest provenance event that came from a platform: SHA-256 of
//                               "platform:platformMessageId", the same value the dedupe persists. Stable across a restart
//                               and a resend, unlike the internal event id, which is new for every ingest.
//   'ev:<event id>'             the nearest provenance event without a platform message id (system events): internal id,
//                               stable within one process only; such events are not resent after a restart.
//   none                        no key: the action runs as before (UI/API requests without a client key). A write from
//                               those sources needs a confirmation, which is single use and dies with the process.
//
// Flow for a keyed action, with persistence (the audit worker):
//   1. key already known (completed, running, or ambiguous from before a restart) -> skipped, inner executor not called
//      (a refused key is forgotten, not known: see fail closed below)
//   2. 'started' marker queued for the worker; the action waits ASYNCHRONOUSLY for the commit (synchronous=FULL), at most
//      startTimeoutMs; the event loop is never blocked
//   3. inner executor runs
//   4. 'completed' marker queued (normal batch timing)
// At start-up (before core.ready) the last retentionMs of keys are loaded: completed -> skip; started but not
// completed -> 'ambiguous' -> skip (we cannot know whether it ran; it is counted and audited, never re-run).
//
// Crash windows (see docs/evidence/2026-10-28-p3-e7-stalls-idempotency.md):
//   kill before the 'started' commit         -> nothing ran, nothing durable -> a resend runs it once
//   kill after the commit, before step 3     -> resend skips it (ambiguous): the action is LOST (ran 0 times). Window:
//                                               worker commit -> ack message -> main-thread callback -> execute call.
//                                               BLOCKER before any chat-triggered action is switched on (C2/C3).
//   kill after step 3                        -> resend skips it: ran once
//   start not acked within startTimeoutMs, or the audit cannot write -> the action runs anyway (fail open, counted as
//                                               startUnconfirmed / startFailed); a kill before the late commit can
//                                               then give a duplicate, as before this layer. NOT for fail-closed actions:
//
// Fail closed (user decisions 2026-10-28: first on-air writes, then extended to every write). An action of class
// 'write' or 'on-air-write' while the live state is not 'offline' (live, unknown, or absent: unknown counts as live)
// must have a durable audit record before it runs (requiresDurableAudit).
// E4b review fix (2026-10-29, finding 1): with persistence attached, EVERY write (both classes, whatever the live state
// at dispatch) is strict. Strictness then never depends on a live state that can change during the wait, so no write can
// be "decided offline" and then run live without a record. Offline writes have no live-path cost; they wait up to
// startTimeoutMs too and are refused when the audit is down. A strict action (keyed or not) waits for its 'started'
// marker AND one hash-chained 'action/start' audit row to commit, at most startTimeoutMs. If that does not happen
// (timeout, write error, audit closed, queue full), the action is REFUSED:
//   - the inner executor is never called;
//   - the returned promise rejects with an Error whose message and code are 'audit-unavailable';
//   - the key is NOT spent (finding 4): it is forgotten in memory and a 'done' marker with outcome 'refused' is queued,
//     which seed() ignores, so an honest retry with the same key runs. The action/start row and the system.refused row
//     stay as the audit trail;
//   - onRefused(act, cause, reason) is called, so the core can show the refusal (bus event, audit row, log line).
// An unkeyed strict action gets a one-off random key for its marker. Reads keep the fail-open rule above.
//
// Re-check before execute (findings 1 and 2): the gate passes a guard as the second argument of execute(act, guard).
// Immediately before inner.execute, in the same synchronous step as the call, a write is checked against the CURRENT
// gate state: panic engaged since dispatch -> refused 'panic'; live epoch or effective live state different from the
// dispatch -> refused 'live-state-changed'; the action needs a durable record for the current live state and has none
// -> refused 'audit-unavailable'. Same refusal path as above (key forgotten, 'refused' marker, onRefused). There is no
// await between that check and the inner call, so there is no TOCTOU window.
//
// No persistence (no audit attached, finding 3): a write while not offline is refused 'audit-unavailable' (nothing can
// be durably recorded), unless the TEST-ONLY option allowUnaudited: true is set. Never set it in the service; the
// service always attaches an audit.
// Exactly once end to end needs the target to take the key too (the studio app, P4/P6): proposed, not built.
//
// Without persistence (no audit) the same key rules hold in memory only and a keyed action runs synchronously.
// Retention: keys older than retentionMs (default 1 h) are forgotten; at most maxKeys (default 50 000) are kept in
// memory, oldest first out. A resend older than that runs again.

import { randomBytes } from 'node:crypto';

export const DEFAULT_RETENTION_MS = 3_600_000;
export const DEFAULT_MAX_KEYS = 50_000;
export const DEFAULT_START_TIMEOUT_MS = 250;
export const KEY_RE = /^[0-9a-f]{64}$/;
export const PHASES = Object.freeze(['before-start', 'after-start', 'after-execute', 'after-done']);
export const AUDIT_UNAVAILABLE = 'audit-unavailable';
export const LIVE_STATE_CHANGED = 'live-state-changed';
export const PANIC_REFUSED = 'panic';
/** States a skipped dispatch reports: the wrapper returns { skipped: <state> } and the inner executor was not called. */
export const SKIPPED_STATES = Object.freeze(['completed', 'running', 'ambiguous']);

/** Classes that fail closed (user decisions 2026-10-28: on-air-write first, then every write). */
export const FAIL_CLOSED_CLASSES = Object.freeze(['write', 'on-air-write']);

/** True for an action that may only run with a durable audit record: any write (class write or on-air-write) while
 *  not offline. Reads never; writes while offline never. (With persistence attached the wrapper is stricter: every
 *  write waits for its record, see the header.) */
export const requiresDurableAudit = (act) => FAIL_CLOSED_CLASSES.includes(act?.class) && act?.liveState !== 'offline';

/** opts: { executor: { execute(act) }, persist?: { start(key, atMs, info?) -> Promise, done(key, atMs, outcome) },
 *          retentionMs?, maxKeys?, startTimeoutMs?, now?: () => wall ms,
 *          onRefused?(act, cause, reason): called once per refusal (reason 'audit-unavailable' | 'live-state-changed' |
 *          'panic'; cause 'timeout' | 'failed:<AuditError code>' | 'no-audit' | 'revalidate'); a throwing hook is ignored,
 *          allowUnaudited?: TEST ONLY. Without persistence, lets a write run while not offline. Never set it in the
 *          service,
 *          phaseHook?(phase, key): TEST SEAM ONLY (crash tests); may return a promise that is awaited. Never set it in
 *          the service. }
 *  execute(act, guard?): guard (from the gate) is { liveState() -> current effective state, revalidate() -> null |
 *  'panic' | 'live-state-changed' }. */
export function createIdempotentExecutor(opts) {
  const inner = opts?.executor;
  if (!inner || typeof inner.execute !== 'function') throw new TypeError('executor.execute is required');
  const persist = opts.persist ?? null;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const hook = opts.phaseHook ?? null;
  const onRefused = typeof opts.onRefused === 'function' ? opts.onRefused : null;
  const allowUnaudited = opts.allowUnaudited === true; // TEST ONLY; see the header

  const keys = new Map(); // key -> { state: 'running' | 'completed' | 'ambiguous', at: wall ms }; insertion order = age
  const counts = {
    executed: 0, unkeyed: 0, skippedCompleted: 0, skippedRunning: 0, skippedAmbiguous: 0,
    startDurable: 0, startUnconfirmed: 0, startFailed: 0, seeded: 0, seededAmbiguous: 0, seededRefused: 0, expired: 0, evicted: 0,
    failClosed: 0, refusedNoAudit: 0, refusedLiveChanged: 0, refusedPanic: 0,
  };

  const expire = (t) => {
    for (const [k, e] of keys) {
      if (t - e.at < retentionMs) break;
      keys.delete(k); counts.expired++;
    }
  };
  const remember = (key, state, at) => {
    keys.delete(key); // re-insert at the end: order stays by time
    keys.set(key, { state, at });
    while (keys.size > maxKeys) { keys.delete(keys.keys().next().value); counts.evicted++; }
  };
  const phase = (p, key) => (hook ? Promise.resolve().then(() => hook(p, key)) : null);

  function done(key, outcome) {
    const e = keys.get(key);
    if (e) e.state = 'completed';
    try { persist?.done(key, now(), outcome); } catch { /* never break an action */ }
  }

  function run(key, act) {
    counts.executed++;
    let r;
    try { r = inner.execute(act); } catch (e) { done(key, 'error'); throw e; }
    // Without the test hook this is synchronous for a synchronous executor.
    const finish = (outcome) => {
      if (!hook) { done(key, outcome); return null; }
      return phase('after-execute', key).then(() => { done(key, outcome); return phase('after-done', key); });
    };
    if (r && typeof r.then === 'function') {
      return r.then(
        (v) => { const f = finish('ok'); return f ? f.then(() => v) : v; },
        (e) => { const f = finish('error'); if (f) return f.then(() => { throw e; }); throw e; },
      );
    }
    const f = finish('ok');
    return f ? f.then(() => r) : r;
  }

  // Waits for the durable 'started' marker (and, with info, the action/start audit row), at most startTimeoutMs.
  // Always resolves, to 'ok' | 'timeout' | 'failed:<code>'. The caller decides between fail open and fail closed.
  function startDurable(key, info = null) {
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), startTimeoutMs); timer.unref?.(); });
    const failed = (e) => `failed:${typeof e?.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(e.code) ? e.code : 'ERROR'}`;
    let p;
    try { p = Promise.resolve(info ? persist.start(key, now(), info) : persist.start(key, now())).then(() => 'ok', failed); } catch (e) { p = Promise.resolve(failed(e)); }
    return Promise.race([p, timeout]).then((v) => {
      clearTimeout(timer);
      if (v === 'ok') counts.startDurable++; else if (v === 'timeout') counts.startUnconfirmed++; else counts.startFailed++;
      return v;
    });
  }

  // Refusal: the action does not run. Nothing ran, so the key is not spent: it is forgotten in memory and a done marker
  // with outcome 'refused' is queued (seed() ignores it), so an honest retry with the same key runs. The core is told.
  // key may be null (no audit attached, nothing claimed). Throws (synchronously, or as a rejection inside a .then).
  function refuse(key, act, cause, reason = AUDIT_UNAVAILABLE) {
    if (reason === PANIC_REFUSED) counts.refusedPanic++;
    else if (reason === LIVE_STATE_CHANGED) counts.refusedLiveChanged++;
    else counts.refusedNoAudit++;
    if (key) {
      keys.delete(key);
      try { persist?.done(key, now(), 'refused'); } catch { /* the audit may be what failed */ }
    }
    try { onRefused?.(act, cause, reason); } catch { /* a hook must never turn a refusal into a run */ }
    const err = new Error(reason);
    err.code = reason;
    err.auditCause = cause;
    throw err;
  }
  const startInfo = (act, keyed) => ({ id: act.id, source: act.source, class: act.class, liveState: act.liveState ?? 'unknown', keyed });
  const oneOffKey = () => randomBytes(32).toString('hex');
  const isWrite = (act) => FAIL_CLOSED_CLASSES.includes(act?.class);

  // The last check before inner.execute, run in the same synchronous step as the call (no await in between).
  // durable: a start record for this action has committed. Returns null or [cause, reason].
  function recheck(act, guard, durable) {
    if (!isWrite(act)) return null; // reads are harmless and never wait on a record
    if (guard && typeof guard.revalidate === 'function') {
      let r;
      try { r = guard.revalidate(); } catch { r = LIVE_STATE_CHANGED; } // a broken guard refuses (fail safe)
      if (r === PANIC_REFUSED) return ['revalidate', PANIC_REFUSED];
      if (r != null) return ['revalidate', LIVE_STATE_CHANGED];
    }
    let ls = act.liveState;
    if (guard && typeof guard.liveState === 'function') { try { ls = guard.liveState(); } catch { ls = 'unknown'; } }
    if (!durable && requiresDurableAudit({ class: act.class, liveState: ls }) && !(persist === null && allowUnaudited)) {
      return [persist === null ? 'no-audit' : 'not-durable', AUDIT_UNAVAILABLE];
    }
    return null;
  }
  // Re-check, then run (or refuse). key may be null for an unkeyed, non-strict action.
  function checkedRun(key, act, guard, durable) {
    const no = recheck(act, guard, durable);
    if (no) return refuse(key, act, no[0], no[1]);
    if (key === null) return inner.execute(act);
    return run(key, act);
  }

  function execute(act, guard = null) {
    const key = act?.idempotencyKey;
    // Finding 1: with persistence, every write is strict, whatever the live state at dispatch.
    const strict = persist !== null && isWrite(act);
    if (strict) counts.failClosed++;
    // Finding 3: no audit attached, nothing can be durably recorded: a write while not offline is refused.
    if (persist === null && !allowUnaudited && requiresDurableAudit(act)) return refuse(null, act, 'no-audit');
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      counts.unkeyed++;
      if (!strict) return checkedRun(null, act, guard, false);
      // Unkeyed write: a one-off key carries the durable marker. It is never a resend target.
      const k = oneOffKey();
      return startDurable(k, startInfo(act, false)).then((v) => (v === 'ok' ? checkedRun(k, act, guard, true) : refuse(k, act, v)));
    }
    const t = now();
    expire(t);
    const e = keys.get(key);
    if (e) {
      if (e.state === 'completed') { counts.skippedCompleted++; return { skipped: 'completed' }; }
      if (e.state === 'ambiguous') { counts.skippedAmbiguous++; return { skipped: 'ambiguous' }; }
      counts.skippedRunning++; return { skipped: 'running' };
    }
    remember(key, 'running', t); // claimed before any await: a second request for the key is skipped from here on
    if (!persist && !hook) return checkedRun(key, act, guard, false);
    const info = strict ? startInfo(act, true) : null;
    const go = (v) => (strict && v !== 'ok' ? refuse(key, act, v) : checkedRun(key, act, guard, strict && v === 'ok'));
    if (!hook) return startDurable(key, info).then(go); // the marker is queued now, in this call
    let started = persist ? 'ok' : 'none';
    return phase('before-start', key)
      .then(() => (persist ? startDurable(key, info).then((v) => { started = v; }) : undefined))
      .then(() => phase('after-start', key))
      .then(() => go(started));
  }

  /** Seed from persisted rows [{ key, started_at, completed_at, outcome? }] (wall ms). Returns the number of keys added.
   *  A row with outcome 'refused' (the action did not run) is ignored: its key stays free for a retry. */
  function seed(rows, nowWall = now()) {
    let added = 0;
    const fresh = (Array.isArray(rows) ? rows : [])
      .filter((r) => {
        if (r?.outcome === 'refused') { counts.seededRefused++; return false; }
        return typeof r?.key === 'string' && KEY_RE.test(r.key) && Number.isFinite(r.started_at) && nowWall - r.started_at < retentionMs && !keys.has(r.key);
      })
      .sort((a, b) => a.started_at - b.started_at);
    const existing = [...keys];
    keys.clear();
    const merged = [...fresh.map((r) => [r.key, { state: r.completed_at != null ? 'completed' : 'ambiguous', at: r.started_at }]), ...existing]
      .sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of merged.slice(-maxKeys)) keys.set(k, v);
    for (const r of fresh) { if (keys.has(r.key)) { added++; if (r.completed_at == null) counts.seededAmbiguous++; } }
    counts.seeded += added;
    return added;
  }

  return {
    execute, seed,
    has: (key) => keys.has(key),
    stateOf: (key) => keys.get(key)?.state ?? null,
    stats: () => ({ ...counts, size: keys.size, retentionMs, maxKeys, startTimeoutMs, persistent: persist !== null }),
  };
}
