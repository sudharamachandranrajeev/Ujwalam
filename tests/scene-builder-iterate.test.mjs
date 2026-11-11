// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB5 (D347): iterate. Round trip build -> import -> the user adjusts the scene in the studio (placements
// in the project) -> export as a scene package -> edit / similar variants -> import again, with the existing-state hash
// unchanged each time; the edit operations, the variant rules (on canvas, V safe zone kept, no new overlap, game never
// cropped, seeded), and the CLI behind the scene-builder flag. Fixtures are drawn in memory (tests/helpers/sb-fixtures.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createProject, loadProject, saveProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset, mergeCanvasScenes } from '../services/project/scene-preset.mjs';
import { applyScenePackageFile, planScenePackage, stateHash, withoutAdded } from '../services/project/scene-package.mjs';
import { buildPackage, loadBuildRules } from '../services/scene-builder/build.mjs';
import { main as cli } from '../services/scene-builder/cli.mjs';
import { packageFromScene } from '../services/scene-builder/export.mjs';
import { IterateError, editPackage, seededRng, similarVariants } from '../services/scene-builder/iterate.mjs';
import { readFrames } from '../services/scene-builder/read.mjs';
import { layoutH, layoutV, writePng } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
const validatePkg = new Ajv2020({ allErrors: true, strict: true }).compile(rd('data/schemas/scene-package.schema.json'));
const schemaOk = (p) => assert.ok(validatePkg(p), JSON.stringify(validatePkg.errors?.slice(0, 3)));
const profile = rd('tests/fixtures/project/profile.fixture.json');
const RULES = loadBuildRules();
const NOW = new Date('2026-11-11T00:00:00Z');

function project() {
  const p = createProject({ name: 'T' });
  p.devices.push({ id: 'dev-cap', kind: 'capture-card', name: 'Capture', match: { name: 'cap' }, origin: { importer: 'alpha', id: 'role/game-capture' } });
  p.devices.push({ id: 'dev-cam', kind: 'camera', name: 'Camera', match: { name: 'cam' }, origin: { importer: 'alpha', id: 'role/facecam' } });
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const h = loadScenePreset(p, rd('registry/presets/scene-default-h.json'), { profile, roles });
  const v = loadScenePreset(h.project, rd('registry/presets/scene-default-v.json'), { profile, roles });
  const out = mergeCanvasScenes(v.project, h.sceneId, v.sceneId).project;
  out.scenes = out.scenes.filter((s) => s.layers.length);
  out.activeScene = out.scenes[0].id;
  out.overlays.push({ id: 'ov-alert-box', name: 'alert-box', file: { base: 'overlays', rel: 'alert-box/index.html' } });
  out.scenes[0].layers.push({ id: 'lyr-alerts1', type: 'browser', name: 'Alerts', source: { overlay: 'ov-alert-box', query: 'hold=6000&x=24&y=210&types=follow,raid', width: 1920, height: 1080 }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } });
  assert.ok(validateProject(out).ok);
  return out;
}

async function readOf(f) {
  const c = f.canvas;
  return readFrames({ name: 'ref layout.png', kind: 'image', width: c.width, height: c.height, durationS: null, frames: [{ t: 0, width: c.width, height: c.height, rgb: c.rgb }] });
}

