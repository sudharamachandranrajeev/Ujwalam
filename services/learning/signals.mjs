// SPDX-License-Identifier: GPL-3.0-or-later
// LL2 learning signals that are read from files the user already changes (D338). Node stdlib only; no UI.
//
//   My clips (the clips folder): the clip pipeline lists every finished clip in <dataDir>/clips/uploads.json
//   (services/clip/clip_publish.py). Each listed clip is followed from the first time it is seen:
//     - renamed: its file is gone, and a file with the same identity (NTFS file id; size + mtime where there is none)
//       is in its day folder or another day folder of the same clips folder. The run folder's own hard link is never
//       looked at, so it cannot be mistaken for the renamed clip.
//     - deleted: its file is gone and no such file is found (moved out of the clips folder counts as deleted).
//     - kept: still there at the first check of a later app start than the one it was published in (the user closed
//       and reopened Ujwalam without deleting it). Once per clip; a later delete adds a "deleted" row.
//   Clips already missing the first time they are seen get no row (when or how they went is unknown).
//   Feedback hotkey (Ctrl+Alt+F): the host writes a moment folder <feedbackDir>/<date>/<time>/moment.json; each new
//   moment becomes one "feedback" row (source hotkey). Its note (tag and severity, never the text) is labelled by the
//   UI server when it is saved (server.mjs).
// A clip's or moment's state moves on only after its row is written, so a failed write is retried on the next pass
// (Codex review). Moments use a checkpoint (the newest moment labelled), not a trimmed list of ids.
// Posting and chat-feedback rows are written where those happen (posting/youtube.mjs, tools/collect-stream-feedback.mjs).
//
// Runs in the launcher: once at start (with the cap check) and then every minute; stats and small JSON reads only.
// Pure background writing with no visible effect, so it has no flag (D338). State: <store>/signals-state.json.

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createLearningStore, sessionId } from './store.mjs';

