// SPDX-License-Identifier: GPL-3.0-or-later
// F7: Posts view YouTube private upload + status check (flag `posting`). Fake auth and fake fetch only: nothing here touches
// Google, a browser or Credential Manager. Checks the Upload click (no typed phrase, D331), live refusal (fail closed), approved-only,
// no double upload, no token in any response, the status route, and the UI source rules.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { checkUploadStatus } from '../services/posting/youtube.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const TOKEN = 'SECRET-ACCESS-TOKEN-123'; // lint-allow: secret (a fake test token, not a credential)
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-f7-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json() { return JSON.parse(buf.toString('utf8')); } });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const VIDEO = Buffer.from('0123456789abcdefghij'.repeat(10));
const sha = createHash('sha256').update(VIDEO).digest('hex');

function makePackage(dataDir) {
  const dir = path.join(mk(), 'posts', 'c01', 'youtube-shorts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'full-crop.mp4'), VIDEO);
  const stamp = '2026-11-03T18:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: 'Test title', description: 'Test description', tags: ['gaming'], hashtags: ['#Shorts'], target: 'youtube-shorts',
    privacy: 'private', status: 'draft', source: { run: 'run', clipId: 'c01', layout: 'full-crop', startSec: 10, endSec: 12, sha256: sha },
    video: { file: 'full-crop.mp4', bytes: VIDEO.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${sha}:youtube-shorts`]: { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: 'c01', createdAt: stamp, updatedAt: stamp } } }));
  return { dir, ledgerFile, id: postId({ sha256: sha, target: 'youtube-shorts' }) };
}

const jsonRes = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });

async function boot({ signedIn = true, sinks = [], outputsThrows = false, reauth = false } = {}) {
  const dataDir = mk();
  const pkg = makePackage(dataDir);
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url: String(url), method: o?.method, auth: o?.headers?.Authorization });
    if (String(url).includes('uploadType=resumable')) return jsonRes(200, {}, { location: 'https://upload.example/s1' });
    if (url === 'https://upload.example/s1') return jsonRes(200, { id: 'VID123', status: { uploadStatus: 'uploaded' } });
    if (String(url).includes('/youtube/v3/videos')) return jsonRes(200, { items: [{ status: { uploadStatus: 'processed', privacyStatus: 'private' }, processingDetails: { processingStatus: 'succeeded' } }] });
    throw new Error(`unexpected ${url}`);
  };
  const auth = {
    status: async () => ({ signedIn, hasClient: true }),
    accessToken: async () => { if (reauth) throw Object.assign(new Error('x'), { code: 'oauth-reauth-needed' }); return TOKEN; },
  };
  const outputsStatus = async () => { if (outputsThrows) throw new Error('host down'); return { sinks }; };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, youtube: { auth, fetchImpl, outputsStatus } });
  const { port } = await srv.listen();
  const lr = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = lr.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  const csrf = s.json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  const get = (url) => raw(port, { url, headers: { cookie } });
  const approve = async () => assert.equal((await post('/ui/api/posts/status', { id: pkg.id, status: 'approved' })).status, 200);
  return { srv, port, post, get, approve, calls, ...pkg, store: createPostStore({ ledgerFile: pkg.ledgerFile }) };
}
const UP = '/ui/api/posts/youtube/upload';

describe('youtube status route', () => {
  test('signed in / out, no token or secret in the answer', async () => {
    const c = await boot({ signedIn: true });
    try {
      const r = await c.get('/ui/api/posts/youtube/status');
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json()).sort(), ['hasClient', 'signedIn'], 'no phrase (D331)');
      assert.equal(r.json().signedIn, true);
      assert.ok(!r.text.includes(TOKEN));
    } finally { c.srv.close(); }
    const d = await boot({ signedIn: false });
    try { assert.equal((await d.get('/ui/api/posts/youtube/status')).json().signedIn, false); } finally { d.srv.close(); }
  });
});

describe('youtube upload route', () => {
  test('refused while the post is a draft, with extra fields (an old phrase field too) and for an unknown post; no network call made', async () => {
    const c = await boot();
    try {
      let r = await c.post(UP, { id: c.id });
      assert.equal(r.status, 409); assert.equal(r.json().error, 'not-approved');
      await c.approve();
      r = await c.post(UP, { id: c.id, confirm: 'yes' });
      assert.equal(r.status, 400); assert.equal(r.json().error, 'bad-params', 'the body is { id } only (D331)');
      r = await c.post(UP, { id: c.id, extra: 1 });
      assert.equal(r.status, 400); assert.equal(r.json().error, 'bad-params');
      r = await c.post(UP, { id: 'nope' });
      assert.equal(r.status, 404);
      assert.equal(c.calls.length, 0);
    } finally { c.srv.close(); }
  });

  test('refused while a stream sink is live, and when the live check fails (fail closed)', async () => {
    for (const opts of [{ sinks: [{ kind: 'stream', id: 'yt', state: 'live' }] }, { sinks: [{ kind: 'stream', active: true }] }, { outputsThrows: true }]) {
      const c = await boot(opts);
      try {
        await c.approve();
        const r = await c.post(UP, { id: c.id });
        assert.equal(r.status, 409, JSON.stringify(opts)); assert.equal(r.json().error, 'stream-active');
        assert.equal(c.calls.length, 0);
        assert.equal(c.store.get(c.id).status, 'approved');
      } finally { c.srv.close(); }
    }
  });

  test('happy path: private upload, video id returned and stored, no token leaks, second upload refused, edit locked', async () => {
    const c = await boot();
    try {
      await c.approve();
      const r = await c.post(UP, { id: c.id });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json(), { videoId: 'VID123', uploadStatus: 'uploaded', thumbnailOk: null, privacy: 'private' });
      assert.ok(!r.text.includes(TOKEN));
      const init = c.calls.find((x) => x.url.includes('uploadType=resumable'));
      assert.equal(init.auth, `Bearer ${TOKEN}`);
      const v = c.store.get(c.id);
      assert.equal(v.status, 'uploaded'); assert.equal(v.videoId, 'VID123');
      assert.ok(!(await c.get('/ui/api/posts')).text.includes(TOKEN));
      const again = await c.post(UP, { id: c.id });
      assert.equal(again.status, 409); assert.equal(again.json().error, 'already-uploaded');
      assert.equal(c.calls.filter((x) => x.url.includes('uploadType=resumable')).length, 1);
      assert.equal((await c.post('/ui/api/posts/edit', { id: c.id, title: 'x' })).status, 409);
      assert.equal((await c.post('/ui/api/posts/status', { id: c.id, status: 'draft' })).status, 409);
    } finally { c.srv.close(); }
  });

  test('expired sign-in maps to youtube-not-signed-in (401), nothing uploaded', async () => {
    const c = await boot({ reauth: true });
    try {
      await c.approve();
      const r = await c.post(UP, { id: c.id });
      assert.equal(r.status, 401); assert.equal(r.json().error, 'youtube-not-signed-in');
      assert.equal(c.calls.length, 0);
    } finally { c.srv.close(); }
  });
});

describe('youtube check route', () => {
  test('not uploaded -> 409; uploaded -> processing status; unknown -> 404', async () => {
    const c = await boot();
    try {
      await c.approve();
      let r = await c.post('/ui/api/posts/youtube/check', { id: c.id });
      assert.equal(r.status, 409); assert.equal(r.json().error, 'not-uploaded');
      await c.post(UP, { id: c.id });
      r = await c.post('/ui/api/posts/youtube/check', { id: c.id });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json(), { videoId: 'VID123', found: true, uploadStatus: 'processed', processingStatus: 'succeeded', privacyStatus: 'private', failureReason: null, rejectionReason: null });
      assert.ok(!r.text.includes(TOKEN));
      assert.equal((await c.post('/ui/api/posts/youtube/check', { id: 'zzz' })).status, 404);
    } finally { c.srv.close(); }
  });
});

describe('checkUploadStatus (fake fetch)', () => {
  test('found, not found, 403 and 500', async () => {
    const mkf = (res) => async (url, o) => {
      assert.match(String(url), /youtube\/v3\/videos\?part=status,processingDetails&id=ABC/);
      assert.equal(o.headers.Authorization, 'Bearer t');
      return res;
    };
    const ok = await checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(200, { items: [{ status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } }] })) });
    assert.equal(ok.found, true); assert.equal(ok.rejectionReason, 'duplicate');
    assert.equal((await checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(200, { items: [] })) })).found, false);
    await assert.rejects(checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(403, {})) }), { code: 'status-not-permitted' });
    await assert.rejects(checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(500, {})) }), { code: 'status-check-failed' });
  });
});

describe('UI source rules', () => {
  test('no innerHTML, no external script, upload button present, no typed confirmation (D331)', () => {
    const js = readFileSync(path.join(UI, 'js', 'app.js'), 'utf8') + readFileSync(path.join(UI, 'js', 'api.js'), 'utf8');
    const html = readFileSync(path.join(UI, 'index.html'), 'utf8');
    assert.ok(!/innerHTML/.test(js));
    assert.ok(!/<script[^>]+src="https?:/.test(html));
    assert.match(html, /id="post-yt-upload"/);
    assert.doesNotMatch(html, /id="post-yt-confirm"/);
  });
});
