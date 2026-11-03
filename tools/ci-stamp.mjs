// SPDX-License-Identifier: GPL-2.0-or-later
// CI pass stamps (D190, batching). Commits run only the quick CI steps; the full CI runs about once an hour and
// before every push. A full pass records the git tree hash of the working tree it tested; the pre-push hook refuses
// a push whose commit tree has no stamp. Stdlib only.
//
//   worktreeTree(root)       -> tree hash of the working tree as git would commit it (tracked + untracked, minus
//                               ignored), built in a throwaway index so the real index is never touched.
//   recordPass(root, tree)   -> appends { tree, at } to <git-dir>/ujwalam-ci-pass.json (last 50 kept).
//   hasPass(root, tree)      -> true when that tree has a stamp.
//   CLI: node tools/ci-stamp.mjs check   (pre-push: reads "<local ref> <local sha> <remote ref> <remote sha>" lines
//        on stdin; exits 1 naming each pushed commit whose tree has no stamp; branch deletions are skipped)
//        node tools/ci-stamp.mjs tree    (prints the working tree hash)
//
// The stamp lives in the git dir, so it is never committed. A stamp only says "the full CI passed on exactly this
// content on this machine"; editing files during a full run changes the tree, so ci.mjs writes no stamp then.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = 50;
const ZERO = /^0+$/;

function git(root, args, env) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

const stampFile = (root) => path.resolve(root, git(root, ['rev-parse', '--git-path', 'ujwalam-ci-pass.json']));

export function worktreeTree(root) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-ci-index-'));
  const index = path.join(dir, 'index');
  try {
    const real = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
    // Start from the real index so unchanged files keep their cached stat data (fast), then stage everything.
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    git(root, ['add', '-A'], env);
    return git(root, ['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readStamps(root) {
  try {
    const j = JSON.parse(readFileSync(stampFile(root), 'utf8'));
    return Array.isArray(j.passes) ? j.passes : [];
  } catch {
    return [];
  }
}

export function recordPass(root, tree, at = new Date().toISOString()) {
  const passes = readStamps(root).filter((p) => p.tree !== tree);
  passes.push({ tree, at });
  writeFileSync(stampFile(root), `${JSON.stringify({ passes: passes.slice(-KEEP) }, null, 2)}\n`);
}

export const hasPass = (root, tree) => readStamps(root).some((p) => p.tree === tree);

/** Pre-push lines -> [{ ref, sha, tree, ok }] for every non-deleting push. */
export function checkPush(root, input) {
  const out = [];
  for (const line of input.split(/\r?\n/)) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (!ref || !sha || ZERO.test(sha)) continue;
    const tree = git(root, ['rev-parse', `${sha}^{tree}`]);
    out.push({ ref, sha, tree, ok: hasPass(root, tree) });
  }
  return out;
}

async function main() {
  const root = process.env.UJWALAM_CI_ROOT ? path.resolve(process.env.UJWALAM_CI_ROOT) : process.cwd();
  const cmd = process.argv[2];
  if (cmd === 'tree') { console.log(worktreeTree(root)); return; }
  if (cmd !== 'check') { console.error('usage: node tools/ci-stamp.mjs check|tree'); process.exit(2); }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const bad = checkPush(root, input).filter((r) => !r.ok);
  for (const r of bad) {
    console.error(`ci-stamp: ${r.ref} ${r.sha.slice(0, 7)}: no full CI pass for tree ${r.tree.slice(0, 12)}.`);
  }
  if (bad.length) {
    console.error('ci-stamp: run `npm run ci` on a tree whose content equals the pushed commit (commit first, no edits during the run), then push again.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
