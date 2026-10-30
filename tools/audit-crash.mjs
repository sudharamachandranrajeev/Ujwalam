// SPDX-License-Identifier: GPL-2.0-or-later
// Audit crash test (P3 E5): spawn a child that writes audit rows continuously, kill it hard at a random point,
// reopen and check; repeat. After each kill the parent requires: the single-writer lock is free again,
// PRAGMA integrity_check ok, the whole chain verifies, the head row count equals the table row count,
// this round's rows are a gap-free prefix 1..K (no partial or reordered batch), and K >= the last count the
// child reported as committed (acked rows survive). Usage: node tools/audit-crash.mjs [--rounds 20] [--seed N]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../services/event-core/audit/lock.mjs';
import { DB_NAME, openStore } from '../services/event-core/audit/store.mjs';

const CHILD = fileURLToPath(new URL('./audit-crash-child.mjs', import.meta.url));

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function round(dataDir, n, killAfterMs) {
  const child = spawn(process.execPath, [CHILD, dataDir, String(n)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let acked = 0;
  let ready = false;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line === 'ready') ready = true;
      else if (line.startsWith('acked ')) acked = Number(line.slice(6));
    }
  });
  child.stderr.on('data', () => {});
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  const t0 = Date.now();
  while (!ready && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 10));
  if (!ready) { child.kill(); throw new Error(`round ${n}: child did not start`); }
  await new Promise((r) => setTimeout(r, killAfterMs));
  child.kill('SIGKILL'); // TerminateProcess on Windows: no shutdown code runs
  const ex = await exited;
  return { acked, ex };
}

function check(dataDir, n, acked) {
  const lock = acquireLock(dataDir); // throws if the dead child still holds it
  const store = openStore({ file: path.join(dataDir, DB_NAME), readOnly: true });
  try {
    const v = store.verify();
    const h = store.db.prepare('SELECT row_count FROM audit_head WHERE k = 1').get();
    const seqs = [];
    for (const r of store.db.prepare("SELECT detail FROM audit WHERE subtype = 'crash-test'").iterate()) {
      const d = JSON.parse(r.detail);
      if (d.round === n) seqs.push(d.seq);
    }
    const contiguous = seqs.every((s, i) => s === i + 1);
    const rawRows = store.db.prepare('SELECT COUNT(*) AS c FROM chat_raw').get().c;
    return {
      round: n, killedAfterAck: acked, rowsThisRound: seqs.length, totalRows: v.rows, headRows: h.row_count,
      integrity: v.integrity, chain: v.ok ? 'ok' : `BAD@${v.firstBadId}:${v.reason}`, contiguous, rawRows,
      pass: v.ok && v.integrity === 'ok' && h.row_count === v.rows && contiguous && seqs.length >= acked,
      lost: Math.max(0, acked - seqs.length),
    };
  } finally { store.close(); lock.release(); }
}

/** Returns an array of per-round result objects. */
export async function runCrashRounds({ rounds = 20, seed = Date.now(), dataDir } = {}) {
  const own = !dataDir;
  const dir = dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'audit-crash-'));
  const rnd = mulberry32(seed);
  const out = [];
  try {
    for (let n = 1; n <= rounds; n++) {
      const killAfter = 40 + Math.floor(rnd() * 900);
      const { acked, ex } = await round(dir, n, killAfter);
      const r = check(dir, n, acked);
      out.push({ ...r, killAfterMs: killAfter, exit: ex.sig ?? ex.code });
    }
  } finally { if (own) rmSync(dir, { recursive: true, force: true }); }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('audit-crash.mjs')) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const res = await runCrashRounds({ rounds: arg('rounds', 20), seed: arg('seed', Date.now()) });
  console.table(res);
  const bad = res.filter((r) => !r.pass).length;
  console.log(`rounds=${res.length} failed=${bad} lostAckedRows=${res.reduce((a, r) => a + r.lost, 0)}`);
  process.exit(bad ? 1 : 0);
}
