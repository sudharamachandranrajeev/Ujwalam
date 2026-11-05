// SPDX-License-Identifier: GPL-3.0-or-later
// Flash detector tests (v1 F4): WCAG 2.x general and red flash thresholds over synthetic luminance series and frames.
// Pure: no files, no processes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyseSeries, createFlashAnalyser, DEFINITION, generalTransitions, maxPerWindow, redState, redTransitions, regionWindows,
  relativeLuminance, summarise, zigzag,
} from '../services/overlay-server/flash-detect.mjs';

const FPS = 30;
/** Square wave between a and b, `period` frames per full cycle, n frames. */
const square = (a, b, period, n) => Array.from({ length: n }, (_, i) => (i % period < period / 2 ? a : b));
const peak = (lum) => summarise(generalTransitions(lum), FPS).peakFlashesPerSecond;

describe('relative luminance (WCAG 2.x)', () => {
  test('black 0, white 1, sRGB curve, Rec. 709 weights', () => {
    assert.equal(relativeLuminance(0, 0, 0), 0);
    assert.ok(Math.abs(relativeLuminance(255, 255, 255) - 1) < 1e-12);
    assert.ok(Math.abs(relativeLuminance(255, 0, 0) - 0.2126) < 1e-12);
    assert.ok(Math.abs(relativeLuminance(0, 255, 0) - 0.7152) < 1e-12);
    assert.ok(Math.abs(relativeLuminance(128, 128, 128) - 0.2158605) < 1e-6, 'mid grey is about 0.216, not 0.5');
  });

  test('red state: saturation R/(R+G+B) >= 0.8 and value max(0, R-G-B) x 320', () => {
    assert.deepEqual(redState(0.1, 0, 0), { value: 32, saturated: true });
    assert.equal(redState(0.5, 0.5, 0.5).saturated, false);
    assert.equal(redState(0.1, 0.5, 0).value, 0);
    assert.equal(redState(0, 0, 0).saturated, false);
  });
});

describe('zig-zag transitions', () => {
  test('noise below the threshold makes no legs; a step is one leg; a pulse is two', () => {
    assert.deepEqual(zigzag([0.5, 0.52, 0.48, 0.55, 0.5], 0.1), []);
    assert.equal(zigzag([0, 0, 0.5, 0.5], 0.1).length, 1);
    const p = zigzag([0, 0.6, 0.6, 0], 0.1);
    assert.equal(p.length, 2);
    assert.deepEqual(p.map((l) => l.toIdx), [1, 3]);
  });

  test('a slow ramp is one transition however long it takes', () => {
    const ramp = Array.from({ length: 90 }, (_, i) => i / 89);
    assert.equal(generalTransitions(ramp).length, 1);
  });
});

describe('general flash threshold (>= 0.1 change, darker state < 0.80, > 3 flashes in a 1 s window fails)', () => {
  test('a still frame has no flashes', () => {
    assert.equal(peak(new Array(90).fill(0.4)), 0);
  });

  test('3 Hz black/white flicker is exactly 3 flashes/s (passes); 4 Hz is 4 (fails)', () => {
    assert.equal(peak(square(0, 1, 10, 90)), 3);
    const s = summarise(generalTransitions(square(0, 1, 8, 90)), FPS);
    assert.ok(s.peakFlashesPerSecond >= 3.5, `4 Hz -> ${s.peakFlashesPerSecond}`);
    assert.equal(analyseSeries({ lum: [square(0, 1, 10, 90)], fps: FPS }).pass, true);
    assert.equal(analyseSeries({ lum: [square(0, 1, 8, 90)], fps: FPS }).pass, false);
  });

  test('7 transitions in one second fail, 6 pass (a flash is a pair of opposing transitions)', () => {
    const at = (idx) => { const s = new Array(60).fill(0); let v = 0; for (let i = 0, k = 0; i < 60; i++) { if (idx[k] === i) { v = v ? 0 : 1; k++; } s[i] = v; } return s; };
    const six = at([2, 6, 10, 14, 18, 22]);
    const seven = at([2, 6, 10, 14, 18, 22, 26]);
    assert.equal(summarise(generalTransitions(six), FPS).maxTransitionsInWindow, 6);
    assert.equal(analyseSeries({ lum: [six], fps: FPS }).pass, true);
    assert.equal(summarise(generalTransitions(seven), FPS).maxTransitionsInWindow, 7);
    assert.equal(analyseSeries({ lum: [seven], fps: FPS }).pass, false);
  });

  test('a change below 0.1 never counts; just above it does', () => {
    assert.equal(peak(square(0.3, 0.39, 4, 90)), 0);
    assert.ok(peak(square(0.3, 0.41, 4, 90)) > 3);
  });

  test('swings where the darker state is 0.80 or brighter are not flashes', () => {
    assert.equal(peak(square(0.8, 1, 4, 90)), 0);
    assert.ok(peak(square(0.79, 1, 4, 90)) > 3);
  });

  test('fast flicker spread out over time: the worst 1 s window is what counts', () => {
    const calm = new Array(60).fill(0.2);
    const burst = square(0.2, 0.9, 4, 30);
    const r = analyseSeries({ lum: [[...calm, ...burst, ...calm]], fps: FPS });
    assert.equal(r.pass, false);
    assert.ok(r.worstWindowStartSec >= 2 && r.worstWindowStartSec < 3, `worst window at ${r.worstWindowStartSec}s`);
  });

  test('frame rate matters: the same 8 transitions over 60 frames are 4/s at 30 fps but 2/s at 60 fps', () => {
    const lum = square(0, 1, 6, 24);
    assert.ok(summarise(generalTransitions(lum), 30).peakFlashesPerSecond > 3);
    assert.ok(summarise(generalTransitions(lum), 60).peakFlashesPerSecond <= 4);
  });

  test('maxPerWindow counts transitions inside [start, start + window)', () => {
    assert.deepEqual(maxPerWindow([0, 10, 20, 29, 30], 30), { count: 4, start: 0 });
    assert.deepEqual(maxPerWindow([], 30), { count: 0, start: -1 });
  });
});

