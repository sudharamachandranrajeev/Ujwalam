// SPDX-License-Identifier: GPL-2.0-or-later
// Encrypted local-data backup (D135): the archive is encrypted (wrong password fails, names hidden), only existing
// sources are taken, a rerun the same day keeps the earlier archive in _to_delete/, and --keep moves, never deletes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveName, backup, findSevenZip, SOURCES } from '../tools/backup-local.mjs';

const exe = findSevenZip();
const skip = exe ? false : '7-Zip not installed';
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-backup-')); dirs.push(d); return d; };

function fakeRoot() {
  const root = tmp();
  mkdirSync(path.join(root, 'data', 'labels'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'profile.local.json'), '{"secret-name":"x"}');
  writeFileSync(path.join(root, 'data', 'labels', 'a.json'), '{}');
  return root;
}
const t7z = (archive, pw) => spawnSync(exe, ['t', '-bd', archive], { input: `${pw}\n`, encoding: 'utf8', windowsHide: true });
const list = (archive, pw) => spawnSync(exe, ['l', '-bd', archive], { input: `${pw}\n`, encoding: 'utf8', windowsHide: true });

test('archive name is dated', () => {
  assert.equal(archiveName(new Date(2026, 10, 3, 2, 0)), 'ujwalam-local-2026-11-03.7z');
});

test('dry run lists only existing sources and never writes', async () => {
  const root = fakeRoot();
  const out = path.join(tmp(), 'b');
  const r = await backup({ root, backupDir: out, password: '', sevenZip: exe ?? 'none', dryRun: true });
  assert.deepEqual(r.sources, ['data/profile.local.json', 'data/labels']);
  assert.ok(SOURCES.includes('feedback'));
  assert.equal(existsSync(out), false);
});

test('encrypted archive: right password passes, wrong fails, names hidden', { skip }, async () => {
  const root = fakeRoot();
  const out = path.join(tmp(), 'b');
  const now = new Date(2026, 10, 3, 2, 0);
  const r = await backup({ root, backupDir: out, password: 'correct horse 1', sevenZip: exe, now });
  assert.equal(r.ok, true, r.reason);
  assert.equal(path.basename(r.archive), 'ujwalam-local-2026-11-03.7z');
  assert.equal(t7z(r.archive, 'correct horse 1').status, 0);
  assert.notEqual(t7z(r.archive, 'wrong').status, 0);
  assert.doesNotMatch(list(r.archive, 'wrong').stdout, /profile\.local\.json/);
  assert.match(list(r.archive, 'correct horse 1').stdout, /profile\.local\.json/);
  assert.deepEqual(readdirSync(out), ['ujwalam-local-2026-11-03.7z']);
});

test('same-day rerun keeps the earlier archive in _to_delete; --keep moves older archives', { skip }, async () => {
  const root = fakeRoot();
  const out = path.join(tmp(), 'b');
  const day = (d) => new Date(2026, 10, d, 2, 0);
  for (const d of [1, 2, 3]) assert.equal((await backup({ root, backupDir: out, password: 'p', sevenZip: exe, now: day(d) })).ok, true);
  assert.equal((await backup({ root, backupDir: out, password: 'p', sevenZip: exe, now: day(3) })).ok, true);
  assert.equal(readdirSync(path.join(out, '_to_delete')).length, 1);
  const r = await backup({ root, backupDir: out, password: 'p', sevenZip: exe, now: day(4), keep: 2 });
  assert.deepEqual(r.moved.sort(), ['ujwalam-local-2026-11-01.7z', 'ujwalam-local-2026-11-02.7z']);
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith('.7z')).sort(), ['ujwalam-local-2026-11-03.7z', 'ujwalam-local-2026-11-04.7z']);
  assert.equal(readdirSync(path.join(out, '_to_delete')).length, 3);
});
