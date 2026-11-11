// SPDX-License-Identifier: GPL-3.0-or-later
// LL2 learning signals (D338): every signal the user already gives becomes a label row in the local learning store;
// the 5 GB cap (LL1) removes the oldest stream folders first. Temp folders only, placeholder names, no network.
process.env.UJWALAM_HEADLESS = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CAP_BYTES, createLearningStore, makeRow, sessionId } from '../services/learning/store.mjs';
import { createLearningSignals } from '../services/learning/signals.mjs';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { uploadPost } from '../services/posting/youtube.mjs';
import { collectFeedback } from '../tools/collect-stream-feedback.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-ll2-'));
const rowsOf = (dataDir, session) => createLearningStore({ dataDir }).rows(session);

test('store: rows are validated; only the five actions and known sources; refs keep short primitives only', () => {
  assert.equal(makeRow({ action: 'liked', source: 'my-clips', session: 's' }), 'bad-action');
  assert.equal(makeRow({ action: 'kept', source: 'guess', session: 's' }), 'bad-source');
  assert.equal(makeRow({ action: 'kept', source: 'my-clips', session: '../x' }).session, 'x', 'unsafe characters dropped');
  assert.equal(makeRow({ action: 'kept', source: 'my-clips', session: '..' }), 'bad-session');
  assert.equal(sessionId('a b/c'), 'a_b_c');
  const r = makeRow({ action: 'kept', source: 'my-clips', session: 's', at: new Date(0), ref: { file: 'x'.repeat(999), deep: { a: 1 }, n: 2, 'bad key': 1 } });
  assert.deepEqual(Object.keys(r.ref), ['file', 'n']);
  assert.equal(r.ref.file.length, 260);
  assert.equal(r.at, '1970-01-01T00:00:00.000Z');
  assert.equal(CAP_BYTES, 5 * 1024 ** 3, 'the user\'s 5 GB cap');
});

