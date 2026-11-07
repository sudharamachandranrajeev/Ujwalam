// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { hudCoverage, loadHudZones, zoneRect } from '../services/project/hud-zones.mjs';

const ZONES = loadHudZones('codm');
// geometry of the default H game layer (2026-11-07 alpha project): 177 px cropped per side, scaled into a frame
const GAME = { id: 'g', type: 'capture', origin: { id: 'scene-default-h/game' }, placements: { h: { visible: true, x: 467.96, y: 31.18, width: 1417.8, height: 977.84, crop: { left: 177, right: 177 } } } };
const layer = (id, px, extra = {}) => ({ id, name: id, type: 'browser', placements: { h: { visible: true, ...px } }, ...extra });
const run = (layers) => hudCoverage({ scene: { layers }, canvas: 'h', gameOrigin: 'scene-default-h/game', zones: ZONES, canvasSize: { width: 1920, height: 1080 } });

test('zones file: unverified, boxes inside the frame', () => {
  assert.equal(ZONES.status, 'unverified');
  for (const z of ZONES.zones) {
    const b = z.box;
    assert.ok(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 1 && b.y1 <= 1 && b.x0 < b.x1 && b.y0 < b.y1, z.id);
  }
});

test('zoneRect maps source fractions through crop and scale, clipped to the shown picture', () => {
  const r = zoneRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, GAME.placements.h, { width: 1920, height: 1080 });
  assert.deepEqual([r.x0, r.y0, r.x1, r.y1].map(Math.round), [468, 31, 1886, 1009]);
});

test('an overlay over the score/timer is reported; one beside the game is not', () => {
  const cta = layer('cta', { x: 1015.41, y: 24.34, width: 342.72, height: 87.1 }, { type: 'image' });
  const side = layer('side', { x: 11.52, y: 114.48, width: 391.68, height: 103.68 });
  const hits = run([GAME, cta, side]);
  assert.deepEqual(hits.map((h) => [h.layer, h.zone]), [['cta', 'score-timer']]);
  assert.ok(hits[0].cover >= 0.05);
});

test('skipped: layers below the game, hidden, full-canvas, transparent placeholders, game copies', () => {
  const over = { x: 1015, y: 24, width: 343, height: 87 };
  const hits = run([
    layer('below', over), GAME,
    layer('hidden', { ...over, visible: false }),
    layer('fx', { x: 0, y: 0, width: 1920, height: 1080 }),
    layer('ph', over, { type: 'color', source: { color: '#00000000' } }),
    layer('dup', over, { type: 'duplicate' }),
  ]);
  assert.deepEqual(hits, []);
});
