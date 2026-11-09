// SPDX-License-Identifier: GPL-3.0-or-later
// Stream recovery after a host crash (D303 proposed, flag stream-recovery) with the REAL libobs host and loopback
// listeners only (no platform, nothing beyond 127.0.0.1): the full studio launch (services/studio-ui/launch.mjs,
// event core --mock, no --alpha, no --live, no devices) with a loopback plan (one 640x360 rung feeding an RTMP sink to
// an ffmpeg listener on 127.0.0.1 and an .mkv recording). The stream is started through the control page's own API
// ("yes, on air"), the host process is killed (TerminateProcess, exit code 1 = a crash), and the launcher restarts
// the host and the stream: a second listener receives it (ffprobe), the recording continues in a new file, the
// control page status names the restarted stream.
//   node --test --test-concurrency=1 app/host/tests/host-stream-recovery.test.mjs   (part of npm run test:host)
// Needs the built host (node app/host/tools/build.mjs), the OBS runtime and ffmpeg/ffprobe on PATH. Headless.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { REPO_ROOT, HOST_DIR, resolveConfig } from '../lib/config.mjs';
import { probe } from '../lib/ffprobe.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const PORT = 19800 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN = {
  config: {
    name: 'D303 stream recovery: loopback RTMP + H recording',
    canvases: [{ id: 'H', w: 1920, h: 1080, fps: 60 }, { id: 'V', w: 1080, h: 1920, fps: 60 }],
    encoders: [{ id: 'tk', canvas: 'H', w: 640, h: 360, fps: 30, codec: 'h264', bitrate: 1500, rc: 'cbr', gop_sec: 2, encoder: 'nvenc' }],
    audio: { tracks: [{ id: 'master', name: 'Master Track', codec: 'aac', bitrate: 128, sampleRate: 48000 }] },
    sinks: [
      { id: 'twitch', platform: 'twitch', encoder: 'tk', proto: 'rtmp', priority: 1 },
      { id: 'rec-h', platform: 'local', encoder: 'tk', proto: 'file', priority: 2 },
    ],
  },
  targets: { twitch: { transport: 'rtmp', port: PORT, app: 'live', stream: 'twitch' }, 'rec-h': { transport: 'file', name: 'recovery-rec-h.mkv' } },
  policy: { retryBaseMs: 1000, retryCapMs: 4000, retryMax: 5, retryResetLiveMs: 10000 },
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
// An ffmpeg RTMP listener on the loopback port; ends when the sender's connection ends.
function listener(name) {
  const file = path.join(dir, `${name}.mkv`);
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${PORT}/live/twitch`, '-c', 'copy', '-f', 'matroska', '-y', file],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  ff.stderr.resume();
  const exit = new Promise((r) => ff.on('exit', r));
  return { file, exit, async stop() { try { ff.stdin.write('q'); } catch { /* gone */ } await Promise.race([exit, sleep(8000).then(() => ff.kill())]); } };
}
const size = (f) => { try { return statSync(f).size; } catch { return 0; } };

before(async () => {
  const cfg = resolveConfig();
  assert.ok(existsSync(cfg.exe), `host exe missing: ${cfg.exe} (node app/host/tools/build.mjs)`);
  mkdirSync(OUT, { recursive: true });
  dir = mkdtempSync(path.join(OUT, 'stream-recovery-'));
  dataDir = path.join(dir, 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'stream-recovery': true } }));
  const planFile = path.join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(PLAN));
  const loginOut = path.join(dir, 'login.json');
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'services', 'studio-ui', 'launch.mjs'), '--data-dir', dataDir, '--mock', '--stop-on-stdin', '--shell', 'browser',
    '--outputs', planFile, '--profile', path.join(dir, 'no-profile.json')], {
    env: {
      ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_BROWSER: process.execPath, UJWALAM_BROWSER_ARGS: `${path.join(HOST_DIR, 'tests', 'studio-login.mjs')} ${loginOut}`,
      UJWALAM_HOST_DATA: path.join(dir, 'host'), UJWALAM_HOST_TOKEN: '', UJWALAM_LIVE_SESSION: '',
      UJWALAM_HOST_RESTART_BACKOFF_MS: '2500', UJWALAM_HOST_WATCH_MS: '300',
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

test('a host killed while streaming comes back with its stream and a new recording file', { timeout: 240_000 }, async () => {
  const st0 = await until(async () => { const s = (await req('GET', '/ui/api/status')).body; return s?.host?.outputsReady?.stream && s; }, 'stream output ready');
  assert.equal(st0.host.kind, 'host', 'the real host');
  const l1 = listener('first');
  await sleep(1200);
  await until(async () => { const r = await req('GET', '/ui/api/status'); return r.body?.host?.outputsReady?.record; }, 'record output ready');
  // Record, then go live, both through the page's confirm flow.
  for (const [method, phrase] of [['record.start', 'yes'], ['stream.start', 'yes, on air']]) {
    const c = await req('POST', '/ui/api/host', { method, params: {} });
    assert.equal(c.body.verdict, 'confirm', JSON.stringify(c.body));
    assert.equal(c.body.pending.phrase, phrase);
    const r = await req('POST', '/ui/api/confirm', { pendingId: c.body.pending.pendingId, text: phrase });
    assert.equal(r.body.verdict, 'allow', JSON.stringify(r.body));
  }
  await until(async () => size(l1.file) > 100_000, 'the first listener receiving the stream', 30_000);
  await sleep(1500); // the launcher's outputs.status poll sees the stream live

  const disc = JSON.parse(readFileSync(path.join(dataDir, 'host.json'), 'utf8'));
  process.kill(disc.pid); // TerminateProcess: exit code 1, an unexpected exit
  await Promise.race([l1.exit, sleep(15_000)]);
  const l2 = listener('second');
  await until(() => lines.some((x) => /HOST EXITED UNEXPECTEDLY/.test(x)), 'the crash line');
  await until(() => lines.some((x) => /Host crashed at \d\d:\d\d, streams restarted: Twitch$/.test(x)), 'the stream recovery line', 120_000);
  await until(async () => size(l2.file) > 100_000, 'the second listener receiving the restarted stream', 30_000);
  const page = await until(async () => { const s = (await req('GET', '/ui/api/status')).body; return s?.recovery && s; }, 'the recovery status on the page');
  assert.equal(page.recovery.result, 'restarted');
  assert.match(page.recovery.text, /^Host crashed at \d\d:\d\d, streams restarted: Twitch$/);
  assert.ok(lines.some((x) => /recording started again in a new file \(rec-h\)/.test(x)), lines.join('\n'));

  // Stop everything from the page (End all, then the recording), then check the files.
  const c = await req('POST', '/ui/api/streams/end-all', {});
  const e = await req('POST', '/ui/api/confirm', { pendingId: c.body.pending.pendingId, text: 'yes, on air' });
  assert.equal(e.body.endAll.allStopped, true, JSON.stringify(e.body));
  await l2.stop();
  for (const f of [l1.file, l2.file]) {
    const p = probe(f);
    const v = p.streams.filter((s) => s.type === 'video');
    assert.equal(v.length, 1, f);
    assert.equal(v[0].codec, 'h264');
    assert.deepEqual([v[0].width, v[0].height], [640, 360]);
    assert.ok(v[0].packets > 30, `${path.basename(f)} video packets ${v[0].packets}`);
  }
  // Two recording files: the one cut by the crash and the new one (never overwritten).
  const recs = readdirSync(path.join(dir, 'host', 'recordings')).filter((n) => /^recovery-rec-h-.*\.mkv$/.test(n));
  assert.equal(recs.length, 2, recs.join(', '));
  console.log(`# recordings: ${recs.join(', ')}`);
  console.log(`# ${lines.filter((x) => /HOST EXITED|host restarted|Host crashed|recording started again/.test(x)).join('\n# ')}`);
});
