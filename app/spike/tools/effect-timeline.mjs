// SPDX-License-Identifier: GPL-2.0-or-later
// Measures an overlay effect in a recording made over a flat-colour background.
// Streams the video through ffmpeg as downscaled RGB, marks pixels that differ from the
// background, and reports per-episode timing, geometry (distance from the canvas edges) and
// colour (hue of saturated "glow" pixels, mean of near-white "core" pixels).
//
//   node effect-timeline.mjs --video FILE [--scale 4] [--mask x,y,w,h] [--threshold 40] [--json OUT]
//
// --border N ignores N full-resolution pixels at each frame edge.
// --mask is in full-resolution pixels and is ignored (e.g. the ?debug=1 readout box).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const video = arg('video');
if (!video) { console.error('usage: --video FILE'); process.exit(1); }
const SCALE = Number(arg('scale', 4));
const THRESH = Number(arg('threshold', 40));
const REF = Number(arg('ref', 0)); // frame index used as the idle reference (must precede any effect)
const BORDER = Number(arg('border', 0)); // full-res px at the frame edge to ignore (e.g. the ?debug=1 outline)
const mask = (arg('mask', '') || '').split(',').filter(Boolean).map(Number);

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,r_frame_rate', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (c) => (c === 0 ? resolve(JSON.parse(out).streams[0]) : reject(new Error('ffprobe ' + c))));
  });
}

function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return { h: 0, s: 0, v: mx / 255 };
  let h;
  if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s: d / mx, v: mx / 255 };
}

const info = await probe(video);
const [fn, fd] = info.r_frame_rate.split('/').map(Number);
const fps = fn / fd;
const W = Math.round(info.width / SCALE), H = Math.round(info.height / SCALE);
const frameBytes = W * H * 3;
const m = mask.length === 4 ? mask.map((v) => Math.round(v / SCALE)) : null;

