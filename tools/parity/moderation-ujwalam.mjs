// SPDX-License-Identifier: GPL-2.0-or-later
// Ujwalam side of the moderation parity check (P3 E3). Shared by tools/parity/moderation-parity.mjs and
// tests/event-core-moderation-parity.test.mjs. Pure; no legacy import.
//
// Case shapes (group -> input -> verdict):
//   normalise  string                                   -> string
//   cleanName  string                                   -> string | null
//   blockIn    { user, text }                           -> 'pass' | 'self-echo' | 'bot' | 'blocked' | 'bad-name'
//   guard      string                                   -> reason | null
//   pathText   string                                   -> string   (raw -> E1 builder -> moderation normalise)
//   pathBlock  { user, text }                           -> as blockIn, but built through the E1 builder first
//   pathEcho   { replyText, replyAt, user, text, at }   -> as echo, with the incoming message built first
//   echo       { replyText, replyAt, user, text, at }   -> 'self-echo' | 'pass'
// Legacy results that moderation does not own (command, too-short, reply, rate gates...) map to 'pass'.

import { buildEvent, createIdGenerator } from '../../services/event-core/model.mjs';
import { createModeration } from '../../services/event-core/moderation/index.mjs';
import { cleanName, normalise } from '../../services/event-core/moderation/text.mjs';
import { compileBlocklist, loadBlocklistJson } from '../../services/event-core/moderation/blocklist.mjs';

const OWNED = new Set(['self-echo', 'bot', 'blocked', 'bad-name']);
export const legacyVerdict = (r) => (r && r.action === 'drop' && OWNED.has(r.reason) ? r.reason : 'pass');

/** Parity runs with the committed list only (no local overlay); echo scope is the default, global (legacy). */
export function parityModeration(extra = {}) {
  return createModeration({ blocklistLocalFile: null, ...extra });
}

const CTX = { key: Buffer.alloc(32, 3), nextId: createIdGenerator() };
/** Raw input through the E1 builder (control chars -> spaces), as the live path does. */
const built = (user, text) => buildEvent(CTX, { kind: 'chat.message', platform: 'twitch', source: 'mock', user: { platformUserId: 'u1', displayName: user }, text });
const chat = (user, text) => ({ kind: 'chat.message', platform: 'twitch', user: { displayName: user }, text });

export function ujwalamVerdict(group, input) {
  switch (group) {
    case 'normalise': return normalise(input);
    case 'cleanName': {
      const { json } = loadBlocklistJson({ localFile: null });
      return cleanName(input, compileBlocklist(json).dropMessage);
    }
    case 'blockIn': {
      const v = parityModeration().moderate(chat(input.user, input.text), 0);
      return v.action === 'drop' ? v.reasons[0] : 'pass';
    }
    case 'guard': {
      const g = parityModeration().guardReply({ platform: 'twitch', text: input });
      return g.ok ? null : g.reasons[0];
    }
    case 'echo': {
      const m = parityModeration();
      m.recordReply({ platform: 'twitch', text: input.replyText, at: input.replyAt });
      const v = m.moderate(chat(input.user, input.text), input.at);
      return v.action === 'drop' && v.reasons[0] === 'self-echo' ? 'self-echo' : 'pass';
    }
    case 'pathText': return normalise(built('viewerone', input).text);
    case 'pathBlock': {
      const v = parityModeration().moderate(built(input.user, input.text), 0);
      return v.action === 'drop' ? v.reasons[0] : 'pass';
    }
    case 'pathEcho': {
      const m = parityModeration();
      m.recordReply({ platform: 'twitch', text: input.replyText, at: input.replyAt });
      const v = m.moderate(built(input.user, input.text), input.at);
      return v.action === 'drop' && v.reasons[0] === 'self-echo' ? 'self-echo' : 'pass';
    }
    default: throw new Error(`unknown group ${group}`);
  }
}
