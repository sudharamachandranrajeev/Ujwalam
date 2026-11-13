// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled posting (flag post-schedule, D310, D314, D375): slot math (gap filling), settings, the user's own settings
// file, publishAt metadata, the optional readonly scope, the CLI sign-in scope and the read-only preview estimate. No
// network: the channel read itself is tested against the local fake Google in tests/posting-e2e.test.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as cli } from '../services/posting/cli.mjs';
import { READONLY_SCOPE, SCHEDULE_SCOPES, SCOPE, authUrl, createYoutubeAuth } from '../services/posting/oauth.mjs';
import { formatPreview, previewRules } from '../services/posting/preview.mjs';
import {
  DEFAULT_SCHEDULE, HOUR_MS, SCHEDULE_FLAG, checkUserSchedule, createSlotter, earliestFree, floorFrom, latestFutureSchedule, loadScheduleConfig, leadOk,
  nextFreeSlots, planQueueSlots, savedChannelTimes, slotTooClose, userScheduleFile,
} from '../services/posting/schedule.mjs';
import { UploadError, uploadMetadata } from '../services/posting/youtube.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-sched-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const CFG = { intervalHours: 1, placement: 'fill-gaps', alignMinutes: 60, minLeadHours: 1, marginMinutes: 15, chunkDeadlineSeconds: 120, fallbackKbps: 1000, maxPages: 4, pageSize: 50, lookbackDays: 120, maxAheadDays: 60 };
const CFG6 = { ...CFG, intervalHours: 6 };
const T0 = Date.parse('2026-11-09T10:00:00Z');
const iso = (t) => new Date(t).toISOString();
const D = (s) => Date.parse(s);
/** A real-like channel schedule (ASSUMED shape, no real data): every 6 h from 13 Nov 18:00 to 14 Nov 18:00 (5 posts),
 *  then daily at 00:00 UTC from 15 Nov to 6 Dec (22 posts): 27 scheduled posts. "Now" is 13 Nov 10:00 UTC. */
const NOW13 = D('2026-11-13T10:00:00Z');
const CHANNEL27 = [
  ...['2026-11-13T18:00:00Z', '2026-11-14T00:00:00Z', '2026-11-14T06:00:00Z', '2026-11-14T12:00:00Z', '2026-11-14T18:00:00Z'].map(D),
  ...Array.from({ length: 22 }, (_, n) => D('2026-11-15T00:00:00Z') + n * 24 * HOUR_MS),
];
const minGap = (times) => { const s = [...times].sort((a, b) => a - b); let m = Infinity; for (let i = 1; i < s.length; i++) m = Math.min(m, s[i] - s[i - 1]); return m; };

