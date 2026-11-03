// SPDX-License-Identifier: GPL-2.0-or-later
// Bot manager (BM1, D193). Node stdlib only. Finds the user's installed Streamer.bot and Speaker.bot, starts them
// hidden, reports health, and stops only a copy Ujwalam started itself. Plan: docs/plan/2026-11-03-bot-manager-plan.md.
//
// Configuration (never committed; both live in the gitignored data/profile.local.json):
//   paths.streamerbot_exe, paths.speakerbot_exe   absolute path of each program
//   bots.streamerbot_ws,   bots.speakerbot_ws     optional WebSocket address, e.g. "ws://127.0.0.1:8093/"
// The WebSocket address must be on this machine (127.0.0.1). Anything else is refused.
//
// Rules kept here:
//   - "running" means a process whose executable path equals the configured path. A copy the user started counts as
//     running, but it is never "started by Ujwalam" and is never stopped by Ujwalam.
//   - "started by Ujwalam" is stored as pid + process creation time in <dataDir>/bots/state.json. A reused pid has a
//     different creation time, so it does not match.
//   - health() only opens a plain TCP connection to the port and closes it. It sends no WebSocket frame and nothing
//     else, to either bot: Ujwalam's connection to Streamer.bot stays read-only (D192).
//   - Every child process is started with windowsHide: true (D191) and every wait has a timeout.
//   - Both programs are GUI apps. Node cannot ask Windows for SW_SHOWNOACTIVATE; windowsHide: true (SW_HIDE) is the
//     closest it offers. UNVERIFIED: what that does to each bot's main window (hidden, or ignored by the app) and
//     whether either bot steals focus at start. The user must check this at runtime on the laptop.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemTool } from '../event-core/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BOTS = Object.freeze(['streamerbot', 'speakerbot']);
export const BOT_LABELS = Object.freeze({ streamerbot: 'Streamer.bot', speakerbot: 'Speaker.bot' });
export const DEFAULT_WS = Object.freeze({ streamerbot: 'ws://127.0.0.1:8093/', speakerbot: 'ws://127.0.0.1:8083/' });
export const STATE_DIR = 'bots';
export const STATE_FILE = 'state.json';
export const GRACEFUL_MS = 10_000;
export const HEALTH_MS = 1_000;
const START_TOLERANCE_MS = 2_000; // creation time match between the state file and the process list

const isPlaceholder = (v) => typeof v === 'string' && /^<.*>$/.test(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parses a bot WebSocket address. Loopback only. Returns { ok: true, port } or { ok: false, reason }. */
export function parseWs(value) {
  let u;
  try { u = new URL(String(value)); } catch { return { ok: false, reason: 'not-a-url' }; }
  if (u.protocol !== 'ws:') return { ok: false, reason: 'not-ws' };
  if (u.hostname !== '127.0.0.1') return { ok: false, reason: 'not-loopback' };
  const port = u.port === '' ? 80 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'bad-port' };
  return { ok: true, port };
}

/**
 * Reads the profile. Returns { streamerbot: { exe|null, ws, port|null, wsError|null }, speakerbot: {...} }.
 * A missing file, a placeholder or a relative path means "not configured" (exe null). Never throws on a bad profile.
 */
export function loadBotConfig({ profilePath = path.join(REPO, 'data', 'profile.local.json') } = {}) {
  let prof = {};
  try { prof = JSON.parse(readFileSync(profilePath, 'utf8')) ?? {}; } catch { prof = {}; }
  const out = {};
  for (const bot of BOTS) {
    const exeRaw = prof?.paths?.[`${bot}_exe`];
    const exe = typeof exeRaw === 'string' && exeRaw && !isPlaceholder(exeRaw) && path.isAbsolute(exeRaw) ? path.resolve(exeRaw) : null;
    const wsRaw = prof?.bots?.[`${bot}_ws`];
    const ws = typeof wsRaw === 'string' && wsRaw && !isPlaceholder(wsRaw) ? wsRaw : DEFAULT_WS[bot];
    const p = parseWs(ws);
    out[bot] = { exe, ws, port: p.ok ? p.port : null, wsError: p.ok ? null : p.reason };
  }
  return out;
}

const norm = (p) => path.resolve(String(p)).toLowerCase();

