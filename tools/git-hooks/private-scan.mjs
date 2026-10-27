#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Private-data scanner for git hooks. Terms come from a gitignored profile
// (data/profile.local.json). Output never echoes a term or matched text.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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

// ---- labels rule: data/labels/ holds timestamps + placeholder names only ----
const LABELS_DIR = 'data/labels/';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let Ajv2020 = null;
try { Ajv2020 = (await import(pathToFileURL(path.join(repoRoot, 'node_modules', 'ajv', 'dist', '2020.js')).href)).default; } catch { /* minimal checker below */ }

// Minimal structural validator (fallback when ajv is absent). Returns error strings (paths + keywords, never values).
function miniValidate(schema, root, v, at, errs) {
  if (schema.$ref) { miniValidate(schema.$ref.split('/').slice(1).reduce((n, k) => n[k], root), root, v, at, errs); return; }
  if (schema === false) { errs.push(`${at} forbidden`); return; }
  const isObj = v && typeof v === 'object' && !Array.isArray(v);
  const t = schema.type;
  if (t === 'object' && !isObj) return void errs.push(`${at} type`);
  if (t === 'array' && !Array.isArray(v)) return void errs.push(`${at} type`);
  if (t === 'string' && typeof v !== 'string') return void errs.push(`${at} type`);
  if (t === 'number' && typeof v !== 'number') return void errs.push(`${at} type`);
  if (t === 'integer' && !Number.isInteger(v)) return void errs.push(`${at} type`);
  if ('const' in schema && v !== schema.const) errs.push(`${at} const`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at} enum`);
  if (schema.pattern && typeof v === 'string' && !new RegExp(schema.pattern).test(v)) errs.push(`${at} pattern`);
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${at} minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${at} maximum`);
    if (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum) errs.push(`${at} exclusiveMinimum`);
  }
  if (Array.isArray(v)) {
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${at} uniqueItems`);
    if (schema.items) v.forEach((x, i) => miniValidate(schema.items, root, x, `${at}/${i}`, errs));
  }
  if (isObj) {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${at} required`);
    const props = schema.properties || {};
    for (const k of Object.keys(v)) {
      if (k in props) miniValidate(props[k], root, v[k], `${at}/${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${at} additionalProperties`);
    }
    if (schema.if) {
      const probe = []; miniValidate(schema.if, root, v, at, probe);
      if (!probe.length && schema.then) miniValidate(schema.then, root, v, at, errs);
    }
  }
}

let labelsValidators; // undefined = not tried, null = unavailable
function getLabelsValidators() {
  if (labelsValidators !== undefined) return labelsValidators;
  labelsValidators = null;
  let schema;
  try { schema = JSON.parse(readFileSync(path.join(repoRoot, 'data', 'labels.schema.json'), 'utf8')); } catch { return null; }
  if (!schema || typeof schema !== 'object' || !schema.$defs || !schema.$defs.label) return null;
  const recSchema = { ...schema.$defs.label };
  if (Ajv2020) {
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const doc = ajv.compile(schema);
      const rec = ajv.compile({ $defs: schema.$defs, ...recSchema });
      const fmt = (v) => () => [...new Set((v.errors || []).map((e) => `${e.instancePath || '/'} ${e.keyword}`))];
      labelsValidators = { doc: (x) => (doc(x) ? [] : fmt(doc)()), rec: (x) => (rec(x) ? [] : fmt(rec)()) };
      return labelsValidators;
    } catch { return null; }
  }
  const run = (sch) => (x) => { const e = []; miniValidate(sch, schema, x, '', e); return [...new Set(e.map((m) => m || '/'))]; };
  labelsValidators = { doc: run(schema), rec: run({ ...recSchema, $defs: schema.$defs }) };
  return labelsValidators;
}

