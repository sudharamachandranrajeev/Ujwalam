// SPDX-License-Identifier: GPL-3.0-or-later
// Studio crash capture (2026-11-08, docs/evidence/2026-11-08-studio-crash.md): with UJWALAM_STUDIO_LOG_DIR the studio
// writes its own log (studio-*.log) and, on a crash, a text report (studio-crash-*.txt: exception code, module+offset,
// stack with symbols when the PDB is beside the exe). The crash is made on purpose by the tests-only path
// UJWALAM_STUDIO_TEST_CRASH, which works only headless (UJWALAM_HEADLESS=1: no window ever appears).
// Skipped when the shell is not built (npm run build:studio) or no Qt kit is configured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = process.platform !== 'win32' || !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('studio crash capture', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-scrash-')); dirs.push(d); return d; };

  test('an access violation writes studio-crash-*.txt with code, module+offset and a symbolised stack; the process still ends with the crash code', async () => {
    const dir = tmp();
    const r = await run({ UJWALAM_STUDIO_LOG_DIR: dir, UJWALAM_STUDIO_TEST_CRASH: 'av', UJWALAM_STUDIO_VERSION: '0.0.0-test' });
    assert.equal(r.code >>> 0, 0xc0000005, `exit ${r.code} ${r.err}`);
    const reports = readdirSync(dir).filter((n) => /^studio-crash-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-p\d+\.txt$/.test(n));
    assert.equal(reports.length, 1, readdirSync(dir).join(', '));
    const txt = readFileSync(path.join(dir, reports[0]), 'utf8');
    assert.match(txt, /^ujwalam-studio crash report \(text only/m);
    assert.match(txt, /^version: 0\.0\.0-test$/m);
    assert.match(txt, /^code: 0xc0000005 \(access violation\)$/m);
    assert.match(txt, /^address: ujwalam-studio\.exe\+0x[0-9a-f]+$/m, 'the faulting address as module+offset');
    assert.match(txt, /^studio log: studio-.+\.log$/m);
    assert.match(txt, /^stack \(faulting thread, module\+offset, \d+ frames\):$/m);
    assert.match(txt, /test_av.*\(crash\.cpp:\d+\)/, 'the PDB beside the exe names the function and line');
    assert.match(txt, /^end of report$/m);
    assert.doesNotMatch(txt, /UJWALAM_UI_LAUNCH_KEY|rax=|rip=/i, 'no secrets, no registers');
    assert.match(r.err, /ujwalam-studio: CRASH \(unhandled exception 0xc0000005 access violation\) on thread \d+; report: logs\/studio-crash-/);
    const logs = readdirSync(dir).filter((n) => /^studio-.+-p\d+\.log$/.test(n) && !n.startsWith('studio-crash-'));
    assert.equal(logs.length, 1);
    assert.match(readFileSync(path.join(dir, logs[0]), 'utf8'), /info: studio 0\.0\.0-test started \(pid \d+\); crash reporter on/);
  });

  test('abort() is reported too', async () => {
    const dir = tmp();
    const r = await run({ UJWALAM_STUDIO_LOG_DIR: dir, UJWALAM_STUDIO_TEST_CRASH: 'abort' });
    assert.notEqual(r.code, 0);
    const reports = readdirSync(dir).filter((n) => n.startsWith('studio-crash-'));
    assert.equal(reports.length, 1);
    assert.match(readFileSync(path.join(dir, reports[0]), 'utf8'), /^kind: abort\(\)/m);
  });

  test('the crash path needs the log folder and a known kind; without the folder nothing is written', async () => {
    const none = await run({ UJWALAM_STUDIO_TEST_CRASH: 'av' });
    assert.equal(none.code, 65);
    const dir = tmp();
    const bad = await run({ UJWALAM_STUDIO_LOG_DIR: dir, UJWALAM_STUDIO_TEST_CRASH: 'nope' });
    assert.equal(bad.code, 65);
    assert.equal(readdirSync(dir).filter((n) => n.startsWith('studio-crash-')).length, 0);
  });

  test('the log keeps the newest 10 studio-*.log files', async () => {
    const dir = tmp();
    for (let i = 0; i < 12; i++) await run({ UJWALAM_STUDIO_LOG_DIR: dir }); // no URL: exits 64 after the log line
    const logs = readdirSync(dir).filter((n) => /^studio-.+\.log$/.test(n));
    assert.equal(logs.length, 10, logs.join(', '));
  });
});
