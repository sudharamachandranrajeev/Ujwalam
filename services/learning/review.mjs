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

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLearningStore, sessionId } from './store.mjs';

export const REVIEW_FILE = 'review.jsonl';
export const KINDS = Object.freeze(['unclassified-banner', 'ocr-low', 'unknown-mode']);
export const ITEM_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_VALUE = 80;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 20;
const MAX_ITEMS = 200;

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

/** opts: { dataDir, now?() -> Date }. */
export function createReview(opts) {
  const store = createLearningStore({ dataDir: opts.dataDir, now: opts.now });

  function items(session) {
    let text = '';
    try { text = readFileSync(path.join(store.root, session, REVIEW_FILE), 'utf8'); } catch { return []; }
    const out = []; const seen = new Set();
    for (const l of text.split('\n')) {
      if (!l) continue;
      let it = null;
      try { it = shape(JSON.parse(l), session); } catch { /* torn line */ }
      if (it && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
    }
    return out;
  }

  const answered = (session) => new Set(store.rows(session).filter((r) => r.action === 'confirmed' && r.source === 'review').map((r) => r.ref?.item));

  /** Unanswered items, newest session first (at most 20 sessions, 200 items). { items, total }. */
  function list() {
    const all = [];
    const sessions = store.sessions().filter((s) => { try { return lstatSync(path.join(store.root, s, REVIEW_FILE)).isFile(); } catch { return false; } });
    for (const s of sessions.reverse().slice(0, MAX_SESSIONS)) {
      const done = answered(s);
      for (const it of items(s)) if (!done.has(it.id)) all.push(it);
    }
    return { items: all.slice(0, MAX_ITEMS), total: all.length };
  }

  function find(session, id) {
    const s = sessionId(session);
    if (!s || s !== session || typeof id !== 'string' || !ITEM_RE.test(id)) return null;
    return items(s).find((it) => it.id === id) ?? null;
  }

  /** The item's JPEG (Buffer) or null. Only frames/<id>.jpg of a listed item is ever read. */
  function frame(session, id) {
    const it = find(session, id);
    if (!it?.hasFrame) return null;
    const f = path.join(store.root, it.session, 'frames', `${it.id}.jpg`);
    try {
      const st = lstatSync(f);
      if (!st.isFile() || st.size > MAX_FRAME_BYTES) return null;
      return readFileSync(f);
    } catch { return null; }
  }

  /**
   * The user's answer: value is one of the item's choices; for ocr-low also a typed correction (1-80 characters).
   * Returns the label row written or an error string: unknown-item | bad-value | write-failed.
   */
  function confirm({ session, id, value }) {
    const it = find(session, id);
    if (!it) return 'unknown-item';
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v || v.length > MAX_VALUE || /[\u0000-\u001f]/.test(v)) return 'bad-value';
    if (!it.choices.includes(v) && it.kind !== 'ocr-low') return 'bad-value';
    const row = store.add({ action: 'confirmed', source: 'review', session: it.session,
      ref: { item: it.id, kind: it.kind, detector: it.detector, label: it.label, value: v, corrected: v !== it.value } });
    return row;
  }

  return { store, list, frame, confirm };
}
