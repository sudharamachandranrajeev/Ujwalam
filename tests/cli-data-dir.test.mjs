// SPDX-License-Identifier: GPL-3.0-or-later
// CLI data dir resolution: --data-dir, then the installed app's data dir, then the profile's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDirNote, installedDataDir, resolveCliDataDir } from '../services/event-core/config.mjs';
import { main as postingMain } from '../services/posting/cli.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-clidd-'));
function installed(root, file = 'flags.local.json') {
  const core = path.join(root, 'core');
  mkdirSync(core, { recursive: true });
  if (file) writeFileSync(path.join(core, file), '{}');
  return core;
}
function profile(dir, dev) {
  const p = path.join(dir, 'profile.json');
  writeFileSync(p, JSON.stringify({ paths: { event_core_data: dev } }));
  return p;
}

test('installedDataDir: UJWALAM_DATA_ROOT or LOCALAPPDATA, only when its files exist', () => {
  const t = tmp();
  try {
    assert.equal(installedDataDir({ UJWALAM_DATA_ROOT: path.join(t, 'none') }), null);
    assert.equal(installedDataDir({}), null);
    const core = installed(path.join(t, 'root'));
    assert.equal(installedDataDir({ UJWALAM_DATA_ROOT: path.join(t, 'root') }), core);
    const core2 = installed(path.join(t, 'la', 'Ujwalam', 'data'), 'event-core.db');
    assert.equal(installedDataDir({ LOCALAPPDATA: path.join(t, 'la') }), core2);
    installed(path.join(t, 'empty'), null);
    assert.equal(installedDataDir({ UJWALAM_DATA_ROOT: path.join(t, 'empty') }), null);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('resolveCliDataDir: option > installed > profile', () => {
  const t = tmp();
  try {
    const dev = path.join(t, 'dev');
    const prof = profile(t, dev);
    const root = path.join(t, 'root');
    const core = installed(root);
    const env = { UJWALAM_DATA_ROOT: root };
    assert.deepEqual(resolveCliDataDir({ dataDir: path.join(t, 'x'), env, profilePath: prof }), { dir: path.join(t, 'x'), source: 'option' });
    assert.deepEqual(resolveCliDataDir({ env, profilePath: prof }), { dir: core, source: 'installed' });
    const none = { UJWALAM_DATA_ROOT: path.join(t, 'nothing') };
    assert.deepEqual(resolveCliDataDir({ env: none, profilePath: prof }), { dir: path.resolve(dev), source: 'profile' });
    assert.throws(() => resolveCliDataDir({ env: none, profilePath: path.join(t, 'missing.json') }), /needs a data dir/);
    assert.match(dataDirNote({ dir: core, source: 'installed' }), /installed app.*core/);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('posting cli: flag on in the installed data dir is seen; prints the data dir; --data-dir still wins', async () => {
  const t = tmp();
  const saved = process.env.UJWALAM_DATA_ROOT;
  try {
    const root = path.join(t, 'root');
    const core = installed(root);
    writeFileSync(path.join(core, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
    process.env.UJWALAM_DATA_ROOT = root;
    const run = async (argv) => { const o = []; const e = []; const code = await postingMain(argv, (s) => o.push(s), (s) => e.push(s)); return { code, o, e }; };
    const a = await run(['package', '--run', path.join(t, 'norun')]);
    assert.ok(a.o.some((l) => l.includes(core) && l.includes('installed app')), a.o.join('\n'));
    assert.ok(!a.e.some((l) => /flag is off/.test(l)), a.e.join('\n'));
    const other = path.join(t, 'other');
    mkdirSync(other);
    const b = await run(['package', '--run', path.join(t, 'norun'), '--data-dir', other]);
    assert.ok(!b.o.some((l) => l.includes('data dir (')), 'explicit --data-dir is not echoed');
    assert.ok(b.e.some((l) => /flag is off/.test(l)), b.e.join('\n'));
  } finally {
    if (saved === undefined) delete process.env.UJWALAM_DATA_ROOT; else process.env.UJWALAM_DATA_ROOT = saved;
    rmSync(t, { recursive: true, force: true });
  }
});
