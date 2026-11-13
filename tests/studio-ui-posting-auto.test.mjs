// SPDX-License-Identifier: GPL-3.0-or-later
// D375 control page routes for Settings > Posting & growth > Auto-post: read and save the card (session + CSRF, checked,
// atomic), the next posting times (saved or a fresh read-only channel read), move and remove a queued clip.
// Fakes only: temp dirs, fake host, fake token provider and fake fetch. No network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { userRulesFile } from '../services/posting/auto-post.mjs';
import { createQuotaBudget } from '../services/posting/quota-budget.mjs';
import { READONLY_SCOPE, SCOPE } from '../services/posting/oauth.mjs';
import { userScheduleFile } from '../services/posting/schedule.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const T0 = Date.parse('2026-11-13T10:00:00Z');
const tmpDirs = []; const servers = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d375ui-')); tmpDirs.push(d); return d; };
after(async () => { for (const s of servers) await s.close?.(); for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

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

async function boot({ flags = { posting: true }, auth, fetchImpl } = {}) {
  const dataDir = mk();
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
  const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => T0);
  for (const id of ['a', 'b']) q.add(id);
  q.patch('a', { state: 'queued', publishAt: '2026-11-13T12:00:00.000Z' });
  q.patch('b', { state: 'done', videoId: 'V', sentPublishAt: '2026-11-13T13:00:00.000Z' });
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), now: () => T0,
    youtube: { auth: auth ?? { status: async () => ({ signedIn: false, hasClient: false }) }, fetchImpl, outputsStatus: async () => ({ sinks: [] }) } });
  servers.push(srv);
  const { port } = await srv.listen();
  const lr = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = lr.headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const origin = `http://127.0.0.1:${port}`;
  const post = (route, body, { noCsrf = false, badOrigin = false } = {}) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body),
    headers: { cookie, origin: badOrigin ? 'http://evil.invalid' : origin, 'content-type': 'application/json', ...(noCsrf ? {} : { 'x-ujwalam-csrf': csrf }) } });
  const get = (url, withCookie = true) => raw(port, { url, headers: withCookie ? { cookie } : {} });
  return { dataDir, port, post, get };
}

const GOOD = { autoUpload: true, kinds: ['short', 'montage', 'won-reel', 'impact-play'], minScore: 3, maxPerDay: 6, intervalHours: 2, maxAheadDays: 30, placement: 'fill-gaps', quotaUnitsPerDay: 10000 };

