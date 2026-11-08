// SPDX-License-Identifier: GPL-3.0-or-later
// Entry point of an installed (or unzipped) Alpha build, run by Ujwalam.cmd. Same as `npm run alpha` from a checkout,
// with every path taken from the install dir and the user's data dir instead of the repo:
//   install dir   two levels above this file (holds release.json, bin/ujwalam-host.exe, obs/)
//   data root     UJWALAM_DATA_ROOT, else %LOCALAPPDATA%\Ujwalam\data (never inside the install dir)
//     core/       event-core data dir (--data-dir): projects/, logs/, flags.local.json, host.json ...
//     host/       host data dir (UJWALAM_HOST_DATA): module config, markers/, recordings/
//     feedback/   feedback captures (--feedback-dir)
//     diag/       diagnostics bundles
//     ujwalam.json  optional user config: { "overlayRoot": "<dir>", "profile": "<file>" } (relative to the data root)
//     profile.local.json  default profile (only when ujwalam.json names none)
//   Overlay root and profile come only from the data root or ujwalam.json, never from the package.
// Usage: Ujwalam.cmd [launcher flags...]   e.g. --mock --no-open --stop-on-stdin, --allow-devices, --live
//        Ujwalam.cmd diag [--out FILE]     diagnostics bundle (tools/diag/bundle.mjs), no host or UI needed
// Node is checked first (release.json nodeMin) and the launcher is loaded only after the check passes.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function nodeOk(version, min) {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const a = p(version);
  const b = p(min);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return true;
}

export function dataRootFrom(env = process.env) {
  if (env.UJWALAM_DATA_ROOT) return path.resolve(env.UJWALAM_DATA_ROOT);
  if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set; set UJWALAM_DATA_ROOT');
  return path.join(path.resolve(env.LOCALAPPDATA), 'Ujwalam', 'data');
}

/** Paths, environment and launcher argv for an installed run (pure apart from reading ujwalam.json; tested). */
export function installedSpec({ install = INSTALL, dataRoot, userArgs = [] }) {
  const inside = (p) => { const r = path.relative(install, p); return !r.startsWith('..') && !path.isAbsolute(r); };
  if (inside(dataRoot)) throw new Error('the data root must not be inside the install dir');
  let cfg = {};
  const cfgFile = path.join(dataRoot, 'ujwalam.json');
  if (existsSync(cfgFile)) cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const fromCfg = (k, def) => (typeof cfg[k] === 'string' && cfg[k] && !/^<.*>$/.test(cfg[k]) ? path.resolve(dataRoot, cfg[k]) : def);
  // overlayRoot names the folder that holds overlays/, brand/ and kit/ (host overlayRootProblem). Installs from
  // 2026-11-03 wrote the overlays/ folder itself; that form is read as its parent (D278), the file is not rewritten.
  const named = fromCfg('overlayRoot', path.join(dataRoot, 'overlays'));
  const overlayRoot = path.basename(named).toLowerCase() === 'overlays' && existsSync(named) && !existsSync(path.join(named, 'overlays'))
    ? path.dirname(named) : named;
  const profile = fromCfg('profile', path.join(dataRoot, 'profile.local.json'));
  for (const [k, p] of [['overlayRoot', overlayRoot], ['profile', profile]]) {
    if (inside(p)) throw new Error(`${k} must not point into the install dir`);
  }
  const dirs = { core: path.join(dataRoot, 'core'), host: path.join(dataRoot, 'host'), feedback: path.join(dataRoot, 'feedback'), diag: path.join(dataRoot, 'diag') };
  const env = {
    UJWALAM_OBS_RUNTIME: path.join(install, 'obs'),
    UJWALAM_HOST_EXE: path.join(install, 'bin', 'ujwalam-host.exe'),
    UJWALAM_HOST_DATA: dirs.host,
    UJWALAM_OVERLAY_ROOT: overlayRoot,
  };
  const has = (f) => userArgs.includes(f);
  const argv = ['--alpha'];
  if (!has('--data-dir')) argv.push('--data-dir', dirs.core);
  if (!has('--feedback-dir')) argv.push('--feedback-dir', dirs.feedback);
  if (!has('--profile')) argv.push('--profile', profile);
  argv.push(...userArgs.filter((a) => a !== '--alpha'));
  return { install, dataRoot, dirs, overlayRoot, profile, env, argv };
}

export async function main(args = process.argv.slice(2)) {
  let release;
  try { release = JSON.parse(readFileSync(path.join(INSTALL, 'release.json'), 'utf8')); } catch { console.log('[ujwalam] release.json missing: run Ujwalam.cmd from an installed or unzipped build'); return 2; }
  if (!nodeOk(process.versions.node, release.nodeMin)) {
    console.log(`[ujwalam] Node.js ${release.nodeMin} or newer is needed (found ${process.versions.node}). Install it from nodejs.org; nothing was started.`);
    return 9;
  }
  let dataRoot;
  try { dataRoot = dataRootFrom(); } catch (e) { console.log(`[ujwalam] ${e.message}`); return 2; }
  if (args[0] === 'diag') {
    const spec = installedSpec({ dataRoot, userArgs: [] });
    const { main: diag } = await import(pathToFileURL(path.join(INSTALL, 'tools', 'diag', 'bundle.mjs')).href);
    const has = (f) => args.includes(f);
    return diag([
      '--data-dir', spec.dirs.core, '--host-data', spec.dirs.host, '--profile', spec.profile, '--release', path.join(INSTALL, 'release.json'),
      ...(has('--out') ? [] : ['--out', path.join(spec.dirs.diag, `ujwalam-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`)]),
      ...args.slice(1),
    ]);
  }
  let spec;
  try { spec = installedSpec({ dataRoot, userArgs: args }); } catch (e) { console.log(`[ujwalam] ${e.message}`); return 2; }
  for (const d of Object.values(spec.dirs)) mkdirSync(d, { recursive: true });
  if (!existsSync(spec.profile)) {
    // The alpha project needs the profile's placeholder values; the package never carries a filled-in one.
    console.log(`[ujwalam] no profile at ${spec.profile}. Copy ${path.join(INSTALL, 'data', 'profile.example.json')} there`);
    console.log('[ujwalam] and fill in your values (it stays on this PC), or name another file with --profile. Nothing was started.');
    return 2;
  }
  Object.assign(process.env, spec.env);
  console.log(`[ujwalam] ${release.version} from ${spec.install}; data ${spec.dataRoot}; overlays ${existsSync(spec.overlayRoot) ? spec.overlayRoot : 'off (no overlay folder)'}; profile ${existsSync(spec.profile) ? 'found' : 'none'}`);
  const { main: launch } = await import(pathToFileURL(path.join(INSTALL, 'services', 'studio-ui', 'launch.mjs')).href);
  return launch(spec.argv);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
