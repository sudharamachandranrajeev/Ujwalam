#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Private-data scanner for git hooks. Terms come from a gitignored profile
// (data/profile.local.json). Output never echoes a term or matched text.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
let profileArg = null;
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--profile') profileArg = argv[++i];
  else args.push(argv[i]);
}
const mode = args[0];
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

const git = (a, input) =>
  execFileSync('git', a, { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });

function failClosed(msg) {
  err(`private-scan: ${msg}`);
  err('private-scan: failing closed. Create data/profile.local.json from data/profile.example.json.');
  process.exit(1);
}

// ---- terms ----
const ALNUM = /[\p{L}\p{N}]/gu;
function collect(node, acc) {
  if (typeof node === 'string') acc.push(node);
  else if (Array.isArray(node)) node.forEach((v) => collect(v, acc));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$') || k === 'version') continue;
      collect(v, acc);
    }
  }
}
function loadTerms() {
  let p = profileArg;
  if (!p) {
    let top;
    try { top = git(['rev-parse', '--show-toplevel']).toString().trim(); } catch { top = process.cwd(); }
    p = path.join(top, 'data', 'profile.local.json');
  }
  if (!existsSync(p)) failClosed('profile not found.');
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { failClosed('profile unparsable.'); }
  const raw = [];
  collect(doc, raw);
  const rxs = [];
  const seen = new Set();
  for (const s of raw) {
    if (/^<.*>$/s.test(s.trim())) continue; // placeholder
    const core = (s.match(ALNUM) || []).join('').toLowerCase();
    if (core.length < 4 || seen.has(core)) continue;
    seen.add(core);
    const esc = [...core].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    rxs.push(new RegExp(esc.join('[^\\p{L}\\p{N}\\r\\n]{0,2}'), 'iu'));
  }
  if (!rxs.length) failClosed('profile has no usable terms.');
  return rxs;
}
const terms = loadTerms();

// ---- matching ----
function termsIn(text) {
  const hits = [];
  terms.forEach((rx, i) => { if (rx.test(text)) hits.push(i + 1); });
  return hits;
}
function scanText(text) { // -> [{line, n}]
  const res = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const n of termsIn(lines[i])) res.push({ line: i + 1, n });
  }
  return res;
}
const isBinary = (buf) => buf.includes(0);
const shown = (p) => (termsIn(p).length ? '<path-redacted>' : p);

let hitCount = 0;
function report(label, hits) {
  for (const h of hits) { out(`${label}:${h.line}: term #${h.n}`); hitCount++; }
}
function scanPath(p, label) {
  for (const n of termsIn(p)) { out(`${label} (path): term #${n}`); hitCount++; }
}

// ---- local rule: gitignored local data never enters a commit (pre-commit, pre-push, worktree) ----
// Anything under data/games/<game>/local/ (drafts, label notes, suggestions with OCR text, crops) and
// any *.local.* name (profile, settings) is refused even when force-added past .gitignore. There is
// no template allowance (review round 4, R3): x.example.local.json is still local. Templates are
// named without ".local." (data/profile.example.json). Both checks ignore case (R4), because Windows
// (core.ignorecase) ignores Foo.LOCAL.json and data/games/codm/Local/ but lets them be force-added.
const LOCAL_DIR_RE = /^data\/games\/[^/]+\/local\//i;
const LOCAL_NAME_RE = /\.local\./i;
function localRule(p) {
  if (LOCAL_DIR_RE.test(p)) return 'local rule: data/games/<game>/local/ is local-only and never committed';
  if (LOCAL_NAME_RE.test(p)) return 'local rule: *.local.* files are local-only and never committed';
  return null;
}
function reportLocal(label, p) {
  const r = localRule(p);
  if (r) { out(`${label}:1: ${r}`); hitCount++; }
}

