// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB1 + SB2 (D339): reference input (image, video sampled to N frames, local only), the typed read
// (palette, type feel, corner radius, glow, shadow, layout slots) against drawn fixtures with known truth, the local
// model hook, the CLI behind the scene-builder flag, and the result schema. Fixtures are drawn at test time
// (tests/helpers/sb-fixtures.mjs) into a temp folder; no picture is committed.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { deltaE, hexLab } from '../services/scene-builder/colour.mjs';
import { checkLocalFile, loadReference } from '../services/scene-builder/frames.mjs';
import { readFrames, readReference } from '../services/scene-builder/read.mjs';
import { main as cli } from '../services/scene-builder/cli.mjs';
import { layoutH, layoutV, paletteBlocks, stylePanels, writePng, writeVideo } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(path.join(REPO, 'data', 'schemas', 'reference-read.schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const valid = (r) => { const ok = validate(r); assert.ok(ok, JSON.stringify(validate.errors?.slice(0, 3))); };

// Tolerances (D339): every box side within EDGE_TOL of the frame side; palette colours within DE_TOL (OKLab
// distance) and shares within SHARE_TOL; corner radius within max(3 px, 15 %) on a 1080 px short side.
const EDGE_TOL = 0.03, DE_TOL = 0.02, SHARE_TOL = 0.02;
const sidesOff = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - b.x - b.w), Math.abs(a.y + a.h - b.y - b.h));

let dir;
before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('SB1 reference input', () => {
  test('an image loads as one frame at the analysis size, aspect kept', async () => {
    const f = layoutH();
    const p = writePng(f.canvas, dir, 'img');
    const r = await loadReference(p);
    assert.equal(r.kind, 'image');
    assert.equal(r.name, 'img.png');
    assert.deepEqual([r.width, r.height, r.durationS], [960, 540, null]);
    assert.equal(r.frames.length, 1);
    assert.deepEqual([r.frames[0].width, r.frames[0].height, r.frames[0].t], [960, 540, 0]);
    assert.equal(r.frames[0].rgb.length, 960 * 540 * 3);
    const small = await loadReference(p, { longSide: 480 });
    assert.deepEqual([small.frames[0].width, small.frames[0].height], [480, 270]);
  });
  test('a video is sampled to N evenly spaced frames', async () => {
    const canvases = [0, 1, 2, 3, 4, 5].map((i) => layoutH({ seed: 7 + i }).canvas);
    const p = writeVideo(canvases, dir, 'vid', 2); // 6 frames at 2 fps = 3 s
    const r = await loadReference(p, { frames: 4 });
    assert.equal(r.kind, 'video');
    assert.ok(Math.abs(r.durationS - 3) < 0.1, String(r.durationS));
    assert.equal(r.frames.length, 4);
    const step = r.durationS / 4;
    const last = r.durationS - 0.5; // the last frame starts at 2.5 s
    r.frames.forEach((fr, i) => assert.ok(Math.abs(fr.t - Math.min(last, (i + 0.5) * step)) < 0.02, `t${i} ${fr.t}`));
    assert.ok(r.frames.every((fr) => fr.width === 960 && fr.height === 540 && fr.rgb.length === 960 * 540 * 3));
    // the samples differ (the game area moves between them)
    assert.notDeepEqual(r.frames[0].rgb, r.frames[3].rgb);
    const one = await loadReference(p, { frames: 1 });
    assert.equal(one.frames.length, 1);
  });
  test('local files only, known types only, sane options', async () => {
    assert.throws(() => checkLocalFile('https://example.invalid/a.png'), /local files only/);
    assert.throws(() => checkLocalFile('file:///C:/a.png'), /local files only/);
    assert.throws(() => checkLocalFile('\\\\server\\share\\a.png'), /network share/);
    assert.throws(() => checkLocalFile('//server/share/a.png'), /network share/);
    assert.throws(() => checkLocalFile(path.join(dir, 'missing.png')), /no such file/);
    assert.throws(() => checkLocalFile(dir), /not a file/);
    const txt = path.join(dir, 'notes.txt'); writeFileSync(txt, 'x');
    assert.throws(() => checkLocalFile(txt), /unsupported file type/);
    const p = writePng(layoutV().canvas, dir, 'opt');
    await assert.rejects(loadReference(p, { frames: 0 }), /frames must be/);
    await assert.rejects(loadReference(p, { frames: 65 }), /frames must be/);
    await assert.rejects(loadReference(p, { longSide: 10 }), /longSide/);
    const bad = path.join(dir, 'broken.png'); writeFileSync(bad, 'not a png');
    await assert.rejects(loadReference(bad), /failed|no picture/);
  });
});

