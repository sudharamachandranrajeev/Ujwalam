// SPDX-License-Identifier: GPL-3.0-or-later
// tools/bench: harness, 10 % regression flag, baseline, accept, post-commit hook. Temp dirs only.
// The fixture benches spin for a time the test sets through a control file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, runHarness, accept, recordCommit, machineInfo, compare, calibrate, stddev, assessNoise, fakeProbes } from '../tools/bench/run.mjs';
import { NOISE, heavyBetween, loadNoisyList, parseProcSnapshot, advisoryLine } from '../tools/bench/noise.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runMjs = path.join(repo, 'tools', 'bench', 'run.mjs');
const recordMjs = path.join(repo, 'tools', 'bench', 'record-commit.mjs');

const QUIET = { power: 'ac', cpuBeforePct: 2, cpuDuringPct: 5 };
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A fixture project: benches/ with a lower-is-better "slow" bench and a higher-is-better "rate" bench.
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  dirs.push(root);
  const benches = path.join(root, 'benches');
  mkdirSync(benches);
  const ctl = path.join(root, 'ctl.json');
  writeFileSync(ctl, JSON.stringify({ ms: 40, rate: 1000 }));
  const ctlUrl = JSON.stringify(ctl);
  writeFileSync(path.join(benches, 'slow.mjs'), `
import { readFileSync } from 'node:fs';
export const id = 'fx-slow';
export const budget = null;
export const metrics = { wall_ms: { unit: 'ms', lowerIsBetter: true } };
export function run() {
  const ms = JSON.parse(readFileSync(${ctlUrl}, 'utf8')).ms;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { /* spin */ }
  return { wall_ms: performance.now() - t0 };
}
`);
  writeFileSync(path.join(benches, 'rate.mjs'), `
import { readFileSync } from 'node:fs';
export const id = 'fx-rate';
export const budget = 'PB-12';
export const metrics = { per_s: { unit: '1/s', lowerIsBetter: false } };
export async function run() { return { per_s: JSON.parse(readFileSync(${ctlUrl}, 'utf8')).rate }; }
`);
  const set = (o) => writeFileSync(ctl, JSON.stringify({ ms: 40, rate: 1000, ...o }));
  const out = path.join(root, 'out');
  const opts = { benches, out, runs: 3, warmup: 0, git: { sha: 'abc123def456', dirty: false }, machine: { cpu: 'test' }, probes: fakeProbes(QUIET) };
  return { root, benches, out, set, opts, go: (extra = {}) => runHarness({ ...opts, ...extra }) };
}
const runFiles = (out) => readdirSync(path.join(out, 'runs')).sort();

test('median of odd and even sample counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('first quiet run: records the run, writes NO baseline, reports missing baseline, passes', async () => {
  const f = fixture();
  const r = await f.go();
  assert.deepEqual(r.missingBaseline.sort(), ['fx-rate', 'fx-slow']);
  assert.equal(r.passed, true);
  assert.deepEqual(r.regressions, []);
  assert.match(r.run, /^\d{4}-\d\d-\d\dT[\d-]+\.\d+Z-abc123def456-clean\.json$/);
  assert.ok(!existsSync(path.join(f.out, 'last-pass.json')));
  const rec = JSON.parse(readFileSync(path.join(f.out, 'runs', r.run), 'utf8'));
  assert.equal(rec.benches['fx-rate'].budget, 'PB-12');
  assert.equal(rec.benches['fx-slow'].metrics.wall_ms.samples.length, 3);
  // a second quiet run still writes nothing
  await f.go();
  assert.ok(!existsSync(path.join(f.out, 'last-pass.json')));
});

