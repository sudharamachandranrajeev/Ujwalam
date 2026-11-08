// SPDX-License-Identifier: GPL-3.0-or-later
// The user's app settings (D284): <dataDir>/settings.json, written by the studio window (Settings) and by the updater
// (Install-Ujwalam.ps1 -ClipsWhenRecording ...). Plain choices, no flags:
//   clips.recording / clips.live: "ask" (ask after each one) | "after" (make clips when it stops) |
//                                 "while" (find moments while it runs, edit them into clips when it stops) | "off"
//   clips.matchGate: which matches become clips (D286 proposed, services/clip/match_gate.py):
//                    { top3: true|false (the streamer is in the top 3 on the end screen),
//                      minKills: null (kills rule off) | whole number 1..200 (the streamer's kills in the match) }
//                    a match passes when any rule that is on holds; default { top3: true, minKills: null }
//   folders.recordings: where recordings are saved (used from the next start); null = <host data>/recordings
//   folders.clips: where finished clips are saved; null = <dataDir>/clips
// Read by the launcher (record-clips.mjs), the UI server and the Python clipper (clip_common.clip_settings).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'settings.json';
export const CLIP_MODES = Object.freeze(['ask', 'after', 'while', 'off']);
export const MIN_KILLS = Object.freeze({ min: 1, max: 200 }); // match gate
export const DEFAULTS = Object.freeze({
  clips: Object.freeze({ recording: 'ask', live: 'ask', matchGate: Object.freeze({ top3: true, minKills: null }) }),
  folders: Object.freeze({ recordings: null, clips: null }),
});

// ---- match gate (D286 proposed) begin: clips.matchGate checks and read; also one line each in DEFAULTS,
// readSettings, settingsProblems and writeSettings, marked "match gate"
const okMinKills = (v) => v === null || (Number.isInteger(v) && v >= MIN_KILLS.min && v <= MIN_KILLS.max);

/** Problems with a clips.matchGate value (whole or partial: { top3?, minKills? }); [] when fine. */
export function matchGateProblems(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return ['clips.matchGate must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(g)) {
    if (k === 'top3') { if (typeof v !== 'boolean') out.push('clips.matchGate.top3 must be true or false'); }
    else if (k === 'minKills') { if (!okMinKills(v)) out.push(`clips.matchGate.minKills must be null or a whole number ${MIN_KILLS.min}-${MIN_KILLS.max}`); }
    else out.push(`unknown match gate setting ${k}`);
  }
  return out;
}

/** clips.matchGate from a settings file value: each part checked on its own, defaults for anything missing or bad. */
function readMatchGate(g) {
  const d = DEFAULTS.clips.matchGate;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return { ...d };
  return { top3: typeof g.top3 === 'boolean' ? g.top3 : d.top3, minKills: okMinKills(g.minKills) ? g.minKills : d.minKills };
}
// ---- match gate end

// --- ui settings (D290) -------------------------------------------------------------------------------------------
// ui.motion: how the studio window animates: "system" (follow the Windows animation setting) | "on" | "off".
// Present in the file and in readSettings() only once the user has chosen. UJWALAM_REDUCE_MOTION still overrides.
export const UI_MOTION = Object.freeze(['system', 'on', 'off']);
const uiProblems = (ui) => {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return ['ui must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(ui)) {
    if (k === 'theme' || k === 'effects') out.push(...themeProblems(k, v)); // D293
    else if (k !== 'motion') out.push(`unknown ui setting ${k}`);
    else if (!UI_MOTION.includes(v)) out.push(`ui.motion must be one of ${UI_MOTION.join(', ')}`);
  }
  return out;
};
const uiRead = (j) => {
  const ui = { ...(j?.ui && typeof j.ui === 'object' && UI_MOTION.includes(j.ui.motion) ? { motion: j.ui.motion } : {}), ...themeRead(j?.ui) }; // D293
  return Object.keys(ui).length ? { ui } : {};
};
// --- end ui settings ----------------------------------------------------------------------------------------------

// --- theme settings (D293) ----------------------------------------------------------------------------------------
// ui.theme: id of the studio theme (data/themes/<id>.json, or a custom theme file the user added): lower-case letters,
// digits and dashes. Not checked against the installed list here: the window falls back to "violet-night" when the
// theme is missing. ui.effects: "full" (shadow, glow and extrusion as the theme says) | "reduced" (none).
// Present in the file and in readSettings() only once the user has chosen.
export const UI_EFFECTS = Object.freeze(['full', 'reduced']);
export const THEME_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const themeProblems = (k, v) => {
  if (k === 'theme') return typeof v === 'string' && v.length <= 40 && THEME_ID.test(v) ? [] : ['ui.theme must be a theme id (lower-case letters, digits and dashes, up to 40 characters)'];
  return UI_EFFECTS.includes(v) ? [] : [`ui.effects must be one of ${UI_EFFECTS.join(', ')}`];
};
const themeRead = (ui) => ({
  ...(typeof ui?.theme === 'string' && ui.theme.length <= 40 && THEME_ID.test(ui.theme) ? { theme: ui.theme } : {}),
  ...(UI_EFFECTS.includes(ui?.effects) ? { effects: ui.effects } : {}),
});
// --- end theme settings -------------------------------------------------------------------------------------------

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
    clips: { recording: mode(c.recording, DEFAULTS.clips.recording), live: mode(c.live, DEFAULTS.clips.live), matchGate: readMatchGate(c.matchGate) },
    folders: { recordings: dir(f.recordings), clips: dir(f.clips) },
    ...uiRead(j), // D290
  };
}

/** Problems with a settings change { clips?: {recording?, live?, matchGate?: {top3?, minKills?}},
 *  folders?: {recordings?, clips?} }; [] when fine. */
export function settingsProblems(patch, { forbidden = [] } = {}) {
  const out = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['settings must be an object'];
  for (const k of Object.keys(patch)) if (!['clips', 'folders', 'ui'].includes(k)) out.push(`unknown setting ${k}`);
  if (patch.ui !== undefined) out.push(...uiProblems(patch.ui)); // D290
  for (const [k, v] of Object.entries(patch.clips ?? {})) {
    if (k === 'matchGate') out.push(...matchGateProblems(v)); // match gate
    else if (!['recording', 'live'].includes(k)) out.push(`unknown clip setting ${k}`);
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
    // match gate: matchGate merges part by part, so changing minKills keeps top3 (and the other way round)
    clips: { ...cur.clips, ...(patch.clips ?? {}), matchGate: { ...cur.clips.matchGate, ...(patch.clips?.matchGate ?? {}) } },
    folders: { ...cur.folders, ...(patch.folders ?? {}) },
    ...(cur.ui || patch.ui ? { ui: { ...(cur.ui ?? {}), ...(patch.ui ?? {}) } } : {}), // D290
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
