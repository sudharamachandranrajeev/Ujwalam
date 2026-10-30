// SPDX-License-Identifier: GPL-2.0-or-later
// Writer-choice measurement for the audit (P3 E5): worker thread vs inline (batched setImmediate on the main thread),
// plus synchronous=FULL vs NORMAL write rate. NOT a regression bench (nothing here is recorded as a baseline); the
// numbers go into docs/evidence/2026-10-28-p3-e5-audit.md. SYNTHETIC events only (made-up ids, names and text).
// Usage: node tools/bench/audit-writer-compare.mjs [--events N] [--runs N]

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createEventCore } from '../../services/event-core/index.mjs';
import { openStore } from '../../services/event-core/audit/store.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const EVENTS = arg('events', 20000);
const RUNS = arg('runs', 3);
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const tick = () => new Promise((r) => setImmediate(r));
const KINDS = ['chat.message', 'chat.message', 'chat.message', 'chat.message', 'alert.follow', 'alert.bits', 'system.connected'];

function input(i) {
  const kind = KINDS[i % KINDS.length];
  if (kind === 'system.connected') return { kind, platform: 'local', source: 'system', target: `t${i % 5}` };
  return {
    kind, platform: 'twitch', source: 'mock', platformMessageId: `syn-${i}`,
    user: { platformUserId: `user-${i % 300}`, displayName: `Viewer${i % 300}`, roles: ['viewer'] },
    ...(kind === 'chat.message' ? { text: `synthetic message number ${i} for the audit bench` } : kind === 'alert.bits' ? { amount: 100 } : {}),
  };
}

async function one(mode) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-cmp-'));
  try {
    const core = createEventCore({ key: Buffer.alloc(32, 1), moderation: false, ...(mode === 'none' ? {} : { audit: { dataDir: dir, mode, purgeOnStart: false } }) });
    core.bus.subscribe({ name: 'sink', limit: EVENTS, handler: () => {} });
    if (core.audit) await core.audit.ready;
    const h = monitorEventLoopDelay({ resolution: 1 });
    const times = new Float64Array(EVENTS);
    h.enable();
    const t0 = performance.now();
    for (let i = 0; i < EVENTS; i++) {
      const a = performance.now();
      core.ingest(input(i));
      times[i] = performance.now() - a;
      if (i % 50 === 49) await tick();
    }
    const ingestMs = performance.now() - t0;
    h.disable();
    let st = null;
    let drainMs = 0;
    if (core.audit) { const d0 = performance.now(); await core.audit.flush(); drainMs = performance.now() - d0; st = core.audit.stats(); await core.audit.close(); }
    const t = Array.from(times);
    return {
      mode, ingest_p50_ms: pct(t, 0.5), ingest_p95_ms: pct(t, 0.95), ingest_p99_ms: pct(t, 0.99), ingest_max_ms: Math.max(...t),
      loop_p99_ms: h.percentile(99) / 1e6, loop_max_ms: h.max / 1e6,
      batch_block_p50_ms: st?.blockMs.p50 ?? 0, batch_block_p95_ms: st?.blockMs.p95 ?? 0, batch_block_max_ms: st?.blockMs.max ?? 0,
      batches: st?.batches ?? 0, rows: st ? st.writtenA + st.writtenR : 0, dropped: st ? st.droppedA + st.droppedR : 0, drain_ms: drainMs, ingest_total_ms: ingestMs,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function syncRate(synchronous) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-sync-'));
  try {
    const s = openStore({ file: path.join(dir, 'x.db'), synchronous });
    const row = (i) => ({ ts: '2026-10-28T00:00:00.000Z', type: 'decision', subtype: 'request', action_id: 'state.read', source: 'ui', verdict: 'allow', reason: 'read', detail: `{"n":${i}}` });
    const BATCH = 200;
    const N = 20000;
    const t0 = performance.now();
    const commits = [];
    for (let i = 0; i < N; i += BATCH) {
      const c0 = performance.now();
      s.appendBatch(Array.from({ length: BATCH }, (_, j) => row(i + j)), []);
      commits.push(performance.now() - c0);
    }
    const sec = (performance.now() - t0) / 1000;
    s.close();
    return { synchronous, rows_per_s: Math.round(N / sec), commit_p50_ms: pct(commits, 0.5), commit_p95_ms: pct(commits, 0.95) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const med = (xs) => pct(xs, 0.5);
const out = {};
for (const mode of ['none', 'inline', 'worker']) {
  const runs = [];
  await one(mode); // warm-up, discarded
  for (let r = 0; r < RUNS; r++) runs.push(await one(mode));
  out[mode] = Object.fromEntries(Object.keys(runs[0]).filter((k) => k !== 'mode').map((k) => [k, Math.round(med(runs.map((x) => x[k])) * 1000) / 1000]));
}
console.log(`events=${EVENTS} runs=${RUNS} (median of runs, warm-up discarded)`);
console.table(out);
const sync = [syncRate('FULL'), syncRate('NORMAL'), syncRate('FULL'), syncRate('NORMAL')];
console.table(sync);
