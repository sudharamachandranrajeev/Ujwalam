// SPDX-License-Identifier: GPL-3.0-or-later
// D375 auto-post: channel read lookback, clips folder source, oldest first, global daily cap, unscored shorts, the
// card's settings (auto-settings.mjs) and the permanent delete after a processed upload (delete-uploaded.mjs).
// Fakes only: temp dirs and fake fetch functions. No network, no real channel, nothing outside the temp dirs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { MAX_PER_DAY, RULE_KINDS, oldestFirst, planAuto, rankerMinScore, userRulesFile } from '../services/posting/auto-post.mjs';
import { CARD_RULES, checkCard, defaultCard, loadQuota, moveQueueItem, readAutoPostSettings, removeQueueItem, rulesFromCard, saveAutoPostSettings, schedulePreview } from '../services/posting/auto-settings.mjs';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { FOLDER_RUN, scanClipsFolder } from '../services/posting/clips-source.mjs';
import { DELETE_FLAG, checkInFolder, deleteUploadedFile, statusVerdict } from '../services/posting/delete-uploaded.mjs';
import { DEFAULT_SCHEDULE, loadScheduleConfig, userScheduleFile } from '../services/posting/schedule.mjs';
import { readChannelSchedule } from '../services/posting/schedule-read.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d375-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const HOUR = 3600 * 1000; const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-13T10:00:00Z');
const iso = (t) => new Date(t).toISOString();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('channel read: lookback (D375)', () => {
  // 2500 uploads, one every 6 h, newest first; three scheduled ones among the newest. The shipped settings check at most
  // 40 pages of 50 (2000 uploads): without the lookback this channel would hit the cap and nothing would upload.
  function fakeChannel(total) {
    const ups = Array.from({ length: total }, (_, i) => ({ id: `v${i}`, added: T0 - i * 6 * HOUR }));
    const sched = new Map([['v0', T0 + 5 * HOUR], ['v1', T0 + 30 * HOUR], ['v3', T0 + 3 * DAY]]);
    const calls = { channels: 0, playlist: 0, videos: 0 };
    const fetchImpl = async (u) => {
      const url = new URL(u); const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.pathname.endsWith('/channels')) { calls.channels++; return ok({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] }); }
      if (url.pathname.endsWith('/playlistItems')) {
        calls.playlist++;
        const from = Number(url.searchParams.get('pageToken') ?? 0); const size = Number(url.searchParams.get('maxResults'));
        const page = ups.slice(from, from + size);
        return ok({ items: page.map((v) => ({ snippet: { publishedAt: iso(v.added) }, contentDetails: { videoId: v.id } })), ...(from + size < ups.length ? { nextPageToken: String(from + size) } : {}) });
      }
      if (url.pathname.endsWith('/videos')) {
        calls.videos++;
        const ids = url.searchParams.get('id').split(',');
        return ok({ items: ids.map((id) => ({ id, status: sched.has(id) ? { privacyStatus: 'private', publishAt: iso(sched.get(id)), uploadStatus: 'processed' } : { privacyStatus: 'public', uploadStatus: 'processed' } })) });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    return { fetchImpl, calls };
  }

  test('more than 1000 uploads: the read stops at the first page older than the lookback; complete, not truncated', async () => {
    const cfg = loadScheduleConfig(DEFAULT_SCHEDULE);
    assert.equal(cfg.lookbackDays, 120); assert.equal(cfg.maxPages * cfg.pageSize, 2000);
    const f = fakeChannel(2500);
    const r = await readChannelSchedule({ accessToken: 'x', fetchImpl: f.fetchImpl, nowMs: T0, cfg });
    assert.equal(r.truncated, false); assert.equal(r.reachedLookback, true);
    // 120 days at 4 uploads a day = 480 uploads = 10 pages, then the 11th page is all older: 11 pages, never 40
    assert.equal(r.pages, 11); assert.equal(f.calls.playlist, 11); assert.equal(f.calls.videos, 10, 'no status read for the old page');
    assert.ok(r.scanned >= 480 && r.scanned < 1000);
    assert.deepEqual(r.times.map(iso), [T0 + 5 * HOUR, T0 + 30 * HOUR, T0 + 3 * DAY].map(iso));
  });

  test('a page with an item that has no added date is never treated as past the lookback (keeps reading, fail closed)', async () => {
    const cfg = { ...loadScheduleConfig(DEFAULT_SCHEDULE), maxPages: 2 };
    const f = fakeChannel(2500);
    const wrap = async (u) => { const r = await f.fetchImpl(u); if (!String(u).includes('/playlistItems')) return r; const b = await r.json(); b.items[0].snippet = {}; return { ok: true, status: 200, json: async () => b }; };
    const r = await readChannelSchedule({ accessToken: 'x', fetchImpl: wrap, nowMs: T0 + 400 * DAY, cfg });
    assert.equal(r.reachedLookback, false); assert.equal(r.truncated, true);
  });
});

