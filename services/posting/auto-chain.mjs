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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, createPostStore, packageRun, packageUploads, sha256File } from './index.mjs';
import { AUTO_FLAG, AUTO_LOG_NAME, UPLOAD_TARGET, UPLOAD_TARGETS, createAutoLog, liveBlock, loadRules, runAuto } from './auto-post.mjs';
import { createYoutubeAuth } from './oauth.mjs';
import { UploadError, uploadPost } from './youtube.mjs';
import { removeTaskFile, writeTaskFile } from '../studio-ui/tasks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const QUEUE_NAME = 'upload-queue.json';
export const BASE_DELAY_MS = 5 * 60 * 1000;
export const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
export const SIGNIN_WAIT_MS = 30 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
export const TICK_EVERY_MS = 30 * 1000;
const PERMANENT = new Set(['not-approved', 'video-changed', 'over-limit', 'unresolved-placeholders', 'unknown-post', 'video-missing']);
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
  'stopped-by-user': 'Stopped by you; tried again at the next start',
};

/** Plain words for a queue reason code (or a failure code). */
const FAIL_TEXT = {
  'over-limit': 'The text is over a platform limit; edit it in the Posts view',
  'unresolved-placeholders': 'The text still has an unfilled placeholder; fill it in the Posts view',
  'video-changed': 'The video file changed after it was approved',
  'video-missing': 'The video file is missing',
  'not-approved': 'The package is not approved',
  'unknown-post': 'The package was not found',
};
export function reasonText(code) {
  if (!code) return null;
  return REASON_TEXT[code] ?? FAIL_TEXT[code] ?? `Upload failed (${String(code).slice(0, 40)})`;
}

/** Plain-language state for the control page. Counts and short fixed texts only. */
export function readQueueSummary(dataDir, flags = null) {
  const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
  const items = q.items();
  const count = (s) => items.filter((i) => i.state === s).length;
  const waiting = items.filter((i) => i.state === 'queued');
  const reason = waiting.find((i) => i.reason && REASON_TEXT[i.reason])?.reason ?? q.note()?.blocked ?? null;
  const failed = items.filter((i) => i.state === 'failed');
  const s = { enabled: flags ? flags.isOn(POSTING_FLAG) && flags.isOn(AUTO_FLAG) : null, queued: count('queued'), uploading: count('uploading'), done: count('done'), failed: failed.length,
    reason, message: null, nextAt: waiting.map((i) => i.nextAt).filter(Boolean).sort()[0] ?? null };
  if (s.uploading) s.message = `Uploading ${s.uploading} clip(s) to YouTube (private)`;
  else if (s.queued) s.message = `${s.queued} clip(s) waiting to upload. ${REASON_TEXT[reason] ?? (s.nextAt ? 'Will retry after an error' : 'Waiting for its turn')}`;
  else if (s.failed) s.message = `${s.failed} upload(s) failed; see the Posts view`;
  else if (s.done) s.message = `${s.done} clip(s) uploaded to YouTube (private)`;
  return s;
}

// ---------------------------------------------------------------- uploads.json (the finished-video list)

/** Fills `posted` on the uploads.json row(s) whose file is the uploaded video. Matches by run + content hash. */
export async function markPosted({ dataDir, run, sha256, postIdValue, videoId, at, privacy = 'private', target = UPLOAD_TARGET }) {
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
    row.posted.push({ platform: 'youtube', target, id: postIdValue, videoId, url: `https://youtu.be/${videoId}`, at, privacy });
    n++;
  }
  if (n) writeJsonAtomic(file, doc);
  return n;
}

// ---------------------------------------------------------------- the chain

