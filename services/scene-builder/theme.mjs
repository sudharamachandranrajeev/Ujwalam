// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB4 (D345): a studio theme from a reference. The same typed read SB2 makes (read.mjs: palette roles,
// type feel, corner radius, glow and shadow) becomes a full theme pack in the data/themes format (schema v2, D336):
// palette roles map to colour tokens, the style read picks the component variants, and every colour says where it
// came from. No colour is invented: a token the read did not give is derived from read colours (a lightness step, a
// mix, or for danger and ok the semantic hue at the accent's lightness and chroma when the picture has no red or
// green) and then pushed with the §4.6 contrast maths (colour.mjs) until the pack passes the T1 contrast check
// (services/studio-ui/theme-contrast.mjs: text 4.5:1, controls and focus 3:1, every state). Every push is reported.
//
// Output is data: themeFromRead() returns the pack and its report; writeThemePack() saves it to a user themes folder
// the studio loads custom packs from, never over a file and never with the id of a built-in pack.

import { existsSync, linkSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairs } from '../studio-ui/theme-contrast.mjs';
import { chroma, contrast, deltaE, forceContrastAll, hexLab, hexToRgb, hueGap, labHex } from './colour.mjs';

export const TOOL_VERSION = 1;
export const BUILTIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'themes');
export const MIN_CONFIDENCE = 0.5; // a style answer below this keeps the base look of the components it would pick
const TEXT = 4.5, CTRL = 3;
const HUE = { danger: 29, ok: 142 }; // OKLab hue of a plain red and a plain green (the semantic convention)
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rgb = (h) => hexToRgb(h);
const ratio = (a, b) => Math.round(contrast(rgb(a), rgb(b)) * 100) / 100;
const lab = (h) => hexLab(h);
const fromLCh = (L, C, h) => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
/** OKLab mix a + (b - a) * t. */
const mixLab = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** The ids of the built-in packs (data/themes, the same files the studio embeds). */
export function builtinIds(dir = BUILTIN_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => f.slice(0, -5));
}

/** A theme id from a name: lower-case words joined by '-', at most 40 characters (the schema's id rule). */
export function slug(name) {
  const s = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40).replace(/-+$/g, '');
}

/** Pick the component variants and the non-colour parts from the style read. Returns { components, why[], geometry,
 *  typography, depthWanted }. Low-confidence answers leave their keys out (the base look) and say so. */
