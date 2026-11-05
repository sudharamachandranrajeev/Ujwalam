#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// fx test (v1 F4): measure the real flash rate of an effect from rendered-frame luminance and fail above the limit
// (at most 3 flashes per second per canvas, AGENTS.md flash safety). Definition: services/overlay-server/flash-detect.mjs.
//
//   node tools/fx-test.mjs --effect gg --host [--canvas h|v] [--query k=v&..] [--write]   render on the host (libobs +
//                                                 obs-browser), fire once, record, analyse the recording. --query replaces
//                                                 the page query from data/effects/fx-test.json (e.g. color=red for storm)
//   node tools/fx-test.mjs --effect gg --video rec.mkv [--start s] [--duration s] [--fps n] [--canvas h|v] [--write]
//   node tools/fx-test.mjs --effect gg --frames <dir> --fps 30 [--canvas h|v] [--write]   (png/jpg/bmp, sorted by name)
//   npm run fx:test -- --effect gg --host
//
// --write stores the result in data/effects/flash-measurements.json (or --measurements <file>) with date, frames and
// fps as evidence; the effect guards load that file at start and refuse an effect measured above the limit.
// --json prints the result as JSON. Exit: 0 pass, 1 above the limit, 2 usage or run error, 3 host render drew nothing.
// Frames are decoded with ffmpeg (FFMPEG / FFPROBE env, else PATH); every child runs with windowsHide. Host mode runs
// the host without a preview (no windows) and with UJWALAM_HEADLESS=1. Nothing about the input but its file name is kept.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createFlashAnalyser, DEFINITION } from '../services/overlay-server/flash-detect.mjs';
import { loadGuardConfig, saveFlashMeasurement } from '../services/overlay-server/guards.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GUARDS_FILE = path.join(REPO, 'data', 'effects', 'guards.json');
export const SETTINGS_FILE = path.join(REPO, 'data', 'effects', 'fx-test.json');
export const MEASUREMENTS_FILE = path.join(REPO, 'data', 'effects', 'flash-measurements.json');
const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const IMAGE = /\.(png|jpe?g|bmp)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const loadSettings = (file = SETTINGS_FILE) => JSON.parse(readFileSync(file, 'utf8'));

/** Frame rate of the first video stream (ffprobe), or null. */
export function probeFps(file) {
  const r = spawnSync(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  try {
    const s = JSON.parse(r.stdout).streams?.[0] ?? {};
    for (const k of ['avg_frame_rate', 'r_frame_rate']) {
      const [a, b] = String(s[k] ?? '').split('/').map(Number);
      const f = b ? a / b : a;
      if (f > 0 && f <= 1000) return f;
    }
  } catch { /* fall through */ }
  return null;
}

const scaleFilter = ({ width, height }) => `scale=${width}:${height}:flags=area,format=rgb24`;

/** Decode a video to rgb24 frames of `sample` size and run them through the analyser. Also measures how much was drawn
 *  (share of pixels that differ from the first frame by more than 24 levels, peak over frames). */
export function analyseVideo(file, { sample, fps, start, duration, drawnLevel = 24 } = {}) {
  if (!existsSync(file)) return Promise.reject(new Error(`no such video: ${path.basename(file)}`));
  const rate = fps ?? probeFps(file);
  if (!rate) return Promise.reject(new Error('frame rate unknown: pass --fps'));
  const an = createFlashAnalyser({ width: sample.width, height: sample.height, fps: rate });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start) args.push('-ss', String(start));
  args.push('-i', file);
  if (duration) args.push('-t', String(duration));
  args.push('-an', '-sn', '-vf', scaleFilter(sample), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let pending = Buffer.alloc(0);
    let first = null;
    let drawnPeak = 0;
    const err = [];
    const onFrame = (f) => {
      if (!first) first = Buffer.from(f);
      else drawnPeak = Math.max(drawnPeak, changedShare(first, f, drawnLevel));
      an.push(f);
    };
    child.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      let off = 0;
      while (pending.length - off >= an.frameBytes) { onFrame(pending.subarray(off, off + an.frameBytes)); off += an.frameBytes; }
      pending = pending.subarray(off);
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => reject(new Error(`ffmpeg not runnable: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim().split('\n').pop()}`));
      if (!an.frames) return reject(new Error('no frames decoded'));
      resolve({ ...an.result(), drawnPeak });
    });
  });
}