// ---- labels rule: data/labels/ holds label files only, validated exactly ----
// Every file under data/labels/ must be .gitkeep (empty) or <sessionId>.json directly in the folder (a
// regular file: no symlink, no gitlink), and must pass the same stdlib validator the label server uses
// (tools/label/labels-export.mjs with tools/label/schema-lite.mjs), so a commit needs no dev dependency:
//   data/labels.schema.json exactly (additionalProperties false at every level, id patterns,
//   labeller const <user>), every reasonTag an id in data/label-tags.json, the sessionId in
//   data/sessions.json, windowEndSec > windowStartSec, unique ids, and every event's detectorId and
//   medal in the session's game pack (data/session-games.json -> data/games/<id>/).
// The validator code and its data come from what is being checked (review M1): the index for
// pre-commit (git show :<path>), the pushed tip commit for pre-push and scan-history, the worktree
// for scan-worktree. A missing file fails closed with a message. They are copied to a temp folder
// and the validator is imported from there, so an unstaged edit cannot loosen the check, and a
// first commit that stages the validator, its data and label files together is checked against the
// staged copies.
const LABELS_DIR = 'data/labels/';
const CTX_FILES = [
  'tools/label/labels-export.mjs', 'tools/label/schema-lite.mjs', 'data/labels.schema.json',
  'data/label-tags.json', 'data/sessions.json', 'data/session-games.json',
];
const PACK_FILES = ['detectors.json', 'events.json'];
const GAME_ID_RE = /^[a-z][a-z0-9_]*$/;
const BAD_MODES = new Map([['120000', 'symlink'], ['160000', 'gitlink (submodule)']]);
let labelsCtx = null; // { error } or the validator context; loaded once per run, when needed

// read(path) -> Buffer, or null when the path is not in that source.
async function loadLabelsCtx(read, where) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'private-scan-labels-'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });
  const put = (p, buf) => { const f = path.join(dir, ...p.split('/')); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, buf); };
  const missing = [];
  for (const p of CTX_FILES) { const b = read(p); if (b === null) missing.push(p); else put(p, b); }
  if (missing.length) return { error: `label validator or its data not in ${where} (${missing.join(', ')}); stage it, failing closed` };
  try {
    const sessionGames = JSON.parse(readFileSync(path.join(dir, 'data', 'session-games.json'), 'utf8')).sessions || {};
    const packMissing = new Set();
    for (const g of new Set(Object.values(sessionGames))) {
      if (typeof g !== 'string' || !GAME_ID_RE.test(g)) continue;
      for (const f of PACK_FILES) { const p = `data/games/${g}/${f}`; const b = read(p); if (b === null) packMissing.add(g); else put(p, b); }
    }
    const lx = await import(pathToFileURL(path.join(dir, 'tools', 'label', 'labels-export.mjs')).href);
    const packs = new Map();
    return {
      validate: lx.validateLabelFile,
      schema: lx.loadSchema(dir),
      tagIds: lx.loadTagIds(path.join(dir, 'data', 'label-tags.json')),
      sessionIds: lx.loadSessionIds(path.join(dir, 'data', 'sessions.json')),
      // undefined when the session has no game, or its pack is not in the source: a file with
      // events then fails closed (/events no-game-pack-for-session).
      pack: (sid) => {
        const g = Object.hasOwn(sessionGames, sid) ? sessionGames[sid] : undefined;
        if (typeof g !== 'string' || packMissing.has(g)) return undefined;
        if (!packs.has(g)) { try { packs.set(g, lx.loadPackSummary(dir, g)); } catch { packs.set(g, undefined); } }
        return packs.get(g);
      },
    };
  } catch { return { error: `label validator or its data in ${where} cannot be loaded, failing closed` }; }
}
const needsCtx = (p) => p.startsWith(LABELS_DIR) && p.endsWith('.json') && !p.slice(LABELS_DIR.length).includes('/');
async function prepareLabels(paths, read, where) {
  if (paths.some(needsCtx)) labelsCtx = await loadLabelsCtx(read, where);
}

