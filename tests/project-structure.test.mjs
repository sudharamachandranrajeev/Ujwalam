// SPDX-License-Identifier: GPL-3.0-or-later
// Scene and layer structure edits (P5b, D240): the pure project changes (services/project/structure.mjs) and the UI
// server route (/ui/api/project/structure: flag, live lock, host first, then the file; undo history cleared).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { addLayer, addScene, duplicateLayer, duplicateScene, moveLayer, removeLayer, removeScene, renameLayer, renameScene } from '../services/project/structure.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { listAssets } from '../services/studio-ui/assets.mjs';
import { SCENE_EDIT_FLAG, createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);

function base() {
  const doc = createProject({ name: 'T', fps: 30 });
  doc.devices = [{ id: 'cam', kind: 'camera', name: 'Camera', match: { name: 'Cam' } }, { id: 'mic', kind: 'microphone', name: 'Mic', match: { name: 'Mic' } }];
  doc.overlays = [{ id: 'alerts', name: 'Alerts', file: { base: 'overlays', rel: 'alerts.html' } }];
  doc.scenes[0].layers.push({ id: 'game', type: 'color', name: 'Game', source: { color: '#101010' },
    placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 }, v: { visible: true, x: 0, y: 0, width: 1080, height: 608 } } });
  const v = validateProject(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return doc;
}

test('addScene / removeScene: names checked; active, last and in-use scenes refused', () => {
  const doc = base();
  assert.equal(addScene(doc, { name: '  ' }).error, 'bad-name');
  const a = addScene(doc, { name: 'Starting soon' });
  assert.equal(a.project.scenes.length, 2);
  assert.equal(doc.scenes.length, 1, 'input unchanged');
  assert.equal(removeScene(a.project, { scene: doc.activeScene }).error, 'scene-active');
  assert.equal(removeScene(doc, { scene: 'nope' }).error, 'unknown-scene');
  const c = addLayer(a.project, { scene: a.scene.id, kind: 'copy', of: 'game' });
  assert.equal(removeScene({ ...c.project, activeScene: a.scene.id }, { scene: doc.activeScene }).error, 'layer-copied');
  assert.equal(removeScene(c.project, { scene: a.scene.id }).project.scenes.length, 1);
});

test('addLayer: copy points at the real layer with its placements; colour, text, capture, overlay; bad input refused', () => {
  const doc = base();
  const s = doc.activeScene;
  const c1 = addLayer(doc, { scene: s, kind: 'copy', of: 'game' });
  assert.deepEqual(c1.layer.source, { layer: 'game' });
  assert.deepEqual(c1.layer.placements, doc.scenes[0].layers[0].placements);
  const c2 = addLayer(c1.project, { scene: s, kind: 'copy', of: c1.layer.id });
  assert.deepEqual(c2.layer.source, { layer: 'game' }, 'a copy of a copy points at the real layer');
  assert.equal(addLayer(doc, { scene: s, kind: 'color', color: '#00ff00' }).layer.placements.v.height, 1920);
  const t = addLayer(doc, { scene: s, kind: 'text', text: 'Hello\nworld' });
  assert.equal(t.layer.name, 'Hello');
  assert.equal(t.layer.placements.h.width, 768);
  assert.equal(addLayer(doc, { scene: s, kind: 'capture', device: 'cam' }).layer.source.device, 'cam');
  assert.equal(addLayer(doc, { scene: s, kind: 'capture', device: 'mic' }).error, 'unknown-device');
  const o = addLayer(doc, { scene: s, kind: 'overlay', overlay: 'alerts' });
  assert.deepEqual(o.layer.source, { overlay: 'alerts', width: 1920, height: 1080 });
  assert.deepEqual(o.layer.placements.v, { visible: true, x: 0, y: 0, width: 1080, height: 608 });
  const img = addLayer(doc, { scene: s, kind: 'image', file: 'logos/main logo.png' });
  assert.deepEqual(img.layer.source, { file: { base: 'media', rel: 'logos/main logo.png' } });
  assert.equal(img.layer.name, 'main logo');
  assert.deepEqual(addLayer(doc, { scene: s, kind: 'media', file: 'intro.mp4' }).layer.source, { file: { base: 'media', rel: 'intro.mp4' }, loop: true });
  assert.equal(addLayer(doc, { scene: s, kind: 'image', file: '../x.png' }).error, 'bad-file');
  assert.equal(addLayer(doc, { scene: s, kind: 'image', file: 'C:/x.png' }).error, 'bad-file');
  assert.equal(addLayer(doc, { scene: s, kind: 'color', color: 'red' }).error, 'bad-color');
  assert.equal(addLayer(doc, { scene: s, kind: 'wipe' }).error, 'bad-kind');
  assert.equal(addLayer(doc, { scene: s, kind: 'image' }).error, 'bad-file');
  assert.equal(addLayer(doc, { scene: s, kind: 'copy', of: 'zz' }).error, 'unknown-layer');
});

