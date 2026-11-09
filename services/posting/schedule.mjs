// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled posting (flag `post-schedule`, off by default; D310 proposed). PURE: slot math and settings only. No network,
// no auth, no writes (the channel read is services/posting/schedule-read.mjs; the queue writes are auto-chain.mjs), so the
// read-only preview can import this file.
//
// Slot rule (settings in data/posting/schedule.json, never hardcoded):
//   anchor = the later of (a) the latest FUTURE publish time already scheduled on the channel (YouTube Studio) and
//            (b) the latest slot Ujwalam itself already gave out (queue items in any state, past or future);
//   slot   = anchor + intervalHours, but never earlier than now + minLeadHours; with no anchor at all, now + minLeadHours.
//   The result is rounded UP to the whole minute and is always UTC (RFC 3339 'Z'), so time zones and DST never matter.
// Slots are given out one by one in queue order; each new slot becomes the next anchor, so two clips never share a slot.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEDULE_FLAG = 'post-schedule';
export const DEFAULT_SCHEDULE = path.join(REPO, 'data', 'posting', 'schedule.json');
export const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class ScheduleError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ScheduleError'; this.code = code; }
}

/** Reads and checks data/posting/schedule.json. Throws ScheduleError('schedule-config-bad') on any bad value. */
export function loadScheduleConfig(file = DEFAULT_SCHEDULE) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new ScheduleError('schedule-config-bad', 'the schedule settings file could not be read'); }
  const num = (k, min, max) => {
    const v = j?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ScheduleError('schedule-config-bad', `schedule setting ${k} must be a number from ${min} to ${max}`);
    return v;
  };
  return {
    intervalHours: num('intervalHours', 0.25, 24 * 30),
    minLeadHours: num('minLeadHours', 0.25, 24 * 30),
    staleMinutes: num('staleMinutes', 1, 24 * 60),
    maxPages: Math.floor(num('maxPages', 1, 20)),
    pageSize: Math.floor(num('pageSize', 1, 50)),
  };
}

const ms = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
export const toIso = (t) => new Date(t).toISOString(); // always UTC with 'Z'

/** The next slot (ms since epoch) from the anchors. channelLast/ownLast: ms or null. Pure. */
export function nextSlot({ channelLast = null, ownLast = null, nowMs, cfg }) {
  const floor = nowMs + cfg.minLeadHours * HOUR_MS;
  const anchors = [channelLast, ownLast].filter((v) => Number.isFinite(v));
  const t = anchors.length ? Math.max(Math.max(...anchors) + cfg.intervalHours * HOUR_MS, floor) : floor;
  return Math.ceil(t / MINUTE_MS) * MINUTE_MS;
}

/** Slots for `count` clips in order, starting from the anchors. Pure. */
export function planSlots({ count, channelLast = null, ownLast = null, nowMs, cfg }) {
  const out = []; let own = ownLast;
  for (let i = 0; i < count; i++) { const s = nextSlot({ channelLast, ownLast: own, nowMs, cfg }); out.push(s); own = s; }
  return out;
}

/** Latest publish time (ms) Ujwalam already gave out, over queue items in any state; `except` = ids to leave out. */
export function ownLastSlot(items, except = new Set()) {
  let last = null;
  for (const it of items ?? []) {
    if (!isPlain(it) || except.has(it.id)) continue;
    const t = ms(it.publishAt);
    if (t !== null && (last === null || t > last)) last = t;
  }
  return last;
}

/** Latest future publish time among YouTube video resources (privacy private + publishAt after now). Past ones are ignored. */
export function latestFutureSchedule(videos, nowMs) {
  let last = null; let count = 0;
  for (const v of videos ?? []) {
    if (!isPlain(v) || v.status?.privacyStatus !== 'private') continue;
    const t = ms(v.status?.publishAt);
    if (t === null || t <= nowMs) continue;
    count++;
    if (last === null || t > last) last = t;
  }
  return { last, count };
}

/** A saved slot is too close (or past) to still be used for a NEW upload session: within staleMinutes of now. */
export const slotStale = (publishAt, nowMs, cfg) => { const t = ms(publishAt); return t === null || t <= nowMs + cfg.staleMinutes * MINUTE_MS; };

/** The channel's last known schedule as saved by the chain (for the preview's estimate); null when unknown or past. */
export function savedChannelLast(queueDoc, nowMs) {
  const t = ms(queueDoc?.schedule?.channelLast);
  return t !== null && t > nowMs ? t : null;
}