export function chooseVariants(style) {
  const why = [];
  const c = { button: {}, slider: {} };
  const set = (key, value, reason) => {
    const [a, b] = key.split('.');
    if (b) c[a][b] = value; else c[a] = value;
    why.push({ key, value, why: reason });
  };
  const cr = style.cornerRadius, glowRead = style.glow, shadowRead = style.shadow, type = style.type;
  const shapeKnown = cr.class !== null && cr.confidence >= MIN_CONFIDENCE;
  const glow = glowRead.used && glowRead.confidence >= MIN_CONFIDENCE;
  const shadow = shadowRead.used && shadowRead.confidence >= MIN_CONFIDENCE;
  const sharp = shapeKnown && cr.class === 'none';
  const pill = shapeKnown && cr.class === 'pill';
  const crWhy = `corner radius ${cr.class} (${cr.px1080 ?? '?'} px at 1080, ${cr.corners} corners, confidence ${cr.confidence})`;
  if (shapeKnown) set('button.shape', sharp ? 'sharp' : pill ? 'pill' : 'rounded', crWhy);
  else why.push({ key: 'button.shape', value: null, why: `base look kept: ${crWhy} is below ${MIN_CONFIDENCE}` });
  // button.style: raised fills when the reference casts shadows, a glowing rim when it glows, else soft tinted fills.
  // metal and neumorph need a surface texture read the rules do not make, so they are never picked.
  set('button.style', shadow ? 'solid' : glow ? 'bezel' : 'soft', shadow ? 'the reference casts drop shadows: raised solid fills' : glow ? 'the reference glows and casts no shadow: a glowing bezel rim' : 'no shadow and no glow: soft tinted fills');
  set('button.secondary', glow ? 'outline' : 'tinted', glow ? 'glow: neon-style outlined plain buttons' : 'no glow: tinted plain buttons');
  set('focus', glow ? 'glow' : shadow ? 'ring' : 'border', glow ? `glow read (${glowRead.marks} marks, confidence ${glowRead.confidence})` : shadow ? 'no glow, drop shadows: a focus ring' : 'no glow, no shadow: a focus border');
  set('card', shadow ? 'raised' : sharp ? 'framed' : 'flat', shadow ? `drop shadow ${shadowRead.offset ?? ''} the panels (depth ${shadowRead.depth}, confidence ${shadowRead.confidence})` : sharp ? 'no shadow and square corners: framed panels' : 'no shadow: flat panels');
  if (shapeKnown) {
    set('tabs', pill ? 'pill' : sharp ? 'boxed' : 'underline', crWhy);
    set('input', sharp ? 'filled' : 'outline', crWhy);
    set('chip', sharp ? 'bracket' : 'pill', crWhy);
    set('sectionHeader', sharp ? 'bracket' : 'rule', crWhy);
    set('slider.handle', sharp ? 'bar' : 'round', crWhy);
  }
  set('switch', glow ? 'bezel' : pill ? 'plain' : 'labelled', 'every switch variant paints the ON side in onAccent (the base switch does not pass 3:1)');
  set('slider.track', shadow ? 'thick' : 'thin', shadow ? 'raised look: a thick track' : 'a thin track');
  set('list', 'plain', 'the read has no row plates');
  const size = type.confidence >= MIN_CONFIDENCE ? type.size : null;
  set('density', size === 'small' ? 'compact' : size === 'large' || size === 'display' ? 'airy' : 'normal', size ? `type size ${size} (${type.glyphHeightPx1080} px at 1080)` : 'type size not read: normal spacing');
  if (!Object.keys(c.button).length) delete c.button;
  if (!Object.keys(c.slider).length) delete c.slider;

  // geometry: the reference radius at 1080 halved for the studio's 100 % scale, small and large around it
  let radius;
  if (!shapeKnown) radius = { small: 4, medium: 8, large: 12 };
  else if (sharp) radius = { small: 0, medium: 0, large: 2 };
  else if (pill) radius = { small: 6, medium: 10, large: 16 };
  else { const m = clamp(Math.round((cr.px1080 ?? 16) / 2), 2, 16); radius = { small: Math.max(1, Math.round(m / 2)), medium: m, large: Math.min(24, Math.round(m * 1.5)) }; }
  const spacing = { compact: { small: 4, medium: 8, large: 12 }, normal: { small: 6, medium: 10, large: 14 }, airy: { small: 8, medium: 12, large: 18 } }[c.density];
  const weight = type.confidence >= MIN_CONFIDENCE ? type.weight : null;
  const base = { small: 9, medium: 10, large: 10.5, display: 11 }[size] ?? 10;
  const family = { sans: 'Segoe UI', serif: 'Georgia', mono: 'Cascadia Mono', display: 'Segoe UI Black', script: 'Segoe Script' }[type.family] ?? 'Segoe UI';
  const typography = {
    family, fallbacks: ['Segoe UI'].filter((f) => f !== family), baseSize: base, captionSize: base - 2, titleSize: base + 5,
    headingWeight: { light: 500, regular: 600, bold: 700, black: 800 }[weight] ?? 600,
    letterSpacing: 0, captionLetterSpacing: 1, captionCaps: false,
  };
  if (!typography.fallbacks.length) delete typography.fallbacks;
  why.push({ key: 'typography', value: `${family} ${base} pt, headings ${typography.headingWeight}`, why: `type family ${type.family ?? 'not read (rules never read it)'}, size ${size ?? 'not read'}, weight ${weight ?? 'not read'}` });
  const stroke = { light: 1.4, regular: 1.6, bold: 2, black: 2.4 }[weight] ?? 1.6;
  return { components: c, why, radius, spacing, typography, stroke, glow, shadow };
}

