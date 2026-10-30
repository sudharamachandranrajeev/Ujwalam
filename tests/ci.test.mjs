// SPDX-License-Identifier: GPL-2.0-or-later
// tools/ci.mjs: step selection and failure propagation. Real suites are never run here: the CLI
// tests point UJWALAM_CI_ROOT at a temp project whose npm scripts are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, runSteps, selectSteps } from '../tools/ci.mjs';

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
  spawnSync(process.execPath, [ci, ...args], { encoding: 'utf8', env: { ...process.env, UJWALAM_CI_ROOT: root } });

test('step list has every required check in order', () => {
  assert.deepEqual(STEPS.map((s) => s.name), [
    'build', 'lint', 'test', 'test-py', 'test-ocr', 'test-capture',
    'validate-registry', 'validate-outputs', 'validate-games', 'private-scan', 'legacy-verify', 'bench', 'stray-mocks',
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

test('pre-commit hook runs the private scan first, then ci, and blocks on failure', () => {
  const hook = readFileSync(path.join(repo, 'tools', 'git-hooks', 'pre-commit'), 'utf8');
  const scan = hook.indexOf('private-scan.mjs pre-commit "$@"');
  const run = hook.indexOf('tools/ci.mjs');
  assert.ok(scan >= 0 && run > scan);
  assert.match(hook, /private-scan\.mjs pre-commit "\$@" \|\| exit \$\?/);
  assert.match(hook, /exec node tools\/ci\.mjs/);
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
