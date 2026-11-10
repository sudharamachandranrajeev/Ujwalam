// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset, placeholderKeys, ScenePresetError } from '../services/project/scene-preset.mjs';
import { validateRegistry } from '../tools/registry-validate.mjs';

const preset = JSON.parse(readFileSync('registry/presets/scene-default-h.json', 'utf8'));
const profile = JSON.parse(readFileSync('tests/fixtures/project/profile.fixture.json', 'utf8'));
const sample = JSON.parse(readFileSync('tests/fixtures/project/sample.project.json', 'utf8'));

function base() {
  const p = createProject({ name: 'T' });
  p.devices.push({ id: 'dev-cap', kind: 'capture-card', name: 'Capture', match: { name: 'cap' } });
  p.devices.push({ id: 'dev-cam', kind: 'camera', name: 'Camera', match: { name: 'cam' } });
  p.overlays.push({ id: 'ov-mine', name: 'Mine', file: { base: 'overlays', rel: 'chat-list/index.html' } });
  return p;
}

test('registry (function + preset) validates', () => {
  assert.deepEqual(validateRegistry('registry', process.cwd()), []);
});

test('preset has 14 layers z0..z13 (z13 = test-broadcast banner, flag-gated) plus cam-pop rule as z14, rects inside the canvas', () => {
  const zs = preset.params.layers.map((l) => l.z).sort((a, b) => a - b);
  assert.deepEqual(zs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(preset.params.rules[0].z, 14);
  for (const l of preset.params.layers) {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(l.rect[k] >= 0 && l.rect[k] <= 1, `${l.key}.${k}`);
    assert.ok(l.rect.x + l.rect.w <= 1.0001 && l.rect.y + l.rect.h <= 1.0001, `${l.key} inside canvas`);
  }
});

test('load appends a NEW scene and leaves everything existing byte-identical', () => {
  for (const proj of [base(), sample]) {
    const before = JSON.stringify(proj);
    const r = loadScenePreset(proj, preset, { profile });
    assert.equal(JSON.stringify(proj), before, 'input not mutated');
    assert.equal(r.project.scenes.length, proj.scenes.length + 1);
    assert.deepEqual(JSON.stringify(r.project.scenes.slice(0, -1)), JSON.stringify(proj.scenes));
    assert.equal(JSON.stringify(r.project.devices), JSON.stringify(proj.devices));
    assert.equal(JSON.stringify(r.project.audio), JSON.stringify(proj.audio));
    assert.equal(JSON.stringify(r.project.outputs), JSON.stringify(proj.outputs));
    assert.equal(JSON.stringify(r.project.canvases), JSON.stringify(proj.canvases));
    assert.equal(r.project.activeScene, proj.activeScene);
    assert.equal(JSON.stringify(r.project.overlays.slice(0, proj.overlays.length)), JSON.stringify(proj.overlays));
    assert.equal(validateProject(r.project).ok, true);
    assert.equal(r.project.scenes.at(-1).name, 'Default H');
  }
});

test('layers are back to front, H only, geometry in pixels of the H canvas', () => {
  const r = loadScenePreset(base(), preset, { profile });
  const sc = r.project.scenes.at(-1);
  assert.equal(sc.layers.length, 14);
  assert.equal(sc.layers[0].name, 'Game backdrop (blurred)');
  assert.equal(sc.layers[12].name, 'Atmos front');
  const game = sc.layers[1].placements.h;
  assert.equal(game.x, Math.round(0.24373 * 1920 * 100) / 100);
  assert.ok(sc.layers.every((l) => Object.keys(l.placements).join() === 'h'));
  assert.equal(sc.layers[12].placements.h.visible, false);
});

test('D331: the bottom layer is a blurred duplicate of the game over the full canvas, no flag, no browser background', () => {
  const spec = preset.params.layers.find((l) => l.key === 'game-backdrop');
  assert.equal(spec.z, Math.min(...preset.params.layers.map((l) => l.z)));
  assert.equal(spec.flag, undefined);
  assert.equal(spec.effectsFlag, undefined);
  assert.equal(spec.crop, undefined, '16:9 source on a 16:9 canvas: no crop');
  assert.ok(!preset.params.layers.some((l) => l.key === 'background'));
  // flag off (default) and on: the backdrop is the same, shown, blurred, under every layer
  for (const flags of [{}, { 'layer-effects': true }]) {
    const r = loadScenePreset(base(), preset, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' }, flags });
    assert.equal(validateProject(r.project).ok, true);
    const sc = r.project.scenes.at(-1);
    const bd = sc.layers[0];
    assert.equal(bd.id, r.layerIds['game-backdrop']);
    assert.equal(bd.type, 'duplicate');
    assert.deepEqual(bd.source, { layer: r.layerIds.game });
    assert.deepEqual(bd.effects, [{ type: 'blur', strength: 71 }]);
    assert.deepEqual(bd.placements.h, { visible: true, x: 0, y: 0, width: 1920, height: 1080 });
    assert.deepEqual(bd.origin, { importer: 'preset', id: 'scene-default-h/game-backdrop' });
    assert.ok(!sc.layers.some((l) => l.origin.id === 'scene-default-h/background'));
    // the game's own rounded corners stay behind layer-effects
    const game = sc.layers.find((l) => l.id === r.layerIds.game);
    assert.deepEqual(game.effects, flags['layer-effects'] ? [{ type: 'rounded', radius: 64 }] : undefined);
  }
  // unbound game: the backdrop is a transparent placeholder
  const u = loadScenePreset(base(), preset, { profile }).project.scenes.at(-1).layers[0];
  assert.equal(u.type, 'color');
  assert.deepEqual(u.source, { color: '#00000000' });
  assert.equal(u.effects, undefined);
});

test('roles: unbound become transparent colour layers, bound become capture layers; no device created', () => {
  const a = loadScenePreset(base(), preset, { profile });
  assert.deepEqual(a.unbound.sort(), ['facecam', 'game-capture']);
  const g = a.project.scenes.at(-1).layers[1];
  assert.equal(g.type, 'color');
  const b = loadScenePreset(base(), preset, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' } });
  assert.deepEqual(b.unbound, []);
  const sc = b.project.scenes.at(-1);
  assert.deepEqual(sc.layers[1].source, { device: 'dev-cap' });
  assert.deepEqual(sc.layers[2].source, { device: 'dev-cam' });
  assert.equal(b.project.devices.length, 2);
  assert.deepEqual(sc.layers[1].placements.h.crop, { left: 177, right: 177 });
  assert.throws(() => loadScenePreset(base(), preset, { profile, roles: { facecam: 'dev-cap' } }), ScenePresetError);
});

test('cam-pop rule targets the facecam layer id', () => {
  const r = loadScenePreset(base(), preset, { profile, roles: { facecam: 'dev-cam' } });
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].type, 'campop');
  assert.equal(r.rules[0].layer, r.layerIds.facecam);
  assert.equal(r.project.scenes.at(-1).layers.find((l) => l.id === r.rules[0].layer).name, 'Facecam');
});

test('placeholders resolve from the fixture profile; query values are URL-encoded', () => {
  const r = loadScenePreset(base(), preset, { profile });
  const sc = r.project.scenes.at(-1);
  const wm = sc.layers.find((l) => l.name === 'Wordmark');
  assert.deepEqual(wm.source.file, { base: 'profile', rel: 'fixture-wordmark.png' });
  const tk = sc.layers.find((l) => l.name === 'Social ticker');
  assert.match(tk.source.query, /discord=https%3A%2F%2Fexample\.invalid%2Ffixture-invite/);
  assert.match(tk.source.query, /twitch=fixture-twitch&youtube=fixture-youtube&kick=fixture-kick/);
  assert.doesNotMatch(JSON.stringify(r.project), /\{(brand|handles|links)\./);
  assert.deepEqual(placeholderKeys(preset), preset.params.placeholders.slice().sort());
});

test('a brand asset that is a video becomes a looping media layer; a still stays an image', () => {
  const vid = { ...profile, brand: { ...profile.brand, wordmark: 'fixture-wordmark.mp4' } };
  const sc = loadScenePreset(base(), preset, { profile: vid }).project.scenes.at(-1);
  const wm = sc.layers.find((l) => l.name === 'Wordmark');
  assert.equal(wm.type, 'media');
  assert.deepEqual(wm.source, { file: { base: 'profile', rel: 'fixture-wordmark.mp4' }, loop: true });
  assert.equal(sc.layers.find((l) => l.name === 'Character cutout').type, 'image');
});

test('a brand asset missing from the profile becomes a transparent placeholder and is reported, not a failure', () => {
  const noChar = { ...profile, brand: { wordmark: profile.brand.wordmark } };
  const r = loadScenePreset(base(), preset, { profile: noChar });
  assert.deepEqual(r.missingAssets, ['brand.character']);
  const ch = r.project.scenes.at(-1).layers.find((l) => l.name === 'Character cutout');
  assert.deepEqual([ch.type, ch.source], ['color', { color: '#00000000' }]);
  assert.equal(r.project.scenes.at(-1).layers.find((l) => l.name === 'Wordmark').type, 'image');
});

test('a missing profile key fails by key name, before anything is built', () => {
  const p = base();
  const before = JSON.stringify(p);
  assert.throws(() => loadScenePreset(p, preset, { profile: { brand: { wordmark: 'x' } } }), (e) => e instanceof ScenePresetError && /handles\.twitch/.test(e.message) && /links\.discord/.test(e.message));
  assert.equal(JSON.stringify(p), before);
});

test('overlays: existing entry is reused untouched, new ones are added', () => {
  const p = base();
  const r = loadScenePreset(p, preset, { profile });
  const ev = r.project.scenes.at(-1).layers.find((l) => l.name === 'Event / chat list');
  assert.equal(ev.source.overlay, 'ov-mine');
  assert.ok(r.addedOverlays.length >= 4);
  assert.ok(r.project.overlays.find((o) => o.id === 'ov-mine').name === 'Mine');
});

test('loading twice creates two distinct scenes with distinct ids', () => {
  const r1 = loadScenePreset(base(), preset, { profile });
  const r2 = loadScenePreset(r1.project, preset, { profile });
  const ids = r2.project.scenes.flatMap((s) => [s.id, ...s.layers.map((l) => l.id)]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(r2.project.scenes.length, r1.project.scenes.length + 1);
});

// First stream scene (2026-11-08): geometry against the user's horizontal target layout (fractions of the canvas,
// boxes measured from the target picture to about 1-2 percent).
test('H target layout: boxes, order, goal bar off, rounded game and mascot behind flags', () => {
  const L = (k) => preset.params.layers.find((l) => l.key === k);
  const within = (k, x0, x1, y0, y1) => {
    const r = L(k).rect;
    assert.ok(r.x >= x0 - 0.02 && r.x + r.w <= x1 + 0.02 && r.y >= y0 - 0.02 && r.y + r.h <= y1 + 0.02, `${k} inside its target box`);
  };
  within('game', 0.245, 0.985, 0.03, 0.93); // rounded inset frame, right three quarters
  within('twitch-followers', 0.26, 0.5, 0, 0.05); // top, left of centre
  within('youtube-subscribers', 0.75, 0.98, 0, 0.05); // top right
  within('subscribe-cta', 0.53, 0.71, 0, 0.11); // top centre
  within('wordmark', 0, 0.22, 0.1, 0.21); // left column under the goal bar
  within('events', 0, 0.2, 0.2, 0.55); // follow-alert stack
  within('social-ticker', 0, 1, 0.94, 1);
  within('character', 0.85, 1, 0.77, 1); // bottom right
  assert.equal(L('goal').visible, false, 'goal bar left out for now (user 2026-11-08)');
  assert.deepEqual(L('game').effects, [{ type: 'rounded', radius: 64 }]);
  assert.equal(L('game').effectsFlag, 'layer-effects');
  assert.ok(L('character').z > L('game').z && L('character').z > L('social-ticker').z);
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const on = loadScenePreset(base(), preset, { profile, roles, flags: { 'layer-effects': true } });
  assert.deepEqual(on.project.scenes.at(-1).layers[1].effects, [{ type: 'rounded', radius: 64 }]);
  const off = loadScenePreset(base(), preset, { profile, roles });
  assert.equal(off.project.scenes.at(-1).layers[1].effects, undefined, 'flag off: square frame');
  assert.equal(off.project.scenes.at(-1).layers[5].placements.h.visible, false);
});
