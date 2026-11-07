// SPDX-License-Identifier: GPL-3.0-or-later
// Preview mouse editing, UI server side (P5, D230): the host's editing switch follows flag preview-edit (off by
// default, switchable live, a restarted host is switched on again), and edits the host committed on mouse release
// (preview.edits, announced by host.status previewEditSeq) are saved into the project file by project-sync exactly
// like inspector layers.setPlacement calls. Stub host (kind 'host'); real flags and project-sync on temp files.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer, PREVIEW_EDIT_FLAG } from '../services/studio-ui/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const SAMPLE = path.join(HERE, 'fixtures', 'project', 'sample.project.json');
const KEY = 'k'.repeat(48);
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

// A host that edits like the real one: editing switch, an edit log with a seq, host.status fields.
function stubHost() {
  const st = { editing: false, seq: 0, edits: [], calls: [], live: false };
  return {
    st,
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      st.calls.push([m, p]);
      if (m === 'host.status') return { live: st.live, recording: false, previewEditing: st.editing, previewEditSeq: st.seq };
      if (m === 'preview.setEditing') { st.editing = p.enabled; return { enabled: p.enabled }; }
      if (m === 'preview.edits') return { seq: st.seq, truncated: false, edits: st.edits.filter((e) => e.seq > p.since) };
      return {};
    },
    drag(layer, placement) { st.seq++; st.edits.push({ seq: st.seq, canvas: 'H', scene: 'scene-main', layer, placement }); },
  };
}

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-pedit-'));
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
  return { srv, port, host, flags, file, dir, cookie };
}

const placementOf = (file, layer, canvas = 'h') => JSON.parse(readFileSync(file, 'utf8')).scenes.find((s) => s.id === 'scene-main').layers.find((l) => l.id === layer).placements[canvas];

test('flag off by default: the host stays off; on: switched on; a restarted host is switched on again; off again', async () => {
  const c = await setup();
  try {
    await sleep(100);
    assert.equal(c.host.st.editing, false);
    assert.ok(!c.host.st.calls.some(([m]) => m === 'preview.setEditing'), 'no call while the flag and the host agree (both off)');
    c.flags.set(PREVIEW_EDIT_FLAG, true); // the control page path is applyFlag after the typed "yes"; the poll catches a file change too
    await until(() => c.host.st.editing === true, 'host switched on');
    c.host.st.editing = false; // host restarted: starts off
    await until(() => c.host.st.editing === true, 'restarted host switched on again');
    c.flags.set(PREVIEW_EDIT_FLAG, false);
    await until(() => c.host.st.editing === false, 'host switched off');
  } finally { await c.srv.close(); }
});

test('host-committed edits are saved into the project file (once each); edits from before the server started are not replayed', async () => {
  const c0 = await setup();
  await c0.srv.close();
  const host = stubHost();
  host.drag('layer-cam', { x: 1, y: 2, width: 3, height: 4 }); // before this server's first poll
  const c = await (async () => {
    const dir = c0.dir;
    const flags = createFlags({ dataDir: dir });
    const projectSync = createProjectSync({ file: c0.file, delayMs: 5 });
    const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync, limits: { statusPollMs: 20 } });
    await srv.listen();
    return { srv, file: c0.file };
  })();
  try {
    const before = placementOf(c.file, 'layer-cam');
    await sleep(100);
    assert.deepEqual(placementOf(c.file, 'layer-cam'), before, 'the old edit is not replayed');
    assert.ok(!host.st.calls.some(([m]) => m === 'preview.edits'));
    host.drag('layer-cam', { x: 100, y: 50, width: 640, height: 360 });
    host.drag('layer-cam', { x: 120, y: 60, width: 640, height: 360 });
    await until(() => placementOf(c.file, 'layer-cam').x === 120, 'saved');
    const p = placementOf(c.file, 'layer-cam');
    assert.deepEqual({ x: p.x, y: p.y, width: p.width, height: p.height }, { x: 120, y: 60, width: 640, height: 360 });
    assert.equal(p.visible, before.visible, 'other fields kept');
    assert.deepEqual(placementOf(c.file, 'layer-cam', 'v'), JSON.parse(readFileSync(SAMPLE, 'utf8')).scenes[0].layers.find((l) => l.id === 'layer-cam').placements.v, 'V untouched');
    const reads = host.st.calls.filter(([m]) => m === 'preview.edits');
    assert.equal(reads.length >= 1, true);
    await sleep(100);
    assert.equal(host.st.calls.filter(([m]) => m === 'preview.edits').length, reads.length, 'no re-read while the seq stands still');
    // host restart: the seq goes back; the new edits are read from 0
    host.st.seq = 0; host.st.edits = [];
    host.drag('layer-cam', { x: 7, y: 8, width: 640, height: 360 });
    await until(() => placementOf(c.file, 'layer-cam').x === 7, 'saved after a host restart');
  } finally { await c.srv.close(); }
});

