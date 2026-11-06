// SPDX-License-Identifier: GPL-3.0-or-later
// tools/soak/stream-day.mjs pure parts: the loopback copy of the alpha live plan never holds a real target, and the
// time-series summary. The run itself needs the host and the GPU (see docs/evidence/2026-11-06-stream-day-mock-run.md).
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planFile } from '../app/host/lib/outputs-plan.mjs';
import { LOOPBACK_PORTS, loopbackPlan, parseRunArgs, RUN_FLAGS, summarise } from '../tools/soak/stream-day.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = JSON.parse(readFileSync(path.join(REPO, 'data', 'outputs', 'alpha-live.json'), 'utf8'));

test('loopback plan: same sinks as the live plan, every stream target is 127.0.0.1 RTMP, no keyRef or serverRef', () => {
  const p = loopbackPlan(LIVE);
  assert.deepEqual(Object.keys(p.targets).sort(), Object.keys(LIVE.targets).sort());
  for (const [id, t] of Object.entries(p.targets)) {
    if (LIVE.targets[id].transport === 'file') { assert.equal(t.transport, 'file'); continue; }
    assert.deepEqual(Object.keys(t).sort(), ['app', 'port', 'stream', 'transport']);
    assert.equal(t.transport, 'rtmp'); assert.equal(t.port, LOOPBACK_PORTS[id]);
  }
  assert.ok(!JSON.stringify(p).includes('keyRef') && !JSON.stringify(p).includes('serverRef'));
});

test('loopback plan is accepted without allowLive (the host would refuse anything real)', () => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'ujw-sd-')), 'plan.json');
  writeFileSync(f, JSON.stringify(loopbackPlan(LIVE)));
  const { params } = planFile(f);
  assert.equal(params.sinks.filter((s) => s.target.transport !== 'file').length, 4);
});

test('loopback plan: a sink without a port is an error', () => {
  assert.throws(() => loopbackPlan({ ...LIVE, targets: { ...LIVE.targets, extra: { transport: 'rtmps', keyRef: 'Ujwalam/stream/x' } } }), /no loopback port/);
});

test('args: --no-record takes no value, so the next flag keeps its own (dense-run finding 2026-11-06)', () => {
  assert.deepEqual(parseRunArgs(['--no-record', '--run-id', 'x', '--minutes', '10']), { _: [], 'no-record': true, 'run-id': 'x', minutes: '10' });
  assert.throws(() => parseRunArgs(['--run-id', '--minutes', '10']), /--run-id needs a value/);
});

test('run flags are known flag ids', () => {
  const ids = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags.map((f) => f.id);
  for (const id of RUN_FLAGS) assert.ok(ids.includes(id), id);
});

test('summarise: memory delta from the warm-up sample, NVENC max, not-live count', () => {
  const row = (t, priv, sessions, state = 'live') => ({ t, host: { fps: 60, cpuPct: 5, gpuPct: 20, renderLagged: 0, encodeSkipped: 0 }, mem: { hostPrivMB: priv, privMB: priv + 100, handles: 1000, hostHandles: 500, procs: 20 }, gpu: { sessions, memMB: 900 }, core: { rttMs: 2 }, ui: { status: 200 }, sinks: [{ id: 'a', state, total: t * 60, dropped: 0, retries: 0 }], markers: 1 });
  const s = summarise([row(0, 1500, 3), row(600, 1600, 3), row(1200, 1610, 4, 'retrying'), row(3600, 1620, 3)]);
  assert.equal(s.warmupAtS, 600); assert.equal(s.hostPrivMB.delta, 20); assert.equal(s.nvencSessionsMax, 4);
  assert.equal(s.sinkSamplesNotLive, 1); assert.equal(s.sinks.a.total, 216000);
  assert.equal(summarise([]), null);
});
