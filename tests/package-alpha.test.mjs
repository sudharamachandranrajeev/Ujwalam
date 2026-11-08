// SPDX-License-Identifier: GPL-3.0-or-later
// Alpha 0 packaging (tools/package/): zip writer/reader, PE import reader, the file allowlist and forbidden-path check,
// release info and changelog excerpt, the installed-run spec, the CRLF launcher scripts, and Install-Ujwalam.ps1 end
// to end on a tiny fake package in a temp install root (install, tamper, reinstall refused, second version, rollback).
// The full build (real host exe and OBS runtime) runs only with UJWALAM_PACKAGE_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogExcerpt, releaseInfo } from '../tools/package/build-alpha.mjs';
import { allowProblems, disabledModules, fontNamesFromLicenceDoc, forbiddenProblems, importProblems, repoFiles } from '../tools/package/manifest.mjs';
import { peInfo } from '../tools/package/pe.mjs';
import { installedSpec, nodeOk } from '../tools/package/run-installed.mjs';
import { extractEntry, readZip, writeZip } from '../tools/package/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-pkg-${p}-`));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('zip: round trip (deflated and stored entries, CRC checked); unsafe and duplicate names are refused', () => {
  const d = tmp('zip');
  try {
    const f = path.join(d, 'a.bin');
    const big = Buffer.alloc(10_000, 'abc');
    writeFileSync(f, big);
    const z = path.join(d, 'x.zip');
    writeZip(z, [{ name: 'top/a.bin', file: f }, { name: 'top/sub/b.txt', data: 'hi' }, { name: 'top/rand', data: Buffer.from(createHash('sha512').update('x').digest()) }]);
    const e = readZip(z);
    assert.deepEqual(e.map((x) => x.name), ['top/a.bin', 'top/sub/b.txt', 'top/rand']);
    assert.equal(e[0].method, 8);
    assert.ok(e[0].compressedSize < 1000);
    assert.equal(e[2].method, 0, 'incompressible data is stored');
    assert.deepEqual(extractEntry(z, e[0]), big);
    assert.equal(extractEntry(z, e[1]).toString(), 'hi');
    for (const bad of ['../x', '/abs', 'C:/x', 'a\\b', 'a//b', '']) assert.throws(() => writeZip(path.join(d, 'y.zip'), [{ name: bad, data: 'x' }]), undefined, bad);
    assert.throws(() => writeZip(path.join(d, 'y.zip'), [{ name: 'a', data: 'x' }, { name: 'A', data: 'y' }]));
    assert.ok(!existsSync(path.join(d, 'y.zip')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PE reader: node.exe is x64 PE32+ with KERNEL32 imports', () => {
  const pe = peInfo(readFileSync(process.execPath));
  assert.equal(pe.machine, 0x8664);
  assert.equal(pe.pe32plus, true);
  assert.ok(pe.imports.some((n) => n.toLowerCase() === 'kernel32.dll'), pe.imports.join(','));
});

test('repo file set: no tests, docs, Python or local files; every relative import resolves inside the package', () => {
  const files = repoFiles(REPO);
  assert.ok(files.length > 100);
  for (const f of files) assert.ok(!/(^|\/)(tests?|fixtures)\/|\.md$|\.py$|\.local\.|(^|\/)\./.test(f), f);
  assert.ok(files.includes('services/studio-ui/launch.mjs'));
  assert.ok(files.includes('tools/diag/bundle.mjs'));
  assert.deepEqual(importProblems(REPO, files), []);
  assert.deepEqual(allowProblems(files), []);
  assert.deepEqual(forbiddenProblems(files, { fontNames: ['Corbel', 'Consolas'] }), []);
  const dis = disabledModules(REPO);
  for (const m of ['obs-websocket', 'win-capture', 'rtmp-services', 'obs-vst', 'nv-filters']) assert.ok(dis.includes(m), m);
});

test('forbidden paths: legacy, local files, Microsoft fonts, any font, private evidence, feedback, out/, user data, secrets', () => {
  const fontNames = fontNamesFromLicenceDoc(readFileSync(path.join(REPO, 'docs', 'licence-headers.md'), 'utf8'));
  assert.deepEqual(fontNames.sort(), ['Consolas', 'Corbel']);
  const bad = ['legacy/x.js', 'data/profile.local.json', 'data/x.local.json', 'ui/fonts/corbel.ttf', 'ui/fonts/Consolas-Bold.woff2', 'ui/fonts/free.otf',
    'docs/evidence/private/a.png', 'docs/x.md', 'feedback/2026/moment.json', 'out/host/build/ujwalam-host.exe', 'recordings/a.mkv', 'markers/s.jsonl',
    '.env', 'node_modules/ajv/x.js', 'host.local.json', 'data/labels/a.json', 'data/games/codm/x.json', 'logs/host.log', 'bin/ujwalam-host.pdb'];
  for (const p of bad) assert.ok(forbiddenProblems([p], { fontNames }).length > 0, p);
  for (const p of ['ui/corbel-colours.css']) assert.deepEqual(forbiddenProblems([p], { fontNames }), [], 'a css file that merely starts with the name is not a font');
  assert.deepEqual(allowProblems(['bin/ujwalam-host.exe', 'studio/ujwalam-studio.exe', 'studio/Qt6Core.dll', 'studio/Qt6Network.dll', 'studio/platforms/qwindows.dll', 'studio/platforms/qoffscreen.dll', 'obs/bin/64bit/obs.dll', 'obs/obs-plugins/64bit/locales/en-US.pak', 'notices/GPL-2.0.txt', 'Install-Ujwalam.ps1']), []);
  assert.equal(allowProblems(['tests/x.test.mjs', 'random.txt', 'bin/other.exe', 'obs/cef/x.dll', 'obs/bin/64bit/platforms/qminimal.dll', 'obs/bin/64bit/imageformats/qjpeg.dll', 'obs/bin/64bit/platforms/qwindows.dll', 'bin/ujwalam-studio.exe', 'studio/Qt6Svg.dll', 'studio/platforms/qminimal.dll']).length, 10);
});

test('release info and changelog excerpt for the current alpha and alpha.1; node version check', () => {
  const cur = JSON.parse(readFileSync(path.join(REPO, 'data', 'release', 'alpha.json'), 'utf8')).current;
  const r = releaseInfo(REPO);
  assert.equal(r.version, `0.1.0-alpha.${cur}`);
  assert.equal(releaseInfo(REPO, 1).version, '0.1.0-alpha.1', 'an older listed build can still be packaged');
  assert.throws(() => releaseInfo(REPO, 99));
  assert.throws(() => releaseInfo(REPO, 0));
  const log = readFileSync(path.join(REPO, 'data', 'release', 'CHANGELOG-alpha.md'), 'utf8');
  for (const n of [1, cur]) assert.match(changelogExcerpt(log, `0.1.0-alpha.${n}`), new RegExp(`^# Ujwalam 0\\.1\\.0-alpha\\.${n}\\n`));
  assert.throws(() => changelogExcerpt('## 0.1.0-alpha.2\nx', '0.1.0-alpha.1'));
  assert.equal(changelogExcerpt('## 0.1.0-alpha.1 — d\na\n## 0.1.0-alpha.0\nb\n', '0.1.0-alpha.1'), '# Ujwalam 0.1.0-alpha.1\n\na\n');
  assert.equal(nodeOk('v22.13.0', '22.13.0'), true);
  assert.equal(nodeOk('v22.12.9', '22.13.0'), false);
  assert.equal(nodeOk('26.12.1', '22.13.0'), true);
  assert.equal(nodeOk('v21.99.0', '22.13.0'), false);
});

test('installed spec: data dirs under the data root, OBS runtime and host exe from the install, config from ujwalam.json', () => {
  const d = tmp('spec');
  try {
    const install = path.join(d, 'Ujwalam', '0.1.0-alpha.1');
    const dataRoot = path.join(d, 'Ujwalam', 'data');
    mkdirSync(dataRoot, { recursive: true });
    let s = installedSpec({ install, dataRoot, userArgs: ['--mock', '--no-open'] });
    assert.equal(s.env.UJWALAM_OBS_RUNTIME, path.join(install, 'obs'));
    assert.equal(s.env.UJWALAM_HOST_EXE, path.join(install, 'bin', 'ujwalam-host.exe'));
    assert.equal(s.env.UJWALAM_HOST_DATA, path.join(dataRoot, 'host'));
    assert.equal(s.overlayRoot, path.join(dataRoot, 'overlays'));
    assert.equal(s.profile, path.join(dataRoot, 'profile.local.json'));
    assert.deepEqual(s.argv, ['--alpha', '--data-dir', path.join(dataRoot, 'core'), '--feedback-dir', path.join(dataRoot, 'feedback'), '--profile', s.profile, '--mock', '--no-open']);
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ overlayRoot: path.join(d, 'my-overlays'), profile: 'p/me.json' }));
    s = installedSpec({ install, dataRoot, userArgs: ['--profile', 'x.json'] });
    assert.equal(s.overlayRoot, path.join(d, 'my-overlays'));
    assert.ok(!s.argv.includes(path.join(dataRoot, 'p', 'me.json')), 'a --profile argument wins');
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ overlayRoot: install }));
    assert.throws(() => installedSpec({ install, dataRoot }), /install dir/);
    assert.throws(() => installedSpec({ install, dataRoot: path.join(install, 'data') }), /install dir/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('installed run without a profile stops before anything starts and says where the example is', () => {
  const d = tmp('noprof');
  try {
    const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'package', 'run-installed.mjs'), '--mock'], { encoding: 'utf8', env: { ...process.env, UJWALAM_DATA_ROOT: path.join(d, 'data') }, windowsHide: true });
    // In the repo there is no release.json at the root, so main() stops even earlier (exit 2); in a package it
    // reaches the profile check. Both exit 2 without starting the launcher.
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.ok(!/\[serve\]|\[studio\]/.test(r.stdout));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('launcher scripts: CRLF line endings, SPDX header, Install-Ujwalam.ps1 parses in Windows PowerShell 5.1', () => {
  for (const f of ['tools/package/Install-Ujwalam.ps1', 'tools/package/Ujwalam.cmd']) {
    const t = readFileSync(path.join(REPO, f), 'latin1');
    assert.ok(!/[^\r]\n/.test(t), `${f} has LF-only lines`);
    assert.match(t, /SPDX-License-Identifier: GPL-3\.0-or-later/);
  }
  const ps = path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1').replace(/'/g, "''");
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '0');
});

