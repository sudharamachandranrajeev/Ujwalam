// SPDX-License-Identifier: GPL-3.0-or-later
// Mouse editing on the preview (P5, D230) against a real host (libobs, headless, no devices, no outputs, no windows).
// preview.editSim (--test-hooks) runs the same editor calls the preview window procedure makes for a mouse press,
// move and release in a preview of the given client size, so the hit test, drag maths, snapping, the commit through
// layer_set_placement and the edit log are all checked without a window. Real mouse use on a screen is not tested here.
//   node --test app/host/tests/host-preview-edit.test.mjs   (needs the built host and the OBS runtime)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
let h;
let c;

// H 1280x720 shown in a 640x400 client: scale 0.5, letterbox 20 px top and bottom. Screen = canvas / 2 + (0, 20).
const VIEW = { canvas: 'H', width: 640, height: 400 };
const scr = (x, y) => ({ x: x / 2, y: y / 2 + 20 });
const sim = (steps) => c.call('preview.editSim', { ...VIEW, steps });
const at = (event, x, y, mods = {}) => ({ event, ...scr(x, y), ...mods });
const placement = async (id) => (await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.find((l) => l.id === id).placement;

const PROJECT = {
  version: 1, id: 'preview-edit', name: 'Preview edit', activeScene: 'main',
  canvases: [{ id: 'h', width: 1280, height: 720, fps: 30 }, { id: 'v', width: 720, height: 1280, fps: 30 }],
  devices: [], overlays: [], outputs: [],
  scenes: [{
    id: 'main', name: 'Main', layers: [ // bottom to top
      { id: 'bg', type: 'color', name: 'Bg', source: { color: '#202020' },
        placements: { h: { visible: true, x: 0, y: 0, width: 1280, height: 720 }, v: { visible: true, x: 0, y: 0, width: 720, height: 1280 } } },
      { id: 'box', type: 'color', name: 'Box', source: { color: '#00ff00' },
        placements: { h: { visible: true, x: 100, y: 100, width: 200, height: 100 }, v: { visible: true, x: 50, y: 50, width: 300, height: 300 } } },
      { id: 'turned', type: 'color', name: 'Turned', source: { color: '#0000ff' },
        placements: { h: { visible: true, x: 600, y: 300, width: 200, height: 100, rotation: 90 } } },
      { id: 'hidden', type: 'color', name: 'Hidden', source: { color: '#ff0000' },
        placements: { h: { visible: false, x: 0, y: 0, width: 1280, height: 720 } } }
    ]
  }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
};

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'pedit-')), extraArgs: ['--test-hooks', '--headless'], env: { UJWALAM_HEADLESS: '1' } });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('flag off by default: no selection, no edit; test-format project: nothing to select', async () => {
  const st = await c.call('host.status');
  assert.equal(st.previewEditing, false, 'mouse editing starts off (flag preview-edit default false)');
  assert.equal(st.previewEditSeq, 0);
  let r = await sim([at('down', 960, 540), at('move', 1000, 560), at('up', 1000, 560)]);
  assert.deepEqual(r.steps.map((s) => s.used), [false, false, false], 'every event ignored while off');
  assert.equal(r.seq, 0);
  await c.call('preview.setEditing', { enabled: true });
  r = await sim([at('down', 960, 540), at('up', 960, 540)]);
  assert.equal(r.steps[0].layer, null, 'the default test-format project has no project placements to edit');
});

test('click selects the topmost visible layer (rotation respected, hidden skipped); empty canvas clears', async () => {
  await loadIntoHost(c, PROJECT);
  await c.call('preview.setEditing', { enabled: true });
  let r = await sim([at('down', 200, 150), at('up', 200, 150)]);
  assert.equal(r.view.y, 20, 'letterbox as draw_cb draws it');
  assert.equal(r.steps[0].layer, 'box', 'box, not the hidden full-canvas layer above it');
  assert.equal(r.steps[0].mode, 'move');
  assert.equal(r.steps[1].mode, 'none');
  assert.equal(r.seq, 0, 'a click without a move is not an edit');
  // turned: 200x100 at (600,300) turned 90 degrees about its centre (700,350) covers x 650..750, y 250..450
  r = await sim([at('down', 700, 430), at('up', 700, 430)]);
  assert.equal(r.steps[0].layer, 'turned', 'inside the turned box (outside its unturned box)');
  const t = await placement('turned'); // its centre is 10 px from the canvas centre line: a click must not snap it
  assert.deepEqual({ x: t.x, y: t.y }, { x: 600, y: 300 }, 'a click never moves or snaps a layer');
  r = await sim([at('down', 780, 350), at('up', 780, 350)]);
  assert.equal(r.steps[0].layer, 'bg', 'inside the unturned box but outside the turned one');
  r = await c.call('preview.editSim', { ...VIEW, steps: [{ event: 'down', x: 320, y: 5 }, { event: 'up', x: 320, y: 5 }] });
  assert.equal(r.steps[0].layer, null, 'a click on the letterbox (no layer) clears the selection');
  assert.equal(r.steps[0].used, true);
});

