// SPDX-License-Identifier: GPL-3.0-or-later
// Device hot-plug, UI server side (D329): the host's device watcher bumps host.status devices.seq; the server turns a
// moved seq into SSE 'devices' and 'layers' {source: 'devices'} (pages and the Qt shell reload the layer list and the
// add-layer device picker), puts {seq, waiting} in the status snapshot, marks each picker device connected or not, and
// passes the host's "waiting for capture card" sentence back when a capture layer is added without its device.
// Stub host (kind 'host'); real flags and project-sync on temp files.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer, SCENE_EDIT_FLAG } from '../services/studio-ui/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const SAMPLE = path.join(HERE, 'fixtures', 'project', 'sample.project.json');
const KEY = 'k'.repeat(48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MSG = 'Waiting for capture card "<capture-card>": it is not connected. Plug it in; the layer connects by itself.';

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
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

// A host with a device watcher: seq, connected flags per project device, waiting layers; addFromProject answers like
// the real host for a capture layer whose card is not connected.
function stubHost() {
  const st = { seq: 0, connected: { 'dev-capture': false, 'dev-cam': true }, waiting: [], listed: true };
  return {
    st,
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      if (m === 'host.status') return { live: false, recording: false, devices: { seq: st.seq, listed: st.listed, busy: false, waiting: st.waiting, connected: st.connected, watcher: { watching: true } } };
      if (m === 'layers.addFromProject') {
        const l = p.project.scenes.flatMap((s) => s.layers).find((x) => x.id === p.layer);
        if (l?.type === 'capture' && st.connected[l.source.device] === false) {
          st.waiting.push({ layer: l.id, device: l.source.device, message: WAIT_MSG });
          return { layer: l.id, canvases: ['H'], waiting: { layer: l.id, device: l.source.device, message: WAIT_MSG } };
        }
        return { layer: p.layer, canvases: ['H'] };
      }
      return {};
    },
  };
}

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-hotplug-'));
  const file = path.join(dir, 'alpha.project.json');
  copyFileSync(SAMPLE, file);
  const host = stubHost();
  const flags = createFlags({ dataDir: dir });
  flags.set(SCENE_EDIT_FLAG, true);
  const projectSync = createProjectSync({ file, delayMs: 5 });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync, limits: { statusPollMs: 20 } });
  const { port } = await srv.listen();
  const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
  return { srv, port, host, cookie };
}

// Collects SSE frames from /ui/api/events.
function listen(port, cookie) {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/ui/api/events', headers: { cookie } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev) events.push([ev, data ? JSON.parse(data) : null]);
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

test('a device plug or unplug (devices.seq moved) reaches the pages as SSE devices + layers; the snapshot carries seq and the waiting count', async () => {
  const c = await setup();
  const sse = listen(c.port, c.cookie);
  try {
    await sleep(100);
    assert.ok(!sse.events.some(([e]) => e === 'devices'), 'the first poll only notes the seq');
    c.host.st.seq = 1;
    c.host.st.waiting = [{ layer: 'layer-game', device: 'dev-capture', message: WAIT_MSG }];
    await until(() => sse.events.some(([e, d]) => e === 'layers' && d?.source === 'devices'), 'layers event after a device change');
    const dev = sse.events.find(([e]) => e === 'devices')[1];
    assert.deepEqual(dev, { seq: 1, waiting: 1 });
    const s = await raw(c.port, { url: '/ui/api/status', headers: { cookie: c.cookie } });
    assert.deepEqual(s.body.host.devices, { seq: 1, waiting: 1 }, 'numbers only: no device names in the status snapshot');
    await sleep(100);
    assert.equal(sse.events.filter(([e]) => e === 'devices').length, 1, 'no repeat while the seq stands still');
    c.host.st.seq = 0; // host restart
    await until(() => sse.events.filter(([e]) => e === 'devices').length === 2, 'a restarted host (lower seq) is a change');
  } finally { sse.close(); await c.srv.close(); }
});

test('the add-layer picker marks each device connected or not; nothing when the host has not listed devices', async () => {
  const c = await setup();
  try {
    let ch = (await raw(c.port, { url: '/ui/api/project/structure', headers: { cookie: c.cookie } })).body;
    assert.deepEqual(ch.devices.map((d) => [d.id, d.connected]), [['dev-capture', false], ['dev-cam', true]]);
    c.host.st.connected['dev-capture'] = true; // plugged in: the next read shows it
    ch = (await raw(c.port, { url: '/ui/api/project/structure', headers: { cookie: c.cookie } })).body;
    assert.equal(ch.devices.find((d) => d.id === 'dev-capture').connected, true);
    c.host.st.listed = false; // devices not allowed: no state shown
    ch = (await raw(c.port, { url: '/ui/api/project/structure', headers: { cookie: c.cookie } })).body;
    assert.ok(ch.devices.every((d) => !('connected' in d)));
  } finally { await c.srv.close(); }
});

test('adding a capture layer while its card is unplugged succeeds and returns the plain waiting sentence', async () => {
  const c = await setup();
  try {
    const csrf = (await raw(c.port, { url: '/ui/api/session', headers: { cookie: c.cookie } })).body.csrf;
    const r = await raw(c.port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify({ op: 'layer.add', scene: 'scene-main', kind: 'capture', device: 'dev-capture' }),
      headers: { cookie: c.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.layer.type, 'capture');
    assert.equal(r.body.waiting, WAIT_MSG);
    assert.equal(r.body.saved, true);
    const r2 = await raw(c.port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify({ op: 'layer.add', scene: 'scene-main', kind: 'capture', device: 'dev-cam' }),
      headers: { cookie: c.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    assert.equal(r2.status, 200);
    assert.ok(!('waiting' in r2.body), 'a connected device: no waiting sentence');
  } finally { await c.srv.close(); }
});
