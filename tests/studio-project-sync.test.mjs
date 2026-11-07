// SPDX-License-Identifier: GPL-3.0-or-later
// P5b autosave of layer edits (services/studio-ui/project-sync.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyEdit, createProjectSync } from '../services/studio-ui/project-sync.mjs';

const doc = () => ({
  scenes: [{ id: 's1', layers: [
    { id: 'cam', visible: true, placements: { h: { visible: true, x: 0, y: 0, width: 640, height: 360 }, v: { visible: true, x: 0, y: 0, width: 1080, height: 600 } } },
    { id: 'off', visible: false, placements: { h: { visible: true, x: 0, y: 0, width: 10, height: 10 }, v: { visible: true, x: 0, y: 0, width: 10, height: 10 } } },
  ] }],
});

test('setPlacement merges a partial patch into one canvas (crop per key)', () => {
  const d = doc();
  d.scenes[0].layers[0].placements.h.crop = { top: 5 };
  assert.equal(applyEdit(d, 'layers.setPlacement', { scene: 's1', canvas: 'H', layer: 'cam', placement: { x: 11, width: 222, crop: { left: 3 } } }), 1);
  assert.deepEqual(d.scenes[0].layers[0].placements.h, { visible: true, x: 11, y: 0, width: 222, height: 360, crop: { top: 5, left: 3 } });
  assert.equal(d.scenes[0].layers[0].placements.v.x, 0, 'V untouched');
});

test('no canvas applies to every canvas; unknown scene, layer or canvas changes nothing', () => {
  const d = doc();
  assert.equal(applyEdit(d, 'layers.setVisible', { scene: 's1', layer: 'cam', visible: false }), 2);
  assert.equal(applyEdit(d, 'layers.setVisible', { scene: 'nope', layer: 'cam', visible: true }), 0);
  assert.equal(applyEdit(d, 'layers.setVisible', { scene: 's1', layer: 'nope', visible: true }), 0);
  assert.equal(applyEdit(d, 'layers.setVisible', { scene: 's1', canvas: 'x', layer: 'cam', visible: true }), 0);
  assert.equal(applyEdit(d, 'layers.move', { scene: 's1', layer: 'cam', index: 0 }), 0, 'move is not saved');
});

test('showing a layer whose layer flag is off keeps it hidden on the other canvas', () => {
  const d = doc();
  applyEdit(d, 'layers.setVisible', { scene: 's1', canvas: 'v', layer: 'off', visible: true });
  const l = d.scenes[0].layers[1];
  assert.equal(l.visible, true);
  assert.equal(l.placements.v.visible, true);
  assert.equal(l.placements.h.visible, false);
});

test('createProjectSync debounces and refuses to save an invalid project', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sync-'));
  try {
    const file = path.join(dir, 'p.project.json');
    writeFileSync(file, '{"not":"a project"}');
    let fire = null;
    const sync = createProjectSync({ file, setTimer: (f) => { fire = f; return 1; }, clearTimer: () => {} });
    assert.equal(sync.record('layers.setVisible', { scene: 's1', layer: 'cam', visible: false }), false);
    assert.match(sync.status().lastError, /version|validation|invalid/i);
    assert.equal(fire, null, 'nothing scheduled');
    assert.equal(readFileSync(file, 'utf8'), '{"not":"a project"}', 'file untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
