// SPDX-License-Identifier: GPL-2.0-or-later
// Action catalogue loader and validator (P3 E4). Node stdlib only. Disk is read only at start-up.
//
// The catalogue is data (data/actions/catalogue.json). It can only RESTRICT. These are fixed in code and
// checked at load, whatever the data says:
//  - Deny categories (isChatDenied): ids that chat (and anything chat-tainted) can never run, by first segment,
//    by target, by main-mic segments, or by a destructive verb anywhere in the id. chatAllowed:true on one fails
//    the load, and the gate checks the same rule again on every tainted request.
//  - A DENY_SET id must be class write or on-air-write (it cannot be downgraded to read).
//  - panic.set and panic.clear must exist (the gate has code paths for them).
//  - chatMode (P3 dry-run, user decision 2026-10-28): 'off' (default) | 'dry-run' | 'on'. 'on' is REFUSED at load for every
//    action until the lost-action gap is closed (docs/plan/2026-10-28-p3-plan.md, Blockers before C2/C3). A deny-category
//    action must be 'off': dry-run never widens what chat may do, it only records. The schema enum has only 'off' and
//    'dry-run' (E4b review finding 9); 'on' returns there when the blocker is closed. This loader refusal stays as
//    defence in depth for documents that skip schema validation.
// Tainted requests use an allowlist: chatAllowed true AND not in a deny category. Everything else is refused.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_CATALOGUE_PATH = path.join(REPO, 'data', 'actions', 'catalogue.json');

export const CLASSES = ['read', 'write', 'on-air-write'];
export const TARGETS = ['none', 'scene', 'layer', 'effect', 'preset', 'camera', 'replay', 'marker', 'chat', 'stream', 'record', 'output', 'settings', 'device', 'audio', 'gate'];
export const CHAT_MODES = Object.freeze(['off', 'dry-run', 'on']);
export const CHAT_ON_BLOCKER = 'lost-action gap must be closed first';
export const PANIC_SET = 'panic.set';
export const PANIC_CLEAR = 'panic.clear';

/** Never from chat: stream, record, outputs, deletion, settings, devices, main mic mute (build plan 4.8),
 *  plus the two panic ids (chat must not engage or clear panic). Fixed in code on purpose. */
export const DENY_SET = Object.freeze(new Set([
  'stream.start', 'stream.stop', 'record.start', 'record.stop', 'output.change',
  'scene.delete', 'layer.delete', 'preset.delete', 'settings.change', 'device.change', 'mic.main.mute',
  PANIC_SET, PANIC_CLEAR,
]));

// Deny categories. Ids are dot-separated segments (ID_RE). An id is chat-denied if ANY rule matches.
/** First segment: stream, record, outputs (and their encoder/rung/sink parts), settings, devices, panic/gate. */
export const DENY_PREFIXES = Object.freeze(new Set([
  'stream', 'streams', 'record', 'records', 'recording', 'recordings', 'output', 'outputs', 'rung', 'rungs',
  'sink', 'sinks', 'encoder', 'encoders', 'delivery', 'settings', 'setting', 'config', 'device', 'devices',
  'panic', 'gate', 'livestate', 'live',
]));
/** Target field: the same categories. */
export const DENY_TARGETS = Object.freeze(new Set(['stream', 'record', 'output', 'settings', 'device', 'gate']));
/** Destructive verbs, as any segment. */
export const DENY_VERBS = Object.freeze(new Set([
  'delete', 'del', 'remove', 'rm', 'destroy', 'erase', 'purge', 'wipe', 'clear', 'reset', 'truncate', 'trash',
  'discard', 'uninstall', 'overwrite', 'unlink', 'drop',
]));
const MIC_SEGMENTS = new Set(['mic', 'mics', 'microphone', 'microphones']);
// 'drop' is destructive in general, but marker.drop places a timeline marker. This is the only exception.
const VERB_EXCEPTIONS = Object.freeze(new Set(['marker.drop']));

/** True if chat-tainted requests may never reach this id, whatever the data says. */
export function isChatDenied(id, target) {
  if (typeof id !== 'string') return true;
  const seg = id.split('.');
  if (DENY_SET.has(id) || DENY_PREFIXES.has(seg[0]) || DENY_TARGETS.has(target)) return true;
  if (seg.some((s) => s === 'mainmic') || (seg.includes('main') && seg.some((s) => MIC_SEGMENTS.has(s)))) return true;
  if (target === 'audio' && seg.includes('main')) return true;
  return !VERB_EXCEPTIONS.has(id) && seg.some((s) => DENY_VERBS.has(s));
}

const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const KEYS = new Set(['id', 'class', 'chatAllowed', 'chatMode', 'target', 'description']);

export class CatalogueError extends Error {
  constructor(errors) { super(`invalid action catalogue: ${errors.join('; ')}`); this.name = 'CatalogueError'; this.errors = errors; }
}

/** Validate a parsed catalogue; returns a frozen Map id -> entry. Throws CatalogueError. */
export function buildCatalogue(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || !Array.isArray(doc.actions) || doc.actions.length === 0) {
    throw new CatalogueError(['top level needs version 1 and a non-empty actions array']);
  }
  const map = new Map();
  doc.actions.forEach((a, i) => {
    const at = `actions[${i}]${a && typeof a.id === 'string' ? ` (${a.id})` : ''}`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${at}: not an object`); return; }
    for (const k of Object.keys(a)) if (!KEYS.has(k)) errors.push(`${at}: unknown key ${k}`);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id) || a.id.length > 64) { errors.push(`${at}: bad id`); return; }
    if (map.has(a.id)) { errors.push(`${at}: duplicate id`); return; }
    if (!CLASSES.includes(a.class)) errors.push(`${at}: class must be one of ${CLASSES.join(', ')}`);
    if (a.chatAllowed !== undefined && typeof a.chatAllowed !== 'boolean') errors.push(`${at}: chatAllowed must be boolean`);
    if (!TARGETS.includes(a.target)) errors.push(`${at}: bad target`);
    if (typeof a.description !== 'string' || a.description.length < 1 || a.description.length > 200) errors.push(`${at}: bad description`);
    if (a.chatAllowed === true && isChatDenied(a.id, a.target)) errors.push(`${at}: chatAllowed:true is not permitted for a deny-category action`);
    if (a.chatMode !== undefined) {
      if (!CHAT_MODES.includes(a.chatMode)) errors.push(`${at}: chatMode must be one of ${CHAT_MODES.join(', ')}`);
      else if (a.chatMode === 'on') errors.push(`${at}: chatMode "on" is not permitted: ${CHAT_ON_BLOCKER} (plan 2026-10-28-p3-plan.md, Blockers before C2/C3)`);
      else if (a.chatMode !== 'off' && isChatDenied(a.id, a.target)) errors.push(`${at}: chatMode must be "off" for a deny-category action`);
    }
    if (DENY_SET.has(a.id) && a.class === 'read') errors.push(`${at}: a deny-set action cannot be class read`);
    map.set(a.id, Object.freeze({
      id: a.id, class: a.class, chatAllowed: a.chatAllowed === true, chatMode: a.chatMode === 'dry-run' ? 'dry-run' : 'off', target: a.target, description: a.description,
    }));
  });
  for (const id of [PANIC_SET, PANIC_CLEAR]) if (!map.has(id)) errors.push(`required action ${id} is missing`);
  if (errors.length) throw new CatalogueError(errors);
  return map;
}

export function loadCatalogue(file = DEFAULT_CATALOGUE_PATH) {
  return buildCatalogue(JSON.parse(readFileSync(file, 'utf8')));
}
