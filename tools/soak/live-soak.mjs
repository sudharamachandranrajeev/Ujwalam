#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Live-soak release gate (LU8, D324). Node stdlib + repo modules.
//
//   npm run soak                      30 min (the release gate)
//   npm run soak -- --short           3 min (a quick check of the same script)
//   node tools/soak/live-soak.mjs [--minutes N] [--short] [--sample-s 10] [--work-dir DIR] [--out-dir docs/evidence]
//        [--keep-media] [--no-record] [--wait]
//
// What runs: the alpha stack of stream-day (stack.mjs: ujwalam-host headless, every stream target a 127.0.0.1 RTMP
// listener, the event core fed by a mock Streamer.bot, the studio UI server), started from a staged copy of the
// runtime (stage.mjs) so the run can change data files the way an update or the user does, without touching the repo.
// While all four loopback streams (and the recording) run, a scripted session plays:
//   - chat: placeholder chat messages through the mock Streamer.bot (one every 1.5 s, a burst of 15 every 4 min);
//   - scene switches on both canvases (an extra colour scene per canvas, switched every 30 s; 20 s in short mode);
//   - effect bursts through effect.fire (storm, charge, gg; guards decide what plays);
//   - clip saves (replay.save);
//   - one data hot-reload of each kind (LU2): a valid change must apply without a restart, a broken file must keep
//     the last good version and show a notice (task file data-<kind>), and the fixed file must clear it.
// Pass needs every check: 0 dropped frames (host and every sink), 0 render-lagged and 0 encode-skipped frames,
// 0 video timestamp gaps in what each loopback listener received (ffprobe), no process exit or overlay restart,
// no crash report, no error-level log line (known benign lines are listed in KNOWN_BENIGN with the reason), every
// reload applied and every broken file kept. Writes <out-dir>/YYYY-MM-DD-live-soak-<mode>-HHMM.{json,md} (numbers,
// base names, no paths, no tokens) and exits 1 on any failure.
//
// Refuses to start (exit 4) while Meld Studio, an installed Ujwalam (a process under %LOCALAPPDATA%\Ujwalam) or a
// clip detector job (clipper.py) runs; --wait waits for those processes to exit instead (Wait-Process, no polling).
// Every process runs BelowNormal. Nothing can reach a real platform: no --allow-live and loopback targets only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../../services/flags/index.mjs';
import { initUserRules } from '../../services/posting/auto-post.mjs';
import { scanStrays } from '../stray-procs.mjs';
import { envelope } from './replay.mjs';
import { execText, filesUnder, gpu, httpReq, preflight, REPO, setBelow, startStack } from './stack.mjs';
import { stageRuntime, writeViaRename } from './stage.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[live-soak +${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

export const SOAK_FLAGS = Object.freeze(['live-markers', 'chat-effects', 'test-broadcast']);
/** Error-level lines that are not faults, each with the reason. Matched against the message after the level tag. */
export const KNOWN_BENIGN = Object.freeze([
  { re: /^Tried to call obs_frontend_add_event_callback with no callbacks!/, why: 'libobs plugin probe (no OBS frontend in the host); logged at load, no effect' },
]);

/** --key value pairs; --short, --keep-media, --no-record, --wait take no value. */
export function parseSoakArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (['short', 'keep-media', 'no-record', 'wait'].includes(k)) o[k] = true;
    else if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${k} needs a value`);
    else o[k] = argv[++i];
  }
  const minutes = o.minutes != null ? Number(o.minutes) : (o.short ? 3 : 30);
  if (!(minutes >= 1 && minutes <= 600)) throw new Error('--minutes must be 1..600');
  const sampleS = Number(o['sample-s'] ?? 10);
  if (!(sampleS >= 2 && sampleS <= 120)) throw new Error('--sample-s must be 2..120');
  return { minutes, short: minutes <= 5, sampleS, workDir: o['work-dir'] ?? null, outDir: o['out-dir'] ?? path.join(REPO, 'docs', 'evidence'), keepMedia: !!o['keep-media'], record: !o['no-record'], wait: !!o.wait };
}

/** The stream sinks the gate requires: every one must be in the plan, live in every sample, and received in full. */
export const REQUIRED_STREAMS = Object.freeze(['youtube-h', 'youtube-v', 'twitch', 'kick']);

/** Video timestamp gaps (pure; tested): pts in seconds, any order. fps: the output's planned frame rate; a gap is a
 *  step above 1.5x the planned frame interval (1/fps). The interval is never inferred from the stream itself: a
 *  60 fps output that loses every second frame has a 33 ms median step and would show no gap.
 *  tailSec: a gap that ends within tailSec of the last packet is counted apart as endGaps (the last segment of a
 *  stream: the encoder flush at stream stop, after the run, which no viewer sees). */
export function ptsGaps(pts, { fps, tailSec = 0 } = {}) {
  if (!(Number.isFinite(fps) && fps > 0)) throw new Error('ptsGaps: the planned fps is required');
  const step = 1 / fps;
  const s = pts.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 3) return { packets: s.length, gaps: 0, endGaps: 0, missingFrames: 0, maxStepMs: null, stepMs: null, spanSec: 0 };
  const steps = []; for (let i = 1; i < s.length; i++) steps.push(s[i] - s[i - 1]);
  const med = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  const last = s[s.length - 1];
  let gaps = 0; let endGaps = 0; let missing = 0;
  for (let i = 0; i < steps.length; i++) {
    const d = steps[i];
    if (!(d > step * 1.5)) continue;
    if (tailSec > 0 && last - s[i + 1] <= tailSec) { endGaps++; continue; }
    gaps++; missing += Math.round(d / step) - 1;
  }
  return { packets: s.length, gaps, endGaps, missingFrames: missing, maxStepMs: +(Math.max(...steps) * 1000).toFixed(1), stepMs: +(med * 1000).toFixed(2), expectedStepMs: +(step * 1000).toFixed(2), spanSec: +(last - s[0]).toFixed(2) };
}

/** Planned fps per sink id from the output plan (pure; tested): the fps of the rung the sink binds to. */
export function sinkFps(params) {
  const rungFps = new Map((params?.rungs ?? []).map((r) => [r.id, r.fps]));
  return Object.fromEntries((params?.sinks ?? []).map((s) => [s.id, rungFps.get(s.rung) ?? null]));
}

/** The required stream sinks missing from the plan or not a network stream there (pure; tested). */
export function missingRequiredStreams(params, required = REQUIRED_STREAMS) {
  const byId = new Map((params?.sinks ?? []).map((s) => [s.id, s]));
  return required.filter((id) => { const s = byId.get(id); return !s || !s.target || s.target.transport === 'file'; });
}

/** The recording passes only when its start was accepted, a file sink exists, it was live in every sample, and the
 *  probed file covers the run (within slackS) with 0 timestamp gaps (pure; tested). Returns the failed reasons. */
export function recordingProblems({ start, sinkId, notLiveSamples, samples, probe, durationS, slackS = 15 }) {
  const why = [];
  if (start !== 'ok') why.push(`start ${start ?? 'not called'}`);
  if (!sinkId) why.push('no file sink in the plan');
  if (!(samples > 0) || notLiveSamples !== 0) why.push(`not live in ${notLiveSamples ?? '?'} of ${samples ?? 0} samples`);
  if (!probe) why.push('no recording file');
  else if (probe.error) why.push(`probe: ${probe.error}`);
  else {
    if (probe.gaps !== 0) why.push(`${probe.gaps} timestamp gaps`);
    if (!(probe.spanSec >= durationS - slackS)) why.push(`covers ${Math.round(probe.spanSec ?? 0)} of ${durationS} s`);
  }
  return why;
}

/** The host's file for one file sink: the largest file named <target name base>-YYYYMMDD-HHMMSS.<ext> (the host
 *  stamps each recording), or null (pure; tested). files: [{ f, size }]. "alpha" never takes "alpha-v-..." (LC2). */
export function recordingFileFor(sink, files) {
  const name = String(sink?.target?.name ?? '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(name.slice(0, dot))}-\\d{8}-\\d{6}${esc(name.slice(dot))}$`, 'i');
  return files.filter((x) => re.test(path.basename(x.f))).sort((a, b) => b.size - a.size)[0] ?? null;
}

