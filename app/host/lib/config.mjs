// SPDX-License-Identifier: GPL-2.0-or-later
// Resolves where the host exe, the OBS runtime and the host data live. No user paths are hardcoded:
//   explicit option > environment > app/host/host.local.json (gitignored; template host.example.json) > default.
//   buildDir   UJWALAM_HOST_BUILD     "buildDir"   default <repo>/out/host/build (a second dir lets you build while
//                                                 another host from the first dir is running)
//   exe        UJWALAM_HOST_EXE       "exe"        default <buildDir>/ujwalam-host.exe
//   runtime    UJWALAM_OBS_RUNTIME    "obsRuntime" required (vendored OBS runtime dir)
//   obsSource  UJWALAM_OBS_SOURCE     "obsSource"  needed only to build
//   dataDir    UJWALAM_HOST_DATA      "dataDir"    default <repo>/out/host/data (dev; gitignored)
//   discovery  UJWALAM_HOST_DISCOVERY "discovery"  default <dataDir>/host.json
//   recordings UJWALAM_HOST_RECORDINGS "recordings" default <dataDir>/recordings
//   overlayRoot UJWALAM_OVERLAY_ROOT  "overlayRoot" default <repo>/legacy (the overlay folder: overlays/, brand/, kit/;
//                                                 read-only, gitignored). overlayScript is app/host/overlay/child.mjs
// Relative paths in host.local.json resolve against the repo root.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(HOST_DIR, '..', '..');

function local() {
  const f = path.join(HOST_DIR, 'host.local.json');
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function resolveConfig(opts = {}) {
  const l = local();
  const pick = (opt, envName, key, def) => {
    const v = opt ?? (process.env[envName] || undefined) ?? l[key] ?? def;
    return v == null ? undefined : path.resolve(REPO_ROOT, v);
  };
  const buildDir = pick(opts.buildDir, 'UJWALAM_HOST_BUILD', 'buildDir', path.join('out', 'host', 'build'));
  const exe = pick(opts.exe, 'UJWALAM_HOST_EXE', 'exe', path.join(buildDir, 'ujwalam-host.exe'));
  const runtime = pick(opts.runtime, 'UJWALAM_OBS_RUNTIME', 'obsRuntime', undefined);
  const obsSource = pick(opts.obsSource, 'UJWALAM_OBS_SOURCE', 'obsSource', undefined);
  const dataDir = pick(opts.dataDir, 'UJWALAM_HOST_DATA', 'dataDir', path.join('out', 'host', 'data'));
  const discovery = pick(opts.discovery, 'UJWALAM_HOST_DISCOVERY', 'discovery', path.join(dataDir, 'host.json'));
  const recordings = pick(opts.recordings, 'UJWALAM_HOST_RECORDINGS', 'recordings', path.join(dataDir, 'recordings'));
  const overlayRoot = pick(opts.overlayRoot, 'UJWALAM_OVERLAY_ROOT', 'overlayRoot', 'legacy');
  const overlayScript = path.join(HOST_DIR, 'overlay', 'child.mjs');
  return { exe, runtime, obsSource, dataDir, discovery, recordings, buildDir, overlayRoot, overlayScript };
}
