// SPDX-License-Identifier: GPL-2.0-or-later
// Studio UI server: the Bots card API (BM2, flag `bot-manager`). Fake bots (in memory) for the API rules, and one run
// over the real bot manager with a copied node executable. Never touches the real Streamer.bot or Speaker.bot, never
// contacts ports 8093 or 8083. Fake host, stub core, 127.0.0.1 only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBots } from '../services/bots/index.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-bui-')); tmpDirs.push(d); return d; };
const kids = new Set();
const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const pid of kids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  kids.clear();
});
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* exe still closing */ } } });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers, json() { return JSON.parse(this.text); } }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function login(port) {
  const r = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
const get = (c, url) => raw(c.port, { url, headers: { cookie: c.a.cookie } });
const post = (c, route, body, extra = {}) => raw(c.port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': c.a.csrf, ...extra },
});

async function boot({ bots, flagOn = true, live = false } = {}) {
  const dataDir = mk();
  if (flagOn) createFlags({ dataDir }).set('bot-manager', true);
  const fake = createFakeHost({ outputsReady: true });
  const host = { describe: () => fake.describe(), call: async (m, p) => { const r = await fake.call(m, p); return m === 'host.status' ? { ...r, live } : r; } };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const botImpl = typeof bots === 'function' ? bots(dataDir) : (bots ?? createFakeBots());
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, bots: botImpl, limits: { statusPollMs: 30 } });
  servers.push(srv);
  const { port } = await srv.listen();
  if (live) await new Promise((r) => setTimeout(r, 150)); // one status poll so the server knows it is live
  return { srv, port, a: await login(port), dataDir, bots: botImpl };
}

describe('flag gate', () => {
  test('the card API is 404 while `bot-manager` is off (the default); the flag is defined and off', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    assert.equal(defs.find((f) => f.id === 'bot-manager').default, false);
    const c = await boot({ flagOn: false });
    assert.equal((await get(c, '/ui/api/bots')).status, 404);
    assert.equal((await post(c, '/ui/api/bots/start', { bot: 'streamerbot' })).status, 404);
    assert.deepEqual(c.bots.calls, []);
  });

  test('the page has the card, hidden until the flag is on, built with safe DOM only', () => {
    const html = readFileSync(path.join(UI, 'index.html'), 'utf8');
    assert.match(html, /<section id="bots" class="panel" hidden>/);
    const js = readFileSync(path.join(UI, 'js', 'app.js'), 'utf8');
    assert.match(js, /f\.id === 'bot-manager'/);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'no HTML string parsing');
    assert.ok(!/style=|#[0-9a-fA-F]{3,6}\b/.test(readFileSync(path.join(UI, 'js', 'api.js'), 'utf8')));
  });
});

