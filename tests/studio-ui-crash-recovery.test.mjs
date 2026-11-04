// SPDX-License-Identifier: GPL-3.0-or-later
// Alpha 0 day 3 crash recovery (services/studio-ui/launch.mjs): restart policy (bounded backoff, at most 3 restarts in
// 5 min), which sinks count as running, and the launcher end to end with the fake host simulating crashes (no
// libobs, no devices, mock Streamer.bot): restart, project reload, recording resumed in a new file, restart marker,
// crash log, give-up after the limit with a diagnostics bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSinks, HOST_RESTART_BACKOFF_MS, HOST_RESTART_MAX, HOST_RESTART_WINDOW_MS, restartPolicy } from '../services/studio-ui/launch.mjs';
import { readZip } from '../tools/package/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'tests', 'fixtures');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-crash-${p}-`));

test('restart policy: 3 restarts in 5 min with 2/5/10 s backoff, the 4th exit gives up; old exits age out', () => {
  assert.equal(HOST_RESTART_MAX, 3);
  assert.equal(HOST_RESTART_WINDOW_MS, 300_000);
  const p = restartPolicy();
  const t0 = 1_000_000;
  assert.deepEqual(p.onExit(t0), { restart: true, attempt: 1, max: 3, delayMs: HOST_RESTART_BACKOFF_MS[0] });
  assert.equal(p.onExit(t0 + 10_000).delayMs, 5000);
  assert.equal(p.onExit(t0 + 20_000).delayMs, 10_000);
  const four = p.onExit(t0 + 30_000);
  assert.equal(four.restart, false);
  assert.equal(four.exits, 4);
  // A fresh policy: exits more than 5 min apart never add up.
  const q = restartPolicy();
  for (let i = 0; i < 10; i++) assert.equal(q.onExit(t0 + i * 301_000).restart, true, `exit ${i}`);
  // Exactly at the window edge the oldest still counts; past it, it is dropped.
  const r = restartPolicy();
  r.onExit(0); r.onExit(1000); r.onExit(2000);
  assert.equal(r.onExit(300_000).restart, false);
  const s = restartPolicy();
  s.onExit(0); s.onExit(1000); s.onExit(2000);
  assert.equal(s.onExit(300_001).restart, true);
});

test('active sinks: starting, live and retrying count; idle, stopping, stopped, failed do not; kinds are separate', () => {
  const o = { sinks: [
    { id: 'rec', kind: 'record', state: 'live' }, { id: 'rec2', kind: 'record', state: 'stopped' },
    { id: 'yt', kind: 'stream', state: 'retrying' }, { id: 'tw', kind: 'stream', state: 'starting' },
    { id: 'kk', kind: 'stream', state: 'failed' }, { id: 'x', kind: 'stream', state: 'idle' }, { kind: 'record', state: 'live' },
  ] };
  assert.deepEqual(activeSinks(o, 'record'), ['rec']);
  assert.deepEqual(activeSinks(o, 'stream'), ['yt', 'tw']);
  assert.deepEqual(activeSinks(null, 'record'), []);
  assert.deepEqual(activeSinks({ sinks: 'bad' }, 'stream'), []);
});

