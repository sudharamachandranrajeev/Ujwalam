// SPDX-License-Identifier: GPL-3.0-or-later
// Session lock for coding agents: one writer at a time (docs/procedures/session-protocol.md). Stdlib only.
//
//   node tools/agent-lock.mjs status
//   node tools/agent-lock.mjs acquire --tool <name> [--force]
//   node tools/agent-lock.mjs release --tool <name>
//
// The lock is `.agent-lock` at the repo root (gitignored): { tool, branch, startedAt, host }. Acquire creates it
// atomically and fails while another holder exists; --force replaces a stale lock (only with the user's yes).
// Release removes it only for the tool that holds it. Exit codes: 0 ok, 1 held by someone else / not holder, 64 usage.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCK_NAME = '.agent-lock';
const TOOL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export function readLock(root) {
  try { return JSON.parse(readFileSync(path.join(root, LOCK_NAME), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { tool: '?', corrupt: true };
  }
}

function currentBranch(root) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

export function acquire(root, { tool, force = false, now = new Date(), branch } = {}) {
  if (!TOOL_RE.test(tool ?? '')) throw new TypeError('tool must match ' + TOOL_RE);
  const lock = { tool, branch: branch ?? currentBranch(root), startedAt: now.toISOString(), host: os.hostname() };
  const file = path.join(root, LOCK_NAME);
  const body = JSON.stringify(lock, null, 2) + '\n';
  try {
    writeFileSync(file, body, { flag: force ? 'w' : 'wx' });
    return { ok: true, lock };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { ok: false, holder: readLock(root) };
  }
}

export function release(root, { tool } = {}) {
  const holder = readLock(root);
  if (!holder) return { ok: true, released: false };
  if (holder.tool !== tool) return { ok: false, holder };
  rmSync(path.join(root, LOCK_NAME), { force: true });
  return { ok: true, released: true };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const describe = (l) => `${l.tool} on ${l.branch ?? '?'} since ${l.startedAt ?? '?'}${l.corrupt ? ' (lock file unreadable)' : ''}`;
  if (cmd === 'status') {
    const l = readLock(root);
    console.log(l ? `agent-lock: held by ${describe(l)}` : 'agent-lock: free');
    return 0;
  }
  if (cmd === 'acquire' || cmd === 'release') {
    const tool = opt('--tool');
    if (!tool || !TOOL_RE.test(tool)) { console.error('agent-lock: --tool <name> required (lowercase, 1-40 chars)'); return 64; }
    if (cmd === 'acquire') {
      const r = acquire(root, { tool, force: rest.includes('--force') });
      if (r.ok) { console.log(`agent-lock: acquired by ${describe(r.lock)}`); return 0; }
      console.error(`agent-lock: held by ${describe(r.holder)}; stop, or ask the user before --force`);
      return 1;
    }
    const r = release(root, { tool });
    if (r.ok) { console.log(r.released ? 'agent-lock: released' : 'agent-lock: was free'); return 0; }
    console.error(`agent-lock: held by ${describe(r.holder)}, not ${tool}; not released`);
    return 1;
  }
  console.error('usage: agent-lock.mjs status | acquire --tool <name> [--force] | release --tool <name>');
  return 64;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
