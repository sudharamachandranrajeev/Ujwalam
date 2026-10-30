// SPDX-License-Identifier: GPL-2.0-or-later
// Audit hash chain (P3 E5). Node stdlib only.
//   hash = SHA-256( prev_hash || canonical row JSON ), both as UTF-8; prev_hash is lowercase hex.
// Canonical row JSON = JSON array of the COLS values in fixed order (missing -> null). `detail` is already a
// JSON string when it reaches here, so the hashed bytes are exactly the stored bytes.

import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);
export const COLS = Object.freeze(['id', 'ts', 'type', 'subtype', 'event_id', 'pseudo_id', 'action_id', 'rule_id', 'source', 'verdict', 'reason', 'detail']);

export function canonicalRow(r) { return JSON.stringify(COLS.map((c) => r[c] ?? null)); }
export function chainHash(prev, r) { return createHash('sha256').update(prev + canonicalRow(r), 'utf8').digest('hex'); }
