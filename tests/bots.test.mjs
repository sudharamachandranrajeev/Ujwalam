// SPDX-License-Identifier: GPL-2.0-or-later
// Bot manager (BM1, BM6): detect, start, stop, health and the "only what Ujwalam started" rule. The "bots" are copies
// of the node executable running an idle loop; nothing real is started and the real bot ports are never contacted
// (all listeners use port 0). The process list is a seam for most tests (fast); one Windows test uses the real query.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { botStrayReport, scanBotStrays } from '../tools/stray-procs.mjs';
import { createBots, DEFAULT_WS, listProcessesByExe, loadBotConfig, parseWs, STATE_DIR, STATE_FILE, tcpAnswers } from '../services/bots/index.mjs';

const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-bots-')); tmpDirs.push(d); return d; };
const kids = new Set();
const IDLE = ['-e', 'setInterval(() => {}, 1000)'];
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(() => { for (const pid of kids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } kids.clear(); });
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* an exe may still be closing */ } } });

/** A copy of node under a bot-like name: its executable path is unique to the test. */
function fakeExe(name = 'fakebot') {
  const dir = mk();
  const exe = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  copyFileSync(process.execPath, exe);
  if (process.platform !== 'win32') chmodSync(exe, 0o755);
  return exe;
}

/** Process-list seam over real child processes: lists the registered, still-alive ones with their start time. */
function world() {
  const procs = new Map(); // pid -> { exe, startedAt }
  return {
    register(pid, exe) { procs.set(pid, { exe, startedAt: new Date().toISOString() }); kids.add(pid); },
    list: (exe) => [...procs].filter(([pid, p]) => p.exe === exe && isAlive(pid)).map(([pid, p]) => ({ pid, startedAt: p.startedAt })),
    spawnImpl(exe, args, o) { const c = spawn(exe, args, { ...o, windowsHide: true }); if (c.pid) this.register(c.pid, exe); this.lastOptions = o; return c; },
  };
}
function rig({ bot = 'streamerbot', ws } = {}) {
  const dataDir = mk();
  const exe = fakeExe();
  const w = world();
  const bots = createBots({
    dataDir, gracefulMs: 400,
    config: { [bot]: { exe, args: IDLE, ...(ws ? { ws } : {}) } },
    listProcesses: (e) => w.list(e), spawnImpl: (e, a, o) => w.spawnImpl(e, a, o),
  });
  return { dataDir, exe, w, bots, bot };
}
const stateOf = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, STATE_DIR, STATE_FILE), 'utf8'));

describe('configuration', () => {
  test('parseWs accepts 127.0.0.1 only', () => {
    assert.deepEqual(parseWs('ws://127.0.0.1:8093/'), { ok: true, port: 8093 });
    assert.deepEqual(parseWs('ws://127.0.0.1:8083'), { ok: true, port: 8083 });
    for (const bad of ['ws://localhost:8093/', 'ws://0.0.0.0:8093/', 'ws://192.168.1.5:8093/', 'ws://example.com:8093/', 'wss://127.0.0.1:8093/', 'http://127.0.0.1:8093/', 'ws://127.0.0.1:99999/', 'nonsense', '']) {
      assert.equal(parseWs(bad).ok, false, bad);
    }
    assert.equal(parseWs('ws://127.0.0.1:0/').ok, false, 'port 0 is not a service port');
  });

  test('loadBotConfig: profile keys, defaults, placeholders and refusals', () => {
    const f = path.join(mk(), 'profile.json');
    const abs = path.join(mk(), 'x.exe');
    writeFileSync(f, JSON.stringify({ paths: { streamerbot_exe: abs, speakerbot_exe: '<speakerbot-exe>' }, bots: { streamerbot_ws: 'ws://127.0.0.1:18093/', speakerbot_ws: 'ws://10.0.0.9:8083/' } }));
    const c = loadBotConfig({ profilePath: f });
    assert.equal(c.streamerbot.exe, path.resolve(abs));
    assert.equal(c.streamerbot.port, 18093);
    assert.equal(c.speakerbot.exe, null, 'a placeholder is not configured');
    assert.equal(c.speakerbot.port, null);
    assert.equal(c.speakerbot.wsError, 'not-loopback');
    writeFileSync(f, JSON.stringify({ paths: { streamerbot_exe: 'relative/bot.exe' } }));
    const d = loadBotConfig({ profilePath: f });
    assert.equal(d.streamerbot.exe, null, 'a relative path is refused');
    assert.equal(d.streamerbot.ws, DEFAULT_WS.streamerbot);
    assert.equal(d.speakerbot.port, 8083);
    assert.equal(loadBotConfig({ profilePath: path.join(mk(), 'missing.json') }).streamerbot.exe, null, 'a missing profile is not an error');
  });

  test('the committed profile template carries the placeholder keys', () => {
    const t = JSON.parse(readFileSync(new URL('../data/profile.example.json', import.meta.url), 'utf8'));
    assert.equal(t.paths.streamerbot_exe, '<streamerbot-exe>');
    assert.equal(t.paths.speakerbot_exe, '<speakerbot-exe>');
    // Placeholders, not the default addresses: every profile string is a private term for the git hooks.
    assert.match(t.bots.streamerbot_ws, /^<.*>$/);
    assert.match(t.bots.speakerbot_ws, /^<.*>$/);
    const f = path.join(mk(), 'profile.json');
    writeFileSync(f, JSON.stringify(t));
    const c = loadBotConfig({ profilePath: f });
    assert.equal(c.streamerbot.exe, null);
    assert.equal(c.streamerbot.port, 8093, 'a placeholder address falls back to the default');
    assert.equal(c.speakerbot.port, 8083);
  });
});

