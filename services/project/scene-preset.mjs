// SPDX-License-Identifier: GPL-3.0-or-later
// Scene preset loader (v1 F1/F4). Turns a registry scene preset (registry/presets/scene-*.json, function
// scene-layout-preset) into a NEW scene in a project. The input project is never modified: the result is a
// deep copy with one scene appended (and overlay entries added only when no entry has the same file).
// Existing scenes, layers, devices, audio and outputs are carried over byte for byte.
//
// Placeholders `{brand.x}`, `{handles.x}`, `{links.x}` in the preset are resolved from the local profile
// (data/profile.local.json, gitignored) at load time. A missing key is an error that names the KEY, never a value.
// Device roles (game-capture, facecam) are bound with opts.roles = { role: deviceId }. An unbound role becomes a
// transparent colour layer that keeps the geometry and is listed in `unbound`; no device is created or guessed.
// Rule targets (cam-pop) are returned as layer ids in `rules`; the project model has no rule storage.
// A `link` layer (scene packages, D341) shows a layer that already exists in the project: opts.links = { role: layerId }
// makes it a `duplicate` of that layer (of its real target when it is itself a duplicate), so the device behind it is
// opened once and nothing about the existing layer changes. An unbound or unknown link becomes a transparent
// placeholder, listed in `unbound` like an unbound capture role.

import path from 'node:path';
import { IMAGE_EXT, newId, validateProject } from './index.mjs';

const ROLE_KIND = { 'game-capture': ['capture-card', 'camera'], facecam: ['camera'] }; // the Meld importer files every video device as 'camera'
const PLACEHOLDER = /\{([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)\}/g;

export class ScenePresetError extends Error {
  constructor(message, details) { super(message); this.name = 'ScenePresetError'; if (details) this.details = details; }
}

function lookup(profile, key) {
  let v = profile;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, part)) return undefined;
    v = v[part];
  }
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Replaces placeholders in a string. `encode` URL-encodes the value (for query strings).
export function resolveString(s, profile, missing, encode = false) {
  return s.replace(PLACEHOLDER, (m, key) => {
    const v = lookup(profile, key);
    if (v === undefined) { missing.add(key); return m; }
    return encode ? encodeURIComponent(v) : v;
  });
}

export function placeholderKeys(preset) {
  const keys = new Set();
  for (const l of preset.params.layers) {
    for (const s of [l.query, l.file?.rel, l.file?.base]) if (typeof s === 'string') for (const m of s.matchAll(PLACEHOLDER)) keys.add(m[1]);
  }
  return [...keys].sort();
}

const label = (s) => String(s).slice(0, 120) || 'Layer';

