// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB3 (D341): reference read -> scene package -> NEW namespaced H + V scene through the scene package
// importer. Checks the built layout against the drawn SB2 fixtures (slot boxes -> layer placements on both canvases),
// links to the project's own layers and devices (never a new device), placeholders with reasons, the V safe zone on
// the derived canvas, the existing-state hash after dry run and apply, a round trip through a temp project file, the
// CLI behind the scene-builder flag, the package schema and the token panel page. Fixtures are drawn in memory
// (tests/helpers/sb-fixtures.mjs); no picture is committed.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createProject, loadProject, saveProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset, mergeCanvasScenes } from '../services/project/scene-preset.mjs';
import { applyScenePackageFile, diffText, packageProblems, planScenePackage, stateHash } from '../services/project/scene-package.mjs';
import { buildPackage, fitBox, loadBuildRules } from '../services/scene-builder/build.mjs';
import { main as cli } from '../services/scene-builder/cli.mjs';
import { readFrames } from '../services/scene-builder/read.mjs';
import { layoutH, layoutV, writePng } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
const validatePkg = new Ajv2020({ allErrors: true, strict: true }).compile(rd('data/schemas/scene-package.schema.json'));
const schemaOk = (p) => assert.ok(validatePkg(p), JSON.stringify(validatePkg.errors?.slice(0, 3)));
const profile = rd('tests/fixtures/project/profile.fixture.json');
const RULES = loadBuildRules();

// Tolerance (D339, D341): every side within EDGE_TOL of the canvas side.
const EDGE_TOL = 0.03;
const sidesOff = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - b.x - b.w), Math.abs(a.y + a.h - b.y - b.h));

/** A project like the alpha one: capture card + camera, Default H + V in one scene, an alert-box layer. */
function project({ alerts = true, cameras = 1 } = {}) {
  const p = createProject({ name: 'T' });
  p.devices.push({ id: 'dev-cap', kind: 'capture-card', name: 'Capture', match: { name: 'cap' }, origin: { importer: 'alpha', id: 'role/game-capture' } });
  p.devices.push({ id: 'dev-cam', kind: 'camera', name: 'Camera', match: { name: 'cam' }, origin: { importer: 'alpha', id: 'role/facecam' } });
  for (let i = 1; i < cameras; i++) p.devices.push({ id: `dev-cam${i + 1}`, kind: 'camera', name: `Camera ${i + 1}`, match: { name: `cam${i + 1}` } });
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const h = loadScenePreset(p, rd('registry/presets/scene-default-h.json'), { profile, roles });
  const v = loadScenePreset(h.project, rd('registry/presets/scene-default-v.json'), { profile, roles });
  const out = mergeCanvasScenes(v.project, h.sceneId, v.sceneId).project;
  out.scenes = out.scenes.filter((s) => s.layers.length); // drop the empty Scene 1
  out.activeScene = out.scenes[0].id;
  if (alerts) {
    out.overlays.push({ id: 'ov-alert-box', name: 'alert-box', file: { base: 'overlays', rel: 'alert-box/index.html' } });
    out.scenes[0].layers.push({ id: 'lyr-alerts1', type: 'browser', name: 'Alerts', source: { overlay: 'ov-alert-box', query: 'hold=6000&x=24&y=210&types=follow,raid', width: 1920, height: 1080 }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } });
  }
  assert.ok(validateProject(out).ok);
  return out;
}

/** The SB2 read of a drawn fixture (in memory; the same path readReference takes after loading). */
async function readOf(f, name = 'ref layout.png') {
  const c = f.canvas;
  return readFrames({ name, kind: 'image', width: c.width, height: c.height, durationS: null, frames: [{ t: 0, width: c.width, height: c.height, rgb: c.rgb }] });
}

const frac = (pl, cv) => ({ x: pl.x / cv.width, y: pl.y / cv.height, w: pl.width / cv.width, h: pl.height / cv.height });
const canvasOf = (p, id) => p.canvases.find((c) => c.id === id);
const layersOn = (diff, canvas) => diff.adds.layers.filter((l) => l.canvas === canvas);
const byKey = (diff, canvas, key) => layersOn(diff, canvas).find((l) => l.key === key);
const box = (l, cv) => frac(l.rect, cv);
const within = (a, b, tol) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

