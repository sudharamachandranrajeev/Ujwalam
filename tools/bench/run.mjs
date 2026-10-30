// SPDX-License-Identifier: GPL-2.0-or-later
// Benchmark harness (P3 E0). Stdlib only.
// Usage: node tools/bench/run.mjs [--runs N] [--warmup N] [--only id,id] [--benches dir] [--out dir]
//        node tools/bench/run.mjs --accept "<reason>"      (user-approved baseline change only)
//
// A bench module exports { id, budget (budget id from docs/architecture/performance-budgets.md or null),
// metrics: { name: { unit, lowerIsBetter, minDelta? } }, run() -> { name: number } }.
// Each bench runs in its own fresh child process (no shared heap or module state): `warmup` times (discarded) then `runs` times; the median per metric is kept.
// Results go to <out>/runs/<iso-time>-<sha>-<dirty|clean>.json and are compared with
// <out>/last-pass.json. A metric more than 10 % worse is a regression: exit 1, baseline kept.
// Baselines are NEVER written automatically (not on a first run, not on a pass). Only --accept writes them.
// A bench with no baseline is reported as "no baseline (needs --accept)" and does not fail.
// minDelta (optional, absolute, in the metric's unit) stops tiny absolute changes from flagging.
// <out> defaults to out/bench (gitignored) or UJWALAM_BENCH_OUT.
//
// Calibration: `--calibrate` runs each bench 10 times (after warm-up), computes mean and standard
// deviation per metric and stores minDelta = 3 x stddev in <out>/calibration.json. The harness reads
// it; the minDelta in the bench module is only the fallback when no calibration exists.
//
// Noisy runs: every run records power state, system-wide CPU load (before start, and the average over
// the run) and known heavy processes (noisy-processes.json). Rules and limits are in noise.mjs (shared
// with the soak system probe). A noisy run is ADVISORY: regressions are reported, exit 0, it never
// becomes the baseline, cannot be accepted, and calibration refuses to run. Only QUIET runs fail CI.
//
// A bench may return an extra `info` object (row counts, file counts): it is stored in the run file and
// in last-pass.json, never compared.

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOISE, assessNoise, cpuPct, cpuSnap, heavyBetween, procSnapshotSync, advisoryLine } from './noise.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const THRESHOLD = 0.10;
// Noise rules (CPU limits, heavy-process list, battery) live in ./noise.mjs, shared with the soak system probe.
export { NOISE, cpuSnap, cpuPct, assessNoise };
export const CALIBRATION_RUNS = 10;
export const CALIBRATION_SIGMAS = 3;

/** Real probes; tests inject their own through opts.probes (heavy-process probes then default to "none"). */
function defaultProbes() {
  let heavyBefore = [];
  let heavyWin = [];
  return {
    power: () => powerState(),
    async cpuBefore() {
      const pa = procSnapshotSync();
      const a = cpuSnap();
      await new Promise((r) => setTimeout(r, 1000));
      const pct = cpuPct(a, cpuSnap());
      heavyBefore = heavyBetween(pa, procSnapshotSync());
      return pct;
    },
    heavyBefore: () => heavyBefore,
    cpuWindow() {
      const a = cpuSnap();
      const pa = procSnapshotSync();
      return { stop: () => { const pct = cpuPct(a, cpuSnap()); heavyWin = heavyBetween(pa, procSnapshotSync()); return pct; } };
    },
    heavyWindow: () => heavyWin,
  };
}
const NO_HEAVY = { heavyBefore: () => [], heavyWindow: () => [] };
const withProbes = (injected) => (injected ? { ...defaultProbes(), ...NO_HEAVY, ...injected } : defaultProbes());

