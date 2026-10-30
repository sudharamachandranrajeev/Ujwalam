// SPDX-License-Identifier: GPL-2.0-or-later
// Event-core audit (P3 E5). Node stdlib only (node:sqlite, worker_threads).
//
//   const audit = createAudit({ dataDir });      // or createEventCore({ audit: { dataDir } })
//   audit.observe(event)            // chat/alert text -> chat_raw (30-day retention); system.* -> audit row
//   audit.recordVerdict(event, v)   // moderation drop/flag -> audit row (+ raw text for review)
//   audit.recordDecision(rec)       // action-gate decision -> audit row
//   await audit.recordActionStart(key, at); audit.recordActionDone(key, at, outcome)   // idempotency keys (see below)
//   await audit.flush(); await audit.purge({ olderThanDays }); await audit.verify(); await audit.close();
//
// Live path rule: every record*/observe call validates a few fields, pushes a plain object on an in-memory queue
// and returns. No disk, no hashing, no await. A timer or a full batch hands the queue to the writer (a worker
// thread by default) which hashes and commits one transaction per batch. The queue is capped; when it is full the
// newest item is dropped and counted (never blocks), and the next batch carries a 'system/audit-overflow' row with
// the drop counts. The audit tables hold ids, pseudo ids, action/rule ids, verdicts, reasons and timestamps only
// (sanitise.mjs enforces patterns). Raw text lives only in chat_raw, outside the chain.
//
// One process owns the database: createAudit takes an exclusive lock (lock.mjs) and throws AuditError('DB_LOCKED')
// when someone else holds it.

import path from 'node:path';
import { ensureSecureDir } from '../config.mjs';
import { acquireLock } from './lock.mjs';
import * as S from './sanitise.mjs';
import { DAY_MS, DB_NAME, DEFAULT_RETENTION_DAYS, AuditError } from './store.mjs';
import { createWriter } from './writer.mjs';

export { AuditError, DB_NAME, DEFAULT_RETENTION_DAYS } from './store.mjs';
export { backupAudit, openStore, verifyDb, isInside } from './store.mjs';
export { acquireLock, LOCK_NAME } from './lock.mjs';
export { MIGRATIONS, migrate } from './schema.mjs';

export const DEFAULTS = Object.freeze({
  mode: 'worker',
  batchMax: 200,        // rows per transaction; a full batch is handed over at once
  batchMs: 100,         // otherwise the queue is handed over at most this long after its first item
  queueMax: 10_000,     // audit rows queued + in flight
  rawQueueMax: 20_000,  // chat_raw rows queued + in flight
  dedupeQueueMax: 50_000, // dedupe keys queued + in flight (E7)
  actionQueueMax: 50_000, // idempotency key rows queued + in flight (E7 follow-up)
  retentionDays: DEFAULT_RETENTION_DAYS,
  purgeIntervalMs: DAY_MS,
});
const PSEUDO_CACHE = 4096;
const BLOCK_SAMPLES = 2048;

const posInt = (name, v, d) => {
  const x = v ?? d;
  if (!Number.isInteger(x) || x < 1) throw new RangeError(`${name} must be an integer >= 1`);
  return x;
};
/** A waiter that resolves after n resolve() calls and rejects on the first reject(). */
function joinWaiter(n, resolve, reject) {
  let left = n;
  let settled = false;
  return {
    resolve: () => { if (!settled && --left === 0) { settled = true; resolve(); } },
    reject: (e) => { if (!settled) { settled = true; reject(e); } },
  };
}
const defaultNote = (level, code) => { if (level === 'error' || level === 'warn') console.warn(`[audit] ${level}: ${code}`); }; // codes only, never content

/** opts: { dataDir, mode?, batchMax?, batchMs?, queueMax?, rawQueueMax?, retentionDays?, purgeOnStart?, purgeIntervalMs?,
 *          scheduler?: { setInterval(fn, ms), clearInterval(h) }, now?: () => ms, onNote?(level, code, data), synchronous? } */
