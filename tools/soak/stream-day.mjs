#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Stream-day mock run: the full alpha stack, headless, with loopback outputs only. Node stdlib + repo modules.
//
//   node tools/soak/stream-day.mjs --data-root DIR [--minutes 60] [--sample-s 30] [--run-id ID] [--speed 1]
//        [--replay-every-min 10] [--effects-every-min 5] [--no-record] [--max-gap-s G]
//
// What runs (each piece is the real one; nothing is faked except Streamer.bot and the platforms):
//   - mock Streamer.bot (tools/mock/mock-streamerbot.mjs, 127.0.0.1) replaying a real Twitch VOD chat export from
//     <data-root>/chat/twitch with its original timing (tools/soak/replay.mjs readExports/chooseExport/timeline);
//   - the event core (`services/event-core/cli.mjs serve --url <mock>`) with the launcher's own environment (coreEnv:
//     api/system tokens and the scoped host MARKERS token, D214; never the full host token);
//   - ujwalam-host in alpha mode (launcher hostLaunchSpec: browser layers, overlay server child fed by the event core,
//     host config with the 30 s replay buffer) with UJWALAM_HEADLESS=1 (no preview window), no --allow-devices, no
//     --allow-live, and an outputs plan whose every stream target is a 127.0.0.1 RTMP listener (ffmpeg -listen 1);
//   - the alpha project (launcher alphaProject: Default H + Default V presets, device layers as placeholders);
//   - the studio UI server (login with the one-time launch key in memory; status polled like the page does).
// Global hotkeys are OFF in this run's host config (the alpha default registers Ctrl+Alt+P/F/M on the user's desktop).
// Flags are switched on ONLY in this run's data dir (<run>/core/flags.local.json): live-markers, posting, auto-post,
// chat-effects, test-broadcast. data/flags.json is never touched.
//
// The streams are started with the host's own outputs API (stream.start, record.start) using the host token this
// script made; the control page's typed "yes, on air" gate is not used and not typed. The host refuses real targets
// (no --allow-live), so nothing can leave the machine.
//
// During the run: samples every --sample-s (host.status, outputs.status, replay.status, feedback.status, overlay.stats,
// core.status, UI /ui/api/status, nvidia-smi NVENC sessions and VRAM, per-process memory/handles of the whole tree);
// effect bursts every --effects-every-min through effect.fire (guards: budget, cooldown, region, flash); a replay save
// every --replay-every-min; an auto-post check while live (dry run, and --run with a temporary approve-only rule:
// it must refuse while outputs are live). Event-core latency: mock emit -> API SSE delivery, matched by message id.
// After: clean stop, ffprobe of every loopback-received file, the recording and the replay saves, crash-*.txt count,
// stray processes, `audit purge --all`, then a scan of the run dir for any replayed chat text or display name
// (counts only). Output: <run>/result.json and timeseries.jsonl (numbers only). Prints counts and timings only:
// never chat text, names, ids, tokens or keys.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';
import { probe } from '../../app/host/lib/ffprobe.mjs';
import { planFile } from '../../app/host/lib/outputs-plan.mjs';
import { createFlags } from '../../services/flags/index.mjs';
import { alphaHostConfig, alphaProject, alphaStatus, coreEnv, coreServeArgs, hostLaunchSpec, openHostLog, waitForDiscovery, writeHostConfig } from '../../services/studio-ui/launch.mjs';
import { startMockStreamerbot } from '../mock/mock-streamerbot.mjs';
import { killTree, track } from '../proc-registry.mjs';
import { scanStrays } from '../stray-procs.mjs';
import { chooseExport, envelope, pct, purgeProof, readExports, timeline } from './replay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => randomBytes(n).toString('hex');
const t0 = Date.now();
const log = (...a) => console.log(`[stream-day +${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
export const RUN_FLAGS = Object.freeze(['live-markers', 'posting', 'auto-post', 'chat-effects', 'test-broadcast']);
export const LOOPBACK_PORTS = Object.freeze({ 'youtube-h': 19551, 'youtube-v': 19552, twitch: 19553, kick: 19554 });

/** The alpha live plan with every stream target replaced by a loopback RTMP listener (pure; same rungs and sinks). */
export function loopbackPlan(live, ports = LOOPBACK_PORTS) {
  const targets = {};
  for (const [id, t] of Object.entries(live.targets)) {
    if (t.transport === 'file') targets[id] = { ...t };
    else {
      if (!Number.isInteger(ports[id])) throw new Error(`no loopback port for sink ${id}`);
      targets[id] = { transport: 'rtmp', port: ports[id], app: 'live', stream: id };
    }
  }
  return { $comment: 'stream-day mock run: data/outputs/alpha-live.json with loopback targets only', config: live.config, extraSinks: live.extraSinks, targets, policy: live.policy };
}

function setBelow(pid) { try { os.setPriority(pid, BELOW); return true; } catch { return false; } }

function execText(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Every process below `root` (Windows CIM, one query): [{ pid, ppid, name, wsMB, privMB, handles }].
const TREE_PS = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | ForEach-Object { "{0}|{1}|{2}|{3}|{4}|{5}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.WorkingSetSize,$_.PrivatePageCount,$_.HandleCount }';
async function treeOf(root) {
  const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TREE_PS]);
  if (!out) return null;
  const all = out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, name, ws, priv, h] = l.split('|'); return { pid: +pid, ppid: +ppid, name, wsMB: +ws / 1048576, privMB: +priv / 1048576, handles: +h }; });
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const res = []; const stack = [root];
  while (stack.length) { const id = stack.pop(); for (const c of kids.get(id) ?? []) { if (c.pid === id) continue; res.push(c); stack.push(c.pid); } }
  return res;
}

async function gpu() {
  const out = await execText('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,memory.used,utilization.gpu,utilization.encoder', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const [sessions, encFps, memMB, gpuPct, encPct] = out.trim().split(/\r?\n/)[0].split(',').map((x) => Number(x.trim()));
  return { sessions, encFps, memMB, gpuPct, encPct };
}

function rpcCore(port, token, method, params = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const t = performance.now();
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/rpc', agent: false, timeout: 10000, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* none */ } resolve({ ms: performance.now() - t, result: j?.result ?? null, error: j?.error?.code ?? null }); });
    });
    req.on('error', () => resolve({ ms: performance.now() - t, result: null, error: 'net' }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

// API SSE (chat kinds): delivery time per platformMessageId, compared with the emit time. Ids only, in memory.
function openSse(port, token, emitted, lat) {
  const st = { events: 0, matched: 0, status: null };
  const req = http.request({ host: '127.0.0.1', port, path: '/events?kinds=chat.', agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
    st.status = res.statusCode; res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        st.events++;
        try {
          const id = JSON.parse(line.slice(6)).platformMessageId;
          const at = emitted.get(id);
          if (at !== undefined) { lat.push(performance.now() - at); emitted.delete(id); st.matched++; }
        } catch { /* not JSON */ }
      }
    });
  });
  req.on('error', () => {}); req.end();
  return { st, close: () => req.destroy() };
}

function httpReq(port, method, route, { cookie, csrf, body } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${port}` };
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') Object.assign(headers, { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Ujwalam-Csrf': csrf ?? '', 'Content-Length': Buffer.byteLength(data ?? '') });
    const r = http.request({ host: '127.0.0.1', port, path: route, method, headers, timeout: 15000 }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
    });
    r.on('error', () => resolve({ status: 0, body: null, headers: {} }));
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data !== null) r.write(data);
    r.end();
  });
}

