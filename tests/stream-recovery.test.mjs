// SPDX-License-Identifier: GPL-3.0-or-later
// Stream recovery after a host crash (D303 proposed, flag stream-recovery; services/studio-ui/stream-recovery.mjs and
// launch.mjs superviseHost). Unit tests of the decision rules, the launcher-owned go-live authority (with its races:
// a revoke that fails closes it, a slow start never arms after a newer stop, a stop waits for an in-flight recovery
// start) and the status text; then the launcher
// end to end with the fake host (no libobs, no devices, mock Streamer.bot, loopback-only fake stream sinks, nothing
// reaches a network): the go-live is the control page's own Start stream click (through the UI server API, D332: no
// typed phrase; logged in by the headless scripted browser), the crash is the fake host exiting with code 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeStreams, appendRecoveryEvent, AUTHORITY_FILE, authorityClient, createLiveAuthority, eventText, labelsOf, loadRecoveryConfig,
  readRecoveryStatus, recoveryPolicy, RECOVERY_CONFIG_FILE, serveAuthority, sinkLabel, STATUS_FILE, waitStreamsUp,
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

test('decisions: only an armed authority, only live sinks not stopped on purpose, within the gap, at most maxRecoveries per window', () => {
  const cfg = { maxRecoveries: 2, windowMs: 600_000, maxGapMs: 90_000 };
  const armed = { gen: 1, armed: true, reason: 'stream.start', closed: false, excluded: [] };
  const p = recoveryPolicy(cfg);
  const t = 10_000_000;
  const go = (o) => p.decide({ now: t, crashAt: t - 5000, flagOn: true, authority: armed, streams: ['youtube-h', 'twitch'], ...o });
  assert.deepEqual(go({ streams: [] }), { restart: [], reason: 'none-live' });
  assert.equal(go({ flagOn: false }).reason, 'flag-off');
  assert.equal(go({ authority: null }).reason, 'no-confirmation');
  assert.equal(go({ authority: { ...armed, armed: false, reason: 'none' } }).reason, 'no-confirmation', 'a new launcher: never armed');
  assert.equal(go({ authority: { ...armed, armed: false, reason: 'end-all' } }).reason, 'stopped', 'Stop / End all revokes');
  assert.equal(go({ authority: { ...armed, armed: false, reason: 'recovery-limit' } }).reason, 'limit-earlier');
  assert.equal(go({ authority: { ...armed, armed: false, closed: true, reason: 'ui-link-lost' } }).reason, 'authority-lost');
  assert.equal(go({ authority: { ...armed, excluded: ['youtube-h', 'twitch'] } }).reason, 'stopped', 'every live sink was stopped on purpose');
  assert.equal(go({ crashAt: t - 90_001 }).reason, 'too-late');
  // none of the refusals above counted as a recovery
  assert.deepEqual(go({ authority: { ...armed, excluded: ['youtube-h'] } }), { restart: ['twitch'], reason: 'restart', attempt: 1, max: 2 });
  assert.equal(go({ now: t + 1000 }).attempt, 2);
  const lim = p.decide({ now: t + 2000, crashAt: t + 1500, flagOn: true, authority: armed, streams: ['twitch'] });
  assert.deepEqual(lim, { restart: [], reason: 'limit', recoveries: 2 });
  // past the window the oldest recovery ages out
  assert.equal(p.decide({ now: t + 600_001, crashAt: t + 600_000, flagOn: true, authority: armed, streams: ['twitch'] }).reason, 'restart');
  assert.equal(recoveryPolicy({ ...cfg, maxRecoveries: 0 }).decide({ now: t, crashAt: t, flagOn: true, authority: armed, streams: ['x'] }).reason, 'limit');
});

