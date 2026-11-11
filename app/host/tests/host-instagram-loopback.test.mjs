// SPDX-License-Identifier: GPL-3.0-or-later
// IG1 (D351): Instagram Live output, loopback only. A real host WITHOUT --allow-live streams the instagram sink to a
// local ffmpeg RTMP listener; ffprobe checks the received stream against data/platforms/instagram.json (resolution,
// fps, video bitrate, keyframe interval, audio). Never touches Instagram. Every limit is read from the platform file.
// The plan is the youtube-1080p60 preset plus the instagram add-on (services/outputs/instagram.mjs), cut down to the
// instagram sink only, with a loopback target in place of the real one. Short run (about 10 s of stream).
// Needs the built host, the OBS runtime and ffmpeg/ffprobe on PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { probe } from '../lib/ffprobe.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { plan } from '../lib/outputs-plan.mjs';
import { addInstagram, loadAddon } from '../../../services/outputs/instagram.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CARD = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const PRESET = path.join(REPO_ROOT, 'data', 'outputs', 'presets', 'youtube-1080p60.json');
const IG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'platforms', 'instagram.json'), 'utf8'));
const PORT = 19700 + Math.floor(Math.random() * 90);
const STREAM_SEC = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'instagram-')), project: CARD });
});
after(async () => { if (h) await stopHost(h); });

/** Host params for the instagram sink alone, on a loopback RTMP target. */
function loopbackParams() {
  const addon = loadAddon();
  const { config, rung, reused } = addInstagram(JSON.parse(readFileSync(PRESET, 'utf8')));
  assert.equal(reused, false, 'the preset V rung (outside the Instagram bitrate range) is not reused');
  const sinks = config.sinks.filter((s) => s.id === addon.sink.id).map((s) => ({ ...s, proto: 'rtmp' }));
  const { params } = plan({ ...config, sinks }, { [addon.sink.id]: { transport: 'rtmp', port: PORT, app: 'live', stream: 'instagram' } });
  assert.equal(params.rungs.length, 1);
  assert.equal(params.rungs[0].id, rung);
  return params;
}

test('instagram sink over loopback RTMP: ffprobe matches data/platforms/instagram.json', async () => {
  const params = loopbackParams();
  const r = params.rungs[0];
  const work = mkdtempSync(path.join(OUT, 'instagram-media-'));
  const file = path.join(work, 'received.mkv');
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', `rtmp://127.0.0.1:${PORT}/live/instagram`,
    '-c', 'copy', '-f', 'matroska', '-y', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const errChunks = [];
  ff.stderr.on('data', (d) => errChunks.push(d));
  const ffExit = new Promise((res) => ff.on('exit', res));
  await sleep(1200);
  try {
    const conf = await h.client.call('outputs.configure', params);
    assert.equal(conf.sinks[0].target, 'loopback');
    await h.client.call('outputs.start', { sinks: ['instagram'] });
    const live = await until(async () => (await h.client.call('outputs.status')).sinks.find((s) => s.id === 'instagram')?.state === 'live');
    assert.ok(live, 'instagram sink live');
    await sleep(STREAM_SEC * 1000);
    await h.client.call('outputs.stop', {});
    await until(async () => (await h.client.call('outputs.status')).sinks.every((s) => ['stopped', 'failed'].includes(s.state)));
    await h.client.call('outputs.clear');
  } finally {
    ff.stdin.write('q');
    await Promise.race([ffExit, sleep(10000).then(() => ff.kill())]);
    writeFileSync(path.join(work, 'listener.log'), Buffer.concat(errChunks).toString('utf8'));
  }

  const p = probe(file);
  const v = p.streams.filter((s) => s.type === 'video');
  const a = p.streams.filter((s) => s.type === 'audio');
  const m = {
    w: v[0]?.width, h: v[0]?.height, fps: Number(v[0]?.measuredFps?.toFixed(2)), kbps: Math.round(v[0]?.measuredKbps ?? 0),
    gopSec: v[0]?.gopSecMedian, keyframes: v[0]?.keyframes, vcodec: v[0]?.codec,
    acodec: a[0]?.codec, sampleRate: a[0]?.sampleRate, channels: a[0]?.channels, akbps: Math.round(a[0]?.measuredKbps ?? 0)
  };
  console.log(`# instagram loopback ffprobe: ${JSON.stringify(m)} (rung ${r.w}x${r.h}@${r.fps} ${r.bitrate} kbps gop ${r.gopSec}s, audio ${params.audio.bitrate} kbps ${params.audio.sampleRate} Hz)`);

  // Video: one H.264 track, portrait, inside the recommended size.
  assert.equal(v.length, 1);
  assert.ok(IG.videoCodecs.value.includes(m.vcodec), `video codec ${m.vcodec}`);
  assert.equal(IG.portrait.value, true);
  assert.ok(m.h > m.w, `portrait ${m.w}x${m.h}`);
  assert.ok(Math.max(m.w, m.h) <= IG.maxWidth.value && Math.min(m.w, m.h) <= IG.maxHeight.value, `size ${m.w}x${m.h}`);
  assert.deepEqual([m.w, m.h], [r.w, r.h]);
  // Frame rate: the rung's, at most the platform maximum (5% slack for a short capture).
  assert.ok(r.fps <= IG.maxFps.value);
  assert.ok(m.fps <= IG.maxFps.value * 1.05 && m.fps >= r.fps * 0.9, `fps ${m.fps}`);
  // Bitrate: the rung is inside the platform range; the measured stream follows it (CBR, short capture: 35% slack).
  const { min, max } = IG.videoBitrateKbps;
  assert.ok(r.bitrate >= min.value && r.bitrate <= max.value, `rung bitrate ${r.bitrate}`);
  assert.ok(m.kbps >= r.bitrate * 0.65 && m.kbps <= max.value * 1.1, `measured video bitrate ${m.kbps} kbps`);
  // Keyframes: at most the platform's interval.
  assert.ok(m.keyframes >= 3, `keyframes ${m.keyframes}`);
  assert.ok(m.gopSec <= IG.keyframeIntervalSec.max.value + 0.05, `keyframe interval ${m.gopSec} s`);
  // Audio: one AAC stereo track, the plan's one shared track (sample rate as encoded once), within the bitrate cap.
  assert.equal(a.length, IG.audioTracksMax.value);
  assert.ok(IG.audioCodecs.value.includes(m.acodec), `audio codec ${m.acodec}`);
  assert.equal(m.channels, 2);
  assert.equal(m.sampleRate, params.audio.sampleRate);
  assert.ok(params.audio.bitrate <= IG.audioBitrateKbps.max.value);
  assert.ok(m.akbps <= IG.audioBitrateKbps.max.value * 1.1, `measured audio bitrate ${m.akbps} kbps`);
});
