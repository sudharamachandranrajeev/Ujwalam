#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Builds ujwalam-host into out/host/build (gitignored).
//   node app/host/tools/build.mjs [--reconfigure]
// OBS paths come from app/lib/config.mjs (env or app/host/host.local.json). cmake, ninja and cl come from the
// current developer prompt, or from VS Build Tools' vcvars64.bat found through vswhere (nothing is installed).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig, REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const cfg = resolveConfig();
if (!cfg.runtime || !cfg.obsSource) {
  console.error('set obsRuntime and obsSource in app/host/host.local.json (template host.example.json) or UJWALAM_OBS_RUNTIME / UJWALAM_OBS_SOURCE');
  process.exit(64);
}
const onPath = (exe) => spawnSync('where', [exe], { stdio: 'ignore', shell: true, windowsHide: true }).status === 0;

function vcvars() {
  const pf86 = process.env['ProgramFiles(x86)'];
  const vswhere = pf86 && path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!vswhere || !existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  const dir = r.stdout?.trim().split(/\r?\n/)[0];
  const bat = dir && path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return bat && existsSync(bat) ? bat : null;
}

const build = path.relative(REPO_ROOT, cfg.buildDir);
const src = path.relative(REPO_ROOT, HOST_DIR);
const steps = [];
if (process.argv.includes('--reconfigure') || !existsSync(path.join(cfg.buildDir, 'build.ninja'))) {
  steps.push(`cmake -S "${src}" -B "${build}" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DOBS_SOURCE_DIR="${cfg.obsSource}" -DOBS_RUNTIME_DIR="${cfg.runtime}"`);
}
steps.push(`cmake --build "${build}"`);
let line = steps.join(' && ');
if (!(onPath('cmake') && onPath('cl'))) {
  const bat = vcvars();
  if (!bat) {
    console.error('cmake/cl not on PATH and VS Build Tools (vcvars64.bat) not found');
    process.exit(69);
  }
  line = `call "${bat}" >nul && ${line}`;
}
const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: REPO_ROOT, stdio: 'inherit', windowsVerbatimArguments: true, windowsHide: true });
if (r.status === 0) console.log(`built ${cfg.exe}`);
process.exit(r.status ?? 1);
