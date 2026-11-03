// SPDX-License-Identifier: GPL-2.0-or-later
// A0 real outputs, against a real host process WITHOUT --allow-live (CI never uses it) and loopback listeners only:
//   - real (non-loopback) targets are refused (FORBIDDEN) and malformed ones are invalid; no key field exists;
//   - recordings are .mkv unless unsafeContainer; a host-killed .mkv still probes;
//   - the host reads a stream key from Windows Credential Manager by keyRef, in-process: a temporary test credential
//     Ujwalam/stream/test-<random> (created and deleted here via services/event-core/streamerbot/credential.mjs) reaches
//     the loopback RTMP stream path (the ffmpeg listener reports the stream name it received), ffprobe checks the
//     received file, and the key string appears in no RPC response, no host log line and no host stdout/stderr;
//   - a missing key fails the start with a message that names the target, never a value.
// Needs the built host, the OBS runtime, ffmpeg/ffprobe on PATH and Windows (Credential Manager).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { probe } from '../lib/ffprobe.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { createCredentialStore } from '../../../services/event-core/streamerbot/credential.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CARD = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const REF = `Ujwalam/stream/test-${randomBytes(4).toString('hex')}`;
const MISSING = `Ujwalam/stream/test-missing-${randomBytes(4).toString('hex')}`;
const KEY = `ujwtest-${randomBytes(16).toString('hex')}`; // throwaway test value, never a real key
const store = createCredentialStore(REF);
const PORT = 19600 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
let dataDir;
const responses = []; // every RPC result and error text seen by this test

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
async function rpcErr(method, params) {
  try { await call(method, params); } catch (e) { return e; }
  assert.fail(`${method} should have failed`);
}
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  assert.equal(await store.get(), null, 'test credential must not exist yet');
  await store.set(KEY);
  dataDir = mkdtempSync(path.join(OUT, 'live-keys-'));
  h = await launchHost({ dataDir, project: CARD });
});

after(async () => {
  try { if (h) await stopHost(h); } finally { assert.equal(await store.delete(), true, 'test credential deleted'); }
  assert.equal(await store.get(), null);
});

const RUNG = { id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 };
const AUDIO = { bitrate: 128, sampleRate: 48000 };
const sink = (id, target, extra = {}) => ({ id, rung: 'r', platform: 'youtube', proto: 'rtmps', priority: 1, target, ...extra });

test('host.info and outputs.status report allowLive false (no --allow-live)', async () => {
  assert.equal((await call('host.info')).flags.allowLive, false);
  assert.equal((await call('outputs.status')).allowLive, false);
});

