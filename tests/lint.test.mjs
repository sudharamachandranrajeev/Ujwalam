// SPDX-License-Identifier: GPL-3.0-or-later
// tools/lint.mjs: one positive and one negative case per rule, temp dirs only, no network.
// Secret-like and user-path samples are written out plainly. Each sample line carries a marker naming its rule
// (allowed in test files; the lint report lists every marker in use). The one exception is the bare, unknown
// and unsupported marker samples, which live in tests/fixtures/lint/markers.txt (a plain one would be a finding
// in this very file). That one file is on the linter's explicit exclusion list, printed on every lint run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint, lintReport, listFiles, attributesFor, formatFinding, forbiddenUserNames, LINT_EXCLUSIONS } from '../tools/lint.mjs';

const ATTRS = '* text=auto eol=lf\n*.ps1 text eol=crlf\n*.cmd text eol=crlf\n*.png binary\n';
const HDR_JS = '// SPDX-License-Identifier: GPL-3.0-or-later\n';

const dirs = [];
function tmp() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lint-'));
  dirs.push(d);
  writeFileSync(path.join(d, '.gitattributes'), ATTRS);
  return d;
}
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Write files {rel: string|Buffer}, lint only `rule`, return findings.
async function run(files, rule) {
  const root = tmp();
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return lint(root, { files: Object.keys(files), rules: rule ? [rule] : undefined });
}

test('syntax-js: bad file flagged with line, good file clean', async () => {
  const bad = await run({ 'a.mjs': `${HDR_JS}const x = 1;\nconst = ;\n` }, 'syntax-js');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].rule, 'syntax-js');
  assert.equal(bad[0].line, 3);
  assert.deepEqual(await run({ 'a.mjs': `${HDR_JS}export const x = 1;\n` }, 'syntax-js'), []);
});

test('syntax-py: bad file flagged with line, good file clean', async () => {
  const bad = await run({ 'a.py': '# SPDX-License-Identifier: GPL-3.0-or-later\nx = 1\ndef f(:\n    pass\n' }, 'syntax-py');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].rule, 'syntax-py');
  assert.equal(bad[0].line, 3);
  assert.deepEqual(await run({ 'a.py': '# SPDX-License-Identifier: GPL-3.0-or-later\nx = 1\n' }, 'syntax-py'), []);
});

test('eol: CRLF in an LF file is flagged', async () => {
  const f = await run({ 'a.mjs': `${HDR_JS}const a = 1;\r\nconst b = 2;\r\n` }, 'eol');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'eol');
  assert.equal(f[0].line, 2);
  assert.deepEqual(await run({ 'a.mjs': `${HDR_JS}const a = 1;\n` }, 'eol'), []);
});

test('eol: .ps1 and .cmd need CRLF, LF is flagged', async () => {
  const bad = await run({ 'x.ps1': '# SPDX-License-Identifier: GPL-3.0-or-later\nWrite-Host 1\n', 'y.cmd': '@echo off\n' }, 'eol');
  assert.deepEqual(bad.map((f) => f.path).sort(), ['x.ps1', 'y.cmd']);
  const ok = await run({ 'x.ps1': '# SPDX-License-Identifier: GPL-3.0-or-later\r\nWrite-Host 1\r\n', 'y.cmd': '@echo off\r\n' }, 'eol');
  assert.deepEqual(ok, []);
});

test('eol: binary files (.gitattributes) and NUL-byte files are skipped; no eol attribute accepts either, rejects mixed', async () => {
  assert.deepEqual(await run({ 'a.png': Buffer.from('a\r\nb\r\n'), 'b.dat': Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x0a]) }, 'eol'), []);
  const root = mkdtempSync(path.join(os.tmpdir(), 'lint-'));
  dirs.push(root); // no .gitattributes at all
  writeFileSync(path.join(root, 'crlf.txt'), 'a\r\nb\r\n');
  writeFileSync(path.join(root, 'mixed.txt'), 'a\r\nb\n');
  const f = await lint(root, { files: ['crlf.txt', 'mixed.txt'], rules: ['eol'] });
  assert.deepEqual(f.map((x) => x.path), ['mixed.txt']);
});

