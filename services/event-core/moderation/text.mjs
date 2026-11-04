// SPDX-License-Identifier: GPL-3.0-or-later
// Text hygiene (P3 E3), ported from the legacy engage pipeline (normalise, cleanName). Node stdlib only.
// Same behaviour as legacy; gaps are proposals in docs/evidence/2026-10-28-p3-e3-moderation.md.
//
// Chat text and display names are untrusted data. Nothing here interprets them.

// Zero-width and bidi controls, exactly as legacy: U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF.
// Written as escapes so this file holds no raw invisible characters.
const ZERO_WIDTH = /[​-‏‪-‮⁦-⁩﻿]/g;
// C0 controls and DEL. C1 (U+0080-U+009F) is NOT touched here, as in legacy.
const CONTROL = /[\u0000-\u001f\u007f]/g;
export const CONTROL_TEST = /[\u0000-\u001f\u007f]/; // not global: no lastIndex state

export const NAME_MAX = 22;

/** Strip zero-width/bidi, turn C0 controls into spaces, collapse whitespace, trim. Non-strings become ''. */
export function normalise(s) {
  return String(s || '')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Display name fit for the screen, or null. Keeps letters, digits, combining marks (Malayalam, Hindi,
 * Tamil vowel signs live in \p{M}), `_ - . '` and space. Mark runs are capped at 3, leading marks are
 * removed, length is capped at 22 UTF-16 units (as legacy), and a name matching any `dropRx` is null.
 */
export function cleanName(raw, dropRx = []) {
  let n = normalise(raw)
    .replace(/[^\p{L}\p{N}\p{M}_\- .']/gu, '')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .replace(/^\p{M}+/u, '')
    .trim();
  if (n.length > NAME_MAX) n = n.slice(0, NAME_MAX).trim();
  if (!n) return null;
  for (const r of dropRx) if (r.test(n)) return null;
  return n;
}
