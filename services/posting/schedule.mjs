// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled posting (flag `post-schedule`, off by default; D310, D314, D375). PURE: slot math and settings only. No network,
// no auth, no writes (the channel read is services/posting/schedule-read.mjs; the queue writes are auto-chain.mjs; the
// user's settings file is written by auto-settings.mjs), so the read-only preview can import this file.
//
// Slot rule (D375, user 2026-11-13: "schedule the post with a gap of 6 hours ... work around the existing schedule ...
// don't double post at the same time"; settings in data/posting/schedule.json, never hardcoded):
//   floor  = now + minLeadHours + marginMinutes, rounded UP to alignMinutes (60 = whole hours). A D314 retry that is
//            backing off after an error counts from its nextAt instead of now (it cannot start sooner).
//   taken  = every time a post already has: each scheduled post read from the channel (YouTube Studio's "Scheduled"),
//            each channel video that went public recently, every fixed queue time (uploaded, open upload session, failed
//            slot, queued with a usable slot) and every slot given out earlier in the same pass.
//   slot   = the earliest time >= floor, on the alignMinutes grid, that is at least intervalHours (6 h) away from EVERY
//            taken time. So new posts fill the free gaps around the existing schedule (e.g. 06:00, 12:00 and 18:00 on days
//            that only have a 00:00 post) and no two posts are ever less than intervalHours apart.
//   placement "after-last" (the D310 rule) instead starts the search at the latest taken time + intervalHours.
//   The result is always UTC (RFC 3339 'Z'), so time zones and DST never matter.
// Who gets a new slot in a pass: a queued item with no slot, and a D314 retry (a queued item with no upload session whose
// time is less than minLeadHours away, or whose too-close time was already dropped). Every other time stays as it is.
// Cap: a slot more than maxAheadDays (730 = 2 years) ahead is not given out; the item waits ('schedule-beyond-cap').
// Check before an upload session starts or resumes: publishAt >= now + minLeadHours (leadOk). The margin in the floor
// is what lets a slot given out now pass that check when its upload starts a little later in the same batch.
// Check before every chunk: publishAt >= now + marginMinutes, so an upload never finishes with a past time.
// Bound on every chunk (youtube.mjs): the request is aborted at publishAt - chunkDeadlineSeconds, and the final chunk
// only starts when its estimated transfer (slowest measured chunk speed, else fallbackKbps) fits before that deadline.
// The user's own settings (Settings > Posting & growth > Auto-post) live in <data dir>/posting/schedule.json and replace
// the shipped intervalHours, maxAheadDays and placement (and hold quotaUnitsPerDay, read by auto-settings.mjs).
import { existsSync, readFileSync } from 'node:fs';
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

export const USER_SCHEDULE_NAME = 'schedule.json';
/** The user's own schedule settings (Settings > Posting & growth > Auto-post): <dataDir>/posting/schedule.json. Only the
 *  keys in USER_KEYS are read from it; each replaces the shipped value. It survives app updates (data dir, not repo). */
export const userScheduleFile = (dataDir) => path.join(dataDir, 'posting', USER_SCHEDULE_NAME);
export const PLACEMENTS = Object.freeze(['fill-gaps', 'after-last']);
/** What the user may set, and the allowed whole-number ranges (2 days is the widest gap that is still a schedule;
 *  maxAheadDays 730 = the user's 2-year cap, D314; quota from 1,000 units up to a raised Google quota). */
export const USER_LIMITS = Object.freeze({
  intervalHours: { min: 1, max: 48 },
  maxAheadDays: { min: 1, max: 730 },
  quotaUnitsPerDay: { min: 1000, max: 10000000 },
});
export const USER_KEYS = Object.freeze(['intervalHours', 'maxAheadDays', 'placement', 'quotaUnitsPerDay']);

/** Checks a user settings object (only USER_KEYS; any may be missing). -> { values, problems: [{ key, text }] }. Pure. */
export function checkUserSchedule(j) {
  const values = {}; const problems = [];
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return { values, problems: [{ key: null, text: 'not a settings object' }] };
  for (const [k, lim] of Object.entries(USER_LIMITS)) {
    if (j[k] === undefined) continue;
    if (!Number.isInteger(j[k]) || j[k] < lim.min || j[k] > lim.max) problems.push({ key: k, text: `${k} must be a whole number from ${lim.min} to ${lim.max}` });
    else values[k] = j[k];
  }
  if (j.placement !== undefined) { if (PLACEMENTS.includes(j.placement)) values.placement = j.placement; else problems.push({ key: 'placement', text: `placement must be one of ${PLACEMENTS.join(', ')}` }); }
  return { values, problems };
}
const ALIGN_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

