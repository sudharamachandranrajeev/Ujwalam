// SPDX-License-Identifier: GPL-2.0-or-later
// services/event-core/diag/stall-tracer.mjs: detects an injected stall, attributes it (CPU busy vs blocked off CPU),
// keeps the breadcrumbs around it, writes JSON lines asynchronously, and stays quiet on an idle loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStallTracer } from '../services/event-core/diag/stall-tracer.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-stall-')); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Spin until `ms` of process CPU time is used, not wall time: under CPU contention a wall-time spin is descheduled
// for most of its gap and is then correctly classed off-CPU, which is not the input this test means to inject.
const busy = (ms) => { const c0 = process.cpuUsage(); while ((process.cpuUsage(c0).user + process.cpuUsage(c0).system) / 1000 < ms) { /* spin */ } };
const blockOffCpu = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A stall gap starts when the tracer's next tick was due (last tick + tickMs). After `await sleep()` that tick can
// already be due (the sleep timer and the 25 ms interval expire in the same timers pass), so a mark made right
// then falls inside the gap, not before it. Wait until a tick has just run, so the next mark precedes the gap start.
const afterTick = async (t, timeoutMs = 2000) => {
  const n = t.summary().ticks; const t0 = performance.now();
  while (t.summary().ticks === n) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`stall tracer did not tick within ${timeoutMs} ms (ticks ${n})`);
    await new Promise((r) => setImmediate(r));
  }
};

test('stall tracer: a 400 ms busy loop and a 400 ms off-CPU wait are both caught, classed and written', async () => {
  const file = path.join(tmp(), 'stalls.jsonl');
  const t = createStallTracer({ file, label: 'test', thresholdMs: 200, flushMs: 100, context: () => ({ probe: 1 }) });
  await sleep(150);
  await afterTick(t);
  t.mark('busy:start'); busy(400); t.mark('busy:end');
  await sleep(150);
  await afterTick(t);
  t.mark('wait:start'); blockOffCpu(400); t.mark('wait:end');
  await sleep(800); // past the 500 ms completion delay, then one flush
  const s = await t.stop();
  assert.equal(s.stalls, 2, JSON.stringify(s));
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const stalls = rows.filter((r) => r.kind === 'stall');
  assert.equal(stalls.length, 2);
  const [b, w] = stalls;
  assert.ok(b.ms >= 300 && w.ms >= 300, `${b.ms} ${w.ms}`);
  assert.equal(b.cls, 'main-thread-busy');
  assert.ok(b.cpuMs >= 200, `busy cpu ${b.cpuMs}`);
  assert.equal(w.cls, 'blocked-off-cpu', JSON.stringify(w));
  assert.ok(w.cpuMs < 100, `wait cpu ${w.cpuMs}`);
  assert.equal(w.watchdog.late, false, 'the watchdog thread kept running while the main thread waited');
  assert.ok(b.marks.lastBefore, `busy stall has no mark before its gap: ${JSON.stringify(b.marks)}`);
  assert.equal(b.marks.lastBefore.label, 'busy:start');
  assert.deepEqual(b.marks.during.map((m) => m.label), ['busy:end']);
  assert.deepEqual(b.context, { probe: 1 });
  assert.ok(typeof b.wallIso === 'string' && Number.isFinite(b.monoStart) && b.resources && 'gc' in b);
  assert.equal(rows.at(-1).kind, 'summary');
});

test('stall tracer: an idle loop records no stall; the summary still counts ticks', async () => {
  const t = createStallTracer({ thresholdMs: 200, flushMs: 50 });
  await sleep(300);
  const s = await t.stop();
  assert.equal(s.stalls, 0);
  assert.ok(s.ticks >= 5, `ticks ${s.ticks}`);
  assert.ok(s.maxLateMs < 200);
});
