// SPDX-License-Identifier: GPL-3.0-or-later
// Bench: cost of the event-loop stall tracer (services/event-core/diag/stall-tracer.mjs, P3 E7). SYNTHETIC input.
// Same process, tracer ON (25 ms tick, watchdog worker on, file in a temp dir) against tracer OFF:
//  - ingest p50/p95 per event, measured in alternating chunks (off, on, off, on, ...) so drift cancels; the metrics
//    are the ON values and the ON-minus-OFF deltas (a delta near 0 or slightly negative means no measurable cost);
//  - main-thread busy time per minute while idle: performance.eventLoopUtilization() active ms over an idle window
//    with the tracer on, minus the same window with it off, scaled to one minute (high resolution, so stable);
//  - process CPU (user + system, all threads incl. the watchdog worker) for the same windows, reported in `info` only:
//    Windows reports it in about 15 ms steps, too coarse for a metric.
// Budget PB-17 (docs/architecture/performance-budgets.md): ingest p95 delta <= 0.02 ms, idle busy <= 300 ms/min. UNVERIFIED until a quiet run.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventCore } from '../../../services/event-core/index.mjs';
import { createStallTracer } from '../../../services/event-core/diag/stall-tracer.mjs';

export const id = 'stall-tracer-overhead';
export const budget = 'PB-17';
export const metrics = {
  ingest_p50_on_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.005 },
  ingest_p95_on_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.01 },
  ingest_p50_delta_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.005 },
  ingest_p95_delta_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.01 },
  idle_main_busy_ms_per_min: { unit: 'ms/min', lowerIsBetter: true, minDelta: 3 },
};

const CHUNKS = 8;       // 4 off + 4 on, alternating
const PER_CHUNK = 1500;
const IDLE_MS = 4000;
const KIND_MIX = ['chat.message', 'chat.message', 'chat.message', 'chat.message', 'alert.follow', 'alert.bits', 'alert.sub', 'alert.raid'];
const EXTRA = { 'chat.message': { text: 'synthetic message text for the bench' }, 'alert.follow': {}, 'alert.bits': { amount: 100 }, 'alert.sub': { tier: '1000' }, 'alert.raid': { viewers: 10 } };
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = (a, b) => ((b.user - a.user) + (b.system - a.system)) / 1000;

async function idleCpu(ms) {
  await sleep(200); // settle
  const a = process.cpuUsage();
  const e0 = performance.eventLoopUtilization();
  await sleep(ms);
  const e = performance.eventLoopUtilization(e0);
  return { cpu: cpuMs(a, process.cpuUsage()), busy: e.active };
}

export async function run() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tracer-bench-'));
  try {
    const total = CHUNKS * PER_CHUNK;
    const core = createEventCore({ key: Buffer.alloc(32, 1) });
    core.bus.subscribe({ name: 'a', limit: total, handler: () => {} });
    const inputs = Array.from({ length: total }, (_, i) => {
      const kind = KIND_MIX[i % KIND_MIX.length];
      return { kind, platform: 'twitch', source: 'mock', platformMessageId: `syn-${i}`, user: { platformUserId: `user-${i % 200}`, displayName: `Viewer${i % 200}`, roles: ['viewer'] }, ...EXTRA[kind] };
    });
    const off = []; const on = [];
    let tracer = null;
    let n = 0;
    for (let c = 0; c < CHUNKS; c++) {
      const isOn = c % 2 === 1;
      if (isOn) tracer = createStallTracer({ file: path.join(dir, 'stalls.jsonl'), label: 'bench', thresholdMs: 200, windowMs: 60_000 });
      await sleep(60); // let timers (and the watchdog worker) start
      for (let i = 0; i < PER_CHUNK; i++, n++) {
        const t0 = performance.now();
        const r = core.ingest(inputs[n]);
        (isOn ? on : off).push(performance.now() - t0);
        if (r.status !== 'published') throw new Error(`bench event ${n} ${r.status}`);
        if (i % 50 === 49) await tick();
      }
      if (isOn) { await tracer.stop(); tracer = null; }
    }
    // Idle CPU, off then on, then off again; the average of the two off windows is the reference.
    const off1 = await idleCpu(IDLE_MS);
    const t = createStallTracer({ file: path.join(dir, 'idle.jsonl'), label: 'bench-idle', thresholdMs: 200, windowMs: 60_000 });
    const withTracer = await idleCpu(IDLE_MS);
    await t.stop();
    const off2 = await idleCpu(IDLE_MS);
    const perMin = 60_000 / IDLE_MS;
    const idle_main_busy_ms_per_min = (withTracer.busy - (off1.busy + off2.busy) / 2) * perMin;
    const p50on = pct(on, 0.5); const p95on = pct(on, 0.95);
    return {
      ingest_p50_on_ms: p50on, ingest_p95_on_ms: p95on,
      ingest_p50_delta_ms: p50on - pct(off, 0.5), ingest_p95_delta_ms: p95on - pct(off, 0.95),
      idle_main_busy_ms_per_min,
      info: { eventsPerChunk: PER_CHUNK, chunks: CHUNKS, idleWindowMs: IDLE_MS, offP50: pct(off, 0.5), offP95: pct(off, 0.95), idleWindows: { off1, withTracer, off2 }, idleCpuMsPerMinCoarse: ((withTracer.cpu - (off1.cpu + off2.cpu) / 2) * perMin), tickMs: 25, watchdog: true },
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
