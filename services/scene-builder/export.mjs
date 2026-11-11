// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB5 (D347): save a scene of the studio's project (typically a built scene the user then moved, resized
// or re-ordered in the studio) as a scene package, so it can be imported again (here or into another project of the
// same sources). Read only: the project is not changed and nothing is written; the caller saves the package.
//
//   packageFromScene(project, scene, { now, rules }) -> { package, skipped }
//
// Per canvas, each placed layer becomes a package layer at its placement (fractions of the canvas):
//   duplicate of a layer -> link (game or camera, by the layer's origin key), the real layer goes to bindings.links
//   capture              -> capture (game or camera by origin key), the device goes to bindings.roles
//   browser (overlay)    -> browser with the overlay's file and query (chat, alerts, panels)
//   colour               -> colour (a transparent one stays a placeholder)
// Anything else (images, media, hidden layers, a link whose role is unknown, a second target for the same role) is
// not carried and is listed in `skipped` with the reason; a rotation, opacity or effect on a carried layer is dropped
// and named in the warnings. Nothing is guessed: slot confidence is 1 and `from` is "edit" (the user's placement).

import { createHash } from 'node:crypto';
import { PACKAGE_FORMAT, PACKAGE_VERSION, BUILDER_VERSION, loadBuildRules } from './build.mjs';
import { realLayer } from '../project/scene-preset.mjs';

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;
const LINK_ROLE = { game: 'game', camera: 'camera' };
const CAPTURE_ROLE = { game: 'game-capture', camera: 'facecam' };

