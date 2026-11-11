// SPDX-License-Identifier: GPL-3.0-or-later
// LL3 review of low-confidence reads (D340). Node stdlib only.
//
// The clip pipeline queues reads it was not sure of in the learning store (services/clip/learning_capture.py):
// <dataDir>/learning-store/<session>/review.jsonl, one item per line, with frames/<id>.jpg for the item's picture.
// Kinds: unclassified-banner (a VICTORY/DEFEAT word at a height that fits none of the pack's banner kinds), ocr-low
// (a hit read below game.json ocr.minConfidence), unknown-mode (a match whose game mode the match gate could not tell).
// After the stream the user may answer each one in the studio (My clips > Review reads, flag learning-review, off by
// default). An answer is one LL2 label row: action "confirmed", source "review", ref { item, kind, detector, label,
// value, corrected }. Nothing waits for an answer; unanswered items simply stay until the cap removes their session.
// Items answered once are not listed again (the newest answer is the one that counts).
//
// The studio server calls this while live (Codex review of D340), so every read is async (never a blocking read on the
// event loop), bounded (MAX_READ_BYTES per file: the start of review.jsonl, the end of labels.jsonl, where the newest
// answers are) and cached by path, mtime and size (an unchanged file is not read again). Every file read must resolve
// (realpath) inside the store's own realpath: a junction or symlink anywhere on the way (a session's frames/ folder,
// say) that leads out of the store is refused.

import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createLearningStore, LABELS_FILE, SESSION_RE, sessionId } from './store.mjs';

export const REVIEW_FILE = 'review.jsonl';
export const KINDS = Object.freeze(['unclassified-banner', 'ocr-low', 'unknown-mode']);
export const ITEM_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_VALUE = 80;
export const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 20;
const MAX_ITEMS = 200;
const CACHE_MAX = 64;

const str = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One review.jsonl line -> the item as the studio sees it, or null when it is not a valid item.
function shape(raw, session) {
  if (!raw || typeof raw !== 'object' || !ITEM_RE.test(raw.id ?? '') || !KINDS.includes(raw.kind)) return null;
  const choices = Array.isArray(raw.choices) ? raw.choices.filter((c) => typeof c === 'string' && c && c.length <= MAX_VALUE).slice(0, 40) : [];
  if (!choices.length) return null;
  return {
    session, id: raw.id, kind: raw.kind, at: str(raw.at, 40), t: num(raw.t), detector: str(raw.detector, 16), label: str(raw.label),
    mode: str(raw.mode, 40), ocrScore: num(raw.ocrScore), threshold: num(raw.threshold), value: str(raw.value, MAX_VALUE), choices,
    hasFrame: raw.frame === `frames/${raw.id}.jpg`, match: num(raw.match), matchStartUtc: str(raw.matchStartUtc, 40),
    matchEndUtc: str(raw.matchEndUtc, 40), modeReason: str(raw.modeReason, 200),
    modeEvidence: Array.isArray(raw.modeEvidence) ? raw.modeEvidence.slice(0, 8).map((e) => ({ source: str(e?.source, 40), text: str(e?.text, 60) })) : [],
  };
}