test('real targets are refused without --allow-live; malformed real targets are invalid; there is no key field', async () => {
  const live = [
    { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com:443/live2', keyRef: REF },
    { transport: 'rtmps', urlRef: 'Ujwalam/stream/kick-server', keyRef: REF }
  ];
  for (const t of live) {
    const e = await rpcErr('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [sink('yt', t)] });
    assert.equal(e.code, -32001, JSON.stringify(t));
    assert.match(e.message, /--allow-live/);
  }
  const bad = [
    { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com/live2' }, // no keyRef
    { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com/live2', keyRef: REF, key: 'x' }, // a key field
    { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com/live2?k=1', keyRef: REF }, // query
    { transport: 'rtmps', url: 'rtmps://user:pw@a.rtmps.youtube.com/live2', keyRef: REF }, // userinfo
    { transport: 'rtmps', url: 'rtmps://127.0.0.1:1935/live', keyRef: REF }, // IP literal: loopback has its own form
    { transport: 'rtmps', url: 'rtmp://a.rtmp.youtube.com/live2', keyRef: REF }, // scheme != transport
    { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com/live2', keyRef: 'Ujwalam/streamerbot' }, // bad ref
    { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com/live2', urlRef: 'Ujwalam/stream/a', keyRef: REF }, // both
    { transport: 'rtmps', port: 19400 } // rtmps is never loopback
  ];
  for (const t of bad) {
    const e = await rpcErr('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [sink('yt', t)] });
    assert.equal(e.code, -32602, JSON.stringify(t));
  }
  const pm = await rpcErr('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [sink('yt', { transport: 'rtmp', url: 'rtmp://a.rtmp.youtube.com/live2', keyRef: REF }, { proto: 'rtmps' })] });
  assert.equal(pm.code, -32602, 'proto must equal the real transport');
});

test('recordings: .mkv by default, other containers only with unsafeContainer (error says why)', async () => {
  const rec = (target) => ({ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target });
  const e = await rpcErr('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [rec({ transport: 'file', name: 'a.mp4' })] });
  assert.equal(e.code, -32602);
  assert.match(e.message, /not crash-safe/);
  assert.equal((await rpcErr('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [rec({ transport: 'file', name: 'a.mp4', unsafeContainer: 'yes' })] })).code, -32602);
  const ok = await call('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [rec({ transport: 'file', name: 'a.mp4', unsafeContainer: true })] });
  assert.equal(ok.sinks[0].container, 'mp4');
  await call('outputs.clear');
});

test('loopback keyRef: the stored key reaches the RTMP stream path, ffprobe passes, the key is in no RPC response or log', async () => {
  const work = mkdtempSync(path.join(OUT, 'live-keys-media-'));
  const file = path.join(work, 'received.mkv');
  const ffLog = path.join(work, 'listener.log');
  // The listener expects a different stream name; ffmpeg reports the one it received ("Unexpected stream <name>").
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', `rtmp://127.0.0.1:${PORT}/live/expected-name`,
    '-c', 'copy', '-f', 'matroska', '-y', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const errChunks = [];
  ff.stderr.on('data', (d) => errChunks.push(d));
  const ffExit = new Promise((r) => ff.on('exit', r));
  await sleep(1200);
  try {
    const conf = await call('outputs.configure', {
      rungs: [RUNG], audio: AUDIO,
      sinks: [
        { id: 'keyed', rung: 'r', platform: 'twitch', proto: 'rtmp', priority: 1, target: { transport: 'rtmp', port: PORT, app: 'live', keyRef: REF } },
        { id: 'nokey', rung: 'r', platform: 'kick', proto: 'rtmp', priority: 2, target: { transport: 'rtmp', port: PORT + 1, app: 'live', keyRef: MISSING } },
        { id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 3, target: { transport: 'file', name: 'keyed.mkv' } }
      ]
    });
    const keyed = conf.sinks.find((s) => s.id === 'keyed');
    assert.equal(keyed.target, 'loopback');
    assert.equal(keyed.keyRef, REF);
    assert.equal(keyed.keyPresent, true);
    assert.equal(keyed.bandwidthTest, false, 'a twitch sink without --twitch-bandwidth-test gets the key unchanged');
    assert.equal(keyed.url, `rtmp://127.0.0.1:${PORT}/live/`);
    assert.equal(conf.sinks.find((s) => s.id === 'nokey').keyPresent, false);
    assert.ok(conf.warnings.some((w) => w.includes(MISSING)), 'configure warns about the missing key by target name');
    assert.equal(conf.rungs.length, 1, 'recording binds to the stream rung (one encoder)');

    await call('outputs.start', { sinks: ['keyed', 'rec'] });
    const live = await until(async () => {
      const st = await call('outputs.status');
      return ['keyed', 'rec'].every((id) => st.sinks.find((s) => s.id === id).state === 'live') && st;
    });
    assert.ok(live, 'keyed sink and recording live');
    await sleep(4000);
    await call('outputs.start', { sinks: ['nokey'] });
    const failed = await until(async () => {
      const s = (await call('outputs.status')).sinks.find((x) => x.id === 'nokey');
      return s.state === 'failed' && s;
    }, 5000);
    assert.ok(failed, 'missing key: start fails (not retried)');
    assert.match(failed.lastError, new RegExp(`no usable stream key in Windows Credential Manager target ${MISSING.replaceAll('/', '\\/')}`));
    assert.match(failed.lastError, /credential set --target/);
    await call('outputs.stop', {});
    await until(async () => (await call('outputs.status')).sinks.every((s) => ['stopped', 'failed'].includes(s.state)));
    const fin = await call('outputs.status');
    assert.equal(fin.sinks.find((s) => s.id === 'keyed').state, 'stopped');
    const recPath = fin.sinks.find((s) => s.id === 'rec').path;
    await call('outputs.clear');

    ff.stdin.write('q');
    await Promise.race([ffExit, sleep(10000).then(() => ff.kill())]);
    const ffText = Buffer.concat(errChunks).toString('utf8');
    writeFileSync(ffLog, ffText);
    assert.ok(ffText.includes(`Unexpected stream ${KEY},`), 'the listener received the stored key as the stream name');

    const p = probe(file);
    const v = p.streams.filter((s) => s.type === 'video');
    const a = p.streams.filter((s) => s.type === 'audio');
    assert.equal(v.length, 1);
    assert.equal(v[0].codec, 'h264');
    assert.deepEqual([v[0].width, v[0].height], [640, 360]);
    assert.ok(v[0].packets > 60, `video packets ${v[0].packets}`);
    assert.equal(a.length, 1);
    assert.equal(a[0].codec, 'aac');
    const r = probe(recPath);
    assert.equal(path.extname(recPath), '.mkv');
    assert.ok(r.streams.some((s) => s.type === 'video' && s.packets > 60), 'recording has video');

    // The key in no RPC response, no host log line, no host stdout/stderr.
    assert.ok(responses.length > 10);
    for (const r2 of responses) assert.equal(r2.includes(KEY), false, 'RPC response carries the key');
    const logDir = path.join(dataDir, 'logs');
    const logs = readdirSync(logDir).filter((f) => f.endsWith('.log'));
    assert.ok(logs.length >= 1);
    for (const f of logs) {
      const text = readFileSync(path.join(logDir, f), 'utf8');
      assert.ok(text.includes('Connecting to RTMP URL'), 'the host log covers the connect');
      assert.equal(text.includes(KEY), false, `host log ${f} carries the key`);
    }
    assert.equal(h.log.join('').includes(KEY), false, 'host stdout/stderr carries the key');
  } finally {
    if (ff.exitCode === null) ff.kill();
    rmSync(ffLog, { force: true }); // it names the throwaway test key; the assertion above already ran
  }
});

test('crash safety: a recording .mkv still probes after the host is killed mid-recording', async () => {
  const dd = mkdtempSync(path.join(OUT, 'live-keys-crash-'));
  const k = await launchHost({ dataDir: dd, project: CARD });
  let killed = false;
  try {
    await k.client.call('outputs.configure', { rungs: [RUNG], audio: AUDIO, sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: 'crash.mkv' } }] });
    await k.client.call('record.start', {});
    let st;
    for (let i = 0; i < 50; i++) { st = await k.client.call('outputs.status'); if (st.sinks[0].state === 'live') break; await sleep(100); }
    assert.equal(st.sinks[0].state, 'live');
    await sleep(5000);
    const recPath = st.sinks[0].path;
    k.child.kill(); // TerminateProcess: no stop, no muxer finalisation by the host
    killed = true;
    await Promise.race([k.exit, sleep(10000)]);
    await sleep(1500); // the mux helper notices the closed pipe and exits
    assert.ok(existsSync(recPath));
    const p = probe(recPath);
    const v = p.streams.find((s) => s.type === 'video');
    assert.ok(v && v.packets >= 60, `video packets after kill: ${v?.packets}`);
    assert.ok(p.streams.some((s) => s.type === 'audio' && s.packets > 0), 'audio after kill');
  } finally {
    if (!killed) await stopHost(k);
  }
});
