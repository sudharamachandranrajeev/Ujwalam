// SPDX-License-Identifier: GPL-3.0-or-later
// Host crash reporter (app/host/src/crash.h): --test-hooks --test-crash <kind> makes the host crash on purpose right
// after the reporter is installed and BEFORE libobs starts, so these tests use no GPU, no NVENC and no outputs.
// Checks: one text report per crash in <data>/logs/crash-*.txt with code, module+offset address, thread, stack,
// symbols, version, time and log name; the exit code is the one the process has without a reporter; no token or
// token-shaped hex and no folder path in the report; the 10-file limit writes nothing new and deletes nothing.
//   node --test app/host/tests/host-crash-report.test.mjs   (needs the built host; the OBS runtime only for PDBs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig, REPO_ROOT } from '../lib/config.mjs';

const cfg = resolveConfig();
const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const AV = 0xC0000005;
const STACK_OVERFLOW = 0xC00000FD;
const FAIL_FAST = 0xC0000409; // what abort(), purecall, invalid parameter and an uncaught C++ exception end with (CRT default)

function runHost(dataDir, args, token) {
  const r = spawnSync(cfg.exe, ['--runtime', cfg.runtime ?? path.join(OUT, 'no-runtime'), '--data-dir', dataDir, ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, UJWALAM_HEADLESS: '1', ...(token ? { UJWALAM_HOST_TOKEN: token } : {}) },
  });
  return { code: r.status === null ? null : r.status >>> 0, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

const crashFiles = (dataDir) => readdirSync(path.join(dataDir, 'logs')).filter((n) => /^crash-.*\.txt$/.test(n)).sort();

function tmp(name) {
  mkdirSync(OUT, { recursive: true });
  return mkdtempSync(path.join(OUT, `crash-${name}-`));
}

const CASES = [
  { kind: 'av', code: AV, reportKind: 'unhandled exception', codeLine: /^code: 0xc0000005 \(access violation\)$/m, thread: 'not the main thread', top: /test_av/ },
  { kind: 'stack-overflow', code: STACK_OVERFLOW, reportKind: 'unhandled exception', codeLine: /^code: 0xc00000fd \(stack overflow\)$/m, thread: 'main thread', top: /test_recurse/ },
  { kind: 'abort', code: FAIL_FAST, reportKind: 'abort() (SIGABRT)', thread: 'main thread', top: /ucrtbase!abort/ },
  { kind: 'cxx', code: FAIL_FAST, reportKind: 'unhandled exception', codeLine: /^code: 0xe06d7363 \(uncaught C\+\+ exception\)$/m, thread: 'main thread', top: /test_trigger/ },
  { kind: 'purecall', code: FAIL_FAST, reportKind: 'pure virtual function call', thread: 'main thread', top: /on_purecall/ },
  { kind: 'invalid-parameter', code: FAIL_FAST, reportKind: 'CRT invalid parameter', thread: 'main thread', top: /on_invalid_parameter/ },
];

for (const c of CASES) {
  test(`crash report: ${c.kind} -> one text report, exit code 0x${c.code.toString(16)}, no secret or path in it`, () => {
    const dataDir = tmp(c.kind);
    const token = randomBytes(32).toString('hex');
    try {
      const r = runHost(dataDir, ['--test-hooks', '--test-crash', c.kind], token);
      assert.equal(r.code, c.code, `exit code ${r.code?.toString(16)}\n${r.stderr}`);
      const files = crashFiles(dataDir);
      assert.equal(files.length, 1, files.join(', '));
      assert.match(files[0], /^crash-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-p\d+\.txt$/);
      assert.match(r.stderr, new RegExp(`ujwalam-host: CRASH \\(.*\\) on thread \\d+; report: logs/${files[0].replace(/\./g, '\\.')}`));
      const text = readFileSync(path.join(dataDir, 'logs', files[0]), 'utf8');
      assert.match(text, /^ujwalam-host crash report \(text only: no memory dump, no register values, no memory contents\)$/m);
      assert.match(text, /^version: \d+\.\d+\.\d+/m);
      assert.match(text, /^time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/m);
      assert.match(text, /^pid: \d+$/m);
      assert.match(text, new RegExp(`^thread: \\d+ \\(${c.thread}\\)$`, 'm'));
      assert.ok(text.includes(`\nkind: ${c.reportKind}\n`), text);
      if (c.codeLine) {
        assert.match(text, c.codeLine);
        // A C++ throw faults in KERNELBASE!RaiseException; the others in the host exe.
        assert.match(text, c.kind === 'cxx' ? /^address: KERNELBASE\.dll\+0x[0-9a-f]+$/mi : /^address: ujwalam-host\.exe\+0x[0-9a-f]+$/m, 'faulting address as module+offset');
      }
      if (c.kind === 'av') assert.match(text, /^access: write at 0x0 \(null page\)$/m);
      assert.match(text, /^host log: host-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.log$/m);
      assert.match(text, /^stack \(faulting thread, module\+offset, \d+ frames\):\n {2}#00 \S+\.(exe|dll)\+0x[0-9a-f]+$/mi);
      assert.match(text, /^stack \(symbols from PDBs; source file names only\):$/m);
      assert.match(text, c.top, 'the trigger function is on the symbolised stack (host PDB)');
      assert.match(text, /\nend of report\n$/);
      // Privacy: nothing from memory. No token, no hex run of 32+, no folder path, no register dump.
      assert.ok(!text.includes(token), 'token');
      assert.ok(!/[0-9a-f]{32,}/i.test(text), 'no token-shaped hex');
      assert.ok(!text.includes(dataDir) && !/[A-Za-z]:[\\/]/.test(text), 'no folder paths');
      assert.ok(!/\b(rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp|r8|rip)\b/i.test(text), 'no registers');
      for (const line of text.split('\n').filter((l) => /^ {2}#\d\d /.test(l))) {
        assert.match(line, /^ {2}#\d\d (\S+\+0x[0-9a-f]+|<withheld>.*|\S+!.+|0x[0-9a-f]{1,4} \(null page\))$/, line);
      }
      const log = readdirSync(path.join(dataDir, 'logs')).find((n) => n.startsWith('host-'));
      assert.match(readFileSync(path.join(dataDir, 'logs', log), 'utf8'), /crash reporter: on \(text report to logs\/crash-\*\.txt, no dump; symbols on; 0 earlier reports\)/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

test('crash report: with 10 reports present, no new file is written and none is deleted; exit code unchanged', () => {
  const dataDir = tmp('cap');
  try {
    mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    const old = [];
    for (let i = 0; i < 10; i++) {
      const n = `crash-2026-01-01T00-00-0${i}-000Z-p${i}.txt`;
      writeFileSync(path.join(dataDir, 'logs', n), `old report ${i}\n`);
      old.push(n);
    }
    const r = runHost(dataDir, ['--test-hooks', '--test-crash', 'av']);
    assert.equal(r.code, AV);
    assert.deepEqual(crashFiles(dataDir), old.sort());
    for (let i = 0; i < 10; i++) assert.equal(readFileSync(path.join(dataDir, 'logs', old[i]), 'utf8'), `old report ${i}\n`);
    assert.match(r.stderr, /CRASH \(unhandled exception 0xc0000005 access violation\) on thread \d+; report not written: 10 crash-\*\.txt files/);
    const log = readdirSync(path.join(dataDir, 'logs')).find((n) => n.startsWith('host-'));
    assert.match(readFileSync(path.join(dataDir, 'logs', log), 'utf8'), /NO report file will be written: 10 crash-\*\.txt files/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('crash report: --test-crash needs --test-hooks; an unknown kind is refused (exit 64, no report)', () => {
  const dataDir = tmp('refuse');
  try {
    const a = runHost(dataDir, ['--test-crash', 'av']);
    assert.equal(a.code, 64);
    assert.match(a.stderr, /--test-crash needs --test-hooks/);
    const b = runHost(dataDir, ['--test-hooks', '--test-crash', 'nope']);
    assert.equal(b.code, 64);
    assert.deepEqual(crashFiles(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});