const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}:flags=area`, '-f', 'rawvideo',
  '-pix_fmt', 'rgb24', '-']);
let buf = Buffer.alloc(0);
let idx = 0;
let bg = null;
let ref = null; // per-pixel reference (first frame, before any effect)
const frames = [];

function analyse(f) {
  if (idx < REF) return; // frames before the reference are not analysed
  if (!ref) { ref = Buffer.from(f); bg = [f[0], f[1], f[2]]; } // idle reference frame (--ref, default 0)
  let n = 0, minEdge = Infinity, x0 = W, y0 = H, x1 = -1, y1 = -1;
  let in220 = 0, in600 = 0;
  let glowN = 0, hx = 0, hy = 0, gr = 0, gg = 0, gb = 0, coreN = 0, cr = 0, cg = 0, cb = 0, ymax = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (m && x >= m[0] && x < m[0] + m[2] && y >= m[1] && y < m[1] + m[3]) continue;
      if (BORDER && Math.min(x, y, W - 1 - x, H - 1 - y) * SCALE < BORDER) continue;
      const i = (y * W + x) * 3;
      const r = f[i], g = f[i + 1], b = f[i + 2];
      const d = Math.abs(r - ref[i]) + Math.abs(g - ref[i + 1]) + Math.abs(b - ref[i + 2]);
      if (d < THRESH) continue;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const e = Math.min(x, y, W - 1 - x, H - 1 - y) * SCALE;
      if (e < minEdge) minEdge = e;
      if (e <= 220) in220++;
      if (e <= 600) in600++;
      const c = hue(r, g, b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma > ymax) ymax = luma;
      if (c.s > 0.35 && c.v > 0.3) {
        glowN++; hx += Math.cos(c.h * Math.PI / 180); hy += Math.sin(c.h * Math.PI / 180);
        gr += r; gg += g; gb += b;
      } else if (c.s < 0.2 && c.v > 0.75) { coreN++; cr += r; cg += g; cb += b; }
    }
  }
  const glowHue = glowN ? ((Math.atan2(hy, hx) * 180 / Math.PI) + 360) % 360 : null;
  frames.push({
    i: idx, t: +(idx / fps).toFixed(4), active: n, ymax: Math.round(ymax),
    bbox: n ? [x0 * SCALE, y0 * SCALE, (x1 + 1) * SCALE, (y1 + 1) * SCALE] : null,
    minEdgePx: n ? minEdge : null,
    in220: n ? +(in220 / n).toFixed(3) : null, in600: n ? +(in600 / n).toFixed(3) : null,
    glow: glowN ? { n: glowN, hue: +glowHue.toFixed(1), rgb: [gr / glowN, gg / glowN, gb / glowN].map(Math.round) } : null,
    core: coreN ? { n: coreN, rgb: [cr / coreN, cg / coreN, cb / coreN].map(Math.round) } : null
  });
}

ff.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= frameBytes) {
    analyse(buf.subarray(0, frameBytes));
    buf = buf.subarray(frameBytes);
    idx++;
  }
});

ff.on('close', () => {
  // Episodes: runs of frames with active pixels, allowing 2-frame gaps (flicker).
  const MIN = Number(arg('min-active', 20));
  const eps = [];
  let cur = null, gap = 0;
  for (const fr of frames) {
    if (fr.active >= MIN) {
      if (!cur) cur = { start: fr, end: fr, peak: fr, frames: [] };
      cur.end = fr; gap = 0; cur.frames.push(fr);
      if (fr.active > cur.peak.active) cur.peak = fr;
    } else if (cur && ++gap > 2) { eps.push(cur); cur = null; gap = 0; }
  }
  if (cur) eps.push(cur);
  const summary = eps.map((e, k) => {
    const hues = e.frames.filter((f) => f.glow).map((f) => f.glow.hue);
    const cores = e.frames.filter((f) => f.core).map((f) => f.core.rgb);
    const hx = hues.reduce((s, h) => s + Math.cos(h * Math.PI / 180), 0);
    const hy = hues.reduce((s, h) => s + Math.sin(h * Math.PI / 180), 0);
    const bb = e.frames.reduce((a, f) => [Math.min(a[0], f.bbox[0]), Math.min(a[1], f.bbox[1]),
      Math.max(a[2], f.bbox[2]), Math.max(a[3], f.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    return {
      episode: k + 1,
      startFrame: e.start.i, endFrame: e.end.i,
      start_s: e.start.t, end_s: e.end.t,
      visible_ms: Math.round((e.end.i - e.start.i + 1) * 1000 / fps),
      rise_ms: Math.round((e.peak.i - e.start.i) * 1000 / fps),
      peakFrame: e.peak.i,
      bbox: bb,
      minEdgePx: Math.min(...e.frames.map((f) => f.minEdgePx)),
      // share of active pixels within 220 / 600 px of the nearest canvas edge, weighted over the episode
      in220: +(e.frames.reduce((s, f) => s + f.in220 * f.active, 0) / e.frames.reduce((s, f) => s + f.active, 0)).toFixed(3),
      in600: +(e.frames.reduce((s, f) => s + f.in600 * f.active, 0) / e.frames.reduce((s, f) => s + f.active, 0)).toFixed(3),
      glowHue: hues.length ? +(((Math.atan2(hy, hx) * 180 / Math.PI) + 360) % 360).toFixed(1) : null,
      peakGlowRgb: e.peak.glow ? e.peak.glow.rgb : null,
      coreRgb: cores.length ? [0, 1, 2].map((c) => Math.round(cores.reduce((s, v) => s + v[c], 0) / cores.length)) : null,
      maxLuma: Math.max(...e.frames.map((f) => f.ymax))
    };
  });
  const result = { video, fps, width: info.width, height: info.height, analysedAt: `${W}x${H}`, background: bg,
    threshold: THRESH, mask, frames: frames.length, episodes: summary };
  if (arg('json')) writeFileSync(arg('json'), JSON.stringify({ ...result, timeline: frames }, null, 1));
  console.log(JSON.stringify(result, null, 1));
});