describe('health: a plain TCP connect, nothing sent', () => {
  test('answers on a listening port, sends no byte, and is false for a closed port', async () => {
    let received = 0; let connects = 0;
    const srv = net.createServer((s) => { connects++; s.on('data', (d) => { received += d.length; }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      assert.equal(await tcpAnswers(port, 1000), true);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(connects, 1);
      assert.equal(received, 0, 'no bytes are ever sent to the bot');
    } finally { await new Promise((r) => srv.close(r)); }
    assert.equal(await tcpAnswers(port, 500), false, 'closed port');
  });

  test('health() combines the process and the port; a loopback-only port setting is enforced', async () => {
    const srv = net.createServer((s) => s.destroy());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ws = `ws://127.0.0.1:${srv.address().port}/`;
    try {
      const { bots, w, exe, bot } = rig({ ws });
      let h = await bots.health(bot);
      assert.equal(h.running, false); assert.equal(h.portAnswering, true); assert.equal(h.ok, false, 'port alone is not healthy');
      assert.equal(h.installed, true);
      assert.equal((await bots.start(bot)).ok, true);
      h = await bots.health(bot);
      assert.deepEqual([h.running, h.startedByUs, h.portAnswering, h.ok], [true, true, true, true]);
      assert.equal(h.pid, w.list(exe)[0].pid);
      const bad = createBots({ dataDir: mk(), config: { streamerbot: { exe, ws: 'ws://192.168.1.2:8093/' } }, listProcesses: () => [] });
      const hb = await bad.health('streamerbot');
      assert.equal(hb.portAnswering, false); assert.equal(hb.wsError, 'not-loopback'); assert.equal(hb.port, null);
    } finally { await new Promise((r) => srv.close(r)); }
  });
});

describe('start and stop', () => {
  test('start: hidden, detached, no stdio; records pid and creation time; a second start is refused', async () => {
    const { bots, w, dataDir, bot, exe } = rig();
    const r = await bots.start(bot);
    assert.equal(r.ok, true);
    assert.equal(w.lastOptions.windowsHide, true);
    assert.equal(w.lastOptions.detached, true);
    assert.equal(w.lastOptions.stdio, 'ignore');
    const st = stateOf(dataDir)[bot];
    assert.equal(st.pid, r.pid);
    assert.ok(Number.isFinite(Date.parse(st.startedAt)));
    assert.equal(st.exe, path.basename(exe));
    const d = bots.detect(bot);
    assert.deepEqual([d.installed, d.running, d.startedByUs, d.pid], [true, true, true, r.pid]);
    assert.deepEqual(await bots.start(bot), { ok: false, reason: 'already-running' });
  });

  test('start: refused when the program is not installed; detect says so', async () => {
    const dataDir = mk();
    const missing = path.join(mk(), 'nothere.exe');
    const bots = createBots({ dataDir, config: { streamerbot: { exe: missing } }, listProcesses: () => [] });
    assert.deepEqual(await bots.start('streamerbot'), { ok: false, reason: 'not-installed' });
    assert.deepEqual(bots.detect('streamerbot'), { installed: false, running: false, startedByUs: false });
    assert.deepEqual(bots.detect('speakerbot'), { installed: false, running: false, startedByUs: false }, 'unconfigured bot');
    assert.throws(() => bots.detect('other'), /unknown-bot/);
  });

  test('stop: ends a bot Ujwalam started (graceful first, then forced) and clears the record', async () => {
    const { bots, w, exe, dataDir, bot } = rig();
    const { pid } = await bots.start(bot);
    const r = await bots.stop(bot);
    assert.equal(r.ok, true);
    assert.equal(isAlive(pid), false);
    assert.equal(w.list(exe).length, 0);
    assert.equal(stateOf(dataDir)[bot], undefined, 'record cleared');
    assert.deepEqual(await bots.stop(bot), { ok: false, reason: 'not-started-by-ujwalam' });
  });

  test('startedByUs survives a restart of the studio (new instance, same data dir)', async () => {
    const { bots, w, exe, dataDir, bot } = rig();
    const { pid } = await bots.start(bot);
    const again = createBots({ dataDir, gracefulMs: 400, config: { [bot]: { exe, args: IDLE } }, listProcesses: (e) => w.list(e) });
    const d = again.detect(bot);
    assert.deepEqual([d.running, d.startedByUs, d.pid], [true, true, pid]);
    assert.equal((await again.stop(bot)).ok, true);
    assert.equal(isAlive(pid), false);
  });

  test('a copy the user started is never stopped and never counted as ours', async () => {
    const { bots, w, exe, bot, dataDir } = rig();
    const user = spawn(exe, IDLE, { stdio: 'ignore', windowsHide: true });
    w.register(user.pid, exe);
    const d = bots.detect(bot);
    assert.deepEqual([d.running, d.startedByUs, d.pid], [true, false, user.pid]);
    assert.deepEqual(await bots.start(bot), { ok: false, reason: 'already-running' });
    assert.deepEqual(await bots.stop(bot), { ok: false, reason: 'not-started-by-ujwalam' });
    assert.deepEqual(await bots.stopStarted(), {});
    assert.equal(isAlive(user.pid), true, 'the user copy is still running');
    assert.equal(existsSync(path.join(dataDir, STATE_DIR, STATE_FILE)), false, 'nothing recorded');
  });

  test('a recorded pid reused by another process (different creation time) is not stopped', async () => {
    const { bots, w, exe, bot, dataDir } = rig();
    const user = spawn(exe, IDLE, { stdio: 'ignore', windowsHide: true });
    w.register(user.pid, exe);
    mkdirSync(path.join(dataDir, STATE_DIR), { recursive: true });
    writeFileSync(path.join(dataDir, STATE_DIR, STATE_FILE), JSON.stringify({ [bot]: { pid: user.pid, startedAt: '2020-01-01T00:00:00.000Z', exe: path.basename(exe) } }));
    assert.equal(bots.detect(bot).startedByUs, false);
    assert.equal(isAlive(user.pid), true);
    assert.equal(stateOf(dataDir)[bot], undefined, 'the stale record is dropped');
    assert.deepEqual(await bots.stop(bot), { ok: false, reason: 'not-started-by-ujwalam' });
    assert.equal(isAlive(user.pid), true);
  });

  test('stopStarted (studio stop, BM6): ends only recorded bots, leaves the user copy of the other bot', async () => {
    const dataDir = mk();
    const exeA = fakeExe('fakebot-a'); const exeB = fakeExe('fakebot-b');
    const w = world();
    const bots = createBots({
      dataDir, gracefulMs: 400, config: { streamerbot: { exe: exeA, args: IDLE }, speakerbot: { exe: exeB, args: IDLE } },
      listProcesses: (e) => w.list(e), spawnImpl: (e, a, o) => w.spawnImpl(e, a, o),
    });
    const mine = (await bots.start('streamerbot')).pid;
    const user = spawn(exeB, IDLE, { stdio: 'ignore', windowsHide: true });
    w.register(user.pid, exeB);
    const out = await bots.stopStarted();
    assert.deepEqual(Object.keys(out), ['streamerbot']);
    assert.equal(out.streamerbot.ok, true);
    assert.equal(isAlive(mine), false);
    assert.equal(isAlive(user.pid), true);
  });

  test('a failing process list throws and is never read as "not running"', async () => {
    const dataDir = mk();
    const exe = fakeExe();
    const bots = createBots({ dataDir, config: { streamerbot: { exe } }, listProcesses: () => { throw new Error('process list failed 3 times (exit 1)'); } });
    assert.throws(() => bots.detect('streamerbot'), /process list failed/);
    await assert.rejects(bots.start('streamerbot'), /process list failed/);
    const all = await bots.statusAll();
    assert.equal(all.find((b) => b.bot === 'streamerbot').error, 'process-list-failed');
    assert.equal(all.find((b) => b.bot === 'streamerbot').running, false);
  });

  test('a program that exits at once is reported, not recorded', async () => {
    const dataDir = mk();
    const exe = fakeExe();
    const bots = createBots({ dataDir, config: { streamerbot: { exe, args: ['-e', '0'] } }, listProcesses: () => [] });
    assert.deepEqual(await bots.start('streamerbot'), { ok: false, reason: 'exited-early' });
    assert.equal(existsSync(path.join(dataDir, STATE_DIR, STATE_FILE)), false);
  });
});

describe('stray report (tools/stray-procs.mjs, report only)', () => {
  test('lists a bot Ujwalam started and left running; never the user copy; nothing when none', async () => {
    const { bots, w, exe, bot } = rig();
    assert.deepEqual(scanBotStrays({ bots }), []);
    assert.equal(botStrayReport([]), null);
    const user = spawn(exe, IDLE, { stdio: 'ignore', windowsHide: true });
    w.register(user.pid, exe);
    assert.deepEqual(scanBotStrays({ bots }), [], 'a user copy is not listed');
    user.kill();
    await new Promise((r) => user.once('exit', r));
    const { pid } = await bots.start(bot);
    const found = scanBotStrays({ bots });
    assert.deepEqual(found, [{ bot, label: 'Streamer.bot', pid }]);
    assert.match(botStrayReport(found), /1 bot\(s\) started by Ujwalam still running \(report only\)/);
    await bots.stop(bot);
    assert.deepEqual(scanBotStrays({ bots }), []);
  });
});

describe('real process query (Windows CIM, same pattern as tools/stray-procs.mjs)', { skip: process.platform !== 'win32' }, () => {
  test('start, detect, health, stop on a copied executable', { timeout: 60_000 }, async () => {
    const dataDir = mk();
    const exe = fakeExe('ujw-fakebot-cim');
    const srv = net.createServer((s) => s.destroy());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const bots = createBots({ dataDir, gracefulMs: 500, config: { streamerbot: { exe, args: IDLE, ws: `ws://127.0.0.1:${srv.address().port}/` } } });
    let pid = null;
    try {
      assert.deepEqual(listProcessesByExe(exe), [], 'nothing runs from the fake path yet');
      const r = await bots.start('streamerbot');
      assert.equal(r.ok, true);
      pid = r.pid; kids.add(pid);
      const procs = listProcessesByExe(exe);
      assert.deepEqual(procs.map((p) => p.pid), [pid]);
      const rec = stateOf(dataDir).streamerbot;
      assert.ok(Math.abs(Date.parse(rec.startedAt) - Date.parse(procs[0].startedAt)) < 2000);
      const h = await bots.health('streamerbot');
      assert.deepEqual([h.running, h.startedByUs, h.portAnswering, h.ok], [true, true, true, true]);
      const s = await bots.stop('streamerbot');
      assert.equal(s.ok, true);
      assert.equal(isAlive(pid), false);
      assert.deepEqual(listProcessesByExe(exe), []);
    } finally {
      await new Promise((r) => srv.close(r));
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
