// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/audit: schema and migrations, hash chain, tamper and truncation detection, append-only triggers,
// single-writer lock, queue overflow, retention (boundary, startup, daily timer, manual), secure delete.
// Temp dirs and injected clocks only. SYNTHETIC rows; the marker strings are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAudit, AuditError, DB_NAME } from '../services/event-core/audit/index.mjs';
import { openStore, DAY_MS } from '../services/event-core/audit/store.mjs';
import { MIGRATIONS, migrate } from '../services/event-core/audit/schema.mjs';
import { acquireLock } from '../services/event-core/audit/lock.mjs';
import { auditCommand } from '../services/event-core/audit/cli.mjs';
import { canonicalRow, chainHash, GENESIS } from '../services/event-core/audit/chain.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evaudit-')); dirs.push(d); return d; };
const row = (i, over = {}) => ({ ts: '2026-10-28T00:00:00.000Z', type: 'decision', subtype: 'request', action_id: 'state.read', source: 'ui', verdict: 'allow', reason: 'read', detail: `{"n":${i}}`, ...over });
const raw = (id, at, text = 'hello') => ({ event_id: id, received_at: at, platform: 'twitch', display_name: 'Name', text });
const bytesOf = (dir) => readdirSync(dir).filter((f) => f.startsWith(DB_NAME) && !f.endsWith('.lock')).map((f) => [f, readFileSync(path.join(dir, f))]);
const hits = (dir, marker) => bytesOf(dir).filter(([, b]) => b.includes(Buffer.from(marker, 'utf8'))).map(([f]) => f);

function seeded(n = 20) {
  const dir = tmp();
  const file = path.join(dir, DB_NAME);
  const s = openStore({ file });
  s.appendBatch(Array.from({ length: n }, (_, i) => row(i)), []);
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { dir, file, s };
}
/** Copy of a closed database, opened raw with the triggers dropped, for tamper tests. */
function tampered(file, mutate) {
  const dir = tmp();
  const copy = path.join(dir, 'copy.db');
  copyFileSync(file, copy);
  const db = new DatabaseSync(copy);
  db.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;');
  mutate(db);
  db.close();
  return openStore({ file: copy, readOnly: true });
}

// ---------- schema and migrations ----------

test('migrations from an empty database: version table, tables, triggers, pragmas', () => {
  const dir = tmp();
  const s = openStore({ file: path.join(dir, DB_NAME) });
  const st = s.stats();
  assert.deepEqual(s.migrated, { from: 0, to: 3 });
  assert.equal(st.version, 3);
  assert.equal(st.journalMode, 'wal');
  assert.equal(st.synchronous, 2); // FULL
  assert.equal(st.secureDelete, 1);
  assert.equal(st.autoVacuum, 2); // INCREMENTAL
  const names = s.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map((r) => r.name);
  for (const n of ['schema_version', 'audit', 'audit_head', 'chat_raw', 'dedupe_keys', 'action_keys', 'audit_no_update', 'audit_no_delete']) assert.ok(names.includes(n), n);
  assert.deepEqual(s.db.prepare('SELECT version, name FROM schema_version').all().map((r) => ({ ...r })), [{ version: 1, name: 'initial' }, { version: 2, name: 'dedupe-keys' }, { version: 3, name: 'action-keys' }]);
  s.close();
  const again = openStore({ file: path.join(dir, DB_NAME) }); // reopen: nothing re-applied
  assert.deepEqual(again.migrated, { from: 3, to: 3 });
  again.close();
});

test('migration v2 -> v3 on an existing database keeps its rows and adds action_keys', () => {
  const file = path.join(tmp(), DB_NAME);
  const old = new DatabaseSync(file); // a database written by the v2 code (E7)
  assert.deepEqual(migrate(old, MIGRATIONS.slice(0, 2)), { from: 0, to: 2 });
  old.prepare('INSERT INTO dedupe_keys (key, seen_at) VALUES (?, ?)').run('d'.repeat(64), 123);
  old.close();
  const s = openStore({ file });
  assert.deepEqual(s.migrated, { from: 2, to: 3 });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM dedupe_keys').get().n, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM action_keys').get().n, 0);
  s.close();
});

