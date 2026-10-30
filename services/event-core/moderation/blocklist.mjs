// SPDX-License-Identifier: GPL-2.0-or-later
// Blocklist loading and matching (P3 E3). Node stdlib only.
//
// Shape and semantics are the legacy blocklist: case-insensitive regexes ('i' only, no 'u'), tested
// against the normalised text. dropMessage is for incoming chat/alert text, rejectReply for outgoing
// replies, dropUser is a set of lowercased account names. A bad regex is skipped and listed in
// `warnings` (legacy skipped it with a log note).
//
// Overlay: data/moderation/blocklist.local.json (gitignored, same array keys, all optional) is
// appended to the committed lists. Real handles, names and channel terms belong only there.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BLOCKLIST_FILE = path.join(REPO, 'data', 'moderation', 'blocklist.json');
export const BLOCKLIST_LOCAL_FILE = path.join(REPO, 'data', 'moderation', 'blocklist.local.json');
export const DEFAULT_POLICY = { echoWindowSec: 120, replyMaxChars: 120 };
const KEYS = ['dropMessage', 'dropUser', 'rejectReply'];

function compileList(list, warnings, key) {
  const out = [];
  (list || []).forEach((p, i) => {
    try { out.push(new RegExp(p, 'i')); } catch { warnings.push(`${key}[${i}]: bad regex skipped`); }
  });
  return out;
}

/** json: { dropMessage?, dropUser?, rejectReply?, policy? } -> compiled blocklist. */
export function compileBlocklist(json) {
  const warnings = [];
  const b = json || {};
  return {
    dropMessage: compileList(b.dropMessage, warnings, 'dropMessage'),
    rejectReply: compileList(b.rejectReply, warnings, 'rejectReply'),
    dropUser: new Set((b.dropUser || []).map((u) => String(u).toLowerCase())),
    policy: { ...DEFAULT_POLICY, ...(b.policy || {}) },
    warnings,
  };
}

/** Load the committed file and, if present, the local overlay. Returns { json, overlay: boolean }. */
export function loadBlocklistJson({ file = BLOCKLIST_FILE, localFile = BLOCKLIST_LOCAL_FILE } = {}) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  let overlay = false;
  if (localFile && existsSync(localFile)) {
    const local = JSON.parse(readFileSync(localFile, 'utf8'));
    for (const k of KEYS) if (Array.isArray(local[k])) json[k] = [...(json[k] || []), ...local[k]];
    overlay = true;
  }
  return { json, overlay };
}

/** Indexes of every pattern that matches `text` (already normalised by the caller). */
export function matchIndexes(rxList, text) {
  const hits = [];
  rxList.forEach((r, i) => { if (r.test(text)) hits.push(i); });
  return hits;
}