/** Image frames in a folder (sorted by name), each scaled to `sample`, at `fps`. */
export function analyseFrames(dir, { sample, fps, drawnLevel = 24 }) {
  if (!(fps > 0)) throw new RangeError('--frames needs --fps');
  const files = readdirSync(dir).filter((f) => IMAGE.test(f)).sort();
  if (!files.length) throw new Error('no png/jpg/bmp frames in the folder');
  const an = createFlashAnalyser({ width: sample.width, height: sample.height, fps });
  let first = null;
  let drawnPeak = 0;
  for (const f of files) {
    const r = spawnSync(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path.join(dir, f), '-frames:v', '1', '-vf', scaleFilter(sample), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { maxBuffer: 16 << 20, windowsHide: true });
    if (r.error) throw new Error(`ffmpeg not runnable: ${r.error.message}`);
    if (r.status !== 0 || r.stdout.length < an.frameBytes) throw new Error(`could not decode frame ${f}`);
    const fr = r.stdout.subarray(0, an.frameBytes);
    if (!first) first = Buffer.from(fr); else drawnPeak = Math.max(drawnPeak, changedShare(first, fr, drawnLevel));
    an.push(fr);
  }
  return { ...an.result(), drawnPeak };
}

function changedShare(a, b, level) {
  let c = 0;
  const n = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) > level || Math.abs(a[i + 1] - b[i + 1]) > level || Math.abs(a[i + 2] - b[i + 2]) > level) c++;
  }
  return c / n;
}

/** The fx-test project: a background colour and one browser layer with the effect's page, on one canvas. */
export function fxProject({ effect, canvas, page, settings, guards }) {
  const cv = settings.render.canvases[canvas];
  const src = guards.canvases[canvas];
  const place = { visible: true, x: 0, y: 0, width: cv.width, height: cv.height };
  // The host always needs canvas h (the libobs main canvas); a v test adds v and draws the effect there only.
  const ids = canvas === 'h' ? ['h'] : ['h', 'v'];
  const all = settings.render.canvases;
  const bgPlace = Object.fromEntries(ids.map((id) => [id, { visible: true, x: 0, y: 0, width: all[id].width, height: all[id].height }]));
  return {
    version: 1, id: 'fx-test', name: 'fx test', activeScene: 'main',
    canvases: ids.map((id) => ({ id, width: all[id].width, height: all[id].height, fps: settings.render.fps })),
    devices: [], outputs: [],
    overlays: [{ id: 'ov-fx', name: `fx ${effect}`, file: { base: 'overlays', rel: page.rel } }],
    scenes: [{
      id: 'main', name: 'Main', layers: [
        { id: 'bg', type: 'color', name: 'Bg', source: { color: settings.render.background }, placements: bgPlace },
        { id: 'fx', type: 'browser', name: 'FX', source: { overlay: 'ov-fx', width: src.width, height: src.height, ...(page.query ? { query: page.query } : {}) }, placements: { [canvas]: place } },
      ],
    }],
    audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
  };
}

