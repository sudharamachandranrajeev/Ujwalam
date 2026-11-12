// SPDX-License-Identifier: GPL-3.0-or-later
// RP5 / AN2 self-learning within limits (D364, D373, flag self-learning). Faked analytics rows and posts (placeholder ids,
// no network): the reward, seeded Thompson sampling, the 10 % floor, the 15-point weekly cap, once a week, undo, cold
// start, the auto-post kind order (flag off = unchanged), the CLI and the studio-ui API (flag gate, CSRF, undo).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LOG_FILE, MIX_DIR, MIX_FILE, analyse, appliedKindShares, betaDraw, choicesOf, defaultShares, limitShares, linkVideos, loadConfig,
  readLog, readMix, rewards, seededRng, step, undo, validateConfig, view, weeklyReport,
} from '../services/learning/mix.mjs';
import { main as cliMain } from '../services/learning/mix-cli.mjs';
import { mixOrder, planAuto } from '../services/posting/auto-post.mjs';
import { cleanChoices } from '../services/posting/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-mix-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
const cfg = loadConfig();
const utcHour = (iso) => new Date(iso).getUTCHours();
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-13T12:00:00Z');

/** n placeholder videos: a summary row (analytics) and a post (choices) each. good(i) decides a strong or weak result. */
function fake(n, { good = () => true, kind = () => 'montage', choices = () => ({ transition: 'fade', title: 'on', music: 'on' }), seconds = () => 40, at7d = false } = {}) {
  const rows = []; const posts = [];
  for (let i = 0; i < n; i++) {
    const g = good(i);
    const snap = { ageHours: at7d ? 170 : 25, data: { views: g ? 400 : 50 }, analytics: { views: g ? 400 : 50, averageViewPercentage: g ? 120 : 30 } };
    rows.push({ videoId: `vid${i}`, postId: `p${i}`, kind: kind(i), publicAt: `2026-11-0${1 + (i % 8)}T${String(19 + (i % 2)).padStart(2, '0')}:00:00Z`, at24h: snap, at7d: at7d ? snap : null });
    posts.push({ id: `p${i}`, kind: kind(i), endSec: seconds(i), choices: choices(i) });
  }
  return { rows, posts };
}

describe('settings and linking', () => {
  test('the shipped settings validate; every default keeps the floor', () => {
    for (const d of cfg.dimensions) for (const a of d.arms) assert.ok(d.defaults[a] >= cfg.limits.minShare);
    assert.equal(cfg.limits.minShare, 0.1);
    assert.equal(cfg.limits.maxStepPoints, 15);
    assert.throws(() => validateConfig({ ...cfg, limits: { ...cfg.limits, minShare: 0.6 } }), /minShare/);
  });
  test('choicesOf: kind, length band (montage only), transition/title/music, unknown values dropped', () => {
    assert.deepEqual(choicesOf({ kind: 'montage', endSec: 25, choices: { transition: 'fade', title: 'off', music: 'on' } }, cfg),
      { kind: 'montage', transition: 'fade', title: 'off', music: 'on', lengthBand: 'short' });
    assert.deepEqual(choicesOf({ kind: 'short', endSec: 50, choices: { transition: 'zoom' } }, cfg), { kind: 'short' });
    assert.equal(choicesOf({ kind: 'montage', endSec: 50 }, cfg).lengthBand, 'long');
  });
  test('cleanChoices keeps short words and a date only', () => {
    assert.deepEqual(cleanChoices({ transition: 'fade', title: 'on', music: 'off', mixAt: '2026-11-13T00:00:00.000Z', x: 'y' }),
      { transition: 'fade', title: 'on', music: 'off', mixAt: '2026-11-13T00:00:00.000Z' });
    assert.equal(cleanChoices({ title: 'Some Text With Spaces' }), null);
    assert.equal(cleanChoices(null), null);
  });
  test('linkVideos: 7 d preferred, else 24 h; a video without statistics is left out; hour band from publicAt', () => {
    const { rows, posts } = fake(3);
    rows[1].at7d = { ageHours: 170, analytics: { views: 999, averageViewPercentage: 10 } };
    rows[2].at24h = { ageHours: 25, analytics: null, data: { views: 5 } };
    const v = linkVideos({ rows, posts, cfg, hourOf: utcHour });
    assert.equal(v.length, 2);
    assert.equal(v[1].checkpoint, 'at7d');
    assert.equal(v[1].views, 999);
    assert.equal(v[0].choices.hour, 'evening');
  });
});

