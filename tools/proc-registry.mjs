// SPDX-License-Identifier: GPL-2.0-or-later
// Child-process teardown for tests and soak tools (v1 test cleanup). Stdlib only.
//
// Why: a test that spawns a child and then fails, times out or throws before its own cleanup leaves that child alive.
// The child's stdio pipes keep the test file's process alive, so the runner never finishes and the whole tree stays for
// hours. Every spawn site registers its child here; teardown kills the whole process tree, and a last-resort 'exit'
// hook kills whatever is still registered when this process ends.
//
//   const child = track(spawn(...));            // registered until it exits
//   const r = await waitExit(child, 30000);     // { code, signal, timedOut }; kills the tree on timeout, never hangs
//   await stopTracked();                        // test.after(): kills every live registered child and waits for it
//   openChildren()                              // how many are still alive (tests assert 0 at the end)
//
// On Windows the tree is killed with taskkill /T /F, run by its validated absolute path (review E8-09).

import { spawnSync } from 'node:child_process';
import { systemTool } from '../services/event-core/config.mjs';

const live = new Set();

export const openChildren = () => live.size;
export const childPids = () => [...live].map((c) => c.pid).filter(Number.isInteger);

/** Register a child until it exits. Returns the child. */
export function track(child) {
  live.add(child);
  const drop = () => live.delete(child);
  child.once('exit', drop);
  child.once('error', drop);
  return child;
}

/** Kill a process and its descendants. Best effort; never throws. */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') return spawnSync(systemTool('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 15000 }).status === 0;
    process.kill(pid, 'SIGKILL');
    return true;
  } catch { return false; }
}

const exitedAlready = (c) => c.exitCode !== null || c.signalCode !== null;

/** Resolves when `child` exits, or after `ms` once the tree has been killed. Never waits forever. */
export function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (exitedAlready(child)) return resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
    let timer;
    const onExit = (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.off('exit', onExit);
      killTree(child.pid);
      // give the kill a moment to be reported, then stop waiting regardless
      const t2 = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), 5000);
      child.once('exit', (code, signal) => { clearTimeout(t2); resolve({ code, signal, timedOut: true }); });
    }, ms);
    timer.unref?.();
  });
}

/** Kill every registered child that is still alive and wait (bounded) for them to be gone. Returns how many were killed. */
export async function stopTracked(waitMs = 10000) {
  const kids = [...live].filter((c) => !exitedAlready(c));
  for (const c of kids) {
    killTree(c.pid);
    try { c.stdin?.destroy(); c.stdout?.destroy(); c.stderr?.destroy(); } catch { /* closed */ }
  }
  await Promise.all(kids.map((c) => new Promise((r) => { if (exitedAlready(c)) return r(); const t = setTimeout(r, waitMs); t.unref?.(); c.once('exit', () => { clearTimeout(t); r(); }); })));
  for (const c of kids) live.delete(c);
  return kids.length;
}

process.once('exit', () => { for (const c of live) if (!exitedAlready(c)) killTree(c.pid); });
