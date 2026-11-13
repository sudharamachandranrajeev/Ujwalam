// SPDX-License-Identifier: GPL-3.0-or-later
// LU2 data hot-reload (D324), no host: the shared data source (valid change applies, invalid keeps the last good value
// and says why, save-through-rename, half-written file), and each owner: feature flags, posting rules, effect guards
// (presets) in the overlay server and in a staged overlay child, the studio UI server's own files and its notices.
// The same kinds are changed during a loopback stream by the live soak (tools/soak/live-soak.mjs, LU8).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDataNotifier, createDataSource, parseJsonText } from '../services/common/data-reload.mjs';
import { createFlags, DEFAULT_FLAGS_FILE, LOCAL_NAME } from '../services/flags/index.mjs';
import { createRulesSource, userRulesFile } from '../services/posting/auto-post.mjs';
import { DEFAULT_GUARDS_FILE, createEffectGuards, createOverlayServer, loadGuardConfig } from '../services/overlay-server/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { readTaskFiles } from '../services/studio-ui/tasks.mjs';
import { stageRuntime, writeViaRename } from '../tools/soak/stage.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lu2-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const old = (f) => { const t = new Date(Date.now() - 10_000); utimesSync(f, t, t); }; // a write that has settled
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(50); }
}
const numParse = (t) => { const j = parseJsonText(t); if (!Number.isInteger(j.n)) throw new Error('n must be a whole number'); return j.n; };