// `fit: "contain"` (D251): the file is shown at its true shape, as large as fits the preset box and centred in it
// (rotation pivots on the centre, so a turned box stays right). `cropBars` first cuts the file's black bars
// (info.crop, source px); `trimKey` (a video keyed with that screen colour) cuts the bars and the border that is only
// ever keyed out (info.content). Without info the box stays as it is (stretched, as before).
function fitContain(px, info, cropBars, trimKey) {
  if (!info || !(info.width > 0) || !(info.height > 0) || !(px.width > 0) || !(px.height > 0)) return;
  const c = (trimKey && info.content) || (cropBars && info.crop) || { left: 0, top: 0, right: 0, bottom: 0 };
  const sw = info.width - c.left - c.right, sh = info.height - c.top - c.bottom;
  if (!(sw > 0) || !(sh > 0)) return;
  const s = Math.min(px.width / sw, px.height / sh);
  const w = Math.round(sw * s * 100) / 100, h = Math.round(sh * s * 100) / 100;
  px.x = Math.round((px.x + (px.width - w) / 2) * 100) / 100;
  px.y = Math.round((px.y + (px.height - h) / 2) * 100) / 100;
  px.width = w; px.height = h;
  if (c.left || c.top || c.right || c.bottom) px.crop = { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
}

/** The id of the real (non-duplicate) layer that layer `id` shows, or null when there is none in the project. */
export function realLayer(project, id) {
  if (typeof id !== 'string') return null;
  const all = new Map();
  for (const s of project.scenes) for (const l of s.layers) all.set(l.id, l);
  const seen = new Set();
  let cur = all.get(id);
  while (cur && cur.type === 'duplicate' && !seen.has(cur.id)) { seen.add(cur.id); cur = all.get(cur.source?.layer); }
  return cur && cur.type !== 'duplicate' ? cur.id : null;
}

/** One scene for both canvases (the host shows one active scene on every canvas; H layers carry only H placements,
 *  V layers only V): the V scene's layers move into the H scene and the V scene is dropped. A V capture layer whose
 *  device already has an H capture layer becomes a `duplicate` of it (D60), so one device is opened once.
 *  Returns { project, duplicated } on a copy; the input is not touched. */
export function mergeCanvasScenes(project, hSceneId, vSceneId) {
  const out = structuredClone(project);
  const h = out.scenes.find((s) => s.id === hSceneId);
  const v = out.scenes.find((s) => s.id === vSceneId);
  const hCapture = new Map(h.layers.filter((l) => l.type === 'capture').map((l) => [l.source.device, l.id]));
  const duplicated = [];
  const movedTo = new Map(); // V capture layer id -> the H layer it now duplicates
  for (const l of v.layers) {
    if (l.type === 'capture' && hCapture.has(l.source.device)) {
      l.type = 'duplicate';
      l.source = { layer: hCapture.get(l.source.device) };
      duplicated.push(l.id);
      movedTo.set(l.id, l.source.layer);
    }
  }
  for (const l of v.layers) {
    // a V duplicate of a V capture layer (e.g. the blurred game backdrop) points at the real H layer: the host
    // refuses a duplicate of a duplicate
    if (l.type === 'duplicate' && movedTo.has(l.source.layer)) l.source = { layer: movedTo.get(l.source.layer) };
    h.layers.push(l);
  }
  out.scenes = out.scenes.filter((s) => s.id !== vSceneId);
  return { project: out, duplicated };
}

export function loadScenePreset(project, preset, opts = {}) {
  // flags: feature flag states ({ id: bool }); a preset layer with `flag` starts hidden while that flag is off, and
  // its `effects` apply only while `effectsFlag` (if set) is on.
  // mediaInfo(pathRef) -> { width, height, crop } | null (services/project/media-info.mjs): needed only by layers with
  // `fit: "contain"`; without it (or when it returns null) such a layer keeps its box as it is.
  const { profile = {}, roles = {}, links = {}, sceneName, idFn = newId, flags = {}, mediaInfo = null } = opts;
  if (!preset || preset.function !== 'scene-layout-preset') throw new ScenePresetError('not a scene-layout-preset preset');
  const P = preset.params;
  const canvasId = P.canvas;
  const canvas = project.canvases.find((c) => c.id === canvasId);
  if (!canvas) throw new ScenePresetError(`project has no ${canvasId} canvas`);

  // placeholders first: fail before building anything
  const missing = new Set();
  const resolvedQuery = new Map();
  const resolvedFile = new Map();
  // A brand asset file that is not in the profile yet does not block the scene (D166): the layer becomes a transparent
  // placeholder holding its geometry, like an unbound role, and its key is reported in `missingAssets`.
  const missingAssets = new Set();
  for (const l of P.layers) {
    if (typeof l.query === 'string') resolvedQuery.set(l.key, resolveString(l.query, profile, missing, true));
    if (l.file) {
      const own = new Set();
      const rel = resolveString(l.file.rel, profile, own, false);
      if (own.size) own.forEach((k) => missingAssets.add(k));
      else resolvedFile.set(l.key, { base: l.file.base, rel });
    }
  }
  if (missing.size) throw new ScenePresetError(`profile is missing placeholder key(s): ${[...missing].sort().join(', ')}`);

  const out = structuredClone(project); // the input is never touched
  const used = new Set();
  for (const s of out.scenes) { used.add(s.id); for (const l of s.layers) used.add(l.id); }
  for (const d of out.devices) used.add(d.id);
  const fresh = (prefix) => { let id; do { id = idFn(prefix); } while (used.has(id)); used.add(id); return id; };

  const ovIds = new Set(out.overlays.map((o) => o.id));
  const addedOverlays = [];
  const overlayFor = (rel) => {
    const hit = out.overlays.find((o) => o.file.base === 'overlays' && o.file.rel === rel);
    if (hit) return hit.id;
    let id = `ov-${rel.split('/')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase()}`;
    if (!/^[a-z]/.test(id)) id = `ov-${id}`;
    let n = 1, cand = id;
    while (ovIds.has(cand)) cand = `${id}-${++n}`;
    ovIds.add(cand);
    const entry = { id: cand, name: label(rel.split('/')[0]), file: { base: 'overlays', rel } };
    out.overlays.push(entry);
    addedOverlays.push(cand);
    return cand;
  };

  const unbound = [];
  const layerIds = {};
  const layers = [];
  const ordered = [...P.layers].sort((a, b) => a.z - b.z);
  for (const l of ordered) layerIds[l.key] = fresh('lyr'); // first: a duplicate may point at a layer above it
  const placeholder = new Set();
  for (const l of [...ordered].sort((a, b) => (a.type === 'duplicate') - (b.type === 'duplicate'))) {
    const id = layerIds[l.key];
    const px = {
      visible: l.visible !== false && (!l.flag || flags[l.flag] === true),
      x: Math.round(l.rect.x * canvas.width * 100) / 100,
      y: Math.round(l.rect.y * canvas.height * 100) / 100,
      width: Math.round(l.rect.w * canvas.width * 100) / 100,
      height: Math.round(l.rect.h * canvas.height * 100) / 100,
    };
    if (l.crop) px.crop = { ...l.crop };
    // turned or see-through layers (D248, e.g. the V confetti prompt at 270 degrees, the V subscribe pill at 0.59)
    if (typeof l.rotation === 'number' && l.rotation !== 0) px.rotation = l.rotation;
    if (typeof l.opacity === 'number' && l.opacity !== 1) px.opacity = l.opacity;
    let type, source;
    if (l.type === 'capture') {
      const devId = roles[l.role];
      const dev = devId && out.devices.find((d) => d.id === devId);
      if (dev && ROLE_KIND[l.role]?.includes(dev.kind)) { type = 'capture'; source = { device: dev.id }; }
      else {
        if (devId) throw new ScenePresetError(`role "${l.role}" is bound to a device that is missing or of the wrong kind`);
        unbound.push(l.role);
        type = 'color'; source = { color: '#00000000' }; delete px.crop;
        placeholder.add(l.key);
      }
    } else if (l.type === 'link') {
      const target = realLayer(project, links[l.role]);
      if (target) { type = 'duplicate'; source = { layer: target }; }
      else {
        unbound.push(l.role);
        type = 'color'; source = { color: '#00000000' }; delete px.crop;
        placeholder.add(l.key);
      }
    } else if (l.type === 'browser') {
      type = 'browser';
      source = { overlay: overlayFor(l.overlay), width: Math.max(1, Math.round(px.width)), height: Math.max(1, Math.round(px.height)) };
      const q = resolvedQuery.get(l.key);
      if (q) source.query = q;
    } else if (l.type === 'image') {
      // A brand asset may be a still or an animation (the Meld wordmark is a looping mp4): the profile file decides.
      const file = resolvedFile.get(l.key);
      if (!file) { type = 'color'; source = { color: '#00000000' }; placeholder.add(l.key); }
      else if (IMAGE_EXT.has(path.extname(file.rel).toLowerCase())) { type = 'image'; source = { file }; }
      else { type = 'media'; source = { file, loop: true }; }
    } else if (l.type === 'color') {
      type = 'color'; source = { color: l.color };
    } else if (l.type === 'duplicate') {
      // a second picture of another layer of this preset (e.g. the blurred, enlarged game behind the framed game);
      // the device is opened once. An unbound target leaves a transparent placeholder here too.
      const target = P.layers.find((x) => x.key === l.of);
      if (!target || target.type === 'duplicate') throw new ScenePresetError(`layer "${l.key}": duplicate of unknown or duplicate layer "${l.of}"`);
      if (placeholder.has(l.of)) { type = 'color'; source = { color: '#00000000' }; delete px.crop; placeholder.add(l.key); }
      else if (target.type === 'link') { type = 'duplicate'; source = { layer: realLayer(project, links[target.role]) }; } // never a duplicate of a duplicate
      else { type = 'duplicate'; source = { layer: layerIds[l.of] }; }
    } else throw new ScenePresetError(`layer "${l.key}": unknown type "${l.type}"`);
    if (l.fit === 'contain' && (type === 'image' || type === 'media')) {
      // `trimKey` only for a video: a still is not keyed (videoEffects), so its green is picture
      const trimKey = type === 'media' && typeof l.trimKey === 'string' ? l.trimKey : null;
      fitContain(px, mediaInfo?.(source.file, trimKey ? { keyColor: trimKey } : {}) ?? null, l.cropBars === true, trimKey !== null);
    }
    const layer = { id, type, name: label(l.name), source, placements: { [canvasId]: px }, origin: { importer: 'preset', id: `${preset.id}/${l.key}` } };
    // effects apply only while `flag` and `effectsFlag` (if set) are on; effectsFlag keeps the layer itself
    const effectsOn = [l.flag, l.effectsFlag].every((f) => !f || flags[f] === true);
    // `videoEffects` (D248) apply only when the profile file turned out to be a video: a green-screen brand video needs a
    // key, a transparent PNG of the same asset must not lose its greens
    const fx = [...(Array.isArray(l.effects) ? l.effects : []), ...(type === 'media' && Array.isArray(l.videoEffects) ? l.videoEffects : [])];
    if (fx.length && effectsOn && !placeholder.has(l.key)) layer.effects = structuredClone(fx);
    layers.push({ z: l.z, layer });
  }
  layers.sort((a, b) => a.z - b.z);

  const sceneId = fresh('scene');
  out.scenes.push({ id: sceneId, name: label(sceneName ?? P.sceneName), layers: layers.map((x) => x.layer), origin: { importer: 'preset', id: preset.id } });

  const rules = (P.rules ?? []).map((r) => {
    const target = layerIds[r.target?.layerKey];
    if (!target) throw new ScenePresetError(`rule "${r.type}" targets an unknown layer key`);
    return { type: r.type, scene: sceneId, layer: target, config: r.config };
  });

  const v = validateProject(out);
  if (!v.ok) throw new ScenePresetError('result does not validate', v.errors.slice(0, 10));
  return { project: out, sceneId, layerIds, rules, unbound, missingAssets: [...missingAssets].sort(), addedOverlays };
}
