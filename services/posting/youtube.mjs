// SPDX-License-Identifier: GPL-3.0-or-later
// P16b step 2: YouTube resumable upload. Node stdlib `fetch` only (Node >=18), no googleapis package.
//
// uploadVideo(opts) -> { videoId } | throws UploadError
//   opts: { postId, store (createPostStore from ./index.mjs), auth (createYoutubeAuth from ./oauth.mjs),
//           outputsStatus: async () => { sinks: [...] } (live-refusal check), ledger (createLedger),
//           videoPath, coverPath?, now?, fetchImpl?, chunkSize? }
//
// Order, matching the plan exactly (docs/plan/2026-11-03-p16b-youtube-private-upload-plan.md step 3):
//   1. re-check: status approved, video sha256 unchanged, limits pass, no unresolved placeholders,
//      ledger has no 'uploaded' entry yet for this sha256+target (never upload the same video twice);
//   2. refuse while any stream sink is active (uploads never compete with the live upload);
//   3. POST the resumable "insert" session (privacyStatus hardcoded "private" -- never read from post.json);
//   4. PUT the video in chunks; a dropped connection resumes from the last byte Google acknowledged (a 308
//      response's Range header), never restarts the whole upload;
//   5. ledger entry { state: 'uploaded', videoId, at } + post.json status 'uploaded' written BEFORE the
//      thumbnail step, so a crash after the upload itself can never cause a second video upload;
//   6. best-effort thumbnails.set (Shorts may ignore it -- noted, not fatal).
//
// Tests inject fetchImpl; the plan's own rule: "No test touches Google".

import { createReadStream, statSync } from 'node:fs';
import { checkLimits, composeField } from './index.mjs';

const UPLOAD_INIT_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const THUMBNAIL_URL = (videoId) => `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`;
const DEFAULT_CHUNK = 8 * 1024 * 1024; // 8 MiB, a multiple of 256 KiB as Google's resumable protocol requires
const MAX_RETRIES = 5;

export class UploadError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'UploadError'; this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds the fixed snippet from a post.json entry. privacyStatus is hardcoded here, never from `post`. */
export function uploadMetadata(post) {
  return {
    snippet: { title: composeField(post, ['title']), description: composeField(post, ['description', 'hashtags']), tags: post.tags ?? [] },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  };
}

/** Starts a resumable session; returns the session URL from the Location header. */
async function initiateSession(fetchImpl, accessToken, metadata, bytes) {
  const res = await fetchImpl(UPLOAD_INIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(bytes) },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) throw new UploadError('upload-init-failed', `HTTP ${res.status} starting the resumable session`);
  const loc = res.headers.get('location');
  if (!loc) throw new UploadError('upload-init-failed', 'no session URL in the response');
  return loc;
}

