// SPDX-License-Identifier: GPL-3.0-or-later
// Event model v1 (P3 E1): constants, per-kind field table, construction. Node stdlib only.
//
// Rules this module enforces at construction (E3 does full moderation on top):
//  - Only mapped fields are copied. Any other key on the input (a raw platform payload, say) is dropped.
//  - Control characters (C0 U+0000-U+001F, DEL U+007F, C1 U+0080-U+009F) are replaced by a space in every
//    string; if one was present, whitespace runs are then collapsed and the ends trimmed (as legacy normalise, so
//    moderation sees 'a b' for an embedded newline). The validator REJECTS them, so a hand-built event
//    that carries one never validates.
//  - Strings longer than their cap are TRUNCATED to the cap, counted in Unicode code points (the unit
//    JSON Schema maxLength uses), never in UTF-16 units.
//  - Optional fields are omitted when absent. null is allowed only where the table says so.
//
// Event id: "e" + 12 hex (wall ms, never goes backwards) + "-" + 8 hex (counter within that ms)
//   + "-" + 8 hex (random nonce per generator, so two processes in the same ms still differ).
//   Fixed length 31 chars, so plain string comparison sorts by creation order within one generator.
//   Across generators it sorts by millisecond, then counter, then nonce (no order promise inside a ms).
// mono: performance.now() in ms, rounded to 3 decimals. Origin = process start (performance.timeOrigin),
//   monotonic and unaffected by wall-clock changes; non-decreasing, ties are possible. It is only
//   comparable inside one process run; receivedAt (wall ISO time) is the cross-run time.

import { createHmac, randomBytes } from 'node:crypto';

