// SPDX-License-Identifier: GPL-2.0-or-later
// Provenance and chat taint (P3 E4). Pure, synchronous, no I/O. Node stdlib only.
//
// provenance node: { kind, eventId?, parent? }
//   kind is the triggering event kind ('chat.message', 'alert.sub', 'system.livestate') or a trigger name
//   ('schedule', 'hotkey'), or 'rule' for a rule that was itself triggered by something (then `parent` says what).
// Tainted unless the chain ends in a known-clean root. Clean roots: kinds starting 'system.', 'schedule', 'hotkey'.
// Everything else is tainted: chat.*, alert.*, unknown kinds, a malformed node, a missing parent on a 'rule'
// node, or a chain deeper than MAX_DEPTH. Fail safe: when unsure, tainted.
//
// copyProvenance() takes a plain-data snapshot of a caller's chain before anything else looks at it: no getter
// is ever run (only own data properties are read), Proxies are refused, and every kind, eventId and actor is
// checked against the E1 patterns. Anything that does not match becomes 'invalid', so no free text (chat or
// otherwise) can reach the audit through provenance. An 'invalid' kind is tainted.

import { types } from 'node:util';
import { ID_RE, KINDS, PSEUDO_RE } from '../model.mjs';

export const SOURCES = Object.freeze(['ui', 'api', 'chat', 'rule', 'remote', 'system']);
export const MAX_DEPTH = 16;
export const INVALID = 'invalid';
const CLEAN_KINDS = new Set(['schedule', 'hotkey']);
const KNOWN_KINDS = new Set([...KINDS, 'rule', 'schedule', 'hotkey']);
// A local (non-viewer) actor label, e.g. 'u1' or 'timer'. Accepted only on untainted requests; a tainted
// request's actor must be an E1 pseudonymous id.
const LOCAL_ACTOR_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Own data property, or undefined. Never runs a getter. Throws BadShape on an accessor. */
export class BadShape extends Error { constructor(what) { super(`bad shape: ${what}`); this.name = 'BadShape'; } }
export function own(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined) return undefined;
  if (!('value' in d)) throw new BadShape(`accessor ${key}`);
  return d.value;
}
/** Plain object (Object.prototype or null prototype), not a Proxy, not an array. */
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || types.isProxy(v) || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Snapshot a provenance chain into frozen plain nodes. undefined/null stays undefined. A malformed node,
 *  an accessor, a Proxy or a chain deeper than MAX_DEPTH (cycles included) becomes { kind: 'invalid' }. */
export function copyProvenance(prov) {
  if (prov === undefined || prov === null) return undefined;
  const nodes = [];
  let n = prov;
  let bad = false;
  for (let d = 0; n !== undefined; d++) {
    if (d > MAX_DEPTH || !isPlainObject(n)) { bad = true; break; }
    let kind; let eventId; let parent;
    try { kind = own(n, 'kind'); eventId = own(n, 'eventId'); parent = own(n, 'parent'); } catch { bad = true; break; }
    nodes.push({
      kind: typeof kind === 'string' && KNOWN_KINDS.has(kind) ? kind : INVALID,
      ...(eventId === undefined ? {} : { eventId: typeof eventId === 'string' && ID_RE.test(eventId) ? eventId : INVALID }),
    });
    if (parent === null) { bad = true; break; }
    n = parent;
  }
  if (bad) nodes.push({ kind: INVALID });
  let out;
  for (let i = nodes.length - 1; i >= 0; i--) out = Object.freeze(out === undefined ? nodes[i] : { ...nodes[i], parent: out });
  return out;
}

/** Actor for audit and hashing: an E1 pseudo id; or, on an untainted request, a short local label. */
export function cleanActor(actor, tainted) {
  if (typeof actor !== 'string') return INVALID;
  if (PSEUDO_RE.test(actor)) return actor;
  return !tainted && LOCAL_ACTOR_RE.test(actor) ? actor : INVALID;
}

function nodeTainted(node, depth) {
  if (depth > MAX_DEPTH) return true;
  if (!node || typeof node !== 'object' || typeof node.kind !== 'string') return true;
  if (node.kind === 'rule') return nodeTainted(node.parent, depth + 1);
  if (node.kind.startsWith('system.') || CLEAN_KINDS.has(node.kind)) {
    // A clean-looking node may still carry a tainted parent; the parent is then what matters.
    return node.parent === undefined ? false : nodeTainted(node.parent, depth + 1);
  }
  return true;
}

// The two functions below take a copyProvenance() result (the gate copies once at entry).
export function taintOfCopy(source, copied) {
  if (source === 'chat') return true;
  if (source === 'rule') return nodeTainted(copied, 0);
  if (copied === undefined) return false;
  return nodeTainted(copied, 0);
}
export function summariseCopy(source, copied) {
  const kinds = [];
  const ids = [];
  for (let d = 0, n = copied; n !== undefined && d <= MAX_DEPTH; d++, n = n.parent) {
    kinds.push(n.kind);
    if (n.eventId !== undefined) ids.push(n.eventId);
  }
  return { tainted: taintOfCopy(source, copied), kinds, eventIds: ids };
}

/** Is a request tainted by chat? source 'chat' always is; a 'rule' with no usable provenance is too.
 *  Other sources are tainted only if they carry provenance that says so. Copies the chain first. */
export function isTainted(source, provenance) { return taintOfCopy(source, copyProvenance(provenance)); }

/** Small audit-safe summary: no text, only validated kinds and ids. Copies the chain first. */
export function summarise(source, provenance) { return summariseCopy(source, copyProvenance(provenance)); }