/** Per required id, the samples where that sink was absent or not live (pure; tested). rows: [{ sinks: [{id,state}] }]. */
export function notLiveByStream(rows, required = REQUIRED_STREAMS) {
  const out = Object.fromEntries(required.map((id) => [id, 0]));
  for (const r of rows) for (const id of required) if (r.sinks?.find((s) => s.id === id)?.state !== 'live') out[id]++;
  return out;
}

/** Error-level lines of a log text (pure; tested). Host lines: "<ts> error: msg"; Node services: an error/fatal tag,
 *  an uncaught/unhandled report or a thrown error's first line. -> { faults: [msg], benign: { why: n } } */
export function errorLines(text) {
  const faults = []; const benign = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const host = /^\S+\s+(error|fatal|critical):\s?(.*)$/i.exec(line);
    const node = host ? null : /(\[(error|fatal)\]|\b(uncaught|unhandled)\b|^\s*(Type|Range|Reference|Syntax)?Error: |\bfatal\b)/i.exec(line);
    if (!host && !node) continue;
    const msg = host ? host[2] : line;
    const k = KNOWN_BENIGN.find((b) => b.re.test(msg));
    if (k) benign[k.why] = (benign[k.why] ?? 0) + 1; else faults.push(noPaths(msg).slice(0, 200));
  }
  return { faults, benign };
}

/** A copy of a JSON document with one harmless, visible change (a note appended or added). */
export function noteChange(j, tag) {
  const o = structuredClone(j);
  if (typeof o.$comment === 'string') o.$comment = `${o.$comment} (${tag})`;
  else if (typeof o.definition === 'string') o.definition = `${o.definition} (${tag})`;
  else o.$comment = tag;
  return o;
}

/** Processes that must not run during a soak: Meld Studio, an installed Ujwalam, a clip detector job. -> [{pid,what}] */
export function busyProcesses() {
  return parseBusy(spawnSync('powershell.exe', ['-NoProfile', '-Command', BUSY_PS], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout);
}
const BUSY_PS = '$ErrorActionPreference="SilentlyContinue"; $l=[IO.Path]::Combine($env:LOCALAPPDATA,"Ujwalam").ToLower(); Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $p=[string]$_.ExecutablePath; $c=[string]$_.CommandLine; if ($p.ToLower().StartsWith($l + "\\")) { "{0}|installed Ujwalam ({1})" -f $_.ProcessId,$_.Name } elseif ($c -match "clipper\\.py|python\\.exe.* detect( |$)") { "{0}|clip detector job" -f $_.ProcessId } elseif ($_.Name -like "MeldStudio*") { "{0}|Meld Studio" -f $_.ProcessId } elseif ($c.ToLower().Contains($l + "\\")) { "{0}|a process using the installed Ujwalam ({1})" -f $_.ProcessId,$_.Name } }';
const parseBusy = (out) => String(out ?? '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, what] = l.split('|'); return { pid: Number(pid), what }; }).filter((p) => p.pid !== process.pid);
/** The same check without blocking the event loop (during the run). */
export async function busyProcessesAsync() { return parseBusy(await execText('powershell.exe', ['-NoProfile', '-Command', BUSY_PS], 60000)); }

/** Log text for the committed report: file paths (they hold the user name and asset names) become <path>. */
export const noPaths = (s) => String(s).replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^'"\r\n]*/g, '<path>');

const PROC_PS = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | ForEach-Object { "{0}|{1}|{2}|{3}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,([int64]$_.KernelModeTime + [int64]$_.UserModeTime) }';

function cpuTimes() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
  return { idle, total };
}

/** Host log lines from the stream start on that tell of a stall (warn level and up), as [t seconds, message]. */
export function stallLines(text, startedAtMs) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(warn|error):\s?(.*)$/.exec(l);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!(t >= startedAtMs)) continue;
    out.push([Math.round((t - startedAtMs) / 1000), noPaths(m[3]).slice(0, 160)]);
  }
  return out;
}

