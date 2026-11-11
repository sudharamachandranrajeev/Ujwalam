// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB1 (D339): load a reference image or video file into rgb24 frames for analysis. Local files only.
// Node stdlib plus ffprobe/ffmpeg (FFPROBE / FFMPEG or PATH); every child is hidden (windowsHide, D191) and limited to
// the file protocol, so a crafted name cannot make ffmpeg read from the network. Nothing is ever written.
//
//   loadReference(file, { frames = 8, longSide = 960 }) ->
//     { name, kind: 'image' | 'video', width, height, rotation, durationS, frames: [{ t, width, height, rgb }] }
//
// name = the file's base name only (no folders). width/height = the display size: the stored size turned by the
// display rotation (side data or rotate tag); ffmpeg's autorotation (set on explicitly) turns the decoded frames the
// same way. Each frame is scaled (area filter) so its long side is longSide px, aspect kept; rgb is a Buffer of
// width*height*3 bytes. A video is sampled at N evenly spaced times t_i = (i + 0.5) * duration / N (one seek per
// frame), so the samples cover the whole clip and no sample is the first black frame of a fade-in (a time past the
// last frame's start is moved back to it). An image gives one frame with t = 0. Frames x analysis pixels must stay
// inside MAX_TOTAL_PIXELS (refused otherwise).
//
// Hardening (Codex review of D339): the demuxer is fixed per extension (-f), never guessed from the content, and
// only self-contained single-file formats are allowed, so a playlist (HLS, DASH), a concat list or an image-sequence
// pattern renamed to an allowed extension fails to open instead of reading other files. The image pipe demuxers read
// exactly one file (no %d pattern expansion). ffmpeg decodes stream 0:v:0, the stream ffprobe measured.

import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
export const DEMUXER = Object.freeze({
  '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe', '.webp': 'webp_pipe', '.bmp': 'bmp_pipe', '.gif': 'gif',
  '.mp4': 'mov', '.mov': 'mov', '.m4v': 'mov', '.mkv': 'matroska', '.webm': 'matroska',
});
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
export const MAX_FRAMES = 64;
// Memory budget: frames x analysis pixels. 40 M px = about 120 MB of rgb24 (64 samples at 960x540 = 33 M px fit;
// 64 at 4096x2304 = 604 M px is refused). analyse.mjs keeps full measurements for the key frame only.
export const MAX_TOTAL_PIXELS = 40_000_000;
const TIMEOUT_MS = 60000;

export class ReferenceError extends Error {}

