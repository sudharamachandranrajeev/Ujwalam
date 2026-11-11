// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB3 (D341): a reference read (SB2, data/schemas/reference-read.schema.json) + the user's project ->
// a scene package (data/schemas/scene-package.schema.json) holding one H and one V scene-layout-preset. The package is
// data only: services/project/scene-package.mjs applies it as NEW namespaced scenes (dry run first) and never changes
// an existing scene, layer, device or setting.
//
//   buildPackage(read, project, { rules, bind, theme, now }) -> package
//
// Canvases: the reference's own canvas (H for a wide reference, V for a tall one) takes the slot boxes as they are
// (fractions of the frame = fractions of the canvas). The other canvas is laid out by the rules in
// data/scene-builder/build-rules.json: on V everything sits inside the V safe zone (data/clip/targets.json) and the
// game is never cropped; on H a left column holds camera, alerts and chat beside the game. Graphics are carried only
// on the reference canvas (no rule moves a free panel between canvases; listed in notCarried).
// Sources: game and camera link to the project's existing capture layer (a duplicate of it; device opened once) or,
// when only the device exists, a capture layer on that device; chat and alerts reuse the project's overlay page and
// its settings. Graphics are token panels (ujwalam-panel overlay; tokens only, the brand theme or ?theme=). A slot
// below rules.minConfidence or without a matching source becomes a transparent placeholder layer that keeps the
// geometry and is listed in `placeholders` with the reason: nothing is guessed silently.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSources } from './sources.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_RULES = path.join(REPO, 'data', 'scene-builder', 'build-rules.json');
export const PACKAGE_FORMAT = 'ujwalam-scene-package';
export const PACKAGE_VERSION = 1;
export const BUILDER_VERSION = '0.1.0';
const ROLE_OF = { game: 'game-capture', camera: 'facecam' };
const THEME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r2 = (v) => Math.round(v * 100) / 100;

/** Build rules with the V safe zone resolved to canvas fractions (from the targets file the rules name). */
export function loadBuildRules(file = DEFAULT_RULES, root = REPO) {
  const rules = JSON.parse(readFileSync(file, 'utf8'));
  const t = JSON.parse(readFileSync(path.join(root, rules.v.safe.file), 'utf8'));
  const target = t.targets.find((x) => x.id === rules.v.safe.target);
  if (!target) throw new Error(`build rules: no target "${rules.v.safe.target}" in ${rules.v.safe.file}`);
  const { width: W, height: H } = t.frame, s = target.safe;
  rules.v.safeBox = { x: s.left / W, y: s.top / H, w: (W - s.left - s.right) / W, h: (H - s.top - s.bottom) / H };
  return rules;
}

/** The best slot per role (highest confidence) and the graphics, largest first, capped. */
export function pickSlots(slots, rules) {
  const best = {};
  for (const s of slots) if (s.role !== 'graphics' && (!best[s.role] || s.confidence > best[s.role].confidence)) best[s.role] = s;
  const graphics = slots.filter((s) => s.role === 'graphics').sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  return { best, graphics: graphics.slice(0, rules.maxGraphics), dropped: Math.max(0, graphics.length - rules.maxGraphics) };
}

// Source content (after the existing layer's own crop) in source px.
function contentOf(src, rules) {
  const c = src?.content ?? { width: rules.sourceSize.width, height: rules.sourceSize.height, crop: null };
  const k = c.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  return { w: c.width - k.left - k.right, h: c.height - k.top - k.bottom, crop: k };
}

/** Fits source content into a box on a canvas (canvas px). fit 'contain' never crops; 'cover' crops at most maxCrop
 *  of a side (centred) and falls back to contain beyond it. Returns { box, crop, fit }. */
