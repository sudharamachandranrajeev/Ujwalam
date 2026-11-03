// SPDX-License-Identifier: GPL-2.0-or-later
// Studio UI server: feature flags (typed confirmation on, instant off) and the post-stream feedback form
// (note.json only, id validation, traversal, links). Fake host, stub core, 127.0.0.1 only; no devices, no platforms.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ff-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

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
async function login(port) {
  const r = await raw(port, { url: `/login?k=${KEY}` });
  assert.equal(r.status, 302);
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
const get = (port, a, url) => raw(port, { url, headers: { cookie: a.cookie } });
const post = (port, a, route, body) => raw(port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: a.cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': a.csrf },
});

async function boot({ live = false, feedbackDir, state = { live } } = {}) {
  const dataDir = mk();
  const fake = createFakeHost({ outputsReady: true });
  const host = { describe: () => fake.describe(), call: async (m, p) => { const r = await fake.call(m, p); return m === 'host.status' ? { ...r, live: state.live } : r; } };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, feedbackDir, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  const a = await login(port);
  return { srv, port, a, dataDir };
}

describe('feature flags API', () => {
  let c;
  before(async () => { c = await boot(); });
  after(() => c.srv.close());

  test('list: every flag off by default', async () => {
    const r = await get(c.port, c.a, '/ui/api/flags');
    assert.equal(r.status, 200);
    const flags = r.json().flags;
    assert.ok(flags.length >= 1);
    assert.ok(flags.every((f) => f.on === false && typeof f.id === 'string' && typeof f.description === 'string'));
  });
  test('ON needs the typed phrase; wrong phrase keeps it off; right phrase turns it on and persists', async () => {
    const id = (await get(c.port, c.a, '/ui/api/flags')).json().flags[0].id;
    const r = await post(c.port, c.a, '/ui/api/flags/set', { id, on: true });
    const j = r.json();
    assert.equal(j.verdict, 'confirm');
    assert.equal(j.pending.phrase, 'yes');
    assert.equal(existsSync(path.join(c.dataDir, 'flags.local.json')), false, 'nothing written before confirmation');
    const bad = await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'no' });
    assert.equal(bad.json().verdict, 'wrong-phrase');
    assert.equal(existsSync(path.join(c.dataDir, 'flags.local.json')), false);
    const ok = await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: ' Yes ' });
    assert.equal(ok.json().verdict, 'allow');
    assert.equal(ok.json().flags.find((f) => f.id === id).on, true);
    assert.equal(JSON.parse(readFileSync(path.join(c.dataDir, 'flags.local.json'), 'utf8')).flags[id], true);
  });
  test('OFF is instant, no confirmation', async () => {
    const id = (await get(c.port, c.a, '/ui/api/flags')).json().flags[0].id;
    const r = await post(c.port, c.a, '/ui/api/flags/set', { id, on: false });
    assert.equal(r.json().verdict, 'allow');
    assert.equal(r.json().flags.find((f) => f.id === id).on, false);
    assert.equal(c.srv._pending().size, 0);
  });
  test('bad input refused: unknown id, bad types, extra fields, traversal-like id', async () => {
    assert.equal((await post(c.port, c.a, '/ui/api/flags/set', { id: 'no-such-flag', on: true })).status, 404);
    assert.equal((await post(c.port, c.a, '/ui/api/flags/set', { id: '../x', on: true })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/flags/set', { id: 'clip-pipeline', on: 'yes' })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/flags/set', { id: 'clip-pipeline', on: true, extra: 1 })).status, 400);
  });
  test('set without CSRF or session is refused', async () => {
    const r = await raw(c.port, { method: 'POST', url: '/ui/api/flags/set', body: '{}', headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json' } });
    assert.equal(r.status, 403);
    assert.equal((await raw(c.port, { url: '/ui/api/flags' })).status, 401);
  });
});

