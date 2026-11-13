// SPDX-License-Identifier: GPL-3.0-or-later
// Graphics watchdog in a real host (gfx_watch.h, D374; libobs, test card, no devices, no previews, headless):
// graphics.testStall (--test-hooks only) blocks the graphics thread in the frame tick, as a stuck GPU would; the host
// must report the stall in host.alive and host.status (lastFrameAgeMs grows, stalled true), log it ONCE (not per
// frame), then report and log the recovery. host.alive must answer while the graphics thread is blocked (it takes no
// lock), which is what lets the launcher's host watchdog tell a frozen host from a busy one.
// A real driver reset cannot be forced here (docs/evidence/2026-11-13-gpu-reset-recovery.md, UNVERIFIED).
// Skipped while the user's installed Ujwalam runs (tools/ci.mjs installedUjwalamProcesses): a second libobs on the
// same GPU next to the running studio is what reset the GPU on 2026-11-12.
//   node --test app/host/tests/host-gfx-watch.test.mjs   (needs the built host and the OBS runtime; ~20 s)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { installedUjwalamProcesses } from '../../../tools/ci.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const PROJECT = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = installedUjwalamProcesses();
const skip = running.length ? `the installed Ujwalam is running (${running.length} process(es)); no GPU test next to it` : false;
const STALL_MS = 1000; // small numbers for the test; the shipped ones are in data/live/host-watch.json
let h, DATA;

function hostLog() {
  const logs = path.join(DATA, 'logs');
  const f = readdirSync(logs).filter((n) => /^host-.*\.log$/.test(n)).sort().pop();
  return readFileSync(path.join(logs, f), 'utf8');
}
async function until(fn, ms) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); }
}

before(async () => {
  if (skip) return;
  mkdirSync(OUT, { recursive: true });
  DATA = mkdtempSync(path.join(OUT, 'gfx-watch-'));
  const cfg = path.join(DATA, 'host-config.json');
  writeFileSync(cfg, JSON.stringify({ graphicsWatch: { stallMs: STALL_MS, checkIntervalMs: 200 } }));
  h = await launchHost({ dataDir: DATA, project: PROJECT, extraArgs: ['--host-config', cfg, '--test-hooks'], env: { UJWALAM_HEADLESS: '1' }, timeoutMs: 60000 });
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h, 60000);
  assert.equal(r.code, 0);
  rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('healthy: frames flow, no stall, no device loss; host.alive and host.status carry the same report', { skip }, async () => {
  const a = await until(async () => { const r = await h.client.call('host.alive'); return r.graphics.frames > 10 && r; }, 10000);
  assert.ok(a, 'frames counted');
  assert.equal(a.pid, h.child.pid);
  assert.ok(a.uptimeMs > 0);
  const g = a.graphics;
  assert.equal(g.watch, true);
  assert.equal(g.stallMs, STALL_MS);
  assert.ok(g.lastFrameAgeMs < 500, `last frame ${g.lastFrameAgeMs} ms ago`);
  assert.deepEqual([g.stalled, g.stalls, g.deviceLosses, g.deviceRebuilds], [false, 0, 0, 0]);
  assert.deepEqual([g.lastStallAt, g.lastDeviceLossAt, g.lastDeviceRebuildAt], [null, null, null]);
  const s = (await h.client.call('host.status')).graphics;
  assert.deepEqual(Object.keys(s).sort(), Object.keys(g).sort());
  assert.match(hostLog(), /graphics watchdog: on \(stall after 1000 ms, check every 200 ms\); device-loss report on/);
});

test('a blocked graphics thread is reported once while host.alive keeps answering, then the recovery', { skip }, async () => {
  await h.client.call('graphics.testStall', { ms: 4000 });
  const st = await until(async () => { const r = await h.client.call('host.alive'); return r.graphics.stalled && r.graphics; }, 5000);
  assert.ok(st, 'stall reported');
  const t0 = Date.now();
  const mid = (await h.client.call('host.alive')).graphics; // answers during the block: no lock taken
  assert.ok(Date.now() - t0 < 1000, 'host.alive answered fast during the stall');
  assert.ok(mid.lastFrameAgeMs >= STALL_MS, `age ${mid.lastFrameAgeMs}`);
  assert.equal(mid.stalls, 1);
  assert.ok(mid.stalledMs >= STALL_MS);
  await sleep(1500); // several more checks inside the same stall
  assert.equal((hostLog().match(/graphics stalled: no video frame for/g) ?? []).length, 1, 'logged once, not per check');
  const back = await until(async () => { const r = await h.client.call('host.alive'); return !r.graphics.stalled && r.graphics; }, 8000);
  assert.ok(back, 'frames came back');
  assert.equal(back.stalls, 1);
  assert.ok(back.longestStallMs >= 3000 && back.longestStallMs < 8000, `longest ${back.longestStallMs}`);
  assert.ok(back.lastFrameAgeMs < 1000);
  assert.match(back.lastStallAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(hostLog(), /graphics recovered: video frames are back after \d+ ms/);
});

test('graphics.testStall is checked and needs --test-hooks', { skip }, async () => {
  for (const p of [{}, { ms: 0 }, { ms: 30001 }, { ms: 'x' }, { ms: 10, extra: 1 }]) {
    await assert.rejects(h.client.call('graphics.testStall', p), (e) => e.code === -32602, JSON.stringify(p));
  }
  const d2 = mkdtempSync(path.join(OUT, 'gfx-watch-nohooks-'));
  const h2 = await launchHost({ dataDir: d2, project: PROJECT, env: { UJWALAM_HEADLESS: '1' }, timeoutMs: 60000 });
  try {
    await assert.rejects(h2.client.call('graphics.testStall', { ms: 10 }), (e) => e.code === -32001);
    const g = (await h2.client.call('host.alive')).graphics;
    assert.equal(g.watch, false, 'no graphicsWatch in the host config: no stall check');
    assert.equal(g.stalled, false);
  } finally {
    assert.equal((await stopHost(h2, 60000)).code, 0);
    rmSync(d2, { recursive: true, force: true, maxRetries: 5 });
  }
});
