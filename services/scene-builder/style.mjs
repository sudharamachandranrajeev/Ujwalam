// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB2 style rules (D339): type feel, corner radius, glow and shadow use, read from the key frame of
// the measurements (analyse.mjs) and the content boxes the layout rules found. Rules only; each answer carries a
// confidence and the numbers it came from, so a person (or SB3/SB4) can argue with it.
//
// type    - glyph-like marks (small connected marks of high contrast inside text areas): stroke weight = median
//           stroke width / median mark height; size from the mark height on a 1080 px short side; polarity.
//           Font family is not read by rules (null; the later local model hook may fill it).
// radius  - per box corner, the sub-pixel distance along the diagonal from where the two side boundaries meet to
//           the panel's boundary; a circular corner of radius r meets it at r (1 - 1/sqrt 2) per axis. Median.
// glow    - vivid marks (OKLab C >= 0.08, L >= 0.5) whose colour fades out gradually beyond their bounds on at
//           least two sides with the same hue (a halo), against a hard edge that stops at once.
// shadow  - boxes with a band below them that is darker than the ground further away and lightens outward.

import { hex, hueDeg, hueGap, oklabToRgb } from './colour.mjs';

const K_DIAG = 1 - Math.SQRT1_2;
export const CORNER_BIAS = 0.2; // px per axis, see cornerRadius
const r2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Pixel components (8-neighbour) of a Uint8Array mask over width x height; bounded to `max` components. */
function pixelComponents(mask, width, height, max = 4000) {
  const label = new Int32Array(mask.length).fill(-1);
  const out = [];
  const stack = new Int32Array(mask.length);
  for (let s = 0; s < mask.length && out.length < max; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = out.length;
    const comp = { area: 0, faces: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, L: 0, A: 0, B: 0 };
    let sp = 0; stack[sp++] = s; label[s] = id;
    while (sp) {
      const i = stack[--sp];
      const x = i % width, y = (i - x) / width;
      comp.area++;
      if (x < comp.x0) comp.x0 = x; if (x > comp.x1) comp.x1 = x; if (y < comp.y0) comp.y0 = y; if (y > comp.y1) comp.y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) comp.faces++;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (mask[j] && label[j] < 0) { label[j] = id; stack[sp++] = j; }
        }
      }
    }
    out.push(comp);
  }
  return { comps: out, label };
}

/** Type feel from glyph-like marks in text (ui) cells. */
export function typeFeel(m) {
  const { width, height, keyLab: lab } = m;
  const mask = new Uint8Array(width * height);
  let lighter = 0, darker = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = Math.floor(y / m.cell) * m.cols + Math.floor(x / m.cell);
      if (m.kind[c] !== 1) continue;
      const d = lab[(y * width + x) * 3] - m.meanLab[c * 3];
      if (Math.abs(d) >= 0.25) { mask[y * width + x] = 1; if (d > 0) lighter++; else darker++; }
    }
  }
  const { comps } = pixelComponents(mask, width, height);
  const glyphs = comps.filter((g) => {
    const w = g.x1 - g.x0 + 1, h = g.y1 - g.y0 + 1;
    const fill = g.area / (w * h);
    return h >= 6 && h <= 80 && w <= 3 * h && g.area >= 12 && fill >= 0.1 && fill <= 0.85;
  });
  if (glyphs.length < 5) return { weight: null, weightRatio: null, size: null, glyphHeightPx1080: null, polarity: null, family: null, glyphs: glyphs.length, confidence: 0 };
  const strokes = glyphs.map((g) => (2 * g.area) / g.faces);
  const heights = glyphs.map((g) => g.y1 - g.y0 + 1);
  const ratios = glyphs.map((g, i) => strokes[i] / heights[i]);
  const ratio = median(ratios);
  const sorted = [...ratios].sort((a, b) => a - b);
  const iqr = sorted[Math.floor(sorted.length * 0.75)] - sorted[Math.floor(sorted.length * 0.25)];
  const h1080 = (median(heights) * 1080) / Math.min(width, height);
  const weight = ratio < 0.08 ? 'light' : ratio < 0.12 ? 'regular' : ratio < 0.17 ? 'bold' : 'black';
  const size = h1080 < 24 ? 'small' : h1080 < 40 ? 'medium' : h1080 < 72 ? 'large' : 'display';
  const conf = 0.8 * Math.min(1, glyphs.length / 40) * Math.max(0.2, 1 - iqr / Math.max(ratio, 1e-6));
  return {
    weight, weightRatio: Math.round(ratio * 1000) / 1000, size, glyphHeightPx1080: Math.round(h1080),
    polarity: lighter >= darker ? 'light-on-dark' : 'dark-on-light', family: null, glyphs: glyphs.length, confidence: r2(conf),
  };
}

