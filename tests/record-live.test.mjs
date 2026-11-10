// SPDX-License-Identifier: GPL-3.0-or-later
// Record while live (LC2, D334 proposed): services/studio-ui/record-live.mjs on its own. The server wiring (Start /
// Stop stream, End all, the status poll, stop-wins) is tested in tests/studio-ui-server.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordLive, RECORD_LIVE_GRACE_MS } from '../services/studio-ui/record-live.mjs';

const status = (stream, record) => ({ sinks: [{ id: 'youtube-h', kind: 'stream', state: stream }, { id: 'record', kind: 'record', state: record }, { id: 'record-v', kind: 'record', state: record }] });

function rig({ enabled = true, closing = false, outputs = () => status('live', 'idle') } = {}) {
  const calls = []; const logs = []; const tasks = [];
  let t = 1000; let epoch = 0;
  const call = async (m) => { calls.push(m); if (m === 'outputs.status') return outputs(); return { ok: true }; };
  const rl = createRecordLive({ call, enabled: () => enabled, epoch: () => epoch, closing: () => closing, log: (l) => logs.push(l), now: () => t,
    tasks: { start: (x) => ({ done: (note) => tasks.push({ ...x, state: 'done', note }), fail: (note) => tasks.push({ ...x, state: 'failed', note }) }) } });
  return { rl, calls, logs, tasks, advance: (ms) => { t += ms; }, bump: () => { epoch += 1; } };
}

test('off, or closing: nothing is started', async () => {
  for (const o of [{ enabled: false }, { closing: true }]) {
    const r = rig(o);
    assert.deepEqual(await r.rl.afterStreamStart(), { started: false });
    assert.deepEqual(r.calls, []);
  }
});

test('outputs unreadable or no recording set up: a warning and a failed task, the stream untouched', async () => {
  const bad = rig({ outputs: () => { throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); } });
  const a = await bad.rl.afterStreamStart();
  assert.equal(a.started, false);
  assert.match(a.warning, /not being recorded \(the outputs could not be read: TIMEOUT\)/);
  assert.equal(bad.tasks[0].state, 'failed');
  assert.ok(!bad.calls.includes('record.start') && !bad.calls.includes('stream.stop'));
  const none = rig({ outputs: () => ({ sinks: [{ id: 'youtube-h', kind: 'stream', state: 'live' }] }) });
  assert.match((await none.rl.afterStreamStart()).warning, /no recording is set up in the outputs/);
});

test('the status poll: a stream not yet seen running gets the grace period; once seen, its end stops the recording', async () => {
  const r = rig();
  assert.deepEqual(await r.rl.afterStreamStart(), { started: true });
  assert.equal(r.rl.active(), true);
  assert.equal(await r.rl.observe(status('idle', 'live')), false, 'not seen live yet: within the grace period');
  r.advance(RECORD_LIVE_GRACE_MS);
  assert.equal(await r.rl.observe(status('failed', 'live')), true, 'never ran: stopped after the grace period');
  assert.equal(r.rl.active(), false);
  // seen running, then every stream sink ended
  await r.rl.afterStreamStart();
  await r.rl.observe(status('live', 'live'));
  assert.equal(await r.rl.observe(status('reconnecting', 'live')), false, 'reconnecting counts as running');
  assert.equal(await r.rl.observe(status('stopped', 'live')), true);
  assert.equal(r.calls.filter((m) => m === 'record.stop').length, 2);
  // the recording ended by itself: forgotten, never stopped
  await r.rl.afterStreamStart();
  await r.rl.observe(status('stopped', 'stopped'));
  assert.equal(r.rl.active(), false);
  assert.equal(r.calls.filter((m) => m === 'record.stop').length, 2);
});

test('a Stop during record.start wins; handOff gives the recording back to the user', async () => {
  const r = rig();
  const orig = r.rl;
  // epoch bumps while record.start is on its way
  const calls = []; let epoch = 0;
  const rl = createRecordLive({ call: async (m) => { calls.push(m); if (m === 'record.start') epoch += 1; return m === 'outputs.status' ? status('live', 'idle') : { ok: true }; }, enabled: () => true, epoch: () => epoch });
  assert.deepEqual(await rl.afterStreamStart(), { started: false });
  assert.deepEqual(calls, ['outputs.status', 'record.start', 'record.stop']);
  await orig.afterStreamStart();
  orig.handOff();
  assert.equal(await orig.streamEnded('the stream was stopped'), false, 'the user owns it now');
});