export function fitBox(box, cv, content, fit, maxCrop = 0) {
  const bx = box.x * cv.width, by = box.y * cv.height, bw = box.w * cv.width, bh = box.h * cv.height;
  const base = content.crop;
  const keep = (crop) => (crop.left || crop.top || crop.right || crop.bottom ? crop : null);
  if (fit === 'cover') {
    const s = Math.max(bw / content.w, bh / content.h);
    const cutX = content.w - bw / s, cutY = content.h - bh / s;
    if (cutX / content.w <= maxCrop + 1e-9 && cutY / content.h <= maxCrop + 1e-9) {
      const crop = { left: r2(base.left + cutX / 2), top: r2(base.top + cutY / 2), right: r2(base.right + cutX / 2), bottom: r2(base.bottom + cutY / 2) };
      return { box: { ...box }, crop: keep(crop), fit: 'cover' };
    }
  }
  const s = Math.min(bw / content.w, bh / content.h);
  const w = content.w * s, h = content.h * s;
  return { box: { x: (bx + (bw - w) / 2) / cv.width, y: (by + (bh - h) / 2) / cv.height, w: w / cv.width, h: h / cv.height }, crop: keep({ ...base }), fit: 'contain' };
}

const pxAspect = (box, size) => (box.w * size.width) / (box.h * size.height);
const containIn = (aspect, region, cv) => { // the largest rect of a px aspect inside a region (fractions), top-left
  let w = region.w * cv.width, h = w / aspect;
  if (h > region.h * cv.height) { h = region.h * cv.height; w = h * aspect; }
  return { x: region.x, y: region.y, w: w / cv.width, h: h / cv.height };
};

/** Derived V layout: game across the safe width (never cropped), camera and alerts above it, chat below, all inside
 *  the safe zone. aspects: { game, camera } in px. */
export function layoutV(roles, aspects, cv, rules) {
  const S = rules.v.safeBox, g = rules.v.gap;
  const out = {};
  const top = ['camera', 'alerts'].filter((r) => roles.has(r)), bottom = ['chat'].filter((r) => roles.has(r));
  let gameH = roles.has('game') ? (S.w * cv.width / aspects.game) / cv.height : 0;
  const gaps = (top.length ? g : 0) + (bottom.length ? g : 0);
  const minBand = (top.length + bottom.length) ? 0.1 : 0;
  if (gameH > S.h - gaps - minBand) gameH = Math.max(0, S.h - gaps - minBand);
  const R = Math.max(0, S.h - gameH - gaps);
  const T = top.length ? (bottom.length ? R / 2 : R) : 0;
  const gameY = S.y + T + (top.length ? g : 0);
  if (roles.has('game')) {
    const w = Math.min(S.w, gameH * cv.height * aspects.game / cv.width);
    out.game = { x: S.x + (S.w - w) / 2, y: gameY, w, h: gameH };
  }
  if (top.length) {
    let right = S.x;
    if (roles.has('camera')) {
      out.camera = containIn(aspects.camera, { x: S.x, y: S.y, w: S.w * (roles.has('alerts') ? rules.v.cameraMaxWidth : 1), h: T }, cv);
      right = out.camera.x + out.camera.w + g;
    }
    if (roles.has('alerts')) out.alerts = { x: right, y: S.y, w: S.x + S.w - right, h: Math.min(T, rules.v.alertsMaxHeight) };
  }
  if (bottom.length) out.chat = { x: S.x, y: gameY + gameH + g, w: S.w, h: S.y + S.h - (gameY + gameH + g) };
  return out;
}

/** Derived H layout: a left column (camera, alerts, chat, top to bottom) and the game contained beside it. */
export function layoutH(roles, aspects, cv, rules) {
  const { margin: m, gap: g, column } = rules.h;
  const out = {};
  const col = ['camera', 'alerts', 'chat'].some((r) => roles.has(r)) ? column : 0;
  const region = { x: m + (col ? col + g : 0), y: m, w: 0, h: 1 - 2 * m };
  region.w = 1 - m - region.x;
  if (roles.has('game')) {
    const r = containIn(aspects.game, region, cv);
    out.game = { ...r, x: region.x + (region.w - r.w) / 2, y: region.y + (region.h - r.h) / 2 };
  }
  let y = m;
  if (roles.has('camera')) { out.camera = containIn(aspects.camera, { x: m, y, w: col, h: rules.h.cameraMaxHeight }, cv); y += out.camera.h + g; }
  if (roles.has('alerts')) { out.alerts = { x: m, y, w: col, h: rules.h.alertsHeight }; y += rules.h.alertsHeight + g; }
  if (roles.has('chat')) out.chat = { x: m, y, w: col, h: Math.max(0.05, 1 - m - y) };
  return out;
}