describe('Bots API with fake bots', () => {
  test('GET lists both bots with installed, running, port and started-by-us', async () => {
    const c = await boot({ bots: createFakeBots({ speakerbot: { installed: false } }) });
    const r = await get(c, '/ui/api/bots');
    assert.equal(r.status, 200);
    const rows = r.json().bots;
    assert.deepEqual(rows.map((b) => b.bot), ['streamerbot', 'speakerbot']);
    assert.deepEqual(rows.map((b) => [b.installed, b.running, b.startedByUs, b.portAnswering]), [[true, false, false, false], [false, false, false, false]]);
    assert.deepEqual(rows.map((b) => b.port), [8093, 8083], 'the fake reports the default ports; nothing is contacted');
  });

  test('Start and Stop are typed-confirmation writes: nothing runs before the phrase, a wrong phrase stays pending', async () => {
    const c = await boot();
    const r = await post(c, '/ui/api/bots/start', { bot: 'streamerbot' });
    const j = r.json();
    assert.equal(j.verdict, 'confirm');
    assert.equal(j.pending.phrase, 'yes');
    assert.match(j.pending.summary, /Start Streamer\.bot/);
    assert.deepEqual(c.bots.calls, [], 'not started before confirmation');
    const wrong = await post(c, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'ok' });
    assert.equal(wrong.json().verdict, 'wrong-phrase');
    assert.deepEqual(c.bots.calls, []);
    const ok = await post(c, '/ui/api/confirm', { pendingId: j.pending.pendingId, text: 'Yes' });
    assert.equal(ok.json().verdict, 'allow');
    assert.deepEqual(c.bots.calls, [['start', 'streamerbot']]);
    assert.deepEqual(ok.json().bots.map((b) => [b.bot, b.running, b.startedByUs]), [['streamerbot', true, true], ['speakerbot', false, false]]);
    // Stop
    const s = (await post(c, '/ui/api/bots/stop', { bot: 'streamerbot' })).json();
    assert.match(s.pending.summary, /Stop Streamer\.bot/);
    assert.match(s.pending.summary, /force-closed: save your Streamer\.bot changes first/); // warned before a forced close
    const done = (await post(c, '/ui/api/confirm', { pendingId: s.pending.pendingId, text: 'yes' })).json();
    assert.equal(done.verdict, 'allow');
    assert.equal(done.forced, false);
    assert.equal(done.bots[0].running, false);
  });

  test('Cancel runs nothing; Stop of a copy the user started is refused with a reason', async () => {
    const c = await boot({ bots: createFakeBots({ speakerbot: { running: true, startedByUs: false, portAnswering: true } }) });
    const p = (await post(c, '/ui/api/bots/start', { bot: 'streamerbot' })).json().pending;
    assert.equal((await post(c, '/ui/api/cancel', { pendingId: p.pendingId })).json().verdict, 'cancelled');
    assert.deepEqual(c.bots.calls, []);
    const s = (await post(c, '/ui/api/bots/stop', { bot: 'speakerbot' })).json().pending;
    const r = (await post(c, '/ui/api/confirm', { pendingId: s.pendingId, text: 'yes' })).json();
    assert.equal(r.verdict, 'refuse');
    assert.equal(r.reason, 'not-started-by-ujwalam');
    assert.equal(r.bots.find((b) => b.bot === 'speakerbot').running, true);
  });

  test('while live the phrase is "yes, on air", also when the stream went live after the request', async () => {
    const c = await boot({ live: true });
    const p = (await post(c, '/ui/api/bots/start', { bot: 'speakerbot' })).json().pending;
    assert.equal(p.phrase, 'yes, on air');
    assert.equal((await post(c, '/ui/api/confirm', { pendingId: p.pendingId, text: 'yes' })).json().verdict, 'wrong-phrase');
    assert.deepEqual(c.bots.calls, []);
    assert.equal((await post(c, '/ui/api/confirm', { pendingId: p.pendingId, text: 'yes, on air' })).json().verdict, 'allow');
    assert.deepEqual(c.bots.calls, [['start', 'speakerbot']]);
  });

  test('turning the flag off between request and confirmation cancels the write', async () => {
    const c = await boot();
    const p = (await post(c, '/ui/api/bots/start', { bot: 'streamerbot' })).json().pending;
    createFlags({ dataDir: c.dataDir }).set('bot-manager', false);
    const r = await post(c, '/ui/api/confirm', { pendingId: p.pendingId, text: 'yes' });
    assert.equal(r.status, 404);
    assert.deepEqual(c.bots.calls, []);
  });

  test('validation, CSRF and origin rules', async () => {
    const c = await boot();
    assert.equal((await post(c, '/ui/api/bots/start', { bot: 'obs' })).status, 400);
    assert.equal((await post(c, '/ui/api/bots/start', { bot: '../x' })).status, 400);
    assert.equal((await post(c, '/ui/api/bots/start', {})).status, 400);
    assert.equal((await post(c, '/ui/api/bots/start', { bot: 'streamerbot', exe: 'C:\\x.exe' })).status, 400, 'no path or argument can come from the page');
    assert.equal((await post(c, '/ui/api/bots/start', { bot: 'streamerbot' }, { 'x-ujwalam-csrf': 'wrong' })).status, 403);
    assert.equal((await post(c, '/ui/api/bots/start', { bot: 'streamerbot' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await raw(c.port, { url: '/ui/api/bots' })).status, 401, 'no session');
    assert.deepEqual(c.bots.calls, []);
  });

  test('a failing bot check is a 502, not a crash', async () => {
    const c = await boot({ bots: { statusAll: async () => { throw new Error('boom'); } } });
    assert.equal((await get(c, '/ui/api/bots')).status, 502);
  });
});

describe('Bots API over the real bot manager (copied node executable, no real bot)', () => {
  test('start and stop through the page API: started by Ujwalam, then stopped', { timeout: 60_000 }, async () => {
    const exeDir = mk();
    const exe = path.join(exeDir, process.platform === 'win32' ? 'ujw-fakebot-ui.exe' : 'ujw-fakebot-ui');
    copyFileSync(process.execPath, exe);
    if (process.platform !== 'win32') chmodSync(exe, 0o755);
    const procs = new Map();
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const c = await boot({
      bots: (dataDir) => createBots({
        dataDir, gracefulMs: 400, config: { streamerbot: { exe, args: ['-e', 'setInterval(() => {}, 1000)'], ws: 'ws://127.0.0.1:1/' } },
        listProcesses: (e) => [...procs].filter(([pid, p]) => p.exe === e && alive(pid)).map(([pid, p]) => ({ pid, startedAt: p.startedAt })),
        spawnImpl: (e, a, o) => { const ch = spawn(e, a, { ...o, windowsHide: true }); procs.set(ch.pid, { exe: e, startedAt: new Date().toISOString() }); kids.add(ch.pid); return ch; },
      }),
    });
    const before = (await get(c, '/ui/api/bots')).json().bots;
    assert.deepEqual([before[0].installed, before[0].running, before[1].installed], [true, false, false], 'speakerbot is not configured');
    const sp = (await post(c, '/ui/api/bots/start', { bot: 'streamerbot' })).json().pending;
    const started = (await post(c, '/ui/api/confirm', { pendingId: sp.pendingId, text: 'yes' })).json();
    assert.equal(started.verdict, 'allow');
    const row = started.bots[0];
    assert.deepEqual([row.running, row.startedByUs, row.portAnswering], [true, true, false]);
    assert.equal(alive(row.pid), true);
    const st = (await post(c, '/ui/api/bots/stop', { bot: 'streamerbot' })).json().pending;
    const stopped = (await post(c, '/ui/api/confirm', { pendingId: st.pendingId, text: 'yes' })).json();
    assert.equal(stopped.verdict, 'allow');
    assert.equal(alive(row.pid), false);
    assert.equal(stopped.bots[0].running, false);
  });
});
