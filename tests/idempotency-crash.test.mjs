// SPDX-License-Identifier: GPL-2.0-or-later
// Idempotency kill test (P3 E7 follow-up): a real child process is killed (taskkill /F on Windows, SIGKILL elsewhere)
// at each phase of a keyed action, restarted on the same database, and the same platform message is resent.
// Asserts the documented bound: the action never runs twice; a kill between the durable start marker and the
// execute call loses it (0 runs, counted as ambiguous). Child: tools/idem-crash-child.mjs. Temp dirs only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { stopTracked, track } from '../tools/proc-registry.mjs';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(repo, 'tools', 'idem-crash-child.mjs');
const dirs = [];
// Kill any child a failed or timed-out test left running before the temp dirs go; the runner can then always end.
after(async () => { await stopTracked(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

function start(args) {
  const p = track(spawn(process.execPath, [CHILD, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  let out = '';
  let err = '';
  const waiters = [];
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', (d) => { out += d; for (const w of [...waiters]) w(); });
  p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal })));
  const line = (re, ms = 20000) => new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`timeout waiting for ${re}; stdout=${out.slice(-300)} stderr=${err.slice(-300)}`)), ms);
    const chk = () => { const m = re.exec(out); if (m) { clearTimeout(t); waiters.splice(waiters.indexOf(chk), 1); ok(m); } };
    waiters.push(chk);
    chk();
  });
  return { p, line, exited, err: () => err };
}

function hardKill(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `taskkill failed: ${r.stdout} ${r.stderr}`);
  } else process.kill(pid, 'SIGKILL');
}

async function resend(dataDir, execLog) {
  const c = start([dataDir, execLog, 'resend']);
  const m = await c.line(/^RESULT (.+)$/m);
  const ex = await c.exited;
  assert.equal(ex.code, 0, c.err());
  return JSON.parse(m[1]);
}
const runs = (execLog) => (existsSync(execLog) ? readFileSync(execLog, 'utf8').split('\n').filter(Boolean) : []);

// phase -> expected runs after kill + restart + resend, and how the resend was handled
const CASES = [
  { phase: 'before-start', runs: 1, resend: 'executed' },
  { phase: 'after-start', runs: 0, resend: 'skippedAmbiguous' }, // documented residual window: the action is lost
  { phase: 'after-execute', runs: 1, resend: 'skippedAmbiguous' },
  { phase: 'after-done', runs: 1, resend: 'skipped' }, // completed if the done marker committed before the kill, else ambiguous
];

for (const c of CASES) {
  test(`kill at ${c.phase}: restart and resend -> ran ${c.runs} time(s), never twice`, { timeout: 60000 }, async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'evidemk-'));
    dirs.push(dataDir);
    const execLog = path.join(dataDir, 'exec.log');
    const k = start([dataDir, execLog, 'kill', c.phase]);
    await k.line(new RegExp(`^PHASE ${c.phase}$`, 'm'));
    hardKill(k.p.pid);
    const ex = await k.exited;
    assert.notEqual(ex.code, 0); // killed, not a clean exit
    const before = runs(execLog).length;
    assert.equal(before, c.phase === 'before-start' || c.phase === 'after-start' ? 0 : 1);

    const r = await resend(dataDir, execLog);
    const all = runs(execLog);
    assert.equal(all.length, c.runs, `exec log: ${all.length} runs`);
    assert.ok(all.length <= 1);
    if (all.length) assert.match(all[0], /^[0-9a-f]{64}$/);
    if (c.resend === 'executed') assert.deepEqual([r.executed, r.dispatch.result], [1, 'ran']);
    if (c.resend === 'skippedAmbiguous') assert.deepEqual([r.executed, r.skippedAmbiguous, r.load.ambiguous, r.dispatch.ok, r.dispatch.skipped], [0, 1, 1, false, 'ambiguous']);
    if (c.resend === 'skipped') { assert.equal(r.executed, 0); assert.equal(r.dispatch.ok, false); assert.ok(['completed', 'ambiguous'].includes(r.dispatch.skipped)); }

    // A second clean restart and resend never runs it again.
    const r2 = await resend(dataDir, execLog);
    assert.equal(runs(execLog).length, c.runs);
    assert.equal(r2.executed, 0);
  });
}

test('no kill: clean run, restart, resend -> ran once, the resend is skipped as completed', { timeout: 60000 }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'evidemk-'));
  dirs.push(dataDir);
  const execLog = path.join(dataDir, 'exec.log');
  const r1 = await resend(dataDir, execLog);
  assert.deepEqual([r1.executed, r1.startDurable, r1.dispatch.result], [1, 1, 'ran']);
  const r2 = await resend(dataDir, execLog);
  assert.deepEqual([r2.executed, r2.skippedCompleted, r2.dispatch.ok, r2.dispatch.skipped], [0, 1, false, 'completed']);
  assert.equal(runs(execLog).length, 1);
});
