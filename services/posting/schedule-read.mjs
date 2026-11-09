// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the channel's scheduled posts (what YouTube Studio shows as "Scheduled") for the post-schedule flag (D310 proposed).
// Needs the youtube.readonly scope; the caller checks the granted scopes first and fails closed without it.
//   readChannelSchedule({ accessToken, fetchImpl?, nowMs, cfg }) -> { last (ms|null), count, scanned, pages, truncated }
// Calls (YouTube Data API v3, 1 quota unit each): channels.list mine=true -> the uploads playlist; then per page
// (cap cfg.maxPages x cfg.pageSize): playlistItems.list -> video ids, videos.list part=status -> privacyStatus + publishAt.
// Only part=status is read (no titles or descriptions). Nothing is written; tokens never leave memory.
// Any failure throws ScheduleError: 'schedule-scope-missing' (403 insufficient permissions / 401) or 'schedule-read-failed'.
// The caller never guesses a slot when this throws.
import { ScheduleError, latestFutureSchedule } from './schedule.mjs';

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

export async function readChannelSchedule({ accessToken, fetchImpl = fetch, nowMs, cfg }) {
  const ch = await getJson(fetchImpl, `${API}/channels?part=contentDetails&mine=true`, accessToken);
  const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof uploads !== 'string' || !uploads) throw new ScheduleError('schedule-read-failed', 'no uploads list found for this channel');
  const videos = []; let pageToken = null; let pages = 0; let scanned = 0;
  do {
    const q = new URLSearchParams({ part: 'contentDetails', playlistId: uploads, maxResults: String(cfg.pageSize) });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await getJson(fetchImpl, `${API}/playlistItems?${q}`, accessToken);
    pages++;
    const ids = (Array.isArray(page?.items) ? page.items : []).map((i) => i?.contentDetails?.videoId).filter((v) => typeof v === 'string' && v);
    scanned += ids.length;
    if (ids.length) {
      const v = await getJson(fetchImpl, `${API}/videos?part=status&id=${ids.map(encodeURIComponent).join(',')}`, accessToken);
      if (Array.isArray(v?.items)) videos.push(...v.items);
    }
    pageToken = typeof page?.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : null;
  } while (pageToken && pages < cfg.maxPages);
  const { last, count } = latestFutureSchedule(videos, nowMs);
  return { last, count, scanned, pages, truncated: Boolean(pageToken) };
}
