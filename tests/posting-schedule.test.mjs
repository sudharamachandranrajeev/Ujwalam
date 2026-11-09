// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled posting (flag post-schedule, D310 proposed): slot math, settings, publishAt metadata, the optional readonly
// scope, the CLI sign-in scope and the read-only preview estimate. No network: the channel read itself is tested against
// the local fake Google in tests/posting-e2e.test.mjs.
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
  DEFAULT_SCHEDULE, HOUR_MS, SCHEDULE_FLAG, latestFutureSchedule, loadScheduleConfig, leadOk, nextSlot, ownLastSlot, planQueueSlots, planSlots, slotTooClose,
} from '../services/posting/schedule.mjs';
import { UploadError, uploadMetadata } from '../services/posting/youtube.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-sched-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const CFG = { intervalHours: 6, minLeadHours: 1, marginMinutes: 15, chunkDeadlineSeconds: 120, fallbackKbps: 1000, maxPages: 4, pageSize: 50, maxAheadDays: 730, minGapMinutes: 60 };
const T0 = Date.parse('2026-11-09T10:00:00Z');
const iso = (t) => new Date(t).toISOString();

describe('slot math (UTC, pure)', () => {
  test('settings come from data/posting/schedule.json (6 h, with source and date)', () => {
    const cfg = loadScheduleConfig();
    assert.equal(cfg.intervalHours, 6);
    assert.ok(cfg.minLeadHours > 0 && cfg.marginMinutes > 0 && cfg.maxPages >= 1 && cfg.pageSize <= 50);
    assert.equal(cfg.chunkDeadlineSeconds, 120); assert.ok(cfg.chunkDeadlineSeconds < cfg.marginMinutes * 60 && cfg.fallbackKbps >= 64);
    const raw = JSON.parse(readFileSync(DEFAULT_SCHEDULE, 'utf8'));
    assert.match(raw.source, /user request 2026-11-09/); assert.equal(raw.checked, '2026-11-09');
  });
  test('a bad settings file is refused, never defaulted', () => {
    const d = mk(); const f = path.join(d, 's.json');
    for (const bad of [{ ...CFG, intervalHours: 0 }, { ...CFG, minLeadHours: 'x' }, { ...CFG, pageSize: 51 }, { ...CFG, chunkDeadlineSeconds: 0 }, { ...CFG, fallbackKbps: 10 },
      { ...CFG, marginMinutes: 2, chunkDeadlineSeconds: 120 }, {}]) {
      writeFileSync(f, JSON.stringify(bad));
      assert.throws(() => loadScheduleConfig(f), (e) => e.code === 'schedule-config-bad');
    }
    assert.throws(() => loadScheduleConfig(path.join(d, 'missing.json')), (e) => e.code === 'schedule-config-bad');
  });
  test('empty channel and empty queue: now + minLead + margin', () => {
    assert.equal(iso(nextSlot({ nowMs: T0, cfg: CFG })), '2026-11-09T11:15:00.000Z');
  });
  test('rounded up to the whole minute', () => {
    assert.equal(iso(nextSlot({ nowMs: T0 + 1500, cfg: CFG })), '2026-11-09T11:16:00.000Z');
  });
  test('future channel schedule: 6 h after the latest one', () => {
    assert.equal(iso(nextSlot({ channelLast: T0 + 10 * HOUR_MS, nowMs: T0, cfg: CFG })), '2026-11-10T02:00:00.000Z');
  });
  test('own queue later than the channel wins; the later anchor always wins', () => {
    assert.equal(iso(nextSlot({ channelLast: T0 + 2 * HOUR_MS, ownLast: T0 + 9 * HOUR_MS, nowMs: T0, cfg: CFG })), '2026-11-10T01:00:00.000Z');
  });
  test('an anchor so close that +6 h is still sooner than the lead time uses the lead time', () => {
    // own slot went public 5.5 h ago: +6 h = now + 30 min < now + 1 h 15 min
    assert.equal(iso(nextSlot({ ownLast: T0 - 5.5 * HOUR_MS, nowMs: T0, cfg: CFG })), '2026-11-09T11:15:00.000Z');
  });
  test('planSlots: in order, 6 h apart, never the same slot twice', () => {
    const s = planSlots({ count: 4, channelLast: T0 + 3 * HOUR_MS, nowMs: T0, cfg: CFG });
    assert.deepEqual(s.map(iso), ['2026-11-09T19:00:00.000Z', '2026-11-10T01:00:00.000Z', '2026-11-10T07:00:00.000Z', '2026-11-10T13:00:00.000Z']);
  });
  test('DST safe: across a clock change (EU 2026-03-29 01:00Z, US 2026-11-01 06:00Z) slots stay exactly 6 h apart in UTC', () => {
    for (const start of ['2026-03-28T23:30:00Z', '2026-11-01T03:10:00Z']) {
      const s = planSlots({ count: 3, nowMs: Date.parse(start), cfg: CFG });
      assert.equal(s[1] - s[0], 6 * HOUR_MS); assert.equal(s[2] - s[1], 6 * HOUR_MS);
      for (const t of s) assert.match(iso(t), /Z$/);
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
  test('own last slot: any state counts (a failed item keeps its slot), ids can be left out', () => {
    const items = [{ id: 'a', state: 'done', publishAt: iso(T0 + HOUR_MS) }, { id: 'b', state: 'failed', publishAt: iso(T0 + 7 * HOUR_MS) }, { id: 'c', state: 'queued', publishAt: null }];
    assert.equal(ownLastSlot(items), T0 + 7 * HOUR_MS);
    assert.equal(ownLastSlot(items, new Set(['b'])), T0 + HOUR_MS);
    assert.equal(ownLastSlot([]), null);
  });
  test('too close: less than minLead ahead (or unreadable); a fresh slot passes the check for the whole margin', () => {
    assert.equal(slotTooClose(iso(T0 + 59 * 60000), T0, CFG), true);
    assert.equal(slotTooClose(iso(T0 + 60 * 60000), T0, CFG), false);
    assert.equal(slotTooClose('x', T0, CFG), true);
    const fresh = iso(nextSlot({ nowMs: T0, cfg: CFG }));
    assert.equal(slotTooClose(fresh, T0 + 15 * 60000, CFG), false); assert.equal(slotTooClose(fresh, T0 + 16 * 60000, CFG), true);
    assert.equal(leadOk(fresh, T0, 75 * 60000), true); assert.equal(leadOk(null, T0, 0), false);
  });
  // D314 (user 2026-11-09): retry close to its time, re-chain, 2-year cap.
  const Q = (id, publishAt, extra = {}) => ({ id, state: 'queued', publishAt: publishAt === null ? null : iso(publishAt), session: null, ...extra });
  const planOf = (args) => Object.fromEntries(planQueueSlots({ nowMs: T0, cfg: CFG, ...args }).map((p) => [p.id, p.at === null ? null : iso(p.at)]));
  test('D314: a retry less than 1 h from its time gets now + 1 h 15 (lead + margin); later queued clips re-chain 6 h apart', () => {
    const items = [Q('a', T0 + 30 * 60000), Q('b', T0 + 6.5 * HOUR_MS), Q('c', T0 + 12.5 * HOUR_MS), Q('d', null)];
    assert.deepEqual(planOf({ items }), { a: '2026-11-09T11:15:00.000Z', b: '2026-11-09T17:15:00.000Z', c: '2026-11-09T23:15:00.000Z', d: '2026-11-10T05:15:00.000Z' });
    const p = planQueueSlots({ items, nowMs: T0, cfg: CFG });
    assert.deepEqual(p.map((x) => [x.id, x.retry, x.rechain]), [['a', true, true], ['b', false, true], ['c', false, true], ['d', false, true]]);
    // rounded up to the minute; a dropped too-close time (reslot, or the old 'slot-passed' reason) is a retry too
    assert.equal(planOf({ items: [Q('a', null, { reslot: true })], nowMs: T0 + 1500 }).a, '2026-11-09T11:16:00.000Z');
    assert.equal(planOf({ items: [Q('a', null, { reason: 'slot-passed' })] }).a, '2026-11-09T11:15:00.000Z');
    // backing off after an error: the floor counts from when it may next try
    assert.equal(planOf({ items: [Q('a', T0 + 30 * 60000, { nextAt: iso(T0 + 2 * HOUR_MS), reason: 'upload-failed' })] }).a, '2026-11-09T13:15:00.000Z');
  });
  test('D314: uploaded, failed and in-session clips keep their times; the re-chain never goes before the latest fixed time + 6 h', () => {
    const items = [
      { id: 'up', state: 'done', publishAt: iso(T0 + 8 * HOUR_MS), sentPublishAt: iso(T0 + 8 * HOUR_MS) },
      Q('a', T0 + 20 * 60000),
      Q('s', T0 + 40 * 60000, { session: 'https://example.invalid/s', sessionPublishAt: iso(T0 + 40 * 60000) }),
      Q('b', T0 + 14 * HOUR_MS),
      { id: 'f', state: 'failed', publishAt: iso(T0 + 3 * HOUR_MS) },
    ];
    const p = planOf({ items, channelLast: T0 + 8 * HOUR_MS });
    assert.deepEqual(Object.keys(p).sort(), ['a', 'b'], 'done, failed and the open session are not touched');
    assert.equal(p.a, '2026-11-09T11:40:00.000Z', 'the floor 11:15 is 35 min from the open session (10:40): moved to 10:40 + 1 h gap');
    assert.equal(p.b, '2026-11-10T00:00:00.000Z', 'b: 6 h after the uploaded clip (T0 + 8 h), not 6 h after the retry');
    // a later channel post pushes the re-chain further out, never earlier
    assert.equal(planOf({ items, channelLast: T0 + 20 * HOUR_MS }).b, '2026-11-10T12:00:00.000Z');
    // queued clips before the first retry in queue order keep their times and count as fixed
    const q2 = [Q('early', T0 + 3 * HOUR_MS), Q('a', T0 + 10 * 60000), Q('b', T0 + 9 * HOUR_MS)];
    assert.deepEqual(planOf({ items: q2 }), { a: '2026-11-09T11:15:00.000Z', b: '2026-11-09T19:00:00.000Z' });
  });
  test('D314 gap: a retry whose floor equals an uploaded clip time moves to the first free time (taken + minGapMinutes)', () => {
    const items = [{ id: 'up', state: 'done', publishAt: iso(T0 + 75 * 60000), sentPublishAt: iso(T0 + 75 * 60000) }, Q('a', T0 + 30 * 60000), Q('b', T0 + 6 * HOUR_MS)];
    assert.deepEqual(planOf({ items }), { a: '2026-11-09T12:15:00.000Z', b: '2026-11-09T18:15:00.000Z' });
  });
  test('D314 gap: a retry whose floor equals a channel post moves past every post within the gap', () => {
    const items = [Q('a', T0 + 30 * 60000), Q('b', null)];
    const p = planOf({ items, channelLast: T0 + 105 * 60000, channelTimes: [T0 + 75 * 60000, T0 + 105 * 60000] });
    assert.deepEqual(p, { a: '2026-11-09T12:45:00.000Z', b: '2026-11-09T18:45:00.000Z' }, '11:15 taken -> 12:15, 30 min from 11:45 -> 12:45');
    // a post 1 h or more away does not move it
    assert.equal(planOf({ items, channelTimes: [T0 + 15 * 60000] }).a, '2026-11-09T11:15:00.000Z');
  });
  test('D314 gap: a new item and a retry in the same pass never share a time', () => {
    const p = planQueueSlots({ items: [Q('n', null), Q('a', T0 + 30 * 60000)], nowMs: T0, cfg: CFG });
    assert.deepEqual(p.map((x) => [x.id, iso(x.at)]), [['n', '2026-11-09T11:15:00.000Z'], ['a', '2026-11-09T12:15:00.000Z']]);
    const at = p.map((x) => x.at); assert.ok(Math.abs(at[0] - at[1]) >= HOUR_MS);
    const d = mk(); const f2 = path.join(d, 's.json');
    for (const bad of [0, 361, 'x']) { writeFileSync(f2, JSON.stringify({ ...CFG, minGapMinutes: bad })); assert.throws(() => loadScheduleConfig(f2), (e) => e.code === 'schedule-config-bad'); }
    assert.equal(loadScheduleConfig().minGapMinutes, 60);
  });
  test('D314: no retry = the D310 rule unchanged (only new clips get a slot, after the latest one)', () => {
    const items = [Q('a', T0 + 5 * HOUR_MS), Q('b', null)];
    assert.deepEqual(planOf({ items }), { b: '2026-11-09T21:00:00.000Z' });
    assert.deepEqual(planOf({ items: [Q('a', T0 + 5 * HOUR_MS)] }), {});
  });
  test('D314 cap: no slot more than maxAheadDays ahead (repo: 730 days = 2 years); everything after it waits too', () => {
    assert.equal(loadScheduleConfig().maxAheadDays, 730);
    const cfg = { ...CFG, maxAheadDays: 1 };
    assert.deepEqual(planOf({ items: [Q('a', T0 + 30 * 60000), Q('b', T0 + 7 * HOUR_MS), Q('c', null), Q('d', null), Q('e', null)], cfg }),
      { a: '2026-11-09T11:15:00.000Z', b: '2026-11-09T17:15:00.000Z', c: '2026-11-09T23:15:00.000Z', d: '2026-11-10T05:15:00.000Z', e: null });
    assert.deepEqual(planOf({ items: [Q('n', null)], channelLast: T0 + 730 * 24 * HOUR_MS - 5 * HOUR_MS }), { n: null }, 'past 2 years: waits');
    assert.deepEqual(planOf({ items: [Q('n', null)], channelLast: T0 + 730 * 24 * HOUR_MS - 6 * HOUR_MS }), { n: iso(T0 + 730 * 24 * HOUR_MS) }, 'exactly 2 years: allowed');
    const d = mk(); const f = path.join(d, 's.json');
    for (const bad of [0, 3651, 'x']) { writeFileSync(f, JSON.stringify({ ...CFG, maxAheadDays: bad })); assert.throws(() => loadScheduleConfig(f), (e) => e.code === 'schedule-config-bad'); }
    const missing = { ...CFG }; delete missing.maxAheadDays; writeFileSync(f, JSON.stringify(missing));
    assert.throws(() => loadScheduleConfig(f), (e) => e.code === 'schedule-config-bad', 'never defaulted');
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
  test('flag off: no times; on: times in queue order after the queue\'s own last slot and the saved channel read', async () => {
    const f = fixture(); const now = () => new Date(T0);
    const off = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [] });
    assert.equal(off.schedule.on, false); assert.ok(off.queued.every((q) => !q.publishAt));
    let r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T11:15:00.000Z', '2026-11-09T17:15:00.000Z']);
    mkdirSync(path.join(f.dataDir, 'posting'), { recursive: true });
    writeFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), JSON.stringify({ version: 1, note: null,
      items: { x: { id: 'x', state: 'done', publishAt: '2026-11-09T20:00:00.000Z' } },
      schedule: { channelLast: '2026-11-09T22:00:00.000Z', readAt: '2026-11-09T09:00:00.000Z' } }));
    r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-10T04:00:00.000Z', '2026-11-10T10:00:00.000Z']);
    assert.equal(r.schedule.channelReadAt, '2026-11-09T09:00:00.000Z');
    const text = formatPreview(r);
    assert.match(text, /scheduled posting: on, every 6 h/); assert.match(text, /goes public: 2026-11-10T04:00:00.000Z \(estimate\)/);
  });
  test('D314: the preview shows the retry and re-chained times, and a clip past maxAheadDays as waiting', async () => {
    const f = fixture(); const now = () => new Date(T0);
    mkdirSync(path.join(f.dataDir, 'posting'), { recursive: true });
    writeFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), JSON.stringify({ version: 1, note: null,
      items: { a: { id: 'a', state: 'queued', publishAt: iso(T0 + 30 * 60000), session: null }, b: { id: 'b', state: 'queued', publishAt: iso(T0 + 6.5 * HOUR_MS), session: null } },
      schedule: { channelLast: null, readAt: '2026-11-09T09:00:00.000Z' } }));
    let r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T23:15:00.000Z', '2026-11-10T05:15:00.000Z'], 'after a (11:15) and b (17:15)');
    // the preview uses the saved channel post times for the gap, like the queue
    const qd = JSON.parse(readFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), 'utf8'));
    qd.schedule.channelTimes = [iso(T0 + 75 * 60000)]; writeFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), JSON.stringify(qd));
    r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-10T00:15:00.000Z', '2026-11-10T06:15:00.000Z'], 'a moved to 12:15, b 18:15');
    delete qd.schedule.channelTimes; writeFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), JSON.stringify(qd));
    assert.equal(r.schedule.retries, 1); assert.equal(r.schedule.rechained, 2);
    assert.match(formatPreview(r), /1 queued clip\(s\) came within 1 h of their time and would get a new time about 1 h from now, 2 queued clip\(s\) re-timed 6 h apart/);
    const cap = path.join(f.dataDir, 'cap.json'); writeFileSync(cap, JSON.stringify({ ...CFG, maxAheadDays: 1 }));
    r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true, scheduleFile: cap });
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T23:15:00.000Z', '2026-11-10T05:15:00.000Z']);
    // cap T0 + 24 h: an uploaded clip at T0 + 20 h is fixed, so b and both new clips would be past the cap
    const q =JSON.parse(readFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), 'utf8'));
    q.items.c = { id: 'c', state: 'done', publishAt: iso(T0 + 20 * HOUR_MS) }; // fixed: the re-chain goes after it
    writeFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), JSON.stringify(q));
    r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [], scheduleOn: true, scheduleFile: cap });
    assert.deepEqual(r.queued.map((q2) => [q2.publishAt ?? null, q2.publishNote ?? null]), [[null, 'beyond-cap'], [null, 'beyond-cap']]);
    assert.match(formatPreview(r), /waits: its public time would be more than 1 days ahead \(maxAheadDays\)/);
  });
  test('the last channel read hit the page cap: no time is estimated, and the preview says why', async () => {
    const f = fixture();
    mkdirSync(path.join(f.dataDir, 'posting'), { recursive: true });
    writeFileSync(path.join(f.dataDir, 'posting', 'upload-queue.json'), JSON.stringify({ version: 1, note: null, items: {},
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
