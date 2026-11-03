// SPDX-License-Identifier: GPL-2.0-or-later
// Child-process teardown (v1 test cleanup): a hung or abandoned child is killed with its whole tree, waits never hang,
// and a replay run that fails part-way leaves no child and no mock behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllMocks, openMocks } from '../tools/mock/mock-streamerbot.mjs';
import { main } from '../tools/soak/replay.mjs';
import { childPids, killTree, openChildren, stopTracked, track, waitExit } from '../tools/proc-registry.mjs';

const dirs = [];
test.after(async () => { await stopTracked(); await closeAllMocks(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, ms = 10000) => { const t0 = Date.now(); while (alive(pid) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

// A parent that starts a grandchild and prints its pid, then both sleep for a long time.
const TREE = "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); console.log('G ' + g.pid); setInterval(()=>{},1000);";

async function startTree() {
  const p = track(spawn(process.execPath, ['-e', TREE], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
  const gpid = await new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /G (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    p.once('exit', () => reject(new Error('tree parent exited early')));
  });
  return { p, gpid };
}

test('waitExit: a child that never exits is killed with its descendants after the timeout, and the wait ends', async () => {
  const { p, gpid } = await startTree();
  assert.equal(alive(gpid), true);
  const r = await waitExit(p, 400);
  assert.equal(r.timedOut, true);
  assert.equal(await waitGone(gpid), true, 'the grandchild must die with its parent');
  assert.equal(openChildren(), 0);
});

test('waitExit: a child that exits normally reports its code without a timeout', async () => {
  const p = track(spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore', windowsHide: true }));
  const r = await waitExit(p, 20000);
  assert.deepEqual([r.code, r.timedOut], [3, false]);
});

test('stopTracked: kills every registered child still alive (what a failed test leaves behind), including grandchildren', async () => {
  const a = await startTree(); const b = await startTree();
  assert.equal(openChildren(), 2);
  assert.equal(await stopTracked(), 2);
  assert.equal(await waitGone(a.gpid) && await waitGone(b.gpid), true);
  assert.equal(openChildren(), 0);
  assert.equal(await stopTracked(), 0);
});

test('a replay run that fails after starting its mock leaves no mock and no child behind', { timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evproc-')); dirs.push(root);
  mkdirSync(path.join(root, 'chat', 'twitch'), { recursive: true });
  writeFileSync(path.join(root, 'chat', 'twitch', 'x.json'), JSON.stringify({ video: { length: 9000 }, comments: [{ _id: 's1', content_offset_seconds: 50, commenter: { _id: 'c-t', name: 'tester', display_name: 'tester' }, message: { body: 'synthetic message alpha' } }] }));
  // The core child is killed as soon as it is registered (a crash during start-up), after the mock is already listening.
  // The run lasts 60 s so it cannot finish on its own before the kill lands: with 2 s, a loaded machine (2026-11-03,
  // system CPU 56 %) let the run complete first and the expected rejection never came. The kill ends it in seconds.
  const run = main(['--data-root', root, '--speed', '10', '--duration-s', '60', '--sample-s', '1', '--run-id', 'unit-fail', '--quiet', '--no-system-probe']);
  const failed = assert.rejects(run);
  const t0 = Date.now();
  while (openChildren() === 0 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 5));
  assert.equal(openMocks(), 1, 'the run started its mock first');
  // killed the way a crash would be, not through stopTracked (which is the cleanup under test)
  for (const pid of childPids()) killTree(pid);
  await failed;
  assert.equal(openMocks(), 0, 'the mock must be closed');
  assert.equal(openChildren(), 0, 'the core child must be gone');
});
