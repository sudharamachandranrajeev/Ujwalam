// SPDX-License-Identifier: GPL-3.0-or-later
// D375 Auto-post settings without hand-editing JSON. The posting engine's settings API: the studio's Settings > Posting &
// growth > Auto-post card (services/studio-ui/server.mjs, a thin layer) calls these; another local app could call them
// the same way. Node stdlib only. Writes only the user's own files in the data dir, atomically:
//   <data>/posting/auto-post-rules.json   the rules (validated by validateRules in auto-post.mjs)
//   <data>/posting/schedule.json          intervalHours, maxAheadDays, placement, quotaUnitsPerDay (checkUserSchedule)
// Both are read again on the next pass (rules: a live source; schedule: loaded per pass), so nothing needs a restart.
//   readAutoPostSettings(dataDir)              -> { exists, custom, card, defaults, kinds, schedule, quota, limits }
//   saveAutoPostSettings(dataDir, body)        -> { ok: true, settings } | { ok: false, problems: [{ key, text }] }
//   The card: { autoUpload, kinds[], minScore, maxPerDay, intervalHours, maxAheadDays, placement, quotaUnitsPerDay }.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoPostError, MAX_PER_DAY, RULE_KINDS, rankerMinScore, userRulesFile, validateRules } from './auto-post.mjs';
import { DEFAULT_SCHEDULE, HOUR_MS, PLACEMENTS, USER_LIMITS, ScheduleError, alignUp, checkUserSchedule, floorFrom, itemTimes, loadScheduleConfig, maxAheadMs, nextFreeSlots, savedChannelTimes, toIso, userScheduleFile } from './schedule.mjs';
import { QUEUE_NAME, createUploadQueue } from './auto-chain.mjs';
import { READONLY_SCOPE } from './oauth.mjs';
import { readChannelSchedule } from './schedule-read.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_QUOTA = path.join(REPO, 'data', 'posting', 'quota.json');
/** The two rules the card writes: one per YouTube target (the target is chosen by length and aspect, limits.json). */
export const CARD_RULES = Object.freeze([{ id: 'auto-shorts', target: 'youtube-shorts' }, { id: 'auto-videos', target: 'youtube-video' }]);
export const KIND_LABELS = Object.freeze({ short: 'Short clips', montage: 'Montages', 'won-reel': 'Won-round reels', 'impact-play': 'Impact plays' });
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The user's own schedule settings as saved (only the known keys), or {} when there is no file or it is unreadable. */
export function readUserSchedule(dataDir) {
  const j = readJson(userScheduleFile(dataDir));
  return isPlain(j) ? checkUserSchedule(j).values : {};
}

/**
 * The quota numbers (data/posting/quota.json, quotaUnitsPerDay from the user's schedule settings when set) and how many
 * uploads a day fit: floor((quota - read reserve) / (insert + thumbnail)), at least 1. Throws when the data file is bad.
 */
export function loadQuota(dataDir, file = DEFAULT_QUOTA) {
  const j = readJson(file);
  const n = (k) => { const v = j?.[k]; if (!Number.isFinite(v) || v < 0) throw new Error(`quota setting ${k} is not valid`); return v; };
  const user = typeof dataDir === 'string' ? readUserSchedule(dataDir) : {};
  const quota = user.quotaUnitsPerDay ?? n('quotaUnitsPerDay');
  const perUpload = n('insertUnits') + n('thumbnailUnits');
  const reserve = n('readReserveUnits');
  const fit = Math.max(1, perUpload > 0 ? Math.floor((quota - reserve) / perUpload) : MAX_PER_DAY);
  return { quotaUnitsPerDay: quota, perUploadUnits: perUpload, readReserveUnits: reserve, uploadsPerDayFit: Math.min(fit, MAX_PER_DAY), userSet: user.quotaUnitsPerDay !== undefined };
}

/** What the card shows when the user has no rules file yet (D375): upload on, every kind, the ranker's own floor as the
 *  minimum score (every clip the ranker keeps; the best go first inside the daily cap), as many a day as the quota fits. */
export function defaultCard(dataDir) {
  const q = loadQuota(dataDir);
  let cfg; // a broken user file is reported by readAutoPostSettings; the defaults still come from the shipped one
  try { cfg = scheduleConfigFor(dataDir); } catch { cfg = loadScheduleConfig(DEFAULT_SCHEDULE); }
  return { autoUpload: true, kinds: [...RULE_KINDS], minScore: rankerMinScore() ?? 0, maxPerDay: q.uploadsPerDayFit,
    intervalHours: cfg.intervalHours, maxAheadDays: cfg.maxAheadDays, placement: cfg.placement, quotaUnitsPerDay: q.quotaUnitsPerDay };
}