test('attributesFor reads binary and eol from .gitattributes rules', () => {
  const rules = [{ pattern: '*', attrs: ['text=auto', 'eol=lf'] }, { pattern: '*.ps1', attrs: ['text', 'eol=crlf'] }, { pattern: '*.png', attrs: ['binary'] }];
  assert.deepEqual(attributesFor(rules, 'a/b.ps1'), { binary: false, eol: 'crlf' });
  assert.deepEqual(attributesFor(rules, 'a/b.PNG'), { binary: true, eol: 'lf' });
});

test('trailing-ws: spaces and tabs flagged in code and Markdown, clean files pass', async () => {
  const f = await run({ 'a.mjs': `${HDR_JS}const a = 1; \nconst b = 2;\t\n`, 'n.md': '# t\ntext  \n' }, 'trailing-ws');
  assert.deepEqual(f.map(formatFinding), [
    'a.mjs:2: trailing-ws: trailing whitespace',
    'a.mjs:3: trailing-ws: trailing whitespace',
    'n.md:2: trailing-ws: trailing whitespace',
  ]);
  assert.deepEqual(await run({ 'a.mjs': `${HDR_JS}const a = 1;\n`, 'n.md': '# t\ntext\n' }, 'trailing-ws'), []);
});

test('trailing-ws: CRLF files do not count the CR as whitespace', async () => {
  assert.deepEqual(await run({ 'x.ps1': '# SPDX-License-Identifier: GPL-3.0-or-later\r\nWrite-Host 1\r\n' }, 'trailing-ws'), []);
});

test('trailing-ws: unified diffs are exempt (blank context line is a space by format); other rules still run', async () => {
  const diff = '--- a/x.c\n+++ b/x.c\n@@ -1,3 +1,3 @@\n int a;\n \n-int b;\n+int c;\n';
  assert.deepEqual(await run({ 'p/fix.diff': diff, 'p/fix.patch': diff }, 'trailing-ws'), []);
  assert.deepEqual((await run({ 'p/fix.diffx': ' \n' }, 'trailing-ws')).map(formatFinding), ['p/fix.diffx:1: trailing-ws: trailing whitespace']);
});

test('spdx: missing header flagged; header after shebang or doctype accepted; json and unknown exempt', async () => {
  const bad = await run({ 'a.mjs': 'export const a = 1;\n', 'b.py': 'x = 1\n', 'c.css': 'a {}\n', 'd.html': '<!doctype html>\n<p>x</p>\n' }, 'spdx');
  assert.deepEqual(bad.map((f) => f.path), ['a.mjs', 'b.py', 'c.css', 'd.html']);
  const ok = await run({
    'a.mjs': `#!/usr/bin/env node\n${HDR_JS}export const a = 1;\n`,
    'b.py': '# SPDX-License-Identifier: GPL-3.0-or-later\nx = 1\n',
    'c.css': '/* SPDX-License-Identifier: GPL-3.0-or-later */\na {}\n',
    'd.html': '<!doctype html>\n<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<p>x</p>\n',
    'e.json': '{"a": 1}\n',
    'CMakeLists.txt': '# SPDX-License-Identifier: GPL-3.0-or-later\n',
    'notes.txt': 'plain\n',
    'hook': '#!/bin/sh\nexit 0\n',
  }, 'spdx');
  assert.deepEqual(ok, []);
});

test('spdx: header buried below line 3 is flagged', async () => {
  const f = await run({ 'a.mjs': `// one\n// two\n// three\n// four\n${HDR_JS}` }, 'spdx');
  assert.equal(f.length, 1);
});

// Fake secrets, written plainly; each line names its rule in a marker.
const SECRETS = {
  pem: '-----BEGIN RSA PRIVATE KEY-----', // lint-allow: secret
  aws: 'AKIAABCDEFGHIJKLMNOP', // lint-allow: secret
  github: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // lint-allow: secret
  sk: 'sk-abcdefghij0123456789xyz', // lint-allow: secret
  slack: 'xoxb-1234567890-abcdef', // lint-allow: secret
  twitch: 'oauth:abcdefghij0123456789abcdefghij', // lint-allow: secret
  bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', // lint-allow: secret
  assign: 'const api_key = "abcdefghijklmnop1234";', // lint-allow: secret
};

