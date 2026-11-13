// SPDX-License-Identifier: GPL-3.0-or-later
// --defer-outputs (opening delay, 2026-11-13): the --outputs plan and the replay buffer are not built for the test card
// at start (no NVENC probe, no encoders); the first project.load builds them once. Real host process, headless.
//   node --test app/host/tests/host-defer-outputs.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
let h;

before(async () => {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(path.join(OUT, 'data-defer-'));
  const plan = path.join(dataDir, 'outputs-params.json');
  writeFileSync(plan, JSON.stringify({
    rungs: [{ id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: 'defer.mkv' } }]
  }));
  h = await launchHost({
    dataDir,
    project: path.join(HOST_DIR, 'projects', 'test-card.project.json'),
    extraArgs: ['--headless', '--defer-outputs', '--outputs', plan]
  });
});

after(async () => {
  if (h) await stopHost(h);
});

test('--defer-outputs: nothing built at start; the first project.load builds the plan once', async () => {
  const c = h.client;
  const before = await c.call('outputs.status');
  assert.equal((before.sinks ?? []).length, 0, 'no graph for the test card');
  assert.deepEqual((await c.call('host.status')).outputsReady, { stream: false, record: false });
  const proj = (await c.call('project.get')).project;
  const re = await c.call('project.load', { project: proj });
  assert.equal(re.outputs.reconfigured, true, JSON.stringify(re.outputs));
  const st = await c.call('outputs.status');
  assert.deepEqual(st.sinks.map((s) => s.id), ['rec']);
  assert.deepEqual((await c.call('host.status')).outputsReady, { stream: false, record: true });
  await c.call('outputs.clear');
});
