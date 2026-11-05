// SPDX-License-Identifier: GPL-3.0-or-later
// Flash detector (v1 F4): counts flashes in a series of rendered frames, from frame luminance. Pure, Node stdlib only.
//
// Definition used (WCAG 2.x, "general flash and red flash thresholds", success criterion 2.3.1; the same numbers as
// ITU-R BT.1702 and the Ofcom/Harding guidance):
//   - relative luminance L of an sRGB pixel: linearise each channel (c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4),
//     then L = 0.2126 R + 0.7152 G + 0.0722 B (0 = black, 1 = white). Areas are averaged in linear light.
//   - a general transition: a change in relative luminance of 0.1 or more (10 % of the maximum), where the darker of
//     the two states is below 0.80.
//   - a flash: a pair of opposing transitions. The limit: no more than 3 flashes in any one-second period, so a window
//     that holds 7 or more qualifying transitions fails (3.5 flashes).
//   - a red transition (WCAG 2.2 understanding note, UNVERIFIED wording check): a change of 20 or more in the value
//     max(0, R - G - B) * 320 (linear channels), where at least one of the two states is saturated red,
//     R / (R + G + B) >= 0.8. Red flashes are counted the same way and against the same limit.
//   - area: WCAG counts a flash only when it covers at least about a quarter of a 10 degree visual field, which it
//     maps to a 341 x 256 px rectangle on a 1024 x 768 screen (one third of each side). This module averages each frame
//     over 25 overlapping windows of one third by one third of the frame (stride one sixth) plus the whole frame and
//     counts each window separately; the result is the worst window. A flash smaller than a window is diluted by the
//     window mean, which approximates the area rule. Approximation, not a certified PSE analyser (e.g. Harding FPA).
//
// Transitions are found with a zig-zag over the series: a turning point is confirmed once the signal moves back by at
// least the threshold from its running extreme, so encoder noise smaller than the threshold never counts. Each leg
// between turning points (and the last open leg) is one transition, timed at the frame where it ends.

export const DEFINITION = Object.freeze({
  id: 'wcag2-2.3.1-general+red',
  source: 'W3C WCAG 2.2, SC 2.3.1 Three Flashes or Below Threshold, definitions "general flash and red flash thresholds" and "relative luminance"; ITU-R BT.1702',
  luminanceDelta: 0.1,
  darkerBelow: 0.8,
  redDelta: 20,
  redSaturation: 0.8,
  maxFlashesPerSecond: 3,
  windowSec: 1,
  regionFraction: 1 / 3,
  regionStride: 1 / 6,
});

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

/** 8-bit sRGB channel -> linear 0..1. */
export const srgbToLinear = (v) => LIN[v & 255];

/** Relative luminance of an 8-bit sRGB colour, 0..1. */
export function relativeLuminance(r, g, b) {
  return 0.2126 * LIN[r & 255] + 0.7152 * LIN[g & 255] + 0.0722 * LIN[b & 255];
}

/** Red-flash value of mean linear channels: max(0, R - G - B) * 320, and the saturation R / (R + G + B). */
export function redState(R, G, B) {
  const s = R + G + B;
  return { value: Math.max(0, R - G - B) * 320, saturated: s > 0 && R / s >= DEFINITION.redSaturation };
}

/** Zig-zag legs of a numeric series. Returns [{ from, to, fromIdx, toIdx }], each leg at least `threshold` tall. */
export function zigzag(series, threshold) {
  const legs = [];
  const n = series.length;
  if (n < 2) return legs;
  let dir = 0, pivot = 0, ext = 0, hi = 0, lo = 0;
  for (let i = 1; i < n; i++) {
    const v = series[i];
    if (dir === 0) {
      if (v > series[hi]) hi = i;
      if (v < series[lo]) lo = i;
      if (series[hi] - series[lo] >= threshold) {
        if (hi > lo) { pivot = lo; ext = hi; dir = 1; } else { pivot = hi; ext = lo; dir = -1; }
      }
      continue;
    }
    if (dir === 1) {
      if (v > series[ext]) ext = i;
      else if (series[ext] - v >= threshold) { legs.push({ from: series[pivot], to: series[ext], fromIdx: pivot, toIdx: ext }); pivot = ext; ext = i; dir = -1; }
    } else {
      if (v < series[ext]) ext = i;
      else if (v - series[ext] >= threshold) { legs.push({ from: series[pivot], to: series[ext], fromIdx: pivot, toIdx: ext }); pivot = ext; ext = i; dir = 1; }
    }
  }
  if (dir !== 0 && Math.abs(series[ext] - series[pivot]) >= threshold) legs.push({ from: series[pivot], to: series[ext], fromIdx: pivot, toIdx: ext });
  return legs;
}

/** Frame indices of qualifying general transitions in a relative-luminance series. */
export function generalTransitions(lum, def = DEFINITION) {
  return zigzag(lum, def.luminanceDelta).filter((l) => Math.min(l.from, l.to) < def.darkerBelow).map((l) => l.toIdx);
}

/** Frame indices of qualifying red transitions. red: [{ value, saturated }] per frame. */
export function redTransitions(red, def = DEFINITION) {
  const v = red.map((r) => r.value);
  return zigzag(v, def.redDelta).filter((l) => red[l.fromIdx].saturated || red[l.toIdx].saturated).map((l) => l.toIdx);
}

