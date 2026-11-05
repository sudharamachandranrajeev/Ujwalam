// SPDX-License-Identifier: GPL-3.0-or-later
// Restore of the encrypted local-data backup made by tools/backup-local.mjs (decision D135). Stdlib only.
//
//   node tools/restore-local.mjs list
//   node tools/restore-local.mjs verify <archive>
//   node tools/restore-local.mjs restore <archive> [--to <dir>]
//   node tools/restore-local.mjs apply [--from <staging dir>] [--to <root>] --confirm "yes, restore"
//
// list     archives in <paths.backup_dir> (data/profile.local.json), newest first, with size and date.
// verify   7z t on the archive (password from Windows Credential Manager target `Ujwalam/backup`).
// restore  extracts into a fresh staging dir (default %LOCALAPPDATA%\Ujwalam\restore\<timestamp>); touches no live file.
// apply    copies staged files into <root> (default: the folder this tool belongs to) only with --confirm "yes, restore".
//          Each file it would replace is first moved to <root>/_to_delete/<timestamp>/<same path>. Nothing is deleted.
//          --from defaults to the newest staging dir.
// The password goes to 7-Zip on stdin only, never argv, env, logs or disk. Archive paths are relative to the root.
// Exit codes: 0 ok, 1 failed, 2 not configured (no backup_dir, no password, no 7-Zip), 64 usage.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_TARGET, findSevenZip } from './backup-local.mjs';

export const CONFIRM = 'yes, restore';
const ARCHIVE_RE = /^ujwalam-local-\d{4}-\d{2}-\d{2}\.7z$/;
const stamp = (now) => now.toISOString().replace(/[:.]/g, '-');

/** Real 7-Zip runner: password on stdin (`lines` copies). Resolves { code, out }. Fake runners share this shape. */
export function run7z(exe, args, password, lines, cwd) {
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

export function defaultStagingBase(env = process.env) {
  return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Ujwalam', 'restore');
}

/** Archives in backupDir, newest first: [{ name, file, bytes, mtime }]. */
export function listArchives(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir).filter((f) => ARCHIVE_RE.test(f)).sort().reverse().map((name) => {
    const file = path.join(backupDir, name);
    const s = statSync(file);
    return { name, file, bytes: s.size, mtime: s.mtime };
  });
}

/** An archive argument is a full path or a bare name inside backupDir. */
export function resolveArchive(arg, backupDir) {
  const p = path.isAbsolute(arg) ? arg : path.join(backupDir, arg);
  return existsSync(p) ? p : null;
}

export async function verify({ archive, password, sevenZip, runner = run7z }) {
  const r = await runner(sevenZip, ['t', '-bd', archive], password, 1, path.dirname(archive));
  return r.code === 0 ? { ok: true } : { ok: false, reason: `7-Zip test failed (exit ${r.code})` };
}

/** Extracts into a fresh staging dir. Refuses an existing non-empty dir. Resolves { ok, staging, files, reason? }. */
export async function extract({ archive, password, sevenZip, to, now = new Date(), runner = run7z }) {
  const staging = path.resolve(to ?? path.join(defaultStagingBase(), stamp(now)));
  if (existsSync(staging) && readdirSync(staging).length > 0) return { ok: false, reason: `staging dir not empty: ${staging}` };
  mkdirSync(staging, { recursive: true });
  const r = await runner(sevenZip, ['x', '-bd', '-y', `-o${staging}`, '-p', archive], password, 2, staging);
  if (r.code !== 0) return { ok: false, staging, reason: `7-Zip extract failed (exit ${r.code})` };
  return { ok: true, staging, files: stagedFiles(staging).length };
}

/** Relative (forward-slash) paths of every file under dir. */
export function stagedFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

export function newestStaging(base = defaultStagingBase()) {
  if (!existsSync(base)) return null;
  const d = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().pop();
  return d ? path.join(base, d) : null;
}

/**
 * Copies staged files into root. Needs confirm === "yes, restore". A file that would be replaced is first moved to
 * <root>/_to_delete/<timestamp>/<path>. Resolves { ok, copied, replaced, trash?, reason? }.
 */
