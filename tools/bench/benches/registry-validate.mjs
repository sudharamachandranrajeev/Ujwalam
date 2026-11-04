// SPDX-License-Identifier: GPL-3.0-or-later
// Bench: wall time of `node tools/registry-validate.mjs registry` in a child process.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const id = 'registry-validate-wall';
export const budget = null; // tooling time, not a product budget
// minDelta: absolute slack (ms) so process-start noise on a ~150 ms run cannot flag a regression.
export const metrics = { wall_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 30 } };

export function run() {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['tools/registry-validate.mjs', 'registry'], { cwd: root, stdio: 'ignore', windowsHide: true });
  const wall_ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`registry-validate exited ${r.status}`);
  return { wall_ms };
}
