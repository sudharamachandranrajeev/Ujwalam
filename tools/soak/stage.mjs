// SPDX-License-Identifier: GPL-3.0-or-later
// A staged copy of the Node runtime (services, overlay child, host client lib, data, registry, control page), laid out
// like the repo, for the live soak (LU8) and the data hot-reload tests (LU2): the soak changes data files in the
// stage the way an update writes into an install, and never touches the repo's own data files.
//   stageRuntime(dir, { eventCoreData? }) -> { root, dataFile(rel), overlayScript }
// eventCoreData: written as paths.event_core_data of the stage's data/profile.local.json (nothing else is in it), so
// processes started from the stage that resolve the data dir through the profile (the overlay child) use the run's
// data dir instead of the user's. Local and private files of the repo (*.local.*, games/<id>/local) are not copied.
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STAGE_DIRS = Object.freeze(['services', path.join('app', 'host', 'overlay'), path.join('app', 'host', 'lib'), path.join('app', 'host', 'projects'), 'data', 'registry', 'ui']);
export const STAGE_FILES = Object.freeze(['package.json', 'release.json']);

const skip = (src) => {
  const b = path.basename(src);
  if (b === '__pycache__' || b === 'node_modules' || /\.local\./.test(b) || /\.pyc$/.test(b)) return false;
  const rel = path.relative(REPO, src).split(path.sep);
  if (rel[0] === 'data' && rel[1] === 'games' && rel.includes('local')) return false;
  if (rel[0] === 'data' && (rel[1] === 'labels' || rel[1] === 'stream assets')) return false;
  return true;
};

export function stageRuntime(dir, { eventCoreData = null, repo = REPO } = {}) {
  const root = path.resolve(dir);
  mkdirSync(root, { recursive: true });
  for (const d of STAGE_DIRS) {
    const src = path.join(repo, d);
    if (existsSync(src)) cpSync(src, path.join(root, d), { recursive: true, filter: skip });
  }
  for (const f of STAGE_FILES) if (existsSync(path.join(repo, f))) cpSync(path.join(repo, f), path.join(root, f));
  if (eventCoreData) writeFileSync(path.join(root, 'data', 'profile.local.json'), JSON.stringify({ paths: { event_core_data: path.resolve(eventCoreData) } }, null, 2));
  return { root, dataFile: (rel) => path.join(root, 'data', rel), overlayScript: path.join(root, 'app', 'host', 'overlay', 'child.mjs') };
}

/** Atomic replace (temp file + rename), the way most editors and installers save. A rename that Windows refuses for a
 *  moment (the target open in another process) is retried for up to 2 s. */
export function writeViaRename(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
