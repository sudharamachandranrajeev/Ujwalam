// SPDX-License-Identifier: GPL-2.0-or-later
// Event-core data dir and pseudonym key (P3 E1). Node stdlib only.
//
// Data dir: the `dataDir` option wins. If it is missing, `paths.event_core_data` in
// data/profile.local.json is used (resolved against the repo root when relative). With neither, or with
// a "<placeholder>" value, resolveDataDir throws. No path is hardcoded here.
//
// Pseudonym key: 32 random bytes in <dataDir>/pseudo.key, created once with the 'wx' flag (so a second
// process never overwrites it) and reused afterwards. A key file of the wrong size is an error, never
// silently replaced (that would change every pseudoId). File protection:
//  - POSIX: mode 0600.
//  - Windows: mode bits do nothing, so the DACL is replaced with icacls (inheritance removed, full control for
//    the current user's SID only, every other ACE removed, read back and verified; see protectPath). The result
//    is reported by loadKey() as `protection` ('mode-0600' | 'acl' | 'acl-failed'). UNVERIFIED that no other
//    administrator-level principal can still read it: administrators can take ownership by design.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEY_FILE = 'pseudo.key';
export const KEY_BYTES = 32;

/** Returns an absolute data dir. opts: { dataDir?, profilePath? }. Reads only paths.event_core_data. */
export function resolveDataDir({ dataDir, profilePath = path.join(REPO, 'data', 'profile.local.json') } = {}) {
  if (typeof dataDir === 'string' && dataDir) return path.resolve(dataDir);
  if (existsSync(profilePath)) {
    const v = JSON.parse(readFileSync(profilePath, 'utf8'))?.paths?.event_core_data;
    if (typeof v === 'string' && v && !/^<.*>$/.test(v)) return path.resolve(REPO, v);
  }
  throw new Error('event core needs a data dir: pass dataDir or set paths.event_core_data in data/profile.local.json');
}

// Review E8-09: Windows system tools are run by absolute path from a validated %SystemRoot%\System32, never by bare
// name (PATH order). SystemRoot must be a local absolute path (X:\...), agree with %windir% when that is set, and the
// tool must exist there as a file; otherwise systemTool() throws and callers fail closed.
const LOCAL_ABS = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)*)?\\?$/;
export function systemTool(...rel) {
  const root = process.env.SystemRoot;
  const windir = process.env.windir;
  if (typeof root !== 'string' || !LOCAL_ABS.test(root)) throw new Error('SystemRoot is not a local absolute path');
  if (typeof windir === 'string' && windir && path.win32.resolve(windir).toLowerCase() !== path.win32.resolve(root).toLowerCase()) {
    throw new Error('SystemRoot and windir disagree');
  }
  const p = path.win32.join(path.win32.resolve(root), 'System32', ...rel);
  let st;
  try { st = statSync(p); } catch { throw new Error(`system tool not found: ${rel.join('\\')}`); }
  if (!st.isFile()) throw new Error(`system tool is not a file: ${rel.join('\\')}`);
  return p;
}