// -> [{line, reason}] for one file under data/labels/. buf = file bytes (null = unreadable).
// mode = git file mode when known. Reasons never contain file values.
function labelsRule(p, buf, mode) {
  if (!p.startsWith(LABELS_DIR)) return [];
  const rest = p.slice(LABELS_DIR.length);
  if (mode && BAD_MODES.has(mode)) return [{ line: 1, reason: `${BAD_MODES.get(mode)} not allowed (only regular files)` }];
  if (rest.includes('/')) return [{ line: 1, reason: 'subfolders not allowed (only data/labels/<sessionId>.json and .gitkeep)' }];
  if (buf === null) return [{ line: 1, reason: 'file cannot be read, failing closed' }];
  if (rest === '.gitkeep') return buf.length ? [{ line: 1, reason: '.gitkeep must be empty' }] : [];
  if (!rest.endsWith('.json')) return [{ line: 1, reason: 'file type not allowed (only .gitkeep and .json)' }];
  const c = labelsCtx;
  if (!c) return [{ line: 1, reason: 'label validator not loaded, failing closed' }];
  if (c.error) return [{ line: 1, reason: c.error }];
  if (isBinary(buf)) return [{ line: 1, reason: 'binary content' }];
  const text = buf.toString('utf8').replace(/^﻿/, '');
  let doc;
  try { doc = JSON.parse(text); } catch { return [{ line: 1, reason: 'invalid JSON' }]; }
  const sid = doc && typeof doc === 'object' ? doc.sessionId : undefined;
  const errors = c.validate(doc, { schema: c.schema, tagIds: c.tagIds, sessionIds: c.sessionIds, pack: typeof sid === 'string' ? c.pack(sid) : undefined });
  if (!errors.length && rest !== `${sid}.json`) errors.push('/ file name is not <sessionId>.json');
  // Line of the n-th label or event id, when the file is in the writer's layout; else line 1.
  const lines = text.split('\n');
  const idLines = (prefix) => lines.flatMap((l, i) => (new RegExp(`"id"\\s*:\\s*"${prefix}-`).test(l) ? [i + 1] : []));
  const at = { labels: idLines('l'), events: idLines('e') };
  return errors.map((e) => {
    const m = /^\/(labels|events)\/(\d+)/.exec(e);
    return { line: (m && at[m[1]][Number(m[2])]) || 1, reason: `schema violation at ${e}` };
  });
}
function reportLabels(label, p, buf, mode) {
  for (const h of labelsRule(p, buf, mode)) { out(`${label}:${h.line}: labels rule: ${h.reason}`); hitCount++; }
}
// "<mode> <sha> <stage>\t<path>" records -> Map(path -> mode)
function modesOf(zOutput) {
  const m = new Map();
  for (const rec of zOutput.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    m.set(rec.slice(tab + 1), rec.split(' ')[0]);
  }
  return m;
}
const tryGit = (a) => { try { return git(a); } catch { return null; } };

// ---- modes ----
// The validator's own files must be staged as they are in the worktree when a commit touches label
// files or the validator's inputs (review M1); otherwise the commit would pass on code or data that
// the worktree no longer has. Unrelated commits are not affected.
const VALIDATOR_SPECS = ['tools/label/*.mjs', 'data/labels.schema.json'];
const touchesLabels = (p) => p.startsWith(LABELS_DIR) || CTX_FILES.includes(p) || /^tools\/label\/[^/]+\.mjs$/.test(p)
  || /^data\/games\/[^/]+\/(detectors|events)\.json$/.test(p);
