// SPDX-License-Identifier: GPL-3.0-or-later
// Undo / redo of layer edits (P5b, D238). Node stdlib only.
//
// One entry per applied edit: { method, scene, canvas?, layer, before, after }. method is layers.setPlacement,
// layers.setVisible or layers.move; before/after are the host params for that method minus scene/canvas/layer
// ({ placement } with only the keys the edit changed, { visible }, { index }). Undo re-applies `before`, redo `after`.
// A new edit clears the redo list. The list is in memory only (a restarted studio starts empty) and keeps the newest
// `max` entries.
//
// Reading `before` from a layers.list result: beforeOf(method, params, list) returns the layer's current value for
// the keys the edit will change, or null when the layer is not in the list (then nothing is recorded).

export const UNDOABLE = Object.freeze(['layers.setPlacement', 'layers.setVisible', 'layers.move']);
const PLACEMENT_DEFAULTS = { rotation: 0 };
const CROP_KEYS = ['left', 'top', 'right', 'bottom'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The current value of what `params` will change, from a host layers.list result; null when it cannot be read. */
export function beforeOf(method, params, list) {
  const layers = Array.isArray(list?.layers) ? list.layers : null;
  if (!layers) return null;
  const index = layers.findIndex((l) => l?.id === params.layer);
  if (index < 0) return null;
  const l = layers[index];
  if (method === 'layers.setVisible') return typeof l.visible === 'boolean' ? { visible: l.visible } : null;
  if (method === 'layers.move') return { index };
  if (method !== 'layers.setPlacement' || !isObj(l.placement) || !isObj(params.placement)) return null;
  const cur = l.placement;
  const placement = {};
  for (const k of Object.keys(params.placement)) {
    if (k === 'crop') {
      if (!isObj(params.placement.crop)) continue;
      const c = isObj(cur.crop) ? cur.crop : {};
      placement.crop = {};
      for (const ck of Object.keys(params.placement.crop)) if (CROP_KEYS.includes(ck)) placement.crop[ck] = Number.isFinite(c[ck]) ? c[ck] : 0;
    } else if (Number.isFinite(cur[k])) placement[k] = cur[k];
    else if (k in PLACEMENT_DEFAULTS) placement[k] = PLACEMENT_DEFAULTS[k];
    else return null; // a key the layer does not report: the old value is unknown, so the edit is not undoable
  }
  return { placement };
}

/** The `after` part of the host params. */
export function afterOf(method, params) {
  if (method === 'layers.setPlacement') return { placement: structuredClone(params.placement) };
  if (method === 'layers.setVisible') return { visible: params.visible };
  if (method === 'layers.move') return { index: params.index };
  return null;
}

/** Host params that set `side` ('before' | 'after') of an entry. */
export function paramsOf(entry, side) {
  return { scene: entry.scene, ...(entry.canvas ? { canvas: entry.canvas } : {}), layer: entry.layer, ...structuredClone(entry[side]) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createEditHistory({ max = 50 } = {}) {
  let done = [];
  let undone = [];
  return {
    /** Records an applied edit. An edit that changed nothing is not recorded. */
    record(entry) {
      if (!UNDOABLE.includes(entry?.method) || !entry.before || !entry.after || same(entry.before, entry.after)) return false;
      done.push({ method: entry.method, scene: entry.scene, ...(entry.canvas ? { canvas: entry.canvas } : {}), layer: entry.layer, before: entry.before, after: entry.after });
      if (done.length > max) done = done.slice(-max);
      undone = [];
      return true;
    },
    peekUndo() { return done.at(-1) ?? null; },
    peekRedo() { return undone.at(-1) ?? null; },
    /** Moves the newest edit to the redo list; call after the host applied its `before`. */
    commitUndo() { const e = done.pop(); if (e) undone.push(e); return e ?? null; },
    /** Moves the newest undone edit back; call after the host applied its `after`. */
    commitRedo() { const e = undone.pop(); if (e) done.push(e); return e ?? null; },
    state() {
      const label = (e) => (e ? `${e.method === 'layers.setPlacement' ? 'Move/resize' : e.method === 'layers.setVisible' ? (e.after.visible ? 'Show' : 'Hide') : 'Reorder'} ${e.layer}` : null);
      return { undo: done.length, redo: undone.length, nextUndo: label(done.at(-1)), nextRedo: label(undone.at(-1)) };
    },
    clear() { done = []; undone = []; },
  };
}
