#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Builds the Alpha 0 portable zip (D133): out/dist/ujwalam-<base>-alpha.<N>-win64.zip
//   node tools/package/build-alpha.mjs [--n N] [--host-exe FILE] [--runtime DIR] [--out-dir DIR] [--profile FILE]
//                                      [--force] [--keep-staging]
//   N         --n, else data/release/alpha.json "current"; data/release/CHANGELOG-alpha.md needs a "## <version>" section.
//   host exe  --host-exe, else app/host/lib/config.mjs (UJWALAM_HOST_EXE / host.local.json "exe" / out/host/build).
//   runtime   --runtime, else the configured OBS runtime (UJWALAM_OBS_RUNTIME / host.local.json "obsRuntime").
//   profile   --profile, else data/profile.local.json: the private-term scan (tools/git-hooks/private-scan.mjs
//             scan-files) runs over every packaged file that is not an upstream OBS binary, and fails closed
//             without a profile.
// Contents (tools/package/manifest.mjs): the host exe and its helper exes in bin/, the OBS runtime subset in obs/
// (import closure, listed in notices/OBS-RUNTIME-FILES.txt), the Node services, UI, registry and runtime data at their
// repo paths, Install-Ujwalam.ps1, Ujwalam.cmd, README.txt, release.json, CHANGELOG-alpha.md (this build's section),
// notices/ (GPL-2.0 text, source offer, third-party list) and SHA256SUMS.txt. Node.js is not bundled: the installer
// and the launcher require Node >= release nodeMin on PATH.
// Checks, any failure stops the build and nothing is written to out/dist: allowlist, forbidden paths (legacy/,
// *.local.*, fonts incl. those named in docs/licence-headers.md, docs/, feedback/, out/, user data, secrets, media),
// import closure of the packaged .mjs files, private-term scan. The same path checks run again on the finished zip.
// An existing zip of the same version is refused unless --force (then it is moved to out/dist/_old/, never deleted).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../../app/host/lib/config.mjs';
import {
  allowProblems, disabledModules, fontNamesFromLicenceDoc, forbiddenProblems, importProblems, repoFiles, selectObsRuntime,
} from './manifest.mjs';
import { readZip, writeZip } from './zip.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function releaseInfo(repo, n) {
  const rel = JSON.parse(readFileSync(path.join(repo, 'data', 'release', 'alpha.json'), 'utf8'));
  const num = n ?? rel.current;
  if (!Number.isInteger(num) || num < 1) throw new Error('alpha N must be a positive integer');
  const build = rel.builds.find((b) => b.n === num);
  if (!build) throw new Error(`data/release/alpha.json has no build ${num}`);
  const version = `${rel.base}-${rel.channel}.${num}`;
  return { rel, build, n: num, version };
}

/** The "## <version>" section of the changelog (heading included), or throws. */
export function changelogExcerpt(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG-alpha.md has no section for ${version}`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return `# Ujwalam ${version}\n\n${lines.slice(start + 1, end).join('\n').trim()}\n`;
}

/** MSVC compiler 19.xx -> VC++ runtime 14.xx.0 (the redistributable must be at least the toolset version). */
export function vcRuntimeMin(buildDir) {
  try {
    for (const d of readdirSync(path.join(buildDir, 'CMakeFiles'))) {
      const f = path.join(buildDir, 'CMakeFiles', d, 'CMakeCXXCompiler.cmake');
      if (!existsSync(f)) continue;
      const m = /CMAKE_CXX_COMPILER_VERSION "19\.(\d+)\./.exec(readFileSync(f, 'utf8'));
      if (m) return `14.${m[1]}.0`;
    }
  } catch { /* unknown */ }
  return null;
}

