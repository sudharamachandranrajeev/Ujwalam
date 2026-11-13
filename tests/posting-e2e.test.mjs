// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end auto posting against a local fake Google/YouTube HTTP server (127.0.0.1 only, no OAuth, no real network).
// Chain: finished clip job -> packageUploads (montage / won-reel) -> auto rules -> resumable upload -> status check -> markPosted.
// The only seams used: fetchImpl (rewrites the googleapis host to the local server) and a fake token provider (auth).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createPostChain, createUploadQueue, readQueueSummary } from '../services/posting/auto-chain.mjs';
import { createPostStore } from '../services/posting/index.mjs';
import { checkPostStatus } from '../services/posting/youtube.mjs';
import { tasksDir } from '../services/studio-ui/tasks.mjs';
import { READONLY_SCOPE, SCOPE } from '../services/posting/oauth.mjs';
import { DELETE_FLAG } from '../services/posting/delete-uploaded.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-e2e-post-')); tmp.push(d); return d; };
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const FFMPEG = process.execPath; // stands in for ffmpeg: the cover step fails and the package has no cover
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const T0 = Date.parse('2026-11-09T10:00:00Z');
const IDLE = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'stopped' }] };
const LIVE = { sinks: [{ id: 'yt', kind: 'stream', state: 'live' }] };
const authOk = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-access', grantedScopes: async () => [SCOPE, READONLY_SCOPE] };
// D375: automatic uploads always go up scheduled. The tests use a 6 h gap on a 1-minute grid (the repo default is 1 h on whole
// hours) so the times below stay easy to read; the delete flag stays off unless a test turns it on.
const TEST_SCHEDULE = { intervalHours: 6, placement: 'fill-gaps', alignMinutes: 1, lookbackDays: 120, minLeadHours: 1, marginMinutes: 15,
  chunkDeadlineSeconds: 120, fallbackKbps: 1000, maxPages: 20, pageSize: 50, maxAheadDays: 730 };
const CHAIN_FLAGS = { isOn: (id) => id !== DELETE_FLAG };

/** Fake Google: resumable insert sessions, chunk PUTs, progress query, videos.list. `opt` switches inject faults. */
async function fakeGoogle() {
  // Channel read (post-schedule): `channel` = other videos already on the channel (newest first, after our uploads);
  // `channelError` = HTTP answer for channels.list ('scope' -> 403 insufficientPermissions, 500 -> server error);
  // `hideOwnUploads` leaves our own uploads out of the channel list (to prove the queue's own slots count by themselves).
  const opt = { initFailures: 0, chunkFailOnce: false, dropFinalAnswer: false, queryAfterComplete: 'resource' /* | 'gone' | 'error' */, stallFinal: null /* | 'hold' | 'finalize' */,
    channel: [], channelError: null, hideOwnUploads: false };
  const sessions = new Map(); const videos = []; const log = [];
  let chunkFailed = false;
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
        log.push('init');
        if (opt.initFailures > 0) { opt.initFailures--; return send(503, { error: 'busy' }); }
        const id = `s${sessions.size + 1}`;
        sessions.set(id, { meta: JSON.parse(body.toString('utf8')), total: Number(req.headers['x-upload-content-length']), got: Buffer.alloc(0), video: null });
        return send(200, undefined, { location: `http://127.0.0.1:${srv.address().port}/session/${id}` });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
        const s = sessions.get(url.pathname.split('/')[2]);
        if (!s) return send(404, { error: 'gone' });
        const cr = String(req.headers['content-range']);
        if (cr.startsWith('bytes */')) {
          log.push('query');
          if (s.video) {
            if (opt.queryAfterComplete === 'gone') return send(404, { error: 'gone' });
            if (opt.queryAfterComplete === 'error') return send(503, { error: 'busy' });
            return send(200, s.video);
          }
          return send(308, undefined, s.got.length ? { range: `bytes=0-${s.got.length - 1}` } : {});
        }
        log.push('chunk');
        if (opt.chunkFailOnce && !chunkFailed) { chunkFailed = true; return send(403, { error: 'quota' }); }
        if (opt.stallFinal && s.got.length + body.length >= s.total) {
          // The final chunk never gets an answer: 'hold' = Google never finalizes it; 'finalize' = it did, the answer is lost.
          log.push('stall');
          if (opt.stallFinal === 'finalize') {
            s.got = Buffer.concat([s.got, body]);
            s.video = { id: `vid${videos.length + 1}`, status: { uploadStatus: 'uploaded', privacyStatus: s.meta.status.privacyStatus, ...(s.meta.status.publishAt ? { publishAt: s.meta.status.publishAt } : {}) }, snippet: s.meta.snippet };
            videos.push({ ...s.video, bytes: s.got.length });
          }
          setTimeout(() => req.socket.destroy(), 5000).unref();
          return undefined;
        }
        s.got = Buffer.concat([s.got, body]);
        if (s.got.length >= s.total) {
          s.video = { id: `vid${videos.length + 1}`, status: { uploadStatus: 'uploaded', privacyStatus: s.meta.status.privacyStatus, ...(s.meta.status.publishAt ? { publishAt: s.meta.status.publishAt } : {}) }, snippet: s.meta.snippet };
          videos.push({ ...s.video, bytes: s.got.length });
          if (opt.dropFinalAnswer) return req.socket.destroy(); // upload completed on the server, the answer never arrives
          return send(200, s.video);
        }
        return send(308, undefined, { range: `bytes=0-${s.got.length - 1}` });
      }
      const all = () => [...(opt.hideOwnUploads ? [] : [...videos].reverse()), ...opt.channel];
      if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
        log.push('list');
        const ids = String(url.searchParams.get('id') ?? '').split(',');
        const found = ids.map((id) => all().find((x) => x.id === id)).filter(Boolean);
        return send(200, { items: found.map((v) => ({ id: v.id, status: v.status, processingDetails: { processingStatus: 'succeeded' } })) });
      }
      if (req.method === 'GET' && url.pathname === '/youtube/v3/channels') {
        log.push('channels');
        if (url.searchParams.get('mine') !== 'true' || !/contentDetails/.test(url.searchParams.get('part') ?? '')) return send(400, {});
        if (opt.channelError === 'scope') return send(403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } });
        if (opt.channelError) return send(opt.channelError, { error: { code: opt.channelError } });
        return send(200, { items: [{ id: 'UCfake', contentDetails: { relatedPlaylists: { uploads: 'UUfake' } } }] });
      }
      if (req.method === 'GET' && url.pathname === '/youtube/v3/playlistItems') {
        log.push('playlist');
        if (url.searchParams.get('playlistId') !== 'UUfake') return send(404, {});
        const size = Number(url.searchParams.get('maxResults')); const from = Number(url.searchParams.get('pageToken') ?? 0);
        const list = all(); const page = list.slice(from, from + size);
        return send(200, { items: page.map((v) => ({ snippet: { publishedAt: v.addedAt ?? '2026-11-09T09:00:00.000Z' }, contentDetails: { videoId: v.id } })), ...(from + size < list.length ? { nextPageToken: String(from + size) } : {}) });
      }
      return send(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const fetchImpl = (u, o) => fetch(String(u).replace('https://www.googleapis.com', base), o); // refuses to leave 127.0.0.1 by construction
  const count = (k) => log.filter((x) => x === k).length;
  return { opt, videos, log, fetchImpl, count, sessions };
}

