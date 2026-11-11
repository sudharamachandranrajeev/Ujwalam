// SPDX-License-Identifier: GPL-3.0-or-later
// Local learning store (LL1 minimal, LL2, D338). Node stdlib only.
//
// Layout: <dataDir>/learning-store/<session>/labels.jsonl, one folder per stream session ("one record per stream").
// LL1 adds its evidence (detector hits, OCR text, review frames) to the same session folders later. The store lives in
// the app data folder, never in the repo; `learning-store/` is gitignored and refused by the private scan (LL5) in
// case a data folder is ever pointed inside a checkout.
//
// Format: JSON lines, append-only. Writers live in several processes (launcher, UI server, the feedback collector
// child); one appended line per label needs no lock and no shared database (SQLite is one file per owning process).
// A reader takes the newest row per reference. Rows record what the user did and nothing more:
//   { v: 1, at: ISO, action: kept|deleted|posted|renamed|feedback, source, session, ref: { ... } }
// No event names, weights or windows are added here. Chat text and viewer names are never written to the store;
// chat-feedback rows only point at the local feedback file and the message id.
//
// Cap (LL1, user 2026-11-10): 5 GB for the whole store; whole session folders are removed oldest first (by their
// newest file time) until the total fits. The newest session is never removed.

import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const STORE_DIR = 'learning-store';
export const LABELS_FILE = 'labels.jsonl';
export const CAP_BYTES = 5 * 1024 ** 3;
export const ACTIONS = Object.freeze(['kept', 'deleted', 'posted', 'renamed', 'feedback']);
export const SOURCES = Object.freeze(['my-clips', 'posting', 'hotkey', 'feedback-form', 'chat-feedback']);
export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_REF_KEYS = 12;
const MAX_REF_STR = 260;

export const storeDir = (dataDir) => path.join(path.resolve(dataDir), STORE_DIR);

/** A safe session folder name from a run name, a date or a stamp ('' when nothing usable is left). */
export function sessionId(raw) {
  const s = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 100);
  return SESSION_RE.test(s) ? s : '';
}

// Only short primitives in ref: never objects, never long text.
function cleanRef(ref) {
  const out = {};
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return out;
  for (const [k, v] of Object.entries(ref).slice(0, MAX_REF_KEYS)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_REF_STR);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

/** Validates and shapes one label row; returns the row or an error string. */
export function makeRow({ action, source, session, ref, at }) {
  if (!ACTIONS.includes(action)) return 'bad-action';
  if (!SOURCES.includes(source)) return 'bad-source';
  const s = sessionId(session);
  if (!s) return 'bad-session';
  const t = at instanceof Date ? at : new Date(at ?? Date.now());
  if (!Number.isFinite(t.getTime())) return 'bad-time';
  return { v: 1, at: t.toISOString(), action, source, session: s, ref: cleanRef(ref) };
}

function dirBytesAndNewest(dir) {
  let bytes = 0; let newest = 0;
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else { bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; }
    }
  };
  walk(dir);
  return { bytes, newest };
}

/** opts: { dataDir, capBytes? (tests), now?() -> Date }. */
export function createLearningStore(opts) {
  const root = storeDir(opts.dataDir);
  const capBytes = Number.isFinite(opts.capBytes) && opts.capBytes > 0 ? opts.capBytes : CAP_BYTES;
  const now = opts.now ?? (() => new Date());

  /** Appends one label row. Returns the row written, or an error string (never throws). */
  function add(r) {
    const row = makeRow({ ...r, at: r.at ?? now() });
    if (typeof row === 'string') return row;
    const dir = path.join(root, row.session);
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, LABELS_FILE), `${JSON.stringify(row)}\n`, 'utf8');
    } catch { return 'write-failed'; }
    return row;
  }

  /** Session folder names (sorted). */
  function sessions() {
    try { return readdirSync(root).filter((n) => SESSION_RE.test(n) && lstatSync(path.join(root, n)).isDirectory()).sort(); } catch { return []; }
  }

  /** Label rows of one session (unreadable lines are skipped). */
  function rows(session) {
    const s = sessionId(session);
    if (!s) return [];
    let text = '';
    try { text = readFileSync(path.join(root, s, LABELS_FILE), 'utf8'); } catch { return []; }
    const out = [];
    for (const l of text.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
    return out;
  }

  /**
   * Cap (LL1): removes whole session folders, oldest first (by their newest file), until the store fits capBytes.
   * The newest session and any name in `keep` are never removed. Returns { total, removed: [names], bytes }.
   */
  function enforceCap({ keep = [] } = {}) {
    const list = sessions().map((n) => ({ n, ...dirBytesAndNewest(path.join(root, n)) }));
    let total = list.reduce((a, x) => a + x.bytes, 0);
    const removed = [];
    if (total <= capBytes) return { total, removed, bytes: total };
    list.sort((a, b) => a.newest - b.newest || (a.n < b.n ? -1 : 1));
    const newest = list.at(-1)?.n;
    for (const x of list) {
      if (total <= capBytes) break;
      if (x.n === newest || keep.includes(x.n)) continue;
      try { rmSync(path.join(root, x.n), { recursive: true, force: true }); } catch { continue; }
      total -= x.bytes; removed.push(x.n);
    }
    return { total, removed, bytes: total };
  }

  return { root, capBytes, add, sessions, rows, enforceCap };
}
