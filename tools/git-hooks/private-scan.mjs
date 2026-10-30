#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Private-data scanner for git hooks. Terms come from a gitignored profile
// (data/profile.local.json). Output never echoes a term or matched text.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function failClosed(msg, hint = 'Create data/profile.local.json from data/profile.example.json.') {
  err(`private-scan: ${msg}`);
  err(`private-scan: failing closed. ${hint}`);
  process.exit(1);
}

// ---- terms ----
// Every string value in the profile is a term, except "$..." keys, "version" and "<placeholder>" values. A term is
// reduced to its core: format characters removed, NFKC, letters and digits only, case folded per code point.
//   - core of 4+ letters/digits: matched anywhere in the file's core text (all non-letter/digit characters removed),
//     so any run of separators, line breaks inside the file, zero-width or bidi characters, soft hyphens and
//     fullwidth forms between the letters still hit (review E8-07).
//   - core of 2 or 3 (short terms, e.g. a clan tag): matched as a whole token only (no letter or digit directly
//     before or after), with at most ONE non-space separator between letters ("K-Q-9", "K.Q.9", "K_Q_9" hit;
//     "K Q 9", "a, b" and "xKQ9y" do not). Short terms get this narrower rule because a 2-3 letter sequence across
//     arbitrary separators matches ordinary text and code everywhere. Add spaced variants to the profile if needed.
//   - core of 1: refused at load (fails closed with a message); it cannot be matched without hitting everything.
// Every run prints the term counts (numbers only) on stderr.
const ALNUM_RUN = /[\p{L}\p{N}]+/gu;
// Format characters (Cf: zero-width space and joiners, word joiner, soft hyphen, bidi controls, BOM) and U+034F.
const STRIP = /[\p{Cf}\u034F]/gu;
const SHORT_LEN = 4;
const fold = (s) => { let o = ''; for (const c of s) o += c.toLowerCase(); return o; };
const normalise = (s) => s.replace(STRIP, '').normalize('NFKC').replace(STRIP, '');
const coreOf = (s) => fold((normalise(s).match(ALNUM_RUN) || []).join(''));
const reEsc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function collect(node, acc, other) {
  if (typeof node === 'string') acc.push(node);
  else if (Array.isArray(node)) node.forEach((v) => collect(v, acc, other));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$') || k === 'version') continue;
      collect(v, acc, other);
    }
  } else if (node !== null) other.n++; // numbers and booleans are not terms; counted, never silently
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
  const other = { n: 0 };
  collect(doc, raw, other);
  const list = [];
  const seen = new Set();
  const counts = { values: raw.length, placeholders: 0, empty: 0, duplicates: 0, nonString: other.n };
  raw.forEach((s, i) => {
    if (/^<.*>$/s.test(s.trim())) { counts.placeholders++; return; }
    const core = coreOf(s);
    const len = [...core].length;
    if (len === 0) { counts.empty++; return; }
    if (len === 1) failClosed(`profile string value #${i + 1} has a single letter or digit and cannot be matched safely.`, 'Fix that value in data/profile.local.json (use a longer variant).');
    if (seen.has(core)) { counts.duplicates++; return; }
    seen.add(core);
    const short = len < SHORT_LEN;
    const rx = short
      ? new RegExp(`(?<![\\p{L}\\p{N}])${[...core].map(reEsc).join('[^\\p{L}\\p{N}\\s]?')}(?![\\p{L}\\p{N}])`, 'gu')
      : null;
    list.push({ core, short, rx });
  });
  if (!list.length) failClosed('profile has no usable terms.');
  return { list, counts, short: list.filter((t) => t.short).length };
}
const terms = loadTerms();

