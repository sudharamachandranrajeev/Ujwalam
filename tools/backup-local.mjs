// SPDX-License-Identifier: GPL-2.0-or-later
// Encrypted backup of local-only data (decision D135). Stdlib only; uses the installed 7-Zip.
//
//   node tools/backup-local.mjs [--dry-run] [--keep N]
//
// What: data/profile.local.json, app/host/host.local.json, docs/evidence/private/, data/labels/, feedback/ (whichever
// exist) into <paths.backup_dir>/ujwalam-local-YYYY-MM-DD.7z, AES-256 with encrypted file names (-mhe=on).
// Where: `paths.backup_dir` in the gitignored data/profile.local.json (the user's Proton Drive folder).
// Password: Windows Credential Manager target `Ujwalam/backup`, set once by the user with
//   node services/event-core/cli.mjs credential set --target Ujwalam/backup --stdin
// The password goes to 7-Zip on stdin only (never argv, env, logs or disk). Each archive is written under a temporary
// name, tested with the password, then renamed. --keep N (default 0 = keep all) leaves the newest N archives and
// moves older ones to <backup_dir>/_to_delete/ (nothing is deleted).
// Exit codes: 0 ok, 1 backup failed, 2 not configured (no backup_dir, no password, no 7-Zip), 64 usage.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCES = Object.freeze([
  'data/profile.local.json',
  'app/host/host.local.json',
  'docs/evidence/private',
  'data/labels',
  'feedback',
]);
export const CREDENTIAL_TARGET = 'Ujwalam/backup';
const NAME_RE = /^ujwalam-local-\d{4}-\d{2}-\d{2}\.7z$/;

export function archiveName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `ujwalam-local-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.7z`;
}

export function findSevenZip(env = process.env) {
  const dirs = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  for (const d of dirs) { const exe = path.join(d, '7-Zip', '7z.exe'); if (existsSync(exe)) return exe; }
  return null;
}

/** Runs 7-Zip with the password on stdin (`lines` copies, one per prompt). Resolves { code, out }. */
function run7z(exe, args, password, lines, cwd) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(`${password}\n`.repeat(lines));
  });
}

function dirSize(p) {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  return readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
}

/**
 * Makes one archive. opts: { root, backupDir, password, sevenZip, now, keep, dryRun }.
 * Resolves { ok, archive?, sources, bytes, moved, reason? }. Never includes the password in any result or message.
 */
export async function backup({ root, backupDir, password, sevenZip, now = new Date(), keep = 0, dryRun = false }) {
  const sources = SOURCES.filter((s) => existsSync(path.join(root, s)));
  const bytes = sources.reduce((n, s) => n + dirSize(path.join(root, s)), 0);
  if (dryRun) return { ok: true, sources, bytes, moved: [] };
  if (sources.length === 0) return { ok: false, reason: 'nothing to back up', sources, bytes, moved: [] };
  mkdirSync(backupDir, { recursive: true });
  const name = archiveName(now);
  const final = path.join(backupDir, name);
  const tmp = path.join(backupDir, `${name}.partial`);
  rmSync(tmp, { force: true });
  const made = await run7z(sevenZip, ['a', '-t7z', '-mx=5', '-mhe=on', '-p', '-bd', tmp, '--', ...sources], password, 2, root);
  if (made.code !== 0) { rmSync(tmp, { force: true }); return { ok: false, reason: `7-Zip create failed (exit ${made.code})`, sources, bytes, moved: [] }; }
  const tested = await run7z(sevenZip, ['t', '-bd', tmp], password, 1, root);
  if (tested.code !== 0) { rmSync(tmp, { force: true }); return { ok: false, reason: `7-Zip test failed (exit ${tested.code})`, sources, bytes, moved: [] }; }
  if (existsSync(final)) {
    mkdirSync(path.join(backupDir, '_to_delete'), { recursive: true });
    renameSync(final, path.join(backupDir, '_to_delete', `${name}.${now.getTime()}`));
  }
  renameSync(tmp, final);
  const moved = [];
  if (keep > 0) {
    const all = readdirSync(backupDir).filter((f) => NAME_RE.test(f)).sort().reverse();
    for (const f of all.slice(keep)) {
      mkdirSync(path.join(backupDir, '_to_delete'), { recursive: true });
      renameSync(path.join(backupDir, f), path.join(backupDir, '_to_delete', f));
      moved.push(f);
    }
  }
  return { ok: true, archive: final, sources, bytes, moved };
}

async function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dryRun = argv.includes('--dry-run');
  const ki = argv.indexOf('--keep');
  const keep = ki >= 0 ? Number(argv[ki + 1]) : 0;
  if (!Number.isInteger(keep) || keep < 0 || argv.some((a, i) => !['--dry-run', '--keep'].includes(a) && i !== ki + 1)) {
    console.error('usage: backup-local.mjs [--dry-run] [--keep N]');
    return 64;
  }
  let profile;
  try { profile = JSON.parse(readFileSync(path.join(root, 'data', 'profile.local.json'), 'utf8')); } catch {
    console.error('backup: data/profile.local.json missing or unreadable'); return 2;
  }
  const backupDir = profile?.paths?.backup_dir;
  if (!backupDir || !path.isAbsolute(backupDir)) { console.error('backup: set paths.backup_dir (absolute) in data/profile.local.json'); return 2; }
  const sevenZip = findSevenZip();
  if (!sevenZip) { console.error('backup: 7-Zip (7z.exe) not found under Program Files'); return 2; }
  if (dryRun) {
    const r = await backup({ root, backupDir, password: '', sevenZip, dryRun: true });
    console.log(`backup (dry run): ${r.sources.length} source(s), ${(r.bytes / 1048576).toFixed(1)} MiB: ${r.sources.join(', ')}`);
    return 0;
  }
  const { createCredentialStore } = await import('../services/event-core/streamerbot/credential.mjs');
  let password;
  try { password = await createCredentialStore(CREDENTIAL_TARGET).get(); } catch (e) { console.error(`backup: ${e.message}`); return 2; }
  if (!password) {
    console.error(`backup: no password stored; run: node services/event-core/cli.mjs credential set --target ${CREDENTIAL_TARGET} --stdin`);
    return 2;
  }
  const r = await backup({ root, backupDir, password, sevenZip, keep });
  password = null;
  if (!r.ok) { console.error(`backup: FAILED: ${r.reason}`); return 1; }
  console.log(`backup: ok, ${r.sources.length} source(s), ${(r.bytes / 1048576).toFixed(1)} MiB -> ${path.basename(r.archive)}${r.moved.length ? `; moved to _to_delete: ${r.moved.join(', ')}` : ''}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
