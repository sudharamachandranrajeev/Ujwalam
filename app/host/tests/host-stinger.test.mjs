// SPDX-License-Identifier: GPL-3.0-or-later
// Stinger transitions (D242): transitions.set type stinger plays a video (pathRef under a load base) over the scene
// switch; the scene changes pointMs into it. A recorded H canvas shows white, then the red stinger for about its own
// length, then black. A file outside the base, a missing file or a bad extension is refused; back to cut releases it.
//   node --test app/host/tests/host-stinger.test.mjs   (needs the built host, the OBS runtime and ffmpeg)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;
let c;
let media;

const full = { visible: true, x: 0, y: 0, width: 640, height: 360 };
const PROJECT = {
  version: 1, id: 'stinger', name: 'Stinger', activeScene: 'white',
  canvases: [{ id: 'h', width: 640, height: 360, fps: 30 }],
  devices: [], overlays: [], outputs: [],
  scenes: [
    { id: 'white', name: 'White', layers: [{ id: 'w', type: 'color', name: 'W', source: { color: '#ffffff' }, placements: { h: full } }] },
    { id: 'black', name: 'Black', layers: [{ id: 'k', type: 'color', name: 'K', source: { color: '#000000' }, placements: { h: full } }] },
  ],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
};

before(async () => {
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'stinger-media-'));
  // 1 s of solid red at 30 fps with a 1 kHz tone (VP8/Opus WebM, as stingers usually are): the stinger
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1',
    '-t', '1', '-c:v', 'libvpx', '-b:v', '500k', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-ac', '2', '-shortest', path.join(media, 'sting.webm')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(path.join(media, 'notes.txt'), 'not a video');
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'stinger-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' } });
  c = h.client;
  await loadIntoHost(c, PROJECT, { bases: { media } });
});

after(async () => { if (h) await stopHost(h); });

async function code(params) {
  try { await c.call('transitions.set', params); } catch (e) { return e.code; }
  return null;
}

test('stinger: set, reported; refused for a missing file, a path outside the base, a bad extension, no file', async () => {
  const r = await c.call('transitions.set', { canvas: 'H', type: 'stinger', file: { base: 'media', rel: 'sting.webm' }, pointMs: 500 });
  assert.deepEqual(r.H, { type: 'stinger', durationMs: 0, file: 'media:sting.webm', pointMs: 500, audio: true, available: true });
  assert.equal(await code({ canvas: 'H', type: 'stinger', file: { base: 'media', rel: 'gone.mp4' }, pointMs: 500 }), -32004);
  assert.equal(await code({ canvas: 'H', type: 'stinger', file: { base: 'media', rel: '../x.mp4' }, pointMs: 500 }), -32602);
  assert.equal(await code({ canvas: 'H', type: 'stinger', file: { base: 'media', rel: 'notes.txt' }, pointMs: 500 }), -32602);
  assert.equal(await code({ canvas: 'H', type: 'stinger', pointMs: 500 }), -32602);
  assert.equal(await code({ canvas: 'H', type: 'stinger', file: { base: 'profile', rel: 'sting.webm' }, pointMs: 500 }), -32004, 'base not given at load');
  assert.equal((await c.call('transitions.get')).H.type, 'stinger', 'refusals left it as it was');
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
});

function stats(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-vf', 'signalstats,metadata=mode=print:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const frames = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /lavfi\.signalstats\.(YAVG|VAVG)=([0-9.]+)/.exec(line);
    if (!m) continue;
    if (m[1] === 'YAVG') frames.push({ y: Number(m[2]) }); else if (frames.length) frames.at(-1).v = Number(m[2]);
  }
  return frames;
}

// Records white, switches to black under the stinger, stops; returns the file.
async function recordSwitch(name, audio) {
  await c.call('scenes.activate', { scene: 'white' });
  await c.call('outputs.configure', {
    rungs: [{ id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name } }],
  });
  await c.call('transitions.set', { canvas: 'H', type: 'stinger', file: { base: 'media', rel: 'sting.webm' }, pointMs: 500, audio });
  await c.call('record.start', {});
  let st;
  for (let i = 0; i < 40; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'live') break; await sleep(100); }
  await sleep(700);
  await c.call('scenes.activate', { scene: 'black' });
  await sleep(2000);
  await c.call('record.stop', {});
  for (let i = 0; i < 50; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'stopped') break; await sleep(100); }
  await c.call('outputs.clear');
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  return st.sinks[0].path;
}

// Loudest 100 ms RMS level (dBFS) of the recording's audio; -Infinity when silent.
function loudest(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-af', 'asetnsamples=4800,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const lv = [...r.stdout.matchAll(/RMS_level=(-?inf|-?[0-9.]+)/g)].map((m) => (m[1].endsWith('inf') ? -Infinity : Number(m[1])));
  assert.ok(lv.length > 10, 'audio levels read');
  return Math.max(...lv);
}

test('a stinger plays over the switch on the recorded canvas: white, red for about 1 s, black; its tone is in the mix', async () => {
  const f = stats(await recordSwitch('stinger.mkv', true));
  const red = f.map((x) => x.v > 200); // red: V (Cr) far above neutral 128
  const runs = [];
  for (let i = 0; i < red.length; i++) if (red[i]) { if (i > 0 && red[i - 1]) runs[runs.length - 1]++; else runs.push(1); }
  console.log(`stinger: ${f.length} frames, red runs ${JSON.stringify(runs)}`);
  assert.ok(f[0].y > 200, 'starts white');
  assert.ok(f.at(-1).y < 40, 'ends black');
  assert.equal(runs.length, 1, 'one stinger');
  assert.ok(runs[0] >= 24 && runs[0] <= 34, `stinger length ${runs[0]} frames (1 s at 30 fps)`);
  assert.equal((await c.call('transitions.get')).H.type, 'cut');
});

test('stinger audio (D244): on, its tone is in the recording; off, the video plays silent', async () => {
  const on = loudest(await recordSwitch('stinger-on.mkv', true));
  const off = loudest(await recordSwitch('stinger-off.mkv', false));
  console.log(`stinger audio: loudest on ${on.toFixed(1)} dBFS, off ${off} dBFS`);
  assert.ok(on > -40, `tone heard with audio on (${on} dBFS)`);
  assert.ok(off < -70, `silent with audio off (${off} dBFS)`);
});
