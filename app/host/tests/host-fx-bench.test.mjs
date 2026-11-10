// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: render cost of the layer effects (D291 proposed). Opt-in: it loads the GPU for about a minute.
//   UJWALAM_FX_BENCH=1 node --test --test-timeout=600000 app/host/tests/host-fx-bench.test.mjs
// Six full-canvas 1920x1080 image layers per run, all with the same effect, no output running. Reports the host's
// average frame time (obs_get_average_frame_time_ns: the render thread's time per frame, CPU side; the GPU works
// asynchronously, so this is an approximation of GPU cost) and NVML GPU load, each against a run without effects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const RUN = process.env.UJWALAM_FX_BENCH === '1';
const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const LAYERS = 6;
const WARM_MS = 2000;
const SAMPLE_MS = 4000;
let h;
let c;
let media;

function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

before(async () => {
  if (!RUN) return;
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'bench-'));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-frames:v', '1', path.join(media, 'frame.png')]);
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=1920x1080,format=gray,geq=lum='X*255/W'", '-frames:v', '1', path.join(media, 'mask.png')]);
  writeFileSync(path.join(media, 'invert.cube'), ['LUT_3D_SIZE 2',
    ...Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1].map((v) => (1 - v).toFixed(1)).join(' '))].join('\n') + '\n');
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'data-')), project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
  c = h.client;
});

after(async () => {
  if (h) await stopHost(h);
});

const file = (rel) => ({ base: 'media', rel });
const CASES = [
  ['none', null],
  ['blur 20 (existing, reference)', { type: 'blur', strength: 20 }],
  ['sharpen', { type: 'sharpen', amount: 0.3 }],
  ['vignette', { type: 'vignette', amount: 0.6, size: 0.4, softness: 0.4, color: '#000000' }],
  ['grain', { type: 'grain', amount: 0.3, size: 2 }],
  ['pixelate', { type: 'pixelate', size: 24 }],
  ['posterize', { type: 'posterize', levels: 6 }],
  ['lut (.cube)', { type: 'lut', file: file('invert.cube'), amount: 1 }],
  ['mirror', { type: 'mirror' }],
  ['circleMask + ring', { type: 'circleMask', feather: 2, borderWidth: 3, borderColor: '#ffffff' }],
  ['roundMask', { type: 'roundMask', radius: 10, feather: 1, borderWidth: 0, borderColor: '#ffffff' }],
  ['opacity', { type: 'opacity', opacity: 0.8 }],
  ['blendMultiply', { type: 'blendMultiply', opacity: 1 }],
  ['gradientMask', { type: 'gradientMask', angle: 90, start: 0.6, end: 1 }],
  ['imageMask', { type: 'imageMask', file: file('mask.png'), channel: 'luma', invert: false, feather: 0 }]
];

function doc(effect) {
  return {
    version: 1, id: 'fx-bench', name: 'FX bench', activeScene: 'main',
    canvases: [{ id: 'h', width: 1920, height: 1080, fps: 60 }], devices: [], overlays: [], outputs: [],
    scenes: [{ id: 'main', name: 'Main', layers: Array.from({ length: LAYERS }, (_, i) => ({
      id: `l${i}`, type: 'image', name: `L${i}`, source: { file: file('frame.png') }, ...(effect ? { effects: [effect] } : {}),
      placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } }
    })) }],
    audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
  };
}

