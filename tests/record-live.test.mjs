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
  const r = rig({ outputs: () => cur });
  let cur = status('live', 'idle');
  const observe = (st) => { cur = st; return r.rl.observe(st, r.rl.owner()); };
  assert.deepEqual(await r.rl.afterStreamStart(), { started: true });
  assert.equal(r.rl.active(), true);
  assert.equal(await observe(status('idle', 'live')), false, 'not seen live yet: within the grace period');
  r.advance(RECORD_LIVE_GRACE_MS);
  assert.equal(await observe(status('failed', 'live')), true, 'never ran: stopped after the grace period');
  assert.equal(r.rl.active(), false);
  // seen running, then every stream sink ended
  cur = status('live', 'idle');
  assert.equal((await r.rl.afterStreamStart()).started, true);
  await observe(status('live', 'live'));
  assert.equal(await observe(status('reconnecting', 'live')), false, 'reconnecting counts as running');
  assert.equal(await observe(status('stopped', 'live')), true);
  assert.equal(r.calls.filter((m) => m === 'record.stop').length, 2);
  // the recording ended by itself: forgotten, never stopped
  cur = status('live', 'idle');
  assert.equal((await r.rl.afterStreamStart()).started, true);
  await observe(status('stopped', 'stopped'));
  assert.equal(r.rl.active(), false);
  assert.equal(r.calls.filter((m) => m === 'record.stop').length, 2);
});

test('a Stop during record.start wins; handOff gives the recording back to the user', async () => {
  const r = rig();
  const orig = r.rl;
  // epoch bumps while record.start is on its way
  const calls = []; let epoch = 0;
  let st = status('live', 'idle');
  const rl = createRecordLive({ call: async (m) => { calls.push(m); if (m === 'record.start') { epoch += 1; st = status('stopped', 'live'); } return m === 'outputs.status' ? st : { ok: true }; }, enabled: () => true, epoch: () => epoch });
  assert.deepEqual(await rl.afterStreamStart(), { started: false });
  assert.deepEqual(calls, ['outputs.status', 'record.start', 'outputs.status', 'record.stop'], 'stopped again once a fresh status shows the stream ended');
  await orig.afterStreamStart();
  orig.handOff();
  assert.equal(await orig.streamEnded('the stream was stopped'), false, 'the user owns it now');
});

// ---- Codex review of LC2: ownership and ordering (each failed before the fix) ----
function hostRig() {
  const h = { stream: 'live', record: 'idle', calls: [], gates: {}, epoch: 0 };
  h.status = () => ({ sinks: [{ id: 'youtube-h', kind: 'stream', state: h.stream }, { id: 'record', kind: 'record', state: h.record }, { id: 'record-v', kind: 'record', state: h.record }] });
  h.gate = (m) => { let release; h.gates[m] = new Promise((x) => { release = x; }); return () => { delete h.gates[m]; release(); }; };
  h.call = async (m) => {
    h.calls.push(m);
    if (m === 'record.start') h.record = 'live';
    if (m === 'record.stop') h.record = 'stopped'; // the host acts at once; the answer may come later
    const st = m === 'outputs.status' ? h.status() : { ok: true };
    if (h.gates[m]) await h.gates[m];
    return st;
  };
  h.rl = createRecordLive({ call: h.call, enabled: () => true, epoch: () => h.epoch });
  h.count = (m) => h.calls.filter((x) => x === m).length;
  return h;
}
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((x) => setImmediate(x)); assert.ok(fn()); };

test('P2: a Stop while outputs.status is read is not lost: nothing is recorded', async () => {
  const h = hostRig();
  const release = h.gate('outputs.status');
  const p = h.rl.afterStreamStart();
  await until(() => h.count('outputs.status') === 1);
  h.epoch += 1; h.stream = 'stopped'; // Stop stream clicked meanwhile
  release();
  assert.deepEqual(await p, { started: false });
  assert.equal(h.count('record.start'), 0);
  assert.equal(h.rl.active(), false);
});

