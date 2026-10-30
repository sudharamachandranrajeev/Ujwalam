// SPDX-License-Identifier: GPL-2.0-or-later
// Bench (a): PLAIN audit write. SYNTHETIC rows. Store used directly, synchronous=FULL, 200-row batches.
// Writes included: audit rows only (the hash-chained `audit` table + `audit_head`). NOT included: chat_raw rows,
// persisted dedupe keys (migration v2), idempotency action keys (migration v3), the live core, the writer thread.
// Same workload as the rate phase of the former combined bench `event-core-audit` (10 000 rows), so it can be
// compared with that bench's `rows_per_s` baseline. Part of PB-12.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../../services/event-core/audit/store.mjs';

export const id = 'event-core-audit-write';
export const budget = 'PB-12';
export const metrics = {
  rows_per_s: { unit: 'rows/s', lowerIsBetter: false, minDelta: 20000 },
};

const N = 10000;
const BATCH = 200;

export function run() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-write-bench-'));
  try {
    const s = openStore({ file: path.join(dir, 'rate.db') });
    const row = (i) => ({ ts: '2026-10-28T00:00:00.000Z', type: 'decision', subtype: 'request', action_id: 'state.read', source: 'ui', verdict: 'allow', reason: 'read', detail: `{"n":${i}}` });
    const t0 = performance.now();
    for (let i = 0; i < N; i += BATCH) s.appendBatch(Array.from({ length: BATCH }, (_, j) => row(i + j)), []);
    const rows_per_s = N / ((performance.now() - t0) / 1000);
    s.close();
    return { rows_per_s, info: { rows: { audit: N, chat_raw: 0, dedupe_keys: 0, action_keys: 0 }, batches: N / BATCH, batchRows: BATCH, synchronous: 'FULL (store default)' } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
