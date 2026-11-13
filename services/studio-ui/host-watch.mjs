// SPDX-License-Identifier: GPL-3.0-or-later
// Host watchdog (D373 proposed, flag `host-watchdog`, off by default; docs/evidence/2026-11-13-gpu-reset-recovery.md).
//
// Why: on 2026-11-12 the host (libobs) froze twice and nothing recovered it. At 19:03 its graphics thread stopped
// producing frames for 3 hours while the process kept running; at 21:42 the NVIDIA driver reset while live and the
// whole thing sat broken until a manual restart at 22:00. The launcher (launch.mjs superviseHost) restarted the host
// only when its process EXITED.
//
// What: every checkMs the launcher asks the host host.alive (a lock-free method that reports the age of the last video
// frame, app/host/src/gfx_watch.h). The host is STALE when it answered nothing for noAnswerMs (counted from its last
// answer, or from its start) or when it answers but has produced no video frame for graphicsStallMs. Stale is logged
// once per incident whatever the flag says. With the flag on the launcher then stops the host (process tree kill; never
// host.shutdown, whose clean exit code 0 would end the session) and the existing crash path takes over: the same
// restart policy (backoff 2/5/10 s, at most 3 restarts in 5 min, then it stops: no restart storm), the project reload,
// the recording restarted in a new file, and the streams that were live before the freeze started again ONLY under the
// stream-recovery rules (flag stream-recovery, the go-live authority of this launcher, data/live/recovery.json limits).
// This module never starts a stream itself. One task-bar entry per incident tells the user what happened, and the
// Windows System log is read once per incident for an NVIDIA driver reset so the message can name the cause.
// Every number lives in data/live/host-watch.json; UJWALAM_HOST_WATCH_CONFIG names another file (tests only).

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemTool } from '../event-core/config.mjs';

export const HOST_WATCH_FLAG = 'host-watchdog';
export const HOST_WATCH_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'live', 'host-watch.json');
const NUMS = Object.freeze({
  checkMs: [500, 60_000], rpcTimeoutMs: [500, 60_000], noAnswerMs: [2000, 600_000], graphicsStallMs: [2000, 600_000],
  killWaitMs: [1000, 120_000], driverLookbackMs: [0, 86_400_000],
});
// JSON-RPC "method not found": a host from before D373 has no host.alive; it counts as an answer without frame data.
const METHOD_NOT_FOUND = -32601;

/** data/live/host-watch.json (or UJWALAM_HOST_WATCH_CONFIG) -> the config. Throws a plain-words error on a bad file. */
export function loadHostWatchConfig(file = process.env.UJWALAM_HOST_WATCH_CONFIG || HOST_WATCH_FILE) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (!d || typeof d !== 'object' || !d.source || typeof d.source !== 'object') throw new Error('host watch: source is required');
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(NUMS)) {
    if (!Number.isInteger(d[k]) || d[k] < lo || d[k] > hi) throw new Error(`host watch: ${k} must be an integer ${lo}..${hi}`);
    if (typeof d.source[k] !== 'string' || !d.source[k]) throw new Error(`host watch: source.${k} is required`);
    out[k] = d[k];
  }
  const h = d.host;
  if (!h || !Number.isInteger(h.stallMs) || !Number.isInteger(h.checkIntervalMs)) throw new Error('host watch: host.stallMs and host.checkIntervalMs are required');
  if (typeof d.source.host !== 'string' || !d.source.host) throw new Error('host watch: source.host is required');
  out.host = { stallMs: h.stallMs, checkIntervalMs: h.checkIntervalMs }; // range checks are the host's (exit 64)
  if (out.rpcTimeoutMs >= out.noAnswerMs) throw new Error('host watch: rpcTimeoutMs must be shorter than noAnswerMs');
  return out;
}

/**
 * The stale decision (pure; fake clock in tests). observe({ now, ok, status }) after each probe:
 *   ok: the host answered; status: its host.alive answer (null for an old host without the method).
 * -> { state: 'ok' } | { state: 'stale', reason: 'no-answer' | 'graphics-stalled', forMs, isNew }.
 * isNew is true on the first stale look of an incident; a healthy answer ends the incident. reset(now): a new host.
 */
export function livenessJudge(cfg) {
  let since = 0; let lastOkAt = null; let incident = false;
  const stale = (reason, forMs) => { const isNew = !incident; incident = true; return { state: 'stale', reason, forMs, isNew }; };
  return {
    reset(now) { since = now; lastOkAt = null; incident = false; },
    observe({ now, ok, status = null }) {
      if (ok) {
        lastOkAt = now;
        const age = status?.graphics?.lastFrameAgeMs;
        if (Number.isFinite(age) && age >= cfg.graphicsStallMs) return stale('graphics-stalled', age);
        incident = false;
        return { state: 'ok' };
      }
      const forMs = now - (lastOkAt ?? since);
      if (forMs >= cfg.noAnswerMs) return stale('no-answer', forMs);
      return { state: incident ? 'stale-wait' : 'ok' }; // a probe that fails inside the window decides nothing yet
    },
  };
}

