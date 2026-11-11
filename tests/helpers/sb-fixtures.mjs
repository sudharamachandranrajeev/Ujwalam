// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic reference fixtures for the scene builder tests (D339): simple drawn layouts whose slots, palette and
// style are known exactly. Drawn in memory with a seeded RNG and written as PNG (or an MP4 for the video case) with
// ffmpeg into a temp folder, so no picture is committed. Truth boxes are fractions of the canvas { x, y, w, h }.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export class Canvas {
  constructor(width, height) { this.width = width; this.height = height; this.rgb = Buffer.alloc(width * height * 3); }
  px(x, y, c, a = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 3;
    for (let k = 0; k < 3; k++) this.rgb[o + k] = Math.round(this.rgb[o + k] * (1 - a) + c[k] * a);
  }
  rect(x0, y0, x1, y1, c) { for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) this.px(x, y, c); }
  /** Fraction box -> pixel rectangle. */
  box(b) { return [b.x * this.width, b.y * this.height, (b.x + b.w) * this.width, (b.y + b.h) * this.height].map(Math.round); }
  // distance from (x, y) to a rounded rectangle (negative inside)
  static sdRound(x, y, x0, y0, x1, y1, r) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
    const qx = Math.abs(x + 0.5 - cx) - hx, qy = Math.abs(y + 0.5 - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  roundRect(b, r, c, { glow = 0, glowColour = c, shadow = 0 } = {}) {
    const [x0, y0, x1, y1] = this.box(b);
    const pad = Math.max(glow, shadow) + 4;
    for (let y = y0 - pad; y < y1 + pad; y++) {
      for (let x = x0 - pad; x < x1 + pad; x++) {
        if (shadow) { const d = Canvas.sdRound(x, y - Math.round(shadow / 2), x0, y0, x1, y1, r); if (d > 0 && d < shadow) this.px(x, y, [0, 0, 0], 0.45 * (1 - d / shadow) ** 2); }
        const d = Canvas.sdRound(x, y, x0, y0, x1, y1, r);
        if (d <= 0) this.px(x, y, c, Math.min(1, -d + 0.5));
        else if (d < 1) this.px(x, y, c, 1 - d);
        else if (glow && d < glow) this.px(x, y, glowColour, 0.7 * (1 - d / glow) ** 2);
      }
    }
  }
  vgradient(top, bottom) {
    for (let y = 0; y < this.height; y++) {
      const t = y / (this.height - 1);
      const c = top.map((v, k) => v + (bottom[k] - v) * t);
      for (let x = 0; x < this.width; x++) this.px(x, y, c);
    }
  }
  /** Game-like texture: many small blocks and lines of many hues. */
  texture(b, seed) {
    const r = rng(seed);
    const [x0, y0, x1, y1] = this.box(b);
    this.rect(x0, y0, x1, y1, [70, 80, 60]);
    const n = Math.round(((x1 - x0) * (y1 - y0)) / 30);
    for (let i = 0; i < n; i++) {
      const w = 2 + Math.floor(r() * 10), h = 2 + Math.floor(r() * 10);
      const x = x0 + Math.floor(r() * (x1 - x0 - w)), y = y0 + Math.floor(r() * (y1 - y0 - h));
      const c = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
      this.rect(x, y, x + w, y + h, c);
    }
  }
  /** Camera-like picture: textured room with a large face of varied skin tones. */
  camera(b, seed) {
    const r = rng(seed);
    const [x0, y0, x1, y1] = this.box(b);
    const n = Math.round(((x1 - x0) * (y1 - y0)) / 30);
    this.rect(x0, y0, x1, y1, [50, 45, 55]);
    for (let i = 0; i < n; i++) {
      const w = 2 + Math.floor(r() * 8), h = 2 + Math.floor(r() * 8);
      const x = x0 + Math.floor(r() * (x1 - x0 - w)), y = y0 + Math.floor(r() * (y1 - y0 - h));
      const v = 40 + Math.floor(r() * 120);
      this.rect(x, y, x + w, y + h, [v, Math.floor(v * (0.6 + r() * 0.6)), Math.floor(v * (0.5 + r() * 0.8))]);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) * 0.32, ry = (y1 - y0) * 0.42;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        const k = 0.85 + r() * 0.3;
        this.px(x, y, [Math.min(255, 225 * k), Math.min(255, 165 * k), Math.min(255, 130 * k)]);
      }
    }
    for (let i = 0; i < n / 6; i++) {
      const x = Math.round(cx - rx + r() * 2 * rx), y = Math.round(cy - ry + r() * 2 * ry);
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 0.8) continue;
      this.rect(x, y, x + 2, y + 2, [120, 70, 50]);
    }
  }
  /** Text lines: bars of lineH px with gaps, random lengths, inside box b with an inset. */
  text(b, colour, { lineH = 4, gap = 6, inset = 8, seed = 1 } = {}) {
    const r = rng(seed);
    const [x0, y0, x1, y1] = this.box(b);
    for (let y = y0 + inset; y + lineH <= y1 - inset; y += lineH + gap) {
      const len = (x1 - x0 - 2 * inset) * (0.5 + r() * 0.5);
      // words: bars broken by small gaps, like text
      for (let x = x0 + inset; x < x0 + inset + len;) {
        const wl = 6 + Math.floor(r() * 18);
        this.rect(x, y, Math.min(x + wl, x0 + inset + len), y + lineH, colour);
        x += wl + 4;
      }
    }
  }
}

