// SPDX-License-Identifier: GPL-3.0-or-later
// Scene transitions, UI server side (D239): the host's per-canvas transition follows flag `transitions` (off by
// default = cut) and the project's canvases[].transition; a mismatch is set again on the next poll.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer, TRANSITIONS_FLAG } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); }
  assert.fail(`timed out: ${what}`);
}

test('flag off: cut on both canvases; on: the project fades; a host that drifts is set again; off: cut again', async () => {
  const tr = { H: { type: 'cut', durationMs: 0, available: true }, V: { type: 'fade', durationMs: 500, available: true } };
  const calls = [];
  const host = {
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      if (m === 'host.status') return { live: false, recording: false, transitions: structuredClone(tr) };
      if (m === 'transitions.set') { calls.push(p); tr[p.canvas] = { type: p.type, durationMs: p.durationMs, available: true }; return tr; }
      return {};
    },
  };
  const flags = createFlags({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'ujw-tr-')) });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: 'k'.repeat(48), flags, transitions: { h: { type: 'fade', durationMs: 2006 }, v: { type: 'fade', durationMs: 1000 } }, limits: { statusPollMs: 20 } });
  await srv.listen();
  try {
    await until(() => tr.V.type === 'cut', 'V set to cut while the flag is off');
    assert.deepEqual(calls, [{ canvas: 'V', type: 'cut', durationMs: 0 }], 'H already matched: not called');
    flags.set(TRANSITIONS_FLAG, true);
    await until(() => tr.H.durationMs === 2006 && tr.V.durationMs === 1000, 'project fades applied');
    tr.H = { type: 'cut', durationMs: 0, available: true }; // host restarted
    await until(() => tr.H.durationMs === 2006, 'set again after a host restart');
    flags.set(TRANSITIONS_FLAG, false);
    await until(() => tr.H.type === 'cut' && tr.V.type === 'cut', 'cut again when off');
  } finally { await srv.close(); }
});

test('stinger (D242): the transition form saves the project; the poll applies it; a refused stinger cuts and is not retried', async () => {
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const http = (await import('node:http')).default;
  const { createProject, saveProject } = await import('../services/project/index.mjs');
  const { createProjectSync } = await import('../services/studio-ui/project-sync.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-st-'));
  const assets = path.join(dir, 'assets');
  mkdirSync(assets);
  writeFileSync(path.join(assets, 'wipe.webm'), '');
  const file = path.join(dir, 'p.project.json');
  saveProject(file, createProject({ name: 'T', fps: 30 }));
  const tr = { H: { type: 'cut', durationMs: 0, available: true }, V: { type: 'cut', durationMs: 0, available: true } };
  const sets = [];
  const state = { refuse: false, live: false };
  const host = {
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      if (m === 'host.status') return { live: state.live, recording: false, transitions: structuredClone(tr) };
      if (m === 'transitions.set') {
        sets.push(p);
        if (p.type === 'stinger' && state.refuse) throw Object.assign(new Error('stinger: file not found'), { code: 'RPC_-32004' });
        tr[p.canvas] = { type: p.type, durationMs: p.durationMs ?? 0, available: true, ...(p.type === 'stinger' ? { file: `${p.file.base}:${p.file.rel}`, pointMs: p.pointMs, audio: p.audio } : {}) };
        return tr;
      }
      return {};
    },
  };
  const flags = createFlags({ dataDir: dir });
  flags.set(TRANSITIONS_FLAG, true);
  const KEY = 'k'.repeat(48);
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), assetsDir: assets, limits: { statusPollMs: 20 } });
  const { port } = await srv.listen();
  const req = (method, url, headers, body) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject);
    r.end(body);
  });
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await req('GET', '/ui/api/session', { cookie })).body.csrf;
    const post = (body) => req('POST', '/ui/api/project/transition', { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf }, JSON.stringify(body));
    const ch = (await req('GET', '/ui/api/project/transitions', { cookie })).body;
    assert.deepEqual(ch.videos, ['wipe.webm']);
    assert.equal((await post({ canvas: 'h', type: 'stinger', file: 'other.webm', pointMs: 500 })).body.error, 'unknown-asset');
    assert.equal((await post({ canvas: 'h', type: 'fade' })).status, 400);
    let r = await post({ canvas: 'h', type: 'stinger', file: 'wipe.webm', pointMs: 500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).canvases[0].transition, { type: 'stinger', durationMs: 0, file: { base: 'media', rel: 'wipe.webm' }, pointMs: 500 });
    await until(() => tr.H.type === 'stinger' && tr.H.pointMs === 500, 'stinger applied to the host');
    assert.equal(tr.H.audio, true, 'stinger sound on by default');
    assert.equal((await post({ canvas: 'h', type: 'cut', audio: false })).status, 400, 'audio is for a stinger only');
    r = await post({ canvas: 'h', type: 'stinger', file: 'wipe.webm', pointMs: 500, audio: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).canvases[0].transition.audio, false);
    await until(() => tr.H.audio === false, 'stinger sound off applied to the host (D244)');
    state.refuse = true;
    r = await post({ canvas: 'v', type: 'stinger', file: 'wipe.webm', pointMs: 300 });
    assert.equal(r.status, 200);
    await until(() => sets.some((p) => p.canvas === 'V' && p.type === 'stinger'), 'stinger asked for on V');
    await sleep(150);
    assert.equal(sets.filter((p) => p.canvas === 'V' && p.type === 'stinger').length, 1, 'a refused stinger is not asked for again');
    assert.equal(tr.V.type, 'cut');
    state.live = true;
    assert.equal((await post({ canvas: 'h', type: 'cut' })).body.error, 'live-locked');
  } finally { await srv.close(); }
});
