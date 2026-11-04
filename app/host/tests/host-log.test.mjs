// SPDX-License-Identifier: GPL-3.0-or-later
// log.tail against a real host (libobs, test card, no devices, no previews): the in-memory ring of the last 1000
// log lines (app/host/src/log.h), its limits, and that token-shaped hex runs never come out of it.
//   node --test app/host/tests/host-log.test.mjs   (needs the built host and the OBS runtime, like host-api)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
// A data dir whose name holds a 40-character hex run: the host logs the dir in its "ready" line, so the ring must
// redact it (the same rule that keeps a mistakenly logged token out of log.tail).
const HEX = randomBytes(20).toString('hex');
const DATA = path.join(OUT, `log-${HEX}`);
let h;

before(async () => {
  mkdirSync(DATA, { recursive: true });
  h = await launchHost({ dataDir: DATA, project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0);
  rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

async function err(params) {
  try { await h.client.call('log.tail', params); } catch (e) { return e; }
  assert.fail('log.tail should have failed');
}

test('log.tail: newest lines, oldest first, default 200, the ready line is there', async () => {
  let r;
  for (let i = 0; i < 40; i++) { // the ready line is written right after the discovery file
    r = await h.client.call('log.tail');
    if (r.lines.some((l) => l.includes('ready: rpc on 127.0.0.1:'))) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(r.capacity, 1000);
  assert.ok(r.lines.length >= 1 && r.lines.length <= 200, `${r.lines.length} lines`);
  assert.ok(r.total >= r.lines.length);
  assert.ok(r.lines.some((l) => l.includes('ready: rpc on 127.0.0.1:')), 'ready line in the tail');
  assert.ok(r.lines.every((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (info|warn|error|debug): /.test(l)), 'timestamped lines');
  const one = await h.client.call('log.tail', { lines: 1 });
  assert.equal(one.lines.length, 1);
  const all = await h.client.call('log.tail', { lines: 1000 });
  assert.ok(all.lines.length >= r.lines.length && all.lines.length <= 1000);
  assert.ok(all.lines.every((l) => Buffer.byteLength(l) <= 1024 + 64), 'lines are capped');
});

test('log.tail: no token and no token-shaped hex run comes out', async () => {
  const { lines } = await h.client.call('log.tail', { lines: 1000 });
  const text = lines.join('\n');
  assert.ok(!text.includes(h.token), 'api token');
  assert.ok(!text.includes(HEX), 'the 40-hex data dir name is redacted');
  assert.ok(text.includes('<redacted-hex>'));
  assert.ok(!/[0-9a-fA-F]{32,}/.test(text));
});

test('log.tail: params are checked', async () => {
  for (const p of [{ lines: 0 }, { lines: 1001 }, { lines: 'x' }, { lines: 1.5 }, { lines: 10, extra: 1 }]) {
    assert.equal((await err(p)).code, -32602, JSON.stringify(p));
  }
});
