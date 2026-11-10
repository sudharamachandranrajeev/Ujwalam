// SPDX-License-Identifier: GPL-3.0-or-later
// Scene upgrade bg1 (D331): an alpha project built from the old presets (browser background at the bottom, the V
// backdrop behind flag layer-effects) gets the blurred game backdrop at the bottom on load, keeps the user's own edits,
// is backed up first, and a second load changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../services/project/index.mjs';
import { loadDevicePresets, matchRoles } from '../services/project/device-roles.mjs';
import { upgradeScenes } from '../services/project/scene-upgrades.mjs';
import { alphaFile, buildAlphaProject, prepareAlphaProject, upgradePresets } from '../services/studio-ui/alpha.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = path.join(REPO, 'registry', 'presets');
const FIX = path.join(REPO, 'tests', 'fixtures', 'project');
const LIST = JSON.parse(readFileSync(path.join(FIX, 'devices-list.fixture.json'), 'utf8'));
const PROFILE = JSON.parse(readFileSync(path.join(FIX, 'profile.fixture.json'), 'utf8'));
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-bg1-${p}-`));
const CURRENT = upgradePresets(PRESETS);
const upgrade = (project) => upgradeScenes(project, { presets: CURRENT });

// The presets as they were before D331 (H 0.5.0, V 0.4.0), rebuilt from the current ones.
function oldPresetsDir() {
  const d = tmp('old-presets');
  const h = structuredClone(CURRENT['scene-default-h']);
  h.version = '0.5.0';
  const hi = h.params.layers.findIndex((l) => l.key === 'game-backdrop');
  h.params.layers[hi] = { key: 'background', z: 0, name: 'Background', type: 'browser', overlay: 'atmos-frame/index.html', query: 'brackets=0', rect: { x: 0, y: 0, w: 1, h: 1 }, geometry: 'spec' };
  const v = structuredClone(CURRENT['scene-default-v']);
  v.version = '0.4.0';
  const bd = v.params.layers.find((l) => l.key === 'game-backdrop');
  bd.z = 0.5; bd.flag = 'layer-effects';
  v.params.layers.unshift({ key: 'background', z: 0, name: 'Background', type: 'browser', overlay: 'atmos-frame/index.html', query: 'brackets=0&canvas=vertical', rect: { x: 0, y: 0, w: 1, h: 1 }, geometry: 'spec' });
  writeFileSync(path.join(d, 'scene-default-h.json'), JSON.stringify(h));
  writeFileSync(path.join(d, 'scene-default-v.json'), JSON.stringify(v));
  return d;
}

const bindings = () => matchRoles({ list: LIST, presets: loadDevicePresets(PRESETS) });
function oldProject({ devices = true, flags = {} } = {}) {
  return buildAlphaProject({ presetsDir: oldPresetsDir(), profile: PROFILE, bindings: devices ? bindings() : { bound: {}, unavailable: [] }, devicesListed: devices, flags }).project;
}
const byOrigin = (layers, id) => layers.find((l) => l.origin?.id === id);
const onCanvas = (layers, c) => layers.filter((l) => l.placements[c]);

test('bg1: old project -> blurred backdrop at the bottom of H and V; browser backgrounds gone; other layers untouched', () => {
  const before = oldProject();
  const frozen = JSON.stringify(before);
  const { project, changes } = upgrade(before);
  assert.equal(JSON.stringify(before), frozen, 'input not mutated');
  assert.ok(validateProject(project).ok, JSON.stringify(validateProject(project).errors));
  assert.deepEqual(changes.map((c) => [c.canvas, c.action, c.background]), [['h', 'backdrop-added', 'removed'], ['v', 'backdrop-shown', 'removed']]);
  const L = project.scenes[0].layers;
  const hGame = byOrigin(L, 'scene-default-h/game');
  for (const [c, pid, strength, crop] of [['h', 'scene-default-h', 71, undefined], ['v', 'scene-default-v', 40, { left: 656, right: 656 }]]) {
    const bd = byOrigin(L, `${pid}/game-backdrop`);
    assert.equal(onCanvas(L, c)[0], bd, `${c}: backdrop is the bottom layer`);
    assert.equal(bd.type, 'duplicate');
    assert.equal(bd.source.layer, hGame.id, `${c}: shows the H game capture (never a duplicate of a duplicate)`);
    assert.deepEqual(bd.effects, [{ type: 'blur', strength }]);
    assert.equal(bd.placements[c].visible, true);
    assert.deepEqual(bd.placements[c].crop, crop);
    assert.equal(byOrigin(L, `${pid}/background`), undefined);
  }
  // every other layer is the same object in the same relative order
  const others = (doc) => doc.scenes[0].layers.filter((l) => !/\/(background|game-backdrop)$/.test(l.origin?.id ?? ''));
  assert.equal(JSON.stringify(others(project)), JSON.stringify(others(before)));
  assert.equal(JSON.stringify(project.audio), JSON.stringify(before.audio));
  assert.equal(JSON.stringify(project.devices), JSON.stringify(before.devices));
});

test('bg1: the user\'s moved and added layers stay; the backdrop takes the background\'s place', () => {
  const before = oldProject();
  const L = before.scenes[0].layers;
  // user edits: move the H facecam and its box, add an own colour layer at the very bottom of H
  const cam = byOrigin(L, 'scene-default-h/facecam');
  cam.placements.h.x = 100; cam.placements.h.y = 50;
  L.splice(L.indexOf(cam), 1); L.splice(5, 0, cam);
  L.unshift({ id: 'lyr-mine', type: 'color', name: 'My colour', source: { color: '#112233' }, placements: { h: { visible: true, x: 0, y: 0, width: 10, height: 10 } } });
  assert.ok(validateProject(before).ok);
  const camAt = L.indexOf(cam);
  const { project } = upgrade(before);
  const U = project.scenes[0].layers;
  assert.equal(U[0].id, 'lyr-mine', 'own layer kept where the user put it');
  assert.equal(U[1].origin.id, 'scene-default-h/game-backdrop', 'backdrop where the background was');
  const cam2 = byOrigin(U, 'scene-default-h/facecam');
  assert.deepEqual([cam2.placements.h.x, cam2.placements.h.y], [100, 50]);
  assert.equal(U.indexOf(cam2), camAt, 'moved layer keeps its place (one layer replaced by one)');
});

test('bg1: a V backdrop the user already blurred (layer-effects on) keeps its own effects', () => {
  const before = oldProject({ flags: { 'layer-effects': true } });
  const bd0 = byOrigin(before.scenes[0].layers, 'scene-default-v/game-backdrop');
  bd0.effects = [{ type: 'blur', strength: 55 }];
  const { project, changes } = upgrade(before);
  const bd = byOrigin(project.scenes[0].layers, 'scene-default-v/game-backdrop');
  assert.equal(bd.id, bd0.id);
  assert.deepEqual(bd.effects, [{ type: 'blur', strength: 55 }]);
  assert.equal(onCanvas(project.scenes[0].layers, 'v')[0], bd);
  assert.equal(changes.find((c) => c.canvas === 'v').action, 'backdrop-shown');
});

test('bg1: game capture still unbound (placeholder) -> scene not changed, trigger kept for a later start', () => {
  const before = oldProject({ devices: false });
  const r = upgrade(before);
  assert.deepEqual(r.changes, []);
  assert.equal(r.project, before, 'nothing changed');
  for (const pid of ['scene-default-h', 'scene-default-v']) assert.ok(byOrigin(before.scenes[0].layers, `${pid}/background`), `${pid}: background (trigger) kept`);
});

test('bg1: a V backdrop built as a placeholder while the game was unbound becomes the real backdrop in place once the game is bound', () => {
  const before = oldProject();
  const bd0 = byOrigin(before.scenes[0].layers, 'scene-default-v/game-backdrop');
  const box = { x: bd0.placements.v.x, y: bd0.placements.v.y, width: bd0.placements.v.width, height: bd0.placements.v.height };
  // as the loader builds it for an unbound game: transparent colour, no crop, no effects, hidden (flag off)
  bd0.type = 'color'; bd0.source = { color: '#00000000' }; delete bd0.placements.v.crop; delete bd0.effects; bd0.placements.v.visible = false;
  assert.ok(validateProject(before).ok);
  const { project, changes } = upgrade(before);
  assert.ok(validateProject(project).ok, JSON.stringify(validateProject(project).errors));
  const L = project.scenes[0].layers;
  const bd = byOrigin(L, 'scene-default-v/game-backdrop');
  assert.equal(bd.id, bd0.id, 'same layer id');
  assert.equal(bd.type, 'duplicate');
  assert.equal(bd.source.layer, byOrigin(L, 'scene-default-h/game').id);
  assert.deepEqual(bd.placements.v, { ...box, visible: true, crop: { left: 656, right: 656 } });
  assert.deepEqual(bd.effects, [{ type: 'blur', strength: 40 }]);
  assert.equal(onCanvas(L, 'v')[0], bd);
  assert.equal(changes.find((c) => c.canvas === 'v').action, 'backdrop-converted');
});

for (const [kind, refer] of [
  ['another layer', (doc, bg) => doc.scenes[0].layers.push({ id: 'lyr-copy', type: 'duplicate', name: 'Copy of background', source: { layer: bg.id }, placements: { h: { visible: true, x: 0, y: 0, width: 100, height: 100 } } })],
  ['an audio source', (doc, bg) => doc.audio.sources.push({ id: 'aud-bg', name: 'Background page', layer: bg.id, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'] })],
]) {
  test(`bg1: a background ${kind} still uses is hidden, not removed; its trigger is retired, so a second load changes nothing`, async () => {
    const before = oldProject();
    const bg = byOrigin(before.scenes[0].layers, 'scene-default-h/background');
    refer(before, bg);
    assert.ok(validateProject(before).ok, JSON.stringify(validateProject(before).errors));
    const { project, changes } = upgrade(before);
    assert.ok(validateProject(project).ok, JSON.stringify(validateProject(project).errors));
    const U = project.scenes[0].layers;
    assert.equal(byOrigin(U, 'scene-default-h/background'), undefined, 'trigger gone');
    const bg2 = U.find((l) => l.id === bg.id);
    assert.deepEqual(bg2.origin, { importer: 'preset', id: 'scene-default-h/background-retired-bg1' });
    assert.equal(bg2.placements.h.visible, false);
    assert.equal(U.indexOf(byOrigin(U, 'scene-default-h/game-backdrop')), U.indexOf(bg2) - 1, 'backdrop under the hidden background');
    assert.equal(changes.find((c) => c.canvas === 'h').background, 'hidden');
    assert.deepEqual(upgrade(project).changes, [], 'second run: nothing');

    // on disk: one backup, the second start leaves the file byte for byte (a later user edit stays)
    const dataDir = tmp(`ref-${kind.replace(/\s/g, '-')}`);
    await prepareAlphaProject({ dataDir, build: async () => before });
    const b = await prepareAlphaProject({ dataDir, build: async () => before, upgrade, now: new Date('2026-11-10T12:00:00Z') });
    assert.equal(b.action, 'upgraded');
    const saved = JSON.parse(readFileSync(alphaFile(dataDir), 'utf8'));
    byOrigin(saved.scenes[0].layers, 'scene-default-h/game-backdrop').placements.h.visible = false; // the user hides it later
    writeFileSync(alphaFile(dataDir), JSON.stringify(saved, null, 2));
    const edited = readFileSync(alphaFile(dataDir));
    const c = await prepareAlphaProject({ dataDir, build: async () => before, upgrade, now: new Date('2026-11-10T13:00:00Z') });
    assert.equal(c.action, 'loaded');
    assert.deepEqual(readFileSync(alphaFile(dataDir)), edited, 'user edit kept, file untouched');
    assert.equal(readdirSync(path.join(dataDir, 'projects', '_old')).length, 1, 'no second backup');
  });
}

test('bg1: a project without the retired background (new build, or the user removed it) is not changed', () => {
  const fresh = buildAlphaProject({ presetsDir: PRESETS, profile: PROFILE, bindings: bindings(), devicesListed: true }).project;
  const r = upgrade(fresh);
  assert.equal(r.project, fresh);
  assert.deepEqual(r.changes, []);
  const old = oldProject();
  for (const s of old.scenes) s.layers = s.layers.filter((l) => !/\/background$/.test(l.origin?.id ?? ''));
  assert.deepEqual(upgrade(old).changes, []);
});

test('bg1 on load: backup in projects/_old first, upgraded file saved, second load does nothing', async () => {
  const dataDir = tmp('data');
  const build = async () => oldProject();
  const a = await prepareAlphaProject({ dataDir, build });
  assert.equal(a.action, 'built');
  const original = readFileSync(a.file);
  const now = new Date('2026-11-10T12:00:00Z');
  const b = await prepareAlphaProject({ dataDir, build, upgrade, now });
  assert.equal(b.action, 'upgraded');
  assert.equal(path.basename(b.backup), 'alpha-2026-11-10T12-00-00-000Z.before-bg1.project.json');
  assert.deepEqual(readFileSync(b.backup), original, 'backup is the file before the upgrade, byte for byte');
  assert.deepEqual(b.upgraded.map((c) => c.canvas), ['h', 'v']);
  const saved = JSON.parse(readFileSync(alphaFile(dataDir), 'utf8'));
  assert.ok(validateProject(saved).ok);
  assert.equal(byOrigin(saved.scenes[0].layers, 'scene-default-h/background'), undefined);
  const after = readFileSync(alphaFile(dataDir));
  const c = await prepareAlphaProject({ dataDir, build, upgrade, now: new Date('2026-11-10T13:00:00Z') });
  assert.equal(c.action, 'loaded');
  assert.deepEqual(readFileSync(alphaFile(dataDir)), after, 'idempotent: second load leaves the file as it is');
  assert.deepEqual(readdirSync(path.join(dataDir, 'projects', '_old')), [path.basename(b.backup)], 'one backup only');
});

test('bg1 on load: a failed upgrade never blocks the start; the file is left as it is', async () => {
  const dataDir = tmp('fail');
  const a = await prepareAlphaProject({ dataDir, build: async () => oldProject() });
  const original = readFileSync(a.file);
  const r = await prepareAlphaProject({ dataDir, build: async () => oldProject(), upgrade: () => { throw new Error('boom'); } });
  assert.equal(r.action, 'loaded');
  assert.match(r.upgradeError, /boom/);
  assert.deepEqual(readFileSync(a.file), original);
});
