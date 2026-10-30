// SPDX-License-Identifier: GPL-2.0-or-later
// Alert fixture anonymiser and recorder (P3 E2). Node stdlib only.
//
// Allowlist, not blocklist. A value survives only if its key is allowlisted AND its value passes that key's
// pattern. Everything else:
//   string leaf with an id-like key  -> "<id>"
//   any other string leaf            -> "<str:LEN>"   (LEN = code points)
//   number with a non-allowlisted key -> "<num>" ; id-like key with a number -> "<id>"
//   unknown object key               -> "<key:LEN>#i" (keys can carry names, e.g. a map keyed by login)
// Booleans and null are kept (one bit of structure). Arrays keep their length (capped at 50) so shape is visible.
//
// Fixtures live OUTSIDE the repo (<dataDir>/fixtures/alerts/<kind>/<n>.json). Committing any of them needs
// the user's explicit approval (CLAUDE.md: public repo, no personal data), after the user has looked at them.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Structural keys seen in the docs' example payloads (read 2026-10-28) plus a few obvious siblings.
export const KNOWN_KEYS = new Set([
  'event', 'source', 'type', 'data', 'timeStamp', 'timestamp',
  'user', 'targetUser', 'raider', 'broadcaster', 'recipient', 'gifter', 'reward', 'meta', 'parts', 'emotes', 'reply',
  'cheerEmotes', 'badges',
  'id', 'userId', 'messageId', 'eventId', 'redemptionId', 'login', 'name', 'displayName', 'userName',
  'text', 'message', 'userInput', 'systemMessage', 'title', 'prompt', 'rewardName', 'levelName', 'tier', 'level',
  'subTier', 'isPrime', 'durationMonths', 'cumulativeMonths', 'cumlativeTotal', 'cumulativeTotal', 'months',
  'milestoneMonths', 'monthsSubscribed', 'duration', 'subscribedAt', 'expiresAt', 'followedAt', 'createdAt',
  'redeemedAt', 'publishedAt', 'bits', 'amount', 'value', 'currency', 'currencyCode', 'cost', 'viewers', 'count',
  'gifts', 'total', 'giftCount', 'communityGiftId', 'communitySubGiftCount', 'communitySubGiftCumulativeTotal',
  'fromCommunitySubGift', 'randomCommunitySubGift', 'counter', 'userCounter', 'status', 'role', 'anonymous',
  'isTest', 'isReply', 'isAnonymous', 'isInternal', 'isInSharedChat', 'isSharedChatHost', 'isFromSharedChatGuest',
  'sharedChatSource', 'subscribed', 'isSubscribed', 'isSponsor', 'isModerator', 'isOwner', 'isVip', 'isMe',
  'firstMessage', 'FirstMessage', 'FirstMessageTimestamp', 'ReturningChatter',
]);

// Numeric values that describe an alert, not a person.
const NUM_KEYS = new Set([
  'bits', 'amount', 'value', 'cost', 'viewers', 'count', 'gifts', 'total', 'giftCount', 'months', 'milestoneMonths',
  'monthsSubscribed', 'durationMonths', 'cumulativeMonths', 'cumlativeTotal', 'cumulativeTotal', 'duration',
  'communitySubGiftCount', 'communitySubGiftCumulativeTotal', 'counter', 'userCounter', 'role',
]);

// String values allowed through, each with a pattern a name or message is very unlikely to satisfy by accident.
const STR_RULES = {
  subTier: /^(prime|1000|2000|3000)$/i,
  tier: /^(prime|1000|2000|3000)$/i,
  currency: /^[A-Z]{3}$/,
  currencyCode: /^[A-Z]{3}$/,
};
// event.source / event.type of the recorder's own wrapper.
const WRAPPER_RE = /^[A-Za-z]{1,40}$/;

const ID_KEY = /(^id$|Id$|^login$|^userName$)/;
const MAX_DEPTH = 8;
const MAX_ARRAY = 50;
const cp = (s) => { let n = 0; for (const _ of s) n++; return n; };

