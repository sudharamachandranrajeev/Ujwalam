// SPDX-License-Identifier: GPL-3.0-or-later
// tools/ci.mjs: step selection and failure propagation. Real suites are never run here: the CLI
// tests point UJWALAM_CI_ROOT at a temp project whose npm scripts are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAPTOP_ONLY, QUICK, gpuGuard, STEPS, isCloud, notRunLine, planSteps, runSteps, selectSteps, summaryLines } from '../tools/ci.mjs';
import { checkPush, hasPass, recordPass, worktreeTree } from '../tools/ci-stamp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = path.join(repo, 'tools', 'ci.mjs');
const node = (code) => ({ cmd: process.execPath, args: ['-e', code] });

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function stubRoot(scripts) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ci-'));
  dirs.push(d);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'stub', private: true, scripts }));
  return d;
}
const cli = (args, root) =>
  spawnSync(process.execPath, [ci, ...args], { encoding: 'utf8', env: { ...process.env, UJWALAM_CI_ROOT: root }, windowsHide: true });

test('step list has every required check in order', () => {
  assert.deepEqual(STEPS.map((s) => s.name), [
    'build', 'lint', 'build-host', 'build-studio', 'bench', 'test', 'test-host', 'test-py', 'test-ocr', 'test-capture',
    'validate-registry', 'validate-outputs', 'validate-games', 'private-scan', 'legacy-verify', 'stray-mocks',
  ]);
});

test('selectSteps keeps canonical order and rejects unknown names', () => {
  const all = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(selectSteps(all, 'c,a').map((s) => s.name), ['a', 'c']);
  assert.equal(selectSteps(all, null), all);
  assert.throws(() => selectSteps(all, 'a,zzz'), /unknown step.*zzz/);
});

test('runSteps continues after a failure, reports every step, keeps output', async () => {
  const lines = [];
  const res = await runSteps([
    { name: 'one', ...node('console.log("hello")') },
    { name: 'two', ...node('console.error("boom"); process.exit(3)') },
    { name: 'three', ...node('') },
    { name: 'crash', run: async () => { throw new Error('x'); } },
  ], { root: repo, log: (l) => lines.push(l) });
  assert.deepEqual(res.map((r) => [r.name, r.ok]), [['one', true], ['two', false], ['three', true], ['crash', false]]);
  assert.match(res[0].output, /hello/);
  assert.match(res[1].output, /boom/);
  assert.ok(lines.some((l) => /^one\s+PASS\s+\d+\.\ds$/.test(l)));
  assert.ok(lines.some((l) => /^two\s+FAIL/.test(l)));
  assert.ok(lines.some((l) => l.includes('| boom')));
});

test('side lanes (D276): alongside steps run beside their anchor, the next main step waits for them, order kept', async () => {
  const ev = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (name, ms, extra = {}) => ({ name, ...extra, run: async () => { ev.push(`${name}+`); await sleep(ms); ev.push(`${name}-`); return { ok: name !== 'bad', output: '' }; } });
  const res = await runSteps([
    step('a', 5), step('heavy', 120), step('s1', 20, { alongside: 'heavy' }), step('next', 5), step('bad', 30, { alongside: 'heavy' }),
    step('last', 5),
  ], { log: () => {} });
  assert.deepEqual(res.map((r) => [r.name, r.ok]), [['a', true], ['heavy', true], ['s1', true], ['next', true], ['bad', false], ['last', true]]);
  assert.ok(ev.indexOf('s1+') < ev.indexOf('heavy-'), 'side step starts while the anchor runs');
  assert.ok(ev.indexOf('s1-') < ev.indexOf('bad+'), 'side steps run one after another');
  assert.ok(ev.indexOf('next+') > Math.max(ev.indexOf('heavy-'), ev.indexOf('bad-')), 'next main step waits for anchor and lane');
  // Anchor not selected: the step runs in order on the main lane.
  ev.length = 0;
  await runSteps([step('s1', 5, { alongside: 'heavy' }), step('next', 5)], { log: () => {} });
  assert.deepEqual(ev, ['s1+', 's1-', 'next+', 'next-']);
  const side = STEPS.filter((s) => s.alongside).map((s) => s.name);
  assert.deepEqual(side, ['test-py', 'test-ocr', 'validate-registry', 'validate-outputs', 'validate-games', 'private-scan', 'legacy-verify']);
  assert.ok(STEPS.filter((s) => s.alongside).every((s) => s.alongside === 'test-host'), 'only beside the GPU host suite');
  assert.ok(!STEPS.find((s) => s.name === 'test-capture').alongside, 'test-capture encodes with NVENC: main lane');
});

