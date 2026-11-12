// SPDX-License-Identifier: GPL-3.0-or-later
// AN1 Growth data (services/analytics, D371): the read-only YouTube readers, the local store, collect() (scopes fail
// closed, public time, snapshots with their age, the 1 h guard), the checkpoints, the posted-video list, the CLI, and
// the sign-in scopes asked for with the growth flag. No test touches Google: fetch is faked. Placeholder ids only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { DB_NAME, collect, openStore, postedVideos, summary } from '../services/analytics/index.mjs';
import { main } from '../services/analytics/cli.mjs';
import { AnalyticsError, METRICS, readAnalytics, readVideos } from '../services/analytics/youtube.mjs';
import { ANALYTICS_SCOPE, READONLY_SCOPE, SCOPE, authUrl, createYoutubeAuth, joinScopes } from '../services/posting/oauth.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-an1-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const H = 3_600_000;
const T0 = Date.parse('2026-11-12T12:00:00Z');
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Fake Google: videos.list and analytics reports from a table, every call recorded. */
function fakeGoogle(videos, metrics) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) {
      const ids = u.searchParams.get('id').split(',');
      return res(200, { items: ids.filter((id) => videos[id]).map((id) => ({ id, ...videos[id] })) });
    }
    if (u.pathname.endsWith('/reports')) {
      const ids = u.searchParams.get('filters').replace('video==', '').split(',');
      const names = ['video', ...u.searchParams.get('metrics').split(',')];
      return res(200, { columnHeaders: names.map((name) => ({ name })),
        rows: ids.filter((id) => metrics[id]).map((id) => [id, ...names.slice(1).map((n) => metrics[id][n] ?? 0)]) });
    }
    return res(404, {});
  };
  return { fetchImpl, calls };
}
const auth = (scopes = [SCOPE, READONLY_SCOPE, ANALYTICS_SCOPE]) => ({ grantedScopes: async () => scopes, accessToken: async () => 'tok' });
const POSTED = [
  { videoId: 'vidA', postId: 'p1.youtube-shorts', kind: 'short', clipId: 'C01', title: 'a', uploadedAt: '2026-11-10T10:00:00Z' },
  { videoId: 'vidB', postId: 'p2.youtube-shorts', kind: 'montage', clipId: 'M01', title: 'b', uploadedAt: '2026-11-11T10:00:00Z' },
];
const VIDEOS = {
  vidA: { status: { privacyStatus: 'public' }, snippet: { publishedAt: '2026-11-11T12:00:00Z' }, statistics: { viewCount: '120', likeCount: '9', commentCount: '1' } },
  vidB: { status: { privacyStatus: 'private', publishAt: '2026-11-13T12:00:00Z' }, snippet: { publishedAt: '2026-11-11T10:00:00Z' }, statistics: { viewCount: '0' } },
};
const METRIC_ROWS = { vidA: { views: 118, averageViewPercentage: 71.5, likes: 9, shares: 2, subscribersGained: 1, estimatedMinutesWatched: 40 } };

describe('readers', () => {
  test('videos: only status, counts and times are kept; bad ids never sent', async () => {
    const g = fakeGoogle(VIDEOS, {});
    const m = await readVideos({ ids: ['vidA', 'vidB', 'bad id!', 'vidA'], accessToken: 'tok', fetchImpl: g.fetchImpl });
    assert.equal(g.calls.length, 1);
    assert.match(g.calls[0].url, /id=vidA%2CvidB&/);
    assert.equal(g.calls[0].auth, 'Bearer tok');
    assert.deepEqual(m.get('vidA'), { privacy: 'public', publishAt: null, publishedAt: '2026-11-11T12:00:00Z', views: 120, likes: 9, comments: 1 });
  });
  test('analytics: metrics by column name, batches of 50', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `v${i}`);
    const g = fakeGoogle({}, Object.fromEntries(ids.map((id) => [id, { views: 1 }])));
    const m = await readAnalytics({ ids, startDate: '2026-11-01', endDate: '2026-11-12', accessToken: 'tok', fetchImpl: g.fetchImpl });
    assert.equal(g.calls.length, 2);
    assert.equal(m.size, 51);
    assert.deepEqual(Object.keys(m.get('v0')), METRICS);
    assert.match(g.calls[0].url, /ids=channel%3D%3DMINE/);
    await assert.rejects(readAnalytics({ ids, startDate: '2026-11-12', endDate: '2026-11-01', accessToken: 'tok', fetchImpl: g.fetchImpl }), { code: 'analytics-bad-range' });
  });
  test('a missing permission and other errors are told apart', async () => {
    const f403 = async () => res(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } });
    await assert.rejects(readVideos({ ids: ['vidA'], accessToken: 't', fetchImpl: f403 }), { code: 'analytics-scope-missing' });
    await assert.rejects(readVideos({ ids: ['vidA'], accessToken: 't', fetchImpl: async () => res(500, {}) }), { code: 'analytics-read-failed' });
    await assert.rejects(readVideos({ ids: ['vidA'], accessToken: 't', fetchImpl: async () => { throw new Error('net'); } }), AnalyticsError);
  });
});

