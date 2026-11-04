// SPDX-License-Identifier: GPL-3.0-or-later
// Bench (b): FULL write path, everything the live core writes per event. SYNTHETIC input: generated events with
// made-up ids, names and text, no real chat. Part of PB-12.
// Phase 1 (real core, real writer thread, all four queues): ingest_p95_ms (what attaching the audit adds to
//   the ingest call, compare event-core-bus) and block_p95_ms (main thread blocked per batch hand-over).
//   Writes: audit rows (system events), chat_raw rows (one per chat message), persisted dedupe keys
//   (migration v2, one per platform event), idempotency action keys (migration v3: a start and a done row for every
//   10th chat message, SYNTHETIC rate; `recordActionStart` triggers an immediate hand-over like a live keyed action).
//   Not included: verdict/decision audit rows from the live-lock gate (same table as plain audit rows) and moderation.
// Phase 2 (store directly, synchronous=FULL, 200-event batches): rows_per_s over ALL tables and events_per_s, with a
//   per-batch mix taken from phase 1's ratios (per 200 events: 29 audit, 114 raw, 171 dedupe, 22 action rows).
// Row counts per table of both phases are returned as `info` (stored in the run file and baseline).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEventCore } from '../../../services/event-core/index.mjs';
import { openStore } from '../../../services/event-core/audit/store.mjs';

export const id = 'event-core-audit-full';
export const budget = 'PB-12';
export const metrics = {
  ingest_p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.01 },
  block_p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.05 },
  rows_per_s: { unit: 'rows/s', lowerIsBetter: false, minDelta: 20000 },
  events_per_s: { unit: 'events/s', lowerIsBetter: false, minDelta: 5000 },
};

const EVENTS = 6000;
const KINDS = ['chat.message', 'chat.message', 'chat.message', 'chat.message', 'alert.follow', 'alert.bits', 'system.connected'];
const ACTION_EVERY = 10; // every 10th chat message gets a keyed action (SYNTHETIC)
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const tick = () => new Promise((r) => setImmediate(r));
const hex = (s) => createHash('sha256').update(s).digest('hex');

function input(i) {
  const kind = KINDS[i % KINDS.length];
  if (kind === 'system.connected') return { kind, platform: 'local', source: 'system', target: `t${i % 5}` };
  return {
    kind, platform: 'twitch', source: 'mock', platformMessageId: `syn-${i}`,
    user: { platformUserId: `user-${i % 200}`, displayName: `Viewer${i % 200}`, roles: ['viewer'] },
    ...(kind === 'chat.message' ? { text: `synthetic message ${i}` } : kind === 'alert.bits' ? { amount: 100 } : {}),
  };
}

function counts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['audit', 'chat_raw', 'dedupe_keys', 'action_keys'].map((t) => [t, db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c]));
  } finally { db.close(); }
}

export async function run() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-full-bench-'));
  try {
    const core = createEventCore({ key: Buffer.alloc(32, 1), moderation: false, audit: { dataDir: path.join(dir, 'a'), purgeOnStart: false } });
    core.bus.subscribe({ name: 'sink', limit: EVENTS, handler: () => {} });
    await core.audit.ready;
    const times = new Float64Array(EVENTS);
    let chats = 0;
    for (let i = 0; i < EVENTS; i++) {
      const t0 = performance.now();
      const r = core.ingest(input(i));
      times[i] = performance.now() - t0;
      if (r.status !== 'published') throw new Error(`bench event ${i} ${r.status}`);
      if (KINDS[i % KINDS.length] === 'chat.message' && ++chats % ACTION_EVERY === 0) {
        const key = hex(`act-${i}`);
        core.audit.recordActionStart(key).then(() => core.audit.recordActionDone(key, undefined, 'ok'), () => {});
      }
      if (i % 50 === 49) await tick();
    }
    await tick();
    const st = await core.audit.flush();
    if (st.droppedA || st.droppedR || st.writeErrors) throw new Error('audit bench dropped or failed');
    const file = core.audit.file;
    await core.audit.close();
    const coreRows = counts(file);

    // Phase 2: full mix, store directly.
    const s = openStore({ file: path.join(dir, 'rate.db') });
    const B = 200; const TOTAL = 10000;
    const base = Date.now();
    const mk = (b) => {
      const audit = Array.from({ length: 29 }, (_, j) => ({ ts: '2026-10-28T00:00:00.000Z', type: 'system', subtype: 'system.connected', source: 'audit', verdict: 'ok', reason: 'bench', detail: `{"n":${b * B + j}}` }));
      const raw = Array.from({ length: 114 }, (_, j) => ({ event_id: `e${b}-${j}`, received_at: base + b * 1000 + j, platform: 'twitch', display_name: `Viewer${j}`, text: `synthetic message ${b}-${j}` }));
      const dedupe = Array.from({ length: 171 }, (_, j) => ({ key: hex(`d${b}-${j}`), seen_at: base + b * 1000 + j }));
      const actions = [];
      for (let j = 0; j < 11; j++) { const k = hex(`a${b}-${j}`); actions.push({ key: k, op: 'start', at: base + b * 1000 + j }, { key: k, op: 'done', at: base + b * 1000 + j, outcome: 'ok' }); }
      return { audit, raw, dedupe, actions };
    };
    const batches = Array.from({ length: TOTAL / B }, (_, b) => mk(b)); // built before timing
    const w = { audit: 0, raw: 0, dedupe: 0, actions: 0 };
    const t0 = performance.now();
    for (const x of batches) { const r = s.appendBatch(x.audit, x.raw, x.dedupe, x.actions); w.audit += r.audit; w.raw += r.raw; w.dedupe += r.dedupe; w.actions += r.actions; }
    const secs = (performance.now() - t0) / 1000;
    s.close();
    const rows = w.audit + w.raw + w.dedupe + w.actions;
    return {
      ingest_p95_ms: pct(Array.from(times), 0.95), block_p95_ms: st.blockMs.p95, rows_per_s: rows / secs, events_per_s: TOTAL / secs,
      info: { corePhase: { events: EVENTS, rows: coreRows, batches: st.batches }, storePhase: { events: TOTAL, batchEvents: B, rowsWritten: w, totalRows: rows } },
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