let reads;
before(async () => { reads = { H: await readOf(layoutH()), V: await readOf(layoutV()) }; });

describe('SB3 layout matches the reference on its own canvas', () => {
  for (const kind of ['H', 'V']) {
    test(`${kind} reference: chat, alerts, camera and graphics on the slot boxes, game contained in its box (tolerance ${EDGE_TOL})`, () => {
      const fx = kind === 'H' ? layoutH() : layoutV();
      const p = project();
      const pkg = buildPackage(reads[kind], p, { now: new Date('2026-11-11T00:00:00Z') });
      schemaOk(pkg);
      const { diff } = planScenePackage(p, pkg);
      const c = kind.toLowerCase(), cv = canvasOf(p, c);
      for (const role of ['camera', 'chat', 'alerts']) {
        const l = byKey(diff, c, role);
        assert.ok(l && !l.placeholder, `${role} built`);
        const off = sidesOff(box(l, cv), fx.truth[role]);
        assert.ok(off <= EDGE_TOL, `${role} off ${off.toFixed(4)}`);
      }
      const g = layersOn(diff, c).filter((l) => l.key.startsWith('graphics-'));
      assert.equal(g.length, 1);
      assert.ok(sidesOff(box(g[0], cv), fx.truth.graphics) <= EDGE_TOL);
      // the game is never cropped: contained in the truth box, centred, touching it on one axis
      const game = byKey(diff, c, 'game'), gb = box(game, cv), t = fx.truth.game;
      assert.ok(within(gb, t, EDGE_TOL), 'game inside its box');
      const fitsW = Math.abs(gb.w - t.w) <= EDGE_TOL, fitsH = Math.abs(gb.h - t.h) <= EDGE_TOL;
      assert.ok(fitsW || fitsH, 'game fills its box on one axis');
      assert.ok(Math.abs(gb.x + gb.w / 2 - (t.x + t.w / 2)) <= EDGE_TOL && Math.abs(gb.y + gb.h / 2 - (t.y + t.h / 2)) <= EDGE_TOL, 'game centred');
      // z order: graphics behind the game, the game behind camera, chat, alerts
      const order = layersOn(diff, c).map((l) => l.key);
      assert.ok(order.indexOf('graphics-1') < order.indexOf('game') && order.indexOf('game') < order.indexOf('camera') && order.indexOf('camera') < order.indexOf('alerts'));
    });
  }

  test('fitBox: contain keeps the source shape; cover crops a centred band up to maxCrop, else contains', () => {
    const cv = { width: 1920, height: 1080 };
    const content = { w: 1920, h: 1080, crop: { left: 0, top: 0, right: 0, bottom: 0 } };
    const sq = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 * 16 / 9 }; // a square on the canvas
    const c = fitBox(sq, cv, content, 'contain');
    assert.equal(c.crop, null);
    assert.ok(Math.abs((c.box.w * 1920) / (c.box.h * 1080) - 16 / 9) < 1e-9);
    const v = fitBox(sq, cv, content, 'cover', 0.5);
    assert.deepEqual(v.box, sq);
    assert.deepEqual(v.crop, { left: 420, top: 0, right: 420, bottom: 0 });
    assert.equal(fitBox(sq, cv, content, 'cover', 0.4).fit, 'contain'); // 43.75 % cut > 40 %
  });
});

