// SPDX-License-Identifier: GPL-3.0-or-later
// fx test (v1 F4): measured flash rates persisted per effect and canvas, loaded by the effect guards (refuse above
// the limit), and the fx-test tool over synthetic videos and frame folders made with ffmpeg (lavfi, lossless).
// Headless: ffmpeg and node children only, windowsHide, files in a temp folder. ffmpeg missing: those tests skip.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createEffectGuards, createOverlayServer, DEFAULT_FLASH_MEASUREMENTS_FILE, DEFAULT_GUARDS_FILE, loadFlashMeasurements, loadGuardConfig,
  saveFlashMeasurement, validateFlashMeasurements,
} from '../services/overlay-server/index.mjs';
import { analyseFrames, analyseVideo, fxProject, loadSettings, measurementRecord, runFxTest } from '../tools/fx-test.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'tools', 'fx-test.mjs');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const haveFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-fx-'));
const rec = (fps, extra = {}) => ({ flashesPerSecond: fps, frames: 90, fps: 30, date: '2026-11-05', method: 'video', pass: fps <= 3, ...extra });
const file = (m) => ({ version: 1, measurements: m });

function rig(measurements) {
  let t = 1_000_000;
  const guards = createEffectGuards({ config: loadGuardConfig(DEFAULT_GUARDS_FILE), now: () => t, measurements, setTimer: () => ({}), clearTimer: () => {} });
  return { guards, adv: (ms) => { t += ms; } };
}

