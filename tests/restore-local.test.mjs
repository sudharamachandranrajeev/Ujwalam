// SPDX-License-Identifier: GPL-3.0-or-later
// Restore of the local-data backup (tools/restore-local.mjs): fake 7-Zip runner and temp dirs only; no real 7-Zip or
// credential. Covers list ordering, verify, extract into a fresh staging dir, and apply (confirm gate, replaced files
// move to _to_delete, nothing deleted, unsafe paths refused), plus the CLI wiring and that the password never leaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIRM, applyStaged, extract, listArchives, main, newestStaging, resolveArchive, stagedFiles, verify } from '../tools/restore-local.mjs';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-restore-')); dirs.push(d); return d; };
const put = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

/** Fake runner: records calls; on `x` writes the given files into the -o dir. */
function fakeRunner({ code = 0, files = {} } = {}) {
  const calls = [];
  const runner = async (exe, args, password, lines, cwd) => {
    calls.push({ exe, args, password, lines, cwd });
    if (args[0] === 'x' && code === 0) {
      const o = args.find((a) => a.startsWith('-o')).slice(2);
      for (const [rel, text] of Object.entries(files)) put(o, rel, text);
    }
    return { code, out: '' };
  };
  return { runner, calls };
}

test('list: only backup archives, newest first', () => {
  const b = tmp();
  for (const n of ['ujwalam-local-2026-11-01.7z', 'ujwalam-local-2026-11-03.7z', 'ujwalam-local-2026-11-02.7z', 'other.7z', 'ujwalam-local-2026-11-04.7z.partial']) put(b, n, 'x');
  assert.deepEqual(listArchives(b).map((a) => a.name), ['ujwalam-local-2026-11-03.7z', 'ujwalam-local-2026-11-02.7z', 'ujwalam-local-2026-11-01.7z']);
  assert.deepEqual(listArchives(path.join(b, 'missing')), []);
  assert.equal(resolveArchive('ujwalam-local-2026-11-01.7z', b), path.join(b, 'ujwalam-local-2026-11-01.7z'));
  assert.equal(resolveArchive('nope.7z', b), null);
});

test('verify: runs 7z t with the password on stdin lines, never in argv', async () => {
  const b = tmp();
  put(b, 'a.7z', 'x');
  const ok = fakeRunner();
  assert.deepEqual(await verify({ archive: path.join(b, 'a.7z'), password: 'pw-secret', sevenZip: '7z', runner: ok.runner }), { ok: true });
  assert.equal(ok.calls[0].args[0], 't');
  assert.equal(ok.calls[0].password, 'pw-secret');
  assert.ok(!ok.calls[0].args.join(' ').includes('pw-secret'));
  const bad = await verify({ archive: path.join(b, 'a.7z'), password: 'pw-secret', sevenZip: '7z', runner: fakeRunner({ code: 2 }).runner });
  assert.equal(bad.ok, false);
  assert.ok(!bad.reason.includes('pw-secret'));
});

test('extract: fresh staging dir, live files untouched, non-empty staging refused', async () => {
  const base = tmp();
  const to = path.join(base, 'stage');
  const live = path.join(base, 'live');
  put(live, 'data/profile.local.json', 'LIVE');
  const f = fakeRunner({ files: { 'data/profile.local.json': 'BACKUP', 'feedback/a.json': '{}' } });
  const r = await extract({ archive: 'a.7z', password: 'pw', sevenZip: '7z', to, runner: f.runner });
  assert.equal(r.ok, true);
  assert.equal(r.files, 2);
  assert.ok(f.calls[0].args.includes(`-o${to}`));
  assert.equal(readFileSync(path.join(live, 'data', 'profile.local.json'), 'utf8'), 'LIVE');
  const again = await extract({ archive: 'a.7z', password: 'pw', sevenZip: '7z', to, runner: f.runner });
  assert.equal(again.ok, false);
  assert.match(again.reason, /not empty/);
  const failed = await extract({ archive: 'a.7z', password: 'pw', sevenZip: '7z', to: path.join(base, 's2'), runner: fakeRunner({ code: 2 }).runner });
  assert.equal(failed.ok, false);
});

test('apply: refused without the exact confirmation, nothing changes', () => {
  const base = tmp();
  put(path.join(base, 'stage'), 'data/x.json', 'NEW');
  put(path.join(base, 'root'), 'data/x.json', 'OLD');
  for (const c of [undefined, '', 'yes', 'Yes, restore', 'yes, restore ']) {
    const r = applyStaged({ staging: path.join(base, 'stage'), root: path.join(base, 'root'), confirm: c });
    assert.equal(r.ok, false);
  }
  assert.equal(readFileSync(path.join(base, 'root', 'data', 'x.json'), 'utf8'), 'OLD');
  assert.ok(!existsSync(path.join(base, 'root', '_to_delete')));
});