function portFromLines(child, re, logFile, ms = 60000) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    const t = setTimeout(() => resolve(null), ms);
    let found = false;
    rl.on('line', (l) => { appendFileSync(logFile, `${l}\n`); if (!found) { const m = re.exec(l); if (m) { found = true; clearTimeout(t); resolve(Number(m[1])); } } });
    child.once('exit', () => { clearTimeout(t); if (!found) resolve(null); });
  });
}

function filesUnder(dir, re) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, re)); else if (re.test(e.name)) out.push(p);
  }
  return out;
}

function summariseProbe(p) {
  const v = p.streams.find((s) => s.type === 'video');
  const a = p.streams.filter((s) => s.type === 'audio');
  return { durationSec: +(p.durationSec || 0).toFixed(1), video: v ? { codec: v.codec, w: v.width, h: v.height, fps: +v.measuredFps.toFixed(2), kbps: Math.round(v.measuredKbps), gopSec: v.gopSecMedian ?? null } : null, audio: a.map((x) => ({ codec: x.codec, rate: x.sampleRate, ch: x.channels, kbps: Math.round(x.measuredKbps) })) };
}

/** Numbers from the time series (pure; tested): memory after a 10 min warm-up (or the first third), frames, sessions. */
export function summarise(rows, warmS = 600) {
  const ok = rows.filter((r) => r.host && r.mem);
  if (!ok.length) return null;
  const warm = ok.find((r) => r.t >= warmS) ?? ok[Math.floor(ok.length / 3)];
  const end = ok[ok.length - 1];
  const grow = (k) => (warm.mem[k] == null || end.mem[k] == null ? null : { atWarmup: warm.mem[k], end: end.mem[k], delta: +(end.mem[k] - warm.mem[k]).toFixed(1) });
  const sinks = {};
  for (const s of end.sinks ?? []) sinks[s.id] = { state: s.state, total: s.total, dropped: s.dropped, retries: s.retries };
  const notLive = ok.reduce((n, r) => n + (r.sinks ?? []).filter((s) => s.state !== 'live').length, 0);
  return {
    samples: ok.length, spanS: end.t, warmupAtS: warm.t,
    fpsMin: Math.min(...ok.map((r) => r.host.fps)), renderLagged: end.host.renderLagged, encodeSkipped: end.host.encodeSkipped,
    nvencSessionsMax: Math.max(...ok.map((r) => r.gpu?.sessions ?? 0)), vramMBMax: Math.max(...ok.map((r) => r.gpu?.memMB ?? 0)),
    hostCpuPctMax: Math.max(...ok.map((r) => r.host.cpuPct ?? 0)), gpuPctMax: Math.max(...ok.map((r) => r.host.gpuPct ?? 0)),
    hostPrivMB: grow('hostPrivMB'), treePrivMB: grow('privMB'), treeHandles: grow('handles'), hostHandles: grow('hostHandles'), procs: grow('procs'),
    coreRttMsMax: Math.max(...ok.map((r) => r.core?.rttMs ?? 0)), uiNon200: ok.filter((r) => r.ui && r.ui.status !== 200).length,
    sinkSamplesNotLive: notLive, sinks, markers: end.markers, captures: end.captures, overlay: end.overlay,
  };
}

