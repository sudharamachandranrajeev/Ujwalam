// SPDX-License-Identifier: GPL-2.0-or-later
// One-command launcher: event core, libobs host (when present) and the studio UI server, then the browser.
// Usage: node services/studio-ui/launch.mjs [--data-dir DIR] [--mock] [--no-open] [--host-exe PATH] [--fake-host] [--allow-devices] [--outputs PLAN.json] [--stop-on-stdin] [--ui-port N]
//                                           [--alpha [--rebuild-alpha] [--profile FILE]]
//
// Tokens: the launcher makes the event-core api/system tokens and a host token, passes them to the children by
// environment (never argv, never printed). The UI server gets only the api token, never the system token. The browser
// is opened on /login?k=<one-time launch key>; the key is not printed.
// Process priority: children inherit Normal (nothing here lowers it); the event core also sets itself to Normal.
// Host: started when its exe and OBS runtime resolve (app/host/lib/config.mjs) and --fake-host is not given. The host
// token goes by environment to the host and the UI server only; the discovery file is <event-core data dir>/host.json.
// Host stdout/stderr go to <data dir>/logs/host-<stamp>.log (the newest 10 are kept). --host-exe may name a .mjs file,
// which runs under this Node (the fake host of the launcher tests).
//
// --alpha (npm run alpha; Alpha 0 day 1): the host starts with native H and V previews (--preview h,v), browser layers
// and the overlay server child (--allow-browser --overlay-root <cfg.overlayRoot> --overlay-script
// app/host/overlay/child.mjs) fed by the event core's /events (--overlay-events-url; the event-core api token goes
// to the host by environment, D91, and the host passes it only to that child). The project is
// <data dir>/projects/alpha.project.json (services/studio-ui/alpha.mjs): loaded unchanged when it exists, else built
// from the Default H (+ Default V) presets; --rebuild-alpha moves the old one to projects/_old/ and builds again.
// With --allow-devices the roles (game capture, facecam, mic) are matched from devices.list (never guessed); without
// it the device layers are placeholders. --profile names the profile (default data/profile.local.json).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';
import { loadFileIntoHost } from '../../app/host/lib/project.mjs';
import { resolveDataDir } from '../event-core/config.mjs';
import { loadDevicePresets, matchRoles, overrideProblems } from '../project/device-roles.mjs';
import { loadProject } from '../project/store.mjs';
import { alphaBases, buildAlphaProject, prepareAlphaProject, readProfile, stampOf } from './alpha.mjs';
import { rpc } from './backends.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (n) => randomBytes(n).toString('hex');
export const HOST_LOGS_KEPT = 10;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); out[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; }
  }
  return out;
}

// UJWALAM_BROWSER (an executable) and UJWALAM_BROWSER_ARGS (space separated flags) pick the browser; used by the UI tests.
function openBrowser(url) {
  const opts = { stdio: 'ignore', detached: true, windowsHide: true };
  if (process.env.UJWALAM_BROWSER) {
    spawn(process.env.UJWALAM_BROWSER, [...(process.env.UJWALAM_BROWSER_ARGS ?? '').split(' ').filter(Boolean), url], opts).unref();
    return;
  }
  if (process.platform === 'win32') spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'start', '""', url], opts).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts).unref();
}

// Starts a child whose stdout is scanned for a "listening" line; resolves the port from the first capture group.
function portFrom(child, re) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    const t = setTimeout(() => resolve(null), 20_000);
    rl.on('line', (l) => { console.log(l); const m = re.exec(l); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.once('exit', () => { clearTimeout(t); resolve(null); });
  });
}

/** Opens <logsDir>/host-<stamp>.log for the host's stdout/stderr and removes the oldest so that `keep` remain. */
export function openHostLog(logsDir, { keep = HOST_LOGS_KEPT, now = new Date() } = {}) {
  mkdirSync(logsDir, { recursive: true });
  const old = readdirSync(logsDir).filter((n) => /^host-.*\.log$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - (keep - 1)))) {
    try { rmSync(path.join(logsDir, n)); } catch { /* in use by another run: kept */ }
  }
  const file = path.join(logsDir, `host-${stampOf(now)}.log`);
  return { file, fd: openSync(file, 'a') };
}

