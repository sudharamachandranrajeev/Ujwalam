// SPDX-License-Identifier: GPL-2.0-or-later
// Post-stream feedback form backend (alpha plan Part B). Node stdlib only.
// Moments live in <feedbackDir>/<YYYY-MM-DD>/<HHMMSS>/ (made by the host's feedback hotkey). This module reads
// moment.json and reads/writes ONLY note.json in a moment folder. Ids are validated against MOMENT_ID before any
// path is built, then the folder is checked with lstat/realpath to be a real directory under feedbackDir (no links).
// Moment content is shown as plain text by the page; it is never trusted and never echoed into logs.

import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MOMENT_ID = /^\d{4}-\d{2}-\d{2}\/\d{6}$/;
export const TAGS = Object.freeze(['bug', 'annoying', 'wish', 'works-well']);
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const MAX_NOTE_CHARS = 2000;
export const MAX_MOMENTS = 200;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const TIME_DIR = /^\d{6}$/;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const isFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink() && s.size <= 65_536; } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

// Keep only small primitives from untrusted JSON.
function cleanStats(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v).slice(0, 24)) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
    else if (typeof x === 'string') out[k] = x.slice(0, 80);
  }
  return out;
}
export function cleanNote(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  return {
    text: typeof n.text === 'string' ? n.text.slice(0, MAX_NOTE_CHARS) : '',
    tag: TAGS.includes(n.tag) ? n.tag : null,
    severity: SEVERITIES.includes(n.severity) ? n.severity : null,
    updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt.slice(0, 40) : null,
  };
}

/** Returns the moment folder (string) or null. Never throws. */
function momentDir(rootReal, id) {
  if (typeof id !== 'string' || !MOMENT_ID.test(id)) return null;
  const dir = path.join(rootReal, ...id.split('/'));
  if (!isDir(path.dirname(dir)) || !isDir(dir)) return null;
  let real;
  try { real = realpathSync(dir); } catch { return null; }
  if (real !== dir || !real.startsWith(rootReal + path.sep)) return null;
  return dir;
}

/** opts: { feedbackDir, now? }. */
export function createFeedback(opts) {
  const now = opts.now ?? (() => new Date());
  const rootOf = () => { try { return realpathSync(path.resolve(opts.feedbackDir)); } catch { return null; } };

  function list() {
    const root = rootOf();
    if (!root) return [];
    const out = [];
    let dates = [];
    try { dates = readdirSync(root).filter((d) => DATE_DIR.test(d)).sort().reverse(); } catch { return []; }
    for (const d of dates) {
      let times = [];
      try { times = readdirSync(path.join(root, d)).filter((t) => TIME_DIR.test(t)).sort().reverse(); } catch { continue; }
      for (const t of times) {
        const id = `${d}/${t}`;
        const dir = momentDir(root, id);
        if (!dir || !isFile(path.join(dir, 'moment.json'))) continue;
        const m = readJson(path.join(dir, 'moment.json'));
        const note = isFile(path.join(dir, 'note.json')) ? cleanNote(readJson(path.join(dir, 'note.json'))) : null;
        out.push({
          id,
          timestamp: typeof m?.timestamp === 'string' ? m.timestamp.slice(0, 40) : (typeof m?.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : null),
          scene: typeof m?.scene === 'string' ? m.scene.slice(0, 64) : null,
          stats: cleanStats(m?.stats),
          note,
        });
        if (out.length >= MAX_MOMENTS) return out;
      }
    }
    return out;
  }

  /** Returns null on success or an error string. Writes note.json only. */
  function saveNote(id, { text, tag, severity }) {
    const root = rootOf();
    const dir = root ? momentDir(root, id) : null;
    if (!dir || !isFile(path.join(dir, 'moment.json'))) return 'unknown-moment';
    if (typeof text !== 'string' || text.length > MAX_NOTE_CHARS) return 'bad-text';
    if (!TAGS.includes(tag)) return 'bad-tag';
    if (!SEVERITIES.includes(severity)) return 'bad-severity';
    const file = path.join(dir, 'note.json');
    if (exists(file) && !isFile(file)) return 'bad-note-file';
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ text, tag, severity, updatedAt: now().toISOString() }, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch { try { unlinkSync(tmp); } catch { /* none */ } return 'write-failed'; }
    return null;
  }
  return { list, saveNote };
}