test('migrations go forward only: an injected v4 applies once, a failing one rolls back, a newer database is refused', () => {
  const dir = tmp();
  const file = path.join(dir, DB_NAME);
  openStore({ file }).close();
  const v4 = { version: 4, name: 'add-col', sql: 'ALTER TABLE chat_raw ADD COLUMN lang TEXT;' };
  const s = openStore({ file, migrations: [...MIGRATIONS, v4] });
  assert.deepEqual(s.migrated, { from: 3, to: 4 });
  assert.ok(s.db.prepare('PRAGMA table_info(chat_raw)').all().some((c) => c.name === 'lang'));
  s.close();
  // the old code now sees a newer schema
  assert.throws(() => openStore({ file }), (e) => e.code === 'SCHEMA_TOO_NEW');
  // a failing migration leaves the version unchanged
  const dir2 = tmp();
  const f2 = path.join(dir2, DB_NAME);
  openStore({ file: f2 }).close();
  assert.throws(() => openStore({ file: f2, migrations: [...MIGRATIONS, { version: 4, name: 'bad', sql: 'CREATE TABLE ok_part (x); THIS IS NOT SQL;' }] }));
  const chk = openStore({ file: f2 });
  assert.equal(chk.stats().version, 3);
  assert.equal(chk.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok_part'").get().n, 0);
  chk.close();
  // migrate() itself on a bare connection
  const raw0 = new DatabaseSync(':memory:');
  assert.deepEqual(migrate(raw0, MIGRATIONS, () => 0), { from: 0, to: 3 });
});

// ---------- chain, triggers, tamper ----------

test('chain: hash = SHA-256(prev_hash || canonical row JSON), genesis prev, ids from 1', () => {
  const { s } = seeded(3);
  const rows = s.db.prepare('SELECT * FROM audit ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.equal(rows[0].prev_hash, GENESIS);
  assert.equal(rows[1].prev_hash, rows[0].hash);
  assert.equal(rows[2].hash, chainHash(rows[2].prev_hash, rows[2]));
  assert.equal(canonicalRow({ id: 1, ts: 't' }), '[1,"t",null,null,null,null,null,null,null,null,null,null]');
  const h = s.db.prepare('SELECT * FROM audit_head').get();
  assert.deepEqual({ ...h }, { k: 1, last_id: 3, row_count: 3, head_hash: rows[2].hash });
  assert.equal(s.verify().ok, true);
  s.close();
});

test('triggers: UPDATE and DELETE on audit are refused; chat_raw is not protected', () => {
  const { s } = seeded(3);
  assert.throws(() => s.db.exec("UPDATE audit SET reason = 'x' WHERE id = 1"), /append-only/);
  assert.throws(() => s.db.exec('DELETE FROM audit WHERE id = 1'), /append-only/);
  assert.throws(() => s.db.exec('DELETE FROM audit'), /append-only/);
  assert.equal(s.verify().ok, true);
  s.appendBatch([], [raw('e1', 1)]);
  s.db.exec('DELETE FROM chat_raw'); // purge must be able to delete
  s.close();
});

test('a failed batch rolls back whole and the chain head stays correct', () => {
  const { s } = seeded(2);
  assert.throws(() => s.appendBatch([row(1), { ...row(2), ts: null }], [raw('e1', 1)])); // ts NOT NULL
  assert.equal(s.stats().auditRows, 2);
  assert.equal(s.stats().rawRows, 0);
  s.appendBatch([row(3)], []);
  assert.equal(s.verify().ok, true);
  assert.equal(s.stats().auditRows, 3);
  s.close();
});

test('tamper: editing a row (triggers dropped in a copy) is found at that row id', () => {
  const { file, s } = seeded(20);
  s.close();
  const t = tampered(file, (db) => db.exec("UPDATE audit SET reason = 'edited' WHERE id = 7"));
  const v = t.verify();
  assert.equal(v.ok, false);
  assert.equal(v.firstBadId, 7);
  assert.equal(v.reason, 'hash-mismatch');
  t.close();
});

test('tamper: rewriting a row AND its hash breaks the next link', () => {
  const { file, s } = seeded(10);
  s.close();
  const t = tampered(file, (db) => {
    const r = db.prepare('SELECT * FROM audit WHERE id = 4').get();
    const edited = { ...r, reason: 'edited' };
    db.prepare('UPDATE audit SET reason = ?, hash = ? WHERE id = 4').run('edited', chainHash(r.prev_hash, edited));
  });
  const v = t.verify();
  assert.deepEqual([v.ok, v.firstBadId, v.reason], [false, 5, 'prev-mismatch']);
  t.close();
});

test('tamper: deleting a middle row is an id gap; truncating the tail is caught by the head record', () => {
  const { file, s } = seeded(20);
  s.close();
  const gap = tampered(file, (db) => db.exec('DELETE FROM audit WHERE id = 9'));
  assert.deepEqual([gap.verify().firstBadId, gap.verify().reason], [9, 'id-gap']);
  gap.close();
  const cut = tampered(file, (db) => db.exec('DELETE FROM audit WHERE id > 15'));
  const v = cut.verify();
  assert.deepEqual([v.ok, v.firstBadId, v.reason, v.rows], [false, 16, 'truncated', 15]);
  cut.close();
  const extra = tampered(file, (db) => db.exec("UPDATE audit_head SET row_count = 5, last_id = 5, head_hash = (SELECT hash FROM audit WHERE id = 5)"));
  assert.equal(extra.verify().ok, false); // rows behind the head
  extra.close();
  const nohead = tampered(file, (db) => db.exec('DELETE FROM audit_head'));
  assert.equal(nohead.verify().reason, 'head-missing');
  nohead.close();
});

// ---------- CLI: verify exit codes ----------

test('cli verify: exit 0 on a good chain, exit 1 with the first bad row id on a bad one', () => {
  const { dir, file, s } = seeded(12);
  s.close();
  const run = (d) => spawnSync(process.execPath, [path.join(repo, 'services', 'event-core', 'cli.mjs'), 'audit', 'verify', '--data-dir', d], { encoding: 'utf8', windowsHide: true });
  const ok = run(dir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /audit verify: OK rows=12 integrity=ok/);
  const badDir = tmp();
  copyFileSync(file, path.join(badDir, DB_NAME));
  const db = new DatabaseSync(path.join(badDir, DB_NAME));
  db.exec("DROP TRIGGER audit_no_update; UPDATE audit SET verdict = 'x' WHERE id = 3");
  db.close();
  const bad = run(badDir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL first bad row id=3 reason=hash-mismatch/);
  assert.equal(run(tmp()).status, 1); // no database
});

// ---------- single writer ----------

test('second writer in the same process is refused until the first closes', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false });
  await a.ready;
  assert.throws(() => createAudit({ dataDir: dir, mode: 'inline' }), (e) => e instanceof AuditError && e.code === 'DB_LOCKED');
  assert.throws(() => acquireLock(dir), (e) => e.code === 'DB_LOCKED');
  await a.close();
  const b = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false });
  await b.ready;
  await b.close();
});

