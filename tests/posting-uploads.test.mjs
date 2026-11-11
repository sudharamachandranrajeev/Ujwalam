// SPDX-License-Identifier: GPL-3.0-or-later
// D301: montages and won-match reels are packaged and posted like shorts. Fakes only: temp dirs, no network, no real ffmpeg
// (process.execPath stands in; the cover step fails and the package simply has no cover).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createPostChain, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { loadRules, planAuto, validateRules } from '../services/posting/auto-post.mjs';
import { createPostStore, loadLimits, loadTemplates, packageUploads, pickYoutubeTarget } from '../services/posting/index.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d301-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const FFMPEG = process.execPath;
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const limits = loadLimits();

function setup(rows) {
  const dataDir = mk(); const clips = mk();
  const out = rows.map((r, i) => {
    const file = path.join(clips, r.name);
    if (r.write !== false) writeFileSync(file, Buffer.from(`${r.name}-${i}`.repeat(8)));
    const { name, write, ...rest } = r;
    return { file, label: 'x', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-08T09:00:00.000Z', ...rest };
  });
  mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: out }));
  return { dataDir, ledgerFile: path.join(dataDir, 'posting', 'ledger.json'), rows: out };
}
const ROWS = [
  { name: 'codm_short_20261108-185841_triple-kill_01_v.mp4', kind: 'short', seconds: 12 },
  { name: 'codm_montage_20261108-185824_kills-5_01_v.mp4', kind: 'montage', seconds: 45 },
  { name: 'codm_montage_20261108-185824_kills-9_02_v.mp4', kind: 'montage', seconds: 90 },
  { name: 'codm_won-reel_20261108-185824_victory-kills-4_01_v-full-crop.mp4', kind: 'won-reel', seconds: 50 },
  { name: 'codm_montage_20261108-185824_kills-5_03_h.mp4', kind: 'montage', seconds: 30 },
];

describe('target by length and aspect (from limits.json, not code)', () => {
  test('vertical and within the Shorts limit -> shorts; longer or horizontal -> youtube-video', () => {
    assert.equal(limits.targets['youtube-shorts'].video.maxDurationSec, 60);
    assert.equal(pickYoutubeTarget({ seconds: 45, vertical: true }, limits), 'youtube-shorts');
    assert.equal(pickYoutubeTarget({ seconds: 60, vertical: true }, limits), 'youtube-shorts');
    assert.equal(pickYoutubeTarget({ seconds: 60.5, vertical: true }, limits), 'youtube-video');
    assert.equal(pickYoutubeTarget({ seconds: 20, vertical: false }, limits), 'youtube-video');
    assert.equal(pickYoutubeTarget({ seconds: NaN, vertical: true }, limits), 'youtube-video');
  });
  test('the limit comes from the data: a changed file moves the line', () => {
    const l = JSON.parse(JSON.stringify(limits)); l.targets['youtube-shorts'].video.maxDurationSec = 30;
    assert.equal(pickYoutubeTarget({ seconds: 45, vertical: true }, l), 'youtube-video');
    delete l.targets['youtube-shorts'].video;
    assert.equal(pickYoutubeTarget({ seconds: 5, vertical: true }, l), 'youtube-video');
  });
  test('templates exist for every kind and target', () => {
    const t = loadTemplates();
    for (const target of ['youtube-shorts', 'youtube-video']) for (const k of ['montage', 'won-reel']) assert.ok(t.targets[target].kinds[k].title, `${target}/${k}`);
    assert.ok(limits.targets['youtube-video'].fields.title);
  });
});

