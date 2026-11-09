#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Draws the Ujwalam app icon procedurally (stdlib only) and writes:
//   app/studio/res/ujwalam.svg            source vector (same geometry as the raster)
//   app/studio/res/ujwalam.ico            16 20 24 32 40 48 64 256, PNG entries
//   app/studio/res/png/ujwalam-<n>.png    sizes the Qt window icon embeds (qrc)
//   ui/favicon.svg                        favicon of the web control page
//   node tools/make-icon.mjs [--out <dir>]   (--out: write only the .ico and PNGs there, for tests)
// Mark: violet rounded-square tile (theme violet-night accent family) with a bright four-point spark ("Ujwalam" =
// radiant). Output is deterministic: running it twice gives identical bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const ICO_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 256]);
export const QT_PNG_SIZES = Object.freeze([16, 24, 32, 48, 64, 256]);
const TOP = [0xa4, 0x72, 0xff], BOT = [0x6a, 0x38, 0xd6]; // tile gradient (accentHi-ish to deeper violet)
const STAR_P = 0.6, STAR_R = 0.36; // |x|^p + |y|^p <= R^p, centred, tile coords -0.5..0.5
const TILE_INSET = 0.03, TILE_RADIUS = 0.22;

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Colour + coverage of one sample at (x, y) in -0.5..0.5: [r, g, b, a], a 0..1.
function sample(x, y) {
  const h = 0.5 - TILE_INSET, r = TILE_RADIUS;
  const qx = Math.abs(x) - (h - r), qy = Math.abs(y) - (h - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  if (d > 0) return [0, 0, 0, 0];
  const t = clamp01(y + 0.5);
  let c = [mix(TOP[0], BOT[0], t), mix(TOP[1], BOT[1], t), mix(TOP[2], BOT[2], t)];
  const rad = Math.hypot(x, y);
  const glow = clamp01(1 - rad / 0.46) ** 2 * 0.55; // soft halo behind the spark
  c = c.map((v) => mix(v, 255, glow * 0.6));
  const s = Math.abs(x) ** STAR_P + Math.abs(y) ** STAR_P;
  if (s <= STAR_R ** STAR_P) {
    const k = clamp01(rad / STAR_R); // white core to pale gold at the tips
    c = [255, mix(255, 226, k), mix(255, 150, k)];
  }
  return [c[0], c[1], c[2], 1];
}

export function render(size) {
  const ss = size >= 64 ? 3 : 6; // samples per axis per pixel
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
      const [r, g, b, a] = sample((i + (si + 0.5) / ss) / size - 0.5, (j + (sj + 0.5) / ss) / size - 0.5);
      R += r * a; G += g * a; B += b * a; A += a;
    }
    const o = (j * size + i) * 4, n = ss * ss;
    px[o] = A ? Math.round(R / A) : 0; px[o + 1] = A ? Math.round(G / A) : 0; px[o + 2] = A ? Math.round(B / A) : 0;
    px[o + 3] = Math.round((A / n) * 255);
  }
  return px;
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export function ico(entries) { // entries: [{ size, data }]
  const head = Buffer.alloc(6 + 16 * entries.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let off = head.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    head[o] = e.size >= 256 ? 0 : e.size; head[o + 1] = e.size >= 256 ? 0 : e.size;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(e.data.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

export function svg() {
  const pts = [];
  const n = 48, f = (v) => (v * 256 + 128).toFixed(2); // viewBox 0 0 256 256
  for (let i = 0; i < 4 * n; i++) { // same implicit curve as the raster, sampled by angle
    const a = (i / (4 * n)) * 2 * Math.PI;
    const c = Math.cos(a), s = Math.sin(a);
    const rr = STAR_R * (Math.abs(c) ** STAR_P + Math.abs(s) ** STAR_P) ** (-1 / STAR_P);
    pts.push(`${f(rr * c)},${f(rr * s)}`);
  }
  const h = (0.5 - TILE_INSET) * 256, r = TILE_RADIUS * 256;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<!-- SPDX-License-Identifier: GPL-3.0-or-later. Ujwalam app icon; generated by tools/make-icon.mjs -->
<defs>
<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a472ff"/><stop offset="1" stop-color="#6a38d6"/></linearGradient>
<radialGradient id="g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffe296"/></radialGradient>
</defs>
<rect x="${(128 - h).toFixed(2)}" y="${(128 - h).toFixed(2)}" width="${(2 * h).toFixed(2)}" height="${(2 * h).toFixed(2)}" rx="${r.toFixed(2)}" fill="url(#t)"/>
<circle cx="128" cy="128" r="118" fill="url(#g)"/>
<polygon points="${pts.join(' ')}" fill="url(#s)"/>
</svg>
`;
}

export function build() {
  const bySize = new Map();
  for (const s of new Set([...ICO_SIZES, ...QT_PNG_SIZES])) bySize.set(s, png(s, render(s)));
  return { bySize, ico: ico(ICO_SIZES.map((s) => ({ size: s, data: bySize.get(s) }))), svg: svg() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const oi = process.argv.indexOf('--out');
  const b = build();
  if (oi > 0) {
    const out = path.resolve(process.argv[oi + 1]); mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'ujwalam.ico'), b.ico);
    for (const s of QT_PNG_SIZES) writeFileSync(path.join(out, `ujwalam-${s}.png`), b.bySize.get(s));
    console.log(`wrote ${out}`);
  } else {
    const res = path.join(repo, 'app', 'studio', 'res');
    mkdirSync(path.join(res, 'png'), { recursive: true });
    writeFileSync(path.join(res, 'ujwalam.ico'), b.ico);
    writeFileSync(path.join(res, 'ujwalam.svg'), b.svg);
    writeFileSync(path.join(repo, 'ui', 'favicon.svg'), b.svg);
    for (const s of QT_PNG_SIZES) writeFileSync(path.join(res, 'png', `ujwalam-${s}.png`), b.bySize.get(s));
    console.log(`wrote ${res} and ui/favicon.svg`);
  }
}