/** Render on the host: load the project, record, fire the effect once, stop. Returns { file, fired, durationMs }. */
export async function renderOnHost({ effect, canvas, settings, guards, log = () => {} }) {
  const page = settings.pages[effect];
  if (!page) throw new Error(`no page for ${effect} in data/effects/fx-test.json`);
  const { launchHost, stopHost } = await import('../app/host/lib/launch.mjs');
  const { loadIntoHost } = await import('../app/host/lib/project.mjs');
  const { HOST_DIR } = await import('../app/host/lib/config.mjs');
  const out = path.join(REPO, 'out', 'fx-test');
  mkdirSync(out, { recursive: true });
  const r = settings.render;
  const def = guards.effects[effect];
  const h = await launchHost({ dataDir: mkdtempSync(path.join(out, `${effect}-${canvas}-`)), overlay: true, env: { UJWALAM_HEADLESS: '1' },
    project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
  const c = h.client;
  const waitFor = async (fn, ms, what) => {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); }
  };
  try {
    const built = await loadIntoHost(c, fxProject({ effect, canvas, page, settings, guards }));
    if (!built?.built?.overlayLayers) throw new Error('the host did not build the overlay layer');
    log(`# host: project loaded, waiting ${r.settleMs} ms for the page`);
    await sleep(r.settleMs);
    const rung = { id: 'r', canvas: canvas.toUpperCase(), codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: r.rung[canvas].w, h: r.rung[canvas].h, fps: r.fps, bitrate: 2500, gopSec: 1 };
    await c.call('outputs.configure', { rungs: [rung], audio: { bitrate: 128, sampleRate: 48000 }, sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: `fx-${effect}-${canvas}.mkv` } }] });
    await c.call('record.start', {});
    await waitFor(async () => (await c.call('outputs.status')).sinks[0].state === 'live', 5000, 'recording live');
    const t0 = Date.now();
    await sleep(r.leadMs + 1000);
    const fired = (Date.now() - t0) / 1000;
    const res = await c.call('effect.fire', { name: effect });
    if (!res?.ok) throw new Error(`effect.fire refused: ${String(res?.reason ?? 'unknown').slice(0, 40)}`);
    await sleep(def.durationMs + r.tailMs);
    await c.call('record.stop', {});
    const st = await waitFor(async () => { const s = await c.call('outputs.status'); return s.sinks[0].state === 'stopped' && s; }, 8000, 'recording stopped');
    return { file: st.sinks[0].path, fired, durationMs: def.durationMs };
  } finally {
    const s = await stopHost(h);
    log(`# host: stopped (exit ${s.code ?? 'killed'})`);
  }
}

/** Run one fx test. opts: { effect, canvas, host?, video?, frames?, fps?, start?, duration?, settings?, guardsFile? }. */
export async function runFxTest(opts) {
  const guards = loadGuardConfig(opts.guardsFile ?? GUARDS_FILE);
  const settings = opts.settings ?? loadSettings();
  const canvas = opts.canvas ?? 'h';
  if (!guards.effects[opts.effect]) throw new RangeError(`unknown effect ${String(opts.effect).slice(0, 32)} (data/effects/guards.json)`);
  if (!['h', 'v'].includes(canvas)) throw new RangeError('canvas must be h or v');
  const sample = settings.sample[canvas];
  const log = opts.log ?? (() => {});
  let res, method, input;
  if (opts.host) {
    if (opts.query !== undefined) {
      if (!/^[A-Za-z0-9_.=&,-]{0,200}$/.test(opts.query)) throw new RangeError('--query: letters, digits and _ . = & , - only');
      settings.pages[opts.effect] = { ...settings.pages[opts.effect], query: opts.query };
    }
    const rec = await renderOnHost({ effect: opts.effect, canvas, settings, guards, log });
    const lead = settings.render.leadMs / 1000;
    res = await analyseVideo(rec.file, { sample, start: Math.max(0.2, rec.fired - lead), duration: lead + (rec.durationMs + settings.render.tailMs) / 1000 });
    method = 'host'; input = path.basename(rec.file);
    const q = settings.pages[opts.effect].query;
    if (q) input += `?${q}`;
    if (res.drawnPeak < settings.sample.drawnThreshold) return { effect: opts.effect, canvas, method, input, ...res, noRender: true };
  } else if (opts.video) {
    res = await analyseVideo(opts.video, { sample, fps: opts.fps, start: opts.start, duration: opts.duration });
    method = 'video'; input = path.basename(opts.video);
  } else if (opts.frames) {
    res = analyseFrames(opts.frames, { sample, fps: opts.fps });
    method = 'frames'; input = path.basename(path.resolve(opts.frames));
  } else throw new RangeError('one of --host, --video or --frames is required');
  return { effect: opts.effect, canvas, method, input, ...res, noRender: false };
}