test('cap (LL1 hook): oldest stream folders go first until the store fits; the newest is never removed', () => {
  const dataDir = tmp();
  try {
    const store = createLearningStore({ dataDir, capBytes: 2500 });
    const t0 = Date.parse('2026-11-01T00:00:00Z') / 1000;
    ['s1', 's2', 's3', 's4'].forEach((s, i) => {
      store.add({ action: 'kept', source: 'my-clips', session: s, ref: { file: 'x' } });
      const f = path.join(store.root, s, 'evidence.bin');
      writeFileSync(f, Buffer.alloc(1000));
      utimesSync(f, t0 + i * 60, t0 + i * 60);
      utimesSync(path.join(store.root, s, 'labels.jsonl'), t0 + i * 60, t0 + i * 60);
    });
    const r = store.enforceCap();
    assert.deepEqual(r.removed, ['s1', 's2']);
    assert.ok(r.total <= 2500);
    assert.deepEqual(store.sessions(), ['s3', 's4']);
    // only one folder left over the cap: the newest one stays
    const one = createLearningStore({ dataDir, capBytes: 10 });
    assert.deepEqual(one.enforceCap().removed, ['s3']);
    assert.deepEqual(one.sessions(), ['s4']);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// A clips folder laid out like services/clip/clip_publish.py: run folder file hard-linked into <clips>/<day>/<name>.
function publishClips(dataDir, names, addedAt) {
  const clips = path.join(dataDir, 'clips');
  const run = path.join(clips, 'runs', 'rec-h-20261110-200000', 'clips');
  const day = path.join(clips, '2026-11-10');
  mkdirSync(run, { recursive: true }); mkdirSync(day, { recursive: true });
  const files = names.map((n, i) => {
    const src = path.join(run, `c${i}.mp4`);
    writeFileSync(src, Buffer.alloc(100 + i, i));
    const dst = path.join(day, n);
    linkSync(src, dst); // like clip_publish.py: the run folder keeps the same file (same id) under its own name
    return dst;
  });
  writeFileSync(path.join(clips, 'uploads.json'), JSON.stringify({ version: 1, files: files.map((file) => ({ file, kind: 'short', label: 'x', seconds: 10, run: 'rec-h-20261110-200000', recording: null, posted: [], addedAt })) }));
  return files;
}

test('My clips: kept (at a later app start), deleted and renamed each become one label row', async () => {
  const dataDir = tmp();
  try {
    const [a, b, c] = publishClips(dataDir, ['game_short_a_01_v.mp4', 'game_short_b_02_v.mp4', 'game_short_c_03_v.mp4'], '2026-11-10T20:30:00+00:00');
    // First app start after the clips were published: all three are still there -> kept.
    let now = new Date('2026-11-11T09:00:00Z');
    const sig = createLearningSignals({ dataDir, now: () => now });
    let r = sig.tick({ startup: true });
    assert.deepEqual(r.rows.map((x) => [x.action, x.ref.file]).sort(), [['kept', 'game_short_a_01_v.mp4'], ['kept', 'game_short_b_02_v.mp4'], ['kept', 'game_short_c_03_v.mp4']]);
    assert.ok(r.rows.every((x) => x.source === 'my-clips' && x.session === 'rec-h-20261110-200000' && x.ref.run === 'rec-h-20261110-200000'));
    assert.equal(sig.tick().rows.length, 0, 'nothing changed: no new rows');
    // The user renames one in Explorer and deletes another.
    now = new Date('2026-11-11T09:05:00Z');
    const renamed = path.join(path.dirname(b), 'best kill.mp4');
    renameSync(b, renamed);
    unlinkSync(c);
    r = sig.tick();
    const by = Object.fromEntries(r.rows.map((x) => [x.action, x]));
    assert.equal(r.rows.length, 2);
    assert.deepEqual(by.renamed.ref, { run: 'rec-h-20261110-200000', kind: 'short', from: 'game_short_b_02_v.mp4', to: 'best kill.mp4' });
    assert.equal(by.deleted.ref.file, 'game_short_c_03_v.mp4');
    assert.equal(by.renamed.at, '2026-11-11T09:05:00.000Z');
    // A second rename follows the new name; a later delete of the renamed clip is a delete.
    const again = path.join(path.dirname(b), 'best kill 2.mp4');
    renameSync(renamed, again);
    assert.deepEqual(sig.tick().rows.map((x) => [x.action, x.ref.from, x.ref.to]), [['renamed', 'best kill.mp4', 'best kill 2.mp4']]);
    unlinkSync(again);
    assert.deepEqual(sig.tick().rows.map((x) => [x.action, x.ref.file]), [['deleted', 'best kill 2.mp4']]);
    // Another app start: kept is never repeated; the stored rows are the full history of this stream.
    const sig2 = createLearningSignals({ dataDir, now: () => new Date('2026-11-12T09:00:00Z') });
    assert.equal(sig2.tick({ startup: true }).rows.length, 0);
    assert.deepEqual(rowsOf(dataDir, 'rec-h-20261110-200000').map((x) => x.action), ['kept', 'kept', 'kept', 'renamed', 'deleted', 'renamed', 'deleted']);
    assert.ok(a);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('My clips: a clip published during this app session is not "kept" until a later start', async () => {
  const dataDir = tmp();
  try {
    const sig = createLearningSignals({ dataDir, now: () => new Date('2026-11-10T20:00:00Z') });
    publishClips(dataDir, ['game_short_a_01_v.mp4'], '2026-11-10T20:30:00+00:00');
    assert.equal(sig.tick({ startup: true }).rows.length, 0, 'published after this start');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('feedback hotkey (Ctrl+Alt+F): each new moment folder becomes one feedback row', () => {
  const dataDir = tmp(); const fb = tmp();
  try {
    const moment = (d, t, at) => { mkdirSync(path.join(fb, d, t), { recursive: true }); writeFileSync(path.join(fb, d, t, 'moment.json'), JSON.stringify({ v: 1, kind: 'feedback', at, trigger: 'hotkey', scenes: { H: 'scene-default', V: null } })); };
    moment('2026-11-10', '201500', '2026-11-10T20:15:00.000Z');
    const sig = createLearningSignals({ dataDir, feedbackDir: fb });
    let r = sig.tick({ startup: true });
    assert.deepEqual(r.rows.map((x) => [x.action, x.source, x.session, x.ref.moment, x.at]), [['feedback', 'hotkey', 'day-2026-11-10', '2026-11-10/201500', '2026-11-10T20:15:00.000Z']]);
    moment('2026-11-10', '201500-2', '2026-11-10T20:15:00.500Z');
    r = sig.tick();
    assert.deepEqual(r.rows.map((x) => x.ref.moment), ['2026-11-10/201500-2']);
    assert.equal(sig.tick().rows.length, 0, 'a moment is labelled once');
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(fb, { recursive: true, force: true }); }
});

test('posting: a finished YouTube upload writes one "posted" row (session = the clip run)', async () => {
  const dataDir = tmp(); const pkgDir = tmp();
  try {
    const VIDEO = Buffer.from('0123456789'.repeat(20));
    const sha = createHash('sha256').update(VIDEO).digest('hex');
    const dir = path.join(pkgDir, 'c01', 'youtube-shorts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'full-crop.mp4'), VIDEO);
    const stamp = '2026-11-10T21:00:00.000Z';
    writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ version: 1, title: 'T', description: 'D', tags: [], hashtags: [], target: 'youtube-shorts', privacy: 'private', status: 'draft',
      source: { run: 'rec-h-20261110-200000', clipId: 'c01', layout: 'full-crop', startSec: 1, endSec: 2, sha256: sha }, video: { file: 'full-crop.mp4', bytes: VIDEO.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp }));
    const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
    mkdirSync(path.dirname(ledgerFile), { recursive: true });
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${sha}:youtube-shorts`]: { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: 'c01', createdAt: stamp, updatedAt: stamp } } }));
    const store = createPostStore({ ledgerFile, dataDir });
    const id = postId({ sha256: sha, target: 'youtube-shorts' });
    assert.ok(typeof (await store.setStatus(id, 'approved')) === 'object');
    const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
    const fetchImpl = async (url) => (String(url).includes('uploadType=resumable') ? res(200, {}, { location: 'https://upload.example/s1' }) : res(200, { id: 'VIDX', status: { uploadStatus: 'uploaded' } }));
    await uploadPost({ id, store, auth: { accessToken: async () => 't' }, outputsStatus: async () => ({ sinks: [] }), fetchImpl });
    const rows = rowsOf(dataDir, 'rec-h-20261110-200000');
    assert.deepEqual(rows.map((x) => [x.action, x.source, x.ref.post, x.ref.clipId, x.ref.target, x.ref.platform]), [['posted', 'posting', id, 'c01', 'youtube-shorts', 'youtube']]);
    // A store without a data folder (older callers) uploads as before and writes nothing.
    assert.equal(createPostStore({ ledgerFile }).dataDir, null);
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(pkgDir, { recursive: true, force: true }); }
});

test('chat-feedback replies (Streamer.bot, read-only): one row per new reply, no viewer name or text in the store', () => {
  const dataDir = tmp();
  try {
    const T0 = Date.parse('2026-11-10T20:00:00Z');
    const db = new DatabaseSync(path.join(dataDir, 'event-core.db'));
    db.exec('CREATE TABLE chat_raw (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, platform TEXT NOT NULL, display_name TEXT, text TEXT)');
    const ins = db.prepare('INSERT INTO chat_raw VALUES (?, ?, ?, ?, ?)');
    ins.run('q1', T0, 'twitch', 'bot-1', 'TEST: how does it look?');
    ins.run('e1', T0 + 60_000, 'youtube', 'viewer-1', 'video is smooth');
    ins.run('e2', T0 + 120_000, 'kick', 'viewer-2', 'fb: audio quiet');
    db.close();
    const opts = { dbFile: path.join(dataDir, 'event-core.db'), date: '2026-11-10', since: '2026-11-10T19:55:00Z', until: '2026-11-10T21:00:00Z', outDir: path.join(dataDir, 'fb'), questionPrefix: 'TEST:', botName: 'bot-1', learningDataDir: dataDir };
    const r = collectFeedback(opts);
    assert.equal(r.total, 2); assert.equal(r.labels, 2);
    const sessions = createLearningStore({ dataDir }).sessions();
    assert.equal(sessions.length, 1);
    assert.match(sessions[0], /^stream-20261110-\d{6}$/);
    const rows = rowsOf(dataDir, sessions[0]);
    assert.deepEqual(rows.map((x) => [x.action, x.source, x.ref.message, x.ref.platform, x.ref.file]), [
      ['feedback', 'chat-feedback', 'e1', 'youtube', '2026-11-10-stream-feedback.md'],
      ['feedback', 'chat-feedback', 'e2', 'kick', '2026-11-10-stream-feedback.md'],
    ]);
    assert.equal(rows[0].at, new Date(T0 + 60_000).toISOString());
    const raw = readFileSync(path.join(createLearningStore({ dataDir }).root, sessions[0], 'labels.jsonl'), 'utf8');
    for (const s of ['viewer-1', 'viewer-2', 'smooth', 'quiet']) assert.ok(!raw.includes(s), `${s} not in the store`);
    assert.equal(collectFeedback(opts).labels, 0, 're-running adds no rows for known replies');
    assert.equal(collectFeedback({ ...opts, learningDataDir: undefined, outDir: path.join(dataDir, 'fb2') }).labels, 0, 'no store without a data folder');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