/** The colour tokens from the palette read. Returns { colors, provenance: { token: { hex, how, from, why } } }. */
export function mapColours(read) {
  const roles = read.palette.roles;
  const prov = {};
  const put = (token, l, how, from, why) => { prov[token] = { hex: labHex(l), how, from, why }; return labHex(l); };
  const bg = lab(roles.background.hex);
  const dark = bg[0] < 0.5;
  const colors = {};
  colors.bg = put('bg', bg, roles.background.how, 'background', roles.background.why);
  let panel = lab(roles.surface.hex);
  if (deltaE(panel, bg) < 0.015) { panel = [clamp(bg[0] + (dark ? 0.05 : -0.04), 0, 1), bg[1], bg[2]]; colors.panel = put('panel', panel, 'derived', 'background', 'surface too close to the background: background one step toward the middle'); }
  else colors.panel = put('panel', panel, roles.surface.how, 'surface', roles.surface.why);
  const field = [clamp(panel[0] + (panel[0] < 0.5 ? 0.035 : -0.035), 0, 1), panel[1], panel[2]];
  colors.field = put('field', field, 'derived', 'surface', 'surface, one 0.035 lightness step toward the middle');
  const grounds = [colors.bg, colors.panel, colors.field].map(rgb);
  let text;
  if (roles.text) {
    const t0 = lab(roles.text.hex);
    text = forceContrastAll(t0, grounds, TEXT, dark);
    colors.text = put('text', text, text === t0 ? roles.text.how : 'derived', 'text', text === t0 ? roles.text.why : `${roles.text.why}; lightness moved ${(text[0] - t0[0]).toFixed(2)} to clear 4.5:1 on panel and field`);
  } else {
    text = forceContrastAll([dark ? 0.95 : 0.2, bg[1], bg[2]], grounds, TEXT, dark);
    colors.text = put('text', text, 'derived', 'background', 'no text colour read: the background hue pushed to 4.5:1');
  }
  // border: the panel one step toward the text, kept clear of the text (pressed buttons and the switch OFF track
  // paint the text colour on it)
  let border = null;
  for (let t = 0.14; t >= 0; t -= 0.01) { border = mixLab(panel, text, t); if (contrast(rgb(labHex(text)), rgb(labHex(border))) >= TEXT) break; }
  colors.border = put('border', border, 'derived', 'surface + text', 'surface mixed toward the text (at most 14 %) while the text keeps 4.5:1 on it');
  // accent: the read accent, else the most chromatic cluster, else the text colour (a neutral accent)
  let acc, accHow, accFrom, accWhy;
  if (roles.accent) { acc = lab(roles.accent.hex); accHow = roles.accent.how; accFrom = 'accent'; accWhy = roles.accent.why; }
  else {
    const best = read.palette.clusters.reduce((a, k) => (k.C > a.C ? k : a));
    if (best.C >= 0.02) { acc = lab(best.hex); accHow = 'derived'; accFrom = 'cluster'; accWhy = `no vivid accent read: the most chromatic cluster (C ${best.C})`; }
    else { acc = text; accHow = 'derived'; accFrom = 'text'; accWhy = 'a neutral reference: the text colour is the accent'; }
  }
  // onAccent: the background or the text, whichever gives the accent less to move. Then the accent is pushed to 4.5:1
  // under its label and 3:1 on the surfaces it sits next to.
  const tries = [colors.bg, colors.text].map((on) => {
    const onRgb = rgb(on);
    const a = forceContrastAll(acc, [onRgb], TEXT, contrast(rgb(labHex(acc)), [1, 1, 1]) <= contrast(onRgb, [1, 1, 1]));
    const a2 = forceContrastAll(a, [...grounds, onRgb], CTRL, dark);
    const ok = contrast(rgb(labHex(a2)), onRgb) >= TEXT && grounds.every((g) => contrast(rgb(labHex(a2)), g) >= CTRL);
    return { on, a: a2, ok, move: Math.abs(a2[0] - acc[0]) };
  }).sort((x, y) => (y.ok - x.ok) || (x.move - y.move));
  const pick = tries[0];
  colors.accent = put('accent', pick.a, pick.a === acc ? accHow : 'derived', accFrom, pick.a === acc ? accWhy : `${accWhy}; lightness moved ${(pick.a[0] - acc[0]).toFixed(2)} for 4.5:1 under its label and 3:1 on the surfaces`);
  colors.onAccent = put('onAccent', lab(pick.on), 'derived', pick.on === colors.bg ? 'background' : 'text', `the ${pick.on === colors.bg ? 'background' : 'text'} colour reads best on the accent (${ratio(pick.on, colors.accent)}:1)`);
  // accentHi: the accent one step toward the text, readable as text on every surface
  const accL = pick.a;
  const hi0 = [clamp(accL[0] + (dark ? 0.1 : -0.1), 0, 1), accL[1], accL[2]];
  const hi = forceContrastAll(hi0, grounds, TEXT, dark);
  colors.accentHi = put('accentHi', hi, 'derived', 'accent', `accent, lightness ${dark ? '+' : '-'}0.10${hi === hi0 ? '' : ` then ${(hi[0] - hi0[0]).toFixed(2)} more to clear 4.5:1 as text`}`);
  // muted: the text 35 % of the way to the background, pushed back to 4.5:1
  const m0 = mixLab(text, bg, 0.35);
  const muted = forceContrastAll(m0, grounds, TEXT, dark);
  colors.muted = put('muted', muted, 'derived', 'text + background', `text mixed 35 % toward the background${muted === m0 ? '' : `, lightness moved ${(muted[0] - m0[0]).toFixed(2)} to clear 4.5:1`}`);
  // danger and ok: a red or green cluster of the read if there is one, else the semantic hue at the accent's
  // lightness and chroma; pushed to 4.5:1 on every surface
  for (const token of ['danger', 'ok']) {
    // never the accent itself: a red accent stays the accent, and danger must look different from it
    const hit = read.palette.clusters.filter((k) => k.C >= 0.08 && hueGap(k.h, HUE[token]) <= 30 && k.share >= 0.005 && deltaE(lab(k.hex), acc) >= 0.08 && deltaE(lab(k.hex), accL) >= 0.08)
      .sort((a, b) => b.C - a.C)[0];
    const c0 = hit ? lab(hit.hex) : fromLCh(accL[0], Math.max(0.12, chroma(accL)), HUE[token]);
    // danger is a fill under the onAccent label too (checked danger buttons): it goes to the accent's side
    const pushed = forceContrastAll(c0, grounds, TEXT, contrast(rgb(colors.accent), [0, 0, 0]) >= contrast(rgb(colors.onAccent), [0, 0, 0]));
    colors[token] = put(token, pushed, hit ? (pushed === c0 ? 'extracted' : 'derived') : 'derived', hit ? 'cluster' : 'accent',
      `${hit ? `a ${token === 'danger' ? 'red' : 'green'} cluster of the reference (hue ${hit.h})` : `no ${token === 'danger' ? 'red' : 'green'} in the reference: hue ${HUE[token]} (the ${token === 'danger' ? 'warning red' : 'success green'} convention) at the accent's lightness and chroma`}${pushed === c0 ? '' : `, lightness moved ${(pushed[0] - c0[0]).toFixed(2)} to clear 4.5:1`}`);
  }
  colors.disabled = put('disabled', mixLab(muted, bg, 0.45), 'derived', 'muted + background', 'muted mixed 45 % toward the background (disabled text is exempt from the contrast rule)');
  // order as the schema lists them
  const order = ['bg', 'panel', 'field', 'border', 'text', 'muted', 'accent', 'accentHi', 'danger', 'ok', 'onAccent', 'disabled'];
  return { dark, colors: Object.fromEntries(order.map((k) => [k, colors[k]])), provenance: prov };
}

const TOKENS = ['bg', 'panel', 'field', 'border', 'text', 'muted', 'accent', 'accentHi', 'danger', 'ok', 'onAccent', 'disabled'];
const MOVABLE_FACES = new Set(['bg', 'panel', 'field', 'border', 'accent', 'danger']);

/** Which token each pair paints with and which tokens it can sit on. The pair tables take hex colours, so the pack is
 *  run once with a unique stand-in colour per token: a pair's position does not depend on the colours (only the face
 *  lists are de-duplicated), so pair i's ink token is the stand-in at position i. Faces that are mixes (tints, wells)
 *  match no stand-in and are not moved directly. */
function pairTokens(pack) {
  const stand = Object.fromEntries(TOKENS.map((t, i) => [t, `#0101${(i + 16).toString(16).padStart(2, '0')}`]));
  const back = new Map(Object.entries(stand).map(([t, h]) => [h, t]));
  return pairs({ ...pack, gradients: undefined, colors: stand }).map(([, , ink, faces]) => ({ ink: back.get(ink) ?? null, faces: faces.map((f) => back.get(f)).filter(Boolean) }));
}

/** Push colours until every pair of the T1 check passes. Returns the pushes made ([] when it passed as read). */
export function settleContrast(pack, maxRounds = 60) {
  const pushes = [];
  const c = pack.colors;
  const seen = new Map(); // token -> values it has had: a push back to one of them is an oscillation
  const visit = (t, v) => { if (!seen.has(t)) seen.set(t, new Set([c[t]])); const had = seen.get(t).has(v); seen.get(t).add(v); return had; };
  const darker = (a, b) => contrast(rgb(a), [0, 0, 0]) < contrast(rgb(b), [0, 0, 0]);
  for (let round = 0; round < maxRounds; round++) {
    const all = pairs(pack);
    const who = pairTokens(pack);
    let f = null;
    for (let i = 0; i < all.length && !f; i++) {
      const [state, what, ink, faces, min] = all[i];
      for (const face of faces) if (contrast(rgb(ink), rgb(face)) < min) { f = { i, state, what, ink, face, min }; break; }
    }
    if (!f) return pushes;
    const inkToken = who[f.i].ink;
    let moved = false;
    if (inkToken) {
      // every face this token must clear at this level, so one push does not undo another
      const faces = [...new Set(all.filter((p, j) => who[j].ink === inkToken && p[4] <= f.min + 1e-9).flatMap((p) => p[3]))];
      const before = c[inkToken];
      const next = labHex(forceContrastAll(lab(before), faces.map(rgb), f.min, !darker(before, f.face)));
      if (next !== before && !visit(inkToken, next)) {
        c[inkToken] = next; moved = true;
        pushes.push({ token: inkToken, from: before, to: next, why: `${f.state}: ${f.what} was ${ratio(before, f.face)}:1 on ${f.face} (needs ${f.min})` });
      }
    }
    if (!moved) {
      const faceToken = who[f.i].faces.find((t) => c[t] === f.face && t !== inkToken && MOVABLE_FACES.has(t));
      if (!faceToken) return pushes; // a mixed face that cannot be moved alone; the report lists the failure
      const before = c[faceToken];
      const next = labHex(forceContrastAll(lab(before), [rgb(f.ink)], f.min, !darker(before, f.ink)));
      if (next === before || visit(faceToken, next)) return pushes;
      c[faceToken] = next;
      pushes.push({ token: faceToken, from: before, to: next, why: `${f.state}: ${f.what} ${f.ink} was ${ratio(f.ink, before)}:1 on it (needs ${f.min})` });
    }
  }
  return pushes;
}

/** The worst ratio per pair kind, for the report. */
function contrastSummary(pack) {
  let worstText = Infinity, worstCtrl = Infinity, n = 0;
  const bad = [];
  for (const [state, what, ink, faces, min] of pairs(pack))
    for (const face of faces) {
      n++;
      const r = contrast(rgb(ink), rgb(face));
      if (min === TEXT) worstText = Math.min(worstText, r); else worstCtrl = Math.min(worstCtrl, r);
      if (r < min) bad.push(`${state}: ${what} ${ink} on ${face} = ${r.toFixed(2)} (needs ${min})`);
    }
  return { checks: n, worstText: Math.round(worstText * 100) / 100, worstControl: Math.round(worstCtrl * 100) / 100, failures: bad };
}

/** SB4: a typed read -> { pack, report }. opts: { name, id }. */
export function themeFromRead(read, { name = null, id = null } = {}) {
  const ref = read.reference.name.replace(/\.[^.]+$/, '');
  const nm = String(name ?? `From ${ref}`).trim().slice(0, 40) || 'From reference';
  const tid = id ?? (slug(nm) || 'reference-theme');
  const { dark, colors, provenance } = mapColours(read);
  const v = chooseVariants(read.style);
  const sh = (blur, y, op) => ({ blur, offsetX: 0, offsetY: v.shadow ? (read.style.shadow.offset === 'around' ? 0 : y) : y, color: '#000000', opacity: op });
  const shOp = clamp(r3(0.3 + (read.style.shadow.depth ?? 0) * 1.5), 0.3, 0.6);
  const glowColour = read.style.glow.colour ?? 'accent';
  const glowOp = clamp(r3(0.25 + (read.style.glow.strength ?? 0) * 0.5), 0.25, 0.55);
  const depth = {
    card: v.shadow ? { shadow: sh(16, 4, shOp) } : {},
    button: {},
    primaryButton: { ...(v.shadow ? { shadow: sh(8, 2, shOp) } : {}), ...(v.glow ? { glow: { blur: 14, color: glowColour, opacity: glowOp, when: 'always' } } : {}) },
    roundControl: { ...(v.shadow ? { shadow: sh(10, 3, shOp) } : {}), ...(v.glow ? { glow: { blur: 18, color: 'auto', opacity: glowOp, when: 'active' } } : {}) },
    toast: { ...(v.shadow ? { shadow: sh(20, 6, shOp) } : {}), ...(v.glow ? { glow: { blur: 12, color: 'accentHi', opacity: 0.2, when: 'always' } } : {}) },
    menu: v.shadow ? { shadow: sh(16, 5, shOp) } : {},
    taskPanel: v.shadow ? { shadow: sh(20, 6, shOp) } : {},
  };
  const look = [dark ? 'dark' : 'light', v.components.button?.shape ? `${v.components.button.shape} corners` : null, v.glow ? 'glow' : null, v.shadow ? 'drop shadows' : null].filter(Boolean).join(', ');
  const pack = {
    id: tid, name: nm,
    topic: `Studio theme built by the scene builder (SB4) from the reference ${read.reference.name}: ${look}.`.slice(0, 200),
    version: 1, dark, colors,
    typography: v.typography,
    geometry: { radius: v.radius, spacing: v.spacing, borderWidth: 1, controlHeight: 20, roundControl: 52, controlPadding: { y: 6, x: 14 } },
    depth,
    motion: { fastMs: 120, normalMs: 190, slowMs: 280, easing: 'outCubic', hoverLift: v.shadow ? 1 : 0, pressSink: 1 },
    background: { kind: 'solid', pattern: 'none', patternColor: colors.border, patternOpacity: 0, patternSpacing: 24 },
    components: v.components,
    icons: { stroke: v.stroke },
  };
  const pushes = settleContrast(pack);
  // the background pattern colour follows a pushed border
  pack.background.patternColor = pack.colors.border;
  const summary = contrastSummary(pack);
  const colours = Object.entries(pack.colors).map(([token, hex]) => {
    const p = provenance[token];
    const pushed = pushes.filter((x) => x.token === token);
    return { token, hex, how: pushed.length ? 'derived' : p.how, from: p.from, why: pushed.length ? `${p.why}; pushed for contrast: ${pushed.map((x) => `${x.from} -> ${x.to}`).join(', ')}` : p.why };
  });
  const notes = [];
  if (deltaE(lab(pack.colors.danger), lab(pack.colors.accent)) < 0.08) notes.push(`danger ${pack.colors.danger} is close to the accent ${pack.colors.accent} (a red reference): the warning colour is told apart by its label and icon only`);
  if (v.glow && read.style.glow.colour) notes.push(`glow colour ${read.style.glow.colour} read from the reference (decoration: not a contrast pair)`);
  notes.push('shadow colour #000000: a shadow darkens what is under it; it is not a palette colour');
  notes.push('motion, control sizes and padding are the studio defaults (a still reference does not show them)');
  return {
    pack,
    report: {
      tool: 'scene-builder/theme-from-reference', toolVersion: TOOL_VERSION, reference: read.reference.name,
      read: { background: read.palette.roles.background?.hex ?? null, surface: read.palette.roles.surface?.hex ?? null, text: read.palette.roles.text?.hex ?? null, accent: read.palette.roles.accent?.hex ?? null, accentAlt: read.palette.roles.accentAlt?.hex ?? null },
      colours, variants: v.why, pushes, contrast: summary, notes,
    },
  };
}

/** The themes folder of the user's studio (theme.cpp searchDirs: <app data>/themes = %APPDATA%\Ujwalam Studio\themes,
 *  the Qt AppDataLocation of the application name). UJWALAM_THEMES_DIR wins, as it does in the studio. */
export function userThemesDir(env = process.env) {
  if (env.UJWALAM_THEMES_DIR) return path.resolve(env.UJWALAM_THEMES_DIR);
  if (!env.APPDATA) throw new Error('no APPDATA folder; pass --themes-dir');
  return path.join(env.APPDATA, 'Ujwalam Studio', 'themes');
}

/** Problems with writing this pack to dir ([] when it can be written). */
export function writeProblems(pack, dir, { builtins = builtinIds() } = {}) {
  const p = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pack.id) || pack.id.length > 40) p.push(`theme id "${pack.id}" is not lower-case words joined by '-' (40 characters at most)`);
  if (builtins.includes(pack.id)) p.push(`"${pack.id}" is a built-in theme; choose another --name`);
  if (path.resolve(dir).toLowerCase() === BUILTIN_DIR.toLowerCase()) p.push('that is the built-in themes folder; custom packs go in the user themes folder');
  if (existsSync(path.join(dir, `${pack.id}.json`))) p.push(`${pack.id}.json already exists there; choose another --name (an existing theme is never overwritten)`);
  return p;
}