test('authority: arms only for the generation a start began in; a revoke wins at once and is answered after an in-flight run', async () => {
  const seen = [];
  const a = createLiveAuthority({ onChange: (st) => seen.push(st) });
  assert.deepEqual(a.state(), { gen: 0, armed: false, reason: 'none', closed: false, excluded: [] }, 'unarmed at start');
  // Race 2: a slow Start, then a Stop before the Start's answer: the Start must not arm afterwards.
  const g0 = a.begin();
  await a.revoke('stream.stop');
  assert.deepEqual(a.arm(g0), { armed: false, gen: 1 });
  assert.equal(a.state().armed, false);
  const g1 = a.begin();
  assert.equal(a.arm(g1).armed, true);
  // Race 3: a recovery start in flight, then a Stop: the authority is gone at once, the answer waits for the run.
  let release;
  const run = a.run(async (st) => { assert.equal(st.armed, true); await new Promise((r) => { release = r; }); return 'started'; });
  await sleep(10);
  let answered = false;
  const rv = a.revoke('end-all').then(() => { answered = true; });
  await sleep(30);
  assert.equal(answered, false, 'the stop waits for the start in flight');
  assert.equal(a.state().armed, false, 'but the authority is gone at once');
  release();
  const r = await run;
  assert.deepEqual(r, { value: 'started', revoked: true, excluded: [] }, 'the run learns it was overtaken (the launcher stops those sinks)');
  await rv;
  assert.equal(answered, true);
  // A run after the revoke sees no authority.
  assert.equal((await a.run(async (st) => st.armed)).value, false);
  // Guard stops: excluded until the next Start stream click.
  a.arm(a.begin());
  await a.exclude(['twitch']);
  assert.deepEqual(a.state().excluded, ['twitch']);
  a.arm(a.begin());
  assert.deepEqual(a.state().excluded, [], 'a new Start stream click starts every sink');
  // Fail closed: closed for good.
  a.close('ui-link-lost');
  assert.equal(a.begin(), null);
  assert.equal(a.arm(a.state().gen).armed, false);
  assert.deepEqual([a.state().armed, a.state().closed, a.state().reason], [false, true, 'ui-link-lost']);
  assert.ok(seen.length >= 6 && seen.every((x) => typeof x.gen === 'number'), 'every change mirrored');
});

// Two fake processes joined like the launcher (child) and the UI server (proc) over Node IPC.
function ipcPair({ launcherAnswers = true } = {}) {
  const proc = new EventEmitter(); const child = new EventEmitter();
  proc.connected = true; child.connected = true;
  proc.send = (m) => { if (launcherAnswers) setImmediate(() => child.emit('message', structuredClone(m))); };
  child.send = (m) => setImmediate(() => proc.emit('message', structuredClone(m)));
  proc.disconnect = () => { proc.connected = false; child.connected = false; setImmediate(() => { proc.emit('disconnect'); child.emit('disconnect'); }); };
  return { proc, child };
}

test('authority over IPC: begin/arm/revoke reach the launcher; a revoke that is not answered closes the channel and the authority (fail closed)', async () => {
  const a = createLiveAuthority();
  const { proc, child } = ipcPair();
  serveAuthority(child, a);
  const c = authorityClient({ proc, timeoutMs: 2000 });
  const g = await c.begin();
  assert.equal(g, 0);
  assert.equal(await c.arm(g), true);
  assert.equal(a.state().armed, true);
  const g2 = await c.begin();
  assert.equal(await c.revoke('stream.stop'), true);
  assert.equal(a.state().armed, false);
  assert.equal(await c.arm(g2), false, 'a start that began before the stop does not arm');
  assert.equal(await c.arm('x'), false);

  // Race 1: the revoke cannot be confirmed (the launcher does not answer): the UI server closes the channel and the
  // launcher closes the authority for the rest of the session. No armed state survives a failed revoke.
  const b = createLiveAuthority();
  const lost = ipcPair({ launcherAnswers: false });
  serveAuthority(lost.child, b);
  b.arm(b.begin()); // armed earlier (a Start stream click)
  const c2 = authorityClient({ proc: lost.proc, timeoutMs: 100 });
  assert.equal(await c2.revoke('stream.stop'), false);
  assert.equal(lost.proc.connected, false, 'the UI server closed the channel');
  await sleep(10);
  assert.deepEqual([b.state().armed, b.state().closed, b.state().reason], [false, true, 'ui-link-lost']);
  assert.equal(recoveryPolicy({ maxRecoveries: 2, windowMs: 600_000, maxGapMs: 90_000 }).decide({ now: 1, crashAt: 0, flagOn: true, authority: b.state(), streams: ['twitch'] }).reason, 'authority-lost');
  assert.equal(await c2.begin(), null, 'a closed channel never arms again');

  // The UI server exiting (or its channel breaking) closes the authority too.
  const d = createLiveAuthority();
  const gone = ipcPair();
  serveAuthority(gone.child, d);
  d.arm(d.begin());
  gone.child.emit('exit', 1);
  assert.equal(d.state().closed, true);
  // Without a channel (started by hand, tests) there is no client.
  assert.equal(authorityClient({ proc: { send: undefined } }), null);
});