describe('SB3 the other canvas follows the rules', () => {
  test('V from an H reference: inside the V safe zone, nothing overlaps, the game shows the whole picture', () => {
    const p = project();
    const { diff } = planScenePackage(p, buildPackage(reads.H, p));
    const cv = canvasOf(p, 'v'), S = RULES.v.safeBox;
    const ls = layersOn(diff, 'v');
    assert.deepEqual(ls.map((l) => l.key).sort(), ['alerts', 'camera', 'chat', 'game']);
    for (const l of ls) assert.ok(within(box(l, cv), S, 0.001), `${l.key} inside the safe zone`);
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) assert.ok(overlap(box(ls[i], cv), box(ls[j], cv)) < 1e-6, `${ls[i].key} / ${ls[j].key}`);
    const game = byKey(diff, 'v', 'game');
    const src = p.scenes[0].layers.find((l) => l.id === game.shows.layer);
    const full = (c) => ({ left: 0, top: 0, right: 0, bottom: 0, ...(c ?? {}) });
    assert.deepEqual(full(game.crop), full(src.placements.h.crop), 'no crop beyond the one the existing game layer already has');
    const k = full(src.placements.h.crop);
    const aspect = (1920 - k.left - k.right) / (1080 - k.top - k.bottom);
    assert.ok(Math.abs(game.rect.width / game.rect.height - aspect) < 0.01, 'game aspect kept');
    assert.ok(diff.notCarried.some((n) => n.canvas === 'v' && n.role === 'graphics'));
  });

  test('H from a V reference: left column beside the game, inside the canvas, no overlap; a V reference outside the safe zone is warned, kept as drawn', () => {
    const p = project();
    const pkg = buildPackage(reads.V, p);
    const { diff } = planScenePackage(p, pkg);
    const cv = canvasOf(p, 'h');
    const ls = layersOn(diff, 'h');
    assert.deepEqual(ls.map((l) => l.key).sort(), ['alerts', 'camera', 'chat', 'game']);
    for (const l of ls) assert.ok(within(box(l, cv), { x: 0, y: 0, w: 1, h: 1 }, 0.001));
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) assert.ok(overlap(box(ls[i], cv), box(ls[j], cv)) < 1e-6, `${ls[i].key} / ${ls[j].key}`);
    const col = ['camera', 'alerts', 'chat'].map((k) => box(byKey(diff, 'h', k), cv));
    assert.ok(col.every((b) => b.x + b.w <= box(byKey(diff, 'h', 'game'), cv).x + 1e-6), 'column left of the game');
    assert.ok(pkg.warnings.some((w) => /chat outside the V safe zone/.test(w)));
  });
});

