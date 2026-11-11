// SPDX-License-Identifier: GPL-3.0-or-later
// Autosave of layer edits (P5b). The host's scene edits are live-only (studio.cpp: "services/project owns the model
// of record"); this module writes the same change into the project file after the host has accepted it, so a restart
// loads the edited layout. Only the edits that map one-to-one onto the project model are saved:
//   layers.setPlacement -> scenes[].layers[].placements[canvas] (x, y, width, height, rotation, crop merged per key)
//   layers.setVisible   -> placements[canvas].visible (and layer.visible, see below)
//   layers.setEffects   -> scenes[].layers[].effects (the whole list; empty removes it; D260)
//   mixer.setTracks     -> audio.sources[audioSource].tracks and .monitoring (D273; params = the host's answer)
//   mixer.setVolume     -> audio.sources[audioSource].volumeDb   (D358; params = the host's answer)
//   mixer.setMute       -> audio.sources[audioSource].muted      (D358)
//   mixer.setCue        -> audio.sources[audioSource].monitoring (D358)
//   A mixer channel with no project audio entry (no audioSource in the answer) stays live-only.
// layers.move is NOT saved here: the host orders layers per canvas, the project has one order shared by H and V.
// The order is saved by the structure route instead (op layer.move, D243), which reorders the host from the project.
// Saves are debounced (one write per burst of edits) and go through saveProject (validate, temp file, .bak, rename).
// A failed save keeps the host change (live-only) and is reported in status(); it never throws into the request.

import { loadProject, saveProject } from '../project/store.mjs';

const CANVASES = ['h', 'v'];
const PLACEMENT_KEYS = ['x', 'y', 'width', 'height', 'rotation'];
const CROP_KEYS = ['left', 'top', 'right', 'bottom'];

// Pure: apply one accepted host edit to a project document (mutates doc). Returns the number of placements changed.
export function applyEdit(doc, method, params) {
  if (method === 'mixer.setVolume' || method === 'mixer.setMute' || method === 'mixer.setCue') {
    const src = doc.audio?.sources?.find((a) => a.id === params?.audioSource);
    if (!src) return 0;
    if (method === 'mixer.setVolume') {
      if (typeof params.volumeDb !== 'number' || !Number.isFinite(params.volumeDb)) return 0;
      src.volumeDb = Math.min(12, Math.max(-100, Math.round(params.volumeDb * 100) / 100));
    } else if (method === 'mixer.setMute') {
      if (typeof params.muted !== 'boolean') return 0;
      src.muted = params.muted;
    } else {
      if (!['off', 'monitor-only', 'monitor-and-output'].includes(params.monitoring)) return 0;
      src.monitoring = params.monitoring;
    }
    return 1;
  }
  if (method === 'mixer.setTracks') {
    const src = doc.audio?.sources?.find((a) => a.id === params.audioSource);
    const known = new Set((doc.audio?.tracks ?? []).map((t) => t.id));
    if (!src || !Array.isArray(params.tracks) || !params.tracks.every((t) => known.has(t))) return 0;
    src.tracks = [...params.tracks];
    // The host flips a CUE that is on with the routing (monitor-only is never in the output mix): record what it does.
    if (['off', 'monitor-only', 'monitor-and-output'].includes(params.monitoring)) src.monitoring = params.monitoring;
    return 1;
  }
  const scene = (doc.scenes ?? []).find((s) => s.id === params.scene);
  const layer = scene?.layers?.find((l) => l.id === params.layer);
  if (!layer || !layer.placements) return 0;
  if (method === 'layers.setEffects') {
    if (!Array.isArray(params.effects)) return 0;
    if (params.effects.length) layer.effects = structuredClone(params.effects);
    else delete layer.effects;
    return 1;
  }
  const canvas = typeof params.canvas === 'string' ? params.canvas.toLowerCase() : null;
  if (canvas !== null && !CANVASES.includes(canvas)) return 0;
  const targets = canvas ? [canvas] : Object.keys(layer.placements); // no canvas: the host applies to every canvas
  let changed = 0;
  for (const c of targets) {
    const pl = layer.placements[c];
    if (!pl) continue;
    if (method === 'layers.setPlacement') {
      const patch = params.placement ?? {};
      for (const k of PLACEMENT_KEYS) if (typeof patch[k] === 'number') pl[k] = patch[k];
      if (patch.crop && typeof patch.crop === 'object') {
        const crop = { ...(pl.crop ?? {}) };
        for (const k of CROP_KEYS) if (typeof patch.crop[k] === 'number') crop[k] = patch.crop[k];
        pl.crop = crop;
      }
      changed++;
    } else if (method === 'layers.setVisible') {
      pl.visible = params.visible === true;
      changed++;
    }
  }
  // The host shows a layer on a canvas when layer.visible && placement.visible. Showing a layer whose layer-level
  // flag is off: turn the flag on and hide it on the other canvases, which were hidden through that flag.
  if (method === 'layers.setVisible' && params.visible === true && layer.visible === false && changed) {
    layer.visible = true;
    for (const c of Object.keys(layer.placements)) if (!targets.includes(c)) layer.placements[c].visible = false;
  }
  return changed;
}

export const SYNCED_METHODS = new Set(['layers.setPlacement', 'layers.setVisible', 'layers.setEffects', 'mixer.setTracks', 'mixer.setVolume',
  'mixer.setMute', 'mixer.setCue']);

/** createProjectSync({ file, delayMs?, setTimer?, clearTimer?, log? })
 *  record(method, params): call after the host accepted the edit. flush(): write now. reload(): flush, then re-read the
 *  file on the next record. status(): { file, pending, saves, lastError }. */
export function createProjectSync({ file, delayMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let doc = null;
  let timer = null;
  let pending = 0;
  let saves = 0;
  let lastError = null;

  const flush = () => {
    if (timer) { clearTimer(timer); timer = null; }
    if (!pending || !doc) return false;
    try {
      saveProject(file, doc);
      saves++;
      lastError = null;
      log(`project saved (${pending} layer edit(s))`);
      pending = 0;
      return true;
    } catch (e) {
      lastError = String(e?.message ?? e).slice(0, 200);
      log(`project NOT saved: ${lastError}; the edits stay live-only`);
      doc = null; // reload from disk next time, so a bad in-memory state is not saved later
      pending = 0;
      return false;
    }
  };

  return {
    record(method, params) {
      if (!SYNCED_METHODS.has(method)) return false;
      try {
        if (!doc) doc = loadProject(file).project;
        if (!applyEdit(doc, method, params)) return false;
      } catch (e) {
        lastError = String(e?.message ?? e).slice(0, 200);
        doc = null;
        return false;
      }
      pending++;
      if (timer) clearTimer(timer);
      timer = setTimer(flush, delayMs);
      timer?.unref?.();
      return true;
    },
    flush,
    /** The file was written by someone else (a structure edit, D240): write what is pending, then re-read it next time. */
    reload() { flush(); doc = null; },
    status: () => ({ file, pending, saves, lastError }),
  };
}