export function createAudit(opts = {}) {
  if (typeof opts.dataDir !== 'string' || !opts.dataDir) throw new TypeError('audit.dataDir is required');
  const dataDir = path.resolve(opts.dataDir);
  const o = {
    mode: opts.mode ?? DEFAULTS.mode,
    batchMax: posInt('batchMax', opts.batchMax, DEFAULTS.batchMax),
    batchMs: posInt('batchMs', opts.batchMs, DEFAULTS.batchMs),
    queueMax: posInt('queueMax', opts.queueMax, DEFAULTS.queueMax),
    rawQueueMax: posInt('rawQueueMax', opts.rawQueueMax, DEFAULTS.rawQueueMax),
    dedupeQueueMax: posInt('dedupeQueueMax', opts.dedupeQueueMax, DEFAULTS.dedupeQueueMax),
    actionQueueMax: posInt('actionQueueMax', opts.actionQueueMax, DEFAULTS.actionQueueMax),
    purgeIntervalMs: posInt('purgeIntervalMs', opts.purgeIntervalMs, DEFAULTS.purgeIntervalMs),
  };
  if (!['worker', 'inline'].includes(o.mode)) throw new RangeError("mode must be 'worker' or 'inline'");
  const retentionDays = opts.retentionDays ?? DEFAULTS.retentionDays;
  if (!(Number.isFinite(retentionDays) && retentionDays >= 0)) throw new RangeError('retentionDays must be a number >= 0');
  const now = opts.now ?? Date.now;
  const note = opts.onNote ?? defaultNote;

  // raw chat lives here: restrict the directory and everything in it, or refuse to open (review E8-06)
  if (ensureSecureDir(dataDir).protection === 'acl-failed') throw new Error('could not restrict the audit data directory to the current user (ACL_FAILED)');
  const lock = acquireLock(dataDir);
  let writer;
  try {
    writer = createWriter({ mode: o.mode, storeOpts: { file: path.join(dataDir, DB_NAME), now, synchronous: opts.synchronous ?? 'FULL' } });
  } catch (e) { lock.release(); throw e; }

  const qa = [];
  const qaw = []; // aligned with qa: { resolve, reject } for a row whose caller waits for its commit (fail-closed start), else null
  const qr = [];
  const qd = []; // dedupe keys { key, seen_at }
  const qx = []; // idempotency key rows { key, op, at, outcome? }
  const qxw = []; // aligned with qx: { resolve, reject } for a 'start' row whose caller waits for the commit, else null
  let inflightX = 0;
  let inflightA = 0;
  let inflightR = 0;
  let inflightD = 0;
  let droppedA = 0;
  let droppedR = 0;
  const totals = { enqueuedA: 0, enqueuedR: 0, writtenA: 0, writtenR: 0, droppedA: 0, droppedR: 0, lostA: 0, lostR: 0, enqueuedD: 0, writtenD: 0, droppedD: 0, lostD: 0, enqueuedX: 0, writtenX: 0, droppedX: 0, lostX: 0, batches: 0, writeErrors: 0, purges: 0 };
  const blocks = [];
  let timer = null;
  let immediate = null;
  let closed = false;
  let failed = null; // error code once the writer is unusable
  let lastError = null;
  const pendingBatches = new Set();
  const pseudoOf = new Map();
  // Diagnostics for the stall tracer (main-thread numbers only): the last batch handed to the writer and the last request.
  let lastWrite = null; // { postedAt (mono ms), ackMs, workerMs, blockMs, rows }
  let lastOp = null;    // { op, startedAt (mono ms), ms (null while running) }

  const iso = () => new Date(now()).toISOString();

  // ---- queueing (hot path: no I/O) ----
  function pushAudit(row, waiter = null) {
    if (closed || failed) { droppedA++; totals.droppedA++; return false; }
    if (qa.length + inflightA >= o.queueMax) { droppedA++; totals.droppedA++; return false; }
    qa.push(row);
    qaw.push(waiter);
    totals.enqueuedA++;
    kick(waiter !== null);
    return true;
  }
  function pushRaw(row) {
    if (closed || failed) { droppedR++; totals.droppedR++; return; }
    if (qr.length + inflightR >= o.rawQueueMax) { droppedR++; totals.droppedR++; return; }
    qr.push(row);
    totals.enqueuedR++;
    kick();
  }
  function pushDedupe(row) {
    if (closed || failed) { totals.droppedD++; return; }
    if (qd.length + inflightD >= o.dedupeQueueMax) { totals.droppedD++; return; }
    qd.push(row);
    totals.enqueuedD++;
    kick();
  }
  // A durable 'start' marker is waited for by an action about to run: it is handed to the writer at once (next
  // setImmediate), not after the batch timer. Everything queued by then rides in the same transaction.
  function pushAction(row, waiter) {
    if (closed || failed) { totals.droppedX++; return false; }
    if (qx.length + inflightX >= o.actionQueueMax) { totals.droppedX++; return false; }
    qx.push(row);
    qxw.push(waiter);
    totals.enqueuedX++;
    kick(waiter !== null);
    return true;
  }
  function kick(urgent = false) {
    if (closed) return;
    if (urgent || qa.length >= o.batchMax || qr.length >= o.batchMax || qd.length >= o.batchMax || qx.length >= o.batchMax) {
      if (!immediate) immediate = setImmediate(() => { immediate = null; drainSome(); });
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; drainSome(); }, o.batchMs);
    }
  }
  function drainSome() {
    flushOnce();
    if (qa.length || qr.length || qd.length || qx.length) kick(qxw.some((w) => w !== null) || qaw.some((w) => w !== null));
  }

  function flushOnce() {
    if (!qa.length && !qr.length && !qd.length && !qx.length && !droppedA && !droppedR) return null;
    if (failed) { // writer unusable: count what is lost, keep memory bounded
      totals.lostA += qa.length; totals.lostR += qr.length; totals.lostD += qd.length; totals.lostX += qx.length;
      for (const w of qxw) w?.reject(new AuditError(failed));
      for (const w of qaw) w?.reject(new AuditError(failed));
      qa.length = 0; qaw.length = 0; qr.length = 0; qd.length = 0; qx.length = 0; qxw.length = 0; droppedA = 0; droppedR = 0;
      return null;
    }
    const audit = qa.splice(0, o.batchMax);
    const aw = qaw.splice(0, audit.length);
    const raw = qr.splice(0, o.batchMax);
    const dd = qd.splice(0, o.batchMax * 5);
    const xs = qx.splice(0, o.batchMax * 5);
    const xw = qxw.splice(0, xs.length);
    if (droppedA || droppedR) {
      audit.push({ ts: iso(), type: 'system', subtype: 'audit-overflow', source: 'audit', verdict: 'dropped', reason: 'queue-full', detail: JSON.stringify({ droppedAudit: droppedA, droppedRaw: droppedR }) });
      droppedA = 0; droppedR = 0;
    }
    inflightA += audit.length;
    inflightR += raw.length;
    inflightD += dd.length;
    inflightX += xs.length;
    totals.batches++;
    const postedAt = performance.now();
    const p = writer.batch(audit, raw, dd, xs).then(
      (r) => {
        totals.writtenA += r.audit; totals.writtenR += r.raw; totals.writtenD += r.dedupe ?? 0; totals.writtenX += r.actions ?? 0;
        for (const w of xw) w?.resolve(); // committed (synchronous=FULL): the 'start' markers are durable
        for (const w of aw) w?.resolve();
        lastWrite = { postedAt, ackMs: performance.now() - postedAt, workerMs: r.workerMs ?? null, blockMs: r.blockMs, rows: audit.length + raw.length + dd.length };
        blocks.push(r.blockMs);
        if (blocks.length > BLOCK_SAMPLES) blocks.shift();
      },
      (e) => {
        totals.writeErrors++; totals.lostA += audit.length; totals.lostR += raw.length; totals.lostD += dd.length; totals.lostX += xs.length;
        lastError = e?.code ?? 'ERROR';
        for (const w of xw) w?.reject(new AuditError(lastError));
        for (const w of aw) w?.reject(new AuditError(lastError));
        if (/^(WORKER|OPEN_FAILED|CLOSED|SCHEMA|NOT_AN)/.test(lastError)) failed = lastError;
        note('error', `write-failed:${lastError}`, { audit: audit.length, raw: raw.length });
      },
    ).finally(() => { inflightA -= audit.length; inflightR -= raw.length; inflightD -= dd.length; inflightX -= xs.length; pendingBatches.delete(p); });
    pendingBatches.add(p);
    return p;
  }

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (immediate) { clearImmediate(immediate); immediate = null; }
    for (;;) {
      while (qa.length || qr.length || qd.length || qx.length || droppedA || droppedR) flushOnce(); // each call consumes rows or clears them when the writer is dead
      if (!pendingBatches.size) break;
      await Promise.allSettled([...pendingBatches]);
    }
    return stats();
  }

  /** writer.request with the start and length recorded in lastOp (stall tracer context). */
  function req(op, args) {
    const rec = { op, startedAt: performance.now(), ms: null };
    lastOp = rec;
    return writer.request(op, args).finally(() => { rec.ms = performance.now() - rec.startedAt; });
  }

  // ---- recorders ----
  /** Dedupe key (SHA-256 hex of "platform:platformMessageId", computed by the dedupe stage) and its wall time in ms.
   *  Queued like any other row; the writer persists it in the next batch. Never throws, never waits. */
  function recordDedupe(key, seenAtMs) {
    try {
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return;
      pushDedupe({ key, seen_at: Number.isFinite(seenAtMs) ? Math.trunc(seenAtMs) : now() });
    } catch { /* never break ingest */ }
  }
  /** Keys seen in the last windowMs (wall), oldest first, for seeding the in-memory dedupe at start-up. */
  async function loadDedupe(windowMs = 120_000) {
    await flush();
    return req('dedupe-load', { since: now() - windowMs });
  }

  // ---- idempotency keys (livelock/idempotency.mjs) ----
  const KEY_RE = /^[0-9a-f]{64}$/;
  /** Queues a durable 'started' marker and resolves once the transaction holding it has committed. Rejects with an
   *  AuditError when the key is malformed, the queue is full or the writer fails. Never blocks the caller.
   *  info ({ id, source, class, liveState, keyed }, fail-closed on-air writes only) also queues one hash-chained audit row
   *  (type 'action', subtype 'start': action id, source, class, live state, key prefix; no params, no text). The promise
   *  then resolves only when BOTH the marker and that row have committed (they may ride in different batches). A start
   *  row followed by a system/system.refused row with the same action id means the action did not run. */
  function recordActionStart(key, atMs, info = null) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return Promise.reject(new AuditError('BAD_KEY'));
    const downCode = () => failed ?? (closed ? 'CLOSED' : 'QUEUE_FULL');
    return new Promise((resolve, reject) => {
      const at = Number.isFinite(atMs) ? Math.trunc(atMs) : now();
      const w = info ? joinWaiter(2, resolve, reject) : { resolve, reject };
      if (info) {
        const row = {
          ts: new Date(at).toISOString(), type: 'action', subtype: 'start', action_id: S.token(info.id), source: S.token(info.source),
          verdict: 'start', reason: S.token(info.class), detail: S.detail({ liveState: info.liveState, keyed: info.keyed === true, key: key.slice(0, 16) }),
        };
        if (!pushAudit(row, w)) { w.reject(new AuditError(downCode())); return; }
      }
      if (!pushAction({ key, op: 'start', at }, w)) w.reject(new AuditError(downCode()));
    });
  }
  /** Queues the 'completed' marker (normal batch timing; nobody waits for it). outcome 'ok' | 'error' | 'refused'
   *  ('refused': the action did not run; loadActionKeys returns it and the idempotent executor ignores the key). */
  function recordActionDone(key, atMs, outcome = 'ok') {
    try {
      if (typeof key !== 'string' || !KEY_RE.test(key)) return;
      pushAction({ key, op: 'done', at: Number.isFinite(atMs) ? Math.trunc(atMs) : now(), outcome: outcome === 'error' || outcome === 'refused' ? outcome : 'ok' }, null);
    } catch { /* never break an action */ }
  }
  /** Keys started in the last windowMs (wall), oldest first, for seeding the idempotent executor at start-up. */
  async function loadActionKeys(windowMs) {
    await flush();
    return req('actions-load', { since: now() - windowMs });
  }

  const rawRow = (event) => {
    const text = event.kind === 'chat.message' ? event.text : event.message;
    if (typeof text !== 'string' || !text) return null;
    return { event_id: event.id, received_at: now(), platform: String(event.platform ?? ''), display_name: event.user?.displayName ?? null, text };
  };
  const remember = (event) => {
    const p = event.user?.pseudoId;
    if (!p || !event.id) return;
    if (pseudoOf.size >= PSEUDO_CACHE) pseudoOf.delete(pseudoOf.keys().next().value);
    pseudoOf.set(event.id, p);
  };

  /** Call for every event that is published. Chat/alert text -> chat_raw; system.* -> audit row. */
  function observe(event) {
    try {
      const k = event?.kind;
      if (typeof k !== 'string') return;
      if (k === 'chat.message' || k.startsWith('alert.')) {
        remember(event);
        const r = rawRow(event);
        if (r) pushRaw(r);
      } else if (k.startsWith('system.')) {
        pushAudit({
          ts: S.token(event.receivedAt) ?? iso(), type: 'system', subtype: S.token(k), event_id: S.eventId(event.id),
          action_id: S.token(event.action), source: S.token(event.source), verdict: null, reason: S.token(event.reason),
          detail: S.detail({ target: event.target, live: event.live }),
        });
      }
    } catch { /* an audit hook must never break ingest */ }
  }

  /** Moderation drop or flag. The raw text is kept (chat_raw) so the user can review a drop within the retention window. */
  function recordVerdict(event, verdict) {
    try {
      remember(event);
      const rules = Array.isArray(verdict?.matched) ? verdict.matched.filter(Number.isInteger).join(',').slice(0, 60) : null;
      pushAudit({
        ts: iso(), type: 'moderation', subtype: S.token(event?.kind), event_id: S.eventId(event?.id), pseudo_id: S.pseudoId(event?.user?.pseudoId),
        rule_id: rules || null, source: S.token(event?.source), verdict: S.token(verdict?.action),
        reason: S.token(Array.isArray(verdict?.reasons) ? verdict.reasons.join(',').slice(0, 60) : null),
        detail: S.detail({ platform: event?.platform }),
      });
      const r = rawRow(event);
      if (r) pushRaw(r);
    } catch { /* never break ingest */ }
  }

  /** One action-gate decision record (gate onDecision). */
  function recordDecision(rec) {
    try {
      const ids = (rec?.provenance?.eventIds ?? []).map(S.eventId).filter(Boolean).slice(0, 8);
      let pseudo = S.pseudoId(rec?.actor);
      if (!pseudo) for (const id of ids) { const p = pseudoOf.get(id); if (p) { pseudo = p; break; } }
      const isRule = rec?.source === 'rule';
      pushAudit({
        ts: S.token(rec?.ts) ?? iso(), type: 'decision', subtype: S.token(rec?.type), event_id: ids[0] ?? null, pseudo_id: pseudo,
        action_id: S.token(rec?.actionId), rule_id: S.token(rec?.rule) ?? (isRule && !S.pseudoId(rec?.actor) ? S.token(rec?.actor) : null),
        source: S.token(rec?.source), verdict: S.token(rec?.verdict), reason: S.token(rec?.reason),
        detail: S.detail({
          tainted: rec?.provenance?.tainted === true, kinds: rec?.provenance?.kinds, eventIds: ids, liveState: rec?.liveState,
          panic: rec?.panic === true, to: rec?.to, actionHash: rec?.actionHash, confirmingSource: rec?.confirmingSource,
          step: rec?.step, dryRun: rec?.dryRun === true ? true : undefined, wouldDecision: rec?.wouldDecision, wouldReason: rec?.wouldReason, wouldSteps: rec?.wouldSteps, wouldClass: rec?.wouldClass, wouldTarget: rec?.wouldTarget,
        }),
      });
    } catch { /* never break the gate */ }
  }

  /** System rows from outside the event bus (start-up, shutdown ...). fields: subtype, reason, verdict, detail. */
  function recordSystem(f = {}) {
    try {
      pushAudit({ ts: iso(), type: 'system', subtype: S.token(f.subtype), source: S.token(f.source) ?? 'audit', verdict: S.token(f.verdict), reason: S.token(f.reason), detail: S.detail(f.detail) });
    } catch { /* never throw */ }
  }

  // ---- retention ----
  async function purge(p = {}) {
    await flush();
    const r = await req('purge', { now: p.now ?? now(), olderThanDays: p.olderThanDays ?? retentionDays, all: p.all === true, mode: p.mode ?? 'manual' });
    totals.purges++;
    return r;
  }
  const verify = async () => { await flush(); return req('verify'); };
  /** One page of audit rows (never chat_raw) after row id `afterId`, at most `limit` (<= 500). Goes through the writer. */
  const exportPage = async (p = {}) => { await flush(); return req('export', { afterId: p.afterId ?? 0, limit: p.limit ?? 100 }); };

  const sched = opts.scheduler ?? {
    setInterval: (f, ms) => { const t = setInterval(f, ms); t.unref?.(); return t; },
    clearInterval: (t) => clearInterval(t),
  };
  const safePurge = (mode) => purge({ mode }).catch((e) => { lastError = e?.code ?? 'ERROR'; note('error', `purge-failed:${lastError}`); });
  const dailyHandle = sched.setInterval(() => (closed ? undefined : safePurge('daily')), o.purgeIntervalMs); // returns the promise so a test scheduler can await it

  const ready = writer.ready.then(
    () => (opts.purgeOnStart === false ? null : safePurge('startup')),
    (e) => { failed = e?.code ?? 'OPEN_FAILED'; lastError = failed; note('error', `open-failed:${failed}`); },
  );

  function stats() {
    const sorted = [...blocks].sort((a, b) => a - b);
    const q = (f) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : 0);
    return {
      mode: o.mode, queuedAudit: qa.length, queuedRaw: qr.length, queuedDedupe: qd.length, inflightDedupe: inflightD, inflightAudit: inflightA, inflightRaw: inflightR,
      queuedActions: qx.length, inflightActions: inflightX,
      ...totals, failed, lastError, lastWrite, lastOp,
      blockMs: { n: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.length ? sorted[sorted.length - 1] : 0, sum: sorted.reduce((a, b) => a + b, 0) },
    };
  }

  async function close() {
    if (closed) return;
    try { await flush(); } catch { /* best effort */ }
    closed = true;
    if (timer) clearTimeout(timer);
    if (immediate) clearImmediate(immediate);
    sched.clearInterval(dailyHandle);
    try { await writer.close(); } finally { lock.release(); }
  }

  return { observe, recordDedupe, loadDedupe, recordActionStart, recordActionDone, loadActionKeys, recordVerdict, recordDecision, recordSystem, flush, purge, verify, exportPage, close, stats, ready, dataDir, file: path.join(dataDir, DB_NAME), retentionDays };
}
