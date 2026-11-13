// SPDX-License-Identifier: GPL-3.0-or-later
// D300 auto-post chain: after a clip job renders, package -> auto-approve (rules) -> private YouTube upload, with no
// manual CLI step. Behind the flags `posting` + `auto-post` (both off by default) and an `autoUpload` rule file.
//   createPostChain({ dataDir, ... }) -> { afterRun(runDir, status), tick(status), summary() }
//   readQueueSummary(dataDir)         -> plain-language queue state for the control page (no ids of tokens, no text)
// Safety (all fail closed):
//   - nothing uploads while any stream sink is active/starting, or when the output state cannot be read; the check is
//     repeated before every 8 MiB chunk, so a stream that starts mid-upload stops it (the session is kept and resumes).
//   - a recording running does not block (D300): a local recording uses disk and the encoder, an upload uses network and
//     a little CPU; the stream sinks are what an upload must never compete with.
//   - the ledger (youtube.mjs) refuses a second upload of the same video; the queue only adds retries around it.
//   - queue states: queued -> uploading -> done | failed. A failed try backs off (5 min, doubling, capped at 6 h);
//     "not signed in" and "stream live" waits cost no attempts. After MAX_ATTEMPTS the item is failed (kept for the user).
//   - tokens are never written: the queue holds post ids, states, times, the video id and the resumable session URL.
// Source (D375): the finished videos in the clips folder (clips-source.mjs; scanned every SCAN_EVERY_MS) and each clip
// job's run (afterRun) are packaged; posts are approved and queued oldest first (madeAt, from the file name).
// Scheduled posting (flag `post-schedule`, off; D310, D375; settings data/posting/schedule.json and the user's own
// <data>/posting/schedule.json from Settings > Posting & growth > Auto-post):
//   - an automatic upload ALWAYS has a publish time: with post-schedule off the items wait ('schedule-off'), they are
//     never uploaded without one (D375, user 2026-11-13: "upload the post as scheduled (not as private)").
//   - every queued item gets a slot (publishAt, UTC) before its upload starts: the earliest free time that is at least the
//     gap away from every scheduled or recently published post on the channel (read once per pass, only when an item
//     needs a slot) and every time already in this queue (rule: schedule.mjs, planQueueSlots); slots are saved on the
//     item, so a retry or restart reuses the same slot.
//   - fail closed: no readonly scope, a failed or incomplete (page cap hit) channel read or a bad settings file -> the
//     item waits without a slot (no attempt used), nothing is uploaded and no slot is guessed.
//   - a slot is never given back: a failed upload keeps it (that time stays empty on the channel).
//   - the slot is re-checked right before a session starts or resumes (>= now + minLeadHours) and before every chunk
//     (>= now + marginMinutes) in youtube.mjs; every chunk request is aborted chunkDeadlineSeconds before the time,
//     and the final chunk only starts if its estimated transfer fits. Too close: the upload stops ('slot-passed' / 'slot-passed-mid'), an
//     unfinished session is dropped, and on the next pass the item gets the next free slot by the same rule (D314, D375);
//     other queued items keep their slots.
//   - a queued slot with no session yet is re-checked before its upload starts (Codex review 2026-11-13): a due item
//     triggers a fresh channel read, and a slot that is now within the gap of a channel post or another kept slot (the
//     channel changed, or the gap grew) gets a new slot by the same rule (schedule.mjs planQueueSlots). A failed read
//     keeps such an item waiting; it never uploads on an unchecked slot.
//     A slot more than maxAheadDays ahead is not given out; the item waits ('schedule-beyond-cap'). Nothing finishes with a
//     passed time. Each session's own publish time is saved (sessionPublishAt) and the time recorded as posted is the
//     one Google really got; a finished upload whose time had already passed is marked plainly ('went-public-early').
//   - live: nothing changes. Approvals, slots and uploads all wait for the stream to end (same fail-closed check).
// After posting (flag `post-delete-uploaded`, off; D375): a done item is checked on YouTube (videos.list) every
// STATUS_EVERY_MS; once processed, the uploaded clips-folder file is deleted permanently (delete-uploaded.mjs: every
// check and the log). Each check also saves lastStatus { uploadStatus, privacyStatus, checkedAt }, so the queue can tell
// whether a post went public at its time.
// Daily budget (quota-budget.mjs, Codex review 2026-11-13): every upload start or resume counts against the rules'
// maxUploadsPerDay (UTC day) and the quota units (Pacific day); every API read (schedule reads, status checks) counts 1
// unit. Over budget: the items wait ('daily-cap-reached' / 'quota-day-used'), no attempt is used.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, createPostStore, packageRun, packageUploads, sha256File } from './index.mjs';
import { AUTO_FLAG, AUTO_LOG_NAME, UPLOAD_TARGET, UPLOAD_TARGETS, createAutoLog, createRulesSource, liveBlock, oldestFirst, rankerMinScore, runAuto } from './auto-post.mjs';
import { scanClipsFolder } from './clips-source.mjs';
import { DELETED_LOG_NAME, DELETE_FLAG, FINAL_KEEP, deleteUploadedFile } from './delete-uploaded.mjs';
import { clipsFolder } from '../studio-ui/user-settings.mjs';
import { createDataNotifier } from '../common/data-reload.mjs';
import { READONLY_SCOPE, createYoutubeAuth } from './oauth.mjs';
import { UploadError, checkUploadStatus, uploadPost } from './youtube.mjs';
import { DEFAULT_SCHEDULE, SCHEDULE_FLAG, ScheduleError, chunkDeadlineMs, fallbackBps, isRetry, loadScheduleConfig, marginMs, minLeadMs, planQueueSlots, toIso, userScheduleFile } from './schedule.mjs';
import { readChannelSchedule } from './schedule-read.mjs';
import { createQuotaBudget } from './quota-budget.mjs';
import { MIX_FLAG, appliedKindShares } from '../learning/mix.mjs';
import { removeTaskFile, writeTaskFile } from '../studio-ui/tasks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const QUEUE_NAME = 'upload-queue.json';
export const BASE_DELAY_MS = 5 * 60 * 1000;
export const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
export const SIGNIN_WAIT_MS = 30 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
export const TICK_EVERY_MS = 30 * 1000;
/** D375: how often the clips folder is scanned for new videos, and how often a posted video's status is checked. */
export const SCAN_EVERY_MS = 15 * 60 * 1000;
export const STATUS_EVERY_MS = 15 * 60 * 1000;
/** At most this many status checks per pass (1 quota unit each). */
export const STATUS_PER_PASS = 10;
const PERMANENT = new Set(['not-approved', 'video-changed', 'over-limit', 'unresolved-placeholders', 'unknown-post', 'video-missing', 'bad-publish-at']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const backoffMs = (attempts) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));

