// SPDX-License-Identifier: GPL-3.0-or-later
// D327 OS3: the main-window Outputs panel switches one output while live. With the REAL libobs host and a loopback plan
// (one 640x360 rung feeding two RTMP sinks, "twitch" and "kick", each to its own local ffmpeg listener), the page's
// toggle route asks for "yes, on air", then stops only that sink: the other listener keeps receiving. Switching it back
// on starts only that sink again, into a new listener. ffprobe checks every received file. Never a real platform.
//   node --test app/host/tests/host-output-toggle.test.mjs
// Needs the built host (node app/host/tools/build.mjs), the OBS runtime and ffmpeg/ffprobe on PATH. Headless.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { REPO_ROOT, HOST_DIR, resolveConfig } from '../lib/config.mjs';
import { probe } from '../lib/ffprobe.mjs';
import { seedSetup, writeSetup } from '../../../services/studio-ui/stream-setup.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const BASE = 19700 + Math.floor(Math.random() * 40) * 2;
const PORTS = { twitch: BASE, kick: BASE + 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = 2000; // UJWALAM_TEST_START_PAUSE_MS: every confirmed start waits this long before the host call

const PLAN = {
  config: {
    name: 'D327 OS3 output toggle: loopback RTMP x2',
    canvases: [{ id: 'H', w: 1920, h: 1080, fps: 60 }, { id: 'V', w: 1080, h: 1920, fps: 60 }],
    encoders: [{ id: 'tk', canvas: 'H', w: 640, h: 360, fps: 30, codec: 'h264', bitrate: 1500, rc: 'cbr', gop_sec: 2, encoder: 'nvenc' }],
    audio: { tracks: [{ id: 'master', name: 'Master Track', codec: 'aac', bitrate: 128, sampleRate: 48000 }] },
    sinks: [
      { id: 'twitch', platform: 'twitch', encoder: 'tk', proto: 'rtmp', priority: 1 },
      { id: 'kick', platform: 'kick', encoder: 'tk', proto: 'rtmp', priority: 2 },
    ],
  },
  targets: {
    twitch: { transport: 'rtmp', port: PORTS.twitch, app: 'live', stream: 'twitch' },
    kick: { transport: 'rtmp', port: PORTS.kick, app: 'live', stream: 'kick' },
  },
};

let child; let dir; let dataDir; let port; let cookie; let csrf; let exitCode = null;
const lines = [];

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
async function until(fn, what, ms = 60_000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; if (exitCode !== null) break; await sleep(step); }
  assert.fail(`timed out waiting for ${what}\n${lines.join('\n')}`);
}
// An ffmpeg RTMP listener on one loopback port; it ends when the sender's connection ends.
function listener(sink, name) {
  const file = path.join(dir, `${name}.mkv`);
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${PORTS[sink]}/live/${sink}`, '-c', 'copy', '-f', 'matroska', '-y', file],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  ff.stderr.resume();
  let done = false;
  const exit = new Promise((r) => ff.on('exit', () => { done = true; r(); }));
  return { file, exit, ended: () => done, async stop() { try { ff.stdin.write('q'); } catch { /* gone */ } await Promise.race([exit, sleep(8000).then(() => ff.kill())]); } };
}
const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
const sinkState = async (id) => (await req('GET', '/ui/api/outputs/panel')).body?.outputs?.find((o) => o.id === id)?.state;

async function toggle(id, on) {
  const c = await req('POST', '/ui/api/outputs/toggle', { id, on });
  assert.equal(c.body.verdict, 'confirm', JSON.stringify(c.body));
  assert.equal(c.body.pending.phrase, 'yes, on air');
  const wrong = await req('POST', '/ui/api/confirm', { pendingId: c.body.pending.pendingId, text: 'yes' });
  assert.notEqual(wrong.body?.verdict, 'allow', 'a plain "yes" never switches a live output');
  const c2 = await req('POST', '/ui/api/outputs/toggle', { id, on });
  const r = await req('POST', '/ui/api/confirm', { pendingId: c2.body.pending.pendingId, text: 'yes, on air' });
  assert.equal(r.body.verdict, 'allow', JSON.stringify(r.body));
}

before(async () => {
  const cfg = resolveConfig();
  assert.ok(existsSync(cfg.exe), `host exe missing: ${cfg.exe} (node app/host/tools/build.mjs)`);
  mkdirSync(OUT, { recursive: true });
  dir = mkdtempSync(path.join(OUT, 'output-toggle-'));
  dataDir = path.join(dir, 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'outputs-panel': true } }));
  // The panel's outputs: the same ids as the plan's sinks (placeholder names).
  const seed = seedSetup();
  const w = writeSetup(dataDir, { ...seed, canvasMode: 'main', video: { ...seed.video, bitrateKbps: 6000 }, outputs: [
    { id: 'twitch', name: 'Twitch test', platform: 'twitch', canvas: 'H', enabled: true },
    { id: 'kick', name: 'Kick test', platform: 'kick', canvas: 'H', enabled: true },
  ] });
  assert.ok(w.ok, JSON.stringify(w.problems));
  const planFile = path.join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(PLAN));
  const loginOut = path.join(dir, 'login.json');
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'services', 'studio-ui', 'launch.mjs'), '--data-dir', dataDir, '--mock', '--stop-on-stdin', '--shell', 'browser',
    '--outputs', planFile, '--profile', path.join(dir, 'no-profile.json')], {
    env: {
      ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_BROWSER: process.execPath, UJWALAM_BROWSER_ARGS: `${path.join(HOST_DIR, 'tests', 'studio-login.mjs')} ${loginOut}`,
      UJWALAM_HOST_DATA: path.join(dir, 'host'), UJWALAM_HOST_TOKEN: '', UJWALAM_LIVE_SESSION: '',
      // The second test needs a confirmed start to wait before it goes to the host (End all lands meanwhile).
      UJWALAM_TEST_START_PAUSE_MS: String(PAUSE_MS),
    },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.once('exit', (c) => { exitCode = c; });
  readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
  readline.createInterface({ input: child.stderr }).on('line', (l) => lines.push(`ERR ${l}`));
  await until(() => existsSync(loginOut) && readFileSync(loginOut, 'utf8').length > 0, 'the scripted login', 90_000);
  const l = JSON.parse(readFileSync(loginOut, 'utf8'));
  assert.equal(l.status, 302);
  port = l.port; cookie = l.cookie;
  csrf = (await req('GET', '/ui/api/session')).body.csrf;
});

after(async () => {
  if (!child || exitCode !== null) return;
  child.stdin.end();
  const t0 = Date.now();
  while (exitCode === null && Date.now() - t0 < 20_000) await sleep(100);
  if (exitCode === null) child.kill();
});

test('while live, one output stops and starts again; the other stays up (loopback, ffprobe)', { timeout: 240_000 }, async () => {
  const st0 = await until(async () => { const s = (await req('GET', '/ui/api/status')).body; return s?.host?.outputsReady?.stream && s; }, 'stream output ready');
  assert.equal(st0.host.kind, 'host', 'the real host');
  const tw = listener('twitch', 'twitch');
  const k1 = listener('kick', 'kick-1');
  await sleep(1200);

  // Offline, the switch only saves the choice (no confirm, nothing starts).
  const off = await req('POST', '/ui/api/outputs/toggle', { id: 'kick', on: true });
  assert.deepEqual(off.body, { ok: true, id: 'kick', enabled: true, live: false });

  const c = await req('POST', '/ui/api/host', { method: 'stream.start', params: {} });
  assert.equal(c.body.verdict, 'confirm', JSON.stringify(c.body));
  const go = await req('POST', '/ui/api/confirm', { pendingId: c.body.pending.pendingId, text: 'yes, on air' });
  assert.equal(go.body.verdict, 'allow', JSON.stringify(go.body));
  await until(async () => size(tw.file) > 100_000 && size(k1.file) > 100_000, 'both listeners receiving', 30_000);

  // Stop kick only.
  await toggle('kick', false);
  await Promise.race([k1.exit, sleep(15_000)]);
  assert.ok(k1.ended(), 'the kick connection closed');
  await until(async () => (await sinkState('kick')) === 'stopped', 'kick stopped', 15_000);
  assert.equal(await sinkState('twitch'), 'live', 'twitch still live');
  const before = size(tw.file);
  await sleep(3000);
  assert.ok(size(tw.file) > before + 50_000, `twitch kept receiving (${before} -> ${size(tw.file)} bytes)`);
  assert.equal(tw.ended(), false, 'the twitch connection stayed open');

  // Start kick only, into a new listener.
  const k2 = listener('kick', 'kick-2');
  await sleep(800);
  await toggle('kick', true);
  await until(async () => size(k2.file) > 100_000, 'the second kick listener receiving', 30_000);
  assert.equal(tw.ended(), false, 'twitch untouched by the restart');

  // Each live switch also saves the choice for the next start.
  const setup = JSON.parse(readFileSync(path.join(dataDir, 'stream-setup.json'), 'utf8'));
  assert.equal(setup.outputs.find((o) => o.id === 'kick').enabled, true);

  const e = await req('POST', '/ui/api/streams/end-all', {});
  const r = await req('POST', '/ui/api/confirm', { pendingId: e.body.pending.pendingId, text: 'yes, on air' });
  assert.equal(r.body.endAll.allStopped, true, JSON.stringify(r.body));
  await Promise.all([tw.stop(), k2.stop()]);
  for (const f of [tw.file, k1.file, k2.file]) {
    const p = probe(f);
    const v = p.streams.filter((s) => s.type === 'video');
    assert.equal(v.length, 1, f);
    assert.equal(v[0].codec, 'h264');
    assert.deepEqual([v[0].width, v[0].height], [640, 360]);
    assert.ok(v[0].packets > 30, `${path.basename(f)} video packets ${v[0].packets}`);
    console.log(`# ${path.basename(f)}: ${v[0].packets} video packets, ${p.streams.filter((s) => s.type === 'audio').length} audio stream(s)`);
  }
});