export class ExportError extends Error {
  constructor(message) { super(message); this.name = 'ExportError'; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30);

/** The scene by id or exact name. */
export function findScene(project, ref) {
  const hit = project.scenes.filter((s) => s.id === ref);
  const byName = hit.length ? hit : project.scenes.filter((s) => s.name === ref);
  if (byName.length === 0) throw new ExportError(`no scene "${ref}" in the project`);
  if (byName.length > 1) throw new ExportError(`more than one scene is named "${ref}"; use its id`);
  return byName[0];
}

export function packageFromScene(project, scene, { now = new Date(), rules = loadBuildRules() } = {}) {
  if (typeof scene === 'string') scene = findScene(project, scene);
  const sizes = Object.fromEntries(project.canvases.map((c) => [c.id, { width: c.width, height: c.height }]));
  const prefix = scene.origin?.importer === 'scene-package' ? `${scene.origin.id}-` : null;
  const links = {}, roles = {}, skipped = [], warnings = [];
  const byCanvas = { h: [], v: [] };
  const used = { h: new Set(), v: new Set() };

  const keyOf = (layer, canvas) => {
    let key = null;
    const id = layer.origin?.id ?? '';
    const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : null;
    if (tail && KEY_RE.test(tail) && (prefix === null || id.startsWith(prefix))) key = tail;
    if (!key || used[canvas].has(key)) key = slug(layer.name) || 'layer';
    let k = key, n = 1;
    while (used[canvas].has(k)) k = `${key.slice(0, 36)}-${++n}`;
    used[canvas].add(k);
    return k;
  };
  const roleOf = (key) => (key === 'game' || key === 'camera' || key === 'chat' || key === 'alerts' ? key : 'graphics');

  for (const l of scene.layers) {
    for (const canvas of Object.keys(l.placements)) {
      if (canvas !== 'h' && canvas !== 'v') { skipped.push({ canvas, name: l.name, reason: 'unknown canvas' }); continue; }
      const pl = l.placements[canvas], cv = sizes[canvas];
      const skip = (reason) => skipped.push({ canvas, name: l.name, reason });
      if (!cv) { skip(`the project has no ${canvas.toUpperCase()} canvas`); continue; }
      if (pl.visible === false) { skip('hidden'); continue; }
      const key = keyOf(l, canvas), role = roleOf(key);
      const rect = { x: r4(pl.x / cv.width), y: r4(pl.y / cv.height), w: r4(pl.width / cv.width), h: r4(pl.height / cv.height) };
      const base = { key, name: l.name, z: 0, rect, slot: { role, confidence: 1, from: 'edit' } };
      if (pl.crop) base.crop = { left: pl.crop.left ?? 0, top: pl.crop.top ?? 0, right: pl.crop.right ?? 0, bottom: pl.crop.bottom ?? 0 };
      let layer = null;
      if (l.type === 'duplicate') {
        const r = LINK_ROLE[key], target = realLayer(project, l.source.layer);
        if (!r) skip('a link to another layer whose role (game or camera) is unknown');
        else if (!target) skip('its source layer is not in the project');
        else if (links[r] && links[r] !== target) skip(`${r} already links to a different layer`);
        else { links[r] = target; layer = { ...base, type: 'link', role: r }; }
      } else if (l.type === 'capture') {
        const r = CAPTURE_ROLE[key];
        if (!r) skip('a capture whose role (game or camera) is unknown');
        else if (roles[r] && roles[r] !== l.source.device) skip(`${r} already uses a different device`);
        else { roles[r] = l.source.device; layer = { ...base, type: 'capture', role: r }; }
      } else if (l.type === 'browser') {
        const ov = project.overlays.find((o) => o.id === l.source.overlay);
        if (!ov || ov.file.base !== 'overlays') skip('its overlay is not an overlay-folder page');
        else layer = { ...base, type: 'browser', overlay: ov.file.rel, query: l.source.query ?? '' };
      } else if (l.type === 'color') {
        const c = /^#[0-9a-f]{6}$/i.test(l.source.color) ? `${l.source.color}ff` : l.source.color;
        if (!/^#[0-9a-f]{8}$/i.test(c)) skip('its colour is not a hex colour');
        else layer = /00$/i.test(c) ? { ...base, type: 'color', color: c, placeholder: 'kept as a placeholder from the scene' } : { ...base, type: 'color', color: c };
      } else skip(`a ${l.type} layer is not carried by a scene package`);
      if (!layer) { used[canvas].delete(key); continue; }
      if (pl.rotation || (typeof pl.opacity === 'number' && pl.opacity !== 1) || l.effects?.length) warnings.push(`${canvas}: ${l.name}: rotation, opacity or effects are not carried`);
      byCanvas[canvas].push(layer);
    }
  }
  for (const c of ['h', 'v']) byCanvas[c].forEach((l, i) => { l.z = i; });
  const canvases = ['h', 'v'].filter((c) => byCanvas[c].length);
  if (!canvases.length) throw new ExportError('the scene has no layer a scene package can carry');

  const name = scene.name.slice(0, 100);
  const digest = createHash('sha256').update(JSON.stringify({ n: name, byCanvas, links, roles })).digest('hex').slice(0, 10);
  const id = `sb-${digest}`;
  const size = sizes[canvases[0]];
  const placeholders = canvases.flatMap((canvas) => byCanvas[canvas].filter((l) => l.placeholder).map((l) => ({ canvas, key: l.key, role: l.slot.role, reason: l.placeholder })));
  return {
    package: {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      id,
      name,
      created: now.toISOString(),
      builder: { tool: 'scene-builder/export', version: BUILDER_VERSION, rulesVersion: rules.version },
      reference: { name: name.slice(0, 255), kind: 'image', canvas: canvases[0].toUpperCase(), width: size.width, height: size.height },
      theme: null,
      bindings: { links, roles },
      sources: {},
      presets: canvases.map((canvas) => ({
        id: `${id}-${canvas}`, version: '0.1.0', function: 'scene-layout-preset', functionVersion: '^0.1.0',
        name: `${name} (${canvas.toUpperCase()})`,
        params: { sceneName: name, canvas, layers: byCanvas[canvas] },
      })),
      placeholders,
      notCarried: skipped.map((s) => ({ canvas: s.canvas, role: 'layer', count: 1, reason: `${s.name}: ${s.reason}` })),
      warnings,
      lineage: { parent: scene.origin?.importer === 'scene-package' ? scene.origin.id : null, changes: ['exported from the studio scene'], scene: scene.id, skipped },
    },
    skipped,
  };
}