describe('reward', () => {
  test('r = 0.5 * min(pct, 150)/150 + 0.5 * views/(views + median)', () => {
    const vids = [
      { platform: 'youtube', checkpoint: 'at24h', views: 100, viewedPct: 75, choices: {} },
      { platform: 'youtube', checkpoint: 'at24h', views: 300, viewedPct: 200, choices: {} },
      { platform: 'youtube', checkpoint: 'at24h', views: 200, viewedPct: null, choices: {} },
    ];
    const r = rewards(vids, cfg);
    // median views 200
    assert.equal(r[0].reward, Math.round((0.5 * 0.5 + 0.5 * (100 / 300)) * 1e4) / 1e4);
    assert.equal(r[1].reward, Math.round((0.5 * 1 + 0.5 * (300 / 500)) * 1e4) / 1e4);
    assert.equal(r[2].reward, 0.5); // missing viewed % -> neutral 0.5, views at the median -> 0.5
    for (const x of r) assert.ok(x.reward >= 0 && x.reward <= 1);
  });
  test('views are normalised per checkpoint', () => {
    const r = rewards([
      { platform: 'youtube', checkpoint: 'at24h', views: 10, viewedPct: 0, choices: {} },
      { platform: 'youtube', checkpoint: 'at7d', views: 1000, viewedPct: 0, choices: {} },
    ], cfg);
    assert.equal(r[0].reward, 0.25);
    assert.equal(r[1].reward, 0.25);
  });
});

describe('sampling and limits', () => {
  test('seeded RNG: same seed, same draws; beta draws stay in 0..1', () => {
    const a = seededRng('x'); const b = seededRng('x');
    for (let i = 0; i < 5; i++) assert.equal(a(), b());
    const r = seededRng(7);
    for (let i = 0; i < 200; i++) { const x = betaDraw(2.5, 1.2, r); assert.ok(x > 0 && x < 1); }
  });
  test('analyse: same seed -> same targets; the better arm gets the higher win probability', () => {
    const data = fake(12, { good: (i) => i % 2 === 0, choices: (i) => ({ transition: i % 2 === 0 ? 'fade' : 'cut', title: 'on', music: 'on' }) });
    const a1 = analyse({ ...data, cfg, seed: 'w1', hourOf: utcHour });
    const a2 = analyse({ ...data, cfg, seed: 'w1', hourOf: utcHour });
    assert.deepEqual(a1.targets, a2.targets);
    assert.ok(a1.numbers.transition.fade.winProb > 0.9);
    assert.equal(a1.numbers.transition.fade.n, 6);
  });
  test('limitShares: the 15-point weekly cap and the 10 % floor, sum 1', () => {
    const lim = { minShare: 0.1, maxStepPoints: 15 };
    const s = limitShares({ cut: 0.1, fade: 0.9 }, { cut: 1, fade: 0 }, lim);
    assert.deepEqual(s, { cut: 0.25, fade: 0.75 });
    const s2 = limitShares({ cut: 0.15, fade: 0.85 }, { cut: 0, fade: 1 }, lim);
    assert.deepEqual(s2, { cut: 0.1, fade: 0.9 }); // the floor stops it at 10 %, not 0 %
    const k = limitShares({ short: 0.25, montage: 0.25, 'won-reel': 0.25, 'impact-play': 0.25 }, { short: 0, montage: 1, 'won-reel': 0, 'impact-play': 0 }, lim);
    assert.equal(k.montage, 0.4);
    for (const v of Object.values(k)) assert.ok(v >= 0.1 - 1e-9);
    assert.ok(Math.abs(Object.values(k).reduce((x, y) => x + y, 0) - 1) < 1e-9);
    // a share below the floor is lifted to it
    assert.ok(limitShares({ a: 0.05, b: 0.95 }, { a: 0, b: 1 }, lim).a >= 0.1);
  });
});

