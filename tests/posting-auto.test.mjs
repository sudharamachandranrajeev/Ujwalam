// SPDX-License-Identifier: GPL-3.0-or-later
// F7 auto-post-approved-rules. Fakes only: no network, no Google, no Credential Manager.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAutoLog, loadRules, liveBlock, planAuto, runAuto, validateRules, DEFAULT_RULES } from '../services/posting/auto-post.mjs';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { main } from '../services/posting/cli.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-f7a-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const NOW = new Date('2026-11-05T20:00:00.000Z');
const RULE = { id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 2 };

/** specs: [{ clip, score, layout?, target?, over? }] -> { dataDir, store, ids, shas } */
function fixture(specs) {
  const dataDir = mk(); const entries = {}; const ids = {}; const shas = {};
  specs.forEach((sp) => {
    const target = sp.target ?? 'youtube-shorts';
    const video = Buffer.from(`video-${sp.clip}`.repeat(5));
    const sha = createHash('sha256').update(video).digest('hex');
    const dir = path.join(mk(), 'posts', sp.clip, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'full-crop.mp4'), video);
    const stamp = '2026-11-05T18:00:00.000Z';
    writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
      version: 1, title: 'T', description: 'D', tags: ['g'], hashtags: ['#Shorts'], target, privacy: 'private', status: 'draft',
      source: { run: 'r', clipId: sp.clip, layout: sp.layout ?? 'full-crop', startSec: 1, endSec: 3, score: sp.score, sha256: sha },
      video: { file: 'full-crop.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: sp.over ? ['handles.x'] : [], createdAt: stamp, updatedAt: stamp,
    }));
    entries[`${sha}:${target}`] = { sha256: sha, target, status: 'draft', dir, clipId: sp.clip, createdAt: stamp, updatedAt: stamp };
    ids[sp.clip] = postId({ sha256: sha, target }); shas[sp.clip] = sha;
  });
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries }));
  return { dataDir, ids, shas, ledgerFile, logFile: path.join(dataDir, 'posting', 'auto-log.json'), store: createPostStore({ ledgerFile }) };
}
const idle = async () => ({ sinks: [{ kind: 'stream', state: 'idle', active: false }] });

describe('rules file', () => {
  test('shipped rules are empty, proposed, autoUpload off', () => {
    const j = JSON.parse(readFileSync(DEFAULT_RULES, 'utf8'));
    assert.deepEqual(j.rules, []); assert.equal(j.autoUpload, false); assert.equal(j.status, 'proposed');
    assert.deepEqual(loadRules(), { autoUpload: false, rules: [] });
  });
  test('validation rejects bad rules', () => {
    for (const bad of [{ rules: [{ ...RULE, maxPerDay: 0 }] }, { rules: [{ ...RULE, maxPerDay: 99 }] }, { rules: [{ ...RULE, minScore: 'x' }] }, { rules: [RULE, RULE] }, { rules: [{ ...RULE, id: 'A B' }] }, { rules: [], autoUpload: 'yes' }, {}])
      assert.throws(() => validateRules(bad), { code: 'bad-rules' });
  });
});

describe('planAuto', () => {
  test('approves matching drafts best first, honours max per day, skips low score / unresolved / wrong layout', () => {
    const f = fixture([{ clip: 'a', score: 9 }, { clip: 'b', score: 7 }, { clip: 'c', score: 6 }, { clip: 'd', score: 1 }, { clip: 'e', score: 8, over: true }, { clip: 'f', score: 8, layout: 'blurred-fill' }, { clip: 'g', score: 8, target: 'tiktok' }]);
    const plan = planAuto({ posts: f.store.list(), rules: [{ ...RULE, layouts: ['full-crop'] }], autoUpload: false, log: [], now: NOW });
    const act = (a) => plan.filter((p) => p.action === a).map((p) => p.id);
    assert.deepEqual(act('approve'), [f.ids.a, f.ids.b]);
    assert.ok(plan.some((p) => p.id === f.ids.c && p.reason === 'max-per-day'));
    assert.ok(plan.some((p) => p.id === f.ids.e && p.reason === 'unresolved-placeholders'));
    assert.ok(!plan.some((p) => [f.ids.d, f.ids.f, f.ids.g].includes(p.id)));
  });
  test('log entries today count against the cap; other days do not', () => {
    const f = fixture([{ clip: 'a', score: 9 }]);
    const mkLog = (at) => [{ at, id: 'x', ruleId: 'top', action: 'approve' }, { at, id: 'y', ruleId: 'top', action: 'approve' }];
    assert.equal(planAuto({ posts: f.store.list(), rules: [RULE], autoUpload: false, log: mkLog('2026-11-05T01:00:00Z'), now: NOW }).filter((p) => p.action === 'approve').length, 0);
    assert.equal(planAuto({ posts: f.store.list(), rules: [RULE], autoUpload: false, log: mkLog('2026-11-04T23:00:00Z'), now: NOW }).filter((p) => p.action === 'approve').length, 1);
  });
});

