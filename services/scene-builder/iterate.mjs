// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB5 (D347): iterate on a scene package. Pure data in, data out: nothing here reads or writes a project
// file, and a package is never changed in place (every call returns a new package with a new id and a lineage note).
//
//   editPackage(pkg, edits, { canvases, rules, now }) -> { package, changes, warnings }
//     edits: { op: 'move',   canvas, key, x, y }          top-left to x,y (fractions); size and crop stay
//            { op: 'resize', canvas, key, w, h }          new box, same top-left; capture and link layers re-fit
//            { op: 'place',  canvas, key, x, y, w, h }    move + resize in one step
//            { op: 'swap',   canvas, a, b }               the two layers trade boxes (the slot swap), both re-fit
//   similarVariants(pkg, { count, seed, canvases, rules, now }) -> [{ package, kind, distance, changes }]
//
// Re-fit (capture and link layers): a game layer keeps the shape it is drawn at and is contained in the new box (never
// cropped); a camera layer is cover-fitted with a centre crop of at most rules.camera.maxCrop of a side, else contained
// (the same fitBox as the build). A camera's source size is rules.sourceSize (the package carries none), so a crop the
// user made in the studio is replaced by the centre crop: UNVERIFIED against a real device format.
// A chat layer's width/height query follows its box. Boxes must stay on the canvas; a layer the V safe zone would
// cut is reported as a warning, never moved silently.
//
// Variants are "similar": a seeded random nudge of at most a few percent of the canvas (kinds nudge-small,
// nudge-large), a mirror left to right (mirror), or both (mirror+nudge). A variant is kept only when every box stays
// on the canvas, a layer that sat inside the V safe zone still does, no two boxes overlap more than they did, and the
// game gets no more crop than it had. Same package + same seed gives the same variants.

import { createHash } from 'node:crypto';
import { fitBox, loadBuildRules } from './build.mjs';

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const MIN_SIDE = 0.02;
const EPS = 1e-6;
const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 };
export const VARIANT_KINDS = ['nudge-small', 'nudge-large', 'mirror', 'mirror+nudge'];
export const MAX_VARIANTS = 8;

export class IterateError extends Error {
  constructor(message) { super(message); this.name = 'IterateError'; }
}

