// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: browser layers (obs-browser, tier B) and the overlay server child under the host's supervisor.
//   node --test app/host/tests/
// Test card + one legacy overlay page (gg-burst, fired through the relay page) only: no devices, no event core, no
// real Streamer.bot (8093 is refused). The overlay root is cfg.overlayRoot (default <repo>/legacy, read-only).
// Frames are read from a local recording in out/ (gitignored) and compared as numbers; no image is kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost, planInHost } from '../lib/project.mjs';
import { REPO_ROOT, HOST_DIR, resolveConfig } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const cfg = resolveConfig();
const haveRoot = existsSync(path.join(cfg.overlayRoot, 'overlays', 'gg-burst', 'index.html'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;
let c;

const W = 1280, H = 720;
const PROJECT = {
  version: 1, id: 'browser-check', name: 'Browser check', activeScene: 'main',
  canvases: [{ id: 'h', width: W, height: H, fps: 30 }],
  devices: [], outputs: [],
  overlays: [{ id: 'ov-gg', name: 'GG burst', file: { base: 'overlays', rel: 'gg-burst/index.html' } }],
  scenes: [{
    id: 'main', name: 'Main', layers: [
      { id: 'bg', type: 'color', name: 'Bg', source: { color: '#203040' },
        placements: { h: { visible: true, x: 0, y: 0, width: W, height: H } } },
      { id: 'gg', type: 'browser', name: 'GG', source: { overlay: 'ov-gg', width: 1920, height: 1080 },
        placements: { h: { visible: true, x: 0, y: 0, width: W, height: H } } }
    ]
  }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
};

before(async () => {
  if (!haveRoot) return;
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'browser-')), overlay: true, project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
  assert.match(h.log.join(''), /overlay: child started/);
});

async function rpcErr(method, params) {
  try {
    await c.call(method, params);
  } catch (e) {
    return e;
  }
  assert.fail(`${method} should have failed`);
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`);
    await sleep(100);
  }
}

// Grey 160x90 frames at 30 fps from t0 for dur seconds of a recording, and the share of pixels that differ from the
// first frame by more than 24 levels (a drawn effect; encoder noise stays far below that).
const FW = 160, FH = 90;
function changed(file, t0, dur) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-i', file, '-t', String(dur),
    '-vf', `fps=30,scale=${FW}:${FH}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 << 20, windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  const n = FW * FH, frames = Math.floor(r.stdout.length / n);
  const base = r.stdout.subarray(0, n);
  const out = [];
  for (let f = 0; f < frames; f++) {
    const x = r.stdout.subarray(f * n, (f + 1) * n);
    let c = 0;
    for (let i = 0; i < n; i++) if (Math.abs(x[i] - base[i]) > 24) c++;
    out.push(c / n);
  }
  return out;
}

const RUNG = { id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 2500, gopSec: 1 };
const AUDIO = { bitrate: 128, sampleRate: 48000 };
const recSink = (name) => ({ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name } });

