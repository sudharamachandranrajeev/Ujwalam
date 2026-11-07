#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the Qt studio shell (app/studio) into out/studio/build (gitignored).
//   node app/studio/tools/build.mjs [--reconfigure]
// Qt comes from UJWALAM_QT_DIR or app/studio/studio.local.json { "qtDir": ".../6.8.3/msvc2022_64" } (template
// studio.example.json). cmake, ninja and cl come from the current developer prompt or VS Build Tools' vcvars64.bat
// (found through vswhere, as the host build). Nothing is installed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(STUDIO_DIR, '..', '..');
export const BUILD_DIR = path.join(REPO_ROOT, 'out', 'studio', 'build');
export const EXE = path.join(BUILD_DIR, 'ujwalam-studio.exe');

export function qtDir() {
  if (process.env.UJWALAM_QT_DIR) return path.resolve(process.env.UJWALAM_QT_DIR);
  const f = path.join(STUDIO_DIR, 'studio.local.json');
  if (!existsSync(f)) return null;
  const v = JSON.parse(readFileSync(f, 'utf8')).qtDir;
  return typeof v === 'string' && v ? path.resolve(REPO_ROOT, v) : null;
}

function vcvars() {
  const pf86 = process.env['ProgramFiles(x86)'];
  const vswhere = pf86 && path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!vswhere || !existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  const dir = r.stdout?.trim().split(/\r?\n/)[0];
  const bat = dir && path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return bat && existsSync(bat) ? bat : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const qt = qtDir();
  if (!qt || !existsSync(path.join(qt, 'lib', 'cmake', 'Qt6'))) {
    console.error('set qtDir in app/studio/studio.local.json (template studio.example.json) or UJWALAM_QT_DIR to a Qt 6.8 msvc2022_64 kit');
    process.exit(64);
  }
  const build = path.relative(REPO_ROOT, BUILD_DIR);
  const src = path.relative(REPO_ROOT, STUDIO_DIR);
  const steps = [];
  if (process.argv.includes('--reconfigure') || !existsSync(path.join(BUILD_DIR, 'build.ninja'))) {
    steps.push(`cmake -S "${src}" -B "${build}" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_PREFIX_PATH="${qt}"`);
  }
  steps.push(`cmake --build "${build}"`);
  const bat = vcvars();
  if (!bat) { console.error('VS Build Tools (vcvars64.bat) not found'); process.exit(69); }
  const line = `call "${bat}" >nul && ${steps.join(' && ')}`;
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: REPO_ROOT, stdio: 'inherit', windowsVerbatimArguments: true, windowsHide: true });
  if (r.status === 0) console.log(`built ${EXE}`);
  process.exit(r.status ?? 1);
}
