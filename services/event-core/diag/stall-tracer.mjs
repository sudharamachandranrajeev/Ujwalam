// SPDX-License-Identifier: GPL-3.0-or-later
// Event-loop stall tracer (P3 E7 follow-up). Node stdlib only.
//
//   const t = createStallTracer({ file, label: 'core-child', thresholdMs: 200, context: () => ({ ... }) });
//   t.mark('sample:start');     // breadcrumb: a short label and the mono time, nothing else (never data)
//   const summary = await t.stop();
//
// How it works. An interval timer (tickMs, default 25 ms) measures how late it fires. A tick that is more than
// thresholdMs late is a stall: the event loop could not run for that long. For each stall one JSON line records:
//   wall and mono time of the gap, its length, the process CPU time used during the gap (user + system, all threads),
//   page faults during the gap, the breadcrumbs around it (what the main thread was doing), GC entries that overlap
//   it (PerformanceObserver 'gc': start, duration, kind), active handle counts (process.getActiveResourcesInfo),
//   a caller context snapshot (e.g. the audit writer's last write and its duration), and whether a watchdog thread
//   (a tiny worker with its own timer) was late at the same time.
// The fields split the causes (heuristic class in `cls`):
//   'gc'                     GC entries cover at least half of the gap
//   'main-thread-busy'       process CPU during the gap is at least half of the gap (JS or a sync call using CPU)
//   'process-not-scheduled'  little CPU, and the watchdog thread was late too (the whole process did not run: host)
//   'blocked-off-cpu'        little CPU, watchdog on time (main thread waiting in a sync call: disk, lock, AV scan)
// Every windowMs (default 60 s) one 'window' line holds the largest lateness and tick counts, so quiet periods are
// visible too.
//
// Cost on the main thread: one timer, process.cpuUsage() and process.resourceUsage() per tick (microseconds). Lines
// are buffered and written with fs.promises.appendFile (libuv thread pool); the tracer never writes synchronously.
// A stall line is completed (GC and watchdog entries attached) on a later flush, because both arrive asynchronously.
//
// Live service options (2026-10-28; services/event-core/api/service.mjs turns them on):
//   stallsOnly: true   write stall lines only (no 'window' or 'summary' lines); summary() still has the counts
//   maxBytes: N        bounded file: before an append would take the file past N bytes it is renamed to <file>.1
//                      (replacing an older <file>.1) and a new file starts, so disk use stays under about 2 x N.
//                      A single line longer than N is dropped and counted. The size is read once with
//                      fs.promises.stat and then counted; rotation uses fs.promises.rename. Nothing is synchronous.
//   maxBuffered: N     at most N lines wait in memory for the writer (default 1000); older ones are dropped and counted.
// Records hold numbers, mark labels from code, handle type names and the caller's context; never event data.

import { appendFile, rename, stat } from 'node:fs/promises';
import { PerformanceObserver, constants as perfConstants, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

const GC_KINDS = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};
const MARKS = 64;
const GC_RING = 256;
const WD_RING = 256;
const BUCKETS = [50, 100, 200, 1000, 5000];