test('a failed step lists its TAP "not ok" tests with the first error line', async () => {
  const tap = ['ok 1 - fine', 'not ok 2 - breaks', '  ---', "  error: 'expected 1, got 2'", '  ...', 'not ok 3 - silent', 'ok 4 - fine'].join('\\n');
  const lines = [];
  await runSteps([{ name: 't', ...node(`console.log("${tap}"); process.exit(1)`) }], { root: repo, log: (l) => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /\| failing \(2\):/);
  assert.match(text, /\| not ok 2 - breaks {2}=> 'expected 1, got 2'/);
  assert.match(text, /\| not ok 3 - silent\n/);
});

test('CLI --list prints step names and runs nothing', () => {
  const r = cli(['--list'], repo);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), STEPS.map((s) => s.name));
});

test('CLI --only with passing stubs exits 0 with a summary', () => {
  const root = stubRoot({ lint: 'node -e 0', test: 'node -e 0' });
  const r = cli(['--only', 'lint,test'], root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^lint\s+PASS/m);
  assert.match(r.stdout, /^test\s+PASS/m);
  assert.match(r.stdout, /ci: 2\/2 passed/);
});

test('CLI exits 1 on a failing step but still runs the later ones', () => {
  const root = stubRoot({ lint: 'node -e process.exit(1)', test: 'node -e 0' });
  const r = cli(['--only', 'lint,test'], root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^lint\s+FAIL/m);
  assert.match(r.stdout, /^test\s+PASS/m);
  assert.match(r.stdout, /ci: 1\/2 passed/);
  assert.match(r.stdout, /ci: FAILED: lint/);
});

test('CLI: unknown step exits 2; missing tool files fail the step', () => {
  const root = stubRoot({});
  assert.equal(cli(['--only', 'nope'], root).status, 2);
  const r = cli(['--only', 'private-scan'], root); // tools/git-hooks/private-scan.mjs absent in the stub root
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^private-scan\s+FAIL/m);
});

test('build step fails with the configure command when the build dir is missing', () => {
  const r = cli(['--only', 'build'], stubRoot({}));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /build dir missing/);
  assert.match(r.stdout, /cmake -S app\/spike -B app\/spike\/build/);
});