/** The H layout fixture: truth slots, its palette colours and the style it was drawn with. */
export function layoutH({ width = 960, height = 540, seed = 7 } = {}) {
  const c = new Canvas(width, height);
  const bg = [18, 22, 40];
  c.vgradient(bg, [26, 30, 52]);
  const truth = {
    game: { x: 0.25, y: 0.16, w: 0.72, h: 0.66 },
    camera: { x: 0.02, y: 0.04, w: 0.2, h: 0.26 },
    chat: { x: 0.02, y: 0.36, w: 0.2, h: 0.46 },
    alerts: { x: 0.4, y: 0.025, w: 0.22, h: 0.09 },
    graphics: { x: 0.02, y: 0.88, w: 0.96, h: 0.08 },
  };
  c.texture(truth.game, seed);
  c.camera(truth.camera, seed + 1);
  // chat: 4 stacked cards with 2 lines each
  const card = [38, 46, 78], ink = [235, 238, 245];
  const ch = truth.chat, cardH = (ch.h - 3 * 0.02) / 4;
  for (let i = 0; i < 4; i++) {
    const b = { x: ch.x, y: ch.y + i * (cardH + 0.02), w: ch.w, h: cardH };
    c.roundRect(b, 8, card);
    c.text(b, ink, { lineH: 4, gap: 6, inset: 10, seed: seed + 10 + i });
  }
  c.roundRect(truth.alerts, 14, [255, 51, 102], { glow: 14, glowColour: [255, 51, 102] });
  c.text({ x: truth.alerts.x + 0.03, y: truth.alerts.y + 0.02, w: truth.alerts.w - 0.06, h: 0.05 }, ink, { lineH: 5, gap: 20, inset: 2, seed: seed + 3 });
  c.roundRect(truth.graphics, 6, [51, 204, 255]);
  c.text(truth.graphics, [10, 20, 40], { lineH: 5, gap: 30, inset: 14, seed: seed + 4 });
  return { canvas: c, kind: 'H', truth, palette: { background: '#121628', accent: '#ff3366', accentAlt: '#33ccff', text: '#ebeef5' }, radiusPx1080: 28, glow: true };
}

/** The V layout fixture (portrait). */
export function layoutV({ width = 540, height = 960, seed = 11 } = {}) {
  const c = new Canvas(width, height);
  c.vgradient([20, 18, 30], [30, 26, 44]);
  const truth = {
    game: { x: 0.03, y: 0.24, w: 0.94, h: 0.32 },
    camera: { x: 0.55, y: 0.03, w: 0.4, h: 0.17 },
    chat: { x: 0.04, y: 0.61, w: 0.6, h: 0.26 },
    alerts: { x: 0.05, y: 0.07, w: 0.42, h: 0.08 },
    graphics: { x: 0.03, y: 0.91, w: 0.94, h: 0.05 },
  };
  c.texture(truth.game, seed);
  c.camera(truth.camera, seed + 1);
  const card = [50, 44, 70], ink = [240, 236, 230];
  const ch = truth.chat, cardH = (ch.h - 3 * 0.012) / 4;
  for (let i = 0; i < 4; i++) {
    const b = { x: ch.x, y: ch.y + i * (cardH + 0.012), w: ch.w, h: cardH };
    c.roundRect(b, 6, card);
    c.text(b, ink, { lineH: 4, gap: 6, inset: 9, seed: seed + 10 + i });
  }
  c.roundRect(truth.alerts, 10, [255, 170, 0], { glow: 12, glowColour: [255, 170, 0] });
  c.roundRect(truth.graphics, 4, [120, 90, 255]);
  c.text(truth.graphics, ink, { lineH: 5, gap: 30, inset: 10, seed: seed + 4 });
  return { canvas: c, kind: 'V', truth };
}

