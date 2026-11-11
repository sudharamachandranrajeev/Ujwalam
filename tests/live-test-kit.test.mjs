// SPDX-License-Identifier: GPL-3.0-or-later
// Live test kit (D305 proposed, flag `live-test-kit`; services/studio-ui/live-test-kit.mjs). Headless: a fake host, a
// temporary chat database with placeholder names, 127.0.0.1 only. Nothing goes live, nothing is posted, spoken or sent
// to Streamer.bot or Speaker.bot.
process.env.UJWALAM_HEADLESS = '1';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createFlags, loadDefinitions } from '../services/flags/index.mjs';
import { TEST_KIT_FLAG, createFeedbackAutoCollect, liveAlerts, loadTestKitConfig, runCollectorChild } from '../services/studio-ui/live-test-kit.mjs';
import { REPO_FILES } from '../tools/package/manifest.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const REPO = path.resolve(UI, '..');
const KEY = 'k'.repeat(48);
const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-kit-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const KIT = loadTestKitConfig();

describe('config and flag', () => {
  test('data/live/test-kit.json loads; the question starts with its prefix; every value has a source', () => {
    assert.ok(KIT.question.startsWith(KIT.questionPrefix));
    assert.match(KIT.announcement, /new streaming software/);
    assert.equal(KIT.marker, 'fb:');
    const raw = JSON.parse(readFileSync(path.join(REPO, 'data', 'live', 'test-kit.json'), 'utf8'));
    assert.equal(raw.status, 'unverified');
    for (const k of ['streamerbotAction', 'announcement', 'question', 'marker', 'windowMin', 'reminderMin']) assert.equal(typeof raw.source[k], 'string', k);
  });
  test('the action name and the texts are data: none of them is written in the module', () => {
    const src = readFileSync(path.join(REPO, 'services', 'studio-ui', 'live-test-kit.mjs'), 'utf8');
    for (const v of [KIT.streamerbotAction, KIT.question, KIT.announcement, KIT.questionPrefix]) assert.ok(!src.includes(v), v);
  });
  test('a bad file is refused', () => {
    const d = mk();
    const f = path.join(d, 'k.json');
    for (const bad of [{ ...KIT, question: 'other text' }, { ...KIT, windowMin: 0 }, { ...KIT, streamerbotAction: '' }]) {
      writeFileSync(f, JSON.stringify(bad));
      assert.throws(() => loadTestKitConfig(f), /test kit config/);
    }
    writeFileSync(f, JSON.stringify(KIT));
    assert.deepEqual(loadTestKitConfig(f), KIT);
  });
  test('flag live-test-kit exists and is off by default', () => {
    const f = loadDefinitions().find((x) => x.id === TEST_KIT_FLAG);
    assert.ok(f, 'flag defined');
    assert.equal(f.default, false);
  });
  test('the package carries the config, the collector and the live limits files', () => {
    for (const f of ['data/live/test-kit.json', 'tools/collect-stream-feedback.mjs', 'data/live/readiness.json', 'data/live/recovery.json']) assert.ok(REPO_FILES.includes(f), f);
  });
});

