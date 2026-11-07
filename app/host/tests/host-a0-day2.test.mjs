// SPDX-License-Identifier: GPL-3.0-or-later
// A0 day 2 against a real host (libobs, test card, no devices, no previews, loopback only, nothing leaves the machine):
// replay buffer H and V (fallback rungs, then bound to configured rungs with no extra encoder), markers, the feedback
// capture, panic (in-process first, then event-core's system pipe with the contract's retries) and global hotkeys.
//   node --test app/host/tests/host-a0-day2.test.mjs   (needs the built host, the OBS runtime and ffprobe on PATH)
// Hotkey actions are driven with hotkeys.trigger (host started with --test-hooks), which runs the same handler a key
// press runs. A second host registers real global hotkeys on unusual combos (Ctrl+Alt+Shift+F2x) and one key press
// is injected with keybd_event; if the desktop does not deliver it (locked or non-interactive session) that one
// check is skipped, never faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { probe, ffprobeVersion } from '../lib/ffprobe.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { startService } from '../../../services/event-core/api/service.mjs';
import { ENV_API_TOKEN, ENV_SYSTEM_TOKEN } from '../../../services/event-core/api/discovery.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h, c, DATA, CORE_DIR, FEEDBACK;
const coreTokens = { api: randomBytes(32).toString('hex'), system: randomBytes(32).toString('hex') };
// NVML counts every NVENC session on the GPU, including other apps on this machine (D188). The count taken before
// the host starts is subtracted; null when nvidia-smi is unavailable (then the session asserts are skipped).
let OTHER_SESSIONS = null;
function gpuSessions() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true });
  const n = r.status === 0 ? Number.parseInt(r.stdout.trim().split(/\r?\n/)[0], 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

before(async () => {
  OTHER_SESSIONS = gpuSessions();
  mkdirSync(OUT, { recursive: true });
  DATA = mkdtempSync(path.join(OUT, 'a0d2-'));
  CORE_DIR = path.join(DATA, 'core');
  FEEDBACK = path.join(DATA, 'feedback-root');
  const cfg = {
    replay: { seconds: 10, autoStart: false, fallbackKbps: { H: 6000, V: 4000 } },
    hotkeys: { enabled: false }, // trigger-only: this host takes no global key
    feedbackDir: FEEDBACK,
    eventCore: { systemFile: path.join(CORE_DIR, 'system.json') }
  };
  writeFileSync(path.join(DATA, 'host-config.json'), JSON.stringify(cfg, null, 2));
  h = await launchHost({
    dataDir: DATA,
    project: path.join(HOST_DIR, 'projects', 'test-card.project.json'),
    extraArgs: ['--host-config', path.join(DATA, 'host-config.json'), '--test-hooks', '--allow-browser'],
    env: { UJWALAM_EVENT_CORE_SYSTEM_TOKEN: coreTokens.system },
    timeoutMs: 60000
  });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h, 40000);
  assert.equal(r.code, 0, 'host exits 0');
});

async function rpcErr(method, params, client = c) {
  try { await client.call(method, params); } catch (e) { return e; }
  assert.fail(`${method} should have failed`);
}

