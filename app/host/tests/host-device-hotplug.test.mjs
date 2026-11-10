// SPDX-License-Identifier: GPL-3.0-or-later
// Device hot-plug (D329) on a real host: a capture layer whose device is not connected is added "waiting" instead of
// failing, and is bound when the device arrives, unbound when it leaves, and rebound when it comes back on another USB
// port (matched by name), while a recording keeps running.
//   node --test app/host/tests/host-device-hotplug.test.mjs
// No device is listed or opened: the host runs with --test-hooks and without --allow-devices. devices.testSet replaces
// the device list with a fake one and runs the same pass a Windows plug-in / unplug notification runs; capture layers
// are built on the host's test source type ujw_test_capture (64 x 36 frames while its fake device is "connected").
// Real hot-plug with the user's capture card is UNVERIFIED here (docs/evidence/2026-11-10-device-hotplug.md).
// Headless (UJWALAM_HEADLESS=1). Needs the built host and ffprobe on PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost, planInHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';
import { probe } from '../lib/ffprobe.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const HEADLESS = { UJWALAM_HEADLESS: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = 'UJW Test Capture Card'; // a name no real device has
const P1 = '\\\\?\\usb#vid_0000&pid_0001&mi_00#7&aaaa&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global';
const P2 = '\\\\?\\usb#vid_0000&pid_0001&mi_00#7&bbbb&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global';
const P3 = '\\\\?\\usb#vid_0000&pid_0001&mi_00#7&cccc&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global';
const card = (p, name = NAME) => ({ kind: 'video', name, path: p });

let h;
let c;

const place = { h: { visible: true, x: 0, y: 0, width: 640, height: 360 } };
const bg = { id: 'bg', type: 'color', name: 'Background', source: { color: '#101820' }, placements: { h: { visible: true, x: 0, y: 0, width: 1280, height: 720 } } };
const capLayer = { id: 'cap', type: 'capture', name: 'Game', source: { device: 'dev-card' }, placements: place };
function doc({ withCapture, withAudio = false }) {
  return {
    version: 1, id: 'hotplug', name: 'Hot-plug test', activeScene: 'main',
    canvases: [{ id: 'h', width: 1280, height: 720, fps: 30 }],
    devices: [{ id: 'dev-card', kind: 'capture-card', name: 'Capture card', match: { name: NAME, deviceId: P1 } }],
    overlays: [], outputs: [],
    scenes: [{ id: 'main', name: 'Main', layers: withCapture ? [bg, capLayer] : [bg] }],
    audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: withAudio
      ? [{ id: 'aud-card', name: 'Card audio', device: 'dev-card', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }] : [] },
  };
}

async function rpcErr(method, params, client = c) {
  try { await client.call(method, params); } catch (e) { return e; }
  assert.fail(`${method} should have failed`);
}
async function until(fn, what, ms = 10_000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(step);
  }
}
const capRow = async () => (await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.find((l) => l.id === 'cap');

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'hotplug-')), extraArgs: ['--test-hooks', '--headless'], env: HEADLESS, timeoutMs: 60000 });
  c = h.client;
});

