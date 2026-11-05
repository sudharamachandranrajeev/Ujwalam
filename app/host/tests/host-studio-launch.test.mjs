// SPDX-License-Identifier: GPL-3.0-or-later
// F2: the full studio launch (services/studio-ui/launch.mjs: event core --mock + the REAL libobs host + UI server),
// driven through the control page's own API (session cookie, CSRF, Origin) the way ui/js/api.js does it.
//   node --test --test-concurrency=1 app/host/tests/host-studio-launch.test.mjs   (part of npm run test:host)
// Needs the built host (node app/host/tools/build.mjs) and the OBS runtime (app/host/host.local.json or env).
// Headless (UJWALAM_HEADLESS=1): no window. No devices (no --allow-devices), no --alpha, no --live. The only output is
// a local .mkv recording from a record-only plan in the test data dir; no stream sink exists, nothing reaches a network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { REPO_ROOT, HOST_DIR, resolveConfig } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Record-only plan: one H rung that feeds only the local recording (ownRung), no stream sink at all.
const PLAN = {
  config: {
    name: 'F2 studio launch: H recording only',
    canvases: [{ id: 'H', w: 1920, h: 1080, fps: 60 }, { id: 'V', w: 1080, h: 1920, fps: 60 }],
    encoders: [{ id: 'rec', canvas: 'H', w: 1280, h: 720, codec: 'h264', bitrate: 4000, rc: 'cbr', gop_sec: 2, encoder: 'nvenc' }],
    audio: { tracks: [{ id: 'master', name: 'Master Track', codec: 'aac', bitrate: 160, sampleRate: 48000 }] },
    sinks: [{ id: 'rec-h', platform: 'local', encoder: 'rec', proto: 'file', priority: 1 }],
  },
  targets: { 'rec-h': { transport: 'file', name: 'f2-rec-h.mkv', ownRung: true } },
  policy: { retryBaseMs: 1000, retryCapMs: 8000, retryMax: 0, retryResetLiveMs: 10000 },
};

let child;
let lines = [];
let port;
let cookie;
let csrf;
let dir;
let hostData;
let exitCode = null;

