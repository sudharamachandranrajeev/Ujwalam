// SPDX-License-Identifier: GPL-3.0-or-later
// The user's app settings (D284): <dataDir>/settings.json, written by the studio window (Settings) and by the updater
// (Install-Ujwalam.ps1 -ClipsWhenRecording ...). Plain choices, no flags:
//   clips.recording / clips.live: "ask" (ask after each one) | "after" (make clips when it stops) |
//                                 "while" (find moments while it runs, edit them into clips when it stops) | "off"
//   clips.matchGate: which matches become clips (D286 proposed, services/clip/match_gate.py):
//                    { top3: true|false (the streamer is in the top 3 on the end screen),
//                      minKills: null (kills rule off) | whole number 1..200 (the streamer's kills in the match) }
//                    a match passes when any rule that is on holds; default { top3: true, minKills: null }
//   clips.recordLive: true (default) | false: record H and V while a stream runs, started with the stream and stopped
//                     when it ends, so the reels can be made after it (LC2, D334 proposed; services/studio-ui/server.mjs)
//   clips.reelLengths: the longest and shortest reel of each type (CL1, D350; defaults and the upper bound in
//                      data/clip/reel-length.json, read by services/clip/reel_length.py): { <type>: { minSec, maxSec } },
//                      only the types the user changed; absent = the defaults. A reel longer than its maximum is split.
//   folders.recordings: where recordings are saved (used from the next start); null = <host data>/recordings
//   folders.clips: where finished clips are saved; null = <dataDir>/clips
//   ui.motion (D290), ui.guide (D294 proposed): see the blocks below
//   ui.snap (D335): true = layers dragged on the preview snap to the canvas edges and centre and to the other layers;
//                   absent or false (default) = no snapping
// Read by the launcher (record-clips.mjs), the UI server and the Python clipper (clip_common.clip_settings).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_FILE = 'settings.json';
export const CLIP_MODES = Object.freeze(['ask', 'after', 'while', 'off']);
export const MIN_KILLS = Object.freeze({ min: 1, max: 200 }); // match gate
export const DEFAULTS = Object.freeze({
  clips: Object.freeze({ recording: 'ask', live: 'ask', recordLive: true, matchGate: Object.freeze({ top3: true, minKills: null }) }),
  folders: Object.freeze({ recordings: null, clips: null }),
});

// ---- reel length (CL1, D350) begin: clips.reelLengths checks and read; also marked "reel length" in readSettings,
// settingsProblems and writeSettings. Same rules as services/clip/reel_length.py limits_problems().
export const REEL_LENGTH_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'clip', 'reel-length.json');
export const REEL_MIN_MAX_SEC = 5;
let reelDefaultsCache = null;
/** { limitMaxSec, types: [{ id, label, hint, minSec, maxSec }] } from data/clip/reel-length.json, or null when unreadable. */
export function reelDefaults(file = REEL_LENGTH_FILE) {
  if (file === REEL_LENGTH_FILE && reelDefaultsCache) return reelDefaultsCache;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const d = { limitMaxSec: Number(j.limitMaxSec), types: j.types.map((t) => ({ id: String(t.id), label: String(t.label ?? t.id), hint: String(t.hint ?? ''), minSec: Number(t.minSec), maxSec: Number(t.maxSec) })) };
    if (!(d.limitMaxSec > 0) || d.types.some((t) => !(t.minSec >= 0 && t.minSec <= t.maxSec && t.maxSec <= d.limitMaxSec))) return null;
    if (file === REEL_LENGTH_FILE) reelDefaultsCache = d;
    return d;
  } catch { return null; }
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Problems with a clips.reelLengths value { <type>: { minSec, maxSec } } (both numbers for each type); [] when fine. */
export function reelLengthProblems(v, d = reelDefaults()) {
  if (!d) return ['reel lengths are not available (data/clip/reel-length.json is missing)'];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['clips.reelLengths must be an object'];
  const out = [];
  for (const [k, x] of Object.entries(v)) {
    if (!d.types.some((t) => t.id === k)) { out.push(`unknown reel type ${k}`); continue; }
    if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join() !== 'maxSec,minSec') out.push(`clips.reelLengths.${k} needs minSec and maxSec`);
    else if (!isNum(x.minSec) || !isNum(x.maxSec)) out.push(`clips.reelLengths.${k} lengths must be numbers`);
    else if (x.minSec < 0) out.push(`${k}: the minimum cannot be below 0 s`);
    else if (x.maxSec < REEL_MIN_MAX_SEC) out.push(`${k}: the maximum cannot be below ${REEL_MIN_MAX_SEC} s`);
    else if (x.maxSec > d.limitMaxSec) out.push(`${k}: the maximum cannot be above ${d.limitMaxSec} s`);
    else if (x.minSec > x.maxSec) out.push(`${k}: the minimum cannot be longer than the maximum`);
  }
  return out;
}