/**
 * Processes whose executable path equals `exe`: [{ pid, startedAt (ISO) }]. Windows: the same PowerShell CIM query as
 * tools/stray-procs.mjs, retried, then thrown (an empty answer after a failed query must never read as "not running").
 */
export function listProcessesByExe(exe) {
  if (process.platform === 'win32') {
    const name = path.win32.basename(exe);
    if (!/^[A-Za-z0-9._ -]{1,64}$/.test(name)) throw new Error('bad executable name');
    let why = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = spawnSync(systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
        `$r = @(Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath; startedAt = $_.CreationDate.ToUniversalTime().ToString('o') } }); if ($r.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $r -Compress }`],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      if (r.status === 0 && r.stdout.trim()) {
        const v = JSON.parse(r.stdout);
        return (Array.isArray(v) ? v : [v]).filter((p) => p.path && norm(p.path) === norm(exe)).map((p) => ({ pid: p.pid, startedAt: p.startedAt }));
      }
      why = r.error ? r.error.code ?? r.error.message : `exit ${r.status}`;
    }
    throw new Error(`process list failed 3 times (${why})`);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,lstart=,args='], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (r.status !== 0) throw new Error('process list failed');
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => m[3] === exe || m[3].startsWith(`${exe} `)).map((m) => ({ pid: Number(m[1]), startedAt: new Date(m[2]).toISOString() }));
}

/** True when something accepts a TCP connection on 127.0.0.1:port within timeoutMs. Sends nothing. */
export function tcpAnswers(port, timeoutMs = HEALTH_MS) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host: '127.0.0.1', port });
    const end = (v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => end(false), timeoutMs);
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/**
 * opts: { dataDir, config?, profilePath?, listProcesses?(exe), spawnImpl?, tcp?(port, ms), gracefulMs? }
 * config (tests): { streamerbot: { exe, ws?, args? }, ... } replaces the profile. args are extra start arguments (test
 * only; the profile has none). The other opts are test seams.
 */