// -> [{line, reason}] for one file under data/labels/. buf = file bytes. Reasons never contain file values.
function labelsRule(p, buf) {
  if (!p.startsWith(LABELS_DIR)) return [];
  const base = p.split('/').pop();
  if (base === '.gitkeep') return [];
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  if (ext !== '.json' && ext !== '.jsonl') return [{ line: 1, reason: 'file type not allowed (only .gitkeep, .json, .jsonl)' }];
  const vs = getLabelsValidators();
  if (!vs) return [{ line: 1, reason: 'schema unavailable, failing closed' }];
  if (isBinary(buf)) return [{ line: 1, reason: 'binary content' }];
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const res = [];
  if (ext === '.jsonl') {
    text.split('\n').forEach((raw, i) => {
      if (!raw.trim()) return;
      let rec;
      try { rec = JSON.parse(raw); } catch { res.push({ line: i + 1, reason: 'invalid JSON' }); return; }
      for (const e of vs.rec(rec)) res.push({ line: i + 1, reason: `schema violation at ${e}` });
    });
    return res;
  }
  let doc;
  try { doc = JSON.parse(text); } catch { return [{ line: 1, reason: 'invalid JSON' }]; }
  const lines = text.split('\n');
  const idLines = lines.flatMap((l, i) => (/"id"\s*:/.test(l) ? [i + 1] : []));
  for (const e of vs.doc(doc)) {
    const m = /^\/labels\/(\d+)\//.exec(e);
    res.push({ line: (m && idLines[Number(m[1])]) || 1, reason: `schema violation at ${e}` });
  }
  return res;
}
function reportLabels(label, p, buf) {
  for (const h of labelsRule(p, buf)) { out(`${label}:${h.line}: labels rule: ${h.reason}`); hitCount++; }
}

// ---- modes ----
function preCommit() {
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString().split('\0').filter(Boolean);
  for (const p of names) {
    scanPath(p, 'staged ' + shown(p));
    let buf;
    try { buf = git(['show', ':' + p]); } catch { continue; }
    reportLabels(shown(p), p, buf);
    if (isBinary(buf)) continue;
    report(shown(p), scanText(buf.toString('utf8')));
  }
  return hitCount ? 1 : 0;
}
function commitMsg(file) {
  if (!file) failClosed('commit-msg needs a file argument.');
  for (const h of scanText(readFileSync(file, 'utf8'))) { out(`commit message:${h.line}: term #${h.n}`); hitCount++; }
  return hitCount ? 1 : 0;
}
function worktree() {
  const names = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean);
  const perFile = [];
  for (const p of names) {
    let buf;
    try { buf = readFileSync(p); } catch { continue; }
    reportLabels(shown(p), p, buf);
    const hits = termsIn(p).map((n) => ({ n }));
    if (!isBinary(buf)) hits.push(...scanText(buf.toString('utf8')));
    if (hits.length) perFile.push([shown(p), hits.length, [...new Set(hits.map((h) => h.n))].sort((a, b) => a - b)]);
  }
  out(`scanned ${names.length} files`);
  for (const [p, c, ns] of perFile) { out(`${p}: ${c} hit(s), terms ${ns.map((n) => '#' + n).join(' ')}`); hitCount += c; }
  return hitCount ? 1 : 0;
}

function scanCommits(shas) {
  const commits = new Set();
  for (const s of shas) git(['rev-list', s]).toString().split('\n').filter(Boolean).forEach((c) => commits.add(c));
  const objs = new Map(); // sha -> path
  for (const s of shas) {
    for (const line of git(['rev-list', '--objects', s]).toString().split('\n')) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const sha = line.slice(0, sp);
      if (!objs.has(sha)) objs.set(sha, line.slice(sp + 1));
    }
  }
  const all = [...commits, ...objs.keys()];
  const buf = git(['cat-file', '--batch'], all.join('\n') + '\n');
  let off = 0;
  const pathsSeen = new Set();
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
      const p = objs.get(sha) || '';
      if (!pathsSeen.has(p)) {
        pathsSeen.add(p);
        for (const n of termsIn(p)) { out(`blob ${sha.slice(0, 12)} (path): term #${n}`); hitCount++; }
      }
      reportLabels(`${shown(p)}@${sha.slice(0, 12)}`, p, body);
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
    for (const p of git(['ls-tree', '-r', '--name-only', '-z', s]).toString().split('\0').filter(Boolean)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out('  ' + shown(p));
    }
  }
}
function historyScan(shas, gate) {
  scanCommits(shas);
  listTips(shas);
  if (hitCount) { err(`private-scan: ${hitCount} hit(s). Push blocked.`); return 1; }
  if (!gate) return 0;
  if (process.env.UJWALAM_PUSH_APPROVED === '1') return 0;
  err('Clean. Review the file list, then push with UJWALAM_PUSH_APPROVED=1 after the user says yes.');
  return 1;
}
function prePush() {
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
  case 'pre-commit': process.exit(preCommit());
  case 'commit-msg': process.exit(commitMsg(args[1]));
  case 'pre-push': process.exit(prePush());
  case 'scan-history': process.exit(historyScan([git(['rev-parse', 'HEAD']).toString().trim()], false));
  case 'scan-worktree': process.exit(worktree());
  default:
    err('usage: private-scan.mjs pre-commit|commit-msg <file>|pre-push|scan-history|scan-worktree [--profile <path>]');
    process.exit(2);
}