test('secret: each pattern is flagged', async () => {
  for (const [name, value] of Object.entries(SECRETS)) {
    const f = await run({ 'a.txt': `x\n${value}\n` }, 'secret');
    assert.equal(f.length, 1, name);
    assert.equal(f[0].line, 2, name);
  }
});

// The invalid-marker samples are plain text in a fixture file that the linter excludes explicitly.
const MARKER_SAMPLES = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lint', 'markers.txt'), 'utf8');

test('secret: sk- inside a word (a file name like task-...-before.xml) is not an API key; a key after = still is', async () => {
  assert.deepEqual(await run({ 'a.md': 'exported to 2026-11-03-task-Ujwalam-Backup-before.xml\n' }, 'secret'), []);
  const f = await run({ 'a.txt': 'key=sk-abcdefghij0123456789xyz\n' }, 'secret'); // lint-allow: secret
  assert.equal(f.length, 1);
});

test('secret: the marker suppresses on the same line in a test file; other lines still flagged; short values pass', async () => {
  const f = await run({ 'tests/a.txt': `${SECRETS.aws} // lint-allow: secret\n${SECRETS.aws}\n` }, 'secret');
  assert.deepEqual(f.map((x) => x.line), [2]);
  assert.deepEqual(await run({ 'a.txt': 'const token = "short";\nplain text, Bearer of news\nsk-short\n' }, 'secret'), []);
});

test('secret: an environment-variable-shaped name is not a secret; a real token-looking value still is', async () => {
  const name = 'UJWALAM_EVENT_CORE_API_TOKEN';
  const neg = await run({ 'a.txt': `export const ENV_API_TOKEN = '${name}';\nconst secret = "${name}";\n` }, 'secret');
  assert.deepEqual(neg, []);
  const pos = await run({ 'a.txt': `const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';\nconst secret = "Ab1Cd2Ef3Gh4Ij5Kl6";\nconst k = '${name}'; const token = "abcdef0123456789";\n` }, 'secret'); // lint-allow: secret
  assert.deepEqual(pos.map((x) => x.line), [1, 2, 3]);
});

test('secret marker outside tests/ is itself a finding and the secret check still applies', async () => {
  const f = await run({ 'src/a.txt': `${SECRETS.aws} // lint-allow: secret\n` });
  assert.deepEqual(f.map((x) => x.rule).sort(), ['lint-allow', 'secret']);
});

test('markers: bare, unknown and unsupported rule ids are findings (samples read from the fixture file)', async () => {
  assert.equal(MARKER_SAMPLES.split('\n').filter(Boolean).length, 4);
  const f = await run({ 'tests/a.txt': MARKER_SAMPLES });
  assert.deepEqual(f.map((x) => `${x.line}:${x.rule}`), ['1:lint-allow', '2:lint-allow', '3:lint-allow']);
});

test('exclusion list: the marker fixture is skipped, reported, and only that exact path; the same text elsewhere is flagged', async () => {
  const r = await lintReport(repoRoot, { files: ['tests/fixtures/lint/markers.txt'], osUser: null });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.markers, []);
  assert.equal(r.exclusions.length, 1);
  assert.equal(r.exclusions[0].path, 'tests/fixtures/lint/markers.txt');
  assert.match(r.exclusions[0].reason, /marker samples/);
  assert.deepEqual(LINT_EXCLUSIONS.map((x) => x.path), ['tests/fixtures/lint/markers.txt'], 'no other exclusion without a user yes');
  const other = await run({ 'tests/fixtures/lint/other.txt': MARKER_SAMPLES });
  assert.equal(other.filter((x) => x.rule === 'lint-allow').length, 3);
  const spawn = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'lint.mjs'), 'tests/fixtures/lint/markers.txt'], { encoding: 'utf8', windowsHide: true });
  assert.equal(spawn.status, 0, spawn.stdout);
  assert.match(spawn.stdout, /^lint exclusion in use: tests\/fixtures\/lint\/markers\.txt: /m);
});