test('--accept writes the baseline and prints old and new values with the reason', async () => {
  const f = fixture();
  await f.go();
  const lines = [];
  accept('first baseline', { out: f.out, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /accept reason: first baseline/.test(l)));
  assert.ok(lines.some((l) => /^fx-rate\.per_s: \(none\) -> 1000\.000/.test(l)), lines.join(' | '));
  const last = JSON.parse(readFileSync(path.join(f.out, 'last-pass.json'), 'utf8'));
  assert.equal(last.results['fx-rate'].per_s, 1000);
  assert.ok(last.results['fx-slow'].wall_ms >= 40);
  f.set({ rate: 900 });
  const r = await f.go();
  assert.deepEqual(r.missingBaseline, []);
  const lines2 = [];
  accept('slower on purpose', { out: f.out, log: (l) => lines2.push(l) });
  assert.ok(lines2.some((l) => /^fx-rate\.per_s: 1000\.000 -> 900\.000/.test(l)), lines2.join(' | '));
});

test('same speed and a 5 % slowdown both pass and leave the baseline untouched', async () => {
  const f = fixture();
  await f.go();
  accept('seed', { out: f.out });
  const seeded = readFileSync(path.join(f.out, 'last-pass.json'), 'utf8');
  assert.equal((await f.go()).passed, true);
  f.set({ ms: 42 });
  const r = await f.go();
  assert.equal(r.passed, true, JSON.stringify(r.regressions));
  assert.deepEqual(r.missingBaseline, []);
  assert.equal(readFileSync(path.join(f.out, 'last-pass.json'), 'utf8'), seeded);
  assert.equal(runFiles(f.out).length, 3);
});

test('injected slowdown over 10 % is flagged, run is kept, baseline is not updated', async () => {
  const f = fixture();
  await f.go();
  accept('seed', { out: f.out });
  const before = readFileSync(path.join(f.out, 'last-pass.json'), 'utf8');
  f.set({ ms: 60 });
  const r = await f.go();
  assert.equal(r.passed, false);
  assert.equal(r.regressions.length, 1);
  assert.equal(r.regressions[0].bench, 'fx-slow');
  assert.ok(r.regressions[0].change > 0.4);
  assert.equal(readFileSync(path.join(f.out, 'last-pass.json'), 'utf8'), before);
  const rec = JSON.parse(readFileSync(path.join(f.out, 'runs', r.run), 'utf8'));
  assert.equal(rec.passed, false);
  assert.equal(rec.regressions.length, 1);
});

test('higher-is-better metric: a 20 % drop is flagged, a 5 % drop is not', async () => {
  const f = fixture();
  await f.go();
  accept('seed', { out: f.out });
  f.set({ rate: 950 });
  assert.equal((await f.go()).passed, true);
  f.set({ rate: 700 });
  const r = await f.go();
  assert.equal(r.passed, false);
  assert.equal(r.regressions[0].bench, 'fx-rate');
});

test('minDelta keeps tiny absolute changes from flagging', () => {
  const benches = [{ id: 'b', metrics: { m: { unit: 'ms', lowerIsBetter: true, minDelta: 50 } } }];
  const base = { results: { b: { m: 100 } } };
  assert.equal(compare(benches, { b: { m: 140 } }, base).length, 0);
  assert.equal(compare(benches, { b: { m: 160 } }, base).length, 1);
});

