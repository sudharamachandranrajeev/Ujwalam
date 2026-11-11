// SPDX-License-Identifier: GPL-3.0-or-later
// Colour maths for the scene builder (D339): the build plan's §4.6 "Theme from media" method, ported from the legacy
// reference tool (tools/theme-from-media.mjs in legacy/): OKLab conversion, seeded k-means++ in OKLab, WCAG relative
// luminance and contrast, and the lightness push that clears a contrast target while keeping hue and chroma.
// OKLab because its distance matches what the eye calls "the same colour" far better than RGB distance does.

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** r, g, b in 0..1 sRGB -> [L, a, b] OKLab. */
export function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** OKLab -> 0..1 sRGB, clamped. */
export function oklabToRgb(L, a, bb) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)].map((c) => Math.min(1, Math.max(0, c)));
}

// sRGB byte -> OKLab, cached per 0..255 triple would be 16M entries; a linear-light table per channel is enough.
const LIN = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
/** Bytes 0..255 -> OKLab into out[o..o+2] (fast path for whole frames). */
export function bytesToOklab(r, g, b, out, o) {
  const lr = LIN[r], lg = LIN[g], lb = LIN[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

export const chroma = ([, a, b]) => Math.hypot(a, b);
export const hueDeg = ([, a, b]) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
export const hueGap = (h1, h2) => { const d = Math.abs(h1 - h2) % 360; return d > 180 ? 360 - d : d; };
export const deltaE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
export const hex = (rgb) => '#' + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const labHex = (lab) => hex(oklabToRgb(...lab));
export const hexLab = (h) => rgbToOklab(...hexToRgb(h));

// WCAG relative luminance and contrast, on 0..1 sRGB.
export const lum = ([r, g, b]) => 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
export const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

/** Move a colour's OKLab lightness until it clears `target` contrast against `groundRgb`. Hue and chroma are kept.
 *  Returns the best reachable colour when the target cannot be met. */
export function forceContrast(lab, groundRgb, target, preferLighter) {
  let best = lab, bestC = contrast(oklabToRgb(...lab), groundRgb);
  if (bestC >= target) return lab;
  for (const dir of preferLighter ? [1, -1] : [-1, 1]) {
    for (let step = 1; step <= 100; step++) {
      const L = Math.min(1, Math.max(0, lab[0] + dir * step * 0.01));
      const cand = [L, lab[1], lab[2]];
      const c = contrast(oklabToRgb(...cand), groundRgb);
      if (c > bestC) { bestC = c; best = cand; }
      if (c >= target) return cand;
      if (L === 0 || L === 1) break;
    }
  }
  return best;
}

/** Seeded k-means++ in OKLab. labs: array of [L, a, b]. Returns [{ lab, share }] sorted by share, empty ones dropped.
 *  k-means++ seeding: plain random seeding loses small but important regions (a rim light, an accent), which are
 *  exactly the colours a theme needs. Same input and seed -> same result. */
export function kmeans(labs, k, seed = 20260928) {
  if (!labs.length) return [];
  k = Math.max(1, Math.min(k, labs.length));
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const centres = [labs[Math.floor(rnd() * labs.length)]];
  const near = labs.map((p) => d2(p, centres[0]));
  while (centres.length < k) {
    const total = near.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let t = rnd() * total;
    let idx = near.findIndex((d) => (t -= d) <= 0);
    if (idx < 0) idx = labs.length - 1;
    centres.push(labs[idx]);
    for (let i = 0; i < labs.length; i++) near[i] = Math.min(near[i], d2(labs[i], labs[idx]));
  }
  const assign = new Int32Array(labs.length).fill(-1);
  for (let iter = 0; iter < 40; iter++) {
    let moved = 0;
    for (let i = 0; i < labs.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centres.length; c++) { const d = d2(labs[i], centres[c]); if (d < bd) { bd = d; bi = c; } }
      if (assign[i] !== bi) { assign[i] = bi; moved++; }
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < labs.length; i++) { const x = sums[assign[i]]; x[0] += labs[i][0]; x[1] += labs[i][1]; x[2] += labs[i][2]; x[3]++; }
    for (let c = 0; c < centres.length; c++) if (sums[c][3]) centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    if (!moved) break;
  }
  const counts = centres.map(() => 0);
  for (const a of assign) counts[a]++;
  return centres.map((lab, i) => ({ lab, share: counts[i] / labs.length })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
}