describe('liveAlerts (pure)', () => {
  const T = Date.parse('2026-11-09T18:00:00Z');
  test('nothing to say: empty list', () => {
    assert.deepEqual(liveAlerts({ host: { live: false } }, { kit: KIT, nowMs: T }), []);
  });
  test('audio warnings become plain-words lines; a recovery event comes first', () => {
    const a = liveAlerts({
      host: { live: true, audioHealth: { ok: false, warnings: ['Game audio missing', 7, ''] } },
      recovery: { result: 'partial', text: 'Host crashed at 18:02, streams restarted: YouTube H; NOT restarted: Kick (start them from the control page)', count: 1 },
    }, { kit: KIT, nowMs: T, liveSinceMs: null });
    assert.deepEqual(a.map((x) => [x.id, x.level]), [['recovery', 'error'], ['audio-0', 'warn']]);
    assert.match(a[1].text, /^Sound problem: Game audio missing\. /);
    assert.match(a[0].text, /NOT restarted: Kick/);
    const ok = liveAlerts({ host: {}, recovery: { result: 'restarted', text: 'Host crashed at 18:02, streams restarted: Twitch' } }, { kit: KIT, nowMs: T });
    assert.equal(ok[0].level, 'warn');
  });
  test('the Streamer.bot reminder shows only while live and only for reminderMin', () => {
    const at = (min) => liveAlerts({ host: { live: true } }, { kit: KIT, liveSinceMs: T, nowMs: T + min * 60_000 });
    assert.equal(at(1).length, 1);
    assert.equal(at(1)[0].id, 'test-action');
    assert.ok(at(1)[0].text.includes(`"${KIT.streamerbotAction}"`));
    assert.match(at(1)[0].text, /Ujwalam does not post or speak/);
    assert.deepEqual(at(KIT.reminderMin + 1), []);
    assert.deepEqual(liveAlerts({ host: { live: false } }, { kit: KIT, liveSinceMs: T, nowMs: T + 60_000 }), []);
    assert.deepEqual(liveAlerts({ host: { live: true } }, { kit: null, liveSinceMs: T, nowMs: T + 60_000 }), [], 'no config: no reminder');
  });
  test('feedback result after the stream (saved or failed)', () => {
    const ok = liveAlerts({ host: { live: false } }, { kit: KIT, feedback: { ok: true, total: 3, counts: { youtube: 1, twitch: 1, kick: 1 }, name: '2026-11-09-stream-feedback.md' } });
    assert.match(ok[0].text, /Viewer feedback saved: 3 message\(s\) \(YouTube 1, Twitch 1, Kick 1\) in feedback\/2026-11-09-stream-feedback\.md/);
    const bad = liveAlerts({ host: { live: false } }, { kit: KIT, feedback: { ok: false, error: 'chat database not found: x' } });
    assert.equal(bad[0].level, 'warn');
    assert.match(bad[0].text, /not collected/);
    assert.deepEqual(liveAlerts({ host: { live: true } }, { kit: KIT, feedback: { ok: true, total: 1, counts: { youtube: 1, twitch: 0, kick: 0 }, name: 'x.md' } }), [], 'not while live');
  });
});

// Chat rows with placeholder names; the question text comes from the config.
function mkDb(dir, t0) {
  const file = path.join(dir, 'event-core.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE chat_raw (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, platform TEXT NOT NULL, display_name TEXT, text TEXT)');
  const ins = db.prepare('INSERT INTO chat_raw VALUES (?, ?, ?, ?, ?)');
  const m = (n) => t0 + n * 60_000;
  ins.run('q1', m(1), 'twitch', 'bot-1', KIT.question);
  ins.run('r1', m(2), 'youtube', 'viewer-1', 'video looks sharp');
  ins.run('r2', m(3), 'kick', 'viewer-2', 'audio fine');
  ins.run('r3', m(40), 'twitch', 'viewer-3', 'fb: scene switch was slow');
  ins.run('n1', m(30), 'youtube', 'viewer-4', 'unrelated chatter');
  ins.run('o1', m(-90), 'kick', 'viewer-5', 'fb: before the stream');
  db.close();
  return file;
}

const until = async (pred, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) assert.fail('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); }
};
// Stand-ins for the collector script: busy for ms (blocks its own process only), then one JSON result line.
function slowScript(dir, ms) {
  const f = path.join(dir, `slow-${ms}.mjs`);
  writeFileSync(f, `const end = Date.now() + ${ms}; while (Date.now() < end) {}
console.log(JSON.stringify({ file: 'x/2026-11-09-stream-feedback.md', total: 1, added: 1, counts: { youtube: 1, twitch: 0, kick: 0, other: 0 } }));
`);
  return f;
}