/**
 * Reads and checks data/posting/schedule.json. Throws ScheduleError('schedule-config-bad') on any bad value.
 * opts.userFile: the user's <data>/posting/schedule.json; when it exists its intervalHours, maxAheadDays and placement
 * replace the shipped ones (a bad or unreadable user file is refused, never ignored: fail closed). cfg.userKeys lists them.
 */
export function loadScheduleConfig(file = DEFAULT_SCHEDULE, { userFile = null } = {}) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new ScheduleError('schedule-config-bad', 'the schedule settings file could not be read'); }
  const num = (k, min, max, src = j) => {
    const v = src?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ScheduleError('schedule-config-bad', `schedule setting ${k} must be a number from ${min} to ${max}`);
    return v;
  };
  const placement = j?.placement ?? 'fill-gaps';
  if (!PLACEMENTS.includes(placement)) throw new ScheduleError('schedule-config-bad', `schedule setting placement must be one of ${PLACEMENTS.join(', ')}`);
  const alignMinutes = num('alignMinutes', 1, 60);
  if (!ALIGN_STEPS.includes(alignMinutes)) throw new ScheduleError('schedule-config-bad', `schedule setting alignMinutes must divide an hour (${ALIGN_STEPS.join(', ')})`);
  const cfg = {
    intervalHours: num('intervalHours', 0.25, 24 * 30),
    minLeadHours: num('minLeadHours', 0.25, 24 * 30),
    marginMinutes: num('marginMinutes', 1, 4 * 60),
    chunkDeadlineSeconds: num('chunkDeadlineSeconds', 1, 3600),
    fallbackKbps: num('fallbackKbps', 64, 1000000),
    maxPages: Math.floor(num('maxPages', 1, 100)),
    pageSize: Math.floor(num('pageSize', 1, 50)),
    maxAheadDays: num('maxAheadDays', 1, 3650),
    lookbackDays: num('lookbackDays', 1, 3650),
    alignMinutes,
    placement,
  };
  cfg.userKeys = [];
  if (typeof userFile === 'string' && userFile && existsSync(userFile)) {
    let u;
    try { u = JSON.parse(readFileSync(userFile, 'utf8')); } catch { throw new ScheduleError('schedule-config-bad', 'your schedule settings file (posting/schedule.json in the data folder) could not be read'); }
    const { values, problems } = checkUserSchedule(u);
    if (problems.length) throw new ScheduleError('schedule-config-bad', `your schedule settings: ${problems.map((p) => p.text).join('; ')}`);
    for (const k of ['intervalHours', 'maxAheadDays', 'placement']) if (values[k] !== undefined) { cfg[k] = values[k]; cfg.userKeys.push(k); }
  }
  // A chunk may only start with at least marginMinutes left, and must end chunkDeadlineSeconds before the time:
  // a deadline at or past the margin would stop every final chunk.
  if (cfg.chunkDeadlineSeconds >= cfg.marginMinutes * 60) throw new ScheduleError('schedule-config-bad', 'schedule setting chunkDeadlineSeconds must be less than marginMinutes');
  return cfg;
}

const ms = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
export const toIso = (t) => new Date(t).toISOString(); // always UTC with 'Z'
/** Rounded UP to the alignMinutes grid (UTC; 60 = whole hours). */
export const alignUp = (t, cfg) => { const a = (cfg.alignMinutes ?? 1) * MINUTE_MS; return Math.ceil(t / a) * a; };
/** The earliest a new slot may be: from + minLeadHours + marginMinutes, on the grid. */
export const floorFrom = (fromMs, cfg) => alignUp(fromMs + cfg.minLeadHours * HOUR_MS + cfg.marginMinutes * MINUTE_MS, cfg);

/**
 * Taken times kept sorted (ms), with the free-slot search. Each search step finds the taken times within the gap of the
 * candidate by binary search and jumps to the latest of them + gap: every time skipped is within the gap of that one,
 * so the answer is the first free one. Steps move strictly later and the list is finite, so it always ends.
 * free() remembers, per floor, where the last search ended: times before it were all taken then and taken times only
 * ever get added, so the next search with the same floor starts there. A pass over ~1500 new items (hourly slots for
 * two months) is then O(n log n), not O(n^2) or worse.
 */
