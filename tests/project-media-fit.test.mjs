// SPDX-License-Identifier: GPL-3.0-or-later
// Media fit (D251): black-bar and keyed-border detection (services/project/media-info.mjs) and `fit: "contain"` +
// `cropBars` + `trimKey` in scene presets (services/project/scene-preset.mjs). No real media: frames and probes are
// synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BAR_LUMA, createMediaInfo, keyChannel, measureFrames, probeMedia } from '../services/project/media-info.mjs';
import { createProject } from '../services/project/index.mjs';
import { loadScenePreset } from '../services/project/scene-preset.mjs';

// width x height rgb24 frame: dark everywhere, `fill` colour inside [l, w-r) x [t, h-b), `dots` drawn on top
function frame(w, h, { l = 0, t = 0, r = 0, b = 0 } = {}, dots = [], fill = [150, 150, 150]) {
  const f = Buffer.alloc(w * h * 3, 3);
  const put = (x, y, c) => { const o = (y * w + x) * 3; f[o] = c[0]; f[o + 1] = c[1]; f[o + 2] = c[2]; };
  for (let y = t; y < h - b; y++) for (let x = l; x < w - r; x++) put(x, y, fill);
  for (const [x, y, c = [200, 200, 200]] of dots) put(x, y, c);
  return f;
}
const NONE = { left: 0, top: 0, right: 0, bottom: 0 };

test('measureFrames bars: side bars; a small watermark inside a bar does not end it', () => {
  const W = 128, H = 72;
  const dots = []; for (let y = 68; y < 70; y++) for (let x = 120; x < 126; x++) dots.push([x, y]); // bottom-right logo
  assert.deepEqual(measureFrames([frame(W, H, { l: 10, r: 11 }, dots), frame(W, H, { l: 10, r: 11 })], W, H).crop, { left: 10, top: 0, right: 11, bottom: 0 });
  assert.deepEqual(measureFrames([frame(W, H, { t: 9, b: 9 })], W, H).crop, { left: 0, top: 9, right: 0, bottom: 9 });
  assert.deepEqual(measureFrames([frame(W, H)], W, H), { crop: NONE });
  // an all-dark sample (a fade-in) says nothing
  assert.deepEqual(measureFrames([Buffer.alloc(W * H * 3, BAR_LUMA - 4)], W, H).crop, NONE);
  // a column lit in any frame is picture
  assert.deepEqual(measureFrames([frame(W, H, { l: 30, r: 30 }), frame(W, H, { l: 10, r: 11 })], W, H).crop, { left: 10, top: 0, right: 11, bottom: 0 });
});

test('measureFrames content: green border cut to where the text ever is, padded, inside the bars', () => {
  const W = 200, H = 100, G = [0, 230, 20];
  const text = (x0, x1, y0, y1) => { const d = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.push([x, y, [240, 240, 240]]); return d; };
  // green picture between bars 10/10; the text moves between two frames: union x 60..140, y 30..60
  const frames = [frame(W, H, { l: 10, r: 10 }, text(60, 100, 30, 50), G), frame(W, H, { l: 10, r: 10 }, text(90, 140, 40, 60), G)];
  const m = measureFrames(frames, W, H, '#00ff00');
  assert.deepEqual(m.crop, { left: 10, top: 0, right: 10, bottom: 0 });
  // kept 80 x 30 -> pad round(1.6) = 2 px, round(0.6) = 1 px
  assert.deepEqual(m.content, { left: 58, top: 29, right: 58, bottom: 39 });
  // not a screen colour: no content
  assert.equal(measureFrames(frames, W, H, '#808080').content, undefined);
  // all green: content stays at the bars
  assert.deepEqual(measureFrames([frame(W, H, { l: 10, r: 10 }, [], G)], W, H, '#00ff00').content, { left: 10, top: 0, right: 10, bottom: 0 });
  assert.deepEqual([keyChannel('#00ff00'), keyChannel('#0000FF'), keyChannel('#00b140'), keyChannel('#ff0000'), keyChannel('green')], [1, 2, 1, null, null]);
});