describe('feature flags while live', () => {
  let c;
  before(async () => { c = await boot({ live: true }); await new Promise((r) => setTimeout(r, 200)); });
  after(() => c.srv.close());

  test('ON while live needs "yes, on air"; OFF while live is still instant', async () => {
    const id = (await get(c.port, c.a, '/ui/api/flags')).json().flags[0].id;
    const j = (await post(c.port, c.a, '/ui/api/flags/set', { id, on: true })).json();
    assert.equal(j.pending.phrase, 'yes, on air');
    assert.equal((await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'yes' })).json().verdict, 'wrong-phrase');
    assert.equal((await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'yes, on air' })).json().verdict, 'allow');
    const off = await post(c.port, c.a, '/ui/api/flags/set', { id, on: false });
    assert.equal(off.json().verdict, 'allow');
  });
});

describe('going live while a confirmation is open (D151)', () => {
  let c; const state = { live: false };
  before(async () => { c = await boot({ state }); await new Promise((r) => setTimeout(r, 200)); });
  after(() => c.srv.close());

  test('a "yes" request made off air needs "yes, on air" once the stream is live', async () => {
    const id = (await get(c.port, c.a, '/ui/api/flags')).json().flags[0].id;
    const j = (await post(c.port, c.a, '/ui/api/flags/set', { id, on: true })).json();
    assert.equal(j.pending.phrase, 'yes');
    state.live = true;
    await new Promise((r) => setTimeout(r, 300)); // status poll is 50 ms
    const up = (await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'yes' })).json();
    assert.equal(up.verdict, 'wrong-phrase');
    assert.equal(up.pending.phrase, 'yes, on air');
    assert.equal(existsSync(path.join(c.dataDir, 'flags.local.json')), false, 'nothing written on plain yes');
    assert.equal((await post(c.port, c.a, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'yes, on air' })).json().verdict, 'allow');
  });
});

function makeMoment(root, date, time, moment = { timestamp: '2026-11-04T19:30:00Z', scene: 'Default', stats: { fps: 60, dropped: 3, live: true } }) {
  const d = path.join(root, date, time);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'moment.json'), JSON.stringify(moment));
  writeFileSync(path.join(d, 'replay.txt'), 'must stay untouched');
  return d;
}