/** Edge strength of a box's outline when it is a real panel (a card, a frame): every side has a continuous edge
 *  (at least 90 % of the middle 40 % of each side, within a pixel). A group of marks (a line of text, icons) has a
 *  broken outline and gives null, so its square bounding box never votes for "no radius". */
export function panelEdge(m, b) {
  const { width, height, grad } = m;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < 24 || h < 24 || b.x0 < 1 || b.y0 < 1 || b.x1 >= width || b.y1 >= height) return null;
  const at = (x, y) => Math.max(grad.mag[y * width + x], grad.mag[(y - 1) * width + x] ?? 0, grad.mag[(y + 1) * width + x] ?? 0, grad.mag[y * width + x - 1] ?? 0, grad.mag[y * width + x + 1] ?? 0);
  const vals = [];
  for (const [horiz, fixed] of [[true, b.y0], [true, b.y1 - 1], [false, b.x0], [false, b.x1 - 1]]) {
    const len = horiz ? w : h;
    const start = (horiz ? b.x0 : b.y0) + Math.round(len * 0.3), end = (horiz ? b.x0 : b.y0) + Math.round(len * 0.7);
    let on = 0, n = 0;
    for (let t = start; t < end; t++) {
      const v = horiz ? at(t, fixed) : at(fixed, t);
      n++; if (v >= 0.06) on++; vals.push(v);
    }
    if (!n || on / n < 0.9) return null;
  }
  return median(vals);
}

/** Corner radius from the corners of the content boxes (pixel boxes { x0, y0, x1, y1 }, x1/y1 exclusive).
 *  Sub-pixel: per corner, the two sides' boundaries are found where lightness crosses half way from the ground
 *  (4 px outside) to the panel's edge tone (the tone 0..4 px inside that differs most from the ground: the fill of a
 *  card or the line of an outlined one); then the same half-way crossing is found along the 45 degree diagonal from
 *  the corner those boundaries meet at, by bilinear sampling. A circular corner meets that diagonal at
 *  r (1 - 1/sqrt 2) per axis. */