/** Plain words for a stale decision. */
export function staleText(d) {
  const s = Math.round(d.forMs / 1000);
  return d.reason === 'graphics-stalled' ? `its graphics produced no video frame for ${s} s` : `it did not answer for ${s} s`;
}

/**
 * The watch loop around the judge. tick() is called every cfg.checkMs by the launcher (or by a test with a fake
 * clock). opts: { cfg, probe: async () => host.alive answer, canCheck: () => bool (no restart in progress, host
 * running), flagOn: () => bool (read at every look: switches live), onStale: async (d) => void (stop the host),
 * log, now }. One log line per incident; onStale at most once per incident and only with the flag on (a flag
 * switched on during an incident acts at the next look). reset(): a new host is running.
 */
export function createHostWatch({ cfg, probe, canCheck = () => true, flagOn = () => false, onStale, log = () => {}, now = Date.now }) {
  const judge = livenessJudge(cfg);
  let gen = 0; let inFlight = false; let acted = false;
  judge.reset(now());
  return {
    reset() { gen += 1; acted = false; judge.reset(now()); },
    async tick() {
      if (inFlight || !canCheck()) return null;
      inFlight = true;
      const g = gen;
      let ok = false; let status = null;
      try { status = await probe(); ok = true; } catch (e) { ok = e?.code === METHOD_NOT_FOUND; } finally { inFlight = false; }
      if (g !== gen || !canCheck()) return null; // the host was replaced meanwhile
      const d = judge.observe({ now: now(), ok, status });
      if (d.state !== 'stale') { if (d.state === 'ok') acted = false; return d; }
      const on = flagOn();
      if (d.isNew) log(`[studio] HOST NOT RESPONDING: ${staleText(d)}${on ? '; the host watchdog stops and restarts it' : ` (flag ${HOST_WATCH_FLAG} is off: not restarting it; restart Ujwalam by hand)`}`);
      if (!on || acted) return d;
      acted = true;
      await onStale(d);
      return { ...d, acted: true };
    },
  };
}

/** Windows System log: NVIDIA driver resets between sinceMs and untilMs -> [{ id, at }] (ms), or null when the log
 *  could not be read. Same events as tools/ci.mjs gpuResetsSince (nvlddmkm / Display 14, 153, 4101). Never throws;
 *  asynchronous (the launcher's event loop is never blocked). run: test seam (file, args) -> Promise<stdout>. */
export async function driverResets(sinceMs, untilMs, { platform = process.platform, run = runPowershell } = {}) {
  if (platform !== 'win32') return [];
  const from = Math.floor(sinceMs); const to = Math.ceil(untilMs);
  const ps = `$ErrorActionPreference="SilentlyContinue"; @(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='nvlddmkm','Display';StartTime=[DateTimeOffset]::FromUnixTimeMilliseconds(${from}).LocalDateTime;EndTime=[DateTimeOffset]::FromUnixTimeMilliseconds(${to}).LocalDateTime} | Where-Object { $_.Id -in 14,153,4101 }) | ForEach-Object { "$($_.Id) $(([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds())" }`;
  let out;
  try { out = await run(ps); } catch { return null; }
  if (typeof out !== 'string') return null;
  return parseDriverLines(out);
}

/** "153 1762983722000" lines -> [{ id, at }] sorted by time; other lines are ignored. */
export function parseDriverLines(text) {
  const evs = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = /^\s*(14|153|4101) (\d{10,16})\s*$/.exec(l);
    if (m) evs.push({ id: Number(m[1]), at: Number(m[2]) });
  }
  return evs.sort((a, b) => a.at - b.at);
}

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    let exe;
    try { exe = systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'); } catch (e) { reject(e); return; }
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 60_000, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** "the graphics driver reset at 21:42" (the newest one; local time of this PC), or null for none. */
export function driverResetText(events) {
  if (!Array.isArray(events) || !events.length) return null;
  const last = events.at(-1);
  return `the graphics driver reset at ${hhmm(last.at)}${events.length > 1 ? ` (${events.length} driver reset events)` : ''}`;
}

/** The task-bar entry for one incident (services/studio-ui/tasks.mjs shape). kind: 'hung' | 'crash'. */
export function incidentTask({ id, at, kind, state, why = null, cause = null, result = null }) {
  const what = kind === 'hung' ? 'The video engine froze' : 'The video engine stopped';
  const title = state === 'running' ? `${what}; restarting it` : state === 'done' ? `${what}; it was restarted` : `${what}; it could not be restarted`;
  const note = [why, cause ? `Cause: ${cause}` : null, result].filter(Boolean).join('. ');
  return { id, kind: 'host', title, state, note: note || null, startedAt: at, updatedAt: Date.now() };
}