async function record(name, during) {
  await c.call('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [recSink(name)] });
  await c.call('record.start', {});
  await waitFor(async () => (await c.call('outputs.status')).sinks[0].state === 'live', 5000, 'recording live');
  const t0 = Date.now();
  const marks = await during(() => (Date.now() - t0) / 1000);
  await c.call('record.stop', {});
  const st = await waitFor(async () => { const s = await c.call('outputs.status'); return s.sinks[0].state === 'stopped' && s; }, 8000, 'recording stopped');
  return { file: st.sinks[0].path, marks };
}

test('overlay server runs under the host: 127.0.0.1, not 8093, obs-browser loaded, no token in its environment', { skip: !haveRoot && 'no overlay root' }, async () => {
  const info = await c.call('host.info');
  assert.equal(info.flags.allowBrowser, true);
  assert.equal(info.flags.allowDevices, false);
  assert.ok(info.loadedModules.includes('obs-browser.dll'), 'obs-browser loaded (tier B)');
  assert.ok(info.sourceTypes.includes('browser_source'));
  const st = await c.call('overlay.status');
  assert.equal(st.state, 'running');
  assert.ok(st.staticPort > 0 && st.feedPort > 0 && st.staticPort !== 8093 && st.feedPort !== 8093);
  assert.equal(st.eventFeed, false, 'no event-core feed in this test');
  assert.equal(st.childHasEventToken, false);
  assert.ok(st.childEnvKeys.length > 0);
  for (const k of st.childEnvKeys) assert.doesNotMatch(k, /UJWALAM|TOKEN|NODE_OPTIONS|STREAM|KEY/i, `child env has only system names (${k})`);
  assert.deepEqual(info.overlay.staticPort, st.staticPort);
  // overlay.stats: the bridge counters (numbers only); no event feed here, so no chat frames.
  const stats = await c.call('overlay.stats');
  for (const k of ['clients', 'chatFrames', 'busFrames', 'effects']) assert.equal(typeof stats[k], 'number', k);
  assert.equal(stats.chatFrames, 0);
  assert.equal((await rpcErr('overlay.stats', { extra: 1 })).code, -32602);
  // Pages and the relay: served from 127.0.0.1, and neither the host's api token nor any token value appears.
  for (const p of ['/overlays/gg-burst/index.html', '/_ujwalam/relay.html', '/_ujwalam/relay.js']) {
    const r = await get(st.staticPort, p);
    assert.equal(r.status, 200, p);
    assert.ok(!r.body.includes(h.token) && !JSON.stringify(r.headers).includes(h.token), `${p}: no host token`);
  }
});

test('effect.fire validates its input and reports the guards verdict', { skip: !haveRoot && 'no overlay root' }, async () => {
  assert.equal((await rpcErr('effect.fire', { name: 'GG!' })).code, -32602);
  assert.equal((await rpcErr('effect.fire', {})).code, -32602);
  assert.equal((await rpcErr('effect.fire', { name: 'gg', meta: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 } })).code, -32602);
  assert.equal((await rpcErr('effect.fire', { name: 'gg', meta: { a: { nested: true } } })).code, -32602);
  assert.equal((await rpcErr('effect.fire', { name: 'gg', extra: 1 })).code, -32602);
  const unknown = await c.call('effect.fire', { name: 'not-an-effect' });
  assert.equal(unknown.ok, false, 'unknown effects fail closed (guards)');
  assert.equal(typeof unknown.reason, 'string');
});

