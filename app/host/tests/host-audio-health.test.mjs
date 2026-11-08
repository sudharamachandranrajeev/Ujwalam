// SPDX-License-Identifier: GPL-3.0-or-later
// Audio health (D297 proposed; docs/evidence/2026-11-08-game-audio-loss.md) against a real host: libobs, test card,
// no devices, no previews, headless. A device audio source is simulated by the host's ujw_test_audio type
// (--test-hooks; audio.testAdd) and a dead device by audio.testStall (the instance stops sending packets, as the game
// audio WASAPI source did after its work queue died). Checked: the RTWQ reference is held, the readiness view
// (host.status audioHealth, mixer.list receiving), the watchdog's missing -> recreated -> recovered cycle on the same
// output channel, the give-up after maxRecreates with the "Game audio missing" warning, report-only and unconfigured
// hosts, and the host config checks.
//   node --test app/host/tests/host-audio-health.test.mjs   (needs the built host and the OBS runtime)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const PROJECT = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const HEADLESS = { UJWALAM_HEADLESS: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEALTH = { enabled: true, noDataMs: 1000, checkIntervalMs: 200, maxRecreates: 2, shutdownGuardMs: 20000 };
let h, c, DATA;

async function until(fn, ms = 15000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}
async function rpcErr(method, params, client) {
  try { await client.call(method, params); } catch (e) { return e; }
  assert.fail(`${method} should have failed`);
}
const health = async (client = c) => (await client.call('host.status', {})).audioHealth;
const src = (ah, id) => ah.sources.find((s) => s.id === id);
function hostLog(dir) {
  const logs = path.join(dir, 'logs');
  const f = readdirSync(logs).filter((n) => /^host-.*\.log$/.test(n)).sort().pop();
  return readFileSync(path.join(logs, f), 'utf8');
}
function config(dir, name, cfg) {
  const f = path.join(dir, name);
  writeFileSync(f, JSON.stringify(cfg, null, 2));
  return f;
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  DATA = mkdtempSync(path.join(OUT, 'audio-health-'));
  const f = config(DATA, 'host-config.json', { audioHealth: HEALTH });
  h = await launchHost({ dataDir: DATA, project: PROJECT, extraArgs: ['--host-config', f, '--test-hooks'], env: HEADLESS, timeoutMs: 60000 });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h, 40000);
  assert.equal(r.code, 0, 'host exits 0 (parked sources are destroyed at shutdown)');
  assert.match(hostLog(DATA), /obs_shutdown returned/);
});

test('root cause fix: the host holds the RTWQ platform; no device sources = nothing to report', async () => {
  const ah = await health();
  assert.equal(ah.rtwqHeld, true, 'RtwqStartup reference held for the process lifetime');
  assert.match(hostLog(DATA), /RTWQ platform held for the process lifetime/);
  assert.deepEqual(ah.sources, []);
  assert.equal(ah.ok, true);
  assert.deepEqual(ah.warnings, []);
  assert.deepEqual(ah.watchdog, { noDataMs: 1000, recreate: true, maxRecreates: 2, parked: 0 });
});

test('readiness: a source that sends packets is ok and receiving (host.status audioHealth and mixer.list)', async () => {
  await c.call('audio.testAdd', { id: 'game', name: 'Game' });
  const ok = await until(async () => src(await health(), 'audio:game')?.state === 'ok');
  assert.ok(ok, 'state becomes ok');
  const s = src(await health(), 'audio:game');
  assert.equal(s.receiving, true);
  assert.equal(s.type, 'ujw_test_audio');
  assert.ok(s.lastDataMs >= 0 && s.lastDataMs < 1000, `lastDataMs ${s.lastDataMs}`);
  assert.equal(s.recreates, 0);
  const row = (await c.call('mixer.list', {})).sources.find((x) => x.id === 'audio:game');
  assert.equal(row.receiving, true);
  assert.ok(row.lastDataMs < 1000);
  assert.equal(row.active, true, 'on an output channel');
});

