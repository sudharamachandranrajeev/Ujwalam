// SPDX-License-Identifier: GPL-2.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset, placeholderKeys } from '../services/project/scene-preset.mjs';
import { validateRegistry } from '../tools/registry-validate.mjs';

const presetV = JSON.parse(readFileSync('registry/presets/scene-default-v.json', 'utf8'));
const presetH = JSON.parse(readFileSync('registry/presets/scene-default-h.json', 'utf8'));
const profile = JSON.parse(readFileSync('tests/fixtures/project/profile.fixture.json', 'utf8'));

function base() {
  const p = createProject({ name: 'T' });
  p.devices.push({ id: 'dev-cap', kind: 'capture-card', name: 'Capture', match: { name: 'cap' } });
  p.devices.push({ id: 'dev-cam', kind: 'camera', name: 'Camera', match: { name: 'cam' } });
  return p;
}

test('V preset: registry validates, targets the v canvas, similar to Default H', () => {
  assert.deepEqual(validateRegistry('registry', process.cwd()), []);
  assert.equal(presetV.params.canvas, 'v');
  assert.deepEqual(presetV.canvases, ['V']);
  assert.deepEqual(presetV.similar, ['scene-default-h']);
  assert.equal(presetV.status, 'in-progress');
  assert.equal(presetV.parity, 'pending');
});

test('V preset: z unique 0..13 (z13 = test-broadcast banner) plus cam-pop rule z14, rects inside the canvas, crop not stretch', () => {
  const zs = presetV.params.layers.map((l) => l.z).sort((a, b) => a - b);
  assert.deepEqual(zs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(presetV.params.rules[0].z, 14);
  for (const l of presetV.params.layers) {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(l.rect[k] >= 0 && l.rect[k] <= 1, `${l.key}.${k}`);
    assert.ok(l.rect.x + l.rect.w <= 1.0001 && l.rect.y + l.rect.h <= 1.0001, `${l.key} inside canvas`);
  }
  // game: 1080 px box of a 1920x1080 source scaled 0.866 shows 1248 source px
  const g = presetV.params.layers.find((l) => l.key === 'game');
  assert.equal(1920 - g.crop.left - g.crop.right, 1248);
});

test('V preset loads into the v canvas with roles bound and validates', () => {
  const r = loadScenePreset(base(), presetV, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' } });
  assert.deepEqual(r.unbound, []);
  assert.equal(validateProject(r.project).ok, true);
  const sc = r.project.scenes.at(-1);
  assert.equal(sc.name, 'Default V');
  assert.equal(sc.layers.length, 14);
  assert.ok(sc.layers.every((l) => Object.keys(l.placements).join() === 'v'));
  assert.deepEqual(sc.layers[1].source, { device: 'dev-cap' });
  assert.deepEqual(sc.layers[2].source, { device: 'dev-cam' });
  assert.equal(sc.layers[2].placements.v.visible, false);
  assert.deepEqual(sc.layers[1].placements.v.crop, { left: 336, right: 336 });
  assert.equal(sc.layers[1].placements.v.width, 1080);
  assert.equal(r.project.devices.length, 2);
  assert.equal(r.rules[0].layer, r.layerIds.facecam);
});

test('V preset: unbound roles give transparent colour layers; browser pages are sized to the placement', () => {
  const r = loadScenePreset(base(), presetV, { profile });
  assert.deepEqual(r.unbound.sort(), ['facecam', 'game-capture']);
  const chargeLayer = r.project.scenes.at(-1).layers.find((l) => l.name === 'Effects (full canvas)');
  assert.equal(chargeLayer.source.width, 1080);
  assert.equal(chargeLayer.source.height, 1920);
  assert.equal(chargeLayer.source.query, 'canvas=vertical');
});

test('V preset: placeholders resolve from the fixture profile only; none left in the project', () => {
  const r = loadScenePreset(base(), presetV, { profile });
  assert.deepEqual(placeholderKeys(presetV), presetV.params.placeholders.slice().sort());
  assert.doesNotMatch(JSON.stringify(r.project), /\{(brand|handles|links)\./);
  assert.throws(() => loadScenePreset(base(), presetV, { profile: {} }), /profile is missing placeholder key/);
});

test('V preset: no brand, id or user path in the committed preset text', () => {
  const text = readFileSync('registry/presets/scene-default-v.json', 'utf8');
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]|https?:\/\/|\b[0-9a-f]{32}\b/i);
});

test('H and V presets load into one project together; both scenes valid, overlays shared', () => {
  const p = base();
  const h = loadScenePreset(p, presetH, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' } });
  const v = loadScenePreset(h.project, presetV, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' } });
  assert.equal(v.project.scenes.length, p.scenes.length + 2);
  assert.deepEqual(v.project.scenes.slice(-2).map((s) => s.name), ['Default H', 'Default V']);
  assert.equal(JSON.stringify(v.project.scenes.at(-2)), JSON.stringify(h.project.scenes.at(-1)), 'H scene untouched by the V load');
  assert.equal(validateProject(v.project).ok, true);
  const ids = v.project.scenes.flatMap((s) => [s.id, ...s.layers.map((l) => l.id)]);
  assert.equal(new Set(ids).size, ids.length);
  const files = v.project.overlays.map((o) => o.file.rel);
  assert.equal(new Set(files).size, files.length, 'one overlay entry per page');
  // reversed order works too
  const v2 = loadScenePreset(loadScenePreset(base(), presetV, { profile }).project, presetH, { profile });
  assert.equal(validateProject(v2.project).ok, true);
});