const ROWS = [
  { name: 'codm_montage_20261109-100000_kills-5_01_v.mp4', kind: 'montage', seconds: 45 },
  { name: 'codm_montage_20261109-100000_kills-9_02_h.mp4', kind: 'montage', seconds: 90 },
  { name: 'codm_won-reel_20261109-100000_victory-kills-4_01_v-full-crop.mp4', kind: 'won-reel', seconds: 50 },
];

// Task bar (D311 proposed): a re-slotted or deadline-stopped upload is waiting, not failed, so its task file is removed.
const failedUploadTasks = (e) => {
  let names = []; try { names = readdirSync(tasksDir(e.dataDir)); } catch { /* no task file written */ }
  return names.filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(path.join(tasksDir(e.dataDir), n), 'utf8')))
    .filter((t) => t.kind === 'upload' && t.state === 'failed');
};

function setup(rows = ROWS) {
  const dataDir = mk(); const clips = mk();
  const out = rows.map((r, i) => {
    const file = path.join(clips, r.name);
    writeFileSync(file, Buffer.from(`${r.name}-${i}`.repeat(8)));
    return { file, label: 'x', seconds: r.seconds, kind: r.kind, run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-09T09:00:00.000Z' };
  });
  mkdirSync(path.join(dataDir, 'clips', 'runs', 'run1'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: out }));
  const rulesFile = path.join(dataDir, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ autoUpload: true, rules: [
    { id: 'm-short', target: 'youtube-shorts', minScore: 0, kinds: ['montage', 'won-reel'], maxPerDay: 5 },
    { id: 'm-long', target: 'youtube-video', minScore: 0, kinds: ['montage', 'won-reel'], maxPerDay: 5 }] }));
  const profileFile = path.join(dataDir, 'profile.json'); writeFileSync(profileFile, JSON.stringify(PROFILE));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  const runDir = path.join(dataDir, 'clips', 'runs', 'run1');
  const clock = { t: T0 };
  const scheduleFile = path.join(dataDir, 'schedule.json'); writeFileSync(scheduleFile, JSON.stringify(TEST_SCHEDULE));
  const chain = (g, extra = {}) => createPostChain({ dataDir, flags: CHAIN_FLAGS, rulesFile, auth: authOk, fetchImpl: g.fetchImpl, now: () => clock.t,
    tickEveryMs: 0, profileFile, ffmpeg: FFMPEG, chunkSize: 16, scheduleFile, ...extra });
  const uploads = () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'uploads.json'), 'utf8')).files;
  const queue = () => createUploadQueue(path.join(dataDir, 'posting', 'upload-queue.json'), () => clock.t);
  return { dataDir, runDir, ledgerFile, clock, chain, uploads, queue, store: () => createPostStore({ ledgerFile }) };
}

