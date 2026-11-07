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

test('bad input is refused', async () => {
  await assert.rejects(c.call('preview.editSim', { ...VIEW, steps: [{ event: 'jump' }] }));
  await assert.rejects(c.call('preview.editSim', { canvas: 'X', width: 640, height: 400, steps: [] }));
  await assert.rejects(c.call('preview.setEditing', {}));
});
