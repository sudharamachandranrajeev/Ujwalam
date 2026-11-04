// SPDX-License-Identifier: GPL-3.0-or-later
// Audit writer (P3 E5): runs the store off the caller's path. Node stdlib only.
//   mode 'worker' (default): a worker_threads thread owns the database; the main thread only posts a message.
//   mode 'inline': the store runs on the main thread inside a setImmediate callback (kept for tests and as the
//                  measured alternative; blocks the event loop for the length of one transaction).
// Interface: ready (Promise), batch(audit, raw) -> Promise<{ blockMs }>, request(op, args) -> Promise, close().
// Every failure is an AuditError carrying a code, never a message from SQLite.

import { Worker } from 'node:worker_threads';
import { AuditError, openStore } from './store.mjs';

export function createWriter({ mode = 'worker', storeOpts }) {
  return mode === 'inline' ? inlineWriter(storeOpts) : workerWriter(storeOpts);
}

function inlineWriter(storeOpts) {
  let store = null;
  let failed = null;
  const ready = new Promise((resolve, reject) => {
    setImmediate(() => {
      try { store = openStore(storeOpts); resolve(store.stats()); } catch (e) { failed = new AuditError(e?.code ?? 'OPEN_FAILED'); reject(failed); }
    });
  });
  ready.catch(() => {});
  const run = (fn) => new Promise((resolve, reject) => {
    setImmediate(async () => {
      try { await ready; resolve(fn()); } catch (e) { reject(new AuditError(e?.code ?? 'ERROR')); }
    });
  });
  return {
    mode: 'inline', ready,
    batch: (audit, raw, dedupe = [], actions = []) => run(() => { const t0 = performance.now(); const r = store.appendBatch(audit, raw, dedupe, actions); return { ...r, blockMs: performance.now() - t0 }; }),
    request: (op, args) => run(() => {
      if (op === 'dedupe-load') return store.loadDedupe(args?.since);
      if (op === 'actions-load') return store.loadActionKeys(args?.since);
      if (op === 'purge') return store.purge(args);
      if (op === 'verify') return store.verify();
      if (op === 'export') return store.exportPage(args);
      if (op === 'stats') return store.stats();
      throw new AuditError('BAD_OP');
    }),
    close: () => run(() => { if (store) store.close(); store = null; return true; }).catch(() => true),
  };
}

function workerWriter(storeOpts) {
  // functions cannot cross the thread boundary; the worker uses Date.now for migration stamps, and purge gets `now` per call
  const { now: _now, ...cloneable } = storeOpts;
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { storeOpts: cloneable }, stdout: true, stderr: true });
  const pending = new Map();
  let seq = 0;
  let dead = null;
  let resolveReady; let rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});
  const failAll = (err) => { dead = err; for (const p of pending.values()) p.reject(err); pending.clear(); worker.unref(); rejectReady(err); };

  worker.on('message', (m) => {
    if (m.op === 'ready') { resolveReady(m.stats); settle(); return; }
    if (m.op === 'fatal') { failAll(new AuditError(m.code)); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    settle();
    if (m.op === 'ack') p.resolve({ audit: m.audit, raw: m.raw, dedupe: m.dedupe ?? 0, actions: m.actions ?? 0, workerMs: m.ms });
    else if (m.op === 'result') p.resolve(m.value);
    else p.reject(new AuditError(m.code ?? 'ERROR'));
  });
  worker.on('error', () => failAll(new AuditError('WORKER_ERROR')));
  worker.on('exit', () => { if (!dead) failAll(new AuditError('WORKER_EXITED')); });
  // The worker is ref'd until it reports ready, then only while a message is pending: an idle writer never keeps the process alive.
  const settle = () => { if (pending.size === 0) worker.unref(); };

  const send = (msg) => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    msg.id = ++seq;
    pending.set(msg.id, { resolve, reject });
    worker.ref();
    worker.postMessage(msg);
  });

  return {
    mode: 'worker', ready,
    async batch(audit, raw, dedupe = [], actions = []) {
      const t0 = performance.now();
      const p = send({ op: 'batch', audit, raw, dedupe, actions }); // the structured clone happens inside postMessage: that is the blocking time
      const blockMs = performance.now() - t0;
      const r = await p;
      return { ...r, blockMs };
    },
    request: (op, args) => send({ op, args }),
    async close() {
      try { if (!dead) await send({ op: 'close' }); } catch { /* already gone */ }
      dead = dead ?? new AuditError('CLOSED');
      await worker.terminate();
      return true;
    },
  };
}