after(async () => {
  if (!h) return;
  try { await c.call('outputs.stop', {}); } catch { /* not running */ }
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('no device is listed or opened: no device module, the watcher is registered, test source type only with --test-hooks', async () => {
  const info = await c.call('host.info');
  assert.equal(info.flags.allowDevices, false);
  assert.deepEqual(info.deviceModules, { 'win-dshow.dll': false, 'win-wasapi.dll': false });
  assert.ok(info.sourceTypes.includes('ujw_test_capture'));
  assert.ok(!info.sourceTypes.includes('dshow_input'));
  const st = await c.call('host.status');
  assert.equal(st.devices.watcher.watching, true, 'CM_Register_Notification succeeded');
  assert.equal(st.devices.watcher.filters, 6);
});

test('resolve + waiting with fake lists (project.plan): none, two with the same name, other USB path by name, exact path', async () => {
  const d = doc({ withCapture: true });
  await c.call('devices.testSet', { devices: [] });
  let p = await planInHost(c, d);
  assert.equal(p.devicesListed, true);
  assert.deepEqual(p.unavailable, [], 'a missing device no longer makes the layer unavailable');
  assert.equal(p.waiting.length, 1);
  assert.equal(p.waiting[0].layer, 'cap');
  assert.equal(p.waiting[0].reason, 'no connected device matches');
  assert.match(p.waiting[0].message, /^Waiting for capture card "Capture card": it is not connected\. Plug it in/);

  await c.call('devices.testSet', { devices: [card(P2), card(P3)] });
  p = await planInHost(c, d);
  assert.equal(p.waiting[0].reason, 'name matches more than one device', 'two devices with the same name: never a guess');
  assert.match(p.waiting[0].message, /more than one connected device has this name/);

  await c.call('devices.testSet', { devices: [card(P2), card(P3, 'Some other card')] });
  p = await planInHost(c, d);
  assert.deepEqual(p.waiting, []);
  const src = p.sources.find((s) => s.layer === 'cap');
  assert.equal(src.matchedBy, 'name', 'another USB path, matched by the unique name');
  assert.equal(src.obsType, 'ujw_test_capture');

  await c.call('devices.testSet', { devices: [card(P1), card(P2)] });
  p = await planInHost(c, d);
  assert.equal(p.sources.find((s) => s.layer === 'cap').matchedBy, 'deviceId', 'the exact path wins over the name (two named the same)');

  await c.call('devices.testSet', { devices: [{ kind: 'video', error: true }] });
  p = await planInHost(c, d);
  assert.equal(p.waiting[0].reason, 'no connected device matches', 'a failed listing: waiting');
});

test('load with the card unplugged: the project loads, the layer waits, its audio entry binds to it', async () => {
  await c.call('devices.testSet', { devices: [] });
  const r = await loadIntoHost(c, doc({ withCapture: true, withAudio: true }));
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.waiting[0].layer, 'cap');
  const row = await capRow();
  assert.equal(row.device.state, 'waiting');
  assert.match(row.device.message, /Plug it in/);
  assert.equal(row.width, 0, 'no frames');
  assert.ok((await c.call('mixer.list')).sources.some((s) => s.name === 'Card audio'), 'the card audio entry is on the waiting source');
  const st = await c.call('host.status');
  assert.deepEqual(st.devices.waiting.map((w) => w.layer), ['cap']);
  assert.equal(st.devices.connected['dev-card'], false);
  // arrival binds it
  const a = await c.call('devices.testSet', { devices: [card(P1)] });
  assert.deepEqual(a.changes.map((x) => [x.layer, x.action, x.matchedBy]), [['cap', 'bound', 'deviceId']]);
  await until(async () => (await capRow()).width === 64, 'frames from the bound test capture');
  assert.equal((await c.call('host.status')).devices.connected['dev-card'], true);
});

test('add while unplugged, plug in, unplug, re-plug on another port, same-name second card: the recording never stops', { timeout: 120_000 }, async () => {
  await c.call('devices.testSet', { devices: [] });
  await loadIntoHost(c, doc({ withCapture: false }));
  const RUNG = { id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 };
  let conf;
  for (let i = 0; ; i++) { // another agent's soak test may hold the GPU outputs: wait, never fight it
    try {
      conf = await c.call('outputs.configure', { rungs: [RUNG], audio: { bitrate: 128, sampleRate: 48000 },
        sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: 'hotplug.mkv' } }] });
      break;
    } catch (e) {
      if (i >= 20 || !/active|busy/i.test(String(e.message))) throw e;
      await sleep(3000);
    }
  }
  assert.ok(conf);
  await c.call('record.start', {});
  const sinkState = async () => (await c.call('outputs.status')).sinks[0];
  await until(async () => (await sinkState()).state === 'live', 'recording live');
  // Render and encode counters (host.status render, the sink): the canvas video_output counter does not move while the
  // only consumer is a GPU texture encoder, so it cannot show a stall here.
  const counters = async () => { const hs = await c.call('host.status'); const s = await sinkState(); return { renderTotal: hs.render.renderTotal, renderLagged: hs.render.renderLagged, sinkFrames: s.totalFrames, sinkDropped: s.droppedFrames }; };
  const frames0 = await counters();
  const t0 = Date.now();
  const steps = [];
  const live = async (what) => { const s = await sinkState(); assert.equal(s.state, 'live', `recording still live after ${what}`); steps.push([what, s.path]); };

  // 1. add the capture layer with the card unplugged: added, waiting (was: HTTP 502 "no connected device matches")
  const add = await c.call('layers.addFromProject', { project: doc({ withCapture: true }), scene: 'main', layer: 'cap' });
  assert.deepEqual(add.canvases, ['H']);
  assert.match(add.waiting.message, /^Waiting for capture card "Capture card"/);
  assert.equal((await capRow()).device.state, 'waiting');
  await live('add while unplugged');
  await sleep(800);

  // 2. plug it in
  let r = await c.call('devices.testSet', { devices: [card(P1)] });
  assert.deepEqual(r.changes.map((x) => x.action), ['bound']);
  await until(async () => (await capRow()).width === 64, 'frames after plug-in');
  await live('plug in');
  await sleep(800);

  // 3. unplug: waiting again, the last frame is cleared, nothing else changes
  r = await c.call('devices.testSet', { devices: [] });
  assert.deepEqual(r.changes.map((x) => x.action), ['lost']);
  assert.match(r.changes[0].message, /Plug it in/);
  const row = await capRow();
  assert.equal(row.device.state, 'waiting');
  await until(async () => (await capRow()).width === 0, 'cleared frame after unplug');
  await live('unplug');
  await sleep(800);

  // 4. re-plug on another USB port: new instance path, matched by the name
  r = await c.call('devices.testSet', { devices: [card(P2)] });
  assert.deepEqual(r.changes.map((x) => [x.action, x.matchedBy]), [['bound', 'name']]);
  await until(async () => (await capRow()).width === 64, 'frames after re-plug');
  await live('re-plug on another port');

  // 5. a second card with the same name arrives: the working source stays where it is (sticky)
  r = await c.call('devices.testSet', { devices: [card(P2), card(P3)] });
  assert.deepEqual(r.changes, [], 'no change for a bound source whose device is still there');
  assert.equal((await capRow()).device.state, 'connected');
  // 6. its card (P2) leaves; P3 and P1 (the project's own path) share the name: the exact path decides, never the name
  r = await c.call('devices.testSet', { devices: [card(P3), card(P1)] });
  assert.deepEqual(r.changes.map((x) => [x.action, x.matchedBy]), [['bound', 'deviceId']], 'the exact project path is back: bound by deviceId');
  await live('second card and port shuffle');
  assert.equal((await capRow()).device.binds, 3);
  await sleep(1000);

  const st = await c.call('host.status');
  assert.ok(st.devices.seq >= 6);
  const elapsed = (Date.now() - t0) / 1000;
  const frames1 = await counters();
  await c.call('record.stop', {});
  const fin = await until(async () => { const s = await sinkState(); return s.state === 'stopped' && s; }, 'recording stopped', 15_000);
  assert.ok(new Set(steps.map((s) => s[1])).size === 1 && steps[0][1] === fin.path, 'one recording file throughout: the output never restarted');
  assert.ok(existsSync(fin.path));
  const pr = probe(fin.path);
  const v = pr.streams.find((s) => s.type === 'video');
  assert.ok(v.spanSec >= elapsed - 1.5, `video covers the whole run (${v.spanSec.toFixed(1)} s of ${elapsed.toFixed(1)} s)`);
  assert.ok(v.measuredFps > 27 && v.measuredFps < 33, `30 fps kept (${v.measuredFps.toFixed(2)})`);
  const fr = JSON.stringify({ frames0, frames1, elapsed });
  assert.ok(frames1.renderTotal - frames0.renderTotal >= elapsed * 25, `the compositor kept rendering ${fr}`);
  assert.ok(frames1.renderLagged - frames0.renderLagged <= 3, `no render stall ${fr}`);
  assert.ok(frames1.sinkFrames - frames0.sinkFrames >= elapsed * 25, `the encoder kept encoding ${fr}`);
  assert.equal(frames1.sinkDropped - frames0.sinkDropped, 0, `no dropped frames ${fr}`);
  console.log(`hotplug run: ${elapsed.toFixed(1)} s, recording ${v.spanSec.toFixed(1)} s at ${v.measuredFps.toFixed(2)} fps, ${v.packets} packets`);
  await c.call('outputs.clear');
});

