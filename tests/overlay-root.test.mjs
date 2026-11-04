// SPDX-License-Identifier: GPL-3.0-or-later
// overlayRootProblem: the overlay root must be the folder that holds overlays/ (and brand/, kit/), not overlays/ itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlayRootProblem } from '../app/host/lib/config.mjs';

test('overlay root: missing, one level too deep, and correct', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-ovroot-'));
  try {
    mkdirSync(path.join(dir, 'overlays', 'chat-list'), { recursive: true });
    assert.match(overlayRootProblem(undefined), /not found/);
    assert.match(overlayRootProblem(path.join(dir, 'nope')), /not found/);
    assert.match(overlayRootProblem(path.join(dir, 'overlays')), /has no overlays\/ folder/);
    assert.equal(overlayRootProblem(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