describe('feedback form API', () => {
  let c, fbDir, outside;
  before(async () => {
    fbDir = mk(); outside = mk();
    makeMoment(fbDir, '2026-11-03', '201500');
    makeMoment(fbDir, '2026-11-04', '190000', { timestamp: 1730000000, scene: 'S'.repeat(200), stats: { ok: 1, nested: { a: 1 }, 'bad key!': 2 } });
    mkdirSync(path.join(fbDir, 'not-a-date'), { recursive: true });
    mkdirSync(path.join(fbDir, '2026-11-04', 'junk'), { recursive: true });
    c = await boot({ feedbackDir: fbDir });
  });
  after(() => c.srv.close());

  test('lists moments newest first, sanitised, ignoring odd folders', async () => {
    const m = (await get(c.port, c.a, '/ui/api/feedback')).json().moments;
    assert.deepEqual(m.map((x) => x.id), ['2026-11-04/190000', '2026-11-03/201500']);
    assert.equal(m[0].scene.length, 64);
    assert.deepEqual(m[0].stats, { ok: 1 });
    assert.equal(m[1].note, null);
    assert.equal(m[1].stats.fps, 60);
  });
  test('missing feedback dir lists nothing', async () => {
    const e = await boot({ feedbackDir: path.join(mk(), 'nope') });
    assert.deepEqual((await get(e.port, e.a, '/ui/api/feedback')).json().moments, []);
    await e.srv.close();
  });
  test('save note writes note.json only and returns the list', async () => {
    const dir = path.join(fbDir, '2026-11-03', '201500');
    const before = readdirSync(dir).sort();
    const r = await post(c.port, c.a, '/ui/api/feedback/note', { id: '2026-11-03/201500', text: 'overlay flickered', tag: 'bug', severity: 'high' });
    assert.equal(r.status, 200);
    const note = JSON.parse(readFileSync(path.join(dir, 'note.json'), 'utf8'));
    assert.equal(note.text, 'overlay flickered'); assert.equal(note.tag, 'bug'); assert.equal(note.severity, 'high');
    assert.deepEqual(readdirSync(dir).sort(), [...before, 'note.json'].sort(), 'no temp file, no other file touched');
    assert.equal(readFileSync(path.join(dir, 'replay.txt'), 'utf8'), 'must stay untouched');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'moment.json'), 'utf8')).scene, 'Default');
    const m = r.json().moments.find((x) => x.id === '2026-11-03/201500');
    assert.equal(m.note.tag, 'bug');
    // update replaces
    await post(c.port, c.a, '/ui/api/feedback/note', { id: '2026-11-03/201500', text: 'fine now', tag: 'works-well', severity: 'low' });
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'note.json'), 'utf8')).tag, 'works-well');
  });
  test('bad tag, severity, text, extra fields refused', async () => {
    const ok = { id: '2026-11-03/201500', text: 'x', tag: 'bug', severity: 'low' };
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { ...ok, tag: 'other' })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { ...ok, severity: 'critical' })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { ...ok, text: 'x'.repeat(2001) })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { ...ok, text: 5 })).status, 400);
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { ...ok, path: '/etc' })).status, 400);
  });
  test('path traversal impossible: only ^\\d{4}-\\d{2}-\\d{2}/\\d{6}$ ids', async () => {
    const bads = ['../x', '2026-11-03/201500/..', '2026-11-03/../201500', '..\\..\\x', '2026-11-03\\201500', '/2026-11-03/201500', '2026-11-03/201500/', '2026-11-03/2015000', '2026-11-03/201500\n', '2026-11-03/20150', 'C:/x', '%2e%2e/%2e%2e', '2026-11-03/201500%00', '', 5, null];
    for (const id of bads) {
      const r = await post(c.port, c.a, '/ui/api/feedback/note', { id, text: 'x', tag: 'bug', severity: 'low' });
      assert.ok(r.status === 404 || r.status === 400, `${JSON.stringify(id)} -> ${r.status}`);
    }
    // a well-formed id of a folder that does not exist
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { id: '2026-01-01/000000', text: 'x', tag: 'bug', severity: 'low' })).status, 404);
    // a well-formed id of a folder without moment.json
    mkdirSync(path.join(fbDir, '2026-11-05', '120000'), { recursive: true });
    assert.equal((await post(c.port, c.a, '/ui/api/feedback/note', { id: '2026-11-05/120000', text: 'x', tag: 'bug', severity: 'low' })).status, 404);
    assert.equal(existsSync(path.join(fbDir, '2026-11-05', '120000', 'note.json')), false);
  });
  test('a link out of the feedback dir is not followed', async (t) => {
    const target = makeMoment(outside, '2026-11-06', '101010');
    try { mkdirSync(path.join(fbDir, '2026-11-06'), { recursive: true }); symlinkSync(target, path.join(fbDir, '2026-11-06', '101010'), 'junction'); } catch { t.skip('cannot create a link here'); return; }
    const r = await post(c.port, c.a, '/ui/api/feedback/note', { id: '2026-11-06/101010', text: 'x', tag: 'bug', severity: 'low' });
    assert.equal(r.status, 404);
    assert.equal(existsSync(path.join(target, 'note.json')), false);
    const ids = (await get(c.port, c.a, '/ui/api/feedback')).json().moments.map((x) => x.id);
    assert.ok(!ids.includes('2026-11-06/101010'));
  });
  test('needs session and CSRF', async () => {
    assert.equal((await raw(c.port, { url: '/ui/api/feedback' })).status, 401);
    const r = await raw(c.port, { method: 'POST', url: '/ui/api/feedback/note', body: '{}', headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json' } });
    assert.equal(r.status, 403);
  });
});

describe('page safety', () => {
  test('ui scripts for the new panels use no innerHTML and no external URLs', () => {
    for (const f of ['app.js', 'api.js']) {
      const s = readFileSync(path.join(UI, 'js', f), 'utf8');
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s), f);
      assert.ok(!/https?:\/\//.test(s), f);
    }
  });
});
