// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: face AI cost next to an NVENC recording (D295 proposed). Opt-in: loads GPU and encoder for ~4 min.
//   UJWALAM_FACE_BENCH=1 [UJWALAM_FACE_PYTHON=...\.venv-gpu\Scripts\python.exe] node --test --test-timeout=900000 app/host/tests/host-face-bench.test.mjs
// No camera: the "camera" is a looping 1280x720 test video. Never run while the user streams or records.
//   1. host render cost and GPU load: idle, then with a 1080p60 NVENC CBR 17 Mbps recording (YouTube-like)
//   2. + the real face worker (services/face/face_worker.py, flag face-ai on in a temporary data dir only) serving
//      personMask (blur) + autoFrame on that video: host frame time, worker infer ms, end-to-end latency (frame
//      render to result in the host), results per second, device VRAM (nvidia-smi)
//   3. per-model bench (tools/bench/face_ai_bench.py, 720p and 1080p input) while the recording runs
// Prints markdown tables for docs/evidence/2026-11-08-face-ai.md and writes out/host/tests/face-bench.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const RUN = process.env.UJWALAM_FACE_BENCH === '1';
const PY = process.env.UJWALAM_FACE_PYTHON || path.join(REPO_ROOT, '.venv-gpu', 'Scripts', 'python.exe');
const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const SAMPLE_MS = 10000;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let h;
let c;
let media;
let recDir;

function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

function smi() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu,utilization.encoder', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const [mem, gpu, enc] = r.stdout.trim().split(',').map((x) => Number(x.trim()));
  return { mem, gpu, enc };
}

before(async () => {
  if (!RUN) return;
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'facebench-media-'));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '10', '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', path.join(media, 'cam.mp4')]);
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'data-')), project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
  c = h.client;
});

after(async () => {
  if (!h) return;
  try { await c.call('record.stop', {}); } catch { /* not recording */ }
  try { await c.call('outputs.clear'); } catch { /* none */ }
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
  if (recDir) rmSync(recDir, { recursive: true, force: true });
});

const DOC = {
  version: 1, id: 'face-bench', name: 'Face bench', activeScene: 'main',
  canvases: [{ id: 'h', width: 1920, height: 1080, fps: 60 }], devices: [], overlays: [], outputs: [],
  scenes: [{ id: 'main', name: 'Main', layers: [
    { id: 'bg', type: 'color', name: 'Bg', source: { color: '#203040' }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } },
    { id: 'cam', type: 'media', name: 'Cam', source: { file: { base: 'media', rel: 'cam.mp4' }, loop: true },
      effects: [{ type: 'personMask', mode: 'blur', threshold: 0.5, feather: 0.2, smoothing: 0.4, strength: 24 }],
      placements: { h: { visible: true, x: 0, y: 0, width: 1280, height: 720 } } },
    { id: 'cam-af', type: 'duplicate', name: 'Cam frame', source: { layer: 'cam' },
      effects: [{ type: 'autoFrame', zoom: 1.6, smoothing: 0.5, deadzone: 0.1 }],
      placements: { h: { visible: true, x: 1280, y: 0, width: 640, height: 360 } } }
  ] }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
};

async function sample(ms) {
  const ft = [], gpu = [], enc = [], mem = [];
  const f0 = await c.call('face.status');
  const r0 = (await c.call('host.status')).render;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await c.call('host.status');
    ft.push(s.render.avgFrameTimeMs);
    const g = smi();
    if (g) { gpu.push(g.gpu); enc.push(g.enc); mem.push(g.mem); }
    await sleep(500);
  }
  const f1 = await c.call('face.status');
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r1 = (await c.call('host.status')).render;
  return {
    frameMs: avg(ft), gpuPct: avg(gpu), encPct: avg(enc), vramMb: avg(mem),
    resultsPerSec: (f1.results - f0.results) / ((Date.now() - t0) / 1000),
    inferMs: f1.inferMs, latencyMs: f1.latencyMs, workerAlive: f1.workerAlive,
    fps: r1.fps, lagged: r1.renderLagged - r0.renderLagged, rendered: r1.renderTotal - r0.renderTotal,
    encSkipped: r1.encodeSkipped - r0.encodeSkipped, encoded: r1.encodeTotal - r0.encodeTotal
  };
}

test('face AI next to a 1080p60 NVENC recording', { skip: !RUN && 'set UJWALAM_FACE_BENCH=1' }, async () => {
  assert.ok(existsSync(PY), `face Python missing: ${PY}`);
  const r = await loadIntoHost(c, DOC, { bases: { media } });
  assert.deepEqual(r.unavailable, []);
  const rows = {};
  await sleep(2000);
  rows.idle = await sample(SAMPLE_MS);
  recDir = mkdtempSync(path.join(OUT, 'facebench-rec-'));
  await c.call('outputs.configure', {
    rungs: [{ id: 'rh', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1920, h: 1080, fps: 60, bitrate: 17000, gopSec: 2 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'fh', rung: 'rh', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: 'facebench.mkv' } }]
  });
  await c.call('record.start', {});
  await sleep(3000);
  rows.recording = await sample(SAMPLE_MS);

  const data = mkdtempSync(path.join(OUT, 'facebench-data-'));
  writeFileSync(path.join(data, 'flags.local.json'), JSON.stringify({ flags: { 'face-ai': true } }));
  const worker = spawn(PY, ['-I', path.join(REPO_ROOT, 'services', 'face', 'face_worker.py'), '--data-dir', data, '--host-pid', String(h.child.pid)],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let wlog = '';
  worker.stderr.on('data', (d) => { wlog += d; });
  try {
    await sleep(10000); // flag read, models load, warm up
    rows.recordingFace = await sample(SAMPLE_MS);
  } finally {
    worker.kill();
  }
  await sleep(2500);
  rows.afterWorker = await sample(4000);
  console.log(wlog.split('\n').slice(-8).join('\n'));

  // per-model bench while the recording runs
  const bench = spawnSync(PY, ['-I', path.join(REPO_ROOT, 'tools', 'bench', 'face_ai_bench.py'), '--seconds', '10', '--json', path.join(OUT, 'face-bench-models.json')],
    { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  const models = bench.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const st = await c.call('outputs.status');
  await c.call('record.stop', {});
  await sleep(1500);
  await c.call('outputs.clear');

  const f = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '-');
  console.log('\n| phase | host frame ms | fps | lagged/rendered | enc skipped/encoded | GPU % | NVENC % | VRAM used MB | results/s | infer ms | latency ms |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(rows)) {
    console.log(`| ${k} | ${f(v.frameMs, 3)} | ${f(v.fps, 1)} | ${v.lagged}/${v.rendered} | ${v.encSkipped}/${v.encoded} | ${f(v.gpuPct, 0)} | ${f(v.encPct, 0)} | ${f(v.vramMb, 0)} | ${f(v.resultsPerSec, 1)} | ${f(v.inferMs)} | ${f(v.latencyMs, 1)} |`);
  }
  console.log('\nmodels (recording running):');
  for (const m of models) console.log(JSON.stringify(m));
  writeFileSync(path.join(OUT, 'face-bench.json'), JSON.stringify({ rows, models, outputs: st }, null, 2));
  assert.equal(rows.recordingFace.workerAlive, true, `worker alive: ${wlog}`);
  assert.ok(rows.recordingFace.resultsPerSec > 10, `worker keeps up: ${rows.recordingFace.resultsPerSec}/s`);
  assert.equal(bench.status, 0, bench.stderr);
});
