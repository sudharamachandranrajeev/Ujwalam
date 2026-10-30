// SPDX-License-Identifier: GPL-2.0-or-later
// Stall tracer on the live service (2026-10-28): on by default in startService/serve, stall lines only, in the data
// dir, bounded size with rotation, no chat text in records; off with stallTracer: false. All text and names are
// invented. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStallTracer } from '../services/event-core/diag/stall-tracer.mjs';
import { startService, STALL_FILE, STALL_DEFAULTS } from '../services/event-core/api/service.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evstall-')); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('service: the stall tracer is on by default, writes stall lines only, to the data dir, with no chat text', async () => {
  const dataDir = tmp();
  const svc = await startService({ dataDir, noStreamerbot: true, out: () => {} });
  const marker = 'zqx-invented-line-7731';
  const name = 'InventedViewerQ';
  try {
    assert.ok(svc.stallTracer, 'tracer is on by default');
    assert.equal(svc.stallFile, path.join(dataDir, STALL_FILE));
    const s0 = svc.stallTracer.summary();
    assert.deepEqual([s0.thresholdMs, s0.maxBytes, s0.watchdog], [200, STALL_DEFAULTS.maxBytes, 'on']);
    svc.core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'st-1', user: { platformUserId: 'u1', displayName: name }, text: marker });
    await sleep(60);
    busy(400); // one stall over the 200 ms threshold
    await sleep(60);
  } finally { await svc.stop(); }
  const text = readFileSync(svc.stallFile, 'utf8');
  assert.equal(text.includes(marker), false, 'no chat text');
  assert.equal(text.includes(name), false, 'no display name');
  const rows = lines(svc.stallFile);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.kind === 'stall'), 'stall lines only: no window or summary lines');
  assert.ok(rows.some((r) => r.ms > 200 && r.label === 'event-core'));
  // context is audit numbers and op names only
  const ctx = rows.find((r) => r.ms > 200).context;
  assert.deepEqual(Object.keys(ctx), ['audit']);
  assert.deepEqual(Object.keys(ctx.audit).sort(), ['batches', 'failed', 'inflight', 'lastOp', 'lastWrite', 'queued']);
});

test('service: stallTracer false turns it off; no file is written', async () => {
  const dataDir = tmp();
  const svc = await startService({ dataDir, noStreamerbot: true, stallTracer: false, out: () => {} });
  try {
    assert.equal(svc.stallTracer, null);
    busy(300);
    await sleep(30);
  } finally { await svc.stop(); }
  assert.equal(existsSync(path.join(dataDir, STALL_FILE)), false);
});

test('tracer: bounded size; the file rotates to .1 and neither file passes maxBytes; an oversized line is dropped', async () => {
  const dir = tmp();
  const file = path.join(dir, 'stalls.jsonl');
  const maxBytes = 3000;
  let big = false;
  const t = createStallTracer({
    file, thresholdMs: 30, tickMs: 10, flushMs: 20, watchdog: false, stallsOnly: true, maxBytes,
    context: () => (big ? { pad: 'x'.repeat(maxBytes) } : { n: 1 }),
  });
  for (let i = 0; i < 14; i++) { busy(60); await sleep(40); }
  await sleep(600); // pending stalls are finalised 500 ms after detection
  t.flush();
  await sleep(100);
  big = true;
  busy(60);
  await sleep(40);
  const s = await t.stop();
  assert.ok(s.stalls >= 10, `stalls ${s.stalls}`);
  assert.ok(s.rotations >= 1, `rotations ${s.rotations}`);
  assert.ok(s.droppedLines >= 1, 'the oversized line is dropped');
  assert.equal(s.writeErrors, 0);
  assert.ok(statSync(file).size <= maxBytes, `current ${statSync(file).size}`);
  assert.ok(statSync(`${file}.1`).size <= maxBytes, `rotated ${statSync(`${file}.1`).size}`);
  assert.ok(lines(file).every((r) => r.kind === 'stall' && r.context.n === 1));
  assert.equal(existsSync(`${file}.2`), false, 'one rotated file only');
});

test('tracer: the line buffer is bounded when the writer cannot keep up', async () => {
  const t = createStallTracer({ thresholdMs: 20, tickMs: 5, flushMs: 60_000, watchdog: false, stallsOnly: true, maxBuffered: 3 });
  for (let i = 0; i < 8; i++) { busy(40); await sleep(15); }
  const s = await t.stop(); // no file: lines stay in memory, capped
  assert.ok(s.stalls >= 6, `stalls ${s.stalls}`);
  assert.equal(s.droppedLines, s.stalls - 3);
});

test('tracer: writes are asynchronous only (no synchronous fs call in the module)', () => {
  const src = readFileSync(new URL('../services/event-core/diag/stall-tracer.mjs', import.meta.url), 'utf8');
  assert.equal(/\b[a-zA-Z]+Sync\(/.test(src), false);
  assert.match(src, /from 'node:fs\/promises'/);
  assert.equal(/from 'node:fs'/.test(src), false);
});