export function cornerRadius(m, panels) {
  const { width, height, keyLab } = m;
  const toCanvas = 1080 / Math.min(width, height);
  const Lpx = (x, y) => keyLab[(Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 3];
  // bilinear lightness at a continuous point (pixel centres at i + 0.5)
  const Lat = (x, y) => {
    const fx = x - 0.5, fy = y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    return (Lpx(x0, y0) * (1 - ax) + Lpx(x0 + 1, y0) * ax) * (1 - ay) + (Lpx(x0, y0 + 1) * (1 - ax) + Lpx(x0 + 1, y0 + 1) * ax) * ay;
  };
  // distance to the first crossing of half way from `out` to `tone`, walking from (px, py) along (dx, dy) in steps
  // of 0.25 px (n steps at most); null when there is none
  const crossing = (px, py, dx, dy, out, tone, n) => {
    let prev = 0;
    for (let i = 0; i <= n; i++) {
      const d = i * 0.25;
      const t = (Lat(px + dx * d, py + dy * d) - out) / (tone - out);
      if (t >= 0.5) return i === 0 ? 0 : d - 0.25 + (0.25 * (0.5 - prev)) / (t - prev);
      prev = t;
    }
    return null;
  };
  const radii = [], rel = [];
  for (const b of panels) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (!panelEdge(m, b)) continue;
    const dMax = (Math.min(w, h) / 2) * K_DIAG + 2;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const ex = sx > 0 ? b.x0 : b.x1, ey = sy > 0 ? b.y0 : b.y1; // the box's outer boundary (pixel edges)
      const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
      const out = Lat(mx, ey - sy * 4);
      let tone = out;
      for (let d = 0.5; d <= 4; d += 0.5) { const v = Lat(mx, ey + sy * d); if (Math.abs(v - out) > Math.abs(tone - out)) tone = v; }
      if (Math.abs(tone - out) < 0.05) continue;
      const cy = crossing(mx, ey - sy * 4, 0, sy, out, tone, 40);
      const cx = crossing(ex - sx * 4, my, sx, 0, out, tone, 40);
      if (cy === null || cx === null) continue;
      const bx = ex - sx * 4 + sx * cx, by = ey - sy * 4 + sy * cy; // sub-pixel corner where the two boundaries meet
      const d = crossing(bx, by, sx * Math.SQRT1_2, sy * Math.SQRT1_2, out, tone, Math.ceil(dMax * Math.SQRT2 * 4));
      if (d === null) continue;
      // d runs along the diagonal; per axis it is d / sqrt 2. CORNER_BIAS: bilinear sampling at a convex corner reads
      // less than half coverage at the true boundary, so the crossing lands a little inside (measured on drawn
      // corners of radius 0..40 px, tests/scene-builder-reference.test.mjs).
      const r = Math.max(0, d * Math.SQRT1_2 - CORNER_BIAS) / K_DIAG;
      radii.push(r * toCanvas);
      rel.push(r / Math.min(w, h));
    }
  }
  if (radii.length < 2) return { px1080: null, class: null, corners: radii.length, confidence: 0 };
  const r = median(radii);
  const relMed = median(rel);
  const agree = radii.filter((v) => Math.abs(v - r) <= Math.max(3, 0.3 * r)).length / radii.length;
  const cls = relMed >= 0.45 ? 'pill' : r < 2 ? 'none' : r < 8 ? 'small' : r < 20 ? 'medium' : 'large';
  return { px1080: Math.round(r), class: cls, corners: radii.length, confidence: r2(agree * Math.min(1, radii.length / 8)) };
}

export const VIVID_L = 0.5, VIVID_C = 0.08;
/** Vivid marks (OKLab L >= VIVID_L, C >= VIVID_C) of at least 40 px outside the game: { comps, mask }. */
export function vividMarks(m, gamePx) {
  const { width, height, keyLab: lab } = m;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) if (lab[i * 3] >= VIVID_L && Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]) >= VIVID_C) mask[i] = 1;
  const { comps } = pixelComponents(mask, width, height);
  const inGame = (g) => gamePx && g.x0 >= gamePx.x0 && g.x1 < gamePx.x1 && g.y0 >= gamePx.y0 && g.y1 < gamePx.y1;
  return { comps: comps.filter((g) => g.area >= 40 && !inGame(g)), mask };
}