describe('weekly step, cold start, undo', () => {
  test('cold start: fewer than minVideos with numbers -> nothing written, the mix stays today\'s, and it says why', async () => {
    const dataDir = mk();
    const data = fake(cfg.coldStart.minVideos - 1);
    const s = await step({ dataDir, cfg, ...data, now: T0, hourOf: utcHour });
    assert.equal(s.changed, false);
    assert.equal(s.reason, 'cold-start');
    assert.match(s.detail, /7 of 8 posted videos/);
    assert.equal(existsSync(path.join(dataDir, MIX_DIR, MIX_FILE)), false);
    const v = await view({ dataDir, cfg, ...data, now: T0, hourOf: utcHour });
    assert.equal(v.status, 'cold-start');
    assert.equal(v.applied, false);
    assert.deepEqual(v.shares, defaultShares(cfg));
    assert.match(weeklyReport(v, cfg), /Not enough results yet/);
    assert.equal(appliedKindShares(dataDir, cfg), null);
  });
  test('a change: logged with its numbers, inside the limits, at most once a week; undo restores the mix before it', async () => {
    const dataDir = mk();
    const data = fake(12, {
      good: (i) => i % 3 !== 0,
      kind: (i) => (i % 3 === 0 ? 'short' : 'montage'),
      choices: (i) => ({ transition: i % 3 === 0 ? 'cut' : 'fade', title: i % 3 === 0 ? 'off' : 'on', music: 'on' }),
    });
    const s = await step({ dataDir, cfg, ...data, now: T0, seed: 'fixed', hourOf: utcHour });
    assert.equal(s.changed, true);
    const m = readMix(dataDir, cfg);
    assert.equal(m.applied, true);
    for (const d of cfg.dimensions) {
      for (const a of d.arms) {
        assert.ok(m.shares[d.id][a] >= cfg.limits.minShare - 1e-9, `${d.id}.${a} floor`);
        assert.ok(Math.abs(m.shares[d.id][a] - d.defaults[a]) <= cfg.limits.maxStepPoints / 100 + 1e-9, `${d.id}.${a} cap`);
      }
    }
    // montages scored better than shorts; the kinds with no posted video yet keep a share from the prior (exploration)
    assert.ok(m.shares.kind.montage > 0.25 && m.shares.kind.short < 0.25);
    // transition is learned from reels only: the 'cut' shorts do not count, so cut has no data (prior only)
    assert.equal(s.entry.numbers.transition.cut.n, 0);
    assert.equal(s.entry.numbers.transition.fade.n, 8);
    const log = readLog(dataDir);
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'change');
    assert.equal(log[0].videos, 12);
    assert.ok(log[0].numbers.kind.montage.n === 8 && log[0].numbers.kind.montage.meanReward > log[0].numbers.kind.short.meanReward);
    assert.deepEqual(log[0].from.shares, defaultShares(cfg));
    assert.deepEqual(appliedKindShares(dataDir, cfg), m.shares.kind);
    // once a week
    const again = await step({ dataDir, cfg, ...data, now: T0 + 3 * DAY, hourOf: utcHour });
    assert.equal(again.reason, 'too-soon');
    const week2 = await step({ dataDir, cfg, ...data, now: T0 + 7 * DAY, seed: 'fixed', hourOf: utcHour });
    assert.equal(week2.changed, true);
    const m2 = readMix(dataDir, cfg);
    assert.ok(m2.shares.kind.short <= m.shares.kind.short && m2.shares.kind.short >= 0.1 - 1e-9);
    for (const d of cfg.dimensions) for (const a of d.arms) assert.ok(Math.abs(m2.shares[d.id][a] - m.shares[d.id][a]) <= 0.15 + 1e-9);
    const text = weeklyReport(await view({ dataDir, cfg, ...data, now: T0 + 7 * DAY, hourOf: utcHour }), cfg);
    assert.match(text, /Reel kind: short \d+ % \(was \d+ %\)/);
    assert.match(text, /never changed/);
    // undo, one call each: back to week 1, then back to today's defaults (applied false)
    assert.equal(undo({ dataDir, cfg, now: T0 + 8 * DAY }).undone, true);
    assert.deepEqual(readMix(dataDir, cfg).shares, m.shares);
    assert.equal(undo({ dataDir, cfg, now: T0 + 8 * DAY }).undone, true);
    const back = readMix(dataDir, cfg);
    assert.equal(back.applied, false);
    assert.deepEqual(back.shares, defaultShares(cfg));
    assert.equal(appliedKindShares(dataDir, cfg), null);
    assert.equal(undo({ dataDir, cfg }).reason, 'nothing-to-undo');
    assert.deepEqual(readLog(dataDir).map((e) => e.action), ['change', 'change', 'undo', 'undo']);
    assert.ok(readFileSync(path.join(dataDir, MIX_DIR, LOG_FILE), 'utf8').split('\n').filter(Boolean).length === 4);
  });
  test('a dimension with too few known choices keeps its shares', async () => {
    const dataDir = mk();
    const data = fake(10, { choices: () => ({}) }); // older posts with no recorded choices
    const s = await step({ dataDir, cfg, ...data, now: T0, hourOf: utcHour });
    assert.equal(s.changed, true);
    const m = readMix(dataDir, cfg);
    assert.deepEqual(m.shares.transition, cfg.byId.transition.defaults);
    assert.ok(s.entry.kept.transition);
  });
});

