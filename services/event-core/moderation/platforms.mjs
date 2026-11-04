// SPDX-License-Identifier: GPL-3.0-or-later
// Reply length limits per platform, read from data/platforms/*.json (field replyMaxChars). Node stdlib only.
// Never hardcoded here. A limit marked unverified is still used (it can only make a reply stricter than
// the legacy cap if smaller) but is reported with unverified: true.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PLATFORMS_DIR = path.join(REPO, 'data', 'platforms');

/** Returns { [platformId]: { replyMaxChars: number|null, unverified: boolean, source?: string, checked?: string } }. */
export function loadReplyLimits(dir = PLATFORMS_DIR) {
  const out = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'platform.schema.json') continue;
    const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const n = p.replyMaxChars;
    out[p.id] = {
      replyMaxChars: Number.isInteger(n?.value) ? n.value : null,
      unverified: n ? n.unverified === true : true,
      source: n?.source,
      checked: n?.checked,
    };
  }
  return out;
}
