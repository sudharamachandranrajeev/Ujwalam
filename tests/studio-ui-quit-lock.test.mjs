// SPDX-License-Identifier: GPL-3.0-or-later
// Closing lock (D311 proposed; Codex review round 2). The studio leaves the tray (and so the launcher stops the host)
// only with a lock the UI server grants. The grant and every stream/recording start are serialized in the UI server:
//   - quit while a stream or recording runs, or while the host cannot be read: refused (fail closed);
//   - a start already under way when the quit comes: the quit is refused;
//   - a start that comes after the grant: refused, 409 "Ujwalam is closing", and the host never gets it (a start
//     acts on the click, D331, so no start can be held open across the grant);
//   - a released lock lets starts through again; the go-live authority is revoked on a grant;
//   - round 3: a granted lock never expires (only its token's cancel releases it); the studio exits only when
//     quit/commit confirms the token still holds the granted lock; a slow or failing revoke cannot end in a grant.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'q'.repeat(48);
const dirs = [];
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A UI server over the fake host. ctl: { live, recording, statusFails, startDelayMs, revoke }; calls lists the host calls. */
async function boot(ctl = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-ql-')); dirs.push(dataDir);
  const fake = createFakeHost({ outputsReady: true });
  const calls = []; const revokes = [];
  const clock = { t: Date.now() };
  const host = {
    describe: () => fake.describe(),
    call: async (m, p) => {
      calls.push(m);
      if (m === 'host.status') {
        if (ctl.statusFails) throw new Error('host gone');
        const r = await fake.call(m, p);
        return { ...r, live: ctl.live ?? r.live, recording: ctl.recording ?? r.recording };
      }
      if (m === 'stream.start' && ctl.startDelayMs) await new Promise((r) => setTimeout(r, ctl.startDelayMs));
      return fake.call(m, p);
    },
  };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const authority = { begin: async () => 0, arm: async () => true, revoke: async (why) => { revokes.push(why); return ctl.revoke ? ctl.revoke(why) : true; } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, authority, now: () => clock.t, limits: { statusPollMs: 50, quitWaitMs: 400 } });
  servers.push(srv);
  const { port } = await srv.listen();
  const r = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
  const post = (route, body = {}) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body),
    headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  /** A start click: it acts at once (D331); the promise is not awaited by the caller when racing. */
  const ask = (method) => post('/ui/api/host', { method, params: {} });
  return { post, ask, calls, revokes, clock, ctl };
}

test('quit while a stream or a recording runs, or with the host unreadable: refused (fail closed); idle: granted, authority revoked', async () => {
  const s = await boot({ live: true, recording: false });
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'live' });
  s.ctl.live = false; s.ctl.recording = true;
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'recording' });
  s.ctl.recording = false; s.ctl.statusFails = true;
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'unreadable' });
  s.ctl.statusFails = false;
  assert.deepEqual(s.revokes, [], 'refused quits never touch the go-live authority');
  const g = (await s.post('/ui/api/quit/begin')).body;
  assert.equal(g.granted, true);
  assert.match(g.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(s.revokes, ['closing'], 'no stream recovery after the grant');
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'already-closing' });
});

test('after the grant every stream and recording start is refused with 409 "Ujwalam is closing"; the host never gets it; cancel releases', async () => {
  const s = await boot();
  const { token } = (await s.post('/ui/api/quit/begin')).body;
  assert.equal(s.revokes.length, 1, 'granted');
  for (const m of ['stream.start', 'record.start']) {
    const r = await s.post('/ui/api/host', { method: m, params: {} });
    assert.equal(r.status, 409, m);
    assert.deepEqual(r.body, { error: 'closing', detail: 'Ujwalam is closing' });
  }
  assert.ok(!s.calls.includes('stream.start') && !s.calls.includes('record.start'), 'nothing started on the host');
  assert.equal((await s.post('/ui/api/host', { method: 'stream.stop', params: {} })).body.verdict, 'allow', 'stops are never blocked');
  assert.equal((await s.post('/ui/api/quit/cancel', { token: 'f'.repeat(32) })).status, 200);
  assert.equal((await s.post('/ui/api/host', { method: 'record.start', params: {} })).status, 409, 'a wrong token releases nothing');
  await s.post('/ui/api/quit/cancel', { token });
  const again = await s.ask('record.start');
  assert.equal(again.body.verdict, 'allow', 'released: starts allowed again');
  assert.ok(s.calls.includes('record.start'));
});

test('race: a start already on its way to the host refuses the quit; right after it the quit is still refused (the host may not show it yet)', async () => {
  const s = await boot({ startDelayMs: 600 });
  const starting = s.ask('stream.start'); // in flight: the host takes 600 ms
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'starting' });
  assert.equal((await starting).body.verdict, 'allow', 'the start itself goes through: the lock was released at once');
  s.ctl.live = false; // even if the host does not report it live yet
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'starting' });
  s.clock.t += 6000;
  assert.equal((await s.post('/ui/api/quit/begin')).body.granted, true, 'later, idle: granted');
});

test('a granted lock never expires (test clock past 60 s): starts stay refused; commit holds only for the held token', async () => {
  const s = await boot();
  const { token } = (await s.post('/ui/api/quit/begin')).body;
  s.clock.t += 3_600_000;
  const r = await s.post('/ui/api/host', { method: 'stream.start', params: {} });
  assert.equal(r.status, 409, 'an hour later: still closing (a studio that hangs holding it is fail safe)');
  assert.equal(r.body.detail, 'Ujwalam is closing');
  assert.equal((await s.post('/ui/api/quit/commit', { token })).status, 200, 'still granted: the studio may exit');
  assert.equal((await s.post('/ui/api/quit/commit', { token: 'f'.repeat(32) })).status, 409, 'another token: not granted');
  await s.post('/ui/api/quit/cancel', { token });
  const stale = await s.post('/ui/api/quit/commit', { token });
  assert.deepEqual([stale.status, stale.body.error], [409, 'stale-quit'], 'released: a late commit of the old token fails, so no exit');
  assert.equal((await s.post('/ui/api/host', { method: 'stream.start', params: {} })).body.verdict, 'allow', 'released: going live works');
});

test('the revoke racing time cannot grant: slow revoke holds the lock (no start slips in); a revoke with no answer or a refusal releases without a grant', async () => {
  const s = await boot();
  let answer;
  s.ctl.revoke = () => new Promise((r) => { answer = r; });
  const begin = s.post('/ui/api/quit/begin');
  await new Promise((r) => setTimeout(r, 100));
  s.clock.t += 120_000; // "time passes" while the launcher has not answered
  assert.equal((await s.post('/ui/api/host', { method: 'stream.start', params: {} })).status, 409, 'locked while the grant is being decided');
  answer(true);
  const g = (await begin).body;
  assert.equal(g.granted, true);
  assert.equal((await s.post('/ui/api/quit/commit', { token: g.token })).status, 200);
  await s.post('/ui/api/quit/cancel', { token: g.token });
  s.ctl.revoke = () => new Promise(() => {}); // never answers: bounded (quitWaitMs 400 here, 10 s by default)
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'unreadable' });
  s.ctl.revoke = async () => false; // the launcher did not confirm the revoke
  assert.deepEqual((await s.post('/ui/api/quit/begin')).body, { granted: false, reason: 'unreadable' });
  // Checked last: a start that goes through blocks a quit for a while ('starting').
  assert.equal((await s.post('/ui/api/host', { method: 'stream.start', params: {} })).body.verdict, 'allow', 'released: not locked for ever');
});