/** Only stream sinks matter for an upload (D300). A malformed sink or answer still reads as "unreadable" (fail closed). */
export function streamOnly(outputsStatus) {
  return async () => {
    const st = await outputsStatus();
    if (!isPlain(st) || !Array.isArray(st.sinks)) return st;
    return { ...st, sinks: st.sinks.filter((s) => !isPlain(s) || s.kind !== 'record') };
  };
}

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------- queue

export function createUploadQueue(file, now = () => Date.now()) {
  const read = () => { const j = readJson(file); return isPlain(j) && isPlain(j.items) ? j : { version: 1, items: {}, note: null }; };
  const write = (j) => writeJsonAtomic(file, j);
  return {
    file,
    items: () => Object.values(read().items),
    get: (id) => read().items[id] ?? null,
    note: () => read().note ?? null,
    setNote(note) { const j = read(); j.note = note ? { ...note, at: new Date(now()).toISOString() } : null; write(j); },
    /** Last channel schedule read (post-schedule): { channelLast, count, scanned, truncated, readAt }. Used by the preview. */
    schedule: () => read().schedule ?? null,
    setSchedule(s) { const j = read(); j.schedule = s; write(j); },
    /** Adds a queued item unless the id is already known (in any state). */
    add(id) {
      const j = read();
      if (Object.hasOwn(j.items, id)) return false;
      const at = new Date(now()).toISOString();
      j.items[id] = { id, state: 'queued', attempts: 0, nextAt: null, reason: null, videoId: null, session: null, enqueuedAt: at, updatedAt: at };
      write(j); return true;
    },
    patch(id, fields) {
      const j = read(); const it = j.items[id]; if (!it) return null;
      Object.assign(it, fields, { updatedAt: new Date(now()).toISOString() });
      write(j); return it;
    },
    /** "Retry now" (D301): a failed or waiting item is queued again at once with a fresh attempt count. Returns the item or null. */
    retryNow(id) {
      const j = read(); const it = j.items[id];
      if (!it || (it.state !== 'failed' && it.state !== 'queued')) return null;
      Object.assign(it, { state: 'queued', attempts: 0, nextAt: null, reason: null, updatedAt: new Date(now()).toISOString() });
      write(j); return it;
    },
    /** A crash mid-upload leaves 'uploading': it is just queued again (the saved session resumes it). */
    recover() {
      const j = read(); let n = 0;
      for (const it of Object.values(j.items)) if (it.state === 'uploading') { it.state = 'queued'; it.reason ??= 'interrupted'; n++; }
      if (n) write(j);
      return n;
    },
  };
}

const REASON_TEXT = {
  'no-oauth-client': 'Not signed in to YouTube: the Google sign-in client is not set up yet',
  'not-signed-in': 'Not signed in to YouTube',
  'stream-live': 'Waiting until the stream ends',
  'output-state-unreadable': 'Waiting: could not confirm that no stream is live',
  'credentials-unreadable': 'Not signed in to YouTube: the saved sign-in could not be read',
  interrupted: 'Resuming after a restart',
  'schedule-scope-missing': 'Sign in again to allow reading scheduled posts (node services/posting/cli.mjs youtube signin)',
  'schedule-read-failed': 'Waiting: could not read the scheduled posts in YouTube Studio; will try again',
  'schedule-config-bad': 'Waiting: the schedule settings are not valid (Settings > Posting & growth > Auto-post, or data/posting/schedule.json)',
  'schedule-read-incomplete': 'Waiting: Ujwalam could not read far enough back in the channel uploads to see every scheduled post; raise maxPages in data/posting/schedule.json',
  'schedule-off': 'Waiting: switch on Scheduled posting; automatic uploads always go up with a publish time',
  'slot-passed': 'Getting a new public time: the planned one came too close before the upload could finish',
  'schedule-beyond-cap': 'Waiting: the next free public time is further ahead than the schedule allows (days ahead, Settings > Posting & growth > Auto-post); planned again later',
  'stopped-by-user': 'Stopped by you; tried again at the next start',
  'daily-cap-reached': "Waiting: today's uploads per day are used up (Settings > Posting & growth > Auto-post); continues tomorrow (UTC)",
  'quota-day-used': "Waiting: today's YouTube quota is used up; continues after midnight Pacific time (ask Google for more: docs/plan/2026-11-12-growth-setup-notes.md)",
  'quota-unreadable': "Waiting: the YouTube quota settings or today's count could not be read (data/posting/quota.json, Settings > Posting & growth > Auto-post, posting/quota-day.json)",
  'quota-busy': "Waiting: today's YouTube quota count was busy; tried again shortly",
};

