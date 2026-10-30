// SPDX-License-Identifier: GPL-2.0-or-later
// api.json: how local clients find the running core (P3 E6). Node stdlib only.
//
//   { "port": N, "pid": N, "startedAt": ISO, "tokens": { "api": hex, "system": hex } | null }
//
// Written atomically (temp file created empty with 'wx', restricted to the current user BEFORE any secret is written,
// content written and fsynced, then renamed over api.json) and removed on clean shutdown. If the ACL cannot be applied
// the write is refused (fail closed): a token never lands in a file that other users could read.
// When the supervisor passes the tokens by environment, tokens is null and only port/pid/startedAt are published.
//
// system.json (E8-03 follow-up, 2026-10-29): discovery for the system role only (the supervisor).
//
//   { "pipe": "\\\\.\\pipe\\ujwalam-core-system-<32 hex>", "pid": N, "startedAt": ISO }
//
// The system pipe's name is published here and never in api.json, which api-role clients read. Same atomic,
// owner-only write as api.json (fail closed), removed on clean shutdown. No token in this file.

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { protectPath } from '../config.mjs';

export const API_FILE = 'api.json';
export const SYSTEM_FILE = 'system.json';
export const ENV_API_TOKEN = 'UJWALAM_EVENT_CORE_API_TOKEN';
export const ENV_SYSTEM_TOKEN = 'UJWALAM_EVENT_CORE_SYSTEM_TOKEN';

/** Tokens from the environment: both or neither, 64 hex each, different. Returns null when neither is set. */
export function tokensFromEnv(env = process.env) {
  const a = env[ENV_API_TOKEN];
  const s = env[ENV_SYSTEM_TOKEN];
  if (a === undefined && s === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(a ?? '') || !/^[0-9a-f]{64}$/.test(s ?? '') || a === s) {
    throw new Error(`${ENV_API_TOKEN} and ${ENV_SYSTEM_TOKEN} must both be set, 64 hex characters, and different`);
  }
  return { api: a, system: s };
}

// On Windows a rename over a file that a reader has open fails with EPERM/EBUSY/EACCES for a moment: retry briefly.
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; } catch (e) {
      if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Atomic, owner-only write. Returns the protection result ('acl' | 'mode-0600'). Throws when it cannot protect. */
export function writeSecretFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    const protection = protectPath(tmp);
    if (protection === 'acl-failed') throw new Error('ACL_FAILED');
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    renameWithRetry(tmp, file);
    return protection;
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
}

/** Writes <dataDir>/api.json. Returns { file, protection, remove() }. remove() deletes it only if it is still ours. */
export function publishApiFile({ dataDir, port, tokens, startedAt = new Date().toISOString() }) {
  const file = path.join(dataDir, API_FILE);
  const protection = writeSecretFileAtomic(file, `${JSON.stringify({ port, pid: process.pid, startedAt, tokens: tokens ?? null }, null, 2)}\n`);
  return {
    file, protection,
    remove() {
      try {
        if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
      } catch { /* best effort */ }
    },
  };
}

/** Writes <dataDir>/system.json with the system pipe's path. Returns { file, protection, remove() }. */
export function publishSystemFile({ dataDir, pipe, startedAt = new Date().toISOString() }) {
  const file = path.join(dataDir, SYSTEM_FILE);
  const protection = writeSecretFileAtomic(file, `${JSON.stringify({ pipe, pid: process.pid, startedAt }, null, 2)}\n`);
  return {
    file, protection,
    remove() {
      try {
        if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
      } catch { /* best effort */ }
    },
  };
}
