// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the channel's scheduled posts (what YouTube Studio shows as "Scheduled") for the post-schedule flag (D310, D375).
// Needs the youtube.readonly scope; the caller checks the granted scopes first and fails closed without it.
//   readChannelSchedule({ accessToken, fetchImpl?, nowMs, cfg })
//     -> { last (ms|null), count, times (ms[], sorted: future scheduled), recent (ms[], sorted: went public in the last
//          RECENT_DAYS), scanned, pages, truncated, reachedLookback }
// Calls (YouTube Data API v3, 1 quota unit each): channels.list mine=true -> the uploads playlist; then per page
// (at most cfg.maxPages x cfg.pageSize): playlistItems.list part=snippet,contentDetails -> video ids, when each was added
// (snippet.publishedAt) and when it went public (contentDetails.videoPublishedAt); videos.list part=status -> privacyStatus
// + publishAt. Only these parts are read (no titles or descriptions). Nothing is written; tokens never leave memory.
// Big channels (D375): the uploads list comes newest first, so the scan stops at the first page whose items were ALL
// added more than cfg.lookbackDays ago (no videos.list call for that page). Such a scan is complete (not truncated).
// Only reaching maxPages first is truncated; the caller then gives out no slot (fail closed). Risk: a video uploaded
// before the lookback but scheduled to go public later is not seen (UNVERIFIED that the uploads list is ordered by
// the time a video was added; a page with an unreadable time never ends the scan).
// Any failure throws ScheduleError: 'schedule-scope-missing' (403 insufficient permissions / 401) or 'schedule-read-failed'.
// The caller never guesses a slot when this throws.
import { ScheduleError, futureScheduleTimes, latestFutureSchedule } from './schedule.mjs';

const API = 'https://www.googleapis.com/youtube/v3';

async function getJson(fetchImpl, url, accessToken) {
  let res;
  try { res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }); } catch {
    throw new ScheduleError('schedule-read-failed', 'network error reading the scheduled posts');
  }
  let body = null; try { body = await res.json(); } catch { /* no body */ }
  if (res.ok && body) return body;
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '');
  if (res.status === 401 || (res.status === 403 && /insufficient|scope/i.test(reason))) {
    throw new ScheduleError('schedule-scope-missing', 'sign in again to allow reading scheduled posts');
  }
  throw new ScheduleError('schedule-read-failed', `HTTP ${res.status} reading the scheduled posts`);
}

const DAY_MS = 24 * 3600 * 1000;
/** Public videos that went public this many days back still count as taken times (a new post is never within the gap). */
export const RECENT_DAYS = 2;
const msOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

export async function readChannelSchedule({ accessToken, fetchImpl = fetch, nowMs, cfg }) {
  const ch = await getJson(fetchImpl, `${API}/channels?part=contentDetails&mine=true`, accessToken);
  const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof uploads !== 'string' || !uploads) throw new ScheduleError('schedule-read-failed', 'no uploads list found for this channel');
  const cutoff = nowMs - cfg.lookbackDays * DAY_MS;
  const videos = []; const wentPublic = new Map(); let pageToken = null; let pages = 0; let scanned = 0; let reachedLookback = false;
  do {
    const q = new URLSearchParams({ part: 'snippet,contentDetails', playlistId: uploads, maxResults: String(cfg.pageSize) });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await getJson(fetchImpl, `${API}/playlistItems?${q}`, accessToken);
    pages++;
    const items = Array.isArray(page?.items) ? page.items : [];
    pageToken = typeof page?.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : null;
    const added = items.map((i) => msOf(i?.snippet?.publishedAt));
    if (items.length && added.every((t) => t !== null && t < cutoff)) { reachedLookback = true; pageToken = null; break; }
    const ids = [];
    for (const i of items) {
      const id = i?.contentDetails?.videoId;
      if (typeof id !== 'string' || !id) continue;
      ids.push(id);
      const p = msOf(i?.contentDetails?.videoPublishedAt);
      if (p !== null) wentPublic.set(id, p);
    }
    scanned += ids.length;
    if (ids.length) {
      const v = await getJson(fetchImpl, `${API}/videos?part=status&id=${ids.map(encodeURIComponent).join(',')}`, accessToken);
      if (Array.isArray(v?.items)) videos.push(...v.items);
    }
  } while (pageToken && pages < cfg.maxPages);
  const { last, count } = latestFutureSchedule(videos, nowMs);
  const recent = [];
  for (const v of videos) {
    if (v?.status?.privacyStatus !== 'public') continue;
    const t = wentPublic.get(v.id);
    if (t !== undefined && t <= nowMs && t > nowMs - RECENT_DAYS * DAY_MS) recent.push(t);
  }
  return { last, count, times: futureScheduleTimes(videos, nowMs), recent: recent.sort((x, y) => x - y), scanned, pages, truncated: Boolean(pageToken), reachedLookback };
}
