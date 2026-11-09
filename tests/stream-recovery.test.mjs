// SPDX-License-Identifier: GPL-3.0-or-later
// Stream recovery after a host crash (D303 proposed, flag stream-recovery; services/studio-ui/stream-recovery.mjs and
// launch.mjs superviseHost). Unit tests of the decision rules, the intent file and the status text; then the launcher
// end to end with the fake host (no libobs, no devices, mock Streamer.bot, loopback-only fake stream sinks, nothing
// reaches a network): the go-live is the control page's own confirm flow ("yes, on air" through the UI server API,
// logged in by the headless scripted browser), the crash is the fake host exiting with code 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeStreams, appendRecoveryEvent, clearIntent, eventText, INTENT_FILE, labelsOf, loadRecoveryConfig, readIntent,
  readRecoveryStatus, recoveryPolicy, RECOVERY_CONFIG_FILE, sinkLabel, STATUS_FILE, waitStreamsUp, writeIntent,
} from '../services/studio-ui/stream-recovery.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S1 = 'a'.repeat(32);
const S2 = 'b'.repeat(32);

test('recovery config: data/live/recovery.json loads with sources; bad values are refused', () => {
  const c = loadRecoveryConfig();
  assert.deepEqual(c, { maxRecoveries: 2, windowMs: 600_000, maxGapMs: 90_000, startCheckMs: 15_000, pollMs: 500 });
  const raw = JSON.parse(readFileSync(RECOVERY_CONFIG_FILE, 'utf8'));
  for (const k of Object.keys(c)) assert.ok(typeof raw.source[k] === 'string' && raw.source[k].length > 20, `source note for ${k}`);
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rcfg-'));
  try {
    const f = path.join(d, 'r.json');
    writeFileSync(f, JSON.stringify({ ...raw, maxGapMs: -1 }));
    assert.throws(() => loadRecoveryConfig(f), /maxGapMs/);
    writeFileSync(f, JSON.stringify({ ...raw, maxRecoveries: 'two' }));
    assert.throws(() => loadRecoveryConfig(f), /maxRecoveries/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('flag stream-recovery exists and is off by default', () => {
  const f = loadDefinitions().find((x) => x.id === 'stream-recovery');
  assert.ok(f);
  assert.equal(f.default, false);
});

test('labels: platform plus canvas; unknown platforms keep the id', () => {
  assert.equal(sinkLabel('youtube-h', 'youtube'), 'YouTube H');
  assert.equal(sinkLabel('youtube-v', 'youtube'), 'YouTube V');
  assert.equal(sinkLabel('twitch', 'twitch'), 'Twitch');
  assert.equal(sinkLabel('kick', 'kick'), 'Kick');
  assert.equal(sinkLabel('lb-1', 'loopback'), 'lb-1');
  const o = { sinks: [{ id: 'youtube-h', platform: 'youtube', kind: 'stream', state: 'live' }, { id: 'twitch', platform: 'twitch', kind: 'stream', state: 'retrying' },
    { id: 'kick', platform: 'kick', kind: 'stream', state: 'failed' }, { id: 'record', platform: 'local', kind: 'record', state: 'live' }] };
  assert.deepEqual(labelsOf(o, ['youtube-h', 'twitch', 'x']), ['YouTube H', 'Twitch', 'x']);
  assert.deepEqual(activeStreams(o), ['youtube-h', 'twitch']);
});

test('decisions: only an armed intent of this session, only live sinks, within the gap, at most maxRecoveries per window', () => {
  const cfg = { maxRecoveries: 2, windowMs: 600_000, maxGapMs: 90_000 };
  const armed = { session: S1, armed: true };
  const p = recoveryPolicy(cfg);
  const t = 10_000_000;
  const go = (o) => p.decide({ now: t, crashAt: t - 5000, flagOn: true, intent: armed, session: S1, streams: ['youtube-h', 'twitch'], ...o });
  assert.deepEqual(go({ streams: [] }), { restart: [], reason: 'none-live' });
  assert.equal(go({ flagOn: false }).reason, 'flag-off');
  assert.equal(go({ intent: null }).reason, 'no-confirmation');
  assert.equal(go({ session: S2 }).reason, 'no-confirmation', 'another launcher session (a launcher restart) is no authority');
  assert.equal(go({ session: null }).reason, 'no-confirmation');
  assert.equal(go({ intent: { session: S1, armed: false } }).reason, 'stopped', 'Stop / End all disarms');
  assert.equal(go({ crashAt: t - 90_001 }).reason, 'too-late');
  // none of the refusals above counted as a recovery
  assert.deepEqual(go({}), { restart: ['youtube-h', 'twitch'], reason: 'restart', attempt: 1, max: 2 });
  assert.equal(go({ now: t + 1000 }).attempt, 2);
  const lim = p.decide({ now: t + 2000, crashAt: t + 1500, flagOn: true, intent: armed, session: S1, streams: ['twitch'] });
  assert.deepEqual(lim, { restart: [], reason: 'limit', recoveries: 2 });
  // past the window the oldest recovery ages out
  assert.equal(p.decide({ now: t + 600_001, crashAt: t + 600_000, flagOn: true, intent: armed, session: S1, streams: ['twitch'] }).reason, 'restart');
  assert.equal(recoveryPolicy({ ...cfg, maxRecoveries: 0 }).decide({ now: t, crashAt: t, flagOn: true, intent: armed, session: S1, streams: ['x'] }).reason, 'limit');
});

test('intent file: written, read, session-checked, cleared; status events per session with plain text', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rint-'));
  try {
    assert.equal(readIntent(d), null);
    assert.throws(() => writeIntent(d, { session: 'nope', armed: true, reason: 'x' }), /session/);
    writeIntent(d, { session: S1, armed: true, reason: 'stream.start', at: new Date('2026-11-09T10:00:00Z') });
    assert.deepEqual(readIntent(d), { session: S1, armed: true, reason: 'stream.start', at: '2026-11-09T10:00:00.000Z' });
    writeFileSync(path.join(d, 'live', INTENT_FILE), '{"v":1,"session":"zz","armed":true}');
    assert.equal(readIntent(d), null, 'malformed: no authority');
    clearIntent(d);
    assert.equal(existsSync(path.join(d, 'live', INTENT_FILE)), false);

    const crashAt = new Date(2026, 10, 9, 14, 2, 30).toISOString(); // 14:02 local
    const e1 = appendRecoveryEvent(d, { session: S1, crashAt, streams: ['YouTube H', 'Twitch'], result: 'restarted', reason: 'restart', restarted: ['YouTube H', 'Twitch'], failed: [] });
    assert.equal(e1.text, 'Host crashed at 14:02, streams restarted: YouTube H, Twitch');
    appendRecoveryEvent(d, { session: S2, crashAt, streams: ['Kick'], result: 'not-restarted', reason: 'flag-off', restarted: [], failed: ['Kick'] });
    const st = readRecoveryStatus(d, S1);
    assert.equal(st.text, e1.text);
    assert.equal(st.count, 1, 'only this session');
    assert.match(readRecoveryStatus(d, S2).text, /^Host crashed at 14:02; streams NOT restarted \(stream recovery is off \(feature flag stream-recovery\)\): Kick$/);
    assert.equal(readRecoveryStatus(d, 'c'.repeat(32)), null);
    assert.match(eventText({ crashAt, result: 'partial', restarted: ['Twitch'], failed: ['Kick'] }), /restarted: Twitch; NOT restarted: Kick/);
    assert.match(eventText({ crashAt, result: 'not-restarted', reason: 'limit', recoveries: 2, windowMs: 600_000, streams: ['Twitch'] }), /again \(2 stream restart\(s\) already in 10 min\): streams NOT restarted: Twitch/);
    for (let i = 0; i < 30; i++) appendRecoveryEvent(d, { session: S1, crashAt, streams: [], result: 'restarted', restarted: [], failed: [] });
    assert.equal(JSON.parse(readFileSync(path.join(d, 'live', STATUS_FILE), 'utf8')).events.length, 20, 'last 20 kept');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('waitStreamsUp: up when active, down after the wait', async () => {
  let n = 0;
  const call = async () => { n++; return { sinks: [{ id: 'a', kind: 'stream', state: n > 2 ? 'live' : 'starting' }, { id: 'b', kind: 'stream', state: 'failed' }] }; };
  let t = 0;
  const r = await waitStreamsUp(call, ['a', 'b'], { startCheckMs: 1000, pollMs: 100 }, () => t, async (ms) => { t += ms; });
  assert.deepEqual(r, { up: ['a'], down: ['b'] });
  const ok = await waitStreamsUp(async () => ({ sinks: [{ id: 'a', kind: 'stream', state: 'live' }] }), ['a'], { startCheckMs: 0, pollMs: 50 });
  assert.deepEqual(ok, { up: ['a'], down: [] });
});

// ---- launcher end to end (fake host) ----

function launch(name, { flag = true, crashRuns = '1,2', extraEnv = {}, before = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `ujw-srec-${name}-`));
  const dataDir = path.join(root, 'core');
  mkdirSync(dataDir, { recursive: true });
  if (flag) writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'stream-recovery': true } }));
  if (before) before(dataDir);
  const rec = path.join(root, 'record.json');
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, readFileSync(path.join(FIX, 'project', 'profile.fixture.json')));
  const loginOut = path.join(root, 'login.json');
  const crashFile = path.join(root, 'crash-now');
  const env = {
    ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_BROWSER: process.execPath, UJWALAM_BROWSER_ARGS: `${path.join(REPO, 'app', 'host', 'tests', 'studio-login.mjs')} ${loginOut}`,
    UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: path.join(root, 'no-overlays'),
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_RUNS: path.join(root, 'runs.txt'), UJWALAM_FAKE_HOST_RECORDING: '1',
    UJWALAM_FAKE_HOST_STREAMS: 'youtube-h:youtube,youtube-v:youtube,twitch:twitch,kick:kick', UJWALAM_FAKE_HOST_STREAM_FAIL: 'kick',
    UJWALAM_FAKE_HOST_CRASH_RUNS: crashRuns, UJWALAM_FAKE_HOST_CRASH_ON: crashFile,
    UJWALAM_HOST_RESTART_BACKOFF_MS: '200', UJWALAM_HOST_WATCH_MS: '200', UJWALAM_ALPHA_STATS_MS: '60000',
    UJWALAM_HOST_TOKEN: '', UJWALAM_HOST_EXE: '', UJWALAM_HOST_BUILD: '', UJWALAM_LIVE_SESSION: '',
    ...extraEnv,
  };
  const args = [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--alpha', '--mock', '--stop-on-stdin', '--shell', 'browser',
    '--data-dir', dataDir, '--host-exe', path.join(FIX, 'studio-ui', 'fake-host.mjs'), '--profile', profile, '--feedback-dir', path.join(root, 'feedback')];
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const s = { root, dataDir, rec, child, out: '', code: null, port: 0, cookie: '', csrf: '' };
  child.stdout.on('data', (d) => { s.out += d; });
  child.stderr.on('data', (d) => { s.out += d; });
  s.exited = new Promise((r) => child.on('exit', (c) => { s.code = c; r(c); }));
  s.calls = () => { try { return readFileSync(`${rec}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  s.crash = () => writeFileSync(crashFile, 'x');
  s.until = async (fn, what, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; if (s.code !== null) break; await sleep(100); }
    assert.fail(`timed out waiting for ${what}\n${s.out}`);
  };
  s.req = (method, route, body) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${s.port}`, Cookie: s.cookie };
    if (method === 'POST') Object.assign(headers, { Origin: `http://127.0.0.1:${s.port}`, 'Content-Type': 'application/json', 'X-Ujwalam-Csrf': s.csrf, 'Content-Length': Buffer.byteLength(data ?? '') });
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: route, method, headers, timeout: 15_000 }, (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { t += c; });
        res.on('end', () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; } resolve({ status: res.statusCode, body: j }); });
      });
      r.on('error', reject);
      r.on('timeout', () => r.destroy(new Error('timeout')));
      if (data !== null) r.write(data);
      r.end();
    });
  };
  s.login = async () => {
    await s.until(() => existsSync(loginOut) && readFileSync(loginOut, 'utf8').length > 0, 'the scripted login');
    const l = JSON.parse(readFileSync(loginOut, 'utf8'));
    assert.equal(l.status, 302, 'one-time login');
    s.port = l.port; s.cookie = l.cookie;
    s.csrf = (await s.req('GET', '/ui/api/session')).body.csrf;
  };
  // The page's flow: request -> typed phrase -> confirm.
  s.confirmed = async (route, body, phrase) => {
    const c = await s.req('POST', route, body);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.verdict, 'confirm');
    assert.equal(c.body.pending.phrase, phrase);
    const r = await s.req('POST', '/ui/api/confirm', { pendingId: c.body.pending.pendingId, text: phrase });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verdict, 'allow', JSON.stringify(r.body));
    return r.body;
  };
  s.goLive = async () => {
    await s.confirmed('/ui/api/host', { method: 'stream.start', params: {} }, 'yes, on air');
    // the launcher's outputs.status poll (200 ms here) must have seen the streams live
    await sleep(800);
  };
  s.status = async () => (await s.req('GET', '/ui/api/status')).body;
  // The page reads a cached status snapshot (refreshed by the UI server's poll): wait for the n-th recovery event.
  s.recovery = async (n = 1) => {
    const end = Date.now() + 20_000;
    for (;;) {
      const r = (await s.status()).recovery;
      if (r && r.count >= n) return r;
      if (Date.now() > end) assert.fail(`no recovery status ${n} on the page: ${JSON.stringify(r)}`);
      await sleep(200);
    }
  };
  s.stop = async () => {
    if (s.code === null) { s.child.stdin.end(); await Promise.race([s.exited, sleep(20_000)]); }
    if (s.code === null) s.child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  };
  return s;
}