test('devices.testSet needs --test-hooks; without --allow-devices nor --test-hooks there is no watcher', async () => {
  const h2 = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'hotplug2-')), extraArgs: ['--headless'], env: HEADLESS, timeoutMs: 60000 });
  try {
    assert.equal((await rpcErr('devices.testSet', { devices: [] }, h2.client)).code, -32001);
    const st = await h2.client.call('host.status');
    assert.equal(st.devices.watcher, null);
    assert.ok(!(await h2.client.call('host.info')).sourceTypes.includes('ujw_test_capture'));
  } finally {
    assert.equal((await stopHost(h2)).code, 0);
  }
});

// Codex review (D329): frames sent by the fake devices (sum over all; one capture layer is loaded in these tests).
const fakeFrames = async () => Object.values((await c.call('devices.testSet', { peek: true })).frames).reduce((a, b) => a + b, 0);
const OTHER = '\\\\?\\usb#vid_0000&pid_0009&mi_00#7&9999&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global';
async function framesFlow(what) {
  const f0 = await fakeFrames();
  await until(async () => (await fakeFrames()) >= f0 + 5, what, 5000);
}

test('a quick unplug and re-plug with the same id inside the watcher debounce reactivates that source; other removals never do', async () => {
  await c.call('devices.testSet', { devices: [card(P1), card(OTHER, 'Other camera')] });
  await loadIntoHost(c, doc({ withCapture: true }));
  await framesFlow('frames after load');
  await until(async () => (await capRow()).device.state === 'connected', 'connected after load');
  const binds0 = (await capRow()).device.binds;

  // another device leaves (and comes back): the working source is left alone
  let r = await c.call('devices.testSet', { devices: [card(P1), card(OTHER, 'Other camera')], removed: [card(OTHER, 'Other camera')] });
  assert.deepEqual(r.changes, [], 'an unrelated removal never reactivates a healthy source');
  assert.equal((await capRow()).device.binds, binds0);
  await framesFlow('frames keep coming');

  // the card leaves and returns with the same id before the debounce ends: its graph died (fake: until reactivated)
  const seq0 = (await c.call('host.status')).devices.seq;
  r = await c.call('devices.testSet', { devices: [card(P1), card(OTHER, 'Other camera')], removed: [card(P1)], viaWatcher: true });
  assert.equal(r.queued, true);
  const fDead = await fakeFrames();
  await until(async () => (await c.call('host.status')).devices.seq > seq0, 'the watcher pass after the debounce', 8000);
  assert.equal((await capRow()).device.binds, binds0 + 1, 'reactivated once (matchedBy reconnect)');
  await until(async () => (await fakeFrames()) >= fDead + 5, 'frames again after the reactivation', 5000);
  await until(async () => (await capRow()).width === 64, 'picture back');
});