describe('SB3 sources by reference, placeholders, never guessed', () => {
  test('game and camera show the existing layers (duplicates); chat and alerts reuse the existing overlay pages and settings; no device, no capture layer added', () => {
    const p = project();
    const pkg = buildPackage(reads.H, p, { theme: 'combat' });
    const { project: out, diff } = planScenePackage(p, pkg);
    assert.equal(out.devices.length, p.devices.length);
    assert.equal(diff.devicesCreated, 0);
    const scene = out.scenes.at(-1);
    assert.equal(scene.layers.filter((l) => l.type === 'capture').length, 0);
    const realGame = p.scenes[0].layers.find((l) => l.type === 'capture' && l.source.device === 'dev-cap');
    const realCam = p.scenes[0].layers.find((l) => l.type === 'capture' && l.source.device === 'dev-cam');
    for (const c of ['h', 'v']) {
      assert.equal(byKey(diff, c, 'game').shows.layer, realGame.id);
      assert.equal(byKey(diff, c, 'camera').shows.layer, realCam.id);
      assert.equal(byKey(diff, c, 'chat').shows.overlay, p.overlays.find((o) => o.file.rel.startsWith('chat-list/')).id);
      assert.deepEqual(byKey(diff, c, 'alerts').shows, { overlay: 'ov-alert-box', existing: true });
    }
    const alerts = scene.layers.find((l) => l.source.overlay === 'ov-alert-box' && l.placements.v);
    const q = new URLSearchParams(alerts.source.query);
    assert.equal(q.get('hold'), '6000'); // the existing layer's own settings
    assert.equal(q.get('types'), 'follow,raid');
    assert.equal(q.get('canvas'), 'vertical');
    assert.equal(q.get('theme'), 'combat'); // theme tokens through the brand theme
    assert.equal(q.get('x'), '0');
    assert.deepEqual(diff.adds.overlays.map((o) => o.rel), ['ujwalam-panel/index.html']);
    const panel = scene.layers.find((l) => l.source.overlay === diff.adds.overlays[0].id);
    assert.equal(new URLSearchParams(panel.source.query).get('radius'), RULES.panel.radius[reads.H.style.cornerRadius.class]);
    assert.equal(diff.placeholders.length, 0);
  });

  test('a missing source and a low-confidence slot become placeholders that keep the geometry and say why', () => {
    const p = project({ alerts: false });
    const rules = { ...loadBuildRules(), minConfidence: 0.6 }; // the chat slot reads 0.55
    const pkg = buildPackage(reads.H, p, { rules });
    schemaOk(pkg);
    const { project: out, diff } = planScenePackage(p, pkg);
    const reasons = Object.fromEntries(diff.placeholders.filter((x) => x.canvas === 'h').map((x) => [x.role, x.reason]));
    assert.match(reasons.alerts, /no alerts overlay layer/);
    assert.match(reasons.chat, /low confidence 0\.55/);
    for (const c of ['h', 'v']) for (const k of ['alerts', 'chat']) {
      const l = byKey(diff, c, k);
      assert.equal(l.type, 'color');
      assert.ok(l.placeholder);
    }
    const ph = out.scenes.at(-1).layers.find((l) => l.name === 'Placeholder: chat' && l.placements.h);
    assert.equal(ph.source.color, '#00000000');
    assert.ok(sidesOff(frac(ph.placements.h, canvasOf(p, 'h')), layoutH().truth.chat) <= EDGE_TOL, 'placeholder holds the slot geometry');
    assert.match(diffText(diff), /PLACEHOLDER \(low confidence 0\.55/);
  });

  test('two cameras and none marked: the camera is a placeholder asking for --bind; --bind picks it', () => {
    const p = project({ cameras: 2 });
    for (const s of p.scenes) s.layers = s.layers.filter((l) => !(l.type === 'capture' && l.source.device === 'dev-cam') && !(l.type === 'duplicate'));
    delete p.devices.find((d) => d.id === 'dev-cam').origin;
    assert.ok(validateProject(p).ok);
    const pkg = buildPackage(reads.H, p);
    assert.match(pkg.placeholders.find((x) => x.role === 'camera').reason, /none is marked as the camera; choose one with --bind camera=/);
    const bound = buildPackage(reads.H, p, { bind: { camera: 'dev-cam2' } });
    assert.ok(!bound.placeholders.some((x) => x.role === 'camera'));
    const { project: out, diff } = planScenePackage(p, bound);
    // only a device: a capture layer on the existing device for H; the V one shares it (one device opened once)
    assert.equal(byKey(diff, 'h', 'camera').type, 'capture');
    assert.deepEqual(byKey(diff, 'h', 'camera').shows, { device: 'dev-cam2', existing: true });
    assert.equal(byKey(diff, 'v', 'camera').type, 'duplicate');
    assert.equal(out.devices.length, p.devices.length);
    const bad = buildPackage(reads.H, p, { bind: { game: 'nope' } });
    assert.match(bad.placeholders.find((x) => x.role === 'game').reason, /no layer or device with that id/);
  });

  test('a package built for one project, imported into another: a lost binding is a placeholder, never re-guessed', () => {
    const pkg = buildPackage(reads.H, project());
    const other = project();
    for (const s of other.scenes) s.layers = s.layers.filter((l) => !(l.type === 'capture' && l.source.device === 'dev-cap') && l.type !== 'duplicate');
    assert.ok(validateProject(other).ok);
    const { diff } = planScenePackage(other, pkg);
    assert.ok(diff.placeholders.some((x) => x.role === 'game' && /not in this project/.test(x.reason)));
    assert.equal(byKey(diff, 'h', 'game').type, 'color');
    assert.ok(diff.unbound.includes('h:game') && diff.unbound.includes('v:game'));
    assert.equal(diff.existingState.unchanged, true);
  });
});

describe('SB3 existing state never changes', () => {
  test('dry run: the input is untouched and the existing state hashes the same; the scene is new and namespaced', () => {
    const p = project();
    const before = stateHash(p), text = JSON.stringify(p);
    const pkg = buildPackage(reads.H, p);
    const { project: out, diff } = planScenePackage(p, pkg);
    assert.equal(JSON.stringify(p), text);
    assert.equal(stateHash(p), before);
    assert.equal(diff.existingState.before, before);
    assert.equal(diff.existingState.after, before);
    assert.equal(diff.existingState.unchanged, true);
    assert.deepEqual([diff.changes, diff.removes], [[], []]);
    assert.equal(out.scenes.length, p.scenes.length + 1);
    assert.deepEqual(out.scenes.slice(0, p.scenes.length), p.scenes);
    assert.equal(out.activeScene, p.activeScene);
    const s = out.scenes.at(-1);
    assert.equal(s.name, 'Built: ref layout');
    assert.deepEqual(s.origin, { importer: 'scene-package', id: pkg.id });
    // a second import of the same package gets its own name
    assert.equal(planScenePackage(out, pkg).diff.adds.scenes[0].name, 'Built: ref layout (2)');
  });

  test('round trip: build -> package file -> importer dry run (file unchanged) -> apply to a temp project -> reload, existing state hash unchanged', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb3-'));
    try {
      const file = path.join(dir, 'projects', 'rt.project.json');
      const p = project();
      saveProject(file, p);
      const bytes = readFileSync(file, 'utf8');
      const before = stateHash(loadProject(file).project);
      const pkgFile = path.join(dir, 'pkg.json');
      writeFileSync(pkgFile, JSON.stringify(buildPackage(reads.V, p)));
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      schemaOk(pkg);
      const dry = applyScenePackageFile(file, pkg);
      assert.equal(dry.saved, false);
      assert.equal(readFileSync(file, 'utf8'), bytes);
      const done = applyScenePackageFile(file, pkg, { dryRun: false });
      assert.equal(done.saved, true);
      const back = loadProject(file).project;
      assert.ok(validateProject(back).ok);
      const added = back.scenes.find((s) => s.id === done.diff.adds.scenes[0].id);
      assert.ok(added);
      const rest = { ...back, scenes: back.scenes.filter((s) => s !== added), overlays: back.overlays.filter((o) => !done.diff.adds.overlays.some((a) => a.id === o.id)) };
      assert.equal(stateHash(rest), before);
      assert.equal(back.devices.length, p.devices.length);
      // the saved scene's placements are the dry run's
      assert.equal(added.layers.length, dry.diff.adds.layers.length);
      for (const l of dry.diff.adds.layers) {
        const pl = added.layers.find((x) => x.name === l.name && x.placements[l.canvas]).placements[l.canvas];
        assert.deepEqual({ x: pl.x, y: pl.y, width: pl.width, height: pl.height }, l.rect, `${l.canvas}:${l.key}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('refused: a malformed package; a project that needs its backup', () => {
    assert.ok(packageProblems({ format: 'x' }).length >= 3);
    assert.throws(() => planScenePackage(project(), { format: 'x' }), /not an importable scene package/);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb3-'));
    try {
      const file = path.join(dir, 'p.project.json');
      saveProject(file, project());
      saveProject(file, project()); // makes the .bak
      writeFileSync(file, '{ broken');
      assert.throws(() => applyScenePackageFile(file, buildPackage(reads.H, project()), { dryRun: false }), /loaded only from its backup/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('SB3 apply is a guarded transaction (Codex review of D341)', () => {
  let dir, file, original;
  const setup = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb3t-'));
    file = path.join(dir, 'projects', 't.project.json');
    const p = project();
    saveProject(file, p);
    original = readFileSync(file);
    return p;
  };
  const studioBytes = (p) => { const q = structuredClone(p); q.scenes[0].name = 'Edited in the studio'; return `${JSON.stringify(q, null, 2)}
`; };
  const temps = () => readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('a studio save between load and save is never overwritten (compare-and-swap)', () => {
    const p = setup();
    const pkg = buildPackage(reads.H, p);
    const edited = studioBytes(p);
    let wrote = false;
    const idFn = (prefix) => { if (!wrote) { wrote = true; writeFileSync(file, edited); } return `${prefix}-${Math.random().toString(16).slice(2, 10)}`; };
    assert.throws(() => applyScenePackageFile(file, pkg, { dryRun: false, idFn, isRunning: () => false }), /changed on disk/);
    assert.equal(readFileSync(file, 'utf8'), edited);
    assert.deepEqual(temps(), []);
    rmSync(dir, { recursive: true, force: true });
  });

  test('refused while the host or event core of that data folder runs (host.json / api.json pid); a stale marker does not block', () => {
    const p = setup();
    const pkg = buildPackage(reads.H, p);
    for (const marker of ['host.json', 'api.json']) {
      const m = path.join(dir, marker);
      writeFileSync(m, JSON.stringify({ port: 1, pid: 4242 }));
      assert.throws(() => applyScenePackageFile(file, pkg, { dryRun: false, isRunning: (pid) => pid === 4242 }), /close the studio/);
      assert.deepEqual(readFileSync(file), original);
      assert.ok(applyScenePackageFile(file, pkg, { isRunning: (pid) => pid === 4242 }).diff, 'a dry run is still allowed');
      rmSync(m);
    }
    writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ port: 1, pid: 4242 }));
    assert.equal(applyScenePackageFile(file, pkg, { dryRun: false, isRunning: () => false }).saved, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a throw in the after-save check restores the exact loaded bytes through temp + rename, never the shared .bak', () => {
    const p = setup();
    writeFileSync(`${file}.bak`, '{ not the loaded bytes');
    const pkg = buildPackage(reads.H, p);
    assert.throws(() => applyScenePackageFile(file, pkg, { dryRun: false, isRunning: () => false, hooks: { afterWrite: () => { throw new Error('disk hiccup'); } } }), /after-save check.*put back/);
    assert.deepEqual(readFileSync(file), original);
    assert.deepEqual(readFileSync(`${file}.bak`), original, '.bak holds the loaded bytes (store.mjs behaviour), not the stale one');
    assert.deepEqual(temps(), []);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a failed check never restores over a file someone else wrote after the import', () => {
    const p = setup();
    writeFileSync(`${file}.bak`, '{ not the loaded bytes');
    const pkg = buildPackage(reads.H, p);
    const edited = studioBytes(p);
    assert.throws(() => applyScenePackageFile(file, pkg, { dryRun: false, isRunning: () => false, hooks: { afterWrite: () => writeFileSync(file, edited) } }), /changed by another writer; it was left as it is/);
    assert.equal(readFileSync(file, 'utf8'), edited);
    assert.deepEqual(temps(), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SB3 CLI behind the scene-builder flag', () => {
  let dir, png, file;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb3c-'));
    png = writePng(layoutH().canvas, dir, 'layout');
    file = path.join(dir, 'projects', 'c.project.json');
    saveProject(file, project());
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = async (argv, on = true) => {
    const out = [], err = [];
    const code = await cli(argv, (s) => out.push(s), (s) => err.push(s), { flagsOn: () => on });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  test('flag off: exit 2 and nothing read or written', async () => {
    const bytes = readFileSync(file, 'utf8');
    const r = await run(['build', png, '--project', file, '--apply'], false);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });

  test('build is a dry run by default; --out saves the package (never over a file); import --apply adds the scene', async () => {
    const bytes = readFileSync(file, 'utf8');
    const pkgFile = path.join(dir, 'pkg.json');
    const r = await run(['build', png, '--project', file, '--out', pkgFile]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Dry run: nothing written\. Adds 1 scene "Built: layout" \(H \+ V, \d+ layers\)\. Changes 0, removes 0, new devices 0\./);
    assert.match(r.out, /existing state unchanged/);
    assert.equal(readFileSync(file, 'utf8'), bytes);
    schemaOk(JSON.parse(readFileSync(pkgFile, 'utf8')));
    assert.equal((await run(['build', png, '--project', file, '--out', pkgFile])).code, 1);
    const j = await run(['import', pkgFile, '--project', file, '--json']);
    assert.equal(JSON.parse(j.out).dryRun, true);
    assert.equal(readFileSync(file, 'utf8'), bytes);
    const a = await run(['import', pkgFile, '--project', file, '--apply']);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /^Applied\./);
    assert.equal(loadProject(file).project.scenes.at(-1).name, 'Built: layout');
  });

  test('bad arguments: exit 1 with the usage', async () => {
    assert.equal((await run(['build', png])).code, 1);
    assert.equal((await run(['build', png, '--project', file, '--bind', 'mic=dev-x'])).code, 1);
    assert.equal((await run(['read', png, '--apply'])).code, 1);
  });
});

test('token panel page: tokens only (no colour of its own), no innerHTML, a short fade only', () => {
  const html = readFileSync(path.join(REPO, 'services', 'overlay-server', 'pages', 'ujwalam-panel', 'index.html'), 'utf8');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(html, /innerHTML|<script src="http|cdn/i);
  const ms = [...css.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(ms.length && ms.every((v) => v < 600));
});
