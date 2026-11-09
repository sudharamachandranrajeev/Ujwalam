// SPDX-License-Identifier: GPL-3.0-or-later
// Simulated audio failures with the SHIPPED watchdog numbers (data/audio/health.json as services/studio-ui/launch.mjs
// passes them: noDataMs 5000, checkIntervalMs 1000, maxRecreates 3, maxParked 12, shutdownGuardMs 20000), against a
// real host (libobs, test card, no devices, no previews, headless) and the real readiness check
// (services/studio-ui/readiness.mjs runReadiness, every other probe faked). host-audio-health.test.mjs proves the same
// mechanics with small, fast numbers; this file proves the numbers the alpha runs with
// (docs/evidence/2026-11-09-failure-sims-and-clipmaker-check.md).
//   1. no data for noDataMs: "missing" no earlier than noDataMs after the last packet, no later than one check later
//   2. recreates exhausted: replacements that never send, 3 restarts, then "gave-up" (restarts did not help)
//   3. parked limit: the 12th parked source fills the limit; the next missing source is not restarted at all
//   4. readiness: audio passes while sources send and fails, naming them, once they are missing
//   5. (host-audio-failsim-guard.test.mjs, a separate file so the 20 s wait runs beside this file's, D276)
// Faults come only from --test-hooks methods (audio.testAdd/testStall/testCreate/testHangDestroy), which a host
// started without --test-hooks refuses (FORBIDDEN); the fake source type is registered only with --test-hooks.
//   node --test app/host/tests/host-audio-failsim.test.mjs   (needs the built host and the OBS runtime; ~1 min)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { loadAudioHealth } from '../../../services/studio-ui/launch.mjs';
import { loadReadinessConfig, runReadiness } from '../../../services/studio-ui/readiness.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const PROJECT = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const HEADLESS = { UJWALAM_HEADLESS: '1' };
const SHIPPED = loadAudioHealth(); // exactly what the alpha launcher writes into the host config
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h, c, DATA;

async function until(fn, ms, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}
const health = async (client = c) => (await client.call('host.status', {})).audioHealth;
const src = (ah, id) => ah.sources.find((s) => s.id === id);
const kindsOf = (ah, id, since = 0) => ah.events.filter((e) => e.id === id && e.seq > since).map((e) => e.kind);
function hostLog(dir) {
  const logs = path.join(dir, 'logs');
  const f = readdirSync(logs).filter((n) => /^host-.*\.log$/.test(n)).sort().pop();
  return readFileSync(path.join(logs, f), 'utf8');
}
function hostConfig(dir, audioHealth) {
  const f = path.join(dir, 'host-config.json');
  writeFileSync(f, JSON.stringify({ audioHealth }, null, 2));
  return f;
}
// One cycle of the watchdog with the shipped numbers: a restart attempt waits noDataMs, the tick runs every
// checkIntervalMs; slack for a loaded test machine.
const CYCLE = SHIPPED.noDataMs + SHIPPED.checkIntervalMs;
const GB = 1024 ** 3;
// Readiness with the real config and the real host; every system probe is a passing fake (only audio is under test).
const readiness = (host) => runReadiness({
  host, config: loadReadinessConfig(), flagOn: () => false, store: () => ({ get: async () => '' }),
  listProcesses: async () => [], diskFree: () => 500 * GB, tcp: async () => false, botPorts: {},
  ciPass: async () => null, clipTools: () => ({ py: 'python.exe' }), planTargets: [],
});
const audioItem = async (host = c) => (await readiness(host)).items.find((i) => i.id === 'audio');

before(async () => {
  assert.deepEqual(SHIPPED, { enabled: true, noDataMs: 5000, checkIntervalMs: 1000, maxRecreates: 3, maxParked: 12, shutdownGuardMs: 20000 },
    'data/audio/health.json changed: update this test and the evidence doc with the new numbers');
  mkdirSync(OUT, { recursive: true });
  DATA = mkdtempSync(path.join(OUT, 'audio-failsim-'));
  h = await launchHost({ dataDir: DATA, project: PROJECT, extraArgs: ['--host-config', hostConfig(DATA, SHIPPED), '--test-hooks'], env: HEADLESS, timeoutMs: 60000 });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h, 60000);
  assert.equal(r.code, 0, 'host exits 0 with 12 parked sources (none of them hangs)');
});

test('shipped numbers reach the host; sources that send pass readiness', async () => {
  const ah = await health();
  assert.deepEqual(ah.watchdog, { noDataMs: 5000, recreate: true, maxRecreates: 3, parked: 0, maxParked: 12, parkedFull: false });
  for (const id of ['game', 'mic', 'aux1', 'aux2', 'aux3']) await c.call('audio.testAdd', { id, name: id === 'game' ? 'Game' : id === 'mic' ? 'Mic' : id.toUpperCase() });
  assert.ok(await until(async () => (await health()).sources.every((s) => s.state === 'ok'), 10000), 'all five send');
  const a = await audioItem();
  assert.equal(a.status, 'pass', a.message);
  assert.equal(a.message, '5 audio source(s) working.');
  assert.match(hostLog(DATA), /audio health: watchdog on \(no data 5000 ms, check 1000 ms, max 3 restarts per source, 12 parked per run; shutdown guard 20000 ms\)/);
});

