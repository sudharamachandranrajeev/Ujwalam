// SPDX-License-Identifier: GPL-3.0-or-later
// AN1 Growth data (D371, flag growth, plan 2026-11-11-growth-content-instagram-plan.md): the user's own YouTube numbers
// for the videos Ujwalam posted, kept in a local SQLite file <data>/analytics/analytics.db (gitignored app data; this
// module is its only writer). Nothing posts or changes anything; the numbers feed the Growth window and, later, the
// RP5 learning loop.
//
//   openStore(file)                       -> { upsertVideo, addSnapshot, videos, snapshots, lastFetchAt, close }
//   collect({ dataDir, auth, fetchImpl?, now?, force? }) -> { videos, public, snapshots, analyticsMissing, skipped? }
//   summary(store)                        -> [{ videoId, kind, clipId, title, publicAt, latest, at24h, at7d }]
//
// collect(): the videos are the post store's uploaded entries (services/posting). For each it reads the public state
// and counts (Data API) and, for public ones, the lifetime analytics (Analytics API), and stores one snapshot per video
// with its age in hours since it went public. It needs both read scopes (youtube.readonly, yt-analytics.readonly) and
// fails closed without them. A run within minIntervalMin of the last one is skipped unless forced (quota care).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LEDGER_NAME, createPostStore } from '../posting/index.mjs';
import { ANALYTICS_SCOPE, READONLY_SCOPE } from '../posting/oauth.mjs';
import { AnalyticsError, readAnalytics, readVideos } from './youtube.mjs';

export const GROWTH_FLAG = 'growth';
export const DB_NAME = path.join('analytics', 'analytics.db');
export const MIN_INTERVAL_MIN = 60;
export const CHECKPOINTS = Object.freeze({ at24h: 24, at7d: 168 });
const HOUR = 3_600_000;

export function openStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY, platform TEXT NOT NULL, post_id TEXT, kind TEXT, clip_id TEXT, title TEXT,
    uploaded_at TEXT, privacy TEXT, public_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL, fetched_at TEXT NOT NULL, age_hours REAL,
    data TEXT, analytics TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS snapshots_video ON snapshots (video_id, fetched_at)');
  const upsert = db.prepare(`INSERT INTO videos (video_id, platform, post_id, kind, clip_id, title, uploaded_at)
    VALUES (?, 'youtube', ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET post_id = excluded.post_id, kind = excluded.kind, clip_id = excluded.clip_id,
      title = excluded.title, uploaded_at = COALESCE(videos.uploaded_at, excluded.uploaded_at)`);
  const setState = db.prepare('UPDATE videos SET privacy = ?, public_at = COALESCE(public_at, ?) WHERE video_id = ?');
  const insert = db.prepare('INSERT INTO snapshots (video_id, fetched_at, age_hours, data, analytics) VALUES (?, ?, ?, ?, ?)');
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const snap = (r) => ({ fetchedAt: r.fetched_at, ageHours: r.age_hours, data: parse(r.data), analytics: parse(r.analytics) });
  return {
    upsertVideo: (v) => upsert.run(v.videoId, v.postId ?? null, v.kind ?? null, v.clipId ?? null, v.title ?? null, v.uploadedAt ?? null),
    setState: (videoId, privacy, publicAt) => setState.run(privacy ?? null, publicAt ?? null, videoId),
    addSnapshot: (s) => insert.run(s.videoId, s.fetchedAt, s.ageHours ?? null, s.data ? JSON.stringify(s.data) : null,
      s.analytics ? JSON.stringify(s.analytics) : null),
    videos: () => db.prepare('SELECT * FROM videos ORDER BY uploaded_at').all().map((r) => ({
      videoId: r.video_id, postId: r.post_id, kind: r.kind, clipId: r.clip_id, title: r.title, uploadedAt: r.uploaded_at,
      privacy: r.privacy, publicAt: r.public_at,
    })),
    snapshots: (videoId) => db.prepare('SELECT * FROM snapshots WHERE video_id = ? ORDER BY fetched_at').all(videoId).map(snap),
    lastFetchAt: () => db.prepare('SELECT MAX(fetched_at) AS t FROM snapshots').get()?.t ?? null,
    close: () => db.close(),
  };
}