async function until(fn, ms = 20000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

function checkClip(file, canvas) {
  const p = probe(file);
  const v = p.streams.find((s) => s.type === 'video');
  const a = p.streams.find((s) => s.type === 'audio');
  assert.ok(v && v.codec === 'h264', `${canvas}: h264 video in ${path.basename(file)}`);
  assert.ok(a && a.codec === 'aac', `${canvas}: aac audio`);
  assert.ok(p.format.includes('matroska'), `${canvas}: mkv container (${p.format})`);
  return { durationSec: p.durationSec, w: v.width, h: v.height, fps: v.measuredFps, kbps: Math.round(v.measuredKbps) };
}

test('host.info: config, session, hotkeys off but listed, test hooks on', async () => {
  const i = await c.call('host.info');
  assert.equal(i.flags.testHooks, true);
  assert.match(i.session, /^\d{8}-\d{6}$/);
  assert.equal(i.hostConfig, path.join(DATA, 'host-config.json'));
  assert.equal(i.hotkeys.enabled, false);
  assert.deepEqual(i.hotkeys.bindings.map((b) => [b.name, b.combo, b.registered]),
    [['panic', 'Ctrl+Alt+P', false], ['feedback', 'Ctrl+Alt+F', false], ['marker', 'Ctrl+Alt+Shift+M', false]]);
  assert.equal(i.moments.feedbackDir.replaceAll('\\', '/'), FEEDBACK.replaceAll('\\', '/'));
});

test('replay: refused before start, then H and V on fallback rungs, replay.save writes playable mkv', async () => {
  assert.ok(ffprobeVersion(), 'ffprobe on PATH');
  const before = await c.call('replay.save');
  assert.equal(before.saved.length, 0);
  assert.match(before.errors[0].error, /not running/);
  for (const p of [{ seconds: 4 }, { seconds: 601 }, { seconds: 'x' }, { extra: 1 }]) {
    assert.equal((await rpcErr('replay.start', p)).code, -32602, JSON.stringify(p));
  }
  const st = await c.call('replay.start');
  assert.equal(st.wanted, true);
  assert.equal(st.seconds, 10);
  assert.deepEqual(st.canvases.map((x) => [x.canvas, x.state, x.fallback]), [['H', 'running', true], ['V', 'running', true]]);
  const hs = await c.call('host.status');
  assert.deepEqual(hs.replayRunning, { H: true, V: true });
  await sleep(4000);
  const r = await c.call('replay.save');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.saved.map((x) => x.canvas), ['H', 'V']);
  for (const s of r.saved) {
    assert.ok(path.resolve(s.path).startsWith(path.resolve(DATA, 'recordings', 'replay')), `in <recordings>/replay: ${s.path}`);
    assert.match(path.basename(s.path), new RegExp(`^replay-${s.canvas}-\\d{8}-\\d{6}\\.mkv$`));
    const m = checkClip(s.path, s.canvas);
    assert.ok(m.durationSec >= 2 && m.durationSec <= 13, `${s.canvas}: ${m.durationSec} s`);
    assert.deepEqual([m.w, m.h], s.canvas === 'H' ? [1920, 1080] : [1080, 1920]);
    console.log(`replay fallback ${s.canvas}: ${JSON.stringify(m)}`);
  }
  const one = await c.call('replay.save', { canvas: 'v' });
  assert.deepEqual(one.saved.map((x) => x.canvas), ['V']);
  assert.equal((await rpcErr('replay.save', { canvas: 'X' })).code, -32602);
});

test('replay: binds to the configured rungs (no extra encoder), shares the encoder with a recording, follows clear', async () => {
  // This host's sessions = GPU-wide count minus the other apps' sessions counted before the host started (D188).
  const sessions = async () => {
    const n = (await c.call('host.status')).gpu.encoderSessions;
    return n === null || n === undefined || OTHER_SESSIONS === null ? null : n - OTHER_SESSIONS;
  };
  const params = {
    rungs: [
      { id: 'h1', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1920, h: 1080, fps: 60, bitrate: 8000, gopSec: 2 },
      { id: 'h2', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1280, h: 720, fps: 30, bitrate: 3000, gopSec: 2 },
      { id: 'v1', canvas: 'V', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1080, h: 1920, fps: 60, bitrate: 6000, gopSec: 2 }
    ],
    audio: { bitrate: 160, sampleRate: 48000 },
    sinks: [
      { id: 'rec-h', rung: 'h1', platform: 'local', proto: 'file', target: { transport: 'file', name: 'a0d2-h.mkv' } },
      { id: 'rec-h2', rung: 'h2', platform: 'local', proto: 'file', target: { transport: 'file', name: 'a0d2-h2.mkv' } },
      { id: 'rec-v', rung: 'v1', platform: 'local', proto: 'file', target: { transport: 'file', name: 'a0d2-v.mkv' } }
    ]
  };
  await c.call('outputs.configure', params);
  const st = await c.call('replay.status');
  assert.deepEqual(st.canvases.map((x) => [x.canvas, x.state, x.fallback, x.rung]),
    [['H', 'running', false, 'h1'], ['V', 'running', false, 'v1']], 'largest rung per canvas');
  await sleep(1500);
  const n = await sessions();
  if (n !== null && n !== undefined) {
    // NVML counts every NVENC session on the GPU: the 2 replays use the h1 and v1 rung encoders, h2 is idle.
    assert.equal(n, 2, `NVENC sessions with the replays bound to rungs: ${n} (fallback encoders would add more)`);
  }
  await c.call('record.start', { sinks: ['rec-h'] });
  await sleep(3500);
  const n2 = await sessions();
  if (n2 !== null) assert.equal(n2, 2, 'a recording on h1 adds no session');
  const r = await c.call('replay.save', { canvas: 'H' });
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].rung, 'h1');
  assert.equal(r.saved[0].fallback, false);
  const stop = await c.call('record.stop', { sinks: ['rec-h'] });
  const recPath = stop.sinks[0].path;
  await until(async () => (await c.call('outputs.status')).sinks.find((s) => s.id === 'rec-h').state === 'stopped');
  const m = checkClip(r.saved[0].path, 'H');
  console.log(`replay on rung h1: ${JSON.stringify(m)}; recording ${JSON.stringify(checkClip(recPath, 'H'))}`);
  assert.ok(m.kbps > 2000 && m.kbps < 16000, `replay bitrate follows the 8000 kbps rung: ${m.kbps}`);
  assert.equal((await c.call('replay.status')).canvases.find((x) => x.canvas === 'H').state, 'running', 'replay survives the record stop');
  await c.call('outputs.clear');
  const back = await c.call('replay.status');
  assert.deepEqual(back.canvases.map((x) => [x.canvas, x.state, x.fallback]), [['H', 'running', true], ['V', 'running', true]]);
});