describe('SB2 palette (the 4.6 method) against known colours', () => {
  test('every drawn colour is a cluster at its share, and the roles land on the right colours', async () => {
    const f = paletteBlocks();
    const r = await readReference(writePng(f.canvas, dir, 'pal'));
    valid(r);
    for (const c of f.colours) {
      const hit = r.palette.clusters.reduce((a, k) => (deltaE(hexLab(k.hex), hexLab(c.hex)) < deltaE(hexLab(a.hex), hexLab(c.hex)) ? k : a));
      assert.ok(deltaE(hexLab(hit.hex), hexLab(c.hex)) <= DE_TOL, `${c.hex} -> ${hit.hex}`);
      assert.ok(Math.abs(hit.share - c.share) <= SHARE_TOL, `${c.hex} share ${hit.share} vs ${c.share}`);
    }
    const role = (k) => r.palette.roles[k].hex;
    for (const [k, want] of [['background', '#1a2b3c'], ['surface', '#2e4057'], ['text', '#f0f0f0'], ['accent', '#ff3366'], ['accentAlt', '#33ccff']]) {
      assert.ok(deltaE(hexLab(role(k)), hexLab(want)) <= DE_TOL, `${k} ${role(k)} vs ${want}`);
    }
    assert.ok(r.palette.contrast.textOnBackground >= 4.5);
  });
  test('a text colour that misses 4.5:1 is pushed and marked derived', async () => {
    const f = paletteBlocks();
    // repaint the light text block and the cyan a mid grey that fails 4.5:1 on the dark background
    for (let y = 0; y < f.canvas.height; y++) for (let x = 360; x < 400; x++) f.canvas.px(x, y, [110, 110, 110]);
    const r = await readReference(writePng(f.canvas, dir, 'pal2'));
    assert.equal(r.palette.roles.text.how, 'derived');
    assert.ok(r.palette.contrast.textOnBackground >= 4.5, String(r.palette.contrast.textOnBackground));
  });
});

describe('SB2 layout slots against drawn layouts', () => {
  for (const make of [layoutH, layoutV]) {
    test(`${make.name}: game, camera, chat, alerts and graphics found where they were drawn`, async () => {
      const f = make();
      const r = await readReference(writePng(f.canvas, dir, make.name));
      valid(r);
      assert.equal(r.canvas, f.kind);
      for (const role of ['game', 'camera', 'chat', 'alerts']) {
        const s = r.slots.filter((x) => x.role === role);
        assert.equal(s.length, 1, `${role}: ${JSON.stringify(r.slots.map((x) => x.role))}`);
        assert.ok(sidesOff(s[0].box, f.truth[role]) <= EDGE_TOL, `${role} ${JSON.stringify(s[0].box)} vs ${JSON.stringify(f.truth[role])}`);
        assert.ok(s[0].confidence >= 0.5, `${role} confidence ${s[0].confidence}`);
        assert.ok(s[0].evidence.length >= 1 && s[0].source === 'rules');
      }
      const g = r.slots.filter((x) => x.role === 'graphics');
      assert.ok(g.some((x) => sidesOff(x.box, f.truth.graphics) <= EDGE_TOL), JSON.stringify(g));
      assert.equal(r.slots.length, 5, 'no extra slots on a clean drawing');
    });
  }
  test('a video reference: the moving game area is found, with motion as evidence', async () => {
    const canvases = [0, 1, 2, 3].map((i) => layoutH({ seed: 30 + i }).canvas);
    const r = await readReference(writeVideo(canvases, dir, 'vidH', 2), { frames: 4 });
    valid(r);
    assert.equal(r.reference.kind, 'video');
    assert.equal(r.reference.frameTimesS.length, 4);
    const game = r.slots.find((s) => s.role === 'game');
    assert.ok(game && sidesOff(game.box, layoutH().truth.game) <= EDGE_TOL, JSON.stringify(game));
    assert.ok(game.evidence.some((e) => /^moving 0\.[5-9]|^moving 1/.test(e)), game.evidence.join('; '));
  });
  test('a picture with no textured area has no game slot and says so', async () => {
    const r = await readReference(writePng(stylePanels().canvas, dir, 'nogame'));
    assert.equal(r.slots.some((s) => s.role === 'game'), false);
    assert.ok(r.notes.some((n) => /no game area/.test(n)));
  });
});

