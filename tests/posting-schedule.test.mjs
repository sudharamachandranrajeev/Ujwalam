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
  DEFAULT_SCHEDULE, HOUR_MS, SCHEDULE_FLAG, latestFutureSchedule, loadScheduleConfig, nextSlot, ownLastSlot, planSlots, slotStale,
} from '../services/posting/schedule.mjs';
import { UploadError, uploadMetadata } from '../services/posting/youtube.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-sched-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const CFG = { intervalHours: 6, minLeadHours: 1, staleMinutes: 15, maxPages: 4, pageSize: 50 };
const T0 = Date.parse('2026-11-09T10:00:00Z');
const iso = (t) => new Date(t).toISOString();

describe('slot math (UTC, pure)', () => {
  test('settings come from data/posting/schedule.json (6 h, with source and date)', () => {
    const cfg = loadScheduleConfig();
    assert.equal(cfg.intervalHours, 6);
    assert.ok(cfg.minLeadHours > 0 && cfg.staleMinutes > 0 && cfg.maxPages >= 1 && cfg.pageSize <= 50);
    const raw = JSON.parse(readFileSync(DEFAULT_SCHEDULE, 'utf8'));
    assert.match(raw.source, /user request 2026-11-09/); assert.equal(raw.checked, '2026-11-09');
  });
  test('a bad settings file is refused, never defaulted', () => {
    const d = mk(); const f = path.join(d, 's.json');
    for (const bad of [{ ...CFG, intervalHours: 0 }, { ...CFG, minLeadHours: 'x' }, { ...CFG, pageSize: 51 }, {}]) {
      writeFileSync(f, JSON.stringify(bad));
      assert.throws(() => loadScheduleConfig(f), (e) => e.code === 'schedule-config-bad');
    }
    assert.throws(() => loadScheduleConfig(path.join(d, 'missing.json')), (e) => e.code === 'schedule-config-bad');
  });
  test('empty channel and empty queue: now + minLead', () => {
    assert.equal(iso(nextSlot({ nowMs: T0, cfg: CFG })), '2026-11-09T11:00:00.000Z');
  });
  test('rounded up to the whole minute', () => {
    assert.equal(iso(nextSlot({ nowMs: T0 + 1500, cfg: CFG })), '2026-11-09T11:01:00.000Z');
  });
  test('future channel schedule: 6 h after the latest one', () => {
    assert.equal(iso(nextSlot({ channelLast: T0 + 10 * HOUR_MS, nowMs: T0, cfg: CFG })), '2026-11-10T02:00:00.000Z');
  });
  test('own queue later than the channel wins; the later anchor always wins', () => {
    assert.equal(iso(nextSlot({ channelLast: T0 + 2 * HOUR_MS, ownLast: T0 + 9 * HOUR_MS, nowMs: T0, cfg: CFG })), '2026-11-10T01:00:00.000Z');
  });
  test('an anchor so close that +6 h is still sooner than the lead time uses the lead time', () => {
    // own slot went public 5.5 h ago: +6 h = now + 30 min < now + 1 h
    assert.equal(iso(nextSlot({ ownLast: T0 - 5.5 * HOUR_MS, nowMs: T0, cfg: CFG })), '2026-11-09T11:00:00.000Z');
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
  test('stale: within staleMinutes of now (or unreadable)', () => {
    assert.equal(slotStale(iso(T0 + 10 * 60000), T0, CFG), true);
    assert.equal(slotStale(iso(T0 + 20 * 60000), T0, CFG), false);
    assert.equal(slotStale('x', T0, CFG), true);
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
    assert.deepEqual(r.queued.map((q) => q.publishAt), ['2026-11-09T11:00:00.000Z', '2026-11-09T17:00:00.000Z']);
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
  test('approval-only rules (no autoUpload) get no time; a bad settings file says so', async () => {
    const f = fixture();
    const r = await previewRules({ dataDir: f.dataDir, rules: { ...f.rules, autoUpload: false }, profile: PROFILE, now: () => new Date(T0), log: [], scheduleOn: true });
    assert.ok(r.queued.length && r.queued.every((q) => !q.publishAt));
    const bad = path.join(f.dataDir, 'bad.json'); writeFileSync(bad, '{}');
    const b = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now: () => new Date(T0), log: [], scheduleOn: true, scheduleFile: bad });
    assert.equal(b.schedule.error, 'schedule-config-bad'); assert.match(formatPreview(b), /not valid/);
  });
});