test('removeLayer: refused while copied or bound to audio', () => {
  const doc = base();
  const s = doc.activeScene;
  const c = addLayer(doc, { scene: s, kind: 'copy', of: 'game' });
  assert.equal(removeLayer(c.project, { scene: s, layer: 'game' }).error, 'layer-copied');
  assert.equal(removeLayer(c.project, { scene: s, layer: c.layer.id }).project.scenes[0].layers.length, 1);
  const withAudio = structuredClone(doc);
  withAudio.audio.sources.push({ id: 'ga', name: 'Game', layer: 'game', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'] });
  assert.ok(validateProject(withAudio).ok, JSON.stringify(validateProject(withAudio).errors));
  assert.equal(removeLayer(withAudio, { scene: s, layer: 'game' }).error, 'layer-has-audio');
});

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('server: flag gate, live lock, host first then the file; a host refusal saves nothing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-struct-'));
  const file = path.join(dir, 'p.project.json');
  saveProject(file, base());
  const calls = [];
  const state = { live: false, refuse: false };
  const host = {
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      if (m === 'host.status') return { live: state.live, recording: false };
      if (['scenes.create', 'scenes.remove', 'layers.addFromProject', 'layers.remove'].includes(m)) {
        if (state.refuse) throw Object.assign(new Error('layer x cannot be built: device not found'), { code: 'RPC_-32010' });
        calls.push([m, m === 'layers.addFromProject' ? { scene: p.scene, layer: p.layer, scenes: p.project.scenes.length } : p]);
        return { ok: true };
      }
      return {};
    },
  };
  const flags = createFlags({ dataDir: dir });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const projectSync = createProjectSync({ file });
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body),
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const disk = () => JSON.parse(readFileSync(file, 'utf8'));

    assert.equal((await post({ op: 'scene.remove', scene: 'x' })).body.error, 'scene-edit-off', 'removing needs the flag');
    flags.set(SCENE_EDIT_FLAG, true);
    assert.equal((await post({ op: 'scene.add', name: 'X', extra: 1 })).status, 400);
    let r = await post({ op: 'scene.add', name: 'Starting soon' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sid = r.body.scene.id;
    assert.deepEqual(calls.map((c) => [c[0], c[1].scene.canvas]), [['scenes.create', 'H'], ['scenes.create', 'V']]);
    assert.equal(disk().scenes.length, 2);

    r = await post({ op: 'layer.add', scene: sid, kind: 'copy', of: 'game' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls.at(-1), ['layers.addFromProject', { scene: sid, layer: r.body.layer.id, scenes: 2 }]);
    assert.equal(disk().scenes[1].layers[0].source.layer, 'game');

    assert.equal((await post({ op: 'layer.remove', scene: disk().activeScene, layer: 'game' })).body.error, 'layer-copied');
    state.refuse = true;
    r = await post({ op: 'layer.add', scene: sid, kind: 'capture', device: 'cam' });
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /device not found/);
    assert.equal(disk().scenes[1].layers.length, 1, 'nothing saved after a host refusal');
    state.refuse = false;

    state.live = true;
    assert.equal((await post({ op: 'scene.remove', scene: sid })).body.error, 'live-locked');
    state.live = false;
    r = await post({ op: 'layer.remove', scene: sid, layer: disk().scenes[1].layers[0].id });
    assert.equal(r.status, 200);
    r = await post({ op: 'scene.remove', scene: sid });
    assert.equal(r.status, 200);
    assert.equal(disk().scenes.length, 1);
  } finally { await srv.close(); }
});