describe('data source', () => {
  test('a valid change applies, an invalid one keeps the last good value and is reported once, a fix applies', () => {
    const f = path.join(tmp(), 'x.json'); const seen = [];
    writeFileSync(f, '{"n":1}');
    const s = createDataSource({ kind: 'k', file: f, parse: numParse, report: (e) => seen.push(e) });
    assert.equal(s.get(), 1);
    writeFileSync(f, '{"n":2}'); old(f);
    assert.equal(s.get(), 2);
    assert.equal(s.status().version, 1);
    writeFileSync(f, '{"n": "two"}'); old(f);
    assert.equal(s.get(), 2, 'old value kept');
    assert.equal(s.get(), 2);
    assert.match(s.status().rejected.why, /whole number/);
    writeFileSync(f, '{"n":'); old(f);
    assert.equal(s.get(), 2);
    assert.match(s.status().rejected.why, /not valid JSON/);
    writeFileSync(f, '{"n":3}'); old(f);
    assert.equal(s.get(), 3);
    assert.equal(s.status().ok, true);
    assert.deepEqual(seen.map((e) => [e.ok, e.first]), [[true, false], [false, false], [false, false], [true, false]]);
  });

  test('a file still being written (young, does not parse) is retried, not reported', () => {
    const f = path.join(tmp(), 'x.json'); const seen = [];
    writeFileSync(f, '{"n":1}'); old(f);
    const s = createDataSource({ kind: 'k', file: f, parse: numParse, report: (e) => seen.push(e), settleMs: 60_000 });
    s.get();
    writeFileSync(f, '{"n":');
    assert.equal(s.get(), 1);
    assert.equal(s.status().rejected, null);
    assert.deepEqual(seen, []);
  });

  test('missing: the fallback applies when given, else the last good value stays', () => {
    const d = tmp(); const f = path.join(d, 'x.json');
    const a = createDataSource({ kind: 'k', file: f, parse: numParse, missing: () => 0 });
    assert.equal(a.get(), 0);
    writeFileSync(f, '{"n":5}'); old(f);
    assert.equal(a.get(), 5);
    rmSync(f);
    assert.equal(a.get(), 0);
    writeFileSync(f, '{"n":7}'); old(f);
    const b = createDataSource({ kind: 'k', file: f, parse: numParse });
    assert.equal(b.get(), 7);
    rmSync(f);
    assert.equal(b.get(), 7);
    assert.match(b.status().rejected.why, /missing/);
  });

  test('watch: a save through a temp file and a rename applies without any reader', async () => {
    const f = path.join(tmp(), 'x.json'); const applied = [];
    writeFileSync(f, '{"n":1}');
    const s = createDataSource({ kind: 'k', file: f, parse: numParse, settleMs: 0 });
    s.onApply((v) => applied.push(v));
    const stop = s.watch({ debounceMs: 50, pollMs: 400 });
    try {
      writeViaRename(f, '{"n":2}');
      assert.ok(await until(() => applied.includes(2)), 'applied through the watch');
      writeViaRename(f, 'nope');
      assert.ok(await until(() => s.status().rejected), 'rejected through the watch');
      assert.equal(s.get(), 2);
    } finally { stop(); }
  });

  test('watch: after stop no pending debounce or retry runs, even when a poll ran in between (review P2)', async () => {
    const f = path.join(tmp(), 'x.json');
    writeFileSync(f, '{"n":1}'); old(f);
    const s = createDataSource({ kind: 'k', file: f, parse: numParse, settleMs: 0 });
    const stop = s.watch({ debounceMs: 400, pollMs: 40 }); // the poll runs long before the debounce fires
    writeViaRename(f, '{"n":2}');                            // a watch event: debounce pending
    assert.ok(await until(() => s.status().version === 1, 300), 'the poll applied the change');
    stop();
    const v = s.status().version;
    writeViaRename(f, '{"n":33}');                           // only the leaked debounce timer could read this
    await sleep(700);
    assert.equal(s.status().version, v, 'nothing read the file after stop');
  });

  test('notifier: a rejection writes a failed notice task, a later valid change turns it into done', () => {
    const d = tmp(); const lines = [];
    const n = createDataNotifier({ dataDir: d, writeTask: (dir, t) => { mkdirSync(path.join(dir, 'tasks'), { recursive: true }); writeFileSync(path.join(dir, 'tasks', `${t.id}.json`), JSON.stringify(t)); return true; }, log: (m) => lines.push(m) });
    n({ kind: 'posting-rules', file: '/x/auto-post-rules.json', ok: true, first: true });
    assert.equal(lines.length, 0, 'the first load is not news');
    n({ kind: 'posting-rules', file: '/x/auto-post-rules.json', ok: false, why: 'rule 0: bad or duplicate id', first: false });
    let t = readTaskFiles(d)[0];
    assert.equal(t.state, 'failed'); assert.equal(t.id, 'data-posting-rules');
    assert.match(t.note, /auto-post-rules\.json: rule 0/); assert.ok(!t.note.includes('/x/'), 'base name only');
    n({ kind: 'posting-rules', file: '/x/auto-post-rules.json', ok: true, first: false });
    t = readTaskFiles(d)[0];
    assert.equal(t.state, 'done');
    assert.equal(lines.length, 2);
  });

  test('notifier: a file missing at start (never loaded) says nothing from it is in use, once, not "last good version"', () => {
    const d = tmp(); const seen = [];
    const s = createDataSource({ kind: 'posting-rules', file: path.join(d, 'auto-post-rules.json'), parse: (t) => parseJsonText(t), report: (e) => seen.push(e) });
    assert.throws(() => s.get());
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].ok, seen[0].loaded, seen[0].why], [false, false, 'file missing']);
    const n = createDataNotifier({ dataDir: d, writeTask: (dir, t) => { mkdirSync(path.join(dir, 'tasks'), { recursive: true }); writeFileSync(path.join(dir, 'tasks', `${t.id}.json`), JSON.stringify(t)); return true; }, log: () => {} });
    n(seen[0]);
    const t = readTaskFiles(d)[0];
    assert.equal(t.note, 'auto-post-rules.json: file missing. Nothing from this file is in use until it is fixed.');
  });
});

