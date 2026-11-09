// SPDX-License-Identifier: GPL-3.0-or-later
// D300 auto-post chain. Fakes only: no network, no Google, no Credential Manager, no real folders (temp dirs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { BASE_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, backoffMs, createPostChain, createUploadQueue, readQueueSummary, streamOnly } from '../services/posting/auto-chain.mjs';
import { createPostStore, postId } from '../services/posting/index.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d300-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const T0 = Date.parse('2026-11-08T10:00:00Z');
const RULES = { autoUpload: true, rules: [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 5 }] };

/** One draft post (score 9) per clip in a ledger, plus an uploads.json row for the same bytes. */
function env({ clips = ['a'] } = {}) {
  const dataDir = mk(); const entries = {}; const ids = {}; const clipsDir = mk();
  const rows = [];
  for (const clip of clips) {
    const video = Buffer.from(`video-${clip}`.repeat(5));
    const sha = createHash('sha256').update(video).digest('hex');
    const dir = path.join(mk(), 'posts', clip, 'youtube-shorts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'full-crop.mp4'), video);
    const stamp = '2026-11-08T09:00:00.000Z';
    writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
      version: 1, title: 'T', description: 'D', tags: ['g'], hashtags: ['#Shorts'], target: 'youtube-shorts', privacy: 'private', status: 'draft',
      source: { run: 'run1', clipId: clip, layout: 'full-crop', startSec: 1, endSec: 3, score: 9, sha256: sha },
      video: { file: 'full-crop.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
    }));
    entries[`${sha}:youtube-shorts`] = { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: clip, createdAt: stamp, updatedAt: stamp };
    ids[clip] = postId({ sha256: sha, target: 'youtube-shorts' });
    const file = path.join(clipsDir, `${clip}.mp4`); writeFileSync(file, video);
    rows.push({ file, kind: 'short', label: 'x', seconds: 3, run: 'run1', recording: 'r', posted: [], addedAt: stamp });
  }
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries }));
  mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: rows }));
  const rulesFile = path.join(dataDir, 'rules.json'); writeFileSync(rulesFile, JSON.stringify(RULES));
  const uploads = () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'uploads.json'), 'utf8')).files;
  const queue = () => createUploadQueue(path.join(dataDir, 'posting', 'upload-queue.json'));
  return { dataDir, ids, rulesFile, ledgerFile, uploads, queue, store: () => createPostStore({ ledgerFile }) };
}

const IDLE = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'stopped' }] };
const LIVE = { sinks: [{ id: 'yt', kind: 'stream', state: 'live' }] };
const RECORDING = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'live' }] };

/** Fake YouTube: init -> session URL; PUT chunks; `bytes *` slash n progress query. */
function fakeYt({ initStatus = 200 } = {}) {
  const calls = []; const received = {};
  const fetchImpl = async (url, o = {}) => {
    const cr = o.headers?.['Content-Range'] ?? '';
    const isInit = String(url).includes('uploadType=resumable');
    calls.push({ url: isInit ? 'init' : cr.startsWith('bytes */') ? 'query' : 'chunk', cr });
    if (isInit) return { ok: initStatus === 200, status: initStatus, headers: new Map([['location', 'https://fake.invalid/session/1']]) };
    if (cr.startsWith('bytes */')) { const n = received.n ?? 0; return { ok: false, status: 308, headers: new Map(n ? [['range', `bytes=0-${n - 1}`]] : []) }; }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    received.n = Number(m[2]) + 1;
    if (received.n >= Number(m[3])) return { ok: true, status: 200, headers: new Map(), json: async () => ({ id: 'vid1' }) };
    return { ok: false, status: 308, headers: new Map() };
  };
  return { fetchImpl, calls, count: (k) => calls.filter((c) => c.url === k).length };
}
const authOk = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-access' };

function chain(e, { yt, auth = authOk, flagsOn = true, time, chunkSize } = {}) {
  const clock = time ?? { t: T0 };
  const c = createPostChain({ dataDir: e.dataDir, flags: { isOn: (id) => flagsOn && id !== 'post-schedule' }, rulesFile: e.rulesFile, auth, fetchImpl: yt?.fetchImpl, now: () => clock.t, tickEveryMs: 0, chunkSize,
    profileFile: path.join(e.dataDir, 'none.json'), packageImpl: async () => ({ packaged: [], skipped: [] }) });
  return { c, clock };
}

describe('backoff', () => {
  test('5 min doubling, capped at 6 h', () => {
    assert.equal(backoffMs(1), BASE_DELAY_MS); assert.equal(backoffMs(2), 2 * BASE_DELAY_MS); assert.equal(backoffMs(3), 4 * BASE_DELAY_MS);
    assert.equal(backoffMs(30), MAX_DELAY_MS);
  });
  test('streamOnly drops record sinks, keeps malformed ones (fail closed)', async () => {
    assert.deepEqual((await streamOnly(async () => RECORDING)()).sinks.map((s) => s.id), ['yt']);
    assert.equal((await streamOnly(async () => ({ sinks: [null, { kind: 'record' }] }))()).sinks.length, 1);
  });
});