test('lintReport lists every marker, valid or not, with path:line and rule, even with no findings', async () => {
  const root = tmp();
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'tests', 'a.txt'), `ok\nC:/Users/x // lint-allow: user-path\n`);
  const r = await lintReport(root, { files: ['tests/a.txt'], osUser: null });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.markers, [{ path: 'tests/a.txt', line: 2, rule: 'user-path' }]);
});

// Samples live in .txt fixtures: written as code here, this file's own child-process import would make them calls.
const fixture = (n) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lint', n), 'utf8');

test('hidden-window (JS): calls without windowsHide: true are flagged; GUI windows need a stated reason', async () => {
  const f = await run({ 'a.mjs': fixture('hidden-window-js.txt') }, 'hidden-window');
  // 4: no options; 10: namespace call; 12: options only in a variable; 17: windowsHide false without a reason
  assert.deepEqual(f.map((x) => x.line), [4, 10, 12, 17]);
  assert.ok(f.every((x) => x.rule === 'hidden-window'));
});

test('hidden-window (Python): calls without creationflags / **NO_WINDOW are flagged, aliases included', async () => {
  const f = await run({ 'a.py': fixture('hidden-window-py.txt') }, 'hidden-window');
  assert.deepEqual(f.map((x) => x.line), [6, 12]);
});

test('hidden-window: a file that never imports child_process / subprocess is not checked', async () => {
  assert.deepEqual(await run({ 'a.mjs': `${HDR_JS}const spawn = (x) => x;\nspawn(1);\n` }, 'hidden-window'), []);
});

test('user-path: Windows, macOS and Linux home paths flagged', async () => {
  const win = 'C:\\Users\\someone\\Documents'; // lint-allow: user-path
  const winFwd = 'D:/Users/someone/x'; // lint-allow: user-path
  const mac = '/Users/someone/x'; // lint-allow: user-path
  const lin = '/home/someone/x'; // lint-allow: user-path
  const f = await run({ 'a.txt': `${win}\n${winFwd}\n${mac}\n${lin}\n` }, 'user-path');
  assert.deepEqual(f.map((x) => x.line), [1, 2, 3, 4]);
});

test('user-path: placeholders, env vars and the allow marker pass', async () => {
  const ph = [
    'C:\\Users\\<user>\\x',
    '%USERPROFILE%\\x',
    '/home/<user>/x',
    '/Users/user/x', // placeholder user name
    'C:/Users/x/y // lint-allow: user-path',
    'https://example.org/home',
  ];
  assert.deepEqual(await run({ 'a.txt': ph.join('\n') + '\n' }, 'user-path'), []);
});

test('scope: git list covers tracked and untracked files but never ignored ones', async () => {
  const root = tmp();
  spawnSync('git', ['init', '-q', root], { windowsHide: true });
  writeFileSync(path.join(root, '.gitignore'), 'legacy/\nout/\n');
  mkdirSync(path.join(root, 'legacy'));
  mkdirSync(path.join(root, 'out'));
  writeFileSync(path.join(root, 'legacy', 'bad.mjs'), 'const = ;\n');
  writeFileSync(path.join(root, 'out', 'bad.mjs'), 'const = ;\n');
  writeFileSync(path.join(root, 'new.mjs'), `${HDR_JS}export const a = 1;\n`);
  assert.deepEqual(listFiles(root), ['.gitattributes', '.gitignore', 'new.mjs']);
  assert.deepEqual(await lint(root), []);
});

// The machine user name: an invented name is injected; the real one is never written anywhere.
const ME = 'zorbax';
const forms = [
  'C:\\Users\\zorbax\\x', // lint-allow: user-path
  'C:\\\\Users\\\\ZORBAX\\\\x', // lint-allow: user-path
  'D:/Users/Zorbax/x', // lint-allow: user-path
  '/Users/zorbax/x', // lint-allow: user-path
  '/home/zorbax/x', // lint-allow: user-path
  '/c/Users/zorbax/x', // lint-allow: user-path
];