test('markers: api, chat and hotkey sources append JSON lines with stream-relative time', async () => {
  const a = await c.call('marker.add', { source: 'api', note: 'line\none\ttab' });
  assert.equal(a.marker.note, 'line one tab', 'control characters become spaces');
  assert.equal(a.marker.streamMs, null, 'not streaming');
  assert.equal(a.marker.recordMs, null);
  assert.ok(a.marker.hostMs > 0);
  assert.deepEqual(a.marker.scenes, { H: 'card-h', V: 'card-v' });
  await c.call('marker.add', { source: 'chat', note: 'clip that' });
  await c.call('hotkeys.trigger', { name: 'marker' });
  for (const p of [{ source: 'x' }, {}, { source: 'api', note: 'n'.repeat(501) }, { source: 'api', extra: 1 }]) {
    assert.equal((await rpcErr('marker.add', p)).code, -32602, JSON.stringify(p));
  }
  const info = await c.call('host.info');
  assert.match(a.file, new RegExp(`markers/${info.session}\\.jsonl$`));
  const lines = readFileSync(a.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.source), ['api', 'chat', 'hotkey']);
  assert.ok(lines.every((l) => l.v === 1 && /Z$/.test(l.at)));
});

test('feedback: the hotkey handler writes moment.json, log.txt and the last replay H and V into feedback/<date>/<time>/', async () => {
  if (!(await c.call('replay.status')).wanted) { await c.call('replay.start', { seconds: 10 }); await sleep(3000); }
  await c.call('hotkeys.trigger', { name: 'feedback' });
  const dir = await until(async () => (await c.call('feedback.status')).lastCapture);
  assert.ok(dir, 'a capture folder');
  assert.ok(path.resolve(dir).startsWith(path.resolve(FEEDBACK)), 'under the configured feedback dir');
  assert.match(dir.replaceAll('\\', '/'), /\/\d{4}-\d\d-\d\d\/\d{6}(-\d+)?$/);
  const moment = await until(() => {
    try { const m = JSON.parse(readFileSync(path.join(dir, 'moment.json'), 'utf8')); return m.replay.state === 'done' ? m : null; } catch { return null; }
  }, 30000);
  assert.ok(moment, 'replay saves finished');
  assert.equal(moment.trigger, 'hotkey');
  assert.equal(moment.version, (await c.call('host.info')).version);
  assert.deepEqual(moment.scenes, { H: 'card-h', V: 'card-v' });
  for (const k of ['cpuPct', 'gpuPct', 'droppedFrames', 'renderLagged', 'renderTotal', 'encodeSkipped', 'fps']) assert.ok(k in moment.stats, `stats.${k}`);
  assert.deepEqual(moment.replay.errors, []);
  assert.deepEqual(moment.replay.saved.map((s) => s.file), ['replay-H.mkv', 'replay-V.mkv']);
  assert.equal(moment.voiceNote.done, false);
  assert.ok(moment.replay.saved.every((s) => !('path' in s) && !/[\\/:]/.test(s.file)), 'file names only, no absolute paths');
  for (const s of moment.replay.saved) checkClip(path.join(dir, s.file), s.canvas);
  const log = readFileSync(path.join(dir, 'log.txt'), 'utf8').trim().split('\n');
  assert.ok(log.length >= 10 && log.length <= 200, `${log.length} log lines`);
  assert.ok(!/[0-9a-fA-F]{32,}/.test(log.join('\n')), 'no token-shaped hex in log.txt');
  assert.ok(!log.join('\n').includes(coreTokens.system), 'no event-core token');
  assert.deepEqual(readdirSync(dir).sort(), ['log.txt', 'moment.json', 'replay-H.mkv', 'replay-V.mkv']);
  // the API entry point too
  const api = await c.call('feedback.capture', { note: 'api capture' });
  assert.ok(existsSync(path.join(api.dir, 'moment.json')));
});

