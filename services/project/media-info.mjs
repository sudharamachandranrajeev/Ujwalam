// SPDX-License-Identifier: GPL-3.0-or-later
// Size and black bars of an image or video file (D251), for scene presets that fit an asset into its box at its true
// shape (`fit: "contain"`, `cropBars`). Node stdlib only; ffprobe/ffmpeg from FFPROBE / FFMPEG or PATH, every child
// hidden (windowsHide, D191). Nothing is ever written.
//
//   probeMedia(file) -> { width, height, crop: { left, top, right, bottom } } | null
//   createMediaInfo({ bases }) -> (pathRef { base, rel }) -> same | null      (cached per file, size and mtime)
//
// crop = the black bars of a video (source px; all 0 for a still or no bars): rows/columns at the edges that stay
// dark (at most BAR_SHARE of their pixels brighter than BAR_LUMA) over the sampled frames (1 per second, first
// `seconds`). Measured here from gray frames, not with ffmpeg's cropdetect: that filter is GPL-only and the LGPL
// ffmpeg build in use has none.
// null when the file cannot be read or ffprobe is missing: the caller then keeps its box as it is.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const NO_BARS = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

export const BAR_LUMA = 24;
export const BAR_SHARE = 0.05;
const MAX_FRAME_BYTES = 3840 * 2160;

/** Bars around a width x height gray picture: frames = Buffers of width*height luma bytes. A row or column belongs to
 *  a bar when at most BAR_SHARE of its sampled pixels are brighter than BAR_LUMA, counted inward from each edge: a
 *  small logo or watermark inside a bar (seen on the user's wordmark video) does not end the bar. NO_BARS when the
 *  kept picture would be smaller than a quarter of either side (an all-dark sample says nothing). */
export function barsFromGray(frames, width, height) {
  const rowLit = new Uint32Array(height), colLit = new Uint32Array(width);
  for (const f of frames) {
    for (let y = 0; y < height; y++) {
      const o = y * width;
      for (let x = 0; x < width; x++) if (f[o + x] > BAR_LUMA) { rowLit[y]++; colLit[x]++; }
    }
  }
  const n = Math.max(1, frames.length);
  const run = (a, from, step, len) => { let k = 0; for (let i = from; i >= 0 && i < a.length && a[i] <= BAR_SHARE * len * n; i += step) k++; return k; };
  const b = { left: run(colLit, 0, 1, height), top: run(rowLit, 0, 1, width), right: run(colLit, width - 1, -1, height), bottom: run(rowLit, height - 1, -1, width) };
  if (width - b.left - b.right < width / 4 || height - b.top - b.bottom < height / 4) return { ...NO_BARS };
  return b;
}

export function probeMedia(file, { seconds = 8, spawn = spawnSync } = {}) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 };
  const p = spawn(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], opts);
  if (p.error || p.status !== 0) return null;
  let s;
  try { s = JSON.parse(p.stdout).streams?.[0]; } catch { return null; }
  const width = s?.width, height = s?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (IMAGE_EXT.has(path.extname(file).toLowerCase())) return { width, height, crop: { ...NO_BARS } };
  if (width * height > MAX_FRAME_BYTES) return { width, height, crop: { ...NO_BARS } };
  const frameBytes = width * height;
  const c = spawn(FFMPEG(), ['-hide_banner', '-nostdin', '-v', 'error', '-t', String(seconds), '-i', file, '-vf', 'fps=1,format=gray', '-an', '-f', 'rawvideo', '-'],
    { ...opts, encoding: 'buffer', maxBuffer: frameBytes * (seconds + 2) });
  if (c.error || c.status !== 0 || !c.stdout || c.stdout.length < frameBytes) return { width, height, crop: { ...NO_BARS } };
  const frames = [];
  for (let o = 0; o + frameBytes <= c.stdout.length; o += frameBytes) frames.push(c.stdout.subarray(o, o + frameBytes));
  return { width, height, crop: barsFromGray(frames, width, height) };
}

/** bases: { [base]: absolute folder } (alphaBases). Paths that leave their base are refused. */
export function createMediaInfo({ bases = {}, probe = probeMedia } = {}) {
  const cache = new Map();
  return (ref) => {
    const root = ref && bases[ref.base];
    if (!root || typeof ref.rel !== 'string') return null;
    const file = path.resolve(root, ref.rel);
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    let st;
    try { st = statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    if (!cache.has(key)) cache.set(key, probe(file));
    return cache.get(key);
  };
}
