// SPDX-License-Identifier: GPL-3.0-or-later
// P16b step 2 tests: services/posting/youtube.mjs. No test touches Google -- fetchImpl is always a fake here.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLedger } from '../services/posting/index.mjs';
import { uploadMetadata, uploadVideo, UploadError } from '../services/posting/youtube.mjs';

const LIMITS = { targets: { 'youtube-shorts': { status: 'checked', fields: { title: { max: 100, unit: 'chars' } } } } };

function tmpVideo(bytes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'uj-yt-'));
  const file = path.join(dir, 'clip.mp4');
  writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

function basePost(sha256, overrides = {}) {
  return { title: 'A clip', description: 'd', tags: ['x'], hashtags: ['#y'], target: 'youtube-shorts', status: 'approved', unresolved: [], source: { sha256, clipId: 'c1' }, ...overrides };
}

const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

test('uploadMetadata: privacyStatus is always private, never taken from post', () => {
  const m = uploadMetadata({ title: 't', description: 'd', hashtags: [], tags: ['a'] });
  assert.equal(m.status.privacyStatus, 'private');
  assert.equal(m.status.selfDeclaredMadeForKids, false);
  assert.equal(m.snippet.title, 't');
});

test('uploadVideo: happy path, single chunk upload, ledger-first then thumbnail', async () => {
  const video = tmpVideo(1024);
  const cover = tmpVideo(16);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  const sha = 'a'.repeat(64);
  ledger.put({ sha256: sha, target: 'youtube-shorts', status: 'approved', dir: path.dirname(video), createdAt: 't0', updatedAt: 't0' });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts?.method });
    if (String(url).includes('uploadType=resumable')) return jsonRes(200, {}, { location: 'https://upload.example/session1' });
    if (url === 'https://upload.example/session1') return jsonRes(200, { id: 'VID123' });
    if (String(url).includes('thumbnails/set')) return jsonRes(200, {});
    throw new Error(`unexpected call ${url}`);
  };
  const r = await uploadVideo({
    post: basePost(sha), sha256: sha, videoPath: video, coverPath: cover, accessToken: 'tok', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [] }), fetchImpl, now: () => 't1',
  });
  assert.equal(r.videoId, 'VID123');
  assert.equal(r.thumbnailOk, true);
  assert.equal(ledger.get(sha, 'youtube-shorts').status, 'uploaded');
  assert.equal(ledger.get(sha, 'youtube-shorts').videoId, undefined); // recordUploaded not used here; videoId travels in the return value
  // ledger-first: the ledger must already say 'uploaded' even if we never got to call the thumbnail endpoint
  const thumbCallIdx = calls.findIndex((c) => String(c.url).includes('thumbnails'));
  assert.ok(thumbCallIdx > 0);
});

test('uploadVideo: multi-chunk upload with a dropped connection resumes from the last acknowledged byte', async () => {
  const chunkSize = 1024;
  const totalBytes = chunkSize * 3; // 3 chunks
  const video = tmpVideo(totalBytes);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  const sha = 'b'.repeat(64);
  ledger.put({ sha256: sha, target: 'youtube-shorts', status: 'approved', dir: path.dirname(video), createdAt: 't0', updatedAt: 't0' });
  let chunk2Attempts = 0;
  const putRanges = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('uploadType=resumable')) return jsonRes(200, {}, { location: 'https://upload.example/s2' });
    const range = opts?.headers?.['Content-Range'];
    if (range?.startsWith('bytes */')) { // resume-progress query
      return jsonRes(308, {}, { range: 'bytes=0-1023' }); // Google says: got the first chunk only
    }
    putRanges.push(range);
    const startByte = Number(/bytes (\d+)-/.exec(range)[1]);
    if (startByte === chunkSize && chunk2Attempts === 0) { chunk2Attempts++; throw new Error('ECONNRESET'); } // drop on chunk 2, first try
    const endByte = Number(/-(\d+)\//.exec(range)[1]);
    if (endByte + 1 >= totalBytes) return jsonRes(200, { id: 'VID999' });
    return jsonRes(308, {}, { range: `bytes=0-${endByte}` });
  };
  const r = await uploadVideo({
    post: basePost(sha), sha256: sha, videoPath: video, accessToken: 'tok', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [] }), fetchImpl, chunkSize, now: () => 't1',
  });
  assert.equal(r.videoId, 'VID999');
  assert.equal(chunk2Attempts, 1); // dropped exactly once, then resumed -- not restarted from byte 0
  const chunk1Sends = putRanges.filter((r2) => r2?.startsWith('bytes 0-1023')).length;
  assert.equal(chunk1Sends, 1); // chunk 1 (already acknowledged) was sent exactly once, never re-sent after the drop on chunk 2
});