// Licence of each shipped OBS runtime file, by name. Statuses are as checked (see docs/third-party-notices.md).
const COMPONENTS = [
  [/^(obs\.dll|libobs-.*\.dll|obs-frontend-api\.dll|w32-pthreads\.dll)$/i, 'OBS Studio 32.1.2 (libobs)', 'GPL-2.0-or-later (w32-pthreads: OBS fork of pthreads-win32, LGPL-2.1-or-later; UNVERIFIED)'],
  [/^(obs-ffmpeg-mux|obs-nvenc-test|obs-amf-test|obs-qsv-test)\.exe$/i, 'OBS Studio 32.1.2 (helper exes)', 'GPL-2.0-or-later'],
  [/^(image-source|obs-ffmpeg|obs-filters|obs-nvenc|obs-outputs|obs-qsv11|obs-text|obs-transitions|obs-x264|text-freetype2|win-dshow|win-wasapi|coreaudio-encoder|obs-browser)\.dll$/i, 'OBS Studio 32.1.2 (plugins)', 'GPL-2.0-or-later'],
  [/^obs-browser-page\.exe$/i, 'OBS Studio 32.1.2 (obs-browser)', 'GPL-2.0-or-later'],
  [/^(avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale)-\d+\.dll$/i, 'FFmpeg (OBS build)', 'GPL-3.0-or-later (verified 2026-11-05: build string has --enable-gpl --enable-version3, no --enable-nonfree; docs/evidence/2026-11-05-licence-verification.md)'],
  [/^libx264-\d+\.dll$/i, 'x264', 'GPL-2.0-or-later'],
  [/^Qt6[A-Za-z]+\.dll$/i, 'Qt 6.8.3 (imported by obs-browser and obs-frontend-api)', 'LGPL-3.0-only; relinking note docs/notices-qt-relinking.md, texts docs/licenses/{LGPL,GPL}-3.0.txt'],
  [/^(libcef\.dll|chrome_elf\.dll|.*\.pak|icudtl\.dat|v8_context_snapshot\.bin)$/i, 'Chromium Embedded Framework (CEF) and Chromium', 'BSD-3-Clause (CEF) plus Chromium third-party licences: UNVERIFIED, credits file not in the runtime'],
  [/^(libEGL|libGLESv2)\.dll$/i, 'ANGLE (part of CEF)', 'BSD-3-Clause: UNVERIFIED'],
  [/^zlib\.dll$/i, 'zlib', 'Zlib'],
  [/^libcurl\.dll$/i, 'curl', 'curl licence (MIT-style)'],
  [/^srt\.dll$/i, 'SRT (Haivision)', 'MPL-2.0'],
  [/^librist\.dll$/i, 'librist', 'BSD-2-Clause'],
  [/^datachannel\.dll$/i, 'libdatachannel', 'MPL-2.0'],
  [/^lua51\.dll$/i, 'LuaJIT', 'MIT'],
];
const componentOf = (name) => COMPONENTS.find(([re]) => re.test(name)) ?? [null, 'unknown component', 'UNVERIFIED: not classified'];

function sourceOffer({ version, commit, obs }) {
  return [
    `Ujwalam ${version}: GPL source offer`,
    '',
    'This package contains Ujwalam (GPL-2.0-or-later) and binaries of OBS Studio and the libraries it uses',
    '(GPL-2.0-or-later, LGPL and other licences; see THIRD-PARTY.txt). The GNU General Public License v2 is in',
    'GPL-2.0.txt.',
    '',
    'Corresponding source:',
    `- Ujwalam: commit ${commit} of the Ujwalam repository. The Node.js services in this package are the`,
    '  complete source of those parts; the host exe (bin/ujwalam-host.exe) is built from app/host/ at that commit.',
    `- OBS Studio ${obs.version}: ${obs.source}`,
    '- OBS Windows dependencies (FFmpeg, x264, Qt, CEF, ...): https://github.com/obsproject/obs-deps, at the',
    `  version that OBS Studio ${obs.version} names in its build files (UNVERIFIED which tag).`,
    '',
    'Written offer: for at least three years from the date of this build, whoever gave you this package will',
    'give you, on request, a complete machine-readable copy of the corresponding source code of every GPL or',
    'LGPL component in it, on a medium customarily used for software interchange, for a charge no more than',
    'the cost of physically performing the distribution. Ask through the channel you received this package from.',
    '',
    'Alpha builds are made for personal testing. Before a build is given to anyone else, check this offer and',
    'the third-party list (docs/third-party-notices.md in the source repository). Status: UNVERIFIED, not legal advice.',
    '',
  ].join('\n');
}