test('panic: in-process first (browser layers hidden, effects refused), event-core retries then is told over the system pipe', async () => {
  // A browser layer (nothing listens on port 9: the page fails to load, the source exists).
  await c.call('layers.add', { scene: 'card-h', canvas: 'H', layer: { id: 'fx', type: 'browser', name: 'FX', settings: { url: 'http://127.0.0.1:9/fx.html', width: 320, height: 180 } } });
  const visible = async () => (await c.call('layers.list', { scene: 'card-h', canvas: 'H' })).layers.find((l) => l.id === 'fx').visible;
  assert.equal(await visible(), true);

  // 1. event-core is not running: the host still panics at once, and the pipe send retries 5 times (50/100/200/400 ms).
  const t0 = Date.now();
  const p1 = await c.call('panic.now');
  assert.equal(p1.engaged, true);
  assert.equal(p1.hiddenNow, 1);
  assert.equal(await visible(), false, 'browser layer hidden in-process');
  assert.ok(Date.now() - t0 < 1500, 'panic.now does not wait for event-core');
  assert.deepEqual(await c.call('effect.fire', { name: 'gg-burst' }), { ok: false, reason: 'panic' });
  const s1 = await until(async () => { const s = await c.call('panic.status'); return s.core.state === 'done' ? s : null; }, 10000, 50);
  assert.equal(s1.core.ok, false);
  assert.equal(s1.core.reason, 'send-failed');
  assert.equal(s1.core.attempts, 5);
  assert.equal(s1.coreConfigured, true);
  const ms = Date.parse(s1.core.at);
  assert.ok(Number.isFinite(ms));

  // 2. event-core up (real service, system pipe with its owner-only DACL): the next panic reaches it.
  const svc = await startService({ dataDir: CORE_DIR, noStreamerbot: true, env: { [ENV_API_TOKEN]: coreTokens.api, [ENV_SYSTEM_TOKEN]: coreTokens.system } });
  try {
    assert.ok(svc.systemPipe, 'event-core system pipe started');
    const clr = await c.call('panic.clear');
    assert.deepEqual(clr, { cleared: true, restored: 1 });
    assert.equal(await visible(), true, 'panic.clear shows the layer again');
    await c.call('hotkeys.trigger', { name: 'panic' });
    assert.equal(await visible(), false);
    const s2 = await until(async () => { const s = await c.call('panic.status'); return s.core.state === 'done' && s.count === 2 ? s : null; }, 10000, 50);
    assert.equal(s2.lastSource, 'hotkey');
    assert.equal(s2.core.ok, true);
    assert.equal(s2.core.reason, 'panic-engaged');
    assert.equal(s2.core.attempts, 1);
    await c.call('panic.now'); // idempotent on both sides
    const s3 = await until(async () => { const s = await c.call('panic.status'); return s.core.state === 'done' && s.count === 3 ? s : null; }, 10000, 50);
    assert.equal(s3.core.reason, 'already-panic');
    assert.equal((await c.call('host.status')).panic, true);
    // outputs and replay untouched by panic
    assert.deepEqual((await c.call('host.status')).replayRunning, { H: true, V: true });
  } finally {
    await svc.stop();
  }
  await c.call('panic.clear');
  assert.equal((await c.call('panic.status')).engaged, false);
  const tail = (await c.call('log.tail', { lines: 1000 })).lines.join('\n');
  assert.ok(!tail.includes(coreTokens.system), 'the system token is never logged');
});

test('hotkeys.trigger: unknown name and bad params are refused', async () => {
  assert.equal((await rpcErr('hotkeys.trigger', { name: 'nope' })).code, -32602);
  assert.equal((await rpcErr('hotkeys.trigger', {})).code, -32602);
});

