// SPDX-License-Identifier: GPL-3.0-or-later
// Event core, in-process part (P3 E1): build, validate, dedupe, publish. No network, no Streamer.bot (E2).
// Node stdlib only.
//
//   const core = createEventCore({ dataDir });
//   core.bus.subscribe({ name: 'x', kinds: ['chat.'], handler: (ev) => {} });
//   const r = core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'm1',
//                           user: { platformUserId: 'u1', displayName: 'A' }, text: 'hi' });
//   // r = { status: 'published' | 'deduped' | 'invalid', event?, errors? }
//
// ingest() is synchronous and never touches disk after start-up. Chat text is untrusted data: it is only
// stored in the event, never interpreted here.

import { createBus } from './bus.mjs';
import { loadKey, resolveDataDir } from './config.mjs';
import { createDedupe } from './dedupe.mjs';
import { buildEvent, createIdGenerator, derivePseudoId } from './model.mjs';
import { validateEvent } from './validate.mjs';
import { createModeration } from './moderation/index.mjs';
import { buildCatalogue, createActionGate, createIdempotentExecutor, loadCatalogue } from './livelock/index.mjs';
import { createAudit } from './audit/index.mjs';
import { AUDIT_UNAVAILABLE, LIVE_STATE_CHANGED, PANIC_REFUSED } from './livelock/idempotency.mjs';

export { createBus } from './bus.mjs';
export { createDedupe } from './dedupe.mjs';
export { loadKey, resolveDataDir } from './config.mjs';
export { buildEvent, createIdGenerator, derivePseudoId, EventError, KINDS, ROLES } from './model.mjs';
export { validateEvent } from './validate.mjs';
export { createModeration } from './moderation/index.mjs';
export * from './livelock/index.mjs';
export { createAudit, AuditError } from './audit/index.mjs';

/** opts: { dataDir?, profilePath?, dedupe?: { windowMs, maxEntries }, queueLimit?, wall?, mono?, key? }.
 *  wall, mono and key are test seams (key skips the key file).
 *  moderation: false turns the stage off; an object is passed to createModeration (blocklist, limits, now, echoScope);
 *  actions: false turns the action gate off (core.actions is null); an object is { catalogue?: parsed JSON,
 *  executor?, onDecision?, now?, wall?, ttlMs?, maxPending?, liveStaleMs?, idempotency?, allowUnaudited? (TEST ONLY) }
 *  for createActionGate (default
 *  catalogue: data/actions/catalogue.json). The executor is wrapped by livelock/idempotency.mjs: a keyed action runs at
 *  most once (keys persisted through the audit when attached, seeded before `ready`). idempotency: { retentionMs,
 *  maxKeys, startTimeoutMs, phaseHook (test seam only) }. Any catalogue is validated through buildCatalogue; there is no pre-built Map seam.
 *  The studio feed's system.disconnected must be followed by core.actions.setLiveState('unknown', { source: 'system' }).
 *  audit: { dataDir, ...createAudit options } attaches the E5 audit (core.audit; null without it): moderation drops/flags,
 *  gate decisions and system events go to a hash-chained SQLite audit, chat text to a 30-day chat_raw table. All writes are
 *  queued and done by a worker thread; ingest never waits on disk. The caller owns core.audit.close().
 *  onVerdict(event, verdict) is called for every drop and flag, after the audit hook.
 *  Fail closed (2026-10-28, E4b review fixes 2026-10-29): with an audit attached, a write (class write or on-air-write,
 *  any live state) that cannot get a durable audit record within idempotency.startTimeoutMs (250 ms) is refused
 *  ('audit-unavailable') and never runs; right before it runs it is re-checked against the current gate state and
 *  refused 'panic' or 'live-state-changed' when those changed since dispatch. WITHOUT an audit, a write while not
 *  offline is refused 'audit-unavailable' unless actions.allowUnaudited: true (TEST ONLY; never in the service). A
 *  refusal does not spend the idempotency key. It is a system.refused event on the bus (and so over SSE, and an audit
 *  row once the audit writes again) plus one log line (codes only, at most one per second; log(line) defaults to
 *  console.warn). */
