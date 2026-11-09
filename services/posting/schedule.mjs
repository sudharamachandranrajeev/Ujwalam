// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled posting (flag `post-schedule`, off by default; D310 proposed). PURE: slot math and settings only. No network,
// no auth, no writes (the channel read is services/posting/schedule-read.mjs; the queue writes are auto-chain.mjs), so the
// read-only preview can import this file.
//
// Slot rule (settings in data/posting/schedule.json, never hardcoded):
//   anchor = the later of (a) the latest FUTURE publish time already scheduled on the channel (YouTube Studio) and
//            (b) the latest slot Ujwalam itself already gave out (queue items in any state, past or future);
//   floor  = now + minLeadHours + marginMinutes;
//   slot   = anchor + intervalHours, but never earlier than the floor; with no anchor at all, the floor.
//   The result is rounded UP to the whole minute and is always UTC (RFC 3339 'Z'), so time zones and DST never matter.
// Slots are given out one by one in queue order; each new slot becomes the next anchor, so two clips never share a slot.
// Check before an upload session starts or resumes: publishAt >= now + minLeadHours (leadOk). The margin in the floor
// is what lets a slot given out now pass that check when its upload starts a little later in the same batch.
// Check before every chunk: publishAt >= now + marginMinutes, so an upload never finishes with a past time.
// Bound on every chunk (youtube.mjs): the request is aborted at publishAt - chunkDeadlineSeconds, and the final chunk
// only starts when its estimated transfer (slowest measured chunk speed, else fallbackKbps) fits before that deadline.
//
// Retry close to its time (D314, user 2026-11-09; planQueueSlots below):
//   A queued clip with no open upload session whose time is less than minLeadHours away (or whose too-close time was
//   already dropped: `reslot`) is a RETRY. The first retry in queue order gets the floor again: now + minLeadHours +
//   marginMinutes, rounded up to the minute (1 h 15 min with the defaults). The user asked for "1 hour away"; exactly
//   1 h cannot pass the session check (>= now + minLeadHours when the upload session starts, a moment later), so the
//   closest safe value is the existing floor. If the clip is backing off after an error (nextAt later than now), the
//   floor counts from nextAt, because it cannot start sooner. The retry ignores the other anchors (the user's rule).
//   Every LATER queued clip in queue order that has no session yet is re-chained intervalHours apart from that time.
//   FIXED times never move: the channel's latest future scheduled post (channelLast), clips already uploaded, clips
//   with an open session (its publishAt is what Google will apply), failed clips (a failed slot stays a gap, D310) and
//   queued clips before the first retry in queue order. Each re-chained slot after the retry is at least intervalHours
//   after the previous chain slot AND after the latest fixed time, so a re-chain never moves a slot earlier than the
//   channel's latest scheduled post + intervalHours, and never into the gap after an uploaded clip.
//   Cap: a slot more than maxAheadDays (730 = 2 years) ahead is not assigned; the clip waits ('schedule-beyond-cap').
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
  const cfg = {
    intervalHours: num('intervalHours', 0.25, 24 * 30),
    minLeadHours: num('minLeadHours', 0.25, 24 * 30),
    marginMinutes: num('marginMinutes', 1, 4 * 60),
    chunkDeadlineSeconds: num('chunkDeadlineSeconds', 1, 3600),
    fallbackKbps: num('fallbackKbps', 64, 1000000),
    maxPages: Math.floor(num('maxPages', 1, 100)),
    pageSize: Math.floor(num('pageSize', 1, 50)),
    maxAheadDays: num('maxAheadDays', 1, 3650),
  };
  // A chunk may only start with at least marginMinutes left, and must end chunkDeadlineSeconds before the time:
  // a deadline at or past the margin would stop every final chunk.
  if (cfg.chunkDeadlineSeconds >= cfg.marginMinutes * 60) throw new ScheduleError('schedule-config-bad', 'schedule setting chunkDeadlineSeconds must be less than marginMinutes');
  return cfg;
}

const ms = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
export const toIso = (t) => new Date(t).toISOString(); // always UTC with 'Z'

