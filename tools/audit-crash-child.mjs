// SPDX-License-Identifier: GPL-2.0-or-later
// Child process for the audit crash test (P3 E5): writes audit rows and raw rows continuously until it is killed.
// argv: dataDir round. Prints "ready", then "acked <rows>" lines (rows the writer has committed, durable with
// synchronous=FULL). SYNTHETIC rows only.
import { createAudit } from '../services/event-core/audit/index.mjs';

const [dataDir, roundArg] = process.argv.slice(2);
const round = Number(roundArg);
const audit = createAudit({ dataDir, batchMax: 50, batchMs: 20, purgeOnStart: false, queueMax: 5000, rawQueueMax: 5000 });
await audit.ready;
process.stdout.write('ready\n');
let seq = 0;
let lastAcked = 0;
const hex = (n, w) => n.toString(16).padStart(w, '0');
function pump() {
  const q = audit.stats();
  if (q.queuedAudit + q.inflightAudit > 1000 || q.queuedRaw + q.inflightRaw > 1000) { setTimeout(pump, 1); return; } // stay under the caps: a drop would be a (correct) gap, not a crash defect
  for (let i = 0; i < 20; i++) {
    seq++;
    audit.recordSystem({ subtype: 'crash-test', verdict: 'ok', detail: { round, seq } });
    audit.observe({ kind: 'chat.message', id: `e${hex(round, 12)}-${hex(seq, 8)}-00000000`, platform: 'twitch', text: `synthetic ${seq}`, user: { displayName: 'synthetic', pseudoId: '0'.repeat(32) } });
  }
  const w = audit.stats().writtenA;
  if (w !== lastAcked) { lastAcked = w; process.stdout.write(`acked ${w}\n`); }
  setImmediate(pump);
}
pump();