/** The valid per-type values of a settings file value (the rest is ignored). */
function readReelLengths(v) {
  const d = reelDefaults();
  if (!d || !v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, x] of Object.entries(v)) if (reelLengthProblems({ [k]: x }, d).length === 0) out[k] = { minSec: x.minSec, maxSec: x.maxSec };
  return out;
}

/** Defaults + the user's values per type, for the Settings page: { limitMaxSec, types: [{ id, label, hint, minSec, maxSec,
 *  defaultMinSec, defaultMaxSec }] }, or null when the defaults file is unreadable. */
export function reelLengthInfo(dataDir) {
  const d = reelDefaults();
  if (!d) return null;
  const mine = readReelLengths(readSettings(dataDir).clips.reelLengths);
  return { limitMaxSec: d.limitMaxSec, types: d.types.map((t) => ({ id: t.id, label: t.label, hint: t.hint, defaultMinSec: t.minSec, defaultMaxSec: t.maxSec,
    minSec: mine[t.id]?.minSec ?? t.minSec, maxSec: mine[t.id]?.maxSec ?? t.maxSec })) };
}

/** The reelLengths to store after a patch: per type, a value equal to the default is dropped; null when none is left. */
function mergeReelLengths(cur, patch) {
  const d = reelDefaults();
  const all = { ...(cur ?? {}), ...(patch ?? {}) };
  for (const [k, x] of Object.entries(all)) { const t = d?.types.find((y) => y.id === k); if (!t || (x.minSec === t.minSec && x.maxSec === t.maxSec)) delete all[k]; }
  return Object.keys(all).length ? all : null;
}
// ---- reel length end

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

// ---- guide settings (D294 proposed) begin: ui.guide = { tips, dismissed, tourDone } for the tips and the welcome tour
// (app/studio/src/guide.*, data/guide/*.json). tips: show tips and hints; dismissed: ids ticked "Don't show again"
// (short slugs from the data files, at most 200); tourDone: the welcome tour was finished or skipped for good.
// Also marked "guide" below: one line each in uiProblems, uiRead, mergeUi and settingsRoute (server.mjs).
export const GUIDE_DEFAULTS = Object.freeze({ tips: true, dismissed: Object.freeze([]), tourDone: false });
export const GUIDE_MAX_IDS = 200;
const GUIDE_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** Problems with a ui.guide value (whole or partial: { tips?, dismissed?, tourDone? }); [] when fine. */
export function guideProblems(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return ['ui.guide must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(g)) {
    if (k === 'tips' || k === 'tourDone') { if (typeof v !== 'boolean') out.push(`ui.guide.${k} must be true or false`); }
    else if (k === 'dismissed') {
      if (!Array.isArray(v)) out.push('ui.guide.dismissed must be a list of ids');
      else if (v.length > GUIDE_MAX_IDS) out.push(`ui.guide.dismissed holds at most ${GUIDE_MAX_IDS} ids`);
      else if (v.some((x) => typeof x !== 'string' || !GUIDE_ID.test(x))) out.push('ui.guide.dismissed ids must be short lower-case slugs (a-z, 0-9, -)');
    } else out.push(`unknown guide setting ${k}`);
  }
  return out;
}

/** ui.guide from a settings file value: each part checked on its own, defaults for anything missing or bad. */
function readGuide(g) {
  const d = GUIDE_DEFAULTS;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return { tips: d.tips, dismissed: [], tourDone: d.tourDone };
  const ids = Array.isArray(g.dismissed) ? [...new Set(g.dismissed.filter((x) => typeof x === 'string' && GUIDE_ID.test(x)))].slice(0, GUIDE_MAX_IDS) : [];
  return { tips: typeof g.tips === 'boolean' ? g.tips : d.tips, dismissed: ids, tourDone: typeof g.tourDone === 'boolean' ? g.tourDone : d.tourDone };
}

/** A settings patch that changes nothing but ui.guide (allowed while live: it only changes what the window shows). */
export const guideOnly = (patch) => !!patch && typeof patch === 'object' && Object.keys(patch).length === 1 && !!patch.ui && typeof patch.ui === 'object'
  && !Array.isArray(patch.ui) && Object.keys(patch.ui).length === 1 && patch.ui.guide !== undefined;
// ---- guide settings end

