// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI server: Posts API (P16a, flag `posting`). Hand-made package on disk (no ffmpeg needed), fake host, stub core,
// 127.0.0.1 only. Checks the flag gate, auth/CSRF, media serving rules (ranges, allowlist, traversal), edit/approve/reject,
// the ledger and the open-folder seam. Nothing is uploaded; there is no network code to test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pui-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), get text() { return this.buf.toString('utf8'); }, json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function login(port) {
  const r = await raw(port, { url: `/login?k=${KEY}` });
  assert.equal(r.status, 302);
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
const get = (port, a, url, headers = {}) => raw(port, { url, headers: { cookie: a.cookie, ...headers } });
const post = (port, a, route, body) => raw(port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: a.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf },
});

const VIDEO = Buffer.from('0123456789abcdefghij'.repeat(10)); // 200 bytes: stands in for an mp4 (served as bytes)
const sha = createHash('sha256').update(VIDEO).digest('hex');

function makePackage(dataDir) {
  const dir = path.join(mk(), 'posts', 'c01', 'youtube-shorts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'full-crop.mp4'), VIDEO);
  writeFileSync(path.join(dir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(path.join(dir, 'captions.ass'), '[Script Info]\n');
  const stamp = '2026-11-03T18:00:00.000Z';
  const limits = { status: 'unverified', ok: true, checks: [{ field: 'title', value: 9, max: 100, ok: true }] };
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: 'Test title', description: 'Test description', tags: ['gaming'], hashtags: ['#Shorts'], target: 'youtube-shorts',
    privacy: 'private', status: 'draft', source: { run: 'run', clipId: 'c01', layout: 'full-crop', startSec: 10, endSec: 12, sha256: sha },
    video: { file: 'full-crop.mp4', bytes: VIDEO.length }, cover: { file: 'cover.jpg', atSec: 1 }, captions: 'captions.ass', limits, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${sha}:youtube-shorts`]: { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: 'c01', createdAt: stamp, updatedAt: stamp } } }));
  return { dir, ledgerFile, id: postId({ sha256: sha, target: 'youtube-shorts' }) };
}

async function boot({ flagOn }) {
  const dataDir = mk();
  const pkg = makePackage(dataDir);
  if (flagOn) writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
  const opened = [];
  const fake = createFakeHost({ outputsReady: true });
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: fake, launchKey: KEY, dataDir, feedbackDir: mk(), openFolder: (d) => { opened.push(d); return true; }, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  const a = await login(port);
  return { srv, port, a, dataDir, opened, ...pkg };
}

describe('posts API with the flag off', () => {
  let c;
  before(async () => { c = await boot({ flagOn: false }); });
  after(() => c.srv.close());
  test('every posts route answers 404 posting-off', async () => {
    for (const u of ['/ui/api/posts', `/ui/api/posts/media?id=${c.id}&kind=video`]) {
      const r = await get(c.port, c.a, u);
      assert.equal(r.status, 404, u);
      assert.equal(r.json().error, 'posting-off');
    }
    const p = await post(c.port, c.a, '/ui/api/posts/status', { id: c.id, status: 'approved' });
    assert.equal(p.status, 404);
    assert.equal(JSON.parse(readFileSync(path.join(c.dir, 'post.json'), 'utf8')).status, 'draft');
  });
});

describe('posts API with the flag on', () => {
  let c;
  before(async () => { c = await boot({ flagOn: true }); });
  after(() => c.srv.close());

  test('needs the session; POST needs CSRF', async () => {
    assert.equal((await raw(c.port, { url: '/ui/api/posts' })).status, 401);
    const r = await raw(c.port, { method: 'POST', url: '/ui/api/posts/status', body: '{}', headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json' } });
    assert.equal(r.status, 403);
  });

  test('the page ships the Posts button (hidden by default) and the CSP allows same-origin media only', async () => {
    const r = await get(c.port, c.a, '/');
    assert.match(r.text, /id="btn-posts"[^>]*hidden/);
    assert.match(r.headers['content-security-policy'], /media-src 'self'/);
    assert.ok(!/innerHTML/.test(readFileSync(path.join(UI, 'js', 'app.js'), 'utf8')));
  });

  test('list shows the package and no file system path', async () => {
    const r = await get(c.port, c.a, '/ui/api/posts');
    assert.equal(r.status, 200);
    const posts = r.json().posts;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, c.id);
    assert.equal(posts[0].privacy, 'private');
    assert.equal(posts[0].hasCover, true);
    assert.ok(!r.text.includes(c.dir), 'no path in the list');
    assert.ok(!r.text.includes(sha), 'no full hash in the list');
  });

  test('media: video bytes, range, bad range, cover, no captions, bad ids and kinds', async () => {
    const v = await get(c.port, c.a, `/ui/api/posts/media?id=${c.id}&kind=video`);
    assert.equal(v.status, 200);
    assert.equal(v.headers['content-type'], 'video/mp4');
    assert.deepEqual(v.buf, VIDEO);
    const part = await get(c.port, c.a, `/ui/api/posts/media?id=${c.id}&kind=video`, { range: 'bytes=10-19' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], `bytes 10-19/${VIDEO.length}`);
    assert.deepEqual(part.buf, VIDEO.subarray(10, 20));
    const tail = await get(c.port, c.a, `/ui/api/posts/media?id=${c.id}&kind=video`, { range: 'bytes=-5' });
    assert.deepEqual(tail.buf, VIDEO.subarray(VIDEO.length - 5));
    assert.equal((await get(c.port, c.a, `/ui/api/posts/media?id=${c.id}&kind=video`, { range: 'bytes=999-' })).status, 416);
    assert.equal((await get(c.port, c.a, `/ui/api/posts/media?id=${c.id}&kind=video`, { range: 'junk' })).status, 416);
    const cv = await get(c.port, c.a, `/ui/api/posts/media?id=${c.id}&kind=cover`);
    assert.equal(cv.headers['content-type'], 'image/jpeg');
    for (const q of [`id=${c.id}&kind=captions`, `id=${c.id}&kind=../post.json`, 'id=../../etc/passwd&kind=video', `id=${c.id.replace(/^./, 'z')}&kind=video`, 'kind=video', `id=${encodeURIComponent('..\\..\\x')}&kind=video`]) {
      assert.equal((await get(c.port, c.a, `/ui/api/posts/media?${q}`)).status, 404, q);
    }
  });

  test('edit: saves text to post.json, recomputes limits; bad fields refused', async () => {
    const r = await post(c.port, c.a, '/ui/api/posts/edit', { id: c.id, title: 'x'.repeat(150), tags: ['a', 'b'], hashtags: ['one'] });
    assert.equal(r.status, 200);
    const p = r.json().post;
    assert.equal(p.status, 'draft');
    assert.equal(p.limits.ok, false, 'over the YouTube 100-character title limit is flagged, not truncated');
    assert.equal(p.title.length, 150);
    assert.deepEqual(p.hashtags, ['#one']);
    assert.equal(JSON.parse(readFileSync(path.join(c.dir, 'post.json'), 'utf8')).title.length, 150);
    assert.equal((await post(c.port, c.a, '/ui/api/posts/edit', { id: c.id, title: 5 })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/posts/edit', { id: c.id, path: '/x' })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/posts/edit', { id: '0000000000000000.nope', title: 'a' })).status, 404);
  });

  test('approve refused over the limit; approve and reject write post.json and the ledger', async () => {
    const bad = await post(c.port, c.a, '/ui/api/posts/status', { id: c.id, status: 'approved' });
    assert.equal(bad.status, 409);
    assert.equal(bad.json().error, 'over-limit');
    await post(c.port, c.a, '/ui/api/posts/edit', { id: c.id, title: 'Short title' });
    const ok = await post(c.port, c.a, '/ui/api/posts/status', { id: c.id, status: 'approved' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json().post.status, 'approved');
    assert.equal(JSON.parse(readFileSync(path.join(c.dir, 'post.json'), 'utf8')).status, 'approved');
    assert.equal(Object.values(JSON.parse(readFileSync(c.ledgerFile, 'utf8')).entries)[0].status, 'approved');
    const rej = await post(c.port, c.a, '/ui/api/posts/status', { id: c.id, status: 'rejected' });
    assert.equal(rej.json().post.status, 'rejected');
    assert.equal(createPostStore({ ledgerFile: c.ledgerFile }).list()[0].status, 'rejected');
    assert.equal((await post(c.port, c.a, '/ui/api/posts/status', { id: c.id, status: 'published' })).status, 400);
  });

  test('open folder: only the package folder of a known id', async () => {
    assert.equal((await post(c.port, c.a, '/ui/api/posts/open', { id: c.id })).status, 200);
    assert.deepEqual(c.opened, [c.dir]);
    assert.equal((await post(c.port, c.a, '/ui/api/posts/open', { id: '../..' })).status, 404);
    assert.equal((await post(c.port, c.a, '/ui/api/posts/open', { id: c.id, dir: '/' })).status, 400);
    assert.equal(c.opened.length, 1);
  });
});
