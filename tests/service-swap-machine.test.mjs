// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 service swap state machine (services/supervisor/swap.mjs, D337): the transition table, the runner with fake steps
// (every failure path, timeouts, the refused hand-over) and the refuse rules (host and overlay server never swapped).
import assert from 'node:assert/strict';
import test from 'node:test';
import { HandoverRefused, refuseReason, runSwap, STATES, transition } from '../services/supervisor/swap.mjs';

const ok = (log, name, v) => async () => { log.push(name); return v; };
const bad = (log, name, e = new Error(`${name} broke`)) => async () => { log.push(name); throw e; };
const steps = (log, over = {}) => ({
  spawnNew: ok(log, 'spawnNew'), check: ok(log, 'check'), handover: ok(log, 'handover'), stopOld: ok(log, 'stopOld'),
  stopNew: ok(log, 'stopNew'), restoreOld: ok(log, 'restoreOld'), ...over,
});

test('table: side-by-side happy path', () => {
  let s = transition('idle', 'begin-side');
  assert.deepEqual(s, { state: 'starting', action: 'spawn-new', result: null });
  s = transition(s.state, 'started'); assert.equal(s.action, 'check-new');
  s = transition(s.state, 'healthy'); assert.equal(s.action, 'hand-over');
  s = transition(s.state, 'handed-over'); assert.equal(s.action, 'stop-old');
  s = transition(s.state, 'old-stopped'); assert.deepEqual(s, { state: 'idle', action: null, result: 'swapped' });
});

test('table: an event a state does not accept throws; every state is reachable from idle', () => {
  assert.throws(() => transition('idle', 'healthy'), /not allowed/);
  assert.throws(() => transition('nope', 'begin-side'), /not allowed/);
  const seen = new Set(['idle']);
  const queue = ['idle'];
  const events = ['begin-side', 'begin-stop', 'started', 'start-failed', 'healthy', 'unhealthy', 'handed-over', 'handover-refused', 'handover-failed', 'old-stopped', 'old-stop-failed', 'new-stopped', 'new-stop-failed', 'restored', 'restore-failed'];
  while (queue.length) {
    const st = queue.shift();
    for (const e of events) {
      try { const n = transition(st, e).state; if (!seen.has(n)) { seen.add(n); queue.push(n); } } catch { /* not accepted */ }
    }
  }
  assert.deepEqual([...seen].sort(), [...STATES].sort());
});

test('runner side-by-side: swapped, steps in order, the old one stops only after the hand-over', async () => {
  const log = [];
  const states = [];
  const r = await runSwap({ mode: 'side-by-side', steps: steps(log), onState: (s) => states.push(s) });
  assert.equal(r.result, 'swapped');
  assert.deepEqual(log, ['spawnNew', 'check', 'handover', 'stopOld']);
  assert.deepEqual(states, ['starting', 'checking', 'handing-over', 'stopping-old', 'idle']);
  assert.ok(r.history.every((h) => h.ok));
});

test('runner side-by-side: a crashing new build (start or check fails) keeps the old one and never touches it', async () => {
  for (const which of ['spawnNew', 'check']) {
    const log = [];
    const r = await runSwap({ mode: 'side-by-side', steps: steps(log, { [which]: bad(log, which) }) });
    assert.equal(r.result, 'kept-old', which);
    assert.ok(!log.includes('handover') && !log.includes('stopOld') && !log.includes('restoreOld'), `${which}: ${log}`);
    assert.equal(log.at(-1), 'stopNew');
    assert.match(r.history.find((h) => !h.ok).error, /broke/);
  }
});

test('runner side-by-side: a refused hand-over rolls back; a failed one restores the old version', async () => {
  let log = [];
  let r = await runSwap({ mode: 'side-by-side', steps: steps(log, { handover: bad(log, 'handover', new HandoverRefused('requests still running')) }) });
  assert.equal(r.result, 'kept-old');
  assert.deepEqual(log, ['spawnNew', 'check', 'handover', 'stopNew']);
  log = [];
  r = await runSwap({ mode: 'side-by-side', steps: steps(log, { handover: bad(log, 'handover') }) });
  assert.equal(r.result, 'restored-old');
  assert.deepEqual(log, ['spawnNew', 'check', 'handover', 'restoreOld']);
  log = [];
  r = await runSwap({ mode: 'side-by-side', steps: steps(log, { handover: bad(log, 'handover'), restoreOld: bad(log, 'restoreOld') }) });
  assert.equal(r.result, 'failed');
});

test('runner: a step that hangs times out and counts as its failure', async () => {
  const log = [];
  const r = await runSwap({ mode: 'side-by-side', steps: steps(log, { check: () => new Promise(() => {}) }), timeouts: { check: 30 } });
  assert.equal(r.result, 'kept-old');
  assert.match(r.history.find((h) => h.action === 'check-new').error, /timed out after 30 ms/);
});

test('runner: an old one that does not stop after the hand-over still counts as swapped (the API is on the new one)', async () => {
  const log = [];
  const r = await runSwap({ mode: 'side-by-side', steps: steps(log, { stopOld: bad(log, 'stopOld') }) });
  assert.equal(r.result, 'swapped');
});

test('runner stop-start: swapped; a new one that fails to start or stay healthy restores the old version', async () => {
  let log = [];
  let r = await runSwap({ mode: 'stop-start', steps: steps(log) });
  assert.equal(r.result, 'swapped');
  assert.deepEqual(log, ['stopOld', 'spawnNew', 'check']);
  log = [];
  r = await runSwap({ mode: 'stop-start', steps: steps(log, { spawnNew: bad(log, 'spawnNew') }) });
  assert.equal(r.result, 'restored-old');
  assert.deepEqual(log, ['stopOld', 'spawnNew', 'restoreOld']);
  log = [];
  r = await runSwap({ mode: 'stop-start', steps: steps(log, { check: bad(log, 'check') }) });
  assert.equal(r.result, 'restored-old');
  assert.deepEqual(log, ['stopOld', 'spawnNew', 'check', 'stopNew', 'restoreOld']);
  log = [];
  r = await runSwap({ mode: 'stop-start', steps: steps(log, { stopOld: bad(log, 'stopOld') }) });
  assert.equal(r.result, 'kept-old');
  assert.deepEqual(log, ['stopOld']);
});

test('runner: unknown mode or a missing step is a programming error', async () => {
  await assert.rejects(runSwap({ mode: 'hot', steps: steps([]) }), /unknown mode/);
  const s = steps([]); delete s.handover;
  await assert.rejects(runSwap({ mode: 'side-by-side', steps: s }), /step handover missing/);
  await runSwap({ mode: 'stop-start', steps: s }); // stop-start needs no hand-over
});

test('refuse rules: host and overlay server never swapped; one swap at a time; unknown refused', () => {
  assert.match(refuseReason('host'), /never swapped while live/);
  assert.match(refuseReason('overlay-server'), /child of the host/);
  assert.equal(refuseReason('event-core'), null);
  assert.equal(refuseReason('live-clipper'), null);
  assert.match(refuseReason('event-core', { busy: true }), /one at a time/);
  assert.match(refuseReason('nope'), /unknown service/);
});