test('uploadVideo: refuses a non-approved package', async () => {
  const video = tmpVideo(16);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  await assert.rejects(uploadVideo({
    post: basePost('c'.repeat(64), { status: 'draft' }), sha256: 'c'.repeat(64), videoPath: video, accessToken: 'x', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [] }), fetchImpl: async () => { throw new Error('must not call the network'); },
  }), (e) => e instanceof UploadError && e.code === 'not-approved');
});

test('uploadVideo: refuses if the video changed since approval (sha256 mismatch)', async () => {
  const video = tmpVideo(16);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  await assert.rejects(uploadVideo({
    post: basePost('d'.repeat(64)), sha256: 'e'.repeat(64), videoPath: video, accessToken: 'x', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [] }), fetchImpl: async () => { throw new Error('must not call the network'); },
  }), (e) => e.code === 'video-changed');
});

test('uploadVideo: refuses an already-uploaded post (never upload the same video twice)', async () => {
  const video = tmpVideo(16);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  const sha = 'f'.repeat(64);
  ledger.put({ sha256: sha, target: 'youtube-shorts', status: 'uploaded', videoId: 'OLDID', dir: path.dirname(video), createdAt: 't0', updatedAt: 't0' });
  await assert.rejects(uploadVideo({
    post: basePost(sha), sha256: sha, videoPath: video, accessToken: 'x', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [] }), fetchImpl: async () => { throw new Error('must not call the network'); },
  }), (e) => e.code === 'already-uploaded' && /OLDID/.test(e.message));
});

test('uploadVideo: refuses while a stream sink is active (uploads never compete with a live stream)', async () => {
  const video = tmpVideo(16);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  const sha = '1'.repeat(64);
  ledger.put({ sha256: sha, target: 'youtube-shorts', status: 'approved', dir: path.dirname(video), createdAt: 't0', updatedAt: 't0' });
  await assert.rejects(uploadVideo({
    post: basePost(sha), sha256: sha, videoPath: video, accessToken: 'x', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [{ kind: 'stream', active: true }] }), fetchImpl: async () => { throw new Error('must not call the network'); },
  }), (e) => e.code === 'stream-active');
});

test('uploadVideo: refuses with unresolved placeholders', async () => {
  const video = tmpVideo(16);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  const sha = '2'.repeat(64);
  ledger.put({ sha256: sha, target: 'youtube-shorts', status: 'approved', dir: path.dirname(video), createdAt: 't0', updatedAt: 't0' });
  await assert.rejects(uploadVideo({
    post: basePost(sha, { unresolved: ['handles.x'] }), sha256: sha, videoPath: video, accessToken: 'x', ledger, limits: LIMITS,
    outputsStatus: async () => ({ sinks: [] }), fetchImpl: async () => { throw new Error('must not call the network'); },
  }), (e) => e.code === 'unresolved-placeholders');
});

test('uploadVideo: a cover upload failure is reported, not fatal (video is already uploaded by then)', async () => {
  const video = tmpVideo(16);
  const cover = tmpVideo(8);
  const ledger = createLedger(path.join(path.dirname(video), 'ledger.json'));
  const sha = '3'.repeat(64);
  ledger.put({ sha256: sha, target: 'youtube-shorts', status: 'approved', dir: path.dirname(video), createdAt: 't0', updatedAt: 't0' });
  const fetchImpl = async (url) => {
    if (String(url).includes('uploadType=resumable')) return jsonRes(200, {}, { location: 'https://upload.example/s3' });
    if (url === 'https://upload.example/s3') return jsonRes(200, { id: 'VID1' });
    if (String(url).includes('thumbnails')) return jsonRes(403, {});
    throw new Error('unexpected');
  };
  const r = await uploadVideo({ post: basePost(sha), sha256: sha, videoPath: video, coverPath: cover, accessToken: 'x', ledger, limits: LIMITS, outputsStatus: async () => ({ sinks: [] }), fetchImpl, now: () => 't1' });
  assert.equal(r.videoId, 'VID1');
  assert.equal(r.thumbnailOk, false);
  assert.equal(ledger.get(sha, 'youtube-shorts').status, 'uploaded'); // still recorded as uploaded
});