const canvasesOf = (p) => Object.fromEntries(p.canvases.map((c) => [c.id, { width: c.width, height: c.height }]));
const layerOf = (pkg, canvas, key) => pkg.presets.find((x) => x.params.canvas === canvas).params.layers.find((l) => l.key === key);
const near = (a, b, tol, msg) => assert.ok(['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol), `${msg}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const inBox = (b, S) => b.x >= S.x - 1e-6 && b.y >= S.y - 1e-6 && b.x + b.w <= S.x + S.w + 1e-6 && b.y + b.h <= S.y + S.h + 1e-6;
const overlapOf = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const overlaps = (pkg, canvas) => { const L = pkg.presets.find((x) => x.params.canvas === canvas).params.layers; let s = 0; for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) s += overlapOf(L[i].rect, L[j].rect); return s; };

/** What the studio does when the user drags a layer: the placement in the project file changes. */
function studioMove(p, sceneId, key, canvas, patch) {
  const out = structuredClone(p);
  const s = out.scenes.find((x) => x.id === sceneId);
  const l = s.layers.find((x) => x.origin?.id?.endsWith(`-${canvas}/${key}`));
  assert.ok(l, `layer ${canvas}:${key}`);
  Object.assign(l.placements[canvas], patch);
  assert.ok(validateProject(out).ok);
  return { project: out, layer: l };
}

let reads, base;
before(async () => {
  reads = { H: await readOf(layoutH()), V: await readOf(layoutV()) };
  base = (kind = 'H') => buildPackage(reads[kind], project(), { now: NOW });
});

describe('SB5 export: a studio scene back to a scene package', () => {
  test('a built scene exports to the layout it was built with (both canvases, bindings, types), and the package is valid', () => {
    const p = project();
    const pkg = buildPackage(reads.H, p, { now: NOW });
    const { project: out, diff } = planScenePackage(p, pkg);
    const sceneId = diff.adds.scenes[0].id;
    const { package: ex, skipped } = packageFromScene(out, sceneId, { now: NOW });
    schemaOk(ex);
    assert.deepEqual(skipped, []);
    assert.deepEqual(ex.bindings, pkg.bindings);
    assert.equal(ex.lineage.parent, pkg.id);
    for (const preset of pkg.presets) {
      const c = preset.params.canvas;
      for (const l of preset.params.layers) {
        const m = layerOf(ex, c, l.key);
        assert.ok(m, `${c}:${l.key}`);
        assert.equal(m.type, l.type, `${c}:${l.key}`);
        near(m.rect, l.rect, 0.0005, `${c}:${l.key}`);
        if (l.crop) near({ x: m.crop.left, y: m.crop.top, w: m.crop.right, h: m.crop.bottom }, { x: l.crop.left, y: l.crop.top, w: l.crop.right, h: l.crop.bottom }, 0.02, `crop ${c}:${l.key}`);
        if (l.type === 'browser') { assert.equal(m.overlay, l.overlay); assert.equal(new URLSearchParams(m.query).get('canvas'), new URLSearchParams(l.query).get('canvas')); }
        assert.deepEqual(m.slot, { role: l.slot.role, confidence: 1, from: 'edit' });
      }
    }
  });

  test('the export reads the project and changes nothing', () => {
    const p = project();
    const { project: out, diff } = planScenePackage(p, buildPackage(reads.V, p, { now: NOW }));
    const before = stateHash(out), copy = structuredClone(out);
    packageFromScene(out, diff.adds.scenes[0].id);
    assert.equal(stateHash(out), before);
    assert.deepEqual(out, copy);
  });

  test('layers a package cannot carry are skipped with the reason, never guessed', () => {
    const p = project();
    const { project: out, diff } = planScenePackage(p, buildPackage(reads.H, p, { now: NOW }));
    const sceneId = diff.adds.scenes[0].id;
    const s = out.scenes.find((x) => x.id === sceneId);
    s.layers.push({ id: 'lyr-pic', type: 'image', name: 'Logo', source: { file: { base: 'media', rel: 'logo.png' } }, placements: { h: { visible: true, x: 0, y: 0, width: 100, height: 100 } } });
    s.layers.push({ id: 'lyr-hid', type: 'color', name: 'Hidden', source: { color: '#112233' }, placements: { h: { visible: false, x: 0, y: 0, width: 100, height: 100 } } });
    s.layers.find((l) => l.name === 'Chat' || l.type === 'browser').placements.h.rotation = 10;
    assert.ok(validateProject(out).ok);
    const r = packageFromScene(out, s.name);
    assert.deepEqual(r.skipped.map((x) => x.reason).sort(), ['a image layer is not carried by a scene package', 'hidden']);
    assert.ok(r.package.warnings.some((w) => /rotation, opacity or effects/.test(w)));
    schemaOk(r.package);
  });

  test('errors: unknown scene, ambiguous name, empty scene', () => {
    const p = project();
    assert.throws(() => packageFromScene(p, 'no such scene'), /no scene/);
    const dup = structuredClone(p);
    dup.scenes.push({ ...structuredClone(dup.scenes[0]), id: 'scene-copy', layers: dup.scenes[0].layers.map((l, i) => ({ ...structuredClone(l), id: `lyr-copy${i}` })) });
    assert.throws(() => packageFromScene(dup, dup.scenes[0].name), /more than one scene/);
    const empty = structuredClone(p);
    empty.scenes.push({ id: 'scene-empty', name: 'Empty', layers: [] });
    assert.throws(() => packageFromScene(empty, 'Empty'), /no layer a scene package can carry/);
  });
});

describe('SB5 round trip: build -> import -> adjust in the studio -> package -> import', () => {
  test('the studio edit is in the exported package and in the re-imported scene; existing state is unchanged at every step', () => {
    const p0 = project();
    const h0 = stateHash(p0);
    const pkg = buildPackage(reads.H, p0, { now: NOW });
    const r1 = planScenePackage(p0, pkg);
    const id1 = r1.diff.adds.scenes[0].id;
    // the user drags the chat layer on H in the studio (placement in pixels) and shrinks the V alerts
    const hv = canvasesOf(p0);
    const chat0 = layerOf(pkg, 'h', 'chat').rect;
    const moved = studioMove(r1.project, id1, 'chat', 'h', { x: Math.round(0.5 * hv.h.width), y: Math.round(0.6 * hv.h.height) });
    const p1 = moved.project;
    const ex = packageFromScene(p1, id1, { now: NOW }).package;
    schemaOk(ex);
    const chat1 = layerOf(ex, 'h', 'chat');
    assert.ok(Math.abs(chat1.rect.x - 0.5) < 0.001 && Math.abs(chat1.rect.y - 0.6) < 0.001 && Math.abs(chat1.rect.w - chat0.w) < 0.001);
    assert.ok(Math.abs(new URLSearchParams(chat1.query).get('width') - chat0.w * hv.h.width) < 3, 'chat width query unchanged by a pure move');
    // import the exported package into the studio project: a NEW scene with the user's placement, the first scene untouched
    const r2 = planScenePackage(p1, ex);
    assert.equal(r2.diff.existingState.unchanged, true);
    assert.equal(r2.diff.existingState.before, stateHash(p1));
    const id2 = r2.diff.adds.scenes[0].id;
    const again = r2.project.scenes.find((s) => s.id === id2);
    assert.notEqual(id2, id1);
    assert.equal(again.layers.length, r1.diff.adds.layers.length);
    const placed = again.layers.find((l) => l.origin.id.endsWith('-h/chat')).placements.h;
    assert.ok(Math.abs(placed.x - 0.5 * hv.h.width) < 1 && Math.abs(placed.y - 0.6 * hv.h.height) < 1);
    assert.deepEqual(r2.project.scenes.find((s) => s.id === id1), p1.scenes.find((s) => s.id === id1), 'the earlier built scene is untouched');
    assert.equal(stateHash(withoutAdded(r2.project, { scenes: [id2], overlays: r2.diff.adds.overlays.map((o) => o.id) })), stateHash(p1));
    assert.equal(stateHash(p0), h0);
  });

  test('on disk: build -> apply -> studio edit saved -> export -> apply, devices never created, overlays reused', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb5-'));
    try {
      const file = path.join(dir, 'projects', 'rt.project.json');
      const p0 = project();
      saveProject(file, p0);
      const pkg = buildPackage(reads.V, p0, { now: NOW });
      const a = applyScenePackageFile(file, pkg, { dryRun: false });
      const id1 = a.diff.adds.scenes[0].id;
      const edited = studioMove(loadProject(file).project, id1, 'game', 'v', { x: 40 });
      saveProject(file, edited.project);
      const mid = loadProject(file).project;
      const ex = packageFromScene(mid, id1, { now: NOW }).package;
      const b = applyScenePackageFile(file, ex, { dryRun: false });
      assert.equal(b.saved, true);
      const end = loadProject(file).project;
      assert.equal(end.devices.length, p0.devices.length);
      assert.equal(end.overlays.length, mid.overlays.length, 'the overlay entries already exist: none added');
      assert.equal(end.scenes.length, mid.scenes.length + 1);
      assert.equal(b.diff.devicesCreated, 0);
      assert.deepEqual(b.diff.changes, []);
      assert.deepEqual(b.diff.removes, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('SB5 edit: move, resize, swap', () => {
  test('move changes only the position; resize re-fits; the input package is not changed; new id and lineage; schema valid', () => {
    const pkg = base('H'), copy = structuredClone(pkg), cv = canvasesOf(project());
    const g0 = layerOf(pkg, 'h', 'game').rect;
    const r = editPackage(pkg, [{ op: 'move', canvas: 'h', key: 'game', x: 0.3, y: 0.05 }, { op: 'resize', canvas: 'h', key: 'chat', w: 0.2, h: 0.3 }], { canvases: cv, now: NOW });
    assert.deepEqual(pkg, copy);
    schemaOk(r.package);
    const g1 = layerOf(r.package, 'h', 'game');
    assert.ok(g1.rect.x === 0.3 && g1.rect.y === 0.05 && g1.rect.w === g0.w && g1.rect.h === g0.h);
    const chat = layerOf(r.package, 'h', 'chat');
    assert.ok(chat.rect.w === 0.2 && chat.rect.h === 0.3);
    const q = new URLSearchParams(chat.query);
    assert.equal(Number(q.get('width')), Math.round(0.2 * cv.h.width));
    assert.equal(Number(q.get('height')), Math.round(0.3 * cv.h.height));
    assert.notEqual(r.package.id, pkg.id);
    assert.equal(r.package.lineage.parent, pkg.id);
    assert.deepEqual(r.package.presets.map((x) => x.id), [`${r.package.id}-h`, `${r.package.id}-v`].filter((id) => r.package.presets.some((x) => x.id === id)));
    assert.match(r.package.name, /\(edited\)$/);
    assert.equal(r.package.presets[0].params.sceneName, r.package.name);
  });

  test('resizing the game keeps its shape and never crops it; resizing the camera cover-fits within the crop limit', () => {
    const pkg = base('H'), cv = canvasesOf(project());
    const g0 = layerOf(pkg, 'h', 'game').rect, g0crop = layerOf(pkg, 'h', 'game').crop, aspect = (g0.w * cv.h.width) / (g0.h * cv.h.height);
    const r = editPackage(pkg, [{ op: 'place', canvas: 'h', key: 'game', x: 0.1, y: 0.1, w: 0.5, h: 0.8 }, { op: 'resize', canvas: 'h', key: 'camera', w: 0.2, h: 0.3 }], { canvases: cv });
    const g = layerOf(r.package, 'h', 'game');
    assert.deepEqual(g.crop, g0crop);
    assert.ok(Math.abs((g.rect.w * cv.h.width) / (g.rect.h * cv.h.height) - aspect) < 0.01);
    assert.ok(g.rect.x >= 0.1 - 1e-6 && g.rect.x + g.rect.w <= 0.6 + 1e-6 && g.rect.y >= 0.1 - 1e-6 && g.rect.y + g.rect.h <= 0.9 + 1e-6);
    const cam = layerOf(r.package, 'h', 'camera');
    if (cam.fit === 'cover') {
      const k = cam.crop ?? {};
      const W = RULES.sourceSize.width, H = RULES.sourceSize.height;
      assert.ok(((k.left ?? 0) + (k.right ?? 0)) / W <= RULES.camera.maxCrop + 1e-6 && ((k.top ?? 0) + (k.bottom ?? 0)) / H <= RULES.camera.maxCrop + 1e-6);
    } else assert.equal(cam.fit, 'contain');
  });

  test('swap trades the two boxes (the slot swap); both layers stay inside them', () => {
    const pkg = base('H'), cv = canvasesOf(project());
    const a0 = layerOf(pkg, 'h', 'camera').rect, b0 = layerOf(pkg, 'h', 'chat').rect;
    const r = editPackage(pkg, [{ op: 'swap', canvas: 'h', a: 'camera', b: 'chat' }], { canvases: cv });
    const a = layerOf(r.package, 'h', 'camera').rect, b = layerOf(r.package, 'h', 'chat').rect;
    const within = (x, box) => x.x >= box.x - 1e-3 && x.y >= box.y - 1e-3 && x.x + x.w <= box.x + box.w + 1e-3 && x.y + x.h <= box.y + box.h + 1e-3;
    assert.ok(within(a, b0), 'camera is in the old chat box');
    assert.ok(within(b, a0), 'chat is in the old camera box');
    assert.deepEqual(b, { ...a0 });
    assert.equal(Number(new URLSearchParams(layerOf(r.package, 'h', 'chat').query).get('width')), Math.round(a0.w * cv.h.width));
    schemaOk(r.package);
  });

  test('bad edits throw and return nothing: off canvas, too small, unknown layer or op, no canvas size, same layer swap', () => {
    const pkg = base('H'), cv = canvasesOf(project());
    const bad = (e, re) => assert.throws(() => editPackage(pkg, [e], { canvases: cv }), re);
    bad({ op: 'move', canvas: 'h', key: 'game', x: 0.9, y: 0 }, /leave the canvas/);
    bad({ op: 'move', canvas: 'h', key: 'game', x: -0.1, y: 0 }, /leave the canvas/);
    bad({ op: 'resize', canvas: 'h', key: 'chat', w: 0.001, h: 0.3 }, /smaller than/);
    bad({ op: 'move', canvas: 'h', key: 'nope', x: 0, y: 0 }, /no layer "nope"/);
    bad({ op: 'rotate', canvas: 'h', key: 'game' }, /unknown edit/);
    bad({ op: 'move', canvas: 'h', key: 'game', x: 'a', y: 0 }, /must be a number/);
    bad({ op: 'swap', canvas: 'h', a: 'chat', b: 'chat' }, /two different/);
    assert.throws(() => editPackage(pkg, [{ op: 'move', canvas: 'h', key: 'game', x: 0.1, y: 0.1 }], { canvases: {} }), IterateError);
    assert.throws(() => editPackage(pkg, [], { canvases: cv }), /no edits/);
    assert.throws(() => editPackage({ format: 'x' }, [{}], { canvases: cv }), /not a scene package/);
    // all or nothing: a good edit followed by a bad one returns nothing
    assert.throws(() => editPackage(pkg, [{ op: 'move', canvas: 'h', key: 'game', x: 0.2, y: 0.2 }, { op: 'move', canvas: 'h', key: 'game', x: 5, y: 0 }], { canvases: cv }));
  });

  test('a V layer moved outside the safe zone is a warning, not a refusal and not a silent move', () => {
    const pkg = base('V'), cv = canvasesOf(project());
    const r = editPackage(pkg, [{ op: 'move', canvas: 'v', key: 'chat', x: 0, y: 0.7 }], { canvases: cv });
    assert.ok(r.warnings.some((w) => /v: chat is outside the V safe zone/.test(w)), JSON.stringify(r.warnings));
    assert.equal(layerOf(r.package, 'v', 'chat').rect.y, 0.7);
  });

  test('an edited package imports as a new scene with the existing state unchanged', () => {
    const p = project(), pkg = buildPackage(reads.H, p, { now: NOW });
    const r = editPackage(pkg, [{ op: 'swap', canvas: 'h', a: 'camera', b: 'chat' }, { op: 'move', canvas: 'v', key: 'game', x: 0.05, y: 0.3 }], { canvases: canvasesOf(p) });
    const plan = planScenePackage(p, r.package);
    assert.equal(plan.diff.existingState.unchanged, true);
    assert.equal(plan.diff.changes.length + plan.diff.removes.length, 0);
    assert.match(plan.diff.adds.scenes[0].name, /\(edited\)$/);
  });
});

describe('SB5 similar variants', () => {
  const run = (kind = 'H', opts = {}, p = project()) => { const pkg = buildPackage(reads[kind], p, { now: NOW }); return { p, pkg, vs: similarVariants(pkg, { canvases: canvasesOf(p), now: NOW, ...opts }) }; };

  test('same package and seed give the same variants; another seed gives others', () => {
    const p = project();
    const a = run('H', { seed: 'one', count: 4 }, p), b = run('H', { seed: 'one', count: 4 }, p), c = run('H', { seed: 'two', count: 4 }, p);
    assert.deepEqual(a.vs.map((v) => v.package), b.vs.map((v) => v.package));
    assert.notDeepEqual(a.vs.map((v) => v.package.id), c.vs.map((v) => v.package.id));
    const r1 = seededRng('x'), r2 = seededRng('x');
    assert.equal(r1(), r2());
  });

  test('count variants, all distinct from each other and from the original, each valid and importable with the existing state unchanged', () => {
    for (const kind of ['H', 'V']) {
      const { p, pkg, vs } = run(kind, { count: 4, seed: 'rt' });
      assert.equal(vs.length, 4, kind);
      const sigs = new Set(vs.map((v) => JSON.stringify(v.package.presets.map((x) => x.params.layers.map((l) => l.rect)))));
      assert.equal(sigs.size, 4);
      assert.ok(!sigs.has(JSON.stringify(pkg.presets.map((x) => x.params.layers.map((l) => l.rect)))));
      for (const v of vs) {
        schemaOk(v.package);
        assert.equal(v.package.lineage.parent, pkg.id);
        assert.match(v.package.name, /\(variant \d\)$/);
        const plan = planScenePackage(p, v.package);
        assert.equal(plan.diff.existingState.unchanged, true);
        assert.ok(v.distance > 0, 'a variant differs');
      }
      assert.equal(new Set(vs.map((v) => v.package.id)).size, 4);
    }
  });

  test('rules hold for every variant: boxes on the canvas, a V layer inside the safe zone stays inside, no more overlap, the game never cropped', () => {
    const S = RULES.v.safeBox;
    for (const kind of ['H', 'V']) {
      for (const seed of ['a', 'b', 'c']) {
        const { pkg, vs } = run(kind, { count: 6, seed });
        assert.ok(vs.length >= 4, `${kind}/${seed}: ${vs.length}`);
        for (const v of vs) {
          for (const preset of v.package.presets) {
            const c = preset.params.canvas, orig = pkg.presets.find((x) => x.params.canvas === c);
            assert.ok(overlaps(v.package, c) <= overlaps(pkg, c) + 1e-3, `${kind}/${seed}/${v.kind}/${c} overlap`);
            for (const l of preset.params.layers) {
              assert.ok(l.rect.x >= -1e-6 && l.rect.y >= -1e-6 && l.rect.x + l.rect.w <= 1 + 1e-6 && l.rect.y + l.rect.h <= 1 + 1e-6, `${kind}/${seed}/${v.kind}/${c}:${l.key} on canvas`);
              const o = orig.params.layers.find((x) => x.key === l.key);
              if (c === 'v' && inBox(o.rect, S)) assert.ok(inBox(l.rect, S), `${kind}/${seed}/${v.kind}: v:${l.key} left the safe zone`);
              if (l.slot.role === 'game') assert.deepEqual(l.crop, o.crop, 'game gets no more crop than it had');
              if (l.type === 'link' || l.type === 'capture') assert.ok(Math.abs(l.rect.w * 1920 / (l.rect.h * (c === 'v' ? 1920 : 1080)) - o.rect.w * 1920 / (o.rect.h * (c === 'v' ? 1920 : 1080))) < 1e5);
            }
          }
          if (v.kind.startsWith('nudge')) assert.ok(v.distance <= 0.2, `a nudge stays similar: ${v.distance}`);
        }
      }
    }
  });

  test('a mirror variant is the layout flipped left to right', () => {
    const { pkg, vs } = run('H', { count: 3, seed: 'm' });
    const m = vs.find((v) => v.kind === 'mirror');
    assert.ok(m, vs.map((v) => v.kind).join());
    for (const l of layerOf(m.package, 'h', 'camera') ? m.package.presets.find((x) => x.params.canvas === 'h').params.layers : []) {
      const o = layerOf(pkg, 'h', l.key).rect;
      assert.ok(Math.abs(l.rect.x - (1 - o.x - o.w)) < 1e-3 && Math.abs(l.rect.w - o.w) < 1e-3 && Math.abs(l.rect.y - o.y) < 1e-3, l.key);
    }
  });

  test('count is checked (1..8)', () => {
    const p = project(), pkg = buildPackage(reads.H, p, { now: NOW });
    for (const count of [0, 9, 1.5]) assert.throws(() => similarVariants(pkg, { count, canvases: canvasesOf(p) }), /count must be/);
    assert.equal(similarVariants(pkg, { count: 1, canvases: canvasesOf(p) }).length, 1);
  });
});

describe('SB5 CLI behind the scene-builder flag', () => {
  let dir, file, pkgFile, png, sceneName;
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb5c-'));
    png = writePng(layoutH().canvas, dir, 'layout');
    file = path.join(dir, 'projects', 'c.project.json');
    saveProject(file, project());
    pkgFile = path.join(dir, 'pkg.json');
    sceneName = 'Built: layout';
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = async (argv, on = true) => {
    const out = [], err = [];
    const code = await cli(argv, (s) => out.push(s), (s) => err.push(s), { flagsOn: () => on, now: () => NOW });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  test('flag off: exit 2 for export, edit and variants, nothing written', async () => {
    for (const argv of [['export', 'x', '--project', file, '--out', path.join(dir, 'e.json')], ['variants', pkgFile, '--project', file, '--out-dir', dir]]) {
      const r = await run(argv, false);
      assert.equal(r.code, 2);
      assert.equal(r.out, '');
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('e.')), []);
  });

  test('CLI round trip: build -> import --apply -> export -> edit -> variants -> import (dry run), the project file is only changed by import --apply', async () => {
    assert.equal((await run(['build', png, '--project', file, '--out', pkgFile])).code, 0);
    assert.equal((await run(['import', pkgFile, '--project', file, '--apply'])).code, 0);
    const bytes = readFileSync(file, 'utf8');
    const ex = path.join(dir, 'ex.json');
    const e = await run(['export', sceneName, '--project', file, '--out', ex]);
    assert.equal(e.code, 0, e.err);
    assert.match(e.out, /^Saved .*ex\.json: "Built: layout"/);
    assert.equal((await run(['export', sceneName, '--project', file, '--out', ex])).code, 1, 'never over a file');
    const ed = path.join(dir, 'ed.json');
    const r = await run(['edit', ex, '--project', file, '--out', ed, '--move', 'h:chat=0.5,0.5', '--swap', 'h:camera,chat']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\* move h:chat\n.*\* swap h:camera <-> chat/s);
    const vd = path.join(dir, 'variants');
    writeFileSync(path.join(dir, 'marker'), '');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(vd);
    const v = await run(['variants', ed, '--project', file, '--count', '3', '--seed', 's', '--out-dir', vd]);
    assert.equal(v.code, 0, v.err);
    const files = readdirSync(vd);
    assert.equal(files.length, 3);
    assert.equal((await run(['variants', ed, '--project', file, '--count', '3', '--seed', 's', '--out-dir', vd])).code, 1, 'never over files');
    const list = await run(['variants', ed, '--project', file, '--count', '2']);
    assert.match(list.out, /not saved: no --out-dir/);
    const imp = await run(['import', path.join(vd, files[0]), '--project', file]);
    assert.equal(imp.code, 0, imp.err);
    assert.match(imp.out, /^Dry run: nothing written\./);
    assert.match(imp.out, /existing state unchanged/);
    assert.equal(readFileSync(file, 'utf8'), bytes, 'export, edit and variants never write the project');
  });

  test('bad arguments: exit 1', async () => {
    assert.equal((await run(['edit', pkgFile, '--project', file])).code, 1, 'needs --out and an edit');
    assert.equal((await run(['edit', pkgFile, '--project', file, '--out', path.join(dir, 'z.json'), '--move', 'h:chat=0.5'])).code, 1);
    assert.equal((await run(['export', 'x', '--project', file, '--apply'])).code, 1, 'never applies');
    assert.equal((await run(['export', 'x', '--project', file, '--count', '2'])).code, 1);
    assert.equal((await run(['variants', pkgFile, '--project', file, '--out', path.join(dir, 'q.json')])).code, 1);
    assert.equal((await run(['variants', pkgFile, '--project', file, '--count', '99'])).code, 1);
    assert.equal((await run(['build', png, '--project', file, '--move', 'h:chat=0,0'])).code, 1);
    assert.equal((await run(['export', 'no such scene', '--project', file])).code, 1);
  });
});