const streamStarts = (s) => s.calls().filter((x) => x.method === 'stream.start');

test('crash while live (flag on): the streams that were live come back, the recording restarts in a new file; after End all nothing comes back', { timeout: 180_000 }, async () => {
  const s = launch('on');
  try {
    await s.login();
    // An intent left by an earlier launcher was cleared at start.
    assert.equal(readIntent(s.dataDir), null);
    await s.goLive();
    const intent = readIntent(s.dataDir);
    assert.equal(intent.armed, true);
    assert.equal(intent.reason, 'stream.start');
    assert.deepEqual(streamStarts(s).map((x) => [x.run, x.params]), [[1, {}]], 'the user\'s own start: all stream sinks');

    s.crash();
    await s.until(() => /streams restarted: YouTube H, YouTube V, Twitch/.test(s.out), 'the recovery line');
    const starts = streamStarts(s);
    assert.deepEqual(starts.map((x) => [x.run, x.params]), [[1, {}], [2, { sinks: ['youtube-h', 'youtube-v', 'twitch'] }]],
      'exactly the sinks that were live (kick had failed, so it is not started)');
    assert.match(s.out, /HOST EXITED UNEXPECTEDLY \(code 3\); restart 1 of 3 in 200 ms; recording was on \(record\); streams were on \(youtube-h, youtube-v, twitch\)/);
    assert.match(s.out, /recording started again in a new file \(record\)/);
    assert.deepEqual(s.calls().filter((x) => x.method === 'record.start').map((x) => x.run), [2]);
    await s.until(() => s.calls().some((x) => x.method === 'marker.add' && x.run === 2), 'the restart marker');
    const marker = s.calls().find((x) => x.method === 'marker.add' && x.run === 2);
    assert.match(marker.params.note, /recording resumed: record; streams restarted: YouTube H, YouTube V, Twitch; streams to restart by hand: none$/);
    const st = { recovery: await s.recovery(1) };
    assert.equal(st.recovery.result, 'restarted');
    assert.match(st.recovery.text, /^Host crashed at \d\d:\d\d, streams restarted: YouTube H, YouTube V, Twitch$/);
    const cr = readFileSync(path.join(s.dataDir, 'logs', 'host-crashes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(cr.find((x) => x.action === 'restarted').streamsRestarted, ['YouTube H', 'YouTube V', 'Twitch']);

    // The user ends all streams: the authority is gone, a crash now brings no stream back.
    await sleep(500);
    const end = await s.confirmed('/ui/api/streams/end-all', {}, 'yes, on air');
    assert.equal(end.endAll.allStopped, true, JSON.stringify(end));
    assert.equal(readIntent(s.dataDir).armed, false);
    assert.equal(readIntent(s.dataDir).reason, 'end-all');
    await sleep(600);
    s.crash();
    await s.until(() => /restart 2 of 3/.test(s.out) && /host restarted \(attempt 2\)/.test(s.out), 'the second host restart');
    await s.until(() => s.calls().some((x) => x.method === 'marker.add' && x.run === 3), 'the second restart marker');
    assert.deepEqual(streamStarts(s).map((x) => x.run), [1, 2], 'no stream.start in run 3');
    assert.ok(!/streams were on/.test(s.out.split('restart 2 of 3')[1].split('\n')[0]), 'no stream was live at the second crash');
    assert.ok(!/[0-9a-f]{64}/.test(s.out), 'no token-shaped value printed');
  } finally { await s.stop(); }
});

test('crash while live with the flag off: streams are not restarted, the page says why', { timeout: 180_000 }, async () => {
  const s = launch('off', { flag: false, crashRuns: '1' });
  try {
    await s.login();
    await s.goLive();
    s.crash();
    await s.until(() => /streams NOT restarted \(stream recovery is off/.test(s.out), 'the refusal line');
    await s.until(() => s.calls().some((x) => x.method === 'marker.add' && x.run === 2), 'the restart marker');
    assert.deepEqual(streamStarts(s).map((x) => x.run), [1]);
    assert.match(s.calls().find((x) => x.method === 'marker.add' && x.run === 2).params.note, /streams to restart by hand: YouTube H, YouTube V, Twitch$/);
    const st = { recovery: await s.recovery(1) };
    assert.equal(st.recovery.result, 'not-restarted');
    assert.equal(st.recovery.reason, 'flag-off');
  } finally { await s.stop(); }
});

test('repeated crashes while live: two recoveries, the third crash leaves the streams off and disarms the intent', { timeout: 240_000 }, async () => {
  const s = launch('limit', { crashRuns: '1,2,3' });
  try {
    await s.login();
    await s.goLive();
    for (let i = 1; i <= 3; i++) {
      s.crash();
      await s.until(() => (s.out.match(/Host crashed at \d\d:\d\d/g) ?? []).length >= i, `recovery event ${i}`);
      await sleep(800); // the launcher's poll sees the restarted streams live again
    }
    assert.deepEqual(streamStarts(s).map((x) => x.run), [1, 2, 3], 'restarted after crash 1 and 2 only');
    assert.match(s.out, /Host crashed at \d\d:\d\d again \(2 stream restart\(s\) already in 10 min\): streams NOT restarted: YouTube H, YouTube V, Twitch\. Check the host log/);
    assert.equal(readIntent(s.dataDir).armed, false);
    assert.equal(readIntent(s.dataDir).reason, 'recovery-limit');
    const st = { recovery: await s.recovery(3) };
    assert.equal(st.recovery.reason, 'limit');
    assert.equal(st.recovery.count, 3);
  } finally { await s.stop(); }
});

test('a launcher start clears an intent left by an earlier launcher (no go-live after a launcher restart)', { timeout: 120_000 }, async () => {
  const s = launch('stale', { crashRuns: '', before: (d) => writeIntent(d, { session: S1, armed: true, reason: 'stream.start' }) });
  try {
    await s.until(() => /\[studio\] UI at /.test(s.out), 'the UI line');
    assert.equal(readIntent(s.dataDir), null, 'cleared at start');
    await sleep(500);
    assert.deepEqual(streamStarts(s), [], 'nothing goes live by itself');
  } finally { await s.stop(); }
});