export function applyStaged({ staging, root, confirm, now = new Date() }) {
  if (confirm !== CONFIRM) return { ok: false, reason: `refused: pass --confirm "${CONFIRM}"` };
  if (!staging || !existsSync(staging)) return { ok: false, reason: 'staging dir not found' };
  const files = stagedFiles(staging);
  if (files.length === 0) return { ok: false, reason: 'staging dir is empty' };
  const rootAbs = path.resolve(root);
  const trash = path.join(rootAbs, '_to_delete', stamp(now));
  const plan = [];
  for (const rel of files) {
    const dest = path.resolve(rootAbs, ...rel.split('/'));
    if (rel.split('/').includes('..') || !dest.startsWith(rootAbs + path.sep)) return { ok: false, reason: `unsafe path in staging: ${rel}` };
    plan.push({ rel, src: path.join(staging, ...rel.split('/')), dest });
  }
  let replaced = 0;
  for (const { rel, src, dest } of plan) {
    if (existsSync(dest)) {
      const t = path.join(trash, ...rel.split('/'));
      mkdirSync(path.dirname(t), { recursive: true });
      renameSync(dest, t);
      replaced++;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  return { ok: true, copied: plan.length, replaced, trash: replaced ? trash : null };
}

const fmtDate = (d) => d.toISOString().slice(0, 16).replace('T', ' ');

function parseFlags(args, known) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (!known.includes(args[i]) || i + 1 >= args.length) return null;
      flags[args[i].slice(2)] = args[++i];
    } else pos.push(args[i]);
  }
  return { flags, pos };
}

async function getPassword() {
  const { createCredentialStore } = await import('../services/event-core/streamerbot/credential.mjs');
  return createCredentialStore(CREDENTIAL_TARGET).get();
}

export async function main(argv, deps = {}) {
  const root = deps.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = deps.log ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const usage = () => { err('usage: restore-local.mjs list | verify <archive> | restore <archive> [--to <dir>] | apply [--from <dir>] [--to <root>] --confirm "yes, restore"'); return 64; };
  const [cmd, ...rest] = argv;
  if (!['list', 'verify', 'restore', 'apply'].includes(cmd)) return usage();
  const parsed = parseFlags(rest, cmd === 'apply' ? ['--from', '--to', '--confirm'] : cmd === 'restore' ? ['--to'] : []);
  if (!parsed) return usage();
  const { flags, pos } = parsed;
  if (cmd === 'apply') {
    if (pos.length) return usage();
    const staging = flags.from ? path.resolve(flags.from) : newestStaging(deps.stagingBase);
    const r = applyStaged({ staging, root: flags.to ?? root, confirm: flags.confirm });
    if (!r.ok) { err(`restore: ${r.reason}`); return r.reason.startsWith('refused') ? 64 : 1; }
    out(`restore: applied ${r.copied} file(s) from ${staging}; replaced ${r.replaced}${r.trash ? `, old copies moved to ${r.trash}` : ''}`);
    return 0;
  }
  let profile;
  try { profile = deps.profile ?? JSON.parse(readFileSync(path.join(root, 'data', 'profile.local.json'), 'utf8')); } catch { err('restore: data/profile.local.json missing or unreadable'); return 2; }
  const backupDir = profile?.paths?.backup_dir;
  if (!backupDir || !path.isAbsolute(backupDir)) { err('restore: set paths.backup_dir (absolute) in data/profile.local.json'); return 2; }
  if (cmd === 'list') {
    const list = listArchives(backupDir);
    if (!list.length) { out(`restore: no archives in ${backupDir}`); return 0; }
    for (const a of list) out(`${a.name}  ${(a.bytes / 1048576).toFixed(1)} MiB  ${fmtDate(a.mtime)}`);
    return 0;
  }
  if (pos.length !== 1) return usage();
  const archive = resolveArchive(pos[0], backupDir);
  if (!archive) { err(`restore: archive not found: ${pos[0]}`); return 1; }
  const sevenZip = deps.sevenZip ?? findSevenZip();
  if (!sevenZip) { err('restore: 7-Zip (7z.exe) not found under Program Files'); return 2; }
  let password;
  try { password = await (deps.getPassword ?? getPassword)(); } catch (e) { err(`restore: ${e.message}`); return 2; }
  if (!password) { err(`restore: no password stored; run: node services/event-core/cli.mjs credential set --target ${CREDENTIAL_TARGET} --stdin`); return 2; }
  if (cmd === 'verify') {
    const r = await verify({ archive, password, sevenZip, runner: deps.runner });
    password = null;
    if (!r.ok) { err(`restore: FAILED: ${r.reason}`); return 1; }
    out(`restore: ${path.basename(archive)} verified ok`);
    return 0;
  }
  const r = await extract({ archive, password, sevenZip, to: flags.to, runner: deps.runner });
  password = null;
  if (!r.ok) { err(`restore: FAILED: ${r.reason}`); return 1; }
  out(`restore: extracted ${r.files} file(s) to ${r.staging}`);
  out('restore: nothing live was changed. Review it, then: node tools/restore-local.mjs apply --from "<that folder>" --confirm "yes, restore"');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