describe('packageUploads', () => {
  test('CL1: the parts of a split reel are packaged as separate reels, each a Short at 60 s or less', async () => {
    const e = setup([
      { name: 'codm_montage_20261111-200000_kills-12-part-1-of-2_01_v.mp4', kind: 'montage', seconds: 60 },
      { name: 'codm_montage_20261111-200500_kills-6-part-2-of-2_02_v.mp4', kind: 'montage', seconds: 33.5 },
      { name: 'codm_won-reel_20261111-201000_victory-kills-30-part-1-of-3_01_v.mp4', kind: 'won-reel', seconds: 59.9 },
    ]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG });
    assert.equal(r.packaged.length, 3);
    assert.ok(r.packaged.every((p) => p.target === 'youtube-shorts' && p.limitsOk));
    const posts = createPostStore({ ledgerFile: e.ledgerFile }).list();
    assert.equal(new Set(posts.map((p) => p.clipId)).size, 3, 'each part has its own post');
    const again = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG });
    assert.equal(again.packaged.length, 0, 'a part is not packaged twice');
  });
  test('packages shorts, montages and reels; right target and text per kind; private draft; second run adds nothing', async () => {
    const e = setup([...ROWS,
      { name: 'codm_short_20261108-185900_double-kill_02_v.mp4', kind: 'short', seconds: 8, posted: [{ platform: 'youtube', videoId: 'old' }] },
      { name: 'gone.mp4', kind: 'montage', seconds: 30, write: false },
      { name: 'other.mp4', kind: 'banana', seconds: 30 }]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG });
    assert.equal(r.packaged.length, 5);
    const t = (needle) => r.packaged.find((p) => p.file.includes(needle)).target;
    assert.equal(t('_short_'), 'youtube-shorts');
    assert.equal(t('kills-5_01'), 'youtube-shorts', '45 s vertical');
    assert.equal(t('kills-9_02'), 'youtube-video', '90 s is not a Short');
    assert.equal(t('won-reel'), 'youtube-shorts');
    assert.equal(t('kills-5_03'), 'youtube-video', 'horizontal');
    assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['already-posted', 'file-missing', 'unknown-kind']);
    for (const p of r.packaged) assert.deepEqual(p.unresolved, [], p.file);
    const store = createPostStore({ ledgerFile: e.ledgerFile });
    const posts = store.list();
    assert.equal(posts.length, 5);
    const m = posts.find((p) => p.kind === 'montage' && p.target === 'youtube-shorts');
    assert.match(m.title, /^Stream kill montage 1 \(2026-11-08\)$/);
    assert.match(m.description, /@example-channel/);
    assert.ok(m.hashtags.includes('#montage') && m.hashtags.includes('#Shorts'));
    const long = posts.find((p) => p.target === 'youtube-video' && p.endSec === 90);
    assert.ok(long && !long.hashtags.includes('#Shorts'));
    const reel = posts.find((p) => p.kind === 'won-reel');
    assert.match(reel.title, /^Stream victory reel 1/);
    for (const p of posts) { assert.equal(p.status, 'draft'); assert.equal(p.privacy, 'private'); assert.equal(p.limits.ok, true); assert.ok(store.media(p.id, 'video')); }
    assert.equal(reel.layout, 'v-full-crop');
    assert.ok(store.dir(reel.id).startsWith(path.join(e.dataDir, 'posting', 'packages')));
    const again = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG });
    assert.equal(again.packaged.length, 0);
    assert.ok(again.skipped.some((s) => s.reason === 'already-packaged'));
  });

  test('D326: impact-play reels are packaged only while the impact-play-reels flag is on (off by default)', async () => {
    const row = { name: 'codm_impact-play_20261109-100000_victory_01_v.mp4', kind: 'impact-play', seconds: 47 };
    const off = setup([row]);
    const r0 = await packageUploads({ dataDir: off.dataDir, ledgerFile: off.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG });
    assert.equal(r0.packaged.length, 0);
    assert.deepEqual(r0.skipped.map((s) => s.reason), ['flag-off'], 'default off, no flags.local.json');
    writeFileSync(path.join(off.dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'impact-play-reels': true } }));
    const r1 = await packageUploads({ dataDir: off.dataDir, ledgerFile: off.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG });
    assert.equal(r1.packaged.length, 1);
    assert.equal(r1.packaged[0].target, 'youtube-shorts');
    const injected = setup([row]);
    const r2 = await packageUploads({ dataDir: injected.dataDir, ledgerFile: injected.ledgerFile, profile: PROFILE, ffmpeg: FFMPEG,
      flags: { isOn: (id) => id !== 'impact-play-reels' } });
    assert.deepEqual(r2.skipped.map((s) => s.reason), ['flag-off']);
  });

  test('run filter packages only that run; an empty profile leaves placeholders listed, never filled in; empty list is fine', async () => {
    const e = setup([{ ...ROWS[1], run: 'runA' }, { ...ROWS[2], run: 'runB' }]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: FFMPEG, run: 'runB' });
    assert.equal(r.packaged.length, 1); assert.equal(r.packaged[0].target, 'youtube-video');
    assert.ok(r.packaged[0].unresolved.length > 0);
    const none = setup([]);
    assert.deepEqual(await packageUploads({ dataDir: none.dataDir, ledgerFile: none.ledgerFile }), { packaged: [], skipped: [] });
  });
});

