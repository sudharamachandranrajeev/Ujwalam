// SPDX-License-Identifier: GPL-3.0-or-later
// AN1 (D371, flag growth): read the user's own YouTube numbers for the videos Ujwalam posted. Read only.
//   readVideos({ ids, accessToken, fetchImpl }) -> Map(videoId -> { privacy, publishAt, publishedAt, views, likes, comments })
//     YouTube Data API v3 videos.list part=status,statistics,snippet (1 quota unit per 50 ids); needs youtube.readonly.
//     Only these fields are kept (no description, tags or thumbnails).
//   readAnalytics({ ids, startDate, endDate, accessToken, fetchImpl }) -> Map(videoId -> metrics)
//     YouTube Analytics API v2 reports, dimensions=video, ids=channel==MINE; needs yt-analytics.readonly. Lifetime totals
//     up to endDate; YouTube fills these with a delay of a day or two, so a fresh video can be missing (UNVERIFIED exact
//     delay).
// Any failure throws AnalyticsError: 'analytics-scope-missing' (401, or 403 for a missing permission) or
// 'analytics-read-failed'. Tokens stay in memory; nothing is written here.

export const DATA_API = 'https://www.googleapis.com/youtube/v3';
export const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2';
export const METRICS = Object.freeze(['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'likes', 'shares', 'comments', 'subscribersGained']);
const BATCH = 50;
const VIDEO_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AnalyticsError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'AnalyticsError'; this.code = code; }
}

async function getJson(fetchImpl, url, accessToken, what) {
  let res;
  try { res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }); } catch {
    throw new AnalyticsError('analytics-read-failed', `network error reading ${what}`);
  }
  let body = null; try { body = await res.json(); } catch { /* no body */ }
  if (res.ok && body) return body;
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '');
  if (res.status === 401 || (res.status === 403 && /insufficient|scope|forbidden|permission/i.test(reason))) {
    throw new AnalyticsError('analytics-scope-missing', 'sign in again to allow reading statistics');
  }
  throw new AnalyticsError('analytics-read-failed', `HTTP ${res.status} reading ${what}`);
}

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((v) => typeof v === 'string' && VIDEO_ID.test(v)))];
const batches = (ids) => { const out = []; for (let i = 0; i < ids.length; i += BATCH) out.push(ids.slice(i, i + BATCH)); return out; };

export async function readVideos({ ids, accessToken, fetchImpl = fetch }) {
  const out = new Map();
  for (const b of batches(cleanIds(ids))) {
    const q = new URLSearchParams({ part: 'status,statistics,snippet', id: b.join(','), maxResults: String(BATCH) });
    const j = await getJson(fetchImpl, `${DATA_API}/videos?${q}`, accessToken, 'the videos');
    for (const it of Array.isArray(j.items) ? j.items : []) {
      if (typeof it?.id !== 'string' || !VIDEO_ID.test(it.id)) continue;
      out.set(it.id, {
        privacy: typeof it.status?.privacyStatus === 'string' ? it.status.privacyStatus : null,
        publishAt: typeof it.status?.publishAt === 'string' ? it.status.publishAt : null,
        publishedAt: typeof it.snippet?.publishedAt === 'string' ? it.snippet.publishedAt : null,
        views: num(it.statistics?.viewCount), likes: num(it.statistics?.likeCount), comments: num(it.statistics?.commentCount),
      });
    }
  }
  return out;
}

export async function readAnalytics({ ids, startDate, endDate, accessToken, fetchImpl = fetch }) {
  if (!DATE.test(String(startDate)) || !DATE.test(String(endDate)) || startDate > endDate) {
    throw new AnalyticsError('analytics-bad-range', 'startDate/endDate must be YYYY-MM-DD with start <= end');
  }
  const out = new Map();
  for (const b of batches(cleanIds(ids))) {
    const q = new URLSearchParams({
      ids: 'channel==MINE', startDate, endDate, metrics: METRICS.join(','), dimensions: 'video',
      filters: `video==${b.join(',')}`, maxResults: String(BATCH),
    });
    const j = await getJson(fetchImpl, `${ANALYTICS_API}/reports?${q}`, accessToken, 'the statistics');
    const cols = (Array.isArray(j.columnHeaders) ? j.columnHeaders : []).map((c) => c?.name);
    const vi = cols.indexOf('video');
    if (vi < 0) continue;
    for (const row of Array.isArray(j.rows) ? j.rows : []) {
      if (!Array.isArray(row) || typeof row[vi] !== 'string' || !b.includes(row[vi])) continue;
      const m = {};
      for (const name of METRICS) { const k = cols.indexOf(name); m[name] = k >= 0 ? num(row[k]) : null; }
      out.set(row[vi], m);
    }
  }
  return out;
}