export function createSlotter(times, cfg) {
  const gap = cfg.intervalHours * HOUR_MS;
  const list = (times ?? []).filter((t) => Number.isFinite(t)).sort((x, y) => x - y);
  const cursor = new Map();
  const lowerBound = (v) => { let lo = 0; let hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < v) lo = m + 1; else hi = m; } return lo; };
  /** The latest taken time t with |at - t| < gap, or null. */
  const conflict = (at) => { const k = lowerBound(at + gap) - 1; return k >= 0 && list[k] > at - gap ? list[k] : null; };
  return {
    add(t) { list.splice(lowerBound(t), 0, t); },
    times: () => list.slice(),
    latest: () => (list.length ? list[list.length - 1] : null),
    free(floor) {
      let at = alignUp(Math.max(floor, cursor.get(floor) ?? floor), cfg);
      for (let t = conflict(at); t !== null; t = conflict(at)) at = alignUp(t + gap, cfg);
      cursor.set(floor, at);
      return at;
    },
  };
}

/** The earliest time >= s (on the grid) that is at least intervalHours from every taken time (ms). Pure. */
export const earliestFree = (s, taken, cfg) => createSlotter(taken, cfg).free(s);

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

/** Every future publish time (ms, sorted) among YouTube video resources that are private with a publishAt after now. */
export function futureScheduleTimes(videos, nowMs) {
  const out = [];
  for (const v of videos ?? []) {
    if (!isPlain(v) || v.status?.privacyStatus !== 'private') continue;
    const t = ms(v.status?.publishAt);
    if (t !== null && t > nowMs) out.push(t);
  }
  return out.sort((a, b) => a - b);
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

/** Every time a queue item already holds (planned, sent to Google, or its open session's), in ms. */
export function itemTimes(i) {
  const out = [];
  for (const k of ['publishAt', 'sentPublishAt', 'sessionPublishAt']) { const v = ms(i?.[k]); if (v !== null && !out.includes(v)) out.push(v); }
  return out;
}

/**
 * The slots to give out now over a whole queue (items in queue order, any state; rule at the top). Pure.
 * channelTimes: the channel's scheduled posts and recently published videos (ms). channelLast: optional extra time.
 * Returns [{ id, at: ms | null, retry }] for every item that gets a new slot or must wait: `at` null = beyond
 * maxAheadDays (the item waits without a slot). Items not listed keep what they have.
 */
export function planQueueSlots({ items, channelLast = null, channelTimes = [], nowMs, cfg }) {
  const list = (items ?? []).filter(isPlain);
  const moving = list.filter((i) => i.state === 'queued' && (!i.publishAt || isRetry(i, nowMs, cfg)));
  const ids = new Set(moving.map((i) => i.id));
  const taken = [...(channelTimes ?? []), channelLast].filter((v) => Number.isFinite(v));
  for (const i of list) if (!ids.has(i.id)) taken.push(...itemTimes(i));
  const slots = createSlotter(taken, cfg);
  const cap = maxAheadMs(nowMs, cfg);
  const gap = cfg.intervalHours * HOUR_MS;
  const out = [];
  for (const i of moving) {
    const retry = isRetry(i, nowMs, cfg);
    const next = retry && typeof i.nextAt === 'string' ? Date.parse(i.nextAt) : NaN;
    let floor = floorFrom(Number.isFinite(next) && next > nowMs ? next : nowMs, cfg);
    if (cfg.placement === 'after-last' && slots.latest() !== null) floor = Math.max(floor, alignUp(slots.latest() + gap, cfg));
    const at = slots.free(floor);
    if (at > cap) { out.push({ id: i.id, at: null, retry }); continue; }
    out.push({ id: i.id, at, retry }); slots.add(at);
  }
  return out;
}

/** The next `count` slots a new item would get after the queue's own (for the schedule preview). Pure. */
export function nextFreeSlots({ items = [], channelTimes = [], count, nowMs, cfg }) {
  const virtual = Array.from({ length: count }, (_, n) => ({ id: `next:${n}`, state: 'queued', publishAt: null, session: null }));
  const plan = planQueueSlots({ items: [...items, ...virtual], channelTimes, nowMs, cfg });
  const byId = new Map(plan.map((p) => [p.id, p.at]));
  return virtual.map((v) => byId.get(v.id) ?? null);
}

/** Channel post times saved by the chain's last read (for the preview): future scheduled posts and recently published
 *  ones (recentTimes, kept so a new post is never within the gap of one that just went public). */
export function savedChannelTimes(queueDoc, nowMs) {
  const s = queueDoc?.schedule;
  const fut = Array.isArray(s?.channelTimes) ? s.channelTimes.map(ms).filter((t) => t !== null && t > nowMs) : [];
  const recent = Array.isArray(s?.recentTimes) ? s.recentTimes.map(ms).filter((t) => t !== null) : [];
  const last = ms(s?.channelLast);
  const out = [...fut, ...recent];
  if (last !== null && last > nowMs && !out.includes(last)) out.push(last);
  return out.sort((x, y) => x - y);
}