test('CLI: first run prints "no baseline (needs --accept)" and writes none; slowdown exits 1; --accept prints old/new and logs the reason', async () => {
  const f = fixture();
  const cli = (...a) => spawnSync(process.execPath, [runMjs, '--benches', f.benches, '--out', f.out, '--runs', '3', '--warmup', '0', ...a], { encoding: 'utf8', env: { ...process.env, UJWALAM_BENCH_NOW: '2026-11-06', UJWALAM_BENCH_FAKE_NOISE: JSON.stringify(QUIET) }, windowsHide: true });
  const first = cli();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /fx-slow: no baseline \(needs --accept\)/);
  assert.ok(!existsSync(path.join(f.out, 'last-pass.json')));
  assert.equal(cli('--accept', 'seed').status, 0);
  assert.match(cli('--accept', 'seed again').stdout, /fx-slow\.wall_ms: [\d.]+ -> [\d.]+ ms/);
  f.set({ ms: 60 });
  const slow = cli();
  assert.equal(slow.status, 1);
  assert.match(slow.stdout, /REGRESSION fx-slow\.wall_ms/);
  assert.equal(cli('--accept').status, 2); // reason is required
  const acc = cli('--accept', 'user approved slower fixture');
  assert.equal(acc.status, 0, acc.stderr);
  const log = readFileSync(path.join(f.out, 'accepts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 3);
  assert.equal(log[2].reason, 'user approved slower fixture');
  assert.equal(log[2].regressions.length, 1);
  const again = cli(); // the new speed is now the baseline
  assert.equal(again.status, 0, again.stdout);
});

test('accept needs a reason and an existing run', () => {
  const f = fixture();
  assert.throws(() => accept('', { out: f.out }), /reason/);
  assert.throws(() => accept('why', { out: f.out }), /no run/);
});

test('machine info has the allowed fields and no host or user name', () => {
  const m = machineInfo();
  assert.deepEqual(Object.keys(m).sort(), ['cpu', 'logicalCores', 'node', 'os', 'power', 'python', 'totalRamGB']);
  const text = JSON.stringify(m);
  assert.ok(!text.includes(os.hostname()));
  assert.ok(!text.includes(os.userInfo().username));
});

test('recordCommit copies the latest run to commits/<sha>.json', async () => {
  const f = fixture();
  assert.equal(recordCommit('deadbeef0000', { out: f.out }), null); // no run yet
  await f.go();
  const r2 = await f.go();
  const dest = recordCommit('deadbeef0000', { out: f.out });
  assert.equal(path.basename(dest), 'deadbeef0000.json');
  assert.equal(readFileSync(dest, 'utf8'), readFileSync(path.join(f.out, 'runs', r2.run), 'utf8'));
});

test('post-commit helper and hook exit 0 whatever the state of the output folder', async () => {
  const f = fixture();
  const withOut = (out) => ({ ...process.env, UJWALAM_BENCH_OUT: out });
  // no output folder at all
  assert.equal(spawnSync(process.execPath, [recordMjs], { env: withOut(path.join(f.root, 'nope')), cwd: repo, windowsHide: true }).status, 0);
  // runs/ holds garbage and commits/ is a file, so copying must fail
  mkdirSync(path.join(f.out, 'runs'), { recursive: true });
  writeFileSync(path.join(f.out, 'runs', 'x.json'), '{ not json');
  writeFileSync(path.join(f.out, 'commits'), 'a file, not a folder');
  assert.equal(spawnSync(process.execPath, [recordMjs], { env: withOut(f.out), cwd: repo, windowsHide: true }).status, 0);
  // the shell hook itself, when a POSIX sh is available
  const hook = path.join(repo, 'tools', 'git-hooks', 'post-commit');
  const text = readFileSync(hook, 'utf8');
  assert.match(text, /\|\| true/);
  assert.match(text.trimEnd(), /exit 0$/);
  const sh = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true });
  if (!sh.error) {
    const good = fixture();
    await good.go();
    const r = spawnSync('sh', [hook], { env: withOut(good.out), cwd: repo, windowsHide: true });
    assert.equal(r.status, 0);
    assert.equal(readdirSync(path.join(good.out, 'commits')).length, 1);
    const bad = spawnSync('sh', [hook], { env: withOut(f.out), cwd: repo, windowsHide: true });
    assert.equal(bad.status, 0);
  }
  assert.ok(existsSync(hook));
});

test('stddev is the sample standard deviation', () => {
  assert.equal(stddev([5]), 0);
  assert.ok(Math.abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001);
});

