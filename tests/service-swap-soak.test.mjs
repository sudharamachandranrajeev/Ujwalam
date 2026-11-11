// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 swap soak (tools/soak/swap-soak.mjs, D337): its arguments and the sequence check. Pure: nothing is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSwapArgs, seqProblems } from '../tools/soak/swap-soak.mjs';

test('parseSwapArgs: defaults, values, refusals', () => {
  assert.deepEqual(parseSwapArgs([]), { swaps: 20, workDir: null, wait: false });
  assert.deepEqual(parseSwapArgs(['--swaps', '3', '--work-dir', 'W', '--wait']), { swaps: 3, workDir: 'W', wait: true });
  assert.throws(() => parseSwapArgs(['--swaps', '0']), /1\.\.200/);
  assert.throws(() => parseSwapArgs(['--swaps', 'x']), /1\.\.200/);
  assert.throws(() => parseSwapArgs(['--work-dir']), /folder/);
  assert.throws(() => parseSwapArgs(['--live']), /unknown argument/);
});

test('seqProblems: missing and duplicated numbers of 1..sent', () => {
  assert.deepEqual(seqProblems([1, 2, 3], 3), { missing: [], dup: [] });
  assert.deepEqual(seqProblems([1, 3, 3], 4), { missing: [2, 4], dup: [3] });
  assert.deepEqual(seqProblems([], 0), { missing: [], dup: [] });
});