function readme({ version, nodeMin }) {
  return [
    `Ujwalam ${version} (alpha, Windows 11 x64)`,
    '',
    'Install (no admin rights):',
    '  1. Unzip this folder anywhere.',
    '  2. In it run:  powershell -ExecutionPolicy Bypass -File .\\Install-Ujwalam.ps1',
    `     It checks Node.js ${nodeMin}+ on PATH and the Microsoft Visual C++ 2015-2022 x64 runtime, verifies`,
    '     SHA256SUMS.txt, copies this build to %LOCALAPPDATA%\\Ujwalam\\<version>, keeps the previous version and',
    '     adds Start-menu and desktop shortcuts. It installs nothing else.',
    '  Roll back:  powershell -ExecutionPolicy Bypass -File .\\Install-Ujwalam.ps1 -Rollback',
    '  3. First run only: copy data\\profile.example.json from the installed version folder to',
    '     %LOCALAPPDATA%\\Ujwalam\\data\\profile.local.json and fill in your values. Without it nothing starts.',
    '',
    'Run: the "Ujwalam (alpha)" shortcut, or %LOCALAPPDATA%\\Ujwalam\\Ujwalam.cmd [flags]',
    '  --allow-devices   open the capture devices (game capture, facecam, mic)',
    '  --live            configure the real stream targets (streaming starts only after "yes, on air")',
    '  --mock --no-open --stop-on-stdin   smoke test without Streamer.bot or a browser',
    '  diag              write a redacted diagnostics zip to %LOCALAPPDATA%\\Ujwalam\\data\\diag\\',
    '',
    'Your data lives in %LOCALAPPDATA%\\Ujwalam\\data (projects, logs, feedback, markers, recordings). Overlays and the',
    'profile come from there too: data\\overlays\\ and data\\profile.local.json, or paths in data\\ujwalam.json',
    '{ "overlayRoot": "...", "profile": "..." }. Stream keys stay in Windows Credential Manager.',
    '',
    'Licences: LICENSE (Ujwalam), notices\\ (GPL-2.0 text, source offer, third-party components).',
    '',
  ].join('\r\n');
}

function git(args) {
  try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return null; }
}

