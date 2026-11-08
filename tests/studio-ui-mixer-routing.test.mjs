// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer track routing, UI server side (D273): mixer.setTracks is refused while flag mixer-routing is off (the default),
// passes the track list to the host when on, saves the host's answer into audio.sources[].tracks of the project file
// (keyed by the project audio source the host resolved), needs "yes, on air" while live, and refuses a bad list
// before the host. Stub host (kind 'host'); real flags and project-sync on temp files.
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
const FLAG = 'mixer-routing';
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

// The real host keys a mixer row by scene/layer or audio:<device source>; it answers with the project audio source.
function stubHost() {
  const st = { live: false, calls: [], tracks: { 'aud-game': ['track1'] } };
  return {
    st,
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      st.calls.push([m, structuredClone(p)]);
      if (m === 'host.status') return { live: st.live, recording: false };
      if (m === 'mixer.setTracks') {
        if (p.id !== 'scene-main/layer-game') throw Object.assign(new Error('no such layer'), { code: -32602 });
        st.tracks['aud-game'] = [...p.tracks];
        // aud-game has CUE on (sample: monitor-only): the host flips it with the routing.
        return { id: p.id, audioSource: 'aud-game', mixers: p.tracks.length, tracks: p.tracks, monitoring: p.tracks.length ? 'monitor-and-output' : 'monitor-only' };
      }
      return {};
    },
  };
}

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-route-'));
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

const sourceOf = (file, id) => JSON.parse(readFileSync(file, 'utf8')).audio.sources.find((a) => a.id === id);
const tracksOf = (file, id) => sourceOf(file, id).tracks;
const routed = (c) => c.host.st.calls.filter(([m]) => m === 'mixer.setTracks');

test('mixer routing: off by default; on: sent to the host and saved under the project audio source', async () => {
  const c = await setup();
  try {
    const params = { id: 'scene-main/layer-game', tracks: ['track1', 'track2'] };
    const off = await c.post('/ui/api/host', { method: 'mixer.setTracks', params });
    assert.equal(off.status, 404);
    assert.equal(off.body.error, 'mixer-routing-off');
    assert.equal(routed(c).length, 0, 'host not called while the flag is off');

    c.flags.set(FLAG, true);
    const on = await c.post('/ui/api/host', { method: 'mixer.setTracks', params });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.saved, 'pending');
    assert.deepEqual(routed(c)[0][1], params);
    await until(() => JSON.stringify(tracksOf(c.file, 'aud-game')) === '["track1","track2"]', 'saved into audio.sources');
    assert.equal(sourceOf(c.file, 'aud-game').monitoring, 'monitor-and-output', 'the host\'s monitoring answer is saved too');
    assert.deepEqual(tracksOf(c.file, 'aud-mic'), ['track1', 'track2'], 'other sources untouched');

    const none = await c.post('/ui/api/host', { method: 'mixer.setTracks', params: { id: params.id, tracks: [] } });
    assert.equal(none.status, 200);
    await until(() => tracksOf(c.file, 'aud-game')?.length === 0, 'an empty list saved: on no track');

    const gone = await c.post('/ui/api/host', { method: 'mixer.setTracks', params: { id: 'scene-main/nope', tracks: ['track1'] } });
    assert.equal(gone.status, 502, 'a host refusal is reported');
    await sleep(30);
    assert.deepEqual(tracksOf(c.file, 'aud-game'), [], 'a refused change is not saved');
  } finally { await c.srv.close(); }
});

test('mixer routing: bad lists refused before the host; while live "yes, on air" first', async () => {
  const c = await setup();
  try {
    c.flags.set(FLAG, true);
    for (const tracks of ['track1', ['track1', 'track1'], [1], ['bad id!'], new Array(7).fill(0).map((_, i) => `t${i}`)]) {
      const r = await c.post('/ui/api/host', { method: 'mixer.setTracks', params: { id: 'scene-main/layer-game', tracks } });
      assert.equal(r.status, 400, JSON.stringify(tracks));
    }
    const noId = await c.post('/ui/api/host', { method: 'mixer.setTracks', params: { tracks: [] } });
    assert.equal(noId.status, 400);
    assert.equal(routed(c).length, 0);

    c.host.st.live = true;
    await until(async () => (await c.status()).host.live === true, 'live seen');
    const r = await c.post('/ui/api/host', { method: 'mixer.setTracks', params: { id: 'scene-main/layer-game', tracks: ['track2'] } });
    assert.equal(r.body.verdict, 'confirm');
    assert.equal(r.body.pending.phrase, 'yes, on air');
    assert.equal(routed(c).length, 0, 'host not called before the phrase');
    const ok = await c.post('/ui/api/confirm', { pendingId: r.body.pending.pendingId, text: 'yes, on air' });
    assert.equal(ok.body.verdict, 'allow');
    assert.deepEqual(c.host.st.tracks['aud-game'], ['track2']);
    await until(() => JSON.stringify(tracksOf(c.file, 'aud-game')) === '["track2"]', 'saved after the on-air confirm');
  } finally { await c.srv.close(); }
});
