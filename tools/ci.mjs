// SPDX-License-Identifier: GPL-3.0-or-later
// Local CI (P3 E0). Runs every standing check in order, continues after a failure so the summary is
// complete, exits 1 if any step failed. Stdlib only.
// Usage: node tools/ci.mjs [--only step,step | --quick] [--list] [--tail N]
//   UJWALAM_CI_ROOT overrides the repo root (tests use it with stub projects).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStrays, strayReport } from './stray-procs.mjs';
import { recordPass, worktreeTree } from './ci-stamp.mjs';

const tryTree = (root) => { try { return worktreeTree(root); } catch { return null; } };

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIGURE_HINT = [
  'configure once from a VS 2022 Build Tools x64 developer prompt (docs/evidence/2026-10-27-p1a-build.md):',
  '  cmake -S app/spike -B app/spike/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo',
  '    -DOBS_SOURCE_DIR=<obs-src> -DOBS_RUNTIME_DIR=<obs-runtime>',
].join('\n');

// A step is { name, cmd, args } (run in the repo root) or { name, run(root) -> Promise<{ok, output}> }.
const npmRun = (name, script) => ({ name, cmd: 'npm', args: ['run', script, '--silent'], shell: true });

function hasOnPath(exe) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

// cmake and cl are usually only on PATH inside a developer prompt. If they are missing, find
// vcvars64.bat through vswhere and run the build inside it.
function findVcvars() {
  const pf = process.env['ProgramFiles(x86)'];
  if (!pf) return null;
  const vswhere = path.join(pf, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  const dir = r.stdout.trim().split(/\r?\n/)[0];
  if (!dir) return null;
  const bat = path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return existsSync(bat) ? bat : null;
}

export async function buildStep(root) {
  const buildDir = path.join(root, 'app', 'spike', 'build');
  if (!existsSync(path.join(buildDir, 'build.ninja')) && !existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
    return { ok: false, output: `build dir missing: app/spike/build\n${CONFIGURE_HINT}\n` };
  }
  let r;
  if (hasOnPath('cmake') && hasOnPath('cl')) {
    r = spawnSync('cmake', ['--build', 'app/spike/build'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  } else {
    const bat = findVcvars();
    if (!bat) return { ok: false, output: `cmake or the MSVC environment not found (no developer prompt, no vswhere).\n${CONFIGURE_HINT}\n` };
    // cmd /s /c "…" keeps the inner quotes intact.
    const line = `"call "${bat}" >nul && cmake --build app/spike/build"`;
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`;
  return { ok: r.status === 0, output: r.status === 0 ? output : `${output}\n${CONFIGURE_HINT}\n` };
}

async function testOcrStep(root) {
  if (!existsSync(path.join(root, '.venv', 'Scripts', 'python.exe')) && !existsSync(path.join(root, '.venv', 'bin', 'python'))) {
    return { ok: false, output: '.venv missing: create it from services/clip/requirements-ocr.lock.txt (see docs/evidence/2026-10-27-p2a-a1-python-wheels.md)\n' };
  }
  return runCommand({ cmd: 'npm', args: ['run', 'test:ocr', '--silent'], shell: true }, root);
}

export const STEPS = [
  { name: 'build', run: buildStep },
  { name: 'lint', cmd: 'npm', args: ['run', 'lint', '--silent'], shell: true },
  npmRun('build-host', 'build:host'),
  npmRun('test', 'test'),
  // Host suite after the main tests, never in parallel with them: it starts libobs and NVENC (one heavy GPU job, D100).
  npmRun('test-host', 'test:host'),
  npmRun('test-py', 'test:py'),
  { name: 'test-ocr', run: testOcrStep },
  npmRun('test-capture', 'test:capture'),
  npmRun('validate-registry', 'validate:registry'),
  npmRun('validate-outputs', 'validate:outputs'),
  npmRun('validate-games', 'validate:games'),
  { name: 'private-scan', cmd: process.execPath, args: ['tools/git-hooks/private-scan.mjs', 'scan-worktree'] },
  npmRun('legacy-verify', 'legacy:verify'),
  // Benchmarks fail CI only on a QUIET machine. On a noisy one the bench prints "bench: advisory (noisy: ...)", exits 0,
  // and the step shows as advisory with the reasons (regressions are listed in its output). Until ENFORCE_FROM in
  // tools/bench/run.mjs (v1 window) a quiet-run regression is advisory too: "bench: advisory (v1 window: ...)".
  { ...npmRun('bench', 'bench'), advisory: /^bench: (advisory \((?:noisy|v1 window): .*\))\r?$/m },
  // Last: no test mock or soak helper may outlive the run. Fails and names the pid when one does.
  { name: 'stray-mocks', run: async () => { const s = scanStrays(); return { ok: s.length === 0, output: `${strayReport(s)}
` }; } },
];

// Cloud mode (GitHub Actions, D202): UJWALAM_CI_ENV=cloud or GITHUB_ACTIONS=true. A hosted runner has none of the
// laptop-only inputs below, so those steps are reported NOT RUN (never PASS), counted apart, and the exit status depends
// only on the steps that ran. Cloud mode never writes the push stamp (D190: only a full laptop pass may stamp a push).
export const isCloud = (env = process.env) => env.UJWALAM_CI_ENV === 'cloud' || env.GITHUB_ACTIONS === 'true';

export const LAPTOP_ONLY = {
  build: 'needs the MSVC + libobs spike build dir (app/spike/build) and the OBS source tree',
  'build-host': 'needs the OBS runtime and source paths from app/host/host.local.json (vendored OBS, not in the repo)',
  'test-host': 'starts the libobs host with NVENC on the GPU; no GPU or OBS runtime on the runner',
  'test-py': 'needs the OCR venv packages (numpy, opencv, rapidocr, onnxruntime); no .venv on the runner',
  'test-ocr': 'needs .venv (RapidOCR and onnxruntime wheels)',
  'test-capture': 'needs a capture device and the .venv',
  'validate-registry': 'presets name legacySource files that must exist under legacy/ (gitignored, never pushed)',
  'private-scan': 'needs data/profile.local.json (gitignored private terms); fails closed without it',
  'legacy-verify': 'needs legacy/ (gitignored, never pushed)',
  bench: 'timings on a shared runner are meaningless; baselines are laptop-only (out/bench)',
};

/** Split steps for cloud mode. Returns { run, skipped: [{name, reason}] }. Laptop mode (cloud false): everything runs. */
export function planSteps(steps, cloud) {
  if (!cloud) return { run: steps, skipped: [] };
  return {
    run: steps.filter((s) => !(s.name in LAPTOP_ONLY)),
    skipped: steps.filter((s) => s.name in LAPTOP_ONLY).map((s) => ({ name: s.name, reason: LAPTOP_ONLY[s.name] })),
  };
}

export const notRunLine = (s) => `${s.name.padEnd(18)} NOT RUN (laptop only: ${s.reason})`;

/** Summary lines. Cloud adds the not-run count and states that the run is not stampable. */
export function summaryLines({ results, skipped = [], cloud = false, seconds = 0 }) {
  const failed = results.filter((r) => !r.ok);
  const lines = [`ci: ${results.length - failed.length}/${results.length} passed in ${seconds.toFixed(1)}s`];
  if (cloud) lines.push(`ci: cloud mode: ${skipped.length} step(s) NOT RUN (laptop only): ${skipped.map((s) => s.name).join(', ') || 'none'}`);
  if (failed.length) lines.push(`ci: FAILED: ${failed.map((r) => r.name).join(', ')}`);
  if (cloud) lines.push('ci: cloud run is not stampable (only a full laptop pass may stamp a push, D190)');
  return lines;
}

// D190 batching: the pre-commit hook runs only these (about 30 s). The full list runs about once an hour and before a
// push; a full pass on an unchanged tree writes the stamp that the pre-push hook requires (tools/ci-stamp.mjs).
export const QUICK = ['build', 'lint', 'build-host', 'validate-registry', 'validate-outputs', 'validate-games', 'private-scan', 'legacy-verify'];

function runCommand(step, root) {
  return new Promise((resolve) => {
    // With a shell, pass one command line (fixed, repo-owned strings) instead of an args array.
    const p = step.shell
      ? spawn([step.cmd, ...step.args].join(' '), { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawn(step.cmd, step.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    p.stdout.on('data', (d) => (output += d));
    p.stderr.on('data', (d) => (output += d));
    p.on('error', (e) => resolve({ ok: false, output: `${output}${e.message}\n` }));
    p.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/** Run steps in order. Returns [{name, ok, seconds, output}]. Never throws on a step failure. */
export async function runSteps(steps, { root = HERE, log = () => {}, tail = 30 } = {}) {
  const results = [];
  for (const step of steps) {
    const t0 = performance.now();
    let res;
    try {
      res = step.run ? await step.run(root) : await runCommand(step, root);
    } catch (e) {
      res = { ok: false, output: `step crashed: ${e.message}\n` };
    }
    const seconds = (performance.now() - t0) / 1000;
    const adv = res.ok && step.advisory ? step.advisory.exec(res.output) : null;
    results.push({ name: step.name, ok: res.ok, seconds, output: res.output, advisory: adv ? adv[1] : null });
    log(`${step.name.padEnd(18)} ${res.ok ? (adv ? 'ADVISORY' : 'PASS') : 'FAIL'}  ${seconds.toFixed(1)}s${adv ? `  ${adv[1]}` : ''}`);
    if (adv) {
      const regs = res.output.split(/\r?\n/).filter((l) => /advisory regression:/.test(l));
      if (regs.length) log(regs.slice(0, tail).map((l) => `    | ${l}`).join('\n'));
    }
    if (!res.ok) {
      const lines = res.output.trimEnd().split(/\r?\n/);
      // TAP "not ok" lines name the failing tests; the tail alone often shows only the summary.
      // Each one is followed by its YAML block; its first `error:` line says why (one line, cut at 200 chars).
      const notOk = [];
      lines.forEach((l, i) => {
        if (!/^\s*not ok \d+ /.test(l)) return;
        let why = '';
        for (let j = i + 1; j < Math.min(lines.length, i + 40) && !/^\s*(not )?ok \d+ /.test(lines[j]); j++) {
          const m = /^\s+error: (.*)$/.exec(lines[j]);
          if (m) { why = m[1].trim().slice(0, 200); break; }
        }
        notOk.push(why ? `${l.trim()}  => ${why}` : l.trim());
      });
      if (notOk.length) log([`    | failing (${notOk.length}):`, ...notOk.slice(0, 200).map((l) => `    | ${l}`)].join('\n'));
      log(lines.slice(-tail).map((l) => `    | ${l}`).join('\n'));
    }
  }
  return results;
}

/** Pick steps by name (comma list). Unknown names throw. Order stays the canonical order. */
export function selectSteps(all, only) {
  if (!only) return all;
  const names = only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !all.some((s) => s.name === n));
  if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(', ')} (see --list)`);
  return all.filter((s) => names.includes(s.name));
}

async function main() {
  const argv = process.argv.slice(2);
  let only = null;
  let tail = 30;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only = argv[++i];
    else if (argv[i] === '--quick') only = QUICK.join(',');
    else if (argv[i] === '--list') list = true;
    else if (argv[i] === '--tail') tail = Number(argv[++i]);
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  if (list) { for (const s of STEPS) console.log(s.name); return; }
  let steps;
  try { steps = selectSteps(STEPS, only); } catch (e) { console.error(e.message); process.exit(2); }
  const root = process.env.UJWALAM_CI_ROOT ? path.resolve(process.env.UJWALAM_CI_ROOT) : HERE;
  // Every step and its children run headless: the host opens no preview window, the launcher no browser (D191).
  process.env.UJWALAM_HEADLESS = '1';
  const cloud = isCloud();
  const plan = planSteps(steps, cloud);
  const full = !cloud && steps === STEPS;
  steps = plan.run;
  for (const s of plan.skipped) console.log(notRunLine(s));
  const treeAtStart = full ? tryTree(root) : null;
  const results = await runSteps(steps, { root, log: (l) => console.log(l), tail });
  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`\n${summaryLines({ results, skipped: plan.skipped, cloud, seconds: total }).join('\n')}`);
  if (full && !failed.length) {
    const treeAtEnd = tryTree(root);
    if (treeAtStart && treeAtStart === treeAtEnd) {
      recordPass(root, treeAtStart);
      console.log(`ci: full pass stamped for tree ${treeAtStart.slice(0, 12)} (a push of a commit with this content is allowed)`);
    } else {
      console.log('ci: no pass stamp: files changed during the run (or not a git work tree); run again on an unchanged tree before pushing');
    }
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
