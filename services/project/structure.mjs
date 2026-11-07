// SPDX-License-Identifier: GPL-3.0-or-later
// Scene and layer structure edits on a project document (P5b, D240). Pure: each function takes a project, returns
// { project, ... } with a changed copy, or { error } with a short code. The result is always checked with
// validateProject. The studio UI server applies the same change to the host and then saves the file.
//
//   addScene(doc, { name })                      -> { project, scene }
//   removeScene(doc, { scene })                  -> { project }      refused: the active scene, the last scene, a scene
//                                                                    whose layers another scene's copy or audio uses
//   addLayer(doc, { scene, kind, ...})           -> { project, layer } kind:
//       copy    { of }       a duplicate of a layer of any scene (Meld "add existing source"), its placements copied
//       color   { color }    #RRGGBB(AA), full canvas
//       text    { text }     centred box
//       capture { device }   a device of the project, full canvas
//       overlay { overlay }  an overlay of the project, a browser layer the size of each canvas
//     New layers go on top, on every canvas of the project.
//   removeLayer(doc, { scene, layer })           -> { project }      refused while a copy or an audio source uses it
// Layer ids are unique across the project (validateProject), new ids come from newId.

import { newId, validateProject } from './index.mjs';

const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const KINDS = ['copy', 'color', 'text', 'capture', 'overlay'];

const label = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 120 ? v.trim() : null);

function checked(project, extra) {
  const v = validateProject(project);
  return v.ok ? { project, ...extra } : { error: 'invalid', errors: v.errors.slice(0, 5) };
}

function allLayers(doc) {
  return doc.scenes.flatMap((s) => s.layers.map((l) => ({ scene: s.id, layer: l })));
}

/** Why a layer cannot go away: another layer copies it, or an audio source is bound to it; null when free. */
function layerUse(doc, id, ignoreScene) {
  if (allLayers(doc).some(({ scene, layer }) => scene !== ignoreScene && layer.type === 'duplicate' && layer.source?.layer === id)) return 'layer-copied';
  if ((doc.audio?.sources ?? []).some((a) => a.layer === id)) return 'layer-has-audio';
  return null;
}

export function addScene(doc, { name } = {}) {
  const n = label(name);
  if (!n) return { error: 'bad-name' };
  if (doc.scenes.length >= 256) return { error: 'too-many-scenes' };
  const project = structuredClone(doc);
  const scene = { id: newId('scene'), name: n, layers: [] };
  project.scenes.push(scene);
  return checked(project, { scene });
}

export function removeScene(doc, { scene } = {}) {
  const s = doc.scenes.find((x) => x.id === scene);
  if (!s) return { error: 'unknown-scene' };
  if (doc.activeScene === scene) return { error: 'scene-active' };
  if (doc.scenes.length <= 1) return { error: 'last-scene' };
  for (const l of s.layers) {
    const why = layerUse(doc, l.id, scene);
    if (why) return { error: why, layer: l.id };
  }
  const project = structuredClone(doc);
  project.scenes = project.scenes.filter((x) => x.id !== scene);
  return checked(project, {});
}

function rect(c, kind) {
  if (kind === 'text') {
    const w = Math.round(c.width * 0.4); const hh = Math.round(c.height * 0.1);
    return { visible: true, x: Math.round((c.width - w) / 2), y: Math.round((c.height - hh) / 2), width: w, height: hh };
  }
  return { visible: true, x: 0, y: 0, width: c.width, height: c.height };
}

export function addLayer(doc, p = {}) {
  const s = doc.scenes.find((x) => x.id === p.scene);
  if (!s) return { error: 'unknown-scene' };
  if (!KINDS.includes(p.kind)) return { error: 'bad-kind' };
  if (s.layers.length >= 64) return { error: 'too-many-layers' };
  const placements = Object.fromEntries(doc.canvases.map((c) => [c.id, rect(c, p.kind)]));
  let layer;
  if (p.kind === 'copy') {
    const hit = allLayers(doc).find(({ layer: l }) => l.id === p.of);
    if (!hit) return { error: 'unknown-layer' };
    const t = hit.layer;
    const target = t.type === 'duplicate' ? t.source.layer : t.id; // a copy points at the real layer
    layer = { id: newId('copy'), type: 'duplicate', name: `${t.name} copy`.slice(0, 120), source: { layer: target },
      placements: structuredClone(t.placements), ...(t.effects ? { effects: structuredClone(t.effects) } : {}) };
  } else if (p.kind === 'color') {
    if (typeof p.color !== 'string' || !COLOR.test(p.color)) return { error: 'bad-color' };
    layer = { id: newId('color'), type: 'color', name: 'Colour', source: { color: p.color }, placements };
  } else if (p.kind === 'text') {
    if (typeof p.text !== 'string' || p.text.length < 1 || p.text.length > 2000) return { error: 'bad-text' };
    layer = { id: newId('text'), type: 'text', name: label(p.text.split('\n')[0].slice(0, 40)) ?? 'Text', source: { text: p.text }, placements };
  } else if (p.kind === 'capture') {
    const d = (doc.devices ?? []).find((x) => x.id === p.device);
    if (!d || d.kind === 'microphone' || d.kind === 'audio-output') return { error: 'unknown-device' };
    layer = { id: newId('capture'), type: 'capture', name: d.name, source: { device: d.id }, placements };
  } else {
    const o = (doc.overlays ?? []).find((x) => x.id === p.overlay);
    if (!o) return { error: 'unknown-overlay' };
    const h = doc.canvases.find((c) => c.id === 'h') ?? doc.canvases[0];
    // The page renders at the H size; each canvas shows it full width at the page's aspect, from the top.
    const fit = Object.fromEntries(doc.canvases.map((c) => [c.id, { visible: true, x: 0, y: 0, width: c.width,
      height: Math.min(c.height, Math.round((c.width * h.height) / h.width)) }]));
    layer = { id: newId('overlay'), type: 'browser', name: o.name, source: { overlay: o.id, width: h.width, height: h.height }, placements: fit };
  }
  const project = structuredClone(doc);
  project.scenes.find((x) => x.id === p.scene).layers.push(layer);
  return checked(project, { layer });
}

export function removeLayer(doc, { scene, layer } = {}) {
  const s = doc.scenes.find((x) => x.id === scene);
  if (!s) return { error: 'unknown-scene' };
  if (!s.layers.some((l) => l.id === layer)) return { error: 'unknown-layer' };
  const why = layerUse(doc, layer, null);
  if (why) return { error: why };
  const project = structuredClone(doc);
  const ps = project.scenes.find((x) => x.id === scene);
  ps.layers = ps.layers.filter((l) => l.id !== layer);
  return checked(project, {});
}