// ---- matching ----
// Core text of a file: the folded letter/digit runs joined together, with the skeleton offset and line of each run.
// maxGap (binary views only): a separator run longer than this breaks the core text, so random bytes do not join.
function skeleton(t, maxGap) {
  const parts = []; const runAt = []; const runLine = [];
  let pos = 0; let line = 1; let len = 0;
  let nl = t.indexOf('\n');
  for (const m of t.matchAll(ALNUM_RUN)) {
    while (nl !== -1 && nl < m.index) { line++; nl = t.indexOf('\n', nl + 1); }
    if (len > 0 && m.index - pos > maxGap) { parts.push('\u0001'); len++; }
    const f = fold(m[0]);
    runAt.push(len); runLine.push(line);
    parts.push(f); len += f.length;
    pos = m.index + m[0].length;
  }
  return { s: parts.join(''), runAt, runLine };
}
function lineAt(sk, at) {
  let lo = 0; let hi = sk.runAt.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sk.runAt[mid] <= at) lo = mid; else hi = mid - 1; }
  return sk.runLine[lo] ?? 1;
}
// -> [{line, n}], one entry per (line, term), sorted by line then term number.
// opts: { maxGap = Infinity, long = true, short = true } (which term kinds to look for).
function findTerms(text, { maxGap = Infinity, long = true, short = true } = {}) {
  const t = normalise(text);
  const sk = long ? skeleton(t, maxGap) : null;
  const res = [];
  const seen = new Set();
  const add = (line, n) => { const k = `${line}:${n}`; if (!seen.has(k)) { seen.add(k); res.push({ line, n }); } };
  let ft = null; // folded full text, only built when there are short terms
  terms.list.forEach((term, i) => {
    if (term.short ? !short : !long) return;
    if (!term.short) {
      for (let at = sk.s.indexOf(term.core); at !== -1; at = sk.s.indexOf(term.core, at + term.core.length)) add(lineAt(sk, at), i + 1);
      return;
    }
    if (ft === null) ft = fold(t);
    let line = 1; let pos = 0;
    term.rx.lastIndex = 0;
    for (const m of ft.matchAll(term.rx)) {
      for (let k = ft.indexOf('\n', pos); k !== -1 && k < m.index; k = ft.indexOf('\n', k + 1)) { line++; pos = k + 1; }
      add(line, i + 1);
    }
  });
  return res.sort((a, b) => a.line - b.line || a.n - b.n);
}
const termsIn = (text) => [...new Set(findTerms(text).map((h) => h.n))].sort((a, b) => a - b);

