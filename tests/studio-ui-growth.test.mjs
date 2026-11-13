// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI server: Growth API (AN1b, D372, flag `growth`). Seeded analytics.db with placeholder videos, fake Google
// (no network), fake host. Checks the flag gate, auth/CSRF, the trimmed numbers, the refresh (rate limit, force, scope
// failure) and that nothing is fetched when it should not be.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DB_NAME, openStore } from '../services/analytics/index.mjs';
import { ANALYTICS_SCOPE, READONLY_SCOPE, SCOPE } from '../services/posting/oauth.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-gui-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const NOW = Date.parse('2026-11-13T10:30:00Z');
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function boot({ flagOn, signedIn = true, scopes = [SCOPE, READONLY_SCOPE, ANALYTICS_SCOPE], seed = true }) {
  const dataDir = mk();
  if (flagOn) writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { growth: true } }));
  if (seed) {
    const st = openStore(path.join(dataDir, DB_NAME));
    st.upsertVideo({ videoId: 'vidA', postId: 'p1', kind: 'montage', clipId: 'C01', title: 'Sample video A', uploadedAt: '2026-11-10T10:00:00Z' });
    st.setState('vidA', 'public', '2026-11-11T12:00:00Z');
    st.addSnapshot({ videoId: 'vidA', fetchedAt: '2026-11-12T12:30:00.000Z', ageHours: 24.5, data: { views: 100, likes: 8 }, analytics: { views: 98, likes: 8, averageViewPercentage: 61.2, shares: 3, subscribersGained: 2 } });
    st.addSnapshot({ videoId: 'vidA', fetchedAt: '2026-11-13T10:00:00.000Z', ageHours: 46, data: { views: 150, likes: 12 }, analytics: null });
    st.close();
  }
  const auth = { status: async () => ({ signedIn, hasClient: true }), grantedScopes: async () => scopes, accessToken: async () => 'tok' };
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    if (new URL(url).pathname.endsWith('/videos')) return res(200, { items: [] });
    return res(200, { columnHeaders: [], rows: [] });
  };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost({ outputsReady: true }), launchKey: KEY, dataDir, feedbackDir: mk(),
    limits: { statusPollMs: 50 }, now: () => NOW, growth: { auth, fetchImpl } });
  const { port } = await srv.listen();
  const r = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { srv, port, dataDir, cookie, csrf: s.json().csrf, fetches: () => fetches };
}
const post = (b, route, body, withCsrf = true) => raw(b.port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: b.cookie, origin: `http://127.0.0.1:${b.port}`, 'content-type': 'application/json', ...(withCsrf ? { 'x-ujwalam-csrf': b.csrf } : {}) },
});
const get = (b, url, cookie = b.cookie) => raw(b.port, { url, headers: cookie ? { cookie } : {} });

describe('Growth API (AN1b)', () => {
  test('flag off: both routes are 404 growth-off and nothing is fetched', async () => {
    const b = await boot({ flagOn: false, seed: false });
    try {
      const g = await get(b, '/ui/api/growth');
      assert.equal(g.status, 404);
      assert.equal(g.json().error, 'growth-off');
      assert.equal((await post(b, '/ui/api/growth/refresh', { force: true })).status, 404);
      assert.equal(b.fetches(), 0);
    } finally { await b.srv.close(); }
  });

  test('needs the session cookie', async () => {
    const b = await boot({ flagOn: true });
    try { assert.notEqual((await get(b, '/ui/api/growth', null)).status, 200); } finally { await b.srv.close(); }
  });

  test('on: the numbers, trimmed, with the 24 h checkpoint, last fetch and the next allowed time', async () => {
    const b = await boot({ flagOn: true });
    try {
      const r = await get(b, '/ui/api/growth');
      assert.equal(r.status, 200);
      const j = r.json();
      assert.equal(j.signedIn, true);
      assert.equal(j.lastFetchAt, '2026-11-13T10:00:00.000Z');
      assert.equal(j.nextAllowedAt, '2026-11-13T11:00:00.000Z', 'one hour after the last fetch');
      assert.equal(j.videos.length, 1);
      const v = j.videos[0];
      assert.equal(v.title, 'Sample video A');
      assert.equal(v.kind, 'montage');
      assert.equal(v.latest.views, 150);
      assert.equal(v.latest.hasAnalytics, false);
      assert.equal(v.at24h.avgViewedPct, 61.2);
      assert.equal(v.at24h.subs, 2);
      assert.equal(v.at7d, null);
      assert.deepEqual(Object.keys(v).sort(), ['at24h', 'at7d', 'kind', 'latest', 'privacy', 'publicAt', 'title', 'videoId']);
    } finally { await b.srv.close(); }
  });

  test('not signed in is reported, not hidden', async () => {
    const b = await boot({ flagOn: true, signedIn: false, seed: false });
    try {
      const j = (await get(b, '/ui/api/growth')).json();
      assert.equal(j.signedIn, false);
      assert.deepEqual(j.videos, []);
      assert.equal(j.lastFetchAt, null);
    } finally { await b.srv.close(); }
  });

  test('refresh: needs the CSRF header and a valid body', async () => {
    const b = await boot({ flagOn: true });
    try {
      assert.equal((await post(b, '/ui/api/growth/refresh', {}, false)).status, 403);
      assert.equal((await post(b, '/ui/api/growth/refresh', { force: 'yes' })).status, 400);
      assert.equal((await post(b, '/ui/api/growth/refresh', { other: 1 })).status, 400);
      assert.equal(b.fetches(), 0);
    } finally { await b.srv.close(); }
  });

  test('refresh: skipped within the hour (no call to Google), runs when forced', async () => {
    const b = await boot({ flagOn: true });
    try {
      const a = await post(b, '/ui/api/growth/refresh', {});
      assert.equal(a.status, 200);
      assert.equal(a.json().skipped, 'recent');
      assert.equal(b.fetches(), 0);
      const f = await post(b, '/ui/api/growth/refresh', { force: true });
      assert.equal(f.status, 200);
      assert.equal(f.json().ok, true);
      assert.equal(f.json().skipped, undefined);
    } finally { await b.srv.close(); }
  });

  test('refresh: missing statistics permission is 401 analytics-scope-missing, nothing fetched', async () => {
    const b = await boot({ flagOn: true, scopes: [SCOPE] });
    try {
      const r = await post(b, '/ui/api/growth/refresh', { force: true });
      assert.equal(r.status, 401);
      assert.equal(r.json().error, 'analytics-scope-missing');
      assert.equal(b.fetches(), 0);
    } finally { await b.srv.close(); }
  });
});
