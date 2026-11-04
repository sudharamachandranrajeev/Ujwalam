// SPDX-License-Identifier: GPL-3.0-or-later
// Diagnostics bundle (tools/diag/bundle.mjs, redact.mjs): the zip holds the expected files, and no key, token, URL,
// chat text, profile value, user name or home path survives in any of them. All secrets here are random values made
// by the test, and the home dir is a made-up folder, so nothing real is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiag, main as diagMain, outputsSafe } from '../tools/diag/bundle.mjs';
import { makeRedactor } from '../tools/diag/redact.mjs';
import { extractEntry, readZip } from '../tools/package/zip.mjs';

const word = (n) => [...randomBytes(n)].map((b) => 'bcdfghjklmnpqrstvwxz'[b % 20]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function secrets() {
  const home = path.join('D:\\', 'Profiles', `diag${word(5)}`);
  const userName = path.basename(home);
  const brand = cap(word(7));
  const ign = `${cap(word(4))}${word(4)}`;
  return {
    home, userName, brand, ign,
    profile: { streamer: { name: brand, variants: [`${brand.toLowerCase()}tv`] }, games: { codm: { ign } }, paths: { clips_corpus: path.join(home, 'Videos', 'corpus') }, channels: { twitch: '<twitch-channel>' } },
    hex: randomBytes(32).toString('hex'),
    twitchKey: `live_${100000 + (randomBytes(2).readUInt16LE(0))}_${randomBytes(15).toString('base64url').replace(/[-_]/g, 'a')}`,
    ytKey: [0, 1, 2, 3, 4].map(() => word(4)).join('-'),
    kickKey: `sk_${word(12)}`,
    blob: randomBytes(45).toString('base64'),
    chat: `${word(6)} ${word(5)} ${word(7)}`,
  };
}

test('redactor: home dir in every spelling, user name, profile terms and separator variants, URLs, secrets, chat fields', () => {
  const s = secrets();
  const red = makeRedactor({ home: s.home, userName: s.userName, profile: s.profile });
  const fwd = s.home.replace(/\\/g, '/');
  const json = JSON.stringify({ path: path.join(s.home, 'x.log') });
  const text = [
    `opened ${s.home}\\AppData\\Local\\Ujwalam\\data and ${fwd.toUpperCase()}/AppData`, json,
    `user ${s.userName} logged`, `brand ${s.brand} and ${s.brand.toUpperCase()} and ${s.brand.split('').join('.')} and ign ${s.ign}`,
    `corpus ${s.profile.paths.clips_corpus}`, `placeholder <twitch-channel> stays`,
    `rtmps://a.rtmps.youtube.com:443/live2/${s.ytKey} and rtmp://ingest.example/app/${s.twitchKey}`,
    `http://127.0.0.1:5000/login?k=${s.hex}`, `Authorization: Bearer ${s.hex}`, `"token":"${s.hex}"`, `streamKey=${s.kickKey}`,
    `blob ${s.blob}`, `{"text":"${s.chat}","displayName":"${s.ign}x","hotkey":"Ctrl+Alt+F","keyPresent":true}`,
  ].join('\n');
  const out = red(text);
  for (const bad of [s.home, fwd, fwd.toUpperCase(), s.userName, s.brand, s.brand.toUpperCase(), s.brand.split('').join('.'), s.ign, s.hex, s.twitchKey, s.ytKey, s.kickKey, s.blob, s.chat, 'youtube.com:443/live2', JSON.parse(json).path]) {
    assert.ok(!out.toLowerCase().includes(bad.toLowerCase()), `leaked: ${bad.slice(0, 12)}...\n${out}`);
  }
  assert.match(out, /%USERPROFILE%\\AppData\\Local\\Ujwalam\\data/);
  assert.match(out, /<profile-term>/);
  assert.match(out, /placeholder <twitch-channel> stays/, 'placeholders are not terms');
  assert.match(out, /rtmps:\/\/<redacted>/);
  assert.match(out, /login\?<redacted>/);
  assert.match(out, /"hotkey":"Ctrl\+Alt\+F","keyPresent":true/, 'ordinary fields stay readable');
  assert.match(out, /"text":"<redacted>"/);
});

test('redactor: a base64 blob containing "/" is redacted whole; a long plain path is not', () => {
  const s = secrets();
  const red = makeRedactor({ home: s.home, userName: s.userName, profile: s.profile });
  const blob = 'jXXNCZdV41Au/k9Qw+Zr7pLmN2bVcX/8YtHsGfDeA1Bc/Zx0Wq==';
  const out = red(`blob ${blob} and obs/data/obs-plugins/obs-browser/locale/en-US.ini/extra/more`);
  assert.ok(!out.includes('jXXNCZdV41Au') && !out.includes('8YtHsGfDeA1Bc'), out);
  assert.match(out, /obs\/data\/obs-plugins\/obs-browser\/locale\/en-US\.ini\/extra\/more/);
});

test('outputs: presence flags and counters only, never a URL, key ref value or file path', () => {
  const o = outputsSafe({ allowLive: true, sinks: [
    { id: 'yt', kind: 'stream', platform: 'youtube', url: 'rtmps://x/live2', keyRef: 'Ujwalam/stream/youtube-h', keyPresent: true, state: 'live', droppedFrames: 2, lastError: 'boom rtmps://x' },
    { id: 'rec', kind: 'record', path: 'D:/rec/a.mkv', container: 'mkv', state: 'idle' },
  ] });
  assert.deepEqual(o, { allowLive: true, sinks: [
    { id: 'yt', kind: 'stream', platform: 'youtube', state: 'live', keyPresent: true, droppedFrames: 2 },
    { id: 'rec', kind: 'record', state: 'idle', container: 'mkv' },
  ] });
});

test('bundle: files from a data dir with logs, snapshot, crash log and markers; nothing private survives in the zip', async () => {
  const s = secrets();
  const root = mkdtempSync(path.join(os.tmpdir(), 'ujw-diag-'));
  try {
    const dataDir = path.join(root, 'core');
    const hostData = path.join(root, 'host');
    mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    mkdirSync(path.join(hostData, 'markers'), { recursive: true });
    const profile = path.join(root, 'profile.json');
    writeFileSync(profile, JSON.stringify(s.profile));
    for (let i = 1; i <= 4; i++) {
      writeFileSync(path.join(dataDir, 'logs', `host-2026-11-0${i}T10-00-00-000Z.log`), [
        `info: ujwalam-host | runtime=${s.home}\\vendor\\obs`, `info: rtmp output to rtmps://a.rtmps.youtube.com:443/live2/${s.ytKey}`,
        `info: chat from ${s.ign}: {"message":"${s.chat}"}`, `warn: token ${s.hex}`, `info: scene ${s.brand} Live`,
      ].join('\n'));
    }
    writeFileSync(path.join(dataDir, 'logs', 'host-snapshot.json'), JSON.stringify({
      v: 1, at: '2026-11-05T10:00:00Z',
      info: { version: '0.1', obsVersion: '32.1.2', adapter: 'NVIDIA GeForce RTX 4050 Laptop GPU', encoders: ['obs_nvenc_h264_tex'], recordingsDir: path.join(s.home, 'Videos') },
      status: { fps: 60, scene: `${s.brand} main` },
      outputs: { sinks: [{ id: 'twitch', kind: 'stream', url: `rtmp://x/app/${s.twitchKey}`, keyPresent: true, state: 'live' }] },
    }));
    writeFileSync(path.join(dataDir, 'logs', 'host-crashes.jsonl'), `${JSON.stringify({ at: '2026-11-05T10:01:00Z', exit: 'code 3', action: 'restart', recording: ['record'] })}\n`);
    const markers = [];
    for (let i = 0; i < 60; i++) markers.push(JSON.stringify({ v: 1, at: `2026-11-05T10:${String(i).padStart(2, '0')}:00Z`, source: 'chat', note: `${s.chat} ${i}`, hostMs: i, streamMs: i * 10, recordMs: null, scenes: { H: `${s.brand} H` } }));
    writeFileSync(path.join(hostData, 'markers', 'session-1.jsonl'), `${markers.join('\n')}\n`);
    writeFileSync(path.join(dataDir, 'host.json'), JSON.stringify({ port: 1, pid: 1, token: null }));
    const release = path.join(root, 'release.json');
    writeFileSync(release, JSON.stringify({ version: '0.1.0-alpha.1', commit: 'abc', date: '2026-11-05' }));

    const files = await collectDiag({ dataDir, hostData, profile, release, home: s.home, userName: s.userName, gpu: () => 'name, driver_version\nNVIDIA GeForce RTX 4050 Laptop GPU, 999.99\n' });
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ['gpu.txt', 'host-crashes.jsonl', 'host-info.json', 'host-status.json', 'logs/host-2026-11-02T10-00-00-000Z.log', 'logs/host-2026-11-03T10-00-00-000Z.log', 'logs/host-2026-11-04T10-00-00-000Z.log', 'manifest.json', 'markers.jsonl', 'outputs.json', 'versions.json']);

    const out = path.join(root, 'out', 'diag.zip');
    const origHome = process.env.USERPROFILE;
    // CLI path (no RPC): same collection, written as a zip; home/user from the test via collectDiag above, so here
    // the CLI's own redactor uses the real home, which this data does not contain.
    assert.equal(await diagMain(['--data-dir', dataDir, '--host-data', hostData, '--profile', profile, '--release', release, '--out', out]), 0);
    assert.equal(process.env.USERPROFILE, origHome);
    const zipNames = readZip(out).map((e) => e.name).sort();
    assert.deepEqual(zipNames, names);

    const all = files.map((f) => `${f.name}\n${f.data}`).join('\n');
    for (const bad of [s.home, s.userName, s.brand, s.ign, s.hex, s.twitchKey, s.ytKey, s.chat, 'live2/', 'rtmp://x/app']) {
      assert.ok(!all.toLowerCase().includes(bad.toLowerCase()), `leaked: ${bad.slice(0, 12)}...`);
    }
    const zipAll = readZip(out).map((e) => extractEntry(out, e).toString('utf8')).join('\n');
    for (const bad of [s.brand, s.ign, s.hex, s.twitchKey, s.ytKey, s.chat]) assert.ok(!zipAll.toLowerCase().includes(bad.toLowerCase()), `zip leaked: ${bad.slice(0, 12)}...`);
    const mk = files.find((f) => f.name === 'markers.jsonl').data.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(mk.length, 50, 'the newest 50 markers');
    assert.equal(mk.at(-1).hostMs, 59);
    for (const m of mk) assert.deepEqual(Object.keys(m).sort(), ['at', 'hostMs', 'recordMs', 'source', 'streamMs', 'v'], 'no note, no scenes');
    const outputs = JSON.parse(files.find((f) => f.name === 'outputs.json').data);
    assert.deepEqual(outputs.sinks[0], { id: 'twitch', kind: 'stream', state: 'live', keyPresent: true });
    const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json').data);
    assert.equal(manifest.profileUsedForRedaction, true);
    assert.equal(manifest.sources.hostLogs, 3);
    assert.equal(manifest.sources.markers, 50);
    assert.match(files.find((f) => f.name === 'gpu.txt').data, /RTX 4050/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
