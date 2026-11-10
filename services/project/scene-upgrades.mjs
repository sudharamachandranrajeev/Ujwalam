// SPDX-License-Identifier: GPL-3.0-or-later
// Scene upgrades: one-time changes to scenes that were built from a registry scene preset, applied when a saved
// project is loaded, so a preset change reaches the user's scenes without a rebuild (a rebuild would drop their own
// edits). Each upgrade has an id and runs in list order. It finds its work by preset layer origins
// (origin { importer: 'preset', id: '<preset id>/<layer key>' }) and touches only those layers; every other layer,
// its order, placements and effects are kept as they are. An upgrade whose trigger is gone does nothing, so a second
// load changes nothing (idempotent). The input project is never modified.
//
// bg1 (D331, user request 2026-11-10): the browser background (origin <preset>/background, the atmos-frame page) is
// replaced by the preset's game-backdrop layer, a blurred duplicate of the game capture over the full canvas, at the
// background's place in the stack (the bottom, unless the user moved it). A V scene that already has the backdrop
// (built while it sat behind flag layer-effects, so hidden and without effects) keeps that layer: it is shown, moved
// to the background's place, and given the preset's blur only when it has no blur of its own. The backdrop always
// points at a real layer (never a duplicate of a duplicate: the alpha build turns the V game into a duplicate of the
// H game). A game layer that is a placeholder (no capture device) leaves a transparent placeholder backdrop. A
// background that another layer or an audio source still refers to is hidden instead of removed.
// No game layer in that scene: nothing is changed there.

import { newId, validateProject } from './index.mjs';

export const BG1_PRESETS = ['scene-default-h', 'scene-default-v'];

const originOf = (l) => (l?.origin?.importer === 'preset' && typeof l.origin.id === 'string' ? l.origin.id : null);
const find = (layers, id) => layers.findIndex((l) => originOf(l) === id);

function backdropPlacement(spec, canvas) {
  const px = {
    visible: true,
    x: Math.round(spec.rect.x * canvas.width * 100) / 100,
    y: Math.round(spec.rect.y * canvas.height * 100) / 100,
    width: Math.round(spec.rect.w * canvas.width * 100) / 100,
    height: Math.round(spec.rect.h * canvas.height * 100) / 100,
  };
  if (spec.crop) px.crop = { ...spec.crop };
  return px;
}

// One scene, one preset. Returns a change record or null. Mutates `scene` (a copy owned by upgradeScenes).
function bg1Scene(doc, scene, preset, fresh) {
  const pid = preset.id;
  const canvasId = preset.params?.canvas;
  const canvas = doc.canvases.find((c) => c.id === canvasId);
  const spec = preset.params?.layers?.find((l) => l.key === 'game-backdrop');
  if (!canvas || !spec || spec.type !== 'duplicate') return null;
  const layers = scene.layers;
  const bgAt = find(layers, `${pid}/background`);
  if (bgAt < 0) return null;
  const game = layers[find(layers, `${pid}/${spec.of}`)];
  if (!game) return null;

  // the layer the backdrop shows: the game itself, or the layer the game duplicates
  const isPlaceholder = game.type === 'color';
  const target = game.type === 'duplicate' ? game.source?.layer : game.id;
  const bg = layers[bgAt];
  let bdAt = find(layers, `${pid}/game-backdrop`);
  let action;
  let backdrop;
  if (bdAt >= 0) {
    backdrop = layers[bdAt];
    const px = backdrop.placements?.[canvasId];
    if (px) px.visible = true;
    else backdrop.placements = { ...backdrop.placements, [canvasId]: backdropPlacement(spec, canvas) };
    if (!isPlaceholder && backdrop.type === 'duplicate') {
      backdrop.source = { layer: target };
      if (!(backdrop.effects ?? []).some((e) => e.type === 'blur')) backdrop.effects = [...structuredClone(spec.effects ?? []), ...(backdrop.effects ?? [])];
    }
    action = 'backdrop-shown';
  } else {
    const px = backdropPlacement(spec, canvas);
    backdrop = { id: fresh('lyr'), type: 'duplicate', name: String(spec.name).slice(0, 120), source: { layer: target }, placements: { [canvasId]: px }, origin: { importer: 'preset', id: `${pid}/game-backdrop` } };
    if (isPlaceholder) { backdrop.type = 'color'; backdrop.source = { color: '#00000000' }; delete px.crop; }
    else if (Array.isArray(spec.effects) && spec.effects.length) backdrop.effects = structuredClone(spec.effects);
    action = 'backdrop-added';
  }

  // the background goes; the backdrop takes its place in the stack
  const referenced = doc.scenes.some((s) => s.layers.some((l) => l.type === 'duplicate' && l.source?.layer === bg.id))
    || (doc.audio?.sources ?? []).some((a) => a.layer === bg.id);
  if (bdAt >= 0) layers.splice(bdAt, 1);
  const at = layers.indexOf(bg);
  if (referenced) {
    for (const px of Object.values(bg.placements ?? {})) px.visible = false;
    layers.splice(at, 0, backdrop);
  } else {
    layers.splice(at, 1, backdrop);
  }
  return { upgrade: 'bg1', scene: scene.id, canvas: canvasId, preset: pid, action, backdrop: backdrop.id, background: referenced ? 'hidden' : 'removed', placeholder: isPlaceholder };
}

export const SCENE_UPGRADES = [
  {
    id: 'bg1',
    presets: BG1_PRESETS,
    apply(doc, presets, fresh) {
      const changes = [];
      for (const pid of BG1_PRESETS) {
        const preset = presets[pid];
        if (!preset) continue;
        for (const scene of doc.scenes) {
          const c = bg1Scene(doc, scene, preset, fresh);
          if (c) changes.push(c);
        }
      }
      return changes;
    },
  },
];

// upgradeScenes(project, { presets: { [presetId]: preset }, idFn }) -> { project, changes }. `project` is the input
// itself when nothing changed, else a validated copy. Throws when the result does not validate (the caller keeps the
// file as it is).
export function upgradeScenes(project, { presets = {}, idFn = newId } = {}) {
  const doc = structuredClone(project);
  const used = new Set();
  for (const s of doc.scenes) { used.add(s.id); for (const l of s.layers) used.add(l.id); }
  for (const d of doc.devices) used.add(d.id);
  const fresh = (prefix) => { let id; do { id = idFn(prefix); } while (used.has(id)); used.add(id); return id; };
  const changes = [];
  for (const u of SCENE_UPGRADES) changes.push(...u.apply(doc, presets, fresh));
  if (!changes.length) return { project, changes };
  const v = validateProject(doc);
  if (!v.ok) {
    const e = new Error(`scene upgrade result does not validate (${v.errors.length} error(s))`);
    e.errors = v.errors.slice(0, 10);
    throw e;
  }
  return { project: doc, changes };
}