test('second writer in another process is refused, and the lock is free after the owner dies', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false });
  await a.ready;
  const url = pathToFileURL(path.join(repo, 'services', 'event-core', 'audit', 'index.mjs')).href;
  const code = `import(${JSON.stringify(url)}).then(m => { try { m.createAudit({ dataDir: process.argv[1], mode: 'inline' }); console.log('GOT'); } catch (e) { console.log(e.code); } process.exit(0); })`;
  const r = spawnSync(process.execPath, ['-e', code, dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.stdout.trim(), 'DB_LOCKED');
  await a.close();
  const r2 = spawnSync(process.execPath, ['-e', code, dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(r2.stdout.trim(), 'GOT');
});

// ---------- queue overflow ----------

test('overflow: a full queue drops and counts without blocking, and the next batch carries an audit-overflow row', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false, queueMax: 5, rawQueueMax: 3, batchMax: 1000, batchMs: 60_000 });
  await a.ready;
  const t0 = performance.now();
  for (let i = 0; i < 12; i++) a.recordSystem({ subtype: 'burst', detail: { i } });
  for (let i = 0; i < 10; i++) a.observe({ kind: 'chat.message', id: `e000000000000-0000000${i}-aaaaaaaa`, platform: 'twitch', text: `synthetic ${i}`, user: { displayName: 'n', pseudoId: 'a'.repeat(32) } });
  assert.ok(performance.now() - t0 < 50, 'record calls do not block');
  assert.equal(a.stats().droppedA, 7);
  assert.equal(a.stats().droppedR, 7);
  await a.flush();
  const s = a.stats();
  assert.equal(s.writtenA, 6); // 5 kept + the overflow row
  assert.equal(s.writtenR, 3);
  assert.equal(await a.verify().then((v) => v.ok), true);
  await a.close();
  const rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  const o = rd.db.prepare("SELECT * FROM audit WHERE subtype = 'audit-overflow'").get();
  assert.equal(o.type, 'system');
  assert.deepEqual(JSON.parse(o.detail), { droppedAudit: 7, droppedRaw: 7 });
  rd.close();
});