// The watchdog: its own timer in its own thread. It reports only when it is late itself (absolute high-res time).
const WATCHDOG_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const tick = workerData.tickMs; const th = workerData.reportMs;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const late = now - last - tick;
  if (late > th) parentPort.postMessage({ startAbs: performance.timeOrigin + last + tick, ms: late });
  last = now;
}, tick);
`;

const r1 = (x) => Math.round(x * 10) / 10;

/** opts: { file?, label?, thresholdMs?, tickMs?, flushMs?, windowMs?, watchdog? (default true), context?(),
 *          stallsOnly? (default false), maxBytes? (default unbounded), maxBuffered? (default 1000) } */
export function createStallTracer(opts = {}) {
  const thresholdMs = opts.thresholdMs ?? 200;
  const tickMs = opts.tickMs ?? 25;
  const flushMs = opts.flushMs ?? 2000;
  const windowMs = opts.windowMs ?? 60_000;
  const label = String(opts.label ?? 'main').slice(0, 32);
  const file = opts.file ?? null;
  const stallsOnly = opts.stallsOnly === true;
  const maxBytes = Number.isSafeInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : null;
  const maxBuffered = Number.isSafeInteger(opts.maxBuffered) && opts.maxBuffered > 0 ? opts.maxBuffered : 1000;
  const origin = performance.timeOrigin;

  // breadcrumbs: fixed ring, label + mono time
  const mLabel = new Array(MARKS).fill(null);
  const mMono = new Float64Array(MARKS);
  let mIdx = -1;
  const mark = (l) => { mIdx = (mIdx + 1) % MARKS; mLabel[mIdx] = l; mMono[mIdx] = performance.now(); };
  const marksBetween = (a, b) => {
    const out = [];
    let before = null;
    for (let i = 0; i < MARKS; i++) {
      const j = (mIdx - i + MARKS) % MARKS;
      if (mLabel[j] === null) break;
      const t = mMono[j];
      if (t >= a && t <= b) out.push({ label: mLabel[j], atMs: r1(t - a) });
      else if (t < a) { before = { label: mLabel[j], agoMs: r1(a - t) }; break; }
    }
    return { lastBefore: before, during: out.reverse() };
  };

  // GC entries
  const gcs = [];
  let gcTotal = 0; let gcMax = 0; let gcCount = 0;
  let obs = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gcCount++; gcTotal += e.duration; if (e.duration > gcMax) gcMax = e.duration;
        gcs.push({ start: e.startTime, ms: e.duration, kind: GC_KINDS[e.detail?.kind ?? e.kind] ?? 'other' });
        if (gcs.length > GC_RING) gcs.shift();
      }
    });
    obs.observe({ entryTypes: ['gc'] });
  } catch { obs = null; }

  // watchdog thread
  const wd = [];
  let wdWorker = null;
  if (opts.watchdog !== false) {
    try {
      wdWorker = new Worker(WATCHDOG_SRC, { eval: true, workerData: { tickMs, reportMs: Math.max(50, thresholdMs / 2) } });
      wdWorker.on('message', (m) => { wd.push(m); if (wd.length > WD_RING) wd.shift(); });
      wdWorker.on('error', () => { wdWorker = null; });
      wdWorker.unref();
    } catch { wdWorker = null; }
  }

  const counts = { ticks: 0, stalls: 0, maxLateMs: 0, buckets: Object.fromEntries(BUCKETS.map((b) => [`over${b}`, 0])), byClass: {}, lines: 0, writeErrors: 0, rotations: 0, droppedLines: 0 };
  let win = { from: Date.now(), ticks: 0, maxLateMs: 0, over50: 0, over100: 0, over200: 0 };
  const pending = []; // stalls waiting for GC / watchdog entries
  const buf = [];
  let writing = null;
  let size = null; // bytes in the current file: read once with stat, then counted
  const push = (line) => {
    buf.push(line);
    if (buf.length > maxBuffered) counts.droppedLines += buf.splice(0, buf.length - maxBuffered).length;
  };
  const lineBytes = (l) => Buffer.byteLength(l) + 1;
  // One append, rotating first when the file would pass maxBytes. Async only.
  async function write(lines) {
    if (!maxBytes) { await appendFile(file, `${lines.join('\n')}\n`); counts.lines += lines.length; return; }
    if (size === null) size = await stat(file).then((st) => st.size, () => 0);
    let keep = lines.filter((l) => lineBytes(l) <= maxBytes);
    counts.droppedLines += lines.length - keep.length;
    let bytes = keep.reduce((a, l) => a + lineBytes(l), 0);
    while (bytes > maxBytes) { bytes -= lineBytes(keep[0]); keep = keep.slice(1); counts.droppedLines++; } // newest win
    if (!keep.length) return;
    if (size > 0 && size + bytes > maxBytes) {
      await rename(file, `${file}.1`).then(() => { counts.rotations++; }, () => { counts.writeErrors++; });
      size = 0;
    }
    await appendFile(file, `${keep.join('\n')}\n`);
    size += bytes; counts.lines += keep.length;
  }

  const ctxSnap = () => { try { return opts.context ? opts.context() : undefined; } catch { return { error: 'context-failed' }; } };
  const resources = () => {
    try {
      const c = {};
      for (const r of process.getActiveResourcesInfo()) c[r] = (c[r] ?? 0) + 1;
      return c;
    } catch { return null; }
  };

  let lastMono = performance.now();
  let lastCpu = process.cpuUsage();
  let lastRu = process.resourceUsage();
  let lastWin = lastMono;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = Math.max(0, now - lastMono - tickMs);
    counts.ticks++; win.ticks++;
    if (late > counts.maxLateMs) counts.maxLateMs = late;
    if (late > win.maxLateMs) win.maxLateMs = late;
    if (late > 50) win.over50++;
    if (late > 100) win.over100++;
    if (late > 200) win.over200++;
    for (const b of BUCKETS) if (late > b) counts.buckets[`over${b}`]++;
    if (late > thresholdMs) {
      const cpu = process.cpuUsage(lastCpu);
      const ru = process.resourceUsage();
      const start = lastMono + tickMs;
      pending.push({
        detectedAt: now,
        row: {
          kind: 'stall', label, wall: Math.round(origin + start), wallIso: new Date(origin + start).toISOString(),
          monoStart: r1(start), monoEnd: r1(now), ms: r1(late),
          cpuMs: r1((cpu.user + cpu.system) / 1000), pageFaults: ru.majorPageFault - lastRu.majorPageFault,
          fsReads: ru.fsRead - lastRu.fsRead, fsWrites: ru.fsWrite - lastRu.fsWrite,
          marks: marksBetween(start, now), resources: resources(), context: ctxSnap(),
          heapUsedMB: r1(process.memoryUsage().heapUsed / 1048576),
        },
      });
    }
    if (now - lastWin >= windowMs) {
      if (!stallsOnly) push(JSON.stringify({ kind: 'window', label, wall: Date.now(), fromWall: win.from, ticks: win.ticks, maxLateMs: r1(win.maxLateMs), over50: win.over50, over100: win.over100, over200: win.over200 }));
      win = { from: Date.now(), ticks: 0, maxLateMs: 0, over50: 0, over100: 0, over200: 0 };
      lastWin = now;
    }
    lastMono = now;
    lastCpu = process.cpuUsage();
    lastRu = process.resourceUsage();
  }, tickMs);
  timer.unref?.();

  function finalize(force) {
    const now = performance.now();
    while (pending.length && (force || now - pending[0].detectedAt > 500)) {
      const { row } = pending.shift();
      const a = row.monoStart; const b = row.monoEnd;
      const g = gcs.filter((e) => e.start < b && e.start + e.ms > a - 1);
      row.gc = { n: g.length, ms: r1(g.reduce((x, e) => x + e.ms, 0)), entries: g.slice(0, 8).map((e) => ({ atMs: r1(e.start - a), ms: r1(e.ms), kind: e.kind })) };
      const absA = origin + a; const absB = origin + b;
      const w = wd.filter((e) => e.startAbs < absB && e.startAbs + e.ms > absA);
      row.watchdog = wdWorker || w.length ? { late: w.length > 0, maxLateMs: r1(Math.max(0, ...w.map((e) => e.ms))) } : { late: null, reason: 'no-watchdog' };
      row.cls = row.gc.ms >= row.ms / 2 ? 'gc'
        : row.cpuMs >= row.ms / 2 ? 'main-thread-busy'
          : row.watchdog.late ? 'process-not-scheduled' : 'blocked-off-cpu';
      counts.stalls++;
      counts.byClass[row.cls] = (counts.byClass[row.cls] ?? 0) + 1;
      push(JSON.stringify(row));
    }
  }

  function flush(force = false) {
    finalize(force);
    if (!file || writing || !buf.length) return writing ?? Promise.resolve();
    const lines = buf.splice(0, buf.length);
    writing = write(lines).catch(() => { counts.writeErrors++; }).finally(() => { writing = null; });
    return writing;
  }
  const flusher = setInterval(() => { flush(); }, flushMs);
  flusher.unref?.();

  function summary() {
    return {
      label, thresholdMs, tickMs, ticks: counts.ticks, stalls: counts.stalls, pendingStalls: pending.length, maxLateMs: r1(counts.maxLateMs),
      buckets: { ...counts.buckets }, byClass: { ...counts.byClass },
      gc: { n: gcCount, totalMs: r1(gcTotal), maxMs: r1(gcMax) }, watchdog: wdWorker ? 'on' : 'off',
      lines: counts.lines, writeErrors: counts.writeErrors, rotations: counts.rotations, droppedLines: counts.droppedLines,
      ...(maxBytes ? { maxBytes } : {}),
    };
  }

  let stopped = false;
  async function stop() {
    if (stopped) return summary();
    stopped = true;
    clearInterval(timer);
    clearInterval(flusher);
    await new Promise((r) => setTimeout(r, 50)); // let the last GC / watchdog messages arrive
    if (writing) await writing;
    finalize(true);
    if (!stallsOnly) push(JSON.stringify({ kind: 'summary', wall: Date.now(), ...summary() }));
    if (file && buf.length) await write(buf.splice(0, buf.length)).catch(() => { counts.writeErrors++; });
    try { obs?.disconnect(); } catch { /* gone */ }
    if (wdWorker) { try { await wdWorker.terminate(); } catch { /* gone */ } }
    return summary();
  }

  return { mark, flush, stop, summary };
}
