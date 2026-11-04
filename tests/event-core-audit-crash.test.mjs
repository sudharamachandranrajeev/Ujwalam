// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/audit: hard-kill crash test. A child process writes audit rows through the real worker writer
// and is killed (TerminateProcess) at a random point, 20 times in a row on the same database. After each kill the
// database must pass integrity_check, the chain and the head record, hold this round's rows as a gap-free prefix, and
// still contain every row the child had reported as committed. See tools/audit-crash.mjs. SYNTHETIC rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCrashRounds } from '../tools/audit-crash.mjs';

test('20 hard kills at random points: integrity ok, chain ok, head equals rows, no partial batch, no acked row lost', { timeout: 180_000 }, async () => {
  const res = await runCrashRounds({ rounds: 20, seed: 20261028 });
  assert.equal(res.length, 20);
  for (const r of res) {
    assert.equal(r.exit, 'SIGKILL');
    assert.equal(r.integrity, 'ok', `round ${r.round}`);
    assert.equal(r.chain, 'ok', `round ${r.round}`);
    assert.equal(r.headRows, r.totalRows, `round ${r.round}`);
    assert.equal(r.contiguous, true, `round ${r.round}`);
    assert.ok(r.rowsThisRound >= r.killedAfterAck, `round ${r.round}: acked rows survive`);
    assert.ok(r.rowsThisRound > 0, `round ${r.round}: the child wrote something`);
  }
  assert.ok(res[19].totalRows > res[0].totalRows, 'the chain kept growing across kills');
});
