// SPDX-License-Identifier: GPL-3.0-or-later
// The user's app settings (D284): <dataDir>/settings.json, written by the studio window (Settings) and by the updater
// (Install-Ujwalam.ps1 -ClipsWhenRecording ...). Plain choices, no flags:
//   clips.recording / clips.live: "ask" (ask after each one) | "after" (make clips when it stops) |
//                                 "while" (find moments while it runs, edit them into clips when it stops) | "off"
//   folders.recordings: where recordings are saved (used from the next start); null = <host data>/recordings
//   folders.clips: where finished clips are saved; null = <dataDir>/clips
// Read by the launcher (record-clips.mjs), the UI server and the Python clipper (clip_common.clip_settings).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'settings.json';
export const CLIP_MODES = Object.freeze(['ask', 'after', 'while', 'off']);
export const DEFAULTS = Object.freeze({ clips: Object.freeze({ recording: 'ask', live: 'ask' }), folders: Object.freeze({ recordings: null, clips: null }) });

const inside = (dir, root) => { const r = path.relative(path.resolve(root), path.resolve(dir)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** Why a folder cannot be used, or null. forbidden: folders it must not be inside (the clips corpus, the install). */
export function folderProblem(dir, { forbidden = [] } = {}) {
  if (dir === null) return null;
  if (typeof dir !== 'string' || !dir || dir.length > 400) return 'not a folder path';
  if (!path.isAbsolute(dir) || dir.startsWith('\\\\')) return 'needs a full path on this PC (like D:\\Videos\\Ujwalam)';
  if (/[\0<>"|?*]/.test(dir.slice(2))) return 'has characters Windows does not allow';
  for (const f of forbidden.filter(Boolean)) if (inside(dir, f) || inside(f, dir)) return `may not be inside or around ${f}`;
  return null;
}

/** Settings with defaults for anything missing or invalid (a bad file never stops Ujwalam). */
export function readSettings(dataDir) {
  let j = null;
  try { j = JSON.parse(readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8')); } catch { j = null; }
  const c = j?.clips ?? {}; const f = j?.folders ?? {};
  const mode = (v, d) => (CLIP_MODES.includes(v) ? v : d);
  const dir = (v) => (typeof v === 'string' && !folderProblem(v) ? v : null);
  return {
    exists: j !== null,
    clips: { recording: mode(c.recording, DEFAULTS.clips.recording), live: mode(c.live, DEFAULTS.clips.live) },
    folders: { recordings: dir(f.recordings), clips: dir(f.clips) },
  };
}

/** Problems with a settings change { clips?: {recording?, live?}, folders?: {recordings?, clips?} }; [] when fine. */
export function settingsProblems(patch, { forbidden = [] } = {}) {
  const out = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['settings must be an object'];
  for (const k of Object.keys(patch)) if (!['clips', 'folders'].includes(k)) out.push(`unknown setting ${k}`);
  for (const [k, v] of Object.entries(patch.clips ?? {})) {
    if (!['recording', 'live'].includes(k)) out.push(`unknown clip setting ${k}`);
    else if (!CLIP_MODES.includes(v)) out.push(`clips.${k} must be one of ${CLIP_MODES.join(', ')}`);
  }
  for (const [k, v] of Object.entries(patch.folders ?? {})) {
    if (!['recordings', 'clips'].includes(k)) { out.push(`unknown folder setting ${k}`); continue; }
    const p = folderProblem(v, { forbidden });
    if (p) out.push(`${k} folder ${p}`);
  }
  return out;
}

/** Merge a checked change into the file (atomic write) and return the new settings. */
export function writeSettings(dataDir, patch) {
  const cur = readSettings(dataDir);
  const next = {
    clips: { ...cur.clips, ...(patch.clips ?? {}) },
    folders: { ...cur.folders, ...(patch.folders ?? {}) },
  };
  for (const k of ['recordings', 'clips']) if (typeof next.folders[k] === 'string') mkdirSync(next.folders[k], { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, SETTINGS_FILE);
  writeFileSync(`${f}.tmp`, JSON.stringify({ $comment: 'Ujwalam settings (Settings in the studio window). D284.', ...next }, null, 2));
  renameSync(`${f}.tmp`, f);
  return { exists: true, ...next };
}

export const clipsFolder = (dataDir, s = readSettings(dataDir)) => s.folders.clips ?? path.join(dataDir, 'clips');
export const settingsExist = (dataDir) => existsSync(path.join(dataDir, SETTINGS_FILE));
