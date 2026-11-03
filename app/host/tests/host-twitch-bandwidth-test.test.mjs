// SPDX-License-Identifier: GPL-2.0-or-later
// Twitch bandwidth-test mode (--twitch-bandwidth-test), against a real host process WITHOUT --allow-live and loopback
// listeners only (no platform, no network beyond 127.0.0.1):
//   - host.info flags and outputs.status report the mode; only the keyed twitch sink has bandwidthTest true;
//   - a temporary test credential Ujwalam/stream/test-<random> (created and deleted here) reaches the twitch sink's
//     loopback RTMP stream path WITH "?bandwidthtest=true" appended, and the youtube sink's path WITHOUT it (the
//     ffmpeg listeners report the stream name they received);
//   - the stored credential is unchanged afterwards; neither the key nor the suffix is in any RPC response or host log.
// Needs the built host, the OBS runtime, ffmpeg on PATH and Windows (Credential Manager).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { createCredentialStore } from '../../../services/event-core/streamerbot/credential.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CARD = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const REF = `Ujwalam/stream/test-bw-${randomBytes(4).toString('hex')}`;
const KEY = `ujwtest-${randomBytes(16).toString('hex')}`; // throwaway test value, never a real key
const SUFFIX = '?bandwidthtest=true';
const store = createCredentialStore(REF);
const PORT = 19700 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
let dataDir;
const responses = [];

async function call(method, params) {
  try {
    const r = await h.client.call(method, params);
    responses.push(JSON.stringify(r));
    return r;
  } catch (e) {
    responses.push(`${e.code} ${e.message}`);
    throw e;
  }
}
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

// An ffmpeg RTMP listener that expects another stream name, so it prints the one it received.
function listener(port, work, name) {
  const file = path.join(work, `${name}.mkv`);
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/expected-name`,
    '-c', 'copy', '-f', 'matroska', '-y', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const chunks = [];
  ff.stderr.on('data', (d) => chunks.push(d));
  const exit = new Promise((r) => ff.on('exit', r));
  return {
    async stop() {
      try { ff.stdin.write('q'); } catch { /* already gone */ }
      await Promise.race([exit, sleep(10000).then(() => ff.kill())]);
      const text = Buffer.concat(chunks).toString('utf8');
      writeFileSync(path.join(work, `${name}.log`), text);
      return text;
    },
  };
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  assert.equal(await store.get(), null, 'test credential must not exist yet');
  await store.set(KEY);
  dataDir = mkdtempSync(path.join(OUT, 'twitch-bw-'));
  h = await launchHost({ dataDir, project: CARD, extraArgs: ['--twitch-bandwidth-test'] });
});

after(async () => {
  try { if (h) await stopHost(h); } finally { assert.equal(await store.delete(), true, 'test credential deleted'); }
  assert.equal(await store.get(), null);
});

const RUNG = { id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 };
const AUDIO = { bitrate: 128, sampleRate: 48000 };

test('flags: host.info and outputs.status report twitchBandwidthTest true (and allowLive false)', async () => {
  const info = await call('host.info');
  assert.equal(info.flags.twitchBandwidthTest, true);
  assert.equal(info.flags.allowLive, false);
  const st = await call('outputs.status');
  assert.equal(st.twitchBandwidthTest, true);
});

test('loopback keyRef: the twitch sink gets the key plus ?bandwidthtest=true, the youtube sink the key alone; nothing leaks', async () => {
  const work = mkdtempSync(path.join(OUT, 'twitch-bw-media-'));
  const tw = listener(PORT, work, 'twitch');
  const yt = listener(PORT + 1, work, 'youtube');
  await sleep(1200);
  let twText = '';
  let ytText = '';
  try {
    const conf = await call('outputs.configure', {
      rungs: [RUNG], audio: AUDIO,
      sinks: [
        { id: 'tw', rung: 'r', platform: 'twitch', proto: 'rtmp', priority: 1, target: { transport: 'rtmp', port: PORT, app: 'live', keyRef: REF } },
        { id: 'yt', rung: 'r', platform: 'youtube', proto: 'rtmp', priority: 2, target: { transport: 'rtmp', port: PORT + 1, app: 'live', keyRef: REF } },
        { id: 'tws', rung: 'r', platform: 'twitch', proto: 'rtmp', priority: 3, target: { transport: 'rtmp', port: PORT + 2, app: 'live', stream: 'plain' } },
      ],
    });
    const by = (id) => conf.sinks.find((s) => s.id === id);
    assert.equal(by('tw').bandwidthTest, true, 'keyed twitch sink');
    assert.equal(by('yt').bandwidthTest, false, 'not twitch');
    assert.equal(by('tws').bandwidthTest, false, 'no keyRef: nothing to append to');
    assert.equal(by('tw').url, `rtmp://127.0.0.1:${PORT}/live/`, 'status shows no key and no suffix');
    await call('outputs.start', { sinks: ['tw', 'yt'] });
    const live = await until(async () => {
      const st = await call('outputs.status');
      return ['tw', 'yt'].every((id) => st.sinks.find((s) => s.id === id).state === 'live') && st;
    });
    assert.ok(live, 'both keyed sinks live');
    assert.equal(live.sinks.find((s) => s.id === 'tw').bandwidthTest, true);
    for (const k of ['encoderSkippedFrames', 'renderLaggedFrames', 'droppedFrames', 'totalFrames']) {
      assert.equal(typeof live.sinks.find((s) => s.id === 'tw')[k], 'number', `status carries ${k}`);
    }
    await sleep(3000);
    await call('outputs.stop', {});
    await until(async () => (await call('outputs.status')).sinks.every((s) => ['stopped', 'failed', 'idle'].includes(s.state)));
    await call('outputs.clear');
  } finally {
    twText = await tw.stop();
    ytText = await yt.stop();
  }
  assert.ok(twText.includes(`Unexpected stream ${KEY}${SUFFIX},`), 'the twitch listener received the stored key with the bandwidth-test suffix');
  assert.ok(ytText.includes(`Unexpected stream ${KEY},`), 'the youtube listener received the stored key without a suffix');
  assert.equal(await store.get(), KEY, 'the stored credential is unchanged');
  assert.ok(responses.length > 5);
  for (const r of responses) {
    assert.equal(r.includes(KEY), false, 'RPC response carries the key');
    assert.equal(r.includes('bandwidthtest='), false, 'RPC response carries the suffix');
  }
  const logDir = path.join(dataDir, 'logs');
  const logs = readdirSync(logDir).filter((f) => f.endsWith('.log'));
  assert.ok(logs.length >= 1);
  for (const f of logs) {
    const text = readFileSync(path.join(logDir, f), 'utf8');
    assert.ok(text.includes('twitch bandwidth test ON'), 'the host log says the mode is on');
    assert.equal(text.includes(KEY), false, `host log ${f} carries the key`);
    assert.equal(text.includes('bandwidthtest='), false, `host log ${f} carries the suffix`);
  }
});
