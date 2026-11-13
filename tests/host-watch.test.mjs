// SPDX-License-Identifier: GPL-3.0-or-later
// Host watchdog (D374 proposed, flag host-watchdog; services/studio-ui/host-watch.mjs and launch.mjs superviseHost).
// Unit tests of the stale decision and the watch loop with a fake clock and a fake probe (no GPU, no host), the driver
// reset lookup with a fake PowerShell, the incident task; then the launcher end to end with the fake host freezing
// (tests/fixtures/studio-ui/fake-host.mjs UJWALAM_FAKE_HOST_HANG_*): stale -> stopped -> restarted -> recording and the
// streams that were live restored (the streams only under flag stream-recovery and this launcher's go-live authority).
// Nothing reaches a network; the fake stream sinks are loopback-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHostWatch, driverResets, driverResetText, HOST_WATCH_FILE, HOST_WATCH_FLAG, incidentTask, livenessJudge,
  loadHostWatchConfig, parseDriverLines, staleText,
} from '../services/studio-ui/host-watch.mjs';
import { alphaHostConfig, hostGraphicsWatch } from '../services/studio-ui/launch.mjs';
import { cleanTask } from '../services/studio-ui/tasks.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = { checkMs: 5000, rpcTimeoutMs: 10_000, noAnswerMs: 30_000, graphicsStallMs: 30_000, killWaitMs: 15_000, driverLookbackMs: 600_000 };

