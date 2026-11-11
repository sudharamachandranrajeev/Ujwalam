// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB2 palette (D339), by the build plan's §4.6 method: pixels of every sampled frame clustered with
// seeded k-means++ in OKLab (colour.mjs), near-identical clusters merged, then five generic roles solved from the
// clusters with provenance (extracted: a cluster as it is; derived: a cluster moved, e.g. to clear WCAG contrast).
// The roles are generic (background, surface, text, accent, accentAlt); SB4 maps them onto the theme schema's tokens.
// A picture with no second accent hue gives accentAlt null rather than an invented colour.

import { chroma, contrast, deltaE, forceContrast, hueDeg, hueGap, kmeans, labHex, oklabToRgb, rgbToOklab } from './colour.mjs';

export const PALETTE_K = 8;
export const MAX_SAMPLES = 24000;
export const MERGE_DE = 0.03;   // clusters closer than this (OKLab distance) are one colour
const MIN_SHARE = 0.005;        // a role colour covers at least 0.5 % of the picture

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Evenly strided pixel sample of all frames, as OKLab triples. */
export function samplePixels(frames, max = MAX_SAMPLES) {
  const total = frames.reduce((a, f) => a + f.width * f.height, 0);
  const stride = Math.max(1, Math.floor(total / max));
  const out = [];
  let k = 0;
  for (const f of frames) {
    const n = f.width * f.height;
    for (let i = (stride - (k % stride)) % stride; i < n; i += stride) {
      const o = i * 3;
      out.push(rgbToOklab(f.rgb[o] / 255, f.rgb[o + 1] / 255, f.rgb[o + 2] / 255));
    }
    k += n;
  }
  return out;
}

/** Merge clusters closer than MERGE_DE (share-weighted mean), largest first. */
export function mergeClusters(cs, limit = MERGE_DE) {
  const out = [];
  for (const c of cs) {
    const hit = out.find((o) => deltaE(o.lab, c.lab) < limit);
    if (!hit) { out.push({ lab: [...c.lab], share: c.share }); continue; }
    const s = hit.share + c.share;
    hit.lab = hit.lab.map((v, i) => (v * hit.share + c.lab[i] * c.share) / s);
    hit.share = s;
  }
  return out.sort((a, b) => b.share - a.share);
}

/** SB2 palette of the frames: { k, clusters: [{ hex, share, L, C, h }], roles: { <role>: { hex, how, why } | null }, contrast }. */
export function paletteOf(frames, { k = PALETTE_K } = {}) {
  const labs = samplePixels(frames);
  const cs = mergeClusters(kmeans(labs, k));
  const usable = cs.filter((c) => c.share >= MIN_SHARE);
  const top = (arr, f) => (arr.length ? arr.reduce((a, c) => (f(c) > f(a) ? c : a)) : null);
  const bg = usable[0] ?? cs[0];
  const bgRgb = oklabToRgb(...bg.lab);
  const roles = {};
  const P = (lab, how, why) => ({ hex: labHex(lab), how, why });
  roles.background = P(bg.lab, 'extracted', `largest cluster (${(bg.share * 100).toFixed(1)} %)`);
  // surface: the next largest quiet colour near the background's lightness (a panel or card fill)
  const surf = top(usable.filter((c) => c !== bg && chroma(c.lab) < 0.06 && Math.abs(c.lab[0] - bg.lab[0]) <= 0.3), (c) => c.share);
  roles.surface = surf ? P(surf.lab, 'extracted', 'largest quiet cluster near the background')
    : P([Math.min(1, Math.max(0, bg.lab[0] + (bg.lab[0] < 0.5 ? 0.06 : -0.06))), bg.lab[1], bg.lab[2]], 'derived', 'background, one step toward the middle');
  // text: the cluster that stands out most from the background, neutral colours preferred (text is rarely vivid),
  // pushed to WCAG 4.5:1 if it does not already
  const txt = top(usable.filter((c) => c !== bg), (c) => contrast(oklabToRgb(...c.lab), bgRgb) - chroma(c.lab) * 10);
  if (txt) {
    const pushed = forceContrast(txt.lab, bgRgb, 4.5, bg.lab[0] < 0.5);
    roles.text = pushed === txt.lab ? P(txt.lab, 'extracted', 'highest-contrast cluster on the background')
      : P(pushed, 'derived', `highest-contrast cluster, lightness moved ${(pushed[0] - txt.lab[0]).toFixed(2)} to clear 4.5:1`);
  } else roles.text = null;
  // accents: the most chromatic clusters; the second must differ in hue by at least 60 degrees
  const vivid = usable.filter((c) => chroma(c.lab) >= 0.08);
  const acc = top(vivid, (c) => chroma(c.lab) + Math.min(c.share, 0.2));
  roles.accent = acc ? P(acc.lab, 'extracted', 'most chromatic cluster') : null;
  const alt = acc ? top(vivid.filter((c) => c !== acc && hueGap(hueDeg(c.lab), hueDeg(acc.lab)) >= 60), (c) => chroma(c.lab) + Math.min(c.share, 0.2)) : null;
  roles.accentAlt = alt ? P(alt.lab, 'extracted', `second chromatic cluster, hue ${Math.round(hueGap(hueDeg(alt.lab), hueDeg(acc.lab)))} deg from accent`) : null;
  const hexRgbN = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return {
    k,
    clusters: cs.map((c) => ({ hex: labHex(c.lab), share: r3(c.share), L: r3(c.lab[0]), C: r3(chroma(c.lab)), h: Math.round(hueDeg(c.lab)) })),
    roles,
    contrast: { textOnBackground: roles.text ? Math.round(contrast(hexRgbN(roles.text.hex), bgRgb) * 100) / 100 : null },
  };
}
