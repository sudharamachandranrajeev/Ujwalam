// SPDX-License-Identifier: GPL-2.0-or-later
// Audit store (P3 E5): the synchronous SQLite layer. Node stdlib only (node:sqlite).
// One process owns the database (see lock.mjs); inside it, one thread (the writer worker, or the main thread in
// 'inline' mode) owns this object. Nothing here is on the live path: callers reach it through writer.mjs.
//
// Pragmas (writer): auto_vacuum=INCREMENTAL (set before the first table exists), journal_mode=WAL,
// synchronous=FULL, secure_delete=ON. See docs/evidence/2026-10-28-p3-e5-audit.md for why.

import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLS, GENESIS, chainHash } from './chain.mjs';
import { MIGRATIONS, currentVersion, migrate } from './schema.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DB_NAME = 'event-core.db';
export const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION_DAYS = 30;
const INSERT_COLS = [...COLS, 'prev_hash', 'hash'];
export const DEDUPE_KEEP_MS = 150_000;      // dedupe window is 120 s; keep 30 s of slack before pruning
const DEDUPE_PRUNE_EVERY_MS = 30_000;
export const ACTION_KEEP_MS = 3_600_000;    // idempotency keys: 1 h (livelock/idempotency.mjs DEFAULT_RETENTION_MS)
const ACTION_PRUNE_EVERY_MS = 60_000;

export class AuditError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