test('config: data/live/host-watch.json loads with a source note per value; bad values are refused', () => {
  const c = loadHostWatchConfig(HOST_WATCH_FILE);
  assert.deepEqual(c, { ...CFG, host: { stallMs: 5000, checkIntervalMs: 1000 } });
  const raw = JSON.parse(readFileSync(HOST_WATCH_FILE, 'utf8'));
  for (const k of [...Object.keys(CFG), 'host']) assert.ok(typeof raw.source[k] === 'string' && raw.source[k].length > 40, `source note for ${k}`);
  assert.equal(raw.status, 'proposed');
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-hw-cfg-'));
  try {
    const f = path.join(d, 'w.json');
    writeFileSync(f, JSON.stringify({ ...raw, noAnswerMs: 100 }));
    assert.throws(() => loadHostWatchConfig(f), /noAnswerMs/);
    writeFileSync(f, JSON.stringify({ ...raw, rpcTimeoutMs: 40_000 }));
    assert.throws(() => loadHostWatchConfig(f), /rpcTimeoutMs must be shorter/);
    writeFileSync(f, JSON.stringify({ ...raw, host: { stallMs: 5000 } }));
    assert.throws(() => loadHostWatchConfig(f), /checkIntervalMs/);
    const { checkMs, ...noteless } = raw.source;
    void checkMs;
    writeFileSync(f, JSON.stringify({ ...raw, source: noteless }));
    assert.throws(() => loadHostWatchConfig(f), /source\.checkMs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('flag host-watchdog exists, is off by default and has its settings-page fields', () => {
  const f = loadDefinitions().find((x) => x.id === HOST_WATCH_FLAG);
  assert.ok(f);
  assert.equal(f.default, false);
  assert.equal(f.page, 'stream');
  assert.ok(f.label && f.summary);
});

test('host config: graphicsWatch comes from data/live/host-watch.json (report only in the host); a bad file leaves it out', () => {
  const c = alphaHostConfig({ dataDir: os.tmpdir() });
  assert.deepEqual(c.graphicsWatch, { stallMs: 5000, checkIntervalMs: 1000 });
  assert.equal(hostGraphicsWatch(() => { throw new Error('bad'); }), null);
  assert.ok(!('graphicsWatch' in alphaHostConfig({ dataDir: os.tmpdir(), graphicsWatch: null })));
});

test('judge: no answer for noAnswerMs is stale once per incident; a healthy answer ends it; frame age counts while answering', () => {
  const j = livenessJudge(CFG);
  j.reset(0);
  assert.equal(j.observe({ now: 5000, ok: true, status: { graphics: { lastFrameAgeMs: 16 } } }).state, 'ok');
  assert.equal(j.observe({ now: 20_000, ok: false }).state, 'ok', '15 s without an answer decides nothing yet');
  assert.equal(j.observe({ now: 34_999, ok: false }).state, 'ok');
  assert.deepEqual(j.observe({ now: 35_000, ok: false }), { state: 'stale', reason: 'no-answer', forMs: 30_000, isNew: true });
  assert.equal(j.observe({ now: 40_000, ok: false }).isNew, false, 'the same incident');
  assert.equal(j.observe({ now: 45_000, ok: true, status: { graphics: { lastFrameAgeMs: 10 } } }).state, 'ok', 'back: the incident ends');
  // Graphics stalled while the host answers.
  assert.equal(j.observe({ now: 50_000, ok: true, status: { graphics: { lastFrameAgeMs: 29_999 } } }).state, 'ok');
  const g = j.observe({ now: 55_000, ok: true, status: { graphics: { lastFrameAgeMs: 30_000 } } });
  assert.deepEqual(g, { state: 'stale', reason: 'graphics-stalled', forMs: 30_000, isNew: true });
  assert.equal(j.observe({ now: 56_000, ok: false }).state, 'stale-wait', 'a failed probe inside an incident is not a new one');
  // A host from before D374 (no host.alive, or no graphics field) is judged by its answers only.
  assert.equal(j.observe({ now: 60_000, ok: true, status: null }).state, 'ok');
  assert.equal(j.observe({ now: 61_000, ok: true, status: { graphics: null } }).state, 'ok');
  // A new host: counted from its start, not from the old host's last answer.
  j.reset(100_000);
  assert.equal(j.observe({ now: 129_999, ok: false }).state, 'ok');
  assert.equal(j.observe({ now: 130_000, ok: false }).reason, 'no-answer');
  assert.match(staleText({ reason: 'no-answer', forMs: 30_400 }), /^it did not answer for 30 s$/);
  assert.match(staleText({ reason: 'graphics-stalled', forMs: 31_000 }), /no video frame for 31 s/);
});

function fakeWatch({ flag = false, answers }) {
  let t = 0;
  const logs = []; const acts = [];
  let i = 0;
  const w = createHostWatch({
    cfg: CFG, now: () => t, flagOn: () => flag, log: (m) => logs.push(m),
    probe: async () => { const a = answers(i++, t); if (a instanceof Error) throw a; return a; },
    onStale: async (d) => { acts.push(d); },
  });
  return { w, logs, acts, at: (ms) => { t = ms; }, setFlag: (v) => { flag = v; } };
}

test('watch loop, flag off: one log line per incident and no stop; switched on during the incident it acts once', async () => {
  const dead = new Error('timeout');
  const f = fakeWatch({ answers: (n, t) => (t < 10_000 ? { graphics: { lastFrameAgeMs: 16 } } : dead) });
  for (let t = 0; t <= 60_000; t += 5000) { f.at(t); await f.w.tick(); }
  assert.equal(f.logs.length, 1, f.logs.join('\n'));
  assert.match(f.logs[0], /HOST NOT RESPONDING: it did not answer for 30 s \(flag host-watchdog is off: not restarting it; restart Ujwalam by hand\)/);
  assert.equal(f.acts.length, 0);
  f.setFlag(true);
  f.at(65_000); const r = await f.w.tick();
  assert.equal(r.acted, true);
  f.at(70_000); await f.w.tick();
  assert.equal(f.acts.length, 1, 'once per incident');
  assert.equal(f.logs.length, 1, 'no second log line for the same incident');
  // A new host (restart): a fresh incident can act again.
  f.w.reset();
  for (let t = 75_000; t <= 110_000; t += 5000) { f.at(t); await f.w.tick(); }
  assert.equal(f.acts.length, 2);
  assert.match(f.logs[1], /the host watchdog stops and restarts it$/);
});

test('watch loop, flag on: a graphics stall acts once; a healthy look re-arms; no look while a restart runs; a probe in flight is not doubled', async () => {
  let age = 16;
  const f = fakeWatch({ flag: true, answers: () => ({ graphics: { lastFrameAgeMs: age } }) });
  f.at(1000); await f.w.tick();
  age = 31_000; f.at(2000);
  const r = await f.w.tick();
  assert.deepEqual([r.reason, r.acted], ['graphics-stalled', true]);
  await f.w.tick();
  assert.equal(f.acts.length, 1);
  age = 16; await f.w.tick();
  age = 40_000; await f.w.tick();
  assert.equal(f.acts.length, 2, 'a second freeze after frames came back is a second incident');
  // canCheck false (a restart in progress, or the host already gone): no probe at all.
  let probes = 0;
  const w2 = createHostWatch({ cfg: CFG, canCheck: () => false, probe: async () => { probes++; return {}; }, onStale: async () => {} });
  assert.equal(await w2.tick(), null);
  assert.equal(probes, 0);
  // A slow probe: the next tick does not start a second one; an answer for a host replaced meanwhile is dropped.
  let release;
  const w3 = createHostWatch({ cfg: CFG, flagOn: () => true, probe: () => new Promise((r) => { release = r; probes++; }), onStale: async () => { throw new Error('must not act'); } });
  const p1 = w3.tick();
  assert.equal(await w3.tick(), null);
  w3.reset();
  release({ graphics: { lastFrameAgeMs: 999_999 } });
  assert.equal(await p1, null);
  assert.equal(probes, 1);
});

test('watch loop: the default clock is monotonic; a wall-clock jump never makes a healthy host look silent (Codex review)', async (t) => {
  let fail = false; let acts = 0;
  const w = createHostWatch({ cfg: CFG, flagOn: () => true, probe: async () => { if (fail) throw new Error('timeout'); return { graphics: { lastFrameAgeMs: 16 } }; }, onStale: async () => { acts++; } });
  assert.equal((await w.tick()).state, 'ok');
  const real = Date.now();
  t.mock.method(Date, 'now', () => real + 3_600_000); // the PC clock jumps 1 h ahead (time sync)
  fail = true; // one lost probe right after the jump
  assert.equal((await w.tick()).state, 'ok', 'one failed probe after a clock jump is not 1 h of silence');
  assert.equal(acts, 0);
});

test('watch loop: an old host without host.alive (method not found) counts as answering', async () => {
  const notFound = Object.assign(new Error('method not found'), { code: -32601 });
  const f = fakeWatch({ flag: true, answers: () => notFound });
  for (let t = 0; t <= 120_000; t += 5000) { f.at(t); await f.w.tick(); }
  assert.equal(f.acts.length, 0);
  assert.equal(f.logs.length, 0);
});

test('driver resets: the System log answer is parsed; a failure is null; other systems have none; plain text with the time', async () => {
  const at = new Date(2026, 10, 12, 21, 42, 2).getTime();
  let cmd = '';
  const evs = await driverResets(at - 600_000, at + 1000, { platform: 'win32', run: async (c) => { cmd = c; return `153 ${at}\r\nnoise\r\n4101 ${at - 5000}\r\n`; } });
  assert.deepEqual(evs, [{ id: 4101, at: at - 5000 }, { id: 153, at }]);
  assert.match(cmd, /ProviderName='nvlddmkm','Display'/);
  assert.match(cmd, /\$_\.Id -in 14,153,4101/);
  assert.match(cmd, new RegExp(`FromUnixTimeMilliseconds\\(${at - 600_000}\\)`));
  assert.equal(await driverResets(0, 1, { platform: 'win32', run: async () => { throw new Error('no log'); } }), null);
  assert.deepEqual(await driverResets(0, 1, { platform: 'linux' }), []);
  assert.deepEqual(parseDriverLines('14 1700000000000\n99 1700000000000\n153 abc'), [{ id: 14, at: 1_700_000_000_000 }]);
  assert.equal(driverResetText([]), null);
  assert.equal(driverResetText(evs), 'the graphics driver reset at 21:42 (2 driver reset events)');
  assert.equal(driverResetText([{ id: 153, at }]), 'the graphics driver reset at 21:42');
});

test('incident task: one entry per incident in the task-bar shape, plain words', () => {
  const t = incidentTask({ id: 'host-1', at: 1, kind: 'hung', state: 'running', why: 'It did not answer for 30 s', cause: 'the graphics driver reset at 21:42' });
  const c = cleanTask(t);
  assert.ok(c, 'valid task');
  assert.equal(c.title, 'The video engine froze; restarting it');
  assert.equal(c.note, 'It did not answer for 30 s. Cause: the graphics driver reset at 21:42');
  assert.equal(cleanTask(incidentTask({ id: 'host-1', at: 1, kind: 'crash', state: 'done', result: 'Recording restarted: yes' })).title, 'The video engine stopped; it was restarted');
  assert.equal(cleanTask(incidentTask({ id: 'host-1', at: 1, kind: 'hung', state: 'failed' })).title, 'The video engine froze; it could not be restarted');
});

// ---- launcher end to end (fake host) ----

function launch(name, { flags = {}, hangMode = 'rpc', hangRuns = '1', env: extraEnv = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `ujw-hw-${name}-`));
  const dataDir = path.join(root, 'core');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
  const raw = JSON.parse(readFileSync(HOST_WATCH_FILE, 'utf8'));
  const watchCfg = path.join(root, 'host-watch.json');
  // Short limits so a test takes seconds: look every 300 ms, stale after 2 s.
  writeFileSync(watchCfg, JSON.stringify({ ...raw, checkMs: 500, rpcTimeoutMs: 500, noAnswerMs: 2000, graphicsStallMs: 2000, killWaitMs: 5000, driverLookbackMs: 0 }));
  const rec = path.join(root, 'record.json');
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, readFileSync(path.join(FIX, 'project', 'profile.fixture.json')));
  const loginOut = path.join(root, 'login.json');
  const hangFile = path.join(root, 'hang-now');
  const env = {
    ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_BROWSER: process.execPath, UJWALAM_BROWSER_ARGS: `${path.join(REPO, 'app', 'host', 'tests', 'studio-login.mjs')} ${loginOut}`,
    UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: path.join(root, 'no-overlays'),
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_RUNS: path.join(root, 'runs.txt'), UJWALAM_FAKE_HOST_RECORDING: '1',
    UJWALAM_FAKE_HOST_STREAMS: 'youtube-h:youtube,twitch:twitch',
    UJWALAM_FAKE_HOST_HANG_RUNS: hangRuns, UJWALAM_FAKE_HOST_HANG_ON: hangFile, UJWALAM_FAKE_HOST_HANG_MODE: hangMode,
    UJWALAM_HOST_WATCH_CONFIG: watchCfg,
    UJWALAM_HOST_RESTART_BACKOFF_MS: '200', UJWALAM_HOST_WATCH_MS: '200', UJWALAM_ALPHA_STATS_MS: '60000',
    UJWALAM_HOST_TOKEN: '', UJWALAM_HOST_EXE: '', UJWALAM_HOST_BUILD: '', UJWALAM_LIVE_SESSION: '',
    ...extraEnv,
  };
  const args = [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--alpha', '--mock', '--stop-on-stdin', '--shell', 'browser',
    '--data-dir', dataDir, '--host-exe', path.join(FIX, 'studio-ui', 'fake-host.mjs'), '--profile', profile, '--feedback-dir', path.join(root, 'feedback')];
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const s = { root, dataDir, child, out: '', code: null, port: 0, cookie: '', csrf: '' };
  child.stdout.on('data', (d) => { s.out += d; });
  child.stderr.on('data', (d) => { s.out += d; });
  s.exited = new Promise((r) => child.on('exit', (c) => { s.code = c; r(c); }));
  s.calls = () => { try { return readFileSync(`${rec}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  s.hang = () => writeFileSync(hangFile, 'x');
  s.crashes = () => { try { return readFileSync(path.join(dataDir, 'logs', 'host-crashes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  s.tasks = () => { try { return readdirSync(path.join(dataDir, 'tasks')).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(path.join(dataDir, 'tasks', n), 'utf8'))).filter((t) => t.kind === 'host'); } catch { return []; } };
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
  // The control page's own Start stream click (D332: one click acts).
  s.goLive = async () => {
    const r = await s.req('POST', '/ui/api/host', { method: 'stream.start', params: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verdict, 'allow', JSON.stringify(r.body));
    await sleep(800); // the launcher's outputs.status poll (200 ms here) must have seen the streams live
  };
  s.stop = async () => {
    if (s.code === null) { s.child.stdin.end(); await Promise.race([s.exited, sleep(20_000)]); }
    if (s.code === null) s.child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  };
  return s;
}

const streamStarts = (s) => s.calls().filter((x) => x.method === 'stream.start');

test('frozen host while live (watchdog + stream recovery on): stopped, restarted, recording and the live streams back, one task', { timeout: 180_000 }, async () => {
  const s = launch('live', { flags: { 'host-watchdog': true, 'stream-recovery': true } });
  try {
    await s.login();
    await s.goLive();
    s.hang();
    await s.until(() => /streams restarted: YouTube H, Twitch/.test(s.out), 'the stream recovery line');
    assert.match(s.out, /HOST NOT RESPONDING: it did not answer for \d+ s; the host watchdog stops and restarts it/);
    assert.match(s.out, /HOST EXITED UNEXPECTEDLY \(stopped by the host watchdog: it did not answer for \d+ s\); restart 1 of 3 in 200 ms; recording was on \(record\); streams were on \(youtube-h, twitch\)/);
    assert.equal((s.out.match(/HOST NOT RESPONDING/g) ?? []).length, 1, 'logged once');
    const c = s.calls();
    assert.deepEqual(c.filter((x) => x.event === 'start').map((x) => x.run), [1, 2], 'one restart');
    assert.deepEqual(c.filter((x) => x.event === 'hang').map((x) => x.run), [1]);
    assert.deepEqual(c.filter((x) => x.method === 'record.start').map((x) => x.run), [2], 'recording restarted in the new host');
    assert.deepEqual(streamStarts(s).map((x) => [x.run, x.params]), [[1, {}], [2, { sinks: ['youtube-h', 'twitch'] }]], 'exactly the streams that were live');
    await s.until(() => s.crashes().some((x) => x.action === 'restarted'), 'the restarted line in the crash log');
    const cr = s.crashes();
    const h = cr.find((x) => x.action === 'hung');
    assert.ok(h, JSON.stringify(cr));
    assert.equal(h.reason, 'no-answer');
    assert.deepEqual(h.streams, ['youtube-h', 'twitch']);
    assert.deepEqual(cr.map((x) => x.action).filter((a) => a !== 'gpu-reset'), ['hung', 'restart', 'restarted']);
    await s.until(() => s.tasks().some((t) => t.state === 'done'), 'the incident task');
    const tasks = s.tasks();
    assert.equal(tasks.length, 1, 'one task-bar entry for the incident');
    assert.equal(tasks[0].title, 'The video engine froze; it was restarted');
    assert.match(tasks[0].note, /^It did not answer for \d+ s\. Recording restarted: yes, in a new file; streams restarted: YouTube H, Twitch$/);
    assert.ok(!/[0-9a-f]{64}/.test(s.out), 'no token-shaped value printed');
  } finally { await s.stop(); }
});

test('graphics stalled (host still answering), watchdog on, stream recovery off: restarted, recording back, no stream started', { timeout: 180_000 }, async () => {
  const s = launch('gfx', { flags: { 'host-watchdog': true }, hangMode: 'graphics' });
  try {
    await s.login();
    await s.goLive();
    s.hang();
    await s.until(() => /host restarted \(attempt 1\)/.test(s.out) && s.crashes().some((x) => x.action === 'restarted'), 'the restart');
    assert.match(s.out, /HOST NOT RESPONDING: its graphics produced no video frame for \d+ s; the host watchdog stops and restarts it/);
    assert.match(s.out, /stopped by the host watchdog: its graphics produced no video frame/);
    assert.deepEqual(s.calls().filter((x) => x.method === 'record.start').map((x) => x.run), [2]);
    assert.deepEqual(streamStarts(s).map((x) => x.run), [1], 'never a stream start by the watchdog: stream recovery is off');
    assert.match(s.out, /streams youtube-h, twitch are NOT running|streams YouTube H, Twitch are NOT running/);
    assert.equal(s.crashes().find((x) => x.action === 'hung').reason, 'graphics-stalled');
  } finally { await s.stop(); }
});

test('a slow restore does not count as silence: the liveness window starts after the restore (Codex review)', { timeout: 180_000 }, async () => {
  // The restore's stream.start takes 2.5 s (longer than noAnswerMs 2 s; no checks run meanwhile), and the new host's
  // first host.alive is lost. Counted from the host's start that would be 3 s of silence and a second, false restart;
  // counted from the end of the restore it is one lost probe.
  const s = launch('slow', { flags: { 'host-watchdog': true, 'stream-recovery': true }, env: { UJWALAM_FAKE_HOST_START_DELAY_MS: '2500', UJWALAM_FAKE_HOST_ALIVE_DROP_RUNS: '2' } });
  try {
    await s.login();
    await s.goLive();
    s.hang();
    await s.until(() => s.crashes().some((x) => x.action === 'restarted'), 'the restore', 90_000);
    await s.until(() => s.calls().some((x) => x.run === 2 && x.event === 'alive-dropped'), 'the lost probe');
    await sleep(4000); // two noAnswerMs windows after the restore
    assert.deepEqual(s.calls().filter((x) => x.event === 'start').map((x) => x.run), [1, 2], `one restart only\n${s.out}`);
    assert.equal((s.out.match(/HOST NOT RESPONDING/g) ?? []).length, 1);
    assert.deepEqual(streamStarts(s).map((x) => x.run), [1, 2]);
  } finally { await s.stop(); }
});

test('frozen host with the watchdog off: logged once, never stopped or restarted', { timeout: 120_000 }, async () => {
  const s = launch('off', { flags: {} });
  try {
    await s.until(() => s.calls().some((x) => x.event === 'start'), 'the host start');
    await s.until(() => /\[studio\] UI at /.test(s.out), 'the launcher ready');
    s.hang();
    await s.until(() => /HOST NOT RESPONDING/.test(s.out), 'the log line');
    await sleep(5000); // more than twice noAnswerMs
    assert.match(s.out, /HOST NOT RESPONDING: it did not answer for \d+ s \(flag host-watchdog is off: not restarting it; restart Ujwalam by hand\)/);
    assert.equal((s.out.match(/HOST NOT RESPONDING/g) ?? []).length, 1);
    assert.deepEqual(s.calls().filter((x) => x.event === 'start').map((x) => x.run), [1], 'no restart');
    assert.ok(!/HOST EXITED UNEXPECTEDLY/.test(s.out));
    assert.equal(s.tasks().length, 0, 'no task-bar entry with the flag off');
  } finally { await s.stop(); }
});