describe('liveBlock (fail closed)', () => {
  test('idle ok; live, starting, any active sink, throw, malformed all block', async () => {
    assert.equal(await liveBlock(idle), null);
    assert.equal(await liveBlock(async () => ({ sinks: [{ kind: 'stream', state: 'starting' }] })), 'output-live');
    assert.equal(await liveBlock(async () => ({ sinks: [{ kind: 'record', active: true }] })), 'output-live');
    assert.equal(await liveBlock(async () => { throw new Error('down'); }), 'output-state-unreadable');
    assert.equal(await liveBlock(async () => ({})), 'output-state-unreadable');
    assert.equal(await liveBlock(async () => null), 'output-state-unreadable');
  });
});

describe('runAuto', () => {
  test('approve only (autoUpload off): approves, logs reason, never calls upload', async () => {
    const f = fixture([{ clip: 'a', score: 9 }, { clip: 'b', score: 2 }]);
    let uploads = 0;
    const r = await runAuto({ store: f.store, rules: { autoUpload: false, rules: [RULE] }, outputsStatus: idle, upload: async () => { uploads++; }, logFile: f.logFile, now: () => NOW });
    assert.equal(r.refused, null); assert.equal(uploads, 0);
    assert.equal(f.store.get(f.ids.a).status, 'approved'); assert.equal(f.store.get(f.ids.b).status, 'draft');
    const log = createAutoLog(f.logFile).list();
    assert.equal(log.length, 1); assert.equal(log[0].action, 'approve'); assert.match(log[0].reason, /score 9/); assert.equal(log[0].ruleId, 'top');
    const r2 = await runAuto({ store: f.store, rules: { autoUpload: false, rules: [RULE] }, outputsStatus: idle, logFile: f.logFile, now: () => NOW });
    assert.deepEqual(r2.done, []);
  });
  test('autoUpload on: uploads once, logged before the call; second run does not repeat; hand-approved posts untouched', async () => {
    const f = fixture([{ clip: 'a', score: 9 }, { clip: 'm', score: 1 }]);
    assert.equal(typeof await f.store.setStatus(f.ids.m, 'approved'), 'object'); // approved by hand, below the score
    const seen = [];
    const upload = async (id) => {
      seen.push({ id, logged: createAutoLog(f.logFile).list().some((e) => e.action === 'upload' && e.id === id) });
      f.store.ledger.setStatus(f.shas.a, 'youtube-shorts', 'uploaded', NOW.toISOString());
    };
    const opts = { store: f.store, rules: { autoUpload: true, rules: [RULE] }, outputsStatus: idle, upload, logFile: f.logFile, now: () => NOW };
    await runAuto(opts);
    assert.deepEqual(seen, [{ id: f.ids.a, logged: true }]);
    await runAuto(opts);
    assert.equal(seen.length, 1);
    assert.deepEqual(createAutoLog(f.logFile).list().map((e) => e.action), ['approve', 'upload']);
    assert.equal(f.store.get(f.ids.m).status, 'approved');
  });
  test('upload failure is logged and ends uploads; no retry on the next run', async () => {
    const f = fixture([{ clip: 'a', score: 9 }, { clip: 'b', score: 8 }]);
    const tried = [];
    const opts = { store: f.store, rules: { autoUpload: true, rules: [{ ...RULE, maxPerDay: 5 }] }, outputsStatus: idle, upload: async (id) => { tried.push(id); throw Object.assign(new Error('x'), { code: 'oauth-reauth-needed' }); }, logFile: f.logFile, now: () => NOW };
    await runAuto(opts); await runAuto(opts);
    assert.deepEqual(tried, [f.ids.a, f.ids.b]); // run 1 stops after the failure; run 2 never retries the failed post
    assert.ok(createAutoLog(f.logFile).list().some((e) => e.action === 'upload-failed' && e.reason === 'oauth-reauth-needed'));
  });
  test('live or unreadable output: refuses everything, nothing approved, nothing logged', async () => {
    for (const outputsStatus of [async () => ({ sinks: [{ kind: 'stream', state: 'live' }] }), async () => { throw new Error('x'); }]) {
      const f = fixture([{ clip: 'a', score: 9 }]);
      let n = 0;
      const r = await runAuto({ store: f.store, rules: { autoUpload: true, rules: [RULE] }, outputsStatus, upload: async () => { n++; }, logFile: f.logFile, now: () => NOW });
      assert.ok(r.refused); assert.equal(n, 0); assert.equal(f.store.get(f.ids.a).status, 'draft'); assert.deepEqual(createAutoLog(f.logFile).list(), []);
    }
  });
  test('stream starts mid-run: the upload is refused', async () => {
    const f = fixture([{ clip: 'a', score: 9 }]);
    let calls = 0; let n = 0;
    const outputsStatus = async () => ({ sinks: [{ kind: 'stream', state: ++calls >= 2 ? 'starting' : 'idle' }] });
    await runAuto({ store: f.store, rules: { autoUpload: true, rules: [RULE] }, outputsStatus, upload: async () => { n++; }, logFile: f.logFile, now: () => NOW });
    assert.equal(n, 0);
    assert.ok(createAutoLog(f.logFile).list().some((e) => e.action === 'upload-refused'));
  });
});

