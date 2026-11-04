// SPDX-License-Identifier: GPL-3.0-or-later
// Agent session lock (docs/procedures/session-protocol.md): one writer at a time across tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire, readLock, release, LOCK_NAME } from '../tools/agent-lock.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lock-')); dirs.push(d); return d; };

test('acquire on a free repo writes the lock with tool, branch and start time', () => {
  const d = tmp();
  const r = acquire(d, { tool: 'claude', branch: 'claude/alpha0-d1', now: new Date('2026-11-03T10:00:00Z') });
  assert.equal(r.ok, true);
  assert.deepEqual({ ...readLock(d), host: undefined }, { tool: 'claude', branch: 'claude/alpha0-d1', startedAt: '2026-11-03T10:00:00.000Z', host: undefined });
});

test('a second acquire fails and reports the holder; --force replaces it', () => {
  const d = tmp();
  acquire(d, { tool: 'claude', branch: 'b1' });
  const r = acquire(d, { tool: 'codex', branch: 'b2' });
  assert.equal(r.ok, false);
  assert.equal(r.holder.tool, 'claude');
  const f = acquire(d, { tool: 'codex', branch: 'b2', force: true });
  assert.equal(f.ok, true);
  assert.equal(readLock(d).tool, 'codex');
});

test('release only by the holder; releasing a free lock is a no-op', () => {
  const d = tmp();
  acquire(d, { tool: 'claude', branch: 'b' });
  assert.equal(release(d, { tool: 'codex' }).ok, false);
  assert.ok(existsSync(path.join(d, LOCK_NAME)));
  assert.deepEqual(release(d, { tool: 'claude' }), { ok: true, released: true });
  assert.deepEqual(release(d, { tool: 'claude' }), { ok: true, released: false });
});

test('tool names are validated', () => {
  assert.throws(() => acquire(tmp(), { tool: 'Bad Name', branch: 'b' }), TypeError);
});