test('the status snapshot names the newest host edit (Qt shell / page refresh their layer list from it)', async () => {
  const c = await setup();
  try {
    await sleep(60);
    c.host.drag('layer-logo', { x: 5, y: 6, width: 70, height: 80 });
    await until(async () => {
      const r = await raw(c.port, { url: '/ui/api/status', headers: { cookie: c.cookie } });
      const j = JSON.parse(r.text);
      return j.host?.previewEdit?.layer === 'layer-logo' && j.host.previewEdit.canvas === 'h' && j.host.previewEdit.scene === 'scene-main';
    }, 'previewEdit in the status snapshot');
  } finally { await c.srv.close(); }
});

test('live-lock (D233): mouse editing is switched off while live and back on after; a layout change while live needs "yes, on air" and then autosaves', async () => {
  const c = await setup();
  try {
    c.flags.set(PREVIEW_EDIT_FLAG, true);
    await until(() => c.host.st.editing === true, 'host switched on');
    c.host.st.live = true;
    await until(() => c.host.st.editing === false, 'switched off while live');
    const s = await raw(c.port, { url: '/ui/api/session', headers: { cookie: c.cookie } });
    const csrf = JSON.parse(s.text).csrf;
    const post = (route, body) => raw(c.port, { method: 'POST', url: route, body: JSON.stringify(body),
      headers: { cookie: c.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const params = { scene: 'scene-main', canvas: 'h', layer: 'layer-cam', placement: { x: 11, y: 12, width: 640, height: 360 } };
    const r = JSON.parse((await post('/ui/api/host', { method: 'layers.setPlacement', params })).text);
    assert.equal(r.verdict, 'confirm', 'not applied at once while live');
    assert.equal(r.pending.phrase, 'yes, on air');
    assert.ok(!c.host.st.calls.some(([m]) => m === 'layers.setPlacement'), 'host not called before the phrase');
    assert.equal(JSON.parse((await post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes' })).text).verdict, 'wrong-phrase');
    const ok = JSON.parse((await post('/ui/api/confirm', { pendingId: r.pending.pendingId, text: 'yes, on air' })).text);
    assert.equal(ok.verdict, 'allow');
    assert.equal(ok.saved, 'pending');
    await until(() => placementOf(c.file, 'layer-cam').x === 11, 'saved after the on-air confirm');
    const vis = JSON.parse((await post('/ui/api/host', { method: 'layers.setVisible', params: { scene: 'scene-main', layer: 'layer-cam', visible: false } })).text);
    assert.notEqual(vis.verdict, 'confirm', 'visibility stays instant while live');
    c.host.st.live = false;
    await until(() => c.host.st.editing === true, 'back on after the stream');
    const idle = JSON.parse((await post('/ui/api/host', { method: 'layers.setPlacement', params })).text);
    assert.notEqual(idle.verdict, 'confirm', 'instant again when nothing is live');
  } finally { await c.srv.close(); }
});