async function preCommit() {
  // Every staged change except deletions (A, C, M, R, T, U, X, B): a typechange is checked too.
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=d', '--no-renames', '-z']).toString().split('\0').filter(Boolean);
  const labelNames = names.filter((p) => p.startsWith(LABELS_DIR));
  const modes = labelNames.length ? modesOf(git(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...labelNames]).toString()) : new Map();
  await prepareLabels(names, (p) => tryGit(['show', ':' + p]), 'the index');
  if (names.some(touchesLabels)) {
    const changed = git(['diff', '--name-only', '-z', '--', ...VALIDATOR_SPECS]).toString().split('\0').filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...VALIDATOR_SPECS]).toString().split('\0').filter(Boolean);
    for (const p of [...changed, ...untracked]) {
      out(`${shown(p)}:1: labels rule: the label validator differs between the index and the worktree (stage or stash the change), failing closed`);
      hitCount++;
    }
  }
  for (const p of names) {
    scanPath(p, 'staged ' + shown(p));
    reportLocal(shown(p), p);
    const mode = modes.get(p);
    // The labels rule runs first, so an unreadable blob, a symlink or a gitlink under data/labels/ is a hit.
    const buf = mode && BAD_MODES.has(mode) ? null : tryGit(['show', ':' + p]);
    reportLabels(shown(p), p, buf, mode);
    if (buf === null || isBinary(buf)) continue;
    report(shown(p), scanText(buf.toString('utf8')));
  }
  return hitCount ? 1 : 0;
}
function commitMsg(file) {
  if (!file) failClosed('commit-msg needs a file argument.');
  for (const h of scanText(readFileSync(file, 'utf8'))) { out(`commit message:${h.line}: term #${h.n}`); hitCount++; }
  return hitCount ? 1 : 0;
}
async function worktree() {
  const top = git(['rev-parse', '--show-toplevel']).toString().trim();
  const names = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean);
  const modes = modesOf(git(['ls-files', '-s', '-z', '--', LABELS_DIR]).toString());
  await prepareLabels(names, (p) => { try { return readFileSync(path.join(top, ...p.split('/'))); } catch { return null; } }, 'the worktree');
  const perFile = [];
  for (const p of names) {
    reportLocal(shown(p), p);
    let mode = modes.get(p);
    if (p.startsWith(LABELS_DIR)) { try { if (lstatSync(path.join(top, ...p.split('/'))).isSymbolicLink()) mode = '120000'; } catch { /* gone */ } }
    let buf;
    try { buf = mode && BAD_MODES.has(mode) ? null : readFileSync(path.join(top, ...p.split('/'))); } catch { buf = null; }
    reportLabels(shown(p), p, buf, mode);
    if (buf === null) continue;
    const hits = termsIn(p).map((n) => ({ n }));
    if (!isBinary(buf)) hits.push(...scanText(buf.toString('utf8')));
    if (hits.length) perFile.push([shown(p), hits.length, [...new Set(hits.map((h) => h.n))].sort((a, b) => a - b)]);
  }
  out(`scanned ${names.length} files`);
  for (const [p, c, ns] of perFile) { out(`${p}: ${c} hit(s), terms ${ns.map((n) => '#' + n).join(' ')}`); hitCount += c; }
  return hitCount ? 1 : 0;
}

// scan-files <path>...: terms in the given files (text only; paths are not echoed). Used by the label server tests.
function scanFiles(paths) {
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); } catch { err('private-scan: cannot read a file'); hitCount++; continue; }
    if (isBinary(buf)) continue;
    report('file', scanText(buf.toString('utf8')));
  }
  return hitCount ? 1 : 0;
}