describe('clips folder source (D375)', () => {
  const NAME = (kind, label, n) => `codm_${kind}_20261109-100000_${label}_0${n}_v.mp4`;
  test('scans <folder>/<YYYY-MM-DD>/ only, real files with clip names; known rows keep their data; others get a row', () => {
    const dataDir = mk(); const folder = mk();
    mkdirSync(path.join(folder, '2026-11-09')); mkdirSync(path.join(folder, '2026-11-10')); mkdirSync(path.join(folder, 'misc'));
    const a = path.join(folder, '2026-11-09', NAME('montage', 'kills-5', 1)); writeFileSync(a, 'a');
    const b = path.join(folder, '2026-11-10', NAME('short', 'triple', 2)); writeFileSync(b, 'b');
    writeFileSync(path.join(folder, '2026-11-10', 'holiday.mp4'), 'x'); // not a clip name: counted, not used
    writeFileSync(path.join(folder, 'misc', NAME('short', 'x', 3)), 'c'); // not a day folder
    mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: [{ file: a, kind: 'montage', label: 'known', seconds: 44, run: 'run9', posted: [] }] }));
    const r = scanClipsFolder({ dataDir, folder, probeSeconds: () => 21 });
    assert.equal(r.rows.length, 2); assert.equal(r.unknown, 1);
    assert.deepEqual(r.rows.map((x) => [path.basename(x.file), x.run, x.seconds]), [[path.basename(a), 'run9', 44], [path.basename(b), FOLDER_RUN, 21]]);
    assert.equal(r.rows[1].kind, 'short');
  });
  test('a missing folder gives no rows (never throws)', () => {
    const r = scanClipsFolder({ dataDir: mk(), folder: path.join(mk(), 'nope'), probeSeconds: () => 1 });
    assert.deepEqual(r.rows, []);
  });
});

