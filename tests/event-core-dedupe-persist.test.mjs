// SPDX-License-Identifier: GPL-2.0-or-later
// services/event-core dedupe persistence (P3 E7): keys are SHA-256 of "platform:platformMessageId", queued off the hot
// path, written by the audit worker in a new table, and seeded back into memory at start-up. SYNTHETIC ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createDedupe, dedupeKey } from '../services/event-core/dedupe.mjs';
import { createEventCore } from '../services/event-core/index.mjs';
import { DB_NAME } from '../services/event-core/audit/index.mjs';
import { openStore } from '../services/event-core/audit/store.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evdedupe-')); dirs.push(d); return d; };
const msg = (id, platform = 'twitch') => ({ kind: 'chat.message', platform, source: 'mock', platformMessageId: id, user: { platformUserId: 'u1', displayName: 'A' }, text: 'x' });
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('dedupeKey is SHA-256 of "platform:platformMessageId"', () => {
  assert.equal(dedupeKey('twitch', 'abc'), sha('twitch:abc'));
  assert.notEqual(dedupeKey('twitch', 'abc'), dedupeKey('kick', 'abc'));
});

test('dedupe: onSeen gets the key hash once per first sighting, never the raw id', () => {
  const seen = [];
  const d = createDedupe({ onSeen: (k) => seen.push(k) });
  assert.equal(d.isDuplicate({ platform: 'twitch', platformMessageId: 'raw-1' }, 0), false);
  assert.equal(d.isDuplicate({ platform: 'twitch', platformMessageId: 'raw-1' }, 5), true);
  assert.deepEqual(seen, [sha('twitch:raw-1')]);
  assert.ok(!seen.join().includes('raw-1'));
});

test('dedupe: seed carries the wall age onto the monotonic clock, drops expired keys, keeps order', () => {
  const d = createDedupe({ windowMs: 1000 });
  const ev = (id) => ({ platform: 'twitch', platformMessageId: id });
  d.isDuplicate(ev('fresh-live'), 1000); // seen after start, before the seed arrives
  const added = d.seed([
    { key: dedupeKey('twitch', 'old'), seen_at: 100 },      // age 900 at wall 1000: still inside
    { key: dedupeKey('twitch', 'expired'), seen_at: -50 },  // age 1050: outside
    { key: dedupeKey('twitch', 'fresh-live'), seen_at: 900 }, // already present: ignored
  ], 1000, 1000);
  assert.equal(added, 1);
  assert.equal(d.isDuplicate(ev('old'), 1050), true);
  assert.equal(d.isDuplicate(ev('expired'), 1050), false);
  assert.equal(d.isDuplicate(ev('old'), 1099), true, 'seeded at mono 100, window 1000: alive until 1100');
  assert.equal(d.isDuplicate(ev('old'), 1101), false, 'expired after 1100');
  assert.equal(d.stats().seeded, 1);
  assert.equal(d.stats().duplicatesFromSeed >= 1, true);
});

test('restart: keys written before a clean close are seeded; same ids are deduped, new ids are not; no raw id on disk', async () => {
  const dir = tmp();
  const key = Buffer.alloc(32, 7);
  const first = createEventCore({ key, audit: { dataDir: dir } });
  await first.ready;
  for (const id of ['r-1', 'r-2', 'r-3']) assert.equal(first.ingest(msg(id)).status, 'published');
  assert.equal(first.ingest(msg('r-1')).status, 'deduped');
  await first.audit.close();

  const rows = (() => { const s = openStore({ file: path.join(dir, DB_NAME), readOnly: true }); try { return s.db.prepare('SELECT key, seen_at FROM dedupe_keys').all().map((r) => ({ ...r })); } finally { s.close(); } })();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.key).sort(), ['r-1', 'r-2', 'r-3'].map((i) => dedupeKey('twitch', i)).sort());
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(DB_NAME) || f.endsWith('.lock')) continue;
    const b = readFileSync(path.join(dir, f));
    // the raw platform message id appears in chat_raw only as event ids (not at all), and never in the dedupe table
    assert.equal(b.includes(Buffer.from('twitch:r-1')), false, f);
  }

  const second = createEventCore({ key, audit: { dataDir: dir } });
  await second.ready;
  assert.equal(second.stats().dedupe.seeded, 3);
  assert.equal(second.ingest(msg('r-2')).status, 'deduped');
  assert.equal(second.ingest(msg('r-4')).status, 'published');
  assert.equal(second.ingest(msg('r-2', 'kick')).status, 'published', 'same id on another platform is a different key');
  await second.audit.close();
});

test('restart: keys older than the window are not seeded; the writer prunes keys past the keep time', async () => {
  const dir = tmp();
  let wall = 1_000_000;
  const key = Buffer.alloc(32, 7);
  const a = createEventCore({ key, wall: () => wall, audit: { dataDir: dir } });
  await a.ready;
  a.ingest(msg('old-1'));
  await a.audit.flush();
  wall += 200_000; // 200 s later: past the 120 s window and the 150 s keep time
  a.ingest(msg('new-1'));
  await a.audit.flush();
  wall += 31_000; // a later batch triggers the (30 s spaced) prune
  a.ingest(msg('new-2'));
  await a.audit.close();
  const s = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  const keys = s.db.prepare('SELECT key FROM dedupe_keys').all().map((r) => r.key);
  s.close();
  assert.equal(keys.includes(dedupeKey('twitch', 'old-1')), false, 'pruned');
  assert.equal(keys.includes(dedupeKey('twitch', 'new-1')), true);
  const b = createEventCore({ key, wall: () => wall + 1000, audit: { dataDir: dir } });
  await b.ready;
  assert.equal(b.ingest(msg('new-2')).status, 'deduped');
  assert.equal(b.ingest(msg('old-1')).status, 'published');
  await b.audit.close();
});

test('no audit attached: dedupe stays memory-only and ready resolves', async () => {
  const c = createEventCore({ key: Buffer.alloc(32, 7) });
  await c.ready;
  assert.equal(c.ingest(msg('m-1')).status, 'published');
  assert.equal(c.ingest(msg('m-1')).status, 'deduped');
});