function req(method, route, body) {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = { Host: `127.0.0.1:${port}`, Cookie: cookie };
  if (method === 'POST') Object.assign(headers, { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Ujwalam-Csrf': csrf, 'Content-Length': Buffer.byteLength(data ?? '') });
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: route, method, headers, timeout: 15_000 }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data !== null) r.write(data);
    r.end();
  });
}
// The page's Api.host(method, params): 200 { result } or a typed confirmation.
async function host(method, params = {}) {
  const r = await req('POST', '/ui/api/host', { method, params });
  assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function confirmed(method, params = {}) {
  const c = await host(method, params);
  assert.equal(c.verdict, 'confirm', `${method} needs a typed phrase`);
  assert.equal(c.pending.phrase, 'yes', `${method} phrase while not live`);
  const r = await req('POST', '/ui/api/confirm', { pendingId: c.pending.pendingId, text: 'yes' });
  assert.equal(r.status, 200, `${method} confirm: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function status() {
  const r = await req('GET', '/ui/api/status');
  assert.equal(r.status, 200);
  return r.body;
}

before(async () => {
  const cfg = resolveConfig();
  assert.ok(existsSync(cfg.exe), `host exe missing: ${cfg.exe} (node app/host/tools/build.mjs)`);
  mkdirSync(OUT, { recursive: true });
  dir = mkdtempSync(path.join(OUT, 'studio-'));
  hostData = path.join(dir, 'host');
  const planFile = path.join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(PLAN));
  const loginOut = path.join(dir, 'login.json');
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'services', 'studio-ui', 'launch.mjs'), '--data-dir', path.join(dir, 'core'), '--mock', '--stop-on-stdin', '--outputs', planFile, '--profile', path.join(dir, 'no-profile.json')], {
    env: {
      ...process.env,
      UJWALAM_HEADLESS: '1',
      UJWALAM_BROWSER: process.execPath,
      UJWALAM_BROWSER_ARGS: `${path.join(HOST_DIR, 'tests', 'studio-login.mjs')} ${loginOut}`,
      UJWALAM_HOST_DATA: hostData,
      UJWALAM_HOST_TOKEN: '', UJWALAM_HOST_EXE: '', UJWALAM_HOST_BUILD: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.once('exit', (c) => { exitCode = c; });
  readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
  readline.createInterface({ input: child.stderr }).on('line', (l) => lines.push(`ERR ${l}`));
  const t0 = Date.now();
  while (!existsSync(loginOut) && Date.now() - t0 < 90_000 && exitCode === null) await sleep(200);
  assert.ok(existsSync(loginOut), `no login (launcher output: ${lines.join(' | ')})`);
  await sleep(100);
  const l = JSON.parse(readFileSync(loginOut, 'utf8'));
  assert.equal(l.status, 302, 'one-time login redirects');
  assert.ok(l.cookie, 'session cookie set');
  port = l.port; cookie = l.cookie;
  const s = await req('GET', '/ui/api/session');
  assert.equal(s.status, 200);
  csrf = s.body.csrf;
  assert.equal(s.body.host.kind, 'host', `UI uses the real host (got ${JSON.stringify(s.body.host)})`);
});

after(async () => {
  if (!child || exitCode !== null) return;
  child.stdin.end();
  const t0 = Date.now();
  while (exitCode === null && Date.now() - t0 < 20_000) await sleep(100);
  if (exitCode === null) child.kill();
  assert.equal(exitCode, 0, 'launcher stops cleanly');
  assert.equal(existsSync(path.join(dir, 'core', 'host.json')), false, 'host discovery file removed (host.shutdown)');
});

test('launcher reports the real libobs host started, devices off, no BLOCKED-ON-HOST', () => {
  const out = lines.join('\n');
  assert.match(out, /libobs host started \(devices off\)/);
  assert.doesNotMatch(out, /BLOCKED-ON-HOST|NOT ready/);
});

test('status bar values: fps, dropped/total frames, CPU and GPU, outputs ready for record only', async () => {
  let s;
  for (let i = 0; i < 30; i++) { s = await status(); if (s.host.available && s.host.totalFrames !== undefined) break; await sleep(500); }
  const h = s.host;
  assert.equal(h.kind, 'host');
  assert.equal(h.available, true);
  assert.equal(h.blockedOnHost, false);
  assert.equal(h.live, false);
  assert.equal(h.recording, false);
  assert.ok(Number.isInteger(h.droppedFrames) && h.droppedFrames >= 0, `droppedFrames ${h.droppedFrames}`);
  assert.ok(Number.isInteger(h.totalFrames) && h.totalFrames >= 0, `totalFrames ${h.totalFrames}`);
  assert.ok(typeof h.fps === 'number' && h.fps > 0, `fps ${h.fps}`);
  assert.ok(h.cpuPct === null || (typeof h.cpuPct === 'number' && h.cpuPct >= 0), `cpuPct ${h.cpuPct}`);
  assert.ok(h.gpuPct === null || (typeof h.gpuPct === 'number' && h.gpuPct >= 0), `gpuPct ${h.gpuPct}`);
  assert.deepEqual(h.outputsReady, { stream: false, record: true });
  console.log(`# status ${JSON.stringify(h)}`);
});

test('scenes list + activate (H)', async () => {
  const { result } = await host('scenes.list');
  const ids = result.scenes.map((x) => `${x.id}@${x.canvas}`).sort();
  assert.deepEqual(ids, ['card-h@H', 'card-v@V', 'plain-h@H']);
  console.log(`# scenes.list ${JSON.stringify(result)}`);
  const a = await host('scenes.activate', { scene: 'plain-h', canvas: 'h' });
  console.log(`# scenes.activate plain-h ${JSON.stringify(a.result)}`);
  const after1 = (await host('scenes.list')).result.scenes;
  assert.equal(after1.find((x) => x.id === 'plain-h').active, true);
  assert.equal(after1.find((x) => x.id === 'card-h').active, false);
  await host('scenes.activate', { scene: 'card-h', canvas: 'h' });
  assert.equal((await host('scenes.list')).result.scenes.find((x) => x.id === 'card-h').active, true);
  const bad = await req('POST', '/ui/api/host', { method: 'scenes.activate', params: { scene: 'nope', canvas: 'h' } });
  assert.equal(bad.status, 502, 'unknown scene is a host error');
});

test('layers setVisible + move (card-h)', async () => {
  const list = async () => (await host('layers.list', { scene: 'card-h', canvas: 'h' })).result.layers;
  const l0 = await list();
  console.log(`# layers.list ${JSON.stringify(l0)}`);
  assert.deepEqual(l0.map((x) => x.id), ['bg', 'bars', 'motion']);
  await host('layers.setVisible', { scene: 'card-h', canvas: 'h', layer: 'motion', visible: false });
  assert.equal((await list()).find((x) => x.id === 'motion').visible, false);
  await host('layers.setVisible', { scene: 'card-h', canvas: 'h', layer: 'motion', visible: true });
  assert.equal((await list()).find((x) => x.id === 'motion').visible, true);
  await host('layers.move', { scene: 'card-h', canvas: 'h', layer: 'motion', index: 1 });
  assert.deepEqual((await list()).map((x) => x.id), ['bg', 'motion', 'bars']);
  await host('layers.move', { scene: 'card-h', canvas: 'h', layer: 'motion', index: 2 });
  assert.deepEqual((await list()).map((x) => x.id), ['bg', 'bars', 'motion']);
});

test('mixer volume + mute + live meter (peakDb)', async () => {
  const find = async () => (await host('mixer.list')).result.sources.find((x) => x.id === 'card-h/bars');
  let m = await find();
  console.log(`# mixer card-h/bars ${JSON.stringify(m)}`);
  assert.ok(m, 'tone layer in the mixer');
  let peak = m.peakDb;
  for (let i = 0; i < 20 && !(typeof peak === 'number' && peak > -60); i++) { await sleep(250); peak = (await find()).peakDb; }
  assert.ok(typeof peak === 'number' && peak > -60, `440 Hz tone meters (peakDb ${peak})`);
  await host('mixer.setVolume', { id: 'card-h/bars', db: -12 });
  m = await find();
  assert.ok(Math.abs(m.volumeDb - -12) < 0.1, `volumeDb ${m.volumeDb}`);
  await host('mixer.setMute', { id: 'card-h/bars', muted: true });
  assert.equal((await find()).muted, true);
  await host('mixer.setMute', { id: 'card-h/bars', muted: false });
  assert.equal((await find()).muted, false);
  await host('mixer.setVolume', { id: 'card-h/bars', db: 0 });
});

test('local recording start/stop through the typed confirmation (no stream)', async () => {
  const st = await confirmed('record.start');
  console.log(`# record.start ${JSON.stringify(st)}`);
  let s;
  for (let i = 0; i < 20; i++) { s = await status(); if (s.host.recording) break; await sleep(250); }
  assert.equal(s.host.recording, true, 'recording on');
  assert.equal(s.host.live, false, 'not live');
  await sleep(3000);
  s = await status();
  // The status bar's dropped / total frames count stream sinks only (Outputs::totals); with no stream they stay 0.
  assert.equal(s.host.totalFrames, 0, 'no stream sink: status-bar frame counters stay 0');
  assert.equal(s.host.droppedFrames, 0);
  console.log(`# status while recording ${JSON.stringify(s.host)}`);
  const sp = await confirmed('record.stop');
  console.log(`# record.stop ${JSON.stringify(sp)}`);
  for (let i = 0; i < 40; i++) { s = await status(); if (!s.host.recording) break; await sleep(250); }
  assert.equal(s.host.recording, false, 'recording off');
  const recDir = path.join(hostData, 'recordings');
  const files = existsSync(recDir) ? readdirSync(recDir).filter((n) => n.endsWith('.mkv')) : [];
  assert.ok(files.length >= 1, `an .mkv in ${recDir}`);
  const size = statSync(path.join(recDir, files[0])).size;
  assert.ok(size > 10_000, `recording size ${size}`);
  console.log(`# recording ${files[0]} ${size} bytes`);
});
