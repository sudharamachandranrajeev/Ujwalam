// SPDX-License-Identifier: GPL-3.0-or-later
// Moderation verdicts (P3 E3). Node stdlib only.
//
//   const m = createModeration();                        // loads data/moderation + data/platforms
//   m.moderate(event)      -> { action: 'pass'|'drop'|'flag', reasons: [...], matched?, cleanName? }
//   m.guardReply({platform, text}) -> { ok, text?, reasons: [] }
//   m.planReply(event, text)       -> { ok, platform, replyTo, text?, reasons }
//   m.recordReply({platform, text, at?})   // call when a reply was ACTUALLY sent (legacy commit)
//
// moderate() and guardReply() are pure over the config, except that self-echo reads the reply history
// that recordReply() writes. Event text is untrusted: it is only normalised and matched, never run.
//
// Verdict rules (legacy order: self-echo, bot, blocked, bad-name; reasons[0] is the legacy reason):
//  - chat.message: drop on self-echo, bot (dropUser), blocked (dropMessage), bad-name (cleanName null).
//  - alert.* with a free-text `message`: blocked -> flag (the alert itself is real, so it is not lost);
//    unusable display name -> flag. The event-core stage then publishes a redacted copy.
//  - everything else (system.*, alerts without text): pass.
// What legacy also drops but is NOT moderation here (engage-bot policy, P13): commands, too-short,
// too-long, emote-only, duplicate, rate gates.
//
// guardReply follows legacy guard: REFUSE, never truncate. Order: empty, too-long (policy cap, 120
// UTF-16 units), newline, control-char, blocklist; then the platform limit (code points) from
// data/platforms. The first failing check is the single reason.

import { compileBlocklist, loadBlocklistJson, matchIndexes } from './blocklist.mjs';
import { createEchoTracker } from './echo.mjs';
import { loadReplyLimits } from './platforms.mjs';
import { CONTROL_TEST, cleanName, normalise } from './text.mjs';

export { normalise, cleanName } from './text.mjs';
export { compileBlocklist, loadBlocklistJson } from './blocklist.mjs';
export { createEchoTracker } from './echo.mjs';
export { loadReplyLimits } from './platforms.mjs';

const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };

/**
 * opts: { blocklist?: json, limits?: loadReplyLimits() result, now?: () => ms, echoScope?: 'global' (default, legacy)|'platform' (opt-in, non-parity),
 *         blocklistFile?, blocklistLocalFile?, platformsDir? }
 */
export function createModeration(opts = {}) {
  const loaded = opts.blocklist
    ? { json: opts.blocklist, overlay: false }
    : loadBlocklistJson({
        ...(opts.blocklistFile ? { file: opts.blocklistFile } : {}),
        ...('blocklistLocalFile' in opts ? { localFile: opts.blocklistLocalFile } : {}),
      });
  const bl = compileBlocklist(loaded.json);
  const limits = opts.limits ?? loadReplyLimits(opts.platformsDir);
  const now = opts.now ?? Date.now;
  const echo = createEchoTracker({ windowMs: bl.policy.echoWindowSec * 1000, scope: opts.echoScope ?? 'global' });
  const nameCache = new Map(); // display name -> cleanName result (names repeat; the Unicode regexes are the costly part)
  const cleanNameCached = (display) => {
    if (nameCache.has(display)) return nameCache.get(display);
    const n = cleanName(display, bl.dropMessage);
    if (nameCache.size >= 2000) nameCache.delete(nameCache.keys().next().value);
    nameCache.set(display, n);
    return n;
  };
  const counts = { pass: 0, drop: 0, flag: 0, guardRefused: 0 };

  function moderate(event, at = now()) {
    const reasons = [];
    const matched = [];
    let action = 'pass';
    let name;
    const isChat = event?.kind === 'chat.message';
    const isAlert = typeof event?.kind === 'string' && event.kind.startsWith('alert.');

    if (isChat || isAlert) {
      const display = event.user?.displayName ?? '';
      const text = isChat ? normalise(event.text) : normalise(event.message);
      if (isChat && echo.isEcho(event.platform, text, at)) reasons.push('self-echo');
      if (isChat && bl.dropUser.has(String(display).toLowerCase())) reasons.push('bot');
      if (text) {
        const hits = matchIndexes(bl.dropMessage, text);
        if (hits.length) { reasons.push('blocked'); matched.push(...hits); }
      }
      if (event.user) {
        name = cleanNameCached(display);
        if (name === null) reasons.push('bad-name');
      }
      if (reasons.length) action = isChat ? 'drop' : 'flag';
    }
    counts[action]++;
    const v = { action, reasons };
    if (matched.length) v.matched = matched;
    if (name !== undefined) v.cleanName = name;
    return v;
  }

  function guardReply({ platform, text } = {}) {
    const refuse = (r) => { counts.guardRefused++; return { ok: false, reasons: [r] }; };
    if (typeof text !== 'string' || !text.trim()) return refuse('empty');
    if (text.length > bl.policy.replyMaxChars) return refuse('too-long');
    if (/[\r\n]/.test(text)) return refuse('newline');
    if (CONTROL_TEST.test(text)) return refuse('control-char');
    for (const r of bl.rejectReply) if (r.test(text)) return refuse('blocklist');
    const lim = limits[platform];
    if (!lim) return refuse('unknown-platform');
    if (lim.replyMaxChars !== null && cpLen(text) > lim.replyMaxChars) return refuse('platform-limit');
    return { ok: true, text, reasons: [] };
  }

  /** A reply goes to the platform of the event it answers, nowhere else. */
  function planReply(event, text) {
    const g = guardReply({ platform: event?.platform, text });
    return {
      ...g,
      platform: event?.platform,
      replyTo: event?.platformMessageId ?? null,
    };
  }

  function recordReply({ platform, text, at = now() }) { echo.record(platform, text, at); }

  return {
    moderate, guardReply, planReply, recordReply,
    stats: () => ({ ...counts, echoEntries: echo.size(), overlay: loaded.overlay, warnings: bl.warnings }),
    limits,
    policy: bl.policy,
  };
}