/** Fixed probes from { power, cpuBeforePct, cpuDuringPct, heavyBefore?, heavyDuring? }. Test seam: env UJWALAM_BENCH_FAKE_NOISE holds the JSON. */
export function fakeProbes(f) {
  return {
    power: () => f.power, cpuBefore: async () => f.cpuBeforePct, cpuWindow: () => ({ stop: () => f.cpuDuringPct }),
    heavyBefore: () => f.heavyBefore ?? [], heavyWindow: () => f.heavyDuring ?? [],
  };
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function outDirFor(opts = {}) {
  return path.resolve(opts.out ?? process.env.UJWALAM_BENCH_OUT ?? path.join(REPO, 'out', 'bench'));
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function gitState(root = REPO) {
  const sha = sh('git', ['rev-parse', '--short=12', 'HEAD'], root);
  if (!sha) return { sha: 'nogit', dirty: true };
  const status = sh('git', ['status', '--porcelain'], root);
  return { sha, dirty: status === null ? true : status.length > 0 };
}

export function powerState() {
  if (process.platform !== 'win32') return 'unknown';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { ($b | Select-Object -First 1).BatteryStatus } else { "none" }'],
  { encoding: 'utf8', timeout: 15000 });
  const v = (r.stdout ?? '').trim();
  if (v === 'none') return 'ac (no battery)';
  if (v === '1') return 'battery';
  if (/^\d+$/.test(v)) return 'ac';
  return 'unknown';
}

// CPU model, logical cores, RAM, OS version, node/python version, AC/battery. No host or user name.
export function machineInfo(power = powerState()) {
  const py = spawnSync('python', ['-I', '-V'], { encoding: 'utf8' });
  return {
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    logicalCores: os.cpus().length,
    totalRamGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    os: `${os.type()} ${os.release()} (${os.version()})`,
    node: process.version,
    python: py.status === 0 ? py.stdout.trim().replace(/^Python /, '') : 'unavailable',
    power,
  };
}

export async function loadBenches(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    if (!m.id || typeof m.run !== 'function' || !m.metrics) throw new Error(`bad bench module: ${f}`);
    out.push({ id: m.id, budget: m.budget ?? null, metrics: m.metrics, run: m.run, file: f, path: path.join(dir, f) });
  }
  return out;
}

const minDeltaOf = (cal, id, name, def) => cal?.benches?.[id]?.[name]?.minDelta ?? def.minDelta ?? 0;
// User-approved rule (2026-10-30): a metric in 'ms' never regresses by less than 0.1 ms absolute, whatever its %.
export const ABS_FLOOR_MS = 0.1;
// User-approved rule (2026-10-30, v1 addendum "benchmarks are advisory until day 9"): before this date a
// regression on a quiet machine is reported as advisory (exit 0); from this date (local time) it fails again.
export const ENFORCE_FROM = '2026-11-06';
// UJWALAM_BENCH_NOW (YYYY-MM-DD) sets the clock for tests of both sides of the window.
export function inAdvisoryWindow(now = process.env.UJWALAM_BENCH_NOW ? new Date(`${process.env.UJWALAM_BENCH_NOW}T12:00:00`) : new Date()) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return d < ENFORCE_FROM;
}

/** Compare medians with a baseline's. Returns [{bench, metric, base, now, change, unit}]. */
export function compare(benches, results, baseline, threshold = THRESHOLD, calibration = null) {
  const regs = [];
  for (const b of benches) {
    for (const [name, def] of Object.entries(b.metrics)) {
      const base = baseline?.results?.[b.id]?.[name];
      const now = results[b.id]?.[name];
      if (typeof base !== 'number' || typeof now !== 'number') continue;
      const lower = def.lowerIsBetter !== false;
      const worse = lower ? now - base : base - now;
      if (worse <= minDeltaOf(calibration, b.id, name, def)) continue;
      if (def.unit === 'ms' && worse <= ABS_FLOOR_MS) continue;
      const limit = Math.abs(base) * threshold;
      if (worse > limit) {
        regs.push({ bench: b.id, metric: name, unit: def.unit, base, now, change: base === 0 ? Infinity : worse / Math.abs(base) });
      }
    }
  }
  return regs;
}

const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);