test('calibrate stores n, mean, stddev and minDelta = 3 x stddev; compare then uses it over the module fallback', async () => {
  const f = fixture();
  // a metric with a known spread: values cycle 10, 12, 14
  const cyc = path.join(f.benches, 'cyc.mjs');
  writeFileSync(cyc, `
let i = 0;
export const id = 'fx-cyc';
export const metrics = { v: { unit: 'ms', lowerIsBetter: true, minDelta: 1 } };
export function run() { return { v: 10 + 2 * (i++ % 3) }; }
`);
  const cal = await calibrate({ ...f.opts, only: ['fx-cyc'], runs: 9, warmup: 0 });
  const c = cal.benches['fx-cyc'].v;
  assert.equal(c.n, 9);
  assert.equal(c.mean, 12);
  assert.ok(Math.abs(c.stddev - Math.sqrt(3)) < 1e-9);
  assert.ok(Math.abs(c.minDelta - 3 * Math.sqrt(3)) < 1e-9);
  assert.ok(existsSync(path.join(f.out, 'calibration.json')));
  const benches = [{ id: 'fx-cyc', metrics: { v: { unit: 'ms', lowerIsBetter: true, minDelta: 1 } } }];
  const base = { results: { 'fx-cyc': { v: 20 } } };
  assert.equal(compare(benches, { 'fx-cyc': { v: 25 } }, base, 0.1, null).length, 1); // fallback minDelta 1
  assert.equal(compare(benches, { 'fx-cyc': { v: 25 } }, base, 0.1, cal).length, 0); // calibrated 5.196 swallows +5
  assert.equal(compare(benches, { 'fx-cyc': { v: 27 } }, base, 0.1, cal).length, 1);
});

test('harness reads calibration.json from the output folder', async () => {
  const f = fixture();
  await f.go({ only: ['fx-slow'] });
  mkdirSync(f.out, { recursive: true });
  writeFileSync(path.join(f.out, 'calibration.json'), JSON.stringify({ benches: { 'fx-slow': { wall_ms: { minDelta: 100 } } } }));
  f.set({ ms: 80 }); // +100 % but under the calibrated 100 ms slack
  assert.equal((await f.go({ only: ['fx-slow'] })).passed, true);
});

test('assessNoise: battery, CPU before and CPU during each mark a run noisy', () => {
  assert.deepEqual(assessNoise(QUIET), { noisy: false, reasons: [] });
  assert.match(assessNoise({ ...QUIET, power: 'battery' }).reasons[0], /battery/);
  assert.deepEqual(NOISE, { cpuBeforePct: 10, cpuDuringPct: 15 }, 'chosen limits, see tools/bench/noise.mjs');
  assert.match(assessNoise({ ...QUIET, cpuBeforePct: 10.1 }).reasons[0], /before start/);
  assert.equal(assessNoise({ ...QUIET, cpuBeforePct: 10 }).noisy, false); // limit is "above 10"
  assert.match(assessNoise({ ...QUIET, cpuDuringPct: 15.1 }).reasons[0], /during the run/);
  assert.equal(assessNoise({ ...QUIET, cpuDuringPct: 15 }).noisy, false);
  // the old limits (25 / 50) no longer count as quiet
  assert.equal(assessNoise({ ...QUIET, cpuBeforePct: 24, cpuDuringPct: 40 }).noisy, true);
});

