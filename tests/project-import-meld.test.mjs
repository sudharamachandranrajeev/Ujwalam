// SPDX-License-Identifier: GPL-2.0-or-later
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
  assert.equal(cam.placements.h.rotation, 180);
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
  assert.equal(byName.Headphones.monitoring, 'monitor-only');
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
  assert.equal(r.ignored.effects, 1);
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
    const run = () => spawnSync(process.execPath, [path.join(repo, 'services', 'project', 'import-meld.mjs'), '--in', fixture, '--out', out], { encoding: 'utf8' });
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
