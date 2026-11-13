// SPDX-License-Identifier: GPL-3.0-or-later
// The headless alpha stack on loopback outputs, shared by the stream-day mock run (stream-day.mjs) and the live soak
// gate (live-soak.mjs, LU8). Node stdlib + repo modules.
//
//   const st = await startStack({ runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check, root?, profile? });
//   ... st.c (HostClient), st.corePort, st.coreTokens, st.uiPort, st.cookie, st.mock, st.params ...
//   await st.teardown();
//
// What runs: mock Streamer.bot (127.0.0.1), the event core (`services/event-core/cli.mjs serve --url <mock>`) with the
// launcher's own environment, ujwalam-host in alpha mode with UJWALAM_HEADLESS=1 (no window), no --allow-devices, no
// --allow-live, hotkeys off, and an outputs plan whose every stream target is a 127.0.0.1 RTMP listener (ffmpeg
// -listen 1, segmented .mkv), the alpha project, and the studio UI server (logged in with the one-time launch key).
// root: where the Node services, the overlay child and data/ come from (default: this repo). The live soak passes a
// staged copy (stage.mjs) so it can change data files while the stack runs without touching the repo.
// swap: true (LU3, D337): the event core and the UI server run behind the launcher's stable-port fronts, as with the
// service-swap flag; st.coreSlot / st.uiSlot swap them (swap-soak.mjs), st.corePort / st.uiPort are the front ports.
// Every process is kept at BelowNormal priority. Nothing here can reach a real platform: the host refuses real
// targets without --allow-live and every target is a loopback listener.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';
import { planFile } from '../../app/host/lib/outputs-plan.mjs';
import { alphaHostConfig, alphaProject, alphaStatus, coreEnv, coreServeArgs, hostLaunchSpec, openHostLog, waitForDiscovery, writeHostConfig } from '../../services/studio-ui/launch.mjs';
import { startMockStreamerbot } from '../mock/mock-streamerbot.mjs';
import { createFront } from '../../services/supervisor/front.mjs';
import { createEventCoreSlot, createUiSlot } from '../../services/supervisor/slots.mjs';
import { killTree, track } from '../proc-registry.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL;
export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => randomBytes(n).toString('hex');
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

export function setBelow(pid) { try { os.setPriority(pid, BELOW); return true; } catch { return false; } }

export function execText(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Every process below `root` (Windows CIM, one query): [{ pid, ppid, name, wsMB, privMB, handles }].
const TREE_PS = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | ForEach-Object { "{0}|{1}|{2}|{3}|{4}|{5}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.WorkingSetSize,$_.PrivatePageCount,$_.HandleCount }';
export async function treeOf(root) {
  const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TREE_PS]);
  if (!out) return null;
  const all = out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, name, ws, priv, h] = l.split('|'); return { pid: +pid, ppid: +ppid, name, wsMB: +ws / 1048576, privMB: +priv / 1048576, handles: +h }; });
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const res = []; const stack = [root];
  while (stack.length) { const id = stack.pop(); for (const c of kids.get(id) ?? []) { if (c.pid === id) continue; res.push(c); stack.push(c.pid); } }
  return res;
}

export async function gpu() {
  const out = await execText('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,memory.used,utilization.gpu,utilization.encoder', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const [sessions, encFps, memMB, gpuPct, encPct] = out.trim().split(/\r?\n/)[0].split(',').map((x) => Number(x.trim()));
  return { sessions, encFps, memMB, gpuPct, encPct };
}

export function rpcCore(port, token, method, params = {}) {
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
export function openSse(port, token, emitted, lat) {
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

export function httpReq(port, method, route, { cookie, csrf, body } = {}) {
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

export function portFromLines(child, re, logFile, ms = 60000) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    const t = setTimeout(() => resolve(null), ms);
    let found = false;
    rl.on('line', (l) => { appendFileSync(logFile, `${l}\n`); if (!found) { const m = re.exec(l); if (m) { found = true; clearTimeout(t); resolve(Number(m[1])); } } });
    child.once('exit', () => { clearTimeout(t); if (!found) resolve(null); });
  });
}

export function filesUnder(dir, re) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, re)); else if (re.test(e.name)) out.push(p);
  }
  return out;
}