/** Plain words for a queue reason code (or a failure code). */
const FAIL_TEXT = {
  'over-limit': 'The text is over a platform limit; edit it in the Posts view',
  'unresolved-placeholders': 'The text still has an unfilled placeholder; fill it in the Posts view',
  'video-changed': 'The video file changed after it was approved',
  'video-missing': 'The video file is missing',
  'not-approved': 'The package is not approved',
  'unknown-post': 'The package was not found',
  'went-public-early': 'Uploaded, but its planned public time had already passed, so YouTube may have made it public at once; check it in YouTube Studio',
};
export function reasonText(code) {
  if (!code) return null;
  return REASON_TEXT[code] ?? FAIL_TEXT[code] ?? `Upload failed (${String(code).slice(0, 40)})`;
}

/** The publish time to show for a queue item: for an uploaded one, the time Google really got (null = none). */
export const shownPublishAt = (i) => (i?.state === 'done' ? (i.sentPublishAt ?? null) : (i?.publishAt ?? null));

/** Plain-language state for the control page. Counts and short fixed texts only. */
export function readQueueSummary(dataDir, flags = null, nowMs = Date.now()) {
  const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
  const items = q.items();
  const count = (s) => items.filter((i) => i.state === s).length;
  const waiting = items.filter((i) => i.state === 'queued');
  const reason = waiting.find((i) => i.reason && REASON_TEXT[i.reason])?.reason ?? q.note()?.blocked ?? null;
  const failed = items.filter((i) => i.state === 'failed');
  const s = { enabled: flags ? flags.isOn(POSTING_FLAG) && flags.isOn(AUTO_FLAG) : null, queued: count('queued'), uploading: count('uploading'), done: count('done'), failed: failed.length,
    reason, message: null, nextAt: waiting.map((i) => i.nextAt).filter(Boolean).sort()[0] ?? null, nextPublishAt: null, lastPublishAt: null };
  // post-schedule: the earliest and latest publish time still ahead (UTC ISO; the page shows them in local time).
  const ahead = items.filter((i) => i.state !== 'failed').map(shownPublishAt).filter((p) => typeof p === 'string' && Date.parse(p) > nowMs).sort();
  if (ahead.length) { s.nextPublishAt = ahead[0]; s.lastPublishAt = ahead[ahead.length - 1]; }
  if (s.uploading) s.message = `Uploading ${s.uploading} clip(s) to YouTube (scheduled)`;
  else if (s.queued) s.message = `${s.queued} clip(s) waiting to upload. ${REASON_TEXT[reason] ?? (s.nextAt ? 'Will retry after an error' : 'Waiting for its turn')}`;
  else if (s.failed) s.message = `${s.failed} upload(s) failed; see the Posts view`;
  else if (s.done) s.message = `${s.done} clip(s) uploaded to YouTube (scheduled)`;
  s.attention = items.filter((i) => i.reason === 'went-public-early').length;
  if (s.attention) s.message = `${s.attention} clip(s) may have gone public early (planned time had passed); check YouTube Studio. ${s.message ?? ''}`.trim();
  return s;
}

// ---------------------------------------------------------------- uploads.json (the finished-video list)

/** Fills `posted` on the uploads.json row(s) whose file is the uploaded video. Matches by run + content hash. */
export async function markPosted({ dataDir, run, sha256, postIdValue, videoId, at, privacy = 'private', target = UPLOAD_TARGET, publishAt = null }) {
  const file = path.join(dataDir, 'clips', 'uploads.json');
  const doc = readJson(file);
  if (!isPlain(doc) || !Array.isArray(doc.files)) return 0;
  let n = 0;
  for (const row of doc.files) {
    if (!isPlain(row) || row.run !== run || typeof row.file !== 'string' || !existsSync(row.file)) continue;
    if (!Array.isArray(row.posted)) row.posted = [];
    if (row.posted.some((p) => p?.platform === 'youtube' && p?.videoId === videoId)) continue;
    let h; try { h = await sha256File(row.file); } catch { continue; }
    if (h !== sha256) continue;
    row.posted.push({ platform: 'youtube', target, id: postIdValue, videoId, url: `https://youtu.be/${videoId}`, at, privacy, ...(publishAt ? { publishAt } : {}) });
    n++;
  }
  if (n) writeJsonAtomic(file, doc);
  return n;
}

// ---------------------------------------------------------------- the chain

/**
 * opts: { dataDir, log?, now?(ms), flags?, rulesFile?, profileFile?, ffmpeg?, fetchImpl?, auth?, chunkSize?,
 *         packageImpl? (tests), tickEveryMs?, rulesSource? (createRulesSource; default: one for dataDir/rulesFile) }
 * status arguments are the host's outputs.status answers (the launcher feeds one every 5 s).
 */
