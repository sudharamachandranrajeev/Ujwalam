// SPDX-License-Identifier: GPL-2.0-or-later
// post-commit helper: copy the latest bench run to out/bench/commits/<new sha>.json.
// Never fails the commit: every error is swallowed and the exit code is always 0.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const { recordCommit } = await import('./run.mjs');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const sha = r.status === 0 ? r.stdout.trim() : '';
  if (sha) recordCommit(sha);
} catch {
  // by design
}
process.exit(0);
