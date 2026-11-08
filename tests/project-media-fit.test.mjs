// SPDX-License-Identifier: GPL-3.0-or-later
// Media fit (D251): black-bar detection (services/project/media-info.mjs) and `fit: "contain"` + `cropBars` in scene
// presets (services/project/scene-preset.mjs). No real media: frames and probes are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { barsFromGray, BAR_LUMA, createMediaInfo, probeMedia } from '../services/project/media-info.mjs';
import { createProject } from '../services/project/index.mjs';
import { loadScenePreset } from '../services/project/scene-preset.mjs';

// width x height gray frame: picture (bright) inside [l, w-r) x [t, h-b), dark elsewhere
function frame(w, h, { l = 0, t = 0, r = 0, b = 0 } = {}, dots = []) {
  const f = Buffer.alloc(w * h, 3);
  for (let y = t; y < h - b; y++) for (let x = l; x < w - r; x++) f[y * w + x] = 150;
  for (const [x, y] of dots) f[y * w + x] = 200;
  return f;
}

test('barsFromGray: side bars; a small watermark inside a bar does not end it', () => {
  const W = 128, H = 72;
  const dots = []; for (let y = 68; y < 70; y++) for (let x = 120; x < 126; x++) dots.push([x, y]); // bottom-right logo
  assert.deepEqual(barsFromGray([frame(W, H, { l: 10, r: 11 }, dots), frame(W, H, { l: 10, r: 11 })], W, H), { left: 10, top: 0, right: 11, bottom: 0 });
  assert.deepEqual(barsFromGray([frame(W, H, { t: 9, b: 9 })], W, H), { left: 0, top: 9, right: 0, bottom: 9 });
  assert.deepEqual(barsFromGray([frame(W, H)], W, H), { left: 0, top: 0, right: 0, bottom: 0 });
  // an all-dark sample (a fade-in) says nothing
  assert.deepEqual(barsFromGray([Buffer.alloc(W * H, BAR_LUMA)], W, H), { left: 0, top: 0, right: 0, bottom: 0 });
  // content in a later frame counts: a column lit in any frame is picture
  assert.deepEqual(barsFromGray([frame(W, H, { l: 30, r: 30 }), frame(W, H, { l: 10, r: 11 })], W, H), { left: 10, top: 0, right: 11, bottom: 0 });
});

test('probeMedia: size from ffprobe, bars from gray frames, hidden children; stills and failures', () => {
  const W = 64, H = 36;
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ args, opts });
    if (args.includes('-show_entries')) return { status: 0, stdout: JSON.stringify({ streams: [{ width: W, height: H }] }) };
    return { status: 0, stdout: Buffer.concat([frame(W, H, { l: 5, r: 6 }), frame(W, H, { l: 5, r: 6 })]) };
  };
  assert.deepEqual(probeMedia('x.mp4', { spawn }), { width: W, height: H, crop: { left: 5, top: 0, right: 6, bottom: 0 } });
  assert.ok(calls.every((c) => c.opts.windowsHide === true), 'no console window (D191)');
  assert.ok(calls[1].args.includes('fps=1,format=gray'));
  calls.length = 0;
  assert.deepEqual(probeMedia('x.png', { spawn }), { width: W, height: H, crop: { left: 0, top: 0, right: 0, bottom: 0 } });
  assert.equal(calls.length, 1, 'a still is not decoded');
  assert.equal(probeMedia('x.mp4', { spawn: () => ({ error: new Error('ENOENT') }) }), null);
  assert.equal(probeMedia('x.mp4', { spawn: () => ({ status: 0, stdout: '{"streams":[]}' }) }), null);
  // decode failure: size kept, no bars
  const half = (c, args) => (args.includes('-show_entries') ? { status: 0, stdout: JSON.stringify({ streams: [{ width: W, height: H }] }) } : { status: 1, stdout: Buffer.alloc(0) });
  assert.deepEqual(probeMedia('x.mp4', { spawn: half }), { width: W, height: H, crop: { left: 0, top: 0, right: 0, bottom: 0 } });
});