test('apply: replaced files move to _to_delete/<timestamp>/, new files copied, nothing deleted', () => {
  const base = tmp();
  const staging = path.join(base, 'stage');
  const root = path.join(base, 'root');
  put(staging, 'data/x.json', 'NEW');
  put(staging, 'feedback/n/y.json', 'Y');
  put(root, 'data/x.json', 'OLD');
  put(root, 'data/keep.json', 'KEEP');
  const r = applyStaged({ staging, root, confirm: CONFIRM, now: new Date('2026-11-05T10:00:00Z') });
  assert.deepEqual({ ok: r.ok, copied: r.copied, replaced: r.replaced }, { ok: true, copied: 2, replaced: 1 });
  assert.equal(readFileSync(path.join(root, 'data', 'x.json'), 'utf8'), 'NEW');
  assert.equal(readFileSync(path.join(root, 'feedback', 'n', 'y.json'), 'utf8'), 'Y');
  assert.equal(readFileSync(path.join(root, 'data', 'keep.json'), 'utf8'), 'KEEP');
  assert.equal(readFileSync(path.join(r.trash, 'data', 'x.json'), 'utf8'), 'OLD');
  assert.match(path.basename(r.trash), /^2026-11-05T10-00-00-000Z$/);
  assert.deepEqual(stagedFiles(staging), ['data/x.json', 'feedback/n/y.json'], 'staging is left as is');
});

test('apply: no replaced file means no trash dir; empty or missing staging fails', () => {
  const base = tmp();
  put(path.join(base, 'stage'), 'a.txt', '1');
  const r = applyStaged({ staging: path.join(base, 'stage'), root: path.join(base, 'root'), confirm: CONFIRM });
  assert.equal(r.ok, true);
  assert.equal(r.trash, null);
  mkdirSync(path.join(base, 'empty'));
  assert.equal(applyStaged({ staging: path.join(base, 'empty'), root: base, confirm: CONFIRM }).ok, false);
  assert.equal(applyStaged({ staging: path.join(base, 'nope'), root: base, confirm: CONFIRM }).ok, false);
});

test('newestStaging picks the latest timestamp folder', () => {
  const b = tmp();
  mkdirSync(path.join(b, '2026-11-01T00-00-00-000Z'));
  mkdirSync(path.join(b, '2026-11-03T00-00-00-000Z'));
  assert.equal(path.basename(newestStaging(b)), '2026-11-03T00-00-00-000Z');
  assert.equal(newestStaging(path.join(b, 'none')), null);
});

test('CLI: list, verify, restore then apply; the password never appears in output', async () => {
  const base = tmp();
  const backupDir = path.join(base, 'backups');
  put(backupDir, 'ujwalam-local-2026-11-03.7z', 'x');
  const root = path.join(base, 'root');
  mkdirSync(root);
  const lines = [];
  const errs = [];
  const f = fakeRunner({ files: { 'data/profile.local.json': 'RESTORED' } });
  const deps = { root, profile: { paths: { backup_dir: backupDir } }, sevenZip: '7z', getPassword: async () => 'pw-secret', runner: f.runner, log: (s) => lines.push(s), err: (s) => errs.push(s) };
  assert.equal(await main(['list'], deps), 0);
  assert.match(lines[0], /^ujwalam-local-2026-11-03\.7z {2}\d/);
  assert.equal(await main(['verify', 'ujwalam-local-2026-11-03.7z'], deps), 0);
  const stage = path.join(base, 'stage');
  assert.equal(await main(['restore', 'ujwalam-local-2026-11-03.7z', '--to', stage], deps), 0);
  assert.equal(await main(['apply', '--from', stage, '--to', root], deps), 64, 'no --confirm');
  assert.ok(!existsSync(path.join(root, 'data')));
  assert.equal(await main(['apply', '--from', stage, '--to', root, '--confirm', CONFIRM], deps), 0);
  assert.equal(readFileSync(path.join(root, 'data', 'profile.local.json'), 'utf8'), 'RESTORED');
  assert.equal(await main(['verify', 'missing.7z'], deps), 1);
  assert.equal(await main(['bogus'], deps), 64);
  assert.equal(await main(['restore'], deps), 64);
  assert.equal(await main(['verify', 'x', '--bad', 'y'], deps), 64);
  assert.equal(await main(['list'], { ...deps, profile: {} }), 2);
  assert.equal(await main(['verify', 'ujwalam-local-2026-11-03.7z'], { ...deps, getPassword: async () => null }), 2);
  assert.ok(![...lines, ...errs].join('\n').includes('pw-secret'));
  assert.equal(readdirSync(backupDir).length, 1, 'backup dir untouched');
});
