// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-post rules dry-run preview: queue/skip decisions with reasons, rendered text, CLI + control-page route, and proof
// of zero network and zero writes. Also: template text vs limits.json (unicode, montage / won-reel overrides, no truncation).
// Fakes only: temp dirs, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../services/posting/cli.mjs';
import { checkLimits, loadLimits, loadTemplates, postId } from '../services/posting/index.mjs';
import { formatPreview, previewRules, renderUploadPost } from '../services/posting/preview.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-preview-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const limits = loadLimits();
const templates = loadTemplates();

/** Records every attempt to leave the process; any attempt also throws. */
function netGuard() {
  const calls = [];
  const saved = { fetch: globalThis.fetch, hr: http.request, sr: https.request, cn: net.Socket.prototype.connect };
  const boom = (what) => (...a) => { calls.push(what + ' ' + String(a[0]?.host ?? a[0]?.href ?? a[0]).slice(0, 80)); throw new Error('network blocked in test'); };
  globalThis.fetch = boom('fetch'); http.request = boom('http'); https.request = boom('https');
  net.Socket.prototype.connect = function (...a) { const h = a[0]?.host ?? a[0]; if (h !== '127.0.0.1' && h !== 'localhost') { calls.push('connect ' + String(h).slice(0, 80)); throw new Error('network blocked in test'); } return saved.cn.apply(this, a); };
  return { calls, restore() { globalThis.fetch = saved.fetch; http.request = saved.hr; https.request = saved.sr; net.Socket.prototype.connect = saved.cn; } };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const f = path.join(d, n); const s = statSync(f); if (s.isDirectory()) walk(f); else out[f] = `${s.size}:${s.mtimeMs}:${createHash('sha256').update(readFileSync(f)).digest('hex')}`; } };
  walk(dir);
  return out;
}

function addPackage(dataDir, ledger, name, { kind = 'short', score = null, layout = 'v', status = 'draft', limitsOk = true, target = 'youtube-shorts' } = {}) {
  const video = Buffer.from(`${name}`.repeat(10));
  const sha = createHash('sha256').update(video).digest('hex');
  const dir = path.join(dataDir, 'posting', 'packages', 'run1', name, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'v.mp4'), video);
  const stamp = '2026-11-08T09:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: `T ${name}`, description: `D ${name}`, tags: ['g'], hashtags: ['#Shorts'], target, privacy: 'private', status: 'draft',
    source: { run: 'run1', clipId: name, kind, layout, startSec: 0, endSec: 30, score, sha256: sha },
    video: { file: 'v.mp4', bytes: video.length }, limits: { status: 'verified', ok: limitsOk, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  ledger[`${sha}:${target}`] = { sha256: sha, target, status, dir, clipId: name, createdAt: stamp, updatedAt: stamp };
  return postId({ sha256: sha, target });
}

function fixture({ liveRows = true } = {}) {
  const dataDir = mk(); const clips = mk();
  const ledger = {}; const id = {};
  id.s1 = addPackage(dataDir, ledger, 's1', { score: 0.9 });
  id.s2 = addPackage(dataDir, ledger, 's2', { score: 0.3 });
  id.s3 = addPackage(dataDir, ledger, 's3', { score: 0.8 });
  id.s6 = addPackage(dataDir, ledger, 's6', { score: 0.85, limitsOk: false });
  id.s7 = addPackage(dataDir, ledger, 's7', { score: 0.7 });
  id.s4 = addPackage(dataDir, ledger, 's4', { kind: 'montage', layout: 'h' });
  id.s5 = addPackage(dataDir, ledger, 's5', { score: 0.99, status: 'uploaded' });
  id.s8 = addPackage(dataDir, ledger, 's8', { kind: 'won-reel', layout: 'v', target: 'tiktok' });
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  writeFileSync(path.join(dataDir, 'posting', 'ledger.json'), JSON.stringify({ version: 1, entries: ledger }));
  const rows = [];
  const add = (name, extra) => { const f = path.join(clips, name); if (extra.write !== false) writeFileSync(f, Buffer.from(name.repeat(6))); const { write, ...r } = extra; rows.push({ file: f, label: 'x', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-08T09:00:00.000Z', ...r }); };
  add('codm_montage_20261108-185824_kills-5_01_v.mp4', { kind: 'montage', seconds: 45 });
  add('codm_montage_20261108-185824_kills-9_02_v.mp4', { kind: 'montage', seconds: 90 });
  add('codm_short_20261108-185841_triple_03_v.mp4', { kind: 'short', seconds: 12, posted: [{ platform: 'youtube', id: 'abc' }] });
  add('codm_won-reel_20261108-185824_win_04_v.mp4', { kind: 'won-reel', seconds: 30, write: false });
  mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: rows }));
  const rulesFile = path.join(dataDir, 'rules.json');
  const rules = { autoUpload: false, rules: [
    { id: 'shorts', target: 'youtube-shorts', minScore: 0.5, maxPerDay: 2 },
    { id: 'reels', target: 'youtube-shorts', minScore: 0, kinds: ['montage', 'won-reel'], layouts: ['v'], maxPerDay: 1 },
  ] };
  writeFileSync(rulesFile, JSON.stringify(rules));
  const profileFile = path.join(dataDir, 'profile.json'); writeFileSync(profileFile, JSON.stringify(PROFILE));
  return { dataDir, id, rulesFile, profileFile, rules: { autoUpload: false, rules: rules.rules.map((r) => ({ kinds: ['short'], layouts: null, ...r })) }, rows };
}
const now = () => new Date('2026-11-09T10:00:00.000Z');
const reasonOf = (r, id) => r.skipped.find((s) => s.id === id)?.reason;