function videoPts(file) {
  const r = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffprobe exit ${r.status}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map(Number);
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseSoakArgs(argv); } catch (e) { console.log(`live-soak: ${e.message}`); return 2; }
  const mode = a.short ? 'short' : a.minutes === 30 ? 'full' : `${a.minutes}min`;
  const started = new Date();
  const stamp = `${started.toISOString().slice(0, 10)}-live-soak-${mode}-${String(started.getHours()).padStart(2, '0')}${String(started.getMinutes()).padStart(2, '0')}`;
  setBelow(process.pid);

  // ---- who else runs
  let busy = busyProcesses();
  if (busy.length && a.wait) {
    log(`waiting for ${busy.length} process(es) to exit: ${[...new Set(busy.map((b) => b.what))].join(', ')}`);
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Wait-Process -Id ${busy.map((b) => b.pid).join(',')} -ErrorAction SilentlyContinue`], { windowsHide: true });
    busy = busyProcesses();
  }
  if (busy.length) { log(`not starting: ${[...new Set(busy.map((b) => b.what))].join(', ')} running (use --wait to wait for them to exit)`); return 4; }

  const workDir = path.resolve(a.workDir ?? path.join(os.tmpdir(), 'ujwalam-soak', stamp));
  const runDir = path.join(workDir, 'run');
  const coreDir = path.join(runDir, 'core');
  const hostData = path.join(runDir, 'host');
  const recvDir = path.join(workDir, 'media', 'recv');
  const recordingsDir = path.join(workDir, 'media', 'recordings');
  const feedbackDir = path.join(workDir, 'media', 'feedback');
  for (const d of [coreDir, hostData, recvDir, recordingsDir, feedbackDir]) mkdirSync(d, { recursive: true });
  const result = { id: stamp, mode, minutes: a.minutes, sampleS: a.sampleS, record: a.record, startedAt: started.toISOString(), checks: [], notes: [] };
  const check = (name, pass, detail) => { result.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
  if (!preflight({ log, check })) return 4;

  // ---- staged runtime, this run's flags and posting rules
  const stage = stageRuntime(path.join(workDir, 'stage'), { eventCoreData: coreDir });
  const flags = createFlags({ dataDir: coreDir, definitionsFile: stage.dataFile('flags.json') });
  for (const id of SOAK_FLAGS) flags.set(id, true);
  initUserRules(coreDir);

  const st = await startStack({ runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check, root: stage.root, profile: path.join(REPO, 'data', 'profile.local.json'), segmentSec: 60, segmentWrap: 0 });
  if (!st) { result.notes.push('the stack did not start'); return finish(1); }
  if (!st.uiPort || !st.cookie) { result.notes.push('the UI server did not start; see run/ui.log in the work dir'); await st.teardown(); return finish(1); }
  const { c, mock } = st;
  result.host = { obsVersion: st.hostInfo.obsVersion, adapter: st.hostInfo.adapter };
  const ui = (route) => httpReq(st.uiPort, 'GET', route, { cookie: st.cookie });

  // ---- extra scenes (one colour scene per canvas) to switch to
  const scenes = (await c.call('scenes.list')).scenes;
  const home = {}; for (const s of scenes) if (s.active) home[s.canvas] = s.id;
  const alt = {};
  for (const cv of Object.keys(home)) {
    const id = `soak-alt-${cv.toLowerCase()}`;
    const r = await c.call('scenes.create', { scene: { id, canvas: cv, name: `Soak ${cv}`, layers: [{ id: 'bg', type: 'color', settings: { color: cv === 'H' || cv === 'h' ? '#203040' : '#402030' } }] } }).then(() => true, (e) => `error ${e.code ?? e.message}`);
    if (r === true) alt[cv] = id; else result.notes.push(`scene ${id}: ${r}`);
  }
  check('a colour scene to switch to on every canvas', Object.keys(home).length > 0 && Object.keys(alt).length === Object.keys(home).length, { canvases: Object.keys(home) });

  // ---- start outputs (host API; loopback only) and take the baseline
  const missingStreams = missingRequiredStreams(st.params);
  check(`the plan has every required stream (${REQUIRED_STREAMS.join(', ')})`, missingStreams.length === 0, { missing: missingStreams });
  const fpsBySink = sinkFps(st.params);
  // Every file sink of the plan (H "record" and, since LC1, V "record-v"): each must run and be probed (LC2).
  const recordSinks = st.params.sinks.filter((s) => s.target.transport === 'file');
  const before = await c.call('host.status');
  result.streamStart = await c.call('stream.start').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
  check('stream start accepted', result.streamStart === 'ok', result.streamStart);
  if (a.record) {
    result.recordStart = await c.call('record.start').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    check('recording start accepted', result.recordStart === 'ok' && recordSinks.length > 0, { start: result.recordStart, sinks: recordSinks.map((x) => x.id) });
  }
  const mustBeLive = [...REQUIRED_STREAMS, ...(a.record ? recordSinks.map((x) => x.id) : [])];
  let allLive = false;
  for (let i = 0; i < 80 && !allLive; i++) { const o = await c.call('outputs.status').catch(() => null); allLive = !!o && mustBeLive.every((id) => o.sinks.find((s) => s.id === id)?.state === 'live'); if (!allLive) await sleep(250); }
  check(`every required stream${a.record ? ' and the recording' : ''} live within 20 s`, allLive, mustBeLive);
  const base = { dropped: before.droppedFrames ?? 0, lagged: before.render?.renderLagged ?? 0, skipped: before.render?.encodeSkipped ?? 0, overlayRestarts: before.overlay?.restarts ?? 0, overlayFailures: before.overlay?.failures ?? 0 };
  const startedAt = Date.now();
  const endAt = startedAt + a.minutes * 60000;
  const running = () => Date.now() < endAt && st.hostExit === null;
  const actions = { chat: { sent: 0, noClient: 0 }, scenes: { ok: 0, failed: 0 }, effects: { fired: 0, delivered: 0, refused: {} }, clips: [], reloads: [] };
  const samples = [];
  const worst = { notLive: 0 };
  // What the script did, when (s since the stream start), to set next to each frame loss.
  const timeline = [];
  const mark = (what) => timeline.push([+((Date.now() - startedAt) / 1000).toFixed(1), what]);
  // Frame counters every second (host.status only, cheap): each loss with its time to the second.
  const frameEvents = [];
  const frameWatch = (async () => {
    let prev = { lagged: 0, skipped: 0, dropped: 0 };
    while (running()) {
      await sleep(1000);
      const hs = await c.call('host.status').catch(() => null);
      if (!hs) continue;
      const now = { lagged: (hs.render?.renderLagged ?? 0) - base.lagged, skipped: (hs.render?.encodeSkipped ?? 0) - base.skipped, dropped: (hs.droppedFrames ?? 0) - base.dropped };
      if (now.lagged > prev.lagged || now.skipped > prev.skipped || now.dropped > prev.dropped) {
        frameEvents.push({ t: +((Date.now() - startedAt) / 1000).toFixed(1), lagged: now.lagged - prev.lagged, skipped: now.skipped - prev.skipped, dropped: now.dropped - prev.dropped });
      }
      prev = now;
    }
  })();
  // Every minute: did Meld Studio, an installed Ujwalam or a detector job start during the run? (A soak needs a quiet
  // machine; a lost frame under such load says nothing about the stack.)
  const disturbed = [];
  const busyWatch = (async () => {
    for (let next = Date.now() + 60000; running();) {
      await sleep(1000);
      if (Date.now() < next || !running()) continue;
      next += 60000;
      const b = await busyProcessesAsync();
      if (b.length) disturbed.push({ t: Math.round((Date.now() - startedAt) / 1000), what: [...new Set(b.map((x) => x.what))] });
    }
  })();
  // CPU per process between samples: the stack's own tree against the rest of the machine (names only).
  let procPrev = null;
  async function procCpu(ms) {
    const out = await execText('powershell.exe', ['-NoProfile', '-Command', PROC_PS], 30000);
    if (!out) return null;
    const now = new Map();
    for (const l of out.split(/\r?\n/)) { const [pid, ppid, name, t] = l.split('|'); if (pid) now.set(Number(pid), { ppid: Number(ppid), name, t: Number(t) }); }
    const prev = procPrev; procPrev = { at: Date.now(), now };
    if (!prev) return null;
    const span = (Date.now() - prev.at) * 1e4 * os.cpus().length; // 100 ns units across all cores
    const tree = new Set([process.pid]);
    for (let grew = true; grew;) { grew = false; for (const [pid, p] of now) if (!tree.has(pid) && tree.has(p.ppid)) { tree.add(pid); grew = true; } }
    const pct = (pid, p) => Math.max(0, p.t - (prev.now.get(pid)?.t ?? p.t)) / span * 100;
    const by = (inTree) => { const m = new Map(); for (const [pid, p] of now) if (tree.has(pid) === inTree && pid !== 0) m.set(p.name, (m.get(p.name) ?? 0) + pct(pid, p)); return [...m].sort((x, y) => y[1] - x[1]); };
    const ins = by(true); const outs = by(false);
    const sum = (xs) => +xs.reduce((n, x) => n + x[1], 0).toFixed(1);
    return { treePct: sum(ins), otherPct: sum(outs), treeTop: ins.slice(0, 4).map(([n, v]) => [n, +v.toFixed(1)]), otherTop: outs.slice(0, 3).map(([n, v]) => [n, +v.toFixed(1)]) };
  }

  // System load next to the frame counters, so a lag can be told apart from load outside the stack.
  let cpuPrev = cpuTimes();
  async function sample() {
    const row = { t: Math.round((Date.now() - startedAt) / 1000) };
    const cpuNow = cpuTimes();
    row.sysCpuPct = +((1 - (cpuNow.idle - cpuPrev.idle) / Math.max(1, cpuNow.total - cpuPrev.total)) * 100).toFixed(1);
    cpuPrev = cpuNow;
    row.gpu = await gpu();
    row.cpu = await procCpu();
    try {
      const [hs, os2] = await Promise.all([c.call('host.status'), c.call('outputs.status')]);
      row.hostCpuPct = hs.cpuPct ?? null; row.hostGpuPct = hs.gpuPct ?? null;
      row.fps = hs.fps; row.dropped = (hs.droppedFrames ?? 0) - base.dropped; row.lagged = (hs.render?.renderLagged ?? 0) - base.lagged; row.skipped = (hs.render?.encodeSkipped ?? 0) - base.skipped;
      row.overlayRestarts = (hs.overlay?.restarts ?? 0) - base.overlayRestarts; row.overlayFailures = (hs.overlay?.failures ?? 0) - base.overlayFailures;
      row.sinks = os2.sinks.map((s) => ({ id: s.id, state: s.state, dropped: s.droppedFrames ?? 0, total: s.totalFrames ?? 0 }));
      if (os2.sinks.some((s) => s.kind === 'stream' && s.state !== 'live')) worst.notLive++;
    } catch (e) { row.error = String(e.code ?? e.message).slice(0, 60); }
    samples.push(row);
    return row;
  }

  const chatLoop = (async () => {
    const texts = ['hello', 'gg', 'nice', 'lol', 'wow', 'that was close', 'gg wp'];
    let n = 0; let nextBurst = startedAt + 45000;
    while (running()) {
      const burst = Date.now() >= nextBurst;
      if (burst) { nextBurst += 4 * 60000; mark('chat burst (15 messages)'); }
      for (let i = 0; i < (burst ? 15 : 1); i++) {
        n++;
        const v = n % 9;
        const env = envelope({ loop: 0, msg: { id: `soak-${n}`, text: texts[n % texts.length], uid: `u${v}`, login: `viewer${v}`, name: `Viewer${v}` } });
        if (mock.emit(env) === 0) actions.chat.noClient++;
        actions.chat.sent++;
        if (burst) await sleep(100);
      }
      await sleep(1500);
    }
  })();

  const sceneLoop = (async () => {
    const every = a.short ? 20000 : 30000;
    let onAlt = false;
    await sleep(every);
    while (running()) {
      onAlt = !onAlt;
      for (const cv of Object.keys(alt)) {
        mark(`scene ${onAlt ? 'colour' : 'home'} ${cv}`);
        const ok = await c.call('scenes.activate', { scene: onAlt ? alt[cv] : home[cv], canvas: cv }).then(() => true, () => false);
        if (ok) actions.scenes.ok++; else actions.scenes.failed++;
      }
      await sleep(every);
    }
    for (const cv of Object.keys(alt)) await c.call('scenes.activate', { scene: home[cv], canvas: cv }).catch(() => {});
  })();

  const effectsLoop = (async () => {
    const effectsAt = a.short ? [40000, 120000] : Array.from({ length: Math.floor(a.minutes / 3) }, (_, i) => 60000 + i * 180000);
    const clipsAt = a.short ? [70000, 150000] : Array.from({ length: Math.floor(a.minutes / 5) }, (_, i) => 90000 + i * 300000);
    const plan = [...effectsAt.map((t) => ({ t, k: 'fx' })), ...clipsAt.map((t) => ({ t, k: 'clip' }))].sort((x, y) => x.t - y.t);
    for (const p of plan) {
      const wait = startedAt + p.t - Date.now();
      if (startedAt + p.t > endAt - 15000) break;
      if (wait > 0) await sleep(wait);
      if (!running()) break;
      mark(p.k === 'fx' ? 'effect burst' : 'clip save');
      if (p.k === 'fx') {
        for (const [name, n, gap] of [['storm', 8, 60], ['charge', 6, 100], ['gg', 3, 200]]) {
          for (let i = 0; i < n; i++) {
            const r = await c.call('effect.fire', { name, meta: { source: 'live-soak' } }).catch((e) => ({ ok: false, reason: `error-${e.code ?? 'x'}` }));
            actions.effects.fired++;
            if (r.ok) actions.effects.delivered++; else actions.effects.refused[r.reason ?? 'unknown'] = (actions.effects.refused[r.reason ?? 'unknown'] ?? 0) + 1;
            await sleep(gap);
          }
        }
      } else {
        const r = await c.call('replay.save').then((x) => ({ ok: true, files: (x.saved ?? x.files ?? []).length ?? null }), (e) => ({ ok: false, code: String(e.code ?? e.message).slice(0, 40) }));
        actions.clips.push({ at: Math.round((Date.now() - startedAt) / 1000), ...r });
        log('clip save', JSON.stringify(r));
      }
    }
  })();

  // ---- data hot-reloads: one of each kind (LU2)
  const overlayData = async () => (await c.call('overlay.stats')).data ?? [];
  const uiData = async () => (await ui('/ui/api/data')).body?.sources ?? [];
  const kinds = [
    { kind: 'flags-local', file: path.join(coreDir, 'flags.local.json'), owners: ['ui', 'overlay'], change: (j) => ({ ...j, flags: { ...j.flags, 'report-button': !j.flags?.['report-button'] } }),
      applied: async (j) => (await ui('/ui/api/flags')).body?.flags?.find((f) => f.id === 'report-button')?.on === j.flags['report-button'] },
    { kind: 'flags-definitions', file: stage.dataFile('flags.json'), owners: ['ui', 'overlay'], change: (j) => ({ ...j, flags: j.flags.map((f) => (f.id === 'report-button' ? { ...f, description: `${f.description} (soak)` } : f)) }),
      applied: async () => /\(soak\)$/.test((await ui('/ui/api/flags')).body?.flags?.find((f) => f.id === 'report-button')?.description ?? '') },
    { kind: 'posting-rules', file: path.join(coreDir, 'posting', 'auto-post-rules.json'), owners: ['ui'], change: (j) => noteChange(j, 'soak') },
    { kind: 'studio-tasks', file: stage.dataFile(path.join('studio', 'tasks.json')), owners: ['ui'], change: (j) => ({ ...j, stallAfterMs: (j.stallAfterMs ?? 180000) + 60000 }) },
    { kind: 'guide-tour', file: stage.dataFile(path.join('guide', 'tour.json')), owners: ['ui'], change: (j) => noteChange(j, 'soak') },
    { kind: 'guide-hints', file: stage.dataFile(path.join('guide', 'hints.json')), owners: ['ui'], change: (j) => noteChange(j, 'soak') },
    { kind: 'effect-guards', file: stage.dataFile(path.join('effects', 'guards.json')), owners: ['overlay'], change: (j) => ({ ...j, budget: { ...j.budget, maxPerMinute: j.budget.maxPerMinute - 1 } }),
      applied: async (j) => (await c.call('overlay.stats')).guards?.budgetPerMinute === j.budget.maxPerMinute },
    { kind: 'flash-measurements', file: stage.dataFile(path.join('effects', 'flash-measurements.json')), owners: ['overlay'], change: (j) => noteChange(j, 'soak') },
  ];
  const statusOf = async (owner, kind) => (owner === 'ui' ? await uiData() : await overlayData()).find((s) => s.kind === kind) ?? null;
  const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { let v = false; try { v = await fn(); } catch { /* not yet */ } if (v) return true; if (Date.now() > end) return false; await sleep(300); } };
  const taskFile = (kind) => path.join(coreDir, 'tasks', `data-${kind}.json`);
  const taskState = (kind) => { try { return JSON.parse(readFileSync(taskFile(kind), 'utf8')).state ?? null; } catch { return null; } };

  async function reload(k) {
    const r = { kind: k.kind, owners: k.owners };
    const t = Date.now();
    const orig = JSON.parse(readFileSync(k.file, 'utf8'));
    const prev = {}; for (const o of k.owners) prev[o] = await statusOf(o, k.kind);
    r.loadedBefore = k.owners.every((o) => prev[o]?.loaded === true);
    const next = k.change(orig);
    const text = `${JSON.stringify(next, null, 2)}\n`;
    mark(`reload ${k.kind}: valid`);
    writeViaRename(k.file, text);
    r.applied = await until(async () => {
      for (const o of k.owners) { const s = await statusOf(o, k.kind); if (!s || !s.ok || s.version <= (prev[o]?.version ?? 0) || s.hash === prev[o]?.hash) return false; }
      return k.applied ? k.applied(next) : true;
    });
    r.applyMs = Date.now() - t;
    const applied = {}; for (const o of k.owners) applied[o] = await statusOf(o, k.kind);
    // broken: half the file (what a crashed editor or a cut-off copy leaves)
    mark(`reload ${k.kind}: broken`);
    writeViaRename(k.file, text.slice(0, Math.floor(text.length / 2)));
    r.brokenKept = await until(async () => {
      for (const o of k.owners) { const s = await statusOf(o, k.kind); if (!s || !s.rejected || s.version !== applied[o]?.version || s.hash !== applied[o]?.hash) return false; }
      return k.applied ? k.applied(next) : true;
    });
    r.why = (await statusOf(k.owners[0], k.kind))?.rejected?.why?.slice(0, 120) ?? null;
    r.notice = await until(async () => taskState(k.kind) === 'failed', 5000);
    // fixed: the good version again
    mark(`reload ${k.kind}: fixed`);
    writeViaRename(k.file, text);
    r.fixed = await until(async () => { for (const o of k.owners) { const s = await statusOf(o, k.kind); if (!s || !s.ok || s.rejected) return false; } return true; });
    r.noticeCleared = await until(async () => taskState(k.kind) !== 'failed', 5000);
    r.ms = Date.now() - t;
    actions.reloads.push(r);
    log('reload', JSON.stringify(r));
  }
  const reloadTask = (async () => {
    await sleep(Math.min(a.minutes * 60000 * 0.15, 60000));
    for (const k of kinds) { if (!running()) break; try { await reload(k); } catch (e) { actions.reloads.push({ kind: k.kind, error: String(e.message).slice(0, 120) }); } await sleep(2000); }
  })();

  // ---- sample until the end
  while (running()) {
    const row = await sample();
    const nl = row.sinks?.filter((s) => s.state !== 'live').map((s) => `${s.id}:${s.state}`) ?? [];
    log(`t=${row.t}s fps ${row.fps} dropped ${row.dropped} lagged ${row.lagged} skipped ${row.skipped} overlay restarts ${row.overlayRestarts} cpu ${row.sysCpuPct}% gpu ${row.gpu?.gpuPct ?? '-'}% enc ${row.gpu?.encPct ?? '-'}% chat ${actions.chat.sent} scenes ${actions.scenes.ok} reloads ${actions.reloads.length}${nl.length ? ` NOT LIVE ${nl.join(',')}` : ''}${row.error ? ` ERROR ${row.error}` : ''}`);
    await sleep(Math.max(0, Math.min(a.sampleS * 1000, endAt - Date.now())));
  }
  await Promise.all([chatLoop, sceneLoop, effectsLoop, reloadTask, frameWatch, busyWatch].map((p) => p.catch((e) => result.notes.push(`script: ${String(e.message).slice(0, 120)}`))));
  await sleep(3000);
  const last = await sample();
  result.durationS = Math.round((Date.now() - startedAt) / 1000);
  const exitsDuringRun = { host: st.hostExit, core: st.coreExit, ui: st.uiExit };

  // ---- stop outputs, then the stack
  if (st.hostExit === null) {
    result.streamStop = await c.call('stream.stop').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    if (a.record) result.recordStop = await c.call('record.stop').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    for (let i = 0; i < 60; i++) { const s = await c.call('outputs.status').catch(() => null); if (!s || s.sinks.every((x) => !['starting', 'live', 'retrying', 'stopping'].includes(x.state))) break; await sleep(500); }
  }
  await st.teardown();
  result.hostExitAfterShutdown = st.hostExit;

  // ---- checks
  result.actions = actions;
  result.samples = samples.length;
  result.end = last;
  // Where frames were lost, with the load at that moment (system CPU, GPU, host) and the host's warnings around it.
  const near = (t) => samples.reduce((b, x) => (b === null || Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), null);
  result.lagEvents = frameEvents.map((e) => { const n = near(e.t); return { ...e, before: timeline.filter(([at]) => at <= e.t && at >= e.t - 3).map(([, w]) => w), sysCpuPct: n?.sysCpuPct ?? null, gpuPct: n?.gpu?.gpuPct ?? null, encPct: n?.gpu?.encPct ?? null, treeCpuPct: n?.cpu?.treePct ?? null, otherCpuPct: n?.cpu?.otherPct ?? null, otherTop: n?.cpu?.otherTop ?? null, treeTop: n?.cpu?.treeTop ?? null }; });
  result.timeline = timeline;
  try { result.hostWarnings = stallLines(readFileSync(st.hostLogFile, 'utf8'), startedAt).slice(0, 60); } catch { result.hostWarnings = null; }
  result.load = { sysCpuPctMax: Math.max(0, ...samples.map((s) => s.sysCpuPct ?? 0)), stackCpuPctMax: Math.max(0, ...samples.map((s) => s.cpu?.treePct ?? 0)), otherCpuPctMax: Math.max(0, ...samples.map((s) => s.cpu?.otherPct ?? 0)), gpuPctMax: Math.max(0, ...samples.map((s) => s.gpu?.gpuPct ?? 0)), encPctMax: Math.max(0, ...samples.map((s) => s.gpu?.encPct ?? 0)), vramMBMax: Math.max(0, ...samples.map((s) => s.gpu?.memMB ?? 0)), nvencSessionsMax: Math.max(0, ...samples.map((s) => s.gpu?.sessions ?? 0)) };
  result.disturbed = disturbed;
  check('a quiet machine: no Meld Studio, installed Ujwalam or detector job started during the run', disturbed.length === 0, disturbed.slice(0, 5));
  check('no process exited during the run (host, event core, UI server)', Object.values(exitsDuringRun).every((x) => x === null), exitsDuringRun);
  check('host stopped cleanly on shutdown (exit 0)', st.hostExit === 0, { exit: st.hostExit });
  check('0 dropped frames (host)', samples.every((s) => s.dropped === 0), { max: Math.max(0, ...samples.map((s) => s.dropped ?? 0)) });
  check('0 render-lagged frames', samples.every((s) => s.lagged === 0), { max: Math.max(0, ...samples.map((s) => s.lagged ?? 0)) });
  check('0 encode-skipped frames', samples.every((s) => s.skipped === 0), { max: Math.max(0, ...samples.map((s) => s.skipped ?? 0)) });
  check('0 dropped frames on every sink', mustBeLive.every((id) => last.sinks?.some((s) => s.id === id)) && (last.sinks ?? []).every((s) => s.dropped === 0), Object.fromEntries((last.sinks ?? []).map((s) => [s.id, { dropped: s.dropped, total: s.total }])));
  const notLive = notLiveByStream(samples, mustBeLive);
  check(`every required stream${a.record ? ' and the recording' : ''} live in every sample`, samples.length > 0 && Object.values(notLive).every((n) => n === 0) && worst.notLive === 0 && samples.every((s) => !s.error), { samplesNotLive: notLive, otherStreamsNotLive: worst.notLive, samplesWithError: samples.filter((s) => s.error).length });
  check('overlay server: no restart, no failure', samples.every((s) => !s.overlayRestarts && !s.overlayFailures));
  check('chat reached the event core', actions.chat.sent > 0 && actions.chat.noClient === 0, actions.chat);
  check('scene switches all applied', actions.scenes.ok > 0 && actions.scenes.failed === 0, actions.scenes);
  check('effects fired and some played', actions.effects.fired > 0 && actions.effects.delivered > 0, { fired: actions.effects.fired, delivered: actions.effects.delivered });
  check('clip saves all ok', actions.clips.length > 0 && actions.clips.every((x) => x.ok), actions.clips.map((x) => x.ok));
  const missingKinds = kinds.map((k) => k.kind).filter((k) => !actions.reloads.some((r) => r.kind === k));
  check('one hot-reload of every data kind ran', missingKinds.length === 0, { missing: missingKinds });
  for (const r of actions.reloads) {
    check(`reload ${r.kind}: valid change applied while live, broken file kept the last good version with a notice, fix cleared it`,
      !r.error && r.loadedBefore && r.applied && r.brokenKept && r.notice && r.fixed && r.noticeCleared, r.error ? { error: r.error } : { applyMs: r.applyMs, applied: r.applied, brokenKept: r.brokenKept, notice: r.notice, fixed: r.fixed, noticeCleared: r.noticeCleared });
  }

  // received streams: every video packet timestamp step, per segment
  result.received = {};
  const perSink = {};
  const segs = filesUnder(recvDir, /\.mkv$/).sort();
  const lastSeg = {}; for (const f of segs) lastSeg[path.basename(f).replace(/-\d+-\d+\.mkv$/, '')] = f; // names sort by connection, then segment
  for (const f of segs) {
    const id = path.basename(f).replace(/-\d+-\d+\.mkv$/, '');
    try {
      const g = ptsGaps(videoPts(f), { fps: fpsBySink[id], tailSec: lastSeg[id] === f ? 0.5 : 0 });
      result.received[path.basename(f)] = { sizeMB: Math.round(statSync(f).size / 1048576), ...g };
      const p = perSink[id] ?? { spanSec: 0, gaps: 0, endGaps: 0, missingFrames: 0, segments: 0 };
      p.spanSec += g.spanSec; p.gaps += g.gaps; p.endGaps += g.endGaps; p.missingFrames += g.missingFrames; p.segments++;
      perSink[id] = p;
    } catch (e) { result.received[path.basename(f)] = { error: String(e.message).slice(0, 80) }; }
  }
  result.receivedBySink = perSink;
  const streamIds = [...new Set([...REQUIRED_STREAMS, ...st.params.sinks.filter((s) => s.target.transport !== 'file').map((s) => s.id)])];
  check('every required loopback listener received the whole run', streamIds.every((id) => (perSink[id]?.spanSec ?? 0) >= result.durationS - 15), Object.fromEntries(streamIds.map((id) => [id, Math.round(perSink[id]?.spanSec ?? 0)])));
  check('0 video timestamp gaps in what the listeners received (ffprobe, planned fps)', streamIds.every((id) => perSink[id]?.segments > 0) && Object.values(result.received).every((x) => !x.error && x.gaps === 0), Object.fromEntries(streamIds.map((id) => [id, perSink[id] ? { gaps: perSink[id].gaps, missingFrames: perSink[id].missingFrames, endGaps: perSink[id].endGaps } : 'nothing received'])));

  // the recordings: each file sink's own file (H and V, LC2; clip saves have other names), probed like a stream
  if (a.record) {
    const vids = filesUnder(recordingsDir, /\.(mkv|mp4|mov|flv|ts)$/i).map((f) => ({ f, size: statSync(f).size }));
    result.recordings = {};
    if (!recordSinks.length) check('the recording: a file sink in the plan', false, recordingProblems({ start: result.recordStart, samples: samples.length, durationS: result.durationS }));
    for (const sink of recordSinks) {
      const file = recordingFileFor(sink, vids);
      let rec = null;
      if (file) {
        try { rec = { file: path.basename(file.f), sizeMB: Math.round(file.size / 1048576), ...ptsGaps(videoPts(file.f), { fps: fpsBySink[sink.id], tailSec: 0.5 }) }; } catch (e) { rec = { error: String(e.message).slice(0, 80) }; }
      }
      result.recordings[sink.id] = rec;
      const recWhy = recordingProblems({ start: result.recordStart, sinkId: sink.id, notLiveSamples: notLive[sink.id], samples: samples.length, probe: rec, durationS: result.durationS });
      check(`the recording ${sink.id}: started, live throughout, covers the whole run with 0 video timestamp gaps (ffprobe, planned fps)`, recWhy.length === 0, recWhy.length ? recWhy : { spanSec: Math.round(rec.spanSec), packets: rec.packets, endGaps: rec.endGaps });
    }
  }

  // crash reports, error-level log lines, strays
  const crashes = [...filesUnder(workDir, /^crash-.*\.txt$/)].map((f) => path.basename(f));
  check('no crash report', crashes.length === 0, crashes);
  const logs = { host: st.hostLogFile, core: st.coreLog, ui: st.uiLog };
  result.logLines = {};
  const faults = [];
  for (const [k, f] of Object.entries(logs)) {
    const t = f && existsSync(f) ? readFileSync(f, 'utf8') : '';
    const e = errorLines(t);
    result.logLines[k] = { lines: t.split(/\r?\n/).filter(Boolean).length, errors: e.faults.length, benign: e.benign };
    for (const m of e.faults) faults.push(`${k}: ${m}`);
  }
  result.errorLines = faults.slice(0, 40);
  check('no error-level log line (host, overlay child, event core, UI server)', faults.length === 0, { count: faults.length });
  await sleep(2000);
  const strays = scanStrays();
  result.strays = Array.isArray(strays) ? strays.length : null;
  const left = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process ujwalam-host,obs-browser-page -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', windowsHide: true });
  result.leftHostOrBrowser = Number(left.stdout?.trim());
  check('no process left after the run', result.leftHostOrBrowser === 0 && !result.strays, { host: result.leftHostOrBrowser, node: result.strays });
  return finish(result.checks.every((x) => x.pass) ? 0 : 1);

  function finish(code) {
    result.pass = code === 0;
    result.endedAt = new Date().toISOString();
    mkdirSync(a.outDir, { recursive: true });
    const jf = path.join(a.outDir, `${stamp}.json`);
    writeFileSync(jf, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(path.join(a.outDir, `${stamp}.md`), report(result));
    if (!a.keepMedia) rmSync(path.join(workDir, 'media'), { recursive: true, force: true });
    log(`${result.pass ? 'PASS' : 'FAIL'}: ${path.relative(REPO, jf)}`);
    return code;
  }
}

/** The markdown report (pure; tested). Numbers and base names only. */
export function report(r) {
  const L = [];
  L.push(`# Live soak ${r.mode} (${r.minutes} min): ${r.pass ? 'PASS' : 'FAIL'}`, '');
  L.push(`Run ${r.id}, started ${r.startedAt}, ran ${r.durationS ?? '-'} s. Gate: \`npm run soak\` (tools/soak/live-soak.mjs, LU8, D324).`);
  L.push(`Host: libobs ${r.host?.obsVersion ?? '-'}, adapter ${r.host?.adapter ?? '-'}. Loopback outputs only (127.0.0.1 RTMP listeners); recording ${r.record ? 'on' : 'off'}.`, '');
  L.push('| Check | Result | Detail |', '|---|---|---|');
  for (const c of r.checks) L.push(`| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail === undefined ? '' : `\`${JSON.stringify(c.detail).replaceAll('|', '/').slice(0, 300)}\``} |`);
  L.push('');
  if (r.actions) {
    L.push('## Session', '');
    L.push(`- Chat messages sent: ${r.actions.chat.sent} (placeholder names and texts; none lost: ${r.actions.chat.noClient === 0}).`);
    L.push(`- Scene switches: ${r.actions.scenes.ok} ok, ${r.actions.scenes.failed} failed.`);
    L.push(`- Effects: ${r.actions.effects.fired} fired, ${r.actions.effects.delivered} played, refused by the guards: \`${JSON.stringify(r.actions.effects.refused)}\`.`);
    L.push(`- Clip saves: ${r.actions.clips.length} (${r.actions.clips.filter((x) => x.ok).length} ok).`);
    L.push('', '| Data kind | Owner | Applied (ms) | Broken file kept | Notice | Fixed |', '|---|---|---|---|---|---|');
    for (const x of r.actions.reloads) L.push(`| ${x.kind} | ${(x.owners ?? []).join(', ')} | ${x.error ? `error: ${x.error}` : `${x.applied ? 'yes' : 'NO'} (${x.applyMs})`} | ${x.brokenKept ? 'yes' : 'NO'} | ${x.notice ? 'yes' : 'NO'} | ${x.fixed && x.noticeCleared ? 'yes' : 'NO'} |`);
    L.push('');
  }
  if (r.receivedBySink) {
    L.push('## Received (ffprobe, video packet timestamps)', '', '| Sink | Segments | Seconds | Gaps | Missing frames | Gaps at stream stop (not counted) |', '|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(r.receivedBySink)) L.push(`| ${k} | ${v.segments} | ${Math.round(v.spanSec)} | ${v.gaps} | ${v.missingFrames} | ${v.endGaps ?? 0} |`);
    L.push('');
  }
  if (r.load) {
    L.push('## Load', '', `Max over the samples: system CPU ${r.load.sysCpuPctMax}% (the stack ${r.load.stackCpuPctMax ?? "-"}%, everything else ${r.load.otherCpuPctMax ?? "-"}%), GPU ${r.load.gpuPctMax}%, NVENC ${r.load.encPctMax}%, VRAM ${r.load.vramMBMax} MB, NVENC sessions ${r.load.nvencSessionsMax}.`, '');
    if (r.lagEvents?.length) {
      L.push('Frame losses (host counters read every second; load from the nearest sample; CPU % of all cores):', '', '| t (s) | Render lagged | Encode skipped | Dropped | Script action in the 3 s before | System CPU % | Stack CPU % | Other CPU % (top) | GPU % | NVENC % |', '|---|---|---|---|---|---|---|---|---|---|');
      for (const e of r.lagEvents) L.push(`| ${e.t} | ${e.lagged} | ${e.skipped} | ${e.dropped} | ${(e.before ?? []).join('; ') || '-'} | ${e.sysCpuPct ?? '-'} | ${e.treeCpuPct ?? '-'} | ${e.otherCpuPct ?? '-'}${e.otherTop?.length ? ` (${e.otherTop.map(([n, v]) => `${n} ${v}`).join(', ')})` : ''} | ${e.gpuPct ?? '-'} | ${e.encPct ?? '-'} |`);
      L.push('');
    }
    if (r.hostWarnings?.length) { L.push('Host warnings after the stream start (t in s):', ''); for (const [t, m] of r.hostWarnings) L.push(`- ${t}: \`${m.replaceAll('`', "'")}\``); L.push(''); }
  }
  if (r.logLines) {
    L.push('## Logs', '');
    for (const [k, v] of Object.entries(r.logLines)) L.push(`- ${k}: ${v.lines} lines, ${v.errors} error-level${Object.keys(v.benign).length ? `; known benign: ${Object.entries(v.benign).map(([w, n]) => `${n}x ${w}`).join('; ')}` : ''}.`);
    for (const e of r.errorLines ?? []) L.push(`  - \`${e.replaceAll('`', "'")}\``);
    L.push('');
  }
  if (r.notes?.length) { L.push('## Notes', ''); for (const n of r.notes) L.push(`- ${n}`); L.push(''); }
  return `${L.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