describe('SB2 style against drawn panels and marks', () => {
  const read = async (opts, name) => (await readReference(writePng(stylePanels(opts).canvas, dir, name))).style;
  test('corner radius: none, small, medium and large within tolerance', async () => {
    // drawn on a 540 px short side, so the 1080 px radius is twice the drawn one
    for (const [radius, cls] of [[0, 'none'], [3, 'small'], [8, 'medium'], [24, 'large'], [40, 'large']]) {
      const s = await read({ radius }, `r${radius}`);
      const want = radius * 2;
      assert.ok(Math.abs(s.cornerRadius.px1080 - want) <= Math.max(3, 0.15 * want), `r ${radius}: ${s.cornerRadius.px1080} vs ${want}`);
      assert.equal(s.cornerRadius.class, cls, `r ${radius}`);
      assert.ok(s.cornerRadius.corners >= 8 && s.cornerRadius.confidence >= 0.5);
    }
  });
  test('glow: found around glowing panels with its colour, not around plain ones', async () => {
    const g = await read({ glow: true }, 'glow');
    assert.equal(g.glow.used, true);
    assert.ok(deltaE(hexLab(g.glow.colour), hexLab('#00d2c8')) <= 0.05, g.glow.colour);
    const plain = await read({}, 'plain');
    assert.equal(plain.glow.used, false);
    assert.equal(plain.shadow.used, false);
  });
  test('shadow: a drop shadow under light cards is found, below them', async () => {
    const s = await read({ shadow: true, light: true }, 'shadow');
    assert.equal(s.shadow.used, true);
    assert.equal(s.shadow.offset, 'below');
    assert.ok(s.shadow.depth >= 0.05);
    const flat = await read({ light: true }, 'flatlight');
    assert.equal(flat.shadow.used, false);
  });
  test('type feel: stroke weight classes and polarity', async () => {
    for (const [stroke, weight] of [[2, 'light'], [3, 'regular'], [4, 'bold'], [6, 'black']]) {
      const s = await read({ stroke }, `w${stroke}`);
      assert.equal(s.type.weight, weight, `stroke ${stroke}: ratio ${s.type.weightRatio}`);
      assert.equal(s.type.polarity, 'light-on-dark');
      assert.equal(s.type.family, null, 'rules never guess a font family');
    }
    const light = await read({ light: true }, 'dol');
    assert.equal(light.type.polarity, 'dark-on-light');
    assert.equal(light.type.size, 'large'); // 28 px marks on a 540 px short side = 56 px at 1080
  });
});