describe('auto post e2e against a local fake YouTube', () => {
  test('success: montage short + long montage + won reel packaged, approved, uploaded private, status checked, posted filled', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = e.chain(g);
    const r = await c.afterRun(e.runDir, IDLE);
    assert.equal(r.packaged, 3);
    assert.equal(g.videos.length, 3);
    assert.ok(g.videos.every((v) => v.status.privacyStatus === 'private'));
    assert.ok(g.videos.every((v) => v.bytes > 16), 'multi-chunk resumable upload');
    assert.deepEqual(e.queue().items().map((i) => i.state), ['done', 'done', 'done']);
    const posts = e.store().list();
    assert.deepEqual(posts.map((p) => `${p.kind}:${p.target}:${p.status}`).sort(),
      ['montage:youtube-shorts:uploaded', 'montage:youtube-video:uploaded', 'won-reel:youtube-shorts:uploaded']);
    // status check through the same fake
    for (const p of posts) {
      const s = await checkPostStatus({ id: p.id, store: e.store(), auth: authOk, fetchImpl: g.fetchImpl });
      assert.equal(s.found, true); assert.equal(s.uploadStatus, 'uploaded'); assert.equal(s.privacyStatus, 'private'); assert.equal(s.processingStatus, 'succeeded');
    }
    const rows = e.uploads();
    assert.deepEqual(rows.map((x) => x.posted.map((p) => [p.target, p.privacy, p.url.startsWith('https://youtu.be/')])),
      [[['youtube-shorts', 'private', true]], [['youtube-video', 'private', true]], [['youtube-shorts', 'private', true]]]);
    assert.ok(!/fake-access/.test(readFileSync(path.join(e.dataDir, 'posting', 'upload-queue.json'), 'utf8')));
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 3, 'a second pass posts nothing new');
  });

  test('failed upload is retried with backoff and never posts twice', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.initFailures = 2;
    await c.afterRun(e.runDir, IDLE);
    let q = e.queue().items()[0];
    assert.equal(q.state, 'queued'); assert.equal(q.attempts, 1); assert.equal(g.videos.length, 0);
    await c.tick(IDLE);
    assert.equal(g.count('init'), 1, 'not retried before nextAt');
    e.clock.t += 5 * 60 * 1000 + 1000; await c.tick(IDLE);
    q = e.queue().items()[0];
    assert.equal(q.attempts, 2); assert.equal(g.count('init'), 2);
    e.clock.t += 5 * 60 * 1000 + 1000; await c.tick(IDLE);
    assert.equal(g.count('init'), 2, 'second wait is 10 min (doubling)');
    e.clock.t += 5 * 60 * 1000; await c.tick(IDLE);
    q = e.queue().items()[0];
    assert.equal(q.state, 'done'); assert.equal(g.videos.length, 1);
    e.clock.t += 24 * 3600 * 1000; await c.tick(IDLE); await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1, 'no duplicate');
    assert.equal(e.uploads()[0].posted.length, 1);
  });

  test('a rejected chunk resumes the same session from Google\'s byte count (one video)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.chunkFailOnce = true;
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[0].state, 'queued');
    e.clock.t += 6 * 60 * 1000; await c.tick(IDLE);
    assert.equal(g.count('init'), 1, 'same session continued');
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'done');
  });

  test('answer lost but upload completed: recorded as posted from the session answer, no retry loop, no duplicate', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.dropFinalAnswer = true;
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1, 'Google has the video');
    const q = e.queue().items()[0];
    assert.equal(q.state, 'done', `queue: ${JSON.stringify(q)}`);
    assert.equal(q.videoId, 'vid1');
    assert.equal(e.store().list()[0].status, 'uploaded');
    assert.equal(e.uploads()[0].posted[0].videoId, 'vid1');
    assert.equal(g.count('init'), 1);
  });

  test('answer lost and the progress query fails once: keeps the session, does not start a second upload', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.dropFinalAnswer = true; g.opt.queryAfterComplete = 'error';
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1);
    assert.equal(e.queue().items()[0].state, 'queued');
    e.clock.t += 6 * 60 * 1000; await c.tick(IDLE); // the query still fails: the session must be kept, not replaced
    assert.equal(g.count('init'), 1, 'transient query failure does not start a second upload');
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'queued');
    g.opt.queryAfterComplete = 'resource';
    e.clock.t += 12 * 60 * 1000; await c.tick(IDLE);
    assert.equal(g.count('init'), 1, 'no new session, so no second video');
    assert.equal(g.videos.length, 1);
    assert.equal(e.queue().items()[0].state, 'done');
    assert.equal(e.uploads()[0].posted.length, 1);
  });

  test('never posts while live: nothing packaged-and-sent, mid-upload stop keeps the session, resumes after the stream', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    await c.afterRun(e.runDir, LIVE);
    assert.equal(g.log.length, 0, 'zero requests while live');
    assert.equal(e.store().list().filter((p) => p.status !== 'draft').length, 0, 'not even approved while live');
    await c.tick({ nope: 1 });
    assert.equal(g.log.length, 0, 'unreadable state fails closed');
    // goes live after the first chunk
    let live = false; let flipped = false;
    const sinks = [{ id: 'yt', kind: 'stream' }];
    Object.defineProperty(sinks[0], 'state', { get: () => (live ? 'live' : 'stopped'), enumerable: true });
    const c2 = e.chain({ fetchImpl: async (u, o) => { const r = await g.fetchImpl(u, o); if (!flipped && g.count('chunk') === 1) { flipped = true; live = true; } return r; } });
    await c2.tick({ sinks });
    assert.equal(g.count('chunk'), 1, 'stopped after one chunk');
    assert.equal(g.videos.length, 0);
    assert.match(readQueueSummary(e.dataDir).message, /stream/i);
    await c2.tick({ sinks }); await c2.tick({ sinks });
    assert.equal(g.count('chunk'), 1, 'still live: still nothing');
    live = false; await c2.tick({ sinks });
    assert.equal(g.count('init'), 1); assert.equal(g.videos.length, 1);
    assert.equal(e.queue().items()[0].state, 'done');
  });
});

