// SPDX-License-Identifier: GPL-2.0-or-later
// Compares one overlay run driven by mock-chat-schedule.mjs on two hosts at once:
//   legacy  the page in headless Chrome, traced by legacy-browser-trace.mjs (draw calls + counters)
//   libobs  the same page in a libobs recording, measured by effect-timeline.mjs
//
//   node parity-cooldown.mjs --mock mock.log --trace trace.json --timeline timeline.json
//        --rec-start 2026-10-27T01:42:14.284Z [--json OUT]
//
// --rec-start is the output's "signal start" time from the spike log; frame i of the recording is
// taken to show wall time rec-start + i/fps (approximate: +/- a frame plus encoder start latency).
// For every send: did each host fire, and after how long. Per phase: fires, intervals between fires.
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const sends = readFileSync(arg('mock'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ev === 'send');
const trace = JSON.parse(readFileSync(arg('trace'), 'utf8'));
const tl = JSON.parse(readFileSync(arg('timeline'), 'utf8'));
const recStart = Date.parse(arg('rec-start'));

// ---- legacy: effects = runs of animation frames with strokes, in wall-clock ms ----
const toWall = (t) => trace.t0wall + (t - trace.t0perf);
const legacyEff = [];
let cur = null;
for (const f of trace.frames) {
  if (f.strokes > 0) {
    if (!cur) { cur = { start: toWall(f.t), end: toWall(f.t), frames: 0, maxAlpha: 0, colors: {}, bb: null, cw: f.cw, ch: f.ch, pts: 0, p220: 0, p600: 0 }; legacyEff.push(cur); }
    cur.end = toWall(f.t); cur.frames++;
    cur.pts += f.pts || 0; cur.p220 += f.p220 || 0; cur.p600 += f.p600 || 0;
    cur.maxAlpha = Math.max(cur.maxAlpha, f.maxAlpha);
    for (const [c, n] of Object.entries(f.colors)) cur.colors[c] = (cur.colors[c] || 0) + n;
    if (f.bb) cur.bb = cur.bb ? [Math.min(cur.bb[0], f.bb[0]), Math.min(cur.bb[1], f.bb[1]), Math.max(cur.bb[2], f.bb[2]), Math.max(cur.bb[3], f.bb[3])] : f.bb.slice();
  } else if (cur) { cur.cleared = toWall(f.t); cur = null; }
}
// legacy fired/dropped per received message, from the page's own counters
const wsById = new Map(trace.wsIn.map((w, i) => [w.id, { ...w, firedNow: i === 0 ? w.fired : w.fired - trace.wsIn[i - 1].fired }]));

// ---- libobs: episodes in wall-clock ms ----
const obsEff = tl.episodes.map((e) => ({ start: recStart + e.start_s * 1000, end: recStart + e.end_s * 1000, vis: e.visible_ms, hue: e.glowHue, in220: e.in220, in600: e.in600, minEdgePx: e.minEdgePx }));

// An effect starting within WINDOW ms after a send belongs to it. Both hosts get -40 ms of
// slack: mock logs written before this tool's fix stamped the send after the socket writes.
const WINDOW = 250;
const rows = sends.map((s) => {
  const lg = legacyEff.find((e) => e.start >= s.ms - 40 && e.start - s.ms < WINDOW);
  const ob = obsEff.find((e) => e.start >= s.ms - 40 && e.start - s.ms < WINDOW);
  const w = wsById.get(`p-${s.k}`);
  return { k: s.k, phase: s.phase, n: s.n, sendMs: s.ms, legacyCounterFired: w ? w.firedNow === 1 : null,
    legacyFired: !!lg, legacyLatency: lg ? Math.round(lg.start - s.ms) : null,
    obsFired: !!ob, obsLatency: ob ? Math.round(ob.start - s.ms) : null };
});

const phases = {};
for (const r of rows) {
  const p = phases[r.phase] ||= { sends: 0, legacyFires: 0, obsFires: 0, legacyFireAt: [], obsFireAt: [] };
  p.sends++;
  if (r.legacyFired) { p.legacyFires++; p.legacyFireAt.push(r.sendMs); }
  if (r.obsFired) { p.obsFires++; p.obsFireAt.push(r.sendMs); }
}
const gaps = (a) => a.slice(1).map((t, i) => t - a[i]);
for (const p of Object.values(phases)) {
  p.legacyIntervals = gaps(p.legacyFireAt); p.obsIntervals = gaps(p.obsFireAt);
  p.sameSends = JSON.stringify(p.legacyFireAt) === JSON.stringify(p.obsFireAt);
  delete p.legacyFireAt; delete p.obsFireAt;
}

const stat = (a) => (a.length ? { n: a.length, min: Math.min(...a), max: Math.max(...a), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) } : null);
const share = (e, k) => (e.pts ? +(e[k] / e.pts).toFixed(3) : null);
const result = {
  sends: rows.length,
  agreement: rows.filter((r) => r.legacyFired === r.obsFired).length,
  counterVsDraw: rows.filter((r) => r.legacyCounterFired === r.legacyFired).length,
  phases,
  legacy: {
    effects: legacyEff.length,
    latencyMs: stat(rows.filter((r) => r.legacyFired).map((r) => r.legacyLatency)),
    // first to last drawn frame, and to the clearing frame (the page's own end of the effect)
    drawnMs: stat(legacyEff.map((e) => Math.round(e.end - e.start))),
    untilClearMs: stat(legacyEff.filter((e) => e.cleared).map((e) => Math.round(e.cleared - e.start))),
    framesPerEffect: stat(legacyEff.map((e) => e.frames)),
    maxAlpha: stat(legacyEff.map((e) => +e.maxAlpha.toFixed(3))),
    colours: [...new Set(legacyEff.flatMap((e) => Object.keys(e.colors)))],
    variants: trace.wsIn.filter((w, i) => (i === 0 ? w.fired : w.fired - trace.wsIn[i - 1].fired) === 1).map((w) => w.last),
    // share of stroked path points within 220 / 600 px of the nearest canvas edge (points off the
    // canvas count as distance 0), per effect
    pts220: stat(legacyEff.filter((e) => e.pts).map((e) => share(e, 'p220'))),
    pts600: stat(legacyEff.filter((e) => e.pts).map((e) => share(e, 'p600')))
  },
  libobs: {
    effects: obsEff.length,
    latencyMs: stat(rows.filter((r) => r.obsFired).map((r) => r.obsLatency)),
    visibleMs: stat(obsEff.map((e) => e.vis)),
    glowHues: obsEff.map((e) => e.hue),
    in220: stat(obsEff.map((e) => e.in220)), in600: stat(obsEff.map((e) => e.in600))
  },
  rows
};
if (arg('json')) writeFileSync(arg('json'), JSON.stringify(result, null, 1));
const { rows: _r, ...summary } = result;
console.log(JSON.stringify(summary, null, 1));
