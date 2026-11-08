// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: face AI effects (personMask, autoFrame, faceSticker; flag face-ai, D295 proposed) on a real host.
//   node --test app/host/tests/host-face.test.mjs
// No camera and no model: the "camera" is an image layer and a fake worker (face_fake_worker.py) answers the host's
// face link with a synthetic mask (left half = person) and synthetic face points. The render checks need its Python
// (numpy): UJWALAM_FACE_PYTHON, else <repo>/.venv-gpu; without one they are skipped. Frames are recorded with NVENC
// to a local file (loopback) and read back with ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost, planInHost } from '../lib/project.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { validateProject } from '../../../services/project/validate.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const PY = process.env.UJWALAM_FACE_PYTHON || path.join(REPO_ROOT, '.venv-gpu', 'Scripts', 'python.exe');
const FAKE = path.join(HOST_DIR, 'tests', 'face_fake_worker.py');
const clone = (x) => JSON.parse(JSON.stringify(x));
let h;
let c;
let media;

function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'face-media-'));
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', path.join(media, 'red.png')]);
  // quadrants: top left red, top right green, bottom left blue, bottom right yellow
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90', '-f', 'lavfi', '-i', 'color=c=lime:s=160x90', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90',
    '-f', 'lavfi', '-i', 'color=c=yellow:s=160x90', '-filter_complex', '[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack', '-frames:v', '1', path.join(media, 'quad.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=magenta:s=64x32', '-frames:v', '1', path.join(media, 'sticker.png')]);
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'data-')), project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

async function rpcErr(method, params) {
  try {
    await c.call(method, params);
  } catch (e) {
    return e;
  }
  assert.fail(`${method} should have failed`);
}

function frameRgb(file, w, hh) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.8', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20, windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.stdout.length, w * hh * 3);
  return (x, y) => { const i = (y * w + x) * 3; return [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]]; };
}

function near(px, rgb, what) {
  assert.ok(px.every((v, i) => Math.abs(v - rgb[i]) <= 48), `${what}: got ${px} want ${rgb}`);
}

async function recordFrame(name, seconds = 2) {
  await c.call('outputs.configure', {
    rungs: [{ id: 'rh', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1280, h: 720, fps: 30, bitrate: 8000, gopSec: 1 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'fh', rung: 'rh', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name } }]
  });
  await c.call('record.start', {});
  await new Promise((res) => setTimeout(res, seconds * 1000));
  await c.call('record.stop', {});
  let st;
  for (let i = 0; i < 60; i++) {
    st = await c.call('outputs.status');
    if (st.sinks.every((s) => s.state === 'stopped')) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  await c.call('outputs.clear');
  return st.sinks.find((s) => s.id === 'fh').path;
}