// Review E8-06: the current user's SID, read once per process from whoami (not %USERNAME%, which is ambiguous on a
// domain and can be changed in the environment). null when it cannot be read; protectPath then fails closed.
let cachedSid;
export function currentUserSid() {
  if (cachedSid !== undefined) return cachedSid;
  let sid = null;
  try {
    const r = spawnSync(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const m = r.status === 0 ? /"(S-1-5-[0-9-]+)"\s*$/.exec(r.stdout ?? '') : null;
    sid = m ? m[1] : null;
  } catch { sid = null; }
  if (sid) cachedSid = sid; // a failure is not cached, so a later call can still succeed
  return sid;
}

// SDDL aliases that can appear in an ACE, mapped to SIDs so icacls can /remove them. An alias not in this table makes
// protectPath fail closed (the read-back check would refuse it anyway).
const SDDL_ALIAS = {
  AC: 'S-1-15-2-1', AN: 'S-1-5-7', AU: 'S-1-5-11', BA: 'S-1-5-32-544', BG: 'S-1-5-32-546', BO: 'S-1-5-32-551',
  BU: 'S-1-5-32-545', CG: 'S-1-3-1', CO: 'S-1-3-0', IU: 'S-1-5-4', LS: 'S-1-5-19', NS: 'S-1-5-20', NU: 'S-1-5-2',
  OW: 'S-1-3-4', PS: 'S-1-5-10', PU: 'S-1-5-32-547', RC: 'S-1-5-12', RD: 'S-1-5-32-555', SU: 'S-1-5-6',
  SY: 'S-1-5-18', WD: 'S-1-1-0',
};
const ACE = /\(([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*)\)/g;

function icacls(args) {
  const r = spawnSync(systemTool('icacls.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return r.status === 0;
}

/** Reads the DACLs of p (and with tree: everything below it) as [{ name, dacl }] via `icacls /save`. null on failure. */
function readDacls(p, { tree = false } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ujw-acl-'));
  try {
    const file = path.join(tmp, 'acl.txt');
    if (!icacls([p, '/save', file, '/C', '/Q', ...(tree ? ['/T'] : [])])) return null;
    const lines = readFileSync(file).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l !== '');
    if (lines.length % 2 !== 0) return null;
    const out = [];
    for (let i = 0; i < lines.length; i += 2) out.push({ name: lines[i], dacl: lines[i + 1] });
    return out;
  } catch { return null; } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** True when a DACL holds allow ACEs for `sid` only (no other principal, no deny, no conditional or object ACE). */
function onlySid(dacl, sid, { top }) {
  if (!dacl.startsWith('D:')) return false;
  const flags = /^D:([A-Z]*)\(/.exec(dacl)?.[1] ?? '';
  if (top && !flags.includes('P')) return false; // the protected item must not inherit from its parent
  const aces = [...dacl.slice(2 + flags.length).matchAll(ACE)];
  if (!aces.length || aces.map((a) => a[0]).join('') !== dacl.slice(2 + flags.length)) return false;
  return aces.every((a) => a[1] === 'A' && a[6] === sid);
}

/** Restrict a file or directory to the current user. dir: true uses mode 0700 / an inheritable grant.
 *  Returns 'mode-0600' | 'mode-0700' | 'acl' | 'acl-failed'.
 *  Windows (review E8-06): the DACL is set, not edited:
 *   1. inheritance off and full control for the current user's SID (from whoami, read once);
 *   2. every other ACE on the item is removed (read back with `icacls /save`, removed by SID);
 *   3. for a directory, everything already inside it is reset to inherit from it (`/reset /T`);
 *   4. the result is read back, and 'acl' is returned only when every DACL holds allow ACEs for that SID alone.
 *  Limits: the owner is not changed (an owner keeps implicit READ_CONTROL and WRITE_DAC), and administrators can take
 *  ownership by design. */
export function protectPath(p, { dir = false } = {}) {
  if (process.platform !== 'win32') {
    try { chmodSync(p, dir ? 0o700 : 0o600); } catch { return 'acl-failed'; }
    return dir ? 'mode-0700' : 'mode-0600';
  }
  try {
    const sid = currentUserSid();
    if (!sid) return 'acl-failed';
    if (!icacls([p, '/inheritance:r', '/grant:r', dir ? `*${sid}:(OI)(CI)F` : `*${sid}:(F)`, '/Q'])) return 'acl-failed';
    const own = readDacls(p);
    if (!own || own.length !== 1) return 'acl-failed';
    const others = new Set();
    for (const a of own[0].dacl.matchAll(ACE)) {
      const who = a[6];
      if (who === sid) continue;
      const resolved = /^S-1-[0-9-]+$/.test(who) ? who : SDDL_ALIAS[who];
      if (!resolved) return 'acl-failed';
      others.add(resolved);
    }
    for (const s of others) if (!icacls([p, '/remove', `*${s}`, '/Q'])) return 'acl-failed';
    if (dir && readdirSync(p).length > 0 && !icacls([path.join(p, '*'), '/reset', '/T', '/C', '/Q'])) return 'acl-failed';
    const all = readDacls(p, { tree: dir });
    if (!all || !all.length) return 'acl-failed';
    return all.every((e, i) => onlySid(e.dacl, sid, { top: i === 0 })) ? 'acl' : 'acl-failed';
  } catch { return 'acl-failed'; }
}
const protect = (file) => protectPath(file);

/** Creates the data dir if missing and restricts it, and everything already in it, to the current user every time
 *  (P3 E6; review E8-06: an existing directory and existing files are re-protected too). Parents created by the
 *  recursive mkdir keep their inherited ACL. Returns { created, protection }. */
export function ensureSecureDir(dir) {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { created: !existed, protection: protectPath(dir, { dir: true }) };
}

/** Returns { key: Buffer, created: boolean, protection: string|null }. Creates dataDir if needed. */
export function loadKey(dataDir) {
  ensureSecureDir(dataDir);
  const file = path.join(dataDir, KEY_FILE);
  try {
    writeFileSync(file, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
    return { key: readKeyFile(file), created: true, protection: protect(file) };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { key: readKeyFile(file), created: false, protection: null };
  }
}

function readKeyFile(file) {
  const key = readFileSync(file);
  if (key.length !== KEY_BYTES) throw new Error(`${KEY_FILE} must be ${KEY_BYTES} bytes, found ${key.length}`);
  return key;
}