test('no data for noDataMs, then 3 restarts that never send, then gave-up; readiness fails and names the sources', async () => {
  await c.call('audio.testCreate', { mode: 'silent' }); // every replacement is created but never sends
  const ids = ['game', 'mic', 'aux1'];
  const seq0 = (await health()).seq;
  const t0 = Date.now();
  for (const id of ids) await c.call('audio.testStall', { id, stall: true });
  // 1) missing: not before noDataMs after the last packet, and within one check (plus slack) after it
  const miss = await until(async () => { const a = await health(); return ids.every((id) => kindsOf(a, `audio:${id}`, seq0).includes('missing')) ? a : null; }, CYCLE + 3000, 50);
  const tMissing = Date.now() - t0;
  assert.ok(miss, 'all three reported missing');
  assert.ok(tMissing >= SHIPPED.noDataMs - 100, `missing after ${tMissing} ms (noDataMs ${SHIPPED.noDataMs})`);
  assert.ok(tMissing <= SHIPPED.noDataMs + SHIPPED.checkIntervalMs + 2000, `missing after ${tMissing} ms`);
  assert.deepEqual(miss.warnings.slice().sort(), ['AUX1 audio missing', 'Game audio missing', 'Mic audio missing']);
  // readiness while they are missing (a restart that has not delivered is still missing)
  const r1 = await audioItem();
  assert.equal(r1.status, 'fail', r1.message);
  for (const n of ['Game (missing)', 'Mic (missing)', 'AUX1 (missing)']) assert.ok(r1.message.includes(n), r1.message);
  // 2) one restart per noDataMs, 3 in all, then gave-up with the per-source text
  const gave = await until(async () => { const a = await health(); return ids.every((id) => kindsOf(a, `audio:${id}`, seq0).includes('gave-up')) ? a : null; }, 4 * CYCLE + 10000);
  assert.ok(gave, 'all three gave up');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 4 * SHIPPED.noDataMs - 500, `gave up after ${elapsed} ms: missing + 3 attempts one noDataMs apart`);
  for (const id of ids) {
    assert.deepEqual(kindsOf(gave, `audio:${id}`, seq0), ['missing', 'recreated', 'recreated', 'recreated', 'gave-up'], id);
    const s = src(gave, `audio:${id}`);
    assert.equal(s.recreates, 3);
    assert.equal(s.state, 'missing');
    assert.equal(s.receiving, false);
    assert.match(gave.events.filter((e) => e.id === `audio:${id}`).at(-1).text, /audio missing: restarts did not help; check the device$/);
  }
  assert.equal(gave.watchdog.parked, 9);
  assert.equal(gave.watchdog.parkedFull, false);
  assert.equal(gave.ok, false);
  assert.match(hostLog(DATA), /audio watchdog: Game audio missing after 3 restarts; not trying again/);
  await sleep(CYCLE);
  assert.equal(src(await health(), 'audio:game').recreates, 3, 'no fourth restart');
  const r2 = await audioItem();
  assert.equal(r2.status, 'fail');
  assert.match(r2.message, /^Not working: /);
});

test('parked limit: the 12th parked source fills it; the next missing source is not restarted', async () => {
  // aux2: 3 more restarts (parked 9 -> 12); its next attempt meets the full limit
  const seq0 = (await health()).seq;
  await c.call('audio.testStall', { id: 'aux2', stall: true });
  const full = await until(async () => { const a = await health(); return kindsOf(a, 'audio:aux2', seq0).includes('gave-up') ? a : null; }, 4 * CYCLE + 10000);
  assert.ok(full, 'aux2 gave up');
  assert.deepEqual(kindsOf(full, 'audio:aux2', seq0), ['missing', 'recreated', 'recreated', 'recreated', 'gave-up']);
  assert.equal(full.watchdog.parked, 12);
  assert.equal(full.watchdog.parkedFull, true);
  // the limit is checked before the per-source count: aux2's gave-up already says "too many restarts in this run"
  assert.equal(full.events.filter((e) => e.id === 'audio:aux2').at(-1).text, 'AUX2 audio missing: too many restarts in this run; restart Ujwalam after the stream');
  // aux3 dies with a working create mode: it would recover, but the limit stops any restart
  await c.call('audio.testCreate', { mode: 'ok' });
  const seq1 = full.seq;
  await c.call('audio.testStall', { id: 'aux3', stall: true });
  const stop = await until(async () => { const a = await health(); return kindsOf(a, 'audio:aux3', seq1).includes('gave-up') ? a : null; }, CYCLE + 5000);
  assert.ok(stop, 'aux3 gave up at once');
  assert.deepEqual(kindsOf(stop, 'audio:aux3', seq1), ['missing', 'gave-up']);
  assert.equal(src(stop, 'audio:aux3').recreates, 0);
  assert.equal(stop.watchdog.parked, 12, 'never above maxParked');
  assert.equal(stop.events.at(-1).text, 'AUX3 audio missing: too many restarts in this run; restart Ujwalam after the stream');
  assert.match(hostLog(DATA), /12 replaced sources are parked \(limit 12 for this run\): not restarting any more/);
  const r = await audioItem();
  assert.equal(r.status, 'fail');
  assert.ok(r.message.includes('AUX3 (missing)'), r.message);
});

test('audio.testHangDestroy is refused without --test-hooks and for an unknown source', async () => {
  const d = mkdtempSync(path.join(OUT, 'audio-failsim-nohooks-'));
  const g = await launchHost({ dataDir: d, project: PROJECT, extraArgs: [], env: HEADLESS, timeoutMs: 60000 });
  try {
    await assert.rejects(g.client.call('audio.testHangDestroy', { id: 'game' }), (e) => e.code === -32001);
  } finally {
    assert.equal((await stopHost(g, 40000)).code, 0);
  }
  await assert.rejects(c.call('audio.testHangDestroy', { id: 'nope' }), (e) => e.code === -32602);
});