export function createPostChain(opts) {
  const dataDir = opts.dataDir;
  const log = opts.log ?? (() => {});
  const nowMs = opts.now ?? (() => Date.now());
  const ledgerFile = path.join(dataDir, 'posting', LEDGER_NAME);
  const autoLogFile = path.join(dataDir, 'posting', AUTO_LOG_NAME);
  const queue = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), nowMs);
  const flags = opts.flags ?? createFlags({ dataDir });
  let latest = null; let busy = false; let lastTick = 0; let recovered = false; let halted = false; let lastScan = -Infinity;
  const readProfile = () => { const pf = opts.profileFile ?? path.join(REPO, 'data', 'profile.local.json'); return existsSync(pf) ? (readJson(pf) ?? {}) : {}; };
  const flagsOn = () => flags.isOn(POSTING_FLAG) && flags.isOn(AUTO_FLAG);
  // LU2: the rules reload when the file changes; a broken file keeps the last good rules (notice in the task area).
  const rulesSrc = opts.rulesSource ?? createRulesSource({ dataDir, explicit: opts.rulesFile, report: createDataNotifier({ dataDir, writeTask: writeTaskFile, log }) });
  const scheduleOn = () => flags.isOn(SCHEDULE_FLAG);
  const outputsStatus = streamOnly(async () => { if (!latest) throw new Error('no output status yet'); return latest; });
  // D375 daily budget: uploads per day and quota units, persisted; every API read goes through apiFetch and is counted.
  const budget = opts.budget ?? createQuotaBudget({ dataDir, nowMs });
  const apiFetch = budget.meter(opts.fetchImpl ?? fetch);
  const getAuth = () => opts.auth ?? createYoutubeAuth({ browserOpen: async () => { throw new Error('sign-in is never started from the background'); } });

  const sessions = {
    get: (sha) => queue.items().find((i) => i.sha === sha)?.session ?? null,
    // The session's own publish time (null = sent without one) is saved with it: it is what Google will apply.
    set: (sha, url, publishAt = null) => { const it = queue.items().find((i) => i.sha === sha); if (it) queue.patch(it.id, { session: url, sessionPublishAt: url ? publishAt : null }); },
    publishAtOf: (sha) => queue.items().find((i) => i.sha === sha)?.sessionPublishAt ?? null,
  };
  // The shipped settings plus the user's own (Settings > Posting & growth > Auto-post), read again on every pass.
  const scheduleCfg = () => { try { return loadScheduleConfig(opts.scheduleFile ?? DEFAULT_SCHEDULE, { userFile: userScheduleFile(dataDir) }); } catch { return null; } };

  /** post-schedule: every queued item without a usable slot gets the next slot, in queue order. The channel is read once,
   *  and only when some item needs a slot or a due item's slot must be re-checked before its upload starts (dueIds).
   *  On any doubt (scope, read, settings) the items wait without a slot; a due item to re-check waits with its slot. */
  async function ensureSlots(auth, dueIds = new Set()) {
    const t = nowMs();
    const queued = queue.items().filter((i) => i.state === 'queued');
    const cfg = scheduleCfg();
    if (!cfg) {
      for (const i of queued) queue.patch(i.id, { reason: 'schedule-config-bad', nextAt: new Date(t + SIGNIN_WAIT_MS).toISOString() });
      log(`posting: ${REASON_TEXT['schedule-config-bad']}`);
      return null;
    }
    // A slot is needed by a new item or a D314 retry (too close, no session). An item waiting past the 2-year cap does not
    // trigger a channel read before its own wait ends (it is still re-planned when a read happens anyway).
    const capWait = (i) => i.reason === 'schedule-beyond-cap' && i.nextAt && Date.parse(i.nextAt) > t;
    const need = queued.filter((i) => !i.publishAt || isRetry(i, t, cfg));
    const recheck = queued.filter((i) => dueIds.has(i.id) && i.publishAt && !i.session && !isRetry(i, t, cfg));
    if (!need.some((i) => !capWait(i)) && !recheck.length) return cfg;
    const wait = (code, delay) => {
      // A too-close slot is dropped here (it can no longer be used) and marked for the D314 retry; nothing else is released.
      for (const i of need) queue.patch(i.id, { publishAt: null, reason: code, nextAt: new Date(t + delay).toISOString(), ...(isRetry(i, t, cfg) ? { reslot: true } : {}) });
      // A slot that could not be re-checked is kept but not used: the item waits for the next read.
      for (const i of recheck) queue.patch(i.id, { reason: code, nextAt: new Date(t + delay).toISOString() });
      log(`posting: ${REASON_TEXT[code] ?? code}; ${need.length + recheck.length} clip(s) wait for a checked publish time`);
    };
    // The read costs 1 unit per call: channels.list + 2 per page at most (a quick look first; reserved below).
    const readWhy = budget.readBlock(1 + 2 * cfg.maxPages);
    if (readWhy) { wait(readWhy, SIGNIN_WAIT_MS); return cfg; }
    let accessToken;
    try {
      const scopes = typeof auth.grantedScopes === 'function' ? await auth.grantedScopes() : null;
      if (!Array.isArray(scopes) || !scopes.includes(READONLY_SCOPE)) { wait('schedule-scope-missing', SIGNIN_WAIT_MS); return cfg; }
      accessToken = await auth.accessToken();
    } catch (e) { wait(e?.code === 'oauth-no-client' ? 'no-oauth-client' : 'not-signed-in', SIGNIN_WAIT_MS); return cfg; }
    let read;
    // The whole read's units are reserved before the first request (locked check + charge); unused ones are given back.
    let scan;
    try { scan = budget.reserveScan(1 + 2 * cfg.maxPages, opts.fetchImpl ?? fetch); } catch (e) { wait(String(e?.code ?? 'quota-unreadable'), SIGNIN_WAIT_MS); return cfg; }
    try { read = await readChannelSchedule({ accessToken, fetchImpl: scan.fetch, nowMs: t, cfg }); } catch (e) {
      const code = e instanceof ScheduleError ? e.code : 'schedule-read-failed';
      wait(code, code === 'schedule-scope-missing' ? SIGNIN_WAIT_MS : BASE_DELAY_MS);
      return cfg;
    } finally { scan.done(); }
    queue.setSchedule({ channelLast: read.last !== null ? toIso(read.last) : null, channelTimes: (read.times ?? []).map(toIso), recentTimes: (read.recent ?? []).map(toIso),
      count: read.count, scanned: read.scanned, truncated: read.truncated, readAt: toIso(t) });
    // Page cap hit: an older scheduled post could be past the pages read, so no slot is given out (never a guess).
    if (read.truncated) { wait('schedule-read-incomplete', SIGNIN_WAIT_MS); return cfg; }
    // D375 slots for new items and D314 retries: the gaps around the channel's scheduled and recent posts (schedule.mjs).
    const plan = planQueueSlots({ items: queue.items(), channelLast: read.last, channelTimes: [...(read.times ?? []), ...(read.recent ?? [])], nowMs: t, cfg });
    let given = 0; let moved = 0; let capped = 0;
    for (const p of plan) {
      const i = queue.get(p.id); if (!i || i.state !== 'queued') continue; // moved or removed by the card meanwhile
      const clear = typeof i.reason === 'string' && (i.reason.startsWith('schedule-') || i.reason === 'slot-passed' || i.reason === 'not-signed-in' || i.reason === 'no-oauth-client');
      if (p.at === null) {
        // Past maxAheadDays: no slot is given; the clip waits (no attempt used) and is planned again later.
        queue.patch(i.id, { publishAt: null, reslot: null, reason: 'schedule-beyond-cap', nextAt: new Date(t + MAX_DELAY_MS).toISOString() });
        capped++; continue;
      }
      const at = toIso(p.at);
      if (i.publishAt === at && !i.reslot) continue; // a slot that did not change
      if (i.publishAt) moved++; else given++;
      queue.patch(i.id, { publishAt: at, slotAt: toIso(t), reslot: null, ...(clear ? { reason: null, nextAt: null } : {}) });
    }
    if (given || moved) log(`posting: gave ${given} clip(s) a publish time and moved ${moved} (at least ${cfg.intervalHours} h apart)`);
    if (capped) log(`posting: ${REASON_TEXT['schedule-beyond-cap']}; ${capped} clip(s) wait`);
    return cfg;
  }

  async function processQueue(store, rules) {
    const due = queue.items().filter((i) => i.state === 'queued' && (!i.nextAt || Date.parse(i.nextAt) <= nowMs()));
    if (!due.length) return;
    // D375: an automatic upload always has a publish time. Without scheduled posting nothing uploads: the items wait.
    if (!scheduleOn()) {
      for (const i of due) queue.patch(i.id, { reason: 'schedule-off', nextAt: new Date(nowMs() + SIGNIN_WAIT_MS).toISOString() });
      log(`posting: ${REASON_TEXT['schedule-off']}; ${due.length} clip(s) wait`);
      return;
    }
    const blocked = await liveBlock(outputsStatus);
    if (blocked) {
      const why = blocked === 'output-live' ? 'stream-live' : blocked;
      queue.setNote({ blocked: why });
      for (const i of due) if (i.reason !== why) queue.patch(i.id, { reason: why });
      return;
    }
    queue.setNote(null);
    const auth = getAuth();
    let st;
    try { st = await auth.status(); } catch { st = null; }
    const stateReason = !st ? 'credentials-unreadable' : !st.hasClient ? 'no-oauth-client' : !st.signedIn ? 'not-signed-in' : null;
    if (stateReason) {
      for (const i of due) queue.patch(i.id, { reason: stateReason, nextAt: new Date(nowMs() + SIGNIN_WAIT_MS).toISOString() });
      log(`posting: ${REASON_TEXT[stateReason]}; ${due.length} clip(s) stay queued`);
      return;
    }
    // The daily budget first: a pass that cannot upload anything does not read the channel either.
    const capOf = Number.isInteger(rules?.maxUploadsPerDay) ? rules.maxUploadsPerDay : null;
    const overBudget = (items, why) => {
      for (const i of items) queue.patch(i.id, { reason: why, nextAt: new Date(nowMs() + SIGNIN_WAIT_MS).toISOString() });
      log(`posting: ${REASON_TEXT[why]}; ${items.length} clip(s) wait`);
    };
    const firstWhy = budget.uploadBlock(capOf);
    if (firstWhy) { overBudget(due, firstWhy); return; }
    const cfg = await ensureSlots(auth, new Set(due.map((i) => i.id)));
    if (!cfg) return; // no valid settings: nothing can be re-checked, so nothing uploads
    for (const [n, item] of due.entries()) {
      if (halted) return;
      if (await liveBlock(outputsStatus)) { queue.setNote({ blocked: 'stream-live' }); return; }
      // The item as it is now: the card may have moved or removed it since this pass began (D375).
      const cur = queue.get(item.id);
      if (!cur || cur.state !== 'queued') continue;
      const post = store.get(item.id);
      if (!post) { queue.patch(item.id, { state: 'failed', reason: 'unknown-post' }); continue; }
      if (post.status === 'uploaded') { queue.patch(item.id, { state: 'done', videoId: post.videoId, reason: null, session: null }); continue; }
      // Only an item with a slot uploads (the slot is fixed before the upload starts, never guessed).
      const publishAt = cur.publishAt ?? null;
      if (!publishAt) continue;
      let sha = item.sha; let run = item.run;
      if (!sha) {
        const dir = store.dir(item.id);
        const pj = dir ? readJson(path.join(dir, 'post.json')) : null;
        sha = pj?.source?.sha256 ?? null; run = pj?.source?.run ?? null;
        queue.patch(item.id, { sha, run });
      }
      // A slot that was due for its re-check but could not be checked (or was moved later) waits for its turn.
      if (cur.nextAt && Date.parse(cur.nextAt) > nowMs()) continue;
      // Every upload start or resume counts against today's budget: checked and charged in one locked step right before it.
      const why = budget.reserveUpload(capOf);
      if (why) { overBudget(due.slice(n).filter((i) => queue.get(i.id)?.state === 'queued'), why); return; }
      queue.patch(item.id, { state: 'uploading', reason: null, nextAt: null });
      // Task bar and tray (D311 proposed): an upload in progress is a task with its own progress (MB sent of MB).
      const task = { id: `upload-${String(item.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}`, kind: 'upload', title: 'Uploading a clip to YouTube (scheduled)', startedAt: nowMs(),
        stage: 'upload', stages: ['upload'], stageText: 'Uploading to YouTube', unit: 'MB' };
      task.activeAt = task.startedAt;
      let progressAt = null; // last chunk sent (the task panel's stall warning, 2026-11-10)
      const taskSay = (p) => writeTaskFile(dataDir, { ...task, updatedAt: nowMs(), progressAt, ...p });
      taskSay({ state: 'running', note: 'Starting the upload' });
      let taskEnd = { state: 'failed', note: 'Did not finish; it will be tried again' };
      try {
        const r = await uploadPost({
          id: item.id, store, auth, outputsStatus, fetchImpl: opts.fetchImpl, chunkSize: opts.chunkSize, sessions, publishAt,
          minLeadMs: minLeadMs(cfg), marginMs: marginMs(cfg), chunkDeadlineMs: chunkDeadlineMs(cfg), fallbackBps: fallbackBps(cfg), nowMs,
          // Runs before every chunk, ahead of youtube.mjs's own slot check (post-schedule): Stop all, the live pause, progress.
          beforeChunk: async (pr) => {
            if (halted) { taskEnd = { state: 'failed', note: 'Stopped by you; it is tried again at the next start' }; throw new UploadError('stopped-by-user', 'stopped'); }
            const b = await liveBlock(outputsStatus);
            if (b) { taskEnd = { state: 'waiting', note: 'Paused while the stream runs; it resumes after' }; throw new UploadError('stream-active', b); }
            if (pr && Number.isFinite(pr.total) && pr.total > 0) {
              const mb = (n) => Math.round(n / 1048576);
              progressAt = nowMs();
              taskSay({ state: 'running', done: mb(pr.offset), total: Math.max(1, mb(pr.total)), note: `${mb(pr.offset)} of ${mb(pr.total)} MB sent` });
            }
          },
        });
        // Record only the time Google really got with this video (the session's), never the planned one.
        const sent = r.publishAt ?? null;
        const early = sent !== null && Date.parse(sent) <= nowMs();
        taskEnd = { state: 'done', note: early ? 'Uploaded; its public time had passed, check it in YouTube Studio' : sent ? 'Uploaded (scheduled: goes public at its time)' : 'Uploaded (private)' };
        queue.patch(item.id, { state: 'done', videoId: r.videoId, reason: early ? 'went-public-early' : null, session: null, sentPublishAt: sent });
        // D375: the ledger keeps the publish time Google got next to the video id (the delete check needs both).
        if (sent) { try { store.ledger.annotate(sha, post.target, { publishAt: sent }); } catch { /* the delete check then keeps the file */ } }
        await markPosted({ dataDir, run, sha256: sha, postIdValue: item.id, videoId: r.videoId, at: new Date(nowMs()).toISOString(), target: post.target, publishAt: sent });
        log(`posting: uploaded ${item.id} (private${sent ? `, goes public ${sent}` : ''}${early ? '; its time had passed, check it in YouTube Studio' : ''})`);
      } catch (e) {
        const code = String(e?.code ?? 'error');
        if (code === 'already-uploaded') {
          // Uploaded earlier (e.g. by hand): which publish time it carried is unknown here, so none is recorded.
          taskEnd = { state: 'done', note: 'Already uploaded' };
          const v = store.get(item.id)?.videoId ?? null;
          queue.patch(item.id, { state: 'done', videoId: v, reason: null, session: null });
          if (v) await markPosted({ dataDir, run, sha256: sha, postIdValue: item.id, videoId: v, at: new Date(nowMs()).toISOString(), target: post.target });
        } else if (code === 'stopped-by-user') {
          queue.patch(item.id, { state: 'queued', reason: 'stopped-by-user' });
          return;
        } else if (code === 'slot-passed') {
          // No session runs now: the slot is too close to use; the next pass gives it now + lead + margin and re-chains the
          // later queued clips (D314; no attempt used).
          taskEnd = { state: 'waiting', note: 'Waiting: new public time' };
          queue.patch(item.id, { state: 'queued', publishAt: null, reslot: true, reason: 'slot-passed', nextAt: null });
          log(`posting: ${item.id}: ${REASON_TEXT['slot-passed']}`);
        } else if (code === 'slot-passed-mid') {
          // Stopped between chunks or aborted at the chunk deadline (not a failure); the next try drops the unfinished
          // session and gets a new slot.
          taskEnd = { state: 'waiting', note: 'Waiting: new public time' };
          queue.patch(item.id, { state: 'queued', reason: 'slot-passed', nextAt: null });
          log(`posting: ${item.id}: ${REASON_TEXT['slot-passed']}`);
        } else if (code === 'stream-active') {
          taskEnd = { state: 'waiting', note: 'Paused while the stream runs; it resumes after' }; // also the check before the first chunk
          queue.patch(item.id, { state: 'queued', reason: 'stream-live' });
          queue.setNote({ blocked: 'stream-live' });
          return;
        } else if (code === 'oauth-no-client' || code === 'oauth-reauth-needed') {
          queue.patch(item.id, { state: 'queued', reason: code === 'oauth-no-client' ? 'no-oauth-client' : 'not-signed-in', nextAt: new Date(nowMs() + SIGNIN_WAIT_MS).toISOString() });
          return;
        } else if (PERMANENT.has(code)) {
          queue.patch(item.id, { state: 'failed', reason: code });
        } else {
          const attempts = (queue.get(item.id)?.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) queue.patch(item.id, { state: 'failed', attempts, reason: code.slice(0, 40) });
          else queue.patch(item.id, { state: 'queued', attempts, reason: code.slice(0, 40), nextAt: new Date(nowMs() + backoffMs(attempts)).toISOString() });
          log(`posting: upload of ${item.id} failed (${code}); retry ${attempts < MAX_ATTEMPTS ? 'later' : 'not planned'}`);
        }
      } finally {
        // A paused or re-slotted upload leaves the task bar: it is queued again (resumes after the stream, at the next
        // start, or with its new public time) and the control page's upload queue shows it.
        if (taskEnd.state === 'waiting') removeTaskFile(dataDir, task.id); else taskSay(taskEnd);
      }
    }
  }

  /** D375: package the clips folder's videos that have no package yet (every SCAN_EVERY_MS). Never fails the pass. */
  async function scanFolder(profile) {
    try {
      const { rows } = scanClipsFolder({ dataDir, folder: opts.clipsFolder ?? clipsFolder(dataDir), ...(opts.probeSeconds ? { probeSeconds: opts.probeSeconds } : {}) });
      if (!rows.length) return 0;
      const r = await (opts.packageUploadsImpl ?? packageUploads)({ dataDir, ledgerFile, profile, ffmpeg: opts.ffmpeg, rows });
      if (r.packaged.length) log(`posting: packaged ${r.packaged.length} video(s) from the clips folder`);
      return r.packaged.length;
    } catch (e) { log(`posting: could not read the clips folder (${String(e?.code ?? e?.message ?? 'error').slice(0, 80)})`); return 0; }
  }

  /**
   * D375 (flag post-delete-uploaded): for each uploaded item, ask YouTube for its status (every STATUS_EVERY_MS, at most
   * STATUS_PER_PASS per pass) and delete the uploaded clips-folder file once it is processed (delete-uploaded.mjs).
   * Nothing happens while a stream runs or its state cannot be read. Any doubt keeps the file. -> number deleted.
   */
  async function deletePass(store) {
    if (!flags.isOn(DELETE_FLAG)) return 0;
    const t = nowMs();
    const due = queue.items().filter((i) => i.state === 'done' && typeof i.videoId === 'string' && i.videoId && i.deleteState !== 'deleted' && i.deleteState !== 'kept'
      && (!i.deleteCheckAt || Date.parse(i.deleteCheckAt) <= t)).slice(0, STATUS_PER_PASS);
    if (!due.length) return 0;
    if (await liveBlock(outputsStatus)) return 0;
    if (budget.readBlock(due.length)) return 0; // today's quota: checked again on a later pass
    const auth = getAuth();
    let accessToken;
    try { accessToken = await auth.accessToken(); } catch { return 0; } // not signed in: checked again on a later pass
    const folder = opts.clipsFolder ?? clipsFolder(dataDir);
    const names = [];
    for (const item of due) {
      const later = new Date(t + STATUS_EVERY_MS).toISOString();
      let status;
      try { status = await checkUploadStatus({ videoId: item.videoId, accessToken, fetchImpl: apiFetch }); } catch {
        queue.patch(item.id, { deleteReason: 'status-unreadable', deleteCheckAt: later }); continue;
      }
      queue.patch(item.id, { lastStatus: { uploadStatus: status.uploadStatus, privacyStatus: status.privacyStatus, checkedAt: toIso(t) } });
      const dir = store.dir(item.id);
      const pj = dir ? readJson(path.join(dir, 'post.json')) : null;
      const target = typeof pj?.target === 'string' ? pj.target : null;
      const ledgerEntry = target && item.sha ? store.ledger.get(item.sha, target) : null;
      const r = await deleteUploadedFile({ flagOn: flags.isOn(DELETE_FLAG), status, item: queue.get(item.id), ledgerEntry, file: pj?.source?.file ?? null,
        folder, logFile: path.join(dataDir, 'posting', DELETED_LOG_NAME), nowMs: t });
      if (r.deleted) { queue.patch(item.id, { deleteState: 'deleted', deletedAt: r.at, deleteReason: null, deleteCheckAt: null }); names.push(path.basename(pj.source.file)); continue; }
      if (FINAL_KEEP.has(r.reason)) queue.patch(item.id, { deleteState: 'kept', deleteReason: r.reason, deleteCheckAt: null });
      else queue.patch(item.id, { deleteReason: r.reason, deleteCheckAt: later });
    }
    if (names.length) {
      // One task bar line per batch (D375).
      writeTaskFile(dataDir, { id: `post-deleted-${t}`, kind: 'upload', title: `Deleted ${names.length} posted clip file(s)`, state: 'done', startedAt: t, updatedAt: t,
        note: `Deleted permanently after YouTube processed them: ${names.join(', ')}` });
      log(`posting: deleted ${names.length} posted clip file(s) from the clips folder (listed in posting/${DELETED_LOG_NAME})`);
    }
    return names.length;
  }

  /** Approvals by the rules, enqueue of auto-approved posts, then the due uploads. Safe to call often. */
  async function step() {
    if (!flagsOn()) return { skipped: 'flag-off' };
    if (halted) return { skipped: 'stopped' };
    let rules;
    try { rules = rulesSrc.get(); } catch (e) { return { skipped: 'bad-rules', detail: e?.code ?? 'error' }; }
    if (!rules.rules.length) return { skipped: 'no-rules' };
    if (!recovered) { recovered = true; queue.recover(); }
    if (opts.scanFolder !== false && nowMs() - lastScan >= (opts.scanEveryMs ?? SCAN_EVERY_MS)) { lastScan = nowMs(); await scanFolder(readProfile()); }
    const store = createPostStore({ ledgerFile, dataDir });
    // Approvals are local file work, but they share the fail-closed live check (unreadable state -> nothing happens).
    // RP5 (D373): the learned kind order only while the flag self-learning is on and a learned mix is in use
    let kindShares = null;
    if (flags.isOn(MIX_FLAG)) { try { kindShares = appliedKindShares(dataDir); } catch { kindShares = null; } }
    const r = await runAuto({ store, rules, outputsStatus, logFile: autoLogFile, now: () => new Date(nowMs()), kindShares, unscoredFloor: rankerMinScore() });
    if (rules.autoUpload) {
      const autoApproved = new Set(createAutoLog(autoLogFile).list().filter((e) => e.action === 'approve').map((e) => e.id));
      // Oldest clip first (D375): the queue's order is the order slots are given out in.
      for (const p of oldestFirst(store.list())) if (p.status === 'approved' && UPLOAD_TARGETS.includes(p.target) && autoApproved.has(p.id)) queue.add(p.id);
      await processQueue(store, rules);
    }
    const deleted = await deletePass(store);
    return { refused: r.refused, approved: r.done.filter((d) => d.action === 'approve').length, ...(deleted ? { deleted } : {}) };
  }

  async function guarded(fn) {
    if (busy) return { skipped: 'busy' };
    busy = true;
    try { return await fn(); } catch (e) { log(`posting: chain error (${String(e?.code ?? e?.name ?? 'error').slice(0, 40)})`); return { skipped: 'error' }; } finally { busy = false; }
  }

  return {
    queue,
    summary: () => readQueueSummary(dataDir, flags, nowMs()),
    /** After a successful clip job: package the run's finished clips, then step(). */
    afterRun(runDir, status) {
      if (status) latest = status;
      return guarded(async () => {
        if (!flagsOn()) return { skipped: 'flag-off' };
        const profile = readProfile();
        const pack = opts.packageImpl ?? packageRun;
        const runName = path.basename(runDir);
        // 1. Shorts with the clipper's scores (candidates.json + report.json). A montage-only run has neither: not an error.
        let packedClips = 0;
        try { packedClips = (await pack({ runDir, ledgerFile, profile, ffmpeg: opts.ffmpeg, targets: [UPLOAD_TARGET] })).packaged.length; } catch (e) {
          if (!['no-candidates', 'no-report'].includes(e?.code)) log(`posting: could not package clips of ${runName}: ${String(e?.message ?? 'error').slice(0, 120)}`);
        }
        // 2. Every validated published video of this run in uploads.json (short | montage | won-reel); same-bytes files are skipped.
        let packedVideos = 0;
        try { packedVideos = (await (opts.packageUploadsImpl ?? packageUploads)({ dataDir, ledgerFile, profile, ffmpeg: opts.ffmpeg, run: runName })).packaged.length; } catch (e) {
          log(`posting: could not package the finished videos of ${runName}: ${String(e?.message ?? 'error').slice(0, 120)}`);
          if (!packedClips) return { skipped: 'package-failed' };
        }
        log(`posting: packaged ${packedClips} clip(s) and ${packedVideos} finished video(s) from ${runName}`);
        lastTick = nowMs();
        return { packaged: packedClips + packedVideos, ...(await step()) };
      });
    },
    /** The tray's Stop all (D311 proposed): the upload in progress stops at its next chunk; nothing new starts this session. */
    stopTasks() { halted = true; },
    /** Called with each host status: remembers it, and every TICK_EVERY_MS retries what is due. */
    tick(status) {
      if (status) latest = status;
      if (nowMs() - lastTick < (opts.tickEveryMs ?? TICK_EVERY_MS)) return Promise.resolve({ skipped: 'throttled' });
      lastTick = nowMs();
      return guarded(step);
    },
  };
}
