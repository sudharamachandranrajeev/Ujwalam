// SPDX-License-Identifier: GPL-3.0-or-later
// Pixel and cell measurements the scene builder's rules read (D339). Pure functions over rgb24 frames; no I/O.
//
// Per pixel: OKLab, the lightness gradient (central differences) and a skin-tone test.
// Per cell (a square of about 1/48 of the long side): edge share, number of distinct colours, mean colour, skin share
// and, for a video, motion (mean lightness change between samples). Each cell is then one of:
//   busy - textured, many colours (game footage, photos, a camera picture)
//   ui   - sharp edges but few colours (text, lines, panel borders)
//   soft - few edges (flat fills, blurred backgrounds, gradients)

import { bytesToOklab } from './colour.mjs';

export const CELLS_LONG = 48;
export const EDGE_T = 0.08;      // |grad L| (OKLab L, central difference) that counts as an edge pixel
export const BUSY_EDGE = 0.10;   // a busy cell has at least this share of edge pixels ...
export const BUSY_DISTINCT = 4;  // ... and at least this many distinct colours
export const SOFT_EDGE = 0.04;   // a soft cell has less than this share of edge pixels
export const MOTION_T = 0.03;    // mean |dL| between video samples that marks a moving cell (evidence only)

/** OKLab of every pixel: Float32Array(width*height*3). */
export function frameLab(frame) {
  const { width, height, rgb } = frame;
  const n = width * height;
  const out = new Float32Array(n * 3);
  const tmp = [0, 0, 0];
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    bytesToOklab(rgb[o], rgb[o + 1], rgb[o + 2], tmp, 0);
    out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2];
  }
  return out;
}

/** Lightness gradient: { gx, gy, mag } Float32Arrays (central differences; 0 on the border). */
export function gradient(lab, width, height) {
  const n = width * height;
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = lab[(i + 1) * 3] - lab[(i - 1) * 3];
      const dy = lab[(i + width) * 3] - lab[(i - width) * 3];
      gx[i] = dx; gy[i] = dy; mag[i] = Math.hypot(dx, dy);
    }
  }
  return { gx, gy, mag };
}

/** Skin-tone test on bytes (a common RGB rule; coarse on purpose, used only as one vote among several). */
export const isSkin = (r, g, b) => r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 && Math.max(r, g, b) - Math.min(r, g, b) > 15 && r - b > 30;

/** |grad L| at pixel i = (x, y), the same central difference as gradient() (0 on the border), without its arrays. */
function edgeMag(lab, width, height, i, x, y) {
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return 0;
  return Math.hypot(lab[(i + 1) * 3] - lab[(i - 1) * 3], lab[(i + width) * 3] - lab[(i - width) * 3]);
}

/** All per-pixel and per-cell measurements of a list of same-size frames. The middle frame is the "key" frame that
 *  pixel-level rules (edges, boxes, style) read. Frames are measured one at a time: only the key frame keeps its
 *  OKLab and gradient arrays, and motion needs only the previous frame's lightness (Codex review of D339: memory
 *  stays near one frame's measurements plus the rgb input, whatever the number of samples). */
export function measure(frames) {
  const { width, height } = frames[0];
  const keyIndex = Math.floor((frames.length - 1) / 2);
  const key = frames[keyIndex];
  let keyLab = null, grad = null;
  const cell = Math.max(4, Math.round(Math.max(width, height) / CELLS_LONG));
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const nc = cols * rows;
  const edge = new Float32Array(nc), distinct = new Float32Array(nc), skin = new Float32Array(nc), motion = new Float32Array(nc);
  const meanLab = new Float32Array(nc * 3), area = new Float32Array(nc);
  let prevL = null;
  for (let f = 0; f < frames.length; f++) {
    const rgb = frames[f].rgb;
    const lab = frameLab(frames[f]);
    const g = f === keyIndex ? gradient(lab, width, height) : null;
    if (g) { keyLab = lab; grad = g; }
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cy * cols + cx;
        const bins = new Map();
        let n = 0, e = 0, sk = 0, L = 0, A = 0, B = 0, mo = 0;
        for (let y = cy * cell; y < Math.min(height, (cy + 1) * cell); y++) {
          for (let x = cx * cell; x < Math.min(width, (cx + 1) * cell); x++) {
            const i = y * width + x, o = i * 3;
            n++;
            if ((g ? g.mag[i] : edgeMag(lab, width, height, i, x, y)) >= EDGE_T) e++;
            if (isSkin(rgb[o], rgb[o + 1], rgb[o + 2])) sk++;
            L += lab[o]; A += lab[o + 1]; B += lab[o + 2];
            const bin = (Math.floor(lab[o] * 10) * 64 + Math.floor((lab[o + 1] + 0.4) / 0.04)) * 64 + Math.floor((lab[o + 2] + 0.4) / 0.04);
            bins.set(bin, (bins.get(bin) ?? 0) + 1);
            if (prevL) mo += Math.abs(lab[o] - prevL[i]);
          }
        }
        let d = 0;
        for (const v of bins.values()) if (v >= 0.04 * n) d++;
        edge[c] += e / n; distinct[c] += d; skin[c] += sk / n;
        meanLab[c * 3] += L / n; meanLab[c * 3 + 1] += A / n; meanLab[c * 3 + 2] += B / n;
        if (f > 0) motion[c] += mo / n;
        area[c] = n;
      }
    }
    if (f < frames.length - 1) {
      prevL ??= new Float32Array(width * height);
      for (let i = 0; i < width * height; i++) prevL[i] = lab[i * 3];
    }
  }
  const F = frames.length;
  for (let c = 0; c < nc; c++) {
    edge[c] /= F; distinct[c] /= F; skin[c] /= F;
    meanLab[c * 3] /= F; meanLab[c * 3 + 1] /= F; meanLab[c * 3 + 2] /= F;
    if (F > 1) motion[c] /= F - 1;
  }
  const kind = new Uint8Array(nc); // 0 soft, 1 ui, 2 busy
  for (let c = 0; c < nc; c++) {
    // Motion is not a class: chat text and a camera change between samples too. It is evidence for the game slot.
    if (edge[c] >= BUSY_EDGE && distinct[c] >= BUSY_DISTINCT) kind[c] = 2;
    else if (edge[c] < SOFT_EDGE) kind[c] = 0;
    else kind[c] = 1;
  }
  return { width, height, frames: F, key, keyLab, grad, cell, cols, rows, edge, distinct, skin, motion, meanLab, kind };
}