test('drag moves, snaps to the canvas edge (Alt: no snap), commits once through setPlacement', async () => {
  const before = await placement('box');
  let r = await sim([at('down', 200, 150), at('move', 250, 175), at('move', 300, 200), at('up', 300, 200)]);
  assert.equal(r.steps[0].layer, 'box');
  assert.deepEqual(r.steps[2].placement, { x: 200, y: 150, width: 200, height: 100 }, 'live move while dragging');
  assert.equal(r.seq, 1, 'one edit for the whole gesture');
  const p = await placement('box');
  assert.deepEqual({ x: p.x, y: p.y, width: p.width, height: p.height }, { x: 200, y: 150, width: 200, height: 100 });
  assert.equal(p.rotation ?? 0, before.rotation ?? 0);
  const v = (await c.call('layers.list', { scene: 'main', canvas: 'V' })).layers.find((l) => l.id === 'box').placement;
  assert.deepEqual({ x: v.x, y: v.y }, { x: 50, y: 50 }, 'the V placement is untouched (placement is per canvas)');
  const e = await c.call('preview.edits', { since: 0 });
  assert.equal(e.seq, 1);
  assert.equal(e.truncated, false);
  assert.deepEqual(e.edits, [{ seq: 1, canvas: 'H', scene: 'main', layer: 'box', placement: { x: 200, y: 150, width: 200, height: 100 },
    before: { x: before.x, y: before.y, width: before.width, height: before.height } }], 'before = the rectangle when the press began (undo, D238)');
  assert.equal((await c.call('host.status')).previewEditSeq, 1);

  // left edge 200 -> 10 (within 8 screen px = 16 canvas px of 0): snaps to 0; with Alt it stays at 10
  r = await sim([at('down', 300, 200), at('move', 110, 200, { alt: true }), at('up', 110, 200, { alt: true })]);
  assert.equal((await placement('box')).x, 10, 'Alt: no snap');
  r = await sim([at('down', 110, 200), at('move', 100, 200), at('move', 102, 200), at('up', 102, 200)]);
  assert.equal((await placement('box')).x, 0, 'snapped to the left canvas edge');
  assert.equal(r.seq, 3);
  assert.deepEqual((await c.call('preview.edits', { since: 2 })).edits.map((x) => x.seq), [3]);
});

test('corner drag resizes with the aspect kept (Shift: free); the opposite corner stays put', async () => {
  // box is (0,150) 200x100; bottom-right corner at (200,250)
  let r = await sim([at('down', 200, 250), at('move', 300, 250), at('up', 300, 250)]);
  assert.equal(r.steps[0].mode, 'resize');
  let p = await placement('box');
  assert.deepEqual({ x: p.x, y: p.y, width: p.width, height: p.height }, { x: 0, y: 150, width: 300, height: 150 }, 'aspect 2:1 kept');
  r = await sim([at('down', 300, 300), at('move', 400, 300, { shift: true }), at('up', 400, 300, { shift: true })]);
  p = await placement('box');
  assert.deepEqual({ x: p.x, y: p.y, width: p.width, height: p.height }, { x: 0, y: 150, width: 400, height: 150 }, 'Shift: free');
  // top-left corner (0,150) dragged to (100,200): bottom-right (400,300) fixed, aspect 400:150 kept
  r = await sim([at('down', 0, 150), at('move', 100, 200, { alt: true }), at('up', 100, 200, { alt: true })]);
  p = await placement('box');
  assert.equal(p.x + p.width, 400, 'right edge fixed');
  assert.equal(p.y + p.height, 300, 'bottom edge fixed');
  assert.ok(Math.abs(p.width / p.height - 400 / 150) < 0.02, `aspect kept: ${p.width}x${p.height}`);
});