/** Largest number of transitions inside any window of `windowFrames` frames that starts at a transition. */
export function maxPerWindow(idx, windowFrames) {
  let best = 0, bestStart = -1;
  for (let i = 0, j = 0; i < idx.length; i++) {
    while (j < idx.length && idx[j] < idx[i] + windowFrames) j++;
    if (j - i > best) { best = j - i; bestStart = idx[i]; }
  }
  return { count: best, start: bestStart };
}

/** Flash summary of one series. Returns { transitions, maxTransitionsInWindow, peakFlashesPerSecond, worstWindowStartFrame }. */
export function summarise(transitions, fps, def = DEFINITION) {
  const w = Math.max(1, Math.round(fps * def.windowSec));
  const m = maxPerWindow(transitions, w);
  return { transitions: transitions.length, maxTransitionsInWindow: m.count, peakFlashesPerSecond: m.count / 2 / def.windowSec, worstWindowStartFrame: m.start };
}

/** Windows (in pixels) over a w x h frame: 5 x 5 overlapping one-third windows plus the whole frame. */
export function regionWindows(w, h, def = DEFINITION) {
  const out = [{ x: 0, y: 0, w, h, id: 'full' }];
  const ww = Math.max(1, Math.round(w * def.regionFraction)), wh = Math.max(1, Math.round(h * def.regionFraction));
  const sx = Math.max(1, Math.round(w * def.regionStride)), sy = Math.max(1, Math.round(h * def.regionStride));
  for (let y = 0; y + wh <= h; y += sy) for (let x = 0; x + ww <= w; x += sx) out.push({ x, y, w: ww, h: wh, id: `r${x}_${y}` });
  return out;
}

/** Streaming analyser for packed rgb24 frames of w x h. push(frame) per frame, then result(). */
export function createFlashAnalyser({ width, height, fps, def = DEFINITION }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('bad frame size');
  if (!(fps > 0 && fps <= 1000)) throw new RangeError('bad fps');
  const wins = regionWindows(width, height, def);
  const lum = wins.map(() => []);
  const red = wins.map(() => []);
  const frameBytes = width * height * 3;
  // Per-pixel linear values are summed per row segment; small frames (about 200 x 110) keep this cheap.
  const linR = new Float64Array(width * height), linG = new Float64Array(width * height), linB = new Float64Array(width * height);
  let frames = 0;
  return {
    frameBytes,
    push(buf) {
      if (buf.length < frameBytes) throw new RangeError('short frame');
      for (let p = 0, i = 0; p < width * height; p++, i += 3) { linR[p] = LIN[buf[i]]; linG[p] = LIN[buf[i + 1]]; linB[p] = LIN[buf[i + 2]]; }
      for (let k = 0; k < wins.length; k++) {
        const r = wins[k];
        let sr = 0, sg = 0, sb = 0;
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x, p = y * width + r.x; x < r.x + r.w; x++, p++) { sr += linR[p]; sg += linG[p]; sb += linB[p]; }
        const n = r.w * r.h, R = sr / n, G = sg / n, B = sb / n;
        lum[k].push(0.2126 * R + 0.7152 * G + 0.0722 * B);
        red[k].push(redState(R, G, B));
      }
      frames++;
    },
    get frames() { return frames; },
    result() { return analyseSeries({ lum, red, fps, ids: wins.map((w) => w.id), def }); },
  };
}

/** Worst result over several region series. lum: number[][] (one per region), red: optional [{value,saturated}][][]. */
export function analyseSeries({ lum, red = [], fps, ids = [], def = DEFINITION }) {
  let worst = null;
  let generalPeak = 0, redPeak = 0;
  const frames = lum[0]?.length ?? 0;
  const none = { transitions: 0, maxTransitionsInWindow: 0, peakFlashesPerSecond: 0, worstWindowStartFrame: -1 };
  for (let k = 0; k < lum.length; k++) {
    const g = summarise(generalTransitions(lum[k], def), fps, def);
    const r = red[k] ? summarise(redTransitions(red[k], def), fps, def) : none;
    generalPeak = Math.max(generalPeak, g.peakFlashesPerSecond);
    redPeak = Math.max(redPeak, r.peakFlashesPerSecond);
    const peak = Math.max(g.peakFlashesPerSecond, r.peakFlashesPerSecond);
    if (!worst || peak > worst.peakFlashesPerSecond) {
      worst = { region: ids[k] ?? String(k), peakFlashesPerSecond: peak, general: g, red: r, kind: r.peakFlashesPerSecond > g.peakFlashesPerSecond ? 'red' : 'general' };
    }
  }
  const peak = worst?.peakFlashesPerSecond ?? 0;
  const startFrame = worst ? (worst.kind === 'red' ? worst.red.worstWindowStartFrame : worst.general.worstWindowStartFrame) : -1;
  return {
    definition: def.id,
    frames,
    fps,
    durationSec: frames / fps,
    regions: lum.length,
    peakFlashesPerSecond: peak,
    maxTransitionsInWindow: worst ? Math.max(worst.general.maxTransitionsInWindow, worst.red.maxTransitionsInWindow) : 0,
    worstRegion: worst?.region ?? null,
    worstKind: peak > 0 ? worst.kind : null,
    worstWindowStartSec: startFrame >= 0 ? startFrame / fps : null,
    generalPeak,
    redPeak,
    limit: def.maxFlashesPerSecond,
    pass: peak <= def.maxFlashesPerSecond,
  };
}