/** Host argv and extra environment (pure; tested). Tokens only ever go into env, never argv. */
export function hostLaunchSpec({ hostCfg, hostDiscovery, args, alpha = false, corePort, coreApiToken }) {
  const argv = ['--runtime', hostCfg.runtime, '--data-dir', hostCfg.dataDir, '--discovery', hostDiscovery, '--recordings', hostCfg.recordings];
  const env = {};
  const notes = [];
  // The test card (H + V canvases) also starts the alpha host: --preview opens its windows at start, before the
  // project v1 load (project.load only), and a V preview needs a V canvas to exist (first alpha run: "canvas V does
  // not exist"). The previews look their canvas up by name every frame, so they show the alpha project after the load.
  argv.push('--project', path.join(REPO, 'app', 'host', 'projects', 'test-card.project.json'));
  if (args['allow-devices'] === true) argv.push('--allow-devices');
  if (alpha) {
    argv.push('--preview', 'h,v');
    if (hostCfg.overlayRoot && existsSync(hostCfg.overlayRoot)) {
      argv.push('--allow-browser', '--overlay-root', hostCfg.overlayRoot, '--overlay-script', hostCfg.overlayScript, '--node', process.execPath);
      if (Number.isInteger(corePort) && corePort > 0 && /^[0-9a-f]{64}$/.test(coreApiToken ?? '')) {
        argv.push('--overlay-events-url', `http://127.0.0.1:${corePort}/events`);
        env.UJWALAM_EVENT_CORE_API_TOKEN = coreApiToken;
      } else notes.push('no event core port or token: overlays get no Streamer.bot events');
    } else {
      notes.push('overlay root not found (UJWALAM_OVERLAY_ROOT or "overlayRoot" in app/host/host.local.json): overlays are off');
    }
  }
  return { argv, env, notes };
}

// A discovery file left by a killed host (its pid is gone) is removed; one whose pid still runs is kept.
function removeStaleDiscovery(file) {
  let pid;
  try { pid = JSON.parse(readFileSync(file, 'utf8')).pid; } catch { return; }
  try { process.kill(pid, 0); return; } catch (e) { if (e.code === 'EPERM') return; }
  try { rmSync(file); } catch { /* gone or in use */ }
}

