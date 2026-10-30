// SPDX-License-Identifier: GPL-2.0-or-later
// Dedupe by (platform, platformMessageId) inside a bounded window (P3 E1, persistent since E7). Node stdlib only.
//
// Limits: an entry lives `windowMs` (default 120 000 ms, monotonic clock) and the table holds at most
// `maxEntries` (default 10 000); the oldest entries go first. A repeat does not refresh its entry, so
// the window is measured from the first sighting. Events with no platformMessageId are never deduped;
// they are counted in `noId`.
//
// Keys are the SHA-256 hex of "platform:platformMessageId"; the raw id is never kept here or persisted.
// Persistence (E7): `onSeen(keyHash, event)` is called once per first sighting so the caller can queue the key for the
// audit worker (off the hot path) and map the event id to it (idempotency origin, livelock/idempotency.mjs). After a restart `seed(entries, nowMono, nowWall)` loads the last window of keys, so a
// Streamer.bot reconnect overlap does not produce a second action. Maximum gap: keys still in the audit queue or in
// the last uncommitted batch when the process dies (batchMs + one write, measured in the E7 crash run).

import { createHash } from 'node:crypto';

export const DEFAULT_WINDOW_MS = 120_000;
export const DEFAULT_MAX_ENTRIES = 10_000;

/** SHA-256 hex of "platform:platformMessageId". */
export const dedupeKey = (platform, platformMessageId) => createHash('sha256').update(`${platform}:${platformMessageId}`).digest('hex');

export function createDedupe({ windowMs = DEFAULT_WINDOW_MS, maxEntries = DEFAULT_MAX_ENTRIES, onSeen } = {}) {
  // Map keeps insertion order, and sightings are inserted in time order, so the oldest is always first.
  const seen = new Map(); // key hash -> first-seen mono ms
  const stats = { checked: 0, duplicates: 0, noId: 0, expired: 0, evictedByCount: 0, seeded: 0, duplicatesFromSeed: 0 };
  const fromSeed = new Set();

  const expire = (now) => {
    for (const [k, t] of seen) { // expire from the front
      if (now - t < windowMs) break;
      seen.delete(k);
      fromSeed.delete(k);
      stats.expired++;
    }
  };

  /** Returns true if the event is a duplicate. `now` is a monotonic ms value. */
  function isDuplicate(ev, now) {
    stats.checked++;
    if (ev.platformMessageId == null) { stats.noId++; return false; }
    expire(now);
    const key = dedupeKey(ev.platform, ev.platformMessageId);
    if (seen.has(key)) { stats.duplicates++; if (fromSeed.has(key)) stats.duplicatesFromSeed++; return true; }
    seen.set(key, now);
    if (onSeen) { try { onSeen(key, ev); } catch { /* persistence must never break ingest */ } }
    while (seen.size > maxEntries) {
      const old = seen.keys().next().value;
      seen.delete(old);
      fromSeed.delete(old);
      stats.evictedByCount++;
    }
    return false;
  }

  /** Load persisted keys. entries: [{ key, seen_at }] with seen_at in wall ms; nowMono/nowWall: the current clocks.
   *  An entry's age (nowWall - seen_at) is carried over to the monotonic clock. Entries older than the window are
   *  ignored. Existing keys keep their own (newer) time. Returns the number of keys added. */
  function seed(entries, nowMono, nowWall) {
    const all = [...seen];
    let added = 0;
    for (const e of entries) {
      if (typeof e?.key !== 'string' || seen.has(e.key)) continue;
      const age = nowWall - e.seen_at;
      if (!(age >= 0 && age < windowMs)) continue;
      all.push([e.key, nowMono - age]);
      fromSeed.add(e.key);
      added++;
    }
    all.sort((a, b) => a[1] - b[1]);
    seen.clear();
    for (const [k, t] of all.slice(-maxEntries)) seen.set(k, t);
    stats.seeded += added;
    return added;
  }

  return { isDuplicate, seed, size: () => seen.size, stats: () => ({ ...stats, size: seen.size, windowMs, maxEntries }) };
}
