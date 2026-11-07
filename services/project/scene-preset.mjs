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

export function loadScenePreset(project, preset, opts = {}) {
  // flags: feature flag states ({ id: bool }); a preset layer with `flag` starts hidden while that flag is off, and
  // its `effects` apply only while `effectsFlag` (if set) is on
  const { profile = {}, roles = {}, sceneName, idFn = newId, flags = {} } = opts;
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
    } else if (l.type === 'browser') {
      type = 'browser';
      source = { overlay: overlayFor(l.overlay), width: Math.max(1, Math.round(px.width)), height: Math.max(1, Math.round(px.height)) };
      const q = resolvedQuery.get(l.key);
      if (q) source.query = q;
    } else if (l.type === 'image') {
      // A brand asset may be a still or an animation (the Meld wordmark is a looping mp4): the profile file decides.
      const file = resolvedFile.get(l.key);
      if (!file) { type = 'color'; source = { color: '#00000000' }; }
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
      else { type = 'duplicate'; source = { layer: layerIds[l.of] }; }
    } else throw new ScenePresetError(`layer "${l.key}": unknown type "${l.type}"`);
    const layer = { id, type, name: label(l.name), source, placements: { [canvasId]: px }, origin: { importer: 'preset', id: `${preset.id}/${l.key}` } };
    // effects apply only while `flag` and `effectsFlag` (if set) are on; effectsFlag keeps the layer itself
    const effectsOn = [l.flag, l.effectsFlag].every((f) => !f || flags[f] === true);
    if (Array.isArray(l.effects) && l.effects.length && effectsOn && !placeholder.has(l.key)) layer.effects = structuredClone(l.effects);
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