async function scanCommits(shas) {
  const commits = new Set();
  for (const s of shas) git(['rev-list', s]).toString().split('\n').filter(Boolean).forEach((c) => commits.add(c));
  // Every path each blob was ever stored at (review round 4, R5: rev-list --objects names a blob once,
  // under its first path, so a local/ path whose bytes match another file was never checked). git log
  // --raw lists each added or changed path of every commit, merges against each parent (-m).
  const objs = new Map(); // blob sha -> Set of paths
  const allPaths = new Set();
  const raw = git(['log', '--raw', '-z', '--no-renames', '-m', '--no-abbrev', '--format=', ...shas]).toString().split('\0');
  for (let i = 0; i < raw.length - 1; i++) {
    const meta = raw[i].replace(/^\n+/, '');
    if (!meta.startsWith(':')) continue;
    const [, mode, , sha, status] = meta.slice(1).split(' ');
    const p = raw[++i];
    if (status === 'D' || /^0+$/.test(sha)) continue;
    if (!allPaths.has(p)) { // path terms and the local rule, once per path (named with the first blob seen)
      allPaths.add(p);
      for (const n of termsIn(p)) { out(`${shown(p)}@${sha.slice(0, 12)} (path): term #${n}`); hitCount++; }
      reportLocal(`${shown(p)}@${sha.slice(0, 12)}`, p);
    }
    if (BAD_MODES.has(mode) && p.startsWith(LABELS_DIR)) { out(`${shown(p)}@${sha.slice(0, 12)}:1: labels rule: ${BAD_MODES.get(mode)} not allowed (only regular files)`); hitCount++; }
    if (mode === '160000') continue; // a gitlink names a commit of another repository: no blob here
    if (!objs.has(sha)) objs.set(sha, new Set());
    objs.get(sha).add(p);
  }
  // Label blobs are checked against the validator and data of the (first) pushed tip.
  await prepareLabels([...allPaths], (p) => tryGit(['show', `${shas[0]}:${p}`]), `commit ${shas[0].slice(0, 12)}`);
  const all = [...commits, ...objs.keys()];
  const buf = git(['cat-file', '--batch'], all.join('\n') + '\n');
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const [sha, type, sizeS] = buf.subarray(off, nl).toString().split(' ');
    const size = Number(sizeS);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    off = nl + 1 + size + 1;
    if (type === 'commit') {
      const text = body.toString('utf8').split('\n').filter((l) => !/^(tree|parent) /.test(l)).join('\n');
      for (const n of termsIn(text)) { out(`commit ${sha.slice(0, 12)} message/header: term #${n}`); hitCount++; }
    } else if (type === 'blob') {
      const ps = [...(objs.get(sha) || [])];
      const p = ps[0] || '';
      for (const q of ps) reportLabels(`${shown(q)}@${sha.slice(0, 12)}`, q, body); // the labels rule depends on the path
      if (!isBinary(body)) {
        for (const h of scanText(body.toString('utf8'))) {
          out(`${shown(p)}@${sha.slice(0, 12)}:${h.line}: term #${h.n}`); hitCount++;
        }
      }
    }
  }
}
function listTips(shas) {
  out('Files in pushed tip tree(s):');
  const seen = new Set();
  for (const s of shas) {
    // A symlink or gitlink under data/labels/ in a pushed tree is a hit (a gitlink has no blob to scan).
    for (const [p, mode] of modesOf(git(['ls-tree', '-r', '-z', s, '--', LABELS_DIR]).toString())) {
      if (BAD_MODES.has(mode)) { out(`${shown(p)}@${s.slice(0, 12)}:1: labels rule: ${BAD_MODES.get(mode)} not allowed (only regular files)`); hitCount++; }
    }
    for (const p of git(['ls-tree', '-r', '--name-only', '-z', s]).toString().split('\0').filter(Boolean)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out('  ' + shown(p));
    }
  }
}
async function historyScan(shas, gate) {
  await scanCommits(shas);
  listTips(shas);
  if (hitCount) { err(`private-scan: ${hitCount} hit(s). Push blocked.`); return 1; }
  if (!gate) return 0;
  if (process.env.UJWALAM_PUSH_APPROVED === '1') return 0;
  err('Clean. Review the file list, then push with UJWALAM_PUSH_APPROVED=1 after the user says yes.');
  return 1;
}
async function prePush() {
  const stdin = readFileSync(0, 'utf8');
  const shas = [];
  for (const line of stdin.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    if (/^0+$/.test(f[1])) continue; // delete-ref
    shas.push(f[1]);
  }
  if (!shas.length) return 0;
  return historyScan(shas, true);
}

switch (mode) {
  case 'pre-commit': process.exit(await preCommit());
  case 'commit-msg': process.exit(commitMsg(args[1]));
  case 'pre-push': process.exit(await prePush());
  case 'scan-history': process.exit(await historyScan([git(['rev-parse', 'HEAD']).toString().trim()], false));
  case 'scan-worktree': process.exit(await worktree());
  case 'scan-files': process.exit(scanFiles(args.slice(1)));
  default:
    err('usage: private-scan.mjs pre-commit|commit-msg <file>|pre-push|scan-history|scan-worktree|scan-files <path>... [--profile <path>]');
    process.exit(2);
}
