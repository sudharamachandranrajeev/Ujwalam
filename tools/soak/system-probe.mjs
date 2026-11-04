// SPDX-License-Identifier: GPL-3.0-or-later
// Power (AC/battery) and system-wide CPU load capture for soak and crash runs (P3 E7). Node stdlib only.
// Uses the shared noise rules in tools/bench/noise.mjs (same as the bench harness): CPU limits (NOISE), battery, and the
// known heavy processes in tools/bench/noisy-processes.json. Process CPU is read at start and every powerEveryMs (async,
// read-only); a row carries the heavy processes found over the last interval.
//
//   const s = createSystemSampler({ file, everyMs: 10000, powerEveryMs: 300000 });
//   await s.start();     // power + 1 s idle measurement ("before"), first row written
//   ...run...
//   const summary = await s.stop();   // end row, summary
//
// Rows go to <file> (JSON lines): { t, wall, kind: 'start'|'tick'|'end', cpuPct, power, noisy, reasons[] }.
// A row is `noisy` when power is 'battery', cpuPct is above the limit for its kind (start: cpuBeforePct, others:
// cpuDuringPct), or `heavy` is not empty.
// Numbers only; nothing about the host name or user is recorded.
//
// Nothing here blocks the harness event loop: the power state is read with an asynchronous PowerShell call (the bench
// probe `powerState` uses spawnSync, which measured 318 to 401 ms per call on this machine and would stall the
// harness, delaying emits), and rows are appended asynchronously. A row carries the last power value read.

import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { NOISE, cpuPct, cpuSnap, heavyBetween, heavyReasons, procSnapshotAsync } from '../bench/noise.mjs';

const POWER_PS = '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { ($b | Select-Object -First 1).BatteryStatus } else { "none" }';

/** Same query and mapping as the bench `powerState`, but asynchronous. Resolves 'ac' | 'ac (no battery)' | 'battery' | 'unknown'. */
export function powerStateAsync() {
  if (process.platform !== 'win32') return Promise.resolve('unknown');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', POWER_PS], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
      const v = String(stdout ?? '').trim();
      if (v === 'none') resolve('ac (no battery)');
      else if (v === '1') resolve('battery');
      else if (/^\d+$/.test(v)) resolve('ac');
      else resolve('unknown');
    });
  });
}

/** Noise verdict for one sample. */
export function assessSample({ kind, cpuPct: pct, power, heavy = [] }, th = NOISE) {
  const reasons = [];
  if (power === 'battery') reasons.push('on battery power');
  const limit = kind === 'start' ? th.cpuBeforePct : th.cpuDuringPct;
  if (pct > limit) reasons.push(`system CPU ${pct} % (limit ${limit} %)`);
  reasons.push(...heavyReasons(heavy, 'in the last interval'));
  return { noisy: reasons.length > 0, reasons };
}

/** Run-level summary from the sample rows. */
export function summariseSystem(rows) {
  if (!rows.length) return { samples: 0, status: 'NOT RECORDED' };
  const cpu = rows.map((r) => r.cpuPct);
  const noisy = rows.filter((r) => r.noisy);
  const powers = [...new Set(rows.map((r) => r.power))];
  return {
    samples: rows.length,
    powerStart: rows[0].power,
    powerEnd: rows[rows.length - 1].power,
    powerStates: powers,
    cpuBeforePct: rows[0].cpuPct,
    cpuPctMean: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1),
    cpuPctMax: Math.max(...cpu),
    noisySamples: noisy.length,
    noisyFraction: +(noisy.length / rows.length).toFixed(3),
    noisy: noisy.length > 0,
    noisyAtS: noisy.slice(0, 20).map((r) => r.t),
    heavyProcesses: [...new Set(rows.flatMap((r) => (r.heavy ?? []).map((h) => h.name)))],
    reasons: [...new Set(noisy.flatMap((r) => r.reasons ?? []))].slice(0, 10),
    status: noisy.length ? 'NOISY' : 'QUIET',
  };
}

/** probes (test seam): { power(): string | Promise<string>, cpuSnap(), cpuPct(a, b), idleMs }; power defaults to
 *  powerStateAsync, the others to the bench probes. mark(label): optional stall-tracer breadcrumb. */
export function createSystemSampler({ file, everyMs = 10000, powerEveryMs = 300000, probes = {}, mark = () => {} }) {
  const procSnap = probes.procSnapshot ?? procSnapshotAsync;
  const power = probes.power ?? powerStateAsync;
  const snap = probes.cpuSnap ?? cpuSnap;
  const pctOf = probes.cpuPct ?? cpuPct;
  const idleMs = probes.idleMs ?? 1000;
  const rows = [];
  let timer = null; let last = null; let lastPower = 'unknown'; let lastPowerAt = 0; let t0 = 0;
  let writes = Promise.resolve(); // rows are appended in order, off the event loop
  let powerRead = null;           // at most one power read in flight
  let prevSnap = null; let lastHeavy = [];
  // Known heavy processes over the interval since the previous snapshot (read-only, asynchronous, never throws).
  const procUpdate = async () => {
    try {
      const sn = await procSnap();
      if (sn) { lastHeavy = heavyBetween(prevSnap, sn, { ...(probes.heavyList ? { list: probes.heavyList } : {}), ...(probes.cores ? { cores: probes.cores } : {}) }); prevSnap = sn; }
    } catch { /* no process data: not noisy */ }
  };
  const readPower = () => {
    if (!powerRead) {
      mark('power:start');
      lastPowerAt = Date.now();
      powerRead = Promise.resolve().then(power).then((v) => { lastPower = v; }, () => { lastPower = 'unknown'; }).then(procUpdate).finally(() => { powerRead = null; mark('power:end'); });
    }
    return powerRead;
  };
  const push = (kind, pct) => {
    const row = { t: Math.round((Date.now() - t0) / 1000), wall: Date.now(), kind, cpuPct: pct, power: lastPower, heavy: lastHeavy };
    Object.assign(row, assessSample(row));
    rows.push(row);
    if (file) { const line = `${JSON.stringify(row)}\n`; writes = writes.then(() => appendFile(file, line)).catch(() => {}); }
    return row;
  };
  const tick = (kind) => {
    mark('sys:tick');
    const now = snap();
    const pct = pctOf(last, now);
    last = now;
    if (Date.now() - lastPowerAt >= powerEveryMs) readPower(); // the row carries the last value; the new one lands later
    return push(kind, pct);
  };
  return {
    rows,
    async start() {
      t0 = Date.now();
      await readPower();
      last = snap();
      await new Promise((r) => setTimeout(r, idleMs));
      await procUpdate(); // heavy processes over the idle window

      tick('start');
      timer = setInterval(() => tick('tick'), everyMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (last) {
        if (powerRead) await powerRead;
        await readPower(); // the end row always carries a fresh power reading
        tick('end');
      }
      await writes;
      return summariseSystem(rows);
    },
  };
}
