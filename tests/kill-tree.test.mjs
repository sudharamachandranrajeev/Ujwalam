// SPDX-License-Identifier: GPL-3.0-or-later
// Nothing runs on after Ujwalam closes (user 2026-11-09, D311 proposed). A clip job is a process tree (Python, then
// ffmpeg). These tests start a real two-process tree (tools/mock/clip-tree.mjs: parent + child, like clipper.py and
// ffmpeg) and check with tools/stray-procs.mjs that nothing of it is left:
//   - the old way (child.kill(), TerminateProcess on Windows) leaves the child running: the root cause;
//   - record-clips stop() (Ujwalam closing) and a stream starting (pause for live) end the whole tree;
//   - killTree's own contract (Windows taskkill /T /F by absolute path, no window; already gone counts as ended).
// The clipper's own half (it ends itself and its ffmpeg when the launcher's pipe closes) is in tests/py.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { killChildTree, killTree } from '../services/common/kill-tree.mjs';
import { STOP_TASKS_FILE, createRecordClips } from '../services/studio-ui/record-clips.mjs';
import { writeSettings } from '../services/studio-ui/user-settings.mjs';
import { findStrays, listNodeProcesses } from '../tools/stray-procs.mjs';

const TREE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'mock', 'clip-tree.mjs');
const win = process.platform === 'win32';
const treeProcs = () => findStrays(listNodeProcesses()).filter((s) => s.script === 'tools/mock/clip-tree.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); }
}
/** Starts the tree with the given spawn options; resolves { parent, childPid } once the child is up. */
function startTree(opts = {}) {
  return new Promise((resolve, reject) => {
    const parent = spawn(process.execPath, [TREE], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, ...opts });
    let err = '';
    parent.stderr.on('data', (d) => { err += d; const m = /clip-tree ready (\d+)/.exec(err); if (m) resolve({ parent, childPid: Number(m[1]) }); });
    parent.once('error', reject);
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('root cause: a plain kill of the job ends only the parent; its child (ffmpeg in a real job) runs on', { skip: !win && 'Windows behaviour' }, async () => {
  const { parent, childPid } = await startTree();
  try {
    parent.kill();
    await new Promise((r) => parent.once('exit', r));
    await sleep(500);
    assert.equal(alive(childPid), true, 'the child outlived its parent: the stray the user saw working after close');
    assert.ok(treeProcs().some((s) => s.pid === childPid), 'tools/stray-procs.mjs lists it');
  } finally { killTree(childPid); }
  assert.ok(await waitFor(() => !alive(childPid)), 'cleaned up');
});

test('killChildTree ends the parent and its child; nothing is left for stray-procs to find', async () => {
  const { parent, childPid } = await startTree();
  assert.equal(killChildTree(parent), true);
  await new Promise((r) => (parent.exitCode !== null ? r() : parent.once('exit', r)));
  assert.ok(await waitFor(() => !alive(childPid)), 'child ended with its parent');
  assert.ok(await waitFor(() => treeProcs().length === 0), `strays: ${JSON.stringify(treeProcs())}`);
  assert.equal(killChildTree(parent), true, 'already gone: counts as ended');
});

function clipSetup() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-kt-'));
  const root = path.join(d, 'repo');
  mkdirSync(path.join(root, 'services', 'clip'), { recursive: true });
  mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'clip', 'clipper.py'), '');
  writeFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), '');
  const rec = path.join(d, 'rec');
  mkdirSync(rec);
  const h = path.join(rec, 'practice-h-1.mkv'); const v = path.join(rec, 'practice-v-1.mkv');
  writeFileSync(h, ''); writeFileSync(v, '');
  const dataDir = path.join(d, 'core');
  mkdirSync(dataDir);
  writeSettings(dataDir, { clips: { recording: 'after', live: 'off' } });
  const spawned = [];
  // The clip job's spawn as record-clips makes it (its options unchanged), with the tree stand-in instead of Python.
  const spawnFn = (exe, argv, o) => { const c = spawn(process.execPath, [TREE], { ...o, windowsHide: true }); /* the test asserts o.windowsHide too */ spawned.push({ exe, argv, o, c }); return c; };
  const S = (state, stream = 'stopped') => ({ rungs: [{ id: 'rec-h', canvas: 'H' }, { id: 'rec-v', canvas: 'V' }], sinks: [
    { id: 'practice-h', kind: 'record', rung: 'rec-h', state, path: h }, { id: 'practice-v', kind: 'record', rung: 'rec-v', state, path: v },
    { id: 'yt', kind: 'stream', rung: 'rec-h', state: stream }] });
  return { d, root, dataDir, spawned, spawnFn, S };
}
const childOf = async (c) => waitFor(() => treeProcs().find((s) => s.pid !== c.pid && listNodeProcesses().find((p) => p.pid === s.pid)?.parentPid === c.pid)?.pid);

test('record-clips: closing Ujwalam (stop) ends the clip job\'s whole tree; it gets the parent pipe and no window', async () => {
  const s = clipSetup();
  try {
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: () => {}, spawnFn: s.spawnFn });
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    const { o, c } = s.spawned[0];
    assert.equal(o.windowsHide, true);
    assert.equal(o.stdio[0], 'pipe', 'stdin is the parent pipe');
    assert.equal(o.env.UJWALAM_PARENT_PIPE, '1');
    const kid = await childOf(c);
    assert.ok(kid, 'the job started its child');
    rc.stop();
    assert.ok(await waitFor(() => !alive(kid) && !alive(c.pid)), 'parent and child ended');
    assert.ok(await waitFor(() => treeProcs().length === 0), `strays: ${JSON.stringify(treeProcs())}`);
  } finally { for (const x of s.spawned) killChildTree(x.c); rmSync(s.d, { recursive: true, force: true }); }
});