describe('collect and the store', () => {
  test('fails closed without both read permissions', async () => {
    const d = tmp();
    for (const s of [null, [SCOPE], [SCOPE, READONLY_SCOPE], [SCOPE, ANALYTICS_SCOPE]]) {
      await assert.rejects(collect({ dataDir: d, auth: auth(s), posted: POSTED, fetchImpl: fakeGoogle(VIDEOS, {}).fetchImpl, now: () => T0, force: true }),
        { code: 'analytics-scope-missing' }, JSON.stringify(s));
    }
  });
  test('snapshots with age since public; private videos get counts only; the 1 h guard', async () => {
    const d = tmp();
    const g = fakeGoogle(VIDEOS, METRIC_ROWS);
    const r = await collect({ dataDir: d, auth: auth(), posted: POSTED, fetchImpl: g.fetchImpl, now: () => T0 });
    assert.deepEqual(r, { videos: 2, public: 1, snapshots: 2, analyticsMissing: 0 });
    assert.ok(g.calls.some((c) => /reports\?.*startDate=2026-11-11.*endDate=2026-11-12/.test(c.url)), 'from the first public day to today');
    assert.ok(!g.calls.some((c) => /reports\?.*vidB/.test(c.url)), 'a private video has no analytics read');
    const skip = await collect({ dataDir: d, auth: auth(), posted: POSTED, fetchImpl: g.fetchImpl, now: () => T0 + 30 * 60_000 });
    assert.equal(skip.skipped, 'recent');
    await collect({ dataDir: d, auth: auth(), posted: POSTED, fetchImpl: g.fetchImpl, now: () => T0 + 7 * 24 * H });
    const s = openStore(path.join(d, DB_NAME));
    try {
      const rows = summary(s);
      const a = rows.find((v) => v.videoId === 'vidA');
      assert.equal(a.publicAt, '2026-11-11T12:00:00Z');
      assert.equal(a.at24h.ageHours, 24);
      assert.equal(a.at24h.analytics.averageViewPercentage, 71.5);
      assert.equal(a.at7d.ageHours, 192);
      const b = rows.find((v) => v.videoId === 'vidB');
      assert.equal(b.publicAt, null, 'still private (scheduled for later)');
      assert.equal(b.at24h, null);
      assert.equal(b.latest.analytics, null);
      assert.equal(b.latest.data.privacy, 'private');
    } finally { s.close(); }
  });
  test('a scheduled video counts as public from its publish time', async () => {
    const d = tmp();
    const v = { vidB: { status: { privacyStatus: 'public', publishAt: '2026-11-12T06:00:00Z' }, snippet: { publishedAt: '2026-11-11T10:00:00Z' }, statistics: {} } };
    await collect({ dataDir: d, auth: auth(), posted: [POSTED[1]], fetchImpl: fakeGoogle(v, {}).fetchImpl, now: () => T0 });
    const s = openStore(path.join(d, DB_NAME));
    try {
      assert.equal(s.videos()[0].publicAt, '2026-11-12T06:00:00Z');
      assert.equal(s.snapshots('vidB')[0].ageHours, 6);
    } finally { s.close(); }
  });
  test('a video made private again keeps its public time but gets no analytics read', async () => {
    const d = tmp();
    const pub = { vidB: { status: { privacyStatus: 'public' }, snippet: { publishedAt: '2026-11-12T06:00:00Z' }, statistics: {} } };
    await collect({ dataDir: d, auth: auth(), posted: [POSTED[1]], fetchImpl: fakeGoogle(pub, {}).fetchImpl, now: () => T0 });
    const priv = { vidB: { status: { privacyStatus: 'private' }, snippet: { publishedAt: '2026-11-12T06:00:00Z' }, statistics: {} } };
    const g = fakeGoogle(priv, {});
    const r = await collect({ dataDir: d, auth: auth(), posted: [POSTED[1]], fetchImpl: g.fetchImpl, now: () => T0 + 2 * 3_600_000 });
    assert.equal(r.public, 0);
    assert.ok(!g.calls.some((c) => /youtubeanalytics/.test(String(c.url ?? c))), 'no analytics call');
    const s = openStore(path.join(d, DB_NAME));
    try {
      assert.equal(s.videos()[0].publicAt, '2026-11-12T06:00:00Z');
      assert.equal(s.snapshots('vidB').at(-1).data.privacy, 'private');
    } finally { s.close(); }
  });
  test('nothing posted: no call to Google', async () => {
    const g = fakeGoogle({}, {});
    assert.deepEqual(await collect({ dataDir: tmp(), auth: auth(), posted: [], fetchImpl: g.fetchImpl, now: () => T0 }), { videos: 0, public: 0, snapshots: 0, analyticsMissing: 0 });
    assert.equal(g.calls.length, 0);
  });
  test('postedVideos: only uploaded entries with a video id', () => {
    const d = tmp();
    const sha = (c) => c.repeat(64);
    const entries = {};
    for (const [c, status, videoId] of [['a', 'uploaded', 'vidA'], ['b', 'approved', undefined], ['c', 'uploaded', undefined]]) {
      const dir = path.join(d, 'posting', 'packages', c);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ target: 'youtube-shorts', source: { sha256: sha(c), clipId: `C0${c}`, kind: 'short' }, title: c, description: '', tags: [], hashtags: [], updatedAt: '2026-11-11T00:00:00Z' }));
      entries[`${sha(c)}:youtube-shorts`] = { sha256: sha(c), target: 'youtube-shorts', dir, status, ...(videoId ? { videoId } : {}) };
    }
    writeFileSync(path.join(d, 'posting', 'ledger.json'), JSON.stringify({ version: 1, entries }));
    const p = postedVideos(d);
    assert.deepEqual(p.map((v) => [v.videoId, v.kind, v.clipId]), [['vidA', 'short', 'C0a']]);
  });
});