describe('red flash threshold (WCAG 2.2 note; UNVERIFIED wording)', () => {
  test('saturated dark red flicker below the general threshold is still a red flash', () => {
    const red = square(redState(0.1, 0, 0), redState(0, 0, 0), 6, 90);
    const lum = red.map((_, i) => (i % 6 < 3 ? 0.2126 * 0.1 : 0));
    assert.equal(generalTransitions(lum).length, 0, 'luminance change 0.02 is below 0.1');
    assert.ok(redTransitions(red).length > 20);
    const r = analyseSeries({ lum: [lum], red: [red], fps: FPS });
    assert.equal(r.worstKind, 'red');
    assert.equal(r.pass, false);
  });

  test('a red value change without saturated red is not a red flash', () => {
    const red = square({ value: 40, saturated: false }, { value: 0, saturated: false }, 6, 90);
    assert.equal(redTransitions(red).length, 0);
  });
});

describe('frames and regions', () => {
  const W = 192, H = 108;
  const frame = (fill) => { const b = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b.set(fill(x, y), (y * W + x) * 3); return b; };

  test('25 overlapping one-third windows plus the whole frame', () => {
    const w = regionWindows(W, H);
    assert.equal(w.length, 26);
    assert.equal(w[0].id, 'full');
    assert.ok(w.slice(1).every((r) => r.w === 64 && r.h === 36 && r.x + r.w <= W && r.y + r.h <= H));
  });

  test('full-frame white flicker at 5 Hz fails; a still frame passes', () => {
    const black = frame(() => [0, 0, 0]), white = frame(() => [255, 255, 255]);
    const an = createFlashAnalyser({ width: W, height: H, fps: FPS });
    for (let i = 0; i < 60; i++) an.push(i % 6 < 3 ? white : black);
    const r = an.result();
    assert.equal(r.frames, 60);
    assert.equal(r.pass, false);
    assert.equal(r.peakFlashesPerSecond, 5);
    const still = createFlashAnalyser({ width: W, height: H, fps: FPS });
    for (let i = 0; i < 60; i++) still.push(black);
    assert.equal(still.result().peakFlashesPerSecond, 0);
  });

  test('a flash in one corner third is caught by its window though the whole-frame mean barely moves', () => {
    const grey = 188; // linear about 0.5
    const on = frame((x, y) => (x < 64 && y < 36 ? [grey, grey, grey] : [0, 0, 0])), off = frame(() => [0, 0, 0]);
    const an = createFlashAnalyser({ width: W, height: H, fps: FPS });
    for (let i = 0; i < 60; i++) an.push(i % 6 < 3 ? on : off);
    const r = an.result();
    assert.equal(r.pass, false);
    assert.notEqual(r.worstRegion, 'full');
  });

  test('a tiny flash (10 x 10 px of 192 x 108) is below the area rule', () => {
    const on = frame((x, y) => (x >= 90 && x < 100 && y >= 50 && y < 60 ? [255, 255, 255] : [0, 0, 0])), off = frame(() => [0, 0, 0]);
    const an = createFlashAnalyser({ width: W, height: H, fps: FPS });
    for (let i = 0; i < 60; i++) an.push(i % 4 < 2 ? on : off);
    assert.equal(an.result().peakFlashesPerSecond, 0);
  });

  test('bad sizes and short frames are refused', () => {
    assert.throws(() => createFlashAnalyser({ width: 0, height: 10, fps: 30 }), RangeError);
    assert.throws(() => createFlashAnalyser({ width: 10, height: 10, fps: 0 }), RangeError);
    assert.throws(() => createFlashAnalyser({ width: 10, height: 10, fps: 30 }).push(Buffer.alloc(5)), RangeError);
  });

  test('the definition carries its source and the settled limit of 3', () => {
    assert.equal(DEFINITION.maxFlashesPerSecond, 3);
    assert.match(DEFINITION.source, /WCAG/);
  });
});
