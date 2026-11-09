// SPDX-License-Identifier: GPL-3.0-or-later
// Ends a child process AND everything it started (user 2026-11-09, D310 proposed). On Windows child.kill() ends only
// the one process (TerminateProcess): a clip job's Python ends, its ffmpeg children run on, hidden, after Ujwalam
// closed. taskkill /T /F ends the whole tree. taskkill is run by its absolute System32 path (never from PATH), with
// no console window (D191). Elsewhere the child is sent SIGKILL (its group when it leads one).
import { spawnSync } from 'node:child_process';
import { systemTool } from '../event-core/config.mjs';

/**
 * Ends pid and its descendants. Returns true when the tree was ended (or was already gone), false when it could not
 * be ended. opts: { platform, spawnSyncFn, kill } for tests.
 */
export function killTree(pid, { platform = process.platform, spawnSyncFn = spawnSync, kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    let exe;
    try { exe = systemTool('taskkill.exe'); } catch { exe = null; }
    if (exe) {
      const r = spawnSyncFn(exe, ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
      // 0: ended; 128: no such process (already gone). Anything else: try the plain kill below.
      if (r?.status === 0 || r?.status === 128) return true;
    }
  }
  try { kill(platform === 'win32' ? pid : -pid, 'SIGKILL'); return true; } catch (e) {
    if (e?.code === 'ESRCH') return true;
    try { kill(pid, 'SIGKILL'); return true; } catch (e2) { return e2?.code === 'ESRCH'; }
  }
}

/** killTree for a ChildProcess that may already have exited; never throws. */
export function killChildTree(child, opts) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return true;
  if (!Number.isInteger(child.pid)) { try { child.kill(); } catch { /* gone */ } return true; }
  const ok = killTree(child.pid, opts);
  if (!ok) { try { child.kill(); } catch { /* gone */ } }
  return ok;
}