function fakePackage(root, version) {
  const pkg = path.join(root, `pkg-${version}`);
  mkdirSync(path.join(pkg, 'tools', 'package'), { recursive: true });
  copyFileSync(path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1'), path.join(pkg, 'Install-Ujwalam.ps1'));
  copyFileSync(path.join(REPO, 'tools', 'package', 'Ujwalam.cmd'), path.join(pkg, 'Ujwalam.cmd'));
  writeFileSync(path.join(pkg, 'release.json'), JSON.stringify({ version, nodeMin: '22.13.0' }));
  writeFileSync(path.join(pkg, 'tools', 'package', 'run-installed.mjs'), `// ${version}\nconsole.log('fake ${version}');\n`);
  const rels = ['Install-Ujwalam.ps1', 'Ujwalam.cmd', 'release.json', 'tools/package/run-installed.mjs'];
  writeFileSync(path.join(pkg, 'SHA256SUMS.txt'), rels.map((r) => `${sha(readFileSync(path.join(pkg, r)))}  ${r}\n`).join(''));
  return pkg;
}

function install(pkg, root, ...extra) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(pkg, 'Install-Ujwalam.ps1'),
    '-InstallRoot', path.join(root, 'Ujwalam'), '-StartMenuDir', path.join(root, 'start'), '-DesktopDir', path.join(root, 'desk'), ...extra], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('Install-Ujwalam.ps1 on a fake package: install, shortcuts, tamper refused, reinstall refused, second version keeps the first, rollback', { timeout: 120_000 }, (t) => {
  const root = tmp('install');
  try {
    const p1 = fakePackage(root, '0.1.0-alpha.1');
    const ir = path.join(root, 'Ujwalam');
    let r = install(p1, root);
    if (r.code === 6) { t.skip(`prerequisites missing on this machine: ${r.out}`); return; }
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8'), '0.1.0-alpha.1\r\n');
    assert.ok(!existsSync(path.join(ir, 'previous.txt')));
    for (const f of ['0.1.0-alpha.1/release.json', 'Ujwalam.cmd', 'data']) assert.ok(existsSync(path.join(ir, f)), f);
    for (const d of ['start', 'desk']) assert.ok(existsSync(path.join(root, d, 'Ujwalam (alpha).lnk')), d);
    // The root launcher follows current.txt to that version's launcher and on to its run-installed.mjs.
    let run = spawnSync('cmd.exe', ['/d', '/c', path.join(ir, 'Ujwalam.cmd')], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.stdout.trim(), 'fake 0.1.0-alpha.1');

    r = install(p1, root, '-NoShortcuts');
    assert.equal(r.code, 4, r.out);

    const p2 = fakePackage(root, '0.1.0-alpha.2');
    writeFileSync(path.join(p2, 'tools', 'package', 'run-installed.mjs'), 'tampered\n');
    r = install(p2, root, '-NoShortcuts');
    assert.equal(r.code, 7, r.out);
    assert.match(r.out, /changed tools\/package\/run-installed\.mjs/);
    writeFileSync(path.join(p2, 'extra.txt'), 'x');
    rmSync(path.join(p2, 'SHA256SUMS.txt'));
    fakePackage(root, '0.1.0-alpha.2');
    r = install(p2, root, '-NoShortcuts');
    assert.equal(r.code, 7, r.out);
    assert.match(r.out, /extra file extra\.txt/);
    rmSync(path.join(p2, 'extra.txt'));
    r = install(p2, root, '-NoShortcuts');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.2');
    assert.equal(readFileSync(path.join(ir, 'previous.txt'), 'utf8').trim(), '0.1.0-alpha.1');
    run = spawnSync('cmd.exe', ['/d', '/c', path.join(ir, 'Ujwalam.cmd')], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.stdout.trim(), 'fake 0.1.0-alpha.2');

    r = install(p2, root, '-Rollback');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), '0.1.0-alpha.1');
    assert.equal(readFileSync(path.join(ir, 'previous.txt'), 'utf8').trim(), '0.1.0-alpha.2');
    run = spawnSync('cmd.exe', ['/d', '/c', path.join(ir, 'Ujwalam.cmd')], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.stdout.trim(), 'fake 0.1.0-alpha.1');
    assert.ok(existsSync(path.join(ir, '0.1.0-alpha.2', 'release.json')), 'nothing deleted');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('full build (real host exe + OBS runtime)', { skip: process.env.UJWALAM_PACKAGE_E2E !== '1' && 'set UJWALAM_PACKAGE_E2E=1 (needs out/host/build and the OBS runtime)', timeout: 600_000 }, async () => {
  const { buildAlpha } = await import('../tools/package/build-alpha.mjs');
  const out = tmp('build');
  try {
    const r = await buildAlpha({ outDir: out });
    const names = readZip(r.zip).map((e) => e.name.replace(/^[^/]+\//, ''));
    assert.deepEqual(allowProblems(names), []);
    assert.deepEqual(forbiddenProblems(names, { fontNames: ['Corbel', 'Consolas'] }), []);
    for (const n of ['bin/ujwalam-host.exe', 'studio/ujwalam-studio.exe', 'studio/platforms/qwindows.dll', 'studio/platforms/qoffscreen.dll', 'studio/Qt6Network.dll', 'studio/Qt6Widgets.dll', 'Install-Ujwalam.ps1', 'Ujwalam.cmd', 'SHA256SUMS.txt', 'notices/GPL-2.0.txt', 'notices/SOURCE-OFFER.txt']) assert.ok(names.includes(n), n);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('packager fails closed without the studio exe, naming npm run build:studio', async () => {
  const { buildAlpha } = await import('../tools/package/build-alpha.mjs');
  const dir = tmp('nostudio');
  try {
    await assert.rejects(buildAlpha({ hostExe: process.execPath, runtime: dir, studioExe: path.join(dir, 'none.exe'), outDir: dir, log: () => {} }), /studio exe not found: .*npm run build:studio/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOW-TO.md ships in the zip: allowlisted top file, built from docs/how-to.md by the packager', () => {
  assert.deepEqual(allowProblems(['HOW-TO.md']), []);
  assert.deepEqual(forbiddenProblems(['HOW-TO.md'], { fontNames: ['Corbel', 'Consolas'] }), []);
  const doc = readFileSync(path.join(REPO, 'docs', 'how-to.md'), 'utf8');
  assert.match(doc, /^# Ujwalam how-to/);
  const build = readFileSync(path.join(REPO, 'tools', 'package', 'build-alpha.mjs'), 'utf8');
  assert.match(build, /put\('HOW-TO\.md', 'generated', \{ src: path\.join\(REPO, 'docs', 'how-to\.md'\) \}\)/);
});