describe('slot math (UTC, pure)', () => {
  test('settings come from data/posting/schedule.json (1 h gap, fill-gaps, whole hours, 2 months ahead, with source and date)', () => {
    const cfg = loadScheduleConfig();
    assert.equal(cfg.intervalHours, 1); assert.equal(cfg.placement, 'fill-gaps'); assert.equal(cfg.alignMinutes, 60);
    assert.equal(cfg.maxAheadDays, 60); assert.ok(cfg.lookbackDays >= cfg.maxAheadDays);
    assert.ok(cfg.minLeadHours > 0 && cfg.marginMinutes > 0 && cfg.maxPages >= 1 && cfg.pageSize <= 50);
    assert.equal(cfg.chunkDeadlineSeconds, 120); assert.ok(cfg.chunkDeadlineSeconds < cfg.marginMinutes * 60 && cfg.fallbackKbps >= 64);
    assert.deepEqual(cfg.userKeys, []);
    const raw = JSON.parse(readFileSync(DEFAULT_SCHEDULE, 'utf8'));
    assert.match(raw.source, /user 2026-11-13/); assert.match(raw.source, /every one hour for the next 2 months/); assert.equal(raw.checked, '2026-11-13');
    assert.equal(raw.minGapMinutes, undefined, 'the D314 gap is retired: every gap is intervalHours');
  });
  test('a bad settings file is refused, never defaulted', () => {
    const d = mk(); const f = path.join(d, 's.json');
    for (const bad of [{ ...CFG, intervalHours: 0 }, { ...CFG, minLeadHours: 'x' }, { ...CFG, pageSize: 51 }, { ...CFG, chunkDeadlineSeconds: 0 }, { ...CFG, fallbackKbps: 10 },
      { ...CFG, marginMinutes: 2, chunkDeadlineSeconds: 120 }, { ...CFG, alignMinutes: 7 }, { ...CFG, placement: 'random' }, { ...CFG, lookbackDays: 0 }, { ...CFG, maxAheadDays: 0 }, {}]) {
      writeFileSync(f, JSON.stringify(bad));
      assert.throws(() => loadScheduleConfig(f), (e) => e.code === 'schedule-config-bad', JSON.stringify(bad).slice(0, 80));
    }
    for (const k of ['lookbackDays', 'alignMinutes', 'maxAheadDays']) { const m = { ...CFG }; delete m[k]; writeFileSync(f, JSON.stringify(m)); assert.throws(() => loadScheduleConfig(f), (e) => e.code === 'schedule-config-bad', `${k} never defaulted`); }
    assert.throws(() => loadScheduleConfig(path.join(d, 'missing.json')), (e) => e.code === 'schedule-config-bad');
  });
  test("the user's own settings file (<data>/posting/schedule.json) replaces gap, days ahead and placement; a bad one is refused", () => {
    const d = mk(); const u = userScheduleFile(d);
    assert.equal(u, path.join(d, 'posting', 'schedule.json'));
    assert.equal(loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: u }).intervalHours, 1, 'no user file: the shipped values');
    mkdirSync(path.dirname(u), { recursive: true });
    writeFileSync(u, JSON.stringify({ intervalHours: 6, maxAheadDays: 730, placement: 'after-last', quotaUnitsPerDay: 20000 }));
    const c = loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: u });
    assert.deepEqual([c.intervalHours, c.maxAheadDays, c.placement, c.userKeys], [6, 730, 'after-last', ['intervalHours', 'maxAheadDays', 'placement']]);
    assert.equal(c.minLeadHours, 1, 'the rest stays shipped');
    for (const bad of ['{ no', JSON.stringify({ intervalHours: 0 }), JSON.stringify({ maxAheadDays: 731 }), JSON.stringify({ placement: 'x' }), JSON.stringify({ intervalHours: 1.5 }), '[]']) {
      writeFileSync(u, bad); assert.throws(() => loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: u }), (e) => e.code === 'schedule-config-bad', bad);
    }
    assert.deepEqual(checkUserSchedule({ intervalHours: 2, quotaUnitsPerDay: 999 }), { values: { intervalHours: 2 }, problems: [{ key: 'quotaUnitsPerDay', text: 'quotaUnitsPerDay must be a whole number from 1000 to 10000000' }] });
  });
  test('empty channel and empty queue: the first whole hour at least now + lead + margin', () => {
    assert.equal(iso(floorFrom(T0, CFG)), '2026-11-09T12:00:00.000Z', '10:00 + 1 h 15 = 11:15 -> 12:00');
    assert.equal(iso(floorFrom(D('2026-11-09T10:45:00Z'), CFG)), '2026-11-09T12:00:00.000Z', 'exactly on the hour stays');
    assert.equal(iso(floorFrom(T0, { ...CFG, alignMinutes: 1 })), '2026-11-09T11:15:00.000Z', 'minute grid');
    assert.deepEqual(nextFreeSlots({ count: 3, nowMs: T0, cfg: CFG }).map(iso), ['2026-11-09T12:00:00.000Z', '2026-11-09T13:00:00.000Z', '2026-11-09T14:00:00.000Z']);
  });
  test('gap filling: the earliest grid time at least the gap away from every taken time', () => {
    const taken = [D('2026-11-09T12:00:00Z'), D('2026-11-09T13:30:00Z'), D('2026-11-09T18:00:00Z')];
    assert.equal(iso(earliestFree(D('2026-11-09T12:00:00Z'), taken, CFG)), '2026-11-09T15:00:00.000Z', '12 taken, 13 and 14 within 1 h of 13:30');
    assert.equal(iso(earliestFree(D('2026-11-09T12:00:00Z'), taken, CFG6)), '2026-11-10T00:00:00.000Z', 'with 6 h: after 18:00 + 6 h');
    assert.equal(iso(earliestFree(D('2026-11-09T05:00:00Z'), taken, CFG6)), '2026-11-09T05:00:00.000Z', 'a gap before the first taken time is used (7 h before 12:00)');
    assert.equal(iso(earliestFree(D('2026-11-09T06:00:00Z'), taken, CFG6)), '2026-11-09T06:00:00.000Z', 'exactly the gap is allowed');
    assert.equal(iso(earliestFree(D('2026-11-09T07:00:00Z'), taken, CFG6)), '2026-11-10T00:00:00.000Z');
    const s = createSlotter(taken, CFG); s.add(D('2026-11-09T15:00:00Z'));
    assert.equal(iso(s.free(D('2026-11-09T12:00:00Z'))), '2026-11-09T16:00:00.000Z');
    assert.equal(s.latest(), D('2026-11-09T18:00:00Z'));
  });
  test('the real-like schedule (27 posts, ASSUMED): the first 10 new posts fill the gaps, never within the gap of a post', () => {
    const one = nextFreeSlots({ channelTimes: CHANNEL27, count: 10, nowMs: NOW13, cfg: CFG });
    assert.deepEqual(one.map((t) => iso(t).slice(5, 16)), ['11-13T12:00', '11-13T13:00', '11-13T14:00', '11-13T15:00', '11-13T16:00', '11-13T17:00', '11-13T19:00', '11-13T20:00', '11-13T21:00', '11-13T22:00']);
    assert.ok(minGap([...CHANNEL27, ...one]) >= HOUR_MS);
    const six = nextFreeSlots({ channelTimes: CHANNEL27, count: 10, nowMs: NOW13, cfg: CFG6 });
    assert.deepEqual(six.map((t) => iso(t).slice(5, 16)), ['11-13T12:00', '11-15T06:00', '11-15T12:00', '11-15T18:00', '11-16T06:00', '11-16T12:00', '11-16T18:00', '11-17T06:00', '11-17T12:00', '11-17T18:00']);
    assert.ok(minGap([...CHANNEL27, ...six]) >= 6 * HOUR_MS);
  });
  test('hourly for 2 months: about 1440 slots, all on the hour, none within 1 h of another or of the channel, none past the cap, fast', () => {
    const items = Array.from({ length: 1500 }, (_, n) => ({ id: `c${n}`, state: 'queued', publishAt: null, session: null }));
    const t = performance.now();
    const plan = planQueueSlots({ items, channelTimes: CHANNEL27, nowMs: NOW13, cfg: CFG });
    const took = performance.now() - t;
    const given = plan.filter((p) => p.at !== null).map((p) => p.at);
    const cap = NOW13 + 60 * 24 * HOUR_MS;
    const grid = Math.floor((cap - floorFrom(NOW13, CFG)) / HOUR_MS) + 1; // every whole hour from the floor to the cap
    assert.equal(given.length, grid - CHANNEL27.length, 'every free whole hour is used once');
    assert.ok(given.every((x) => x % HOUR_MS === 0 && x <= cap && x >= floorFrom(NOW13, CFG)));
    assert.ok(minGap([...CHANNEL27, ...given]) >= HOUR_MS, 'never two posts within the gap');
    assert.deepEqual(given, [...given].sort((a, b) => a - b), 'oldest queued clip gets the earliest time');
    assert.ok(plan.slice(given.length).every((p) => p.at === null), 'the rest wait (beyond 60 days)');
    assert.ok(took < 2000, `planning took ${took.toFixed(0)} ms`);
  });
  test('DST safe: across a clock change (EU 2026-03-29 01:00Z, US 2026-11-01 06:00Z) slots stay exactly the gap apart in UTC', () => {
    for (const start of ['2026-03-28T23:30:00Z', '2026-11-01T03:10:00Z']) {
      const s = nextFreeSlots({ count: 3, nowMs: Date.parse(start), cfg: CFG6 });
      assert.equal(s[1] - s[0], 6 * HOUR_MS); assert.equal(s[2] - s[1], 6 * HOUR_MS);
      for (const t of s) assert.match(iso(t), /:00:00\.000Z$/);
    }
  });
  test('channel videos: only private with a future publishAt count; past, public and bad ones are ignored', () => {
    const r = latestFutureSchedule([
      { status: { privacyStatus: 'private', publishAt: iso(T0 - HOUR_MS) } },
      { status: { privacyStatus: 'private', publishAt: iso(T0 + 4 * HOUR_MS) } },
      { status: { privacyStatus: 'public', publishAt: iso(T0 + 40 * HOUR_MS) } },
      { status: { privacyStatus: 'private' } },
      { status: { privacyStatus: 'private', publishAt: 'soon' } },
      null,
    ], T0);
    assert.deepEqual(r, { last: T0 + 4 * HOUR_MS, count: 1 });
  });
  test('too close: less than minLead ahead (or unreadable); a fresh slot passes the check for the whole margin', () => {
    assert.equal(slotTooClose(iso(T0 + 59 * 60000), T0, CFG), true);
    assert.equal(slotTooClose(iso(T0 + 60 * 60000), T0, CFG), false);
    assert.equal(slotTooClose('x', T0, CFG), true);
    const fresh = iso(floorFrom(T0, { ...CFG, alignMinutes: 1 }));
    assert.equal(slotTooClose(fresh, T0 + 15 * 60000, CFG), false); assert.equal(slotTooClose(fresh, T0 + 16 * 60000, CFG), true);
    assert.equal(leadOk(fresh, T0, 75 * 60000), true); assert.equal(leadOk(null, T0, 0), false);
  });
  const Q = (id, publishAt, extra = {}) => ({ id, state: 'queued', publishAt: publishAt === null ? null : iso(publishAt), session: null, ...extra });
  const planOf = (args) => Object.fromEntries(planQueueSlots({ nowMs: T0, cfg: CFG6, ...args }).map((p) => [p.id, p.at === null ? null : iso(p.at)]));
  test('queued clips with a time keep it; only new clips and D314 retries get one, by the same gap rule', () => {
    const items = [Q('a', T0 + 5 * HOUR_MS), Q('b', null), Q('c', null)];
    assert.deepEqual(planOf({ items }), { b: '2026-11-09T21:00:00.000Z', c: '2026-11-10T03:00:00.000Z' }, 'gap of 6 h around a (15:00): 12:00 is 3 h from it');
    assert.deepEqual(planOf({ items: [Q('a', T0 + 12 * HOUR_MS), Q('b', null)] }), { b: '2026-11-09T12:00:00.000Z' }, 'fill-gaps: b goes BEFORE a (10 h before it, more than the gap)');
    assert.deepEqual(planOf({ items: [Q('a', T0 + 5 * HOUR_MS)] }), {});
  });
  test('D314 retry (less than the lead time from its time): the next free slot; other queued clips keep theirs (no re-chain)', () => {
    const items = [Q('a', T0 + 30 * 60000), Q('b', T0 + 8 * HOUR_MS), Q('d', null)];
    const p = planQueueSlots({ items, nowMs: T0, cfg: CFG6 });
    assert.deepEqual(p.map((x) => [x.id, iso(x.at), x.retry]), [['a', '2026-11-09T12:00:00.000Z', true], ['d', '2026-11-10T00:00:00.000Z', false]],
      'a: 12:00 is exactly 6 h before b (18:00), allowed; d: after b + 6 h; b keeps 18:00');
    assert.ok(minGap([T0 + 8 * HOUR_MS, ...p.map((x) => x.at)]) >= 6 * HOUR_MS);
    assert.equal(planOf({ items: [Q('a', null, { reslot: true })] }).a, '2026-11-09T12:00:00.000Z', 'a dropped too-close time is a retry');
    assert.equal(planOf({ items: [Q('a', null, { reason: 'slot-passed' })] }).a, '2026-11-09T12:00:00.000Z');
    assert.equal(planOf({ items: [Q('a', T0 + 30 * 60000, { nextAt: iso(T0 + 2 * HOUR_MS), reason: 'upload-failed' })] }).a, '2026-11-09T14:00:00.000Z', 'backing off: the floor counts from nextAt');
  });
  test('uploaded, failed and in-session clips keep their times and block the gap around them', () => {
    const items = [
      { id: 'up', state: 'done', publishAt: iso(T0 + 8 * HOUR_MS), sentPublishAt: iso(T0 + 8 * HOUR_MS) },
      Q('a', T0 + 20 * 60000),
      Q('s', T0 + 40 * 60000, { session: 'https://example.invalid/s', sessionPublishAt: iso(T0 + 40 * 60000) }),
      { id: 'f', state: 'failed', publishAt: iso(T0 + 14 * HOUR_MS) },
      Q('n', null),
    ];
    const p = planOf({ items, cfg: CFG });
    assert.deepEqual(Object.keys(p).sort(), ['a', 'n'], 'done, failed and the open session are not touched');
    assert.equal(p.a, '2026-11-09T12:00:00.000Z', 'more than 1 h from the open session (10:40) and the upload (18:00)');
    assert.equal(p.n, '2026-11-09T13:00:00.000Z');
    const six = planOf({ items });
    assert.deepEqual(six, { a: '2026-11-10T06:00:00.000Z', n: '2026-11-10T12:00:00.000Z' }, '6 h from the session, the upload and the failed clip (00:00)');
    assert.ok(minGap([T0 + 8 * HOUR_MS, T0 + 40 * 60000, T0 + 14 * HOUR_MS, ...Object.values(six).map(D)]) >= 6 * HOUR_MS);
  });
  test('a new item and a retry in the same pass never share a time; recent channel posts count too', () => {
    const p = planQueueSlots({ items: [Q('n', null), Q('a', T0 + 30 * 60000)], nowMs: T0, cfg: CFG });
    assert.deepEqual(p.map((x) => [x.id, iso(x.at)]), [['n', '2026-11-09T12:00:00.000Z'], ['a', '2026-11-09T13:00:00.000Z']]);
    const q = { schedule: { channelTimes: [iso(T0 + 2 * HOUR_MS), iso(T0 - 5 * HOUR_MS)], recentTimes: [iso(T0 + 30 * 60000)], channelLast: iso(T0 + 2 * HOUR_MS) } };
    assert.deepEqual(savedChannelTimes(q, T0).map(iso), [iso(T0 + 30 * 60000), iso(T0 + 2 * HOUR_MS)], 'past scheduled ones are dropped, recent public ones kept');
    assert.equal(iso(nextFreeSlots({ channelTimes: savedChannelTimes(q, T0), count: 1, nowMs: T0, cfg: CFG })[0]), '2026-11-09T13:00:00.000Z');
  });
  test('placement after-last keeps the old D310 rule: after the latest taken time + the gap', () => {
    const cfg = { ...CFG6, placement: 'after-last' };
    assert.deepEqual(planOf({ items: [Q('a', T0 + 12 * HOUR_MS), Q('b', null), Q('c', null)], cfg }), { b: '2026-11-10T04:00:00.000Z', c: '2026-11-10T10:00:00.000Z' });
  });
  test('cap: no slot more than maxAheadDays ahead; everything after it waits too', () => {
    const cfg = { ...CFG6, maxAheadDays: 1 };
    assert.deepEqual(planOf({ items: [Q('c', null), Q('d', null), Q('e', null), Q('f', null), Q('g', null)], cfg }),
      { c: '2026-11-09T12:00:00.000Z', d: '2026-11-09T18:00:00.000Z', e: '2026-11-10T00:00:00.000Z', f: '2026-11-10T06:00:00.000Z', g: null });
    assert.equal(planOf({ items: [Q('n', null)], channelTimes: [T0 + 60 * 24 * HOUR_MS - 5 * HOUR_MS], cfg: { ...CFG6, maxAheadDays: 60 } }).n, '2026-11-09T12:00:00.000Z', 'a far post does not push a near slot (fill-gaps)');
  });
  test('schedule.mjs has no network, auth or write code (the preview imports it)', () => {
    const src = readFileSync(path.join(ROOT, 'services', 'posting', 'schedule.mjs'), 'utf8').replace(/^\/\/.*$/gm, '');
    assert.ok(!/youtube\.mjs|oauth\.mjs|node:https?|node:net|fetch\(|writeFile|mkdirSync|renameSync/.test(src));
  });
});