test('status events per session with plain text', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rint-'));
  try {
    const crashAt = new Date(2026, 10, 9, 14, 2, 30).toISOString(); // 14:02 local
    const e1 = appendRecoveryEvent(d, { session: S1, crashAt, streams: ['YouTube H', 'Twitch'], result: 'restarted', reason: 'restart', restarted: ['YouTube H', 'Twitch'], failed: [] });
    assert.equal(e1.text, 'Host crashed at 14:02, streams restarted: YouTube H, Twitch');
    appendRecoveryEvent(d, { session: S2, crashAt, streams: ['Kick'], result: 'not-restarted', reason: 'flag-off', restarted: [], failed: ['Kick'] });
    const st = readRecoveryStatus(d, S1);
    assert.equal(st.text, e1.text);
    assert.equal(st.count, 1, 'only this session');
    assert.match(readRecoveryStatus(d, S2).text, /^Host crashed at 14:02; streams NOT restarted \(stream recovery is off \(feature flag stream-recovery\)\): Kick$/);
    assert.equal(readRecoveryStatus(d, 'c'.repeat(32)), null);
    assert.match(eventText({ crashAt, result: 'cancelled', failed: ['Twitch'] }), /streams started again, then stopped because you pressed Stop or End all: Twitch$/);
    assert.match(eventText({ crashAt, result: 'not-restarted', reason: 'authority-lost', streams: ['Twitch'] }), /lost its link to the launcher/);
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
  s.authority = () => { try { return JSON.parse(readFileSync(path.join(dataDir, 'live', AUTHORITY_FILE), 'utf8')); } catch { return null; } };
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
  // The page's flow (D332): one click acts; no pending entry, no typed phrase.
  s.clicked = async (route, body) => {
    const r = await s.req('POST', route, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verdict, 'allow', JSON.stringify(r.body));
    assert.equal(r.body.pending, undefined, 'nothing pending');
    return r.body;
  };
  // A click whose answer the caller checks itself (used while another action is in flight).
  s.click = (route, body) => s.req('POST', route, body);
  s.goLive = async () => {
    await s.clicked('/ui/api/host', { method: 'stream.start', params: {} });
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
    // A new launcher: a new, unarmed authority.
    assert.deepEqual([s.authority().armed, s.authority().reason], [false, 'none']);
    await s.goLive();
    assert.deepEqual([s.authority().armed, s.authority().reason], [true, 'stream.start']);
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
    const end = await s.clicked('/ui/api/streams/end-all', {});
    assert.equal(end.endAll.allStopped, true, JSON.stringify(end));
    assert.deepEqual([s.authority().armed, s.authority().reason], [false, 'end-all']);
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

test('repeated crashes while live: two recoveries, the third crash leaves the streams off and revokes the authority', { timeout: 240_000 }, async () => {
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
    assert.deepEqual([s.authority().armed, s.authority().reason], [false, 'recovery-limit']);
    const st = { recovery: await s.recovery(3) };
    assert.equal(st.recovery.reason, 'limit');
    assert.equal(st.recovery.count, 3);
  } finally { await s.stop(); }
});

test('a launcher start is never armed, whatever an earlier launcher left on disk (no go-live after a launcher restart)', { timeout: 120_000 }, async () => {
  const s = launch('stale', { crashRuns: '', before: (d) => {
    mkdirSync(path.join(d, 'live'), { recursive: true });
    writeFileSync(path.join(d, 'live', AUTHORITY_FILE), JSON.stringify({ v: 1, session: 'a'.repeat(32), gen: 3, armed: true, reason: 'stream.start', closed: false, excluded: [] }));
    writeFileSync(path.join(d, 'live', 'stream-intent.json'), JSON.stringify({ v: 1, session: 'a'.repeat(32), armed: true, reason: 'stream.start' }));
  } });
  try {
    await s.until(() => /\[studio\] UI at /.test(s.out), 'the UI line');
    assert.deepEqual([s.authority().armed, s.authority().reason, s.authority().gen], [false, 'none', 0], 'the mirror shows the new, unarmed authority');
    await sleep(500);
    assert.deepEqual(streamStarts(s), [], 'nothing goes live by itself');
  } finally { await s.stop(); }
});

test('race: a Stop while a slow Start is at the host: the Start does not arm and its streams are stopped again; a crash restarts nothing', { timeout: 180_000 }, async () => {
  const s = launch('slowstart', { crashRuns: '1', extraEnv: { UJWALAM_FAKE_HOST_START_DELAY_MS: '2500' } });
  try {
    await s.login();
    const start = s.click('/ui/api/host', { method: 'stream.start', params: {} }); // not awaited: the host is slow
    await s.until(() => streamStarts(s).length === 1, 'the start reaching the host');
    const stop = await s.click('/ui/api/host', { method: 'stream.stop', params: {} });
    assert.equal(stop.body.verdict, 'allow', JSON.stringify(stop.body));
    // The host answers the start last (and turns the sinks live last): the start must not arm, and is undone.
    const r = await start;
    assert.deepEqual([r.body.verdict, r.body.reason, r.body.stoppedAgain], ['refuse', 'stopped-meanwhile', true], JSON.stringify(r.body));
    const run1 = s.calls().filter((x) => x.run === 1 && /^stream\./.test(x.method ?? '')).map((x) => x.method);
    assert.deepEqual(run1, ['stream.start', 'stream.stop', 'stream.start.done', 'stream.stop'], 'the compensating stop comes after the late start');
    assert.deepEqual([s.authority().armed, s.authority().reason], [false, 'stream.stop'], 'the later Stop wins over the slow Start');
    await sleep(800);
    s.crash();
    await s.until(() => /host restarted \(attempt 1\)/.test(s.out), 'the host restart');
    await sleep(800);
    assert.ok(!/streams were on/.test(s.out), 'no stream was live at the crash');
    assert.deepEqual(streamStarts(s).map((x) => x.run), [1], 'no stream.start after the crash');
  } finally { await s.stop(); }
});

// The slow-start race with the host refusing stream.stop calls from the 2nd on (the user's stop is the 1st): the
// compensating stop is retried; when every try fails the page gets a loud error and the log says so.
async function overtakenStart(name, failCount) {
  const extraEnv = { UJWALAM_FAKE_HOST_START_DELAY_MS: '2500', UJWALAM_FAKE_HOST_STOP_FAIL_FROM: '2' };
  if (failCount !== null) extraEnv.UJWALAM_FAKE_HOST_STOP_FAIL_COUNT = String(failCount);
  const s = launch(name, { crashRuns: '', extraEnv });
  await s.login();
  const start = s.click('/ui/api/host', { method: 'stream.start', params: {} }); // not awaited: the host is slow
  await s.until(() => streamStarts(s).length === 1, 'the start reaching the host');
  const stop = await s.click('/ui/api/host', { method: 'stream.stop', params: {} });
  assert.equal(stop.body.verdict, 'allow', JSON.stringify(stop.body));
  const r = await start;
  const stops = s.calls().filter((x) => x.method === 'stream.stop').map((x) => (x.failed ? 'failed' : 'ok'));
  return { s, r, stops };
}

test('race: the compensating stop is retried when the host refuses it once', { timeout: 180_000 }, async () => {
  const { s, r, stops } = await overtakenStart('stopretry', 1);
  try {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.verdict, r.body.reason, r.body.stoppedAgain], ['refuse', 'stopped-meanwhile', true]);
    assert.deepEqual(stops, ['ok', 'failed', 'ok'], 'user stop, a failed try, then the retry wins');
    assert.ok(!/could not be stopped again/.test(s.out));
  } finally { await s.stop(); }
});