export function createEventCore(opts = {}) {
  const key = opts.key ?? loadKey(resolveDataDir(opts)).key;
  const ctx = { key, nextId: createIdGenerator({ wall: opts.wall }), wall: opts.wall, mono: opts.mono };
  const bus = createBus({ queueLimit: opts.queueLimit });
  const mod = opts.moderation === false ? null : createModeration(opts.moderation ?? {});
  const audit = opts.audit ? createAudit({ now: opts.wall, ...opts.audit }) : null;
  // E7: with an audit attached, every first-seen dedupe key (a SHA-256, never the raw id) is queued for the audit worker.
  // The same key is the idempotency origin of actions that event triggers: event id -> key, bounded, newest kept.
  const wallNow = () => (opts.wall ?? Date.now)();
  const origins = new Map();
  const onSeen = (k, ev) => {
    if (ev?.id) {
      origins.set(ev.id, k);
      if (origins.size > ORIGIN_CAP) origins.delete(origins.keys().next().value);
    }
    audit?.recordDedupe(k, wallNow());
  };
  const dedupe = createDedupe({ ...(opts.dedupe ?? {}), onSeen });
  const counts = { invalid: 0, moderated: 0, refusedNoAudit: 0, refusedRecheck: 0 };
  const log = typeof opts.log === 'function' ? opts.log : (line) => console.warn(line);
  let lastLogAt = -Infinity;
  let logSuppressed = 0;
  // An action refused because it could not be audited: visible on the bus (SSE) and in the audit (a system row, written
  // when the writer recovers; dropped and counted if it is down), and as a log line for the case the audit is down.
  function onAuditRefused(act, cause, reason) {
    const why = REFUSAL_REASONS.includes(reason) ? reason : 'audit-unavailable';
    if (why === 'audit-unavailable') counts.refusedNoAudit++; else counts.refusedRecheck++;
    const id = typeof act?.id === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(act.id) ? act.id : 'invalid';
    try { ingest({ kind: 'system.refused', platform: 'local', source: 'system', action: id, reason: why }); } catch { /* never turn a refusal into a run */ }
    const t = performance.now();
    if (t - lastLogAt < 1000) { logSuppressed++; return; }
    lastLogAt = t;
    const c = typeof cause === 'string' && /^[A-Za-z0-9:_-]{1,48}$/.test(cause) ? cause : 'unknown';
    try { log(`[event-core] warn: action-refused reason=${why} action=${id} cause=${c}${logSuppressed ? ` suppressed=${logSuppressed}` : ''}`); } catch { /* ignore */ }
    logSuppressed = 0;
  }
  let actions = null;
  let idem = null;
  if (opts.actions !== false) try {
    const a = opts.actions ?? {};
    if ('catalogueMap' in a) throw new TypeError('actions.catalogueMap is not supported; pass catalogue (parsed JSON)');
    const catalogue = a.catalogue ? buildCatalogue(a.catalogue) : loadCatalogue();
    // system.livestate and system.panic go on the bus so rules and the dashboard can see them.
    const emit = (kind, fields) => { ingest({ kind, platform: 'local', source: 'system', ...fields }); };
    // Idempotency sits at the executor, so it covers every source (chat, rules, UI, API, schedule).
    const { idempotency: io = {}, allowUnaudited, ...gateOpts } = a;
    if (a.executor && typeof a.executor.execute === 'function') {
      idem = createIdempotentExecutor({
        executor: a.executor, now: wallNow,
        retentionMs: io.retentionMs, maxKeys: io.maxKeys, startTimeoutMs: io.startTimeoutMs, phaseHook: io.phaseHook,
        persist: audit ? { start: (k, at, info) => (info ? audit.recordActionStart(k, at, info) : audit.recordActionStart(k, at)), done: (k, at, outcome) => audit.recordActionDone(k, at, outcome) } : null,
        onRefused: onAuditRefused, allowUnaudited: allowUnaudited === true,
      });
    }
    actions = createActionGate({
      ...gateOpts, catalogue, emit, executor: idem ?? a.executor, originOf: (id) => origins.get(id),
      onDecision: audit ? (rec) => { audit.recordDecision(rec); a.onDecision?.(rec); } : a.onDecision,
    });
  } catch (e) { audit?.close(); throw e; } // do not leak the audit lock when the gate cannot be built
  // ready resolves once the audit is open, the last dedupe window is loaded and the idempotency keys are seeded;
  // await it before ingesting. It resolves to the number of dedupe keys seeded.
  const idemLoad = { seeded: 0, ambiguous: 0, error: null };
  const ready = audit
    ? audit.ready.then(() => audit.loadDedupe(dedupe.stats().windowMs)).then(
      (rows) => dedupe.seed(rows, (opts.mono ?? (() => performance.now()))(), wallNow()),
      () => 0, // an unreadable audit leaves the dedupe memory-only; the audit reports its own failure
    ).then(async (n) => {
      if (!idem) return n;
      try {
        const rows = await audit.loadActionKeys(idem.stats().retentionMs);
        const before = idem.stats().seededAmbiguous;
        idemLoad.seeded = idem.seed(rows, wallNow());
        idemLoad.ambiguous = idem.stats().seededAmbiguous - before;
        if (idemLoad.ambiguous) audit.recordSystem({ subtype: 'action-ambiguous', source: 'system', verdict: 'skip', reason: 'started-not-completed', detail: { count: idemLoad.ambiguous } });
      } catch (e) { idemLoad.error = e?.code ?? 'ERROR'; } // keys stay memory-only; counted in stats
      return n;
    })
    : Promise.resolve(0);

  function ingest(input) {
    const event = buildEvent(ctx, input);
    const v = validateEvent(event);
    if (!v.ok) { counts.invalid++; return { status: 'invalid', errors: v.errors }; }
    if (dedupe.isDuplicate(event, event.mono)) return { status: 'deduped', event };
    let out = event;
    let verdict;
    if (mod) {
      verdict = mod.moderate(event);
      if (verdict.action !== 'pass') {
        counts.moderated++;
        audit?.recordVerdict(event, verdict);
        try { opts.onVerdict?.(event, verdict); } catch { /* an audit hook must never break ingest */ }
      }
      if (verdict.action === 'drop') return { status: 'dropped', event, verdict };
      if (verdict.action === 'flag') out = redact(event, verdict);
    }
    if (audit && !(verdict && verdict.action !== 'pass')) audit.observe(out); // a flagged alert's raw text was recorded by recordVerdict
    bus.publish(out);
    return verdict ? { status: 'published', event: out, verdict } : { status: 'published', event: out };
  }

  function stats() {
    const d = dedupe.stats();
    return {
      published: bus.stats().published,
      deduped: d.duplicates,
      noPlatformId: d.noId,
      invalid: counts.invalid,
      moderated: counts.moderated,
      refusedNoAudit: counts.refusedNoAudit,
      refusedRecheck: counts.refusedRecheck,
      dedupe: d,
      subscribers: bus.stats().subscribers,
      ...(idem ? { idempotency: { ...idem.stats(), load: { ...idemLoad } } } : {}),
    };
  }

  return { ingest, bus, stats, ready, moderation: mod, actions, audit, pseudoId: (platform, platformUserId) => derivePseudoId(key, platform, platformUserId) };
}

const REFUSAL_REASONS = Object.freeze([AUDIT_UNAVAILABLE, LIVE_STATE_CHANGED, PANIC_REFUSED]);
const ORIGIN_CAP = 4096; // event id -> dedupe key, for idempotency origins of recent events

// A flagged alert is real, so subscribers still get it, minus the text that tripped the filter:
// the free-text message is removed, and an unusable display name becomes 'viewer'.
function redact(event, verdict) {
  const copy = { ...event };
  if (verdict.reasons.includes('blocked')) delete copy.message;
  if (verdict.reasons.includes('bad-name') && copy.user) copy.user = Object.freeze({ ...copy.user, displayName: 'viewer' });
  return Object.freeze(copy);
}