// ---- known heavy processes (data: tools/bench/noisy-processes.json) ----
const snap = (ts, procs) => ({ ts, procs });
const CORES = 16;
const SEC = 1e7; // 100 ns ticks per second
const cpuTicks = (pct) => (pct / 100) * CORES * 10 * SEC; // one process using pct % of the whole machine for 10 s
const list = () => loadNoisyList();
test('noisy-processes.json: valid, has a comment field, covers Defender, NVIDIA, Discord, Telegram and browsers', () => {
  const raw = JSON.parse(readFileSync(path.join(path.dirname(runMjs), 'noisy-processes.json'), 'utf8'));
  assert.equal(typeof raw.comment, 'string');
  const names = list().groups.flatMap((g) => g.names.map((n) => n.toLowerCase()));
  for (const n of ['msmpeng', 'nvcontainer', 'nvdisplay.container', 'discord', 'telegram', 'chrome', 'msedge', 'firefox', 'brave', 'opera']) assert.ok(names.includes(n), n);
});
const heavy = (name, pct) => heavyBetween(snap(0, { [name]: 0 }), snap(10 * SEC, { [name]: cpuTicks(pct) }), { list: list(), cores: CORES });
test('heavy processes: Defender above its limit is flagged, below it is not', () => {
  assert.equal(heavy('MsMpEng', 5)[0].group, 'Windows Defender');
  assert.deepEqual(heavy('MsMpEng', 0.5), []);
});
for (const n of ['nvcontainer', 'NVDisplay.Container', 'Discord', 'Telegram', 'chrome', 'msedge', 'firefox', 'brave', 'opera']) {
  test(`heavy processes: ${n} is flagged by name when busy, not when idle`, () => {
    assert.equal(heavy(n, 12).length, 1);
    assert.equal(heavy(n.toUpperCase(), 12).length, 1, 'case-insensitive');
    assert.deepEqual(heavy(n, 0.2), []);
  });
}
test('heavy processes: a running Defender scan helper is flagged on presence alone; unknown names never are', () => {
  const h = heavyBetween(snap(0, { MpCmdRun: 0 }), snap(10 * SEC, { MpCmdRun: 0 }), { list: list(), cores: CORES });
  assert.equal(h.length, 1);
  assert.equal(h[0].presenceOnly, true);
  assert.deepEqual(heavy('node', 90), []);
  assert.deepEqual(heavyBetween(null, snap(1, {}), { list: list(), cores: CORES }), [], 'no snapshot: not noisy');
});
test('heavy processes: the list is data (a custom list changes the verdict, no code change)', () => {
  const custom = { defaultMinCpuPct: 1, groups: [{ group: 'custom', names: ['zorbax'] }] };
  const h = heavyBetween(snap(0, { zorbax: 0 }), snap(10 * SEC, { zorbax: cpuTicks(3) }), { list: custom, cores: CORES });
  assert.equal(h[0].group, 'custom');
  assert.equal(h[0].limit, 1);
});
test('parseProcSnapshot: sums same-named processes, strips #n suffixes, ignores Idle and junk', () => {
  const s = parseProcSnapshot('chrome|100|500\r\nchrome#1|50|500\r\nIdle|9|500\r\njunk\r\nnode|7|600\r\n');
  assert.deepEqual(s, { ts: 600, procs: { chrome: 150, node: 7 } });
  assert.equal(parseProcSnapshot(''), null);
});
test('assessNoise: a heavy process makes a run noisy with its name in the reasons', () => {
  const r = assessNoise({ ...QUIET, heavyBefore: heavy('MsMpEng', 8) });
  assert.equal(r.noisy, true);
  assert.match(r.reasons[0], /MsMpEng \(Windows Defender\) uses 8 % CPU before start/);
  assert.match(assessNoise({ ...QUIET, heavyDuring: heavy('Discord', 9) }).reasons[0], /Discord.*during the run/);
  assert.equal(advisoryLine(['a', 'b']), 'advisory (noisy: a; b)');
});

