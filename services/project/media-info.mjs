// SPDX-License-Identifier: GPL-3.0-or-later
// Size, black bars and keyed-out border of an image or video file (D251), for scene presets that fit an asset into
// its box at its true shape (`fit: "contain"`, `cropBars`, `trimKey`). Node stdlib only; ffprobe/ffmpeg from
// FFPROBE / FFMPEG or PATH, every child hidden (windowsHide, D191). Nothing is ever written.
//
//   probeMedia(file, { keyColor? }) -> { width, height, crop, content? } | null
//   createMediaInfo({ bases }) -> (pathRef { base, rel }, { keyColor? }) -> same | null   (cached per file and key)
//
// All rectangles are { left, top, right, bottom } in source px.
// crop    = the black bars (all 0 for a still or no bars): rows/columns at the edges where at most BAR_SHARE of the
//           sampled pixels are lit (luma > BAR_LUMA). A small logo or watermark inside a bar does not end the bar.
// content = only with keyColor (a green or blue screen colour): the bars plus the border that is only ever dark or
//           key colour (at most CONTENT_SHARE of its pixels otherwise), then padded by CONTENT_PAD of the kept size
//           on each side (inside the bars) for frames between samples.
// Frames: 2 per second of the first `seconds`, scaled down by a whole factor to at most 1280 px wide for the check.
// Measured in Node, not with ffmpeg's cropdetect: that filter is GPL-only and the LGPL ffmpeg build in use has none.
// null when the file cannot be read or ffprobe is missing: the caller then keeps its box as it is.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const NONE = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
export const BAR_LUMA = 24;
export const BAR_SHARE = 0.05;
export const CONTENT_SHARE = 0.002;
export const CONTENT_PAD = 0.02;
const CHECK_WIDTH = 1280;
const FPS = 2;

/** '#00ff00' -> 1 (green), '#0000ff' -> 2 (blue): the channel a screen colour is made of; null for other colours. */
export function keyChannel(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const c = [1, 2, 3].map((i) => parseInt(m[i], 16));
  const top = c[1] >= c[2] ? 1 : 2;
  return c[top] >= 128 && c[top] >= 2 * Math.max(c[0], c[3 - top]) ? top : null;
}

const dark = (f, o) => 0.299 * f[o] + 0.587 * f[o + 1] + 0.114 * f[o + 2] <= BAR_LUMA;
// a pixel of the screen colour: its channel ch is bright and clearly above the other two
const keyed = (ch) => { const [a, b] = ch === 1 ? [0, 2] : [0, 1]; return (f, o) => f[o + ch] > 100 && f[o + ch] > 1.4 * f[o + a] && f[o + ch] > 1.4 * f[o + b]; };

// Edges of rectangle r (inside width x height) whose rows/columns have at most share of their pixels non-empty.
// frames: rgb24 Buffers. Returns r grown inward, or r unchanged when nothing (or almost nothing) would stay.
function trim(frames, width, height, empty, share, r, minKeep) {
  const x0 = r.left, x1 = width - r.right, y0 = r.top, y1 = height - r.bottom;
  const rowLit = new Uint32Array(height), colLit = new Uint32Array(width);
  for (const f of frames) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0, o = (y * width + x0) * 3; x < x1; x++, o += 3) if (!empty(f, o)) { rowLit[y]++; colLit[x]++; }
    }
  }
  const n = Math.max(1, frames.length);
  const colMax = share * (y1 - y0) * n, rowMax = share * (x1 - x0) * n;
  let l = x0, rr = x1, t = y0, b = y1;
  while (l < rr && colLit[l] <= colMax) l++;
  while (rr > l && colLit[rr - 1] <= colMax) rr--;
  while (t < b && rowLit[t] <= rowMax) t++;
  while (b > t && rowLit[b - 1] <= rowMax) b--;
  if (rr - l < (x1 - x0) * minKeep || b - t < (y1 - y0) * minKeep) return { ...r };
  return { left: l, top: t, right: width - rr, bottom: height - b };
}

/** The bars and, with keyColor, the content rectangle of rgb24 frames (width x height). */
export function measureFrames(frames, width, height, keyColor = null) {
  const bars = trim(frames, width, height, dark, BAR_SHARE, NONE, 0.25);
  const ch = keyChannel(keyColor);
  if (ch === null) return { crop: bars };
  const isKey = keyed(ch);
  const c = trim(frames, width, height, (f, o) => dark(f, o) || isKey(f, o), CONTENT_SHARE, bars, 0.02);
  const pw = Math.round((width - c.left - c.right) * CONTENT_PAD), ph = Math.round((height - c.top - c.bottom) * CONTENT_PAD);
  const content = {
    left: Math.max(bars.left, c.left - pw), right: Math.max(bars.right, c.right - pw),
    top: Math.max(bars.top, c.top - ph), bottom: Math.max(bars.bottom, c.bottom - ph),
  };
  return { crop: bars, content };
}

// back to source px; rounding down keeps a little more picture, never less
const scaleRect = (r, k) => (k === 1 ? r : { left: Math.floor(r.left * k), top: Math.floor(r.top * k), right: Math.floor(r.right * k), bottom: Math.floor(r.bottom * k) });

export function probeMedia(file, { seconds = 8, keyColor = null, spawn = spawnSync } = {}) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 };
  const p = spawn(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], opts);
  if (p.error || p.status !== 0) return null;
  let s;
  try { s = JSON.parse(p.stdout).streams?.[0]; } catch { return null; }
  const width = s?.width, height = s?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const plain = { width, height, crop: { ...NONE }, ...(keyChannel(keyColor) !== null ? { content: { ...NONE } } : {}) };
  if (IMAGE_EXT.has(path.extname(file).toLowerCase()) && keyChannel(keyColor) === null) return plain;
  const k = Math.max(1, Math.ceil(width / CHECK_WIDTH));
  const w = Math.floor(width / k), h = Math.floor(height / k);
  const frameBytes = w * h * 3;
  const vf = `${k > 1 ? `scale=${w}:${h},` : ''}fps=${FPS},format=rgb24`;
  const c = spawn(FFMPEG(), ['-hide_banner', '-nostdin', '-v', 'error', '-t', String(seconds), '-i', file, '-vf', vf, '-an', '-f', 'rawvideo', '-'],
    { ...opts, encoding: 'buffer', maxBuffer: frameBytes * (seconds * FPS + 4) });
  if (c.error || c.status !== 0 || !c.stdout || c.stdout.length < frameBytes) return plain;
  const frames = [];
  for (let o = 0; o + frameBytes <= c.stdout.length; o += frameBytes) frames.push(c.stdout.subarray(o, o + frameBytes));
  const m = measureFrames(frames, w, h, keyColor);
  return { width, height, crop: scaleRect(m.crop, k), ...(m.content ? { content: scaleRect(m.content, k) } : {}) };
}

/** bases: { [base]: absolute folder } (alphaBases). Paths that leave their base are refused. */
export function createMediaInfo({ bases = {}, probe = probeMedia } = {}) {
  const cache = new Map();
  return (ref, { keyColor = null } = {}) => {
    const root = ref && bases[ref.base];
    if (!root || typeof ref.rel !== 'string') return null;
    const file = path.resolve(root, ref.rel);
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    let st;
    try { st = statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const key = `${file}|${st.size}|${st.mtimeMs}|${keyColor ?? ''}`;
    if (!cache.has(key)) cache.set(key, probe(file, { keyColor }));
    return cache.get(key);
  };
}