/** Reads one byte range of a file into a Buffer. */
function readRange(file, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(file, { start, end: end - 1 })
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

/** Asks Google how many bytes of a resumable session it already has (for resuming after a drop). */
async function queryProgress(fetchImpl, sessionUrl, totalBytes) {
  const res = await fetchImpl(sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${totalBytes}` } });
  if (res.status === 308) {
    const range = res.headers.get('range'); // "bytes=0-12345" = bytes 0..12345 received
    const m = range ? /bytes=0-(\d+)/.exec(range) : null;
    return m ? Number(m[1]) + 1 : 0;
  }
  if (res.ok) return totalBytes; // already complete
  throw new UploadError('upload-resume-query-failed', `HTTP ${res.status} checking upload progress`);
}

/** Uploads the whole file in chunks, resuming from the last acknowledged byte on a dropped connection.
 *  Returns the finished video resource (parsed JSON) once Google responds 200/201. */
async function uploadChunks(fetchImpl, sessionUrl, filePath, totalBytes, chunkSize) {
  let offset = 0;
  let attempt = 0;
  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize, totalBytes);
    let res;
    try {
      const body = await readRange(filePath, offset, end);
      res = await fetchImpl(sessionUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(body.length), 'Content-Range': `bytes ${offset}-${end - 1}/${totalBytes}` },
        body,
      });
    } catch (e) {
      attempt++;
      if (attempt > MAX_RETRIES) throw new UploadError('upload-failed', `network error after ${MAX_RETRIES} retries: ${e?.message ?? e}`);
      await sleep(Math.min(1000 * 2 ** attempt, 30000));
      offset = await queryProgress(fetchImpl, sessionUrl, totalBytes); // resume from Google's own count, not our guess
      continue;
    }
    if (res.status === 308) { offset = end; attempt = 0; continue; } // chunk accepted, more to send
    if (res.ok) return res.json(); // 200/201: upload complete
    if (res.status >= 500 || res.status === 0) {
      attempt++;
      if (attempt > MAX_RETRIES) throw new UploadError('upload-failed', `HTTP ${res.status} after ${MAX_RETRIES} retries`);
      await sleep(Math.min(1000 * 2 ** attempt, 30000));
      offset = await queryProgress(fetchImpl, sessionUrl, totalBytes);
      continue;
    }
    throw new UploadError('upload-failed', `HTTP ${res.status} (not retryable)`);
  }
  throw new UploadError('upload-failed', 'loop ended without a finished response'); // unreachable in practice
}

/** Best-effort cover upload. Returns true on success, false on any failure (never throws: not fatal). */
async function setThumbnail(fetchImpl, accessToken, videoId, coverPath) {
  try {
    const bytes = statSync(coverPath).size;
    const body = await readRange(coverPath, 0, bytes);
    const res = await fetchImpl(THUMBNAIL_URL(videoId), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes) }, body });
    return res.ok;
  } catch { return false; }
}

/**
 * Uploads one approved post package. opts: { post, sha256, videoPath, coverPath?, accessToken, ledger,
 *   outputsStatus: async () => { sinks }, fetchImpl?, chunkSize?, now? }
 * `post` is the full post.json object (status/target/sha256 already re-checked by the caller against the
 * ledger before calling this -- see services/posting/cli.mjs `youtube upload`).
 */
export async function uploadVideo(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;

  if (opts.post.status !== 'approved') throw new UploadError('not-approved', 'only approved packages can be uploaded');
  if (opts.post.source?.sha256 !== opts.sha256) throw new UploadError('video-changed', 'the video changed since it was approved');
  if (!checkLimits(opts.post, opts.limits).ok) throw new UploadError('over-limit', 'the post is over a platform limit');
  if ((opts.post.unresolved ?? []).length) throw new UploadError('unresolved-placeholders', 'unresolved template placeholders remain');
  const existing = opts.ledger.get(opts.sha256, opts.post.target);
  if (existing?.status === 'uploaded') throw new UploadError('already-uploaded', `already uploaded as ${existing.videoId}`);

  const live = await opts.outputsStatus();
  if ((live?.sinks ?? []).some((s) => s.kind === 'stream' && s.active)) throw new UploadError('stream-active', 'a stream sink is active; uploads never compete with a live stream');

  const bytes = statSync(opts.videoPath).size;
  const metadata = uploadMetadata(opts.post);
  const sessionUrl = await initiateSession(fetchImpl, opts.accessToken, metadata, bytes);
  const resource = await uploadChunks(fetchImpl, sessionUrl, opts.videoPath, bytes, chunkSize);
  const videoId = resource?.id;
  if (typeof videoId !== 'string' || !videoId) throw new UploadError('upload-failed', 'no video id in the finished response');

  // Ledger + post.json first, before the thumbnail step: a crash after this point can never upload twice.
  const at = now();
  if (existing) opts.ledger.setStatus(opts.sha256, opts.post.target, 'uploaded', at);
  else opts.ledger.put({ sha256: opts.sha256, target: opts.post.target, status: 'uploaded', dir: opts.post.$dir ?? null, clipId: opts.post.source?.clipId, createdAt: at, updatedAt: at });
  if (typeof opts.recordUploaded === 'function') await opts.recordUploaded({ videoId, at });

  let thumbnailOk = null;
  if (opts.coverPath) thumbnailOk = await setThumbnail(fetchImpl, opts.accessToken, videoId, opts.coverPath);

  return { videoId, thumbnailOk };
}
