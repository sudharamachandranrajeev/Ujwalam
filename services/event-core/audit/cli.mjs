// SPDX-License-Identifier: GPL-3.0-or-later
// Audit command line (P3 E5). Node stdlib only. Reached through services/event-core/cli.mjs:
//   audit purge [--older-than-days N] [--all [--confirm yes]] [--data-dir DIR]
//   audit verify [--data-dir DIR]
//   audit backup <dest> [--data-dir DIR]
//   audit export --format jsonl [--out FILE] [--data-dir DIR]
//
// Output holds counts, ids and codes only, never chat text. purge and backup/export refuse as described in
// docs/evidence/2026-10-28-p3-e5-audit.md. purge needs the single-writer lock, so it refuses while the event core
// runs (the running core purges itself at start-up and daily; an API-triggered purge arrives with E6).
// verify, backup and export only read, so they work while the core runs.

import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { dataDirNote, resolveCliDataDir } from '../config.mjs';
import { acquireLock } from './lock.mjs';
import { AuditError, DB_NAME, DEFAULT_RETENTION_DAYS, REPO_ROOT, backupAudit, isInside, openStore } from './store.mjs';

async function typedConfirm(io) {
  if (io.confirm) return io.confirm();
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((res) => rl.question('This deletes ALL raw chat. Type yes to continue: ', res));
  rl.close();
  return answer;
}

/** args: parsed CLI args ({ _: ['audit', sub, ...], ...flags }). io: { out(line), confirm?() }. Returns the exit code. */
export async function auditCommand(args, io = { out: (s) => console.log(s) }) {
  const sub = args._[1];
  let dataDir;
  try { const r = resolveCliDataDir({ dataDir: args['data-dir'] }); dataDir = r.dir; if (r.source !== 'option') io.out(`audit: ${dataDirNote(r)}`); } catch (e) { io.out(`audit: ${e.message}`); return 1; }
  const file = path.join(dataDir, DB_NAME);
  try {
    if (sub === 'purge') return await purgeCmd(args, io, dataDir, file);
    if (sub === 'verify') return verifyCmd(io, file);
    if (sub === 'backup') return backupCmd(args, io, file);
    if (sub === 'export') return await exportCmd(args, io, file);
  } catch (e) {
    io.out(`audit ${sub}: failed (${e instanceof AuditError || e instanceof RangeError ? e.message : (e?.code ?? 'error')})`);
    return 1;
  }
  io.out('usage: audit purge [--older-than-days N] [--all [--confirm yes]] | verify | backup <dest> | export --format jsonl [--out FILE]   (each takes [--data-dir DIR])');
  return 1;
}

async function purgeCmd(args, io, dataDir, file) {
  const all = args.all === true;
  if (all && args['older-than-days'] !== undefined) { io.out('audit purge: use --all or --older-than-days, not both'); return 1; }
  let days = DEFAULT_RETENTION_DAYS;
  if (!all && args['older-than-days'] !== undefined) {
    days = Number(args['older-than-days']);
    if (!(Number.isFinite(days) && days >= 0)) { io.out('audit purge: --older-than-days must be a number >= 0'); return 1; }
  }
  if (all) {
    const typed = args.confirm !== undefined ? args.confirm : await typedConfirm(io);
    if (String(typed).trim() !== 'yes') { io.out('audit purge --all: not confirmed (type yes); nothing deleted'); return 1; }
  }
  if (!existsSync(file)) { io.out('audit purge: no audit database here; nothing to purge'); return 0; }
  let lock;
  try { lock = acquireLock(dataDir); } catch (e) {
    if (e.code === 'DB_LOCKED') { io.out('audit purge: the event core is running and owns the database; it purges at start-up and daily. Stop it to purge by hand.'); return 1; }
    throw e;
  }
  const store = openStore({ file });
  try {
    const r = store.purge({ olderThanDays: days, all, mode: 'manual' });
    io.out(all ? `audit purge: removed ${r.purged} raw chat rows (all)` : `audit purge: removed ${r.purged} raw chat rows older than ${days} days`);
    return 0;
  } finally { store.close(); lock.release(); }
}

function verifyCmd(io, file) {
  if (!existsSync(file)) { io.out('audit verify: FAIL no database'); return 1; }
  const store = openStore({ file, readOnly: true });
  try {
    const r = store.verify();
    if (r.ok) { io.out(`audit verify: OK rows=${r.rows} integrity=${r.integrity}`); return 0; }
    io.out(`audit verify: FAIL first bad row id=${r.firstBadId} reason=${r.reason} rows=${r.rows} integrity=${r.integrity}`);
    return 1;
  } finally { store.close(); }
}

function backupCmd(args, io, file) {
  const dest = args._[2];
  if (!dest) { io.out('audit backup: destination required'); return 1; }
  if (!existsSync(file)) { io.out('audit backup: no audit database here'); return 1; }
  const r = backupAudit(file, dest);
  io.out(`audit backup: wrote ${r.rows} audit rows, no raw chat, verified`);
  return 0;
}

async function exportCmd(args, io, file) {
  if ((args.format ?? 'jsonl') !== 'jsonl') { io.out('audit export: only --format jsonl is supported'); return 1; }
  if (!existsSync(file)) { io.out('audit export: no audit database here'); return 1; }
  let sink = null;
  if (args.out) {
    const out = path.resolve(args.out);
    if (isInside(out, REPO_ROOT)) { io.out('audit export: destination is inside the repository'); return 1; }
    if (existsSync(out)) { io.out('audit export: destination already exists'); return 1; }
    sink = createWriteStream(out, { flags: 'wx' });
  }
  const store = openStore({ file, readOnly: true });
  let n = 0;
  try {
    for (const row of store.exportRows()) {
      const line = JSON.stringify(row);
      if (sink) { if (!sink.write(`${line}\n`)) await new Promise((r) => sink.once('drain', r)); } else io.out(line);
      n++;
    }
  } finally { store.close(); }
  if (sink) { await new Promise((r) => sink.end(r)); io.out(`audit export: wrote ${n} audit rows (no raw chat)`); }
  return 0;
}