/** mulberry32 over a sha256 of the seed text. */
export function seededRng(seed) {
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const presetOf = (pkg, canvas) => pkg.presets.find((p) => p.params.canvas === canvas);
const layerOf = (pkg, canvas, key) => {
  const l = presetOf(pkg, canvas)?.params.layers.find((x) => x.key === key);
  if (!l) throw new IterateError(`no layer "${key}" on ${String(canvas).toUpperCase()}`);
  return l;
};
const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const onCanvas = (b) => b.x >= -EPS && b.y >= -EPS && b.x + b.w <= 1 + EPS && b.y + b.h <= 1 + EPS && b.w >= MIN_SIDE - EPS && b.h >= MIN_SIDE - EPS;
const inside = (b, S) => b.x >= S.x - EPS && b.y >= S.y - EPS && b.x + b.w <= S.x + S.w + EPS && b.y + b.h <= S.y + S.h + EPS;
const clampBox = (b) => {
  const w = Math.min(1, Math.max(MIN_SIDE, b.w)), h = Math.min(1, Math.max(MIN_SIDE, b.h));
  return { x: Math.min(1 - w, Math.max(0, b.x)), y: Math.min(1 - h, Math.max(0, b.y)), w, h };
};
// Round the left/top edge, then the right/bottom edge, and derive the size: x + w never exceeds the rounded edge.
const rnd = (b) => {
  const x = r4(b.x), y = r4(b.y);
  return { x, y, w: Math.max(0, r4(r4(b.x + b.w) - x)), h: Math.max(0, r4(r4(b.y + b.h) - y)) };
};

function setQuerySize(query, box, cv) {
  const q = new URLSearchParams(query ?? '');
  q.set('width', String(Math.round(box.w * cv.width)));
  q.set('height', String(Math.round(box.h * cv.height)));
  return q.toString();
}

// Put a layer into a box. refit: capture and link layers get the build's fit; others take the box as they are.
function placeLayer(layer, box, { cv, rules, refit }) {
  if (refit && (layer.type === 'capture' || layer.type === 'link')) {
    const camera = layer.slot?.role === 'camera';
    const fit = camera ? (rules.camera.fit ?? 'cover') : 'contain';
    let content;
    if (fit === 'contain') { // keep the shape the layer is drawn at
      const a = (layer.rect.w * cv.width) / (layer.rect.h * cv.height);
      content = { w: a * 1000, h: 1000, crop: { ...NO_CROP } };
    } else content = { w: rules.sourceSize.width, h: rules.sourceSize.height, crop: { ...NO_CROP } };
    const f = fitBox(box, cv, content, fit, camera ? (rules.camera.maxCrop ?? 0) : 0);
    layer.rect = rnd(f.box);
    layer.fit = f.fit;
    if (fit === 'cover') { if (f.crop) layer.crop = f.crop; else delete layer.crop; } // a contained layer keeps its crop
  } else layer.rect = rnd(box);
  if (layer.slot?.role === 'chat' && layer.type === 'browser') layer.query = setQuerySize(layer.query, layer.rect, cv);
}

function cvOf(canvases, canvas) {
  const cv = canvases?.[canvas];
  if (!cv || !(cv.width > 0) || !(cv.height > 0)) throw new IterateError(`the ${String(canvas).toUpperCase()} canvas size is needed for this edit`);
  return cv;
}

function applyOne(pkg, e, ctx) {
  if (!e || typeof e !== 'object') throw new IterateError('an edit must be an object');
  if (e.canvas !== 'h' && e.canvas !== 'v') throw new IterateError('an edit needs canvas "h" or "v"');
  const num = (k) => { if (!Number.isFinite(e[k])) throw new IterateError(`${e.op}: ${k} must be a number`); return e[k]; };
  const cv = cvOf(ctx.canvases, e.canvas);
  const c = { cv, rules: ctx.rules };
  if (e.op === 'move' || e.op === 'resize' || e.op === 'place') {
    const l = layerOf(pkg, e.canvas, e.key);
    const cur = l.rect;
    const next = e.op === 'move' ? { x: num('x'), y: num('y'), w: cur.w, h: cur.h }
      : e.op === 'resize' ? { x: cur.x, y: cur.y, w: num('w'), h: num('h') }
        : { x: num('x'), y: num('y'), w: num('w'), h: num('h') };
    if (!onCanvas(next)) throw new IterateError(`${e.op} ${e.canvas}:${e.key}: the box would leave the canvas or be smaller than ${MIN_SIDE}`);
    placeLayer(l, next, { ...c, refit: e.op !== 'move' });
    if (!onCanvas(l.rect)) throw new IterateError(`${e.op} ${e.canvas}:${e.key}: the stored box would leave the canvas or be smaller than ${MIN_SIDE}`);
    return `${e.op} ${e.canvas}:${e.key}`;
  }
  if (e.op === 'swap') {
    if (e.a === e.b) throw new IterateError('swap needs two different layers');
    const a = layerOf(pkg, e.canvas, e.a), b = layerOf(pkg, e.canvas, e.b);
    const boxA = { ...a.rect }, boxB = { ...b.rect };
    placeLayer(a, boxB, { ...c, refit: true });
    placeLayer(b, boxA, { ...c, refit: true });
    if (!onCanvas(a.rect) || !onCanvas(b.rect)) throw new IterateError(`swap ${e.canvas}:${e.a} <-> ${e.b}: a stored box would leave the canvas`);
    return `swap ${e.canvas}:${e.a} <-> ${e.b}`;
  }
  throw new IterateError(`unknown edit "${e.op}"`);
}

function safeWarnings(pkg, rules) {
  const S = rules.v.safeBox, out = [];
  const v = presetOf(pkg, 'v');
  if (!S || !v) return out;
  for (const l of v.params.layers) {
    if (['game', 'camera', 'chat', 'alerts'].includes(l.slot?.role) && !inside(l.rect, S)) out.push(`v: ${l.key} is outside the V safe zone (${rules.v.safe.target})`);
  }
  return out;
}

// New id from the content, lineage, names; the warnings are the parent's minus safe-zone ones plus the current ones.
function seal(pkg, parent, { changes, now, suffix, extra = {}, rules }) {
  const name = `${parent.name.replace(/ \((?:edited|variant \d+)\)$/, '').slice(0, 85)} (${suffix})`;
  const digest = createHash('sha256').update(JSON.stringify({ p: parent.id, presets: pkg.presets.map((x) => x.params), changes })).digest('hex').slice(0, 10);
  pkg.id = `sb-${digest}`;
  pkg.name = name;
  pkg.created = now.toISOString();
  pkg.lineage = { parent: parent.id, changes, ...extra };
  pkg.warnings = [...(parent.warnings ?? []).filter((w) => !/safe zone/.test(w)), ...safeWarnings(pkg, rules)];
  for (const p of pkg.presets) {
    p.id = `${pkg.id}-${p.params.canvas}`;
    p.params.sceneName = name;
    p.name = `${name} (${p.params.canvas.toUpperCase()})`;
  }
  return pkg;
}

/** Apply edits to a copy of the package. All or nothing: the first bad edit throws and nothing is returned. */
export function editPackage(pkg, edits, { canvases, rules = loadBuildRules(), now = new Date() } = {}) {
  if (!pkg || pkg.format !== 'ujwalam-scene-package') throw new IterateError('not a scene package');
  if (!Array.isArray(edits) || !edits.length) throw new IterateError('no edits given');
  const out = structuredClone(pkg);
  const changes = edits.map((e) => applyOne(out, e, { canvases, rules }));
  seal(out, pkg, { changes, now, suffix: 'edited', rules });
  return { package: out, changes, warnings: out.warnings.filter((w) => /safe zone/.test(w)) };
}

// Each pair of layers may overlap no more than it did in the original (a smaller A/B overlap never hides a new B/C one).
function pairsGrow(orig, next) {
  for (let i = 0; i < orig.length; i++) for (let j = i + 1; j < orig.length; j++) if (area(next[i], next[j]) > area(orig[i], orig[j]) + 1e-4) return true;
  return false;
}

// The stored rects of a variant, after rounding and fitting: canvas bounds, V safe zone kept, pairwise overlap.
function storedProblem(from, to, rules) {
  const S = rules.v.safeBox;
  for (const p of from.presets) {
    const q = presetOf(to, p.params.canvas);
    if (!q || q.params.layers.length !== p.params.layers.length) return 'layers changed';
    const m = p.params.layers.map((l) => q.params.layers.find((x) => x.key === l.key));
    if (m.some((x) => !x)) return 'layers changed';
    if (m.some((x) => !onCanvas(x.rect))) return 'off canvas';
    if (p.params.canvas === 'v' && S && p.params.layers.some((l, i) => inside(l.rect, S) && !inside(m[i].rect, S))) return 'left the safe zone';
    if (pairsGrow(p.params.layers.map((l) => l.rect), m.map((x) => x.rect))) return 'overlap grew';
  }
  return null;
}

// Edits for one candidate; null when a rule rejects it.
function candidate(pkg, kind, rng, { canvases, rules }) {
  const amp = kind === 'nudge-large' ? 0.04 : kind === 'nudge-small' ? 0.02 : 0.015;
  const mirror = kind.startsWith('mirror'), nudge = kind !== 'mirror';
  const edits = [];
  for (const p of pkg.presets) {
    const canvas = p.params.canvas;
    cvOf(canvases, canvas);
    const S = rules.v.safeBox;
    const planned = p.params.layers.map((l) => {
      let b = { ...l.rect };
      if (mirror) b.x = 1 - b.x - b.w;
      if (nudge && l.slot?.role !== 'game') {
        const s = 1 + (rng() * 2 - 1) * amp * 2.5;
        const cx = b.x + b.w / 2 + (rng() * 2 - 1) * amp, cy = b.y + b.h / 2 + (rng() * 2 - 1) * amp;
        b = { x: cx - (b.w * s) / 2, y: cy - (b.h * s) / 2, w: b.w * s, h: b.h * s };
      } else if (nudge) { // the game only slides; it is never rescaled, so it is never cropped
        b = { ...b, x: b.x + (rng() * 2 - 1) * amp * 0.5, y: b.y + (rng() * 2 - 1) * amp * 0.5 };
      }
      return { l, b: clampBox(b) };
    });
    for (const { l, b } of planned) {
      if (!onCanvas(b)) return null;
      if (canvas === 'v' && S && inside(l.rect, S) && !inside(b, S)) return null;
    }
    if (pairsGrow(planned.map((x) => x.l.rect), planned.map((x) => x.b))) return null;
    for (const { l, b } of planned) {
      const same = Math.abs(b.w - l.rect.w) < 1e-9 && Math.abs(b.h - l.rect.h) < 1e-9;
      edits.push(same ? { op: 'move', canvas, key: l.key, x: b.x, y: b.y } : { op: 'place', canvas, key: l.key, x: b.x, y: b.y, w: b.w, h: b.h });
    }
  }
  return edits;
}

// The game keeps the crop it came with (the project's own layer may have one); an edit never adds to it.
const gameCropKept = (from, to) => from.presets.every((p) => p.params.layers.filter((l) => l.slot?.role === 'game').every((l) => {
  const m = presetOf(to, p.params.canvas)?.params.layers.find((x) => x.key === l.key);
  return JSON.stringify(m?.crop ?? null) === JSON.stringify(l.crop ?? null);
}));

const signature = (pkg) => JSON.stringify(pkg.presets.map((p) => p.params.layers.map((l) => [l.key, l.rect])));
function distance(a, b) {
  let d = 0;
  for (const p of a.presets) {
    const q = presetOf(b, p.params.canvas);
    for (const l of p.params.layers) {
      const m = q?.params.layers.find((x) => x.key === l.key);
      if (m) d = Math.max(d, Math.abs(l.rect.x - m.rect.x), Math.abs(l.rect.y - m.rect.y), Math.abs(l.rect.x + l.rect.w - m.rect.x - m.rect.w), Math.abs(l.rect.y + l.rect.h - m.rect.y - m.rect.h));
    }
  }
  return r4(d);
}

/** Up to `count` (1..MAX_VARIANTS) distinct, rule-respecting variants of a package. Deterministic for a seed. */
export function similarVariants(pkg, { count = 3, seed = 'sb5', canvases, rules = loadBuildRules(), now = new Date() } = {}) {
  if (!pkg || pkg.format !== 'ujwalam-scene-package') throw new IterateError('not a scene package');
  if (!Number.isInteger(count) || count < 1 || count > MAX_VARIANTS) throw new IterateError(`count must be a whole number from 1 to ${MAX_VARIANTS}`);
  const rng = seededRng(`${seed}|${pkg.id}`);
  const seen = new Set([signature(pkg)]);
  const out = [];
  for (let i = 0; out.length < count && i < count * 12; i++) {
    const kind = VARIANT_KINDS[i % VARIANT_KINDS.length];
    const edits = candidate(pkg, kind, rng, { canvases, rules });
    if (!edits) continue;
    const copy = structuredClone(pkg);
    try { edits.forEach((e) => applyOne(copy, e, { canvases, rules })); } catch (e) { if (e instanceof IterateError) continue; throw e; }
    if (storedProblem(pkg, copy, rules)) continue;
    if (seen.has(signature(copy))) continue;
    if (!gameCropKept(pkg, copy)) continue; // the game is never cropped more than it was
    seen.add(signature(copy));
    const n = out.length + 1;
    seal(copy, pkg, { changes: [`${kind} (seed ${seed}, variant ${n})`], now, suffix: `variant ${n}`, extra: { kind, seed: String(seed) }, rules });
    out.push({ package: copy, kind, distance: distance(pkg, copy), changes: edits.length });
  }
  return out;
}
