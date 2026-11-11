// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB2 layout slots, rules only (D339). Reads the measurements of analyse.mjs and says where the game,
// camera, chat, alerts and graphics sit, each with a confidence 0..1 and the rule hits that gave it.
//
// 1. game: the rectangle of cells that best covers the textured (busy) cells, found as the maximum-sum sub-rectangle
//    with busy +1, ui -0.4, soft -1.2 per cell (game footage is textured; the frame around it is not), split at
//    near-empty seams so a textured panel next to it is not joined to it (gameRect). At least
//    GAME_MIN_AREA of the canvas, else there is no game slot. Its sides then snap to the strongest straight edge
//    within one cell.
// 2. The other content (cells that are not soft, outside the game) is split into connected boxes; text-like boxes
//    stacked under each other with small gaps are one stack (a chat rail of cards).
// 3. Each box is scored as camera (skin tones, texture, a camera shape), chat (text lines, stacked cards, a tall rail
//    at a side), alerts (a wide box, centred, upper half, vivid fill) or graphics (everything else: bands, logos).
//    Camera, chat and alerts keep only their best box; the rest are graphics.
// Boxes are fractions of the frame: { x, y, w, h } in 0..1.

import { cellsToPx, components, MOTION_T, snapToEdges, toFraction } from './analyse.mjs';
import { chroma } from './colour.mjs';

export const RULES_VERSION = '0.1.0';
export const ROLES = ['game', 'camera', 'chat', 'alerts', 'graphics'];
export const GAME_MIN_AREA = 0.08;
const MIN_BOX_AREA = 0.0015;
export const CONTENT_EDGE = 0.05; // a lower edge bar than EDGE_T for content boxes, so subtle card outlines count
const W_BUSY = 1, W_UI = -0.4, W_SOFT = -1.2;

const r2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

/** Maximum-sum sub-rectangle over a cols x rows weight grid (Kadane over column sums for every pair of rows). */
export function maxRect(weights, cols, rows) {
  let best = { sum: -Infinity, c0: 0, r0: 0, c1: -1, r1: -1 };
  const colSum = new Float64Array(cols);
  for (let r0 = 0; r0 < rows; r0++) {
    colSum.fill(0);
    for (let r1 = r0; r1 < rows; r1++) {
      for (let c = 0; c < cols; c++) colSum[c] += weights[r1 * cols + c];
      let run = 0, start = 0;
      for (let c = 0; c < cols; c++) {
        if (run <= 0) { run = colSum[c]; start = c; } else run += colSum[c];
        if (run > best.sum) best = { sum: run, c0: start, r0, c1: c, r1 };
      }
    }
  }
  return best;
}

// Text lines inside a pixel box: runs of rows (inset from the border) where enough pixels are edges.
/** The game rectangle: the maximum-sum rectangle, split at seams. A seam is an inner column (or row) of the
 *  rectangle where at most SEAM_BUSY of the cells are busy: the game is one unbroken textured area, so a gap
 *  between it and a textured panel beside it (a camera, a busy chat) never joins them. The part with more busy
 *  cells is kept and searched again, a few times at most. */
export const SEAM_BUSY = 0.3;
export function gameRect(m, w) {
  const { cols, rows } = m;
  let g = maxRect(w, cols, rows);
  for (let pass = 0; pass < 6 && g.c1 >= g.c0; pass++) {
    const busyIn = (c0, r0, c1, r1) => { let n = 0; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (m.kind[r * cols + c] === 2) n++; return n; };
    let split = null;
    for (let c = g.c0 + 1; c < g.c1 && !split; c++) if (busyIn(c, g.r0, c, g.r1) <= SEAM_BUSY * (g.r1 - g.r0 + 1)) split = { a: [g.c0, g.r0, c - 1, g.r1], b: [c + 1, g.r0, g.c1, g.r1] };
    for (let r = g.r0 + 1; r < g.r1 && !split; r++) if (busyIn(g.c0, r, g.c1, r) <= SEAM_BUSY * (g.c1 - g.c0 + 1)) split = { a: [g.c0, g.r0, g.c1, r - 1], b: [g.c0, r + 1, g.c1, g.r1] };
    if (!split) break;
    const keep = busyIn(...split.a) >= busyIn(...split.b) ? split.a : split.b;
    const masked = new Float64Array(w.length).fill(-1e6);
    for (let r = keep[1]; r <= keep[3]; r++) for (let c = keep[0]; c <= keep[2]; c++) masked[r * cols + c] = w[r * cols + c];
    g = maxRect(masked, cols, rows);
  }
  return g;
}

function textLines(m, b) {
  const inset = Math.max(3, Math.round(m.cell / 4));
  const x0 = b.x0 + inset, x1 = b.x1 - inset, y0 = b.y0 + inset, y1 = b.y1 - inset;
  if (x1 - x0 < 8 || y1 - y0 < 6) return 0;
  const maxRun = Math.max(6, 0.25 * (y1 - y0));
  let lines = 0, run = 0;
  for (let y = y0; y <= y1; y++) {
    let e = 0;
    if (y < y1) for (let x = x0; x < x1; x++) if (m.grad.mag[y * m.width + x] >= 0.08) e++;
    if (y < y1 && e / (x1 - x0) >= 0.06) run++;
    else { if (run >= 2 && run <= maxRun) lines++; run = 0; }
  }
  return lines;
}