test('race: a compensating stop that keeps failing is a loud error on the page and in the log', { timeout: 180_000 }, async () => {
  const { s, r, stops } = await overtakenStart('stopfail', null);
  try {
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.deepEqual(r.body, { error: 'Streams may still be live: press Stop or End all', detail: 'stop-again-failed' });
    assert.deepEqual(stops, ['ok', 'failed', 'failed', 'failed'], 'three tries');
    await s.until(() => /WARNING: a start overtaken by a Stop could not be stopped again \(.+\); streams may still be live/.test(s.out), 'the log line');
    assert.equal(s.authority().armed, false, 'never armed');
  } finally { await s.stop(); }
});

test('race: a Stop during the pause before a clicked Start reaches the host: the Start is not sent', { timeout: 180_000 }, async () => {
  const s = launch('prestart', { crashRuns: '1', extraEnv: { UJWALAM_TEST_START_PAUSE_MS: '2500' } });
  try {
    await s.login();
    const start = s.click('/ui/api/host', { method: 'stream.start', params: {} }); // not awaited: it pauses 2.5 s
    await sleep(800); // the start has its generation and waits before the host call
    const stop = await s.click('/ui/api/host', { method: 'stream.stop', params: {} });
    assert.equal(stop.body.verdict, 'allow', JSON.stringify(stop.body));
    const r = await start;
    assert.deepEqual([r.body.verdict, r.body.reason], ['refuse', 'stopped-meanwhile'], JSON.stringify(r.body));
    assert.deepEqual(streamStarts(s), [], 'the stale start never reached the host');
    assert.deepEqual(s.calls().filter((x) => x.method === 'stream.stop').map((x) => x.params), [{}], 'only the user\'s stop');
    assert.deepEqual([s.authority().armed, s.authority().reason], [false, 'stream.stop']);
    // After that the user can still go live normally.
    await s.goLive();
    assert.equal(s.authority().armed, true);
    assert.equal(streamStarts(s).length, 1);
  } finally { await s.stop(); }
});

