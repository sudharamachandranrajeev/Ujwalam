// SPDX-License-Identifier: GPL-3.0-or-later
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

test('V preset: z unique 0..13 (z13 = test-broadcast banner, z0 = blurred game backdrop, D331) plus cam-pop rule z14, rects inside the canvas, crop not stretch', () => {
  const zs = presetV.params.layers.map((l) => l.z).sort((a, b) => a - b);
  assert.deepEqual(zs, [0, 1, 2, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // z3.5 = confetti prompt (D248)
  assert.equal(presetV.params.rules[0].z, 14);
  for (const l of presetV.params.layers) {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(l.rect[k] >= 0 && l.rect[k] <= 1, `${l.key}.${k}`);
    // a layer turned a quarter turn about its centre (the host's pivot) shows its box with width and height swapped
    const quarter = Math.abs(((((l.rotation ?? 0) % 180) + 180) % 180) - 90) < 1;
    let { x, y, w, h } = l.rect;
    if (quarter) {
      const cx = (x + w / 2) * 1080, cy = (y + h / 2) * 1920, W = h * 1920, H = w * 1080;
      [x, y, w, h] = [(cx - W / 2) / 1080, (cy - H / 2) / 1920, W / 1080, H / 1920];
    } else assert.ok(!l.rotation, `${l.key}: only quarter turns are checked`);
    assert.ok(x >= -0.0001 && y >= -0.0001 && x + w <= 1.0001 && y + h <= 1.0001, `${l.key} inside canvas`);
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
  assert.equal(sc.layers.length, 16);
  assert.ok(sc.layers.every((l) => Object.keys(l.placements).join() === 'v'));
  const byKey = (k) => sc.layers.find((l) => l.id === r.layerIds[k]);
  assert.deepEqual(byKey('game').source, { device: 'dev-cap' });
  assert.deepEqual(byKey('facecam').source, { device: 'dev-cam' });
  assert.equal(byKey('facecam').placements.v.visible, true); // shown (user 2026-11-06)
  assert.deepEqual(byKey('game').placements.v.crop, { left: 336, right: 336 });
  assert.equal(byKey('game').placements.v.width, 1080);
  // D331: the bottom layer is the blurred game backdrop, shown and blurred with layer-effects off (no flag); no
  // browser background. The game's rounded corners stay behind layer-effects.
  assert.equal(sc.layers[0].id, r.layerIds['game-backdrop']);
  assert.equal(r.layerIds.background, undefined);
  assert.ok(!sc.layers.some((l) => l.origin.id === 'scene-default-v/background'));
  const bd = byKey('game-backdrop');
  assert.deepEqual(bd.source, { layer: r.layerIds.game });
  assert.equal(bd.placements.v.visible, true);
  assert.deepEqual(bd.effects, [{ type: 'blur', strength: 40 }]);
  assert.deepEqual(bd.placements.v.crop, { left: 656, right: 656 });
  assert.deepEqual([bd.placements.v.x, bd.placements.v.y, bd.placements.v.width, bd.placements.v.height], [0, 0, 1080, 1920]);
  assert.equal(byKey('game').effects, undefined);
  assert.ok(sc.layers.every((l) => l === bd || !l.effects));
  assert.equal(r.project.devices.length, 2);
  assert.equal(r.rules[0].layer, r.layerIds.facecam);
});

test('V preset with layer-effects on: blurred backdrop shown behind the game, game rounded; validates', () => {
  const r = loadScenePreset(base(), presetV, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' }, flags: { 'layer-effects': true } });
  assert.equal(validateProject(r.project).ok, true);
  const sc = r.project.scenes.at(-1);
  const byKey = (k) => sc.layers.find((l) => l.id === r.layerIds[k]);
  const bd = byKey('game-backdrop');
  assert.equal(bd.type, 'duplicate');
  assert.equal(bd.placements.v.visible, true);
  assert.deepEqual(bd.effects, [{ type: 'blur', strength: 40 }]);
  assert.deepEqual([bd.placements.v.width, bd.placements.v.height], [1080, 1920]);
  assert.ok(sc.layers.indexOf(bd) < sc.layers.indexOf(byKey('game')), 'backdrop under the game');
  assert.deepEqual(byKey('game').effects, [{ type: 'rounded', radius: 48 }]);
});

test('V preset: an unbound game leaves the backdrop a transparent placeholder too (flag on or off)', () => {
  for (const flags of [{ 'layer-effects': true }, {}]) {
    const r = loadScenePreset(base(), presetV, { profile, flags });
    const bd = r.project.scenes.at(-1).layers.find((l) => l.id === r.layerIds['game-backdrop']);
    assert.equal(bd.type, 'color');
    assert.deepEqual(bd.source, { color: '#00000000' });
    assert.equal(bd.placements.v.crop, undefined);
    assert.equal(bd.effects, undefined);
  }
});

test('V preset (D331): the backdrop carries no feature flag; the atmos-frame background is gone from the preset', () => {
  const bd = presetV.params.layers.find((l) => l.key === 'game-backdrop');
  assert.equal(bd.flag, undefined);
  assert.equal(bd.effectsFlag, undefined);
  assert.equal(bd.z, Math.min(...presetV.params.layers.map((l) => l.z)));
  assert.ok(!presetV.params.layers.some((l) => l.key === 'background'));
  assert.ok(!presetV.params.layers.some((l) => l.overlay === 'atmos-frame/index.html'));
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

test('call-to-action videos (D248): keyed looping media from the stream assets folder, shown only with layer-effects', () => {
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const on = loadScenePreset(base(), presetV, { profile, roles, flags: { 'layer-effects': true } });
  const byKey = (r, k) => r.project.scenes.at(-1).layers.find((l) => l.id === r.layerIds[k]);
  const sub = byKey(on, 'subscribe-cta');
  assert.deepEqual([sub.type, sub.source], ['media', { file: { base: 'media', rel: 'fixture-subscribe.webm' }, loop: true }]);
  assert.deepEqual(sub.effects, [{ type: 'chromaKey', color: '#00ff00', similarity: 300, smoothness: 1 }]);
  assert.equal(sub.placements.v.opacity, 0.59);
  const conf = byKey(on, 'confetti-cta');
  assert.equal(conf.placements.v.rotation, 269.72);
  assert.deepEqual(conf.effects.map((e) => e.type), ['chromaKey', 'rounded']);
  assert.equal(byKey(on, 'support-cta').source.file.rel, 'fixture-support.mp4');
  assert.equal(validateProject(on.project).ok, true);

  // flag off: the layers stay (geometry kept) but hidden and unkeyed, so no green box ever shows
  const off = loadScenePreset(base(), presetV, { profile, roles });
  for (const k of ['subscribe-cta', 'support-cta', 'confetti-cta']) {
    assert.equal(byKey(off, k).placements.v.visible, false, k);
    assert.equal(byKey(off, k).effects, undefined, k);
  }
  // no file named in the profile: a transparent placeholder, reported by key
  const none = loadScenePreset(base(), presetV, { profile: { ...profile, assets: {} }, roles, flags: { 'layer-effects': true } });
  assert.deepEqual(none.missingAssets, ['assets.confetti_cta', 'assets.subscribe_cta', 'assets.support_cta']);
  assert.deepEqual(byKey(none, 'confetti-cta').source, { color: '#00000000' });
  assert.equal(byKey(none, 'confetti-cta').effects, undefined);
});

test('wordmark (D248): a video wordmark is keyed under layer-effects; a still is never keyed', () => {
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const wm = (prof, flags) => { const r = loadScenePreset(base(), presetV, { profile: prof, roles, flags }); return r.project.scenes.at(-1).layers.find((l) => l.id === r.layerIds.wordmark); };
  const vid = { ...profile, brand: { ...profile.brand, wordmark: 'fixture-wordmark.mp4' } };
  assert.deepEqual(wm(vid, { 'layer-effects': true }).effects, [{ type: 'chromaKey', color: '#00ff00', similarity: 300, smoothness: 1 }]);
  assert.equal(wm(vid, {}).effects, undefined, 'flag off: no key');
  assert.equal(wm(vid, {}).placements.v.visible, true, 'effectsFlag keeps the layer itself');
  assert.equal(wm(profile, { 'layer-effects': true }).effects, undefined, 'a PNG wordmark keeps its colours');
});

// First stream scene (2026-11-08): V geometry against the user's vertical target layout.
test('V target layout: bands top to bottom, mascot bottom right behind layer-effects', () => {
  const L = (k) => presetV.params.layers.find((l) => l.key === k);
  assert.ok(L('subscribe-cta').rect.x < 0.1 && L('subscribe-cta').rect.y < 0.05, 'subscribe pill top left');
  assert.ok(L('confetti-cta').rect.x > 0.7, 'confetti prompt top right');
  const g = L('game').rect;
  assert.ok(g.y > 0.2 && g.y + g.h < 0.76, 'game band in the middle');
  assert.ok(L('twitch-followers').rect.y >= g.y + g.h - 0.03 && L('youtube-subscribers').rect.y >= g.y + g.h - 0.03, 'counters under the game');
  const c = L('character');
  assert.ok(c.rect.x >= 0.55 && c.rect.y >= 0.8 && c.rect.y + c.rect.h <= L('social-ticker').rect.y + 0.03, 'mascot bottom right above the ticker');
  assert.equal(c.flag, 'layer-effects');
  assert.ok(presetV.params.placeholders.includes('brand.character'));
  const off = loadScenePreset(base(), presetV, { profile, roles: { 'game-capture': 'dev-cap', facecam: 'dev-cam' } });
  assert.equal(off.project.scenes.at(-1).layers.find((l) => l.id === off.layerIds.character).placements.v.visible, false);
});