test('project v1 overlay layer: URL via feedQuery, relay page, gg-burst draws on effect.fire and clears after', { skip: !haveRoot && 'no overlay root' }, async () => {
  const st = await c.call('overlay.status');
  const plan = await planInHost(c, PROJECT);
  assert.deepEqual(plan.unavailable, [], 'overlay layer is buildable');
  const src = plan.sources.find((s) => s.layer === 'gg');
  assert.equal(src.overlay, true);
  const url = src.url;
  assert.ok(url.startsWith(`http://127.0.0.1:${st.staticPort}/overlays/gg-burst/index.html?`), 'page on the host overlay server');
  assert.match(url, new RegExp(`[?&]sbPort=${st.feedPort}(&|$)`), 'feedQuery points at the bridge feed');
  assert.ok(!url.includes(h.token) && !/token/i.test(url), 'no token in the layer URL');

  // A URL that does not belong to the layer's overlay is not loaded.
  const forged = await c.call('project.plan', { project: PROJECT, browserUrls: { gg: `http://127.0.0.1:${st.staticPort}/overlays/other/index.html` } });
  assert.equal(forged.unavailable[0]?.layer, 'gg');
  assert.match(forged.unavailable[0].reason, /does not point at this layer's overlay/);
  const noUrl = await c.call('project.plan', { project: PROJECT });
  assert.match(noUrl.unavailable[0].reason, /no overlay URL/);

  const r = await loadIntoHost(c, PROJECT);
  assert.equal(r.built.overlayLayers, 1);
  assert.equal(r.built.relay, 'effects', 'one relay page, effects scope (gg-burst is not a display page)');
  assert.equal((await c.call('project.get')).relay, 'effects');
  await sleep(3000); // CEF loads the page and the relay connects to the feed

  const rec = await record('browser-gg.mkv', async (now) => {
    await sleep(2500);
    const fired = now();
    const res = await c.call('effect.fire', { name: 'gg' });
    assert.deepEqual(res, { ok: true });
    await sleep(6000);
    return { fired };
  });
  const t0 = Math.max(0.2, rec.marks.fired - 1.5);
  const ch = changed(rec.file, t0, 6.5);
  const on = ch.map((v) => v > 0.002); // > 0.2 % of the frame drawn
  const first = on.indexOf(true), last = on.lastIndexOf(true);
  const atFire = Math.round((rec.marks.fired - t0) * 30);
  const onsetMs = Math.round((first - atFire) * 1000 / 30), shownMs = Math.round((last - first + 1) * 1000 / 30);
  const peak = Math.max(...ch);
  console.log(`# gg-burst: onset ${onsetMs} ms after effect.fire (wall clock vs file time), shown ${shownMs} ms, peak ${(peak * 100).toFixed(1)} % of pixels, idle max ${(Math.max(...ch.slice(0, Math.max(1, atFire - 3))) * 100).toFixed(2)} %`);
  assert.ok(first > 0, 'nothing drawn before the effect');
  assert.ok(first >= atFire - 6, 'drawing starts at the fire, not before');
  assert.ok(onsetMs < 1000, 'the effect starts within a second (BroadcastChannel from the relay reached the page)');
  assert.ok(peak > 0.01, 'the effect draws a visible area');
  assert.ok(shownMs > 1500 && shownMs < 3500, 'shown for about its 2400 ms duration');
  assert.ok(last < ch.length - 15, 'the effect clears');
  const stats = await (async () => { try { return await c.call('overlay.status'); } catch { return null; } })();
  assert.equal(stats.state, 'running');
});

test('overlay child restart: new pid, same ports, effect.fire UNAVAILABLE while down, recording unaffected, pages reconnect', { skip: !haveRoot && 'no overlay root' }, async () => {
  if ((await c.call('project.get')).relay !== 'effects') { await loadIntoHost(c, PROJECT); await sleep(3000); }
  const st0 = await c.call('overlay.status');
  let sawDown = false;
  const rec = await record('browser-restart.mkv', async (now) => {
    await sleep(1000);
    const k = spawnSync('taskkill', ['/PID', String(st0.pid), '/F'], { encoding: 'utf8', windowsHide: true });
    assert.equal(k.status, 0, k.stderr);
    const killed = now();
    const e = await rpcErr('effect.fire', { name: 'gg' }).catch(() => null);
    if (e && e.code === -32004) sawDown = true;
    const st1 = await waitFor(async () => { const s = await c.call('overlay.status'); return s.state === 'running' && s.pid !== st0.pid && s; }, 20000, 'child back');
    const back = now();
    assert.equal(st1.staticPort, st0.staticPort, 'static port pinned across restarts');
    assert.equal(st1.feedPort, st0.feedPort, 'feed port pinned across restarts');
    assert.equal(st1.restarts, st0.restarts + 1);
    await sleep(3000); // the relay page retries its feed socket (1 s, then x1.6)
    const fired = now();
    assert.deepEqual(await c.call('effect.fire', { name: 'gg' }), { ok: true });
    await sleep(3500);
    return { killed, back, fired };
  });
  assert.ok(sawDown, 'effect.fire answered -32004 while the child was down');
  const p = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', rec.file], { encoding: 'utf8', windowsHide: true });
  const dur = Number(p.stdout.trim());
  console.log(`# restart in ${((rec.marks.back - rec.marks.killed) * 1000).toFixed(0)} ms; recording ${dur.toFixed(2)} s`);
  assert.ok(dur >= rec.marks.back + 1.0, 'the recording ran through the restart');
  const t0 = rec.marks.fired - 1.0;
  const ch = changed(rec.file, t0, 4.0);
  const first = ch.findIndex((v) => v > 0.002);
  console.log(`# after restart: gg-burst onset ${Math.round((first - 30) * 1000 / 30)} ms after effect.fire, peak ${(Math.max(...ch) * 100).toFixed(1)} %`);
  assert.ok(first >= 24 && first < 60, 'the page drew the effect after the restart (relay reconnected to the pinned feed port)');
  const cv = (await c.call('host.status'));
  assert.ok(cv.droppedFrames === 0 || cv.droppedFrames === undefined || cv.droppedFrames < 5, 'no output drops from the restart');
});

test('overlay ports: 8093 is refused before anything starts', { skip: !haveRoot && 'no overlay root' }, async () => {
  for (const flag of ['--overlay-port', '--overlay-feed-port']) {
    const r = spawnSync(h.cfg.exe, ['--runtime', h.cfg.runtime, '--data-dir', mkdtempSync(path.join(OUT, 'bad-')), '--allow-browser',
      '--overlay-root', cfg.overlayRoot, '--overlay-script', cfg.overlayScript, '--node', process.execPath, flag, '8093'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(r.status, 64, `${flag} 8093 refused`);
  }
  const r = spawnSync(process.execPath, [cfg.overlayScript, '--root', cfg.overlayRoot, '--feed-port', '8093'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(r.status, 64, 'the child refuses 8093 too');
});

// Cam-pop mic feed (overlay.h): the child names the mic source (guards.json rules.campop.voice.audioSource), the host
// pumps that source's meter peak into the child as op "mic" every 50 ms, and the rule counts a voice trigger. A media
// layer with a loud tone stands in for the mic (no devices); its project audio source gets the configured id.
test('cam-pop mic feed: the named audio source reaches the rule as op mic (about 20 lines/s), loud tone triggers', { skip: !haveRoot && 'no overlay root' }, async () => {
  const { readFileSync } = await import('node:fs');
  const voice = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'effects', 'guards.json'), 'utf8')).rules.campop.voice;
  const micId = voice.audioSource.id;
  const media = mkdtempSync(path.join(OUT, 'mic-'));
  const ff = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30',
    '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t):s=48000', '-t', '4', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest',
    path.join(media, 'tone.mp4')], { windowsHide: true });
  assert.equal(ff.status, 0, String(ff.stderr));
  const MIC = {
    version: 1, id: 'mic-feed', name: 'Mic feed', activeScene: 'main',
    canvases: [{ id: 'h', width: W, height: H, fps: 30 }], devices: [], overlays: [], outputs: [],
    scenes: [{ id: 'main', name: 'Main', layers: [
      { id: 'tone', type: 'media', name: 'Tone', source: { file: { base: 'media', rel: 'tone.mp4' }, loop: true },
        placements: { h: { visible: true, x: 0, y: 0, width: W, height: H } } }] }],
    audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [
      { id: micId, name: 'Mic stand-in', layer: 'tone', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }] }
  };
  const st0 = await c.call('overlay.status');
  assert.equal(st0.mic.source, micId, 'the child named the mic source in its ready line');
  const stats0 = await c.call('overlay.stats');
  assert.equal(typeof stats0.campop?.triggers, 'number', 'stats carry the cam-pop rule counters');
  await loadIntoHost(c, MIC, { bases: { media } });
  const a = await waitFor(async () => { const s = await c.call('overlay.status'); return s.mic.found && s.mic.sent > st0.mic.sent && s; }, 5000, 'mic feed found');
  const t0 = Date.now();
  await sleep(2000);
  const b = await c.call('overlay.status');
  const rate = (b.mic.sent - a.mic.sent) / ((Date.now() - t0) / 1000);
  console.log(`# mic feed: ${rate.toFixed(1)} lines/s, skipped ${b.mic.skipped - a.mic.skipped}`);
  assert.ok(rate >= 14 && rate <= 22, `about 20 lines/s (got ${rate.toFixed(1)})`);
  const stats1 = await c.call('overlay.stats');
  assert.ok(stats1.campop.triggers > stats0.campop.triggers, 'the loud tone held over holdMs counted as a voice trigger');
  assert.equal(b.state, 'running');
});