describe('auto rules: oldest first, one daily cap, unscored shorts (D375)', () => {
  const post = (id, madeAt, extra = {}) => ({ id, target: 'youtube-shorts', kind: 'short', status: 'draft', score: 5, madeAt, limits: { ok: true }, unresolved: [], ...extra });
  const RULE = (o = {}) => ({ id: 'r', target: 'youtube-shorts', minScore: 3, kinds: ['short', 'montage'], layouts: null, maxPerDay: 10, ...o });
  const NOW = new Date('2026-11-13T10:00:00Z');
  test('oldest clip first (madeAt), then the higher score; no date goes last', () => {
    const ps = [post('c', '2026-11-10T00:00:00Z'), post('a', '2026-11-09T00:00:00Z', { score: 4 }), post('n', undefined), post('b', '2026-11-09T00:00:00Z', { score: 9 })];
    assert.deepEqual(oldestFirst(ps).map((p) => p.id), ['b', 'a', 'c', 'n']);
    const plan = planAuto({ posts: ps, rules: [RULE()], autoUpload: true, log: [], now: NOW });
    assert.deepEqual(plan.filter((p) => p.action === 'upload').map((p) => p.id), ['b', 'a', 'c', 'n']);
  });
  test('maxUploadsPerDay caps uploads across every rule, counting today\'s log', () => {
    const ps = [post('a', '2026-11-01T00:00:00Z'), post('b', '2026-11-02T00:00:00Z'), { ...post('c', '2026-11-03T00:00:00Z'), target: 'youtube-video' }];
    const rules = [RULE(), RULE({ id: 'v', target: 'youtube-video' })];
    let plan = planAuto({ posts: ps, rules, autoUpload: true, log: [], now: NOW, maxUploadsPerDay: 2 });
    assert.deepEqual(plan.filter((p) => p.action === 'upload').map((p) => p.id), ['a', 'b']);
    const log = [{ id: 'old', ruleId: 'other', action: 'upload', at: '2026-11-13T01:00:00Z' }];
    plan = planAuto({ posts: ps, rules, autoUpload: true, log, now: NOW, maxUploadsPerDay: 2 });
    assert.deepEqual(plan.filter((p) => p.action === 'upload').map((p) => p.id), ['a']);
  });
  test('a short with no score passes when the rule asks no more than the ranker floor, else it is skipped', () => {
    const ps = [post('u', '2026-11-01T00:00:00Z', { score: null })];
    const floor = rankerMinScore();
    assert.ok(Number.isFinite(floor));
    assert.equal(planAuto({ posts: ps, rules: [RULE({ minScore: floor })], autoUpload: true, log: [], now: NOW, unscoredFloor: floor }).find((p) => p.action === 'approve')?.id, 'u');
    assert.equal(planAuto({ posts: ps, rules: [RULE({ minScore: floor + 1 })], autoUpload: true, log: [], now: NOW, unscoredFloor: floor })[0].reason, 'no-score');
    assert.equal(planAuto({ posts: ps, rules: [RULE({ minScore: 0 })], autoUpload: true, log: [], now: NOW })[0].reason, 'no-score', 'without the floor: skipped');
  });
});

describe('auto-post card settings (auto-settings.mjs)', () => {
  test('defaults: upload on, every kind, the ranker floor, as many a day as the quota fits, 1 h gap, 60 days, fill-gaps', () => {
    const d = defaultCard(mk());
    const q = loadQuota(mk());
    assert.equal(q.uploadsPerDayFit, Math.floor((10000 - 100) / 1650));
    assert.deepEqual(d, { autoUpload: true, kinds: [...RULE_KINDS], minScore: rankerMinScore(), maxPerDay: q.uploadsPerDayFit, intervalHours: 1, maxAheadDays: 60, placement: 'fill-gaps', quotaUnitsPerDay: 10000 });
    assert.ok(RULE_KINDS.includes('impact-play'));
  });
  test('save: checked first, nothing written on a problem; then both files written whole, read back as the card', () => {
    const dataDir = mk();
    const bad = saveAutoPostSettings(dataDir, { card: { autoUpload: 'yes', kinds: ['nope'], minScore: -1, maxPerDay: MAX_PER_DAY + 1, intervalHours: 0, placement: 'x' } });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.problems.map((p) => p.key).sort(), ['autoUpload', 'intervalHours', 'kinds', 'maxPerDay', 'minScore', 'placement']);
    assert.equal(existsSync(userRulesFile(dataDir)), false); assert.equal(existsSync(userScheduleFile(dataDir)), false);
    const card = { autoUpload: true, kinds: ['short', 'montage'], minScore: 4, maxPerDay: 6, intervalHours: 3, maxAheadDays: 30, placement: 'after-last', quotaUnitsPerDay: 20000 };
    const ok = saveAutoPostSettings(dataDir, { card });
    assert.equal(ok.ok, true);
    const rules = JSON.parse(readFileSync(userRulesFile(dataDir), 'utf8'));
    assert.deepEqual(rules.rules.map((r) => r.id), CARD_RULES.map((r) => r.id)); assert.equal(rules.maxUploadsPerDay, 6);
    const sched = JSON.parse(readFileSync(userScheduleFile(dataDir), 'utf8'));
    assert.deepEqual([sched.intervalHours, sched.maxAheadDays, sched.placement, sched.quotaUnitsPerDay], [3, 30, 'after-last', 20000]);
    const s = readAutoPostSettings(dataDir);
    assert.equal(s.custom, false); assert.equal(s.error, null);
    assert.deepEqual(s.card, card);
    assert.equal(s.quota.uploadsPerDayFit, Math.floor((20000 - 100) / 1650)); assert.equal(s.quota.userSet, true);
  });
  test('a hand-written rules file shows as custom; a broken one is reported, the defaults still show', () => {
    const dataDir = mk(); mkdirSync(path.dirname(userRulesFile(dataDir)), { recursive: true });
    writeFileSync(userRulesFile(dataDir), JSON.stringify({ autoUpload: false, rules: [{ id: 'mine', target: 'youtube-shorts', minScore: 7, kinds: ['short'], maxPerDay: 2 }] }));
    let s = readAutoPostSettings(dataDir);
    assert.equal(s.custom, true); assert.equal(s.card.autoUpload, false); assert.equal(s.card.minScore, 7);
    writeFileSync(userRulesFile(dataDir), '{nope');
    s = readAutoPostSettings(dataDir);
    assert.ok(s.error); assert.deepEqual(s.card, s.defaults);
  });
  test('checkCard is pure and names each bad value; rulesFromCard writes the card shape', () => {
    assert.deepEqual(checkCard({ autoUpload: false, kinds: ['short'], minScore: 0, maxPerDay: 1 }).problems, []);
    const doc = rulesFromCard({ autoUpload: false, kinds: ['short'], minScore: 2, maxPerDay: 3 });
    assert.equal(doc.autoUpload, false); assert.ok(doc.rules.every((r) => r.minScore === 2 && r.maxPerDay === 3));
  });
});