test('rotate handle turns the layer about its centre (Shift: 15 degree steps); the edit is the rotation alone (D255)', async () => {
  const b = await placement('box');
  const mx = b.x + b.width / 2, my = b.y + b.height / 2;
  const seq0 = (await c.call('host.status')).previewEditSeq;
  await sim([at('down', mx, my), at('up', mx, my)]); // select it
  // handle: 24 screen px = 48 canvas px above the top edge's middle; dragged to the right of the centre = +90
  let r = await sim([at('down', mx, b.y - 48), at('move', mx + 100, my - 2), at('move', mx + 100, my), at('up', mx + 100, my)]);
  assert.equal(r.steps[0].mode, 'rotate');
  let p = await placement('box');
  assert.equal(p.rotation, 90);
  assert.deepEqual({ x: p.x, y: p.y, width: p.width, height: p.height }, { x: b.x, y: b.y, width: b.width, height: b.height }, 'position and size stay');
  const e = (await c.call('preview.edits', { since: seq0 })).edits;
  assert.deepEqual(e.map((x) => [x.placement, x.before]), [[{ rotation: 90 }, { rotation: b.rotation ?? 0 }]], 'one edit, rotation only (undo restores it)');
  // the handle turned with the box: now right of the centre. Shift: about 50 degrees back lands on 45
  const a = (40 * Math.PI) / 180;
  r = await sim([at('down', mx + b.height / 2 + 48, my), at('move', mx + 100 * Math.sin(a), my - 100 * Math.cos(a), { shift: true }),
    at('up', mx + 100 * Math.sin(a), my - 100 * Math.cos(a), { shift: true })]);
  assert.equal(r.steps[0].mode, 'rotate');
  assert.equal((await placement('box')).rotation, 45, 'Shift: 15 degree steps');
  // back upright, so the later tests see an unturned box
  const hx = mx + 48 * Math.SQRT1_2 + (b.height / 2) * Math.SQRT1_2, hy = my - 48 * Math.SQRT1_2 - (b.height / 2) * Math.SQRT1_2;
  await sim([at('down', hx, hy), at('move', mx, my - 100, { shift: true }), at('up', mx, my - 100, { shift: true })]);
  assert.equal((await placement('box')).rotation, 0);
});

test('Alt + edge drag crops that side: the box edge follows, the scale stays, the opposite edge stays put (D256)', async () => {
  const L = (await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.find((l) => l.id === 'box');
  const b = L.placement;
  assert.ok(L.width > 0 && L.height > 0, `source size known: ${L.width}x${L.height}`);
  const k = L.width / b.width; // source px per canvas px (no crop yet)
  const seq0 = (await c.call('host.status')).previewEditSeq;
  const my = b.y + b.height / 2;
  await sim([at('down', b.x + b.width / 2, my), at('up', b.x + b.width / 2, my)]); // select it
  let r = await sim([at('down', b.x, my, { alt: true }), at('move', b.x + 40, my + 6, { alt: true }), at('up', b.x + 40, my + 6, { alt: true })]);
  assert.equal(r.steps[0].mode, 'crop');
  let p = await placement('box');
  const left = Math.round(40 * k);
  assert.deepEqual(p.crop, { left, top: 0, right: 0, bottom: 0 }, 'cut by the same share as the box edge moved');
  assert.equal(p.x + p.width, b.x + b.width, 'right edge stays put');
  assert.deepEqual([p.y, p.height], [b.y, b.height], 'a side crop leaves the height alone');
  assert.ok(Math.abs(p.x - (b.x + left / k)) <= 1, `left edge follows the cut: ${p.x}`);
  const e = (await c.call('preview.edits', { since: seq0 })).edits;
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].before.crop, { left: 0, top: 0, right: 0, bottom: 0 }, 'undo puts the crop back');
  // dragged back out past the source edge: the crop stops at 0 and the box at the full picture
  r = await sim([at('down', p.x, my, { alt: true }), at('move', p.x - 200, my, { alt: true }), at('up', p.x - 200, my, { alt: true })]);
  p = await placement('box');
  assert.equal(p.crop.left, 0);
  assert.deepEqual([p.x, p.width], [b.x, b.width]);
  // without Alt the same press is the edge handle (resize that side, D330), not a crop
  r = await sim([at('down', p.x + 2, my), at('up', p.x + 2, my)]);
  assert.equal(r.steps[0].mode, 'resize');
  assert.deepEqual((await placement('box')).crop, { left: 0, top: 0, right: 0, bottom: 0 }, 'a click on the edge cuts nothing');
});