/** The schedule settings in use: the shipped file plus the user's own (throws ScheduleError when either is bad). */
export const scheduleConfigFor = (dataDir) => loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: typeof dataDir === 'string' ? userScheduleFile(dataDir) : null });

/** The rules file the card writes. Pure. */
export function rulesFromCard(card) {
  return {
    $comment: 'Written by Settings > Posting & growth > Auto-post (D375). You can still edit it by hand; the card then says it has your own rules and Save replaces them.',
    version: '0.2.0',
    autoUpload: card.autoUpload === true,
    maxUploadsPerDay: card.maxPerDay,
    rules: CARD_RULES.map((r) => ({ id: r.id, target: r.target, minScore: card.minScore, kinds: [...card.kinds], maxPerDay: card.maxPerDay })),
  };
}

/** The card values held in a rules doc. custom = the doc is not the card's own shape (Save would replace it). Pure. */
export function cardFromRules(doc) {
  const v = validateRules(doc);
  const own = v.rules.length === CARD_RULES.length && CARD_RULES.every((c, i) => v.rules[i].id === c.id && v.rules[i].target === c.target)
    && v.rules.every((r) => r.minScore === v.rules[0].minScore && r.maxPerDay === v.rules[0].maxPerDay && !r.layouts && r.kinds.join() === v.rules[0].kinds.join());
  const first = v.rules[0];
  return {
    custom: !own,
    card: { autoUpload: v.autoUpload, kinds: first ? [...first.kinds] : [], minScore: first ? first.minScore : null, maxPerDay: v.maxUploadsPerDay ?? (first ? first.maxPerDay : null) },
  };
}

/** Checks the card's values. -> { card, problems }. Pure (the ranges are data: USER_LIMITS, RULE_KINDS, MAX_PER_DAY). */
export function checkCard(body) {
  const problems = [];
  const c = isPlain(body) ? body : {};
  const add = (key, text) => problems.push({ key, text });
  if (typeof c.autoUpload !== 'boolean') add('autoUpload', 'upload automatically must be on or off');
  const kinds = Array.isArray(c.kinds) ? [...new Set(c.kinds)] : null;
  if (!kinds || !kinds.length || !kinds.every((k) => RULE_KINDS.includes(k))) add('kinds', `choose at least one of ${RULE_KINDS.map((k) => KIND_LABELS[k]).join(', ')}`);
  if (!Number.isFinite(c.minScore) || c.minScore < 0 || c.minScore > 100) add('minScore', 'the minimum clip score must be a number from 0 to 100');
  if (!Number.isInteger(c.maxPerDay) || c.maxPerDay < 1 || c.maxPerDay > MAX_PER_DAY) add('maxPerDay', `uploads per day must be a whole number from 1 to ${MAX_PER_DAY}`);
  const sched = {};
  for (const k of ['intervalHours', 'maxAheadDays', 'placement', 'quotaUnitsPerDay']) if (c[k] !== undefined) sched[k] = c[k];
  const s = checkUserSchedule(sched);
  problems.push(...s.problems);
  return { card: { autoUpload: c.autoUpload === true, kinds: kinds ?? [], minScore: c.minScore, maxPerDay: c.maxPerDay, ...s.values }, problems };
}

/** Everything the card needs. Never throws for a bad user file: it says so (error) and shows the defaults. */
export function readAutoPostSettings(dataDir) {
  const defaults = defaultCard(dataDir);
  const rulesFile = userRulesFile(dataDir);
  const exists = existsSync(rulesFile);
  let card = { ...defaults }; let custom = false; let error = null;
  if (exists) {
    try {
      const r = cardFromRules(readJson(rulesFile) ?? (() => { throw new AutoPostError('bad-rules', 'rules file: not valid JSON'); })());
      custom = r.custom;
      card = { ...defaults, ...Object.fromEntries(Object.entries(r.card).filter(([, v]) => v !== null)) };
    } catch (e) { error = e?.message ?? 'rules file could not be read'; }
  }
  let scheduleError = null;
  try { scheduleConfigFor(dataDir); } catch (e) { scheduleError = e instanceof ScheduleError ? e.message : 'schedule settings could not be read'; }
  const quota = loadQuota(dataDir);
  return {
    exists, custom, error, scheduleError, card, defaults,
    kinds: RULE_KINDS.map((id) => ({ id, label: KIND_LABELS[id] ?? id })),
    quota,
    limits: { maxPerDay: MAX_PER_DAY, minScore: { min: 0, max: 100 }, ...USER_LIMITS, placements: PLACEMENTS },
  };
}

