// SPDX-License-Identifier: GPL-3.0-or-later
// Shutdown guard with the SHIPPED number (data/audio/health.json shutdownGuardMs 20000), against a real host (libobs, test
// card, no devices, headless): a source whose destroy never returns (audio.testHangDestroy, --test-hooks only) ends the
// host with exit 9 after shutdownGuardMs, logged; without the guard it would hang forever. Split out of
// host-audio-failsim.test.mjs so that its 20 s wait runs beside that file's watchdog waits (test:host runs two files at a
// time, D276) instead of after them. Evidence: docs/evidence/2026-11-09-failure-sims-and-clipmaker-check.md.
//   node --test app/host/tests/host-audio-failsim-guard.test.mjs   (needs the built host and the OBS runtime; ~25 s)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';
import { loadAudioHealth } from '../../../services/studio-ui/launch.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const PROJECT = path.join(HOST_DIR, 'projects', 'test-card.project.json');
const HEADLESS = { UJWALAM_HEADLESS: '1' };
const SHIPPED = loadAudioHealth();
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
mkdirSync(OUT, { recursive: true });

test('shutdown guard: a source destroy that never returns ends the host with exit 9 after shutdownGuardMs', async () => {
  const d = mkdtempSync(path.join(OUT, 'audio-failsim-guard-'));
  const g = await launchHost({ dataDir: d, project: PROJECT, extraArgs: ['--host-config', hostConfig(d, SHIPPED), '--test-hooks'], env: HEADLESS, timeoutMs: 60000 });
  let stopped = false;
  try {
    await g.client.call('audio.testAdd', { id: 'game', name: 'Game' });
    const set = await g.client.call('audio.testHangDestroy', { id: 'game' });
    assert.deepEqual(set, { id: 'audio:game', hangDestroy: true, source: 'ujw:audio:game' });
    assert.equal((await g.client.call('host.status', {})).audioHealth.sources.length, 1, 'still running normally');
    const t0 = Date.now();
    const r = await stopHost(g, SHIPPED.shutdownGuardMs + 30000);
    stopped = true;
    const ms = Date.now() - t0;
    assert.equal(r.timedOut, false, 'the guard ended the process (the test did not have to kill it)');
    assert.equal(r.code, 9, 'kShutdownGuardExit');
    assert.ok(ms >= SHIPPED.shutdownGuardMs - 500, `ended after ${ms} ms (guard ${SHIPPED.shutdownGuardMs} ms)`);
    const log = hostLog(d);
    assert.match(log, /ujw_test_audio: destroy hangs on purpose/);
    assert.match(log, /obs_shutdown did not return in 20000 ms \(a source's destroy is stuck\); ending the process with exit code 9/);
    assert.doesNotMatch(log, /obs_shutdown returned/);
  } finally {
    if (!stopped) { try { g.child.kill(); } catch { /* gone */ } }
  }
});