describe('auto-post kind order', () => {
  const posts = [
    ...[90, 80, 70, 60].map((s, i) => ({ id: `s${i}`, kind: 'short', score: s, target: 'youtube-shorts', status: 'draft', limits: { ok: true }, unresolved: [] })),
    ...[0, 1].map((i) => ({ id: `m${i}`, kind: 'montage', score: null, target: 'youtube-shorts', status: 'draft', limits: { ok: true }, unresolved: [] })),
  ];
  const rules = [{ id: 'r1', target: 'youtube-shorts', minScore: 0, kinds: ['short', 'montage'], maxPerDay: 3, layouts: null }];
  const now = new Date('2026-11-13T10:00:00Z');
  test('flag off (kindShares null): exactly the plan of before', () => {
    const before = planAuto({ posts, rules, autoUpload: false, log: [], now });
    const off = planAuto({ posts, rules, autoUpload: false, log: [], now, kindShares: null });
    assert.deepEqual(off, before);
    assert.deepEqual(before.filter((x) => x.action === 'approve').map((x) => x.id), ['s0', 's1', 's2']);
  });
  test('a learned mix changes only the order inside the daily cap', () => {
    const plan = planAuto({ posts, rules, autoUpload: false, log: [], now, kindShares: { short: 0.5, montage: 0.5 } });
    const ids = plan.filter((x) => x.action === 'approve').map((x) => x.id);
    assert.equal(ids.length, 3);
    assert.ok(ids.includes('m0'));
    assert.deepEqual(mixOrder(posts, { short: 0.5, montage: 0.5 }).map((p) => p.id), ['s0', 'm0', 's1', 'm1', 's2', 's3']);
  });
});