export async function runHarness(opts = {}) {
  const out = outDirFor(opts);
  const runs = opts.runs ?? 5;
  const warmup = opts.warmup ?? 1;
  const benchesDir = path.resolve(opts.benches ?? path.join(REPO, 'tools', 'bench', 'benches'));
  const log = opts.log ?? (() => {});
  let benches = await loadBenches(benchesDir);
  if (opts.only) benches = benches.filter((b) => opts.only.includes(b.id));
  if (!benches.length) throw new Error('no benches selected');

  const probes = withProbes(opts.probes);
  const power = await probes.power();
  const cpuBeforePct = await probes.cpuBefore();
  const heavyBefore = probes.heavyBefore();
  const win = probes.cpuWindow();
  const all = measure(benches, runs, warmup);
  const cpuDuringPct = win.stop();
  const heavyDuring = probes.heavyWindow();
  const noise = assessNoise({ power, cpuBeforePct, cpuDuringPct, heavyBefore, heavyDuring }, opts.noiseThresholds);

  const results = {};
  const detail = {};
  const infoAll = {};
  for (const b of benches) {
    const samples = all[b.id].samples;
    results[b.id] = {};
    detail[b.id] = { budget: b.budget, metrics: {} };
    if (all[b.id].info) { detail[b.id].info = all[b.id].info; infoAll[b.id] = all[b.id].info; }
    for (const [name, def] of Object.entries(b.metrics)) {
      const med = median(samples[name]);
      results[b.id][name] = med;
      detail[b.id].metrics[name] = { unit: def.unit, lowerIsBetter: def.lowerIsBetter !== false, median: med, samples: samples[name] };
    }
  }

  const lastPassFile = path.join(out, 'last-pass.json');
  const baseline = readJson(lastPassFile);
  const calibration = readJson(path.join(out, 'calibration.json'));
  const found = baseline ? compare(benches, results, baseline, opts.threshold, calibration) : [];
  // A noisy run never flags: the regressions it would have flagged are kept as a warning.
  const regressions = noise.noisy ? [] : found;
  const g = opts.git ?? gitState();
  const time = new Date().toISOString();
  const runName = `${time.replace(/:/g, '-')}-${g.sha}-${g.dirty ? 'dirty' : 'clean'}.json`;
  const record = {
    version: 1, time, commit: g.sha, dirty: g.dirty, machine: opts.machine ?? machineInfo(power),
    runs, warmup, benches: detail, baseline: baseline?.run ?? null,
    noisy: noise.noisy, noiseReasons: noise.reasons,
    noise: { power, cpuBeforePct, cpuDuringPct, heavyBefore, heavyDuring, limits: opts.noiseThresholds ?? NOISE },
    regressions, wouldRegress: noise.noisy ? found : [], passed: regressions.length === 0,
  };
  mkdirSync(path.join(out, 'runs'), { recursive: true });
  writeFileSync(path.join(out, 'runs', runName), JSON.stringify(record, null, 2) + '\n');

  // No code path here writes last-pass.json: only accept() does, with a stated reason.
  const missingBaseline = benches
    .filter((b) => Object.keys(b.metrics).some((n) => typeof baseline?.results?.[b.id]?.[n] !== 'number'))
    .map((b) => b.id);
  for (const b of benches) {
    for (const [name, d] of Object.entries(detail[b.id].metrics)) {
      log(`${b.id}.${name} = ${d.median.toFixed(2)} ${d.unit}`);
    }
  }
  return {
    run: runName, record, regressions, missingBaseline, passed: regressions.length === 0,
    noisy: noise.noisy, noiseReasons: noise.reasons, wouldRegress: record.wouldRegress,
  };
}

export const CHILD_MARK = 'UJWALAM-BENCH-RESULT ';

/** Collect samples for one loaded bench in this process: `warmup` discarded runs, then `runs` kept. */
export async function sampleBench(b, runs, warmup) {
  for (let i = 0; i < warmup; i++) await b.run();
  const samples = {};
  let info = null;
  for (let i = 0; i < runs; i++) {
    const r = await b.run();
    if (r?.info && typeof r.info === 'object') info = r.info; // facts of the last run (row counts, file counts), not metrics
    for (const name of Object.keys(b.metrics)) {
      if (typeof r?.[name] !== 'number' || !Number.isFinite(r[name])) {
        throw new Error(`${b.id}: run() did not return a number for "${name}"`);
      }
      (samples[name] ??= []).push(r[name]);
    }
  }
  return { samples, info };
}

/**
 * Run every bench `warmup` + `runs` times, each bench in its own fresh child process (same node binary,
 * no shell), so heap and module state never carry from one bench to the next.
 * Returns { benchId: { metric: [samples] } }.
 */