describe('sign-in scopes and the CLI', () => {
  test('joinScopes keeps each scope once, in order', () => {
    assert.equal(joinScopes(SCOPE, false, `${READONLY_SCOPE} ${SCOPE}`, ANALYTICS_SCOPE), `${SCOPE} ${READONLY_SCOPE} ${ANALYTICS_SCOPE}`);
  });
  test('a scope function is read at sign-in time', async () => {
    let growth = false;
    let opened = null;
    const a = createYoutubeAuth({
      clientIdStore: { get: async () => 'id' }, clientSecretStore: { get: async () => 'secret' }, refreshStore: { get: async () => null, set: async () => {} },
      scope: () => (growth ? joinScopes(SCOPE, ANALYTICS_SCOPE) : SCOPE),
      browserOpen: async (u) => { opened = new URL(u); throw new Error('stop here'); },
    });
    growth = true;
    await assert.rejects(a.signIn());
    assert.equal(opened.searchParams.get('scope'), `${SCOPE} ${ANALYTICS_SCOPE}`);
    assert.match(authUrl({ clientId: 'i', redirectUri: 'http://127.0.0.1:1/', challenge: 'c', state: 's' }), /youtube\.upload/);
  });
  test('CLI: flag off refuses; scope missing gives the sign-in hint; show with nothing stored', async () => {
    const d = tmp();
    const out = []; const err = [];
    assert.equal(await main(['fetch', '--data-dir', d], (s) => out.push(s), (s) => err.push(s)), 3);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'flags.local.json'), JSON.stringify({ flags: { growth: true } }));
    const fake = { createYoutubeAuth: () => auth([SCOPE]), fetchImpl: fakeGoogle({}, {}).fetchImpl };
    assert.equal(await main(['fetch', '--data-dir', d], (s) => out.push(s), (s) => err.push(s), fake), 1);
    assert.match(err.at(-1), /youtube signin/);
    assert.equal(await main(['show', '--data-dir', d], (s) => out.push(s), (s) => err.push(s)), 0);
    assert.match(out.at(-1), /no posted videos stored yet/);
  });
});