describe('local model hook (typed, never a paid API)', () => {
  let ref;
  before(async () => { ref = await loadReference(writePng(layoutH().canvas, dir, 'hook')); });
  const camera = { role: 'camera', box: { x: 0.02, y: 0.04, w: 0.2, h: 0.26 }, confidence: 0.99, evidence: ['model'] };
  test('an adapter that is not marked local is refused; the rules result stands', async () => {
    let called = false;
    const r = await readFrames(ref, { model: { id: 'remote-thing', analyze: () => { called = true; return {}; } } });
    assert.equal(called, false);
    assert.equal(r.detector.model, null);
    assert.ok(r.notes.some((n) => /refused/.test(n)));
    valid(r);
  });
  test('a local model slot with a higher confidence replaces that role; family is taken; graphics are added', async () => {
    let input;
    const model = { id: 'local-test', local: true, analyze: (i) => { input = i; return { slots: [camera, { role: 'graphics', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 0.4 }], type: { family: 'sans' } }; } };
    const r = await readFrames(ref, { model });
    valid(r);
    assert.equal(input.canvas, 'H');
    assert.equal(input.frames.length, 1);
    assert.ok(input.rules.slots.length >= 5);
    assert.equal(r.detector.model, 'local-test');
    const cams = r.slots.filter((s) => s.role === 'camera');
    assert.equal(cams.length, 1);
    assert.equal(cams[0].source, 'model');
    assert.equal(r.style.type.family, 'sans');
    assert.ok(r.slots.some((s) => s.role === 'graphics' && s.source === 'model'));
    const low = await readFrames(ref, { model: { id: 'local-low', local: true, analyze: () => ({ slots: [{ ...camera, confidence: 0.1 }] }) } });
    assert.equal(low.slots.find((s) => s.role === 'camera').source, 'rules', 'a less sure model does not replace the rules');
  });
  test('an answer out of shape, or a model that throws, is ignored with a note', async () => {
    for (const analyze of [() => ({ slots: [{ ...camera, role: 'webcam' }] }), () => ({ slots: [{ ...camera, box: { x: 0.9, y: 0, w: 0.5, h: 0.1 } }] }),
      () => ({ type: { family: 'comic' } }), () => { throw new Error('boom'); }]) {
      const r = await readFrames(ref, { model: { id: 'local-bad', local: true, analyze } });
      valid(r);
      assert.equal(r.detector.model, null);
      assert.ok(r.slots.every((s) => s.source === 'rules'));
      assert.ok(r.notes.some((n) => /local-bad/.test(n)));
    }
  });
});

describe('CLI entry point behind the scene-builder flag', () => {
  test('the flag is defined and off by default', () => {
    const flags = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    const f = flags.find((x) => x.id === 'scene-builder');
    assert.ok(f, 'flag defined');
    assert.equal(f.default, false);
  });
  test('flag off: refuses with exit 2; flag on: prints a schema-valid read; nothing is written', async () => {
    const data = mkdtempSync(path.join(dir, 'data-'));
    const p = writePng(layoutV().canvas, dir, 'cli');
    const before = readdirSync(dir).sort();
    const outs = [], errs = [];
    assert.equal(await cli(['read', p, '--data-dir', data], (s) => outs.push(s), (s) => errs.push(s)), 2);
    assert.match(errs.join('\n'), /scene-builder feature flag is off/);
    assert.equal(outs.length, 0);
    writeFileSync(path.join(data, 'flags.local.json'), JSON.stringify({ flags: { 'scene-builder': true } }));
    assert.equal(await cli(['read', p, '--frames', '2', '--data-dir', data], (s) => outs.push(s), (s) => errs.push(s)), 0);
    const r = JSON.parse(outs[0]);
    valid(r);
    assert.equal(r.reference.name, 'cli.png');
    assert.ok(!JSON.stringify(r).includes(dir), 'no folder path in the output');
    assert.deepEqual(readdirSync(dir).sort(), before, 'nothing written next to the reference');
  });
  test('bad arguments exit 1', async () => {
    const quiet = () => {};
    assert.equal(await cli([], quiet, quiet), 1);
    assert.equal(await cli(['read'], quiet, quiet), 1);
    assert.equal(await cli(['read', 'a.png', '--frames'], quiet, quiet), 1);
    assert.equal(await cli(['read', 'a.png', '--bogus', '1'], quiet, quiet), 1);
    assert.equal(await cli(['read', 'a.png', '--frames', 'x'], quiet, quiet, { flagsOn: () => true }), 1);
    assert.equal(await cli(['read', 'https://example.invalid/a.png'], quiet, quiet, { flagsOn: () => true }), 1);
  });
});