export function summariseProbe(p) {
  const v = p.streams.find((s) => s.type === 'video');
  const a = p.streams.filter((s) => s.type === 'audio');
  return { durationSec: +(p.durationSec || 0).toFixed(1), video: v ? { codec: v.codec, w: v.width, h: v.height, fps: +v.measuredFps.toFixed(2), kbps: Math.round(v.measuredKbps), gopSec: v.gopSecMedian ?? null } : null, audio: a.map((x) => ({ codec: x.codec, rate: x.sampleRate, ch: x.channels, kbps: Math.round(x.measuredKbps) })) };
}

/** Pre-flight shared by the heavy runs: Meld Studio must not be running (6 GB VRAM has no room for both); the patched
 *  obs-nvenc.dll is reported as a check. Returns false when the run must not start. */
export function preflight({ log, check }) {
  const meld = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process MeldStudio* -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', windowsHide: true });
  if (Number(meld.stdout?.trim()) > 0) { log('MeldStudio is running; not starting a heavy run'); return false; }
  const patch = spawnSync(process.execPath, [path.join(REPO, 'tools', 'obs-patch', 'build-obs-nvenc.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  check('obs-nvenc.dll patched (build-obs-nvenc --check)', patch.status === 0 && /: patched/.test(patch.stdout));
  return true;
}

/**
 * Starts the stack (see the header). opts: { runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check,
 * root?, profile? (local profile for the alpha project; default the repo's data/profile.local.json when present),
 * segmentSec? (300), segmentWrap? (3; 0 = keep every segment) }. Returns null (after its own teardown) when a piece
 * did not start.
 */
export async function startStack(opts) {
  const { runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check } = opts;
  const root = path.resolve(opts.root ?? REPO);
  const segmentSec = opts.segmentSec ?? 300;
  const segmentWrap = opts.segmentWrap ?? 3;
  const st = { listeners: new Map(), hostExit: null, notes: [] };
  let core = null; let mock = null; let host = null; let ui = null;

  // ---- loopback listeners
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'outputs', 'alpha-live.json'), 'utf8'));
  const plan = loopbackPlan(opts.config ? { ...live, config: opts.config } : live);
  const planPath = path.join(runDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const { params, report } = planFile(planPath);
  st.params = params; st.planReport = report;
  st.startListener = (id) => {
    const t = params.sinks.find((s) => s.id === id).target;
    const n = (st.listeners.get(id)?.n ?? 0) + 1;
    // Segmented so a long run does not need one huge file; each segment is ffprobed. wrap 0 keeps all of them.
    const pattern = path.join(recvDir, `${id}-${n}-%03d.mkv`);
    const seg = ['-f', 'segment', '-segment_time', String(segmentSec), ...(segmentWrap > 0 ? ['-segment_wrap', String(segmentWrap)] : []), '-segment_format', 'matroska', '-reset_timestamps', '1'];
    const p = track(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-i', `rtmp://127.0.0.1:${t.port}/${t.app}/${t.stream}`, '-c', 'copy', ...seg, '-y', pattern], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }));
    setBelow(p.pid);
    let errBytes = 0; p.stderr.on('data', (d) => { errBytes += d.length; appendFileSync(path.join(recvDir, `${id}-${n}.ffmpeg.log`), d); });
    const exited = new Promise((r) => p.once('exit', (c) => r(c)));
    st.listeners.set(id, { proc: p, n, exited, errBytes: () => errBytes });
  };
  for (const s of params.sinks) if (s.target.transport !== 'file') st.startListener(s.id);
  await sleep(1500);

  // ---- mock Streamer.bot + event core
  mock = await startMockStreamerbot();
  st.mock = mock;
  st.coreTokens = { api: hex(32), system: hex(32) };
  const hostToken = hex(32);
  const hostMarkersToken = hex(32);
  const launchKey = hex(32);
  const coreArgs = coreServeArgs({ dataDir: coreDir, sbWs: { ws: mock.url } });
  st.coreLog = path.join(runDir, 'core.log');
  st.coreExit = null;
  if (opts.swap) {
    // As the launcher with the service-swap flag: a front, a slot, the swap switches right after 'serve'.
    st.coreFront = createFront({ backendPort: null, name: 'event-core', log: (l) => appendFileSync(st.coreLog, `${l}\n`) });
    await st.coreFront.listen();
    const spawnCore = (r, { standby = false } = {}) => {
      const c = track(spawn(process.execPath, [path.join(r, 'services', 'event-core', 'cli.mjs'), coreArgs.argv[0], '--swap-control', '--public-port', String(st.coreFront.port()), ...(standby ? ['--standby'] : []), ...coreArgs.argv.slice(1)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...coreEnv({ coreTokens: st.coreTokens, hostMarkersToken }), UJWALAM_PARENT_PIPE: '1' } }));
      c.stderr.on('data', (d) => appendFileSync(st.coreLog, d));
      c.once('spawn', () => setTimeout(() => setBelow(c.pid), 1500)); // the core raises itself to Normal; keep it BelowNormal
      return c;
    };
    st.coreSlot = createEventCoreSlot({ front: st.coreFront, root, spawn: spawnCore, systemToken: st.coreTokens.system, onLine: (l) => appendFileSync(st.coreLog, `${l}\n`), onUnexpectedExit: (c, code) => { st.coreExit = code; }, log: (l) => appendFileSync(st.coreLog, `${l}\n`) });
    try { await st.coreSlot.start(); st.corePort = st.coreFront.port(); } catch (e) { log(`event core: ${e.message}`); }
    if (!st.corePort) { log('event core did not start'); await teardown(); return null; }
    await sleep(1000);
  } else {
    core = track(spawn(process.execPath, [path.join(root, 'services', 'event-core', 'cli.mjs'), ...coreArgs.argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: coreEnv({ coreTokens: st.coreTokens, hostMarkersToken }) }));
    st.core = core;
    core.once('exit', (c) => { st.coreExit = c; });
    core.stderr.on('data', (d) => appendFileSync(st.coreLog, d));
    st.corePort = await portFromLines(core, /api on 127\.0\.0\.1:(\d+)/, st.coreLog);
    if (!st.corePort) { log('event core did not start'); await teardown(); return null; }
    await sleep(1000);
    setBelow(core.pid); // the core raises itself to Normal (live default); these runs keep every process BelowNormal
  }

  // ---- host (alpha spec, headless, hotkeys off, loopback plan)
  process.env.UJWALAM_HOST_DATA = hostData;
  const hostCfg = resolveHostConfig({ dataDir: hostData, recordings: recordingsDir });
  if (root !== REPO) hostCfg.overlayScript = path.join(root, 'app', 'host', 'overlay', 'child.mjs');
  const hcfg = alphaHostConfig({ dataDir: coreDir, feedbackDir });
  hcfg.hotkeys = { ...(hcfg.hotkeys ?? {}), enabled: false };
  const hostConfigFile = writeHostConfig(coreDir, hcfg);
  const hostDiscovery = path.join(coreDir, 'host.json');
  const spec = hostLaunchSpec({ hostCfg, hostDiscovery, args: {}, alpha: true, corePort: st.corePort, coreApiToken: st.coreTokens.api, hostConfigFile, coreSystemToken: st.coreTokens.system, headless: true });
  st.hostNotes = spec.notes;
  const paramsFile = path.join(hostData, 'outputs-params.json');
  writeFileSync(paramsFile, JSON.stringify(params, null, 2));
  const hostLog = openHostLog(path.join(coreDir, 'logs'));
  st.hostLogFile = hostLog.file;
  host = track(spawn(hostCfg.exe, [...spec.argv, '--outputs', paramsFile], { stdio: ['ignore', hostLog.fd, hostLog.fd], windowsHide: true, env: { ...process.env, ...spec.env, UJWALAM_HEADLESS: '1', UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_MARKERS_TOKEN: hostMarkersToken, UJWALAM_HOST_DISCOVERY: hostDiscovery } }));
  st.host = host;
  host.once('exit', (c) => { st.hostExit = c; });
  const disc = await waitForDiscovery(hostDiscovery, host);
  if (!disc) { log('host not ready'); await teardown(); return null; }
  const c = new HostClient({ port: disc.port, token: hostToken });
  st.c = c;
  const info = await c.call('host.info');
  st.hostInfo = { obsVersion: info.obsVersion, adapter: info.adapter, allowDevices: info.flags?.allowDevices, allowLive: info.flags?.allowLive, disabledModules: info.disabledModules };
  check('host: devices off, real targets off', info.flags?.allowDevices === false && info.flags?.allowLive !== true);
  const profile = opts.profile !== undefined ? opts.profile : (existsSync(path.join(REPO, 'data', 'profile.local.json')) ? path.join(REPO, 'data', 'profile.local.json') : path.join(runDir, 'no-profile.json'));
  await alphaProject({ client: c, dataDir: coreDir, args: { profile }, hostCfg });
  await alphaStatus(c);
  const ost = await c.call('outputs.status');
  check('every stream sink is a loopback target', ost.sinks.filter((s) => s.kind === 'stream').every((s) => s.target === 'loopback'), ost.sinks.map((s) => `${s.id}:${s.kind}:${s.target ?? s.container ?? ''}`));

  // ---- UI server
  st.uiLog = path.join(runDir, 'ui.log');
  const uiEnv = { ...process.env, UJWALAM_UI_LAUNCH_KEY: launchKey, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_DISCOVERY: hostDiscovery, UJWALAM_EVENT_CORE_PORT: String(st.corePort), UJWALAM_EVENT_CORE_API_TOKEN: st.coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: '' };
  const uiArgv = (r) => [path.join(r, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--data-dir', coreDir, '--feedback-dir', feedbackDir, '--profile', profile, '--release', path.join(r, 'release.json')];
  st.uiExit = null;
  if (opts.swap) {
    st.uiFront = createFront({ backendPort: null, name: 'studio-ui', log: (l) => appendFileSync(st.uiLog, `${l}\n`) });
    await st.uiFront.listen();
    const spawnUi = (r) => {
      const c = track(spawn(process.execPath, uiArgv(r), { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...uiEnv, UJWALAM_PARENT_PIPE: '1' } }));
      c.stderr.on('data', (d) => appendFileSync(st.uiLog, d));
      c.once('spawn', () => setBelow(c.pid));
      return c;
    };
    st.uiSlot = createUiSlot({ front: st.uiFront, root, spawn: spawnUi, onLine: (l) => appendFileSync(st.uiLog, `${l}\n`), onUnexpectedExit: (c, code) => { st.uiExit = code; }, log: (l) => appendFileSync(st.uiLog, `${l}\n`) });
    try { await st.uiSlot.start(); st.uiPort = st.uiFront.port(); } catch (e) { log(`UI server: ${e.message}`); st.uiPort = null; }
  } else {
    ui = track(spawn(process.execPath, uiArgv(root), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: uiEnv }));
    st.ui = ui;
    ui.once('exit', (x) => { st.uiExit = x; });
    ui.stderr.on('data', (d) => appendFileSync(st.uiLog, d));
    st.uiPort = await portFromLines(ui, /listening on http:\/\/127\.0\.0\.1:(\d+)\//, st.uiLog);
  }
  st.cookie = null;
  if (st.uiPort) {
    const l = await httpReq(st.uiPort, 'GET', `/login?k=${launchKey}`);
    const set = l.headers['set-cookie'];
    st.cookie = Array.isArray(set) && set[0] ? set[0].split(';')[0] : null;
  }
  check('UI server up and one-time login works', st.uiPort && st.cookie);
  for (const p of (await treeOf(process.pid)) ?? []) setBelow(p.pid);

  // ---- wait for the core to subscribe to the mock
  for (let i = 0; i < 600 && !(mock.clientCount() > 0 && mock.subscriptions().some((s) => s.length > 0)); i++) await sleep(100);
  check('event core subscribed to the mock Streamer.bot', mock.clientCount() > 0);

  st.teardown = teardown;
  return st;

  async function teardown() {
    try { ui?.kill(); } catch { /* gone */ }
    try { await st.uiSlot?.stop(); } catch { /* gone */ }
    if (host && st.c && st.hostExit === null) {
      try { await st.c.call('host.shutdown'); } catch { /* fall through */ }
      for (let i = 0; i < 240 && st.hostExit === null; i++) await sleep(250); // the wait ends at exit
      if (st.hostExit === null) killTree(host.pid);
    } else if (host && st.hostExit === null) killTree(host.pid);
    try { core?.kill(); } catch { /* gone */ }
    try { await st.coreSlot?.stop(); } catch { /* gone */ }
    st.coreFront?.close(); st.uiFront?.close();
    try { await mock?.close(); } catch { /* not started */ }
    for (const [, l] of st.listeners) { try { l.proc.stdin.write('q'); } catch { /* gone */ } }
    await Promise.race([Promise.all([...st.listeners.values()].map((l) => l.exited)), sleep(15000)]);
    for (const [, l] of st.listeners) if (l.proc.exitCode === null) killTree(l.proc.pid);
  }
}