export function createBots(opts) {
  if (typeof opts?.dataDir !== 'string' || !opts.dataDir) throw new Error('bots: dataDir required');
  const stateFile = path.join(opts.dataDir, STATE_DIR, STATE_FILE);
  const gracefulMs = opts.gracefulMs ?? GRACEFUL_MS;
  const list = opts.listProcesses ?? listProcessesByExe;
  const spawnFn = opts.spawnImpl ?? spawn;
  const tcp = opts.tcp ?? tcpAnswers;

  function cfg(bot) {
    if (!BOTS.includes(bot)) throw Object.assign(new Error('unknown-bot'), { code: 'UNKNOWN_BOT' });
    if (opts.config) {
      const c = opts.config[bot] ?? {};
      const p = parseWs(c.ws ?? DEFAULT_WS[bot]);
      return { exe: c.exe ? path.resolve(c.exe) : null, port: p.ok ? p.port : null, wsError: p.ok ? null : p.reason, args: c.args ?? [] };
    }
    return { ...loadBotConfig({ profilePath: opts.profilePath })[bot], args: [] };
  }
  const installed = (c) => !!c.exe && existsSync(c.exe) && statSync(c.exe).isFile();

  function readState() {
    try { const j = JSON.parse(readFileSync(stateFile, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
  }
  function writeState(s) {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(tmp, stateFile);
  }
  function setRecord(bot, rec) {
    const s = readState();
    if (rec) s[bot] = rec; else delete s[bot];
    writeState(s);
  }
  const sameProc = (rec, p) => !!rec && !!p && rec.pid === p.pid && Math.abs(Date.parse(rec.startedAt) - Date.parse(p.startedAt)) <= START_TOLERANCE_MS;

  /** { installed, running, pid?, startedByUs }. Throws when the process list fails (never a false "not running"). */
  function detect(bot) {
    const c = cfg(bot);
    if (!c.exe) return { installed: false, running: false, startedByUs: false };
    const procs = list(c.exe);
    const rec = readState()[bot];
    const mine = rec ? procs.find((p) => sameProc(rec, p)) : null;
    if (rec && !mine) { try { setRecord(bot, null); } catch { /* a stale record stays; harmless */ } } // our copy has ended
    const p = mine ?? procs[0];
    return { installed: installed(c), running: procs.length > 0, ...(p ? { pid: p.pid } : {}), startedByUs: !!mine };
  }

  /** Starts a bot that is installed and not running. Returns { ok, reason?, pid? }. */
  async function start(bot) {
    const c = cfg(bot);
    if (!installed(c)) return { ok: false, reason: 'not-installed' };
    if (list(c.exe).length > 0) return { ok: false, reason: 'already-running' };
    let child;
    try {
      child = spawnFn(c.exe, c.args, {
        cwd: path.dirname(c.exe), detached: true, stdio: 'ignore',
        windowsHide: true // see the header: these are GUI apps; the effect on their main window is UNVERIFIED
      });
      child.on('error', () => {});
      child.unref();
    } catch (e) { return { ok: false, reason: `spawn-failed:${String(e?.code ?? 'error').slice(0, 40)}` }; }
    const pid = child.pid;
    if (!pid) return { ok: false, reason: 'spawn-failed:no-pid' };
    // Record the process creation time (not our clock), so a reused pid can never match later.
    for (let i = 0; i < 10; i++) {
      const p = list(c.exe).find((x) => x.pid === pid);
      if (p) { setRecord(bot, { pid, startedAt: p.startedAt, exe: path.basename(c.exe) }); return { ok: true, pid }; }
      await sleep(300);
    }
    return { ok: false, reason: 'exited-early' };
  }

  function taskkill(pid, force) {
    const args = ['/PID', String(pid), ...(force ? ['/F', '/T'] : [])];
    if (process.platform === 'win32') {
      spawnSync(systemTool('taskkill.exe'), args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    } else {
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  /** Stops a bot only when Ujwalam started it (pid and creation time both match). Returns { ok, reason?, forced? }. */
  async function stop(bot) {
    const c = cfg(bot);
    if (!c.exe) return { ok: false, reason: 'not-installed' };
    const rec = readState()[bot];
    if (!rec) return { ok: false, reason: 'not-started-by-ujwalam' };
    const mine = list(c.exe).find((p) => sameProc(rec, p));
    if (!mine) { setRecord(bot, null); return { ok: true, reason: 'already-stopped' }; }
    taskkill(mine.pid, false); // graceful: asks the window to close
    const until = Date.now() + gracefulMs;
    while (Date.now() < until && alive(mine.pid)) await sleep(200);
    let forced = false;
    if (alive(mine.pid) && list(c.exe).some((p) => sameProc(rec, p))) { // identity checked again before the hard kill
      taskkill(mine.pid, true); forced = true;
      const hard = Date.now() + 5_000;
      while (Date.now() < hard && alive(mine.pid)) await sleep(100);
    }
    if (alive(mine.pid) && list(c.exe).some((p) => sameProc(rec, p))) return { ok: false, reason: 'still-running' };
    setRecord(bot, null);
    return { ok: true, forced };
  }

  /** Process up + port answering. Returns detect()'s fields plus { port, portAnswering, wsError?, ok }. */
  async function health(bot) {
    const c = cfg(bot);
    const d = detect(bot);
    const portAnswering = c.port ? await tcp(c.port, HEALTH_MS) : false;
    return { bot, label: BOT_LABELS[bot], ...d, port: c.port, portAnswering, ...(c.wsError ? { wsError: c.wsError } : {}), ok: d.running && portAnswering };
  }

  async function statusAll() {
    const out = [];
    for (const bot of BOTS) {
      try { out.push(await health(bot)); } catch { out.push({ bot, label: BOT_LABELS[bot], error: 'process-list-failed', installed: false, running: false, startedByUs: false, portAnswering: false, ok: false }); }
    }
    return out;
  }

  /** Stops every bot Ujwalam started (studio stop, BM6). Never touches a copy the user started. */
  async function stopStarted() {
    const out = {};
    for (const bot of BOTS) {
      if (!readState()[bot]) continue;
      try { out[bot] = await stop(bot); } catch (e) { out[bot] = { ok: false, reason: String(e?.message ?? 'error').slice(0, 80) }; }
    }
    return out;
  }

  return { detect, start, stop, health, statusAll, stopStarted, startedRecords: readState, stateFile };
}