for (const [label, noise] of [
  ['battery', { ...QUIET, power: 'battery' }],
  ['background CPU before start', { ...QUIET, cpuBeforePct: 60 }],
  ['CPU load during the run', { ...QUIET, cpuDuringPct: 90 }],
  ['known heavy process before start (Defender)', { ...QUIET, heavyBefore: [{ name: 'MsMpEng', group: 'Windows Defender', cpuPct: 8, limit: 1.5 }] }],
  ['known heavy process during the run (browser)', { ...QUIET, heavyDuring: [{ name: 'chrome', group: 'Browser', cpuPct: 12, limit: 3 }] }],
]) {
  test(`noisy run (${label}): recorded with reason, no baseline, no regression flag`, async () => {
    const f = fixture();
    // noisy first run must not set a baseline
    const first = await f.go({ probes: fakeProbes(noise) });
    assert.equal(first.noisy, true);
    assert.equal(first.passed, true);
    assert.deepEqual(first.missingBaseline.sort(), ['fx-rate', 'fx-slow']);
    assert.ok(!existsSync(path.join(f.out, 'last-pass.json')));
    const rec = JSON.parse(readFileSync(path.join(f.out, 'runs', first.run), 'utf8'));
    assert.equal(rec.noisy, true);
    assert.ok(rec.noiseReasons.length >= 1);
    assert.equal(rec.noise.power, noise.power);
    assert.ok(Array.isArray(rec.noise.heavyBefore) && Array.isArray(rec.noise.heavyDuring), 'run file records the heavy processes');
    // accepted quiet baseline, then a noisy slow run: warning only, baseline untouched
    await f.go();
    accept('seed', { out: f.out });
    const before = readFileSync(path.join(f.out, 'last-pass.json'), 'utf8');
    f.set({ ms: 80 });
    const slow = await f.go({ probes: fakeProbes(noise) });
    assert.equal(slow.passed, true);
    assert.deepEqual(slow.regressions, []);
    assert.equal(slow.wouldRegress.length, 1);
    assert.equal(readFileSync(path.join(f.out, 'last-pass.json'), 'utf8'), before);
    // the latest run is noisy: accept refuses, calibration refuses
    assert.throws(() => accept('try', { out: f.out }), /noisy/);
    await assert.rejects(() => calibrate({ ...f.opts, probes: fakeProbes(noise), runs: 2 }), /calibration refused/);
    assert.ok(!existsSync(path.join(f.out, 'calibration.json')));
  });
}

