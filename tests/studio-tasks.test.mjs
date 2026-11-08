// SPDX-License-Identifier: GPL-3.0-or-later
// Task bar model (services/studio-ui/tasks.mjs) and its UI server route: plain-words tasks from launcher files and
// from the server's own long actions; pruning; text-only fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTask, createTasks, PRUNE_MS, readTaskFiles, tasksDir, writeTaskFile } from '../services/studio-ui/tasks.mjs';
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