describe('chain', () => {
  test('flags off: nothing happens, no network', async () => {
    const e = env(); const yt = fakeYt(); const { c } = chain(e, { yt, flagsOn: false });
    assert.deepEqual(await c.afterRun(path.join(e.dataDir, 'clips', 'runs', 'run1'), IDLE), { skipped: 'flag-off' });
    assert.equal(yt.calls.length, 0); assert.equal(e.store().get(e.ids.a).status, 'draft');
  });

  test('happy path: approve by rule, upload private, ledger + posted filled, no token written', async () => {
    const e = env(); const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.afterRun('x', IDLE);
    assert.equal(yt.count('init'), 1);
    assert.equal(e.store().get(e.ids.a).status, 'uploaded');
    const q = e.queue().get(e.ids.a);
    assert.equal(q.state, 'done'); assert.equal(q.videoId, 'vid1');
    const [row] = e.uploads();
    assert.equal(row.posted.length, 1);
    assert.deepEqual({ ...row.posted[0], at: 'T' }, { platform: 'youtube', target: 'youtube-shorts', id: e.ids.a, videoId: 'vid1', url: 'https://youtu.be/vid1', at: 'T', privacy: 'private' });
    for (const f of ['posting/upload-queue.json', 'clips/uploads.json', 'posting/auto-log.json']) assert.ok(!/fake-access/.test(readFileSync(path.join(e.dataDir, f), 'utf8')), f);
    assert.match(readQueueSummary(e.dataDir).message, /uploaded to YouTube \(private\)/);
  });

  test('a live stream blocks approval and upload; a running recording does not', async () => {
    const e = env(); const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.afterRun('x', LIVE);
    assert.equal(yt.calls.length, 0, 'nothing sent while live');
    assert.equal(e.store().get(e.ids.a).status, 'draft', 'not even approved while live (fail closed)');
    await c.tick(IDLE);
    assert.equal(yt.count('init'), 1, 'after the stream: uploaded');

    // stream goes live between approval and upload
    const e3 = env(); const y3 = fakeYt();
    let st = { signedIn: false, hasClient: true };
    const { c: c3 } = chain(e3, { yt: y3, auth: { status: async () => st, accessToken: async () => 'fake-access' } });
    await c3.tick(IDLE); // approved + queued, waits for sign-in
    assert.equal(readQueueSummary(e3.dataDir).queued, 1);
    st = { signedIn: true, hasClient: true };
    e3.queue().patch(e3.ids.a, { nextAt: null });
    await c3.tick(LIVE);
    assert.equal(y3.calls.length, 0);
    assert.equal(readQueueSummary(e3.dataDir).reason, 'stream-live');
    assert.match(readQueueSummary(e3.dataDir).message, /Waiting until the stream ends/);

    const e4 = env(); const y4 = fakeYt(); const { c: c4 } = chain(e4, { yt: y4 });
    await c4.tick(RECORDING);
    assert.equal(y4.count('init'), 1, 'a local recording does not block');
  });

  test('unreadable output state fails closed', async () => {
    const e = env(); const yt = fakeYt(); const { c } = chain(e, { yt });
    for (const bad of [null, { nope: 1 }, { sinks: [null] }]) await c.tick(bad);
    assert.equal(yt.calls.length, 0); assert.equal(e.store().get(e.ids.a).status, 'draft');
  });

  test('a stream starting mid-upload stops it; the session is kept and resumes after a restart without a new init', async () => {
    const e = env(); const yt = fakeYt(); const clock = { t: T0 };
    let ref = null;
    const flip = async (url, o) => { const r = await yt.fetchImpl(url, o); if (yt.count('chunk') === 1) ref.latestLive = true; return r; };
    const { c } = chain(e, { yt: { fetchImpl: flip }, time: clock, chunkSize: 10 });
    ref = { latestLive: false };
    // the chain keeps the status object it was given: this one turns live after the first chunk
    const sinks = [{ id: 'yt', kind: 'stream', state: 'stopped' }];
    const status = { sinks };
    Object.defineProperty(sinks[0], 'state', { get: () => (ref.latestLive ? 'live' : 'stopped'), enumerable: true });
    await c.tick(status);
    assert.equal(e.store().get(e.ids.a).status, 'approved', 'not uploaded');
    const it = e.queue().get(e.ids.a);
    assert.equal(it.state, 'queued'); assert.ok(it.session, 'session kept');
    assert.equal(yt.count('init'), 1);
    const { c: c3 } = chain(e, { yt, time: clock, chunkSize: 10 });
    await c3.tick(IDLE);
    assert.equal(yt.count('init'), 1, 'no second session');
    assert.equal(yt.count('query'), 1, 'asked Google how far it got');
    assert.equal(e.store().get(e.ids.a).status, 'uploaded');
    assert.equal(e.uploads()[0].posted[0].videoId, 'vid1');
  });

  test('error: exponential backoff, waits for nextAt, fails after MAX_ATTEMPTS and is then left alone', async () => {
    const e = env(); const yt = fakeYt({ initStatus: 500 }); const clock = { t: T0 };
    const { c } = chain(e, { yt, time: clock });
    const item = () => e.queue().get(e.ids.a);
    await c.tick(IDLE);
    assert.equal(item().attempts, 1); assert.equal(Date.parse(item().nextAt) - clock.t, BASE_DELAY_MS);
    await c.tick(IDLE); assert.equal(yt.count('init'), 1, 'not due yet: no new try');
    clock.t += BASE_DELAY_MS; await c.tick(IDLE);
    assert.equal(item().attempts, 2); assert.equal(Date.parse(item().nextAt) - clock.t, 2 * BASE_DELAY_MS);
    for (let i = 2; i < MAX_ATTEMPTS; i++) { clock.t += MAX_DELAY_MS; await c.tick(IDLE); }
    assert.equal(item().state, 'failed'); assert.equal(item().attempts, MAX_ATTEMPTS);
    const before = yt.calls.length; clock.t += MAX_DELAY_MS * 2; await c.tick(IDLE);
    assert.equal(yt.calls.length, before, 'failed items are not retried');
    assert.equal(e.store().get(e.ids.a).status, 'approved');
    assert.match(readQueueSummary(e.dataDir).message, /failed/);
  });

  test('never uploads twice: finished upload, deleted queue, re-queued item', async () => {
    const e = env(); const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.tick(IDLE);
    assert.equal(yt.count('init'), 1);
    rmSync(path.join(e.dataDir, 'posting', 'upload-queue.json'));
    await chain(e, { yt }).c.tick(IDLE);
    assert.equal(yt.count('init'), 1, 'an uploaded post is not queued again');
    e.queue().add(e.ids.a); // forced back into the queue
    await chain(e, { yt }).c.tick(IDLE);
    assert.equal(yt.count('init'), 1, 'ledger says uploaded: marked done, nothing sent');
    assert.equal(e.queue().get(e.ids.a).state, 'done');
  });

  test('a crash mid-upload leaves "uploading": the next start queues it again and finishes it once', async () => {
    const e = env(); const yt = fakeYt();
    await chain(e, { yt: fakeYt({ initStatus: 500 }) }).c.tick(IDLE); // approved + queued after one failed try
    e.queue().patch(e.ids.a, { state: 'uploading', nextAt: null });
    await chain(e, { yt }).c.tick(IDLE);
    assert.equal(yt.count('init'), 1); assert.equal(e.queue().get(e.ids.a).state, 'done');
  });

  test('not signed in / no OAuth client: the item is kept, says why, costs no attempts, uploads once signed in', async () => {
    const e = env(); const yt = fakeYt(); const clock = { t: T0 };
    let st = { signedIn: false, hasClient: false };
    const { c } = chain(e, { yt, time: clock, auth: { status: async () => st, accessToken: async () => 'fake-access' } });
    await c.afterRun('x', IDLE);
    assert.equal(yt.calls.length, 0);
    const s = readQueueSummary(e.dataDir);
    assert.equal(s.queued, 1); assert.equal(s.reason, 'no-oauth-client');
    assert.match(s.message, /Not signed in to YouTube/);
    assert.equal(e.queue().get(e.ids.a).attempts, 0);
    st = { signedIn: false, hasClient: true };
    clock.t += 31 * 60000; await c.tick(IDLE);
    assert.equal(readQueueSummary(e.dataDir).reason, 'not-signed-in');
    st = { signedIn: true, hasClient: true };
    clock.t += 31 * 60000; await c.tick(IDLE);
    assert.equal(yt.count('init'), 1); assert.equal(readQueueSummary(e.dataDir).done, 1);
  });

  test('a post approved by hand (not by the rules) is never queued', async () => {
    const e = env(); const yt = fakeYt();
    assert.equal(typeof await e.store().setStatus(e.ids.a, 'approved'), 'object');
    writeFileSync(e.rulesFile, JSON.stringify({ autoUpload: true, rules: [{ id: 'top', target: 'youtube-shorts', minScore: 99, maxPerDay: 1 }] }));
    await chain(e, { yt }).c.tick(IDLE);
    assert.equal(yt.calls.length, 0); assert.equal(readQueueSummary(e.dataDir).queued, 0);
  });

  test('autoUpload false: approvals only, nothing queued', async () => {
    const e = env(); const yt = fakeYt();
    writeFileSync(e.rulesFile, JSON.stringify({ autoUpload: false, rules: RULES.rules }));
    await chain(e, { yt }).c.tick(IDLE);
    assert.equal(e.store().get(e.ids.a).status, 'approved'); assert.equal(yt.calls.length, 0);
    assert.equal(existsSync(path.join(e.dataDir, 'posting', 'upload-queue.json')), false);
  });
});