test('CLI: a noisy slow run is ADVISORY (reasons and regression printed, exit 0), a quiet one fails; --accept on a noisy one exits 2', async () => {
  const f = fixture();
  const run = (noise, ...a) => spawnSync(process.execPath, [runMjs, '--benches', f.benches, '--out', f.out, '--runs', '3', '--warmup', '0', ...a],
    { encoding: 'utf8', env: { ...process.env, UJWALAM_BENCH_NOW: '2026-11-06', UJWALAM_BENCH_FAKE_NOISE: JSON.stringify(noise) }, windowsHide: true });
  assert.equal(run(QUIET).status, 0);
  assert.equal(run(QUIET, '--accept', 'seed').status, 0);
  f.set({ ms: 80 });
  const rq = run(QUIET); // the same slow run on a quiet machine fails
  assert.equal(rq.status, 1, rq.stdout);
  assert.match(rq.stdout, /REGRESSION fx-slow\.wall_ms/);
  const r = run({ ...QUIET, power: 'battery' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WARNING noisy run: on battery power/);
  assert.match(r.stdout, /^bench: advisory \(noisy: on battery power\)$/m);
  assert.match(r.stdout, /advisory regression: fx-slow\.wall_ms/);
  assert.equal(run({ ...QUIET, power: 'battery' }, '--accept', 'no').status, 2);
  const cal = run({ ...QUIET, cpuBeforePct: 80 }, '--calibrate');
  assert.equal(cal.status, 2);
  assert.match(cal.stderr, /calibration refused/);
});

test('CLI --calibrate prints per-metric n, mean, stddev and minDelta', async () => {
  const f = fixture();
  const r = spawnSync(process.execPath, [runMjs, '--benches', f.benches, '--out', f.out, '--calibrate', '--runs', '4', '--warmup', '0'],
    { encoding: 'utf8', env: { ...process.env, UJWALAM_BENCH_FAKE_NOISE: JSON.stringify(QUIET) }, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /calibrated fx-slow\.wall_ms: n=4 mean=[\d.]+ stddev=[\d.]+ minDelta=[\d.]+ ms/);
  assert.match(r.stdout, /calibrated fx-rate\.per_s: n=4 mean=1000\.000 stddev=0\.000 minDelta=0\.000/);
});

test('each bench runs in its own fresh process: no module, global or heap state is shared between benches', async () => {
  const f = fixture();
  for (const n of ['iso-a', 'iso-b']) {
    writeFileSync(path.join(f.benches, `${n}.mjs`), `
export const id = '${n}';
export const budget = null;
export const metrics = { seen: { unit: 'count', lowerIsBetter: true }, pid: { unit: 'id', lowerIsBetter: true } };
export function run() {
  globalThis.__benchShared = (globalThis.__benchShared ?? 0) + 1;
  globalThis.__benchHeap = [...(globalThis.__benchHeap ?? []), new Array(1000).fill(1)];
  return { seen: globalThis.__benchShared, pid: process.pid };
}
`);
  }
  const r = await f.go({ only: ['iso-a', 'iso-b'], runs: 1, warmup: 0 });
  const a = r.record.benches['iso-a'].metrics;
  const b = r.record.benches['iso-b'].metrics;
  assert.equal(a.seen.median, 1, 'iso-a saw only its own run');
  assert.equal(b.seen.median, 1, 'iso-b did not see iso-a state');
  assert.notEqual(a.pid.median, b.pid.median, 'different processes');
  assert.notEqual(a.pid.median, process.pid, 'not the harness process');
});

test('a bench that crashes in its child fails the harness with the bench id', async () => {
  const f = fixture();
  writeFileSync(path.join(f.benches, 'boom.mjs'), `
export const id = 'fx-boom';
export const metrics = { x: { unit: 'ms' } };
export function run() { throw new Error('kaboom'); }
`);
  await assert.rejects(f.go({ only: ['fx-boom'] }), /fx-boom: bench child failed.*kaboom/);
});

test('slowdown injected into an isolated child is still flagged', async () => {
  const f = fixture();
  await f.go({ only: ['fx-slow'] });
  accept('seed', { out: f.out });
  f.set({ ms: 80 });
  const r = await f.go({ only: ['fx-slow'] });
  assert.equal(r.passed, false);
  assert.equal(r.regressions[0].metric, 'wall_ms');
});

test('a bench may return info (row counts, file counts): stored in the run file and the baseline, never compared', async () => {
  const f = fixture();
  writeFileSync(path.join(f.benches, 'info.mjs'), `
export const id = 'fx-info';
export const budget = null;
export const metrics = { v: { unit: 'ms', lowerIsBetter: true } };
export function run() { return { v: 5, info: { files: 12, bytes: 3456, rows: { audit: 7 } } }; }
`);
  const r = await f.go({ only: ['fx-info'] });
  accept('seed', { out: f.out });
  const rec = JSON.parse(readFileSync(path.join(f.out, 'runs', r.run), 'utf8'));
  assert.deepEqual(rec.benches['fx-info'].info, { files: 12, bytes: 3456, rows: { audit: 7 } });
  const last = JSON.parse(readFileSync(path.join(f.out, 'last-pass.json'), 'utf8'));
  assert.deepEqual(last.info['fx-info'], { files: 12, bytes: 3456, rows: { audit: 7 } });
  assert.equal(last.results['fx-info'].v, 5);
  assert.equal(rec.benches['fx-slow'], undefined);
});

test('the private-scan bench records files and bytes of the scan input and the time per file', async () => {
  const m = await import('../tools/bench/benches/private-scan.mjs');
  const i = m.scanInput();
  assert.ok(i.files > 50 && i.bytes > 10000);
  assert.deepEqual(Object.keys(m.metrics), ['wall_ms']);
});

test('audit benches are split: plain write (audit rows only) and full write path (all four tables)', async () => {
  const w = await import('../tools/bench/benches/event-core-audit-write.mjs');
  const full = await import('../tools/bench/benches/event-core-audit-full.mjs');
  assert.notEqual(w.id, full.id);
  const a = w.run();
  assert.deepEqual(a.info.rows, { audit: 10000, chat_raw: 0, dedupe_keys: 0, action_keys: 0 });
  const b = await full.run();
  const rows = b.info.corePhase.rows;
  for (const t of ['audit', 'chat_raw', 'dedupe_keys', 'action_keys']) assert.ok(rows[t] > 0, `${t} has rows in the full path`);
  for (const k of ['audit', 'raw', 'dedupe', 'actions']) assert.ok(b.info.storePhase.rowsWritten[k] > 0, k);
});

// User-approved rules (2026-10-30): 0.1 ms absolute floor for 'ms' metrics; quiet-run regressions advisory before 2026-11-06.
test('bench rules: 0.1 ms absolute floor for ms metrics; v1 advisory window ends 2026-11-06', async () => {
  const { ABS_FLOOR_MS, ENFORCE_FROM, inAdvisoryWindow } = await import('../tools/bench/run.mjs');
  assert.equal(ABS_FLOOR_MS, 0.1);
  const benches = [{ id: 'b', metrics: { m: { unit: 'ms', lowerIsBetter: true }, r: { unit: 'rows/s', lowerIsBetter: false } } }];
  const base = { results: { b: { m: 0.0013, r: 100 } } };
  assert.equal(compare(benches, { b: { m: 0.011, r: 100 } }, base).length, 0, '742 % worse but under 0.1 ms: not a regression');
  assert.equal(compare(benches, { b: { m: 0.2, r: 100 } }, base).length, 1, 'over 0.1 ms and over 10 %: a regression');
  assert.equal(compare(benches, { b: { m: 0.0013, r: 50 } }, base).length, 1, 'the floor applies to ms metrics only');
  assert.equal(ENFORCE_FROM, '2026-11-06');
  assert.equal(inAdvisoryWindow(new Date('2026-11-05T23:59:00')), true);
  assert.equal(inAdvisoryWindow(new Date('2026-11-06T00:01:00')), false);
  const f = fixture();
  const run = (now) => spawnSync(process.execPath, [runMjs, '--benches', f.benches, '--out', f.out, '--runs', '3', '--warmup', '0'],
    { encoding: 'utf8', env: { ...process.env, UJWALAM_BENCH_NOW: now, UJWALAM_BENCH_FAKE_NOISE: JSON.stringify(QUIET) }, windowsHide: true });
  assert.equal(run('2026-10-30').status, 0);
  assert.equal(spawnSync(process.execPath, [runMjs, '--benches', f.benches, '--out', f.out, '--runs', '3', '--warmup', '0', '--accept', 'seed'],
    { encoding: 'utf8', env: { ...process.env, UJWALAM_BENCH_FAKE_NOISE: JSON.stringify(QUIET) }, windowsHide: true }).status, 0);
  const lastPass = readFileSync(path.join(f.out, 'last-pass.json'), 'utf8');
  f.set({ ms: 80 });
  const inWindow = run('2026-10-30');
  assert.equal(inWindow.status, 0, inWindow.stdout);
  assert.match(inWindow.stdout, /^bench: advisory \(v1 window: regressions enforced from 2026-11-06\)\r?$/m);
  assert.match(inWindow.stdout, /advisory regression: fx-slow\.wall_ms/);
  assert.equal(readFileSync(path.join(f.out, 'last-pass.json'), 'utf8'), lastPass, 'baseline untouched');
  const enforced = run('2026-11-06');
  assert.equal(enforced.status, 1, enforced.stdout);
  assert.match(enforced.stdout, /REGRESSION fx-slow\.wall_ms/);
});