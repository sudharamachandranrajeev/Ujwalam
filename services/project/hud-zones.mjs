// SPDX-License-Identifier: GPL-3.0-or-later
// HUD safe-zone check (end-list L12/L13, option a: warn only). Finds overlay layers drawn above the game capture that
// cover the game's HUD areas (data/games/<id>/hud-zones.json: boxes as fractions of the full game source frame).
// Layer placement = canvas px of the shown (cropped) picture; crop = source px (project.schema.json placement).
// Skipped: hidden layers, full-canvas layers (effect and atmosphere pages, mostly transparent and event-driven),
// fully transparent colour placeholders, and copies of the game itself (duplicate layers).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIN_COVER = 0.05; // share of a zone's area an overlay must cover before it is reported
const FULL_CANVAS = 0.9;

export function loadHudZones(gameId, root = REPO) {
  if (!/^[a-z0-9-]{1,32}$/.test(gameId)) throw new Error('bad game id');
  return JSON.parse(readFileSync(path.join(root, 'data', 'games', gameId, 'hud-zones.json'), 'utf8'));
}

const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const meet = (a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const transparent = (l) => l.type === 'color' && /^#[0-9a-f]{6}00$/i.test(l.source?.color ?? '');

/** Canvas rectangle of a zone, through the game layer's placement and crop. source: {width, height} of the capture. */
export function zoneRect(box, px, source) {
  const c = px.crop ?? {};
  const sw = source.width - (c.left ?? 0) - (c.right ?? 0);
  const sh = source.height - (c.top ?? 0) - (c.bottom ?? 0);
  if (sw <= 0 || sh <= 0) return null;
  const fx = (f) => px.x + (f * source.width - (c.left ?? 0)) * (px.width / sw);
  const fy = (f) => px.y + (f * source.height - (c.top ?? 0)) * (px.height / sh);
  // clip to the shown picture: HUD cut away by the crop is not on stream
  return meet({ x0: fx(box.x0), y0: fy(box.y0), x1: fx(box.x1), y1: fy(box.y1) }, { x0: px.x, y0: px.y, x1: px.x + px.width, y1: px.y + px.height });
}

/** Overlays above the game that cover HUD zones on one canvas of one scene.
 *  scene.layers is bottom-to-top. Returns [{layer, name, zone, cover}] with cover = share of the zone's shown area. */
export function hudCoverage({ scene, canvas, gameOrigin, zones, source = { width: 1920, height: 1080 }, canvasSize }) {
  const layers = scene.layers ?? [];
  const gi = layers.findIndex((l) => l.origin?.id === gameOrigin);
  const game = layers[gi];
  const gpx = game?.placements?.[canvas];
  if (!gpx || gpx.visible === false) return [];
  const full = (canvasSize?.width ?? 0) * (canvasSize?.height ?? 0);
  const rects = zones.zones.map((z) => ({ z, r: zoneRect(z.box, gpx, source) })).filter((x) => x.r && area(x.r) > 0);
  const out = [];
  for (const l of layers.slice(gi + 1)) {
    const px = l.placements?.[canvas];
    if (!px || px.visible === false || l.type === 'duplicate' || transparent(l)) continue;
    const lr = { x0: px.x, y0: px.y, x1: px.x + px.width, y1: px.y + px.height };
    if (full && area(lr) >= FULL_CANVAS * full) continue;
    for (const { z, r } of rects) {
      const cover = area(meet(lr, r)) / area(r);
      if (cover >= MIN_COVER) out.push({ layer: l.id, name: l.name ?? l.id, zone: z.id, cover: Math.round(cover * 100) / 100 });
    }
  }
  return out;
}