test('probeMedia: size from ffprobe, frames scaled and sampled, hidden children; stills and failures', () => {
  const W = 64, H = 36;
  const calls = [];
  const probeOk = { status: 0, stdout: JSON.stringify({ streams: [{ width: W, height: H }] }) };
  const spawn = (cmd, args, opts) => {
    calls.push({ args, opts });
    if (args.includes('-show_entries')) return probeOk;
    return { status: 0, stdout: Buffer.concat([frame(W, H, { l: 5, r: 6 }), frame(W, H, { l: 5, r: 6 })]) };
  };
  assert.deepEqual(probeMedia('x.mp4', { spawn }), { width: W, height: H, crop: { left: 5, top: 0, right: 6, bottom: 0 } });
  assert.ok(calls.every((c) => c.opts.windowsHide === true), 'no console window (D191)');
  assert.ok(calls[1].args.includes('fps=2,format=rgb24'));
  calls.length = 0;
  assert.deepEqual(probeMedia('x.png', { spawn }), { width: W, height: H, crop: NONE });
  assert.equal(calls.length, 1, 'a still without a key is not decoded');
  assert.equal(probeMedia('x.mp4', { spawn: () => ({ error: new Error('ENOENT') }) }), null);
  assert.equal(probeMedia('x.mp4', { spawn: () => ({ status: 0, stdout: '{"streams":[]}' }) }), null);
  // decode failure: size kept, nothing cut
  const half = (c, args) => (args.includes('-show_entries') ? probeOk : { status: 1, stdout: Buffer.alloc(0) });
  assert.deepEqual(probeMedia('x.mp4', { spawn: half, keyColor: '#00ff00' }), { width: W, height: H, crop: NONE, content: NONE });
  // wider than 1280: checked at a whole-factor smaller size, scaled back
  const big = [];
  const spawnBig = (c, args) => {
    big.push(args);
    if (args.includes('-show_entries')) return { status: 0, stdout: JSON.stringify({ streams: [{ width: 2560, height: 1440 }] }) };
    return { status: 0, stdout: frame(1280, 720, { l: 51, r: 52 }) };
  };
  assert.deepEqual(probeMedia('x.mp4', { spawn: spawnBig }).crop, { left: 102, top: 0, right: 104, bottom: 0 });
  assert.ok(big[1].includes('scale=1280:720,fps=2,format=rgb24'));
});