const uiProblems = (ui) => {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return ['ui must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(ui)) {
    if (k === 'theme' || k === 'effects') out.push(...themeProblems(k, v)); // D293
    else if (k === 'guide') out.push(...guideProblems(v)); // guide
    else if (k === 'snap') { if (typeof v !== 'boolean') out.push('ui.snap must be true or false'); } // D335
    else if (k !== 'motion') out.push(`unknown ui setting ${k}`);
    else if (!UI_MOTION.includes(v)) out.push(`ui.motion must be one of ${UI_MOTION.join(', ')}`);
  }
  return out;
};
const uiRead = (j) => {
  const ui = { ...(j?.ui && typeof j.ui === 'object' && UI_MOTION.includes(j.ui.motion) ? { motion: j.ui.motion } : {}), ...themeRead(j?.ui) }; // D293
  if (j?.ui && typeof j.ui === 'object' && j.ui.guide !== undefined) ui.guide = readGuide(j.ui.guide); // guide
  if (typeof j?.ui?.snap === 'boolean') ui.snap = j.ui.snap; // D335
  return Object.keys(ui).length ? { ui } : {};
};
/** ui after a checked patch: motion replaces; guide merges part by part (dismissed is replaced whole, de-duplicated). */
const mergeUi = (cur, patch) => {
  const out = { ...(cur ?? {}), ...(patch ?? {}) };
  if (patch?.guide !== undefined) out.guide = readGuide({ ...(cur?.guide ?? {}), ...patch.guide }); // guide
  return out;
};
// --- end ui settings ----------------------------------------------------------------------------------------------

// --- theme settings (D293) ----------------------------------------------------------------------------------------
// ui.theme: id of the studio theme (data/themes/<id>.json, or a custom theme file the user added): lower-case letters,
// digits and dashes. Not checked against the installed list here: the window falls back to "violet-night" when the
// theme is missing. ui.effects: "full" (shadow, glow and extrusion as the theme says) | "reduced" (none) |
// "performance" (High performance, 2026-11-10: none, and no gradients, backdrop pattern, hover overlays or animation).
// Present in the file and in readSettings() only once the user has chosen.
export const UI_EFFECTS = Object.freeze(['full', 'reduced', 'performance']);
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
    clips: { recording: mode(c.recording, DEFAULTS.clips.recording), live: mode(c.live, DEFAULTS.clips.live),
      recordLive: typeof c.recordLive === 'boolean' ? c.recordLive : DEFAULTS.clips.recordLive, matchGate: readMatchGate(c.matchGate),
      ...(Object.keys(readReelLengths(c.reelLengths)).length ? { reelLengths: readReelLengths(c.reelLengths) } : {}) }, // reel length
    folders: { recordings: dir(f.recordings), clips: dir(f.clips) },
    ...uiRead(j), // D290
  };
}

/** Problems with a settings change { clips?: {recording?, live?, recordLive?, matchGate?: {top3?, minKills?}},
 *  folders?: {recordings?, clips?} }; [] when fine. */
export function settingsProblems(patch, { forbidden = [] } = {}) {
  const out = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['settings must be an object'];
  for (const k of Object.keys(patch)) if (!['clips', 'folders', 'ui'].includes(k)) out.push(`unknown setting ${k}`);
  if (patch.ui !== undefined) out.push(...uiProblems(patch.ui)); // D290
  for (const [k, v] of Object.entries(patch.clips ?? {})) {
    if (k === 'matchGate') out.push(...matchGateProblems(v)); // match gate
    else if (k === 'reelLengths') out.push(...reelLengthProblems(v)); // reel length
    else if (k === 'recordLive') { if (typeof v !== 'boolean') out.push('clips.recordLive must be true or false'); } // LC2
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
    ...(cur.ui || patch.ui ? { ui: mergeUi(cur.ui, patch.ui) } : {}), // D290, guide
  };
  // reel length: per type merge, so changing one type keeps the others; a value equal to its default is not stored
  const rls = mergeReelLengths(cur.clips.reelLengths, patch.clips?.reelLengths);
  if (rls) next.clips.reelLengths = rls; else delete next.clips.reelLengths;
  for (const k of ['recordings', 'clips']) if (typeof next.folders[k] === 'string') mkdirSync(next.folders[k], { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, SETTINGS_FILE);
  writeFileSync(`${f}.tmp`, JSON.stringify({ $comment: 'Ujwalam settings (Settings in the studio window). D284.', ...next }, null, 2));
  renameSync(`${f}.tmp`, f);
  return { exists: true, ...next };
}

export const clipsFolder = (dataDir, s = readSettings(dataDir)) => s.folders.clips ?? path.join(dataDir, 'clips');
export const settingsExist = (dataDir) => existsSync(path.join(dataDir, SETTINGS_FILE));
