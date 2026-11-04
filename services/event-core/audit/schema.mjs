// SPDX-License-Identifier: GPL-3.0-or-later
// Audit database schema and forward migrations (P3 E5). Node stdlib only.
// schema_version holds one row per applied migration. Migrations only go forward; a database whose
// version is higher than the code knows is refused (never downgraded or "repaired").

import { GENESIS } from './chain.mjs';

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  event_id TEXT,
  pseudo_id TEXT,
  action_id TEXT,
  rule_id TEXT,
  source TEXT,
  verdict TEXT,
  reason TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TABLE audit_head (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  last_id INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  head_hash TEXT NOT NULL
);
INSERT INTO audit_head (k, last_id, row_count, head_hash) VALUES (1, 0, 0, '${GENESIS}');
CREATE TABLE chat_raw (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  platform TEXT NOT NULL,
  display_name TEXT,
  text TEXT
);
CREATE INDEX chat_raw_received ON chat_raw (received_at);
`,
  },
  {
    // P3 E7: persistent dedupe. key = SHA-256 hex of "platform:platformMessageId" (never the raw id); seen_at = wall ms.
    // Plain state, not part of the hash chain: only the last ~120 s matter and the writer prunes older rows.
    version: 2,
    name: 'dedupe-keys',
    sql: `
CREATE TABLE dedupe_keys (
  key TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX dedupe_keys_seen ON dedupe_keys (seen_at);
`,
  },
  {
    // P3 E7 follow-up: idempotent actions. key = SHA-256 hex idempotency key of a dispatched action (derived from the
    // triggering platform message id hash, or a client key, plus action, source, actor and params; never raw ids or text).
    // started_at = wall ms when the durable "started" marker was written (before the action ran); completed_at and
    // outcome ('ok' | 'error' | 'refused': did not run, key free for a retry; E4b review 2026-10-29) once it finished. Plain state, not part of the hash chain; the writer prunes rows older
    // than the retention (ACTION_KEEP_MS in store.mjs).
    version: 3,
    name: 'action-keys',
    sql: `
CREATE TABLE action_keys (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  outcome TEXT
) WITHOUT ROWID;
CREATE INDEX action_keys_started ON action_keys (started_at);
`,
  },
]);

export function currentVersion(db) {
  const t = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (!t) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
}

/** Applies every migration above the current version, each in its own transaction. Returns { from, to }. */
export function migrate(db, migrations = MIGRATIONS, now = Date.now) {
  const from = currentVersion(db);
  const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0);
  if (from > latest) {
    const e = new Error(`database schema version ${from} is newer than this code (${latest})`);
    e.code = 'SCHEMA_TOO_NEW';
    throw e;
  }
  let at = from;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (m.version === 1) db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date(now()).toISOString());
      db.exec('COMMIT');
      at = m.version;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
  return { from, to: at };
}
