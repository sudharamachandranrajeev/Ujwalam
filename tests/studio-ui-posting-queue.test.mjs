// SPDX-License-Identifier: GPL-3.0-or-later
// D301: control page upload queue (summary, per-item state and reason, link when done) and the "Retry now" route.
// Fakes only: temp dirs, fake host, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { postId } from '../services/posting/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d301ui-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, text: buf.toString('utf8'), headers: res.headers, json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function makePost(dataDir, name, kind) {
  const video = Buffer.from(`${name}`.repeat(10));
  const sha = createHash('sha256').update(video).digest('hex');
  const dir = path.join(mk(), 'posts', name, 'youtube-shorts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'v.mp4'), video);
  const stamp = '2026-11-08T09:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: 'T', description: 'D', tags: ['g'], hashtags: ['#Shorts'], target: 'youtube-shorts', privacy: 'private', status: 'approved',
    source: { run: 'run1', clipId: name, kind, layout: 'v', startSec: 0, endSec: 30, score: null, sha256: sha },
    video: { file: 'v.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  return { key: `${sha}:youtube-shorts`, entry: { sha256: sha, target: 'youtube-shorts', status: 'approved', dir, clipId: name, createdAt: stamp, updatedAt: stamp }, id: postId({ sha256: sha, target: 'youtube-shorts' }) };
}

async function boot({ sinks = [], outputsThrows = false } = {}) {
  const dataDir = mk();
  const a = makePost(dataDir, 'montage-a', 'montage');
  const b = makePost(dataDir, 'reel-b', 'won-reel');
  const c = makePost(dataDir, 'short-c', 'short');
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  writeFileSync(path.join(dataDir, 'posting', 'ledger.json'), JSON.stringify({ version: 1, entries: { [a.key]: a.entry, [b.key]: b.entry, [c.key]: { ...c.entry, status: 'uploaded', videoId: 'VID777' } } }));
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
  const queue = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
  queue.add(a.id); queue.add(b.id); queue.add(c.id);
  queue.patch(a.id, { state: 'queued', reason: 'no-oauth-client', nextAt: '2026-11-08T12:00:00.000Z' });
  queue.patch(b.id, { state: 'failed', attempts: 8, reason: 'upload-failed' });
  queue.patch(c.id, { state: 'done', videoId: 'VID777' });
  const outputsStatus = async () => { if (outputsThrows) throw new Error('host down'); return { sinks }; };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, outputsStatus } });
  const { port } = await srv.listen();
  const lr = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = lr.headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  const get = (url) => raw(port, { url, headers: { cookie } });
  return { srv, port, cookie, post, get, ids: { a: a.id, b: b.id, c: c.id }, queue: () => createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME)) };
}
const RETRY = '/ui/api/posts/queue/retry';

describe('posts list carries the queue', () => {
  test('summary, per-item state, plain reason, link only when uploaded, kind', async () => {
    const t = await boot();
    try {
      const r = (await t.get('/ui/api/posts')).json();
      assert.equal(r.queue.queued, 1); assert.equal(r.queue.failed, 1); assert.equal(r.queue.done, 1);
      assert.equal(r.queue.reason, 'no-oauth-client');
      assert.match(r.queue.message, /Not signed in to YouTube: the Google sign-in client is not set up yet/);
      assert.equal(r.queue.nextAt, '2026-11-08T12:00:00.000Z');
      const by = Object.fromEntries(r.posts.map((p) => [p.id, p]));
      assert.equal(by[t.ids.a].queueState, 'queued'); assert.equal(by[t.ids.a].kind, 'montage');
      assert.match(by[t.ids.a].queueReasonText, /Not signed in to YouTube/);
      assert.equal(by[t.ids.a].videoUrl, null);
      assert.equal(by[t.ids.b].queueState, 'failed'); assert.equal(by[t.ids.b].kind, 'won-reel');
      assert.match(by[t.ids.b].queueReasonText, /Upload failed \(upload-failed\)/);
      assert.equal(by[t.ids.c].videoUrl, 'https://youtu.be/VID777'); assert.equal(by[t.ids.c].queueState, 'done');
    } finally { t.srv.close(); }
  });
});

describe('Retry now', () => {
  test('a failed item is queued again at once with a fresh count; the answer carries the new summary', async () => {
    const t = await boot();
    try {
      const r = await t.post(RETRY, { id: t.ids.b });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json().state, 'queued');
      const it = t.queue().get(t.ids.b);
      assert.deepEqual({ state: it.state, attempts: it.attempts, nextAt: it.nextAt, reason: it.reason }, { state: 'queued', attempts: 0, nextAt: null, reason: null });
      assert.equal(r.json().queue.failed, 0);
    } finally { t.srv.close(); }
  });
  test('refused while a stream is live, and when the live state cannot be read; nothing changes', async () => {
    for (const opts of [{ sinks: [{ kind: 'stream', id: 'yt', state: 'live' }] }, { outputsThrows: true }]) {
      const t = await boot(opts);
      try {
        const r = await t.post(RETRY, { id: t.ids.b });
        assert.equal(r.status, 409, JSON.stringify(opts));
        assert.match(r.json().error, /stream-live|output-state-unreadable/);
        assert.equal(t.queue().get(t.ids.b).state, 'failed');
      } finally { t.srv.close(); }
    }
  });
  test('a local recording does not block it; done and unknown items and bad bodies are refused', async () => {
    const t = await boot({ sinks: [{ kind: 'record', id: 'rec', state: 'live' }] });
    try {
      assert.equal((await t.post(RETRY, { id: t.ids.b })).status, 200);
      const done = await t.post(RETRY, { id: t.ids.c });
      assert.equal(done.status, 409); assert.equal(done.json().error, 'not-retryable');
      assert.equal((await t.post(RETRY, { id: 'nope' })).status, 404);
      assert.equal((await t.post(RETRY, { id: t.ids.b, extra: 1 })).status, 400);
      assert.equal((await t.post(RETRY, {})).status, 400);
    } finally { t.srv.close(); }
  });
  test('needs the page session and CSRF like every write', async () => {
    const t = await boot();
    try {
      const body = JSON.stringify({ id: t.ids.b });
      const h = { 'content-type': 'application/json', origin: `http://127.0.0.1:${t.port}` };
      assert.notEqual((await raw(t.port, { method: 'POST', url: RETRY, body, headers: h })).status, 200, 'no cookie');
      assert.equal((await raw(t.port, { method: 'POST', url: RETRY, body, headers: { ...h, cookie: t.cookie } })).status, 403, 'no csrf');
      assert.equal(t.queue().get(t.ids.b).state, 'failed');
    } finally { t.srv.close(); }
  });
});

describe('UI source', () => {
  const js = readFileSync(path.join(UI, 'js', 'app.js'), 'utf8') + readFileSync(path.join(UI, 'js', 'api.js'), 'utf8');
  const html = readFileSync(path.join(UI, 'index.html'), 'utf8');
  test('safe DOM, retry wired, queue elements present', () => {
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js));
    assert.match(js, /posts\/queue\/retry/);
    assert.match(js, /queueRetry/);
    for (const id of ['posts-queue', 'post-queue', 'post-queue-info', 'post-queue-link', 'post-queue-retry']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(!/<script[^>]+src="https?:/.test(html), 'no CDN');
  });
});