// ---- decoding (review E8-01): no file is skipped because it has a NUL byte ----
// UTF-8 (with or without BOM) is decoded as text. A UTF-16LE/BE BOM, or the alternating-NUL pattern of UTF-16 text
// without a BOM, is decoded as UTF-16 text. Anything else with a NUL byte is binary: its bytes are scanned as UTF-8
// and as UTF-16LE/BE at both byte alignments, with the core text broken at separator runs over BINARY_GAP.
const BINARY_GAP = 3;
const ISLAND = /[^\u0000-\u0008\u000e-\u001f\u007f-\u009f�]{4,}/gu;
const isBinary = (buf) => buf.includes(0);
const utf16be = (b) => { const c = Buffer.from(b.subarray(0, b.length & ~1)); c.swap16(); return c.toString('utf16le'); };
function utf16Pattern(buf) {
  const n = Math.min(buf.length, 65536) & ~1;
  if (n < 2) return null;
  let even = 0; let odd = 0;
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) even++; if (buf[i + 1] === 0) odd++; }
  const pairs = n / 2;
  if (odd >= pairs * 0.3 && even <= pairs * 0.02) return 'utf16le';
  if (even >= pairs * 0.3 && odd <= pairs * 0.02) return 'utf16be';
  return null;
}
function decode(buf) { // -> { kind: 'utf8'|'utf16le'|'utf16be'|'binary', text? }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { kind: 'utf8', text: buf.subarray(3).toString('utf8') };
  const utf32 = (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) || (buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff);
  if (!utf32 && buf[0] === 0xff && buf[1] === 0xfe) return { kind: 'utf16le', text: buf.subarray(2).toString('utf16le') };
  if (!utf32 && buf[0] === 0xfe && buf[1] === 0xff) return { kind: 'utf16be', text: utf16be(buf.subarray(2)) };
  if (!isBinary(buf)) return { kind: 'utf8', text: buf.toString('utf8') };
  const pat = utf16Pattern(buf);
  if (pat === 'utf16le') return { kind: pat, text: buf.toString('utf16le') };
  if (pat === 'utf16be') return { kind: pat, text: utf16be(buf) };
  return { kind: 'binary' };
}
const stats = { files: 0, utf16: 0, binary: 0, skipped: 0 };
// -> { kind, hits: [{line, n, binary?}] }
function scanBuf(buf) {
  stats.files++;
  const d = decode(buf);
  if (d.kind !== 'binary') {
    if (d.kind !== 'utf8') stats.utf16++;
    return { kind: d.kind, hits: findTerms(d.text) };
  }
  stats.binary++;
  const ns = new Set();
  for (const v of [buf.toString('utf8'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le'), utf16be(buf), utf16be(buf.subarray(1))]) {
    for (const h of findTerms(v, { maxGap: BINARY_GAP, short: false })) ns.add(h.n);
    // Short terms only inside printable islands (4+ printable characters, like `strings`): a 2-3 letter token occurs
    // in random bytes by chance, but a term written as text inside a binary sits in such an island.
    if (terms.short) for (const h of findTerms((v.match(ISLAND) || []).join('\n'), { long: false })) ns.add(h.n);
  }
  return { kind: 'binary', hits: [...ns].sort((a, b) => a - b).map((n) => ({ line: 1, n, binary: true })) };
}
const shown = (p) => (termsIn(p).length ? '<path-redacted>' : p);

let hitCount = 0;
const hitLine = (label, h) => `${label}:${h.line}: term #${h.n}${h.binary ? ' (binary content, raw bytes)' : ''}`;
function report(label, res) {
  for (const h of res.hits) { out(hitLine(label, h)); hitCount++; }
}
function scanPath(p, label) {
  for (const n of termsIn(p)) { out(`${label} (path): term #${n}`); hitCount++; }
}
// A file whose content cannot be scanned is always reported with its reason; failClosed makes it a hit.
function skipped(label, reason, failClosedHit) {
  stats.skipped++;
  out(`${label}:1: skipped: ${reason}${failClosedHit ? ', failing closed' : ''}`);
  if (failClosedHit) hitCount++;
}
function summary() {
  const c = terms.counts;
  err(`private-scan: ${terms.list.length} term(s) loaded (${terms.short} short, whole-token); profile values ignored: ${c.placeholders} placeholder, ${c.empty} without letters or digits, ${c.duplicates} duplicate, ${c.nonString} non-string`);
  err(`private-scan: ${stats.files} content item(s) scanned (${stats.utf16} UTF-16 decoded, ${stats.binary} binary scanned as raw bytes); ${stats.skipped} skipped (each listed above)`);
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
// for scan-worktree. Exception (review E8-13): pre-push and scan-history take the validator CODE and
// schema from the checked-out hook tooling, read at hook start (VALIDATOR_CODE, toolingSnapshot), never
// from the commits being pushed. A missing file fails closed with a message. They are copied to a temp folder
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
// code (optional): { files: Map(path -> Buffer), missing, where } for the validator code and schema (E8-13).
async function loadLabelsCtx(read, where, code = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'private-scan-labels-'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });
  const put = (p, buf) => { const f = path.join(dir, ...p.split('/')); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, buf); };
  if (code && code.missing.length) return { error: `label validator not in ${code.where} (${code.missing.join(', ')}), failing closed` };
  const missing = [];
  for (const p of CTX_FILES) {
    const b = code && code.files.has(p) ? code.files.get(p) : read(p);
    if (b === null) missing.push(p); else put(p, b);
  }
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
async function prepareLabels(paths, read, where, code = null) {
  if (paths.some(needsCtx)) labelsCtx = await loadLabelsCtx(read, where, code);
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
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
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
  const modes = names.length ? modesOf(git(['ls-files', '-s', '-z']).toString()) : new Map();
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
    const inLabels = p.startsWith(LABELS_DIR);
    // The labels rule runs first, so an unreadable blob, a symlink or a gitlink under data/labels/ is a hit.
    // Outside data/labels/ a symlink's blob (its target text) is scanned; a gitlink has no blob here.
    const buf = (inLabels && mode && BAD_MODES.has(mode)) || mode === '160000' ? null : tryGit(['show', ':' + p]);
    reportLabels(shown(p), p, buf, mode);
    if (buf === null) {
      if (inLabels) continue; // already a labels-rule hit
      if (mode === '160000') skipped(shown(p), 'gitlink (submodule), no blob in this repository', false);
      else skipped(shown(p), 'the staged blob cannot be read', true);
      continue;
    }
    report(shown(p), scanBuf(buf));
  }
  summary();
  return hitCount ? 1 : 0;
}
function commitMsg(file) {
  if (!file) failClosed('commit-msg needs a file argument.');
  for (const h of scanBuf(readFileSync(file)).hits) { out(hitLine('commit message', h)); hitCount++; }
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
    let readErr = null;
    try { buf = mode && BAD_MODES.has(mode) ? null : readFileSync(path.join(top, ...p.split('/'))); } catch (e) { buf = null; readErr = e?.code ?? 'error'; }
    reportLabels(shown(p), p, buf, mode);
    const hits = termsIn(p).map((n) => ({ n }));
    if (buf === null) {
      // Under data/labels/ the labels rule has already reported it. A tracked file deleted from the working tree has
      // nothing to leak here (pre-commit scans the index); a directory (a gitlink checkout) has no content of its own.
      if (!p.startsWith(LABELS_DIR)) {
        if (readErr === 'ENOENT') skipped(shown(p), 'not in the working tree (deleted)', false);
        else if (readErr === 'EISDIR') skipped(shown(p), 'a directory (gitlink checkout), not a file', false);
        else skipped(shown(p), `cannot be read (${readErr})`, true);
      }
    } else {
      hits.push(...scanBuf(buf).hits);
    }
    if (hits.length) perFile.push([shown(p), hits.length, [...new Set(hits.map((h) => h.n))].sort((a, b) => a - b)]);
  }
  out(`scanned ${names.length} files`);
  for (const [p, c, ns] of perFile) { out(`${p}: ${c} hit(s), terms ${ns.map((n) => '#' + n).join(' ')}`); hitCount += c; }
  summary();
  return hitCount ? 1 : 0;
}

