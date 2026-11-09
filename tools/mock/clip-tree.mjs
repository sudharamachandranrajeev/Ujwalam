// SPDX-License-Identifier: GPL-3.0-or-later
// Test stand-in for a clip job's process tree (tests/kill-tree.test.mjs, D311 proposed): this process starts one child
// of itself (as clipper.py starts ffmpeg), prints "clip-tree ready <child pid>" on stderr, then both wait forever.
// Being under tools/mock/, any copy left running is listed by tools/stray-procs.mjs (and fails the CI stray step).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hold = () => setInterval(() => {}, 60_000);
if (process.argv.includes('--child')) hold();
else {
  // detached: outside this Node's kill-on-close job, as a Python subprocess child is (Python makes no job), so the
  // child outlives its parent the way ffmpeg outlived a killed clipper.py.
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], { stdio: 'ignore', windowsHide: true, detached: true });
  c.unref();
  process.stderr.write(`clip-tree ready ${c.pid}\n`);
  hold();
}