test('edge handle stretches that side alone (aspect free), snaps the moving edge, the opposite side stays put (D330)', async () => {
  await c.call('layers.setPlacement', { scene: 'main', canvas: 'H', layer: 'box',
    placement: { x: 300, y: 500, width: 200, height: 100, rotation: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } } });
  await sim([at('down', 400, 550), at('up', 400, 550)]); // select box
  const seq0 = (await c.call('host.status')).previewEditSeq;
  // hover cursors over the selected box (WM_SETCURSOR): corner, edges, inside, rotate handle, outside
  const hv = await sim([at('hover', 500, 600), at('hover', 300, 500), at('hover', 500, 550), at('hover', 400, 600),
    at('hover', 400, 550), at('hover', 400, 500 - 48), at('hover', 1000, 100)]);
  assert.deepEqual(hv.steps.map((s) => s.cursor), ['nwse', 'nwse', 'we', 'ns', 'move', 'rotate', 'arrow']);
  assert.equal(hv.seq, seq0, 'hovering changes nothing');
  // right edge (x 500) dragged 60 px right: width 260, height and left edge unchanged
  let r = await sim([at('down', 500, 550), at('move', 560, 552), at('up', 560, 552)]);
  assert.equal(r.steps[0].mode, 'resize');
  let p = await placement('box');
  assert.deepEqual([p.x, p.y, p.width, p.height], [300, 500, 260, 100], 'only the width changed');
  // bottom edge (y 600) dragged up 40 px: height 60, top stays
  r = await sim([at('down', 430, 600), at('move', 431, 560), at('up', 431, 560)]);
  p = await placement('box');
  assert.deepEqual([p.x, p.y, p.width, p.height], [300, 500, 260, 60], 'only the height changed');
  // left edge (x 300) dragged to x 6: snaps to the canvas edge (0); the right edge (560) stays
  r = await sim([at('down', 300, 530), at('move', 6, 530), at('up', 6, 530)]);
  assert.deepEqual(r.steps[1].snap, { x: 0, y: null }, 'guide line on the snapped edge');
  p = await placement('box');
  assert.deepEqual([p.x, p.width, p.height], [0, 560, 60], 'left edge snapped to 0, right edge fixed');
  // past the opposite edge: the box keeps at least 1 px
  r = await sim([at('down', 560, 530), at('move', -100, 530, { alt: true }), at('up', -100, 530, { alt: true })]);
  assert.equal(r.steps[0].mode, 'resize', 'Alt pressed after the press does not turn a resize into a crop');
  p = await placement('box');
  assert.deepEqual([p.x, p.width], [0, 1]);
  const e = (await c.call('preview.edits', { since: seq0 })).edits;
  assert.equal(e.length, 4, 'one edit per gesture');
  assert.deepEqual(e[0].before, { x: 300, y: 500, width: 200, height: 100 }, 'undo restores the rectangle');
});

test('lost capture puts the layer back; switching the flag off clears the selection and ignores the mouse', async () => {
  const before = await placement('box');
  const seq0 = (await c.call('host.status')).previewEditSeq;
  let r = await sim([at('down', before.x + 20, before.y + 20), at('move', before.x + 220, before.y + 120), { event: 'cancel' }]);
  assert.equal(r.seq, seq0, 'a cancelled drag is not an edit');
  const p = await placement('box');
  assert.deepEqual({ x: p.x, y: p.y }, { x: before.x, y: before.y }, 'back where the drag began');
  r = await sim([at('down', before.x + 20, before.y + 20)]);
  assert.equal(r.steps[0].mode, 'move');
  await c.call('preview.setEditing', { enabled: false });
  r = await sim([at('move', before.x + 200, before.y + 20), at('up', before.x + 200, before.y + 20)]);
  assert.deepEqual(r.steps.map((s) => [s.used, s.layer]), [[false, null], [false, null]], 'off mid-drag: nothing moves');
  assert.equal((await placement('box')).x, before.x);
  assert.equal((await c.call('host.status')).previewEditing, false);
});

