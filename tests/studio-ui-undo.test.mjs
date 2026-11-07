// SPDX-License-Identifier: GPL-3.0-or-later
// Undo / redo of layer edits (P5b, D238): the history module, and the UI server routes on the fake host
// (placement, visibility, order; redo cleared by a new edit; refused while live; nothing to undo).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { beforeOf, createEditHistory } from '../services/studio-ui/edit-history.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);

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

test('beforeOf: only the keys the edit changes; crop and rotation defaults; unknown layer or key gives null', () => {
  const list = { layers: [{ id: 'a', visible: true, placement: { x: 1, y: 2, width: 3, height: 4 } }, { id: 'b', visible: false, placement: { x: 0, y: 0, width: 9, height: 9, crop: { left: 5 } } }] };
  assert.deepEqual(beforeOf('layers.setPlacement', { layer: 'a', placement: { x: 10, rotation: 45 } }, list), { placement: { x: 1, rotation: 0 } });
  assert.deepEqual(beforeOf('layers.setPlacement', { layer: 'b', placement: { crop: { left: 1, top: 2 } } }, list), { placement: { crop: { left: 5, top: 0 } } });
  assert.deepEqual(beforeOf('layers.setVisible', { layer: 'b', visible: true }, list), { visible: false });
  assert.deepEqual(beforeOf('layers.move', { layer: 'b', index: 0 }, list), { index: 1 });
  assert.equal(beforeOf('layers.move', { layer: 'zz', index: 0 }, list), null);
  assert.equal(beforeOf('layers.setPlacement', { layer: 'a', placement: { opacity: 1 } }, list), null);
});

test('history: no-op edits skipped, newest max kept, a new edit clears redo', () => {
  const h = createEditHistory({ max: 2 });
  const e = (i) => ({ method: 'layers.move', scene: 's', layer: 'l', before: { index: i }, after: { index: i + 1 } });
  assert.equal(h.record({ method: 'layers.move', scene: 's', layer: 'l', before: { index: 1 }, after: { index: 1 } }), false);
  h.record(e(0)); h.record(e(1)); h.record(e(2));
  assert.deepEqual(h.state(), { undo: 2, redo: 0, nextUndo: 'Reorder l', nextRedo: null });
  h.commitUndo();
  assert.equal(h.state().redo, 1);
  h.record(e(5));
  assert.equal(h.state().redo, 0);
});

test('server: undo and redo placement, visibility and order on the fake host; refused while live', async () => {
  const host = createFakeHost({ outputsReady: true });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, limits: { statusPollMs: 20 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const post = (url, body = {}) => raw(port, { method: 'POST', url, body: JSON.stringify(body),
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const layer = async (id) => (await host.call('layers.list', { scene: 'scene-1' })).layers.find((l) => l.id === id);
    const order = async () => (await host.call('layers.list', { scene: 'scene-1' })).layers.map((l) => l.id);

    assert.equal((await post('/ui/api/edits/undo')).body.error, 'nothing-to-undo');
    await post('/ui/api/host', { method: 'layers.setPlacement', params: { scene: 'scene-1', layer: 'cam', placement: { x: 100, y: 50 } } });
    await post('/ui/api/host', { method: 'layers.setVisible', params: { scene: 'scene-1', layer: 'chat', visible: true } });
    await post('/ui/api/host', { method: 'layers.move', params: { scene: 'scene-1', layer: 'game', index: 2 } });
    assert.deepEqual(await order(), ['cam', 'chat', 'game']);
    assert.deepEqual((await raw(port, { url: '/ui/api/edits', headers: { cookie } })).body, { undo: 3, redo: 0, nextUndo: 'Reorder game', nextRedo: null });

    let r = await post('/ui/api/edits/undo');
    assert.equal(r.status, 200);
    assert.deepEqual(await order(), ['game', 'cam', 'chat']);
    await post('/ui/api/edits/undo');
    assert.equal((await layer('chat')).visible, false);
    r = await post('/ui/api/edits/undo');
    assert.deepEqual(r.body.edits, { undo: 0, redo: 3, nextUndo: null, nextRedo: 'Move/resize cam' });
    const cam = (await layer('cam')).placement;
    assert.deepEqual({ x: cam.x, y: cam.y }, { x: 1440, y: 40 });

    await post('/ui/api/edits/redo');
    assert.deepEqual({ x: (await layer('cam')).placement.x, y: (await layer('cam')).placement.y }, { x: 100, y: 50 });
    assert.equal((await post('/ui/api/edits/redo')).status, 200);
    assert.equal((await layer('chat')).visible, true);

    await host.call('stream.start', {});
    r = await post('/ui/api/edits/undo');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'live-locked');
    assert.equal((await layer('chat')).visible, true, 'nothing changed while live');
  } finally { await srv.close(); }
});
