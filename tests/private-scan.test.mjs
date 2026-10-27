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

// ---- labels rule (data/labels/: timestamps + placeholder names only) ----
import { mkdirSync, readFileSync } from 'node:fs';
const goodRec = (o = {}) => ({
  id: 'l-0001', windowStartSec: 1, windowEndSec: 2, label: 'keep', reasonTags: ['x'],
  labeller: '<user>', createdAt: '2026-10-27T12:00:00Z', ...o,
});
const goodDoc = (labels = [goodRec()]) => JSON.stringify({ version: 1, sessionId: 's-1', labels }, null, 2);
const lput = (name, content) => {
  mkdirSync(path.join(work, 'data', 'labels'), { recursive: true });
  staged('data/labels/' + name, content);
};
const hasRule = (r, re) => r.stdout.split('\n').some((l) => re.test(l));

test('labels rule: allowed json, jsonl, .gitkeep pass', () => {
  lput('.gitkeep', '');
  lput('a.json', goodDoc());
  lput('b.jsonl', JSON.stringify(goodRec()) + '\n\n' + JSON.stringify(goodRec({ id: 'l-0002' })) + '\n');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  git('reset', '-q');
});

test('labels rule: PNG and other non-JSON files blocked', () => {
  lput('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  lput('notes.txt', 'plain');
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.ok(hasRule(r, /pic\.png:1: labels rule: file type not allowed/));
  assert.ok(hasRule(r, /notes\.txt:1: labels rule: file type not allowed/));
  git('reset', '-q');
});

test('labels rule: real-looking labeller / note blocked, value not echoed', () => {
  lput('c.json', goodDoc([goodRec(), goodRec({ id: 'l-0002', labeller: 'janedoe' })]));
  lput('d.json', goodDoc([goodRec({ note: 'saw zorkwick play' })]));
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.ok(hasRule(r, /c\.json:\d+: labels rule: schema violation at \/labels\/1\/labeller pattern/));
  assert.ok(hasRule(r, /d\.json:\d+: labels rule: schema violation at \/labels\/0\/note pattern/));
  assert.ok(!/janedoe|zorkwick/i.test(r.stdout + r.stderr));
  git('reset', '-q');
});

test('labels rule: schema-invalid and unparsable json blocked', () => {
  lput('e.json', goodDoc([goodRec({ label: 'maybe' })]));
  lput('f.json', '{ not json');
  lput('g.json', JSON.stringify({ version: 1, sessionId: 's-1', labels: [goodRec({ extra: 1 })] }));
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.ok(hasRule(r, /e\.json:\d+: labels rule: schema violation/));
  assert.ok(hasRule(r, /f\.json:1: labels rule: invalid JSON/));
  assert.ok(hasRule(r, /g\.json:\d+: labels rule: schema violation/));
  git('reset', '-q');
});

test('labels rule: jsonl reports line numbers', () => {
  lput('h.jsonl', [JSON.stringify(goodRec()), '{bad', JSON.stringify(goodRec({ labeller: 'bob' })), ''].join('\n'));
  const r = scan(['pre-commit']);
  assert.equal(r.status, 1);
  assert.ok(hasRule(r, /h\.jsonl:2: labels rule: invalid JSON/));
  assert.ok(hasRule(r, /h\.jsonl:3: labels rule: schema violation at \/labeller pattern/));
  assert.ok(!hasRule(r, /h\.jsonl:1:/));
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
  const w = scan(['scan-worktree']);
  assert.equal(w.status, 1);
  assert.ok(hasRule(w, /data\/labels\/pic\.png:1: labels rule: file type not allowed/));
  assert.ok(hasRule(w, /h\.jsonl:3: labels rule: schema violation/));
  assert.ok(!hasRule(w, /a\.json:\d+: labels rule/));
  assert.ok(!hasRule(w, /\.gitkeep:\d+: labels rule/));
  // history: commit only the bad PNG + a bad doc, then scan-history sees them per blob.
  git('add', 'data/labels/pic.png', 'data/labels/c.json');
  git('commit', '-q', '-m', 'labels fixture');
  const h = scan(['scan-history']);
  assert.equal(h.status, 1);
  assert.ok(hasRule(h, /data\/labels\/pic\.png@[0-9a-f]{12}:1: labels rule: file type not allowed/));
  assert.ok(hasRule(h, /data\/labels\/c\.json@[0-9a-f]{12}:\d+: labels rule: schema violation/));
  assert.ok(!/janedoe/i.test(h.stdout + h.stderr));
});