// scan-files <path>...: terms in the given files (paths are not echoed). Used by the label server tests.
function scanFiles(paths) {
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); } catch { err('private-scan: cannot read a file, failing closed'); stats.skipped++; hitCount++; continue; }
    report('file', scanBuf(buf));
  }
  summary();
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
    if (mode === '160000') { // a gitlink names a commit of another repository: no blob here
      if (!p.startsWith(LABELS_DIR)) skipped(`${shown(p)}@${sha.slice(0, 12)}`, 'gitlink (submodule), no blob in this repository', false);
      continue;
    }
    if (!objs.has(sha)) objs.set(sha, new Set());
    objs.get(sha).add(p);
  }
  // Label blobs are checked against the label DATA of the (first) pushed tip, with the validator CODE and schema of
  // the checked-out hook tooling (review E8-13; see toolingSnapshot).
  await prepareLabels([...allPaths], (p) => tryGit(['show', `${shas[0]}:${p}`]), `commit ${shas[0].slice(0, 12)}`, tooling);
  const all = [...commits, ...objs.keys()];
  const buf = git(['cat-file', '--batch'], all.join('\n') + '\n');
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const [sha, type, sizeS] = buf.subarray(off, nl).toString().split(' ');
    if (type === 'missing' || !/^\d+$/.test(sizeS ?? '')) { // object not in this repository: never skipped silently
      off = nl + 1;
      const ps = [...(objs.get(sha) || [])];
      skipped(ps.length ? `${shown(ps[0])}@${sha.slice(0, 12)}` : `object ${sha.slice(0, 12)}`, 'object missing from the repository', true);
      continue;
    }
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
      report(`${shown(p)}@${sha.slice(0, 12)}`, scanBuf(body));
    }
  }
}
// Review E8-13: pre-push and scan-history never import the label validator from the commits being checked. The
// validator code and schema (VALIDATOR_CODE) are read once, when the hook starts, from the checked-out tree that holds
// this hook script (tools/git-hooks/ -> repository root; with core.hooksPath tools/git-hooks that is the working tree
// the push runs from). The label data (tags, sessions, session games, game packs) still comes from the pushed tip,
// because label files must match the data they are pushed with. Every run prints which version was used.
const VALIDATOR_CODE = ['tools/label/labels-export.mjs', 'tools/label/schema-lite.mjs', 'data/labels.schema.json'];
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let tooling = null;
function toolingSnapshot() {
  const files = new Map();
  const missing = [];
  for (const p of VALIDATOR_CODE) {
    try { files.set(p, readFileSync(path.join(TOOL_ROOT, ...p.split('/')))); } catch { missing.push(p); }
  }
  const id = [...files].map(([p, b]) => `${p} ${createHash('sha256').update(b).digest('hex').slice(0, 12)}`).join(', ');
  err(`private-scan: label validator code from the checked-out hook tooling (working tree at hook start): ${id || 'none'}${missing.length ? `; missing: ${missing.join(', ')}` : ''}; label data from the pushed tip`);
  return { files, missing, where: 'the checked-out hook tooling' };
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
  summary();
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

// The tooling snapshot is taken here, before any other work, for the modes that check pushed or committed history.
if (mode === 'pre-push' || mode === 'scan-history') tooling = toolingSnapshot();
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
