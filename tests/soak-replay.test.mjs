// SPDX-License-Identifier: GPL-3.0-or-later
// tools/soak/replay.mjs (P3 E7): export choice, timeline (gap cap, looping, unique ids), memory-growth maths, and one short
// end-to-end replay on a SYNTHETIC export (invented text, temp data root): child core, mock Streamer.bot, purge proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllMocks, openMocks } from '../tools/mock/mock-streamerbot.mjs';
import { openChildren, stopTracked } from '../tools/proc-registry.mjs';
import { chooseExport, envelope, main, memoryGrowth, pct, readExports, timeline } from '../tools/soak/replay.mjs';

const dirs = [];
test.after(async () => {
  const killed = await stopTracked(); const closed = await closeAllMocks();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  assert.equal(openMocks() + openChildren(), 0, 'a mock or child process was left open');
  assert.equal(killed + closed, 0, `teardown had to clean up ${killed} child(ren) and ${closed} mock(s): a test did not clean up after itself`);
});
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evsoak-')); dirs.push(d); return d; };
const comment = (id, off, body, who = 'tester') => ({ _id: id, content_offset_seconds: off, commenter: { _id: `c-${who}`, name: who, display_name: who }, message: { body } });
const writeExport = (dir, name, length, comments) => writeFileSync(path.join(dir, name), JSON.stringify({ video: { length }, comments }));

test('export choice: longest of at least 2 h that holds a message; none -> null', () => {
  const dir = tmp();
  writeExport(dir, 'a.json', 9000, [comment('1', 10, 'synthetic hello one')]);
  writeExport(dir, 'b.json', 30000, []);                                   // longest but empty
  writeExport(dir, 'c.json', 12000, [comment('2', 5, 'synthetic hello two')]);
  writeExport(dir, 'd.json', 3000, [comment('3', 5, 'synthetic hello three')]); // too short
  writeFileSync(path.join(dir, 'broken.json'), '{nope');
  const all = readExports(dir);
  assert.equal(all.length, 4);
  assert.equal(chooseExport(all).file, 'c.json');
  assert.equal(chooseExport(all.filter((e) => e.lengthS < 7200)), null);
});

test('timeline: lead-in dropped, gaps kept, gap cap, loop passes get unique ids', () => {
  const msgs = [{ off: 100, id: 'a', text: 't', uid: 'u', login: 'l', name: 'n' }, { off: 110, id: 'b', text: 't', uid: 'u', login: 'l', name: 'n' }, { off: 500, id: 'c', text: 't', uid: 'u', login: 'l', name: 'n' }];
  assert.deepEqual([...timeline(msgs)].map((i) => i.tRel), [0, 10, 400]);
  assert.deepEqual([...timeline(msgs, { maxGapS: 2 })].map((i) => i.tRel), [0, 2, 4]);
  const it = timeline(msgs, { maxGapS: 2, loop: true });
  const first = Array.from({ length: 6 }, () => it.next().value);
  assert.deepEqual(first.map((i) => i.tRel), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(first.map((i) => envelope(i).data.messageId), ['a', 'b', 'c', 'a~1', 'b~1', 'c~1']);
  assert.deepEqual(first.map((i) => i.seq), [1, 2, 3, 4, 5, 6]);
});

test('percentile helper and memory growth: warm-up, 5 % or 100 MB rule, short run is N/A', () => {
  assert.equal(pct([5, 1, 3, 2, 4], 0.5), 3);
  const rows = (f) => Array.from({ length: 40 }, (_, i) => ({ t: i * 60, rssMB: f(i), heapUsedMB: 10 }));
  const flat = memoryGrowth(rows((i) => 100 + (i < 10 ? i * 20 : 0)));   // grows only inside the warm-up
  assert.equal(flat.status, 'PASS');
  assert.equal(flat.rss.growthMB, 0);
  const leak = memoryGrowth(rows((i) => 100 + i * 10));                    // +10 MB/min after warm-up: over 5 % and over 100 MB
  assert.equal(leak.status, 'FAIL');
  const small = memoryGrowth(rows((i) => 100 + (i >= 10 ? (i - 10) * 0.1 : 0)));
  assert.equal(small.status, 'PASS');
  assert.equal(memoryGrowth([{ t: 0, rssMB: 1, heapUsedMB: 1 }, { t: 100, rssMB: 1, heapUsedMB: 1 }]).status, 'N/A');
});

test('end-to-end: replay a synthetic export through the real connector, core, gate, audit and SSE; purge leaves no text', { timeout: 300000 }, async () => {
  const root = tmp();
  mkdirSync(path.join(root, 'chat', 'twitch'), { recursive: true });
  writeExport(path.join(root, 'chat', 'twitch'), 'x.json', 9000, [
    comment('s1', 50, 'synthetic message alpha', 'zedwriter'), comment('s2', 51, 'synthetic message bravo', 'yankeefan'), comment('s3', 52, 'synthetic message charlie', 'zedwriter'),
  ]);
  const r = await main(['--data-root', root, '--speed', '10', '--max-gap-s', '0.5', '--duration-s', '4', '--sample-s', '1', '--run-id', 'unit', '--quiet']);
  assert.ok(r.harness.sent >= 20, `sent ${r.harness.sent}`);
  assert.equal(r.drain.drained, true, JSON.stringify(r.drain));
  assert.equal(r.connector.published, r.harness.sent);
  assert.equal(r.ingestToDispatchMs.n, r.harness.sent);
  assert.equal(r.busToSseMs.n, r.harness.sent);
  assert.equal(r.auditVerify.ok, true);
  assert.equal(r.stub.probes, r.harness.sent);
  assert.ok(r.stub.refused['chat-forbidden'] > 0 && r.stub.refused['chat-not-allowed'] > 0);
  assert.equal(r.drops.sse, 0);
  assert.equal(r.purge.exit, 0);
  assert.ok(r.purge.before.counts.chatRaw > 0 && r.purge.after.counts.chatRaw === 0);
  assert.ok(r.purge.before.scan.bodyHits > 0, 'the scan does find text before the purge');
  assert.equal(r.purge.after.scan.bodyHits + r.purge.after.scan.nameHits + r.purge.otherRunFiles.bodyHits + r.purge.otherRunFiles.nameHits, 0);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'soak', 'unit', 'result.json'), 'utf8')).mode, 'replay');
});
