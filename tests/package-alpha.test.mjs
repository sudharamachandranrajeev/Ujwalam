// SPDX-License-Identifier: GPL-3.0-or-later
// Alpha 0 packaging (tools/package/): zip writer/reader, PE import reader, the file allowlist and forbidden-path check,
// release info and changelog excerpt, the installed-run spec, the CRLF launcher scripts, and Install-Ujwalam.ps1 end
// to end on a tiny fake package in a temp install root (install, tamper, reinstall refused, second version, rollback).
// The full build (real host exe and OBS runtime) runs only with UJWALAM_PACKAGE_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXE as STUDIO_EXE, START_EXE } from '../app/studio/tools/build.mjs';
import { changelogExcerpt, releaseInfo } from '../tools/package/build-alpha.mjs';
import { OFL_FONTS, OFL_FONT_LICENCES, OFL_FONT_LICENCE_SHA, allowProblems, dataRefProblems, disabledModules, fontNamesFromLicenceDoc, forbiddenProblems, importProblems, repoFiles } from '../tools/package/manifest.mjs';
import { peInfo } from '../tools/package/pe.mjs';
import { clipMakerNote, installedSpec, nodeOk, pruneLaunchLogs } from '../tools/package/run-installed.mjs';
import { CLIP_MAKER_FIX, clipTools } from '../services/studio-ui/record-clips.mjs';
import { extractEntry, readZip, writeZip } from '../tools/package/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO = path.join(REPO, 'app', 'studio', 'res', 'ujwalam.ico');
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
  // alpha.22 shipped without data/posting/auto-post-rules.json (and three more): the task panel said "file missing"
  assert.deepEqual(dataRefProblems(REPO, files), []);
  for (const f of ['data/posting/auto-post-rules.json', 'data/posting/schedule.json', 'data/clip/targets.json', 'data/stream/stream-options.json']) assert.ok(files.includes(f), f);
  assert.deepEqual(dataRefProblems(REPO, files.filter((f) => f !== 'data/posting/auto-post-rules.json')).length, 1, 'the check sees a missing file');
  {
    // Codex review: either quote style counts; comments and joins on another folder (the data dir) do not
    const d = tmp('dataref');
    try {
      mkdirSync(path.join(d, 'data', 'x'), { recursive: true });
      mkdirSync(path.join(d, 'services'), { recursive: true });
      for (const f of ['a.json', 'b.json', 'c.json', 'd.json']) writeFileSync(path.join(d, 'data', 'x', f), '{}');
      writeFileSync(path.join(d, 'services', 'm.mjs'), [
        `const A = path.join(REPO, 'data', 'x', 'a.json');`,
        `const B = path.join(REPO_ROOT, "data", "x", "b.json");`,
        `// const C = path.join(REPO, 'data', 'x', 'c.json');`,
        `/* path.join(REPO, 'data', 'x', 'c.json') */`,
        `const D = path.join(dataDir, 'data', 'x', 'd.json');`,
      ].join('\n'));
      const p = dataRefProblems(d, ['services/m.mjs']);
      assert.deepEqual(p.map((x) => x.replace(/^.*reads /, '').replace(/,.*$/, '')), ['data/x/a.json', 'data/x/b.json']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
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
  // D344: the pinned OFL fonts are the only font files that may ship; a same-named file with other bytes is caught at build time, any other font stays forbidden
  for (const p of Object.keys(OFL_FONTS)) assert.deepEqual(forbiddenProblems([p], { fontNames }), [], p);
  for (const p of ['data/fonts/Corbel.ttf', 'data/fonts/Consolas-Regular.ttf', 'data/fonts/Inter-Italic.ttf', 'data/fonts/Other.otf', 'studio/fonts/Inter-Regular.ttf', 'data/fonts/inter-regular.ttf']) assert.ok(forbiddenProblems([p], { fontNames }).length > 0, p);
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
    // D278: an overlayRoot naming the overlays/ folder itself (installs from 2026-11-03) is read as its parent.
    mkdirSync(path.join(d, 'legacy', 'overlays', 'alert-box'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ overlayRoot: path.join(d, 'legacy', 'overlays') }));
    assert.equal(installedSpec({ install, dataRoot }).overlayRoot, path.join(d, 'legacy'));
    mkdirSync(path.join(d, 'kit2', 'overlays', 'overlays'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ overlayRoot: path.join(d, 'kit2', 'overlays') }));
    assert.equal(installedSpec({ install, dataRoot }).overlayRoot, path.join(d, 'kit2', 'overlays'), 'a root that holds overlays/ stays');
    // D283: clipRoot reaches the launcher as UJWALAM_CLIP_ROOT; unset, no clip env
    assert.equal(installedSpec({ install, dataRoot }).env.UJWALAM_CLIP_ROOT, undefined);
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ clipRoot: path.join(d, 'repo') }));
    assert.equal(installedSpec({ install, dataRoot }).env.UJWALAM_CLIP_ROOT, path.join(d, 'repo'));
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ overlayRoot: install }));
    assert.throws(() => installedSpec({ install, dataRoot }), /install dir/);
    assert.throws(() => installedSpec({ install, dataRoot: path.join(install, 'data') }), /install dir/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('clip maker check: the package ships no Python, so an installed copy says so in plain words and names the fix', () => {
  // the repo part of the zip has no Python, no venv and no clipper (manifest.mjs repoFiles; the allowlist refuses them)
  const files = repoFiles(REPO);
  for (const f of files) assert.ok(!/(^|\/)\.venv|python\.exe$|\.py$|(^|\/)services\/clip\//.test(f), f);
  assert.ok(allowProblems(['.venv/Scripts/python.exe']).length > 0 && allowProblems(['python/python.exe']).length > 0, 'a Python in the zip would be refused');
  const d = tmp('clipcheck');
  try {
    const install = path.join(d, 'Ujwalam', '0.1.0-alpha.1');
    const dataRoot = path.join(d, 'Ujwalam', 'data');
    mkdirSync(path.join(install, 'services', 'studio-ui'), { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    // 1) no clipRoot in ujwalam.json: the launcher uses the install dir, which has no Python
    const spec = installedSpec({ install, dataRoot });
    assert.equal(spec.clipRoot, null);
    const t = clipTools({ clipRoot: spec.clipRoot ?? install });
    assert.deepEqual([t.py, t.missing], [null, 'python']);
    assert.match(t.reason, /^the clip maker's Python is missing \(the Ujwalam download does not include Python; looked in /);
    assert.equal(t.fix, CLIP_MAKER_FIX);
    const note = clipMakerNote(t);
    assert.match(note, /^\[ujwalam\] Clips can't be made on this PC yet: the clip maker's Python is missing/);
    assert.ok(note.includes('Install-Ujwalam.ps1 -SettingsOnly -ClipMaker <folder>'), note);
    assert.match(note, /Everything else works\.$/);
    // 2) clipRoot names a folder with Python but no clipper: the clipper is named
    const maker = path.join(d, 'checkout');
    mkdirSync(path.join(maker, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(path.join(maker, '.venv', 'Scripts', 'python.exe'), '');
    writeFileSync(path.join(dataRoot, 'ujwalam.json'), JSON.stringify({ clipRoot: maker }));
    const s2 = installedSpec({ install, dataRoot });
    const t2 = clipTools({ clipRoot: s2.clipRoot });
    assert.deepEqual([t2.py, t2.missing], [null, 'script']);
    assert.match(t2.reason, /clipper\.py/);
    // 3) a folder with both: ready, no note
    mkdirSync(path.join(maker, 'services', 'clip'), { recursive: true });
    writeFileSync(path.join(maker, 'services', 'clip', 'clipper.py'), '');
    const t3 = clipTools({ clipRoot: s2.clipRoot });
    assert.equal(t3.py, path.join(maker, '.venv', 'Scripts', 'python.exe'));
    assert.equal(t3.missing, null);
    assert.equal(clipMakerNote(t3), null);
    // 4) the GPU venv wins when both exist (the clip maker's own preference)
    mkdirSync(path.join(maker, '.venv-gpu', 'Scripts'), { recursive: true });
    writeFileSync(path.join(maker, '.venv-gpu', 'Scripts', 'python.exe'), '');
    assert.equal(clipTools({ clipRoot: maker }).py, path.join(maker, '.venv-gpu', 'Scripts', 'python.exe'));
    // 5) nothing set at all (a checkout run with clipRoot null is never passed; a null root says "not set up")
    assert.deepEqual([clipTools({ clipRoot: null }).missing, clipMakerNote(clipTools({ clipRoot: null })).includes('not set up')], ['root', true]);
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
  // The real start stub when it is built (npm run build:studio); otherwise a stand-in file the installer only copies.
  if (existsSync(START_EXE)) copyFileSync(START_EXE, path.join(pkg, 'ujwalam-start.exe'));
  else writeFileSync(path.join(pkg, 'ujwalam-start.exe'), 'stand-in\n');
  copyFileSync(ICO, path.join(pkg, 'ujwalam.ico'));
  writeFileSync(path.join(pkg, 'release.json'), JSON.stringify({ version, nodeMin: '22.13.0' }));
  writeFileSync(path.join(pkg, 'tools', 'package', 'run-installed.mjs'), `// ${version}\nconsole.log('fake ${version}');\n`);
  const rels = ['Install-Ujwalam.ps1', 'Ujwalam.cmd', 'ujwalam-start.exe', 'ujwalam.ico', 'release.json', 'tools/package/run-installed.mjs'];
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
    for (const f of ['0.1.0-alpha.1/release.json', 'Ujwalam.cmd', 'ujwalam-start.exe', 'ujwalam.ico', 'data']) assert.ok(existsSync(path.join(ir, f)), f);
    for (const d of ['start', 'desk']) assert.ok(existsSync(path.join(root, d, 'Ujwalam (alpha).lnk')), d);
    for (const d of ['start', 'desk']) assert.ok(existsSync(path.join(root, d, 'Ujwalam (alpha, LIVE).lnk')), `${d} LIVE (D281)`);
    // Arguments: devices on both (D282), stream targets only on LIVE (read back through the shell COM object).
    // Target: the windowless ujwalam-start.exe, not Ujwalam.cmd, so no console window opens (D191; 2026-11-08).
    const lnks = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object -ComObject WScript.Shell; foreach ($n in 'Ujwalam (alpha).lnk','Ujwalam (alpha, LIVE).lnk') { $l = $s.CreateShortcut((Join-Path '${path.join(root, 'start')}' $n)); $l.Arguments; $l.TargetPath; $l.IconLocation }`],
    { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    assert.deepEqual([lnks[0], lnks[3]], ['--allow-devices', '--live --allow-devices']);
    for (const target of [lnks[1], lnks[4]]) assert.equal(target.toLowerCase(), path.join(ir, 'ujwalam-start.exe').toLowerCase());
    // Both shortcuts carry the app icon (the .ico copied into the install root).
    for (const loc of [lnks[2], lnks[5]]) assert.equal(loc.toLowerCase(), `${path.join(ir, 'ujwalam.ico')},0`.toLowerCase());
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

test('Install-Ujwalam.ps1 -SettingsOnly: clip choices and folders merged into data\\core\\settings.json, clip maker into ujwalam.json, nothing installed (D284)', { timeout: 60_000 }, () => {
  const root = tmp('settings');
  try {
    const p = fakePackage(root, '0.1.0-alpha.1');
    const ir = path.join(root, 'Ujwalam');
    const sf = path.join(ir, 'data', 'core', 'settings.json');
    const maker0 = path.join(root, 'maker');
    mkdirSync(path.join(maker0, 'services', 'clip'), { recursive: true });
    writeFileSync(path.join(maker0, 'services', 'clip', 'clipper.py'), '');
    let r0 = install(p, root, '-SettingsOnly', '-ClipMaker', maker0);
    if (r0.code === 6) return;
    assert.equal(r0.code, 0, r0.out);
    assert.ok(!existsSync(sf), 'clip maker alone: no settings file, so the first-run welcome still asks');
    mkdirSync(path.dirname(sf), { recursive: true });
    writeFileSync(sf, JSON.stringify({ clips: { recording: 'off', live: 'off' }, folders: { recordings: 'E:\\Rec', clips: null }, keep: 1 }));
    const maker = path.join(root, 'maker');
    mkdirSync(path.join(maker, 'services', 'clip'), { recursive: true });
    writeFileSync(path.join(maker, 'services', 'clip', 'clipper.py'), '');
    let r = install(p, root, '-SettingsOnly', '-ClipsWhenLive', 'while', '-ClipsFolder', 'D:\\Clips', '-ClipMaker', maker);
    if (r.code === 6) return;
    assert.equal(r.code, 0, r.out);
    const s = JSON.parse(readFileSync(sf, 'utf8'));
    assert.deepEqual(s.clips, { recording: 'off', live: 'while' }, 'only the given choice changes');
    assert.deepEqual(s.folders, { recordings: 'E:\\Rec', clips: 'D:\\Clips' });
    assert.equal(s.keep, 1, 'other settings kept');
    assert.equal(JSON.parse(readFileSync(path.join(ir, 'data', 'ujwalam.json'), 'utf8')).clipRoot, maker);
    assert.ok(!existsSync(path.join(ir, 'current.txt')), 'nothing installed');
    r = install(p, root, '-SettingsOnly', '-ClipsFolder', 'relative\\clips');
    assert.equal(r.code, 2, r.out);
    r = install(p, root, '-SettingsOnly', '-RecordingsFolder', path.join(ir, '0.1.0-alpha.1', 'rec'));
    assert.equal(r.code, 2, 'not inside the install folder');
    r = install(p, root, '-SettingsOnly');
    assert.equal(r.code, 2, 'needs a setting');
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
    for (const n of ['ujwalam.ico', 'bin/ujwalam-host.exe', 'studio/ujwalam-studio.exe', 'studio/platforms/qwindows.dll', 'studio/platforms/qoffscreen.dll', 'studio/Qt6Network.dll', 'studio/Qt6Widgets.dll', 'Install-Ujwalam.ps1', 'Ujwalam.cmd', 'ujwalam-start.exe', 'SHA256SUMS.txt', 'notices/GPL-2.0.txt', 'notices/SOURCE-OFFER.txt']) assert.ok(names.includes(n), n);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('packager fails closed without the studio exe, naming npm run build:studio', async () => {
  const { buildAlpha } = await import('../tools/package/build-alpha.mjs');
  const dir = tmp('nostudio');
  try {
    await assert.rejects(buildAlpha({ hostExe: process.execPath, runtime: dir, studioExe: path.join(dir, 'none.exe'), outDir: dir, log: () => {} }), /studio exe not found: .*npm run build:studio/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ujwalam-start.exe (the shortcuts\' target): runs current.txt\'s run-installed.mjs with no console, output to data\\core\\logs\\launcher-*.log, arguments and exit code passed through', {
  skip: (process.platform !== 'win32' || !existsSync(START_EXE)) && 'start stub not built (npm run build:studio)', timeout: 60_000,
}, () => {
  const root = tmp('start');
  try {
    const ir = path.join(root, 'Ujwalam');
    const data = path.join(root, 'data');
    const v = '0.1.0-alpha.7';
    mkdirSync(path.join(ir, v, 'tools', 'package'), { recursive: true });
    copyFileSync(START_EXE, path.join(ir, 'ujwalam-start.exe'));
    writeFileSync(path.join(ir, 'current.txt'), `${v}\r\n`);
    writeFileSync(path.join(ir, v, 'tools', 'package', 'run-installed.mjs'),
      'console.log(JSON.stringify({ argv: process.argv.slice(2), noConsole: process.env.UJWALAM_NO_CONSOLE, log: process.env.UJWALAM_LAUNCH_LOG, cwd: process.cwd() }));\nconsole.error("to stderr");\nprocess.exit(7);\n');
    const env = { ...process.env, UJWALAM_DATA_ROOT: data };
    const run = (exe, args = []) => spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, env, timeout: 30_000 });
    const logs = () => readdirSync(path.join(data, 'core', 'logs')).filter((n) => /^launcher-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-p\d+\.log$/.test(n));

    const r = run(path.join(ir, 'ujwalam-start.exe'), ['--live', '--allow-devices']);
    assert.equal(r.status, 7, 'the launcher\'s exit code');
    assert.equal(r.stdout, '', 'nothing on its own stdout: a GUI exe');
    assert.equal(logs().length, 1);
    const logFile = path.join(data, 'core', 'logs', logs()[0]);
    const text = readFileSync(logFile, 'utf8');
    const seen = JSON.parse(text.split(/\r?\n/).find((l) => l.startsWith('{')));
    assert.deepEqual(seen.argv, ['--live', '--allow-devices']);
    assert.equal(seen.noConsole, '1');
    assert.equal(seen.log.toLowerCase(), logFile.toLowerCase());
    assert.equal(seen.cwd.toLowerCase(), path.join(ir, v).toLowerCase());
    assert.match(text, /^to stderr$/m);
    assert.match(text, /\[ujwalam-start\] launcher ended \(exit 7\)/);

    rmSync(path.join(ir, v, 'tools', 'package', 'run-installed.mjs'));
    assert.equal(run(path.join(ir, 'ujwalam-start.exe')).status, 3, 'missing version folder');
    writeFileSync(path.join(ir, 'current.txt'), '..\\..\\x\r\n');
    assert.equal(run(path.join(ir, 'ujwalam-start.exe')).status, 3, 'current.txt must name a version');
    assert.ok(logs().some((n) => /not a version/.test(readFileSync(path.join(data, 'core', 'logs', n), 'utf8'))));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('launcher logs: the newest 10 launcher-*.log files are kept, other files untouched', () => {
  const d = tmp('launchlogs');
  try {
    for (let i = 0; i < 13; i++) writeFileSync(path.join(d, `launcher-2026-11-${String(i + 1).padStart(2, '0')}T10-00-00-p${100 + i}.log`), 'x');
    writeFileSync(path.join(d, 'host-2026-11-01T10-00-00.log'), 'x');
    const removed = pruneLaunchLogs(d);
    assert.deepEqual(removed, ['launcher-2026-11-01T10-00-00-p100.log', 'launcher-2026-11-02T10-00-00-p101.log', 'launcher-2026-11-03T10-00-00-p102.log']);
    assert.equal(readdirSync(d).filter((n) => n.startsWith('launcher-')).length, 10);
    assert.ok(existsSync(path.join(d, 'host-2026-11-01T10-00-00.log')));
    assert.deepEqual(pruneLaunchLogs(path.join(d, 'none')), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('HOW-TO.md ships in the zip: allowlisted top file, built from docs/how-to.md by the packager', () => {
  assert.deepEqual(allowProblems(['HOW-TO.md']), []);
  assert.deepEqual(forbiddenProblems(['HOW-TO.md'], { fontNames: ['Corbel', 'Consolas'] }), []);
  const doc = readFileSync(path.join(REPO, 'docs', 'how-to.md'), 'utf8');
  assert.match(doc, /^# Ujwalam how-to/);
  const build = readFileSync(path.join(REPO, 'tools', 'package', 'build-alpha.mjs'), 'utf8');
  assert.match(build, /put\('HOW-TO\.md', 'generated', \{ src: path\.join\(REPO, 'docs', 'how-to\.md'\) \}\)/);
});

// ---- app icon (tools/make-icon.mjs) ----------------------------------------------------------------------------------
// Top-level resource types of a PE file (RT_ICON = 3, RT_GROUP_ICON = 14), read from its resource directory.
function peResourceTypes(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  const nSec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), opt = pe + 24;
  const dd = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const rva = b.readUInt32LE(dd + 2 * 8);
  if (!rva) return [];
  let off = -1;
  for (let i = 0; i < nSec; i++) {
    const s = opt + optSize + i * 40, va = b.readUInt32LE(s + 12), raw = b.readUInt32LE(s + 20), len = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16));
    if (rva >= va && rva < va + len) off = raw + (rva - va);
  }
  if (off < 0) return [];
  const nNamed = b.readUInt16LE(off + 12), nId = b.readUInt16LE(off + 14), ids = [];
  for (let i = 0; i < nNamed + nId; i++) if (i >= nNamed) ids.push(b.readUInt32LE(off + 16 + i * 8));
  return ids;
}

test('app icon: .ico has all sizes as PNG entries, matches the generator, and ships (allowlist, installer, packager)', async () => {
  const { build, ICO_SIZES } = await import('../tools/make-icon.mjs');
  const ico = readFileSync(ICO);
  assert.equal(ico.readUInt16LE(2), 1, 'type = icon');
  const n = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + 16 * i, w = ico[o] || 256, len = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12);
    assert.equal(ico.subarray(off, off + 8).toString('hex'), '89504e470d0a1a0a', `entry ${w} is a PNG`);
    assert.equal(ico.readUInt32BE(off + 16), w, 'PNG width = entry width');
    assert.ok(off + len <= ico.length);
    sizes.push(w);
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 256]);
  assert.deepEqual(sizes, [...ICO_SIZES]);
  assert.ok(build().ico.equals(ico), 'committed .ico equals the generator output (run node tools/make-icon.mjs)');
  assert.ok(readFileSync(path.join(REPO, 'app', 'studio', 'res', 'ujwalam.svg'), 'utf8').startsWith('<svg'));
  assert.ok(readFileSync(path.join(REPO, 'ui', 'favicon.svg'), 'utf8').startsWith('<svg'));
  assert.match(readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8'), /<link rel="icon"[^>]*href="\/favicon\.svg"/);
  assert.deepEqual(allowProblems(['ujwalam.ico', 'ui/favicon.svg']), []);
  const ps = readFileSync(path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1'), 'utf8');
  assert.equal((ps.match(/\.IconLocation = \$iconLoc/g) ?? []).length, 2, 'both shortcuts set IconLocation');
  assert.match(readFileSync(path.join(REPO, 'tools', 'package', 'build-alpha.mjs'), 'utf8'), /put\('ujwalam\.ico'/);
  const cm = readFileSync(path.join(REPO, 'app', 'studio', 'CMakeLists.txt'), 'utf8');
  assert.equal((cm.match(/res\/ujwalam\.rc/g) ?? []).length, 2, 'both exes get the .rc');
});

test('app icon: the built studio and start exes carry an icon resource', (t) => {
  const exes = [STUDIO_EXE, START_EXE].filter((f) => existsSync(f));
  if (exes.length < 2) { t.skip('build the studio first (npm run build:studio)'); return; }
  for (const f of exes) {
    const ids = peResourceTypes(f);
    assert.ok(ids.includes(14) && ids.includes(3), `${path.basename(f)} has RT_GROUP_ICON and RT_ICON (types: ${ids})`);
  }
});

test('bundled OFL fonts (D344): the repo files are the pinned bytes, each family has its licence text, notices record every hash', async () => {
  const { createHash } = await import('node:crypto');
  const notices = readFileSync(path.join(REPO, 'docs', 'third-party-notices.md'), 'utf8');
  for (const [rel, sha] of Object.entries(OFL_FONTS)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(REPO, rel))).digest('hex'), sha, rel);
    assert.ok(notices.includes(sha), `docs/third-party-notices.md lists ${rel}`);
  }
  for (const [rel, sha] of Object.entries(OFL_FONT_LICENCE_SHA)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(REPO, rel))).digest('hex'), sha, `${rel} is the pinned licence text`);
    assert.ok(notices.includes(sha), `docs/third-party-notices.md lists the hash of ${rel}`);
  }
  for (const rel of OFL_FONT_LICENCES) assert.match(readFileSync(path.join(REPO, rel), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/, rel);
  const all = repoFiles(REPO);
  for (const rel of [...Object.keys(OFL_FONTS), ...OFL_FONT_LICENCES]) assert.ok(all.includes(rel), `${rel} is packaged`);
  assert.deepEqual(allowProblems([...Object.keys(OFL_FONTS), ...OFL_FONT_LICENCES]), []);
});