/**
 * Saves the card in one click (D332): the rules file and the user's schedule settings, each written atomically after
 * every value was checked. Nothing is written when any value is wrong. body: { card } (the card's values) or
 * { doc } (a whole rules file, checked with validateRules; the schedule is left as it is).
 */
export function saveAutoPostSettings(dataDir, body) {
  if (!isPlain(body)) return { ok: false, problems: [{ key: null, text: 'nothing to save' }] };
  if (body.doc !== undefined) {
    try { validateRules(body.doc); } catch (e) { return { ok: false, problems: [{ key: 'doc', text: e?.message ?? 'rules file not valid' }] }; }
    writeJsonAtomic(userRulesFile(dataDir), body.doc);
    return { ok: true, settings: readAutoPostSettings(dataDir) };
  }
  const { card, problems } = checkCard(body.card);
  if (problems.length) return { ok: false, problems };
  const doc = rulesFromCard(card);
  validateRules(doc); // the card's own shape always passes; checked again so a bad file can never be written
  const sched = { ...readUserSchedule(dataDir) };
  for (const k of ['intervalHours', 'maxAheadDays', 'placement', 'quotaUnitsPerDay']) if (card[k] !== undefined) sched[k] = card[k];
  writeJsonAtomic(userScheduleFile(dataDir), {
    $comment: 'Your posting schedule (Settings > Posting & growth > Auto-post, D375). Replaces the shipped values in data/posting/schedule.json and data/posting/quota.json.',
    ...sched,
  });
  writeJsonAtomic(userRulesFile(dataDir), doc);
  return { ok: true, settings: readAutoPostSettings(dataDir) };
}

// ---------------------------------------------------------------- schedule preview and queue edits (D375)

const queueOf = (dataDir) => createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
const ms = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const SCHEDULE_REASONS = new Set(['slot-passed', 'not-signed-in', 'no-oauth-client']);

/**
 * What the card's "Next posting times" list shows. channel = { times: [ms], recent: [ms], readAt } from a fresh read,
 * or null to use the times the chain saved at its last read. -> { channel: [iso], queue: [{ id, state, publishAt,
 * reason }], next: [iso], intervalHours, placement, maxAheadDays, channelReadAt, source: 'live'|'saved'|'none', error }.
 */
export function schedulePreview(dataDir, { nowMs = Date.now(), count = 10, channel = null } = {}) {
  let cfg;
  try { cfg = scheduleConfigFor(dataDir); } catch (e) { return { error: e instanceof ScheduleError ? e.code : 'schedule-config-bad', channel: [], queue: [], next: [] }; }
  const q = queueOf(dataDir);
  const doc = { items: Object.fromEntries(q.items().map((i) => [i.id, i])), schedule: q.schedule() };
  const items = Object.values(doc.items);
  const channelTimes = channel
    ? [...(channel.times ?? []).filter((t) => t > nowMs), ...(channel.recent ?? [])].sort((a, b) => a - b)
    : savedChannelTimes(doc, nowMs);
  const truncated = channel ? channel.truncated === true : doc.schedule?.truncated === true;
  const n = Math.max(0, Math.min(50, Math.trunc(count) || 0));
  const next = truncated ? [] : nextFreeSlots({ items, channelTimes, count: n, nowMs, cfg }).filter((t) => t !== null).map(toIso);
  const shown = (i) => (i.state === 'done' ? (i.sentPublishAt ?? null) : (i.publishAt ?? null));
  return {
    error: truncated ? 'schedule-read-incomplete' : null,
    channel: channelTimes.filter((t) => t > nowMs).map(toIso),
    queue: items.filter((i) => i.state === 'queued' || i.state === 'uploading' || (i.state === 'done' && ms(shown(i)) > nowMs))
      .map((i) => ({ id: i.id, state: i.state, publishAt: shown(i), reason: i.reason ?? null, movable: i.state === 'queued' && !i.session }))
      .sort((a, b) => (ms(a.publishAt) ?? Infinity) - (ms(b.publishAt) ?? Infinity)),
    next, intervalHours: cfg.intervalHours, placement: cfg.placement, maxAheadDays: cfg.maxAheadDays,
    channelReadAt: channel ? (channel.readAt ?? toIso(nowMs)) : (doc.schedule?.readAt ?? null),
    source: channel ? 'live' : doc.schedule ? 'saved' : 'none',
  };
}