test('createMediaInfo: resolves under its base only, caches per file and key colour', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ujw-fit-'));
  try {
    mkdirSync(path.join(dir, 'a'));
    writeFileSync(path.join(dir, 'a', 'v.mp4'), 'x');
    const keys = [];
    const mi = createMediaInfo({ bases: { media: path.join(dir, 'a') }, probe: (f, o) => { keys.push(o.keyColor); return { width: 10, height: 10, crop: NONE }; } });
    assert.equal(mi({ base: 'media', rel: 'v.mp4' }).width, 10);
    mi({ base: 'media', rel: 'v.mp4' });
    mi({ base: 'media', rel: 'v.mp4' }, { keyColor: '#00ff00' });
    mi({ base: 'media', rel: 'v.mp4' }, { keyColor: '#00ff00' });
    assert.deepEqual(keys, [null, '#00ff00'], 'cached');
    assert.equal(mi({ base: 'media', rel: '../a/../../x.mp4' }), null, 'outside the base');
    assert.equal(mi({ base: 'profile', rel: 'v.mp4' }), null, 'unknown base');
    assert.equal(mi({ base: 'media', rel: 'missing.mp4' }), null);
    assert.equal(keys.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function preset(layer) {
  return { id: 't', version: '0.1.0', function: 'scene-layout-preset', functionVersion: '^0.1.0', params: { sceneName: 'T', canvas: 'h', layers: [layer] } };
}
const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }; // 384 x 108 at 1920x1080, origin 192,108
const WM = { key: 'wm', z: 1, name: 'Wordmark', type: 'image', file: { base: 'profile', rel: '{brand.wordmark}' }, rect: BOX };
const profile = { brand: { wordmark: 'wm.mp4' } };
const place = (r) => r.project.scenes.at(-1).layers[0].placements.h;
const load = (layer, opts) => loadScenePreset(createProject({ name: 'p' }), preset(layer), { profile, ...opts });

test('fit contain + cropBars: bars cut, true shape, centred in the box; no info keeps the box', () => {
  const info = { width: 1280, height: 720, crop: { left: 102, top: 0, right: 103, bottom: 0 } };
  const asked = [];
  const mediaInfo = (ref, o) => { asked.push([ref, o]); return info; };
  const p = place(load({ ...WM, fit: 'contain', cropBars: true }, { mediaInfo }));
  assert.deepEqual(asked, [[{ base: 'profile', rel: 'wm.mp4' }, {}]]);
  assert.equal(p.height, 108);
  assert.equal(p.width, Math.round((1075 * 108 / 720) * 100) / 100); // 161.25
  assert.equal(p.x, Math.round((192 + (384 - p.width) / 2) * 100) / 100);
  assert.equal(p.y, 108);
  assert.deepEqual(p.crop, { left: 102, top: 0, right: 103, bottom: 0 });

  // cropBars off: whole frame at 16:9
  const q = place(load({ ...WM, fit: 'contain' }, { mediaInfo }));
  assert.deepEqual([q.width, q.height, q.crop], [192, 108, undefined]);

  // no probe, or a failed one: the box stays (stretched, as before D251)
  for (const mi of [null, () => null]) {
    const s = place(load({ ...WM, fit: 'contain', cropBars: true }, { mediaInfo: mi }));
    assert.deepEqual([s.x, s.y, s.width, s.height, s.crop], [192, 108, 384, 108, undefined]);
  }
  // no fit: never probed
  asked.length = 0;
  load(WM, { mediaInfo });
  assert.deepEqual(asked, []);
});

test('fit contain: a tall picture fills the height of a narrow box; a missing asset stays a placeholder', () => {
  const info = { width: 100, height: 400, crop: NONE };
  const p = place(load({ ...WM, fit: 'contain' }, { mediaInfo: () => info }));
  assert.deepEqual([p.width, p.height, p.y], [27, 108, 108]);
  const r = load({ ...WM, fit: 'contain' }, { profile: {}, mediaInfo: () => { throw new Error('not called'); } });
  assert.deepEqual(r.missingAssets, ['brand.wordmark']);
  assert.deepEqual([place(r).width, place(r).height], [384, 108]);
});

test('trimKey: a keyed video is cut to its content; a still ignores it', () => {
  const info = { width: 1280, height: 720, crop: { left: 102, top: 0, right: 103, bottom: 0 }, content: { left: 172, top: 104, right: 170, bottom: 182 } };
  const asked = [];
  const mediaInfo = (ref, o) => { asked.push(o); return info; };
  const p = place(load({ ...WM, fit: 'contain', cropBars: true, trimKey: '#00ff00' }, { mediaInfo }));
  assert.deepEqual(asked, [{ keyColor: '#00ff00' }]);
  assert.deepEqual(p.crop, info.content);
  assert.equal(p.height, 108);
  assert.equal(p.width, Math.round((938 * 108 / 434) * 100) / 100);
  // a PNG wordmark is not keyed, so its green is picture: bars only, no key asked for
  asked.length = 0;
  const q = place(load({ ...WM, fit: 'contain', cropBars: true, trimKey: '#00ff00' }, { profile: { brand: { wordmark: 'wm.png' } }, mediaInfo }));
  assert.deepEqual(asked, [{}]);
  assert.deepEqual(q.crop, info.crop);
});

test('committed H preset: the wordmark uses fit contain with cropBars and trimKey (D251)', () => {
  const h = JSON.parse(readFileSync('registry/presets/scene-default-h.json', 'utf8'));
  const wm = h.params.layers.find((l) => l.key === 'wordmark');
  assert.deepEqual([wm.fit, wm.cropBars, wm.trimKey], ['contain', true, '#00ff00']);
});