test('test-ocr step fails when .venv is missing', () => {
  const r = cli(['--only', 'test-ocr'], stubRoot({ 'test:ocr': 'node -e 0' }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\.venv missing/);
});

test('pre-commit hook runs the private scan first, then the quick ci steps, and blocks on failure (D190)', () => {
  const hook = readFileSync(path.join(repo, 'tools', 'git-hooks', 'pre-commit'), 'utf8');
  const scan = hook.indexOf('private-scan.mjs pre-commit "$@"');
  const run = hook.indexOf('tools/ci.mjs');
  assert.ok(scan >= 0 && run > scan);
  assert.match(hook, /private-scan\.mjs pre-commit "\$@" \|\| exit \$\?/);
  assert.match(hook, /exec node tools\/ci\.mjs --quick/);
  // Quick = no test suites; they run in the full CI that the push requires.
  assert.deepEqual(QUICK.filter((n) => /^test|bench|stray/.test(n)), []);
  for (const n of QUICK) assert.ok(STEPS.some((s) => s.name === n), n);
});

test('pre-push hook runs the private scan, then requires a full CI pass stamp, both fed the same stdin', () => {
  const hook = readFileSync(path.join(repo, 'tools', 'git-hooks', 'pre-push'), 'utf8');
  const scan = hook.indexOf('private-scan.mjs pre-push "$@" || exit $?');
  const stamp = hook.indexOf('tools/ci-stamp.mjs check');
  assert.ok(scan >= 0 && stamp > scan);
  assert.match(hook, /input=\$\(cat\)/);
  assert.equal((hook.match(/printf '%s\\n' "\$input" \|/g) ?? []).length, 2);
});

test('ci-stamp: a pass on the working tree allows exactly that content; edits and other commits are refused', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ci-stamp-'));
  dirs.push(d);
  const g = (...a) => { const r = spawnSync('git', a, { cwd: d, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('config', 'user.name', 'ci-test'); g('config', 'user.email', 'ci-test@example.invalid'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(d, '.gitignore'), 'ignored.txt\n');
  writeFileSync(path.join(d, 'a.txt'), 'one\n');
  writeFileSync(path.join(d, 'new.txt'), 'untracked\n');
  writeFileSync(path.join(d, 'ignored.txt'), 'x\n');
  const tree = worktreeTree(d);
  assert.equal(g('status', '--porcelain').includes('?? a.txt'), true, 'the real index is untouched');
  recordPass(d, tree);
  assert.equal(hasPass(d, tree), true);
  g('add', '-A'); g('commit', '-q', '-m', 'c1');
  const c1 = g('rev-parse', 'HEAD');
  assert.equal(g('rev-parse', 'HEAD^{tree}'), tree, 'committing the tested content gives the stamped tree');
  writeFileSync(path.join(d, 'ignored.txt'), 'changed\n');
  assert.equal(worktreeTree(d), tree, 'ignored files do not change the tree');
  writeFileSync(path.join(d, 'a.txt'), 'two\n');
  assert.notEqual(worktreeTree(d), tree, 'an edit changes the tree');
  g('commit', '-q', '-a', '-m', 'c2');
  const c2 = g('rev-parse', 'HEAD');
  const z = '0'.repeat(40);
  const res = checkPush(d, `refs/heads/a ${c1} refs/heads/a ${z}\nrefs/heads/b ${c2} refs/heads/b ${z}\n(delete) ${z} refs/heads/x ${c1}\n`);
  assert.deepEqual(res.map((r) => [r.ref, r.ok]), [['refs/heads/a', true], ['refs/heads/b', false]]);
  const tool = path.join(repo, 'tools', 'ci-stamp.mjs');
  const run = (input) => spawnSync(process.execPath, [tool, 'check'], { cwd: d, input, encoding: 'utf8', env: { ...process.env, UJWALAM_CI_ROOT: d }, windowsHide: true });
  assert.equal(run(`refs/heads/a ${c1} refs/heads/a ${z}\n`).status, 0);
  const bad = run(`refs/heads/b ${c2} refs/heads/b ${z}\n`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no full CI pass for tree/);
});

// Real incremental build: touch one source's mtime (content unchanged), the build step must recompile
// exactly that file, and an immediate second build must do nothing. Skipped when the spike build dir
// is not configured. Only gitignored build outputs change.
test('build step recompiles a touched source, then a second build is a no-op', { timeout: 300000 }, async (t) => {
  const { existsSync, utimesSync } = await import('node:fs');
  const { buildStep } = await import('../tools/ci.mjs');
  if (!existsSync(path.join(repo, 'app', 'spike', 'build', 'build.ninja'))) return t.skip('app/spike/build is not configured');
  await buildStep(repo); // make sure the tree is up to date first
  const src = path.join(repo, 'app', 'spike', 'src', 'scenes.cpp');
  const now = new Date();
  utimesSync(src, now, now);
  const first = await buildStep(repo);
  assert.equal(first.ok, true, first.output);
  assert.match(first.output, /Building CXX object .*scenes\.cpp\.obj/);
  assert.doesNotMatch(first.output, /Building CXX object .*host\.cpp\.obj/);
  const second = await buildStep(repo);
  assert.equal(second.ok, true, second.output);
  assert.match(second.output, /no work to do/);
  assert.doesNotMatch(second.output, /Building CXX object/);
});

// Benchmarks are advisory on a noisy machine: exit 0 and the step shows the reasons; a quiet failure still fails.
test('bench step: a noisy advisory run passes CI and shows "advisory (noisy: ...)"; a quiet failure fails', async () => {
  const advisory = STEPS.find((s) => s.name === 'bench').advisory;
  assert.ok(advisory instanceof RegExp);
  const lines = [];
  const noisy = node("console.log('bench: advisory (noisy: on battery power; MsMpEng (Windows Defender) uses 8 % CPU before start)'); console.log('bench: advisory regression: x.y 1.00 -> 2.00 ms (100.0 % worse)')");
  const quietFail = node("console.log('bench: REGRESSION x.y: 1.00 -> 2.00 ms (100.0 % worse, limit 10 %)'); process.exit(1)");
  const quietPass = node("console.log('bench: PASS')");
  const r = await runSteps([{ name: 'noisy', ...noisy, advisory }, { name: 'qfail', ...quietFail, advisory }, { name: 'qpass', ...quietPass, advisory }], { log: (l) => lines.push(l) });
  assert.deepEqual(r.map((x) => x.ok), [true, false, true]);
  assert.match(r[0].advisory, /^advisory \(noisy: on battery power; MsMpEng/);
  assert.equal(r[1].advisory, null);
  assert.equal(r[2].advisory, null);
  assert.match(lines[0], /^noisy +ADVISORY .*advisory \(noisy: on battery power; MsMpEng/);
  assert.ok(lines.some((l) => /advisory regression: x\.y/.test(l)), 'regressions are listed under the step');
  assert.ok(lines.some((l) => /^qfail +FAIL/.test(l)));
  assert.ok(lines.some((l) => /^qpass +PASS/.test(l)));
});

test('isCloud: only UJWALAM_CI_ENV=cloud or GITHUB_ACTIONS=true', () => {
  assert.equal(isCloud({}), false);
  assert.equal(isCloud({ UJWALAM_CI_ENV: 'cloud' }), true);
  assert.equal(isCloud({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isCloud({ UJWALAM_CI_ENV: 'laptop', GITHUB_ACTIONS: 'false' }), false);
});

test('LAPTOP_ONLY names real steps; node-only steps stay in the cloud run', () => {
  const names = STEPS.map((s) => s.name);
  for (const k of Object.keys(LAPTOP_ONLY)) { assert.ok(names.includes(k), k); assert.ok(LAPTOP_ONLY[k].length > 10); }
  for (const k of ['lint', 'test', 'validate-outputs', 'validate-games', 'stray-mocks']) assert.ok(!(k in LAPTOP_ONLY), k);
});


test('planSteps: laptop mode runs every step; cloud mode drops the laptop-only ones with reasons', () => {
  const lap = planSteps(STEPS, false);
  assert.equal(lap.run, STEPS);
  assert.deepEqual(lap.skipped, []);
  const cl = planSteps(STEPS, true);
  assert.deepEqual(cl.run.map((s) => s.name), ['lint', 'test', 'validate-outputs', 'validate-games', 'stray-mocks']);
  assert.equal(cl.run.length + cl.skipped.length, STEPS.length);
  assert.match(notRunLine(cl.skipped[0]), /^build\s+NOT RUN \(laptop only: .+\)$/);
});

test('summaryLines: cloud counts not-run apart and is never stampable; laptop output is unchanged', () => {
  const ok = [{ name: 'a', ok: true }, { name: 'b', ok: false }];
  assert.deepEqual(summaryLines({ results: ok, seconds: 1 }), ['ci: 1/2 passed in 1.0s', 'ci: FAILED: b']);
  const c = summaryLines({ results: [{ name: 'a', ok: true }], skipped: [{ name: 'x', reason: 'r' }], cloud: true });
  assert.match(c[0], /^ci: 1\/1 passed/);
  assert.ok(c.some((l) => /1 step\(s\) NOT RUN.*: x$/.test(l)));
  assert.ok(c.some((l) => /not stampable/.test(l)));
});

test('CLI cloud mode: reports NOT RUN, exit depends on steps that ran, writes no stamp', () => {
  const root = stubRoot({ lint: 'node -e "0"' });
  const r = spawnSync(process.execPath, [ci, '--only', 'lint,build-host'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UJWALAM_CI_ROOT: root, UJWALAM_CI_ENV: 'cloud' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /build-host\s+NOT RUN \(laptop only: /);
  assert.match(r.stdout, /1\/1 passed/);
  assert.match(r.stdout, /not stampable/);
  assert.doesNotMatch(r.stdout, /stamped/);
});

test('CLI cloud mode: a failing step that ran still exits 1', () => {
  const root = stubRoot({ lint: 'node -e "process.exit(1)"' });
  const r = spawnSync(process.execPath, [ci, '--only', 'lint'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UJWALAM_CI_ROOT: root, GITHUB_ACTIONS: 'true' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAILED: lint/);
});

test('GPU steps are refused while an installed Ujwalam runs (2026-11-12 GPU reset)', () => {
  const busy = () => [{ pid: 42, name: 'ujwalam-host.exe' }];
  const none = () => [];
  const msg = gpuGuard(STEPS, false, busy);
  assert.match(msg, /refused/);
  assert.match(msg, /test-host/);
  assert.match(msg, /pid 42/);
  assert.equal(gpuGuard(STEPS, false, none), null);
  assert.equal(gpuGuard(STEPS, true, busy), null, 'cloud runs have no GPU steps');
  assert.equal(gpuGuard(STEPS, false, busy, { UJWALAM_CI_ALLOW_GPU: '1' }), null, 'the user override');
  assert.match(gpuGuard(STEPS, false, () => null, {}), /could not check/, 'a failed check is never read as free');
  assert.equal(gpuGuard(selectSteps(STEPS, 'lint,test-py'), false, busy), null, 'CPU-only steps still run');
});