/** --key value pairs; BOOLEAN_ARGS take no value (replay.mjs's parser would eat the next flag as their value). */
export const BOOLEAN_ARGS = Object.freeze(['no-record']);
export function parseRunArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOLEAN_ARGS.includes(k)) o[k] = true;
    else if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${k} needs a value`);
    else o[k] = argv[++i];
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRunArgs(argv);
  const minutes = Number(args.minutes ?? 60);
  const sampleMs = Number(args['sample-s'] ?? 30) * 1000;
  const speed = Number(args.speed ?? 1);
  const replayEveryMs = Number(args['replay-every-min'] ?? 10) * 60000;
  const effectsEveryMs = Number(args['effects-every-min'] ?? 5) * 60000;
  if (!args['data-root']) { console.log('usage: node tools/soak/stream-day.mjs --data-root DIR [--minutes 60]'); return 2; }
  const dataRoot = path.resolve(args['data-root']);
  const runId = String(args['run-id'] ?? `stream-day-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const runDir = path.join(dataRoot, 'soak', runId);
  const coreDir = path.join(runDir, 'core');
  const hostData = path.join(runDir, 'host');
  // Media (loopback receives, recording, replay saves, feedback clips) goes next to the run dir, not in it: the
  // text scan at the end reads every file of the run dir.
  const mediaDir = path.join(dataRoot, 'soak', `${runId}-media`);
  const recvDir = path.join(mediaDir, 'recv');
  const recordingsDir = path.join(mediaDir, 'recordings');
  const feedbackDir = path.join(mediaDir, 'feedback');
  for (const d of [coreDir, hostData, recvDir, recordingsDir, feedbackDir]) mkdirSync(d, { recursive: true });
  let core = null; let mock = null; let host = null; let c = null; let ui = null; let hostExit = null;
  setBelow(process.pid);
  const result = { runId, startedAt: new Date().toISOString(), minutes, speed, maxGapS: args['max-gap-s'] != null ? Number(args['max-gap-s']) : null, sampleS: sampleMs / 1000, checks: [], notes: [] };
  const check = (name, pass, detail) => { result.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
  const tsFile = path.join(runDir, 'timeseries.jsonl');

  // ---- pre-flight
  const meld = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process MeldStudio* -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', windowsHide: true });
  if (Number(meld.stdout?.trim()) > 0) { log('MeldStudio is running; not starting a heavy run'); return 4; }
  const patch = spawnSync(process.execPath, [path.join(REPO, 'tools', 'obs-patch', 'build-obs-nvenc.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  check('obs-nvenc.dll patched (build-obs-nvenc --check)', patch.status === 0 && /: patched/.test(patch.stdout));
  const gpuBefore = await gpu();
  result.gpuBefore = gpuBefore;
  const exp = chooseExport(readExports(path.join(dataRoot, 'chat', 'twitch')), 3600);
  if (!exp) { log('no chat export of at least 1 h'); return 2; }
  result.chat = { exportLengthS: exp.lengthS, messages: exp.messages.length };

  // ---- flags (this run's data dir only)
  const flags = createFlags({ dataDir: coreDir });
  for (const id of RUN_FLAGS) flags.set(id, true);
  result.flags = Object.fromEntries(RUN_FLAGS.map((id) => [id, flags.isOn(id)]));
  check('run flags on in the temp data dir only', RUN_FLAGS.every((id) => flags.isOn(id)) && !createFlags({ dataDir: path.join(runDir, 'nonexistent') }).isOn('live-markers'));

  // ---- loopback listeners
  const live = JSON.parse(readFileSync(path.join(REPO, 'data', 'outputs', 'alpha-live.json'), 'utf8'));
  const plan = loopbackPlan(live);
  const planPath = path.join(runDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const { params, report } = planFile(planPath);
  result.plan = { rungs: params.rungs?.map((r) => ({ id: r.id, canvas: r.canvas, w: r.w, h: r.h, fps: r.fps, kbps: r.bitrate })) ?? null, sinks: params.sinks.map((s) => s.id), warnings: report.warnings.map((w) => w.code) };
  const listeners = new Map();
  const startListener = (id) => {
    const t = params.sinks.find((s) => s.id === id).target;
    const n = (listeners.get(id)?.n ?? 0) + 1;
    // Segmented (5 min, last 3 kept) so an hour of 17 Mbps does not fill the disk; each segment is ffprobed.
    const pattern = path.join(recvDir, `${id}-${n}-%03d.mkv`);
    const p = track(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-i', `rtmp://127.0.0.1:${t.port}/${t.app}/${t.stream}`, '-c', 'copy', '-f', 'segment', '-segment_time', '300', '-segment_wrap', '3', '-segment_format', 'matroska', '-reset_timestamps', '1', '-y', pattern], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }));
    setBelow(p.pid);
    let errBytes = 0; p.stderr.on('data', (d) => { errBytes += d.length; appendFileSync(path.join(recvDir, `${id}-${n}.ffmpeg.log`), d); });
    const exited = new Promise((r) => p.once('exit', (c) => r(c)));
    listeners.set(id, { proc: p, n, exited, errBytes: () => errBytes });
  };
  for (const s of params.sinks) if (s.target.transport !== 'file') startListener(s.id);
  await sleep(1500);

  // ---- mock Streamer.bot + event core
  mock = await startMockStreamerbot();
  const coreTokens = { api: hex(32), system: hex(32) };
  const hostToken = hex(32);
  const hostMarkersToken = hex(32);
  const launchKey = hex(32);
  const coreArgs = coreServeArgs({ dataDir: coreDir, sbWs: { ws: mock.url } });
  const coreLog = path.join(runDir, 'core.log');
  core = track(spawn(process.execPath, [path.join(REPO, 'services', 'event-core', 'cli.mjs'), ...coreArgs.argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: coreEnv({ coreTokens, hostMarkersToken }) }));
  core.stderr.on('data', (d) => appendFileSync(coreLog, d));
  const corePort = await portFromLines(core, /api on 127\.0\.0\.1:(\d+)/, coreLog);
  if (!corePort) { log('event core did not start'); await teardown(); return 1; }
  await sleep(1000);
  setBelow(core.pid); // the core raises itself to Normal (live default); this run keeps every process BelowNormal

  // ---- host (alpha spec, headless, hotkeys off, loopback plan)
  process.env.UJWALAM_HOST_DATA = hostData;
  const hostCfg = resolveHostConfig({ dataDir: hostData, recordings: recordingsDir });
  const hcfg = alphaHostConfig({ dataDir: coreDir, feedbackDir });
  hcfg.hotkeys = { ...(hcfg.hotkeys ?? {}), enabled: false };
  const hostConfigFile = writeHostConfig(coreDir, hcfg);
  const hostDiscovery = path.join(coreDir, 'host.json');
  const spec = hostLaunchSpec({ hostCfg, hostDiscovery, args: {}, alpha: true, corePort, coreApiToken: coreTokens.api, hostConfigFile, coreSystemToken: coreTokens.system, headless: true });
  result.hostNotes = spec.notes;
  const paramsFile = path.join(hostData, 'outputs-params.json');
  writeFileSync(paramsFile, JSON.stringify(params, null, 2));
  const hostLog = openHostLog(path.join(coreDir, 'logs'));
  host = track(spawn(hostCfg.exe, [...spec.argv, '--outputs', paramsFile], { stdio: ['ignore', hostLog.fd, hostLog.fd], windowsHide: true, env: { ...process.env, ...spec.env, UJWALAM_HEADLESS: '1', UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_MARKERS_TOKEN: hostMarkersToken, UJWALAM_HOST_DISCOVERY: hostDiscovery } }));
  host.once('exit', (c) => { hostExit = c; });
  const disc = await waitForDiscovery(hostDiscovery, host);
  if (!disc) { log('host not ready'); await teardown(); return 1; }
  c = new HostClient({ port: disc.port, token: hostToken });
  const info = await c.call('host.info');
  result.host = { obsVersion: info.obsVersion, adapter: info.adapter, allowDevices: info.flags?.allowDevices, allowLive: info.flags?.allowLive, disabledModules: info.disabledModules };
  check('host: devices off, real targets off', info.flags?.allowDevices === false && info.flags?.allowLive !== true);
  await alphaProject({ client: c, dataDir: coreDir, args: { profile: path.join(REPO, 'data', 'profile.local.json') }, hostCfg });
  await alphaStatus(c);
  const ost = await c.call('outputs.status');
  check('every stream sink is a loopback target', ost.sinks.filter((s) => s.kind === 'stream').every((s) => s.target === 'loopback'), ost.sinks.map((s) => `${s.id}:${s.kind}:${s.target ?? s.container ?? ''}`));

  // ---- UI server
  const uiLog = path.join(runDir, 'ui.log');
  ui = track(spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--data-dir', coreDir, '--feedback-dir', feedbackDir, '--profile', path.join(REPO, 'data', 'profile.local.json'), '--release', path.join(REPO, 'release.json')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, UJWALAM_UI_LAUNCH_KEY: launchKey, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_DISCOVERY: hostDiscovery, UJWALAM_EVENT_CORE_PORT: String(corePort), UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: '' } }));
  ui.stderr.on('data', (d) => appendFileSync(uiLog, d));
  const uiPort = await portFromLines(ui, /listening on http:\/\/127\.0\.0\.1:(\d+)\//, uiLog);
  let cookie = null;
  if (uiPort) {
    const l = await httpReq(uiPort, 'GET', `/login?k=${launchKey}`);
    const set = l.headers['set-cookie'];
    cookie = Array.isArray(set) && set[0] ? set[0].split(';')[0] : null;
  }
  check('UI server up and one-time login works', uiPort && cookie);
  for (const p of (await treeOf(process.pid)) ?? []) setBelow(p.pid);

  // ---- wait for the core to subscribe to the mock
  for (let i = 0; i < 600 && !(mock.clientCount() > 0 && mock.subscriptions().some((s) => s.length > 0)); i++) await sleep(100);
  check('event core subscribed to the mock Streamer.bot', mock.clientCount() > 0);
  const emitted = new Map(); const lat = [];
  const sse = openSse(corePort, coreTokens.api, emitted, lat);

  // ---- start outputs (host API; loopback only)
  const startedAt = Date.now();
  result.streamStart = await c.call('stream.start').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
  if (args['no-record'] !== true) result.recordStart = await c.call('record.start').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
  await sleep(3000);

  // ---- run loop
  const endAt = startedAt + minutes * 60000;
  const actions = { replaySaves: [], effects: [], autoPost: [], feedback: [] };
  const coreRtt = []; const playLag = [];
  let sent = 0; let noClient = 0;
  const player = (async () => {
    // --max-gap-s caps each gap (dense mode, as in replay.mjs): the local exports are sparse, so a dense run is the
    // load supplement for the event core, the overlay chat feed and the chat-speed live markers.
    const items = timeline(exp.messages, { loop: true, maxGapS: args['max-gap-s'] != null ? Number(args['max-gap-s']) : null });
    let base = performance.now();
    for (const item of items) {
      const target = base + (item.tRel / speed) * 1000;
      if (Date.now() + (target - performance.now()) > endAt) break;
      let wait = target - performance.now();
      while (wait > 1) { await sleep(Math.min(wait, 2000)); wait = target - performance.now(); }
      if (Date.now() > endAt) break;
      playLag.push(Math.max(0, performance.now() - target));
      const env = envelope(item);
      emitted.set(env.data.messageId, performance.now());
      if (emitted.size > 5000) emitted.delete(emitted.keys().next().value);
      if (mock.emit(env) === 0) noClient++;
      sent++;
    }
  })();

  async function sample(tag) {
    const row = { t: Math.round((Date.now() - startedAt) / 1000), tag };
    try {
      const [hs, os2, rs, fs, ov] = await Promise.all([c.call('host.status'), c.call('outputs.status'), c.call('replay.status'), c.call('feedback.status'), c.call('overlay.stats').catch(() => null)]);
      row.host = { fps: hs.fps, cpuPct: hs.cpuPct, gpuPct: hs.gpuPct, renderLagged: hs.render?.renderLagged, encodeSkipped: hs.render?.encodeSkipped, encoderSessions: hs.gpu?.encoderSessions ?? null, live: hs.live, recording: hs.recording, dropped: hs.droppedFrames, total: hs.totalFrames };
      row.sinks = os2.sinks.map((s) => ({ id: s.id, state: s.state, kbps: s.kbps, total: s.totalFrames, dropped: s.droppedFrames, retries: s.retries }));
      row.replay = (rs.canvases ?? []).map((x) => `${x.canvas}:${x.state}`);
      row.markers = fs.markers ?? null; row.captures = fs.captures ?? null;
      row.overlay = ov ? { clients: ov.clients, chatFrames: ov.chatFrames, busFrames: ov.busFrames, effects: ov.effects, refused: ov.refused ?? ov.guards ?? null } : null;
    } catch (e) { row.hostError = String(e.code ?? e.message).slice(0, 60); }
    const cs = await rpcCore(corePort, coreTokens.api, 'core.status'); coreRtt.push(cs.ms);
    row.core = { rttMs: Math.round(cs.ms), error: cs.error, liveState: cs.result?.live?.liveState ?? null };
    if (cookie) { const u = await httpReq(uiPort, 'GET', '/ui/api/status', { cookie }); row.ui = { status: u.status, hostAvailable: u.body?.host?.available ?? null, coreAvailable: u.body?.core?.available ?? null }; }
    row.gpu = await gpu();
    const tree = await treeOf(process.pid);
    if (tree) {
      const by = (re) => tree.filter((p) => re.test(p.name));
      const sum = (ps, k) => +ps.reduce((a, p) => a + p[k], 0).toFixed(1);
      const hostP = tree.find((p) => p.pid === host.pid);
      row.mem = { procs: tree.length, privMB: sum(tree, 'privMB'), handles: sum(tree, 'handles'), hostPrivMB: hostP ? +hostP.privMB.toFixed(1) : null, hostHandles: hostP?.handles ?? null, nodePrivMB: sum(by(/^node/i), 'privMB'), ffmpegN: by(/^ffmpeg/i).length, cefN: by(/obs-browser-page|cef/i).length };
    }
    row.chat = { sent, noClient, sse: sse.st.events, matched: sse.st.matched };
    appendFileSync(tsFile, `${JSON.stringify(row)}\n`);
    return row;
  }

  async function effectBurst() {
    const out = { at: Math.round((Date.now() - startedAt) / 1000), fired: 0, delivered: 0, refused: {} };
    for (const [name, n, gapMs] of [['storm', 8, 60], ['charge', 6, 100], ['gg', 3, 200]]) {
      for (let i = 0; i < n; i++) {
        const r = await c.call('effect.fire', { name, meta: { source: 'stream-day' } }).catch((e) => ({ ok: false, reason: `error-${e.code ?? 'x'}` }));
        out.fired++;
        if (r.ok) out.delivered++; else out.refused[r.reason ?? 'unknown'] = (out.refused[r.reason ?? 'unknown'] ?? 0) + 1;
        await sleep(gapMs);
      }
    }
    actions.effects.push(out);
    log('effects', JSON.stringify(out));
  }

  async function replaySave() {
    const r = await c.call('replay.save').then((x) => ({ ok: true, files: (x.saved ?? x.files ?? []).length ?? null }), (e) => ({ ok: false, code: e.code ?? e.message }));
    actions.replaySaves.push({ at: Math.round((Date.now() - startedAt) / 1000), ...r });
    log('replay.save', JSON.stringify(r));
  }

  function postingCli(extra) {
    // The environment of a user's shell: no host token, no host discovery override.
    const env = { ...process.env }; for (const k of ['UJWALAM_HOST_TOKEN', 'UJWALAM_HOST_DISCOVERY', 'UJWALAM_HOST_DATA', 'UJWALAM_HOST_MARKERS_TOKEN']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(REPO, 'services', 'posting', 'cli.mjs'), 'auto', '--data-dir', coreDir, ...extra], { encoding: 'utf8', windowsHide: true, env, timeout: 60000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(0, 3).map((l) => l.slice(0, 160)) };
  }
  const rulesFile = path.join(runDir, 'auto-rules.json');
  writeFileSync(rulesFile, JSON.stringify({ autoUpload: false, rules: [{ id: 'mock-run', target: 'youtube-shorts', minScore: 0, maxPerDay: 1 }] }));

  let nextReplay = startedAt + Math.min(replayEveryMs, 120000);
  let nextEffects = startedAt + 60000;
  let autoDone = false;
  let stopEarly = null;
  while (Date.now() < endAt) {
    const row = await sample('tick');
    const failed = row.sinks?.filter((s) => s.state !== 'live').map((s) => `${s.id}:${s.state}`) ?? [];
    if (row.hostError || hostExit !== null) { stopEarly = `host ${row.hostError ?? `exited ${hostExit}`}`; break; }
    log(`t=${row.t}s fps ${row.host?.fps} lagged ${row.host?.renderLagged} skipped ${row.host?.encodeSkipped} nvenc ${row.gpu?.sessions} hostPriv ${row.mem?.hostPrivMB}MB chat ${row.chat.sent}/${row.chat.sse} markers ${row.markers} effects ${row.overlay?.effects}${failed.length ? ` NOT LIVE ${failed.join(',')}` : ''}`);
    if (Date.now() >= nextEffects) { await effectBurst(); nextEffects += effectsEveryMs; }
    if (Date.now() >= nextReplay) { await replaySave(); nextReplay += replayEveryMs; }
    if (!autoDone && Date.now() - startedAt > 90000) {
      autoDone = true;
      actions.autoPost.push({ phase: 'live', dry: postingCli([]), run: postingCli(['--run', '--rules', rulesFile]) });
      log('auto-post while live', JSON.stringify(actions.autoPost.at(-1)));
    }
    const fc = await c.call('feedback.status').catch(() => null);
    if (fc && actions.feedback.length === 0 && Date.now() - startedAt > 5 * 60000) {
      actions.feedback.push(await c.call('feedback.capture', { note: '' }).then(() => 'ok', (e) => `error ${e.code ?? e.message}`));
    }
    await sleep(Math.max(0, sampleMs - 1500));
  }
  if (stopEarly) result.notes.push(`stopped early: ${stopEarly}`);
  await player.catch(() => {});
  await sleep(5000);
  const last = await sample('end').catch(() => null);
  result.endSample = last;

  // ---- stop outputs
  if (hostExit === null) {
    result.streamStop = await c.call('stream.stop').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    if (args['no-record'] !== true) result.recordStop = await c.call('record.stop').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    for (let i = 0; i < 60; i++) { const s = await c.call('outputs.status').catch(() => null); if (!s || s.sinks.every((x) => !['starting', 'live', 'retrying', 'stopping'].includes(x.state))) break; await sleep(500); }
    actions.autoPost.push({ phase: 'after-stop', dry: postingCli([]), run: postingCli(['--run', '--rules', rulesFile]) });
    log('auto-post after stop', JSON.stringify(actions.autoPost.at(-1)));
  }
  result.actions = actions;
  result.chatPlayed = { sent, noClient, sse: sse.st.events, matched: sse.st.matched, emitLagMs: { p50: pct(playLag, 0.5), p95: pct(playLag, 0.95), max: playLag.length ? Math.max(...playLag) : null } };
  result.eventCoreLatencyMs = { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat.length ? Math.max(...lat) : null };
  result.coreRttMs = { p50: pct(coreRtt, 0.5), p95: pct(coreRtt, 0.95), max: coreRtt.length ? Math.max(...coreRtt) : null };
  sse.close();

  await teardown();

  // ---- after: probes, crash reports, strays, purge, text scan
  result.hostExitCode = hostExit;
  result.received = {};
  for (const f of filesUnder(recvDir, /\.mkv$/)) {
    try { result.received[path.basename(f)] = summariseProbe(probe(f)); } catch (e) { result.received[path.basename(f)] = { error: String(e.message).slice(0, 80) }; }
  }
  result.recordings = {};
  for (const f of filesUnder(mediaDir, /\.mkv$/).filter((x) => !x.startsWith(recvDir))) {
    const key = path.relative(mediaDir, f).replaceAll('\\', '/');
    const size = statSync(f).size;
    try { result.recordings[key] = { sizeMB: Math.round(size / 1048576), ...(size < 512 * 1048576 ? summariseProbe(probe(f)) : { note: 'large file: format only', durationSec: Number(JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', f], { encoding: 'utf8', windowsHide: true }).stdout).format.duration) }) }; } catch (e) { result.recordings[key] = { sizeMB: Math.round(size / 1048576), error: String(e.message).slice(0, 80) }; }
  }
  result.crashReports = [...filesUnder(runDir, /^crash-.*\.txt$/), ...filesUnder(mediaDir, /^crash-.*\.txt$/)].map((f) => path.basename(f));
  const markerFiles = filesUnder(coreDir, /\.jsonl$/).concat(filesUnder(hostData, /\.jsonl$/)).filter((f) => /marker/i.test(f));
  result.markerFiles = markerFiles.map((f) => {
    const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const by = {}; for (const r of rows) by[r.source ?? 'unknown'] = (by[r.source ?? 'unknown'] ?? 0) + 1;
    return { file: path.relative(runDir, f), count: rows.length, bySource: by };
  });
  await sleep(2000);
  const strays = scanStrays();
  result.strays = { node: Array.isArray(strays) ? strays.length : null };
  const left = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process ujwalam-host,ffmpeg,obs-browser-page -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', windowsHide: true });
  result.strays.hostFfmpegCef = Number(left.stdout?.trim());
  // Names that are also profile values (the streamer's own channel names, used in overlay URLs of the local alpha
  // project) are not chat data; they are left out of the name scan and counted separately.
  let profileText = '';
  try { profileText = readFileSync(path.join(REPO, 'data', 'profile.local.json'), 'utf8').toLowerCase(); } catch { /* no profile */ }
  const inProfile = (n) => n.length >= 5 && profileText.includes(n.toLowerCase());
  const scanMsgs = exp.messages.map((m) => ({ ...m, name: inProfile(m.name) ? '' : m.name, login: inProfile(m.login) ? '' : m.login }));
  result.textScanProfileNamesExcluded = new Set(exp.messages.flatMap((m) => [m.name, m.login]).filter(inProfile)).size;
  try { result.textScan = purgeProof({ dataDir: coreDir, runDir, messages: scanMsgs }); } catch (e) { result.textScan = { error: String(e.message).slice(0, 80) }; }
  result.gpuAfter = await gpu();
  result.summary = summarise(readFileSync(tsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  result.endedAt = new Date().toISOString();
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  log('result:', path.join(runDir, 'result.json'));
  return 0;

  async function teardown() {
    try { ui?.kill(); } catch { /* gone */ }
    if (host && c && hostExit === null) {
      try { await c.call('host.shutdown'); } catch { /* fall through */ }
      for (let i = 0; i < 80 && hostExit === null; i++) await sleep(250);
      if (hostExit === null) killTree(host.pid);
    }
    try { core?.kill(); } catch { /* gone */ }
    try { await mock?.close(); } catch { /* not started */ }
    for (const [, l] of listeners) { try { l.proc.stdin.write('q'); } catch { /* gone */ } }
    await Promise.race([Promise.all([...listeners.values()].map((l) => l.exited)), sleep(15000)]);
    for (const [, l] of listeners) if (l.proc.exitCode === null) killTree(l.proc.pid);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