async function waitForDiscovery(file, child, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && child.exitCode === null) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      if (d.pid === child.pid && Number.isInteger(d.port)) return d;
    } catch { /* not there yet or partly written */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Alpha project: build (or keep) <dataDir>/projects/alpha.project.json, then project.load it into the host.
async function alphaProject({ client, dataDir, args, hostCfg }) {
  const profileFile = typeof args.profile === 'string' ? path.resolve(args.profile) : path.join(REPO, 'data', 'profile.local.json');
  const profile = readProfile(profileFile);
  let report = null;
  const r = await prepareAlphaProject({
    dataDir,
    rebuild: args['rebuild-alpha'] === true,
    build: async () => {
      let bindings = { bound: {}, unavailable: [] };
      if (args['allow-devices'] === true) {
        const overrides = profile?.devices?.roles ?? {};
        const problems = overrideProblems(overrides);
        if (problems.length) throw new Error(`profile devices.roles: ${problems.join('; ')}`);
        const list = await client.call('devices.list');
        bindings = matchRoles({ list, presets: loadDevicePresets(path.join(REPO, 'registry', 'presets')), overrides });
      }
      const b = buildAlphaProject({ presetsDir: path.join(REPO, 'registry', 'presets'), profile, bindings, devicesListed: args['allow-devices'] === true });
      report = b.report;
      return b.project;
    },
  });
  console.log(`[studio] alpha project ${r.action}: ${path.basename(r.file)}${r.moved ? ' (old one moved to projects/_old/)' : ''}`);
  if (report) {
    for (const w of report.warnings) console.log(`[studio] WARNING: ${w}`);
    for (const [role, b] of Object.entries(report.roles)) console.log(`[studio] role ${role}: bound (${b.by}${b.preset ? ` ${b.preset}` : ''})`);
    for (const u of report.unavailableRoles) console.log(`[studio] role ${u.role}: not bound: ${u.reason}`);
    if (args['allow-devices'] !== true) console.log('[studio] devices off: game capture and facecam are placeholders (run with --allow-devices --rebuild-alpha after "devices ready")');
  } else {
    const { project } = loadProject(r.file);
    if (args['allow-devices'] === true && project.origin?.importer === 'alpha' && project.origin.id === 'no-devices') {
      console.log('[studio] WARNING: the alpha project was built without devices and is loaded unchanged; add --rebuild-alpha to bind them');
    }
  }
  const bases = alphaBases({ profile, overlayRoot: hostCfg.overlayRoot });
  const loaded = await loadFileIntoHost(client, r.file, { bases, skipUnavailable: true });
  console.log(`[studio] alpha project loaded into the host: ${JSON.stringify(loaded.built ?? {})}; not built: ${loaded.unavailable?.length ?? 0}`);
  for (const u of loaded.unavailable ?? []) console.log(`[studio]   not built: ${u.layer ?? u.audio}: ${u.code}: ${u.reason}`);
  try { // a preview that did not open at start (e.g. closed by hand on a reused host) is opened now
    const open = new Set(((await client.call('preview.list')).previews ?? []).filter((p) => p.open === true).map((p) => String(p.canvas).toUpperCase()));
    for (const c of ['H', 'V']) if (!open.has(c)) { await client.call('preview.open', { canvas: c }); console.log(`[studio] preview ${c} opened after the load`); }
  } catch (e) { console.log(`[studio] WARNING: preview open failed: ${e.message}`); }
  try {
    const st = await client.call('overlay.status');
    console.log(`[studio] overlay server: ${st.state ?? 'unknown'}; event feed: ${st.eventFeed === true ? 'on' : 'off'}; child has the event token: ${st.childHasEventToken === true ? 'yes' : 'no'}; browser layers ${st.browserAllowed ? 'allowed' : 'off'}`);
  } catch (e) { console.log(`[studio] overlay status unavailable: ${e.message}`); }
  return r;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const alpha = args.alpha === true;
  let dataDir;
  try { dataDir = resolveDataDir({ dataDir: typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined }); } catch (e) { console.log(`[studio] ${e.message}`); return 1; }
  const children = [];
  let hostChild = null;
  let hostDiscoveryFile = null;
  let alphaClient = null;
  // Ask the host to exit cleanly first (it closes previews and removes its discovery file), then kill what is left.
  const stopAll = async () => {
    if (hostChild && hostChild.exitCode === null && hostDiscoveryFile) {
      try {
        const d = JSON.parse(readFileSync(hostDiscoveryFile, 'utf8'));
        await rpc({ port: d.port, token: hostToken, method: 'host.shutdown', params: {}, timeoutMs: 2000 }); // node:http: the host refuses fetch (it sends Sec-Fetch headers)
        await new Promise((r) => { hostChild.once('exit', r); setTimeout(r, 8000); });
      } catch { /* fall through to kill */ }
    }
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  };
  process.once('SIGINT', () => { stopAll().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { stopAll().then(() => process.exit(0)); });

  const hostToken = hex(32);
  const coreTokens = { api: hex(32), system: hex(32) };
  const launchKey = hex(32);

  // 1. event core (port 0; its own log line reports the port)
  const core = spawn(process.execPath, [path.join(REPO, 'services', 'event-core', 'cli.mjs'), 'serve', '--data-dir', dataDir, ...(args.mock === true ? ['--mock'] : [])], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: coreTokens.system },
  });
  children.push(core);
  const corePort = await portFrom(core, /api on 127\.0\.0\.1:(\d+)/);
  if (!corePort) { console.log('[studio] event core did not start; stopping'); await stopAll(); return 1; }

  // 2. host (optional). Config (exe, OBS runtime, data) comes from app/host/lib/config.mjs (env or host.local.json).
  // Devices stay off unless --allow-devices is given here; this launcher never opens a device by itself.
  let hostCfg = null;
  try { hostCfg = resolveHostConfig(typeof args['host-exe'] === 'string' ? { exe: args['host-exe'] } : {}); } catch { hostCfg = null; }
  // The day-2 host build lives in out/host/build-c while another host may hold out/host/build: use the newer exe
  // unless the user chose one (--host-exe, UJWALAM_HOST_EXE or UJWALAM_HOST_BUILD).
  if (hostCfg && typeof args['host-exe'] !== 'string' && !process.env.UJWALAM_HOST_EXE && !process.env.UJWALAM_HOST_BUILD) {
    const alt = path.join(REPO, 'out', 'host', 'build-c', 'ujwalam-host.exe');
    try { if (existsSync(alt) && (!existsSync(hostCfg.exe) || statSync(alt).mtimeMs > statSync(hostCfg.exe).mtimeMs)) hostCfg.exe = alt; } catch { /* keep the default */ }
  }
  const hostExe = hostCfg?.exe;
  const hostDiscovery = path.join(dataDir, 'host.json');
  if (args['fake-host'] !== true && hostExe && existsSync(hostExe) && hostCfg.runtime) {
    const spec = hostLaunchSpec({ hostCfg, hostDiscovery, args, alpha, corePort, coreApiToken: coreTokens.api });
    for (const n of spec.notes) console.log(`[studio] WARNING: ${n}`);
    const hostArgs = spec.argv;
    if (typeof args.outputs === 'string') {
      // An O1 plan file (app/host/outputs/*.json): validated against data/platforms, configured at host start, nothing started.
      const { planFile } = await import('../../app/host/lib/outputs-plan.mjs');
      const { params, report } = planFile(path.resolve(args.outputs));
      for (const w of report.warnings) console.log(`[studio] outputs plan warning: ${w.code}`);
      const f = path.join(hostCfg.dataDir, 'outputs-params.json');
      mkdirSync(hostCfg.dataDir, { recursive: true });
      writeFileSync(f, JSON.stringify(params, null, 2));
      hostArgs.push('--outputs', f);
    }
    removeStaleDiscovery(hostDiscovery);
    const hostLog = openHostLog(path.join(dataDir, 'logs'));
    const script = /\.m?js$/i.test(hostExe);
    hostChild = spawn(script ? process.execPath : hostExe, script ? [hostExe, ...hostArgs] : hostArgs, {
      stdio: ['ignore', hostLog.fd, hostLog.fd],
      env: { ...process.env, ...spec.env, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_DISCOVERY: hostDiscovery },
    });
    closeSync(hostLog.fd); // the child holds its own handle
    children.push(hostChild);
    hostDiscoveryFile = hostDiscovery;
    console.log(`[studio] host log: ${hostLog.file}`);
    // The UI server and the browser start only after the host has written its discovery file (up to 60 s), so the page never meets the fake backend first.
    const disc = await waitForDiscovery(hostDiscovery, hostChild);
    console.log(`[studio] libobs host ${disc ? 'started' : 'NOT ready (see the host log)'}${args['allow-devices'] === true ? ' (devices ALLOWED)' : ' (devices off)'}${alpha ? ', previews H and V' : ''}`);
    if (alpha) {
      if (!disc) { console.log('[studio] alpha: the host is not ready; stopping'); await stopAll(); return 1; }
      try {
        alphaClient = new HostClient({ port: disc.port, token: hostToken });
        await alphaProject({ client: alphaClient, dataDir, args, hostCfg });
      } catch (e) {
        console.log(`[studio] alpha project failed: ${e.message}`);
        for (const x of (e.errors ?? e.details ?? []).slice(0, 10)) console.log(`[studio]   ${x.path ?? ''} ${x.message ?? x}`);
        await stopAll();
        return 1;
      }
    }
  } else {
    console.log('[studio] BLOCKED-ON-HOST: no libobs host executable (build it with node app/host/tools/build.mjs, or set UJWALAM_HOST_EXE / --host-exe); the UI uses its fake backend');
    if (alpha) { console.log('[studio] alpha needs the libobs host; stopping'); await stopAll(); return 1; }
  }

  // 3. UI server
  const uiArgs = [path.join(REPO, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--data-dir', dataDir];
  if (typeof args['ui-port'] === 'string') uiArgs.push('--port', args['ui-port']);
  if (args['fake-host'] === true) uiArgs.push('--fake-host');
  const ui = spawn(process.execPath, uiArgs, {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, UJWALAM_UI_LAUNCH_KEY: launchKey, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_EVENT_CORE_PORT: String(corePort), UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: '' },
  });
  children.push(ui);
  const uiPort = await portFrom(ui, /listening on http:\/\/127\.0\.0\.1:(\d+)\//);
  if (!uiPort) { console.log('[studio] UI server did not start; stopping'); await stopAll(); return 1; }

  console.log(`[studio] UI at http://127.0.0.1:${uiPort}/ (the login key is one-time and not printed). Ctrl-C stops everything.`);
  if (args['no-open'] !== true) openBrowser(`http://127.0.0.1:${uiPort}/login?k=${launchKey}`);
  if (alphaClient) {
    // One line that answers "are the overlays fed?": bridge counters 10 s after start (counts only, never text).
    // UJWALAM_ALPHA_STATS_MS shortens the wait for tests.
    const statsMs = Number(process.env.UJWALAM_ALPHA_STATS_MS ?? 10_000);
    setTimeout(async () => {
      try {
        const s = await alphaClient.call('overlay.stats');
        console.log(`[studio] overlay feed after ${Math.round(statsMs / 1000)} s: ${s.clients ?? 0} overlay page(s) connected, ${s.chatFrames ?? 0} chat and ${s.busFrames ?? 0} event frame(s) delivered, ${s.effects ?? 0} effect(s)`);
      } catch (e) { console.log(`[studio] overlay feed stats unavailable: ${e.message}`); }
    }, statsMs).unref();
  }
  if (args['stop-on-stdin'] === true) {
    // Clean stop for scripts and tests: closing stdin (or any input) ends the session; Ctrl-C does not reach a child on Windows.
    process.stdin.resume();
    process.stdin.once('data', () => { stopAll().then(() => process.exit(0)); });
    process.stdin.once('end', () => { stopAll().then(() => process.exit(0)); });
  }
  await new Promise((resolve) => { core.once('exit', resolve); ui.once('exit', resolve); });
  await stopAll();
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('launch.mjs') && process.argv[1].includes('studio-ui')) process.exit(await main());