test('P2: the click\'s own epoch counts (a Stop before afterStreamStart is called wins too)', async () => {
  const h = hostRig();
  const e0 = h.epoch; h.epoch += 1;
  assert.deepEqual(await h.rl.afterStreamStart({ epoch: e0 }), { started: false });
  assert.equal(h.count('record.start'), 0);
});

test('P1: a Record / Stop click while the automatic record.start is on its way keeps the recording the user\'s', async () => {
  const h = hostRig();
  const release = h.gate('record.start');
  const p = h.rl.afterStreamStart();
  await until(() => h.count('record.start') === 1);
  h.rl.handOff(); // the user's Record click completed meanwhile
  release();
  assert.equal((await p).started, false);
  assert.equal(h.rl.active(), false, 'not reclaimed');
  h.stream = 'stopped';
  assert.equal(await h.rl.streamEnded('the stream was stopped'), false);
  assert.equal(h.count('record.stop'), 0, 'the user\'s recording keeps running');
});

test('P1: an old record.stop answer never clears the recording a new stream start made', async () => {
  const h = hostRig();
  await h.rl.afterStreamStart();
  h.stream = 'stopped';
  const release = h.gate('record.stop');
  const stopping = h.rl.streamEnded('the stream was stopped');
  await until(() => h.count('record.stop') === 1);
  h.stream = 'live'; // a new stream starts while the old stop's answer is still on its way
  const starting = h.rl.afterStreamStart();
  release();
  assert.equal(await stopping, true);
  assert.equal((await starting).started, true, 'the new stream is recorded');
  assert.equal(h.rl.active(), true, 'and that recording is still owned (not orphaned)');
  h.stream = 'stopped';
  assert.equal(await h.rl.streamEnded('the stream was stopped'), true, 'so it stops with its stream');
  assert.equal(h.record, 'stopped');
});

test('P1: the recording is stopped only when a fresh status shows no stream running (per-output stops, End all not finished)', async () => {
  const h = hostRig();
  await h.rl.afterStreamStart();
  h.stream = 'live'; // one output stopped, another still live
  assert.equal(await h.rl.streamEnded('the stream was stopped'), false);
  h.stream = 'stopping';
  assert.equal(await h.rl.streamEnded('all streams were ended'), false, 'still closing: not yet');
  assert.equal(h.count('record.stop'), 0);
  h.stream = 'stopped';
  assert.equal(await h.rl.streamEnded('all streams were ended'), true);
});

test('P1: a status poll read before a new start never stops or forgets the new recording', async () => {
  const h = hostRig();
  await h.rl.afterStreamStart();
  const old = h.rl.owner();
  h.stream = 'stopped';
  await h.rl.streamEnded('the stream was stopped');
  const stale = { sinks: [{ id: 'youtube-h', kind: 'stream', state: 'stopped' }, { id: 'record', kind: 'record', state: 'stopped' }] };
  h.stream = 'live';
  await h.rl.afterStreamStart();
  assert.equal(await h.rl.observe(stale, old), false, 'the poll began before this recording');
  assert.equal(h.rl.active(), true);
  assert.equal(h.count('record.stop'), 1);
});

test('a slow record.start never holds up Stop stream or End all; that start stops its own recording', async () => {
  const h = hostRig();
  const release = h.gate('record.start');
  const p = h.rl.afterStreamStart();
  await until(() => h.count('record.start') === 1);
  h.epoch += 1; h.stream = 'stopped'; // Stop stream clicked while record.start is on its way
  const ended = await Promise.race([h.rl.streamEnded('the stream was stopped'), new Promise((x) => setTimeout(() => x('waited'), 500))]);
  assert.equal(ended, false, 'answered at once, not after record.start');
  release();
  assert.deepEqual(await p, { started: false });
  assert.equal(h.count('record.stop'), 1, 'stopped by the start itself');
  assert.equal(h.rl.active(), false);
});
