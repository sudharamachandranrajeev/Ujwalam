// SPDX-License-Identifier: GPL-3.0-or-later
// Scene and layer structure edits on a loaded project v1 (P5b, D240): layers.addFromProject builds one layer of the
// changed project document on every canvas it has a placement on, at its project position, sharing the source of the
// layer it duplicates; refusals change nothing. scenes.create / scenes.remove / layers.remove on project v1 scenes.
//   node --test app/host/tests/host-structure.test.mjs   (needs the built host and the OBS runtime)
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

const full = (cv) => (cv === 'h' ? { visible: true, x: 0, y: 0, width: 1280, height: 720 } : { visible: true, x: 0, y: 0, width: 720, height: 1280 });
const PROJECT = {
  version: 1, id: 'structure', name: 'Structure', activeScene: 'main',
  canvases: [{ id: 'h', width: 1280, height: 720, fps: 30 }, { id: 'v', width: 720, height: 1280, fps: 30 }],
  devices: [], overlays: [], outputs: [],
  scenes: [
    { id: 'main', name: 'Main', layers: [
      { id: 'bg', type: 'color', name: 'Bg', source: { color: '#202020' }, placements: { h: full('h'), v: full('v') } },
      { id: 'top', type: 'color', name: 'Top', source: { color: '#00ff00' }, placements: { h: { visible: true, x: 10, y: 10, width: 100, height: 100 } } },
    ] },
    { id: 'other', name: 'Other', layers: [] },
  ],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
};
const ids = async (scene, canvas) => (await c.call('layers.list', { scene, canvas })).layers.map((l) => l.id);
async function code(method, params) {
  try { await c.call(method, params); } catch (e) { return e.code; }
  return null;
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'struct-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' } });
  c = h.client;
  await loadIntoHost(c, PROJECT);
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('addFromProject: a new layer lands at its project position on each canvas it has a placement on', async () => {
  const doc = structuredClone(PROJECT);
  doc.scenes[0].layers.splice(1, 0, { id: 'mid', type: 'text', name: 'Mid', source: { text: 'hello' },
    placements: { h: { visible: true, x: 0, y: 0, width: 200, height: 50 }, v: { visible: false, x: 0, y: 0, width: 200, height: 50 } } });
  const r = await c.call('layers.addFromProject', { project: doc, scene: 'main', layer: 'mid' });
  assert.deepEqual(r.canvases.sort(), ['H', 'V']);
  assert.deepEqual(await ids('main', 'H'), ['bg', 'mid', 'top']);
  assert.deepEqual(await ids('main', 'V'), ['bg', 'mid'], 'V has no "top"');
  const v = (await c.call('layers.list', { scene: 'main', canvas: 'V' })).layers.find((l) => l.id === 'mid');
  assert.equal(v.visible, false);
  assert.equal((await c.call('project.get')).project.scenes[0].layers[1].id, 'mid', 'the doc became the host model');
  PROJECT.scenes = doc.scenes;
});

test('addFromProject: a duplicate in another scene shares the source; refusals change nothing', async () => {
  const doc = structuredClone(PROJECT);
  doc.scenes[1].layers.push({ id: 'bg-copy', type: 'duplicate', name: 'Bg copy', source: { layer: 'bg' }, placements: { h: full('h') } });
  await c.call('layers.addFromProject', { project: doc, scene: 'other', layer: 'bg-copy' });
  const l = (await c.call('layers.list', { scene: 'other', canvas: 'H' })).layers[0];
  assert.equal(l.duplicateOf, 'bg');
  assert.equal(l.source, 'bg', 'the source of bg, not a new one');
  assert.deepEqual(await ids('other', 'V'), [], 'no V placement: not on V');

  assert.equal(await code('layers.addFromProject', { project: doc, scene: 'other', layer: 'bg-copy' }), -32009, 'already there');
  assert.equal(await code('layers.addFromProject', { project: doc, scene: 'other', layer: 'nope' }), -32602, 'not in the doc');
  assert.equal(await code('layers.addFromProject', { project: doc, scene: 'gone', layer: 'bg' }), -32602, 'no such scene');
  assert.equal(await code('layers.addFromProject', { project: { scenes: [] }, scene: 'main', layer: 'bg' }), -32602, 'not a project v1');
  assert.deepEqual(await ids('other', 'H'), ['bg-copy']);
});

test('scenes.create / scenes.remove / layers.remove on project v1 scenes', async () => {
  for (const canvas of ['H', 'V']) await c.call('scenes.create', { scene: { id: 'new', canvas, name: 'New' } });
  const list = (await c.call('scenes.list')).scenes.filter((s) => s.id === 'new');
  assert.equal(list.length, 2);
  const doc = structuredClone(PROJECT);
  doc.scenes.push({ id: 'new', name: 'New', layers: [{ id: 'red', type: 'color', name: 'Red', source: { color: '#ff0000' }, placements: { v: full('v') } }] });
  await c.call('layers.addFromProject', { project: doc, scene: 'new', layer: 'red' });
  assert.deepEqual(await ids('new', 'V'), ['red']);
  await c.call('layers.remove', { scene: 'new', layer: 'red' });
  assert.deepEqual(await ids('new', 'V'), []);
  assert.equal(await code('scenes.remove', { scene: 'main' }), -32009, 'active scene is refused');
  await c.call('scenes.remove', { scene: 'new' });
  assert.equal((await c.call('scenes.list')).scenes.some((s) => s.id === 'new'), false);
});

test('orderFromProject (D243): each canvas takes the document order; layers not on a canvas are skipped there', async () => {
  const doc = structuredClone(PROJECT); // earlier tests may have added layers to PROJECT; the checks follow the document
  doc.scenes[0].layers.splice(1, 0, { id: 'blue', type: 'color', name: 'Blue', source: { color: '#0000ff' }, placements: { h: full('h'), v: full('v') } });
  const on = (d, cv) => d.scenes[0].layers.filter((l) => l.placements[cv]).map((l) => l.id);
  await loadIntoHost(c, doc);
  assert.deepEqual(await ids('main', 'H'), on(doc, 'h'));
  assert.deepEqual(await ids('main', 'V'), on(doc, 'v'));
  const moved = structuredClone(doc);
  moved.scenes[0].layers.push(moved.scenes[0].layers.shift()); // bg to the top
  const r = await c.call('layers.orderFromProject', { project: moved, scene: 'main' });
  assert.deepEqual(r.canvases.sort(), ['H', 'V']);
  assert.equal((await ids('main', 'H')).at(-1), 'bg');
  assert.deepEqual(await ids('main', 'H'), on(moved, 'h'));
  assert.deepEqual(await ids('main', 'V'), on(moved, 'v'));
  assert.equal(await code('layers.orderFromProject', { project: moved, scene: 'nope' }), -32602);
  assert.equal(await code('layers.orderFromProject', { project: { x: 1 }, scene: 'main' }), -32602);
  assert.deepEqual(await ids('main', 'H'), on(moved, 'h'), 'refusals change nothing');
});