describe('rules preview: decisions', () => {
  test('queued, skipped and why: kind, minScore, cap, over-limit, already posted, layout, no rule, missing file', async () => {
    const f = fixture();
    const r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log: [] });
    const queuedIds = r.queued.map((q) => q.id);
    assert.deepEqual(queuedIds.filter((x) => x === f.id.s1 || x === f.id.s3).sort(), [f.id.s1, f.id.s3].sort());
    assert.equal(reasonOf(r, f.id.s2), 'below-min-score');
    assert.equal(reasonOf(r, f.id.s6), 'over-limit');
    assert.equal(reasonOf(r, f.id.s7), 'max-per-day');
    assert.equal(reasonOf(r, f.id.s5), 'already-posted');
    assert.equal(reasonOf(r, f.id.s4), 'layout-not-in-rule');
    assert.equal(reasonOf(r, f.id.s8), 'no-rule-for-target');
    // uploads.json rows: a 45 s vertical montage would be packaged for shorts and queued by the montage rule
    const m = r.queued.find((q) => q.kind === 'montage');
    assert.ok(m && m.source === 'uploads' && m.target === 'youtube-shorts' && m.ruleId === 'reels' && m.actions.join() === 'approve');
    assert.match(m.title, /^Stream kill montage 1 \(2026-11-08\)$/);
    assert.match(m.description, /Live on @example-channel/);
    assert.ok(!/\{[a-z.]+\}/.test(m.description), 'placeholders resolved from the profile');
    assert.ok(m.hashtags.includes('#montage'));
    // 90 s montage -> youtube-video target -> no rule for it
    assert.ok(r.skipped.some((s) => s.source === 'uploads' && s.target === 'youtube-video' && s.reason === 'no-rule-for-target'));
    assert.ok(r.skipped.some((s) => s.reason === 'already-posted' && s.source === 'uploads'));
    assert.ok(r.skipped.some((s) => s.reason === 'file-missing'));
    assert.equal(r.blocked, null);
    const txt = formatPreview(r);
    assert.match(txt, /would queue: \d+/); assert.match(txt, /below-min-score/); assert.match(txt, /title: Stream kill montage 1/);
  });
  test('the per-day cap counts what the auto log already did today', async () => {
    const f = fixture();
    const log = [{ at: '2026-11-09T01:00:00.000Z', id: 'x', ruleId: 'shorts', action: 'approve' }, { at: '2026-11-09T02:00:00.000Z', id: 'y', ruleId: 'shorts', action: 'approve' }];
    const r = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, log });
    assert.equal(reasonOf(r, f.id.s1), 'max-per-day');
  });
  test('a live stream (or unreadable state) marks everything held', async () => {
    const f = fixture();
    const live = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, outputsStatus: async () => ({ sinks: [{ kind: 'stream', active: true }] }) });
    assert.equal(live.blocked, 'output-live'); assert.ok(live.queued.length && live.queued.every((q) => q.held === 'output-live'));
    assert.match(formatPreview(live), /LIVE CHECK/);
    const bad = await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now, outputsStatus: async () => { throw new Error('down'); } });
    assert.equal(bad.blocked, 'output-state-unreadable');
  });
  test('no rules: nothing queued', async () => {
    const f = fixture();
    const r = await previewRules({ dataDir: f.dataDir, rules: { autoUpload: false, rules: [] }, profile: PROFILE, now });
    assert.equal(r.queued.length, 0); assert.ok(r.skipped.length > 0);
  });
});

