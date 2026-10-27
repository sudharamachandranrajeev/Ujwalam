// SPDX-License-Identifier: GPL-2.0-or-later
// Flash rate of a recording, from rendered-frame luminance (WCAG 2.x general-flash method).
//
//   node flash-rate.mjs --video FILE [--scale 4] [--grid 3] [--from S] [--to S] [--json OUT]
//
// Each frame is downscaled (--scale) and converted to relative luminance
// L = 0.2126 R + 0.7152 G + 0.0722 B on linearised sRGB. The frame is covered by overlapping
// windows of 1/grid of the width and 1/grid of the height (stride half a window). grid 3 gives
// windows of ~11 % of the canvas: the WCAG "25 % of a 10 degree field" area (341x256 of
// 1024x768). Per window, a transition is a change of mean L of at least 0.1 between successive
// extremes, with the darker side below 0.8. A flash is a pair of opposing transitions.
// Reported: the largest number of flashes inside any 1 s span in any window (flashes/s), and the
// largest frame-to-frame change of window mean L, to show the margin. Red flash is not checked.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const video = arg('video');
if (!video) { console.error('usage: --video FILE'); process.exit(1); }
const SCALE = Number(arg('scale', 4));
const GRID = Number(arg('grid', 3));
const FROM = Number(arg('from', 0));
const TO = Number(arg('to', Infinity));
const DL = 0.1, DARK = 0.8;

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (c) => (c === 0 ? resolve(JSON.parse(out).streams[0]) : reject(new Error('ffprobe ' + c))));
  });
}

const lin = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

const info = await probe(video);
const [fn, fd] = info.r_frame_rate.split('/').map(Number);
const fps = fn / fd;
const W = Math.round(info.width / SCALE), H = Math.round(info.height / SCALE);
const ww = Math.floor(W / GRID), wh = Math.floor(H / GRID);
const sx = Math.max(1, Math.floor(ww / 2)), sy = Math.max(1, Math.floor(wh / 2));
const wins = [];
for (let y = 0; y + wh <= H; y += sy) for (let x = 0; x + ww <= W; x += sx) wins.push({ x, y, prev: null, dir: 0, ref: 0, lo: Infinity, hi: -Infinity, trans: [], maxStep: 0 });

const frameBytes = W * H * 3;
const L = new Float64Array(W * H);
let buf = Buffer.alloc(0), idx = 0, analysed = 0;

function transition(w, t, a, b) { if (Math.min(a, b) < DARK) w.trans.push(t); }

function analyse(f) {
  const t = idx / fps;
  if (t < FROM || t > TO) return;
  analysed++;
  for (let i = 0, p = 0; i < W * H; i++, p += 3) L[i] = 0.2126 * lin[f[p]] + 0.7152 * lin[f[p + 1]] + 0.0722 * lin[f[p + 2]];
  for (const w of wins) {
    let s = 0;
    for (let y = w.y; y < w.y + wh; y++) for (let x = w.x; x < w.x + ww; x++) s += L[y * W + x];
    const v = s / (ww * wh);
    if (w.prev !== null) w.maxStep = Math.max(w.maxStep, Math.abs(v - w.prev));
    w.prev = v;
    if (w.dir === 0) {
      w.lo = Math.min(w.lo, v); w.hi = Math.max(w.hi, v);
      if (v - w.lo >= DL) { transition(w, t, w.lo, v); w.dir = 1; w.ref = v; } else if (w.hi - v >= DL) { transition(w, t, w.hi, v); w.dir = -1; w.ref = v; }
    } else if (w.dir === 1) {
      if (v > w.ref) w.ref = v; else if (w.ref - v >= DL) { transition(w, t, w.ref, v); w.dir = -1; w.ref = v; }
    } else if (v < w.ref) w.ref = v; else if (v - w.ref >= DL) { transition(w, t, w.ref, v); w.dir = 1; w.ref = v; }
  }
}

const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
ff.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= frameBytes) { analyse(buf.subarray(0, frameBytes)); buf = buf.subarray(frameBytes); idx++; }
});
ff.on('close', () => {
  let maxFlashes = 0, at = null, maxStep = 0, transTotal = 0;
  for (const w of wins) {
    maxStep = Math.max(maxStep, w.maxStep);
    transTotal += w.trans.length;
    for (let i = 0; i < w.trans.length; i++) {
      let n = 0;
      for (let j = i; j < w.trans.length && w.trans[j] - w.trans[i] < 1; j++) n++;
      const flashes = Math.floor(n / 2);
      if (flashes > maxFlashes) { maxFlashes = flashes; at = { t: +w.trans[i].toFixed(3), window: [w.x * SCALE, w.y * SCALE, ww * SCALE, wh * SCALE] }; }
    }
  }
  const result = {
    video, fps, frames: analysed, grid: GRID, windows: wins.length, windowPx: [ww * SCALE, wh * SCALE],
    windowAreaPct: +(100 * ww * wh / (W * H)).toFixed(1), threshold: { deltaL: DL, darkerBelow: DARK },
    transitions: transTotal, maxFlashesPerSecond: maxFlashes, at, maxFrameStepL: +maxStep.toFixed(4),
    limit: 3, pass: maxFlashes <= 3
  };
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result));
});