function runLauncher(extra, env, until) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--alpha', '--mock', '--no-open', '--stop-on-stdin', ...extra], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let ended = false;
    const t = setTimeout(() => { child.kill(); reject(new Error(`launcher timed out:\n${out}`)); }, 120_000);
    // Stop 1 s after `until` matches (the restart path writes its snapshot after the status lines).
    child.stdout.on('data', (d) => { out += d; if (!ended && until && until(out)) { ended = true; setTimeout(() => child.stdin.end(), 1000); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

function setup(name) {
  const root = tmp(name);
  const dataDir = path.join(root, 'core');
  const rec = path.join(root, 'record.json');
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, readFileSync(path.join(FIX, 'project', 'profile.fixture.json')));
  const env = {
    UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), UJWALAM_OVERLAY_ROOT: path.join(root, 'no-overlays'),
    UJWALAM_FAKE_HOST_RECORD: rec, UJWALAM_FAKE_HOST_RUNS: path.join(root, 'runs.txt'), UJWALAM_FAKE_HOST_RECORDING: '1',
    UJWALAM_FAKE_HOST_CRASH_MS: '1500', UJWALAM_HOST_RESTART_BACKOFF_MS: '200', UJWALAM_HOST_WATCH_MS: '200', UJWALAM_ALPHA_STATS_MS: '60000',
  };
  const args = ['--data-dir', dataDir, '--host-exe', path.join(FIX, 'studio-ui', 'fake-host.mjs'), '--profile', profile, '--feedback-dir', path.join(root, 'feedback')];
  const calls = () => readFileSync(`${rec}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const crashes = () => readFileSync(path.join(dataDir, 'logs', 'host-crashes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { root, dataDir, rec, env, args, calls, crashes };
}

test('launcher restarts a crashed host twice, reloads the project, resumes the recording in a new file and writes a marker', { timeout: 180_000 }, async () => {
  const s = setup('restart');
  try {
    const r = await runLauncher(s.args, { ...s.env, UJWALAM_FAKE_HOST_CRASH_RUNS: '1,2' }, (out) => /\[studio\] replay buffer:/.test(out.split('host restarted (attempt 2)')[1] ?? ''));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /HOST EXITED UNEXPECTEDLY \(code 3\); restart 1 of 3 in 200 ms; recording was on \(record\)/);
    assert.match(r.out, /HOST EXITED UNEXPECTEDLY \(code 3\); restart 2 of 3 in 200 ms; recording was on \(record\)/);
    assert.match(r.out, /recording started again in a new file \(record\)/);
    assert.ok(!/HOST CRASHED/.test(r.out));
    assert.ok(!/[0-9a-f]{64}/.test(r.out), 'no token-shaped value printed');
    const c = s.calls();
    const starts = c.filter((x) => x.event === 'start').map((x) => x.run);
    assert.deepEqual(starts, [1, 2, 3], 'three host runs');
    assert.deepEqual(c.filter((x) => x.event === 'crash').map((x) => x.run), [1, 2]);
    const recStarts = c.filter((x) => x.method === 'record.start');
    assert.deepEqual(recStarts.map((x) => x.run), [2, 3], 'recording started again after each restart');
    for (const x of recStarts) assert.deepEqual(x.params, { sinks: ['record'] });
    const markers = c.filter((x) => x.method === 'marker.add');
    assert.deepEqual(markers.map((x) => x.run), [2, 3]);
    for (const m of markers) {
      assert.equal(m.params.source, 'api');
      assert.match(m.params.note, /^host restarted after an unexpected exit \(code 3\); restart [12] of 3; recording resumed: record; streams to restart by hand: none$/);
      assert.ok(m.params.note.length <= 500);
    }
    const h = JSON.parse(readFileSync(s.rec, 'utf8'));
    assert.equal(h.run, 3);
    assert.ok(h.calls.includes('project.load'), 'the project was loaded into the restarted host');
    const cr = s.crashes();
    assert.deepEqual(cr.map((x) => x.action), ['restart', 'restarted', 'restart', 'restarted']);
    assert.deepEqual(cr[0].recording, ['record']);
    assert.equal(cr[0].exit, 'code 3');
    const snap = JSON.parse(readFileSync(path.join(s.dataDir, 'logs', 'host-snapshot.json'), 'utf8'));
    assert.equal(snap.info.run, 3);
    assert.ok(!JSON.stringify(snap.outputs).includes('C:/fake/rec.mkv'), 'snapshot outputs carry no file path');
    assert.equal(readdirSync(path.join(s.dataDir, 'logs')).filter((n) => /^host-.*\.log$/.test(n)).length, 3, 'one host log per run');
  } finally {
    rmSync(s.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('launcher gives up after the 4th unexpected exit in 5 min: exit code 3, crash log, diagnostics bundle', { timeout: 180_000 }, async () => {
  const s = setup('giveup');
  try {
    const r = await runLauncher(s.args, { ...s.env, UJWALAM_FAKE_HOST_CRASH_RUNS: '1,2,3,4,5', UJWALAM_FAKE_HOST_CRASH_MS: '800' });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /HOST CRASHED 4 times in 5 min \(last exit code 3\); not restarting again\. Stopping\./);
    const c = s.calls();
    assert.deepEqual(c.filter((x) => x.event === 'start').map((x) => x.run), [1, 2, 3, 4], 'no 5th start');
    const cr = s.crashes();
    assert.equal(cr.filter((x) => x.action === 'restart').length, 3);
    assert.equal(cr.at(-1).action, 'gave-up');
    const diagDir = path.join(s.dataDir, 'diag');
    const zips = existsSync(diagDir) ? readdirSync(diagDir).filter((n) => n.endsWith('.zip')) : [];
    assert.equal(zips.length, 1, r.out);
    const names = readZip(path.join(diagDir, zips[0])).map((e) => e.name);
    for (const n of ['manifest.json', 'versions.json', 'gpu.txt', 'host-crashes.jsonl']) assert.ok(names.includes(n), `${n} in ${names}`);
    assert.ok(names.some((n) => /^logs\/host-.*\.log$/.test(n)));
  } finally {
    rmSync(s.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the launcher\'s own stop is not a crash; a host that exits 0 by itself ends the session without a restart', { timeout: 120_000 }, async () => {
  const s = setup('clean');
  try {
    mkdirSync(path.join(s.root, 'feedback'), { recursive: true });
    let r = await runLauncher(s.args, s.env, (out) => /\[studio\] UI at /.test(out));
    assert.equal(r.code, 0, r.out);
    assert.ok(!/HOST EXITED UNEXPECTEDLY|HOST CRASHED/.test(r.out));
    assert.deepEqual(s.calls().filter((x) => x.event === 'start').map((x) => x.run), [1]);
    assert.ok(!existsSync(path.join(s.dataDir, 'logs', 'host-crashes.jsonl')));

    r = await runLauncher(s.args, { ...s.env, UJWALAM_FAKE_HOST_EXIT0_MS: '1500' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /the host shut itself down \(code 0\): ending the session/);
    assert.ok(!/HOST EXITED UNEXPECTEDLY/.test(r.out));
    assert.deepEqual(s.calls().filter((x) => x.event === 'start').map((x) => x.run), [1, 2], 'no restart after a clean exit');
    assert.deepEqual(s.crashes().map((x) => x.action), ['session-ended']);
  } finally {
    rmSync(s.root, { recursive: true, force: true, maxRetries: 5 });
  }
});