describe('cli auto', () => {
  const run = async (argv, deps) => { const o = []; const e = []; const code = await main(argv, (s) => o.push(s), (s) => e.push(s), deps); return { code, o, e }; };
  test('dry run lists and changes nothing, even with flags off; --run exits 3 with flags off', async () => {
    const f = fixture([{ clip: 'a', score: 9 }]);
    const d = await run(['auto', '--data-dir', f.dataDir], { rules: { autoUpload: false, rules: [RULE] }, now: () => NOW });
    assert.equal(d.code, 0); assert.match(d.o[0], /off/); assert.ok(d.o.some((l) => l.includes('approve')));
    assert.equal(f.store.get(f.ids.a).status, 'draft');
    const r = await run(['auto', '--run', '--data-dir', f.dataDir], { rules: { autoUpload: false, rules: [RULE] }, outputsStatus: idle });
    assert.equal(r.code, 3); assert.equal(f.store.get(f.ids.a).status, 'draft');
  });
  test('--run with both flags on: shipped empty rules do nothing; a rule approves; unreadable outputs refuse', async () => {
    const f = fixture([{ clip: 'a', score: 9 }]);
    writeFileSync(path.join(f.dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true, 'auto-post': true } }));
    const none = await run(['auto', '--run', '--data-dir', f.dataDir], { outputsStatus: idle });
    assert.equal(none.code, 0); assert.match(none.o[0], /no rules/); assert.equal(f.store.get(f.ids.a).status, 'draft');
    const live = await run(['auto', '--run', '--data-dir', f.dataDir], { rules: { autoUpload: false, rules: [RULE] }, outputsStatus: async () => { throw new Error('x'); } });
    assert.equal(live.code, 1); assert.equal(f.store.get(f.ids.a).status, 'draft');
    const go = await run(['auto', '--run', '--data-dir', f.dataDir], { rules: { autoUpload: false, rules: [RULE] }, outputsStatus: idle });
    assert.equal(go.code, 0); assert.equal(f.store.get(f.ids.a).status, 'approved');
  });
});

describe('studio route + UI source', () => {
  function get(port, url, cookie) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: url, headers: cookie ? { host: `127.0.0.1:${port}`, cookie } : { host: `127.0.0.1:${port}` } }, (res) => {
        const c = []; res.on('data', (b) => c.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString() }));
      }).on('error', reject);
    });
  }
  test('GET /ui/api/posts/auto is read-only and shows the dry run', async () => {
    const f = fixture([{ clip: 'a', score: 9 }]);
    writeFileSync(path.join(f.dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
    const rulesFile = path.join(f.dataDir, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ autoUpload: false, rules: [RULE] }));
    const KEY = 'k'.repeat(48);
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir: f.dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, autoRulesFile: rulesFile });
    const { port } = await srv.listen();
    try {
      const lr = await get(port, `/login?k=${KEY}`);
      const cookie = lr.headers['set-cookie'][0].split(';')[0];
      const r = await get(port, '/ui/api/posts/auto', cookie);
      assert.equal(r.status, 200);
      const j = JSON.parse(r.text);
      assert.equal(j.mode.enabled, false); assert.equal(j.mode.ruleCount, 1); assert.equal(j.mode.privacy, 'private');
      assert.deepEqual(j.plan.map((p) => p.action), ['approve']);
      assert.equal(f.store.get(f.ids.a).status, 'draft');
    } finally { srv.close(); }
  });
  test('UI code uses no innerHTML for the auto-post display', () => {
    const app = readFileSync(path.join(UI, 'js', 'app.js'), 'utf8');
    const part = app.slice(app.indexOf('function loadAuto'), app.indexOf('function openPosts'));
    assert.ok(part.length > 50); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(part));
  });
});