const inside = (b, S) => b.x >= S.x - 1e-6 && b.y >= S.y - 1e-6 && b.x + b.w <= S.x + S.w + 1e-6 && b.y + b.h <= S.y + S.h + 1e-6;

function query(pairs) {
  const q = new URLSearchParams();
  for (const [k, v] of pairs) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q.toString();
}

/** SB3: the scene package for a read and a project. Pure: neither input is changed. */
export function buildPackage(read, project, { rules = loadBuildRules(), bind = {}, theme = null, now = new Date() } = {}) {
  if (!read || read.tool !== 'scene-builder/reference-read' || !Array.isArray(read.slots)) throw new Error('not a scene builder reference read');
  if (theme !== null && (typeof theme !== 'string' || !THEME_RE.test(theme))) throw new Error('theme must be a short id (a-z, 0-9, -)');
  const refCanvas = read.canvas === 'V' ? 'v' : 'h';
  const sizes = Object.fromEntries(project.canvases.map((c) => [c.id, { width: c.width, height: c.height }]));
  const refSize = { width: read.reference.width, height: read.reference.height };
  const sources = findSources(project, { bind, rules });
  const { best, graphics, dropped } = pickSlots(read.slots, rules);
  const roles = new Set(Object.keys(best));
  const placeholders = [], notCarried = [], warnings = [], links = {}, deviceRoles = {};
  const aspectOf = (role) => {
    if (role === 'game') { const c = contentOf(sources.game.missing ? null : sources.game, rules); return c.w / c.h; }
    return pxAspect(best.camera.box, refSize); // the reference's framing of the face
  };
  const aspects = { game: roles.has('game') ? aspectOf('game') : 16 / 9, camera: roles.has('camera') ? aspectOf('camera') : 16 / 9 };

  const radiusToken = rules.panel.radius[read.style?.cornerRadius?.class] ?? 'none';
  const glow = read.style?.glow?.used === true ? 1 : 0;
  const orientation = (canvas) => (canvas === 'v' ? 'vertical' : 'horizontal');

  const presets = [];
  for (const canvas of ['h', 'v']) {
    const cv = sizes[canvas];
    if (!cv) { warnings.push(`the project has no ${canvas.toUpperCase()} canvas; no ${canvas.toUpperCase()} scene is built`); continue; }
    const fromRef = canvas === refCanvas;
    const boxes = fromRef ? Object.fromEntries([...roles].map((r) => [r, best[r].box])) : (canvas === 'v' ? layoutV : layoutH)(roles, aspects, cv, rules);
    const layers = [];
    const add = (role, key, slot, box, make) => {
      const from = fromRef ? 'reference' : 'rule';
      const meta = { role, confidence: slot.confidence, from };
      const hold = (reason) => {
        placeholders.push({ canvas, key, role, reason });
        layers.push({ key, type: 'color', color: '#00000000', name: `Placeholder: ${role}`, z: rules.z[role], rect: rnd(box), slot: meta, placeholder: reason });
      };
      if (slot.confidence < rules.minConfidence) return hold(`low confidence ${slot.confidence} (below ${rules.minConfidence})`);
      const built = make();
      if (built.missing) return hold(built.missing);
      layers.push({ key, z: rules.z[role], slot: meta, ...built, rect: rnd(built.rect ?? box) });
    };
    const rnd = (b) => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });

    for (const role of ['game', 'camera']) {
      if (!roles.has(role)) continue;
      add(role, role, best[role], boxes[role], () => {
        const src = sources[role];
        if (src.missing) return src;
        const f = fitBox(boxes[role], cv, contentOf(src, rules), rules[role].fit, rules[role].maxCrop ?? 0);
        const out = { name: role === 'game' ? 'Game' : 'Camera', rect: f.box, fit: f.fit, link: src.layer ? { layer: src.layer, name: src.name } : { device: src.device, name: src.name } };
        if (f.crop) out.crop = f.crop;
        if (src.layer) { links[role] = src.layer; return { ...out, type: 'link', role }; }
        deviceRoles[ROLE_OF[role]] = src.device;
        return { ...out, type: 'capture', role: ROLE_OF[role] };
      });
    }
    for (const role of ['chat', 'alerts']) {
      if (!roles.has(role)) continue;
      add(role, role, best[role], boxes[role], () => {
        const src = sources[role];
        if (src.missing) return src;
        const b = boxes[role];
        const kept = [...new URLSearchParams(src.query)].filter(([k]) => !rules.dropQuery.includes(k));
        const geo = role === 'chat'
          ? [['x', 0], ['y', 0], ['width', Math.round(b.w * cv.width)], ['height', Math.round(b.h * cv.height)]]
          : [['x', 0], ['y', 0]];
        return { type: 'browser', name: role === 'chat' ? 'Chat' : 'Alerts', overlay: src.overlay.rel, query: query([...kept, ...geo, ['canvas', orientation(canvas)], ['theme', theme]]), link: { overlay: src.overlay.id, layer: src.layer, name: src.name } };
      });
    }
    if (fromRef) {
      graphics.forEach((slot, i) => add('graphics', `graphics-${i + 1}`, slot, slot.box, () => ({
        type: 'browser', name: `Panel ${i + 1}`, overlay: rules.panel.overlay,
        query: query([['radius', radiusToken], ['glow', glow], ['theme', theme]]),
      })));
      if (canvas === 'v') {
        for (const role of ['camera', 'chat', 'alerts']) {
          if (roles.has(role) && !inside(best[role].box, rules.v.safeBox)) warnings.push(`v: the reference puts the ${role} outside the V safe zone (${rules.v.safe.target}); kept as drawn`);
        }
      }
    } else if (graphics.length) {
      notCarried.push({ canvas, role: 'graphics', count: graphics.length, reason: 'no rule moves a free panel between canvases' });
    }
    layers.sort((a, b) => a.z - b.z || a.key.localeCompare(b.key));
    // z must be unique per layer for a stable order
    layers.forEach((l, i) => { l.z = i; });
    presets.push({ canvas, layers });
  }
  if (dropped) notCarried.push({ canvas: refCanvas, role: 'graphics', count: dropped, reason: `more than ${rules.maxGraphics} graphics slots; the smallest are left out` });
  if (!roles.has('game')) warnings.push('the reference read has no game slot: the scenes have no game layer');

  const base = read.reference.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 60) || 'reference';
  const digest = createHash('sha256').update(JSON.stringify({ read, presets, theme })).digest('hex').slice(0, 10);
  const id = `sb-${digest}`;
  const sceneName = `${rules.sceneNamePrefix}: ${base}`;
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    id,
    name: sceneName,
    created: now.toISOString(),
    builder: { tool: 'scene-builder/build', version: BUILDER_VERSION, rulesVersion: rules.version, readRules: read.detector.rulesVersion, model: read.detector.model },
    reference: { name: read.reference.name, kind: read.reference.kind, canvas: read.canvas, width: read.reference.width, height: read.reference.height },
    theme,
    bindings: { links, roles: deviceRoles },
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.missing ? { missing: v.missing } : { why: v.why }])),
    presets: presets.map((p) => ({
      id: `${id}-${p.canvas}`,
      version: '0.1.0',
      function: 'scene-layout-preset',
      functionVersion: '^0.1.0',
      name: `${sceneName} (${p.canvas.toUpperCase()})`,
      params: { sceneName, canvas: p.canvas, layers: p.layers },
    })),
    placeholders,
    notCarried,
    warnings,
  };
}