describe('auto-post settings routes (D375)', () => {
  test('read needs the session; it returns the card, defaults, quota fit, limits and the three flags', async () => {
    const t = await boot();
    assert.notEqual((await t.get('/ui/api/posts/auto/settings', false)).status, 200);
    const r = await t.get('/ui/api/posts/auto/settings');
    assert.equal(r.status, 200);
    const j = r.json();
    assert.equal(j.exists, false); assert.equal(j.card.intervalHours, 1); assert.equal(j.card.maxAheadDays, 60);
    assert.equal(j.quota.uploadsPerDayFit, 6); assert.equal(j.limits.maxPerDay, 100);
    assert.deepEqual(j.flags, { autoPost: false, schedule: false, deleteUploaded: false });
  });

  test('posting flag off: the routes are not there', async () => {
    const t = await boot({ flags: {} });
    assert.equal((await t.get('/ui/api/posts/auto/settings')).status, 404);
  });

  test('save needs CSRF and the same origin; bad values are refused with the reasons and nothing is written', async () => {
    const t = await boot();
    assert.equal((await t.post('/ui/api/posts/auto/settings', { card: GOOD }, { noCsrf: true })).status, 403);
    assert.equal((await t.post('/ui/api/posts/auto/settings', { card: GOOD }, { badOrigin: true })).status, 403);
    assert.equal((await t.post('/ui/api/posts/auto/settings', { card: GOOD, extra: 1 })).status, 400);
    assert.equal((await t.post('/ui/api/posts/auto/settings', {})).status, 400);
    const bad = await t.post('/ui/api/posts/auto/settings', { card: { ...GOOD, intervalHours: 0, kinds: [] } });
    assert.equal(bad.status, 400); assert.equal(bad.json().error, 'invalid');
    assert.deepEqual(bad.json().problems.map((p) => p.key).sort(), ['intervalHours', 'kinds']);
    assert.equal(existsSync(userRulesFile(t.dataDir)), false); assert.equal(existsSync(userScheduleFile(t.dataDir)), false);
  });

  test('save writes both files whole (no temp file left) and the next read and schedule use them', async () => {
    const t = await boot();
    const r = await t.post('/ui/api/posts/auto/settings', { card: GOOD });
    assert.equal(r.status, 200); assert.equal(r.json().card.intervalHours, 2);
    assert.equal(JSON.parse(readFileSync(userScheduleFile(t.dataDir), 'utf8')).intervalHours, 2);
    assert.equal(JSON.parse(readFileSync(userRulesFile(t.dataDir), 'utf8')).maxUploadsPerDay, 6);
    assert.deepEqual(readdirSync(path.dirname(userRulesFile(t.dataDir))).filter((n) => n.endsWith('.tmp')), []);
    const s = (await t.get('/ui/api/posts/auto/schedule?count=3')).json();
    assert.equal(s.intervalHours, 2);
    // The gap grew to 2 h: queued 'a' at 12:00 is now within 2 h of the uploaded 13:00, so it is re-slotted to 15:00
    // (Codex review: a queued slot is re-checked); new clips come after it.
    assert.deepEqual(s.next, ['2026-11-13T17:00:00.000Z', '2026-11-13T19:00:00.000Z', '2026-11-13T21:00:00.000Z']);
  });

  test('next posting times: saved by default; fresh=1 reads the channel (read-only scope) at most every 10 minutes', async () => {
    let reads = 0;
    const fetchImpl = async (u) => {
      const url = new URL(u); const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.pathname.endsWith('/channels')) { reads++; return ok({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] }); }
      if (url.pathname.endsWith('/playlistItems')) return ok({ items: [{ snippet: { publishedAt: '2026-11-12T00:00:00Z' }, contentDetails: { videoId: 'c1' } }] });
      if (url.pathname.endsWith('/videos')) return ok({ items: [{ id: 'c1', status: { privacyStatus: 'private', publishAt: '2026-11-13T14:00:00Z' } }] });
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const auth = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'x', grantedScopes: async () => [SCOPE, READONLY_SCOPE] };
    const t = await boot({ auth, fetchImpl });
    const saved = (await t.get('/ui/api/posts/auto/schedule?count=2')).json();
    assert.equal(saved.source, 'none'); assert.equal(reads, 0);
    const live = (await t.get('/ui/api/posts/auto/schedule?count=2&fresh=1')).json();
    assert.equal(live.source, 'live'); assert.equal(live.liveError, null);
    assert.deepEqual(live.channel, ['2026-11-13T14:00:00.000Z']);
    assert.deepEqual(live.next, ['2026-11-13T15:00:00.000Z', '2026-11-13T16:00:00.000Z']);
    await t.get('/ui/api/posts/auto/schedule?fresh=1');
    assert.equal(reads, 1, 'throttled');
  });

  test('fresh reads that arrive together share one channel read (Codex review); its calls count in the daily quota', async () => {
    let reads = 0; let open; const gate = new Promise((r) => { open = r; });
    const fetchImpl = async (u) => {
      const url = new URL(u); const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.pathname.endsWith('/channels')) { reads++; await gate; return ok({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] }); }
      if (url.pathname.endsWith('/playlistItems')) return ok({ items: [{ snippet: { publishedAt: '2026-11-12T00:00:00Z' }, contentDetails: { videoId: 'c1' } }] });
      if (url.pathname.endsWith('/videos')) return ok({ items: [{ id: 'c1', status: { privacyStatus: 'private', publishAt: '2026-11-13T14:00:00Z' } }] });
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const auth = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'x', grantedScopes: async () => [SCOPE, READONLY_SCOPE] };
    const t = await boot({ auth, fetchImpl });
    const all = Promise.all([1, 2, 3].map(() => t.get('/ui/api/posts/auto/schedule?count=1&fresh=1')));
    await new Promise((r) => setTimeout(r, 100));
    open();
    const js = (await all).map((r) => r.json());
    assert.equal(reads, 1, 'one read for three requests');
    assert.ok(js.every((j) => j.source === 'live' && j.channel[0] === '2026-11-13T14:00:00.000Z'));
    const day = createQuotaBudget({ dataDir: t.dataDir, nowMs: () => T0 }).state();
    assert.equal(day.units.n, 3, 'channels + playlistItems + videos'); assert.equal(day.uploads.n, 0);
  });

  test('fresh read without the readonly scope: a plain error, the saved times still show', async () => {
    const auth = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'x', grantedScopes: async () => [SCOPE] };
    const t = await boot({ auth, fetchImpl: async () => { throw new Error('must not be called'); } });
    const j = (await t.get('/ui/api/posts/auto/schedule?fresh=1')).json();
    assert.equal(j.liveError, 'schedule-scope-missing'); assert.ok(Array.isArray(j.next));
  });

  test('move and remove: CSRF, exact params, 404 for an unknown clip, 409 with the reason, 200 with the new time', async () => {
    const t = await boot();
    assert.equal((await t.post('/ui/api/posts/auto/queue/move', { id: 'a', at: '2026-11-13T20:00:00Z' }, { noCsrf: true })).status, 403);
    assert.equal((await t.post('/ui/api/posts/auto/queue/move', { id: 'a' })).status, 400);
    assert.equal((await t.post('/ui/api/posts/auto/queue/move', { id: 'a', at: '2026-11-13T20:00:00Z', x: 1 })).status, 400);
    assert.equal((await t.post('/ui/api/posts/auto/queue/move', { id: 'zz', at: '2026-11-13T20:00:00Z' })).status, 404);
    const taken = await t.post('/ui/api/posts/auto/queue/move', { id: 'a', at: '2026-11-13T13:00:00Z' });
    assert.equal(taken.status, 409); assert.equal(taken.json().error, 'taken');
    const ok = await t.post('/ui/api/posts/auto/queue/move', { id: 'a', at: '2026-11-13T20:00:00Z' });
    assert.equal(ok.status, 200); assert.equal(ok.json().publishAt, '2026-11-13T20:00:00.000Z');
    assert.equal((await t.post('/ui/api/posts/auto/queue/remove', { id: 'b' })).status, 409);
    const rm = await t.post('/ui/api/posts/auto/queue/remove', { id: 'a' });
    assert.equal(rm.status, 200); assert.equal(rm.json().state, 'removed');
  });
});