test('overflow with the worker writer: a flood never throws and the books balance', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, purgeOnStart: false, queueMax: 500, batchMax: 100, batchMs: 5 });
  await a.ready;
  for (let i = 0; i < 20_000; i++) a.recordSystem({ subtype: 'flood', detail: { i } });
  await a.flush();
  const s = a.stats();
  assert.equal(s.enqueuedA + s.droppedA, 20_000);
  assert.ok(s.droppedA > 0, 'the cap was hit');
  assert.ok(s.writtenA >= s.enqueuedA);
  assert.equal((await a.verify()).ok, true);
  await a.close();
});

// ---------- retention ----------

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

test('purge boundary: exactly 30 days is kept, 1 ms older is deleted, 1 ms younger is kept', () => {
  const dir = tmp();
  const s = openStore({ file: path.join(dir, DB_NAME) });
  const cut = NOW - 30 * DAY_MS;
  s.appendBatch([], [raw('older', cut - 1), raw('exact', cut), raw('younger', cut + 1), raw('fresh', NOW)]);
  const r = s.purge({ now: NOW, mode: 'startup' });
  assert.equal(r.purged, 1);
  assert.deepEqual(s.db.prepare('SELECT event_id FROM chat_raw ORDER BY received_at').all().map((x) => x.event_id), ['exact', 'younger', 'fresh']);
  // one audit row, count only
  const last = s.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([last.type, last.subtype, last.reason, last.ts], ['system', 'purge', 'retention', new Date(NOW).toISOString()]);
  assert.deepEqual(JSON.parse(last.detail), { purged: 1, mode: 'startup', olderThanDays: 30 });
  // nothing older than the cutoff remains
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM chat_raw WHERE received_at < ?').get(cut).n, 0);
  assert.equal(s.verify().ok, true);
  // configurable cutoff
  assert.equal(s.purge({ now: NOW, olderThanDays: 0 }).purged, 2); // everything strictly older than now
  assert.equal(s.stats().rawRows, 1);
  assert.throws(() => s.purge({ now: NOW, olderThanDays: -1 }), RangeError);
  assert.throws(() => s.purge({ now: NOW, olderThanDays: Number.NaN }), RangeError);
  s.close();
});

test('purge keeps what the audit needs: action, rule, result, timestamp and pseudo id survive', () => {
  const dir = tmp();
  const s = openStore({ file: path.join(dir, DB_NAME) });
  const pseudo = 'ab'.repeat(16);
  s.appendBatch([{ ts: '2026-09-01T00:00:00.000Z', type: 'decision', subtype: 'request', event_id: 'e000000000001-00000000-aaaaaaaa', pseudo_id: pseudo, action_id: 'effect.fire', rule_id: 'rule-x', source: 'rule', verdict: 'refuse', reason: 'chat-not-allowed', detail: null }], [raw('e000000000001-00000000-aaaaaaaa', NOW - 40 * DAY_MS, 'MARKER-OLD')]);
  s.purge({ now: NOW });
  const a = s.db.prepare("SELECT * FROM audit WHERE type = 'decision'").get();
  assert.deepEqual([a.action_id, a.rule_id, a.verdict, a.reason, a.ts, a.pseudo_id], ['effect.fire', 'rule-x', 'refuse', 'chat-not-allowed', '2026-09-01T00:00:00.000Z', pseudo]);
  assert.equal(s.stats().rawRows, 0);
  s.close();
});

test('startup purge runs once the writer is ready (injected clock) and writes one audit row', async () => {
  const dir = tmp();
  const seed = openStore({ file: path.join(dir, DB_NAME) });
  seed.appendBatch([], [raw('old', NOW - 31 * DAY_MS), raw('new', NOW - 29 * DAY_MS)]);
  seed.close();
  const a = createAudit({ dataDir: dir, mode: 'inline', now: () => NOW });
  await a.ready;
  const rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.deepEqual(rd.db.prepare('SELECT event_id FROM chat_raw').all().map((r) => r.event_id), ['new']);
  const p = rd.db.prepare("SELECT detail FROM audit WHERE subtype = 'purge'").all();
  assert.equal(p.length, 1);
  assert.deepEqual(JSON.parse(p[0].detail), { purged: 1, mode: 'startup', olderThanDays: 30 });
  rd.close();
  await a.close();
  // purgeOnStart:false skips it
  const dir2 = tmp();
  const s2 = openStore({ file: path.join(dir2, DB_NAME) });
  s2.appendBatch([], [raw('old', NOW - 99 * DAY_MS)]);
  s2.close();
  const b = createAudit({ dataDir: dir2, mode: 'inline', now: () => NOW, purgeOnStart: false });
  await b.ready;
  assert.equal((await b.purge({ mode: 'manual' })).purged, 1);
  await b.close();
});