export function anonymise(value, opts = {}) {
  const extraKeys = new Set(opts.extraAllowedKeys ?? []);
  let keyCounter = 0;
  function walk(v, key, pathKeys, depth) {
    if (v === null || typeof v === 'boolean') return v;
    if (depth > MAX_DEPTH) return '<deep>';
    if (typeof v === 'string') {
      if (key != null && ID_KEY.test(key)) return '<id>';
      if (pathKeys.length === 2 && pathKeys[0] === 'event' && (key === 'source' || key === 'type') && WRAPPER_RE.test(v)) return v;
      const rule = key != null ? STR_RULES[key] : undefined;
      if (rule && rule.test(v)) return v;
      return `<str:${cp(v)}>`;
    }
    if (typeof v === 'number') {
      if (key != null && ID_KEY.test(key)) return '<id>';
      if (key != null && NUM_KEYS.has(key) && Number.isFinite(v)) return v;
      return '<num>';
    }
    if (Array.isArray(v)) {
      return v.slice(0, MAX_ARRAY).map((x) => walk(x, key, pathKeys, depth + 1));
    }
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        const safe = KNOWN_KEYS.has(k) || extraKeys.has(k);
        const outKey = safe ? k : `<key:${cp(k)}>#${keyCounter++}`;
        out[outKey] = walk(v[k], safe ? k : null, safe ? [...pathKeys, k] : [...pathKeys, '*'], depth + 1);
      }
      return out;
    }
    return '<other>'; // bigint, symbol, function: never expected from JSON
  }
  return walk(value, null, [], 0);
}

// ---- recorder ---------------------------------------------------------------------------------------------

const SAFE_KIND = /^alert\.[a-z]+$/;

/** opts: { dir (absolute, outside the repo), maxPerKind = 50, extraAllowedKeys }. */
export function createFixtureRecorder(opts) {
  const root = path.resolve(opts.dir);
  const rel = path.relative(REPO, root);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('fixture-dir-inside-repo: fixtures must live outside the repository');
  }
  const base = path.join(root, 'fixtures', 'alerts');
  const maxPerKind = opts.maxPerKind ?? 50;
  const counts = {};
  let chain = Promise.resolve(); // one write at a time, in arrival order: numbering stays deterministic
  let pending = 0;
  const MAX_PENDING = 200; // bounded memory under an alert flood; more are dropped (resolve null)
  const full = new Set(); // kinds at the cap: no more disk calls for them

  // Asynchronous (P3 E7 follow-up): the connector calls record() from its message handler on the live path, so it
  // uses node:fs/promises only and never blocks the event loop. The envelope is anonymised synchronously, at call time.
  async function write(short, doc) {
    const dir = path.join(base, short);
    await mkdir(dir, { recursive: true });
    const have = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)).length;
    if (have >= maxPerKind) { full.add(short); return null; }
    for (let n = have + 1; ; n++) {
      const file = path.join(dir, `${n}.json`);
      try {
        await writeFile(file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
      } catch (e) {
        if (e?.code === 'EEXIST') continue;
        throw e;
      }
      counts[short] = (counts[short] ?? 0) + 1;
      return file;
    }
  }

  /** envelope: the Streamer.bot message { event: {source, type}, data }. Resolves the path, or null (not an alert,
   *  or the cap is reached). Rejects on a write error. */
  function record(kind, envelope) {
    if (!SAFE_KIND.test(kind)) return Promise.resolve(null);
    const short = kind.slice('alert.'.length);
    if (full.has(short) || pending >= MAX_PENDING) return Promise.resolve(null);
    const doc = anonymise({ event: { source: envelope?.event?.source, type: envelope?.event?.type }, data: envelope?.data ?? null },
      { extraAllowedKeys: opts.extraAllowedKeys });
    pending++;
    const p = chain.then(() => write(short, doc)).finally(() => { pending--; });
    chain = p.catch(() => {}); // a failed write does not stop the next one
    return p;
  }
  return { record, counts: () => ({ ...counts }), dir: base };
}