function boxStats(m, b) {
  let n = 0, skin = 0, busy = 0, ui = 0, cn = 0, L = 0, A = 0, B = 0;
  for (let cy = Math.floor(b.y0 / m.cell); cy <= Math.floor((b.y1 - 1) / m.cell); cy++) {
    for (let cx = Math.floor(b.x0 / m.cell); cx <= Math.floor((b.x1 - 1) / m.cell); cx++) {
      const c = cy * m.cols + cx;
      cn++; if (m.kind[c] === 2) busy++; else if (m.kind[c] === 1) ui++;
    }
  }
  const rgb = m.key.rgb, lab = m.keyLab;
  for (let y = b.y0; y < b.y1; y += 2) {
    for (let x = b.x0; x < b.x1; x += 2) {
      const o = (y * m.width + x) * 3;
      n++;
      const r = rgb[o], g = rgb[o + 1], bl = rgb[o + 2];
      if (r > 95 && g > 40 && bl > 20 && r > g && r > bl && r - g > 15 && r - bl > 30) skin++;
      L += lab[o]; A += lab[o + 1]; B += lab[o + 2];
    }
  }
  const mean = [L / n, A / n, B / n];
  return { skin: skin / n, busy: busy / cn, ui: ui / cn, meanChroma: chroma(mean), mean };
}

/** Merge text-like boxes stacked under each other (same column, similar width, small gaps) into one stack. */
function mergeStacks(boxes, m) {
  const gapMax = 2.5 * m.cell;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const a = boxes[i], b = boxes[j];
        if (a.stats.busy > 0.3 || b.stats.busy > 0.3) continue;
        if (b.px.y0 < a.px.y0) continue;
        const gap = b.px.y0 - a.px.y1;
        if (gap > gapMax || gap < -m.cell) continue;
        const wa = a.px.x1 - a.px.x0, wb = b.px.x1 - b.px.x0;
        const ov = Math.min(a.px.x1, b.px.x1) - Math.max(a.px.x0, b.px.x0);
        if (ov < 0.6 * Math.min(wa, wb) || Math.min(wa, wb) / Math.max(wa, wb) < 0.7) continue;
        const px = { x0: Math.min(a.px.x0, b.px.x0), y0: Math.min(a.px.y0, b.px.y0), x1: Math.max(a.px.x1, b.px.x1), y1: Math.max(a.px.y1, b.px.y1) };
        boxes[i] = { px, cards: a.cards + b.cards, stats: boxStats(m, px) };
        boxes.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return boxes;
}

function score(m, box, canvas) {
  const f = toFraction(m, box.px);
  const s = box.stats;
  const area = f.w * f.h;
  const aspect = (f.w * m.width) / (f.h * m.height);
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const nearSide = f.x < 0.12 || f.x + f.w > 0.88;
  const ev = { camera: [], chat: [], alerts: [], graphics: [] };
  const sc = { camera: 0, chat: 0, alerts: 0, graphics: 0.35 };
  // camera
  if (s.skin >= 0.12 && area >= 0.005 && area <= 0.35) {
    sc.camera += Math.min(1, s.skin / 0.35) * 0.55; ev.camera.push(`skin ${s.skin.toFixed(2)}`);
    if (s.busy >= 0.3) { sc.camera += 0.25; ev.camera.push(`textured ${s.busy.toFixed(2)}`); }
    if (aspect >= 0.5 && aspect <= 2.2) { sc.camera += 0.15; ev.camera.push(`camera shape ${aspect.toFixed(2)}`); }
  }
  // chat
  if (s.busy < 0.4) {
    if (box.lines >= 4) { sc.chat += Math.min(1, box.lines / 8) * 0.4; ev.chat.push(`${box.lines} text lines`); }
    if (box.cards >= 3) { sc.chat += Math.min(1, box.cards / 4) * 0.3; ev.chat.push(`${box.cards} stacked cards`); }
    if (sc.chat > 0 && f.h * m.height >= 1.3 * f.w * m.width) { sc.chat += 0.15; ev.chat.push('tall rail'); }
    if (sc.chat > 0 && nearSide && canvas === 'H') { sc.chat += 0.15; ev.chat.push('at a side'); }
    if (sc.chat > 0 && canvas === 'V' && f.w >= 0.4) { sc.chat += 0.15; ev.chat.push('wide portrait rail'); }
  }
  const band = f.w >= 0.6 && f.h <= 0.14;
  // alerts (a full-width band is a ticker or a banner: graphics)
  if (!band && area >= 0.003 && area <= 0.12 && box.lines <= 3 && box.cards <= 2) {
    if (aspect >= 1.5) { sc.alerts += 0.25; ev.alerts.push(`wide ${aspect.toFixed(2)}`); }
    if (Math.abs(cx - 0.5) < 0.2) { sc.alerts += 0.25; ev.alerts.push('centred'); }
    if (cy < 0.5) { sc.alerts += 0.15; ev.alerts.push('upper half'); }
    if (s.meanChroma >= 0.07) { sc.alerts += 0.2; ev.alerts.push(`vivid fill ${s.meanChroma.toFixed(2)}`); }
    if (f.y + f.h > 0.97 || f.y < 0.005) sc.alerts -= 0.2;
  }
  // graphics
  if (band) { sc.graphics += 0.3; ev.graphics.push('full-width band'); }
  else if (area < 0.02) ev.graphics.push('small mark');
  else ev.graphics.push('panel');
  return { f, sc, ev };
}

