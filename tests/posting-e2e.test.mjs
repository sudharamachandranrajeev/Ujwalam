// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end auto posting against a local fake Google/YouTube HTTP server (127.0.0.1 only, no OAuth, no real network).
// Chain: finished clip job -> packageUploads (montage / won-reel) -> auto rules -> resumable upload -> status check -> markPosted.
// The only seams used: fetchImpl (rewrites the googleapis host to the local server) and a fake token provider (auth).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createPostChain, createUploadQueue, readQueueSummary } from '../services/posting/auto-chain.mjs';
import { createPostStore } from '../services/posting/index.mjs';
import { checkPostStatus } from '../services/posting/youtube.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-e2e-post-')); tmp.push(d); return d; };
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const FFMPEG = process.execPath; // stands in for ffmpeg: the cover step fails and the package has no cover
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const T0 = Date.parse('2026-11-09T10:00:00Z');
const IDLE = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'stopped' }] };
const LIVE = { sinks: [{ id: 'yt', kind: 'stream', state: 'live' }] };
const authOk = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-access' };

/** Fake Google: resumable insert sessions, chunk PUTs, progress query, videos.list. `opt` switches inject faults. */
async function fakeGoogle() {
  const opt = { initFailures: 0, chunkFailOnce: false, dropFinalAnswer: false, queryAfterComplete: 'resource' /* | 'gone' | 'error' */ };
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
        s.got = Buffer.concat([s.got, body]);
        if (s.got.length >= s.total) {
          s.video = { id: `vid${videos.length + 1}`, status: { uploadStatus: 'uploaded', privacyStatus: s.meta.status.privacyStatus }, snippet: s.meta.snippet };
          videos.push({ ...s.video, bytes: s.got.length });
          if (opt.dropFinalAnswer) return req.socket.destroy(); // upload completed on the server, the answer never arrives
          return send(200, s.video);
        }
        return send(308, undefined, { range: `bytes=0-${s.got.length - 1}` });
      }
      if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
        log.push('list');
        const v = videos.find((x) => x.id === url.searchParams.get('id'));
        return send(200, { items: v ? [{ id: v.id, status: v.status, processingDetails: { processingStatus: 'succeeded' } }] : [] });
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
  const chain = (g, extra = {}) => createPostChain({ dataDir, flags: { isOn: (id) => id !== 'post-schedule' }, rulesFile, auth: authOk, fetchImpl: g.fetchImpl, now: () => clock.t,
    tickEveryMs: 0, profileFile, ffmpeg: FFMPEG, chunkSize: 16, ...extra });
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