async function measure() {
  await new Promise((res) => setTimeout(res, WARM_MS));
  const ft = [], gpu = [];
  for (let t = 0; t < SAMPLE_MS; t += 250) {
    const s = await c.call('host.status');
    ft.push(s.render.avgFrameTimeMs);
    if (typeof s.gpuPct === 'number') gpu.push(s.gpuPct);
    await new Promise((res) => setTimeout(res, 250));
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { frameMs: avg(ft), gpuPct: avg(gpu) };
}

test('render cost per effect: 6 full-canvas 1080p layers', { skip: !RUN && 'set UJWALAM_FX_BENCH=1' }, async () => {
  const rows = [];
  for (const [name, effect] of CASES) {
    const r = await loadIntoHost(c, doc(effect), { bases: { media } });
    assert.deepEqual(r.unavailable, [], name);
    rows.push({ name, ...(await measure()) });
  }
  const base = rows[0];
  const f = (v, d = 2) => (v == null ? 'n/a' : v.toFixed(d));
  console.log(`| effect | frame ms | +ms vs none | +ms per layer | GPU % |`);
  console.log(`|---|---|---|---|---|`);
  for (const r of rows) {
    const d = r.frameMs - base.frameMs;
    console.log(`| ${r.name} | ${f(r.frameMs, 3)} | ${f(d, 3)} | ${f(d / LAYERS, 3)} | ${f(r.gpuPct, 0)} |`);
  }
  for (const r of rows) assert.ok(r.frameMs < 1000 / 60, `${r.name}: ${r.frameMs} ms fits a 60 fps frame`);
});

// D331 game backdrop: the alpha scene's shape on both canvases. A 1920x1080 still stands in for the game capture (H
// framed game; V framed game = a duplicate of it, as the alpha build does), then the two full-canvas blurred
// duplicates behind them: H strength 71 (no crop), V strength 40 (crop 656 left/right). Before = game layers only.
function backdropDoc(withBackdrop) {
  const px = (c, o) => ({ [c]: { visible: true, ...o } });
  const layers = [];
  if (withBackdrop) {
    layers.push({ id: 'bd-h', type: 'duplicate', name: 'Backdrop H', source: { layer: 'game' }, effects: [{ type: 'blur', strength: 71 }], placements: px('h', { x: 0, y: 0, width: 1920, height: 1080 }) });
    layers.push({ id: 'bd-v', type: 'duplicate', name: 'Backdrop V', source: { layer: 'game' }, effects: [{ type: 'blur', strength: 40 }], placements: px('v', { x: 0, y: 0, width: 1080, height: 1920, crop: { left: 656, right: 656 } }) });
  }
  layers.push({ id: 'game', type: 'image', name: 'Game', source: { file: file('frame.png') }, placements: px('h', { x: 468, y: 31, width: 1418, height: 978, crop: { left: 177, right: 177 } }) });
  layers.push({ id: 'game-v', type: 'duplicate', name: 'Game V', source: { layer: 'game' }, placements: px('v', { x: 0, y: 458, width: 1080, height: 935, crop: { left: 336, right: 336 } }) });
  return {
    version: 1, id: 'fx-bench-bd', name: 'FX bench backdrop', activeScene: 'main',
    canvases: [{ id: 'h', width: 1920, height: 1080, fps: 60 }, { id: 'v', width: 1080, height: 1920, fps: 60 }], devices: [], overlays: [], outputs: [],
    scenes: [{ id: 'main', name: 'Main', layers }],
    audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
  };
}

test('game backdrop (D331): H + V full-canvas blurred duplicates, before/after', { skip: !RUN && 'set UJWALAM_FX_BENCH=1' }, async () => {
  const rows = [];
  // twice each, alternating, so a drift of the idle GPU clock shows up as a spread between the runs
  for (const [name, bd] of [['game only (before)', false], ['game + backdrops (after)', true], ['game only (before)', false], ['game + backdrops (after)', true]]) {
    const r = await loadIntoHost(c, backdropDoc(bd), { bases: { media } });
    assert.deepEqual(r.unavailable, [], name);
    rows.push({ name, ...(await measure()) });
  }
  const f = (v, d = 2) => (v == null ? 'n/a' : v.toFixed(d));
  console.log(`| run | frame ms | GPU % |`);
  console.log(`|---|---|---|`);
  for (const r of rows) console.log(`| ${r.name} | ${f(r.frameMs, 3)} | ${f(r.gpuPct, 0)} |`);
  for (const r of rows) assert.ok(r.frameMs < 1000 / 60, `${r.name}: ${r.frameMs} ms fits a 60 fps frame`);
});