test('listAssets: images and videos only, relative with forward slashes, hidden names and depth limit respected', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-assets-'));
  mkdirSync(path.join(d, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  mkdirSync(path.join(d, '.hidden'));
  for (const f of ['x.PNG', 'notes.txt', 'clip.webm', 'a/y.jpg', 'a/b/c/d/deep.png', 'a/b/c/d/e/too-deep.png', '.hidden/z.png', '.dot.png']) writeFileSync(path.join(d, f), '');
  assert.deepEqual(listAssets(d), [{ rel: 'a/b/c/d/deep.png', kind: 'image' }, { rel: 'a/y.jpg', kind: 'image' }, { rel: 'clip.webm', kind: 'media' }, { rel: 'x.PNG', kind: 'image' }]);
  assert.equal(listAssets(d, { max: 2 }).length, 2);
  assert.deepEqual(listAssets(path.join(d, 'missing')), []);
  assert.deepEqual(listAssets(null), []);
});

test('server: an asset layer must name a file the listing offers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-struct2-'));
  const assets = path.join(dir, 'assets');
  mkdirSync(assets);
  writeFileSync(path.join(assets, 'logo.png'), '');
  const file = path.join(dir, 'p.project.json');
  saveProject(file, base());
  const calls = [];
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => { if (m === 'host.status') return { live: false }; if (m === 'layers.addFromProject') calls.push(p.layer); return {}; } };
  const flags = createFlags({ dataDir: dir });
  flags.set(SCENE_EDIT_FLAG, true);
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), assetsDir: assets, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body),
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const ch = (await raw(port, { url: '/ui/api/project/structure', headers: { cookie } })).body;
    assert.deepEqual(ch.assets, [{ rel: 'logo.png', kind: 'image' }]);
    const scene = ch.scenes[0].id;
    assert.equal((await post({ op: 'layer.add', scene, kind: 'image', file: 'other.png' })).body.error, 'unknown-asset');
    assert.equal((await post({ op: 'layer.add', scene, kind: 'media', file: 'logo.png' })).body.error, 'unknown-asset', 'kind must match');
    const r = await post({ op: 'layer.add', scene, kind: 'image', file: 'logo.png' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).scenes[0].layers.at(-1).source, { file: { base: 'media', rel: 'logo.png' } });
  } finally { await srv.close(); }
});

test('moveLayer (D243): passes the next layer on the chosen canvas; edges, other canvases and bad input refused', () => {
  const doc = base();
  const s = doc.scenes[0].id;
  // bottom first: game (H+V), vonly (V), top (H+V)
  let d = addLayer(doc, { scene: s, kind: 'color', color: '#ff0000' }).project;
  const vonly = d.scenes[0].layers.at(-1);
  vonly.id = 'vonly'; delete vonly.placements.h;
  d = addLayer(d, { scene: s, kind: 'color', color: '#00ff00' }).project;
  d.scenes[0].layers.at(-1).id = 'top';
  assert.ok(validateProject(d).ok, JSON.stringify(validateProject(d).errors));
  const ids = (r) => r.project.scenes[0].layers.map((l) => l.id);
  assert.deepEqual(ids(moveLayer(d, { scene: s, layer: 'game', canvas: 'h', direction: 'up' })), ['vonly', 'top', 'game'], 'on H it passes top, skipping the V-only layer');
  assert.deepEqual(ids(moveLayer(d, { scene: s, layer: 'game', canvas: 'v', direction: 'up' })), ['vonly', 'game', 'top'], 'on V it passes the V-only layer');
  assert.deepEqual(ids(moveLayer(d, { scene: s, layer: 'top', canvas: 'h', direction: 'down' })), ['top', 'game', 'vonly']);
  assert.equal(d.scenes[0].layers[0].id, 'game', 'input unchanged');
  assert.equal(moveLayer(d, { scene: s, layer: 'top', canvas: 'h', direction: 'up' }).error, 'at-edge');
  assert.equal(moveLayer(d, { scene: s, layer: 'game', canvas: 'v', direction: 'down' }).error, 'at-edge');
  assert.equal(moveLayer(d, { scene: s, layer: 'vonly', canvas: 'h', direction: 'up' }).error, 'not-on-canvas');
  assert.equal(moveLayer(d, { scene: s, layer: 'game', canvas: 'x', direction: 'up' }).error, 'bad-move');
  assert.equal(moveLayer(d, { scene: s, layer: 'game', canvas: 'h', direction: 'left' }).error, 'bad-move');
  assert.equal(moveLayer(d, { scene: s, layer: 'zz', canvas: 'h', direction: 'up' }).error, 'unknown-layer');
  assert.equal(moveLayer(d, { scene: 'zz', layer: 'game', canvas: 'h', direction: 'up' }).error, 'unknown-scene');
});