/** Write the pack as <dir>/<id>.json: a temp file linked into place, so the studio's watcher never sees half a file and
 *  an existing file is never replaced (the link fails if one appeared in between). Returns the file path. */
export function writeThemePack(pack, dir) {
  const bad = writeProblems(pack, dir);
  if (bad.length) throw new Error(bad.join('; '));
  const file = path.join(dir, `${pack.id}.json`);
  const tmp = path.join(dir, `.${pack.id}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx' });
  try { linkSync(tmp, file); } finally { unlinkSync(tmp); }
  return file;
}

/** Plain-text dry-run report. */
export function reportText(pack, report, { file, dryRun }) {
  const L = [];
  L.push(`${dryRun ? 'Dry run' : 'Written'}: theme "${pack.name}" (id ${pack.id}) from ${report.reference}${file ? ` -> ${file}` : ''}`);
  L.push(`Contrast (T1 check, ${report.contrast.checks} pairs): ${report.contrast.failures.length ? `${report.contrast.failures.length} FAIL` : 'pass'}; worst text ${report.contrast.worstText}:1 (>= 4.5), worst control ${report.contrast.worstControl}:1 (>= 3)`);
  for (const f of report.contrast.failures) L.push(`  FAIL ${f}`);
  L.push('Colours:');
  for (const c of report.colours) L.push(`  ${c.token.padEnd(9)} ${c.hex}  ${c.how.padEnd(9)} ${c.why}`);
  L.push(report.pushes.length ? 'Contrast pushes after mapping:' : 'Contrast pushes after mapping: none (passed as mapped)');
  for (const p of report.pushes) L.push(`  ${p.token}: ${p.from} -> ${p.to} (${p.why})`);
  L.push('Components:');
  for (const v of report.variants) L.push(`  ${v.key} = ${v.value ?? '(base look)'}: ${v.why}`);
  for (const n of report.notes) L.push(`Note: ${n}`);
  if (dryRun) L.push('Nothing written. Add --apply to save it; the studio lists it in Settings > Appearance (components need the theme-components flag).');
  return L.join('\n');
}
