// SPDX-License-Identifier: GPL-3.0-or-later
// Layer effect presets (D258, D291 proposed): every preset whose params carry one layer effect is a valid project
// effect, and its function's defaults are too. File effects (lut, imageMask, faceSticker) get their file when applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../services/project/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (dir) => readdirSync(path.join(ROOT, 'registry', dir)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(ROOT, 'registry', dir, f), 'utf8')));

function doc(effect) {
  const fx = 'file' in effect || !['lut', 'imageMask', 'faceSticker'].includes(effect.type) ? effect : { ...effect, file: { base: 'media', rel: effect.type === 'lut' ? 'look.cube' : 'mask.png' } };
  return {
    version: 1, id: 'preset-check', name: 'Preset check', activeScene: 'main',
    canvases: [{ id: 'h', width: 1920, height: 1080, fps: 60 }], devices: [], overlays: [], outputs: [],
    scenes: [{ id: 'main', name: 'Main', layers: [{ id: 'l', type: 'color', name: 'L', source: { color: '#808080' }, effects: [fx],
      placements: { h: { visible: true, x: 0, y: 0, width: 640, height: 360 } } }] }],
    audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
  };
}

const functions = new Map(read('functions').map((f) => [f.id, f]));
const effectPresets = read('presets').filter((p) => p.params && p.params.effect);

test('layer effect presets and function defaults are valid project effects', () => {
  assert.ok(effectPresets.length >= 17, `found ${effectPresets.length}`);
  const fns = new Set();
  for (const p of effectPresets) {
    const v = validateProject(doc(p.params.effect));
    assert.ok(v.ok, `${p.id}: ${JSON.stringify(v.errors)}`);
    fns.add(p.function);
  }
  for (const id of fns) {
    const fn = functions.get(id);
    assert.ok(fn.status !== 'planned' && fn.format, `${id} has a format`);
    const v = validateProject(doc(fn.params.defaults.effect));
    assert.ok(v.ok, `${id} defaults: ${JSON.stringify(v.errors)}`);
  }
});