describe('upload metadata', () => {
  const post = { title: 't', description: 'd', hashtags: [], tags: [] };
  test('publishAt goes into status next to privacy private', () => {
    const m = uploadMetadata(post, { publishAt: '2026-11-09T16:00:00.000Z' });
    assert.deepEqual(m.status, { privacyStatus: 'private', selfDeclaredMadeForKids: false, publishAt: '2026-11-09T16:00:00.000Z' });
  });
  test('no slot: unchanged private upload; a bad time is refused', () => {
    assert.equal('publishAt' in uploadMetadata(post).status, false);
    for (const bad of ['2026-11-09 16:00', '2026-11-09T16:00:00+01:00', 12, 'tomorrow']) assert.throws(() => uploadMetadata(post, { publishAt: bad }), (e) => e instanceof UploadError && e.code === 'bad-publish-at');
  });
  test('privacy never comes from post.json', () => {
    assert.equal(uploadMetadata({ ...post, privacyStatus: 'public', status: { privacyStatus: 'public' } }, { publishAt: '2026-11-09T16:00:00Z' }).status.privacyStatus, 'private');
  });
});

describe('optional readonly scope', () => {
  const store = (v) => { let x = v; return { get: async () => x, set: async (y) => { x = y; }, delete: async () => { x = null; return true; } }; };
  test('authUrl carries both scopes when asked', () => {
    const u = new URL(authUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1/', challenge: 'x', state: 's', scope: SCHEDULE_SCOPES }));
    assert.deepEqual(u.searchParams.get('scope').split(' '), [SCOPE, READONLY_SCOPE]);
  });
  test('grantedScopes reads the refresh answer; no scope in the answer = null (callers fail closed)', async () => {
    const mkAuth = (scope) => createYoutubeAuth({ clientIdStore: store('c'), clientSecretStore: store('s'), refreshStore: store('r'), now: () => T0,
      request: async () => ({ access_token: 'a', expires_in: 3600, ...(scope === undefined ? {} : { scope }) }) });
    assert.deepEqual(await mkAuth(`${SCOPE} ${READONLY_SCOPE}`).grantedScopes(), [SCOPE, READONLY_SCOPE]);
    assert.deepEqual(await mkAuth(SCOPE).grantedScopes(), [SCOPE]);
    assert.equal(await mkAuth(undefined).grantedScopes(), null);
  });
  test('not signed in: grantedScopes throws oauth-reauth-needed', async () => {
    const a = createYoutubeAuth({ clientIdStore: store('c'), clientSecretStore: store('s'), refreshStore: store(null), request: async () => { throw new Error('must not call'); } });
    await assert.rejects(a.grantedScopes(), (e) => e.code === 'oauth-reauth-needed');
  });
  test('CLI signin asks for upload + readonly only when post-schedule is on, and says when readonly was not given', async () => {
    const d = mk(); const seen = [];
    const run = async (flags, scope) => {
      writeFileSync(path.join(d, 'flags.local.json'), JSON.stringify({ flags }));
      const lines = [];
      const code = await cli(['youtube', 'signin', '--data-dir', d], (s) => lines.push(s), () => {}, { createYoutubeAuth: (o) => { seen.push(o.scope); return { signIn: async () => ({ scope }) }; } });
      return { code, text: lines.join('\n') };
    };
    let r = await run({ posting: true }, SCOPE);
    assert.equal(r.code, 0); assert.equal(seen.at(-1), SCOPE); assert.doesNotMatch(r.text, /scheduled/);
    r = await run({ posting: true, [SCHEDULE_FLAG]: true }, SCHEDULE_SCOPES);
    assert.equal(seen.at(-1), SCHEDULE_SCOPES); assert.doesNotMatch(r.text, /not allowed/);
    r = await run({ posting: true, [SCHEDULE_FLAG]: true }, SCOPE);
    assert.match(r.text, /reading scheduled posts was not allowed/);
  });
});


describe('preview: planned publish time (estimate, read-only)', () => {
  function fixture() {
    const dataDir = mk(); const clips = mk();
    const files = ['codm_montage_20261109-100000_kills-5_01_v.mp4', 'codm_won-reel_20261109-100000_victory-kills-4_01_v-full-crop.mp4'].map((n, i) => {
      const file = path.join(clips, n); writeFileSync(file, Buffer.from(`${n}-${i}`.repeat(8)));
      return { file, label: 'x', seconds: 40, kind: i ? 'won-reel' : 'montage', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-09T09:00:00.000Z' };
    });
    mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files }));
    return { dataDir, rules: { autoUpload: true, rules: [{ id: 'm', target: 'youtube-shorts', minScore: 0, kinds: ['montage', 'won-reel'], layouts: null, maxPerDay: 5 }] } };
  }
  const queueFile = (f) => path.join(f.dataDir, 'posting', 'upload-queue.json');
  test('flag off: no times, and it says uploads wait; on: the first free whole hours, filling the gaps around the saved channel read', async () => {
    const f = fixture(); const now = () => new Date(T0);
    const off = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [] });
    assert.equal(off.schedule.on, false); assert.ok(off.queued.every((q) => !q.publishAt));
    assert.match(formatPreview(off), /scheduled posting: off; automatic uploads wait/);
    let r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T12:00:00.000Z', '2026-11-09T13:00:00.000Z']);
    mkdirSync(path.join(f.dataDir, 'posting'), { recursive: true });
    writeFileSync(queueFile(f), JSON.stringify({ version: 1, note: null,
      items: { x: { id: 'x', state: 'done', publishAt: '2026-11-09T20:00:00.000Z', sentPublishAt: '2026-11-09T20:00:00.000Z' } },
      schedule: { channelLast: '2026-11-09T22:00:00.000Z', channelTimes: ['2026-11-09T22:00:00.000Z'], readAt: '2026-11-09T09:00:00.000Z' } }));
    // the user's own gap of 6 h (Settings > Posting & growth > Auto-post): 12:00 is 8 h before 20:00, then after 22:00 + 6 h
    writeFileSync(userScheduleFile(f.dataDir), JSON.stringify({ intervalHours: 6 }));
    r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T12:00:00.000Z', '2026-11-10T04:00:00.000Z']);
    assert.equal(r.schedule.channelReadAt, '2026-11-09T09:00:00.000Z');
    const text = formatPreview(r);
    assert.match(text, /scheduled posting: on, at least 6 h apart \(fill-gaps\)/); assert.match(text, /goes public: 2026-11-10T04:00:00.000Z \(estimate\)/);
    assert.match(text, /uploads go up scheduled/); assert.doesNotMatch(text, /privacy private/);
  });
  test('D314: the preview shows a retry taking the next free time, and a clip past the days-ahead limit as waiting', async () => {
    const f = fixture(); const now = () => new Date(T0);
    mkdirSync(path.join(f.dataDir, 'posting'), { recursive: true });
    writeFileSync(queueFile(f), JSON.stringify({ version: 1, note: null,
      items: { a: { id: 'a', state: 'queued', publishAt: iso(T0 + 30 * 60000), session: null }, b: { id: 'b', state: 'queued', publishAt: iso(T0 + 6.5 * HOUR_MS), session: null } },
      schedule: { channelLast: null, readAt: '2026-11-09T09:00:00.000Z' } }));
    let r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T13:00:00.000Z', '2026-11-09T14:00:00.000Z'], 'the retry a takes 12:00, b keeps 16:30');
    assert.equal(r.schedule.retries, 1);
    assert.match(formatPreview(r), /1 queued clip\(s\) came within 1 h of their time and would get the next free time/);
    const cap = path.join(f.dataDir, 'cap.json'); writeFileSync(cap, JSON.stringify({ ...CFG, intervalHours: 6, maxAheadDays: 1 }));
    r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true, scheduleFile: cap });
    // b 16:30 fixed; a (retry) 23:00; the new clips 05:00 and (11:00, past the cap at 10:00) waiting
    assert.deepEqual(r.queued.map((q2) => [q2.publishAt ?? null, q2.publishNote ?? null]), [['2026-11-10T05:00:00.000Z', null], [null, 'beyond-cap']]);
    assert.match(formatPreview(r), /waits: its public time would be more than 1 days ahead/);
  });
  test('the last channel read hit the page cap: no time is estimated, and the preview says why', async () => {
    const f = fixture();
    mkdirSync(path.join(f.dataDir, 'posting'), { recursive: true });
    writeFileSync(queueFile(f), JSON.stringify({ version: 1, note: null, items: {},
      schedule: { channelLast: null, truncated: true, scanned: 200, readAt: '2026-11-09T09:00:00.000Z' } }));
    const r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now: () => new Date(T0), log: [], scheduleOn: true });
    assert.equal(r.schedule.error, 'schedule-read-incomplete'); assert.ok(r.queued.every((q) => !q.publishAt));
    assert.match(formatPreview(r), /raise maxPages/);
  });
  test('approval-only rules (no autoUpload) get no time; a bad settings file says so', async () => {
    const f = fixture();
    const r = await previewRules({ dataDir: f.dataDir, rules: { ...f.rules, autoUpload: false }, profile: PROFILE, now: () => new Date(T0), log: [], scheduleOn: true });
    assert.ok(r.queued.length && r.queued.every((q) => !q.publishAt));
    const bad = path.join(f.dataDir, 'bad.json'); writeFileSync(bad, '{}');
    const b = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now: () => new Date(T0), log: [], scheduleOn: true, scheduleFile: bad });
    assert.equal(b.schedule.error, 'schedule-config-bad'); assert.match(formatPreview(b), /not valid/);
  });
});