describe('CLI', () => {
  test('flag off: exit 3 and nothing written', async () => {
    const dataDir = mk();
    const err = [];
    assert.equal(await cliMain(['show', '--data-dir', dataDir], () => {}, (s) => err.push(s)), 3);
    assert.match(err[0], /self-learning/);
  });
  test('step, report, undo with the flag on', async () => {
    const dataDir = mk();
    writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'self-learning': true } }));
    const data = fake(9, { kind: (i) => (i < 6 ? 'montage' : 'won-reel'), good: (i) => i < 6 });
    const deps = { ...data, now: T0, hourOf: utcHour };
    const out = [];
    assert.equal(await cliMain(['step', '--data-dir', dataDir], (s) => out.push(s), () => {}, deps), 0);
    assert.match(out.at(-1), /changed/);
    assert.equal(await cliMain(['report', '--data-dir', dataDir], (s) => out.push(s), () => {}, deps), 0);
    assert.match(out.at(-1), /Self-learning weekly report/);
    assert.equal(await cliMain(['undo', '--data-dir', dataDir], (s) => out.push(s), () => {}, deps), 0);
    assert.match(out.at(-1), /undone/);
    assert.equal(readMix(dataDir, cfg).applied, false);
  });
});

// ---------------------------------------------------------------- studio-ui API

const KEY = 'k'.repeat(48);
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
async function boot(flags) {
  const dataDir = mk();
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
  const data = fake(10, { kind: (i) => (i < 5 ? 'montage' : 'short'), good: (i) => i < 5 });
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost({ outputsReady: true }), launchKey: KEY, dataDir, feedbackDir: mk(),
    limits: { statusPollMs: 50 }, now: () => T0, learning: { ...data, hourOf: utcHour } });
  const { port } = await srv.listen();
  const r = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { srv, port, dataDir, cookie, csrf: s.json().csrf };
}
const post = (b, route, body, withCsrf = true) => raw(b.port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: b.cookie, origin: `http://127.0.0.1:${b.port}`, 'content-type': 'application/json', ...(withCsrf ? { 'x-ujwalam-csrf': b.csrf } : {}) },
});

describe('studio-ui mix API', () => {
  test('self-learning off (growth on): 404 self-learning-off for GET and undo', async () => {
    const b = await boot({ growth: true });
    try {
      const g = await raw(b.port, { url: '/ui/api/growth/mix', headers: { cookie: b.cookie } });
      assert.equal(g.status, 404);
      assert.equal(g.json().error, 'self-learning-off');
      assert.equal((await post(b, '/ui/api/growth/mix/undo', {})).status, 404);
    } finally { await b.srv.close(); }
  });
  test('growth off: 404 growth-off even with self-learning on', async () => {
    const b = await boot({ 'self-learning': true });
    try { assert.equal((await raw(b.port, { url: '/ui/api/growth/mix', headers: { cookie: b.cookie } })).json().error, 'growth-off'); } finally { await b.srv.close(); }
  });
  test('both on: GET shows the mix and report; undo needs CSRF; nothing to undo -> 409; after a change undo restores', async () => {
    const b = await boot({ growth: true, 'self-learning': true });
    try {
      assert.equal((await raw(b.port, { url: '/ui/api/growth/mix' })).status, 401);
      const g = await raw(b.port, { url: '/ui/api/growth/mix', headers: { cookie: b.cookie } });
      assert.equal(g.status, 200);
      const v = g.json();
      assert.equal(v.applied, false);
      assert.equal(v.status, 'waiting-for-weekly-change');
      assert.match(v.report, /weekly report/);
      assert.equal((await post(b, '/ui/api/growth/mix/undo', {}, false)).status, 403);
      assert.equal((await post(b, '/ui/api/growth/mix/undo', {})).status, 409);
      assert.equal((await post(b, '/ui/api/growth/mix/undo', { x: 1 })).status, 400);
      await step({ dataDir: b.dataDir, cfg, ...fake(10, { kind: (i) => (i < 5 ? 'montage' : 'short'), good: (i) => i < 5 }), now: T0, hourOf: utcHour });
      assert.equal(readMix(b.dataDir, cfg).applied, true);
      const u = await post(b, '/ui/api/growth/mix/undo', {});
      assert.equal(u.status, 200);
      assert.equal(u.json().applied, false);
      assert.equal(u.json().log.at(-1).action, 'undo');
    } finally { await b.srv.close(); }
  });
});