describe('next posting times, move and remove (auto-settings.mjs)', () => {
  function queueFixture() {
    const dataDir = mk();
    const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => T0);
    for (const id of ['a', 'b', 'c', 'd']) q.add(id);
    q.patch('a', { state: 'queued', publishAt: '2026-11-13T12:00:00.000Z' });
    q.patch('b', { state: 'queued', publishAt: '2026-11-13T13:00:00.000Z', session: 'https://example.invalid/s' });
    q.patch('c', { state: 'done', videoId: 'v', sentPublishAt: '2026-11-13T15:00:00.000Z' });
    q.patch('d', { state: 'failed', reason: 'upload-failed' });
    const j = JSON.parse(readFileSync(path.join(dataDir, 'posting', QUEUE_NAME), 'utf8'));
    j.schedule = { channelLast: '2026-11-13T14:00:00.000Z', channelTimes: ['2026-11-13T14:00:00.000Z'], readAt: iso(T0) };
    writeFileSync(path.join(dataDir, 'posting', QUEUE_NAME), JSON.stringify(j));
    return { dataDir, q: () => createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => T0) };
  }
  test('preview: channel times, queue times sorted, and the next free whole hours around all of them', () => {
    const f = queueFixture();
    const p = schedulePreview(f.dataDir, { nowMs: T0, count: 3 });
    assert.equal(p.error, null); assert.equal(p.source, 'saved');
    assert.deepEqual(p.channel, ['2026-11-13T14:00:00.000Z']);
    assert.deepEqual(p.queue.map((i) => [i.id, i.publishAt, i.movable]), [['a', '2026-11-13T12:00:00.000Z', true], ['b', '2026-11-13T13:00:00.000Z', false], ['c', '2026-11-13T15:00:00.000Z', false], ['d', null, false]].filter((x) => x[0] !== 'd'));
    assert.deepEqual(p.next, ['2026-11-13T16:00:00.000Z', '2026-11-13T17:00:00.000Z', '2026-11-13T18:00:00.000Z']);
    const live = schedulePreview(f.dataDir, { nowMs: T0, count: 2, channel: { times: [Date.parse('2026-11-13T16:00:00Z')], recent: [], readAt: iso(T0) } });
    assert.equal(live.source, 'live'); assert.deepEqual(live.next, ['2026-11-13T14:00:00.000Z', '2026-11-13T17:00:00.000Z']);
  });
  test('move: only a queued clip with no session, on the grid, not too soon, not too far, the gap from every other post', () => {
    const f = queueFixture();
    const code = (id, at) => moveQueueItem(f.dataDir, id, at, { nowMs: T0 }).code ?? 'ok';
    assert.equal(code('zz', '2026-11-13T20:00:00Z'), 'unknown');
    assert.equal(code('b', '2026-11-13T20:00:00Z'), 'not-movable');
    assert.equal(code('a', 'tomorrow'), 'bad-time');
    assert.equal(code('a', '2026-11-13T20:30:00Z'), 'off-grid');
    assert.equal(code('a', '2026-11-13T11:00:00Z'), 'too-soon');
    assert.equal(code('a', '2027-02-01T10:00:00Z'), 'too-far');
    assert.equal(code('a', '2026-11-13T14:00:00Z'), 'taken', 'the channel post');
    assert.equal(code('a', '2026-11-13T15:00:00Z'), 'taken', 'an uploaded clip');
    assert.equal(code('a', '2026-11-13T20:00:00Z'), 'ok');
    const it = f.q().get('a'); assert.equal(it.publishAt, '2026-11-13T20:00:00.000Z'); assert.equal(it.movedByUser, true);
  });
  test('remove: a waiting or failed clip leaves the queue for good; an uploading or uploaded one cannot', () => {
    const f = queueFixture();
    assert.equal(removeQueueItem(f.dataDir, 'c').code, 'not-removable');
    assert.equal(removeQueueItem(f.dataDir, 'zz').code, 'unknown');
    assert.equal(removeQueueItem(f.dataDir, 'd').ok, true);
    const r = removeQueueItem(f.dataDir, 'a');
    assert.equal(r.ok, true); assert.equal(r.item.state, 'removed'); assert.equal(r.item.publishAt, null);
    assert.ok(!schedulePreview(f.dataDir, { nowMs: T0 }).queue.some((i) => i.id === 'a'));
  });
});