/** Pixel rectangle of a cell rectangle { c0, r0, c1, r1 } (inclusive cells). */
export function cellsToPx(m, r) {
  return { x0: r.c0 * m.cell, y0: r.r0 * m.cell, x1: Math.min(m.width, (r.c1 + 1) * m.cell), y1: Math.min(m.height, (r.r1 + 1) * m.cell) };
}

/** Pixel box -> { x, y, w, h } as fractions of the frame, 4 decimals. */
export function toFraction(m, b) {
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(b.x0 / m.width), y: r(b.y0 / m.height), w: r((b.x1 - b.x0) / m.width), h: r((b.y1 - b.y0) / m.height) };
}

/** Moves each side of pixel box b to the strongest straight edge within `reach` px (the line whose mean gradient
 *  across it is highest), when that line is clearly stronger than the box's typical edge (2x the median line). */
export function snapToEdges(m, b, reach) {
  const { width, height, grad } = m;
  const line = (horiz, pos, from, to) => {
    if (pos < 1 || pos >= (horiz ? height : width) - 1) return 0;
    let s = 0, n = 0;
    for (let t = from; t < to; t++) {
      const i = horiz ? pos * width + t : t * width + pos;
      s += Math.abs(horiz ? grad.gy[i] : grad.gx[i]); n++;
    }
    return n ? s / n : 0;
  };
  const best = (horiz, around, from, to, lo, hi) => {
    const vals = [];
    for (let p = Math.max(lo, around - reach); p <= Math.min(hi, around + reach); p++) vals.push([p, line(horiz, p, from, to)]);
    if (!vals.length) return around;
    const sorted = vals.map((v) => v[1]).sort((a, b2) => a - b2);
    const med = sorted[Math.floor(sorted.length / 2)];
    const top = vals.reduce((a, v) => (v[1] > a[1] ? v : a));
    return top[1] >= Math.max(0.01, 2 * med) ? top[0] : around;
  };
  const ix0 = Math.round(b.x0 + (b.x1 - b.x0) * 0.15), ix1 = Math.round(b.x1 - (b.x1 - b.x0) * 0.15);
  const iy0 = Math.round(b.y0 + (b.y1 - b.y0) * 0.15), iy1 = Math.round(b.y1 - (b.y1 - b.y0) * 0.15);
  // An edge between rows y-1 and y shows on both rows with central differences; the box's first row is the inner one.
  const y0 = best(true, b.y0, ix0, ix1, 0, height - 1);
  const y1 = best(true, b.y1 - 1, ix0, ix1, 0, height - 1) + 1;
  const x0 = best(false, b.x0, iy0, iy1, 0, width - 1);
  const x1 = best(false, b.x1 - 1, iy0, iy1, 0, width - 1) + 1;
  return x1 - x0 > 4 && y1 - y0 > 4 ? { x0, y0, x1, y1 } : b;
}

/** Connected components (8-neighbour) of a Uint8Array mask over a cols x rows grid. Returns [{ cells: [idx], c0, r0, c1, r1 }]. */
export function components(mask, cols, rows) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = { cells: [], c0: Infinity, r0: Infinity, c1: -1, r1: -1 };
    const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      const cx = i % cols, cy = (i - cx) / cols;
      comp.cells.push(i);
      comp.c0 = Math.min(comp.c0, cx); comp.c1 = Math.max(comp.c1, cx); comp.r0 = Math.min(comp.r0, cy); comp.r1 = Math.max(comp.r1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    out.push(comp);
  }
  return out;
}