// ---------------------------------------------------------------- scheduled posting (flag post-schedule, D310 proposed)
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const FIRST = T0 + HOUR + 15 * MIN; // empty channel: now + minLeadHours (1) + marginMinutes (15) on the 1-minute grid (TEST_SCHEDULE)
const iso = (t) => new Date(t).toISOString();
const SCHED_ON = CHAIN_FLAGS;
const SCHED_OFF = { isOn: (id) => id !== 'post-schedule' && id !== DELETE_FLAG };
const authSched = { ...authOk, grantedScopes: async () => [SCOPE, READONLY_SCOPE] };
const vid = (id, privacyStatus, publishAt) => ({ id, status: { privacyStatus, uploadStatus: 'processed', ...(publishAt ? { publishAt } : {}) } });
/** The clip maker publishes one more finished video into uploads.json (same run). */
function addRow(e, r) {
  const f = path.join(e.dataDir, 'clips', 'uploads.json');
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  const file = path.join(path.dirname(doc.files[0].file), r.name);
  writeFileSync(file, Buffer.from(`${r.name}-late`.repeat(8)));
  doc.files.push({ file, label: 'x', seconds: r.seconds, kind: r.kind, run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-09T10:30:00.000Z' });
  writeFileSync(f, JSON.stringify(doc));
}

describe('scheduled posting (post-schedule) against the local fake YouTube', () => {
  const schedChain = (e, g, extra = {}) => e.chain(g, { flags: SCHED_ON, auth: authSched, ...extra });
  const sent = (g) => g.videos.map((v) => v.status.publishAt ?? null); // publish times Google received, in upload order
  const qfile = (e) => JSON.parse(readFileSync(path.join(e.dataDir, 'posting', 'upload-queue.json'), 'utf8'));
  /** A settings file in the test's data folder: the repo defaults with `over` applied. */
  const schedFile = (e, over) => {
    const p = path.join(e.dataDir, 'schedule.json');
    writeFileSync(p, JSON.stringify({ ...TEST_SCHEDULE, ...over }));
    return p;
  };

  test('empty channel: three clips go up private, first at now + lead + margin, then every 6 h, in queue order', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 3);
    assert.ok(g.videos.every((v) => v.status.privacyStatus === 'private'));
    assert.deepEqual(sent(g), [iso(FIRST), iso(FIRST + 6 * HOUR), iso(FIRST + 12 * HOUR)]);
    assert.deepEqual(e.queue().items().map((i) => i.publishAt), sent(g), 'queue order = slot order');
    assert.deepEqual(e.queue().items().map((i) => i.sentPublishAt), sent(g), 'recorded = what Google got');
    assert.equal(g.count('channels'), 1, 'the channel is read once per pass');
    assert.deepEqual(e.uploads().flatMap((r) => r.posted.map((p) => p.publishAt)).sort(), [...sent(g)].sort());
    const s = readQueueSummary(e.dataDir, null, T0);
    assert.equal(s.nextPublishAt, iso(FIRST)); assert.equal(s.lastPublishAt, iso(FIRST + 12 * HOUR)); assert.equal(s.attention, 0);
    assert.ok(!/fake-access/.test(readFileSync(path.join(e.dataDir, 'posting', 'upload-queue.json'), 'utf8')));
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('channels'), 1, 'nothing new to schedule: no channel read'); assert.equal(g.videos.length, 3);
  });

  test('existing schedule in YouTube Studio: 6 h after the latest FUTURE one; past, public and unlisted ones are ignored', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = [vid('old1', 'private', iso(T0 - 2 * HOUR)), vid('pub1', 'public', iso(T0 + 30 * HOUR)), vid('s1', 'private', iso(T0 + 10 * HOUR)),
      vid('s2', 'private', iso(T0 + 4 * HOUR)), vid('u1', 'unlisted')];
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(T0 + 16 * HOUR)]);
    const q = qfile(e);
    assert.equal(q.schedule.channelLast, iso(T0 + 10 * HOUR)); assert.equal(q.schedule.count, 2); assert.equal(q.schedule.truncated, false);
  });

  test('another clip later: next slot after our own last slot, even when the channel list does not show it yet', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST)]);
    e.clock.t = T0 + 30 * MIN; addRow(e, ROWS[2]);
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST), iso(FIRST + 6 * HOUR)]);
    assert.equal(g.count('channels'), 2);
  });

  test('a failed item keeps its slot (never given back): the next clip goes after it', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    const q = e.queue(); q.patch(q.items()[0].id, { state: 'failed', reason: 'upload-failed' }); // as if it had failed for good
    addRow(e, ROWS[2]);
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[1].publishAt, iso(FIRST + 6 * HOUR));
  });

  test('retries never re-slot while the time is still far enough ahead: same time, no new channel read, one video', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.initFailures = 1;
    await c.afterRun(e.runDir, IDLE);
    const slot = e.queue().items()[0].publishAt;
    assert.equal(slot, iso(FIRST)); assert.equal(g.videos.length, 0);
    e.clock.t += 5 * MIN + 1000; await c.tick(IDLE); // 70 min before the slot: still >= the 1 h lead
    assert.equal(g.videos.length, 1);
    assert.deepEqual(sent(g), [slot]); assert.equal(e.queue().items()[0].publishAt, slot);
    assert.equal(g.count('channels'), 1);
  });

  test('missing readonly scope fails closed: no request to Google, no slot, no upload, no attempt used, plain message', async () => {
    const { grantedScopes: _unused, ...noScopes } = authOk;
    for (const auth of [{ ...authOk, grantedScopes: async () => [SCOPE] }, { ...authOk, grantedScopes: async () => null }, noScopes]) {
      const g = await fakeGoogle(); const e = setup([ROWS[0]]);
      await schedChain(e, g, { auth }).afterRun(e.runDir, IDLE);
      assert.equal(g.log.length, 0);
      const it = e.queue().items()[0];
      assert.equal(it.state, 'queued'); assert.equal(it.publishAt ?? null, null); assert.equal(it.reason, 'schedule-scope-missing'); assert.equal(it.attempts, 0);
      assert.match(readQueueSummary(e.dataDir).message, /Sign in again to allow reading scheduled posts/);
    }
  });

  test('Google refuses the read (403 scope) or fails (500): nothing uploads, nothing is guessed; goes up once the read works', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.channelError = 'scope';
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'schedule-scope-missing');
    g.opt.channelError = 500; e.clock.t += 31 * MIN; await c.tick(IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'schedule-read-failed'); assert.equal(e.queue().items()[0].attempts, 0);
    g.opt.channelError = null; e.clock.t += 6 * MIN; await c.tick(IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(e.clock.t + HOUR + 15 * MIN)]);
  });

  test('nothing while live: no read, no slot, no upload; after the stream the slot is set and the clip goes up', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    await c.afterRun(e.runDir, LIVE);
    await c.tick(LIVE); await c.tick({ nope: 1 });
    assert.equal(g.log.length, 0);
    e.clock.t += 3 * HOUR; await c.tick(IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(FIRST + 3 * HOUR)]);
  });

  test('a later item in the batch whose slot came too close before its session started gets a new slot (no past time sent)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true;
    // the first upload is slow: when it finishes, 6 h 20 min have passed, so the second slot (T0 + 7 h 15) is 55 min away
    const fetchImpl = async (u, o) => { const r = await g.fetchImpl(u, o); if (g.videos.length === 1 && e.clock.t === T0) e.clock.t = T0 + 6 * HOUR + 20 * MIN; return r; };
    const c = schedChain(e, g, { fetchImpl });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 1, 'no session started with a too-close time');
    const it = e.queue().items()[1];
    assert.equal(it.state, 'queued'); assert.equal(it.publishAt, null); assert.equal(it.reason, 'slot-passed'); assert.equal(it.attempts, 0);
    assert.deepEqual(failedUploadTasks(e), [], 'a re-slot is not shown as a failed task');
    await c.tick(IDLE);
    assert.equal(g.videos.length, 2);
    const now = T0 + 6 * HOUR + 20 * MIN;
    assert.deepEqual(sent(g), [iso(FIRST), iso(now + HOUR + 15 * MIN)]);
    assert.ok(Date.parse(sent(g)[1]) - now >= HOUR, 'the time sent is at least the lead ahead of when its session started');
  });

  test('time comes too close during the upload: stopped between chunks, unfinished session dropped, new slot, one video', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const fetchImpl = async (u, o) => { const r = await g.fetchImpl(u, o); if (g.count('chunk') === 1 && e.clock.t === T0) e.clock.t = T0 + HOUR + 5 * MIN; return r; };
    const c = schedChain(e, g, { fetchImpl });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('chunk'), 1, 'stopped after the first chunk (10 min left < 15 min margin)'); assert.equal(g.videos.length, 0);
    assert.equal(e.queue().items()[0].reason, 'slot-passed'); assert.deepEqual(failedUploadTasks(e), []);
    await c.tick(IDLE); // drops the unfinished session (progress query), clears the slot
    assert.equal(g.count('query'), 1); assert.equal(e.queue().items()[0].publishAt, null); assert.equal(e.queue().items()[0].session, null);
    await c.tick(IDLE); // new slot, new session
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 2);
    assert.deepEqual(sent(g), [iso(T0 + HOUR + 5 * MIN + HOUR + 15 * MIN)]);
    assert.equal(g.sessions.get('s1').video, null, 'the first session never became a video');
  });

  test('a slot that passed during a long stream gets a new slot, also when an unfinished session was open', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.initFailures = 1;
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[0].publishAt, iso(FIRST)); assert.equal(e.queue().items()[0].session, null);
    e.clock.t = T0 + 10 * HOUR; await c.tick(LIVE);
    assert.equal(g.count('channels'), 1);
    await c.tick(IDLE);
    assert.deepEqual(sent(g), [iso(T0 + 11 * HOUR + 15 * MIN)]);
    // unfinished session open: dropped (never finished with a passed time), then a new slot and a new session
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]); const c2 = schedChain(e2, g2);
    g2.opt.chunkFailOnce = true;
    await c2.afterRun(e2.runDir, IDLE);
    assert.ok(e2.queue().items()[0].session); assert.equal(e2.queue().items()[0].sessionPublishAt, iso(FIRST));
    e2.clock.t = T0 + 10 * HOUR; await c2.tick(IDLE);
    assert.equal(g2.videos.length, 0); assert.equal(e2.queue().items()[0].reason, 'slot-passed');
    await c2.tick(IDLE);
    assert.deepEqual(sent(g2), [iso(T0 + 11 * HOUR + 15 * MIN)]); assert.equal(g2.count('init'), 2);
  });

  // Before D375 an automatic upload could start with no publish time (flag post-schedule off). Such a session can still be in
  // a queue file from then: it is made here by clearing the times of an open session.
  const makeLegacy = (e) => { const it = e.queue().items()[0]; e.queue().patch(it.id, { sessionPublishAt: null, publishAt: null }); };

  test('post-schedule off: an automatic upload waits (never goes up without a publish time); on: it goes up scheduled', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    await e.chain(g, { flags: SCHED_OFF }).afterRun(e.runDir, IDLE);
    assert.equal(g.log.length, 0, 'no request to Google at all');
    const it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'schedule-off'); assert.equal(it.attempts, 0); assert.equal(it.publishAt ?? null, null);
    e.clock.t += 31 * MIN; await schedChain(e, g).tick(IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(e.clock.t + HOUR + 15 * MIN)]);
  });

  test('an unscheduled session from before D375 is not finished as if scheduled: new session with the slot', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.chunkFailOnce = true;
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    makeLegacy(e);
    assert.ok(e.queue().items()[0].session); assert.equal(e.queue().items()[0].sessionPublishAt, null);
    e.clock.t += 6 * MIN;
    await schedChain(e, g).tick(IDLE);
    assert.equal(g.count('init'), 2, 'the unscheduled session was dropped');
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(e.clock.t + HOUR + 15 * MIN)]);
    assert.equal(e.uploads()[0].posted[0].publishAt, sent(g)[0]);
  });

  test('a FINISHED unscheduled session is recorded with no publish time (never a schedule that was not sent)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.dropFinalAnswer = true; g.opt.queryAfterComplete = 'error';
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    makeLegacy(e);
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'queued');
    g.opt.queryAfterComplete = 'resource'; e.clock.t += 6 * MIN;
    await schedChain(e, g).tick(IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.sentPublishAt, null); assert.equal(g.count('init'), 1);
    assert.equal('publishAt' in e.uploads()[0].posted[0], false);
    assert.equal(readQueueSummary(e.dataDir, null, e.clock.t).nextPublishAt, null);
  });

  test('a scheduled upload that finished but was only confirmed after its time passed is marked plainly, not silently', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.dropFinalAnswer = true; g.opt.queryAfterComplete = 'error';
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(FIRST)]);
    g.opt.queryAfterComplete = 'resource'; e.clock.t = T0 + 2 * HOUR;
    await c.tick(IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, 'went-public-early'); assert.equal(it.sentPublishAt, iso(FIRST));
    const s = readQueueSummary(e.dataDir, null, e.clock.t);
    assert.equal(s.attention, 1); assert.match(s.message, /may have gone public early/);
  });

  test('pagination cap hit: nothing is scheduled or uploaded (fail closed), plain message; within the cap page 2 is read', async () => {
    const f = (e, maxPages) => schedFile(e, { maxPages });
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = Array.from({ length: 160 }, (_, i) => vid(`c${i}`, 'public'));
    g.opt.channel[70] = vid('mid', 'private', iso(T0 + 5 * HOUR));
    await schedChain(e, g, { scheduleFile: f(e, 2) }).afterRun(e.runDir, IDLE);
    assert.equal(g.count('channels'), 1); assert.equal(g.count('playlist'), 2); assert.equal(g.count('init'), 0);
    const it = e.queue().items()[0];
    assert.equal(it.reason, 'schedule-read-incomplete'); assert.equal(it.publishAt ?? null, null); assert.equal(it.attempts, 0);
    assert.match(readQueueSummary(e.dataDir).message, /raise maxPages/);
    assert.equal(qfile(e).schedule.truncated, true); assert.equal(qfile(e).schedule.scanned, 100);
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]);
    g2.opt.channel = Array.from({ length: 90 }, (_, i) => vid(`c${i}`, 'public'));
    g2.opt.channel[70] = vid('mid', 'private', iso(T0 + 5 * HOUR)); // page 2
    await schedChain(e2, g2, { scheduleFile: f(e2, 2) }).afterRun(e2.runDir, IDLE);
    assert.equal(g2.count('playlist'), 2); assert.deepEqual(sent(g2), [iso(T0 + 11 * HOUR)]);
  });

  // Chunk deadline (Codex round 2): margin 1 min and a deadline of 59.5 s, so with the clock at slot - 60 s every chunk
  // request has 500 ms (real time) before it is aborted.
  const SLOT = T0 + HOUR + MIN; // floor with marginMinutes 1
  const nearSlot = (e, g, after) => async (u, o) => {
    const r = await g.fetchImpl(u, o);
    if (e.clock.t === T0 && after()) e.clock.t = SLOT - MIN; // the upload got slow: 60 s left before the slot
    return r;
  };

  test('a final chunk that stalls is aborted before the slot; the unfinished session is dropped and the clip gets a new slot', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; g.opt.stallFinal = 'hold';
    const c = schedChain(e, g, { fetchImpl: nearSlot(e, g, () => g.count('chunk') === 1), scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.5 }) });
    const t = performance.now();
    await c.afterRun(e.runDir, IDLE);
    const took = performance.now() - t;
    assert.equal(g.count('stall'), 1, 'the final chunk was sent and got no answer'); assert.equal(g.videos.length, 0);
    assert.ok(took >= 400 && took < 5000, `aborted at the deadline (${Math.round(took)} ms), not left hanging`);
    assert.equal(g.count('query'), 1, 'asked Google once whether it finished anyway');
    const it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'slot-passed'); assert.equal(it.attempts ?? 0, 0);
    assert.deepEqual(failedUploadTasks(e), [], 'a deadline abort is not shown as a failed task');
    g.opt.stallFinal = null;
    await c.tick(IDLE); // the session (60 s from its time) is dropped, the slot cleared
    assert.equal(e.queue().items()[0].publishAt, null); assert.equal(e.queue().items()[0].session, null);
    await c.tick(IDLE); // new slot, new session
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 2);
    assert.deepEqual(sent(g), [iso(SLOT - MIN + HOUR + MIN)]);
    assert.equal(g.sessions.get('s1').video, null, 'the stalled session never became a video');
  });

  test('a final chunk aborted at the deadline that Google had finished anyway is recorded as done with its slot', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; g.opt.stallFinal = 'finalize';
    const c = schedChain(e, g, { fetchImpl: nearSlot(e, g, () => g.count('chunk') === 1), scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.5 }) });
    await c.afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, null); assert.equal(it.sentPublishAt, iso(SLOT));
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 1); assert.equal(e.uploads()[0].posted[0].publishAt, iso(SLOT));
  });

  test('a fast final chunk under the same deadline is unaffected', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g, { fetchImpl: nearSlot(e, g, () => g.count('chunk') === 1), scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.5 }) });
    await c.afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, null); assert.deepEqual(sent(g), [iso(SLOT)]);
    assert.equal(g.count('query'), 0); assert.equal(g.count('init'), 1);
  });

  test('a slot 30 days ahead (beyond the setTimeout limit of about 24.8 days) uploads normally with no abort', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = [vid('far', 'private', iso(T0 + 30 * 24 * HOUR - 6 * HOUR))];
    await schedChain(e, g, { scheduleFile: schedFile(e, { placement: 'after-last' }) }).afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, null);
    assert.deepEqual(sent(g), [iso(T0 + 30 * 24 * HOUR)]);
    assert.equal(g.count('query'), 0, 'no abort, so no progress query'); assert.equal(g.count('init'), 1);
    assert.ok(g.count('chunk') > 1, 'several chunks, each with the far deadline');
  });

  test('the final chunk does not start when its estimated transfer time does not fit before the deadline', async () => {
    // One chunk (no speed measured yet): fallbackKbps 64 = 8000 B/s, ~370 bytes needs ~46 ms; only 10 ms are left.
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g, { chunkSize: 1 << 20, fetchImpl: nearSlot(e, g, () => g.count('init') === 1),
      scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.99, fallbackKbps: 64 }) });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('chunk'), 0, 'no byte sent'); assert.equal(g.videos.length, 0);
    assert.equal(e.queue().items()[0].reason, 'slot-passed');
    // with a fast enough fallback it fits and goes up
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]); g2.opt.hideOwnUploads = true;
    await schedChain(e2, g2, { chunkSize: 1 << 20, fetchImpl: nearSlot(e2, g2, () => g2.count('init') === 1),
      scheduleFile: schedFile(e2, { marginMinutes: 1, chunkDeadlineSeconds: 59.5, fallbackKbps: 1000 }) }).afterRun(e2.runDir, IDLE);
    assert.deepEqual(sent(g2), [iso(SLOT)]);
  });
  // D314 (user 2026-11-09) with D375 gap filling: a retry less than 1 h from its time gets the earliest free time from
  // now + lead + margin, at least 6 h from every other time; the other queued clips keep their times.
  test('D314: a retry 45 min from its time gets the next free time; the other queued clips keep theirs', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = schedChain(e, g);
    g.opt.initFailures = 3; // every session start fails once: three queued clips with slots, no session, backing off
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 0);
    assert.deepEqual(e.queue().items().map((i) => [i.publishAt, i.session ?? null]), [[iso(FIRST), null], [iso(FIRST + 6 * HOUR), null], [iso(FIRST + 12 * HOUR), null]]);
    e.clock.t = T0 + 30 * MIN; // the first slot (T0 + 1 h 15) is now 45 min away: less than the 1 h lead
    await c.tick(IDLE);
    const now = T0 + 30 * MIN; const R = FIRST + 18 * HOUR; // 11:45 is too close to 17:15, and 23:15 is taken: the next free time
    assert.deepEqual(sent(g), [iso(R), iso(FIRST + 6 * HOUR), iso(FIRST + 12 * HOUR)]);
    assert.deepEqual(e.queue().items().map((i) => i.state), ['done', 'done', 'done']);
    assert.ok(e.queue().items().every((i) => !i.reslot));
    assert.equal(readQueueSummary(e.dataDir, null, now).lastPublishAt, iso(R), 'the control page shows the new time');
  });

  test('D314: uploaded clips keep their times; the retry and a new clip take the next free times, 6 h from every other', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = schedChain(e, g);
    g.opt.initFailures = 1; // the first clip's session start fails; the other two upload at FIRST + 6 h and FIRST + 12 h
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST + 6 * HOUR), iso(FIRST + 12 * HOUR)]);
    e.clock.t = T0 + 30 * MIN; addRow(e, { name: 'codm_montage_20261109-100000_kills-7_03_v.mp4', kind: 'montage', seconds: 45 });
    await c.afterRun(e.runDir, IDLE);
    const items = e.queue().items();
    assert.equal(items[1].sentPublishAt, iso(FIRST + 6 * HOUR)); assert.equal(items[2].sentPublishAt, iso(FIRST + 12 * HOUR));
    assert.equal(items[0].sentPublishAt, iso(FIRST + 18 * HOUR), 'the retry: 11:45 is within 6 h of 17:15, so after 23:15');
    assert.equal(items[3].sentPublishAt, iso(FIRST + 24 * HOUR), 'the new clip: the next free time after the retry');
  });

  test('D314: a clip with an open session keeps its time (Google applies the session time); only the retry moves', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.initFailures = 1; g.opt.chunkFailOnce = true; // clip 1: no session; clip 2: session open, first chunk failed
    await c.afterRun(e.runDir, IDLE);
    const before = e.queue().items();
    assert.equal(before[0].session ?? null, null); assert.ok(before[1].session); assert.equal(before[1].sessionPublishAt, iso(FIRST + 6 * HOUR));
    e.clock.t = T0 + 30 * MIN;
    await c.tick(IDLE);
    const R = FIRST + 12 * HOUR; // 11:45 is within 6 h of the open session's 17:15
    assert.deepEqual(e.queue().items().map((i) => i.sentPublishAt), [iso(R), iso(FIRST + 6 * HOUR)]);
    assert.equal(g.videos.length, 2); assert.equal(g.count('init'), 3, 'clip 2 resumed its session, no new one');
  });

  test('D314 gap: a retry whose floor equals a channel post goes the gap (6 h) after it (read from the fake channel)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.initFailures = 1;
    await c.afterRun(e.runDir, IDLE);
    g.opt.channel = [vid('p1', 'private', iso(T0 + HOUR + 45 * MIN))]; // exactly the retry floor at now = T0 + 30 min
    e.clock.t = T0 + 30 * MIN; await c.tick(IDLE);
    assert.deepEqual(sent(g), [iso(T0 + 7 * HOUR + 45 * MIN)]);
    assert.deepEqual(qfile(e).schedule.channelTimes, [iso(T0 + HOUR + 45 * MIN)]);
  });

  test('D375 delete flag on: the clip file is deleted only once YouTube says processed; log line and one task bar line', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    const file = e.uploads()[0].file; const folder = path.dirname(file);
    const c = e.chain(g, { flags: { isOn: () => true }, clipsFolder: folder });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'done');
    assert.ok(existsSync(file), 'still processing at YouTube: kept');
    assert.equal(e.queue().items()[0].deleteReason, 'still-processing');
    g.videos[0].status.uploadStatus = 'processed';
    await c.tick(IDLE);
    assert.ok(existsSync(file), 'not asked again before the 15 min wait');
    e.clock.t += 16 * MIN; await c.tick(IDLE);
    assert.equal(existsSync(file), false);
    const it = e.queue().items()[0];
    assert.equal(it.deleteState, 'deleted'); assert.equal(it.lastStatus.uploadStatus, 'processed');
    const log = readFileSync(path.join(e.dataDir, 'posting', 'deleted.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => [l.file, l.videoId]), [[path.basename(file), g.videos[0].id]]);
    const tasks = readdirSync(tasksDir(e.dataDir)).filter((n) => n.startsWith('post-deleted-'));
    assert.equal(tasks.length, 1);
    e.clock.t += 16 * MIN; await c.tick(IDLE);
    assert.equal(readdirSync(tasksDir(e.dataDir)).filter((n) => n.startsWith('post-deleted-')).length, 1, 'never checked again');
  });

  test('D375 delete flag on, but the upload failed or the file changed: the file is kept for good', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    const file = e.uploads()[0].file;
    const c = e.chain(g, { flags: { isOn: () => true }, clipsFolder: path.dirname(file) });
    await c.afterRun(e.runDir, IDLE);
    writeFileSync(file, 'edited after the upload');
    g.videos[0].status.uploadStatus = 'processed'; e.clock.t += 16 * MIN; await c.tick(IDLE);
    assert.ok(existsSync(file)); assert.equal(e.queue().items()[0].deleteState, 'kept'); assert.equal(e.queue().items()[0].deleteReason, 'sha-mismatch');
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]);
    const file2 = e2.uploads()[0].file;
    const c2 = e2.chain(g2, { flags: { isOn: () => true }, clipsFolder: path.dirname(file2) });
    await c2.afterRun(e2.runDir, IDLE);
    g2.videos[0].status.uploadStatus = 'failed'; e2.clock.t += 16 * MIN; await c2.tick(IDLE);
    assert.ok(existsSync(file2)); assert.equal(e2.queue().items()[0].deleteReason, 'upload-failed');
  });

  test('D314 cap: a slot more than maxAheadDays ahead is not given; the clip waits (plain reason, no attempt) and goes up later', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = [vid('s1', 'private', iso(T0 + 20 * HOUR))]; // next slot T0 + 26 h, past a 1-day cap
    const c = schedChain(e, g, { scheduleFile: schedFile(e, { maxAheadDays: 1, placement: 'after-last' }) });
    await c.afterRun(e.runDir, IDLE);
    let it = e.queue().items()[0];
    assert.equal(g.count('init'), 0); assert.equal(it.state, 'queued'); assert.equal(it.publishAt, null);
    assert.equal(it.reason, 'schedule-beyond-cap'); assert.equal(it.attempts, 0);
    assert.match(readQueueSummary(e.dataDir, null, T0).message, /further ahead than the schedule allows \(days ahead/);
    const reads = g.count('channels');
    e.clock.t = T0 + HOUR; await c.tick(IDLE);
    assert.equal(g.count('channels'), reads, 'a capped clip does not re-read the channel before its wait ends');
    e.clock.t = T0 + 6 * HOUR + MIN; await c.tick(IDLE); // the cap is now T0 + 30 h: the slot fits
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.deepEqual(sent(g), [iso(T0 + 26 * HOUR)]);
  });

});