describe('permanent delete after a processed upload (delete-uploaded.mjs)', () => {
  function fixture() {
    const folder = mk(); const day = path.join(folder, '2026-11-09'); mkdirSync(day);
    const buf = Buffer.from('clip bytes '.repeat(20)); const file = path.join(day, 'codm_short_20261109-100000_x_01_v.mp4');
    writeFileSync(file, buf);
    const item = { id: 'p1', videoId: 'VID1', sha: sha(buf), sentPublishAt: '2026-11-14T12:00:00.000Z' };
    const ledgerEntry = { status: 'uploaded', videoId: 'VID1', sha256: sha(buf), publishAt: '2026-11-14T12:00:00.000Z' };
    const logFile = path.join(mk(), 'posting', 'deleted.jsonl');
    const base = { flagOn: true, status: { found: true, uploadStatus: 'processed' }, item, ledgerEntry, file, folder, logFile, nowMs: T0 };
    return { folder, file, buf, base, logFile };
  }
  test('the flag is off by default and its label says it deletes permanently', () => {
    const flags = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'data', 'flags.json'), 'utf8'));
    const list = Array.isArray(flags) ? flags : flags.flags;
    const f = list.find((x) => x.id === DELETE_FLAG);
    assert.equal(f.default, false); assert.match(f.label, /forever/i); assert.match(f.summary, /permanently/i);
  });
  test('deletes only after processed, with every record matching; the log gets one line with the name only', async () => {
    const f = fixture();
    const r = await deleteUploadedFile(f.base);
    assert.equal(r.deleted, true); assert.equal(existsSync(f.file), false);
    const lines = readFileSync(f.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ file: path.basename(f.file), videoId: 'VID1', at: iso(T0) }]);
  });
  test('flag off never deletes', async () => {
    const f = fixture();
    for (const flagOn of [false, undefined, 'true']) assert.equal((await deleteUploadedFile({ ...f.base, flagOn })).reason, 'flag-off');
    assert.ok(existsSync(f.file)); assert.equal(existsSync(f.logFile), false);
  });
  test('never on a failed or rejected upload, while still processing, or when the status read failed', async () => {
    const f = fixture();
    const reason = async (status) => (await deleteUploadedFile({ ...f.base, status })).reason;
    assert.equal(await reason({ found: true, uploadStatus: 'failed' }), 'upload-failed');
    assert.equal(await reason({ found: true, uploadStatus: 'rejected' }), 'upload-rejected');
    assert.equal(await reason({ found: true, uploadStatus: 'uploaded' }), 'still-processing');
    assert.equal(await reason({ found: false }), 'video-not-found');
    assert.equal(await reason(null), 'still-processing');
    assert.equal(statusVerdict({ found: true, uploadStatus: 'processed' }), 'processed');
    assert.ok(existsSync(f.file));
  });
  test('the records must agree: video id, sha256 and the publish time Google got', async () => {
    const f = fixture();
    const reason = async (over) => (await deleteUploadedFile({ ...f.base, ...over })).reason;
    assert.equal(await reason({ ledgerEntry: { ...f.base.ledgerEntry, videoId: 'OTHER' } }), 'not-recorded');
    assert.equal(await reason({ ledgerEntry: { ...f.base.ledgerEntry, status: 'approved' } }), 'not-recorded');
    assert.equal(await reason({ ledgerEntry: null }), 'not-recorded');
    assert.equal(await reason({ ledgerEntry: { ...f.base.ledgerEntry, publishAt: undefined } }), 'no-publish-time');
    assert.equal(await reason({ item: { ...f.base.item, sentPublishAt: null } }), 'no-publish-time');
    assert.ok(existsSync(f.file));
  });
  test('sha256 or path mismatch refuses: a changed file, another file, a path outside the folder, a folder', async () => {
    const f = fixture();
    const reason = async (over) => (await deleteUploadedFile({ ...f.base, ...over })).reason;
    writeFileSync(f.file, Buffer.concat([f.buf, Buffer.from('x')]));
    assert.equal(await reason({}), 'sha-mismatch');
    writeFileSync(f.file, f.buf);
    const outside = path.join(mk(), path.basename(f.file)); writeFileSync(outside, f.buf);
    assert.equal(await reason({ file: outside }), 'not-in-folder'); assert.ok(existsSync(outside));
    assert.equal(await reason({ file: path.join(f.folder, '2026-11-09', '..', '..', path.basename(path.dirname(outside)), path.basename(outside)) }), 'not-in-folder');
    assert.equal(await reason({ file: 'relative.mp4' }), 'no-source-file');
    assert.equal(await reason({ file: path.join(f.folder, '2026-11-09') }), 'not-a-file');
    assert.equal(await reason({ file: path.join(f.folder, '2026-11-09', 'gone.mp4') }), 'file-gone');
    assert.ok(existsSync(f.file)); assert.ok(existsSync(path.join(f.folder, '2026-11-09')));
  });
  test('a junction or link inside the folder that leads out is refused (the file outside is kept)', async (t) => {
    const f = fixture();
    const elsewhere = mk(); const victim = path.join(elsewhere, path.basename(f.file)); writeFileSync(victim, f.buf);
    const j = path.join(f.folder, 'linked');
    try { symlinkSync(elsewhere, j, 'junction'); } catch { t.skip('cannot create a junction here'); return; }
    const r = await deleteUploadedFile({ ...f.base, file: path.join(j, path.basename(f.file)) });
    assert.equal(r.deleted, false); assert.ok(['outside-folder', 'link'].includes(r.reason), r.reason);
    assert.ok(existsSync(victim));
    assert.equal(checkInFolder(path.join(j, path.basename(f.file)), f.folder) !== null, true);
  });
});