function privateScan(files, profile) {
  const scanner = path.join(REPO, 'tools', 'git-hooks', 'private-scan.mjs');
  for (let i = 0; i < files.length; i += 40) {
    const chunk = files.slice(i, i + 40);
    const r = spawnSync(process.execPath, [scanner, '--profile', profile, 'scan-files', ...chunk], { cwd: REPO, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return { ok: false, out: `${r.stdout}${r.stderr}`.trim() };
  }
  return { ok: true };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (['force', 'keep-staging'].includes(k)) o[k] = true;
    else { o[k] = argv[++i]; if (o[k] === undefined) throw new Error(`${a} needs a value`); }
  }
  return o;
}

export async function buildAlpha(opts = {}) {
  const log = opts.log ?? ((s) => console.log(`[package] ${s}`));
  const { rel, build, n, version } = releaseInfo(REPO, opts.n);
  const cfg = resolveConfig({ ...(opts.hostExe ? { exe: opts.hostExe } : {}), ...(opts.runtime ? { runtime: opts.runtime } : {}) });
  const hostExe = path.resolve(opts.hostExe ?? cfg.exe);
  const runtime = opts.runtime ? path.resolve(opts.runtime) : cfg.runtime;
  if (!runtime || !existsSync(runtime)) throw new Error('OBS runtime dir not found (--runtime, UJWALAM_OBS_RUNTIME or host.local.json obsRuntime)');
  if (!existsSync(hostExe)) throw new Error(`host exe not found: ${hostExe} (build it: npm run build:host)`);
  const profile = path.resolve(opts.profile ?? path.join(REPO, 'data', 'profile.local.json'));
  if (!existsSync(profile)) throw new Error('private-term scan needs a profile (--profile or data/profile.local.json); failing closed');
  const outDir = path.resolve(opts.outDir ?? path.join(REPO, 'out', 'dist'));
  const name = `ujwalam-${version}-win64`;
  const zipFile = path.join(outDir, `${name}.zip`);
  if (existsSync(zipFile) && !opts.force) throw new Error(`${path.basename(zipFile)} exists (use --force; the old one is moved to _old/)`);

  const commitShort = git(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown';
  const dirty = (git(['status', '--porcelain']) ?? '') !== '';
  const commit = `${commitShort}${dirty ? ' (with uncommitted changes)' : ''}`;
  const fontNames = fontNamesFromLicenceDoc(readFileSync(path.join(REPO, 'docs', 'licence-headers.md'), 'utf8'));
  if (!fontNames.length) throw new Error('docs/licence-headers.md: no never-publish font names found');

  // 1. what goes in
  const repoRel = repoFiles(REPO);
  const imp = importProblems(REPO, repoRel);
  if (imp.length) throw new Error(`import closure:\n  ${imp.join('\n  ')}`);
  const obs = selectObsRuntime(runtime, { hostExe, disabled: disabledModules(REPO) });
  log(`OBS runtime: ${obs.files.length} files from ${obs.modules.shipped.length} modules (${obs.modules.shipped.join(', ')}); skipped ${obs.skipped.files} files`);

  // 2. stage
  const stageRoot = mkdtempSync(path.join(os.tmpdir(), 'ujw-package-'));
  const stage = path.join(stageRoot, name);
  const files = []; // { rel, abs, origin: 'repo'|'obs'|'host'|'generated' }
  const put = (rel, origin, { src, text } = {}) => {
    const abs = path.join(stage, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    if (src) copyFileSync(src, abs); else writeFileSync(abs, text);
    files.push({ rel, abs, origin });
  };
  try {
    for (const r of repoRel) put(r, 'repo', { src: path.join(REPO, ...r.split('/')) });
    put('bin/ujwalam-host.exe', 'host', { src: hostExe });
    for (const f of obs.files) put(f.dest, 'obs', { src: f.src });
    put('Install-Ujwalam.ps1', 'repo', { src: path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1') });
    put('Ujwalam.cmd', 'repo', { src: path.join(REPO, 'tools', 'package', 'Ujwalam.cmd') });
    const hostSha = sha256(readFileSync(hostExe));
    const release = {
      product: rel.product, version, n, date: build.date, title: build.title, nodeMin: rel.nodeMin,
      vcRuntimeMin: vcRuntimeMin(path.dirname(hostExe)), commit, hostExeSha256: hostSha, obsRuntime: rel.obsRuntime,
      obsModules: obs.modules.shipped, systemDlls: obs.systemDlls,
    };
    put('release.json', 'generated', { text: `${JSON.stringify(release, null, 2)}\n` });
    put('package.json', 'generated', { text: `${JSON.stringify({ name: 'ujwalam', version, private: true, license: 'GPL-2.0-or-later', type: 'module', engines: { node: `>=${rel.nodeMin}` } }, null, 2)}\n` });
    put('CHANGELOG-alpha.md', 'generated', { text: changelogExcerpt(readFileSync(path.join(REPO, 'data', 'release', 'CHANGELOG-alpha.md'), 'utf8'), version) });
    put('README.txt', 'generated', { text: readme({ version, nodeMin: rel.nodeMin }) });
    const gpl = [path.join(runtime, 'data', 'obs-studio', 'license', 'gplv2.txt'), cfg.obsSource && path.join(cfg.obsSource, 'COPYING')].find((f) => f && existsSync(f));
    if (!gpl) throw new Error('GPL-2.0 text not found in the OBS runtime (data/obs-studio/license/gplv2.txt) or source (COPYING)');
    put('notices/GPL-2.0.txt', 'generated', { src: gpl });
    put('notices/SOURCE-OFFER.txt', 'generated', { text: sourceOffer({ version, commit, obs: rel.obsRuntime }) });
    const tp = ['Third-party components in this package (OBS runtime subset). Licence status as recorded; UNVERIFIED items need checking before any distribution.', ''];
    const byComp = new Map();
    for (const f of [...obs.files.map((x) => x.dest)]) {
      const base = f.split('/').pop();
      if (!/\.(dll|exe|pak|dat|bin)$/i.test(base)) continue;
      const [, comp, lic] = componentOf(base);
      const k = `${comp} | ${lic}`;
      if (!byComp.has(k)) byComp.set(k, []);
      byComp.get(k).push(f);
    }
    for (const [k, list] of [...byComp].sort()) tp.push(`${k}`, ...list.map((f) => `    ${f}`), '');
    tp.push('Data files under obs/data/ come from OBS Studio (GPL-2.0-or-later).', 'Windows system DLLs the runtime imports (not shipped): ' + obs.systemDlls.join(', '), '');
    put('notices/THIRD-PARTY.txt', 'generated', { text: tp.join('\n') });
    const list = ['OBS runtime files copied (package path, bytes, reason). Source: the configured OBS runtime dir.', ''];
    for (const f of obs.files) list.push(`${f.dest}\t${statSync(f.src).size}\t${f.why}`);
    list.push('', `Skipped ${obs.skipped.files} runtime files (${obs.skipped.bytes} bytes):`);
    for (const [r, c] of Object.entries(obs.skipped.byReason).sort()) list.push(`  ${c}\t${r}`);
    list.push('', 'Not imported (skipped by name):', ...obs.skipped.notImported.map((r) => `  ${r}`));
    put('notices/OBS-RUNTIME-FILES.txt', 'generated', { text: `${list.join('\n')}\n` });

    // 3. checks on the staged tree
    const rels = files.map((f) => f.rel);
    const problems = [...allowProblems(rels), ...forbiddenProblems(rels, { fontNames })];
    if (problems.length) throw new Error(`package checks failed:\n  ${problems.join('\n  ')}`);
    const scan = privateScan(files.filter((f) => f.origin !== 'obs').map((f) => f.abs), profile);
    if (!scan.ok) throw new Error(`private-term scan failed (terms are never printed):\n${scan.out}`);
    log(`checks passed: allowlist, forbidden paths (fonts: ${fontNames.join(', ')}), import closure, private-term scan over ${files.filter((f) => f.origin !== 'obs').length} non-OBS files`);

    // 4. checksums, zip
    const sums = files.map((f) => `${sha256(readFileSync(f.abs))}  ${f.rel}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
    put('SHA256SUMS.txt', 'generated', { text: `${sums.join('\n')}\n` });
    mkdirSync(outDir, { recursive: true });
    if (existsSync(zipFile)) {
      const old = path.join(outDir, '_old');
      mkdirSync(old, { recursive: true });
      renameSync(zipFile, path.join(old, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`));
    }
    const [y, m, d] = build.date.split('-').map(Number);
    const entries = files.map((f) => ({ name: `${name}/${f.rel}`, file: f.abs })).sort((a, b) => a.name.localeCompare(b.name));
    const z = writeZip(zipFile, entries, { mtime: new Date(y, m - 1, d, 12, 0, 0) });

    // 5. the same path checks on the finished zip
    const inZip = readZip(zipFile).map((e) => e.name);
    const strip = inZip.map((p) => { if (!p.startsWith(`${name}/`)) throw new Error(`zip entry outside the root folder: ${p}`); return p.slice(name.length + 1); });
    const zp = [...allowProblems(strip), ...forbiddenProblems(strip, { fontNames })];
    if (zp.length || strip.length !== files.length) throw new Error(`zip check failed:\n  ${zp.join('\n  ') || `entry count ${strip.length} != ${files.length}`}`);
    const zipSha = sha256(readFileSync(zipFile));
    writeFileSync(`${zipFile}.sha256`, `${zipSha}  ${path.basename(zipFile)}\n`);
    const unpacked = files.reduce((s, f) => s + statSync(f.abs).size, 0);
    const summary = {
      version, zip: zipFile, zipBytes: z.bytes, zipSha256: zipSha, entries: z.entries, unpackedBytes: unpacked,
      byOrigin: Object.fromEntries(['repo', 'host', 'obs', 'generated'].map((o) => [o, files.filter((f) => f.origin === o).length])),
      obsModules: obs.modules.shipped, systemDlls: obs.systemDlls, skipped: obs.skipped, commit,
    };
    writeFileSync(path.join(outDir, `${name}.files.txt`), `${sums.join('\n')}\n`);
    log(`wrote ${zipFile} (${(z.bytes / 1048576).toFixed(1)} MiB, ${z.entries} files, ${(unpacked / 1048576).toFixed(1)} MiB unpacked) sha256 ${zipSha}`);
    if (opts.keepStaging) log(`staging kept: ${stage}`);
    return summary;
  } finally {
    if (!opts.keepStaging) rmSync(stageRoot, { recursive: true, force: true, maxRetries: 3 }); // made by this run
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const s = await buildAlpha({
      n: a.n !== undefined ? Number(a.n) : undefined, hostExe: a['host-exe'], runtime: a.runtime, outDir: a['out-dir'],
      profile: a.profile, force: a.force === true, keepStaging: a['keep-staging'] === true,
    });
    console.log(JSON.stringify({ ...s, zip: path.basename(s.zip) }, null, 2));
  } catch (e) {
    console.error(`[package] FAILED: ${e.message}`);
    process.exit(1);
  }
}