// Fake worker for `seconds`; resolves with its JSON summary when it exits.
function fakeWorker(seconds) {
  const p = spawn(PY, ['-I', FAKE, String(h.child.pid), String(seconds)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  return new Promise((res, rej) => p.once('exit', (code) => (code === 0 ? res(JSON.parse(out.trim().split('\n').pop())) : rej(new Error(`fake worker ${code}: ${err}`)))));
}

const place = (x, y, w = 320, hh = 180) => ({ h: { visible: true, x, y, width: w, height: hh } });
const doc = (layers) => ({
  version: 1, id: 'face-check', name: 'Face check', activeScene: 'main',
  canvases: [{ id: 'h', width: 1280, height: 720, fps: 30 }], devices: [], overlays: [], outputs: [],
  scenes: [{ id: 'main', name: 'Main', layers: [
    { id: 'bg', type: 'color', name: 'Bg', source: { color: '#00ff00' }, placements: { h: { visible: true, x: 0, y: 0, width: 1280, height: 720 } } },
    ...layers] }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
});
const MASKS = doc([
  { id: 'cam', type: 'image', name: 'Cam', source: { file: { base: 'media', rel: 'red.png' } }, placements: place(40, 40),
    effects: [{ type: 'personMask', threshold: 0.5, feather: 0.1, smoothing: 0 }] },
  { id: 'cam-col', type: 'duplicate', name: 'Cam colour', source: { layer: 'cam' }, placements: place(400, 40),
    effects: [{ type: 'personMask', mode: 'replace', threshold: 0.5, feather: 0.1, smoothing: 0, color: '#0000ff' }] },
  { id: 'cam-blur', type: 'duplicate', name: 'Cam blur', source: { layer: 'cam' }, placements: place(760, 40),
    effects: [{ type: 'personMask', mode: 'blur', threshold: 0.5, feather: 0.1, smoothing: 0, strength: 30 }] }
]);
const TRACK = doc([
  { id: 'quad', type: 'image', name: 'Quad', source: { file: { base: 'media', rel: 'quad.png' } }, placements: place(40, 300),
    effects: [{ type: 'autoFrame', zoom: 2, smoothing: 0, deadzone: 0 }] },
  { id: 'quad-st', type: 'duplicate', name: 'Quad sticker', source: { layer: 'quad' }, placements: place(400, 300),
    effects: [{ type: 'faceSticker', file: { base: 'media', rel: 'sticker.png' }, anchor: 'eyes', scale: 1, offsetX: 0, offsetY: 0 }] }
]);

test('face effects parse: valid list round-trips; bad values are refused by the host and the validator', async () => {
  assert.deepEqual(validateProject(MASKS).errors, []);
  assert.deepEqual(validateProject(TRACK).errors, []);
  const plan = await planInHost(c, TRACK, { bases: { media } });
  const items = Object.fromEntries(plan.scenes[0].items.H.map((i) => [i.layer, i]));
  assert.deepEqual(items.quad.effects, [{ type: 'autoFrame', zoom: 2, smoothing: 0, deadzone: 0 }]);
  const mp = await planInHost(c, MASKS, { bases: { media } });
  const mi = Object.fromEntries(mp.scenes[0].items.H.map((i) => [i.layer, i]));
  assert.deepEqual(mi.cam.effects, [{ type: 'personMask', mode: 'remove', threshold: 0.5, feather: 0.1, smoothing: 0, strength: 20, color: '#00b140' }],
    'defaults filled in: mode remove, strength 20, colour #00b140');
  const bad = [
    [{ type: 'personMask', mode: 'cutout', threshold: 0.5, feather: 0.1, smoothing: 0 }],
    [{ type: 'personMask', threshold: 0.5, feather: 0.1, smoothing: 1 }],
    [{ type: 'personMask', threshold: 0.5, feather: 0.1 }],
    [{ type: 'personMask', threshold: 0.5, feather: 0.1, smoothing: 0, strength: 0 }],
    [{ type: 'autoFrame', zoom: 5, smoothing: 0.5, deadzone: 0.1 }],
    [{ type: 'autoFrame', zoom: 2, smoothing: 0.5 }],
    [{ type: 'faceSticker', file: { base: 'media', rel: 'sticker.png' }, anchor: 'chin', scale: 1, offsetX: 0, offsetY: 0 }],
    [{ type: 'faceSticker', anchor: 'eyes', scale: 1, offsetX: 0, offsetY: 0 }],
    [{ type: 'faceSticker', file: { base: 'media', rel: 'sticker.png' }, anchor: 'eyes', scale: 11, offsetX: 0, offsetY: 0 }]
  ];
  for (const effects of bad) {
    const d = clone(TRACK);
    d.scenes[0].layers[1].effects = effects;
    assert.equal(validateProject(d).ok, false, `validator: ${JSON.stringify(effects)}`);
    assert.equal((await rpcErr('project.plan', { project: d, bases: { media } })).code, -32602, `host: ${JSON.stringify(effects)}`);
  }
  const missing = clone(TRACK);
  missing.scenes[0].layers[2].effects[0].file.rel = 'nope.png';
  const w = (await planInHost(c, missing, { bases: { media } })).warnings.find((x) => x.layer === 'quad-st');
  assert.ok(w && w.effect === 'faceSticker', 'a missing sticker file is a plan warning');
});

test('face.status: the link is on; no worker means nothing is captured and the layers draw plainly', async () => {
  const r = await loadIntoHost(c, MASKS, { bases: { media } });
  assert.deepEqual(r.unavailable, []);
  await new Promise((res) => setTimeout(res, 500));
  const st = await c.call('face.status');
  assert.equal(st.on, true);
  assert.equal(st.workerAlive, false);
  assert.equal(st.framesSent, 0, 'no worker: no camera frame leaves the host');
  const px = frameRgb(await recordFrame('face-noworker.mkv'), 1280, 720);
  near(px(40 + 240, 40 + 90), [255, 0, 0], 'remove, no worker: the plain layer');
  near(px(400 + 240, 40 + 90), [255, 0, 0], 'replace, no worker: the plain layer');
});

const pyOk = existsSync(PY);

test('personMask with a synthetic mask: remove, replace colour, blur; stale mask fades to the plain layer', { skip: !pyOk && `no face Python at ${PY}` }, async () => {
  const r = await loadIntoHost(c, MASKS, { bases: { media } });
  assert.deepEqual(r.unavailable, []);
  const worker = fakeWorker(6);
  await new Promise((res) => setTimeout(res, 1500));
  const px = frameRgb(await recordFrame('face-mask.mkv'), 1280, 720);
  const st = await c.call('face.status');
  const sum = await worker;
  assert.ok(sum.frames > 10, `the fake worker answered frames: ${JSON.stringify(sum)}`);
  assert.deepEqual(sum.src, [320, 180], 'the link analyses the shared source at its own size');
  assert.ok(st.framesSent > 10 && st.results > 10, `face.status counts: ${JSON.stringify(st)}`);
  near(px(40 + 60, 40 + 90), [255, 0, 0], 'remove: the person half shows');
  near(px(40 + 260, 40 + 90), [0, 255, 0], 'remove: the background half is transparent (green canvas)');
  near(px(400 + 60, 40 + 90), [255, 0, 0], 'replace: the person half shows');
  near(px(400 + 260, 40 + 90), [0, 0, 255], 'replace colour: the background half is blue');
  near(px(760 + 60, 40 + 90), [255, 0, 0], 'blur: the person half shows');
  near(px(760 + 260, 40 + 90), [255, 0, 0], 'blur of a flat red layer is red');
  await new Promise((res) => setTimeout(res, 1500)); // worker gone > hold + fade
  const stale = frameRgb(await recordFrame('face-stale.mkv'), 1280, 720);
  near(stale(40 + 260, 40 + 90), [255, 0, 0], 'stale mask: back to the plain layer');
  near(stale(400 + 260, 40 + 90), [255, 0, 0], 'stale mask: replace shows the plain layer');
});

test('autoFrame and faceSticker with synthetic face points', { skip: !pyOk && `no face Python at ${PY}` }, async () => {
  const r = await loadIntoHost(c, TRACK, { bases: { media } });
  assert.deepEqual(r.unavailable, []);
  const worker = fakeWorker(6);
  await new Promise((res) => setTimeout(res, 1500));
  const px = frameRgb(await recordFrame('face-track.mkv'), 1280, 720);
  await worker;
  // face box centre (0.75, 0.75), zoom 2: the crop is the bottom right quadrant (yellow) stretched over the layer
  near(px(40 + 20, 300 + 20), [255, 255, 0], 'autoFrame: top left of the layer shows the face quadrant');
  near(px(40 + 300, 300 + 160), [255, 255, 0], 'autoFrame: bottom right too');
  // eyes at y 0.5, x 0.425 .. 0.575 of 320 x 180: midpoint (160, 90), eye distance 48 px; sticker 48 x 24 magenta
  near(px(400 + 160, 300 + 90), [255, 0, 255], 'faceSticker: the sticker sits between the eyes');
  near(px(400 + 160 + 40, 300 + 80), [0, 255, 0], 'faceSticker: no wider than one eye distance (green quadrant beside it)');
  near(px(400 + 20, 300 + 20), [255, 0, 0], 'faceSticker: the layer itself is unchanged');
  await new Promise((res) => setTimeout(res, 1500));
  const stale = frameRgb(await recordFrame('face-track-stale.mkv'), 1280, 720);
  near(stale(400 + 150, 300 + 95), [0, 0, 255], 'no face: no sticker (the blue quadrant shows where it was)');
});