export const EVENT_VERSION = 1;
export const PLATFORMS = ['twitch', 'youtube', 'kick', 'local'];
export const SOURCES = ['streamerbot', 'mock', 'api', 'rule', 'system'];
// Canonical order; also the order roles are stored in.
export const ROLES = ['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'follower', 'viewer'];
export const SUB_TIERS = ['prime', '1000', '2000', '3000'];

// Length caps, in code points.
export const CAPS = {
  platformMessageId: 128,
  platformUserId: 64,
  displayName: 64,
  text: 500,        // chat text and every free-text "message"
  emoteId: 64,
  emoteName: 64,
  emotes: 50,       // max emotes per message
  reward: 100,
  tier: 64,         // membership level name (free text, unlike sub tiers)
  target: 64,       // system.connected / disconnected target name
  reason: 200,
};
export const PSEUDO_ID_HEX = 32; // 128 bits of HMAC-SHA256

// Written as escapes so this file holds no raw control characters.
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_RE_G = /[\u0000-\u001f\u007f-\u009f]/gu;

export const ID_RE = /^e[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{8}$/;
export const PSEUDO_RE = /^[0-9a-f]{32}$/;
export const ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
export const CURRENCY_RE = /^[A-Z]{3}$/;

// Per-kind field table. t: str | int | num | bool | enum | emotes.
// req: required. Everything else is optional and omitted when absent.
export const KIND_FIELDS = {
  'chat.message': { text: { t: 'str', min: 1, max: CAPS.text, req: true }, emotes: { t: 'emotes' } },
  'alert.follow': {},
  'alert.sub': { tier: { t: 'enum', values: SUB_TIERS, req: true }, message: { t: 'str', max: CAPS.text } },
  'alert.resub': {
    tier: { t: 'enum', values: SUB_TIERS, req: true },
    months: { t: 'int', min: 1, max: 1200, req: true },
    message: { t: 'str', max: CAPS.text },
  },
  // user = the gifter; count = number of subs gifted in this event.
  'alert.giftsub': {
    tier: { t: 'enum', values: SUB_TIERS, req: true },
    count: { t: 'int', min: 1, max: 10000, req: true },
  },
  // user = the raider (channel that raided); viewers = size of the raid.
  'alert.raid': { viewers: { t: 'int', min: 0, max: 10000000, req: true } },
  'alert.bits': { amount: { t: 'int', min: 1, max: 10000000, req: true }, message: { t: 'str', max: CAPS.text } },
  'alert.superchat': {
    amount: { t: 'num', exclusiveMin: 0, max: 1e9, req: true },
    currency: { t: 'str', re: CURRENCY_RE, min: 3, max: 3, req: true },
    message: { t: 'str', max: CAPS.text },
  },
  'alert.membership': { tier: { t: 'str', min: 1, max: CAPS.tier }, months: { t: 'int', min: 1, max: 1200 } },
  'alert.redemption': {
    reward: { t: 'str', min: 1, max: CAPS.reward, req: true },
    cost: { t: 'int', min: 0, max: 1000000000 },
    message: { t: 'str', max: CAPS.text },
  },
  'system.connected': { target: { t: 'str', min: 1, max: CAPS.target, req: true } },
  'system.disconnected': {
    target: { t: 'str', min: 1, max: CAPS.target, req: true },
    reason: { t: 'str', max: CAPS.reason },
  },
  'system.livestate': { live: { t: 'bool', req: true } },
  'system.panic': { reason: { t: 'str', max: CAPS.reason } },
  'system.refused': { action: { t: 'str', min: 1, max: 64, req: true }, reason: { t: 'str', min: 1, max: CAPS.reason, req: true } },
};
export const KINDS = Object.keys(KIND_FIELDS);
export const isSystemKind = (k) => typeof k === 'string' && k.startsWith('system.');

/** Length in Unicode code points (what JSON Schema maxLength counts). */
export function cpLen(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Replace each control character with a space (then collapse whitespace runs and trim, only when one was
 *  present, matching legacy normalise), then truncate to `max` code points. Non-strings pass through unchanged. */
export function cleanString(s, max) {
  if (typeof s !== 'string') return s;
  let out = s;
  if (CONTROL_RE.test(s)) out = s.replace(CONTROL_RE_G, ' ').replace(/\s+/gu, ' ').trim(); // as legacy normalise
  if (out.length > max) { // cheap pre-check: code points <= UTF-16 units
    const cps = [...out];
    if (cps.length > max) out = cps.slice(0, max).join('');
  }
  return out;
}

export class EventError extends Error {
  constructor(errors) {
    super(`invalid event: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'EventError';
    this.errors = errors;
  }
}

/** pseudoId = first 32 hex chars of HMAC-SHA256(key, platform + ":" + platformUserId).
 *  No platformUserId (some alerts omit it): HMAC(key, platform + ":name:" + lowercased displayName),
 *  so the id is still stable per platform and name but is not a real account identity. */
export function derivePseudoId(key, platform, platformUserId, displayName = '') {
  const subject = platformUserId != null
    ? `${platform}:${platformUserId}`
    : `${platform}:name:${String(displayName).toLowerCase()}`;
  return createHmac('sha256', key).update(subject, 'utf8').digest('hex').slice(0, PSEUDO_ID_HEX);
}

/** Id generator; see the format at the top of this file. `wall` and `random` are test seams. */
export function createIdGenerator({ wall = Date.now, random = randomBytes } = {}) {
  const nonce = random(4).toString('hex');
  let lastMs = 0;
  let counter = 0;
  return function nextId() {
    const now = wall();
    if (now > lastMs) { lastMs = now; counter = 0; } else { counter++; } // clock stepped back: keep lastMs
    return `e${lastMs.toString(16).padStart(12, '0')}-${counter.toString(16).padStart(8, '0')}-${nonce}`;
  };
}

const monoNow = () => Math.round(performance.now() * 1000) / 1000;

/**
 * Build an event from loose input. Input: { kind, platform, source, platformMessageId?, user?, ...kind fields }.
 * user: { platformUserId?, displayName, roles? }; roles default to ['viewer'].
 * ctx: { key, nextId, wall?, mono? }. Returns a frozen object; the caller validates it (validate.mjs).
 * Unknown input keys are dropped. Nothing is checked here beyond sanitising strings.
 */
export function buildEvent(ctx, input) {
  const kind = input?.kind;
  const wall = ctx.wall ?? Date.now;
  const ev = {
    v: EVENT_VERSION,
    id: ctx.nextId(),
    kind,
    platform: input?.platform,
    source: input?.source,
    platformMessageId: input?.platformMessageId == null ? null : cleanString(input.platformMessageId, CAPS.platformMessageId),
    receivedAt: new Date(wall()).toISOString(),
    mono: (ctx.mono ?? monoNow)(),
  };
  if (!isSystemKind(kind) && input?.user && typeof input.user === 'object') {
    const u = input.user;
    const platformUserId = u.platformUserId == null ? null : cleanString(String(u.platformUserId), CAPS.platformUserId);
    const displayName = cleanString(u.displayName, CAPS.displayName);
    let roles = u.roles === undefined ? ['viewer'] : u.roles;
    if (Array.isArray(roles)) {
      // Known roles in canonical order, no duplicates. Unknown values are kept so the validator rejects them.
      const known = ROLES.filter((r) => roles.includes(r));
      const unknown = roles.filter((r) => !ROLES.includes(r));
      roles = [...known, ...unknown];
    }
    ev.user = {
      pseudoId: derivePseudoId(ctx.key, ev.platform, platformUserId, typeof displayName === 'string' ? displayName : ''),
      platformUserId,
      displayName,
      roles,
    };
  }
  for (const [name, spec] of Object.entries(KIND_FIELDS[kind] ?? {})) {
    const val = input[name];
    if (val === undefined) continue;
    if (spec.t === 'str') ev[name] = cleanString(val, spec.max);
    else if (spec.t === 'emotes' && Array.isArray(val)) {
      ev[name] = val.slice(0, CAPS.emotes).map((e) => ({
        id: cleanString(e?.id, CAPS.emoteId),
        name: cleanString(e?.name, CAPS.emoteName),
      }));
    } else ev[name] = val;
  }
  return deepFreeze(ev);
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}
