// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildManifest, formatManifest, verify } from '../tools/legacy-verify.mjs';

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-verify-'));
  const dir = path.join(root, 'legacy');
  mkdirSync(path.join(dir, 'overlays'), { recursive: true });
  writeFileSync(path.join(dir, 'overlays', 'a.html'), 'a');
  writeFileSync(path.join(dir, 'README.md'), 'notes');
  const manifest = path.join(root, 'legacy.manifest.sha256');
  writeFileSync(manifest, formatManifest(buildManifest(dir)));
  return { root, dir, manifest };
}

test('unchanged copy passes; README.md is not hashed', () => {
  const { root, dir, manifest } = setup();
  writeFileSync(path.join(dir, 'README.md'), 'edited notes');
  assert.deepEqual(verify(dir, manifest), []);
  rmSync(root, { recursive: true });
});

test('changed, added and missing files fail', () => {
  const { root, dir, manifest } = setup();
  writeFileSync(path.join(dir, 'overlays', 'a.html'), 'b');
  writeFileSync(path.join(dir, 'new.js'), 'x');
  assert.deepEqual(verify(dir, manifest).sort(), ['added: new.js', 'changed: overlays/a.html']);
  rmSync(path.join(dir, 'overlays', 'a.html'));
  assert.ok(verify(dir, manifest).includes('missing: overlays/a.html'));
  rmSync(root, { recursive: true });
});
