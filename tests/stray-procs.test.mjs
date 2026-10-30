// SPDX-License-Identifier: GPL-2.0-or-later
// tools/stray-procs.mjs and the mock cleanup guarantees (P3 E7): a mock left running is found and reported by pid,
// a mock started in-process is tracked until closed, and the CLI mock stops itself after its TTL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMocks, startMockStreamerbot } from '../tools/mock/mock-streamerbot.mjs';
import { findStrays, listNodeProcesses, scanStrays, strayReport } from '../tools/stray-procs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO, 'tools', 'mock', 'mock-streamerbot.mjs');
test.after(() => assert.equal(openMocks(), 0, 'a mock Streamer.bot was left open'));

test('findStrays: picks mock and soak scripts, skips self, its parents and unrelated node processes', () => {
  const procs = [
    { pid: 1, parentPid: 0, startedAt: '2026-10-28T10:00:00.000Z', cmd: 'node C:\\x\\npm-cli.js test' },
    { pid: 2, parentPid: 1, startedAt: '2026-10-28T10:00:01.000Z', cmd: 'node --test tests/soak-replay.test.mjs' },
    { pid: 3, parentPid: 0, startedAt: '2026-10-28T09:00:00.000Z', cmd: 'node tools/mock/mock-streamerbot.mjs --port 18094 --every 150' },
    { pid: 4, parentPid: 0, startedAt: '2026-10-28T09:30:00.000Z', cmd: '"node.exe" C:\\r\\tools\\soak\\core-child.mjs --data-dir D:\\private\\data' },
    { pid: 5, parentPid: 2, startedAt: '2026-10-28T10:00:02.000Z', cmd: 'node C:\\r\\tools\\soak\\replay.mjs --run-id me' }, // our own tree (self = 5)
    { pid: 6, parentPid: 0, startedAt: '2026-10-28T08:00:00.000Z', cmd: 'node server.mjs' },
  ];
  const s = findStrays(procs, { self: 5, now: Date.parse('2026-10-28T10:30:00.000Z') });
  assert.deepEqual(s.map((x) => [x.pid, x.script, x.ageMin]), [[3, 'tools/mock/mock-streamerbot.mjs', 90], [4, 'tools/soak/core-child.mjs', 60]]);
  assert.ok(!JSON.stringify(s).includes('private'), 'the data path of the command line is never reported');
  assert.match(strayReport(s), /2 test mock\/soak process\(es\) still running/);
  assert.equal(strayReport([]), 'stray-mocks: none running');
});

test('findStrays: also finds the idempotency kill-test child and listen-CLI children started by tests, by label only', () => {
  const procs = [
    { pid: 10, parentPid: 0, startedAt: '2026-10-28T09:00:00.000Z', cmd: 'node C:/r/tools/idem-crash-child.mjs D:/private/d kill after-start' },
    { pid: 11, parentPid: 0, startedAt: '2026-10-28T09:00:00.000Z', cmd: 'node C:/r/services/event-core/cli.mjs listen --credential Ujwalam-TEST-ONLY-absent-123' },
    { pid: 12, parentPid: 0, startedAt: '2026-10-28T09:00:00.000Z', cmd: 'node C:/r/services/event-core/cli.mjs serve' }, // a real run is never flagged
  ];
  const s = findStrays(procs, { self: 99, now: Date.parse('2026-10-28T10:00:00.000Z') });
  assert.deepEqual(s.map((x) => [x.pid, x.script]), [[10, 'test child'], [11, 'test child']]);
  assert.ok(!JSON.stringify(s).includes('private'));
});

test('a mock started in-process is tracked until it is closed', async () => {
  assert.equal(openMocks(), 0);
  const a = await startMockStreamerbot();
  const b = await startMockStreamerbot();
  assert.equal(openMocks(), 2);
  await a.close();
  assert.equal(openMocks(), 1);
  await b.close();
  assert.equal(openMocks(), 0);
});

test('a CLI mock left running is found by the scan, and stops by itself after --ttl-s', { timeout: 60000 }, async () => {
  const child = spawn(process.execPath, [MOCK, '--port', '0', '--ttl-s', '4'], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const found = scanStrays().filter((s) => s.pid === child.pid);
    assert.equal(found.length, 1, 'the running mock is reported');
    assert.equal(found[0].script, 'tools/mock/mock-streamerbot.mjs');
    assert.equal(await exited, 0, 'the mock exits cleanly after its TTL');
    assert.equal(scanStrays().filter((s) => s.pid === child.pid).length, 0, 'once stopped it is not reported');
    assert.ok(listNodeProcesses().some((p) => p.pid === process.pid), 'the listing includes this process');
  } finally { try { child.kill(); } catch { /* gone */ } }
});