test('user name: refused in every path form, case-insensitively, even with the marker, and never echoed', async () => {
  for (const form of forms) {
    const f = await run2({ 'tests/a.txt': form + '\n' + form + ' // lint-allow: user-path\n' }, { userNames: [ME] });
    assert.deepEqual(f.map((x) => x.line), [1, 2], form);
    assert.ok(f.every((x) => x.rule === 'user-path' && !x.message.toLowerCase().includes(ME)), form);
  }
});

test('user name: other names, bare words and longer names are not hit', async () => {
  const ok = [
    'C:\\Users\\zorbaxter\\x', // lint-allow: user-path
    'say zorbax hello',
    'C:\\Users\\<zorbax>',
  ];
  const f = await run2({ 'a.txt': ok.join('\n') + '\n' }, { userNames: [ME], rules: ['user-path'] });
  assert.deepEqual(f.map((x) => x.line), [1]); // zorbaxter is a real-looking other user, so the ordinary rule hits it
  assert.ok(f[0].message.startsWith('absolute user path'));
});

test('user name: read from a profile paths.windows_user (placeholders ignored) and from the OS user', async () => {
  const root = tmp();
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'profile.local.json'), JSON.stringify({ paths: { windows_user: 'Zorbax' } }));
  assert.ok(forbiddenUserNames(root, { osUser: null }).has(ME));
  writeFileSync(path.join(root, 'data', 'profile.local.json'), JSON.stringify({ paths: { windows_user: '<windows-user>' } }));
  assert.equal(forbiddenUserNames(root, { osUser: null }).size, 0);
  assert.ok(forbiddenUserNames(root, { osUser: 'Injected-Name' }).has('injected-name'));
  // default: the OS user is included (compared in memory, never printed)
  assert.ok(forbiddenUserNames(root).has(os.userInfo().username.toLowerCase()));
  // no profile at all is fine
  assert.equal(forbiddenUserNames(tmp(), { osUser: null }).size, 0);
});

test('user name from a temp profile is enforced by lint()', async () => {
  const root = tmp();
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'profile.local.json'), JSON.stringify({ paths: { windows_user: ME } }));
  writeFileSync(path.join(root, 'a.txt'), forms[0] + '\n');
  const f = await lint(root, { files: ['a.txt'], rules: ['user-path'], osUser: null });
  assert.equal(f.length, 1);
});

test('data/profile.example.json carries a placeholder windows_user key', async () => {
  const ex = JSON.parse(readFileSync(new URL('../data/profile.example.json', import.meta.url), 'utf8'));
  assert.match(ex.paths.windows_user, /^<.+>$/);
});

async function run2(files, opts) {
  const root = tmp();
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return lint(root, { files: Object.keys(files), rules: ['user-path'], osUser: null, ...opts });
}

// The one self-exemption: the marker pattern definition line of tools/lint.mjs. Read from the real file, so
// this test needs no marker text of its own.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('self-exemption: only the marker pattern definition in tools/lint.mjs, and it is reported', async () => {
  const r = await lintReport(repoRoot, { files: ['tools/lint.mjs'], osUser: null });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.markers, []);
  assert.equal(r.exemptions.length, 1);
  assert.equal(r.exemptions[0].path, 'tools/lint.mjs');
  assert.equal(r.exemptions[0].what, 'marker pattern definition');
  const lines = readFileSync(path.join(repoRoot, 'tools', 'lint.mjs'), 'utf8').split('\n');
  assert.ok(lines[r.exemptions[0].line - 1].startsWith('const MARKER_RE = '));

  // The same text under any other file name is not exempt: its marker is bare, so it is a finding.
  const other = (await run({ 'tools/other.mjs': `${HDR_JS}${lines[r.exemptions[0].line - 1]}\n` })).filter((x) => x.rule === 'lint-allow');
  assert.equal(other.length, 1);
});

test('CLI output lists the self-exemption', () => {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'lint.mjs'), 'tools/lint.mjs'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^lint self-exemption in use: tools\/lint\.mjs:\d+: marker pattern definition$/m);
});
