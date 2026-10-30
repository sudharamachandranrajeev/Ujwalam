// SPDX-License-Identifier: GPL-2.0-or-later
// Process priority rule (user decision 2026-10-28): `serve` sets itself to Normal (logged; a failure is reported, not
// fatal); background children go to BelowNormal. The OS calls are faked, so the test runner's own priority is never
// raised. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_PRIORITY, LIVE_PRIORITY, formatPriority, priorityName, setBackgroundPriority, setLivePriority, setPriorityOf } from '../services/event-core/priority.mjs';
import { serve } from '../services/event-core/cli.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evprio-')); dirs.push(d); return d; };
const P = os.constants.priority;

function fakeSys(start, { failSet = null } = {}) {
  const calls = [];
  let cur = start;
  return {
    calls,
    getPriority: (pid) => { calls.push(['get', pid]); return cur; },
    setPriority: (pid, v) => { calls.push(['set', pid, v]); if (failSet) throw Object.assign(new Error('denied'), { code: failSet }); cur = v; },
  };
}

test('live priority is Normal and background is BelowNormal; names are stable', () => {
  assert.equal(LIVE_PRIORITY, P.PRIORITY_NORMAL);
  assert.equal(BACKGROUND_PRIORITY, P.PRIORITY_BELOW_NORMAL);
  assert.deepEqual([priorityName(P.PRIORITY_NORMAL), priorityName(P.PRIORITY_BELOW_NORMAL), priorityName(undefined)], ['normal', 'below-normal', null]);
});

test('setLivePriority raises this process (pid 0) from BelowNormal to Normal and reports it', () => {
  const sys = fakeSys(P.PRIORITY_BELOW_NORMAL);
  const r = setLivePriority(sys);
  assert.deepEqual(r, { ok: true, target: 'normal', before: 'below-normal', after: 'normal' });
  assert.deepEqual(sys.calls.filter(([k]) => k === 'set'), [['set', 0, P.PRIORITY_NORMAL]]);
  assert.equal(formatPriority(r), 'process priority normal (target normal, was below-normal)');
});

test('a failure is reported, never thrown', () => {
  const r = setLivePriority(fakeSys(P.PRIORITY_BELOW_NORMAL, { failSet: 'EACCES' }));
  assert.deepEqual(r, { ok: false, target: 'normal', before: 'below-normal', after: 'below-normal', error: 'EACCES' });
  assert.equal(formatPriority(r), 'warn: process priority NOT set to normal (EACCES); now below-normal; continuing');
  const bg = fakeSys(P.PRIORITY_NORMAL);
  assert.equal(setBackgroundPriority(4242, bg).after, 'below-normal');
  assert.deepEqual(bg.calls.filter(([k]) => k === 'set'), [['set', 4242, P.PRIORITY_BELOW_NORMAL]]);
});

test('real OS call: setting this process to its current priority is accepted (no change made)', () => {
  const cur = os.getPriority(0);
  const r = setPriorityOf(0, cur);
  assert.equal(r.ok, true);
  assert.equal(os.getPriority(0), cur);
});

async function runServe(args, setPriority) {
  const out = [];
  const ac = new AbortController();
  const io = { out: (l) => { out.push(l); if (l.startsWith('[serve] api on')) setImmediate(() => ac.abort()); }, signal: ac.signal, setPriority };
  const code = await serve({ 'data-dir': tmp(), mock: true, ...args }, io);
  return { code, out };
}

test('serve: sets Normal first and logs it; the stall tracer is on by default', async () => {
  let called = 0;
  const { code, out } = await runServe({}, () => { called++; return { ok: true, target: 'normal', before: 'below-normal', after: 'normal' }; });
  assert.equal(code, 0);
  assert.equal(called, 1);
  assert.equal(out[0], '[serve] process priority normal (target normal, was below-normal)');
  assert.ok(out.some((l) => /^\[serve\] stall tracer on \(> 200 ms, stalls\.jsonl in the data dir\)$/.test(l)), out.join('\n'));
});

test('serve: a priority failure is logged and the service still starts; --no-stall-tracer turns the tracer off', async () => {
  const { code, out } = await runServe({ 'no-stall-tracer': true }, () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); });
  assert.equal(code, 0);
  assert.equal(out[0], '[serve] warn: process priority NOT set to normal (EPERM); now unknown; continuing');
  assert.ok(out.some((l) => l.startsWith('[serve] api on')));
  assert.ok(out.includes('[serve] stall tracer off'));
});
