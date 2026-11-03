// SPDX-License-Identifier: GPL-2.0-or-later
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
  const full = steps === STEPS;
  const treeAtStart = full ? tryTree(root) : null;
  const results = await runSteps(steps, { root, log: (l) => console.log(l), tail });
  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`\nci: ${results.length - failed.length}/${results.length} passed in ${total.toFixed(1)}s`);
  if (failed.length) console.log(`ci: FAILED: ${failed.map((r) => r.name).join(', ')}`);
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