test('moveLayer to a target (D330, drag in the layer list): directly above or below it; other canvases keep their place', () => {
  const doc = base();
  const s = doc.scenes[0].id;
  // bottom first: game (H+V), vonly (V), mid (H+V), top (H+V)
  let d = addLayer(doc, { scene: s, kind: 'color', color: '#ff0000' }).project;
  const vonly = d.scenes[0].layers.at(-1);
  vonly.id = 'vonly'; delete vonly.placements.h;
  d = addLayer(d, { scene: s, kind: 'color', color: '#00ff00' }).project;
  d.scenes[0].layers.at(-1).id = 'mid';
  d = addLayer(d, { scene: s, kind: 'color', color: '#0000ff' }).project;
  d.scenes[0].layers.at(-1).id = 'top';
  assert.ok(validateProject(d).ok, JSON.stringify(validateProject(d).errors));
  const ids = (r) => (r.error ? r.error : r.project.scenes[0].layers.map((l) => l.id));
  const mv = (layer, target, place, canvas = 'h') => ids(moveLayer(d, { scene: s, layer, canvas, target, place }));
  assert.deepEqual(mv('game', 'top', 'above'), ['vonly', 'mid', 'top', 'game'], 'dragged from the bottom to the top');
  assert.deepEqual(mv('top', 'game', 'below'), ['top', 'game', 'vonly', 'mid'], 'dragged from the top to the bottom');
  assert.deepEqual(mv('top', 'game', 'above'), ['game', 'top', 'vonly', 'mid'], 'directly above the target');
  assert.deepEqual(mv('game', 'mid', 'below'), ['vonly', 'game', 'mid', 'top'], 'already right under mid on H: H order unchanged');
  assert.deepEqual(mv('game', 'vonly', 'above', 'v'), ['vonly', 'game', 'mid', 'top'], 'on V the V-only layer is a target');
  assert.equal(d.scenes[0].layers[0].id, 'game', 'input unchanged');
  assert.equal(mv('game', 'vonly', 'above'), 'not-on-canvas', 'the target must be on the canvas');
  assert.equal(mv('vonly', 'top', 'above'), 'not-on-canvas');
  assert.equal(mv('game', 'game', 'above'), 'bad-move', 'not onto itself');
  assert.equal(mv('game', 'zz', 'above'), 'unknown-layer');
  assert.equal(mv('game', 'top', 'over'), 'bad-move');
  assert.equal(ids(moveLayer(d, { scene: s, layer: 'game', canvas: 'h', target: 'top', place: 'above', direction: 'up' })), 'bad-move', 'target and direction together');
  assert.equal(ids(moveLayer(d, { scene: s, layer: 'game', canvas: 'h', target: 'top' })), 'bad-move', 'place missing');
});

