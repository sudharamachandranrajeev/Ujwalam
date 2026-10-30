// SPDX-License-Identifier: GPL-2.0-or-later
// Power/load capture for soak runs, and the duration regression (P3 E7). Synthetic export, temp data root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../tools/soak/replay.mjs';
import { assessSample, createSystemSampler, summariseSystem } from '../tools/soak/system-probe.mjs';
import { closeAllMocks, openMocks } from '../tools/mock/mock-streamerbot.mjs';
import { openChildren, stopTracked } from '../tools/proc-registry.mjs';

const dirs = [];
// Teardown runs even when a test failed or timed out: kill any child still registered, close any mock, then assert none are left.
test.after(async () => {
  const killed = await stopTracked(); const closed = await closeAllMocks();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  assert.equal(openMocks() + openChildren(), 0, 'a mock or child process was left open');
  assert.equal(killed + closed, 0, `teardown had to clean up ${killed} child(ren) and ${closed} mock(s): a test did not clean up after itself`);
});
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evsys-')); dirs.push(d); return d; };
const comment = (id, off, body) => ({ _id: id, content_offset_seconds: off, commenter: { _id: 'c-t', name: 'tester', display_name: 'tester' }, message: { body } });
const exportRoot = (comments) => {
  const root = tmp();
  mkdirSync(path.join(root, 'chat', 'twitch'), { recursive: true });
  writeFileSync(path.join(root, 'chat', 'twitch', 'x.json'), JSON.stringify({ video: { length: 9000 }, comments }));
  return root;
};

// Regression: the first 2 h soak stopped at 6463 s of a planned 7200 s because the play loop ended after the last message
// that fell inside the window and nothing waited for the rest of the duration. A duration run lasts the duration.
test('a duration run lasts the whole duration even when its last message comes much earlier', { timeout: 300000 }, async () => {
  const root = exportRoot([comment('r1', 10, 'synthetic one'), comment('r2', 11, 'synthetic two')]);
  const r = await main(['--data-root', root, '--speed', '10', '--no-loop', '--duration-s', '6', '--sample-s', '1', '--run-id', 'idle', '--quiet', '--no-system-probe']);
  assert.equal(r.harness.sent, 2, 'both messages are inside the window');
  assert.ok(r.wallSeconds >= 6, `wall ${r.wallSeconds} s must reach the 6 s duration`);
  assert.equal(r.system.status, 'NOT RECORDED', 'the probe can be switched off and then says so');
});

test('a replay records power and system load, and leaves no mock process behind', { timeout: 300000 }, async () => {
  const root = exportRoot([comment('p1', 10, 'synthetic one'), comment('p2', 11, 'synthetic two')]);
  const r = await main(['--data-root', root, '--speed', '10', '--max-gap-s', '0.5', '--duration-s', '3', '--sample-s', '1', '--run-id', 'sys', '--quiet']);
  assert.ok(r.system.samples >= 3 && ['QUIET', 'NOISY'].includes(r.system.status));
  assert.ok(['ac', 'ac (no battery)', 'battery', 'unknown'].includes(r.system.powerStart));
  const rows = readFileSync(path.join(root, 'soak', 'sys', 'metrics', 'system.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].kind, 'start');
  assert.equal(rows.at(-1).kind, 'end');
  assert.deepEqual(r.strayProcesses.filter((p) => p.script.endsWith('mock-streamerbot.mjs') && p.ageMin < 2), [], 'the run left no mock behind');
});

test('system probe: battery or high load marks a sample noisy with the bench thresholds; the summary counts them', async () => {
  assert.deepEqual(assessSample({ kind: 'start', cpuPct: 9, power: 'ac' }), { noisy: false, reasons: [] });
  assert.equal(assessSample({ kind: 'start', cpuPct: 11, power: 'ac' }).noisy, true);   // before start: limit 10
  assert.equal(assessSample({ kind: 'tick', cpuPct: 14, power: 'ac' }).noisy, false);   // during: limit 15
  assert.equal(assessSample({ kind: 'tick', cpuPct: 16, power: 'ac' }).noisy, true);
  assert.match(assessSample({ kind: 'tick', cpuPct: 1, power: 'battery' }).reasons[0], /battery/);
  assert.deepEqual(summariseSystem([]), { samples: 0, status: 'NOT RECORDED' });

  const file = path.join(tmp(), 'system.jsonl');
  const load = [5, 10, 80, 12];
  let call = 0;
  const s = createSystemSampler({
    file, everyMs: 20, powerEveryMs: 1e9,
    probes: { power: () => 'ac', cpuSnap: () => ({ call }), cpuPct: () => load[Math.min(call++, load.length - 1)], idleMs: 5, procSnapshot: async () => null },
  });
  await s.start();
  while (s.rows.length < 3) await new Promise((r) => setTimeout(r, 10));
  const sum = await s.stop();
  assert.equal(sum.status, 'NOISY');
  assert.equal(sum.powerStart, 'ac');
  assert.equal(sum.cpuBeforePct, 5);
  assert.ok(sum.noisySamples >= 1 && sum.cpuPctMax === 80);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].kind, 'start');
  assert.equal(lines.at(-1).kind, 'end');
  assert.ok(lines.every((l) => 'power' in l && 'cpuPct' in l && 'noisy' in l));
});

test('system probe: battery power during the run is carried into the summary', async () => {
  const s = createSystemSampler({ everyMs: 1e6, powerEveryMs: 1e9, probes: { power: () => 'battery', cpuSnap: () => ({}), cpuPct: () => 3, idleMs: 1, procSnapshot: async () => null } });
  await s.start();
  const sum = await s.stop();
  assert.equal(sum.status, 'NOISY');
  assert.equal(sum.powerEnd, 'battery');
});

test('system probe: a known heavy process (shared list with the bench) marks the sample noisy and is named in the summary', async () => {
  const SEC = 1e7; let ts = 0; let ticks = 0;
  // 16 cores; MsMpEng uses 8 % of the machine (1.28 cores) between snapshots, node is busy but not on the list
  const procSnapshot = async () => { ts += 10 * SEC; ticks += 1.28 * 10 * SEC; return { ts, procs: { MsMpEng: ticks, node: ticks * 10 } }; };
  const s = createSystemSampler({ everyMs: 1e6, powerEveryMs: 1e9, probes: { power: () => 'ac', cpuSnap: () => ({}), cpuPct: () => 3, idleMs: 1, procSnapshot, cores: 16 } });
  await s.start();
  const sum = await s.stop();
  assert.equal(sum.status, 'NOISY');
  assert.deepEqual(sum.heavyProcesses, ['MsMpEng']);
  assert.match(sum.reasons[0], /MsMpEng \(Windows Defender\) uses 8 % CPU/);
  assert.equal(s.rows[0].noisy, true);
});

test('system probe: no process data (snapshot unavailable) is not noisy', async () => {
  const s = createSystemSampler({ everyMs: 1e6, powerEveryMs: 1e9, probes: { power: () => 'ac', cpuSnap: () => ({}), cpuPct: () => 3, idleMs: 1, procSnapshot: async () => null } });
  await s.start();
  assert.equal((await s.stop()).status, 'QUIET');
});
