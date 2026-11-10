// SPDX-License-Identifier: GPL-3.0-or-later
// Effect editor, UI server side (D260, D290): layers.setEffects needs no flag (the Look panel; flag effect-editor only shows the
// Advanced list), passes the whole list to the host when on, saves it into the project file (an empty list removes it), can be
// undone and redone, acts on the click while live (D332), and refuses a list that is not a short array of typed objects.
// Stub host (kind 'host'); real flags and project-sync on temp files.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const SAMPLE = path.join(HERE, 'fixtures', 'project', 'sample.project.json');
const KEY = 'k'.repeat(48);
const FLAG = 'effect-editor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); }
  assert.fail(`timed out: ${what}`);
}

// A host that keeps each layer's effects like the real one (layers.list reports them; setEffects replaces them).
function stubHost() {
  const st = { live: false, calls: [], effects: { 'layer-cam': [] } };
  return {
    st,
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      st.calls.push([m, structuredClone(p)]);
      if (m === 'host.status') return { live: st.live, recording: false };
      if (m === 'layers.list') return { layers: Object.entries(st.effects).map(([id, e]) => ({ id, ...(e.length ? { effects: e } : {}) })) };
      if (m === 'layers.setEffects') { st.effects[p.layer] = structuredClone(p.effects); return { scene: p.scene, layer: p.layer, effects: p.effects }; }
      return {};
    },
  };
}

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-fxed-'));
  const file = path.join(dir, 'alpha.project.json');
  copyFileSync(SAMPLE, file);
  const host = stubHost();
  const flags = createFlags({ dataDir: dir });
  const projectSync = createProjectSync({ file, delayMs: 5 });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync, limits: { statusPollMs: 20 } });
  const { port } = await srv.listen();
  const login = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = login.headers?.['set-cookie']?.[0]?.split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  const csrf = JSON.parse(s.text).csrf;
  const post = async (route, body) => {
    const r = await raw(port, { method: 'POST', url: route, body: JSON.stringify(body),
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    return { status: r.status, body: JSON.parse(r.text) };
  };
  const status = async () => JSON.parse((await raw(port, { url: '/ui/api/status', headers: { cookie } })).text);
  return { srv, host, flags, file, post, status };
}

const layerOf = (file, layer) => JSON.parse(readFileSync(file, 'utf8')).scenes.find((s) => s.id === 'scene-main').layers.find((l) => l.id === layer);
const SHADOW = { type: 'shadow', color: '#000000', opacity: 0.5, size: 10, distance: 10, angle: 135 };
const TONER = { type: 'toner', shadows: '#000000', darktones: '#404040', midtones: '#808080', brights: '#c0c0c0', highlights: '#ffffff', amount: 1 };

test('effect editor: no flag needed (D290); applied, saved, undone and redone; an empty list removes the effects', async () => {
  const c = await setup();
  try {
    const params = { scene: 'scene-main', layer: 'layer-cam', effects: [SHADOW, TONER] };
    // D290: the Look panel edits effects without a flag; the flag only shows the Advanced list.
    assert.equal((await c.status()).host.effectEditing, false);
    c.flags.set(FLAG, true);
    await until(async () => (await c.status()).host.effectEditing === true, 'status shows the advanced list on');
    c.flags.set(FLAG, false);
    await until(async () => (await c.status()).host.effectEditing === false, 'and off again');
    const on = await c.post('/ui/api/host', { method: 'layers.setEffects', params });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.saved, 'pending');
    assert.deepEqual(c.host.st.calls.find(([m]) => m === 'layers.setEffects')[1], params, 'the whole list, no canvas');
    await until(() => JSON.stringify(layerOf(c.file, 'layer-cam').effects) === JSON.stringify([SHADOW, TONER]), 'saved into the project');

    const undo = await c.post('/ui/api/edits/undo', {});
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.deepEqual(c.host.st.effects['layer-cam'], [], 'undo restores the empty list');
    await until(() => layerOf(c.file, 'layer-cam').effects === undefined, 'undo removes the effects from the project');
    const redo = await c.post('/ui/api/edits/redo', {});
    assert.equal(redo.status, 200);
    assert.deepEqual(c.host.st.effects['layer-cam'], [SHADOW, TONER]);
    await until(() => layerOf(c.file, 'layer-cam').effects?.length === 2, 'redo saved again');
  } finally { await c.srv.close(); }
});

test('effect editor: while live it acts on the click (D332); malformed lists are refused before the host', async () => {
  const c = await setup();
  try {
    c.flags.set(FLAG, true);
    for (const effects of ['blur', [1], [{ strength: 5 }], new Array(7).fill({ type: 'blur', strength: 1 }), [{ type: 'blur', note: 'x'.repeat(5000) }]]) {
      const r = await c.post('/ui/api/host', { method: 'layers.setEffects', params: { scene: 'scene-main', layer: 'layer-cam', effects } });
      assert.equal(r.status, 400, JSON.stringify(effects).slice(0, 40));
    }
    const withCanvas = await c.post('/ui/api/host', { method: 'layers.setEffects', params: { scene: 'scene-main', canvas: 'h', layer: 'layer-cam', effects: [] } });
    assert.equal(withCanvas.status, 400, 'effects belong to the layer: no canvas field');
    assert.ok(!c.host.st.calls.some(([m]) => m === 'layers.setEffects'));

    c.host.st.live = true;
    await until(async () => (await c.status()).host.live === true, 'live seen');
    const ok = await c.post('/ui/api/host', { method: 'layers.setEffects', params: { scene: 'scene-main', layer: 'layer-cam', effects: [SHADOW] } });
    assert.equal(ok.body.verdict, 'allow', 'acts on the click while live (D332), no "yes, on air"');
    assert.equal(ok.body.pending, undefined);
    assert.deepEqual(c.host.st.effects['layer-cam'], [SHADOW]);
    await until(() => layerOf(c.file, 'layer-cam').effects?.length === 1, 'saved after the live click');
  } finally { await c.srv.close(); }
});