/** The post store's uploaded videos -> [{ videoId, postId, kind, clipId, title, uploadedAt }]. */
export function postedVideos(dataDir) {
  const posts = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), dataDir });
  return posts.list().filter((p) => p.status === 'uploaded' && typeof p.videoId === 'string' && p.videoId)
    .map((p) => ({ videoId: p.videoId, postId: p.id, kind: p.kind, clipId: p.clipId, title: p.title, uploadedAt: p.updatedAt }));
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function collect({ dataDir, auth, fetchImpl = fetch, now = () => Date.now(), force = false, store: given, posted: postedIn }) {
  const store = given ?? openStore(path.join(dataDir, DB_NAME));
  try {
    const last = store.lastFetchAt();
    if (!force && last && now() - Date.parse(last) < MIN_INTERVAL_MIN * 60_000) {
      return { skipped: 'recent', lastFetchAt: last, videos: 0, public: 0, snapshots: 0, analyticsMissing: 0 };
    }
    const scopes = typeof auth.grantedScopes === 'function' ? await auth.grantedScopes() : null;
    if (!Array.isArray(scopes) || !scopes.includes(READONLY_SCOPE) || !scopes.includes(ANALYTICS_SCOPE)) {
      throw new AnalyticsError('analytics-scope-missing', 'sign in again to allow reading statistics');
    }
    const posted = postedIn ?? postedVideos(dataDir);
    for (const v of posted) store.upsertVideo(v);
    const ids = posted.map((v) => v.videoId);
    if (!ids.length) return { videos: 0, public: 0, snapshots: 0, analyticsMissing: 0 };
    const token = await auth.accessToken();
    const state = await readVideos({ ids, accessToken: token, fetchImpl });
    const t = now();
    for (const [id, s] of state) {
      // the time it went public: its scheduled publish time once past, else the Data API's publishedAt (UNVERIFIED: for a
      // private upload made public by hand YouTube may keep the upload time here)
      const pub = s.privacy === 'public'
        ? ((s.publishAt && Date.parse(s.publishAt) <= t && s.publishAt) || s.publishedAt || new Date(t).toISOString()) : null;
      store.setState(id, s.privacy, pub);
    }
    const known = new Map(store.videos().map((v) => [v.videoId, v]));
    // public now (a video made private again keeps its first public time but gets no analytics read)
    const pubIds = ids.filter((id) => state.get(id)?.privacy === 'public' && known.get(id)?.publicAt);
    let an = new Map();
    if (pubIds.length) {
      const start = Math.min(...pubIds.map((id) => Date.parse(known.get(id).publicAt)));
      an = await readAnalytics({ ids: pubIds, startDate: day(start), endDate: day(t), accessToken: token, fetchImpl });
    }
    const at = new Date(t).toISOString();
    let n = 0;
    for (const id of ids) {
      const s = state.get(id);
      if (!s) continue; // deleted or not visible to this account: no snapshot
      const v = known.get(id);
      const age = v?.publicAt ? Math.round(((t - Date.parse(v.publicAt)) / HOUR) * 100) / 100 : null;
      store.addSnapshot({ videoId: id, fetchedAt: at, ageHours: age, data: { privacy: s.privacy, views: s.views, likes: s.likes, comments: s.comments },
        analytics: an.get(id) ?? null });
      n += 1;
    }
    return { videos: ids.length, public: pubIds.length, snapshots: n, analyticsMissing: pubIds.filter((id) => !an.has(id)).length };
  } finally {
    if (!given) store.close();
  }
}

/** Per video: the latest snapshot and the first one at or after each checkpoint age (24 h, 7 d), or null. */
export function summary(store) {
  return store.videos().map((v) => {
    const snaps = store.snapshots(v.videoId);
    const first = (h) => snaps.find((s) => typeof s.ageHours === 'number' && s.ageHours >= h) ?? null;
    return { ...v, latest: snaps.at(-1) ?? null, at24h: first(CHECKPOINTS.at24h), at7d: first(CHECKPOINTS.at7d) };
  });
}

const pick = (s) => (s ? {
  fetchedAt: s.fetchedAt, ageHours: s.ageHours,
  views: s.analytics?.views ?? s.data?.views ?? null, likes: s.analytics?.likes ?? s.data?.likes ?? null,
  avgViewedPct: s.analytics?.averageViewPercentage ?? null, shares: s.analytics?.shares ?? null,
  subs: s.analytics?.subscribersGained ?? null, hasAnalytics: !!s.analytics,
} : null);

/** What the Growth window shows (AN1b): per video the numbers only (no raw snapshots), plus when the last fetch was and
 *  when a non-forced fetch is allowed again. Read only. */
export function view(store, now = Date.now()) {
  const last = store.lastFetchAt();
  const next = last ? Date.parse(last) + MIN_INTERVAL_MIN * 60_000 : null;
  return {
    lastFetchAt: last, minIntervalMin: MIN_INTERVAL_MIN, nextAllowedAt: next && next > now ? new Date(next).toISOString() : null,
    videos: summary(store).map((v) => ({ videoId: v.videoId, kind: v.kind, title: v.title, privacy: v.privacy, publicAt: v.publicAt,
      latest: pick(v.latest), at24h: pick(v.at24h), at7d: pick(v.at7d) })),
  };
}