// Codex review P1 (2026-11-10): a switch-on confirmed while live, then End all confirmed before that start reaches the
// host. End all wins: the switch-on is refused and the output never connects again.
test('End all during a pending switch-on: nothing restarts after End all (loopback)', { timeout: 240_000 }, async () => {
  const tw = listener('twitch', 'twitch-2');
  const k = listener('kick', 'kick-3');
  await sleep(1200);
  const c = await req('POST', '/ui/api/host', { method: 'stream.start', params: {} });
  const go = await req('POST', '/ui/api/confirm', { pendingId: c.body.pending.pendingId, text: 'yes, on air' });
  assert.equal(go.body.verdict, 'allow', JSON.stringify(go.body));
  await until(async () => size(tw.file) > 100_000 && size(k.file) > 100_000, 'both listeners receiving', 30_000);
  await toggle('kick', false);
  await Promise.race([k.exit, sleep(15_000)]);
  await until(async () => (await sinkState('kick')) === 'stopped', 'kick stopped', 15_000);

  const k4 = listener('kick', 'kick-4'); // would receive if the switch-on got through
  await sleep(800);
  const t = await req('POST', '/ui/api/outputs/toggle', { id: 'kick', on: true });
  const pendingOn = req('POST', '/ui/api/confirm', { pendingId: t.body.pending.pendingId, text: 'yes, on air' });
  await sleep(300); // the switch-on is inside its pause, on its way to the host
  const e = await req('POST', '/ui/api/streams/end-all', {});
  const ended = await req('POST', '/ui/api/confirm', { pendingId: e.body.pending.pendingId, text: 'yes, on air' });
  assert.equal(ended.body.endAll.allStopped, true, JSON.stringify(ended.body));
  const on = (await pendingOn).body;
  assert.equal(on.verdict, 'refuse', JSON.stringify(on));
  assert.equal(on.reason, 'stopped-meanwhile');
  await sleep(PAUSE_MS + 3000);
  assert.notEqual(await sinkState('kick'), 'live', 'kick stays stopped after End all');
  assert.notEqual(await sinkState('twitch'), 'live', 'twitch stays stopped after End all');
  assert.equal(size(k4.file), 0, 'the kick listener never received anything after End all');
  await Promise.all([tw.stop(), k4.stop()]);
  const v = probe(tw.file).streams.filter((s) => s.type === 'video');
  assert.equal(v[0]?.codec, 'h264');
  assert.ok(v[0].packets > 30, `twitch-2 video packets ${v[0].packets}`);
  console.log(`# twitch-2: ${v[0].packets} video packets; kick-4: ${size(k4.file)} bytes after End all`);
});
