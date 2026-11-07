// SPDX-License-Identifier: GPL-3.0-or-later
// Scene and layer structure edits (P5b, D240): the pure project changes (services/project/structure.mjs) and the UI
// server route (/ui/api/project/structure: flag, live lock, host first, then the file; undo history cleared).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { addLayer, addScene, removeLayer, removeScene } from '../services/project/structure.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
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
  assert.equal(addLayer(doc, { scene: s, kind: 'color', color: 'red' }).error, 'bad-color');
  assert.equal(addLayer(doc, { scene: s, kind: 'image' }).error, 'bad-kind');
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

    assert.equal((await post({ op: 'scene.add', name: 'X' })).body.error, 'scene-edit-off');
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