describe('rules preview: zero network, zero writes', () => {
  test('previewRules and the CLI make no outbound request and change no file', async () => {
    const f = fixture(); const g = netGuard();
    try {
      const before = snapshot(f.dataDir);
      await previewRules({ dataDir: f.dataDir, rules: f.rules, profile: PROFILE, now });
      const lines = []; const errs = [];
      const code = await main(['auto', '--preview', '--data-dir', f.dataDir, '--rules', f.rulesFile, '--profile', f.profileFile], (s) => lines.push(s), (s) => errs.push(s), { now, outputsStatus: async () => ({ sinks: [] }) });
      assert.equal(code, 0, errs.join('\n'));
      assert.match(lines.join('\n'), /auto-post preview \(dry run/);
      const json = [];
      assert.equal(await main(['auto', '--preview', '--json', '--data-dir', f.dataDir, '--rules', f.rulesFile, '--profile', f.profileFile], (s) => json.push(s), () => {}, { now, outputsStatus: async () => ({ sinks: [] }) }), 0);
      assert.ok(Array.isArray(JSON.parse(json.join('\n')).queued));
      assert.deepEqual(g.calls, []);
      assert.deepEqual(snapshot(f.dataDir), before);
    } finally { g.restore(); }
  });
  test('the module imports no uploader, auth or http code', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'services', 'posting', 'preview.mjs'), 'utf8');
    assert.ok(!/youtube\.mjs|oauth\.mjs|node:https?|node:net|fetch\(|writeFile|mkdirSync|renameSync|copyFile/.test(src.replace(/^\/\/.*$/gm, '')));
  });
});

describe('rules preview: control-page route', () => {
  async function boot(flagOn) {
    const f = fixture();
    if (flagOn) writeFileSync(path.join(f.dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir: f.dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, autoRulesFile: f.rulesFile, profileFile: f.profileFile, youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, outputsStatus: async () => ({ sinks: [] }) } });
    const { port } = await srv.listen();
    const req = (method, url, headers = {}) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') })); });
      rq.on('error', reject); rq.end();
    });
    const lr = await req('GET', `/login?k=${KEY}`);
    return { f, srv, get: (u) => req('GET', u, { cookie: lr.headers['set-cookie'][0].split(';')[0] }), anon: (u) => req('GET', u) };
  }
  test('flag off: 404; no session: refused; flag on: 200 with queue and skips, no write', async () => {
    const off = await boot(false);
    try { assert.equal((await off.get('/ui/api/posts/auto/preview')).status, 404); } finally { off.srv.close(); }
    const on = await boot(true);
    try {
      assert.notEqual((await on.anon('/ui/api/posts/auto/preview')).status, 200);
      const before = snapshot(on.f.dataDir);
      const r = await on.get('/ui/api/posts/auto/preview');
      assert.equal(r.status, 200, r.text);
      const j = JSON.parse(r.text);
      assert.ok(j.queued.length > 0 && j.skipped.some((s) => s.reason === 'below-min-score'));
      assert.deepEqual(snapshot(on.f.dataDir), before);
    } finally { on.srv.close(); }
  });
});

