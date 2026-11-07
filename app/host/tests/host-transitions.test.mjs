// SPDX-License-Identifier: GPL-3.0-or-later
// Scene transitions (D239): per canvas cut or fade. transitions.set / transitions.get / host.status.transitions, and a
// recorded H canvas proving the fade: white -> black over 1000 ms gives a run of in-between frames, a cut gives none.
//   node --test app/host/tests/host-transitions.test.mjs   (needs the built host and the OBS runtime)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;
let c;

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'data-')), project: path.join(HOST_DIR, 'projects', 'test-card.project.json'), extraArgs: ['--headless'] });
  c = h.client;
});

after(async () => { if (h) await stopHost(h); });

async function code(method, params) {
  try { await c.call(method, params); } catch (e) { return e.code; }
  return null;
}

test('transitions: cut by default; set fade per canvas; bad values refused; host.status reports them', async () => {
  const t0 = await c.call('transitions.get');
  assert.deepEqual(t0.H, { type: 'cut', durationMs: 0, available: true });
  assert.equal(t0.V.type, 'cut');
  const r = await c.call('transitions.set', { canvas: 'v', type: 'fade', durationMs: 1000 });
  assert.deepEqual(r.V, { type: 'fade', durationMs: 1000, available: true });
  assert.equal(r.H.type, 'cut', 'per canvas');
  assert.deepEqual((await c.call('host.status')).transitions.V, { type: 'fade', durationMs: 1000, available: true });
  assert.equal(await code('transitions.set', { canvas: 'H', type: 'wipe', durationMs: 300 }), -32602);
  assert.equal(await code('transitions.set', { canvas: 'H', type: 'fade', durationMs: 20000 }), -32602);
  assert.equal(await code('transitions.set', { canvas: 'X', type: 'fade', durationMs: 300 }), -32602);
  await c.call('transitions.set', { canvas: 'V', type: 'cut', durationMs: 0 });
});

function yavg(file) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  assert.equal(r.status, 0, r.stderr);
  return [...r.stdout.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
}

test('a fade blends the scenes over its duration on the recorded canvas; a cut does not', async () => {
  for (const [id, color] of [['tr-white', '#FFFFFFFF'], ['tr-black', '#FF000000']])
    await c.call('scenes.create', { scene: { id, canvas: 'H', name: id, layers: [{ id: 'bg', type: 'color', settings: { color } }] } });
  await c.call('scenes.activate', { scene: 'tr-white' });
  await c.call('outputs.configure', {
    rungs: [{ id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: 'transitions.mkv' } }],
  });
  await c.call('record.start', {});
  let st;
  for (let i = 0; i < 40; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'live') break; await sleep(100); }
  await sleep(700);
  await c.call('transitions.set', { canvas: 'H', type: 'fade', durationMs: 1000 });
  await c.call('scenes.activate', { scene: 'tr-black' }); // fade white -> black
  await sleep(1700);
  await c.call('transitions.set', { canvas: 'H', type: 'cut', durationMs: 0 });
  await c.call('scenes.activate', { scene: 'tr-white' }); // cut black -> white
  await sleep(700);
  await c.call('record.stop', {});
  for (let i = 0; i < 50; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'stopped') break; await sleep(100); }
  await c.call('outputs.clear');
  const y = yavg(st.sinks[0].path);
  const mid = y.map((v) => v > 40 && v < 200);
  const runs = [];
  for (let i = 0; i < mid.length; i++) if (mid[i]) { if (i > 0 && mid[i - 1]) runs[runs.length - 1]++; else runs.push(1); }
  console.log(`transitions: ${y.length} frames, in-between runs ${JSON.stringify(runs)}`);
  assert.ok(y[0] > 200 && y.at(-1) > 200, 'starts and ends white');
  assert.ok(y.some((v) => v < 40), 'black in between');
  const long = runs.filter((n) => n >= 20);
  assert.equal(long.length, 1, 'one fade of about 30 frames (1000 ms at 30 fps)');
  assert.ok(long[0] <= 34, `fade length ${long[0]} frames`);
  assert.ok(runs.filter((n) => n < 20).every((n) => n <= 2), 'the cut has at most an encoder blend frame or two');
});
