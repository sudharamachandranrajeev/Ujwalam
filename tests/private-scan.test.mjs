// SPDX-License-Identifier: GPL-2.0-or-later
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

const run = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: work, encoding: 'utf8', ...o });
const git = (...a) => {
  const r = run('git', a);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const scan = (a, o = {}) => run('node', [scanner, ...a, '--profile', profile], o);
const put = (name, content) => writeFileSync(path.join(work, name), content);

test.before(() => {
  spawnSync('git', ['init', '-q', work]);
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
  assert.ok(lines.some((l) => /v\.txt:6: term #2/.test(l)));
  assert.ok(lines.some((l) => /v\.txt:4: term #1/.test(l)));
  noEcho(r);
  git('reset', '-q');
});

test('3-char gaps do not match, short terms and placeholders skipped', () => {
  staged('s.txt', 'foo---bar---xy\na-b a b <placeholder-x> placeholderx versionversion9\n');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout);
  git('reset', '-q');
});

test('binary files skipped', () => {
  writeFileSync(path.join(work, 'b.bin'), Buffer.concat([Buffer.from('foobarxy'), Buffer.from([0, 1, 2])]));
  git('add', 'b.bin');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout);
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
  spawnSync('git', ['init', '-q', w]);
  const r = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: w, encoding: 'utf8', ...o });
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
  // outside data/labels/ an unreadable blob is skipped as before
  f.g('update-index', '--add', '--cacheinfo', `100644,${'2'.repeat(40)},other.txt`);
  assert.equal(f.scan(['pre-commit']).status, 0);
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
