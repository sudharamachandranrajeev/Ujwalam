// SPDX-License-Identifier: GPL-3.0-or-later
// LC1 (D333 proposed): the live plan data/outputs/alpha-live.json records H and V while it streams, so the kill
// montages and match reels can be cut after a live stream. Run against a real host started WITH --allow-live (as the
// studio does for a live start) but with every stream target replaced by a 127.0.0.1 RTMP listener (tools/soak
// loopbackPlan): never a real platform, no key. Checks:
//   - the planned params keep three encoders (yt-h, reencode-tk, vert); "record" binds to yt-h and "record-v" to vert
//     (sinks never own encoders), and the host reports the same;
//   - stream.start + record.start run all four streams and both recordings; after stop, ffprobe finds an H .mkv
//     (1920x1080) and a V .mkv (1080x1920), each with H.264 video and one AAC track, with distinct file names
//     (alpha-<stamp>.mkv, alpha-v-<stamp>.mkv), and every listener received a playable stream;
//   - record-clips finishedRecording() turns that outputs.status pair into { h, v }, so the after-stream review job
//     gets --v-recording and --montage (the reels).
// Needs the built host, the OBS runtime, ffmpeg/ffprobe on PATH and Windows. Headless (no preview window).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { probe } from '../lib/ffprobe.mjs';
import { planFile } from '../lib/outputs-plan.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { loopbackPlan } from '../../../tools/soak/stack.mjs';
import { finishedRecording, clipRunSpec } from '../../../services/studio-ui/record-clips.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CARD = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const LIVE = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'outputs', 'alpha-live.json'), 'utf8'));
const BASE = 19700 + Math.floor(Math.random() * 40) * 4;
const PORTS = { 'youtube-h': BASE, 'youtube-v': BASE + 1, twitch: BASE + 2, kick: BASE + 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h; let work;
const listeners = [];

before(async () => {
  mkdirSync(OUT, { recursive: true });
  work = mkdtempSync(path.join(OUT, 'live-plan-record-'));
  h = await launchHost({ dataDir: path.join(work, 'host-data'), project: CARD, extraArgs: ['--allow-live'] });
});

after(async () => {
  for (const l of listeners) if (l.proc.exitCode === null) l.proc.kill();
  if (h) await stopHost(h);
});

function listen(id) {
  const file = path.join(work, `recv-${id}.mkv`);
  const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${PORTS[id]}/live/${id}`,
    '-c', 'copy', '-f', 'matroska', '-y', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const l = { id, file, proc, exit: new Promise((r) => proc.on('exit', r)) };
  listeners.push(l);
  return l;
}

test('live plan on loopback (--allow-live host): H and V recordings beside four streams, three encoders, both ffprobe', async () => {
  const planPath = path.join(work, 'plan.json');
  writeFileSync(planPath, JSON.stringify(loopbackPlan(LIVE, PORTS)));
  const { params, live, dropped } = planFile(planPath);
  assert.deepEqual(live, [], 'loopback only: no real target');
  assert.deepEqual(dropped, []);
  assert.deepEqual(params.rungs.map((r) => r.id), ['yt-h', 'reencode-tk', 'vert'], 'no extra encoder for the V recording');
  const rungOf = Object.fromEntries(params.sinks.map((s) => [s.id, s.rung]));
  assert.equal(rungOf.record, 'yt-h');
  assert.equal(rungOf['record-v'], 'vert');

  assert.equal((await h.client.call('host.info')).flags.allowLive, true, 'host runs as for a live start');
  for (const id of Object.keys(PORTS)) listen(id);
  await sleep(1200);
  const conf = await h.client.call('outputs.configure', params);
  assert.equal(conf.rungs.length, 3);
  await h.client.call('stream.start', {});
  await h.client.call('record.start', {});
  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    st = await h.client.call('outputs.status');
    if (st.sinks.every((s) => s.state === 'live')) break;
    await sleep(250);
  }
  assert.ok(st.sinks.every((s) => s.state === 'live'), `all live: ${st.sinks.map((s) => `${s.id}=${s.state}`).join(', ')}`);
  const during = st;
  await sleep(8000);
  await h.client.call('record.stop', {});
  await h.client.call('stream.stop', {});
  let fin = null;
  for (let i = 0; i < 80; i++) {
    fin = await h.client.call('outputs.status');
    if (fin.sinks.every((s) => ['stopped', 'failed', 'idle'].includes(s.state))) break;
    await sleep(250);
  }
  const rec = (id) => fin.sinks.find((s) => s.id === id);
  const hPath = rec('record').path; const vPath = rec('record-v').path;
  assert.match(path.basename(hPath), /^alpha-\d{8}-\d{6}\.mkv$/);
  assert.match(path.basename(vPath), /^alpha-v-\d{8}-\d{6}\.mkv$/);
  assert.notEqual(hPath, vPath);

  // The after-stream job: finishedRecording gives { h, v } and the review spec asks for the reels.
  const f = finishedRecording(during, fin);
  assert.deepEqual(f, { h: hPath, v: vPath });
  const spec = clipRunSpec({ clipRoot: 'C:\\clip', dataDir: work, job: { type: 'review', h: f.h, v: f.v, name: 'alpha' }, saves: work,
    exists: (p) => p === f.h || p === f.v || p.endsWith('python.exe') || p.endsWith('clipper.py') }).spec;
  assert.ok(spec.argv.includes('--montage') && spec.argv[spec.argv.indexOf('--v-recording') + 1] === f.v, 'the review job makes the reels from the V recording');

  for (const [file, w, hh] of [[hPath, 1920, 1080], [vPath, 1080, 1920]]) {
    assert.ok(existsSync(file), file);
    const p = probe(file);
    const v = p.streams.filter((s) => s.type === 'video');
    const a = p.streams.filter((s) => s.type === 'audio');
    assert.equal(v.length, 1, `${file}: one video stream`);
    assert.equal(v[0].codec, 'h264');
    assert.deepEqual([v[0].width, v[0].height], [w, hh]);
    assert.ok(v[0].packets > 300, `${file}: video packets ${v[0].packets}`);
    assert.equal(a.length, 1, `${file}: one audio stream (audio encoded once)`);
    assert.equal(a[0].codec, 'aac');
  }
  for (const l of listeners) { try { l.proc.stdin.write('q'); } catch { /* gone */ } }
  await Promise.race([Promise.all(listeners.map((l) => l.exit)), sleep(10000)]);
  for (const l of listeners) {
    const p = probe(l.file);
    assert.ok(p.streams.some((s) => s.type === 'video' && s.packets > 120), `${l.id}: the listener received video`);
  }
  writeFileSync(path.join(work, 'result.json'), JSON.stringify({ rungs: conf.rungs.map((r) => r.id), h: path.basename(hPath), v: path.basename(vPath),
    hProbe: probe(hPath).streams.map((s) => [s.type, s.codec, s.width, s.height, s.packets]), vProbe: probe(vPath).streams.map((s) => [s.type, s.codec, s.width, s.height, s.packets]) }, null, 2));
});
