// SPDX-License-Identifier: GPL-3.0-or-later
// tools/git-hooks/private-scan.mjs: synthetic terms only, temp repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(repo, 'tools', 'git-hooks', 'private-scan.mjs');
const TERM = 'FooBar~XY';
const dir = mkdtempSync(path.join(os.tmpdir(), 'pscan-'));
const profile = path.join(dir, 'profile.json');
const work = path.join(dir, 'work');
writeFileSync(profile, JSON.stringify({
  $comment: 'ZzCommentZz', version: 'Ver-Sion-9',
  a: { t: TERM, short: 'a-b', ph: '<placeholder-x>' },
  private_terms: ['Second_Term'],
}));

const run = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: work, encoding: 'utf8', ...o, windowsHide: true });
const git = (...a) => {
  const r = run('git', a);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const scan = (a, o = {}) => run('node', [scanner, ...a, '--profile', profile], o);
const put = (name, content) => writeFileSync(path.join(work, name), content);

test.before(() => {
  spawnSync('git', ['init', '-q', work], { windowsHide: true });
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.hooksPath', 'none');
  git('config', 'commit.gpgsign', 'false');
});
test.after(() => rmSync(dir, { recursive: true, force: true }));

const staged = (name, content) => { put(name, content); git('add', name); };
const noEcho = (r) => {
  const all = r.stdout + r.stderr;
  assert.ok(!/foo|bar|second|xy/i.test(all.replace(/commit message|staged|path|private|failing|profile/gi, '')), all);
};

test('case and separator variants hit; hits never echo the term', () => {
  staged('v.txt', 'ok\nfoobarxy\nFOO-BAR_XY\nF o o B a r X Y\nfoo^^bar~~xy\nsecond term\n');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.some((l) => /v\.txt:2: term #1/.test(l)));
  assert.ok(lines.some((l) => /v\.txt:3: term #1/.test(l)));
  assert.ok(lines.some((l) => /v\.txt:5: term #1/.test(l)));
  assert.ok(lines.some((l) => /v\.txt:6: term #3/.test(l))); // term #2 is the short term 'a-b' (E8-07: no longer dropped)
  assert.ok(lines.some((l) => /v\.txt:4: term #1/.test(l)));
  noEcho(r);
  git('reset', '-q');
});

test('placeholders, $-keys and version are not terms; term counts are printed (numbers only)', () => {
  staged('s.txt', '<placeholder-x> placeholderx versionversion9 ZzCommentZz Ver-Sion-9\n');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stderr, /private-scan: 3 term\(s\) loaded \(1 short, whole-token\); profile values ignored: 1 placeholder, 0 without letters or digits, 0 duplicate, 0 non-string/);
  assert.match(r.stderr, /1 content item\(s\) scanned \(0 UTF-16 decoded, 0 binary scanned as raw bytes\); 0 skipped/);
  git('reset', '-q');
});

// ---- review E8-07 (2026-10-29): normalisation before matching; short terms scanned, not dropped ----
test('E8-07: separator runs of any length, line breaks, format characters and fullwidth forms all hit', () => {
  const fw = (s) => [...s].map((c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join(''); // ASCII -> fullwidth
  const cases = {
    'sep3.txt': 'f - o - o - b - a - r - x - y\n',
    'sep-run.txt': 'foo------bar~~~~~~~~xy\n',
    'split.txt': 'intro\nfoo\nbar\nxy\n',
    'split-crlf.txt': 'foob\r\n  arxy\r\n',
    'zwsp3.txt': 'fo\u200B\u200B\u200Bobarxy\n',
    'soft-hyphen.txt': 'foo\u00ADbar\u00ADxy\n',
    'word-joiner.txt': 'foo\u2060bar\u2060xy\n',
    'zwj-zwnj.txt': 'foo\u200Dbar\u200Cxy\n',
    'bidi.txt': 'foo\u202Ebar\u2066xy\u2069\n',
    'cgj.txt': 'foo\u034Fbarxy\n',
    'fullwidth.txt': `${fw('FooBarXY')}\n`,
    'fullwidth-mixed.txt': `foo${fw('bar')}＿${fw('xy')}\n`,
  };
  for (const [name, content] of Object.entries(cases)) {
    staged(name, content);
    const r = scan(['pre-commit']);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.match(r.stdout, new RegExp(`${name.replace(/[.]/g, '\\.')}:\\d+: term #1`), name);
    noEcho(r);
    git('reset', '-q');
  }
  // the line of a split hit is the line where the term starts
  staged('split2.txt', 'a\nb\nfoo\nbar\nxy\n');
  assert.match(scan(['pre-commit']).stdout, /split2\.txt:3: term #1/);
  git('reset', '-q');
  // commit messages are normalised the same way
  const f = path.join(dir, 'msg-e807.txt');
  writeFileSync(f, 'feat: x\n\nf\u00ADo\u2060o b-a-r\nxy\n');
  assert.equal(scan(['commit-msg', f]).status, 1);
});

test('E8-07: a 2-3 character term is scanned as a whole token; a 1-character term fails loudly at load', () => {
  // 'a-b' in the profile: core "ab", term #2
  for (const [content, hit] of [
    ['x ab y\n', true], ['AB\n', true], ['a-b\n', true], ['a.b\n', true], ['a_b\n', true], ['a\u200Bb\n', true], ['ａｂ\n', true],
    ['cab\n', false], ['abc\n', false], ['a b\n', false], ['(a, b)\n', false], ['a--b\n', false], ['xa-by\n', false],
  ]) {
    staged('short.txt', content);
    const r = scan(['pre-commit']);
    assert.equal(r.status, hit ? 1 : 0, `${JSON.stringify(content)}: ${r.stdout}`);
    if (hit) assert.match(r.stdout, /short\.txt:1: term #2/);
    git('reset', '-q');
  }
  // a single letter or digit cannot be matched safely: refused with a message that does not echo the value
  const one = path.join(dir, 'profile-one.json');
  writeFileSync(one, JSON.stringify({ a: TERM, b: 'Q', c: '<p>' }));
  const r = run('node', [scanner, 'scan-worktree', '--profile', one]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /profile string value #2 has a single letter or digit/);
  assert.ok(!/\bQ\b/.test(r.stdout + r.stderr.replace(/private-scan/g, '')), r.stderr);
});

// ---- review E8-01 (2026-10-29): NUL-containing files are decoded or scanned as bytes, never skipped ----
const utf16le = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]);
const utf16be = (s, bom = true) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), b]); };
const noise = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

test('E8-01: UTF-16LE (BOM and no BOM) and UTF-16BE staged files with a term are blocked, with line numbers', () => {
  for (const [name, buf, line] of [
    ['le-bom.txt', utf16le('hello\r\nfoo bar xy\r\n'), 2],
    ['le-nobom.txt', utf16le('first line\nsecond line\nzz FooBarXY zz\n', false), 3],
    ['be-bom.txt', utf16be('foo_bar_xy\n'), 1],
    ['be-nobom.txt', utf16be('a\nb\nfoobarxy\n', false), 3],
  ]) {
    staged(name, buf);
    const r = scan(['pre-commit']);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`${name.replace(/[.]/g, '\\.')}:${line}: term #1$`, 'm'), name);
    assert.match(r.stderr, /1 UTF-16 decoded/);
    noEcho(r);
    git('reset', '-q');
  }
});

test('E8-01: binary files are scanned as raw bytes: a term in UTF-16 (either alignment) or UTF-8 inside binary data is blocked', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  for (const [name, buf] of [
    ['u16le.bin', Buffer.concat([png, noise(301, 7), Buffer.from('FooBarXY', 'utf16le'), noise(200, 9)])],
    ['u16le-odd.bin', Buffer.concat([png, noise(300, 7), Buffer.from('foobarxy', 'utf16le'), noise(200, 9)])],
    ['u16be.bin', Buffer.concat([png, noise(300, 3), utf16be('foobarxy', false), noise(77, 5)])],
    ['u8.bin', Buffer.concat([Buffer.from('foobarxy'), Buffer.from([0, 1, 2])])],
    ['text-one-nul.txt', Buffer.from('hello foobarxy\n\0\n')],
  ]) {
    staged(name, buf);
    const r = scan(['pre-commit']);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.match(r.stdout, new RegExp(`${name.replace(/[.]/g, '\\.')}:1: term #1 \\(binary content, raw bytes\\)`), name);
    assert.match(r.stderr, /1 binary scanned as raw bytes/);
    noEcho(r);
    git('reset', '-q');
  }
  // a short term written as text inside binary data hits (printable island); random bytes do not make short-term hits
  staged('short.bin', Buffer.concat([png, noise(500, 13), Buffer.from(' tag a-b here '), noise(500, 17)]));
  const sh = scan(['pre-commit']);
  assert.equal(sh.status, 1, sh.stdout);
  assert.match(sh.stdout, /short\.bin:1: term #2 \(binary content, raw bytes\)/);
  git('reset', '-q');
  // a binary file without a term passes (and is counted, not skipped)
  staged('clean.bin', Buffer.concat([png, noise(4096, 11)]));
  const ok = scan(['pre-commit']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stderr, /1 binary scanned as raw bytes\); 0 skipped/);
  git('reset', '-q');
});

test('path names are scanned without echoing the path', () => {
  staged('foobarxy-name.txt', 'clean');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\(path\): term #1/);
  assert.ok(!/foobarxy-name/.test(r.stdout));
  git('reset', '-q');
});

test('commit-msg', () => {
  const f = path.join(dir, 'msg.txt');
  writeFileSync(f, 'feat: thing\n\nby Foo Bar XY\n');
  const bad = scan(['commit-msg', f]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /commit message:3: term #1/);
  noEcho(bad);
  writeFileSync(f, 'feat: thing\n');
  assert.equal(scan(['commit-msg', f]).status, 0);
});

test('missing or broken profile fails closed', () => {
  const r = run('node', [scanner, 'pre-commit', '--profile', path.join(dir, 'nope.json')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /profile\.example\.json/);
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  const r2 = run('node', [scanner, 'commit-msg', 'x', '--profile', bad]);
  assert.equal(r2.status, 1);
});

test('pre-push: old-commit hit blocks; clean needs approval env', () => {
  staged('base.txt', 'base\n');
  git('commit', '-q', '-m', 'init');
  staged('leak.txt', 'x foo_bar_xy y\n');
  git('commit', '-q', '-m', 'add leak');
  git('rm', '-q', 'leak.txt');
  git('commit', '-q', '-m', 'remove leak');
  const tip = git('rev-parse', 'HEAD').trim();
  const refs = `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`;

  const hit = scan(['pre-push'], { input: refs, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(hit.status, 1, 'history hit blocks even when approved');
  assert.match(hit.stdout, /leak\.txt@[0-9a-f]+:1: term #1/);
  noEcho(hit);

  const scanH = scan(['scan-history']);
  assert.equal(scanH.status, 1);

  // Fresh clean repo history
  const first = git('rev-list', '--max-parents=0', 'HEAD').trim();
  const clean = `refs/heads/main ${first} refs/heads/main ${'0'.repeat(40)}\n`;
  const env = { ...process.env };
  delete env.UJWALAM_PUSH_APPROVED;
  const blocked = scan(['pre-push'], { input: clean, env });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Clean\. Review the file list/);
  const ok = scan(['pre-push'], { input: clean, env: { ...env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  const del = scan(['pre-push'], { input: `(delete) ${'0'.repeat(40)} refs/heads/x ${tip}\n`, env });
  assert.equal(del.status, 0);
});

test('scan-worktree reports per-file counts', () => {
  put('w.txt', 'foobarxy\nfoobarxy\n');
  const r = scan(['scan-worktree']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /w\.txt: 2 hit\(s\), terms #1/);
});

// ---- labels rule (data/labels/: label files validated exactly, N3 2026-10-28) ----
// The scanner reads the schema, tags, sessions and packs from this repository (real data files);
// the label files themselves are synthetic.
import { mkdirSync, readFileSync } from 'node:fs';
const SESSION = 's-2026-10-18-1221'; // in data/sessions.json and data/session-games.json (codm)
const goodRec = (o = {}) => ({
  id: 'l-0001', windowStartSec: 1, windowEndSec: 2, label: 'keep', reasonTags: ['multi-kill'],
  labeller: '<user>', createdAt: '2026-10-27T12:00:00Z', ...o,
});
const goodDoc = (labels = [goodRec()], extra = {}) => JSON.stringify({ version: 1, sessionId: SESSION, labels, ...extra }, null, 2);
const lput = (name, content) => {
  mkdirSync(path.dirname(path.join(work, 'data', 'labels', name)), { recursive: true });
  staged('data/labels/' + name, content);
};
const hasRule = (r, re) => r.stdout.split('\n').some((l) => re.test(l));
const blocked = (r, re, msg) => { assert.equal(r.status, 1, msg); assert.ok(hasRule(r, re), `${msg}: ${r.stdout}`); };
// The hook reads the validator and its data from the index (review M1), so the test repo commits copies.
const CTX = [
  'tools/label/labels-export.mjs', 'tools/label/schema-lite.mjs', 'data/labels.schema.json', 'data/label-tags.json',
  'data/sessions.json', 'data/session-games.json', 'data/games/codm/detectors.json', 'data/games/codm/events.json',
];
const copyCtx = (to) => {
  for (const p of CTX) {
    const dst = path.join(to, ...p.split('/'));
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(path.join(repo, ...p.split('/'))));
  }
};

test('labels setup: the validator and its data are committed in the test repo', () => {
  copyCtx(work);
  git('add', ...CTX);
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  git('commit', '-q', '-m', 'validator');
});

test('labels rule: a valid label file and an empty .gitkeep pass', () => {
  lput('.gitkeep', '');
  lput(`${SESSION}.json`, goodDoc([goodRec(), goodRec({ id: 'l-0002', windowStartSec: 5, windowEndSec: 9, label: 'reject', reasonTags: ['quiet'] })], {
    events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 1.5, verdict: 'accept', medal: 'Double Kill' }, { id: 'e-0002', detectorId: 'N1', timeSec: 3, verdict: 'added' }],
    timing: { highlightPassSec: 10, eventPassSec: 5 }, highlightsEditedAfterSuggestions: false,
  }));
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  git('reset', '-q');
});

test('labels rule: an extra field is blocked (additionalProperties false at every level)', () => {
  for (const [doc, re] of [
    [goodDoc([goodRec({ extra: 1 })]), /additionalProperties/],
    [goodDoc([goodRec()], { comment: 'x' }), /schema violation at \/ additionalProperties/],
    [goodDoc([goodRec()], { events: [{ id: 'e-0001', detectorId: 'N1', timeSec: 3, verdict: 'added', ocrText: 'x' }] }), /additionalProperties/],
    [goodDoc([goodRec()], { timing: { highlightPassSec: 1, eventPassSec: 1, other: 2 } }), /additionalProperties/],
  ]) {
    lput(`${SESSION}.json`, doc);
    blocked(scan(['pre-commit']), re, 'extra field');
    git('reset', '-q');
  }
});

test('labels rule: free text is blocked (note, labeller, $schema, medal outside the pack), never echoed', () => {
  for (const [rec, extra, re] of [
    [goodRec({ note: 'saw zorkwick play' }), {}, /additionalProperties/],
    [goodRec({ note: '<nothing-happens>' }), {}, /additionalProperties/],
    [goodRec({ labeller: 'janedoe' }), {}, /\/labels\/0\/labeller const/],
    [goodRec({ labeller: '<jane>' }), {}, /\/labels\/0\/labeller const/],
    [goodRec(), { $schema: 'zorkwick' }, /additionalProperties/],
    [goodRec(), { events: [{ id: 'e-0001', detectorId: 'M3', timeSec: 1, verdict: 'accept', medal: 'Zorkwick Janedoe' }] }, /\/events\/0\/medal not-in-pack/],
    [goodRec(), { events: [{ id: 'e-0001', detectorId: 'ZZ9', timeSec: 1, verdict: 'added' }] }, /\/events\/0\/detectorId not-in-pack/],
  ]) {
    lput(`${SESSION}.json`, goodDoc([rec], extra));
    const r = scan(['pre-commit']);
    blocked(r, re, 'free text');
    assert.ok(!/janedoe|zorkwick/i.test(r.stdout + r.stderr));
    git('reset', '-q');
  }
});

test('labels rule: a free-text or unknown tag is blocked', () => {
  lput(`${SESSION}.json`, goodDoc([goodRec({ reasonTags: ['Jane Doe was here'] })]));
  blocked(scan(['pre-commit']), /\/labels\/0\/reasonTags\/0 pattern/, 'free-text tag');
  git('reset', '-q');
  lput(`${SESSION}.json`, goodDoc([goodRec({ reasonTags: ['multi-kill', 'janedoe'] })]));
  const r = scan(['pre-commit']);
  blocked(r, /\/labels\/0\/reasonTags\/1 not-in-tags/, 'unknown tag');
  assert.ok(!/janedoe/i.test(r.stdout));
  git('reset', '-q');
});

test('labels rule: a name-shaped id is blocked', () => {
  for (const [doc, re] of [
    [goodDoc([goodRec({ id: 'l-janedoe' })]), /\/labels\/0\/id pattern/],
    [goodDoc([goodRec({ id: 'janedoe' })]), /\/labels\/0\/id pattern/],
    [goodDoc([goodRec()], { events: [{ id: 'e-Janedoe', detectorId: 'N1', timeSec: 3, verdict: 'added' }] }), /\/events\/0\/id pattern/],
    [goodDoc([goodRec()], { events: [{ id: 'e-0001', detectorId: 'Janedoe', timeSec: 3, verdict: 'added' }] }), /\/events\/0\/detectorId pattern/],
  ]) {
    lput(`${SESSION}.json`, doc);
    const r = scan(['pre-commit']);
    blocked(r, re, 'name-shaped id');
    assert.ok(!/janedoe/i.test(r.stdout + r.stderr));
    git('reset', '-q');
  }
});

test('labels rule: unknown session, wrong file name, bad times, duplicate ids are blocked', () => {
  lput('s-2099-01-01-0000.json', JSON.stringify({ version: 1, sessionId: 's-2099-01-01-0000', labels: [goodRec()] }));
  blocked(scan(['pre-commit']), /\/sessionId unknown-session/, 'unknown session');
  git('reset', '-q');
  lput('other-name.json', goodDoc());
  blocked(scan(['pre-commit']), /file name is not <sessionId>\.json/, 'file name');
  git('reset', '-q');
  for (const [doc, re] of [
    [goodDoc([goodRec({ windowStartSec: 5, windowEndSec: 5 })]), /\/labels\/0 end-not-after-start/],
    [goodDoc([goodRec({ windowStartSec: 9, windowEndSec: 5 })]), /\/labels\/0 end-not-after-start/],
    [goodDoc([goodRec(), goodRec()]), /\/labels\/1 duplicate-id/],
    [goodDoc([goodRec({ windowStartSec: -1 })]), /minimum/],
  ]) {
    lput(`${SESSION}.json`, doc);
    blocked(scan(['pre-commit']), re, 'times or ids');
    git('reset', '-q');
  }
});

test('labels rule: only .gitkeep and .json, no subfolders, empty .gitkeep; bad JSON blocked', () => {
  lput('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  lput('notes.txt', 'plain');
  lput('b.jsonl', JSON.stringify(goodRec()) + '\n');
  lput('sub/x.json', goodDoc());
  lput('f.json', '{ not json');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.ok(hasRule(r, /pic\.png:1: labels rule: file type not allowed/));
  assert.ok(hasRule(r, /notes\.txt:1: labels rule: file type not allowed/));
  assert.ok(hasRule(r, /b\.jsonl:1: labels rule: file type not allowed/));
  assert.ok(hasRule(r, /sub\/x\.json:1: labels rule: subfolders not allowed/));
  assert.ok(hasRule(r, /f\.json:1: labels rule: invalid JSON/));
  git('reset', '-q');
  lput('.gitkeep', 'janedoe');
  blocked(scan(['pre-commit']), /\.gitkeep:1: labels rule: \.gitkeep must be empty/, 'non-empty .gitkeep');
  git('reset', '-q');
  put('data/labels/.gitkeep', '');
});

test('labels rule: line numbers point at the failing label', () => {
  lput(`${SESSION}.json`, goodDoc([goodRec(), goodRec({ id: 'l-0002', labeller: 'bob' })]));
  const r = scan(['pre-commit']);
  const want = readFileSync(path.join(work, 'data', 'labels', `${SESSION}.json`), 'utf8').split('\n').findIndex((l) => l.includes('"l-0002"')) + 1;
  assert.ok(hasRule(r, new RegExp(`:${want}: labels rule: schema violation at /labels/1/labeller const`)), r.stdout);
  git('reset', '-q');
});

test('labels rule: files outside data/labels/ unaffected', () => {
  staged('other.png', Buffer.from([0x89, 0, 1]));
  staged('other.json', '{"labeller":"janedoe"}');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout);
  git('reset', '-q');
});

test('labels rule: scan-worktree and history modes', () => {
  // staged-but-uncommitted files from earlier tests were reset; they remain untracked in the worktree.
  lput('c.json', goodDoc([goodRec({ labeller: 'janedoe' })]));
  git('reset', '-q');
  const w = scan(['scan-worktree']);
  assert.equal(w.status, 1);
  assert.ok(hasRule(w, /data\/labels\/pic\.png:1: labels rule: file type not allowed/));
  assert.ok(hasRule(w, /data\/labels\/c\.json:\d+: labels rule: schema violation/));
  assert.ok(!hasRule(w, /\.gitkeep:\d+: labels rule/));
  // history: commit the bad PNG + a bad doc, then scan-history sees them per blob.
  git('add', 'data/labels/pic.png', 'data/labels/c.json');
  git('commit', '-q', '-m', 'labels fixture');
  const h = scan(['scan-history']);
  assert.equal(h.status, 1);
  assert.ok(hasRule(h, /data\/labels\/pic\.png@[0-9a-f]{12}:1: labels rule: file type not allowed/));
  assert.ok(hasRule(h, /data\/labels\/c\.json@[0-9a-f]{12}:\d+: labels rule: schema violation/));
  assert.ok(!/janedoe/i.test(h.stdout + h.stderr));
});

// ---- review fixes round 3 (2026-10-28): each in its own fresh repo ----
// fresh({ ctx }): a new temp repo; ctx = 'commit' (validator and data committed), 'none' (absent).
let freshN = 0;
function fresh({ ctx = 'commit' } = {}) {
  const w = path.join(dir, `fresh-${++freshN}`);
  spawnSync('git', ['init', '-q', w], { windowsHide: true });
  const r = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: w, encoding: 'utf8', ...o, windowsHide: true });
  const g = (...a) => { const x = r('git', a); assert.equal(x.status, 0, x.stderr); return x.stdout; };
  g('config', 'user.name', 'Test User'); g('config', 'user.email', 'test@example.invalid');
  g('config', 'core.hooksPath', 'none'); g('config', 'commit.gpgsign', 'false');
  const f = {
    w, g,
    put: (p, content) => { const dst = path.join(w, ...p.split('/')); mkdirSync(path.dirname(dst), { recursive: true }); writeFileSync(dst, content); },
    add: (p, content) => { f.put(p, content); g('add', '-f', p); },
    scan: (a, o) => r('node', [scanner, ...a, '--profile', profile], o),
    blob: (content) => r('git', ['hash-object', '-w', '--stdin'], { input: content }).stdout.trim(),
  };
  if (ctx === 'commit') { copyCtx(w); g('add', ...CTX); g('commit', '-q', '-m', 'validator'); }
  return f;
}
const LABEL = `data/labels/${SESSION}.json`;

test('H2: prototype-named keys are additional properties at every level (hook)', () => {
  const f = fresh();
  for (const k of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    const rec = JSON.stringify(goodRec()).slice(0, -1) + `,"${k}":"jane doe was here"}`;
    for (const [doc, at] of [
      [`{"version":1,"sessionId":"${SESSION}","labels":[${JSON.stringify(goodRec())}],"${k}":"jane doe"}`, /schema violation at \/ additionalProperties/],
      [`{"version":1,"sessionId":"${SESSION}","labels":[${rec}]}`, /schema violation at \/labels\/0 additionalProperties/],
      [`{"version":1,"sessionId":"${SESSION}","labels":[${JSON.stringify(goodRec())}],"events":[{"id":"e-0001","detectorId":"N1","timeSec":3,"verdict":"added","${k}":"x"}]}`, /schema violation at \/events\/0 additionalProperties/],
      [`{"version":1,"sessionId":"${SESSION}","labels":[${JSON.stringify(goodRec())}],"timing":{"highlightPassSec":1,"eventPassSec":1,"${k}":2}}`, /schema violation at \/timing additionalProperties/],
    ]) {
      f.add(LABEL, doc);
      const r = f.scan(['pre-commit']);
      blocked(r, at, `${k}`);
      assert.ok(!/jane/i.test(r.stdout + r.stderr));
    }
  }
});

test('M1: the validator and its data come from the index; missing ones fail closed', () => {
  const f = fresh({ ctx: 'none' });
  f.add(LABEL, goodDoc());
  blocked(f.scan(['pre-commit']), /labels rule: label validator or its data not in the index \(tools\/label\/labels-export\.mjs, .*\); stage it, failing closed/, 'nothing staged');
  // worktree copies alone do not count
  copyCtx(f.w);
  blocked(f.scan(['pre-commit']), /not in the index/, 'only in the worktree');
  // the first commit stages the validator, its data and a label file together: checked against the staged copies
  f.g('add', ...CTX);
  const ok = f.scan(['pre-commit']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  f.g('commit', '-q', '-m', 'first');
  // a pack that is not in the index: a file with events fails closed
  const g2 = fresh({ ctx: 'none' });
  copyCtx(g2.w);
  g2.g('add', ...CTX.filter((p) => !p.startsWith('data/games/')));
  g2.add(LABEL, goodDoc([goodRec()], { events: [{ id: 'e-0001', detectorId: 'N1', timeSec: 3, verdict: 'added' }] }));
  blocked(g2.scan(['pre-commit']), /\/events no-game-pack-for-session/, 'pack not staged');
});

test('M1: an unstaged validator change blocks the commit and cannot loosen the check', () => {
  const f = fresh();
  // a loosened validator in the worktree only (accepts everything)
  const lx = path.join(f.w, 'tools', 'label', 'labels-export.mjs');
  writeFileSync(lx, readFileSync(lx, 'utf8').replace('export function validateLabelFile(doc, ctx) {', 'export function validateLabelFile(doc, ctx) {\n  return [];'));
  f.add(LABEL, goodDoc([goodRec({ note: 'free text' })]));
  const r = f.scan(['pre-commit']);
  blocked(r, /tools\/label\/labels-export\.mjs:1: labels rule: the label validator differs between the index and the worktree/, 'unstaged validator');
  assert.ok(hasRule(r, /schema violation at \/labels\/0 additionalProperties/), 'the index copy still validates: ' + r.stdout);
  // a valid label file is refused too while the validator differs
  f.add(LABEL, goodDoc());
  blocked(f.scan(['pre-commit']), /differs between the index and the worktree/, 'valid file, unstaged validator');
  // an untracked new validator module and an unstaged schema change count as well
  f.g('checkout', '--', 'tools/label/labels-export.mjs');
  f.put('tools/label/extra.mjs', 'export {};\n');
  blocked(f.scan(['pre-commit']), /tools\/label\/extra\.mjs:1: labels rule: the label validator differs/, 'untracked module');
  rmSync(path.join(f.w, 'tools', 'label', 'extra.mjs'));
  f.put('data/labels.schema.json', '{}');
  blocked(f.scan(['pre-commit']), /data\/labels\.schema\.json:1: labels rule: the label validator differs/, 'unstaged schema');
  f.g('checkout', '--', 'data/labels.schema.json');
  const ok = f.scan(['pre-commit']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // a commit that does not touch labels or the validator is not affected by an unstaged validator edit
  f.g('commit', '-q', '-m', 'label');
  writeFileSync(lx, readFileSync(lx, 'utf8') + '\n// edit\n');
  f.add('README.txt', 'hello\n');
  const other = f.scan(['pre-commit']);
  assert.equal(other.status, 0, other.stdout + other.stderr);
});

test('M2: typechange, symlink and gitlink under data/labels/ are hits', () => {
  const f = fresh();
  f.add(LABEL, goodDoc());
  f.g('commit', '-q', '-m', 'label');
  // typechange (T): the same path becomes a symlink in the index (ACMR skipped this)
  const target = f.blob('../../secret.txt');
  f.g('update-index', '--cacheinfo', `120000,${target},${LABEL}`);
  assert.match(f.g('diff', '--cached', '--name-status'), /^T\t/m);
  blocked(f.scan(['pre-commit']), new RegExp(`${LABEL.replace(/[.]/g, '\\.')}:1: labels rule: symlink not allowed`), 'typechange to symlink');
  f.g('reset', '-q');
  // a new symlink and a gitlink
  f.g('update-index', '--add', '--cacheinfo', `120000,${target},data/labels/link.json`);
  const head = f.g('rev-parse', 'HEAD').trim();
  f.g('update-index', '--add', '--cacheinfo', `160000,${head},data/labels/sub`);
  const r = f.scan(['pre-commit']);
  blocked(r, /data\/labels\/link\.json:1: labels rule: symlink not allowed/, 'symlink');
  assert.ok(hasRule(r, /data\/labels\/sub:1: labels rule: gitlink \(submodule\) not allowed/), r.stdout);
  // pushed trees: a committed symlink under data/labels/ blocks the push
  f.g('commit', '-q', '-m', 'links');
  const tip = f.g('rev-parse', 'HEAD').trim();
  const p = f.scan(['pre-push'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(p.status, 1);
  assert.ok(hasRule(p, /data\/labels\/sub@[0-9a-f]{12}:1: labels rule: gitlink/), p.stdout);
});

test('M3: local game data and *.local.* files are blocked in pre-commit, pre-push and scan-worktree; templates allowed', () => {
  const f = fresh();
  for (const p of ['data/games/codm/local/labels-draft/s.json', 'data/games/codm/local/label-notes/s.jsonl', 'data/games/x/local/sugg.json']) {
    f.add(p, '{}\n');
    blocked(f.scan(['pre-commit']), new RegExp(`${p.replace(/[.]/g, '\\.')}:1: local rule: data/games/<game>/local/`), p);
    f.g('reset', '-q');
  }
  for (const p of ['data/profile.local.json', 'settings.local.yaml']) {
    f.add(p, '{}\n');
    blocked(f.scan(['pre-commit']), new RegExp(`${p.replace(/[.]/g, '\\.')}:1: local rule: \\*\\.local\\.\\* files`), p);
    f.g('reset', '-q');
  }
  f.add('data/profile.example.json', '{}\n');
  f.add('data/games/codm/localx/ok.json', '{}\n');
  const ok = f.scan(['pre-commit']);
  assert.equal(ok.status, 0, ok.stdout);
  f.g('commit', '-q', '-m', 'templates');
  // a force-added local file in history blocks the push, even after it was removed again
  f.add('data/games/codm/local/label-notes/s.jsonl', '{"text":"x"}\n');
  f.g('commit', '-q', '-m', 'oops');
  f.g('rm', '-q', 'data/games/codm/local/label-notes/s.jsonl');
  f.g('commit', '-q', '-m', 'undo');
  const tip = f.g('rev-parse', 'HEAD').trim();
  const p = f.scan(['pre-push'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(p.status, 1);
  assert.ok(hasRule(p, /label-notes\/s\.jsonl@[0-9a-f]{12}:1: local rule/), p.stdout);
});

test('M4: an unreadable staged blob under data/labels/ is a hit', () => {
  const f = fresh();
  f.g('update-index', '--add', '--cacheinfo', `100644,${'1'.repeat(40)},${LABEL}`);
  blocked(f.scan(['pre-commit']), new RegExp(`${LABEL.replace(/[.]/g, '\\.')}:1: labels rule: file cannot be read, failing closed`), 'missing blob');
  f.g('reset', '-q');
  // outside data/labels/ an unreadable blob is reported and fails closed too (review E8-01: never skipped silently)
  f.g('update-index', '--add', '--cacheinfo', `100644,${'2'.repeat(40)},other.txt`);
  const r = f.scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /other\.txt:1: skipped: the staged blob cannot be read, failing closed/);
});

// ---- review fixes round 4 (2026-10-28) ----
test('R3: no template allowance: any name with .local. is blocked; data/profile.example.json still passes', () => {
  const f = fresh();
  for (const p of ['settings.example.local.json', 'data/profile.local.example.json', 'x.example.local.json', 'cfg/a.local.b.example.yaml']) {
    f.add(p, '{}\n');
    blocked(f.scan(['pre-commit']), new RegExp(`${p.replace(/[.]/g, '\\.')}:1: local rule: \\*\\.local\\.\\* files`), p);
    f.g('reset', '-q');
  }
  f.add('data/profile.example.json', '{}\n');
  const ok = f.scan(['pre-commit']);
  assert.equal(ok.status, 0, ok.stdout);
});

test('R4: the local rule ignores case (Foo.LOCAL.json, data/games/codm/Local/), in pre-commit and scan-worktree', () => {
  const f = fresh();
  for (const [p, re] of [['Foo.LOCAL.json', /Foo\.LOCAL\.json:1: local rule: \*\.local\.\* files/], ['data/games/codm/Local/x.json', /codm\/Local\/x\.json:1: local rule: data\/games\/<game>\/local\//], ['data/games/codm/LOCAL/y.json', /codm\/LOCAL\/y\.json:1: local rule: data\/games/]]) {
    f.add(p, '{}\n');
    blocked(f.scan(['pre-commit']), re, p);
    blocked(f.scan(['scan-worktree']), re, `${p} (worktree)`);
    f.g('rm', '-q', '--cached', p);
    rmSync(path.join(f.w, ...p.split('/')));
  }
});

test('R5: pre-push checks every path of a blob: a local/ path or a term path with the bytes of another file is a hit', () => {
  const f = fresh();
  const bytes = '{"same":"bytes"}\n';
  f.add('docs/a.json', bytes);
  f.g('commit', '-q', '-m', 'a');
  f.add('data/games/codm/local/crop.json', bytes); // same blob as docs/a.json
  f.add(`docs/${TERM}.json`, bytes); // same blob, a term in the path
  f.g('commit', '-q', '-m', 'dup');
  const tip = f.g('rev-parse', 'HEAD').trim();
  const r = f.scan(['pre-push'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(hasRule(r, /data\/games\/codm\/local\/crop\.json@[0-9a-f]{12}:1: local rule/), r.stdout);
  assert.ok(hasRule(r, /@[0-9a-f]{12} \(path\): term #\d+/), r.stdout);
  assert.ok(!r.stdout.includes(TERM), 'the term is never echoed');
  // scan-history: the same, and a removed duplicate stays a hit
  f.g('rm', '-q', 'data/games/codm/local/crop.json', `docs/${TERM}.json`);
  f.g('commit', '-q', '-m', 'undo');
  const h = f.scan(['scan-history']);
  assert.equal(h.status, 1, h.stdout);
  assert.ok(hasRule(h, /data\/games\/codm\/local\/crop\.json@[0-9a-f]{12}:1: local rule/), h.stdout);
  // a duplicate label blob at a second, misnamed path under data/labels/ is checked at that path too
  const g2 = fresh();
  const good = JSON.stringify({ version: 1, sessionId: SESSION, labels: [goodRec()] }) + '\n';
  g2.add(LABEL, good);
  g2.add('data/labels/s-2026-10-17-0000.json', good); // same bytes, but the sessionId does not match the name
  g2.g('commit', '-q', '-m', 'labels');
  const t2 = g2.g('rev-parse', 'HEAD').trim();
  const r2 = g2.scan(['pre-push'], { input: `refs/heads/main ${t2} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(r2.status, 1, r2.stdout);
  assert.ok(hasRule(r2, /s-2026-10-17-0000\.json@[0-9a-f]{12}:1: labels rule/), r2.stdout);
});

// ---- review E8-01 (2026-10-29), continued: modes that need fresh repos ----
test('E8-01: scan-files, scan-worktree and pre-push history also decode UTF-16 and scan binary blobs', () => {
  const f = fresh({ ctx: 'none' });
  f.add('base.txt', 'base\n');
  f.g('commit', '-q', '-m', 'base');
  f.add('notes-utf16.txt', utf16le('hello foobarxy\n'));
  f.add('blob.bin', Buffer.concat([noise(64, 1), Buffer.from('foobarxy', 'utf16le'), noise(64, 2)]));
  f.g('commit', '-q', '-m', 'add');
  f.g('rm', '-q', 'notes-utf16.txt', 'blob.bin');
  f.g('commit', '-q', '-m', 'remove');
  const tip = f.g('rev-parse', 'HEAD').trim();
  const p = f.scan(['pre-push'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(p.status, 1, p.stdout);
  assert.ok(hasRule(p, /notes-utf16\.txt@[0-9a-f]{12}:1: term #1$/), p.stdout);
  assert.ok(hasRule(p, /blob\.bin@[0-9a-f]{12}:1: term #1 \(binary content, raw bytes\)/), p.stdout);
  f.put('wt-utf16.txt', utf16be('x\nfoobarxy\n'));
  const w = f.scan(['scan-worktree']);
  assert.equal(w.status, 1);
  assert.match(w.stdout, /wt-utf16\.txt: 1 hit\(s\), terms #1/);
  const s = f.scan(['scan-files', path.join(f.w, 'wt-utf16.txt')]);
  assert.equal(s.status, 1);
  assert.match(s.stdout, /file:2: term #1/);
});

test('E8-01: files that cannot be scanned are reported with a reason; an unreadable staged blob fails closed', () => {
  const f = fresh({ ctx: 'none' });
  f.g('update-index', '--add', '--cacheinfo', `100644,${'2'.repeat(40)},other.txt`);
  const r = f.scan(['pre-commit']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /other\.txt:1: skipped: the staged blob cannot be read, failing closed/);
  assert.match(r.stderr, /1 skipped \(each listed above\)/);
  f.g('reset', '-q');
  // a gitlink outside data/labels/ has no blob: reported, not a hit
  f.add('a.txt', 'a\n');
  f.g('commit', '-q', '-m', 'a');
  const head = f.g('rev-parse', 'HEAD').trim();
  f.g('update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`);
  const g = f.scan(['pre-commit']);
  assert.equal(g.status, 0, g.stdout);
  assert.match(g.stdout, /vendor\/sub:1: skipped: gitlink \(submodule\), no blob in this repository$/m);
  f.g('commit', '-q', '-m', 'sub');
  const tip = f.g('rev-parse', 'HEAD').trim();
  const p = f.scan(['pre-push'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /vendor\/sub@[0-9a-f]{12}:1: skipped: gitlink/);
  // a tracked file deleted from the working tree is reported by scan-worktree, not silently passed over
  rmSync(path.join(f.w, 'a.txt'));
  const w = f.scan(['scan-worktree']);
  assert.match(w.stdout, /a\.txt:1: skipped: not in the working tree \(deleted\)/);
});

// ---- review E8-13 (2026-10-29): pre-push never imports the label validator from the commits being pushed ----
test('E8-13: pre-push and scan-history use the checked-out hook tooling validator, not a loosened one in the pushed commit', () => {
  const f = fresh();
  // the pushed commit carries a validator that accepts everything, plus a label file with free text
  const lx = path.join(f.w, 'tools', 'label', 'labels-export.mjs');
  writeFileSync(lx, readFileSync(lx, 'utf8').replace('export function validateLabelFile(doc, ctx) {', 'export function validateLabelFile(doc, ctx) {\n  return [];'));
  f.g('add', 'tools/label/labels-export.mjs');
  f.add(LABEL, goodDoc([goodRec({ note: 'free text' })]));
  f.g('commit', '-q', '-m', 'loosen');
  const tip = f.g('rev-parse', 'HEAD').trim();
  const p = f.scan(['pre-push'], { input: `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`, env: { ...process.env, UJWALAM_PUSH_APPROVED: '1' } });
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.ok(hasRule(p, /schema violation at \/labels\/0 additionalProperties/), p.stdout);
  assert.match(p.stderr, /label validator code from the checked-out hook tooling \(working tree at hook start\): tools\/label\/labels-export\.mjs [0-9a-f]{12}, tools\/label\/schema-lite\.mjs [0-9a-f]{12}, data\/labels\.schema\.json [0-9a-f]{12}; label data from the pushed tip/);
  const h = f.scan(['scan-history']);
  assert.equal(h.status, 1);
  assert.ok(hasRule(h, /schema violation at \/labels\/0 additionalProperties/), h.stdout);
  assert.match(h.stderr, /checked-out hook tooling/);
});
