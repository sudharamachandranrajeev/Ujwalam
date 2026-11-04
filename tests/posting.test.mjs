// SPDX-License-Identifier: GPL-3.0-or-later
// P16a export-only posting: packager, ledger, text limits, store, CLI flag gate. Fixture run folder built in a temp dir
// with a tiny ffmpeg-generated video (tests needing ffmpeg skip when it is missing). Placeholder names only; no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { main as cli } from '../services/posting/cli.mjs';
import {
  POSTING_FLAG, UNITS, checkLimits, cleanProfile, composeField, createLedger, createPostStore, loadLimits, loadTemplates, packageRun, renderText,
  unresolvedKeys, youtubeTagsLength,
} from '../services/posting/index.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-post-')); tmp.push(d); return d; };
const writeTmp = (obj) => { const f = path.join(mk(), 'limits.json'); writeFileSync(f, JSON.stringify(obj)); return f; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
const skip = haveFfmpeg ? false : 'ffmpeg not on PATH';
const PROFILE = { handles: { youtube: '@yt-handle-x', twitch: 'tw-handle-x' }, links: { discord: 'https://discord.example/invite-x' } };

function makeVideo(file, size) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=2`, '-pix_fmt', 'yuv420p', file], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
}
const pass = (ok) => ({ 'youtube-shorts': { ok }, tiktok: { ok }, 'instagram-reels': { ok: false } });

// c01: two PASS variants for shorts/tiktok, none for reels. c02: no PASS variant anywhere.
function makeRun() {
  const run = mk();
  mkdirSync(path.join(run, 'clips', 'c01'), { recursive: true });
  mkdirSync(path.join(run, 'clips', 'c02'), { recursive: true });
  makeVideo(path.join(run, 'clips', 'c01', 'full-crop.mp4'), '160x284');
  makeVideo(path.join(run, 'clips', 'c01', 'blurred-fill.mp4'), '176x312');
  makeVideo(path.join(run, 'clips', 'c02', 'full-crop.mp4'), '192x340');
  writeFileSync(path.join(run, 'clips', 'c01', 'captions.ass'), '[Script Info]\n');
  writeFileSync(path.join(run, 'candidates.json'), JSON.stringify({
    recordStartUtc: '2026-11-03T18:00:00Z',
    candidates: [
      { id: 'c01', rank: 1, start: 10, end: 12, anchor: 11, score: 1, reasons: [{ kind: 'marker.hotkey', detail: 'SECRET-NOTE-TEXT' }] },
      { id: 'c02', rank: 2, start: 30, end: 32, anchor: 31, score: 0.5, reasons: [] },
    ],
  }));
  writeFileSync(path.join(run, 'report.json'), JSON.stringify({
    results: [
      { id: 'c01', layout: 'blurred-fill', file: 'blurred-fill.mp4', ok: true, targets: pass(true), facts: { duration: 2 } },
      { id: 'c01', layout: 'full-crop', file: 'full-crop.mp4', ok: true, targets: pass(true), facts: { duration: 2 } },
      { id: 'c02', layout: 'full-crop', file: 'full-crop.mp4', ok: false, targets: pass(false), facts: { duration: 2 } },
    ],
  }));
  return run;
}

describe('pure helpers', () => {
  test('renderText fills {date}, {n} and profile keys; unresolved stay literal and are listed', () => {
    const missing = new Set();
    const s = renderText('Clip {n} on {date} at {handles.youtube} / {links.nope}', { profile: PROFILE, n: 3, date: '2026-11-03' }, missing);
    assert.equal(s, 'Clip 3 on 2026-11-03 at @yt-handle-x / {links.nope}');
    assert.deepEqual([...missing], ['links.nope']);
    assert.deepEqual(unresolvedKeys(s), ['links.nope']);
  });
  test('cleanProfile drops angle-bracket template values', () => {
    assert.deepEqual(cleanProfile({ handles: { youtube: '<youtube-handle>', kick: 'k' }, links: { discord: '<d>' } }), { handles: { kick: 'k' }, links: {} });
  });
  test('checkLimits flags over-limit, skips fields without max, keeps the status', () => {
    const limits = { targets: { t: { fields: { title: { from: ['title'], max: 5, unit: 'chars' }, body: { from: ['description', 'hashtags'], hashtagMax: 1 } }, status: 'unverified', source: 's', checked: null } } };
    const r = checkLimits({ target: 't', title: 'abcdef', description: 'x'.repeat(9999), tags: [], hashtags: ['#a'] }, limits);
    assert.equal(r.ok, false);
    assert.deepEqual(r.checks.map((c) => [c.field, c.unit, c.ok]), [['title', 'chars', false], ['body', 'hashtags', true]]);
    assert.equal(r.status, 'unverified');
  });

  test('composeField builds the posted text: parts separated by a blank line, hashtags by spaces, tags by commas', () => {
    const post = { title: 'T', description: ' Body ', tags: ['a', 'b c'], hashtags: ['#x', '#y'] };
    assert.equal(composeField(post, ['description', 'hashtags']), 'Body\n\n#x #y');
    assert.equal(composeField({ ...post, hashtags: [] }, ['description', 'hashtags']), 'Body');
    assert.equal(composeField(post, ['tags']), 'a,b c');
  });

  test('units: YouTube description counts UTF-8 bytes, TikTok UTF-16 units, titles code points', () => {
    const ml = 'മലയാളം'; // 6 Malayalam code points, 18 UTF-8 bytes
    assert.equal(UNITS.chars(ml), 6);
    assert.equal(UNITS['utf8-bytes'](ml), 18);
    assert.equal(UNITS.utf16('\u{1F3AE}'), 2, 'an emoji is 2 UTF-16 units');
    const L = loadLimits();
    const d = 'x'.repeat(1700);
    const yt = checkLimits({ target: 'youtube-shorts', title: 'ok', description: ml.repeat(278), tags: [], hashtags: [] }, L);
    assert.equal(yt.checks.find((c) => c.field === 'description' && c.unit === 'utf8-bytes').ok, false, '1668 Malayalam letters = 5004 bytes > 5000');
    assert.equal(checkLimits({ target: 'tiktok', title: '', description: d + '\u{1F3AE}'.repeat(251), tags: [], hashtags: [] }, L).ok, false, '1700 + 502 units > 2200 (1951 code points)');
    assert.equal(checkLimits({ target: 'tiktok', title: '', description: d + '\u{1F3AE}'.repeat(250), tags: [], hashtags: [] }, L).ok, true, 'exactly 2200 units passes');
    assert.equal(checkLimits({ target: 'tiktok', title: '', description: d, tags: [], hashtags: [] }, L).ok, true);
  });

  test('YouTube: < and > refused in title and description; tags count commas and quotes; over 60 hashtags flagged', () => {
    const L = loadLimits();
    const base = { target: 'youtube-shorts', title: 'a', description: 'b', tags: [], hashtags: [] };
    assert.equal(checkLimits({ ...base, title: 'a <b>' }, L).ok, false);
    assert.equal(youtubeTagsLength(['ab', 'c d']), 2 + 1 + (3 + 2));
    assert.equal(checkLimits({ ...base, tags: Array.from({ length: 100 }, () => 'abcd') }, L).ok, true, '100*4 + 99 = 499');
    assert.equal(checkLimits({ ...base, tags: Array.from({ length: 101 }, () => 'abcd') }, L).ok, false, '101*4 + 100 = 504');
    assert.equal(checkLimits({ ...base, hashtags: Array.from({ length: 61 }, (_, i) => `#h${i}`) }, L).ok, false);
    assert.equal(checkLimits({ ...base, hashtags: Array.from({ length: 60 }, (_, i) => `#h${i}`) }, L).ok, true);
  });

  test('Instagram: 30 hashtags and 20 mentions in the caption; every shipped target is verified with a source and date', () => {
    const L = loadLimits();
    const base = { target: 'instagram-reels', title: 't', description: 'd', tags: [], hashtags: [] };
    assert.equal(checkLimits({ ...base, hashtags: Array.from({ length: 31 }, (_, i) => `#h${i}`) }, L).ok, false);
    assert.equal(checkLimits({ ...base, description: Array.from({ length: 21 }, (_, i) => `@m${i}`).join(' ') }, L).ok, false);
    for (const [id, t] of Object.entries(L.targets)) {
      assert.equal(t.status, 'verified', id);
      assert.match(t.checked, /^\d{4}-\d{2}-\d{2}$/, id);
      assert.match(t.source, /^https:\/\//, id);
    }
    assert.throws(() => loadLimits(writeTmp({ targets: { x: { fields: { a: { unit: 'words' } } } } })), /bad field unit/);
  });
  test('data files: every template target has limits; templates hold placeholders only', () => {
    const t = loadTemplates(); const l = loadLimits();
    for (const id of Object.keys(t.targets)) assert.ok(l.targets[id], id);
    const all = JSON.stringify(t.targets);
    assert.ok(/\{handles\.|\{links\./.test(all));
    assert.ok(!/@[A-Za-z]/.test(all), 'no literal handles in committed templates');
  });
});

describe('packager', { skip }, () => {
  test('packages only PASS variants, byte-copies video, makes cover, resolves text, no private text', async () => {
    const run = makeRun(); const data = mk();
    const ledgerFile = path.join(data, 'posting', 'ledger.json');
    const r = await packageRun({ runDir: run, ledgerFile, profile: PROFILE });
    assert.deepEqual(r.packaged.map((p) => `${p.clipId}/${p.target}/${p.layout}`).sort(), ['c01/tiktok/full-crop', 'c01/youtube-shorts/full-crop']);
    assert.ok(r.skipped.some((s) => s.clipId === 'c01' && s.target === 'instagram-reels' && s.reason === 'no-pass-variant'));
    assert.equal(r.skipped.filter((s) => s.clipId === 'c02').length, 3);
    const dir = path.join(run, 'posts', 'c01', 'youtube-shorts');
    assert.equal(sha(path.join(dir, 'full-crop.mp4')), sha(path.join(run, 'clips', 'c01', 'full-crop.mp4')), 'byte-for-byte copy');
    const cover = readFileSync(path.join(dir, 'cover.jpg'));
    assert.deepEqual([...cover.subarray(0, 2)], [0xff, 0xd8], 'JPEG');
    assert.ok(existsSync(path.join(dir, 'captions.ass')));
    const post = JSON.parse(readFileSync(path.join(dir, 'post.json'), 'utf8'));
    assert.equal(post.privacy, 'private');
    assert.equal(post.status, 'draft');
    assert.equal(post.target, 'youtube-shorts');
    assert.equal(post.source.clipId, 'c01');
    assert.equal(post.source.layout, 'full-crop');
    assert.equal(post.source.sha256, sha(path.join(dir, 'full-crop.mp4')));
    assert.equal(post.source.startSec, 10);
    assert.equal(post.cover.atSec, 1);
    assert.match(post.description, /@yt-handle-x/);
    assert.match(post.description, /invite-x/);
    assert.deepEqual(post.unresolved, []);
    assert.equal(post.limits.status, 'verified');
    assert.ok(post.limits.checks.some((c) => c.field === 'description' && c.unit === 'utf8-bytes'));
    assert.ok(!readFileSync(path.join(dir, 'post.json'), 'utf8').includes('SECRET-NOTE-TEXT'));
    assert.equal(createLedger(ledgerFile).list().length, 2);
  });

  test('second run never packages the same video for the same target again', async () => {
    const run = makeRun(); const data = mk();
    const ledgerFile = path.join(data, 'ledger.json');
    await packageRun({ runDir: run, ledgerFile, profile: PROFILE });
    const again = await packageRun({ runDir: run, ledgerFile, profile: PROFILE });
    assert.equal(again.packaged.length, 0);
    assert.ok(again.skipped.some((s) => s.reason === 'already-packaged'));
  });

  test('missing profile keys are flagged (placeholders stay literal); over-limit is flagged, never truncated', async () => {
    const run = makeRun(); const data = mk();
    const limits = loadLimits();
    limits.targets['youtube-shorts'].fields.title.max = 5;
    const r = await packageRun({ runDir: run, ledgerFile: path.join(data, 'l.json'), profile: {}, limits, targets: ['youtube-shorts'] });
    const post = JSON.parse(readFileSync(path.join(r.packaged[0].dir, 'post.json'), 'utf8'));
    assert.ok(post.unresolved.includes('handles.youtube'));
    assert.match(post.description, /\{handles\.youtube\}/);
    assert.equal(post.limits.ok, false);
    assert.ok(post.title.length > 5, 'not truncated');
  });
});

describe('store', { skip }, () => {
  async function setup(profile = PROFILE) {
    const run = makeRun(); const data = mk();
    const ledgerFile = path.join(data, 'ledger.json');
    await packageRun({ runDir: run, ledgerFile, profile, targets: ['youtube-shorts'] });
    const store = createPostStore({ ledgerFile });
    return { run, ledgerFile, store, id: store.list()[0].id };
  }

  test('list, edit (back to draft, limits recomputed), approve, reject; ledger follows', async () => {
    const { ledgerFile, store, id } = await setup();
    assert.equal(store.list().length, 1);
    assert.equal(store.get(id).status, 'draft');
    const ap = await store.setStatus(id, 'approved');
    assert.equal(ap.status, 'approved');
    assert.equal(createLedger(ledgerFile).list()[0].status, 'approved');
    const ed = store.edit(id, { title: 'New title', tags: ['a', ' b '], hashtags: ['x y', '#z'] });
    assert.equal(ed.status, 'draft', 'an edit drops approval');
    assert.deepEqual(ed.tags, ['a', 'b']);
    assert.deepEqual(ed.hashtags, ['#xy', '#z']);
    assert.equal(createLedger(ledgerFile).list()[0].status, 'draft');
    assert.equal((await store.setStatus(id, 'rejected')).status, 'rejected');
    assert.equal(await store.setStatus(id, 'bogus'), 'bad-status');
    assert.equal(await store.setStatus('0000000000000000.nope', 'draft'), 'unknown-post');
  });

  test('approve refused when over the limit or placeholders remain', async () => {
    const { store, id } = await setup({});
    assert.equal(await store.setStatus(id, 'approved'), 'unresolved-placeholders');
    store.edit(id, { description: 'plain' });
    store.edit(id, { title: 'x'.repeat(150) });
    assert.equal(await store.setStatus(id, 'approved'), 'over-limit');
    store.edit(id, { title: 'ok' });
    assert.equal((await store.setStatus(id, 'approved')).status, 'approved');
  });

  test('edit rejects bad fields; approve detects a changed video', async () => {
    const { run, store, id } = await setup();
    assert.equal(store.edit(id, { title: 5 }), 'bad-title');
    assert.equal(store.edit(id, { nope: 1 }), 'bad-params');
    assert.equal(store.edit(id, { tags: 'a' }), 'bad-tags');
    writeFileSync(path.join(run, 'posts', 'c01', 'youtube-shorts', 'full-crop.mp4'), 'tampered');
    assert.equal(await store.setStatus(id, 'approved'), 'video-changed');
  });

  test('media: video and cover resolve; a tampered post.json name cannot leave the folder', async () => {
    const { run, store, id } = await setup();
    assert.equal(store.media(id, 'video').type, 'video/mp4');
    assert.equal(store.media(id, 'cover').type, 'image/jpeg');
    assert.equal(store.media(id, 'captions'), null);
    const pj = path.join(run, 'posts', 'c01', 'youtube-shorts', 'post.json');
    const post = JSON.parse(readFileSync(pj, 'utf8'));
    for (const bad of ['../../../candidates.json', '..\\x.mp4', 'a/b.mp4', 'post.json']) {
      writeFileSync(pj, JSON.stringify({ ...post, video: { ...post.video, file: bad } }));
      assert.equal(store.media(id, 'video'), null, bad);
    }
  });
});

describe('cli', { skip }, () => {
  test('exit 3 while the posting flag is off; packages when on', async () => {
    const run = makeRun(); const data = mk();
    const quiet = () => {};
    assert.equal(await cli(['package', '--run', run, '--data-dir', data], quiet, quiet), 3);
    assert.ok(!existsSync(path.join(run, 'posts')));
    writeFileSync(path.join(data, 'flags.local.json'), JSON.stringify({ flags: { [POSTING_FLAG]: true } }));
    const lines = [];
    assert.equal(await cli(['package', '--run', run, '--data-dir', data, '--profile', path.join(data, 'missing.json')], (s) => lines.push(s), quiet), 0);
    assert.ok(lines.some((l) => /packaged 2 \(2 flagged/.test(l)), lines.join('|'));
    assert.ok(existsSync(path.join(run, 'posts', 'c01', 'tiktok', 'post.json')));
  });
});