// Parsed files by real path + read mode: { mtimeMs, size, value }. Shared by every createReview (the server makes one
// per request). Oldest entry out first past CACHE_MAX.
const cache = new Map();
const caseKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** opts: { dataDir, now?() -> Date }. */
export function createReview(opts) {
  const store = createLearningStore({ dataDir: opts.dataDir, now: opts.now });

  // The real path of a file inside the store, or null (missing, or it resolves outside the store's real path).
  async function inStore(file) {
    try {
      const [root, real] = await Promise.all([realpath(store.root), realpath(file)]);
      return caseKey(real).startsWith(caseKey(root) + path.sep) ? real : null;
    } catch { return null; }
  }

  // Opens a regular file inside the store and hands (handle, stat, real path) to fn; null when that fails.
  async function withFile(file, fn) {
    const real = await inStore(file);
    if (!real) return null;
    let fh;
    try {
      fh = await open(real, 'r');
      const st = await fh.stat();
      return st.isFile() ? await fn(fh, st, real) : null;
    } catch { return null; } finally { await fh?.close().catch(() => {}); }
  }

  // At most n bytes from the start, or from the end when tail.
  async function bytes(fh, st, n, tail) {
    const buf = Buffer.alloc(Math.min(st.size, n));
    const { bytesRead } = await fh.read(buf, 0, buf.length, tail ? st.size - buf.length : 0);
    return buf.subarray(0, bytesRead);
  }

  // JSON lines of a bounded read, parsed once per (path, mtime, size). A cut read drops its partial edge line.
  function lines(file, tail, parse) {
    return withFile(file, async (fh, st, real) => {
      const key = `${tail ? 'tail' : 'head'}:${caseKey(real)}`;
      const hit = cache.get(key);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
      let ls = (await bytes(fh, st, MAX_READ_BYTES, tail)).toString('utf8').split('\n');
      if (st.size > MAX_READ_BYTES) ls = tail ? ls.slice(1) : ls.slice(0, -1);
      const value = parse(ls.filter(Boolean));
      cache.delete(key);
      cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, value });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return value;
    });
  }

  async function items(session) {
    const out = await lines(path.join(store.root, session, REVIEW_FILE), false, (ls) => {
      const got = []; const seen = new Set();
      for (const l of ls) {
        let it = null;
        try { it = shape(JSON.parse(l), session); } catch { /* torn line */ }
        if (it && !seen.has(it.id)) { seen.add(it.id); got.push(it); }
      }
      return got;
    });
    return out ?? [];
  }

  async function answered(session) {
    const done = await lines(path.join(store.root, session, LABELS_FILE), true, (ls) => {
      const ids = new Set();
      for (const l of ls) {
        try { const r = JSON.parse(l); if (r?.action === 'confirmed' && r.source === 'review') ids.add(r.ref?.item); } catch { /* torn line */ }
      }
      return ids;
    });
    return done ?? new Set();
  }

  async function sessions() {
    try {
      return (await readdir(store.root, { withFileTypes: true })).filter((e) => e.isDirectory() && SESSION_RE.test(e.name)).map((e) => e.name).sort();
    } catch { return []; }
  }

  /** Unanswered items, newest session first (at most 20 sessions with a review file, 200 items). { items, total }. */
  async function list() {
    const all = [];
    let n = 0;
    for (const s of (await sessions()).reverse()) {
      if (n >= MAX_SESSIONS) break;
      const its = await items(s);
      if (!its.length) continue;
      n += 1;
      const done = await answered(s);
      for (const it of its) if (!done.has(it.id)) all.push(it);
    }
    return { items: all.slice(0, MAX_ITEMS), total: all.length };
  }

  async function find(session, id) {
    const s = sessionId(session);
    if (!s || s !== session || typeof id !== 'string' || !ITEM_RE.test(id)) return null;
    return (await items(s)).find((it) => it.id === id) ?? null;
  }

  /** The item's JPEG (Buffer) or null. Only frames/<id>.jpg of a listed item is ever read, and only inside the store. */
  async function frame(session, id) {
    const it = await find(session, id);
    if (!it?.hasFrame) return null;
    return withFile(path.join(store.root, it.session, 'frames', `${it.id}.jpg`), (fh, st) => (st.size > MAX_FRAME_BYTES ? null : bytes(fh, st, MAX_FRAME_BYTES, false)));
  }

  /**
   * The user's answer: value is one of the item's choices; for ocr-low also a typed correction (1-80 characters).
   * Resolves to the label row written or an error string: unknown-item | bad-value | write-failed.
   */
  async function confirm({ session, id, value }) {
    const it = await find(session, id);
    if (!it) return 'unknown-item';
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v || v.length > MAX_VALUE || /[\u0000-\u001f]/.test(v)) return 'bad-value';
    if (!it.choices.includes(v) && it.kind !== 'ocr-low') return 'bad-value';
    return store.add({ action: 'confirmed', source: 'review', session: it.session,
      ref: { item: it.id, kind: it.kind, detector: it.detector, label: it.label, value: v, corrected: v !== it.value } });
  }

  return { store, list, frame, confirm };
}