test('race: End all while the recovery start is in flight: the stop reaches the host after it and wins; the launcher stops them too', { timeout: 180_000 }, async () => {
  const s = launch('inflight', { crashRuns: '1', extraEnv: { UJWALAM_FAKE_HOST_START_DELAY_MS: '2500' } });
  try {
    await s.login();
    await s.goLive();
    await sleep(800);
    s.crash();
    await s.until(() => s.calls().some((x) => x.method === 'stream.start' && x.run === 2), 'the recovery start reaching the restarted host');
    const end = await s.clicked('/ui/api/streams/end-all', {});
    assert.equal(end.endAll.allStopped, true, JSON.stringify(end));
    const run2 = s.calls().filter((x) => x.run === 2 && /^stream\./.test(x.method ?? ''));
    const done = run2.findIndex((x) => x.method === 'stream.start.done');
    const stops = run2.map((x, i) => (x.method === 'stream.stop' ? i : -1)).filter((i) => i >= 0);
    assert.ok(done >= 0 && stops.length >= 1 && stops.every((i) => i > done), `every stop after the start answer: ${JSON.stringify(run2)}`);
    assert.ok(run2.some((x) => x.method === 'stream.stop' && Array.isArray(x.params.sinks) && x.params.sinks.join() === 'youtube-h,youtube-v,twitch'), 'the launcher stopped the restarted sinks');
    assert.ok(run2.some((x) => x.method === 'stream.stop' && x.params.sinks === undefined), 'End all reached the host');
    await s.until(() => /streams started again, then stopped because you pressed Stop or End all: YouTube H, YouTube V, Twitch/.test(s.out), 'the cancelled line');
    assert.equal((await s.recovery(1)).result, 'cancelled');
    assert.deepEqual([s.authority().armed, s.authority().reason], [false, 'end-all']);
  } finally { await s.stop(); }
});