/** The next slot (ms since epoch) from the anchors. channelLast/ownLast: ms or null. Pure. */
export function nextSlot({ channelLast = null, ownLast = null, nowMs, cfg }) {
  const floor = nowMs + cfg.minLeadHours * HOUR_MS + cfg.marginMinutes * MINUTE_MS;
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

/** True when publishAt is at least needMs ahead of now (unreadable = false). */
export const leadOk = (publishAt, nowMs, needMs) => { const t = ms(publishAt); return t !== null && t - nowMs >= needMs; };
/** A saved slot can no longer start or resume an upload session: less than minLeadHours ahead (or unreadable). */
export const slotTooClose = (publishAt, nowMs, cfg) => !leadOk(publishAt, nowMs, cfg.minLeadHours * HOUR_MS);
export const minLeadMs = (cfg) => cfg.minLeadHours * HOUR_MS;
export const marginMs = (cfg) => cfg.marginMinutes * MINUTE_MS;
/** Every chunk request is aborted this long before the publish time (so the last byte arrives before it or never). */
export const chunkDeadlineMs = (cfg) => cfg.chunkDeadlineSeconds * 1000;
/** Assumed upload speed (bytes/s) for the final-chunk estimate when no chunk was timed yet in this run. */
export const fallbackBps = (cfg) => (cfg.fallbackKbps * 1000) / 8;

/** Latest time (ms) a slot may have: now + maxAheadDays (D314). */
export const maxAheadMs = (nowMs, cfg) => nowMs + cfg.maxAheadDays * 24 * HOUR_MS;

/** D314 retry: a queued clip with no session whose time is too close to start an upload, or whose too-close time was
 *  already dropped (`reslot` saved on the item, or the 'slot-passed' reason from before D314). */
export const isRetry = (i, nowMs, cfg) => isPlain(i) && i.state === 'queued' && !i.session
  && (typeof i.publishAt === 'string' && i.publishAt ? slotTooClose(i.publishAt, nowMs, cfg) : (i.reslot === true || i.reason === 'slot-passed'));

/**
 * The slots to give out now over a whole queue (items in queue order, any state; see the D314 rule at the top). Pure.
 * Returns [{ id, at: ms | null, retry, rechain }] for every item that gets a new slot or must wait: `at` null = beyond
 * maxAheadDays (the item waits without a slot). Items not listed keep what they have.
 *   - new items (queued, no slot) before the first retry: the D310 rule (after the latest slot anywhere, after the channel).
 *   - the first retry: the floor (counted from its nextAt when that is later than now).
 *   - every later queued item with no session (retries, slotted, new): previous chain slot + interval, but never before
 *     the latest fixed time + interval.
 */
export function planQueueSlots({ items, channelLast = null, nowMs, cfg }) {
  const list = (items ?? []).filter(isPlain);
  const queued = list.filter((i) => i.state === 'queued');
  const first = queued.findIndex((i) => isRetry(i, nowMs, cfg));
  const chain = first >= 0 ? queued.slice(first).filter((i) => !i.session) : [];
  const inChain = new Set(chain.map((i) => i.id));
  const fresh = queued.filter((i) => !inChain.has(i.id) && !i.publishAt);
  const moving = new Set([...inChain, ...fresh.map((i) => i.id)]);
  const cap = maxAheadMs(nowMs, cfg);
  const out = [];
  // fixed = every time that stays (D310 anchors: any state, past or future; the floor makes the past ones irrelevant)
  let own = ownLastSlot(list, moving);
  for (const i of fresh) {
    const s = nextSlot({ channelLast, ownLast: own, nowMs, cfg });
    if (s > cap) { out.push({ id: i.id, at: null, retry: false, rechain: false }); continue; }
    out.push({ id: i.id, at: s, retry: false, rechain: false }); own = s;
  }
  let prev = null;
  for (const i of chain) {
    let s;
    if (prev === null) {
      const next = typeof i.nextAt === 'string' ? Date.parse(i.nextAt) : NaN;
      s = nextSlot({ nowMs: Number.isFinite(next) && next > nowMs ? next : nowMs, cfg });
    } else {
      s = nextSlot({ channelLast, ownLast: own === null ? prev : Math.max(own, prev), nowMs, cfg });
    }
    // prev advances even past the cap, so every later item is past it too (and none becomes a second 'first').
    out.push({ id: i.id, at: s > cap ? null : s, retry: isRetry(i, nowMs, cfg), rechain: true }); prev = s;
  }
  return out;
}

/** The channel's last known schedule as saved by the chain (for the preview's estimate); null when unknown or past. */
export function savedChannelLast(queueDoc, nowMs) {
  const t = ms(queueDoc?.schedule?.channelLast);
  return t !== null && t > nowMs ? t : null;
}