test('watchdog: a source that stops sending is reported missing, recreated on the same channel, and recovers', async () => {
  const seq0 = (await health()).seq;
  await c.call('mixer.setVolume', { id: 'audio:game', db: -6 });
  const st = await c.call('audio.testStall', { id: 'game', stall: true });
  assert.equal(st.source, 'ujw:audio:game');
  const back = await until(async () => {
    const ah = await health();
    return ah.events.some((e) => e.seq > seq0 && e.kind === 'recovered') ? ah : null;
  });
  assert.ok(back, 'missing -> recreated -> recovered');
  const kinds = back.events.filter((e) => e.seq > seq0).map((e) => e.kind);
  assert.deepEqual(kinds, ['missing', 'recreated', 'recovered']);
  const missing = back.events.find((e) => e.seq > seq0 && e.kind === 'missing');
  assert.equal(missing.text, 'Game audio missing');
  assert.equal(missing.id, 'audio:game');
  const s = src(back, 'audio:game');
  assert.equal(s.state, 'ok');
  assert.equal(s.receiving, true);
  assert.equal(s.recreates, 1);
  assert.equal(back.watchdog.parked, 1, 'the old source is parked, not destroyed');
  assert.equal(back.ok, true);
  assert.deepEqual(back.warnings, []);
  const row = (await c.call('mixer.list', {})).sources.find((x) => x.id === 'audio:game');
  assert.equal(row.receiving, true);
  assert.equal(row.active, true, 'the new source is on the output channel');
  assert.ok(Math.abs(row.volumeDb + 6) < 0.01, `volume carried over (${row.volumeDb} dB)`);
  assert.equal(row.name, 'Game');
  const log = hostLog(DATA);
  assert.match(log, /audio watchdog: Game audio missing: no audio data for \d+ ms \(source ujw:audio:game/);
  assert.match(log, /audio watchdog: recreated ujw:audio:game \(ujw_test_audio, attempt 1 of 2/);
  assert.match(log, /audio watchdog: Game audio is back/);
});

test('watchdog: after maxRecreates it gives up and the "Game audio missing" warning stays', async () => {
  // attempt 2 of 2, then the third stall is left alone
  for (let i = 0; i < 2; i++) {
    const before = src(await health(), 'audio:game').recreates;
    await c.call('audio.testStall', { id: 'game', stall: true });
    if (before < HEALTH.maxRecreates) {
      assert.ok(await until(async () => {
        const s = src(await health(), 'audio:game');
        return s.recreates === before + 1 && s.state === 'ok';
      }), `recreate ${before + 1}`);
    }
  }
  const gave = await until(async () => {
    const ah = await health();
    return ah.events.some((e) => e.kind === 'gave-up') ? ah : null;
  });
  assert.ok(gave, 'gave-up event');
  assert.equal(gave.ok, false);
  assert.deepEqual(gave.warnings, ['Game audio missing']);
  const s = src(gave, 'audio:game');
  assert.equal(s.state, 'missing');
  assert.equal(s.receiving, false);
  assert.equal(s.recreates, 2);
  assert.equal(gave.watchdog.parked, 2);
  const row = (await c.call('mixer.list', {})).sources.find((x) => x.id === 'audio:game');
  assert.equal(row.receiving, false, 'mixer.list shows the dead source before going live');
  await sleep(1000);
  assert.equal(src(await health(), 'audio:game').recreates, 2, 'no further restarts');
  assert.match(hostLog(DATA), /audio watchdog: Game audio missing after 2 restarts/);
  // a working device again (the user replugged it): reported back, warning gone
  await c.call('audio.testStall', { id: 'game', stall: false });
  assert.ok(await until(async () => (await health()).ok === true), 'recovered');
});

test('report only (enabled false) never recreates; no config = receiving unknown; test methods need --test-hooks', async () => {
  const d = mkdtempSync(path.join(OUT, 'audio-health-ro-'));
  const f = config(d, 'ro.json', { audioHealth: { ...HEALTH, enabled: false } });
  const h2 = await launchHost({ dataDir: d, project: PROJECT, extraArgs: ['--host-config', f, '--test-hooks'], env: HEADLESS, timeoutMs: 60000 });
  try {
    await h2.client.call('audio.testAdd', { id: 'mic', name: 'Mic' });
    assert.ok(await until(async () => src(await health(h2.client), 'audio:mic')?.state === 'ok'));
    await h2.client.call('audio.testStall', { id: 'mic', stall: true });
    const ah = await until(async () => { const a = await health(h2.client); return a.ok === false ? a : null; });
    assert.ok(ah, 'reported missing');
    assert.deepEqual(ah.warnings, ['Mic audio missing']);
    await sleep(800);
    const a2 = await health(h2.client);
    assert.equal(src(a2, 'audio:mic').recreates, 0);
    assert.equal(a2.watchdog.recreate, false);
    assert.deepEqual(a2.events.map((e) => e.kind), ['missing']);
  } finally {
    assert.equal((await stopHost(h2, 40000)).code, 0);
  }
  const d3 = mkdtempSync(path.join(OUT, 'audio-health-none-'));
  const h3 = await launchHost({ dataDir: d3, project: PROJECT, extraArgs: [], env: HEADLESS, timeoutMs: 60000 });
  try {
    const ah = await health(h3.client);
    assert.equal(ah.watchdog.noDataMs, null);
    assert.equal(ah.rtwqHeld, true);
    assert.equal((await rpcErr('audio.testAdd', { id: 'x', name: 'X' }, h3.client)).code, -32001, 'FORBIDDEN without --test-hooks');
    assert.equal((await rpcErr('audio.testStall', { id: 'x' }, h3.client)).code, -32001);
    assert.match(hostLog(d3), /audio health: off/);
  } finally {
    assert.equal((await stopHost(h3, 40000)).code, 0);
  }
});

test('host config: bad audioHealth values stop the host with exit 64', async () => {
  const d4 = mkdtempSync(path.join(OUT, 'audio-health-cfg-'));
  const bad = [
    { audioHealth: { enabled: true } }, // numbers come from the data file: required when enabled
    { audioHealth: { ...HEALTH, noDataMs: 100 } },
    { audioHealth: { ...HEALTH, checkIntervalMs: 'x' } },
    { audioHealth: { ...HEALTH, shutdownGuardMs: 500 } },
    { audioHealth: { ...HEALTH, other: 1 } },
    { audioHealth: { ...HEALTH, enabled: 1 } },
  ];
  for (const [i, cfg] of bad.entries()) {
    const f = config(d4, `c${i}.json`, cfg);
    await assert.rejects(launchHost({ dataDir: d4, extraArgs: ['--host-config', f], env: HEADLESS, timeoutMs: 15000 }), /exited with 64/, JSON.stringify(cfg));
  }
});