function measure(benches, runs, warmup) {
  const all = {};
  for (const b of benches) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', b.path, '--runs', String(runs), '--warmup', String(warmup)],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.error || r.status !== 0) {
      throw new Error(`${b.id}: bench child failed (${r.error?.message ?? `exit ${r.status}`}) ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
    }
    const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith(CHILD_MARK));
    if (!line) throw new Error(`${b.id}: bench child gave no result`);
    const j = JSON.parse(line.slice(CHILD_MARK.length));
    all[b.id] = { samples: j.samples, info: j.info ?? null };
  }
  return all;
}

/** Child entry: load one bench module, sample it, print the samples on one marked line. */
async function childMain(argv) {
  const file = argv[argv.indexOf('--child') + 1];
  const num = (flag, d) => (argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : d);
  const m = await import(pathToFileURL(path.resolve(file)).href);
  if (!m.id || typeof m.run !== 'function' || !m.metrics) throw new Error(`bad bench module: ${file}`);
  const { samples, info } = await sampleBench(m, num('--runs', 5), num('--warmup', 1));
  process.stdout.write(`\n${CHILD_MARK}${JSON.stringify({ id: m.id, samples, info })}\n`);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Measure noise per metric and store minDelta = 3 x stddev in <out>/calibration.json. Refuses noisy runs. */
export async function calibrate(opts = {}) {
  const out = outDirFor(opts);
  const benchesDir = path.resolve(opts.benches ?? path.join(REPO, 'tools', 'bench', 'benches'));
  let benches = await loadBenches(benchesDir);
  if (opts.only) benches = benches.filter((b) => opts.only.includes(b.id));
  if (!benches.length) throw new Error('no benches selected');
  const probes = withProbes(opts.probes);
  const power = await probes.power();
  const cpuBeforePct = await probes.cpuBefore();
  const heavyBefore = probes.heavyBefore();
  const win = probes.cpuWindow();
  const all = measure(benches, opts.runs ?? CALIBRATION_RUNS, opts.warmup ?? 1);
  const cpuDuringPct = win.stop();
  const heavyDuring = probes.heavyWindow();
  const noise = assessNoise({ power, cpuBeforePct, cpuDuringPct, heavyBefore, heavyDuring }, opts.noiseThresholds);
  if (noise.noisy) throw new Error(`calibration refused, noisy machine: ${noise.reasons.join('; ')}`);
  const g = opts.git ?? gitState();
  const prev = readJson(path.join(out, 'calibration.json'));
  const cal = {
    version: 1, time: new Date().toISOString(), commit: g.sha, machine: opts.machine ?? machineInfo(power),
    sigmas: CALIBRATION_SIGMAS, benches: { ...(prev?.benches ?? {}) },
  };
  for (const b of benches) {
    cal.benches[b.id] = {};
    for (const [name, def] of Object.entries(b.metrics)) {
      const xs = all[b.id].samples[name];
      const sd = stddev(xs);
      cal.benches[b.id][name] = { unit: def.unit, n: xs.length, mean: mean(xs), stddev: sd, minDelta: CALIBRATION_SIGMAS * sd };
    }
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'calibration.json'), JSON.stringify(cal, null, 2) + '\n');
  return cal;
}

/** Make the latest run the baseline and log why. Returns the run file name. */
export function accept(reason, opts = {}) {
  if (!reason || !String(reason).trim()) throw new Error('--accept needs a reason');
  const out = outDirFor(opts);
  const dir = path.join(out, 'runs');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error('no run to accept; run the benchmarks first');
  const latest = files[files.length - 1];
  const rec = JSON.parse(readFileSync(path.join(dir, latest), 'utf8'));
  if (rec.noisy) {
    throw new Error(`latest run is noisy (${(rec.noiseReasons ?? []).join('; ')}); run again on AC power with a quiet machine`);
  }
  const results = {};
  for (const [id, b] of Object.entries(rec.benches)) {
    results[id] = Object.fromEntries(Object.entries(b.metrics).map(([n, m]) => [n, m.median]));
  }
  const baseline = readJson(path.join(out, 'last-pass.json'));
  const log = opts.log ?? (() => {});
  log(`accept reason: ${String(reason).trim()}`);
  for (const [id, ms] of Object.entries(results)) {
    for (const [n, v] of Object.entries(ms)) {
      const old = baseline?.results?.[id]?.[n];
      log(`${id}.${n}: ${typeof old === 'number' ? old.toFixed(3) : '(none)'} -> ${v.toFixed(3)} ${rec.benches[id].metrics[n].unit}`);
    }
  }
  const merged = { ...(baseline?.results ?? {}), ...results };
  const info = { ...(baseline?.info ?? {}) };
  for (const [id, b] of Object.entries(rec.benches)) if (b.info) info[id] = b.info;
  writeFileSync(
    path.join(out, 'last-pass.json'),
    JSON.stringify({ version: 1, run: latest, time: rec.time, commit: rec.commit, results: merged, info, accepted: true }, null, 2) + '\n',
  );
  appendFileSync(
    path.join(out, 'accepts.jsonl'),
    JSON.stringify({ time: new Date().toISOString(), run: latest, commit: rec.commit, reason: String(reason).trim(), regressions: rec.regressions }) + '\n',
  );
  return latest;
}

/** Copy the latest run to commits/<sha>.json. Used by the post-commit hook. */
export function recordCommit(sha, opts = {}) {
  const out = outDirFor(opts);
  const dir = path.join(out, 'runs');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) return null;
  mkdirSync(path.join(out, 'commits'), { recursive: true });
  const dest = path.join(out, 'commits', `${sha}.json`);
  copyFileSync(path.join(dir, files[files.length - 1]), dest);
  return dest;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--child')) return childMain(argv);
  const o = {};
  let acceptReason = null;
  if (process.env.UJWALAM_BENCH_FAKE_NOISE) o.probes = fakeProbes(JSON.parse(process.env.UJWALAM_BENCH_FAKE_NOISE));
  let doCalibrate = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') o.runs = Number(argv[++i]);
    else if (a === '--warmup') o.warmup = Number(argv[++i]);
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--benches') o.benches = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--calibrate') doCalibrate = true;
    else if (a === '--accept') acceptReason = argv[++i] ?? '';
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (acceptReason !== null) {
    try {
      const run = accept(acceptReason, { ...o, log: (l) => console.log(`bench: ${l}`) });
      console.log(`bench: accepted ${run} as baseline (reason logged to accepts.jsonl)`);
      return;
    } catch (e) { console.error(`bench: ${e.message}`); process.exit(2); }
  }
  if (doCalibrate) {
    try {
      const cal = await calibrate(o);
      for (const [id, ms] of Object.entries(cal.benches)) {
        for (const [n, c] of Object.entries(ms)) {
          console.log(`bench: calibrated ${id}.${n}: n=${c.n} mean=${c.mean.toFixed(3)} stddev=${c.stddev.toFixed(3)} minDelta=${c.minDelta.toFixed(3)} ${c.unit}`);
        }
      }
      return;
    } catch (e) { console.error(`bench: ${e.message}`); process.exit(2); }
  }
  o.log = (l) => console.log(`bench: ${l}`);
  const r = await runHarness(o);
  console.log(`bench: wrote runs/${r.run}`);
  if (r.noisy) {
    console.log(`bench: ${advisoryLine(r.noiseReasons)}`);
    console.log(`bench: WARNING noisy run: ${r.noiseReasons.join('; ')}`);
    console.log('bench: ADVISORY run: baseline and calibration untouched, regressions reported but not enforced (exit 0)');
    for (const g of r.wouldRegress) {
      const pct = Number.isFinite(g.change) ? `${(g.change * 100).toFixed(1)} %` : 'from zero';
      console.log(`bench: advisory regression: ${g.bench}.${g.metric} ${g.base.toFixed(2)} -> ${g.now.toFixed(2)} ${g.unit} (${pct} worse)`);
    }
    return;
  }
  for (const id of r.missingBaseline) console.log(`bench: ${id}: no baseline (needs --accept)`);
  if (!r.passed && inAdvisoryWindow()) {
    console.log(`bench: advisory (v1 window: regressions enforced from ${ENFORCE_FROM})`);
    for (const g of r.regressions) {
      const pct = Number.isFinite(g.change) ? `${(g.change * 100).toFixed(1)} %` : 'from zero';
      console.log(`bench: advisory regression: ${g.bench}.${g.metric} ${g.base.toFixed(2)} -> ${g.now.toFixed(2)} ${g.unit} (${pct} worse)`);
    }
    console.log('bench: ADVISORY run: baseline unchanged, regressions reported but not enforced (exit 0)');
    return;
  }
  if (!r.passed) {
    for (const g of r.regressions) {
      const pct = Number.isFinite(g.change) ? `${(g.change * 100).toFixed(1)} %` : 'from zero';
      console.log(`bench: REGRESSION ${g.bench}.${g.metric}: ${g.base.toFixed(2)} -> ${g.now.toFixed(2)} ${g.unit} (${pct} worse, limit ${THRESHOLD * 100} %)`);
    }
    console.log('bench: FAIL (baseline unchanged; user-approved changes: npm run bench -- --accept "<reason>")');
    process.exit(1);
  }
  console.log('bench: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`bench: ${e.message}`); process.exit(2); });
}
