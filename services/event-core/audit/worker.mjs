// SPDX-License-Identifier: GPL-2.0-or-later
// Audit writer thread (P3 E5). Owns the SQLite connection. Receives batches and requests by message; replies with
// counts and error CODES only (never an error message, which could echo SQL or values). Node stdlib only.

import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from './store.mjs';

let store = null;
try {
  store = openStore(workerData.storeOpts);
  parentPort.postMessage({ op: 'ready', stats: store.stats() });
} catch (e) {
  parentPort.postMessage({ op: 'fatal', code: e?.code ?? 'OPEN_FAILED' });
}

parentPort.on('message', (m) => {
  if (!store) { parentPort.postMessage({ op: 'error', id: m.id, code: 'NOT_OPEN' }); return; }
  try {
    switch (m.op) {
      case 'batch': {
        const t0 = performance.now();
        const r = store.appendBatch(m.audit, m.raw, m.dedupe, m.actions);
        parentPort.postMessage({ op: 'ack', id: m.id, ...r, ms: performance.now() - t0 });
        break;
      }
      case 'actions-load': parentPort.postMessage({ op: 'result', id: m.id, value: store.loadActionKeys(m.args?.since) }); break;
      case 'dedupe-load': parentPort.postMessage({ op: 'result', id: m.id, value: store.loadDedupe(m.args?.since) }); break;
      case 'purge': parentPort.postMessage({ op: 'result', id: m.id, value: store.purge(m.args) }); break;
      case 'verify': parentPort.postMessage({ op: 'result', id: m.id, value: store.verify() }); break;
      case 'export': parentPort.postMessage({ op: 'result', id: m.id, value: store.exportPage(m.args) }); break;
      case 'stats': parentPort.postMessage({ op: 'result', id: m.id, value: store.stats() }); break;
      case 'close': store.close(); store = null; parentPort.postMessage({ op: 'result', id: m.id, value: true }); break;
      default: parentPort.postMessage({ op: 'error', id: m.id, code: 'BAD_OP' });
    }
  } catch (e) {
    parentPort.postMessage({ op: 'error', id: m.id, code: e?.code ?? e?.name ?? 'ERROR' });
  }
});