export const STATE_FILE = 'signals-state.json';
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const VIDEO = /\.(mp4|mov|mkv|webm)$/i;
const TIME_DIR = /^(\d{6})(?:-([1-9]\d?))?$/;
const MAX_MOMENT_BYTES = 65_536;

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** { ino (string, '0' when the file system has none), size, mtimeMs } or null. */
function identity(file) {
  try {
    const st = statSync(file, { bigint: true });
    if (!st.isFile()) return null;
    return { ino: String(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
  } catch { return null; }
}
const sameFile = (a, b) => (a.ino !== '0' && b.ino !== '0' ? a.ino === b.ino && a.size === b.size : a.size === b.size && a.mtimeMs === b.mtimeMs);

// Moment ids sort by this key: <date>/<HHMMSS>-<nn>, the host's same-second copies -2 .. -99 after the first (-01).
export function momentKey(id) {
  const m = typeof id === 'string' ? /^(\d{4}-\d{2}-\d{2})\/(\d{6})(?:-([1-9]\d?))?$/.exec(id) : null;
  return m ? `${m[1]}/${m[2]}-${String(m[3] ?? 1).padStart(2, '0')}` : null;
}
// State before the checkpoint kept a list of ids (trimmed at 5000): its newest id becomes the mark.
const markOf = (ids) => ids.map(momentKey).filter(Boolean).sort().at(-1) ?? '';

function loadState(file) {
  const s = readJson(file);
  return {
    v: 1,
    clips: isPlain(s?.clips) ? s.clips : {},
    momentMark: typeof s?.momentMark === 'string' ? s.momentMark : markOf(Array.isArray(s?.moments) ? s.moments : []),
  };
}
function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  renameSync(tmp, file);
}

const dayOf = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const clipSession = (row, at) => sessionId(row.run) || `day-${dayOf(row.addedAt) ?? at.toISOString().slice(0, 10)}`;

// Candidate files for a renamed clip: video files in the day folders directly under the clips folder.
function candidates(clipsRoot) {
  const out = [];
  let days = [];
  try { days = readdirSync(clipsRoot).filter((d) => DAY_DIR.test(d)); } catch { return out; }
  for (const d of days) {
    const dir = path.join(clipsRoot, d);
    let names = [];
    try { if (!lstatSync(dir).isDirectory()) continue; names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (VIDEO.test(n)) out.push(path.join(dir, n));
  }
  return out;
}

/**
 * One pass over uploads.json. opts: { dataDir, store, state, startedAt (ms, this app start), now () -> Date }.
 * Mutates state.clips; returns the rows written.
 */
export function reconcileClips({ dataDir, store, state, startedAt = 0, now = () => new Date() }) {
  const doc = readJson(path.join(dataDir, 'clips', 'uploads.json'));
  const rows = Array.isArray(doc?.files) ? doc.files.filter((r) => isPlain(r) && typeof r.file === 'string' && path.isAbsolute(r.file)) : [];
  const written = [];
  const at = now();
  // true when the row was written. The clip's state moves on only then, so a failed write is tried again next pass
  // (Codex review of D338).
  const label = (action, row, ref) => { const r = store.add({ action, source: 'my-clips', session: clipSession(row, at), ref: { run: row.run ?? null, kind: row.kind ?? null, ...ref }, at }); if (typeof r === 'string') return false; written.push(r); return true; };
  let cands = null;
  const tracked = () => new Set(Object.values(state.clips).filter((c) => c.state === 'present').map((c) => path.resolve(c.file).toLowerCase()));
  for (const row of rows) {
    const key = row.file;
    let st = state.clips[key];
    if (!st) {
      const id = identity(row.file);
      st = state.clips[key] = id ? { file: row.file, ...id, state: 'present', kept: false } : { file: row.file, state: 'missing-at-first-sight' };
    }
    if (st.state !== 'present') continue;
    if (!identity(st.file)) {
      // Gone: renamed in place (or into another day folder), or deleted.
      cands ??= candidates(path.dirname(path.dirname(row.file)));
      const busy = tracked();
      const hit = cands.find((f) => !busy.has(path.resolve(f).toLowerCase()) && (() => { const c = identity(f); return c && sameFile(st, c); })());
      if (!hit) { if (label('deleted', row, { file: path.basename(st.file) })) st.state = 'deleted'; continue; }
      if (!label('renamed', row, { from: path.basename(st.file), to: path.basename(hit) })) continue;
      st.file = hit;
    }
    // Published before this app start and still here: kept. Checked on every pass, not only the first, so a kept row
    // whose write failed at start is written later (the clip was here at start too: a pass runs right at start).
    const addedMs = Date.parse(row.addedAt ?? '');
    if (!st.kept && Number.isFinite(addedMs) && addedMs < startedAt && label('kept', row, { file: path.basename(st.file) })) st.kept = true;
  }
  return written;
}

// Moment folders (no links) with a moment.json, newer than the mark: [{ id, key, file }] sorted oldest first.
function momentsAfter(feedbackDir, mark) {
  const real = (p, dir) => { try { const s = lstatSync(p); return !s.isSymbolicLink() && (dir ? s.isDirectory() : s.isFile() && s.size <= MAX_MOMENT_BYTES); } catch { return false; } };
  const out = [];
  let days = [];
  try { days = readdirSync(feedbackDir).filter((d) => DAY_DIR.test(d) && d >= mark.slice(0, 10)); } catch { return out; }
  for (const d of days) {
    if (!real(path.join(feedbackDir, d), true)) continue;
    let times = [];
    try { times = readdirSync(path.join(feedbackDir, d)).filter((t) => TIME_DIR.test(t)); } catch { continue; }
    for (const t of times) {
      const id = `${d}/${t}`; const key = momentKey(id);
      const dir = path.join(feedbackDir, d, t); const file = path.join(dir, 'moment.json');
      if (key > mark && real(dir, true) && real(file, false)) out.push({ id, key, file });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * New feedback-hotkey moments become "feedback" rows (source hotkey), oldest first. Checkpoint (Codex review of D338):
 * state.momentMark is the newest moment labelled; the host only adds moments with the current time, so every moment
 * at or before the mark is done and is never labelled again, however many there are. A failed write stops the pass
 * there (the mark stays before it), so it is tried again next pass. Returns the rows written.
 */
export function reconcileMoments({ feedbackDir, store, state, now = () => new Date() }) {
  if (!feedbackDir || !existsSync(feedbackDir)) return [];
  const written = [];
  for (const m of momentsAfter(feedbackDir, state.momentMark)) {
    const j = readJson(m.file);
    const ts = j?.at ?? j?.timestamp;
    const t = typeof ts === 'string' || typeof ts === 'number' ? new Date(ts) : now();
    const r = store.add({ action: 'feedback', source: 'hotkey', session: `day-${m.id.slice(0, 10)}`, ref: { moment: m.id }, at: Number.isFinite(t.getTime()) ? t : now() });
    if (typeof r === 'string') break;
    written.push(r);
    state.momentMark = m.key;
  }
  return written;
}

/**
 * The launcher's learning-signal pass. opts: { dataDir, feedbackDir?, log?, everyMs? (60 s), capEvery? (10 passes),
 * capBytes? (tests), now? }. tick({ startup }) runs one pass and returns { rows, cap }.
 */
export function createLearningSignals(opts) {
  const store = createLearningStore({ dataDir: opts.dataDir, capBytes: opts.capBytes, now: opts.now });
  const stateFile = path.join(store.root, STATE_FILE);
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const startedAt = now().getTime();
  const capEvery = opts.capEvery ?? 10;
  let passes = 0; let timer = null;

  function tick({ startup = false } = {}) {
    const state = loadState(stateFile);
    let rows = [];
    try { rows = rows.concat(reconcileClips({ dataDir: opts.dataDir, store, state, startedAt, now })); } catch (e) { log(`learning: clips check failed (${e?.code ?? 'error'})`); }
    try { rows = rows.concat(reconcileMoments({ feedbackDir: opts.feedbackDir, store, state, now })); } catch (e) { log(`learning: feedback check failed (${e?.code ?? 'error'})`); }
    try { saveState(stateFile, state); } catch { log('learning: state not saved; the next pass repeats it'); }
    let cap = null;
    if (startup || ++passes % capEvery === 0) {
      cap = store.enforceCap();
      if (cap.removed.length) log(`learning: store over its cap; removed ${cap.removed.length} oldest stream folder(s)`);
    }
    if (rows.length) log(`learning: ${rows.length} label row(s) written`);
    return { rows, cap };
  }
  return {
    store, tick,
    start() { try { tick({ startup: true }); } catch { /* never stops the studio */ } timer = setInterval(() => { try { tick(); } catch { /* next pass */ } }, opts.everyMs ?? 60_000); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