/** Glow: vivid marks whose colour fades out gradually around them. gamePx (or null) is skipped. */
export function glowUse(m, gamePx, vivid = vividMarks(m, gamePx)) {
  const { width, height, keyLab: lab } = m;
  const C = (i) => Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]);
  const H = (i) => hueDeg([0, lab[i * 3 + 1], lab[i * 3 + 2]]);
  const { comps: marks, mask } = vivid;
  let tested = 0, glowing = 0, strength = 0;
  const hues = [];
  for (const g of marks.slice(0, 400)) {
    const mx = Math.round((g.x0 + g.x1) / 2), my = Math.round((g.y0 + g.y1) / 2);
    const hue = (() => { const i = my * width + mx; return mask[i] ? H(i) : null; })() ?? H(g.y0 * width + Math.round((g.x0 + g.x1) / 2));
    let sides = 0, s = 0, seen = 0;
    for (const [sx, sy, x, y] of [[0, -1, mx, g.y0], [0, 1, mx, g.y1], [-1, 0, g.x0, my], [1, 0, g.x1, my]]) {
      const prof = [];
      for (let d = 1; d <= 14; d++) {
        const px = x + sx * d, py = y + sy * d;
        if (px < 0 || py < 0 || px >= width || py >= height) break;
        prof.push(py * width + px);
      }
      if (prof.length < 14) continue;
      seen++;
      const c = prof.map(C);
      const far = (c[11] + c[12] + c[13]) / 3;
      let same = 0;
      for (let d = 0; d < 6; d++) if (c[d] - far >= 0.015 && hueGap(H(prof[d]), hue) < 35) same++;
      const fading = c[0] > c[3] && c[3] >= c[6] - 0.005 && c[0] - far >= 0.03;
      if (same >= 3 && fading) { sides++; s += c[0] - far; }
    }
    if (seen < 2) continue;
    tested++;
    if (sides >= 2) { glowing++; strength += s / sides; hues.push(g); }
  }
  if (!tested) return { used: false, share: 0, colour: null, marks: 0, confidence: 0.3 };
  const share = glowing / tested;
  const used = glowing >= 1 && share >= 0.2;
  let colour = null;
  if (used) {
    const g = hues.reduce((a, b) => (b.area > a.area ? b : a));
    const i = Math.round((g.y0 + g.y1) / 2) * width + Math.round((g.x0 + g.x1) / 2);
    colour = hex(oklabToRgb(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]));
  }
  return {
    used, share: r2(share), strength: glowing ? Math.round((strength / glowing) * 1000) / 1000 : 0, colour, marks: tested,
    confidence: r2(Math.min(1, tested / 6) * (used ? 0.5 + share / 2 : 1 - share)),
  };
}

/** Shadow: content boxes with a darker band below them that lightens outward. */
export function shadowUse(m, panels) {
  const { width, height, keyLab: lab } = m;
  const L = (x, y) => lab[(y * width + x) * 3];
  let tested = 0, below = 0, around = 0, depth = 0;
  for (const b of panels) {
    const w = b.x1 - b.x0;
    if (b.y1 + 30 >= height || b.y0 - 30 < 0 || !panelEdge(m, b)) continue;
    const xs = [];
    for (let x = b.x0 + Math.round(w * 0.2); x < b.x1 - Math.round(w * 0.2); x += 2) xs.push(x);
    const rowMean = (y) => xs.reduce((a, x) => a + L(x, y), 0) / xs.length;
    const nearB = (rowMean(b.y1 + 2) + rowMean(b.y1 + 4) + rowMean(b.y1 + 6)) / 3;
    const midB = rowMean(b.y1 + 12);
    const farB = (rowMean(b.y1 + 26) + rowMean(b.y1 + 28)) / 2;
    const nearT = (rowMean(b.y0 - 3) + rowMean(b.y0 - 5)) / 2;
    const farT = (rowMean(b.y0 - 26) + rowMean(b.y0 - 28)) / 2;
    tested++;
    if (farB - nearB >= 0.03 && midB >= nearB - 0.005 && farB >= midB - 0.005) {
      below++; depth += farB - nearB;
      if (farT - nearT >= 0.03) around++;
    }
  }
  if (!tested) return { used: false, share: 0, offset: null, depth: 0, boxes: 0, confidence: 0.3 };
  const share = below / tested;
  const used = below >= 1 && share >= 0.25;
  return {
    used, share: r2(share), offset: used ? (around >= below / 2 ? 'around' : 'below') : null,
    depth: below ? Math.round((depth / below) * 1000) / 1000 : 0, boxes: tested,
    confidence: r2(Math.min(1, tested / 4) * (used ? 0.5 + share / 2 : 1 - share)),
  };
}

/** All style rules. */
export function styleOf(m, panels, gamePx) {
  const vivid = vividMarks(m, gamePx);
  // filled vivid marks (buttons, chips) are radius candidates too; panelEdge keeps only those with a whole outline
  const marks = vivid.comps.slice(0, 400).map((g) => ({ x0: g.x0, y0: g.y0, x1: g.x1 + 1, y1: g.y1 + 1 }));
  return { type: typeFeel(m), cornerRadius: cornerRadius(m, [...panels, ...marks]), glow: glowUse(m, gamePx, vivid), shadow: shadowUse(m, panels) };
}
