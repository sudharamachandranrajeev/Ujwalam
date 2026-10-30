// SPDX-License-Identifier: GPL-2.0-or-later
// "Import Meld session" for the studio UI (v1 F1/T2 path). Server side only: the page never supplies a path or a project.
//   1. read the session file named by env UJWALAM_MELD_SESSION or paths.meld_session in data/profile.local.json
//   2. services/project/import-meld.mjs importMeld() -> a NEW project file under <dataDir>/projects (never overwrites)
//   3. host project.plan (dry run) -> counts only go back to the page (no names, ids, paths or device names)
//   4. project.load happens later, behind the typed confirmation (server.mjs)
// Existing scenes, layers, devices and settings of the studio are never modified by the import itself.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importMeld } from '../project/import-meld.mjs';
import { saveProject } from '../project/index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveSessionFile({ env = process.env, profilePath = path.join(REPO, 'data', 'profile.local.json') } = {}) {
  if (typeof env.UJWALAM_MELD_SESSION === 'string' && env.UJWALAM_MELD_SESSION) return path.resolve(env.UJWALAM_MELD_SESSION);
  try {
    const v = JSON.parse(readFileSync(profilePath, 'utf8'))?.paths?.meld_session;
    if (typeof v === 'string' && v && !/^<.*>$/.test(v)) return path.resolve(REPO, v);
  } catch { /* no profile */ }
  return null;
}

// Counts only: arrays become their length, numbers and booleans stay, everything else is dropped.
export function countsOnly(o) {
  const out = {};
  if (o === null || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) out[k] = v.length;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v && typeof v === 'object') { const n = Object.keys(v).length; out[k] = n; }
  }
  return out;
}

/** Returns { file (project path), project, bases, summary } or throws Error with .code in
 *  NO_SESSION | READ_FAILED | IMPORT_FAILED | EXISTS. summary has counts and kinds only. */
export function importSession({ dataDir, sessionFile, now = () => new Date() }) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!sessionFile) throw fail('NO_SESSION', 'no Meld session file configured');
  if (!dataDir) throw fail('NO_SESSION', 'no data dir');
  let session;
  try { session = JSON.parse(readFileSync(sessionFile, 'utf8')); } catch (e) { throw fail('READ_FAILED', `cannot read the session (${e.code ?? 'bad json'})`); }
  let r;
  try { r = importMeld(session, {}); } catch (e) { throw fail('IMPORT_FAILED', String(e.message).slice(0, 120)); }
  const stamp = now().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(dataDir, 'projects');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `meld-import-${stamp}.project.json`);
  if (existsSync(file)) throw fail('EXISTS', 'a project file for this second already exists; try again');
  saveProject(file, r.project);
  const reportFile = file.replace(/\.project\.json$/, '.report.json');
  writeFileSync(reportFile, JSON.stringify(r.report, null, 2) + '\n', { flag: 'wx' }); // local only: holds real paths in report.bases
  const c = r.report.counts ?? {};
  return {
    file, project: r.project, bases: r.report.bases ?? {},
    summary: { counts: countsOnly(c), skipped: r.report.skipped?.length ?? 0, skippedByKind: { ...(r.report.skippedByKind ?? {}) }, file: path.basename(file) },
  };
}