/**
 * Moves one queued, not-yet-uploaded clip to another time (the card's "Move"). The time must be on the schedule grid,
 * at least the lead time from now, not past the days-ahead limit, and at least the gap away from every other post (the
 * channel's saved times and every other time in the queue). -> { ok: true, item } | { ok: false, code, text }.
 */
export function moveQueueItem(dataDir, id, at, { nowMs = Date.now() } = {}) {
  const no = (code, text) => ({ ok: false, code, text });
  let cfg;
  try { cfg = scheduleConfigFor(dataDir); } catch { return no('schedule-config-bad', 'the schedule settings are not valid'); }
  const q = queueOf(dataDir);
  const it = q.get(id);
  if (!it) return no('unknown', 'that clip is not in the upload queue');
  if (it.state !== 'queued' || it.session) return no('not-movable', 'only a clip that has not started uploading can be moved');
  const t = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(at) ? ms(at) : null;
  if (t === null) return no('bad-time', 'the time is not valid (UTC, e.g. 2026-11-14T18:00:00Z)');
  if (alignUp(t, cfg) !== t) return no('off-grid', `pick a time on the ${cfg.alignMinutes}-minute grid`);
  if (t < floorFrom(nowMs, cfg)) return no('too-soon', 'that time is too soon for the upload to finish first');
  if (t > maxAheadMs(nowMs, cfg)) return no('too-far', `that time is more than ${cfg.maxAheadDays} days ahead`);
  const doc = { schedule: q.schedule() };
  const others = q.items().filter((i) => i.id !== id).flatMap(itemTimes);
  const gap = cfg.intervalHours * HOUR_MS;
  if ([...savedChannelTimes(doc, nowMs), ...others].some((x) => Math.abs(x - t) < gap)) return no('taken', `another post is less than ${cfg.intervalHours} h from that time`);
  const item = q.patch(id, { publishAt: toIso(t), slotAt: toIso(nowMs), reslot: null, movedByUser: true,
    ...(typeof it.reason === 'string' && (it.reason.startsWith('schedule-') || SCHEDULE_REASONS.has(it.reason)) ? { reason: null, nextAt: null } : {}) });
  return { ok: true, item };
}

/** Takes one clip that has not been uploaded out of the queue (the card's "Remove"); it is never queued again by itself.
 *  The package stays (Posts view). -> { ok: true, item } | { ok: false, code, text }. */
export function removeQueueItem(dataDir, id) {
  const q = queueOf(dataDir);
  const it = q.get(id);
  if (!it) return { ok: false, code: 'unknown', text: 'that clip is not in the upload queue' };
  if (it.state !== 'queued' && it.state !== 'failed') return { ok: false, code: 'not-removable', text: 'only a clip that is waiting to upload can be removed' };
  return { ok: true, item: q.patch(id, { state: 'removed', publishAt: null, session: null, sessionPublishAt: null, reslot: null, nextAt: null, reason: 'removed-by-user' }) };
}

/** A fresh read of the channel's schedule for the card (read-only; needs the readonly sign-in scope). Throws
 *  ScheduleError ('schedule-scope-missing', 'schedule-read-failed', ...) or the auth error. -> the schedulePreview channel. */
export async function readChannelForPreview({ dataDir, auth, fetchImpl = fetch, nowMs = Date.now() }) {
  const cfg = scheduleConfigFor(dataDir);
  const scopes = typeof auth.grantedScopes === 'function' ? await auth.grantedScopes() : null;
  if (!Array.isArray(scopes) || !scopes.includes(READONLY_SCOPE)) throw new ScheduleError('schedule-scope-missing', 'sign in again to allow reading scheduled posts');
  const read = await readChannelSchedule({ accessToken: await auth.accessToken(), fetchImpl, nowMs, cfg });
  return { times: read.times ?? [], recent: read.recent ?? [], truncated: read.truncated === true, readAt: toIso(nowMs) };
}
