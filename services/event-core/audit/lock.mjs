// SPDX-License-Identifier: GPL-2.0-or-later
// Single-writer lock for the audit database (P3 E5). Node stdlib only.
//
// The lock is an EXCLUSIVE SQLite lock on a separate file, <dataDir>/event-core.db.lock, held for the life of the
// owner (PRAGMA locking_mode=EXCLUSIVE + BEGIN EXCLUSIVE, never committed). Chosen over a pid lock file because the
// OS releases it when the process dies by any means (kill, crash, power loss): no stale lock, no pid reuse, no
// "is that pid alive" guessing. The lock file is separate so readers (audit verify/backup/export) can still read
// the WAL database while the owner runs.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AuditError } from './store.mjs';

export const LOCK_NAME = 'event-core.db.lock';

/** Throws AuditError('DB_LOCKED') when another owner (this or another process) holds it. */
export function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_NAME);
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    if (/locked|busy/i.test(String(e?.message))) throw new AuditError('DB_LOCKED', 'the audit database is owned by another writer');
    throw e;
  }
  let open = true;
  return { file, release() { if (!open) return; open = false; try { db.exec('ROLLBACK'); } catch { /* ignore */ } try { db.close(); } catch { /* ignore */ } } };
}
