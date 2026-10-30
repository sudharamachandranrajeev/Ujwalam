// SPDX-License-Identifier: GPL-2.0-or-later
// Self-echo tracker (P3 E3). Node stdlib only.
//
// Legacy definition (engage/lib/pipeline.mjs): key = normalise(text).toLowerCase(), TEXT ONLY (no
// author), one global map. An incoming message is a self-echo when its key was recorded and
// now - recordedAt < window (strict, 120 s). Recording the same key again overwrites the time; entries
// older than the window are pruned on record.
//
// scope 'global' (default): exact legacy behaviour, which ★ parity requires.
// scope 'platform' (opt-in, NON-PARITY variant): the key also holds the platform, so another viewer saying
// the same words on another platform is not dropped. Replies go to the source platform only, so the real
// echo comes back on that platform.
import { normalise } from './text.mjs';

export const MAX_ENTRIES = 1000;

export function createEchoTracker({ windowMs = 120_000, scope = 'global' } = {}) {
  const map = new Map(); // key -> recordedAt (ms)
  const keyOf = (platform, text) => {
    const k = normalise(text).toLowerCase();
    return scope === 'global' ? k : `${platform}\u0000${k}`;
  };

  function record(platform, text, at) {
    map.set(keyOf(platform, text), at);
    for (const [k, t] of map) if (at - t > windowMs) map.delete(k);
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  }

  function isEcho(platform, text, now) {
    const t = map.get(keyOf(platform, text));
    return t !== undefined && now - t < windowMs;
  }

  return { record, isEcho, size: () => map.size };
}