describe('rules: kinds', () => {
  test('validation and default', () => {
    assert.deepEqual(validateRules({ rules: [{ id: 'a', target: 'youtube-shorts', minScore: 1, maxPerDay: 1 }] }).rules[0].kinds, ['short']);
    assert.throws(() => validateRules({ rules: [{ id: 'a', target: 'youtube-shorts', minScore: 1, maxPerDay: 1, kinds: ['banana'] }] }), /kinds/);
    assert.throws(() => validateRules({ rules: [{ id: 'a', target: 'youtube-shorts', minScore: 1, maxPerDay: 1, kinds: [] }] }), /kinds/);
    assert.equal(loadRules().rules.length, 0, 'the committed rules file stays empty');
  });
  test('a montage rule approves scoreless montages; a short rule still needs a score', () => {
    const base = { status: 'draft', score: null, layout: 'v', limits: { ok: true }, unresolved: [] };
    const posts = [
      { ...base, id: 'm1', target: 'youtube-video', kind: 'montage' },
      { ...base, id: 's1', target: 'youtube-shorts', kind: 'short' },
      { ...base, id: 'r1', target: 'youtube-shorts', kind: 'won-reel' },
    ];
    const rules = [{ id: 'mm', target: 'youtube-video', minScore: 0, layouts: null, kinds: ['montage'], maxPerDay: 3 },
      { id: 'ss', target: 'youtube-shorts', minScore: 0, layouts: null, kinds: ['short', 'won-reel'], maxPerDay: 3 }];
    const plan = planAuto({ posts, rules, autoUpload: true, log: [], now: new Date('2026-11-08T10:00:00Z') });
    const acts = plan.map((p) => `${p.id}:${p.action}${p.reason === 'no-score' ? '(no-score)' : ''}`).sort();
    assert.deepEqual(acts, ['m1:approve', 'm1:upload', 'r1:approve', 'r1:upload', 's1:skip(no-score)']);
  });
});

describe('chain: finished videos reach the queue', () => {
  const authOk = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-access' };
  function fakeYt() {
    const inits = []; let n = 0;
    const fetchImpl = async (url, o = {}) => {
      const cr = o.headers?.['Content-Range'] ?? '';
      if (String(url).includes('uploadType=resumable')) { inits.push(JSON.parse(o.body)); return { ok: true, status: 200, headers: new Map([['location', `https://fake.invalid/s${inits.length}`]]) }; }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (m && Number(m[2]) + 1 >= Number(m[3])) return { ok: true, status: 200, headers: new Map(), json: async () => ({ id: `vid${++n}` }) };
      return { ok: false, status: 308, headers: new Map() };
    };
    return { fetchImpl, inits };
  }
  test('montage-only run (no candidates.json): packaged from uploads.json, approved by a kinds rule, uploaded private to the chosen target', async () => {
    const e = setup([ROWS[0], ROWS[1], ROWS[2]]);
    const runDir = path.join(e.dataDir, 'clips', 'runs', 'run1'); mkdirSync(runDir, { recursive: true });
    const rulesFile = path.join(e.dataDir, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ autoUpload: true, rules: [
      { id: 'mm', target: 'youtube-shorts', minScore: 0, kinds: ['montage'], maxPerDay: 5 },
      { id: 'ml', target: 'youtube-video', minScore: 0, kinds: ['montage'], maxPerDay: 5 }] }));
    const pf = path.join(e.dataDir, 'profile.json'); writeFileSync(pf, JSON.stringify(PROFILE));
    const yt = fakeYt(); const logs = [];
    const c = createPostChain({ dataDir: e.dataDir, flags: { isOn: (id) => id !== 'post-schedule' }, rulesFile, auth: authOk, fetchImpl: yt.fetchImpl, now: () => Date.parse('2026-11-08T10:00:00Z'),
      tickEveryMs: 0, profileFile: pf, ffmpeg: FFMPEG, log: (m) => logs.push(m) });
    const r = await c.afterRun(runDir, { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }] });
    assert.equal(r.packaged, 3, JSON.stringify(logs));
    assert.equal(yt.inits.length, 2, 'both montages uploaded; the short (no score, kind short) stays a draft');
    assert.ok(yt.inits.every((b) => b.status.privacyStatus === 'private'));
    const store = createPostStore({ ledgerFile: e.ledgerFile });
    assert.deepEqual(store.list().map((p) => `${p.kind}:${p.target}:${p.status}`).sort(), ['montage:youtube-shorts:uploaded', 'montage:youtube-video:uploaded', 'short:youtube-shorts:draft']);
    const rows = JSON.parse(readFileSync(path.join(e.dataDir, 'clips', 'uploads.json'), 'utf8')).files;
    assert.deepEqual(rows.map((x) => [x.kind, x.posted.map((p) => p.target)]), [['short', []], ['montage', ['youtube-shorts']], ['montage', ['youtube-video']]]);
    const q = createUploadQueue(path.join(e.dataDir, 'posting', 'upload-queue.json')).items();
    assert.deepEqual(q.map((i) => i.state), ['done', 'done']);
    await c.afterRun(runDir, { sinks: [] });
    assert.equal(yt.inits.length, 2, 'a second run uploads nothing');
    assert.ok(!existsSync(path.join(runDir, 'posts')), 'nothing written into the run folder');
  });
});
