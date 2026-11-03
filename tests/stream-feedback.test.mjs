// SPDX-License-Identifier: GPL-2.0-or-later
// BM5 stream feedback collection: recorded mock chat only (placeholder names), headless, read-only database.
process.env.UJWALAM_HEADLESS = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectFeedback, escapeText } from '../tools/collect-stream-feedback.mjs';

const T0 = Date.parse('2026-11-03T18:00:00Z');
const min = (n) => T0 + n * 60_000;
const ROWS = [
  ['e1', min(-5), 'youtube', 'viewer-0', 'hello before the question'],
  ['e2', min(0), 'twitch', 'bot-1', 'TEST: how do video, audio and scenes look?'],
  ['e3', min(2), 'youtube', 'viewer-1', 'video is smooth'],
  ['e4', min(4), 'twitch', 'viewer-2', 'audio a bit quiet'],
  ['e5', min(9), 'kick', 'viewer-3', 'scenes fine'],
  ['e6', min(30), 'kick', 'viewer-4', 'fb: lag at the 30 minute mark'],
  ['e7', min(31), 'twitch', 'viewer-5', 'unrelated chatter'],
  ['e8', min(12), 'youtube', 'viewer-6', 'too late for the window'],
];

function mkDb(dir, rows = ROWS) {
  const file = path.join(dir, 'event-core.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE chat_raw (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, platform TEXT NOT NULL, display_name TEXT, text TEXT)');
  const ins = db.prepare('INSERT INTO chat_raw VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(...r);
  db.close();
  return file;
}
const base = (dir, extra = {}) => ({
  dbFile: path.join(dir, 'event-core.db'), date: '2026-11-03', since: '2026-11-03T17:00:00Z', until: '2026-11-03T20:00:00Z',
  outDir: path.join(dir, 'out'), questionPrefix: 'TEST:', botName: 'bot-1', ...extra,
});
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-fb-'));

test('window, marker, exclusion, three platforms', () => {
  const dir = tmp();
  try {
    mkDb(dir);
    const r = collectFeedback(base(dir));
    const md = readFileSync(r.file, 'utf8');
    assert.equal(r.total, 4);
    assert.deepEqual([r.counts.youtube, r.counts.twitch, r.counts.kick], [1, 1, 2]);
    assert.match(md, /youtube 1, twitch 1, kick 2/);
    assert.match(md, /Stream window: 2026-11-03T17:00:00.000Z to 2026-11-03T20:00:00.000Z/);
    for (const id of ['e3', 'e4', 'e5', 'e6']) assert.ok(md.includes(`<!--id:${id}-->`), id);
    for (const id of ['e1', 'e2', 'e7', 'e8']) assert.ok(!md.includes(`<!--id:${id}-->`), id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit question time works without a question row', () => {
  const dir = tmp();
  try {
    mkDb(dir);
    const r = collectFeedback(base(dir, { questionPrefix: undefined, botName: undefined, questionTimes: ['2026-11-03T18:00:00Z'] }));
    assert.equal(r.total, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('escaping: markdown, newlines, control chars, length cap, comment injection', () => {
  const bidi = String.fromCharCode(0x202e);
  const t = escapeText(`*bold* [x](http://e) <!--id:z--> line1\nline2\u0000${bidi} end | pipe`);
  assert.ok(!/[\n\u0000]/.test(t) && !t.includes(bidi));
  assert.ok(!t.includes('<!--') && t.includes('\\<'));
  assert.ok(t.includes('\\*bold\\*'));
  assert.ok(escapeText('a'.repeat(900)).length <= 504);
  const dir = tmp();
  try {
    mkDb(dir, [['x1', min(1), 'twitch', 'viewer-9\n# head', 'fb: <!--id:evil--> # injected\n- fake line']]);
    const r = collectFeedback(base(dir));
    const md = readFileSync(r.file, 'utf8');
    assert.equal(md.split('\n').filter((l) => l.startsWith('- 2026')).length, 1);
    assert.ok(!md.includes('<!--id:evil-->'));
    assert.ok(!/^# injected/m.test(md));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('re-run adds no duplicates; later messages are appended', () => {
  const dir = tmp();
  try {
    const file = mkDb(dir);
    const first = collectFeedback(base(dir));
    const again = collectFeedback(base(dir));
    assert.equal(again.added, 0);
    assert.equal(again.total, first.total);
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO chat_raw VALUES (?, ?, ?, ?, ?)').run('e9', min(35), 'youtube', 'viewer-7', 'fb: late note');
    db.close();
    const third = collectFeedback(base(dir));
    assert.equal(third.added, 1);
    assert.equal(third.total, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing database is an error, never an empty report', () => {
  const dir = tmp();
  try {
    assert.throws(() => collectFeedback(base(dir)), /chat database not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty result writes a header with zero counts', () => {
  const dir = tmp();
  try {
    mkDb(dir, [['n1', min(1), 'twitch', 'viewer-1', 'just chatting']]);
    const r = collectFeedback(base(dir, { questionPrefix: undefined, botName: undefined }));
    assert.equal(r.total, 0);
    assert.match(readFileSync(r.file, 'utf8'), /Messages: 0 \(youtube 0, twitch 0, kick 0\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