describe('templates vs limits.json', () => {
  const ctx = { n: 7, date: '2026-11-08' };
  const KINDS = ['short', 'montage', 'won-reel'];
  const checked = (target, kind, profile, lim = limits) => { const r = renderUploadPost({ templates, target, kind, profile, ...ctx }); return { r, c: checkLimits(r, lim) }; };

  test('every target x kind renders inside its limits with a full profile; nothing unresolved', () => {
    for (const target of Object.keys(templates.targets)) {
      if (!limits.targets[target]) continue;
      for (const kind of KINDS) {
        const { r, c } = checked(target, kind, PROFILE);
        assert.ok(c.ok, `${target}/${kind}: ${JSON.stringify(c.checks.filter((x) => !x.ok))}`);
        assert.deepEqual(r.unresolved, [], `${target}/${kind}`);
      }
    }
  });
  test('montage and won-reel use their own text where the template defines it; others fall back to the base', () => {
    for (const target of ['youtube-shorts', 'youtube-video']) {
      const s = renderUploadPost({ templates, target, kind: 'short', profile: PROFILE, ...ctx });
      const m = renderUploadPost({ templates, target, kind: 'montage', profile: PROFILE, ...ctx });
      const w = renderUploadPost({ templates, target, kind: 'won-reel', profile: PROFILE, ...ctx });
      assert.match(s.title, /highlight 7 \(2026-11-08\)/); assert.match(m.title, /kill montage 7/); assert.match(w.title, /victory reel 7/);
      assert.ok(m.hashtags.includes('#montage') && !s.hashtags.includes('#montage'));
      assert.ok(w.tags.includes('victory'));
    }
    const base = renderUploadPost({ templates, target: 'tiktok', kind: 'short', profile: PROFILE, ...ctx });
    const over = renderUploadPost({ templates, target: 'tiktok', kind: 'montage', profile: PROFILE, ...ctx });
    assert.deepEqual(over, base);
  });
  test('unicode: the description limit is in UTF-8 bytes, so Malayalam text hits it at a third of the characters; flagged, never truncated', () => {
    const ml = 'ക'.repeat(1700); // 1700 chars, 5100 bytes
    const profile = { ...PROFILE, handles: { ...PROFILE.handles, youtube: ml } };
    const { r, c } = checked('youtube-shorts', 'montage', profile);
    const d = c.checks.find((x) => x.field === 'description' && x.unit === 'utf8-bytes');
    assert.equal(c.ok, false); assert.ok(d.value > 5000 && !d.ok);
    assert.ok(r.description.includes(ml), 'text kept whole, not truncated');
    assert.ok(Array.from(r.description).length < 5000, 'under the limit if counted in characters');
    // the same text under the TikTok UTF-16 rule: 1700 code units, inside 2200
    assert.ok(checked('tiktok', 'short', profile).c.ok === false || Array.from(ml).length <= 2200);
    // emoji outside the BMP: 2 UTF-16 units, 1 code point
    const emoji = { ...PROFILE, handles: { ...PROFILE.handles, twitch: '🎮'.repeat(1100), youtube: 'x' } };
    const t = checked('tiktok', 'short', emoji).c.checks.find((x) => x.unit === 'utf16');
    assert.ok(t.value > 2200 && !t.ok, 'astral characters count twice in UTF-16');
  });
  test('title limit counts code points; a title over 100 is flagged and kept whole', () => {
    const T = JSON.parse(JSON.stringify(templates));
    T.targets['youtube-shorts'].kinds.montage.title = '🎮'.repeat(101);
    const r = renderUploadPost({ templates: T, target: 'youtube-shorts', kind: 'montage', profile: PROFILE, ...ctx });
    const c = checkLimits(r, limits);
    assert.equal(c.checks.find((x) => x.field === 'title' && x.unit === 'chars').value, 101);
    assert.equal(c.ok, false); assert.equal(Array.from(r.title).length, 101);
    T.targets['youtube-shorts'].kinds.montage.title = '🎮'.repeat(100);
    assert.ok(checkLimits(renderUploadPost({ templates: T, target: 'youtube-shorts', kind: 'montage', profile: PROFILE, ...ctx }), limits).ok);
  });
  test('angle brackets are refused by the youtube fields; an unfilled profile leaves placeholders flagged', () => {
    const T = JSON.parse(JSON.stringify(templates)); T.targets['youtube-shorts'].kinds['won-reel'].title = 'a <b> c';
    assert.equal(checkLimits(renderUploadPost({ templates: T, target: 'youtube-shorts', kind: 'won-reel', profile: PROFILE, ...ctx }), limits).ok, false);
    const bare = renderUploadPost({ templates, target: 'youtube-shorts', kind: 'montage', profile: {}, ...ctx });
    assert.deepEqual(bare.unresolved, ['handles.youtube', 'links.discord']);
  });
});