/**
 * opts: { dataDir, log?, now?(ms), flags?, rulesFile?, profileFile?, ffmpeg?, fetchImpl?, auth?, chunkSize?,
 *         packageImpl? (tests), tickEveryMs? }
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
  let latest = null; let busy = false; let lastTick = 0; let recovered = false; let halted = false;
  const flagsOn = () => flags.isOn(POSTING_FLAG) && flags.isOn(AUTO_FLAG);
  const outputsStatus = streamOnly(async () => { if (!latest) throw new Error('no output status yet'); return latest; });
  const getAuth = () => opts.auth ?? createYoutubeAuth({ browserOpen: async () => { throw new Error('sign-in is never started from the background'); } });

  const sessions = {
    get: (sha) => queue.items().find((i) => i.sha === sha)?.session ?? null,
    set: (sha, url) => { const it = queue.items().find((i) => i.sha === sha); if (it) queue.patch(it.id, { session: url }); },
  };

  async function processQueue(store, rules) {
    const due = queue.items().filter((i) => i.state === 'queued' && (!i.nextAt || Date.parse(i.nextAt) <= nowMs()));
    if (!due.length) return;
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
    for (const item of due) {
      if (halted) return;
      if (await liveBlock(outputsStatus)) { queue.setNote({ blocked: 'stream-live' }); return; }
      const post = store.get(item.id);
      if (!post) { queue.patch(item.id, { state: 'failed', reason: 'unknown-post' }); continue; }
      if (post.status === 'uploaded') { queue.patch(item.id, { state: 'done', videoId: post.videoId, reason: null, session: null }); continue; }
      let sha = item.sha; let run = item.run;
      if (!sha) {
        const dir = store.dir(item.id);
        const pj = dir ? readJson(path.join(dir, 'post.json')) : null;
        sha = pj?.source?.sha256 ?? null; run = pj?.source?.run ?? null;
        queue.patch(item.id, { sha, run });
      }
      queue.patch(item.id, { state: 'uploading', reason: null, nextAt: null });
      // Task bar and tray (D311 proposed): an upload in progress is a task with its own progress (MB sent of MB).
      const task = { id: `upload-${String(item.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}`, kind: 'upload', title: 'Uploading a clip to YouTube (private)', startedAt: nowMs() };
      const taskSay = (p) => writeTaskFile(dataDir, { ...task, updatedAt: nowMs(), ...p });
      taskSay({ state: 'running', note: 'Starting the upload' });
      let taskEnd = { state: 'failed', note: 'Did not finish; it will be tried again' };
      try {
        const r = await uploadPost({
          id: item.id, store, auth, outputsStatus, fetchImpl: opts.fetchImpl, chunkSize: opts.chunkSize, sessions,
          beforeChunk: async (pr) => {
            if (halted) { taskEnd = { state: 'failed', note: 'Stopped by you; it is tried again at the next start' }; throw new UploadError('stopped-by-user', 'stopped'); }
            const b = await liveBlock(outputsStatus);
            if (b) { taskEnd = { state: 'waiting', note: 'Paused while the stream runs; it resumes after' }; throw new UploadError('stream-active', b); }
            if (pr && Number.isFinite(pr.total) && pr.total > 0) {
              const mb = (n) => Math.round(n / 1048576);
              taskSay({ state: 'running', done: mb(pr.offset), total: Math.max(1, mb(pr.total)), note: `${mb(pr.offset)} of ${mb(pr.total)} MB sent` });
            }
          },
        });
        taskEnd = { state: 'done', note: 'Uploaded (private)' };
        queue.patch(item.id, { state: 'done', videoId: r.videoId, reason: null, session: null });
        await markPosted({ dataDir, run, sha256: sha, postIdValue: item.id, videoId: r.videoId, at: new Date(nowMs()).toISOString(), target: post.target });
        log(`posting: uploaded ${item.id} (private)`);
      } catch (e) {
        const code = String(e?.code ?? 'error');
        if (code === 'already-uploaded') {
          taskEnd = { state: 'done', note: 'Already uploaded' };
          const v = store.get(item.id)?.videoId ?? null;
          queue.patch(item.id, { state: 'done', videoId: v, reason: null, session: null });
          if (v) await markPosted({ dataDir, run, sha256: sha, postIdValue: item.id, videoId: v, at: new Date(nowMs()).toISOString(), target: post.target });
        } else if (code === 'stopped-by-user') {
          queue.patch(item.id, { state: 'queued', reason: 'stopped-by-user' });
          return;
        } else if (code === 'stream-active') {
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
        // A paused upload leaves the task bar: it is queued again (resumes after the stream, or at the next start) and
        // the control page's upload queue shows it.
        if (taskEnd.state === 'waiting') removeTaskFile(dataDir, task.id); else taskSay(taskEnd);
      }
    }
  }

  /** Approvals by the rules, enqueue of auto-approved posts, then the due uploads. Safe to call often. */
  async function step() {
    if (!flagsOn()) return { skipped: 'flag-off' };
    if (halted) return { skipped: 'stopped' };
    let rules;
    try { rules = (opts.rulesFile ? loadRules(opts.rulesFile) : loadRules()); } catch (e) { return { skipped: 'bad-rules', detail: e?.code ?? 'error' }; }
    if (!rules.rules.length) return { skipped: 'no-rules' };
    if (!recovered) { recovered = true; queue.recover(); }
    const store = createPostStore({ ledgerFile });
    // Approvals are local file work, but they share the fail-closed live check (unreadable state -> nothing happens).
    const r = await runAuto({ store, rules, outputsStatus, logFile: autoLogFile, now: () => new Date(nowMs()) });
    if (rules.autoUpload) {
      const autoApproved = new Set(createAutoLog(autoLogFile).list().filter((e) => e.action === 'approve').map((e) => e.id));
      for (const p of store.list()) if (p.status === 'approved' && UPLOAD_TARGETS.includes(p.target) && autoApproved.has(p.id)) queue.add(p.id);
      await processQueue(store, rules);
    }
    return { refused: r.refused, approved: r.done.filter((d) => d.action === 'approve').length };
  }

  async function guarded(fn) {
    if (busy) return { skipped: 'busy' };
    busy = true;
    try { return await fn(); } catch (e) { log(`posting: chain error (${String(e?.code ?? e?.name ?? 'error').slice(0, 40)})`); return { skipped: 'error' }; } finally { busy = false; }
  }

  return {
    queue,
    summary: () => readQueueSummary(dataDir, flags),
    /** After a successful clip job: package the run's finished clips, then step(). */
    afterRun(runDir, status) {
      if (status) latest = status;
      return guarded(async () => {
        if (!flagsOn()) return { skipped: 'flag-off' };
        let profile = {};
        const pf = opts.profileFile ?? path.join(REPO, 'data', 'profile.local.json');
        if (existsSync(pf)) profile = readJson(pf) ?? {};
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