test('record-clips: a stream that starts pauses the job by ending its whole tree (no ffmpeg encoding while live)', async () => {
  const s = clipSetup();
  try {
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: () => {}, spawnFn: s.spawnFn });
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    const { c } = s.spawned[0];
    const kid = await childOf(c);
    assert.ok(kid);
    rc.feed(s.S('stopped', 'live'));
    assert.ok(await waitFor(() => !alive(kid) && !alive(c.pid)), 'parent and child ended while live');
    rc.stop();
    assert.ok(await waitFor(() => treeProcs().length === 0), `strays: ${JSON.stringify(treeProcs())}`);
  } finally { for (const x of s.spawned) killChildTree(x.c); rmSync(s.d, { recursive: true, force: true }); }
});

test('killTree contract: Windows runs System32 taskkill /T /F /PID hidden; 128 (no such process) counts as ended; bad pids refused', () => {
  const calls = [];
  const ok = killTree(4321, { platform: 'win32', spawnSyncFn: (exe, args, o) => { calls.push({ exe, args, o }); return { status: 128 }; }, kill: () => { throw new Error('not reached'); } });
  assert.equal(ok, true);
  assert.match(calls[0].exe, /System32[\\/]taskkill\.exe$/i);
  assert.deepEqual(calls[0].args, ['/T', '/F', '/PID', '4321']);
  assert.equal(calls[0].o.windowsHide, true);
  const fallback = [];
  assert.equal(killTree(55, { platform: 'win32', spawnSyncFn: () => ({ status: 1 }), kill: (pid, sig) => fallback.push([pid, sig]) }), true, 'taskkill failed: plain kill');
  assert.deepEqual(fallback, [[55, 'SIGKILL']]);
  const posix = [];
  assert.equal(killTree(77, { platform: 'linux', kill: (pid, sig) => posix.push([pid, sig]) }), true);
  assert.deepEqual(posix, [[-77, 'SIGKILL']], 'its process group elsewhere');
  for (const bad of [0, -1, 1.5, null, '12']) assert.equal(killTree(bad), false);
});

test('an exited child is never targeted, also when a signal ended it (exitCode null, signalCode set): its PID may be reused', async () => {
  const calls = [];
  const opts = { platform: 'win32', spawnSyncFn: (...a) => { calls.push(a); return { status: 0 }; }, kill: (...a) => calls.push(a) };
  for (const gone of [{ pid: 4242, exitCode: null, signalCode: 'SIGTERM' }, { pid: 4242, exitCode: 0, signalCode: null }, { pid: 4242, exitCode: null, signalCode: 'SIGKILL', kill: () => calls.push('kill') }]) {
    assert.equal(killChildTree(gone, opts), true, 'already ended');
  }
  assert.deepEqual(calls, [], 'no taskkill, no kill on a PID that is not ours any more');
  // the real case: child.kill() ends it with a signal; Node reports exitCode null, signalCode SIGTERM
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => c.once('spawn', r));
  c.kill();
  await new Promise((r) => c.once('exit', r));
  assert.equal(c.exitCode, null);
  assert.equal(c.signalCode, 'SIGTERM');
  assert.equal(killChildTree(c, opts), true);
  assert.deepEqual(calls, [], 'the exited child was not targeted');
  // still running: targeted
  assert.equal(killChildTree({ pid: 4243, exitCode: null, signalCode: null }, opts), true);
  assert.equal(calls.length, 1);
});

test('record-clips: Stop all while live or recording (D311 proposed) ends the clip job\'s whole tree, keeps it for the next start, and starts nothing new', async () => {
  const s = clipSetup();
  try {
    const rc = createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: () => {}, spawnFn: s.spawnFn });
    // a leftover request from before this launcher started is ignored
    mkdirSync(path.join(s.dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(s.dataDir, 'clips', STOP_TASKS_FILE), JSON.stringify({ atMs: Date.now() - 60_000 }));
    rc.feed(s.S('live')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'the stale request did not stop it');
    const { c } = s.spawned[0];
    const kid = await childOf(c);
    assert.ok(kid);
    writeFileSync(path.join(s.dataDir, 'clips', STOP_TASKS_FILE), JSON.stringify({ atMs: Date.now() }));
    rc.feed(s.S('stopped'));
    assert.ok(await waitFor(() => !alive(kid) && !alive(c.pid)), 'parent and child ended');
    assert.ok(await waitFor(() => treeProcs().length === 0), `strays: ${JSON.stringify(treeProcs())}`);
    const tdir = path.join(s.dataDir, 'tasks');
    const t = readdirSync(tdir).map((n) => JSON.parse(readFileSync(path.join(tdir, n), 'utf8'))).find((x) => x.kind === 'clips');
    assert.deepEqual([t.state, t.note], ['failed', 'Stopped by you; it runs again at the next start'], 'the tray sees it end');
    rc.feed(s.S('stopped')); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'nothing new started in this session');
    const st = JSON.parse(readFileSync(path.join(s.dataDir, 'clips', 'status.json'), 'utf8'));
    assert.ok(st.running, 'the job is kept in the status: the next start runs it again');
    assert.equal(st.state, 'queued');
    rc.stop();
  } finally { for (const x of s.spawned) killChildTree(x.c); rmSync(s.d, { recursive: true, force: true }); }
});