/** True when `p` is `root` or below it. Uses the real path of the nearest existing ancestor (symlinks, case). */
export function isInside(p, root = REPO_ROOT) {
  const real = (x) => {
    let cur = path.resolve(x);
    const tail = [];
    while (!existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
    return path.join(realpathSync.native(cur), ...tail);
  };
  const rel = path.relative(real(root), real(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Verifies the whole chain, the head record and PRAGMA integrity_check, in one read snapshot.
 *  Returns { ok, rows, integrity, firstBadId, reason }. Never throws for a damaged chain. */
export function verifyDb(db) {
  const res = { ok: true, rows: 0, integrity: 'ok', firstBadId: null, reason: null };
  const bad = (id, reason) => { if (res.ok) { res.ok = false; res.firstBadId = id; res.reason = reason; } };
  db.exec('BEGIN');
  try {
    const ic = db.prepare('PRAGMA integrity_check').all();
    if (!(ic.length === 1 && ic[0].integrity_check === 'ok')) { res.integrity = 'failed'; res.ok = false; res.reason = 'integrity-check'; }
    let prevHash = GENESIS;
    let prevId = 0;
    let chainBad = false;
    for (const r of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
      res.rows++;
      let why = null;
      if (r.id !== prevId + 1) why = ['id-gap', prevId + 1];
      else if (r.prev_hash !== prevHash) why = ['prev-mismatch', r.id];
      else if (r.hash !== chainHash(r.prev_hash, r)) why = ['hash-mismatch', r.id];
      if (why) { chainBad = true; res.ok = false; res.firstBadId = why[1]; res.reason = why[0]; break; }
      prevHash = r.hash;
      prevId = r.id;
    }
    if (!chainBad) {
      const h = db.prepare('SELECT last_id, row_count, head_hash FROM audit_head WHERE k = 1').get();
      let why = null;
      if (!h) why = 'head-missing';
      else if (h.row_count !== res.rows || h.last_id !== prevId || h.head_hash !== prevHash) {
        // head ahead of the table means rows were cut off the tail; otherwise rows were added behind the head.
        why = h.row_count > res.rows ? 'truncated' : 'head-mismatch';
      }
      if (why) { res.ok = false; res.firstBadId = prevId + 1; res.reason = why; }
    }
  } finally {
    db.exec('COMMIT');
  }
  return res;
}

/** opts: { file, readOnly?, now?, migrations?, synchronous? ('FULL'|'NORMAL') } */
export function openStore(opts) {
  const { file, readOnly = false, now = Date.now, migrations = MIGRATIONS, synchronous = 'FULL' } = opts;
  if (!['FULL', 'NORMAL'].includes(synchronous)) throw new RangeError('synchronous must be FULL or NORMAL');
  if (!readOnly) mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  let head = null;
  let migrated = { from: 0, to: 0 };
  try {
    if (!readOnly) {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL'); // only takes effect before the first table; read back in stats()
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(`PRAGMA synchronous = ${synchronous}`);
      db.exec('PRAGMA secure_delete = ON');
      migrated = migrate(db, migrations, now);
    } else if (currentVersion(db) === 0) {
      throw new AuditError('NOT_AN_AUDIT_DB', 'no audit schema in this database');
    }
  } catch (e) { try { db.close(); } catch { /* ignore */ } throw e; }

  const loadHead = () => { const h = db.prepare('SELECT last_id, row_count, head_hash FROM audit_head WHERE k = 1').get(); head = { id: h.last_id, count: h.row_count, hash: h.head_hash }; };
  let insA; let insR; let updH; let delOld; let delAll; let insD; let delD; let insXs; let insXd; let delX;
  let lastDedupePrune = 0;
  let lastActionPrune = 0;
  if (!readOnly) {
    loadHead();
    insD = db.prepare('INSERT OR IGNORE INTO dedupe_keys (key, seen_at) VALUES (?, ?)');
    delD = db.prepare('DELETE FROM dedupe_keys WHERE seen_at < ?');
    // A start for a key whose last outcome was 'refused' (did not run) is a fresh attempt: clear the refusal, keep the
    // first started_at. Any other existing row is left as it is.
    insXs = db.prepare("INSERT INTO action_keys (key, started_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET completed_at = NULL, outcome = NULL WHERE action_keys.outcome = 'refused'");
    insXd = db.prepare('INSERT INTO action_keys (key, started_at, completed_at, outcome) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET completed_at = excluded.completed_at, outcome = excluded.outcome');
    delX = db.prepare('DELETE FROM action_keys WHERE started_at < ?');
    insA = db.prepare(`INSERT INTO audit (${INSERT_COLS.join(',')}) VALUES (${INSERT_COLS.map(() => '?').join(',')})`);
    insR = db.prepare('INSERT OR IGNORE INTO chat_raw (event_id, received_at, platform, display_name, text) VALUES (?, ?, ?, ?, ?)');
    updH = db.prepare('UPDATE audit_head SET last_id = ?, row_count = ?, head_hash = ? WHERE k = 1');
    delOld = db.prepare('DELETE FROM chat_raw WHERE received_at < ?');
    delAll = db.prepare('DELETE FROM chat_raw');
  }
  const needWrite = () => { if (readOnly) throw new AuditError('READ_ONLY', 'store opened read-only'); };

  // Inside a transaction. Returns the new head; the caller assigns it only after COMMIT.
  function appendRows(rows, from) {
    let { id, count, hash } = from;
    for (const row of rows) {
      id++;
      const r = { ...row, id };
      const h = chainHash(hash, r);
      insA.run(...COLS.map((c) => r[c] ?? null), hash, h);
      hash = h;
      count++;
    }
    if (rows.length) updH.run(id, count, hash);
    return { id, count, hash };
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      loadHead();
      throw e;
    }
  }

  /** One transaction per call. rows: audit rows (without id); raw: chat_raw rows; dedupe: { key, seen_at };
   *  actions: { key, op: 'start' | 'done', at, outcome? } in queue order (a 'done' row also creates the key if its
   *  'start' row was never written). */
  function appendBatch(auditRows, rawRows = [], dedupeRows = [], actionRows = []) {
    needWrite();
    const next = tx(() => {
      let maxAt = 0;
      for (const x of actionRows) {
        if (x.op === 'start') insXs.run(x.key, x.at);
        else insXd.run(x.key, x.at, x.at, x.outcome === 'error' || x.outcome === 'refused' ? x.outcome : 'ok');
        if (x.at > maxAt) maxAt = x.at;
      }
      if (maxAt && maxAt - lastActionPrune >= ACTION_PRUNE_EVERY_MS) { delX.run(maxAt - ACTION_KEEP_MS); lastActionPrune = maxAt; }
      for (const r of rawRows) insR.run(r.event_id, r.received_at, r.platform, r.display_name ?? null, r.text ?? null);
      let maxSeen = 0;
      for (const d of dedupeRows) { insD.run(d.key, d.seen_at); if (d.seen_at > maxSeen) maxSeen = d.seen_at; }
      // Only the last DEDUPE_KEEP_MS of keys matter; prune at most every 30 s of event time, inside the same transaction.
      if (maxSeen && maxSeen - lastDedupePrune >= DEDUPE_PRUNE_EVERY_MS) { delD.run(maxSeen - DEDUPE_KEEP_MS); lastDedupePrune = maxSeen; }
      return appendRows(auditRows, head);
    });
    head = next;
    return { audit: auditRows.length, raw: rawRows.length, dedupe: dedupeRows.length, actions: actionRows.length };
  }

  /** Idempotency keys started at or after `since` (wall ms): [{ key, started_at, completed_at, outcome }]. */
  function loadActionKeys(since) {
    return db.prepare('SELECT key, started_at, completed_at, outcome FROM action_keys WHERE started_at >= ? ORDER BY started_at, key').all(Number(since) || 0)
      .map((r) => ({ key: r.key, started_at: r.started_at, completed_at: r.completed_at, outcome: r.outcome }));
  }

  /** Dedupe keys seen at or after `since` (wall ms), oldest first: [{ key, seen_at }]. */
  function loadDedupe(since) {
    return db.prepare('SELECT key, seen_at FROM dedupe_keys WHERE seen_at >= ? ORDER BY seen_at, key').all(Number(since) || 0).map((r) => ({ key: r.key, seen_at: r.seen_at }));
  }

  /** Deletes chat_raw rows with received_at < now - days*DAY_MS (or every row with all:true), writes one audit row
   *  with the count (no content), then returns the pages to the OS and truncates the WAL.
   *  opts: { now, olderThanDays = 30, all = false, mode = 'manual' } */
  function purge(popts = {}) {
    needWrite();
    const at = popts.now ?? now();
    const days = popts.olderThanDays ?? DEFAULT_RETENTION_DAYS;
    const all = popts.all === true;
    if (!all && !(Number.isFinite(days) && days >= 0)) throw new RangeError('olderThanDays must be a number >= 0');
    const cutoff = all ? null : at - days * DAY_MS;
    let purged = 0;
    head = tx(() => {
      purged = Number((all ? delAll.run() : delOld.run(cutoff)).changes);
      const row = {
        ts: new Date(at).toISOString(), type: 'system', subtype: 'purge', source: 'audit', verdict: 'done',
        reason: all ? 'all' : 'retention',
        detail: JSON.stringify({ purged, mode: String(popts.mode ?? 'manual').replace(/[^a-z-]/g, '').slice(0, 16), ...(all ? { all: true } : { olderThanDays: days }) }),
      };
      return appendRows([row], head);
    });
    // Scrub: freed pages are already zeroed (secure_delete=ON); incremental_vacuum returns them to the OS;
    // a full VACUUM (only for --all) rewrites the file; a TRUNCATE checkpoint folds the WAL into the db and empties it.
    if (all) db.exec('VACUUM'); else db.exec('PRAGMA incremental_vacuum');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { purged, cutoff, all };
  }

  function verify() { return verifyDb(db); }

  function stats() {
    return {
      version: currentVersion(db), migrated,
      auditRows: db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
      rawRows: db.prepare('SELECT COUNT(*) AS n FROM chat_raw').get().n,
      oldestRaw: db.prepare('SELECT MIN(received_at) AS t FROM chat_raw').get().t,
      autoVacuum: db.prepare('PRAGMA auto_vacuum').get().auto_vacuum,
      secureDelete: readOnly ? null : db.prepare('PRAGMA secure_delete').get().secure_delete,
      synchronous: readOnly ? null : db.prepare('PRAGMA synchronous').get().synchronous,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    };
  }

  /** Audit rows only (never chat_raw) as plain objects, in id order. */
  function* exportRows() {
    db.exec('BEGIN');
    try { for (const r of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) yield { ...r }; } finally { db.exec('COMMIT'); }
  }

  /** One page of audit rows after id `afterId`, at most `limit` (1..500). nextAfterId is null on the last page. */
  function exportPage(popts = {}) {
    const afterId = Number.isSafeInteger(popts.afterId) && popts.afterId >= 0 ? popts.afterId : 0;
    const limit = Number.isSafeInteger(popts.limit) && popts.limit >= 1 ? Math.min(popts.limit, 500) : 100;
    const rows = db.prepare('SELECT * FROM audit WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit).map((r) => ({ ...r }));
    return { rows, nextAfterId: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  return { appendBatch, loadDedupe, loadActionKeys, purge, verify, stats, exportRows, exportPage, db, file, close: () => db.close(), migrated };
}

/** Writes a copy of the audit (audit, audit_head, schema_version) with NO chat_raw content: a fresh database is
 *  created at `dest` and the audit tables are copied into it in one read snapshot, so raw chat is never read
 *  into the copy (and never sits in the copy's free pages). Refuses a destination inside the repo or one that
 *  exists. Verifies the copy. Returns { rows, verify }. */
export function backupAudit(srcFile, dest, { repoRoot = REPO_ROOT, now = Date.now } = {}) {
  const out = path.resolve(dest);
  if (isInside(out, repoRoot)) throw new AuditError('DEST_IN_REPO', 'backup destination is inside the repository');
  if (existsSync(out)) throw new AuditError('DEST_EXISTS', 'backup destination already exists');
  const tmp = `${out}.partial`;
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(tmp + s, { force: true });
  const bk = openStore({ file: tmp, now });
  try {
    bk.db.prepare('ATTACH DATABASE ? AS src').run(path.resolve(srcFile));
    bk.db.exec('BEGIN IMMEDIATE');
    try {
      const sv = bk.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM src.schema_version').get().v;
      if (sv !== currentVersion(bk.db)) throw new AuditError('SCHEMA_MISMATCH', 'source schema version differs from this code');
      const cols = INSERT_COLS.join(',');
      bk.db.exec(`INSERT INTO main.audit (${cols}) SELECT ${cols} FROM src.audit ORDER BY id`);
      bk.db.exec('UPDATE main.audit_head SET last_id = s.last_id, row_count = s.row_count, head_hash = s.head_hash FROM (SELECT * FROM src.audit_head WHERE k = 1) AS s WHERE main.audit_head.k = 1');
      bk.db.exec('COMMIT');
    } catch (e) { try { bk.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    bk.db.exec('DETACH DATABASE src');
    const v = verifyDb(bk.db);
    const raw = bk.db.prepare('SELECT COUNT(*) AS n FROM chat_raw').get().n;
    if (!v.ok || raw !== 0) throw new AuditError('BACKUP_VERIFY_FAILED', `backup did not verify (${v.reason ?? 'raw rows present'})`);
    bk.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    bk.db.exec('PRAGMA journal_mode = DELETE'); // one self-contained file
    bk.close();
    for (const s of ['-wal', '-shm']) rmSync(tmp + s, { force: true });
    renameSync(tmp, out);
    return { rows: v.rows, verify: v };
  } catch (e) {
    try { bk.close(); } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm', '-journal']) rmSync(tmp + s, { force: true });
    throw e;
  }
}