test('moves and resizes snap to other layers\' edges and centres too (Alt: no snap); the guide shows while dragging (D272)', async () => {
  await c.call('preview.setEditing', { enabled: true });
  const put = (pl) => c.call('layers.setPlacement', { scene: 'main', canvas: 'H', layer: 'box',
    placement: { width: 200, height: 100, rotation: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 }, ...pl } });
  // turned covers x 650..750 (centre 700), y 250..450: its guides; bg covers the canvas (same as the canvas guides)
  await put({ x: 300, y: 500 });
  await sim([at('down', 400, 550), at('up', 400, 550)]); // select box
  // bottom-right corner (500,600) to x 695 (Shift: free): 5 px from turned's centre line 700
  let r = await sim([at('down', 500, 600), at('move', 695, 600, { shift: true }), at('up', 695, 600, { shift: true })]);
  assert.equal(r.steps[0].mode, 'resize');
  assert.deepEqual(r.steps[1].snap, { x: 700, y: null }, 'guide line on the turned layer\'s centre while dragging');
  assert.equal(r.steps[2].snap, undefined, 'no guide after the release');
  let p = await placement('box');
  assert.deepEqual([p.x, p.width, p.height], [300, 400, 100], 'right edge snapped to the other layer\'s centre');

  await put({ x: 300, y: 500 });
  // drag by +457: left edge 757, 7 px right of turned's right edge 750
  r = await sim([at('down', 400, 550), at('move', 857, 550), at('up', 857, 550)]);
  assert.deepEqual(r.steps[1].snap, { x: 750, y: null });
  assert.equal((await placement('box')).x, 750, 'left edge snapped against the other layer\'s right edge');
  await put({ x: 300, y: 500 });
  await sim([at('down', 400, 550), at('move', 857, 550, { alt: true }), at('up', 857, 550, { alt: true })]);
  assert.equal((await placement('box')).x, 757, 'Alt: no snap');
});

test('bad input is refused', async () => {
  await assert.rejects(c.call('preview.editSim', { ...VIEW, steps: [{ event: 'jump' }] }));
  await assert.rejects(c.call('preview.editSim', { canvas: 'X', width: 640, height: 400, steps: [] }));
  await assert.rejects(c.call('preview.setEditing', {}));
});

// Stand-alone preview placement (D316, pplace::fit_in through preview.placeSim; no window): the whole window stays inside
// the chosen display's work area. Work area 1920x1040 at 0,0 (a 1080p screen with a 40 px taskbar at the bottom).
test('placement (D316): the whole window is kept inside the work area, shrunk if larger', async () => {
  const work = { x: 0, y: 0, w: 1920, h: 1040 };
  const place = (want, w = work) => c.call('preview.placeSim', { work: w, want });
  // inside: unchanged
  assert.deepEqual(await place({ x: 100, y: 100, w: 976, h: 579 }), { x: 100, y: 100, w: 976, h: 579 });
  // near the right edge: moved left until the right edge fits
  assert.deepEqual(await place({ x: 1800, y: 100, w: 976, h: 579 }), { x: 944, y: 100, w: 976, h: 579 });
  // top-left on the taskbar: moved up until the bottom edge is above it
  assert.deepEqual(await place({ x: 100, y: 1050, w: 976, h: 579 }), { x: 100, y: 461, w: 976, h: 579 });
  // left of / above the work area: moved in
  assert.deepEqual(await place({ x: -500, y: -20, w: 400, h: 300 }), { x: 0, y: 0, w: 400, h: 300 });
  // larger than the work area: shrunk with the aspect kept (4000x2000 -> 1920x960), then placed inside
  assert.deepEqual(await place({ x: 50, y: 50, w: 4000, h: 2000 }), { x: 0, y: 50, w: 1920, h: 960 });
  // a second display to the left (negative coordinates)
  assert.deepEqual(await place({ x: -100, y: 900, w: 600, h: 400 }, { x: -1280, y: 0, w: 1280, h: 984 }), { x: -600, y: 584, w: 600, h: 400 });
});

test('preview.placeSim needs its parameters', async () => {
  await assert.rejects(c.call('preview.placeSim', { work: { x: 0, y: 0, w: 10, h: 10 } }));
  await assert.rejects(c.call('preview.placeSim', { work: { x: 0, y: 0, w: 10 }, want: { x: 0, y: 0, w: 1, h: 1 } }));
});