/** A lossless test video: grey flicker, `period` frames per cycle, at 30 fps for `sec` seconds. */
function flicker(dir, name, period, sec = 3, size = '192x108') {
  const out = path.join(dir, name);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
    `color=black:s=${size}:r=30:d=${sec},format=gray,geq=lum='if(lt(mod(N,${period}),${period / 2}),255,0)'`, '-c:v', 'ffv1', out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

describe('measured flashes: file, validation, guards', () => {
  test('the repo measurements file is valid', () => {
    const m = loadFlashMeasurements(DEFAULT_FLASH_MEASUREMENTS_FILE);
    assert.equal(m.version, 1);
  });

  test('validation lists every problem: canvas, rate, evidence (frames, fps, date), method', () => {
    assert.throws(() => validateFlashMeasurements(file({ storm: { x: rec(1) } })), /canvas must be h or v/);
    assert.throws(() => validateFlashMeasurements(file({ storm: { h: rec(-1) } })), /flashesPerSecond/);
    assert.throws(() => validateFlashMeasurements(file({ storm: { h: rec(1, { frames: 0 }) } })), /frames/);
    assert.throws(() => validateFlashMeasurements(file({ storm: { h: rec(1, { date: '5 Nov' }) } })), /date/);
    assert.throws(() => validateFlashMeasurements(file({ storm: { h: rec(1, { method: 'guess' }) } })), /method/);
    assert.throws(() => validateFlashMeasurements({ version: 2, measurements: {} }), /version/);
  });

  test('an absent file is an empty set', () => {
    assert.deepEqual(loadFlashMeasurements(path.join(tmp(), 'none.json')).measurements, {});
  });

  test('a persisted measurement above the limit refuses the effect on that canvas only', () => {
    const r = rig(file({ storm: { h: rec(5) } }));
    assert.deepEqual(r.guards.measuredFlashes(), { 'storm:h': 5 });
    assert.equal(r.guards.gate({ name: 'storm', canvas: 'h' }).reason, 'flash-limit');
    assert.equal(r.guards.gate({ name: 'storm' }).reason, 'flash-limit', 'both canvases: refused when either is over');
    assert.equal(r.guards.gate({ name: 'storm', canvas: 'v' }).allow, true);
    assert.equal(r.guards.stats().byReason['flash-limit'], 2);
  });

  test('a measurement at or under the limit changes nothing; an unknown effect in the file is skipped', () => {
    const r = rig(file({ storm: { h: rec(3), v: rec(1.5) }, ghost: { h: rec(9) } }));
    assert.equal(r.guards.gate({ name: 'storm' }).allow, true);
    assert.equal(r.guards.measuredFlashes()['ghost:h'], undefined);
  });

  test('a broken measurements object stops the guards from starting (fail closed)', () => {
    assert.throws(() => rig(file({ storm: { h: rec(1, { frames: 'many' }) } })), RangeError);
  });

  test('save then load round-trips and keeps other effects', () => {
    const f = path.join(tmp(), 'm.json');
    saveFlashMeasurement(f, { effect: 'gg', canvas: 'h', record: rec(1), definition: 'wcag2-2.3.1-general+red' });
    saveFlashMeasurement(f, { effect: 'storm', canvas: 'v', record: rec(4) });
    const m = loadFlashMeasurements(f);
    assert.equal(m.measurements.gg.h.flashesPerSecond, 1);
    assert.equal(m.measurements.storm.v.flashesPerSecond, 4);
    assert.equal(m.definition, 'wcag2-2.3.1-general+red');
    assert.throws(() => saveFlashMeasurement(f, { effect: 'gg', canvas: 'x', record: rec(1) }), RangeError);
    assert.equal(loadFlashMeasurements(f).measurements.gg.x, undefined, 'a refused write leaves the file as it was');
  });

  test('the overlay server applies a measurements file to its guards', () => {
    const f = path.join(tmp(), 'm.json');
    writeFileSync(f, JSON.stringify(file({ charge: { v: rec(6) } })));
    const s = createOverlayServer({ root: tmp(), guards: DEFAULT_GUARDS_FILE, flashMeasurements: f });
    assert.deepEqual(s.guards.measuredFlashes(), { 'charge:v': 6 });
    assert.equal(s.bridge.publishEffect('charge', { canvas: 'v' }).reason, 'flash-limit');
    const none = createOverlayServer({ root: tmp(), guards: DEFAULT_GUARDS_FILE });
    assert.deepEqual(none.guards.measuredFlashes(), {}, 'a config file without flashMeasurements loads none');
  });
});

describe('fx test tool', () => {
  test('host project: one canvas, background colour, the effect page as a browser layer', () => {
    const p = fxProject({ effect: 'gg', canvas: 'v', page: { rel: 'gg-burst/index.html', query: 'a=1' }, settings: loadSettings(), guards: loadGuardConfig(DEFAULT_GUARDS_FILE) });
    assert.deepEqual(p.canvases.map((c) => c.id), ['h', 'v'], 'the host needs canvas h');
    assert.equal(p.overlays[0].file.rel, 'gg-burst/index.html');
    const fx = p.scenes[0].layers[1];
    assert.equal(fx.type, 'browser');
    assert.deepEqual([fx.source.width, fx.source.height, fx.source.query], [1080, 1920, 'a=1']);
    assert.ok(fx.placements.v.visible);
    assert.equal(fx.placements.h, undefined, 'the effect is drawn on the canvas under test only');
    assert.deepEqual(fxProject({ effect: 'gg', canvas: 'h', page: { rel: 'gg-burst/index.html' }, settings: loadSettings(), guards: loadGuardConfig(DEFAULT_GUARDS_FILE) }).canvases.map((c) => c.id), ['h']);
  });

  test('every guards effect has a page in fx-test.json; sample sizes divide by 6', () => {
    const s = loadSettings();
    for (const e of Object.keys(loadGuardConfig(DEFAULT_GUARDS_FILE).effects)) assert.ok(s.pages[e]?.rel, e);
    for (const c of ['h', 'v']) assert.ok(s.sample[c].width % 6 === 0 && s.sample[c].height % 6 === 0, c);
  });

  test('unknown effect and missing input are refused', async () => {
    await assert.rejects(runFxTest({ effect: 'nope', video: 'x.mkv' }), /unknown effect/);
    await assert.rejects(runFxTest({ effect: 'gg' }), /--host, --video or --frames/);
  });

  test('video: 5 Hz flicker fails (5/s), 1.5 Hz passes (1.5/s), frame rate from ffprobe', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
    const d = tmp();
    const fast = await analyseVideo(flicker(d, 'fast.mkv', 6), { sample: { width: 192, height: 108 } });
    assert.equal(fast.fps, 30);
    assert.equal(fast.frames, 90);
    assert.equal(fast.peakFlashesPerSecond, 5);
    assert.equal(fast.pass, false);
    const slow = await analyseVideo(flicker(d, 'slow.mkv', 20), { sample: { width: 192, height: 108 } });
    assert.equal(slow.peakFlashesPerSecond, 1.5);
    assert.equal(slow.pass, true);
    const part = await analyseVideo(flicker(d, 'part.mkv', 6), { sample: { width: 192, height: 108 }, start: 1, duration: 1 });
    assert.ok(part.frames >= 29 && part.frames <= 31, `--start/--duration cut: ${part.frames} frames`);
  });

  test('frames folder: png frames at --fps', { skip: !haveFfmpeg && 'no ffmpeg' }, () => {
    const d = tmp();
    const fr = path.join(d, 'frames');
    mkdirSync(fr);
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', flicker(d, 'src.mkv', 6, 1), path.join(fr, 'f%03d.png')], { windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr));
    const res = analyseFrames(fr, { sample: { width: 192, height: 108 }, fps: 30 });
    assert.equal(res.frames, 30);
    assert.equal(res.pass, false);
    assert.throws(() => analyseFrames(fr, { sample: { width: 192, height: 108 } }), /--fps/);
  });

  test('CLI: exit 1 above the limit, --write persists date, frames, fps and only the input base name; the guards then refuse', { skip: !haveFfmpeg && 'no ffmpeg' }, () => {
    const d = tmp();
    const m = path.join(d, 'measured.json');
    const video = flicker(d, 'storm-capture.mkv', 6);
    const r = spawnSync(process.execPath, [TOOL, '--effect', 'storm', '--canvas', 'h', '--video', video, '--write', '--measurements', m], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UJWALAM_HEADLESS: '1' } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL peak 5 flashes\/s/);
    const saved = JSON.parse(readFileSync(m, 'utf8'));
    const s = saved.measurements.storm.h;
    assert.equal(s.flashesPerSecond, 5);
    assert.equal(s.frames, 90);
    assert.equal(s.fps, 30);
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(s.method, 'video');
    assert.equal(s.input, 'storm-capture.mkv');
    assert.ok(!JSON.stringify(saved).includes(d), 'no folder path is stored');
    const g = rig(loadFlashMeasurements(m));
    assert.equal(g.guards.gate({ name: 'storm', canvas: 'h' }).reason, 'flash-limit');
    const ok = spawnSync(process.execPath, [TOOL, '--effect', 'gg', '--video', flicker(d, 'gg.mkv', 20), '--json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout.slice(0, ok.stdout.lastIndexOf('}') + 1)).pass, true);
    assert.equal(spawnSync(process.execPath, [TOOL], { windowsHide: true }).status, 2, 'usage');
  });

  test('measurementRecord keeps numbers and the base name only', () => {
    const r = measurementRecord({ peakFlashesPerSecond: 2, pass: true, limit: 3, maxTransitionsInWindow: 4, worstWindowStartSec: 1.23456, worstRegion: 'full', worstKind: 'general',
      generalPeak: 2, redPeak: 0, frames: 60, fps: 30, durationSec: 2, regions: 26, drawnPeak: 0.5, method: 'host', input: 'fx-gg-h.mkv', definition: 'd' }, '2026-11-05');
    assert.equal(r.worstWindowStartSec, 1.235);
    assert.equal(r.date, '2026-11-05');
    assert.doesNotThrow(() => validateFlashMeasurements(file({ gg: { h: r } })));
  });
});