describe('owners', () => {
  test('flags: an edit made on disk applies; a broken local file keeps the last values; a broken definitions file keeps the list', () => {
    const d = tmp(); const seen = [];
    const defsFile = path.join(d, 'flags.json');
    const defs = JSON.parse(readFileSync(DEFAULT_FLAGS_FILE, 'utf8'));
    writeFileSync(defsFile, JSON.stringify(defs)); old(defsFile);
    const f = createFlags({ dataDir: d, definitionsFile: defsFile, report: (e) => seen.push(e) });
    const id = f.ids()[0];
    const local = path.join(d, LOCAL_NAME);
    writeFileSync(local, JSON.stringify({ flags: { [id]: true } })); old(local);
    assert.equal(f.isOn(id), true, 'external edit applied');
    writeFileSync(local, '{"flags": [true]}'); old(local);
    assert.equal(f.isOn(id), true, 'broken file: last good values');
    assert.ok(seen.some((e) => e.kind === 'flags-local' && !e.ok));
    f.set(id, false);
    assert.equal(f.isOn(id), false, 'a flip still works after a broken file');
    writeFileSync(defsFile, '{"flags": 3}'); old(defsFile);
    const later = Date.now() + 1100; while (Date.now() < later) { /* the definitions are checked once a second */ }
    assert.equal(f.ids().length, defs.flags.length, 'definitions kept');
    assert.ok(seen.some((e) => e.kind === 'flags-definitions' && !e.ok));
    writeFileSync(defsFile, JSON.stringify({ flags: [...defs.flags, { id: 'lu2-test-flag', description: 'test', default: true, since: '2026-11-10', label: 'Test flag', page: 'advanced', summary: 'A test flag.' }] })); old(defsFile);
    const later2 = Date.now() + 1100; while (Date.now() < later2) { /* idem */ }
    assert.equal(f.isOn('lu2-test-flag'), true, 'new definition applied');
  });

  test('flags: a known flag with a non-boolean value rejects the whole file; a default-on flag does not turn on (review P2)', () => {
    const d = tmp(); const seen = [];
    const defsFile = path.join(d, 'flags.json');
    const defs = JSON.parse(readFileSync(DEFAULT_FLAGS_FILE, 'utf8'));
    defs.flags.push({ id: 'lu2-default-on', description: 'test', default: true, since: '2026-11-10', label: 'Test flag', page: 'advanced', summary: 'A test flag.' });
    writeFileSync(defsFile, JSON.stringify(defs)); old(defsFile);
    const f = createFlags({ dataDir: d, definitionsFile: defsFile, report: (e) => seen.push(e) });
    const local = path.join(d, LOCAL_NAME);
    writeFileSync(local, JSON.stringify({ flags: { 'lu2-default-on': false } })); old(local);
    assert.equal(f.isOn('lu2-default-on'), false);
    writeFileSync(local, JSON.stringify({ flags: { 'lu2-default-on': 'false' } })); old(local);
    assert.equal(f.isOn('lu2-default-on'), false, 'the override stays off');
    const r = seen.filter((e) => e.kind === 'flags-local' && !e.ok).at(-1);
    assert.match(r?.why ?? '', /lu2-default-on must be true or false/);
    writeFileSync(local, JSON.stringify({ flags: { 'lu2-default-on': false, 'not-a-flag': 'x' } })); old(local);
    assert.equal(f.isOn('lu2-default-on'), false);
    assert.equal(f.dataStatus().find((x) => x.kind === 'flags-local').rejected, null, 'unknown ids are not checked');
  });

  test('posting rules: a valid edit applies, a broken one keeps the last good rules, broken at start fails closed', () => {
    const d = tmp(); const seen = [];
    const file = userRulesFile(d);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"rules": ['); old(file);
    const s = createRulesSource({ dataDir: d, report: (e) => seen.push(e) });
    assert.throws(() => s.get(), (e) => e.code === 'bad-rules', 'no good version yet: fail closed');
    writeFileSync(file, JSON.stringify({ rules: [{ id: 'one', target: 'youtube-shorts', minScore: 1, maxPerDay: 2 }] })); old(file);
    assert.equal(s.get().rules.length, 1);
    writeFileSync(file, JSON.stringify({ rules: [{ id: 'one', target: 'youtube-shorts', minScore: 1, maxPerDay: 101 }] })); old(file);
    assert.equal(s.get().rules[0].maxPerDay, 2, 'kept');
    assert.match(s.status().rejected.why, /maxPerDay/);
    writeFileSync(file, JSON.stringify({ rules: [{ id: 'one', target: 'youtube-shorts', minScore: 1, maxPerDay: 3 }, { id: 'two', target: 'youtube-shorts', minScore: 2, maxPerDay: 1 }] })); old(file);
    assert.equal(s.get().rules.length, 2);
    assert.ok(seen.some((e) => !e.ok && /maxPerDay/.test(e.why)));
  });

  test('effect guards: a new config applies while plays run; budget and flash windows carry over; an invalid one throws and keeps', () => {
    let t = 1000;
    const cfg = loadGuardConfig(DEFAULT_GUARDS_FILE);
    const g = createEffectGuards({ config: cfg, now: () => t, setTimer: () => 0, clearTimer: () => {} });
    const name = Object.keys(cfg.effects)[0];
    assert.equal(g.gate({ name, source: 'test' }).allow, true);
    const used = g.stats().budgetUsed;
    const next = structuredClone(cfg);
    next.budget.maxPerMinute = used; // the window already holds `used` plays: the next must be refused
    g.setConfig(next);
    assert.equal(g.config.budget.maxPerMinute, used);
    assert.equal(g.stats().budgetUsed, used, 'budget window carried over');
    t += 60;
    const other = Object.keys(cfg.effects).find((k) => k !== name);
    assert.equal(g.gate({ name: other, source: 'test' }).reason, 'budget');
    const bad = structuredClone(cfg); bad.flash.maxPerSecond = 9;
    assert.throws(() => g.setConfig(bad), /maxPerSecond/);
    assert.equal(g.config.budget.maxPerMinute, used, 'old config kept');
    const srv = createOverlayServer({ root: tmp(), guards: cfg, flashMeasurements: false });
    assert.deepEqual(srv.reloadGuards(bad), { ok: false, why: srv.reloadGuards(bad).why });
    assert.equal(srv.reloadGuards(next).ok, true);
    assert.equal(srv.guards.config.budget.maxPerMinute, used);
  });

  test('studio UI server: /ui/api/data lists its sources; the task-panel setting and the guide reload; a broken rules file shows a notice', async () => {
    const d = tmp();
    const cfgFile = path.join(d, 'tasks-config.json');
    writeFileSync(cfgFile, JSON.stringify({ stallAfterMs: 180000 })); old(cfgFile);
    const guideDir = path.join(d, 'guide'); mkdirSync(guideDir);
    writeFileSync(path.join(guideDir, 'tour.json'), JSON.stringify({ tours: [{ id: 'a' }] }));
    writeFileSync(path.join(guideDir, 'hints.json'), JSON.stringify({ hints: [] }));
    for (const n of ['tour.json', 'hints.json']) old(path.join(guideDir, n));
    const rules = userRulesFile(d); mkdirSync(path.dirname(rules), { recursive: true });
    writeFileSync(rules, JSON.stringify({ rules: [] })); old(rules);
    const fake = createFakeHost();
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const KEY = 'k'.repeat(48);
    const srv = createStudioServer({ uiRoot: path.join(REPO, 'ui'), core, host, launchKey: KEY, dataDir: d, tasksConfigFile: cfgFile, guideDir, limits: { statusPollMs: 1000 }, log: () => {} });
    const { port } = await srv.listen();
    const get = (u, cookie) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: u, headers: cookie ? { cookie } : {} }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b ? (() => { try { return JSON.parse(b); } catch { return null; } })() : null })); });
    });
    try {
      const cookie = (await get(`/login?k=${KEY}`)).headers['set-cookie'][0].split(';')[0];
      const kinds = (await get('/ui/api/data', cookie)).body.sources.map((s) => s.kind);
      for (const k of ['flags-definitions', 'flags-local', 'posting-rules', 'studio-tasks', 'guide-tour', 'guide-hints']) assert.ok(kinds.includes(k), k);
      writeViaRename(cfgFile, JSON.stringify({ stallAfterMs: 240000 }));
      writeViaRename(path.join(guideDir, 'tour.json'), JSON.stringify({ tours: [{ id: 'a' }, { id: 'b' }] }));
      assert.ok(await until(async () => (await get('/ui/api/data', cookie)).body.sources.find((s) => s.kind === 'studio-tasks').version >= 1, 6000), 'tasks config reloaded');
      assert.ok(await until(async () => (await get('/ui/api/guide', cookie)).body.tours.length === 2, 6000), 'guide reloaded');
      writeViaRename(path.join(guideDir, 'tour.json'), '{"tours": 1}');
      writeViaRename(rules, '{"rules": [{"id": "Bad Id"}]}');
      assert.ok(await until(() => readTaskFiles(d).some((t) => t.id === 'data-posting-rules' && t.state === 'failed'), 6000), 'notice in the task area');
      assert.ok(await until(async () => (await get('/ui/api/data', cookie)).body.sources.find((s) => s.kind === 'guide-tour').rejected, 6000));
      assert.equal((await get('/ui/api/guide', cookie)).body.tours.length, 2, 'guide: last good kept');
      const tasks = (await get('/ui/api/tasks', cookie)).body.tasks;
      assert.ok(tasks.some((t) => t.id === 'data-posting-rules' && t.state === 'failed' && /bad or duplicate id/.test(t.note)));
    } finally { await srv.close(); }
  });

  test('overlay child (staged runtime): effect presets reload while it runs; a broken file keeps them and is reported', { timeout: 60000 }, async () => {
    const d = tmp();
    const coreData = path.join(d, 'core'); mkdirSync(coreData);
    const stage = stageRuntime(path.join(d, 'stage'), { eventCoreData: coreData });
    const overlays = path.join(d, 'overlays'); mkdirSync(overlays);
    const child = spawn(process.execPath, [stage.overlayScript, '--root', overlays], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, UJWALAM_HEADLESS: '1' } });
    let err = ''; child.stderr.on('data', (c) => { err += c; });
    const replies = new Map(); let ready = null;
    createInterface({ input: child.stdout }).on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.type === 'ready') ready = m; if (m.type === 'reply') replies.set(m.id, m); });
    let id = 0;
    const stats = async () => { const n = ++id; child.stdin.write(`${JSON.stringify({ id: n, op: 'stats' })}\n`); await until(() => replies.has(n), 5000); return replies.get(n).result; };
    try {
      assert.ok(await until(() => ready, 20000), `child ready (${err.slice(0, 200)})`);
      const file = stage.dataFile(path.join('effects', 'guards.json'));
      const before = (await stats()).guards.budgetPerMinute;
      const j = JSON.parse(readFileSync(file, 'utf8')); j.budget.maxPerMinute = before + 7;
      writeViaRename(file, JSON.stringify(j, null, 2));
      assert.ok(await until(async () => (await stats()).guards.budgetPerMinute === before + 7, 8000), 'new preset applied');
      j.flash.maxPerSecond = 12; // above the settled flash limit: invalid
      writeViaRename(file, JSON.stringify(j, null, 2));
      assert.ok(await until(async () => (await stats()).data.find((s) => s.kind === 'effect-guards').rejected, 8000), 'rejection seen');
      const s = await stats();
      assert.equal(s.guards.budgetPerMinute, before + 7, 'last good preset kept');
      assert.match(s.data.find((x) => x.kind === 'effect-guards').rejected.why, /maxPerSecond/);
      assert.ok(await until(() => readTaskFiles(coreData).some((t) => t.id === 'data-effect-guards' && t.state === 'failed'), 4000), 'notice for the studio task area');
      assert.match(err, /effect-guards: guards\.json not applied/);
      assert.ok(!/\berror\b/i.test(err.replace(/not applied/g, '')), 'no error-level line');
    } finally {
      child.stdin.end();
      await until(() => child.exitCode !== null, 10000);
      if (child.exitCode === null) child.kill();
      assert.ok(existsSync(stage.root));
    }
  });
});