/** Slots of one measured reference. canvas: 'H' or 'V'. Returns { slots: [{ role, box, confidence, evidence, source }],
 *  gamePx, panels: [pixel boxes of the game and every other content box] } (panels feed the style rules). */
export function detectSlots(m, canvas) {
  const slots = [];
  const nc = m.cols * m.rows;
  const w = new Float64Array(nc);
  for (let c = 0; c < nc; c++) w[c] = m.kind[c] === 2 ? W_BUSY : m.kind[c] === 1 ? W_UI : W_SOFT;
  const g = gameRect(m, w);
  let gamePx = null;
  if (g.c1 >= g.c0) {
    const cells = (g.c1 - g.c0 + 1) * (g.r1 - g.r0 + 1);
    let busy = 0, mov = 0;
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) { if (m.kind[r * m.cols + c] === 2) busy++; if (m.motion[r * m.cols + c] >= MOTION_T) mov++; }
    const px = snapToEdges(m, cellsToPx(m, g), m.cell);
    const f = toFraction(m, px);
    if (f.w * f.h >= GAME_MIN_AREA) {
      gamePx = px;
      const busyShare = busy / cells;
      const ev = [`textured ${busyShare.toFixed(2)}`, `area ${(f.w * f.h).toFixed(2)}`];
      let conf = 0.3 + 0.5 * Math.min(1, busyShare / 0.8) + 0.2 * Math.min(1, (f.w * f.h) / 0.3);
      if (m.frames > 1) { ev.push(`moving ${(mov / cells).toFixed(2)}`); conf = 0.8 * conf + 0.2 * (mov / cells); }
      slots.push({ role: 'game', box: f, confidence: r2(conf), evidence: ev, source: 'rules' });
    }
  }
  // The rest of the content, outside the game (with a margin of a quarter cell for its frame), on a grid of half
  // cells so that boxes a cell apart stay apart: a fine cell is content when it has edges.
  const fc = Math.max(3, Math.round(m.cell / 2));
  const fcols = Math.ceil(m.width / fc), frows = Math.ceil(m.height / fc);
  const mask = new Uint8Array(fcols * frows);
  const margin = Math.round(m.cell / 4);
  for (let r = 0; r < frows; r++) {
    for (let c = 0; c < fcols; c++) {
      const x0 = c * fc, y0 = r * fc, x1 = Math.min(m.width, x0 + fc), y1 = Math.min(m.height, y0 + fc);
      if (gamePx && x1 > gamePx.x0 - margin && x0 < gamePx.x1 + margin && y1 > gamePx.y0 - margin && y0 < gamePx.y1 + margin) continue;
      let e = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (m.grad.mag[y * m.width + x] >= CONTENT_EDGE) e++;
      if (e / ((x1 - x0) * (y1 - y0)) >= 0.04) mask[r * fcols + c] = 1;
    }
  }
  const fine = { cell: fc, width: m.width, height: m.height };
  let boxes = components(mask, fcols, frows).map((comp) => {
    const px = snapToEdges(m, cellsToPx(fine, comp), fc + 2);
    return { px, cards: 1, stats: boxStats(m, px) };
  }).filter((b) => ((b.px.x1 - b.px.x0) * (b.px.y1 - b.px.y0)) / (m.width * m.height) >= MIN_BOX_AREA);
  boxes = mergeStacks(boxes, m);
  for (const b of boxes) b.lines = textLines(m, b.px);
  const scored = boxes.map((b) => ({ b, ...score(m, b, canvas) }));
  const taken = new Set();
  for (const role of ['camera', 'chat', 'alerts']) {
    let best = null;
    for (const s of scored) {
      if (taken.has(s)) continue;
      const mine = s.sc[role];
      const rival = Math.max(...Object.entries(s.sc).filter(([k]) => k !== role && k !== 'graphics').map(([, v]) => v));
      if (mine >= 0.45 && mine >= rival && (!best || mine > best.sc[role])) best = s;
    }
    if (best) {
      taken.add(best);
      slots.push({ role, box: best.f, confidence: r2(best.sc[role]), evidence: best.ev[role], source: 'rules' });
    }
  }
  for (const s of scored) {
    if (taken.has(s)) continue;
    slots.push({ role: 'graphics', box: s.f, confidence: r2(s.sc.graphics), evidence: s.ev.graphics, source: 'rules' });
  }
  return { slots, gamePx, panels: [...(gamePx ? [gamePx] : []), ...boxes.map((b) => b.px)] };
}