test('server (D330): layer.remove and layer.move (direction or target) work with scene-edit OFF; still refused while live', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-struct5-'));
  const file = path.join(dir, 'p.project.json');
  let doc = base();
  const sid = doc.scenes[0].id;
  doc = addLayer(doc, { scene: sid, kind: 'color', color: '#00ff00' }).project;
  doc.scenes[0].layers.at(-1).id = 'cam';
  doc = addLayer(doc, { scene: sid, kind: 'color', color: '#0000ff' }).project;
  doc.scenes[0].layers.at(-1).id = 'chat';
  saveProject(file, doc);
  const calls = [];
  const state = { live: false };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    calls.push([m, p.scene, p.layer, p.project?.scenes?.[0]?.layers?.map((l) => l.id)]);
    return {};
  } };
  const flags = createFlags({ dataDir: dir }); // scene-edit stays off
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body), headers: hdr });
    const order = () => JSON.parse(readFileSync(file, 'utf8')).scenes[0].layers.map((l) => l.id);
    assert.equal(flags.isOn(SCENE_EDIT_FLAG), false);
    assert.deepEqual(order(), ['game', 'cam', 'chat']);
    // drag game (bottom) above chat (top)
    let r = await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', target: 'chat', place: 'above' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls, [['layers.orderFromProject', sid, undefined, ['cam', 'chat', 'game']]], 'the host reorders from the changed document');
    assert.deepEqual(order(), ['cam', 'chat', 'game'], 'saved');
    r = await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', direction: 'down' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(order(), ['cam', 'game', 'chat'], 'the one-step move needs no flag either');
    assert.equal((await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', target: 'chat', place: 'onto' })).body.error, 'bad-move');
    assert.equal((await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', target: 7, place: 'above' })).status, 400, 'target must be a string');
    assert.equal((await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', target: 'chat', place: 'above', extra: 1 })).status, 400, 'unknown key');
    state.live = true;
    calls.length = 0;
    assert.equal((await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', target: 'chat', place: 'above' })).body.error, 'live-locked');
    assert.equal((await post({ op: 'layer.remove', scene: sid, layer: 'cam' })).body.error, 'live-locked');
    assert.deepEqual(calls, [], 'nothing reached the host while live');
    assert.deepEqual(order(), ['cam', 'game', 'chat'], 'nothing saved while live');
    state.live = false;
    r = await post({ op: 'layer.remove', scene: sid, layer: 'cam' });
    assert.equal(r.status, 200, 'deleting a layer needs no flag: ' + JSON.stringify(r.body));
    assert.deepEqual(calls, [['layers.remove', sid, 'cam', undefined]]);
    assert.deepEqual(order(), ['game', 'chat']);
  } finally { await srv.close(); }
});

test('server: layer.move saves the project order after the host reorders from it; refused while live', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-struct3-'));
  const file = path.join(dir, 'p.project.json');
  const doc = base();
  const top = addLayer(doc, { scene: doc.scenes[0].id, kind: 'color', color: '#00ff00' });
  saveProject(file, top.project);
  const calls = [];
  const state = { live: false };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    if (m === 'layers.orderFromProject') calls.push([p.scene, p.project.scenes[0].layers.map((l) => l.id)]);
    return {};
  } };
  const flags = createFlags({ dataDir: dir });
  flags.set(SCENE_EDIT_FLAG, true);
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body),
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const disk = () => JSON.parse(readFileSync(file, 'utf8')).scenes[0].layers.map((l) => l.id);
    const scene = doc.scenes[0].id;
    assert.equal((await post({ op: 'layer.move', scene, layer: 'game', canvas: 'h', direction: 'up', index: 2 })).status, 400, 'unknown key');
    let r = await post({ op: 'layer.move', scene, layer: 'game', canvas: 'h', direction: 'up' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls, [[scene, [top.layer.id, 'game']]]);
    assert.deepEqual(disk(), [top.layer.id, 'game']);
    assert.equal((await post({ op: 'layer.move', scene, layer: 'game', canvas: 'h', direction: 'up' })).body.error, 'at-edge');
    state.live = true;
    r = await post({ op: 'layer.move', scene, layer: 'game', canvas: 'h', direction: 'down' });
    assert.equal(r.body.error, 'live-locked');
    assert.deepEqual(disk(), [top.layer.id, 'game'], 'nothing saved while live');
    assert.equal(calls.length, 1);
  } finally { await srv.close(); }
});

test('duplicateLayer (D292): new id and name, directly above the source, deep copy, valid project', () => {
  const doc = base();
  const s = doc.scenes[0].id;
  doc.scenes[0].layers[0].effects = [{ type: 'blur', strength: 4 }];
  const top = addLayer(doc, { scene: s, kind: 'color', color: '#00ff00' }).project; // game, <top>
  const topId = top.scenes[0].layers[1].id;
  const a = duplicateLayer(top, { scene: s, layer: 'game' });
  assert.ok(!a.error, JSON.stringify(a));
  assert.equal(a.layer.id, 'game-copy');
  assert.equal(a.layer.name, 'Game copy');
  assert.deepEqual(a.project.scenes[0].layers.map((l) => l.id), ['game', 'game-copy', topId], 'directly above the source, below the rest');
  assert.deepEqual(a.layer.placements, top.scenes[0].layers[0].placements);
  assert.deepEqual(a.layer.source, { color: '#101010' });
  assert.deepEqual(a.layer.effects, top.scenes[0].layers[0].effects);
  a.layer.effects[0].strength = 99;
  a.layer.source.color = '#ffffff';
  assert.equal(top.scenes[0].layers[0].source.color, '#101010', 'input untouched');
  assert.equal(a.project.scenes[0].layers[0].source.color, '#101010', 'the source is independent of the copy');
  assert.equal(a.project.scenes[0].layers[0].effects[0].strength, 4);
  assert.ok(validateProject(a.project).ok);
  const b = duplicateLayer(a.project, { scene: s, layer: 'game' });
  assert.equal(b.layer.id, 'game-copy-2');
  assert.equal(b.layer.name, 'Game copy 2');
  const c = duplicateLayer(b.project, { scene: s, layer: 'game-copy' });
  assert.equal(c.layer.id, 'game-copy-3', 'a copy of a copy takes the next free number');
  assert.equal(c.layer.name, 'Game copy 3');
  assert.equal(duplicateLayer(doc, { scene: s, layer: 'zz' }).error, 'unknown-layer');
  assert.equal(duplicateLayer(doc, { scene: 'zz', layer: 'game' }).error, 'unknown-scene');
  const long = structuredClone(doc);
  long.scenes[0].layers[0].id = 'x'.repeat(64);
  assert.ok(duplicateLayer(long, { scene: s, layer: 'x'.repeat(64) }).layer.id.length <= 64);
});

test('duplicateLayer: a device capture is copied as a layer showing the same source; a copy of a copy points at the real layer', () => {
  let doc = base();
  const s = doc.scenes[0].id;
  doc = addLayer(doc, { scene: s, kind: 'capture', device: 'cam' }).project;
  const cam = doc.scenes[0].layers.at(-1);
  const a = duplicateLayer(doc, { scene: s, layer: cam.id });
  assert.ok(!a.error, JSON.stringify(a));
  assert.equal(a.layer.type, 'duplicate');
  assert.deepEqual(a.layer.source, { layer: cam.id });
  assert.deepEqual(a.layer.placements, cam.placements);
  assert.equal(a.project.devices.length, doc.devices.length, 'devices are referenced, never cloned');
  const b = duplicateLayer(a.project, { scene: s, layer: a.layer.id });
  assert.deepEqual(b.layer.source, { layer: cam.id });
  assert.ok(validateProject(b.project).ok);
  doc = addLayer(doc, { scene: s, kind: 'overlay', overlay: 'alerts' }).project;
  const ov = doc.scenes[0].layers.at(-1);
  const o = duplicateLayer(doc, { scene: s, layer: ov.id });
  assert.equal(o.layer.type, 'browser');
  assert.deepEqual(o.layer.source, ov.source);
});

test('renameLayer / renameScene: trimmed, 1-80 characters, unknown ids refused', () => {
  const doc = base();
  const s = doc.scenes[0].id;
  assert.equal(renameLayer(doc, { scene: s, layer: 'game', name: '  Main game  ' }).layer.name, 'Main game');
  assert.equal(renameLayer(doc, { scene: s, layer: 'game', name: '   ' }).error, 'bad-name');
  assert.equal(renameLayer(doc, { scene: s, layer: 'game', name: 'x'.repeat(81) }).error, 'bad-name');
  assert.ok(!renameLayer(doc, { scene: s, layer: 'game', name: 'x'.repeat(80) }).error);
  assert.equal(renameLayer(doc, { scene: s, layer: 'game', name: 5 }).error, 'bad-name');
  assert.equal(renameLayer(doc, { scene: s, layer: 'zz', name: 'a' }).error, 'unknown-layer');
  assert.equal(renameLayer(doc, { scene: 'zz', layer: 'game', name: 'a' }).error, 'unknown-scene');
  assert.equal(doc.scenes[0].layers[0].name, 'Game', 'input unchanged');
  assert.equal(renameScene(doc, { scene: s, name: ' Intro ' }).project.scenes[0].name, 'Intro');
  assert.equal(renameScene(doc, { scene: s, name: '' }).error, 'bad-name');
  assert.equal(renameScene(doc, { scene: 'zz', name: 'a' }).error, 'unknown-scene');
});

test('duplicateScene: every layer copied with a new id in the same order; capture layers share the open source', () => {
  let doc = base();
  const s = doc.scenes[0].id;
  doc = addLayer(doc, { scene: s, kind: 'capture', device: 'cam' }).project;
  doc = addLayer(doc, { scene: s, kind: 'text', text: 'Hi' }).project;
  const r = duplicateScene(doc, { scene: s });
  assert.ok(!r.error, JSON.stringify(r));
  assert.equal(r.scene.id, `${s}-copy`.slice(0, 64));
  assert.equal(r.scene.name, `${doc.scenes[0].name} copy`);
  assert.equal(r.project.scenes[1].id, r.scene.id, 'right after the source');
  assert.deepEqual(r.layers.map((l) => l.name), doc.scenes[0].layers.map((l) => l.name), 'layer names stay');
  assert.deepEqual(r.layers.map((l) => l.type), ['color', 'duplicate', 'text']);
  assert.equal(r.layers[1].source.layer, doc.scenes[0].layers[1].id);
  const ids = r.project.scenes.flatMap((x) => x.layers.map((l) => l.id));
  assert.equal(new Set(ids).size, ids.length, 'layer ids unique across the project');
  assert.equal(r.project.activeScene, doc.activeScene);
  assert.ok(validateProject(r.project).ok);
  assert.equal(duplicateScene(r.project, { scene: s }).scene.id, `${s}-copy-2`.slice(0, 64));
  assert.equal(duplicateScene(doc, { scene: 'zz' }).error, 'unknown-scene');
});

test('server (D292): duplicate and rename work with scene-edit OFF; removing a scene still needs it; refused while live', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-struct4-'));
  const file = path.join(dir, 'p.project.json');
  const doc = base();
  saveProject(file, doc);
  const sid = doc.scenes[0].id;
  const calls = [];
  const state = { live: false, fail: false };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    if (m === 'layers.list') return { scene: sid, layers: [{ id: 'game', name: 'Game' }, { id: 'game-copy', name: 'Game copy' }] };
    if (m === 'scenes.list') return { scenes: [{ id: sid, name: 'Scene' }] };
    if (state.fail) throw new Error('host says no');
    calls.push([m, p.scene?.id ?? p.scene, p.layer]);
    return {};
  } };
  const flags = createFlags({ dataDir: dir }); // scene-edit stays off
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body), headers: hdr });
    const disk = () => JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(flags.isOn(SCENE_EDIT_FLAG), false);
    assert.equal((await post({ op: 'scene.remove', scene: sid })).body.error, 'scene-edit-off', 'removing a scene still needs the flag');
    // D330: layer.remove and layer.move need no flag (see the D330 test below); here the single layer is at the edge
    assert.equal((await post({ op: 'layer.move', scene: sid, layer: 'game', canvas: 'h', direction: 'up' })).body.error, 'at-edge');
    const choices = (await raw(port, { url: '/ui/api/project/structure', headers: { cookie } })).body;
    assert.deepEqual([choices.on, choices.available, choices.canvases], [false, true, ['h', 'v']], 'the add lists need no flag');
    assert.equal((await post({ op: 'layer.duplicate', scene: sid, layer: 'game', name: 'x' })).status, 400, 'unknown key');
    assert.equal((await post({ op: 'layer.rename', scene: sid, layer: 'game' })).body.error, 'bad-name');
    assert.equal((await post({ op: 'nope' })).status, 400);
    state.live = true;
    assert.equal((await post({ op: 'layer.duplicate', scene: sid, layer: 'game' })).body.error, 'live-locked');
    assert.equal((await post({ op: 'layer.rename', scene: sid, layer: 'game', name: 'A' })).body.error, 'live-locked');
    state.live = false;
    assert.equal(disk().scenes[0].layers.length, 1, 'nothing saved so far');
    let r = await post({ op: 'layer.duplicate', scene: sid, layer: 'game' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.layer, { id: 'game-copy', name: 'Game copy', type: 'color' });
    assert.deepEqual(calls, [['layers.addFromProject', sid, 'game-copy'], ['layers.orderFromProject', sid, undefined]], 'add, then order');
    assert.deepEqual(disk().scenes[0].layers.map((l) => l.id), ['game', 'game-copy']);
    state.fail = true; // a host refusal saves nothing
    r = await post({ op: 'layer.duplicate', scene: sid, layer: 'game' });
    assert.equal(r.status, 502);
    assert.equal(disk().scenes[0].layers.length, 2);
    state.fail = false;
    r = await post({ op: 'layer.rename', scene: sid, layer: 'game-copy', name: '  Overlay two ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(disk().scenes[0].layers[1].name, 'Overlay two');
    // the host has no rename: its lists carry the new name until it reloads the project
    const list = await raw(port, { method: 'POST', url: '/ui/api/host', body: JSON.stringify({ method: 'layers.list', params: { scene: sid } }), headers: hdr });
    assert.deepEqual(list.body.result.layers.map((l) => l.name), ['Game', 'Overlay two']);
    r = await post({ op: 'scene.rename', scene: sid, name: 'Opening' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(disk().scenes[0].name, 'Opening');
    const sl = await raw(port, { method: 'POST', url: '/ui/api/host', body: JSON.stringify({ method: 'scenes.list', params: {} }), headers: hdr });
    assert.equal(sl.body.result.scenes[0].name, 'Opening');
    calls.length = 0;
    r = await post({ op: 'layer.add', scene: sid, kind: 'color', color: '#00aa00' });
    assert.equal(r.status, 200, 'adding a layer needs no flag: ' + JSON.stringify(r.body));
    assert.equal(r.body.layer.type, 'color');
    assert.deepEqual(calls.map((c) => c[0]), ['layers.addFromProject']);
    r = await post({ op: 'scene.add', name: 'Brand new' });
    assert.equal(r.status, 200, 'adding a scene needs no flag: ' + JSON.stringify(r.body));
    state.live = true;
    assert.equal((await post({ op: 'layer.add', scene: sid, kind: 'color', color: '#00aa00' })).body.error, 'live-locked');
    assert.equal((await post({ op: 'scene.add', name: 'Y' })).body.error, 'live-locked');
    state.live = false;
    calls.length = 0;
    r = await post({ op: 'scene.duplicate', scene: sid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.scene.id, `${sid}-copy`.slice(0, 64));
    assert.deepEqual(calls.map((c) => c[0]), ['scenes.create', 'scenes.create', 'layers.addFromProject', 'layers.addFromProject', 'layers.addFromProject'], 'H and V scene, then the layers bottom first');
    assert.equal(disk().scenes.length, 3);
    assert.equal(disk().scenes[1].layers.length, 3, 'the copy follows the source, which now has the added colour layer');
    assert.equal(validateProject(disk()).ok, true);
  } finally { await srv.close(); }
});