test('daily timer: 24 h interval through an injected scheduler; each tick purges with the clock at that time; closing clears it', async () => {
  const dir = tmp();
  let clock = NOW;
  const timers = [];
  const scheduler = { setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; }, clearInterval: (h) => { timers[h].cleared = true; } };
  const a = createAudit({ dataDir: dir, mode: 'inline', now: () => clock, scheduler, purgeOnStart: false });
  await a.ready;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 24 * 3600 * 1000);
  a.observe({ kind: 'chat.message', id: 'e000000000000-00000000-aaaaaaaa', platform: 'twitch', text: 'synthetic', user: { displayName: 'n', pseudoId: 'a'.repeat(32) } });
  await a.flush();
  await timers[0].fn(); // day 0: nothing old
  let rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.equal(rd.stats().rawRows, 1);
  rd.close();
  clock = NOW + 31 * DAY_MS; // 31 days later
  await timers[0].fn();
  rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.equal(rd.stats().rawRows, 0);
  const modes = rd.db.prepare("SELECT detail FROM audit WHERE subtype = 'purge' ORDER BY id").all().map((r) => JSON.parse(r.detail));
  assert.deepEqual(modes.map((m) => [m.mode, m.purged]), [['daily', 0], ['daily', 1]]);
  rd.close();
  await a.close();
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[0].fn(), undefined); // closed: a late tick does nothing
});

test('the default daily timer is unref\'d', async () => {
  const dir = tmp();
  const real = globalThis.setInterval;
  const seen = [];
  globalThis.setInterval = (...args) => { const t = real(...args); seen.push(t); return t; };
  let a;
  try { a = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false }); } finally { globalThis.setInterval = real; }
  await a.ready;
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].hasRef(), false);
  await a.close();
});

// ---------- manual purge ----------

const io = (confirm) => { const lines = []; return { lines, out: (s) => lines.push(s), ...(confirm === undefined ? {} : { confirm: async () => confirm }) }; };
const cliArgs = (dir, extra = {}, rest = []) => ({ _: ['audit', 'purge', ...rest], 'data-dir': dir, ...extra });

test('manual purge: --older-than-days, default 30, bad values refused', async () => {
  const dir = tmp();
  const s = openStore({ file: path.join(dir, DB_NAME) });
  const t = Date.now();
  s.appendBatch([], [raw('d40', t - 40 * DAY_MS), raw('d20', t - 20 * DAY_MS), raw('d5', t - 5 * DAY_MS)]);
  s.close();
  const o = io();
  assert.equal(await auditCommand(cliArgs(dir), o), 0);
  assert.match(o.lines[0], /removed 1 raw chat rows older than 30 days/);
  assert.equal(await auditCommand(cliArgs(dir, { 'older-than-days': '10' }), o), 0);
  assert.match(o.lines[1], /removed 1 raw chat rows older than 10 days/);
  assert.equal(await auditCommand(cliArgs(dir, { 'older-than-days': 'abc' }), o), 1);
  assert.equal(await auditCommand(cliArgs(dir, { 'older-than-days': '-3' }), o), 1);
  assert.equal(await auditCommand(cliArgs(dir, { all: true, 'older-than-days': '3' }), o), 1);
  const rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.equal(rd.stats().rawRows, 1);
  assert.equal(rd.verify().ok, true);
  rd.close();
});

test('manual purge --all needs the typed word yes; anything else deletes nothing', async () => {
  const dir = tmp();
  const s = openStore({ file: path.join(dir, DB_NAME) });
  s.appendBatch([], [raw('a', Date.now()), raw('b', Date.now())]);
  s.close();
  for (const typed of ['', 'y', 'Yes', 'no', 'yes please']) {
    const o = io(typed);
    assert.equal(await auditCommand(cliArgs(dir, { all: true }), o), 1, typed);
    assert.match(o.lines[0], /not confirmed/);
  }
  const noTty = io(); // no confirm hook and stdin is not a terminal under test -> empty answer
  assert.equal(await auditCommand(cliArgs(dir, { all: true }), noTty), 1);
  let rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.equal(rd.stats().rawRows, 2);
  rd.close();
  const ok = io('yes');
  assert.equal(await auditCommand(cliArgs(dir, { all: true }), ok), 0);
  assert.match(ok.lines[0], /removed 2 raw chat rows \(all\)/);
  const flagged = io(); // --confirm yes on the command line counts as the typed word
  assert.equal(await auditCommand(cliArgs(dir, { all: true, confirm: 'yes' }), flagged), 0);
  rd = openStore({ file: path.join(dir, DB_NAME), readOnly: true });
  assert.equal(rd.stats().rawRows, 0);
  assert.equal(rd.verify().ok, true);
  rd.close();
});