test('a bind whose activation delivers no frames is retried with backoff; the layer says "connecting" until a picture comes', { timeout: 60_000 }, async () => {
  await c.call('devices.testSet', { devices: [] });
  await loadIntoHost(c, doc({ withCapture: true }));
  assert.equal((await capRow()).device.state, 'waiting');
  // plugged in while the driver is still starting (or another app holds it): the first two activations fail
  const r = await c.call('devices.testSet', { devices: [{ ...card(P1), fail: 2 }] });
  assert.deepEqual(r.changes.map((x) => x.action), ['bound']);
  let row = await capRow();
  assert.equal(row.device.state, 'connecting');
  assert.equal(row.device.attempt, 1);
  assert.equal(row.width, 0);
  assert.deepEqual((await c.call('host.status')).devices.connecting.map((x) => x.layer), ['cap']);
  // attempt 2 after about 3 s: fails too; the layer says why in plain words
  await until(async () => (await capRow()).device.attempt === 2, 'second attempt', 6000);
  row = await capRow();
  assert.equal(row.device.state, 'connecting');
  assert.match(row.device.message, /^Connecting to capture card "Capture card": no picture yet\. If another app is using it, close that app/);
  // attempt 3 about 6 s later: the picture comes
  await until(async () => (await capRow()).width === 64, 'picture after the third attempt', 12_000);
  await until(async () => (await capRow()).device.state === 'connected', 'connected', 2000);
  const st = await c.call('host.status');
  assert.deepEqual(st.devices.connecting, []);
  assert.equal((await capRow()).device.binds, 1, 'retries are not binds: the same device id');
});