/** Flat colour blocks with known shares (the palette truth). */
export function paletteBlocks({ width = 400, height = 300 } = {}) {
  const c = new Canvas(width, height);
  const colours = [
    { hex: '#1a2b3c', share: 0.6 },
    { hex: '#2e4057', share: 0.2 },
    { hex: '#ff3366', share: 0.1 },
    { hex: '#f0f0f0', share: 0.05 },
    { hex: '#33ccff', share: 0.05 },
  ];
  // vertical stripes of whole columns, so shares are exact (400 px wide: 240, 80, 40, 20, 20 columns)
  let x = 0;
  for (const col of colours) { const w = Math.round(col.share * width); c.rect(x, 0, x + w, height, hexRgb(col.hex)); x += w; }
  return { canvas: c, colours };
}

/** Panels for the style rules: rounded corners of a known radius, with or without glow and drop shadow, on a flat
 *  ground, and glyph-like marks of a known stroke weight. */
export function stylePanels({ width = 960, height = 540, radius = 24, glow = false, shadow = false, light = false, stroke = 3 } = {}) {
  const c = new Canvas(width, height);
  const ground = light ? [236, 238, 242] : [16, 18, 26];
  c.rect(0, 0, width, height, ground);
  const fill = light ? [255, 255, 255] : [40, 60, 110];
  const accent = [0, 210, 200];
  const boxes = [
    { x: 0.06, y: 0.1, w: 0.26, h: 0.3 }, { x: 0.38, y: 0.1, w: 0.26, h: 0.3 }, { x: 0.7, y: 0.1, w: 0.24, h: 0.3 },
  ];
  for (const b of boxes) c.roundRect(b, radius, glow ? accent : fill, { glow: glow ? 16 : 0, glowColour: accent, shadow: shadow ? 18 : 0 });
  // glyphs: "I L O E" shapes of height 28 px and the given stroke, in rows across the lower half
  const ink = light ? [20, 22, 30] : [235, 238, 245];
  const gh = 28, gw = 18;
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 18; i++) {
      const x = Math.round(width * 0.06) + i * (gw + 12), y = Math.round(height * 0.55) + row * (gh + 20);
      const shape = i % 4;
      if (shape === 0) c.rect(x + gw / 2 - stroke / 2, y, x + gw / 2 + stroke / 2, y + gh, ink);
      if (shape === 1) { c.rect(x, y, x + stroke, y + gh, ink); c.rect(x, y + gh - stroke, x + gw, y + gh, ink); }
      if (shape === 2) { c.rect(x, y, x + gw, y + stroke, ink); c.rect(x, y + gh - stroke, x + gw, y + gh, ink); c.rect(x, y, x + stroke, y + gh, ink); c.rect(x + gw - stroke, y, x + gw, y + gh, ink); }
      if (shape === 3) { c.rect(x, y, x + stroke, y + gh, ink); for (const yy of [y, y + gh / 2 - stroke / 2, y + gh - stroke]) c.rect(x, yy, x + gw, yy + stroke, ink); }
    }
  }
  return { canvas: c, radius, glow, shadow, light, stroke, glyphHeight: gh };
}

/** Writes a canvas as a PNG (ffmpeg, hidden) and returns the path. */
export function writePng(canvas, dir, name) {
  const raw = path.join(dir, `${name}.rgb`);
  writeFileSync(raw, canvas.rgb);
  const out = path.join(dir, `${name}.png`);
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${canvas.width}x${canvas.height}`,
    '-i', raw, '-frames:v', '1', out], { windowsHide: true, stdio: 'ignore' });
  return out;
}

/** Writes canvases as frames of an MP4 at `fps` (MPEG-4 part 2, high quality) and returns the path. */
export function writeVideo(canvases, dir, name, fps = 2) {
  const raw = path.join(dir, `${name}.rgb`);
  writeFileSync(raw, Buffer.concat(canvases.map((c) => c.rgb)));
  const out = path.join(dir, `${name}.mp4`);
  const { width, height } = canvases[0];
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps),
    '-i', raw, '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p', out], { windowsHide: true, stdio: 'ignore' });
  return out;
}
