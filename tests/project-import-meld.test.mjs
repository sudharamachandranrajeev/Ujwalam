// SPDX-License-Identifier: GPL-3.0-or-later
// Meld session importer: mapping, skipped list, report content, CLI refusals. The fixture is a hand-made,
// minimal Meld-shaped file with placeholder names only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { importMeld, ImportError, runCli, MAPPING } from '../services/project/import-meld.mjs';
import { validateProject, loadProject } from '../services/project/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const fixture = path.join(here, 'fixtures', 'project', 'meld-minimal.session.json');
const session = () => JSON.parse(fs.readFileSync(fixture, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemaCheck = ajv.compile(JSON.parse(fs.readFileSync(path.join(repo, 'data', 'schemas', 'project.schema.json'), 'utf8')));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ujw-meld-'));

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

test('maps the fixture: scenes, layer kinds, pairs, origins, devices, overlays, audio', () => {
  const { project: p, report: r } = importMeld(deepFreeze(session()), { id: 'meld-test' });
  assert.equal(validateProject(p).ok, true);
  assert.equal(schemaCheck(p), true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(p.origin, { importer: 'meld', id: 'session' });
  assert.deepEqual(p.canvases.map((c) => c.id), ['h', 'v']);
  assert.equal(p.scenes.length, 2);
  assert.equal(p.scenes[0].origin.id, 'H-SCENE-1+V-SCENE-1');
  assert.equal(p.activeScene, p.scenes[1].id, 'currentScene maps to the scene with the same Meld id');

  const layers = p.scenes[0].layers;
  // bottom first: image, media, V-only text (after its V neighbour), camera, web, overlay, duplicate
  assert.deepEqual(layers.map((l) => l.type), ['image', 'media', 'text', 'capture', 'browser', 'browser', 'duplicate']);
  const [image, media, text, cam, web, chat, dup] = layers;
  assert.deepEqual(dup.source, { layer: cam.id }, 'duplicator maps to a second item on the same source as its target');
  assert.deepEqual(Object.keys(dup.placements).sort(), ['h', 'v'], 'H and V duplicators pair');
  assert.deepEqual(dup.placements.h, { visible: true, x: 1000, y: 20, width: 300, height: 200 });
  assert.equal(dup.origin.id, 'H-L-DUP+V-L-DUP');

  assert.deepEqual(image.source, { file: { base: 'media', rel: 'images/logo one.png' } });
  assert.deepEqual(image.placements.h, { visible: true, x: 24, y: 24, width: 160, height: 160 });
  assert.equal(image.placements.v, undefined);

  assert.deepEqual(media.source, { file: { base: 'media', rel: 'clips/intro.mp4' }, loop: true });
  assert.deepEqual(Object.keys(media.placements).sort(), ['h', 'v']);
  assert.equal(media.locked, true, 'locked in V counts');
  assert.equal(media.origin.id, 'H-L-MEDIA+V-L-MEDIA');

  assert.deepEqual(text.source, { text: 'Hello', font: 'Sans', size: 48, color: '#112233ff' });
  assert.deepEqual(Object.keys(text.placements), ['v']);

  assert.equal(cam.source.device, p.devices.find((d) => d.kind === 'camera').id);
  assert.equal(cam.placements.h.rotation, undefined, 'rotation 180 with one flipped axis is a mirror, not an upside-down picture');
  assert.deepEqual(cam.placements.v, { visible: true, x: -420, y: 656, width: 1920, height: 1080 });

  assert.deepEqual(web.source, { url: 'https://example.invalid/page', width: 640, height: 360 });
  assert.equal(web.placements.h.visible, false);
  assert.equal(web.placements.h.opacity, 0.5);

  assert.equal(chat.source.overlay, p.overlays[0].id);
  assert.equal(chat.source.query, 'canvas=horizontal&theme=demo');
  assert.deepEqual(p.overlays[0].file, { base: 'overlays', rel: 'chat-overlay/index.html' });

  assert.deepEqual(p.devices.map((d) => d.kind), ['camera', 'microphone', 'audio-output']);
  assert.deepEqual(p.devices[0].match, { deviceId: 'DEVICE-CAMERA-1', directShowId: 'DSHOW-CAMERA-1' });
  assert.deepEqual(p.devices[0].format, { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(p.devices[1].match, { deviceId: 'AUDIO-MIC-1', name: 'Microphone One' });

  assert.equal(p.audio.tracks.length, 2);
  const byName = Object.fromEntries(p.audio.sources.map((s) => [s.name, s]));
  assert.ok(Math.abs(byName.Mic.volumeDb - 20 * Math.log10(0.5)) < 1e-9);
  assert.deepEqual(byName.Mic.tracks, ['track1', 'track2']);
  assert.equal(byName.Headphones.volumeDb, -100);
  assert.equal(byName.Headphones.muted, true);
  assert.equal(byName.Headphones.monitoring, 'monitor-and-output');
  assert.deepEqual(byName.Headphones.tracks, []);
  const layerAudio = p.audio.sources.filter((s) => s.layer);
  assert.equal(layerAudio.length, 2);
  assert.ok(layerAudio.every((s) => layers.some((l) => l.id === s.layer)));

  assert.deepEqual(r.counts, {
    scenes: 2, verticalScenesMerged: 2, verticalScenesOnly: 0, layersSeen: 18, layersImported: 10, layersPaired: 3,
    layersHOnly: 3, layersVOnly: 1, devices: 3, audioSources: 4, overlays: 1,
  });
  assert.deepEqual(r.bases, { media: 'D:/media-root' });
});

test('skipped list: every unmapped kind is listed with a reason and a Meld id, nothing guessed', () => {
  const { report: r } = importMeld(session());
  const kinds = r.skipped.map((s) => `${s.kind}|${s.layer}`).sort();
  assert.deepEqual(kinds, [
    'Display capture|H-L-DISPLAY', 'Duplicator|H-L-DUP2', 'Duplicator|H-L-DUP3', 'Group|H-L-GROUP', 'Hologram|H-L-FUTURE',
    'Text|H-L-BADGEO', 'Widget|H-L-WIDGET', 'audio track|A-APP',
  ].sort());
  assert.match(r.skipped.find((s) => s.kind === 'Group').reason, /1 child layer/);
  assert.match(r.skipped.find((s) => s.layer === 'H-L-BADGEO').reason, /out of range/);
  assert.match(r.skipped.find((s) => s.kind === 'Hologram').reason, /unknown layer kind/);
  assert.match(r.skipped.find((s) => s.layer === 'H-L-DUP2').reason, /^target-skipped/);
  assert.equal(r.skipped.find((s) => s.layer === 'H-L-DUP3').reason, 'target-skipped');
  assert.match(r.skipped.find((s) => s.layer === 'H-L-DUP3').detail, /itself a duplicator/);
  assert.equal(Object.values(r.skippedByKind).reduce((a, b) => a + b, 0), 8);
  assert.equal(r.ignored.effects, undefined, 'an effect that is not enabled does nothing in Meld: not imported, not reported (D246)');
  assert.ok(!importMeld(session()).project.scenes.some((x) => x.layers.some((l) => l.effects)), 'no effects imported');
  assert.equal(r.ignored['flip (negative scale)'], 1);
  assert.ok(r.warnings.some((w) => /different stacking order on V/.test(w)));
});

test('report holds no names: only ids, kinds, counts, mapping status (and base roots)', () => {
  const { report } = importMeld(session());
  const text = JSON.stringify({ ...report, bases: undefined });
  for (const name of ['Camera One', 'Microphone One', 'Headphones One', 'Scene One', 'Cloud widget', 'Something new', 'logo one']) {
    assert.ok(!text.includes(name), `report leaks "${name}"`);
  }
  assert.ok(Object.keys(MAPPING).length > 10);
  assert.ok(Object.values(MAPPING).every((v) => /^(VERIFIED|UNVERIFIED)/.test(v)));
});

test('import is deterministic and does not mutate its input', () => {
  const input = deepFreeze(session());
  const a = importMeld(input, { id: 'x' });
  const b = importMeld(input, { id: 'x' });
  assert.deepEqual(a.project, b.project);
  assert.deepEqual(a.report, b.report);
});

test('refuses an API dump, a wrong version and non-sessions with a clear error', () => {
  assert.throws(() => importMeld({ apiVersion: 3, items: {}, takenAt: 'x' }), (e) => e instanceof ImportError && /API dump/.test(e.message));
  assert.throws(() => importMeld({ version: 2, session: { scenes: [] } }), /unsupported Meld session version 2/);
  assert.throws(() => importMeld({ version: 1 }), /no "session" object/);
  assert.throws(() => importMeld([]), ImportError);
  assert.throws(() => importMeld({ version: 1, session: {} }), /scenes is missing/);
  assert.throws(() => importMeld({ session: { scenes: [] } }), /schema version undefined/);
  assert.throws(() => importMeld({ session: { version: 4, scenes: [] } }), /schema version 4/);
});

test('wrapper-less shape { session: { version: 3 } } imports the same as { version: 1, session } (D145)', () => {
  const wrapped = session();
  wrapped.session.version = 3;
  const bare = { session: structuredClone(wrapped.session) };
  const a = importMeld(wrapped, { id: 'x' });
  const b = importMeld(bare, { id: 'x' });
  assert.deepEqual(b.project, a.project);
  assert.deepEqual([a.report.sessionVersion, a.report.sessionSchemaVersion], [1, 3]);
  assert.deepEqual([b.report.sessionVersion, b.report.sessionSchemaVersion], [null, 3]);
});

test('vertical canvas disabled: V layers are skipped and listed, project is H only', () => {
  const s = session();
  s.session.verticalCanvasEnabled = false;
  const { project: p, report: r } = importMeld(s);
  assert.deepEqual(p.canvases.map((c) => c.id), ['h']);
  assert.ok(p.scenes.flatMap((x) => x.layers).every((l) => !l.placements.v));
  assert.equal(r.skipped.filter((x) => x.kind === 'vertical-canvas').length, 4);
  assert.equal(validateProject(p).ok, true);
});

test('empty session gives a valid project with one empty scene', () => {
  const { project: p } = importMeld({ version: 1, session: { scenes: [], verticalScenes: [], audioTracks: [] } });
  assert.equal(validateProject(p).ok, true);
  assert.equal(p.scenes.length, 1);
});

test('a duplicator whose target is in another scene maps; one with an unknown target is skipped', () => {
  const s = session();
  const extra = { x: 0, y: 0, width: 50, height: 50, visible: true, rotation: 0, effects: [], meta: { sceneObjectSourceName: 'MeldStudio/Duplicator' } };
  s.session.scenes[1].childItems.push({ ...extra, id: 'H-L-XDUP', name: 'Cross', sourceItemId: 'H-L-MEDIA', sourceSceneId: 'H-SCENE-1' });
  s.session.scenes[1].childItems.push({ ...extra, id: 'H-L-NODUP', name: 'Orphan', sourceItemId: 'NO-SUCH-ITEM' });
  const { project: p, report: r } = importMeld(s);
  const x = p.scenes[1].layers.find((l) => l.type === 'duplicate');
  assert.equal(x.source.layer, p.scenes[0].layers.find((l) => l.type === 'media').id);
  assert.equal(validateProject(p).ok, true);
  assert.match(r.skipped.find((e) => e.layer === 'H-L-NODUP').reason, /^target-skipped/);
});

test('a V scene with no linked H scene becomes its own scene with a warning', () => {
  const s = session();
  s.session.verticalScenes[1].linkedSceneId = 'NOPE';
  const { project: p, report: r } = importMeld(s);
  assert.equal(p.scenes.length, 3);
  assert.equal(r.counts.verticalScenesOnly, 1);
  assert.ok(r.warnings.some((w) => /not linked/.test(w)));
});

test('CLI: creates a new project and report, prints counts only, refuses to overwrite', () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'p.project.json');
    const rep = path.join(dir, 'r.json');
    const lines = [];
    const io = { log: (m) => lines.push(m), err: (m) => lines.push(`ERR ${m}`) };
    assert.equal(runCli(['--in', fixture, '--out', out, '--report', rep, '--id', 'cli-test'], io), 0, lines.join('\n'));
    assert.equal(loadProject(out).project.id, 'cli-test');
    assert.equal(JSON.parse(fs.readFileSync(rep, 'utf8')).importer, 'meld');
    assert.ok(lines[0].startsWith('import-meld: 2 scene(s), 10 layer placement(s) imported'));
    assert.ok(!lines.join('\n').includes('Camera One'));
    const before = fs.readFileSync(out, 'utf8');
    assert.equal(runCli(['--in', fixture, '--out', out], io), 1);
    assert.equal(runCli(['--in', fixture, '--out', path.join(dir, 'other.json'), '--report', rep], io), 1);
    assert.equal(fs.existsSync(path.join(dir, 'other.json')), false, 'nothing is written when the report path is taken');
    assert.equal(fs.readFileSync(out, 'utf8'), before, 'existing project untouched');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['p.project.json', 'r.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: usage errors and bad input exit non-zero without writing', () => {
  const dir = tmpDir();
  try {
    const io = { log() {}, err() {} };
    const out = path.join(dir, 'p.json');
    assert.equal(runCli([], io), 2);
    assert.equal(runCli(['--in', fixture], io), 2);
    assert.equal(runCli(['--bogus', 'x'], io), 2);
    assert.equal(runCli(['--in', path.join(dir, 'missing.json'), '--out', out], io), 1);
    const bad = path.join(dir, 'api.json');
    fs.writeFileSync(bad, JSON.stringify({ apiVersion: 3, items: {} }));
    assert.equal(runCli(['--in', bad, '--out', out], io), 1);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI as a real process: exit codes and no overwrite', () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'p.json');
    const run = () => spawnSync(process.execPath, [path.join(repo, 'services', 'project', 'import-meld.mjs'), '--in', fixture, '--out', out], { encoding: 'utf8', windowsHide: true });
    const a = run();
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /skipped 1 x Widget/);
    assert.match(a.stdout, /skipped 2 x Duplicator: target-skipped/);
    const b = run();
    assert.equal(b.status, 1);
    assert.match(b.stderr, /refusing to overwrite/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fixture holds placeholders only: no real-looking paths, names or ids', () => {
  const text = fs.readFileSync(fixture, 'utf8');
  assert.doesNotMatch(text, /\\Users\\|\/Users\/|C:\//i);
  assert.doesNotMatch(text, /[0-9A-F]{32}/, 'no real 32-hex Meld ids');
  assert.doesNotMatch(text, /meldstudio\.co/i);
});

// ---- F1 fidelity (2026-11-05)
const extraLayer = (id, kind, more = {}) => ({
  id, name: id, x: 10, y: 20, width: 100, height: 50, visible: true, rotation: 0, effects: [], childItems: [],
  meta: { sceneObjectSourceName: `MeldStudio/${kind}` }, ...more,
});

test('gain is linear amplitude: -30 dB and -25 dB points, 1 is 0 dB, 0 is the floor', () => {
  const s = session();
  s.session.audioTracks.push(
    { id: 'A-30', type: 1, deviceName: 'Dev30', uniqueId: 'U30', name: 'n30', gain: 0.03162277660168379, muted: false, monitoring: false, outputTracks: 1 },
    { id: 'A-25', type: 1, deviceName: 'Dev25', uniqueId: 'U25', name: 'n25', gain: 0.05623413251903491, muted: false, monitoring: false, outputTracks: 1 },
    { id: 'A-1', type: 1, deviceName: 'Dev1', uniqueId: 'U1', name: 'n1', gain: 1, muted: false, monitoring: false, outputTracks: 1 },
  );
  const { project } = importMeld(s);
  const db = Object.fromEntries(project.audio.sources.map((x) => [x.name, x.volumeDb]));
  assert.ok(Math.abs(db.n30 + 30) < 1e-9);
  assert.ok(Math.abs(db.n25 + 25) < 1e-9);
  assert.equal(db.n1, 0);
});

test('monitoring true keeps the track on the stream (monitor-and-output); false is off', () => {
  const { project } = importMeld(session());
  const modes = new Set(project.audio.sources.map((x) => x.monitoring));
  assert.ok(modes.has('monitor-and-output'));
  assert.ok(!modes.has('monitor-only'));
});

test('rotation: 180 with both axes flipped or none stays 180; other angles are kept; 180 with one flip is a mirror', () => {
  const s = session();
  const items = s.session.scenes[1].childItems;
  items.push(
    extraLayer('R-NONE', 'Text', { text: 'a', rotation: 180, scaleX: 1, scaleY: 1 }),
    extraLayer('R-BOTH', 'Text', { text: 'b', rotation: 180, scaleX: -1, scaleY: -1 }),
    extraLayer('R-45', 'Text', { text: 'c', rotation: 45, scaleX: 1, scaleY: 1 }),
    extraLayer('R-MIRROR', 'Text', { text: 'd', rotation: 180, scaleX: 1, scaleY: -1 }),
    extraLayer('R-90FLIP', 'Text', { text: 'e', rotation: 90, scaleX: -1, scaleY: 1 }),
  );
  const { project, report } = importMeld(s);
  const by = Object.fromEntries(project.scenes[1].layers.map((l) => [l.origin.id, l.placements.h.rotation]));
  assert.equal(by['R-NONE'], 180);
  assert.equal(by['R-BOTH'], 180);
  assert.equal(by['R-45'], 45);
  assert.equal(by['R-MIRROR'], undefined);
  assert.equal(by['R-90FLIP'], 90);
  assert.equal(report.ignored['flip (negative scale)'] >= 2, true);
});

test('video device fill mode crops the centre in source pixels instead of stretching', () => {
  const s = session();
  s.session.scenes[1].childItems.push(extraLayer('R-CAMFILL', 'Video device', {
    deviceId: 'DEVICE-CAMERA-1', width: 387, height: 373, scaleX: 0.345, scaleY: 0.345, implicitWidth: 1920, implicitHeight: 1080, fitmentMode: 2,
  }));
  const { project } = importMeld(s);
  const l = project.scenes[1].layers.find((x) => x.origin.id === 'R-CAMFILL');
  const c = l.placements.h.crop;
  assert.ok(c && c.left === c.right && c.top === 0 && c.bottom === 0);
  // visible source width = 387 / 0.345 = 1121.7 px of 1920
  assert.ok(Math.abs(1920 - c.left - c.right - 387 / 0.345) <= 1);
  assert.equal(validateProject(project).ok, true);
});

test('fill mode on media and duplicates crops too; a picture equal to the box needs nothing; the rest is reported (D253)', () => {
  const s = session();
  const kids = s.session.scenes[1].childItems;
  // media: 1280x720 at 0.5 = 640x360 shown in a 300x360 box -> 680 source px cut, 340 each side
  kids.push(extraLayer('F-MEDIA', 'Media source', { mediaSource: 'file:///D:/media-root/clips/a.mp4', width: 300, height: 360, scaleX: 0.5, scaleY: 0.5, implicitWidth: 1280, implicitHeight: 720, fitmentMode: 2 }));
  // the same at fit (1) with picture = box: no crop, no report
  kids.push(extraLayer('F-SAME', 'Media source', { mediaSource: 'file:///D:/media-root/clips/b.mp4', width: 640, height: 360, scaleX: 0.5, scaleY: 0.5, implicitWidth: 1280, implicitHeight: 720, fitmentMode: 1 }));
  // no picture size (Meld writes 16x16 before the file loads): reported
  kids.push(extraLayer('F-NOSIZE', 'Media source', { mediaSource: 'file:///D:/media-root/clips/c.mp4', width: 300, height: 300, scaleX: 1, scaleY: 1, implicitWidth: 16, implicitHeight: 16, fitmentMode: 2 }));
  // text at fill with a larger picture: reported, not cropped
  kids.push(extraLayer('F-TEXT', 'Text', { text: 'hi', width: 100, height: 50, scaleX: 1, scaleY: 1, implicitWidth: 200, implicitHeight: 50, fitmentMode: 2 }));
  const { project, report } = importMeld(s);
  const L = (id) => project.scenes[1].layers.find((x) => x.origin.id === id);
  assert.deepEqual(L('F-MEDIA').placements.h.crop, { left: 340, top: 0, right: 340, bottom: 0 });
  assert.equal(L('F-SAME').placements.h.crop, undefined);
  assert.equal(L('F-NOSIZE').placements.h.crop, undefined);
  assert.equal(L('F-TEXT').placements.h.crop, undefined);
  assert.equal(report.ignored['fitmentMode 2 without a known picture size'], 1);
  assert.equal(report.ignored['fitmentMode 2 on a text layer'], 1);
  assert.equal(report.ignored['fitmentMode 1 without a known picture size'], undefined);
  assert.equal(validateProject(project).ok, true);
});

test('group: children are flattened in place with inherited visibility, opacity and lock; counts stay right', () => {
  const s = session();
  const grp = extraLayer('G-OK', 'Group', {
    visible: false, opacity: 0.5, isLocked: true,
    childItems: [
      extraLayer('G-C1', 'Text', { text: 'one', x: 5, y: 6 }),
      extraLayer('G-INNER', 'Group', { childItems: [extraLayer('G-C2', 'Text', { text: 'two', x: 7, y: 8, opacity: 0.5 })] }),
      extraLayer('G-C3', 'Game capture'),
    ],
  });
  s.session.scenes[1].childItems.push(grp);
  const { project, report } = importMeld(s);
  const ls = project.scenes[1].layers;
  const c1 = ls.find((x) => x.origin.id === 'G-C1');
  const c2 = ls.find((x) => x.origin.id === 'G-C2');
  assert.deepEqual([c1.placements.h.x, c1.placements.h.y], [5, 6], 'child coordinates are canvas coordinates, unchanged');
  assert.equal(c1.placements.h.visible, false);
  assert.equal(c1.placements.h.opacity, 0.5);
  assert.equal(c1.locked, true);
  assert.equal(c2.placements.h.opacity, 0.25, 'nested group opacity multiplies');
  assert.ok(ls.indexOf(c2) < ls.indexOf(c1), 'index 0 is top: the first child ends above the later ones');
  assert.ok(!ls.some((x) => x.origin.id === 'G-OK'), 'the group itself is not a layer');
  assert.ok(report.skipped.some((x) => x.layer === 'G-C3' && x.kind === 'Game capture'), 'unsupported children are still reported');
  assert.equal(report.counts.layersSeen, 18 + 5);
});

test('group with its own scale, rotation or offset is skipped with the reason and the child count', () => {
  const s = session();
  for (const [id, more] of [['G-SC', { scaleX: 0.5 }], ['G-ROT', { rotation: 180 }], ['G-OFF', { offsetX: 3 }]]) {
    s.session.scenes[1].childItems.push(extraLayer(id, 'Group', { ...more, childItems: [extraLayer(`${id}-C`, 'Text', { text: 'x' })] }));
  }
  const { report } = importMeld(s);
  for (const id of ['G-SC', 'G-ROT', 'G-OFF']) {
    const sk = report.skipped.find((x) => x.layer === id);
    assert.match(sk.reason, /own scale, rotation or offset.*1 child layer/);
  }
});

test('game and display capture are skipped with the host-kind reason (no libobs source kind in the host)', () => {
  const s = session();
  s.session.scenes[1].childItems.push(extraLayer('C-GAME', 'Game capture'));
  const { report } = importMeld(s);
  for (const id of ['C-GAME', 'H-L-DISPLAY']) {
    assert.match(report.skipped.find((x) => x.layer === id).reason, /^no host source kind for (game|display) capture/);
  }
});

test('Spark Element (Meld HTML overlay) imports as a browser layer sized from the layer box', () => {
  const s = session();
  const scene = s.session ? s.session.scenes[0] : s.scenes[0];
  const spark = (id, url, extra = {}) => ({
    id, name: 'Spark one', x: 10, y: 20, width: 505.4, height: 283.6, visible: true, isLocked: false, rotation: 0, opacity: 1,
    scaleX: 1, scaleY: 1, effects: [], meta: { sceneObjectSourceName: 'MeldStudio/Spark Element' }, url, implicitWidth: 0, implicitHeight: 0, ...extra,
  });
  scene.childItems.push(
    spark('H-L-SPARK-OV', 'http://localhost:8787/overlays/stream-alert/index.html?theme=demo'),
    spark('H-L-SPARK-WEB', 'https://example.invalid/el.html'),
    spark('H-L-SPARK-BAD', 'ftp://example.invalid/x'),
    spark('H-L-SPARK-NOURL', undefined),
  );
  const { project: p, report: r } = importMeld(s, { id: 'spark-test' });
  assert.equal(validateProject(p).ok, true);
  const layers = p.scenes[0].layers;
  const ov = layers.find((l) => l.origin && l.origin.id === 'H-L-SPARK-OV');
  const web = layers.find((l) => l.origin && l.origin.id === 'H-L-SPARK-WEB');
  assert.ok(ov && web, 'spark layers imported');
  const src = (l) => (p.sources ? p.sources.find((x) => x.id === l.source) : l.source) || l.source;
  assert.deepEqual([src(web).width, src(web).height], [505, 284]);
  assert.equal(src(web).url, 'https://example.invalid/el.html');
  assert.equal(src(ov).query, 'theme=demo');
  const reasons = r.skipped.filter((x) => x.kind === 'Spark Element');
  assert.deepEqual(reasons.map((x) => x.layer).sort(), ['H-L-SPARK-BAD', 'H-L-SPARK-NOURL']);
  assert.ok(!r.skipped.some((x) => /unknown layer kind/.test(x.reason) && x.kind === 'Spark Element'));
});

test('scene transitions (D239): Meld durations become per-canvas fades; an enabled stinger without a video is reported, not guessed', () => {
  const s = session();
  s.session.sceneTransition = { duration: 2006, effects: [{ type: 'Stinger', enabled: false }] };
  s.session.verticalSceneTransition = { duration: 1000, effects: [{ type: 'Stinger', enabled: true }] };
  const { project: p, report: r } = importMeld(s, { id: 'meld-test' });
  assert.deepEqual(p.canvases.map((c) => [c.id, c.transition]), [['h', { type: 'fade', durationMs: 2006 }], ['v', { type: 'fade', durationMs: 1000 }]]);
  assert.equal(schemaCheck(p), true, JSON.stringify(schemaCheck.errors));
  assert.ok(r.warnings.some((w) => w.includes('canvas v') && w.includes('stinger')));
  assert.ok(!r.warnings.some((w) => w.includes('canvas h')), 'a disabled stinger is not reported');
  const none = importMeld(session(), { id: 'meld-test' }).project;
  assert.ok(none.canvases.every((c) => !('transition' in c)), 'no Meld transition: none imported (cut)');
  const bad = structuredClone(p);
  bad.canvases[0].transition = { type: 'wipe', durationMs: 20000 };
  assert.equal(validateProject(bad).ok, false);
});

test('stinger transitions (D242): an enabled Meld stinger with a local video imports with its cut point under the media base', () => {
  const s = session();
  s.session.sceneTransition = { duration: 2006, effects: [{ type: 'Stinger', enabled: true, source: 'file:///D:/Media/Stingers/wipe.webm', midPointMs: 1750.4, audioEnabled: false }] };
  s.session.verticalSceneTransition = { duration: 1000, effects: [{ type: 'Stinger', enabled: true, source: 'https://example.com/x.webm' }] };
  const { project: p, report: r } = importMeld(s, { id: 'meld-test' });
  const h = p.canvases.find((c) => c.id === 'h').transition;
  assert.equal(h.type, 'stinger');
  assert.equal(h.pointMs, 1750);
  assert.equal(h.audio, false, 'Meld audioEnabled false: the stinger plays silent (D244)');
  assert.equal(h.file.base, 'media');
  assert.ok(h.file.rel.endsWith('wipe.webm'), h.file.rel);
  assert.equal(r.bases.media.length > 0, true);
  assert.deepEqual(p.canvases.find((c) => c.id === 'v').transition, { type: 'fade', durationMs: 1000 }, 'a remote stinger stays a fade');
  assert.ok(r.warnings.some((w) => w.includes('canvas v') && w.includes('not a local')));
  assert.ok(r.warnings.some((w) => w.includes('canvas h') && w.includes('track matte')));
  assert.equal(schemaCheck(p), true, JSON.stringify(schemaCheck.errors));
  assert.equal(validateProject(p).ok, true, JSON.stringify(validateProject(p).errors));
  const bad = structuredClone(p);
  bad.canvases[1].transition = { type: 'fade', durationMs: 10, audio: true };
  assert.equal(validateProject(bad).ok, false, 'audio only for a stinger');
  assert.equal(schemaCheck(bad), false);
  bad.canvases[1].transition = { type: 'fade', durationMs: 10, pointMs: 5 };
  assert.equal(validateProject(bad).ok, false, 'pointMs only for a stinger');
  assert.equal(schemaCheck(bad), false);
  delete bad.canvases[0].transition.file;
  bad.canvases[1].transition = { type: 'cut', durationMs: 0 };
  assert.equal(validateProject(bad).ok, false, 'a stinger needs its file');  // the layers' media are on D:, so a stinger on C: cannot share their base
  s.session.sceneTransition.effects[0].source = 'file:///C:/Media/Stingers/wipe.webm';
  const other = importMeld(s, { id: 'meld-test' });
  assert.deepEqual(other.project.canvases.find((c) => c.id === 'h').transition, { type: 'fade', durationMs: 2006 });
  assert.ok(other.report.warnings.some((w) => w.includes('canvas h') && w.includes('another drive')));
});

test('layer effects (D246): an enabled Meld ChromaKey imports as chromaKey with the fitted scale; others are reported', () => {
  const s = session();
  const items = [];
  (function walk(o) { if (o && typeof o === 'object') { if (o.id === 'H-L-MEDIA' || o.id === 'V-L-MEDIA') items.push(o); Object.values(o).forEach(walk); } })(s);
  const h = items.find((x) => x.id === 'H-L-MEDIA');
  h.effects = [
    { type: 'ChromaKey', enabled: true, keyColor: '#00FF00', threshold: 0.03, feather: 0.41, tolerance: 0, edgeBlend: 0.05, version: 2 },
    { type: 'ChromaKey', enabled: false, keyColor: '#ff0000', threshold: 0.3, feather: 0 },
    { type: 'GaussianBlur', enabled: true },
  ];
  const { project: p, report: r } = importMeld(s, { id: 'meld-test' });
  const layer = p.scenes.flatMap((x) => x.layers).find((l) => l.origin?.id?.includes('H-L-MEDIA'));
  assert.deepEqual(layer.effects, [{ type: 'chromaKey', color: '#00ff00', similarity: 440, smoothness: 103 }]);
  assert.equal(r.ignored['effect GaussianBlur'], 1);
  assert.equal(r.ignored['V effects that differ from H (H kept)'], 1, 'the V copy has no key');
  assert.equal(schemaCheck(p), true, JSON.stringify(schemaCheck.errors));
  assert.equal(validateProject(p).ok, true);
  const bad = structuredClone(p);
  bad.scenes.flatMap((x) => x.layers).find((l) => l.effects).effects[0].color = '#00ff0';
  assert.equal(validateProject(bad).ok, false);
  assert.equal(schemaCheck(bad), false);
});

test('blur and corner radii (D247): canvas-pixel Meld values become source-pixel blur and rounded, rounding last', () => {
  const s = session();
  const items = [];
  (function walk(o) { if (o && typeof o === 'object') { if (o.id === 'H-L-MEDIA' || o.id === 'V-L-MEDIA') items.push(o); Object.values(o).forEach(walk); } })(s);
  const h = items.find((x) => x.id === 'H-L-MEDIA');
  Object.assign(h, { width: 400, height: 300, scaleX: 0.5, scaleY: 0.5 });
  h.radii = { topLeft: 40, topRight: 40, bottomLeft: 40, bottomRight: 40 };
  h.effects = [{ type: 'GaussianBlur', enabled: true, blurriness: 31.25, dimensions: 1, repeatEdge: 0, showOriginalOnTop: false }];
  const { project: p, report: r } = importMeld(s, { id: 'meld-test' });
  const layer = () => p.scenes.flatMap((x) => x.layers).find((l) => l.origin?.id?.includes('H-L-MEDIA'));
  assert.deepEqual(layer().effects, [{ type: 'blur', strength: 62.5 }, { type: 'rounded', radius: 80 }]);
  assert.equal(r.ignored['effect GaussianBlur'], undefined);
  assert.equal(r.ignored['rounded corners (radii)'], undefined, 'radii are no longer skipped');
  assert.equal(schemaCheck(p), true, JSON.stringify(schemaCheck.errors));
  assert.equal(validateProject(p).ok, true);

  // a radius over half the shorter side is drawn as half by Meld; uneven corners keep the largest and are reported
  h.radii = { topLeft: 900, topRight: 10, bottomLeft: 10, bottomRight: 10 };
  h.effects = [];
  const two = importMeld(s, { id: 'meld-test' });
  const l2 = two.project.scenes.flatMap((x) => x.layers).find((l) => l.origin?.id?.includes('H-L-MEDIA'));
  assert.deepEqual(l2.effects, [{ type: 'rounded', radius: 300 }]);
  assert.equal(two.report.ignored['radii that differ per corner (largest kept)'], 1);

  // all-zero radii and a zero blur import nothing
  h.radii = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
  h.effects = [{ type: 'GaussianBlur', enabled: true, blurriness: 0 }];
  const three = importMeld(s, { id: 'meld-test' });
  assert.equal(three.project.scenes.flatMap((x) => x.layers).find((l) => l.origin?.id?.includes('H-L-MEDIA')).effects, undefined);
});
