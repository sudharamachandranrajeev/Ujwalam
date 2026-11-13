// SPDX-License-Identifier: GPL-3.0-or-later
// Realism grade LUT (D381): writes data/luts/realism-filmic.cube, our own 33 x 33 x 33 colour look-up table for OBS's
// clut_filter (layer effect "lut", base "luts"). Deterministic: only + - * / on doubles and toFixed(6), so the same
// Node writes the same bytes; tests/realism-look.test.mjs checks the committed file against this script.
//
//   node tools/make-realism-lut.mjs          writes the file
//   node tools/make-realism-lut.mjs --check  exit 1 when the committed file differs
//
// The look, in order, on display-referred RGB 0..1:
//   1. tame over-saturated game colours: the most saturated colours lose up to 18 % of their chroma, greys keep theirs
//   2. gentle filmic S-curve (a quarter of smoothstep: more mid-tone contrast) with a tiny black lift (0.01)
//   3. highlight roll-off above 0.75 (Reinhard-style shoulder, slope 1 at the knee, white lands at 0.97)
//   4. split tone: slightly cool shadows, slightly warm highlights (at most 1.2 % per channel)
// Format: Adobe .cube 1.0, LUT_3D_SIZE 33, red changes fastest, LF line endings, no comments or TITLE line (kept to the
// lines every .cube reader takes).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZE = 33;
export const LUT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'luts', 'realism-filmic.cube');

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const KNEE = 0.75;
const SHOULDER = 1.8333333333; // KNEE + (1 - KNEE) / (1 + (1 - KNEE) / SHOULDER) = 0.97
const LIFT = 0.01;

/** One channel through the S-curve, the lift and the shoulder. */
export function tone(x) {
  let y = x + 0.25 * (x * x * (3 - 2 * x) - x); // a quarter of the way to smoothstep
  y = LIFT + y * (1 - LIFT);
  if (y > KNEE) y = KNEE + (y - KNEE) / (1 + (y - KNEE) / SHOULDER);
  return y;
}

/** The whole look for one RGB triple (0..1 in, 0..1 out). */
export function grade(r, g, b) {
  // 1. saturation tame
  const l0 = luma(r, g, b);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const keep = 1 - 0.18 * smooth(0.35, 1, chroma);
  r = l0 + (r - l0) * keep; g = l0 + (g - l0) * keep; b = l0 + (b - l0) * keep;
  // 2 + 3. tone curve per channel
  r = tone(clamp01(r)); g = tone(clamp01(g)); b = tone(clamp01(b));
  // 4. split tone by the graded luma
  const l = clamp01(luma(r, g, b));
  const hi = l * l, sh = (1 - l) * (1 - l);
  r += 0.012 * hi - 0.008 * sh;
  g += 0.003 * hi - 0.001 * sh;
  b += -0.012 * hi + 0.012 * sh;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** The .cube text. */
export function cubeText(size = SIZE) {
  const out = [`LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const n = size - 1;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        out.push(grade(ri / n, gi / n, bi / n).map((v) => v.toFixed(6)).join(' '));
      }
    }
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = cubeText();
  if (process.argv.includes('--check')) {
    let cur = null;
    try { cur = readFileSync(LUT_FILE, 'utf8'); } catch { cur = null; }
    if (cur !== text) { console.error(`${path.relative(process.cwd(), LUT_FILE)} differs from tools/make-realism-lut.mjs`); process.exit(1); }
    console.log('realism LUT up to date');
  } else {
    mkdirSync(path.dirname(LUT_FILE), { recursive: true });
    writeFileSync(LUT_FILE, text);
    console.log(`wrote ${path.relative(process.cwd(), LUT_FILE)} (${SIZE}^3 entries)`);
  }
}