describe('createFeedbackAutoCollect', () => {
  const tick = () => new Promise((r) => setImmediate(r));
  test('runCollectorChild: a collector that runs too long is killed and reported', async () => {
    const d = mk();
    const t0 = Date.now();
    await assert.rejects(runCollectorChild({ dbFile: 'x', date: '2026-11-09', since: 'a', until: 'b', marker: 'fb:', windowMin: 10, questionPrefix: 'q', outDir: d },
      { script: slowScript(d, 10_000), timeoutMs: 400 }), /collector timed out after 0 s/);
    assert.ok(Date.now() - t0 < 5000, 'not waited out');
  });
  test('runCollectorChild: the collector source starts its children hidden', () => {
    const src = readFileSync(path.join(REPO, 'services', 'studio-ui', 'live-test-kit.mjs'), 'utf8');
    assert.match(src, /spawn\(execPath, args, \{ windowsHide: true/);
  });
  test('live -> offline with the flag on: replies of that stream are collected once (child process), read-only, into the feedback folder', async () => {
    const d = mk();
    const t0 = Date.parse('2026-11-09T18:00:00Z');
    mkDb(d, t0);
    let t = t0; let on = true;
    const outDir = path.join(d, 'feedback');
    // no collect seam: the default runs tools/collect-stream-feedback.mjs in a child process
    const fc = createFeedbackAutoCollect({ dbFile: path.join(d, 'event-core.db'), outDir, kit: () => KIT, enabled: () => on, now: () => t, learningDataDir: d });
    fc.observe(false);
    fc.observe(true);
    assert.equal(fc.liveSince(), t0);
    t = t0 + 60 * 60_000;
    fc.observe(true);
    fc.observe(false);
    await until(() => fc.last() !== null);
    const last = fc.last();
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.equal(last.total, 3);
    assert.deepEqual(last.counts, { youtube: 1, twitch: 1, kick: 1, other: 0 });
    const files = path.join(outDir, last.name);
    assert.ok(existsSync(files));
    const md = readFileSync(files, 'utf8');
    for (const id of ['r1', 'r2', 'r3']) assert.ok(md.includes(`<!--id:${id}-->`), id);
    for (const id of ['q1', 'n1', 'o1']) assert.ok(!md.includes(`<!--id:${id}-->`), id);
    // LL2 (D338): the child also wrote one chat-feedback label row per reply into <dataDir>/learning-store/stream-<start>/
    const sess = readdirSync(path.join(d, 'learning-store')).filter((n) => n.startsWith('stream-'));
    assert.equal(sess.length, 1);
    const rows = readFileSync(path.join(d, 'learning-store', sess[0], 'labels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => [x.action, x.source, x.ref.message]).sort(), [['feedback', 'chat-feedback', 'r1'], ['feedback', 'chat-feedback', 'r2'], ['feedback', 'chat-feedback', 'r3']]);
    // a second offline poll does nothing; the next live start clears the result
    fc.observe(false);
    await tick();
    assert.equal(fc.last().total, 3);
    fc.observe(true);
    assert.equal(fc.last(), null);
    // flag off: a stream end collects nothing
    on = false;
    t += 60_000;
    fc.observe(false);
    await tick();
    assert.equal(fc.last(), null);
  });
  test('a missing database is a failed result, never a throw', async () => {
    const d = mk();
    let t = 1_000;
    const fc = createFeedbackAutoCollect({ dbFile: path.join(d, 'nope.db'), outDir: d, kit: () => KIT, enabled: () => true, now: () => t });
    fc.observe(true); t += 1000; fc.observe(false);
    await until(() => fc.last() !== null);
    assert.equal(fc.last().ok, false);
    assert.match(fc.last().error, /chat database not found/);
  });
});

// ---- server: alerts in the status snapshot ----
function raw(port, { url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end();
  });
}
const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function boot({ flagOn, collectImpl = null }) {
  const dataDir = mk();
  if (flagOn) createFlags({ dataDir }).set(TEST_KIT_FLAG, true);
  const fake = createFakeHost({ outputsReady: true });
  const st = { live: false, audio: null };
  const host = {
    describe: () => fake.describe(),
    async call(m, p) {
      const r = await fake.call(m, p);
      return m === 'host.status' ? { ...r, live: st.live, ...(st.audio ? { audioHealth: st.audio } : {}) } : r;
    },
  };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const collected = [];
  const collect = collectImpl ? (o) => { collected.push(o); return collectImpl(o); } : (o) => { collected.push(o); return { file: path.join(o.outDir, `${o.date}-stream-feedback.md`), total: 2, added: 2, counts: { youtube: 1, twitch: 0, kick: 1, other: 0 } }; };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, feedbackDir: path.join(dataDir, 'fb'), testKit: { kit: KIT, collect }, limits: { statusPollMs: 30 }, log: () => {} });
  servers.push(srv);
  const { port } = await srv.listen();
  const r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } }, resolve));
  r.resume();
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const status = async () => (await raw(port, { url: '/ui/api/status', headers: { cookie } })).json();
  const until = async (pred, what) => {
    const end = Date.now() + 3000;
    for (;;) { const s = await status(); if (pred(s)) return s; if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(s.alerts)}`); await new Promise((x) => setTimeout(x, 40)); }
  };
  return { st, status, until, collected, dataDir };
}

describe('server: status alerts', () => {
  test('flag off (the default): no alerts field and no collection at stream end', async () => {
    const s = await boot({ flagOn: false });
    s.st.audio = { warnings: ['Game audio missing'], sources: [] };
    s.st.live = true;
    await new Promise((r) => setTimeout(r, 120));
    s.st.live = false;
    await new Promise((r) => setTimeout(r, 150));
    const snap = await s.status();
    assert.equal(snap.alerts, undefined);
    assert.equal(s.collected.length, 0);
  });
  test('flag on: audio warning, test-action reminder while live, feedback result after the stream', async () => {
    const s = await boot({ flagOn: true });
    s.st.audio = { warnings: ['Game audio missing'], sources: [] };
    s.st.live = true;
    const liveSnap = await s.until((x) => Array.isArray(x.alerts) && x.alerts.some((a) => a.id === 'test-action'), 'reminder while live');
    assert.ok(liveSnap.alerts.some((a) => a.id === 'audio-0' && /Sound problem: Game audio missing/.test(a.text)));
    s.st.audio = null;
    s.st.live = false;
    const after = await s.until((x) => Array.isArray(x.alerts) && x.alerts.some((a) => a.id === 'feedback'), 'feedback after the stream');
    assert.match(after.alerts.find((a) => a.id === 'feedback').text, /Viewer feedback saved: 2 message\(s\)/);
    assert.ok(!after.alerts.some((a) => a.id === 'test-action'));
    assert.equal(s.collected.length, 1);
    const c = s.collected[0];
    assert.equal(c.dbFile, path.join(s.dataDir, 'event-core.db'));
    assert.equal(c.outDir, path.join(s.dataDir, 'fb'));
    assert.equal(c.questionPrefix, KIT.questionPrefix);
    assert.equal(c.marker, KIT.marker);
    assert.ok(Date.parse(c.since) < Date.parse(c.until));
  });
  test('a slow collection (child process busy 2.5 s) never stalls the status poll', async () => {
    const d = mk();
    const script = slowScript(d, 2500);
    let childDone = false;
    const s = await boot({ flagOn: true, collectImpl: (o) => runCollectorChild(o, { script }).finally(() => { childDone = true; }) });
    s.st.live = true;
    await s.until((x) => Array.isArray(x.alerts) && x.alerts.some((a) => a.id === 'test-action'), 'live');
    s.st.live = false;
    await until(() => s.collected.length === 1, 3000);
    const times = [];
    while (!childDone) {
      const t0 = Date.now();
      const snap = await s.status();
      times.push(Date.now() - t0);
      assert.equal(snap.host.live, false);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(times.length >= 10, `polled ${times.length} times while the collector ran`);
    assert.ok(Math.max(...times) < 500, `slowest status answer ${Math.max(...times)} ms`);
    const after = await s.until((x) => Array.isArray(x.alerts) && x.alerts.some((a) => a.id === 'feedback'), 'result recorded');
    assert.match(after.alerts.find((a) => a.id === 'feedback').text, /Viewer feedback saved: 1 message\(s\)/);
  });
});
