// SPDX-License-Identifier: GPL-3.0-or-later
// Task bar model (services/studio-ui/tasks.mjs) and its UI server route: plain-words tasks from launcher files and
// from the server's own long actions; pruning; text-only fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTask, createTasks, createTiming, ETA_MIN_MS, etaFrom, progressOf, PRUNE_MS, readTaskFiles, tasksDir, writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 't'.repeat(48);

test('cleanTask: bad input refused, lengths capped, done never above total', () => {
  assert.equal(cleanTask(null), null);
  assert.equal(cleanTask({ id: '../x', title: 'a', state: 'running' }), null);
  assert.equal(cleanTask({ id: 'a', title: 'a', state: 'weird' }), null);
  assert.equal(cleanTask({ id: 'a', title: '', state: 'running' }), null);
  const t = cleanTask({ id: 'a', title: 'x'.repeat(500), state: 'running', done: 9, total: 4, note: 'n'.repeat(900), kind: 'k'.repeat(99) });
  assert.equal(t.title.length, 120); assert.equal(t.note.length, 160); assert.equal(t.done, 4); assert.equal(t.kind.length, 24);
  assert.equal(cleanTask({ id: 'a', title: 'x', state: 'running', total: 0 }).total, null, 'total 0 = unknown');
});

test('task files: atomic write, read back, finished/stale ones pruned after 10 minutes', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-tasks-'));
  try {
    const t0 = 1_000_000;
    assert.equal(writeTaskFile(d, { id: 'clip-a', title: 'Finding the best moments in a', kind: 'clips', state: 'running', done: 1, total: 4, startedAt: t0, updatedAt: t0 }), true);
    writeTaskFile(d, { id: 'clip-b', title: 'Old', kind: 'clips', state: 'done', startedAt: 0, updatedAt: 0 });
    writeFileSync(path.join(tasksDir(d), 'junk.json'), '{nope');
    assert.deepEqual(readTaskFiles(d, t0 + 1000).map((t) => t.id).sort(), ['clip-a'], 'junk and stale skipped');
    assert.ok(!existsSync(path.join(tasksDir(d), 'clip-b.json')), 'stale file deleted');
    assert.equal(readTaskFiles(d, t0 + PRUNE_MS + 1).length, 0, 'a running task nobody updates for 10 min is dropped');
    assert.deepEqual(readdirSync(tasksDir(d)).filter((n) => n.endsWith('.tmp')), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('createTasks: start/update/done/fail, track(), order, pruning, file tasks merged', async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-tasks-'));
  try {
    let t = 5_000_000;
    const tasks = createTasks({ dataDir: d, now: () => t });
    const a = tasks.start({ title: 'Loading', kind: 'project', total: 4 });
    a.update({ done: 2, stage: 'load', note: 'halfway' });
    assert.deepEqual(tasks.list().map((x) => [x.title, x.state, x.done, x.total, x.stage]), [['Loading', 'running', 2, 4, 'load']]);
    t += 10; a.done('ok');
    assert.equal(tasks.list()[0].done, 4, 'done fills the bar');
    await assert.rejects(tasks.track({ title: 'Boom' }, async () => { throw new Error('secret detail'); }), /secret/);
    const failed = tasks.list().find((x) => x.title === 'Boom');
    assert.equal(failed.state, 'failed'); assert.doesNotMatch(JSON.stringify(failed), /secret/, 'error text never reaches the bar');
    writeTaskFile(d, { id: 'clip-x', title: 'Waiting', kind: 'clips', state: 'waiting', startedAt: t, updatedAt: t });
    const b = tasks.start({ title: 'Now', kind: 'x' });
    assert.deepEqual(tasks.list().map((x) => x.state), ['running', 'waiting', 'failed', 'done'], 'running, waiting, failed, done');
    t += PRUNE_MS + 1; assert.equal(tasks.list().length, 0); void b;
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- progress, elapsed, time left (user 2026-11-09, D310 proposed) ----
test('progressOf: done/total, done = 1, unknown amount = null', () => {
  assert.equal(progressOf({ state: 'running', done: 1, total: 4 }), 0.25);
  assert.equal(progressOf({ state: 'done', done: null, total: null }), 1);
  assert.equal(progressOf({ state: 'running', done: null, total: 4 }), null);
  assert.equal(progressOf({ state: 'running', done: 2, total: null }), null);
  assert.equal(progressOf({ state: 'running', done: 9, total: 4 }), 1, 'capped');
});

test('etaFrom: from the measured rate only; unknown before ETA_MIN_MS, without progress, or going back', () => {
  assert.equal(etaFrom({ at: 0, p: 0.1 }, 0.3, 10_000), 35_000, '0.2 in 10 s, 0.7 left -> 35 s');
  assert.equal(etaFrom({ at: 0, p: 0 }, 0.5, 60_000), 60_000);
  assert.equal(etaFrom({ at: 0, p: 0.1 }, 0.3, ETA_MIN_MS - 1), null, 'too soon to measure');
  assert.equal(etaFrom({ at: 0, p: 0.3 }, 0.3, 60_000), null, 'no progress since: unknown, never a guess');
  assert.equal(etaFrom({ at: 0, p: 0.5 }, 0.4, 60_000), null);
  assert.equal(etaFrom({ at: 0, p: 0.5 }, 1, 60_000), 0, 'finished: nothing left');
  assert.equal(etaFrom(null, 0.5, 1), null);
});

test('createTiming: elapsed for running and finished tasks; ETA per stage; waiting and unknown amounts have none', () => {
  let t = 1_000_000;
  const { timing, keep } = createTiming(() => t);
  const base = { id: 'clip-a', state: 'running', stage: 'detect', total: 10, startedAt: t - 30_000 };
  assert.deepEqual(timing({ ...base, done: 2 }), { progress: 0.2, elapsedMs: 30_000, etaMs: null }, 'first sample: no rate yet');
  t += 5000;
  assert.deepEqual(timing({ ...base, done: 4 }), { progress: 0.4, elapsedMs: 35_000, etaMs: 15_000 }, '0.2 per 5 s, 0.6 left');
  t += 5000;
  const r = timing({ ...base, stage: 'render', done: 1, total: 4 });
  assert.equal(r.etaMs, null, 'a new stage starts a new measurement');
  t += 4000;
  assert.equal(timing({ ...base, stage: 'render', done: 2, total: 4 }).etaMs, 8000);
  assert.deepEqual(timing({ id: 'w', state: 'waiting', startedAt: t - 1000 }), { progress: null, elapsedMs: 1000, etaMs: null });
  assert.deepEqual(timing({ id: 'u', state: 'running', startedAt: t - 2000, total: null, done: null }), { progress: null, elapsedMs: 2000, etaMs: null }, 'unknown amount of work: unknown time left');
  assert.deepEqual(timing({ id: 'd', state: 'done', startedAt: t - 9000, updatedAt: t - 4000 }), { progress: 1, elapsedMs: 5000, etaMs: null }, 'finished: elapsed stops at its end');
  keep(new Set());
  t += 4000;
  assert.equal(timing({ ...base, stage: 'render', done: 3, total: 4 }).etaMs, null, 'forgotten: measured again');
});

test('createTasks list(): every task carries progress, elapsedMs and etaMs (files and the server own tasks)', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-tasks-eta-'));
  try {
    let t = 7_000_000;
    const tasks = createTasks({ dataDir: d, now: () => t });
    writeTaskFile(d, { id: 'clip-b', title: 'Editing clips', kind: 'clips', state: 'running', stage: 'render', done: 1, total: 5, startedAt: t - 60_000, updatedAt: t });
    const a = tasks.start({ title: 'Upload', kind: 'upload', total: 100 });
    let l = tasks.list();
    assert.deepEqual(l.map((x) => [x.id.startsWith('ui-') ? 'ui' : x.id, x.progress, x.elapsedMs, x.etaMs]), [['ui', 0, 0, null], ['clip-b', 0.2, 60_000, null]]);
    t += 10_000;
    a.update({ done: 50 });
    writeTaskFile(d, { id: 'clip-b', title: 'Editing clips', kind: 'clips', state: 'running', stage: 'render', done: 3, total: 5, startedAt: t - 70_000, updatedAt: t });
    l = tasks.list();
    const by = Object.fromEntries(l.map((x) => [x.id.startsWith('ui-') ? 'ui' : x.id, x]));
    assert.equal(by.ui.etaMs, 10_000, 'half in 10 s: 10 s left');
    assert.equal(by['clip-b'].etaMs, 10_000, '0.2 to 0.6 in 10 s, 0.4 left: 10 s');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, headers: res.headers, body: b }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('UI server: GET /ui/api/tasks and the status snapshot carry tasks; a settings save is a task', async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-tasks-srv-'));
  const fake = createFakeHost({});
  const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir: d, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const l = await raw(port, { url: `/login?k=${KEY}` });
    const cookie = l.headers['set-cookie'][0].split(';')[0];
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const get = (u) => raw(port, { url: u, headers: { cookie } });
    const post = (u, b) => raw(port, { method: 'POST', url: u, body: JSON.stringify(b), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    assert.deepEqual((await get('/ui/api/tasks')).body.tasks, []);
    writeTaskFile(d, { id: 'clip-demo', title: 'Editing clips (3 of 7)', kind: 'clips', state: 'running', stage: 'render', done: 2, total: 7, startedAt: Date.now(), updatedAt: Date.now() });
    assert.equal((await post('/ui/api/settings', { clips: { recording: 'after' } })).status, 200);
    const tasks = (await get('/ui/api/tasks')).body.tasks;
    assert.deepEqual(tasks.map((t) => [t.title, t.state]), [['Editing clips (3 of 7)', 'running'], ['Saving your settings', 'done']]);
    let snap = [];
    for (let i = 0; i < 40 && snap.length < tasks.length; i++) { snap = (await get('/ui/api/status')).body.tasks ?? []; if (snap.length < tasks.length) await new Promise((r) => setTimeout(r, 50)); }
    assert.deepEqual(snap.map((t) => t.id).sort(), tasks.map((t) => t.id).sort(), 'the snapshot (and SSE) carry them too');
    assert.doesNotMatch(JSON.stringify(tasks), /[A-Za-z]:[\/]/, 'no paths');
  } finally { srv.close(); rmSync(d, { recursive: true, force: true }); }
});