test('manual purge is refused while the event core owns the database', async () => {
  const dir = tmp();
  const a = createAudit({ dataDir: dir, mode: 'inline', purgeOnStart: false });
  await a.ready;
  const o = io();
  assert.equal(await auditCommand(cliArgs(dir), o), 1);
  assert.match(o.lines[0], /event core is running/);
  await a.close();
  assert.equal(await auditCommand(cliArgs(dir), io()), 0);
  assert.equal(await auditCommand(cliArgs(tmp()), io()), 0); // no database: nothing to do
});

// ---------- secure delete: the purged string is not in the file bytes ----------

test('secure delete: a purged marker is in the database file before the purge and in no db or WAL byte after it', async () => {
  const dir = tmp();
  const marker = 'ZQXJ-SECDEL-MARKER-7731';
  const s = openStore({ file: path.join(dir, DB_NAME) });
  // many rows, some long enough to use overflow pages, so the marker spans leaf and overflow pages
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push(raw(`e${i}`, NOW - 40 * DAY_MS, `${marker} ${i} ${'x'.repeat(i % 7 === 0 ? 5000 : 40)}`));
  rows.push(raw('keep', NOW, 'KEEP-ME-STAYS'));
  s.appendBatch([row(1)], rows);
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.deepEqual(hits(dir, marker), [DB_NAME], 'marker is in the live database file before the purge');
  s.appendBatch([], [raw('in-wal', NOW - 40 * DAY_MS, marker)]); // and once more, left in the WAL
  assert.ok(hits(dir, marker).includes(`${DB_NAME}-wal`), 'marker is in the WAL before the purge');
  const sizeBefore = readFileSync(path.join(dir, DB_NAME)).length;
  const r = s.purge({ now: NOW });
  assert.equal(r.purged, 1501);
  assert.deepEqual(hits(dir, marker), [], 'no db or WAL byte holds the marker after the purge');
  assert.ok(hits(dir, 'KEEP-ME-STAYS').includes(DB_NAME), 'rows that are kept are still there');
  assert.ok(readFileSync(path.join(dir, DB_NAME)).length < sizeBefore, 'incremental_vacuum returned the freed pages to the OS');
  s.close();
});

test('secure delete: control. Without secure_delete and vacuum the same purge leaves the marker in the file (the check can fail)', () => {
  const dir = tmp();
  const marker = 'ZQXJ-CONTROL-MARKER-5512';
  const db = new DatabaseSync(path.join(dir, DB_NAME));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF; CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
  const ins = db.prepare('INSERT INTO t (x) VALUES (?)');
  for (let i = 0; i < 300; i++) ins.run(`${marker} ${i} ${'y'.repeat(200)}`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('DELETE FROM t');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  assert.ok(hits(dir, marker).length > 0, 'a plain DELETE leaves the text in free pages');
});

test('full purge (--all) also leaves no marker, using VACUUM', () => {
  const dir = tmp();
  const marker = 'ZQXJ-ALLPURGE-MARKER-9090';
  const s = openStore({ file: path.join(dir, DB_NAME) });
  s.appendBatch([], Array.from({ length: 400 }, (_, i) => raw(`e${i}`, NOW, `${marker} ${i} ${'z'.repeat(100)}`)));
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(hits(dir, marker).length > 0);
  s.purge({ now: NOW, all: true });
  assert.deepEqual(hits(dir, marker), []);
  assert.equal(s.stats().rawRows, 0);
  assert.equal(s.verify().ok, true);
  s.close();
});

test('a store opened read-only cannot write', () => {
  const { file, s } = seeded(2);
  s.close();
  const ro = openStore({ file, readOnly: true });
  assert.throws(() => ro.appendBatch([row(1)], []), (e) => e.code === 'READ_ONLY');
  assert.throws(() => ro.purge({ now: NOW }), (e) => e.code === 'READ_ONLY');
  ro.close();
  assert.ok(existsSync(file));
});