test('createMediaInfo: resolves under its base only, caches per file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ujw-fit-'));
  try {
    mkdirSync(path.join(dir, 'a'));
    writeFileSync(path.join(dir, 'a', 'v.mp4'), 'x');
    let n = 0;
    const mi = createMediaInfo({ bases: { media: path.join(dir, 'a') }, probe: () => { n++; return { width: 10, height: 10, crop: { left: 0, top: 0, right: 0, bottom: 0 } }; } });
    assert.equal(mi({ base: 'media', rel: 'v.mp4' }).width, 10);
    mi({ base: 'media', rel: 'v.mp4' });
    assert.equal(n, 1, 'cached');
    assert.equal(mi({ base: 'media', rel: '../a/../../x.mp4' }), null, 'outside the base');
    assert.equal(mi({ base: 'profile', rel: 'v.mp4' }), null, 'unknown base');
    assert.equal(mi({ base: 'media', rel: 'missing.mp4' }), null);
    assert.equal(n, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function preset(layer) {
  return { id: 't', version: '0.1.0', function: 'scene-layout-preset', functionVersion: '^0.1.0', params: { sceneName: 'T', canvas: 'h', layers: [layer] } };
}
const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }; // 384 x 108 at 1920x1080, origin 192,108
const WM = { key: 'wm', z: 1, name: 'Wordmark', type: 'image', file: { base: 'profile', rel: '{brand.wordmark}' }, rect: BOX };
const profile = { brand: { wordmark: 'wm.mp4' } };
const place = (r) => r.project.scenes.at(-1).layers[0].placements.h;

test('fit contain + cropBars: bars cut, true shape, centred in the box; no info keeps the box', () => {
  const info = { width: 1280, height: 720, crop: { left: 102, top: 0, right: 103, bottom: 0 } };
  const asked = [];
  const mediaInfo = (ref) => { asked.push(ref); return info; };
  const r = loadScenePreset(createProject({ name: 'p' }), preset({ ...WM, fit: 'contain', cropBars: true }), { profile, mediaInfo });
  const p = place(r);
  assert.deepEqual(asked, [{ base: 'profile', rel: 'wm.mp4' }]);
  assert.equal(p.height, 108);
  assert.equal(p.width, Math.round((1075 * 108 / 720) * 100) / 100); // 161.25
  assert.equal(p.x, Math.round((192 + (384 - p.width) / 2) * 100) / 100);
  assert.equal(p.y, 108);
  assert.deepEqual(p.crop, { left: 102, top: 0, right: 103, bottom: 0 });

  // cropBars off: whole frame at 16:9
  const q = place(loadScenePreset(createProject({ name: 'p' }), preset({ ...WM, fit: 'contain' }), { profile, mediaInfo }));
  assert.deepEqual([q.width, q.height, q.crop], [192, 108, undefined]);

  // no probe, or a failed one: the box stays (stretched, as before D251)
  for (const mi of [null, () => null]) {
    const s = place(loadScenePreset(createProject({ name: 'p' }), preset({ ...WM, fit: 'contain', cropBars: true }), { profile, mediaInfo: mi }));
    assert.deepEqual([s.x, s.y, s.width, s.height, s.crop], [192, 108, 384, 108, undefined]);
  }
  // no fit: never probed
  asked.length = 0;
  loadScenePreset(createProject({ name: 'p' }), preset(WM), { profile, mediaInfo });
  assert.deepEqual(asked, []);
});

test('fit contain: a tall picture fills the height of a narrow box; a missing asset stays a placeholder', () => {
  const info = { width: 100, height: 400, crop: { left: 0, top: 0, right: 0, bottom: 0 } };
  const p = place(loadScenePreset(createProject({ name: 'p' }), preset({ ...WM, fit: 'contain' }), { profile, mediaInfo: () => info }));
  assert.deepEqual([p.width, p.height, p.y], [27, 108, 108]);
  const r = loadScenePreset(createProject({ name: 'p' }), preset({ ...WM, fit: 'contain' }), { profile: {}, mediaInfo: () => { throw new Error('not called'); } });
  assert.deepEqual(r.missingAssets, ['brand.wordmark']);
  assert.deepEqual([place(r).width, place(r).height], [384, 108]);
});

test('committed H preset: the wordmark uses fit contain with cropBars (D251)', async () => {
  const { readFileSync } = await import('node:fs');
  const h = JSON.parse(readFileSync('registry/presets/scene-default-h.json', 'utf8'));
  const wm = h.params.layers.find((l) => l.key === 'wordmark');
  assert.deepEqual([wm.fit, wm.cropBars], ['contain', true]);
});