/** The record persisted per effect and canvas (numbers and the input's base name only). */
export function measurementRecord(r, date = new Date().toISOString().slice(0, 10)) {
  return {
    flashesPerSecond: r.peakFlashesPerSecond,
    pass: r.pass,
    limit: r.limit,
    maxTransitionsInWindow: r.maxTransitionsInWindow,
    worstWindowStartSec: r.worstWindowStartSec === null ? null : Math.round(r.worstWindowStartSec * 1000) / 1000,
    worstRegion: r.worstRegion,
    worstKind: r.worstKind,
    generalPeak: r.generalPeak,
    redPeak: r.redPeak,
    frames: r.frames,
    fps: Math.round(r.fps * 1000) / 1000,
    durationSec: Math.round(r.durationSec * 1000) / 1000,
    regions: r.regions,
    drawnPeak: Math.round(r.drawnPeak * 10000) / 10000,
    method: r.method,
    input: r.input,
    date,
    definition: r.definition,
    tool: 'tools/fx-test.mjs',
    status: 'measured',
  };
}

async function main(argv) {
  let a;
  try {
    ({ values: a } = parseArgs({ args: argv, options: {
      effect: { type: 'string' }, canvas: { type: 'string', default: 'h' }, host: { type: 'boolean' }, video: { type: 'string' }, frames: { type: 'string' },
      query: { type: 'string' }, fps: { type: 'string' }, start: { type: 'string' }, duration: { type: 'string' }, write: { type: 'boolean' }, measurements: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
  } catch (e) { console.error(`fx test: ${e.message}`); return 2; }
  if (a.help || !a.effect) { console.error('usage: node tools/fx-test.mjs --effect <name> (--host [--query k=v] | --video <file> | --frames <dir> --fps <n>) [--canvas h|v] [--start s] [--duration s] [--write] [--measurements <file>] [--json]'); return a.help ? 0 : 2; }
  const n = (v) => (v === undefined ? undefined : Number(v));
  let r;
  try {
    r = await runFxTest({ effect: a.effect, canvas: a.canvas, host: a.host, query: a.query, video: a.video, frames: a.frames, fps: n(a.fps), start: n(a.start), duration: n(a.duration), log: (s) => console.error(s) });
  } catch (e) { console.error(`fx test: ${e.message}`); return 2; }
  if (a.json) console.log(JSON.stringify(r, null, 2));
  if (r.noRender) {
    console.log(`fx test ${r.effect} ${r.canvas}: NO RENDER (peak drawn ${(r.drawnPeak * 100).toFixed(2)} % of pixels); nothing written`);
    return 3;
  }
  console.log(`fx test ${r.effect} ${r.canvas}: ${r.pass ? 'PASS' : 'FAIL'} peak ${r.peakFlashesPerSecond} flashes/s (limit ${r.limit}; ${r.maxTransitionsInWindow} transitions in the worst 1 s window, ${r.worstKind ?? 'none'}, region ${r.worstRegion}) over ${r.frames} frames at ${r.fps.toFixed(2)} fps (${DEFINITION.id})`);
  if (a.write) {
    const file = a.measurements ? path.resolve(a.measurements) : MEASUREMENTS_FILE;
    saveFlashMeasurement(file, { effect: r.effect, canvas: r.canvas, record: measurementRecord(r), definition: DEFINITION.id });
    console.log(`fx test: written to ${path.relative(REPO, file) || file}`);
  }
  return r.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