test('second host: real RegisterHotKey, a taken combo and a bad combo are reported, not fatal; no --test-hooks = no trigger', async () => {
  const d2 = mkdtempSync(path.join(OUT, 'a0d2-keys-'));
  const cfg = { hotkeys: { enabled: true, panic: null, marker: 'Ctrl+Alt+Shift+F21', feedback: 'Ctrl+Alt+Shift+F21' }, markersDir: path.join(d2, 'm') };
  writeFileSync(path.join(d2, 'host-config.json'), JSON.stringify(cfg));
  const h2 = await launchHost({ dataDir: d2, project: path.join(HOST_DIR, 'projects', 'test-card.project.json'), extraArgs: ['--host-config', path.join(d2, 'host-config.json')] });
  try {
    const hk = (await h2.client.call('host.info')).hotkeys;
    assert.equal(hk.enabled, true);
    const by = Object.fromEntries(hk.bindings.map((b) => [b.name, b]));
    assert.equal(by.panic.combo, null);
    assert.equal(by.panic.error, 'off');
    assert.equal(by.feedback.registered, true, `feedback registered: ${by.feedback.error}`);
    assert.equal(by.marker.registered, false);
    assert.match(by.marker.error, /already registered/);
    assert.equal((await rpcErr('hotkeys.trigger', { name: 'feedback' }, h2.client)).code, -32001, 'FORBIDDEN without --test-hooks');
    // One real key press through the desktop input queue (keybd_event): Ctrl+Alt+Shift+F21 -> feedback capture.
    const ps = [
      'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);\'',
      '$k = 0x11,0x12,0x10,0x84', 'foreach ($x in $k) { [W.K]::keybd_event($x, 0, 0, [System.UIntPtr]::Zero) }',
      '[array]::Reverse($k)', 'foreach ($x in $k) { [W.K]::keybd_event($x, 0, 2, [System.UIntPtr]::Zero) }'
    ].join('; ');
    // Opt-in (UJWALAM_HOTKEY_INJECT=1): it types into the user's desktop session, so CI and normal runs skip it.
    const inject = process.env.UJWALAM_HOTKEY_INJECT === '1';
    if (inject) spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const pressed = inject && await until(async () => (await h2.client.call('hotkeys.status')).bindings.find((b) => b.name === 'feedback').presses > 0, 5000);
    if (!inject) {
      console.log('SKIP: key injection is opt-in (UJWALAM_HOTKEY_INJECT=1); WM_HOTKEY delivery not exercised in this run');
    } else if (!pressed) {
      console.log('SKIP: the injected key press was not delivered (non-interactive or locked desktop); WM_HOTKEY path UNVERIFIED in this run');
    } else {
      const dir = await until(async () => (await h2.client.call('feedback.status')).lastCapture, 5000);
      assert.ok(dir && existsSync(path.join(dir, 'moment.json')), 'a real key press made a feedback capture');
      console.log('real WM_HOTKEY press delivered: feedback capture made');
    }
  } finally {
    const r = await stopHost(h2, 40000);
    assert.equal(r.code, 0);
  }
  const d3 = mkdtempSync(path.join(OUT, 'a0d2-bad-'));
  writeFileSync(path.join(d3, 'host-config.json'), JSON.stringify({ hotkeys: { enabled: true, panic: 'Shift+P', feedback: 'Ctrl+Alt+Bogus', marker: null }, monitoringDevice: 'No Such Output', audio: { lowLatency: true } }));
  // monitoringDevice without --allow-devices: accepted, not applied (the host still starts)
  const h3 = await launchHost({ dataDir: d3, project: path.join(HOST_DIR, 'projects', 'test-card.project.json'), extraArgs: ['--host-config', path.join(d3, 'host-config.json')] });
  try {
    const by = Object.fromEntries((await h3.client.call('host.info')).hotkeys.bindings.map((b) => [b.name, b]));
    assert.match(by.panic.error, /invalid combo/, 'Shift alone is refused');
    assert.match(by.feedback.error, /invalid combo/);
  } finally {
    assert.equal((await stopHost(h3, 40000)).code, 0);
  }
});

test('host config: unknown keys and bad values stop the host with exit 64', async () => {
  const d4 = mkdtempSync(path.join(OUT, 'a0d2-cfg-'));
  for (const [i, cfg] of [{ nope: 1 }, { replay: { seconds: 2 } }, { feedbackDir: 'relative/dir' }, { hotkeys: { panic: 5 } }, { monitoringDevice: '' }, { monitoringDevice: 5 }, { audio: { lowLatency: 1 } }, { audio: { other: true } }].entries()) {
    const f = path.join(d4, `c${i}.json`);
    writeFileSync(f, JSON.stringify(cfg));
    await assert.rejects(launchHost({ dataDir: d4, extraArgs: ['--host-config', f], timeoutMs: 15000 }), /exited with 64/, JSON.stringify(cfg));
  }
});