function run(cmd, args, encoding) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new ReferenceError(`${path.basename(cmd)} failed: ${String(err.message).split('\n')[0].slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

const isShare = (p) => /^[\\/]{2}/.test(p) && !/^\\\\\?\\[a-z]:/i.test(p);

/** A local, existing, regular file with a known image or video extension; otherwise a plain-words error. */
export function checkLocalFile(file) {
  if (typeof file !== 'string' || !file) throw new ReferenceError('reference: a file path is needed');
  // Local only: no URL of any scheme (a Windows drive letter is one letter and is allowed), no UNC or network share.
  if (/^[a-z][a-z0-9+.-]+:/i.test(file)) throw new ReferenceError('reference: local files only, not a URL');
  if (/^[\\/]{2}/.test(file)) throw new ReferenceError('reference: local files only, not a network share');
  const abs = path.resolve(file);
  if (/^[\\/]{2}/.test(abs)) throw new ReferenceError('reference: local files only, not a network share');
  let st;
  try { st = statSync(abs); } catch { throw new ReferenceError(`reference: no such file ${path.basename(abs)}`); }
  if (!st.isFile()) throw new ReferenceError(`reference: not a file ${path.basename(abs)}`);
  // a link, junction or mapped drive that leads to a share is a share too
  let real = abs;
  try { real = realpathSync.native(abs); } catch { /* statSync already proved it exists */ }
  if (isShare(real)) throw new ReferenceError('reference: local files only, not a network share');
  const ext = path.extname(abs).toLowerCase();
  const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
  if (!kind) throw new ReferenceError(`reference: unsupported file type ${ext || '(none)'}; images ${[...IMAGE_EXT].join(' ')}, videos ${[...VIDEO_EXT].join(' ')}`);
  return { abs, kind, demuxer: DEMUXER[ext] };
}

/** Analysis size: long side = longSide (never upscaled past the source), even numbers, aspect kept. */
export function analysisSize(width, height, longSide) {
  const k = Math.min(1, longSide / Math.max(width, height));
  const even = (v) => Math.max(2, 2 * Math.round((v * k) / 2));
  return { width: even(width), height: even(height) };
}

/** Plain-words problem when frames x the analysis size exceed the memory budget, else null. */
export function budgetProblem(size, frames, maxPixels = MAX_TOTAL_PIXELS) {
  const total = size.width * size.height * frames;
  if (total <= maxPixels) return null;
  return `reference: ${frames} frames of ${size.width}x${size.height} exceed the memory budget of ${(maxPixels / 1e6).toFixed(1)} M pixels; use fewer frames or a smaller long side`;
}

/** Display rotation in degrees (0, 90, 180 or 270) from the stream's display matrix side data or its rotate tag. */
export function displayRotation(stream) {
  const side = (stream?.side_data_list ?? []).find((d) => d && d.rotation !== undefined);
  const raw = side ? Number(side.rotation) : Number(stream?.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
}

// Input options for both tools: local files only, the fixed demuxer.
const INPUT = (abs, demuxer) => ['-protocol_whitelist', 'file', '-f', demuxer, '-i', abs];

async function probe(abs, demuxer) {
  const out = await run(FFPROBE(), ['-v', 'error', '-protocol_whitelist', 'file', '-f', demuxer, '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration',
    '-of', 'json', abs], 'utf8');
  let j;
  try { j = JSON.parse(out); } catch { throw new ReferenceError('reference: ffprobe gave no readable answer'); }
  const s = j.streams?.[0];
  if (!Number.isInteger(s?.width) || !Number.isInteger(s?.height) || s.width < 1 || s.height < 1) throw new ReferenceError('reference: no picture in this file');
  const d = Number(j.format?.duration);
  const [num, den] = String(s.avg_frame_rate ?? '').split('/').map(Number);
  const fps = num > 0 && den > 0 ? num / den : null;
  // display size: a quarter turn swaps the stored size (autorotation turns the decoded frames to match)
  const rotation = displayRotation(s);
  const quarter = rotation === 90 || rotation === 270;
  return { width: quarter ? s.height : s.width, height: quarter ? s.width : s.height, rotation, durationS: Number.isFinite(d) && d > 0 ? d : null, fps };
}

async function grab(abs, demuxer, size, seekS) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-autorotate']; // a bare flag: on
  if (seekS !== null) args.push('-ss', seekS.toFixed(3));
  args.push(...INPUT(abs, demuxer), '-map', '0:v:0', '-frames:v', '1', '-an',
    '-vf', `scale=${size.width}:${size.height}:flags=area,format=rgb24`, '-f', 'rawvideo', '-');
  const buf = await run(FFMPEG(), args, 'buffer');
  const bytes = size.width * size.height * 3;
  if (!buf || buf.length < bytes) return null;
  return buf.subarray(0, bytes);
}

/** SB1: an image or a video file -> frames (see the header). opts.frames: N for a video (1..64, default 8). */
export async function loadReference(file, { frames = 8, longSide = 960, maxPixels = MAX_TOTAL_PIXELS } = {}) {
  const { abs, kind, demuxer } = checkLocalFile(file);
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) throw new ReferenceError(`reference: frames must be 1..${MAX_FRAMES}`);
  if (!Number.isInteger(longSide) || longSide < 64 || longSide > 4096) throw new ReferenceError('reference: longSide must be 64..4096');
  const info = await probe(abs, demuxer);
  const size = analysisSize(info.width, info.height, longSide);
  const over = budgetProblem(size, kind === 'image' ? 1 : frames, maxPixels);
  if (over) throw new ReferenceError(over);
  const out = [];
  if (kind === 'image') {
    const rgb = await grab(abs, demuxer, size, null);
    if (!rgb) throw new ReferenceError('reference: the image could not be decoded');
    out.push({ t: 0, ...size, rgb });
  } else {
    if (!info.durationS) throw new ReferenceError('reference: the video has no duration');
    // the last frame starts one frame before the end; a seek past it decodes nothing
    const last = Math.max(0, info.durationS - (info.fps ? 1 / info.fps : 0.04));
    for (let i = 0; i < frames; i++) {
      const t = Math.min(last, ((i + 0.5) * info.durationS) / frames);
      const rgb = await grab(abs, demuxer, size, t);
      if (rgb) out.push({ t: +t.toFixed(3), ...size, rgb });
    }
    if (!out.length) throw new ReferenceError('reference: no frame of the video could be decoded');
  }
  return { name: path.basename(abs), kind, width: info.width, height: info.height, rotation: info.rotation, durationS: kind === 'video' ? +info.durationS.toFixed(3) : null, frames: out };
}
