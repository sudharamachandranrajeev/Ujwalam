// SPDX-License-Identifier: GPL-3.0-or-later
// Shared noisy-machine rules for the bench harness (tools/bench/run.mjs) and the soak system probe
// (tools/soak/system-probe.mjs). One place, so both agree. Node stdlib only; everything is read-only.
//
// A run or sample is noisy when
//   - the machine is on battery power, or
//   - system-wide CPU load is above a limit (before start, or during the run), or
//   - a known heavy background process (tools/bench/noisy-processes.json) is busy.
//
// CPU limits (percent of the whole machine, all logical cores):
//   before start 10 %, during the run 15 %.
//   Why: quiet runs on this machine (AC, nothing else open) measured 2 to 6 % before start and 9 to 11 % during
//   the run (the bench itself is most of that). Runs with Telegram, Discord, Defender or NVIDIA services busy
//   measured 11 to 23 % before and 20 to 29 % during. The old limits (25 / 50) let all of those count as quiet.
//   10 / 15 sit just above the quiet maximum. UNVERIFIED on other machines; recalibrate there.
import { spawnSync, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOISE = { cpuBeforePct: 10, cpuDuringPct: 15 };
export const NOISY_LIST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'noisy-processes.json');

export function cpuSnap() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const [k, v] of Object.entries(c.times)) { total += v; if (k === 'idle') idle += v; }
  }
  return { idle, total };
}
export function cpuPct(a, b) {
  const t = b.total - a.total;
  return t > 0 ? Math.round((1 - (b.idle - a.idle) / t) * 1000) / 10 : 0;
}

/** The known-heavy-process list (data). Returns { defaultMinCpuPct, groups[] }. */
export function loadNoisyList(file = NOISY_LIST_FILE) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(j.groups)) throw new Error(`${file}: "groups" must be an array`);
  return { defaultMinCpuPct: Number.isFinite(j.defaultMinCpuPct) ? j.defaultMinCpuPct : 2, groups: j.groups };
}

// ---- process CPU (read-only) ----
// Raw performance counters: cumulative processor time in 100 ns ticks plus a system timestamp per row.
// Works for protected processes (Get-Process cannot read MsMpEng's CPU without admin rights).
export const PROC_PS = 'Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property Name,PercentProcessorTime,Timestamp_Sys100NS | Where-Object { $_.Name -ne "_Total" } | ForEach-Object { "$($_.Name)|$($_.PercentProcessorTime)|$($_.Timestamp_Sys100NS)" }';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', PROC_PS];

/** Parses the PowerShell output into { ts, procs: { name: ticks } } (names without "#n" suffix, ticks summed). */
export function parseProcSnapshot(text) {
  const procs = {};
  let ts = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(.+)\|(\d+)\|(\d+)$/.exec(line.trim());
    if (!m || m[1] === 'Idle') continue;
    const name = m[1].replace(/#\d+$/, '');
    procs[name] = (procs[name] ?? 0) + Number(m[2]);
    ts = Math.max(ts, Number(m[3]));
  }
  return ts ? { ts, procs } : null;
}

/** Snapshot of per-process CPU time, or null (not Windows, no PowerShell, timeout). Blocks: use before/after a run. */
export function procSnapshotSync() {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell', PS_ARGS, { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1 << 24 });
  return r.status === 0 ? parseProcSnapshot(r.stdout) : null;
}
/** Same, asynchronous: never blocks the event loop (soak probe). */
export function procSnapshotAsync() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell', PS_ARGS, { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout) => resolve(err ? null : parseProcSnapshot(stdout)));
  });
}

/**
 * Known heavy processes between two snapshots. cpuPct is percent of the whole machine (all cores).
 * Returns [{ name, group, cpuPct, presenceOnly? }] for entries over their limit (or running, for flagOnPresence).
 * A null snapshot gives []. `list` and `cores` are test seams.
 */
export function heavyBetween(a, b, { list = loadNoisyList(), cores = os.cpus().length } = {}) {
  if (!a || !b || b.ts <= a.ts) return [];
  const dt = b.ts - a.ts;
  const byLower = new Map(Object.keys(b.procs).map((n) => [n.toLowerCase(), n]));
  const out = [];
  for (const g of list.groups) {
    const limit = Number.isFinite(g.minCpuPct) ? g.minCpuPct : list.defaultMinCpuPct;
    for (const want of g.names) {
      const name = byLower.get(String(want).toLowerCase());
      if (!name) continue;
      const pct = Math.round(((b.procs[name] - (a.procs[name] ?? 0)) / dt / cores) * 1000) / 10;
      if (g.flagOnPresence) out.push({ name, group: g.group, cpuPct: pct, presenceOnly: true });
      else if (pct > limit) out.push({ name, group: g.group, cpuPct: pct, limit });
    }
  }
  return out;
}

export function heavyReasons(heavy, when) {
  return (heavy ?? []).map((h) => (h.presenceOnly
    ? `${h.name} (${h.group}) is running ${when}`
    : `${h.name} (${h.group}) uses ${h.cpuPct} % CPU ${when} (limit ${h.limit} %)`));
}

/** Returns { noisy, reasons[] } for power state, CPU load figures and heavy processes. */
export function assessNoise({ power, cpuBeforePct, cpuDuringPct, heavyBefore = [], heavyDuring = [] }, th = NOISE) {
  const reasons = [];
  if (power === 'battery') reasons.push('on battery power');
  if (cpuBeforePct > th.cpuBeforePct) reasons.push(`background CPU load before start ${cpuBeforePct} % (limit ${th.cpuBeforePct} %)`);
  if (cpuDuringPct > th.cpuDuringPct) reasons.push(`system CPU load during the run ${cpuDuringPct} % (limit ${th.cpuDuringPct} %)`);
  reasons.push(...heavyReasons(heavyBefore, 'before start'));
  // A process already listed for "before start" is not repeated for the run.
  const seen = new Set((heavyBefore ?? []).map((h) => h.name));
  reasons.push(...heavyReasons((heavyDuring ?? []).filter((h) => !seen.has(h.name)), 'during the run'));
  return { noisy: reasons.length > 0, reasons };
}

/** Compact one-line form for CI output: "advisory (noisy: a; b)". */
export const advisoryLine = (reasons) => `advisory (noisy: ${reasons.join('; ')})`;
