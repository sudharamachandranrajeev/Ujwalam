// SPDX-License-Identifier: GPL-2.0-or-later
// Defence in depth for the audit (P3 E5): every field that reaches an audit row passes a strict pattern, so a
// free-text string (chat, a display name) can never be written there even if an upstream stage lets one through.
// A value that fails its pattern is replaced by a fixed marker, never truncated into something readable.

const ID_RE = /^e[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{8}$/;
const PSEUDO_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:,-]{0,64}$/; // action ids, rule labels, reasons, kinds: one word, no spaces, so a sentence never fits
export const REDACTED = '(redacted)';

export const eventId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
export const pseudoId = (v) => (typeof v === 'string' && PSEUDO_RE.test(v) ? v : null);
export function token(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  return TOKEN_RE.test(s) ? s : REDACTED;
}

/** A detail object may hold only numbers, booleans, null and short safe tokens (or arrays of those, max 16). */
export function detail(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
    const one = (x) => (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean' || x === null ? x : (typeof x === 'string' ? (TOKEN_RE.test(x) ? x : REDACTED) : undefined);
    if (Array.isArray(v)) out[k] = v.slice(0, 16).map(one).filter((x) => x !== undefined);
    else { const x = one(v); if (x !== undefined) out[k] = x; }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
