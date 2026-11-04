// SPDX-License-Identifier: GPL-3.0-or-later
// Bench: wall time of `node tools/git-hooks/private-scan.mjs scan-worktree` in a child process.
// Every run also records the scan's input size (files and bytes, same file list the scan uses) and the
// time per file, as `info` in the result, the run file and the baseline, so a later change in wall time
// can be told apart from worktree growth. `info` is never compared.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const id = 'private-scan-worktree-wall';
export const budget = null; // tooling time, not a product budget
export const metrics = { wall_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 80 } };

/** Same list as the scanner: tracked plus untracked-not-ignored files. */
export function scanInput() {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'buffer', maxBuffer: 1 << 26, windowsHide: true });
  const names = r.stdout.toString().split('\0').filter(Boolean);
  let bytes = 0;
  let files = 0;
  for (const n of names) {
    try { bytes += statSync(path.join(root, n)).size; files++; } catch { /* deleted since listing */ }
  }
  return { files, bytes };
}

export function run() {
  const input = scanInput(); // measured before the timed section
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['tools/git-hooks/private-scan.mjs', 'scan-worktree'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const wall_ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`private-scan exited ${r.status}`);
  const reported = /scanned (\d+) files/.exec(r.stdout ?? '');
  return {
    wall_ms,
    info: { files: input.files, bytes: input.bytes, scannerReportedFiles: reported ? Number(reported[1]) : null, ms_per_file: +(wall_ms / input.files).toFixed(3), ms_per_mb: +(wall_ms / (input.bytes / 1048576)).toFixed(1) },
  };
}
