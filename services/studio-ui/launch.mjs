// SPDX-License-Identifier: GPL-2.0-or-later
// One-command launcher: event core, libobs host (when present) and the studio UI server, then the browser.
// Usage: node services/studio-ui/launch.mjs [--data-dir DIR] [--mock] [--no-open] [--host-exe PATH] [--fake-host] [--allow-devices] [--outputs PLAN.json] [--stop-on-stdin] [--ui-port N]
//                                           [--alpha [--rebuild-alpha] [--profile FILE] [--live] [--feedback-dir DIR]
//                                                    [--hotkey-panic C] [--hotkey-feedback C] [--hotkey-marker C]]
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
//
// Alpha 0 day 2 wiring (D152 host config): at every alpha start the launcher writes <data dir>/host-config.json
// (owner-only, atomic; edits are overwritten) with hotkeys on (Ctrl+Alt+P/F/M), replay autostart 30 s, feedbackDir
// = --feedback-dir (default <repo>/feedback, the same folder the UI server's feedback form reads) and
// eventCore.systemFile = <data dir>/system.json (written by the event core), and passes --host-config. The event-core
// system token goes to the host by environment only (UJWALAM_EVENT_CORE_SYSTEM_TOKEN; the host reads it, removes it
// from its environment and uses it only for panic's actions.panic). --hotkey-panic / --hotkey-feedback /
// --hotkey-marker COMBO|off replace a default combo (e.g. when another program already holds Ctrl+Alt+M).
// --live (alpha only): configure the real-output plan data/outputs/alpha-live.json and start the host with
// --allow-live. Without it no real target is configured (an --outputs plan with real targets is refused). Nothing
// starts streaming at launch: the control page's typed "yes, on air" stays the start gate. At start the launcher
// prints per sink keyPresent / urlPresent from outputs.status (never a key or URL), the hotkeys and the replay state.
// Private test stream options (all need --alpha --live):
//   --sinks youtube-h,youtube-v,twitch[,kick]  which REAL sinks of the plan are configured (default: all of them);
//       the recording always stays. A rung left without sinks is not created.
//   --twitch-bandwidth-test  the host runs with --twitch-bandwidth-test: twitch sinks connect with
//       "?bandwidthtest=true" appended to the stored key at connect time (never stored, never printed). The launcher
//       stops (exit 1) unless outputs.status shows bandwidthTest true on every twitch sink.
//   --test-stream-minutes N [--test-sink-minutes id=M,...]  arms the live-test guard (live-guard.mjs, budget
//       data/outputs/guard/live-test-budget.json). The guard never starts anything: it waits for the first stream started
//       from the control page ("yes, on air"), then stops ALL outputs after N minutes (exit 0) or at once when a
//       destination fails or drops frames past the budget (exit 4), writes <data dir>/logs/live-test-<stamp>.json
//       and .txt (no keys, URLs or error text) and ends the session. id=M stops only that sink after M minutes.
// UJWALAM_ALPHA_FEEDBACK_PROBE=1 (tests and evidence; only with --no-open): after start the launcher calls
// feedback.capture once, waits for its replay saves, logs in to its own UI server with the unused one-time key and
// prints whether the feedback form lists the moment.
//
// Crash recovery (Alpha 0 day 3): after the host has started, an exit the launcher did not ask for (a non-zero exit
// code; code 0 means the host shut itself down and ends the session) restarts it with the same argv and environment
// after a bounded backoff (2 s, 5 s, 10 s), at most HOST_RESTART_MAX times in HOST_RESTART_WINDOW_MS; one more exit
// in that window stops everything (exit code 3), writes a diagnostics bundle to <data dir>/diag/ and reports it.
// After a restart: the alpha project is loaded again (unchanged file), a recording that was running (record sinks
// seen starting/live/retrying by the outputs.status poll, every UJWALAM_HOST_WATCH_MS, default 2000) is started again
// (a new .mkv file; the old one stays playable, mkv is crash-safe), streams are NOT restarted (they need "yes, on
// air" on the control page) and a marker (source api) records the restart. Every exit is a line in
// <data dir>/logs/host-crashes.jsonl; <data dir>/logs/host-snapshot.json holds host.info / host.status / outputs
// presence flags for the diagnostics bundle (tools/diag/bundle.mjs). UJWALAM_HOST_RESTART_BACKOFF_MS overrides the
// backoff (tests).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';
import { loadFileIntoHost } from '../../app/host/lib/project.mjs';
import { SYSTEM_FILE, writeSecretFileAtomic } from '../event-core/api/discovery.mjs';
import { resolveDataDir } from '../event-core/config.mjs';
import { loadDevicePresets, matchRoles, overrideProblems } from '../project/device-roles.mjs';
import { loadProject } from '../project/store.mjs';
import { alphaBases, buildAlphaProject, prepareAlphaProject, readProfile, stampOf } from './alpha.mjs';
import { rpc } from './backends.mjs';
import { collectDiag, CRASH_LOG_FILE, outputsSafe, SNAPSHOT_FILE } from '../../tools/diag/bundle.mjs';
import { writeZip } from '../../tools/package/zip.mjs';
import { GUARD_ABORT_EXIT, LIVE_TEST_BUDGET, loadBudget, MAX_TEST_MINUTES, parseMinutes, parseSinkMinutes, runGuard } from './live-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (n) => randomBytes(n).toString('hex');
export const HOST_LOGS_KEPT = 10;
export const HOST_CONFIG_FILE = 'host-config.json';
export const ALPHA_LIVE_PLAN = path.join(REPO, 'data', 'outputs', 'alpha-live.json');
export const DEFAULT_FEEDBACK_DIR = path.join(REPO, 'feedback');
export const ALPHA_REPLAY_SECONDS = 30;
const HEX64 = /^[0-9a-f]{64}$/;

export const HOST_RESTART_MAX = 3;
export const HOST_RESTART_WINDOW_MS = 5 * 60_000;
export const HOST_RESTART_BACKOFF_MS = Object.freeze([2000, 5000, 10_000]);
const ACTIVE_STATES = new Set(['starting', 'live', 'retrying']);

/** Restart decisions for unexpected host exits (pure; tested with a fake clock). */
export function restartPolicy({ max = HOST_RESTART_MAX, windowMs = HOST_RESTART_WINDOW_MS, backoffMs = HOST_RESTART_BACKOFF_MS } = {}) {
  const exits = [];
  return {
    onExit(now) {
      exits.push(now);
      while (exits.length && now - exits[0] > windowMs) exits.shift();
      if (exits.length > max) return { restart: false, exits: exits.length, max, windowMs };
      return { restart: true, attempt: exits.length, max, delayMs: backoffMs[Math.min(exits.length - 1, backoffMs.length - 1)] };
    },
  };
}

/** Sink ids of one kind ('record' | 'stream') that were running in an outputs.status result (pure; tested). */
export function activeSinks(outputs, kind) {
  return (Array.isArray(outputs?.sinks) ? outputs.sinks : []).filter((s) => s.kind === kind && ACTIVE_STATES.has(s.state)).map((s) => s.id).filter((id) => typeof id === 'string');
}

const exitText = (code, signal) => (signal ? `signal ${signal}` : `code ${code}${code > 255 ? ` (0x${(code >>> 0).toString(16).toUpperCase()})` : ''}`);

export const HOTKEY_NAMES = Object.freeze(['panic', 'feedback', 'marker']);
// "Ctrl+Alt+Shift+M", "Ctrl+Alt+F9" or "off". The host checks the combo itself when it registers it (a bad one is
// reported, not fatal); this only keeps argv text out of the file that is not a combo.
const COMBO = /^(?:off|[A-Za-z0-9]{1,8}(?:\+[A-Za-z0-9]{1,8}){0,4})$/;

/** --hotkey-<name> COMBO|off from launcher args -> { overrides, problems } (pure; tested). */
export function hotkeyOverrides(args) {
  const overrides = {};
  const problems = [];
  for (const n of HOTKEY_NAMES) {
    const v = args[`hotkey-${n}`];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 40 || !COMBO.test(v)) { problems.push(`--hotkey-${n} needs a combo like Ctrl+Alt+Shift+M, or off`); continue; }
    overrides[n] = v === 'off' ? null : v;
  }
  return { overrides, problems };
}

/** The alpha host config (keys of app/host/src/host_config.cpp; pure; tested). Combos: host defaults unless overridden. */
export function alphaHostConfig({ dataDir, feedbackDir = DEFAULT_FEEDBACK_DIR, hotkeys = {} }) {
  return {
    $comment: 'Written by services/studio-ui/launch.mjs --alpha at every start (edits are overwritten; use --hotkey-panic/--hotkey-feedback/--hotkey-marker). Host defaults: panic Ctrl+Alt+P, feedback Ctrl+Alt+F, marker Ctrl+Alt+Shift+M.',
    replay: { seconds: ALPHA_REPLAY_SECONDS, autoStart: true },
    hotkeys: { enabled: true, ...hotkeys },
    feedbackDir: path.resolve(feedbackDir),
    eventCore: { systemFile: path.join(path.resolve(dataDir), SYSTEM_FILE) },
  };
}

/** Writes <dataDir>/host-config.json atomically and owner-only (fails closed when it cannot protect it). */
export function writeHostConfig(dataDir, cfg) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, HOST_CONFIG_FILE);
  writeSecretFileAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); out[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; }
  }
  return out;
}

// UJWALAM_HEADLESS=1 (every test run, D191): no preview windows (the host gets the same variable and refuses them)
// and no browser window; the control page URL is printed only.
export const isHeadless = () => process.env.UJWALAM_HEADLESS === '1';

// UJWALAM_BROWSER (an executable) and UJWALAM_BROWSER_ARGS (space separated flags) pick the browser; used by the UI tests.
function openBrowser(url) {
  const opts = { stdio: 'ignore', detached: true, windowsHide: true };
  if (process.env.UJWALAM_BROWSER) {
    spawn(process.env.UJWALAM_BROWSER, [...(process.env.UJWALAM_BROWSER_ARGS ?? '').split(' ').filter(Boolean), url], { ...opts, windowsHide: true }).unref();
    return;
  }
  if (process.platform === 'win32') spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'start', '""', url], { ...opts, windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { ...opts, windowsHide: true }).unref();
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
export function hostLaunchSpec({ hostCfg, hostDiscovery, args, alpha = false, corePort, coreApiToken, hostConfigFile, coreSystemToken, headless = isHeadless() }) {
  const argv = ['--runtime', hostCfg.runtime, '--data-dir', hostCfg.dataDir, '--discovery', hostDiscovery, '--recordings', hostCfg.recordings];
  const env = {};
  const notes = [];
  // The test card (H + V canvases) also starts the alpha host: --preview opens its windows at start, before the
  // project v1 load (project.load only), and a V preview needs a V canvas to exist (first alpha run: "canvas V does
  // not exist"). The previews look their canvas up by name every frame, so they show the alpha project after the load.
  argv.push('--project', path.join(REPO, 'app', 'host', 'projects', 'test-card.project.json'));
  if (args['allow-devices'] === true) argv.push('--allow-devices');
  if (alpha) {
    if (headless) notes.push('headless (UJWALAM_HEADLESS=1): no preview windows');
    else argv.push('--preview', 'h,v');
    if (hostCfg.overlayRoot && existsSync(hostCfg.overlayRoot)) {
      argv.push('--allow-browser', '--overlay-root', hostCfg.overlayRoot, '--overlay-script', hostCfg.overlayScript, '--node', process.execPath);
      if (Number.isInteger(corePort) && corePort > 0 && /^[0-9a-f]{64}$/.test(coreApiToken ?? '')) {
        argv.push('--overlay-events-url', `http://127.0.0.1:${corePort}/events`);
        env.UJWALAM_EVENT_CORE_API_TOKEN = coreApiToken;
      } else notes.push('no event core port or token: overlays get no Streamer.bot events');
    } else {
      notes.push('overlay root not found (UJWALAM_OVERLAY_ROOT or "overlayRoot" in app/host/host.local.json): overlays are off');
    }
    // Day 2: hotkeys, replay, feedback folder and event-core system file come from the host config; the system
    // token (panic's actions.panic) goes by environment only.
    if (typeof hostConfigFile === 'string' && path.isAbsolute(hostConfigFile)) argv.push('--host-config', hostConfigFile);
    else notes.push('no host config: hotkeys and the replay buffer stay off');
    if (HEX64.test(coreSystemToken ?? '')) env.UJWALAM_EVENT_CORE_SYSTEM_TOKEN = coreSystemToken;
    else notes.push('no event-core system token: panic cannot tell the event core');
    if (args.live === true) argv.push('--allow-live');
    if (args.live === true && args['twitch-bandwidth-test'] === true) argv.push('--twitch-bandwidth-test');
  }
  return { argv, env, notes };
}

/**
 * Private test stream options (pure apart from reading the budget file; tested): --sinks, --twitch-bandwidth-test,
 * --test-stream-minutes, --test-sink-minutes. Returns { problems, select, bandwidthTest, minutes, sinkMinutes, budget }.
 */
export function liveTestOptions(args, { alpha = args.alpha === true, budgetFile = LIVE_TEST_BUDGET } = {}) {
  const problems = [];
  const out = { problems, select: undefined, bandwidthTest: args['twitch-bandwidth-test'] === true, minutes: null, sinkMinutes: {}, budget: null };
  const given = ['sinks', 'twitch-bandwidth-test', 'test-stream-minutes', 'test-sink-minutes'].filter((k) => args[k] !== undefined);
  if (!given.length) return out;
  if (!alpha || args.live !== true) { problems.push(`--${given.join(', --')} need --alpha --live`); return out; }
  if (args.sinks !== undefined) {
    const ids = typeof args.sinks === 'string' ? args.sinks.split(',').map((x) => x.trim()) : [];
    if (!ids.length || ids.some((x) => !/^[a-z0-9-]{1,32}$/.test(x))) problems.push('--sinks needs a comma-separated list of sink ids (e.g. youtube-h,youtube-v,twitch)');
    else out.select = ids;
  }
  if (args['twitch-bandwidth-test'] !== undefined && args['twitch-bandwidth-test'] !== true) problems.push('--twitch-bandwidth-test takes no value');
  if (args['test-stream-minutes'] !== undefined) {
    out.minutes = parseMinutes(args['test-stream-minutes']);
    if (out.minutes === null) problems.push(`--test-stream-minutes needs minutes (0 < N <= ${MAX_TEST_MINUTES})`);
  }
  if (args['test-sink-minutes'] !== undefined) {
    if (args['test-stream-minutes'] === undefined) problems.push('--test-sink-minutes needs --test-stream-minutes');
    try { out.sinkMinutes = parseSinkMinutes(args['test-sink-minutes']); } catch (e) { problems.push(e.message); }
  }
  if (out.minutes !== null) {
    try { out.budget = loadBudget(budgetFile); } catch (e) { problems.push(`live-test budget ${budgetFile}: ${e.message}`); }
  }
  return out;
}

/** Checks a configured plan against the live-test options (twitch present for the bandwidth test, sink limits name sinks). */
export function liveTestPlanProblems(opts, sinks) {
  const problems = [];
  const streams = sinks.filter((s) => s.target?.transport !== 'file');
  if (opts.bandwidthTest && !streams.some((s) => s.platform === 'twitch')) problems.push('--twitch-bandwidth-test: no twitch sink is configured (check --sinks)');
  for (const id of Object.keys(opts.sinkMinutes)) {
    if (!sinks.some((s) => s.id === id)) problems.push(`--test-sink-minutes: "${id}" is not a configured sink`);
  }
  return problems;
}

/** After the host configured the plan: every twitch stream sink must report bandwidthTest true (fail closed). */
export function bandwidthTestProblems(outputs) {
  const problems = [];
  if (outputs?.twitchBandwidthTest !== true) problems.push('the host does not report twitchBandwidthTest (old host build?)');
  const tw = (Array.isArray(outputs?.sinks) ? outputs.sinks : []).filter((s) => s.kind === 'stream' && s.platform === 'twitch');
  if (!tw.length) problems.push('no twitch sink in outputs.status');
  for (const s of tw) if (s.bandwidthTest !== true) problems.push(`twitch sink ${s.id} is not in bandwidth-test mode`);
  return problems;
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
  // A preview that did not open at start (e.g. closed by hand on a reused host) is opened now. The host opens previews
  // only on a second display and never takes focus (D191); with one display it refuses and this says why.
  if (!isHeadless()) {
    let open = new Set();
    try { open = new Set(((await client.call('preview.list')).previews ?? []).filter((p) => p.open === true).map((p) => String(p.canvas).toUpperCase())); } catch { /* listed below per canvas */ }
    for (const c of ['H', 'V']) {
      if (open.has(c)) continue;
      try { const w = await client.call('preview.open', { canvas: c }); console.log(`[studio] preview ${c} opened after the load on the ${w.display ?? 'second display'}`); } catch (e) { console.log(`[studio] preview ${c} not shown: ${e.message}`); }
    }
  }
  try {
    const st = await client.call('overlay.status');
    console.log(`[studio] overlay server: ${st.state ?? 'unknown'}; event feed: ${st.eventFeed === true ? 'on' : 'off'}; child has the event token: ${st.childHasEventToken === true ? 'yes' : 'no'}; browser layers ${st.browserAllowed ? 'allowed' : 'off'}`);
  } catch (e) { console.log(`[studio] overlay status unavailable: ${e.message}`); }
  return r;
}

const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : '-');

// One block at start: outputs (per sink keyPresent / urlPresent, never a key or URL), hotkeys, replay buffer.
async function alphaStatus(client) {
  try {
    const o = await client.call('outputs.status');
    const sinks = Array.isArray(o.sinks) ? o.sinks : [];
    console.log(`[studio] outputs: real targets ${o.allowLive === true ? 'ALLOWED (--live)' : 'off'}; ${sinks.length} sink(s)${sinks.length ? '' : ' (no plan; real targets need --live)'}`);
    for (const s of sinks) {
      if (s.kind === 'stream') {
        console.log(`[studio]   sink ${s.id}: ${s.platform} ${s.target ?? ''}, keyPresent ${yn(s.keyPresent)}${Object.hasOwn(s, 'urlPresent') ? `, urlPresent ${yn(s.urlPresent)}` : ''}${s.bandwidthTest === true ? ', TWITCH BANDWIDTH TEST (not broadcast)' : ''}, ${s.state}`);
      } else console.log(`[studio]   sink ${s.id}: ${s.kind} ${s.container ?? ''}, ${s.state}`);
    }
  } catch (e) { console.log(`[studio] outputs status unavailable: ${e.message}`); }
  try {
    const h = await client.call('hotkeys.status');
    const b = (h.bindings ?? []).map((x) => `${x.name} ${x.combo ?? '(unbound)'} ${x.registered ? 'registered' : `NOT registered${x.error ? ` (${x.error})` : ''}`}`);
    console.log(`[studio] hotkeys: ${h.enabled === true ? 'on' : 'off'}; ${b.join('; ')}`);
  } catch (e) { console.log(`[studio] hotkeys status unavailable: ${e.message}`); }
  try {
    const r = await client.call('replay.status');
    const c = (r.canvases ?? []).map((x) => `${x.canvas} ${x.state}${x.fallback ? ' (fallback rung)' : x.rung ? ` (rung ${x.rung})` : ''}`);
    console.log(`[studio] replay buffer: ${r.wanted === true ? 'on' : 'off'}, ${r.seconds ?? '?'} s; ${c.join('; ')}`);
  } catch (e) { console.log(`[studio] replay status unavailable: ${e.message}`); }
}

function httpGet(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// UJWALAM_ALPHA_FEEDBACK_PROBE=1: one feedback.capture (the same handler as the Ctrl+Alt+F hotkey, trigger "api"),
// then the UI server's feedback list. The one-time launch key is used here, so this runs only with --no-open.
// UJWALAM_ALPHA_FEEDBACK_PROBE_WAIT_MS (default 5000) lets the replay buffer (restarted empty by the project load) fill first.
async function feedbackProbe({ client, uiPort, launchKey }) {
  const waitMs = Number(process.env.UJWALAM_ALPHA_FEEDBACK_PROBE_WAIT_MS ?? 5000);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)));
  const cap = await client.call('feedback.capture', { note: 'launcher feedback probe' });
  const t0 = Date.now();
  for (;;) {
    const st = await client.call('feedback.status');
    if ((st.queued ?? 0) === 0 && (st.busy ?? 0) === 0) break;
    if (Date.now() - t0 > 30_000) { console.log('[studio] feedback probe: replay saves still running after 30 s'); break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  const id = String(cap.dir).split(/[\\/]/).slice(-2).join('/');
  let replay = 'unknown';
  try {
    const m = JSON.parse(readFileSync(path.join(cap.dir, 'moment.json'), 'utf8'));
    replay = m.replay?.state === 'done' ? `${(m.replay.saved ?? []).map((s) => s.file).join(', ') || 'none'}${m.replay.errors?.length ? `; ${m.replay.errors.length} error(s)` : ''}` : String(m.replay?.state);
  } catch { /* reported as unknown */ }
  const login = await httpGet(uiPort, `/login?k=${launchKey}`);
  const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0];
  const list = await httpGet(uiPort, '/ui/api/feedback', { cookie });
  const moments = list.status === 200 ? (JSON.parse(list.body).moments ?? []) : [];
  const m = moments.find((x) => x.id === id);
  console.log(`[studio] feedback probe: moment ${id} ${m ? 'listed' : 'NOT listed'} by the UI server (${moments.length} moment(s), HTTP ${list.status}); replay files: ${replay}; scene: ${m?.scene ?? '-'}; at: ${m?.timestamp ?? '-'}`);
}

/** <logsDir>/host-snapshot.json: host.info, host.status and outputs presence flags (no secrets; for diagnostics). */
async function writeSnapshot(client, logsDir) {
  const snap = { v: 1, at: new Date().toISOString() };
  for (const [k, m] of [['info', 'host.info'], ['status', 'host.status'], ['outputs', 'outputs.status']]) {
    try { snap[k] = await client.call(m); } catch (e) { snap[k] = { error: e.message }; }
  }
  if (snap.outputs && !snap.outputs.error) snap.outputs = outputsSafe(snap.outputs);
  try {
    mkdirSync(logsDir, { recursive: true });
    const f = path.join(logsDir, SNAPSHOT_FILE);
    writeFileSync(`${f}.partial`, `${JSON.stringify(snap, null, 2)}\n`);
    renameSync(`${f}.partial`, f);
  } catch { /* diagnostics only */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Crash recovery (see the header). Arms an exit handler on the running host child and on every restarted one.
function superviseHost(o) {
  const { logsDir, dataDir, hostCfg, args, alpha, hostToken, hostDiscovery, spawnHost, getChild, isStopping, onClient, endSession } = o;
  const backoffEnv = Number(process.env.UJWALAM_HOST_RESTART_BACKOFF_MS);
  const policy = restartPolicy(Number.isFinite(backoffEnv) && backoffEnv >= 0 ? { backoffMs: [backoffEnv] } : {});
  const watchMs = Math.max(100, Number(process.env.UJWALAM_HOST_WATCH_MS ?? 2000) || 2000);
  let client = o.initialClient;
  let lastOutputs = null;
  let busy = false;
  const crashLog = (rec) => {
    try { mkdirSync(logsDir, { recursive: true }); appendFileSync(path.join(logsDir, CRASH_LOG_FILE), `${JSON.stringify(rec)}\n`); } catch { /* best effort */ }
  };
  const readOutputs = async () => {
    if (busy || isStopping()) return;
    try { lastOutputs = await client.call('outputs.status'); } catch { /* host gone or busy: keep the last answer */ }
  };
  const poll = setInterval(readOutputs, watchMs);
  poll.unref();
  // Read once now: a host that exits before the first interval must still restart its recording / report its streams.
  void readOutputs();
  writeSnapshot(client, logsDir);

  const arm = (child) => child.once('exit', (code, signal) => { onExit(child, code, signal).catch((e) => console.log(`[studio] crash recovery failed: ${e.message}`)); });
  async function onExit(child, code, signal) {
    if (isStopping() || child !== getChild()) return;
    busy = true;
    const at = new Date();
    const recording = activeSinks(lastOutputs, 'record');
    const streams = activeSinks(lastOutputs, 'stream');
    const base = { at: at.toISOString(), exit: exitText(code, signal), recording, streams };
    if (code === 0 && !signal) {
      console.log('[studio] the host shut itself down (code 0): ending the session');
      crashLog({ ...base, action: 'session-ended' });
      clearInterval(poll);
      endSession(0);
      return;
    }
    const d = policy.onExit(at.getTime());
    if (!d.restart) {
      crashLog({ ...base, action: 'gave-up', exits: d.exits });
      clearInterval(poll);
      let diag = null;
      try {
        const files = await collectDiag({ dataDir, hostData: hostCfg.dataDir, profile: typeof args.profile === 'string' ? path.resolve(args.profile) : path.join(REPO, 'data', 'profile.local.json'), release: path.join(REPO, 'release.json') });
        mkdirSync(path.join(dataDir, 'diag'), { recursive: true });
        diag = path.join(dataDir, 'diag', `ujwalam-diag-${at.toISOString().replace(/[:.]/g, '-')}.zip`);
        writeZip(diag, files.map((f) => ({ name: f.name, data: f.data })), { mtime: at });
      } catch (e) { console.log(`[studio] diagnostics bundle failed: ${e.message}`); }
      console.log(`[studio] HOST CRASHED ${d.exits} times in ${Math.round(d.windowMs / 60000)} min (last exit ${base.exit}); not restarting again. Stopping. Crash log: ${path.join(logsDir, CRASH_LOG_FILE)}${diag ? `; diagnostics: ${diag}` : ''}`);
      endSession(3);
      return;
    }
    crashLog({ ...base, action: 'restart', attempt: d.attempt, delayMs: d.delayMs });
    console.log(`[studio] HOST EXITED UNEXPECTEDLY (${base.exit}); restart ${d.attempt} of ${d.max} in ${d.delayMs} ms${recording.length ? `; recording was on (${recording.join(', ')})` : ''}${streams.length ? `; streams were on (${streams.join(', ')})` : ''}`);
    await sleep(d.delayMs);
    if (isStopping()) return;
    const next = spawnHost();
    arm(next);
    const disc = await waitForDiscovery(hostDiscovery, next);
    if (!disc) {
      console.log('[studio] restarted host is not ready (see its log)');
      if (next.exitCode === null) { try { next.kill(); } catch { /* gone */ } } // its exit counts against the limit
      return;
    }
    client = new HostClient({ port: disc.port, token: hostToken });
    onClient(client);
    console.log(`[studio] host restarted (attempt ${d.attempt})`);
    try {
      if (alpha) await alphaProject({ client, dataDir, args, hostCfg });
    } catch (e) { console.log(`[studio] WARNING: project reload after the restart failed: ${e.message}`); }
    let resumed = [];
    if (recording.length) {
      try {
        await client.call('record.start', { sinks: recording });
        resumed = recording;
        console.log(`[studio] recording started again in a new file (${recording.join(', ')}); the file before the crash stays playable (mkv)`);
      } catch (e) { console.log(`[studio] WARNING: recording could not be started again: ${e.message}`); }
    }
    if (streams.length) console.log(`[studio] WARNING: streams ${streams.join(', ')} are NOT restarted automatically: start them from the control page ("yes, on air")`);
    const note = `host restarted after an unexpected exit (${base.exit}); restart ${d.attempt} of ${d.max}; recording resumed: ${resumed.join(', ') || 'none'}; streams to restart by hand: ${streams.join(', ') || 'none'}`;
    try { await client.call('marker.add', { source: 'api', note: note.slice(0, 500) }); } catch (e) { console.log(`[studio] WARNING: restart marker not written: ${e.message}`); }
    crashLog({ at: new Date().toISOString(), action: 'restarted', attempt: d.attempt, resumed, streams });
    if (alpha) await alphaStatus(client);
    await writeSnapshot(client, logsDir);
    busy = false;
  }
  arm(getChild());
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const alpha = args.alpha === true;
  let dataDir;
  try { dataDir = resolveDataDir({ dataDir: typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined }); } catch (e) { console.log(`[studio] ${e.message}`); return 1; }
  if (args.live === true && !alpha) { console.log('[studio] --live is for the alpha session only (npm run alpha -- --live)'); return 2; }
  if (args.live === true && typeof args.outputs === 'string') { console.log('[studio] --live uses data/outputs/alpha-live.json; do not also give --outputs'); return 2; }
  if (args['feedback-dir'] !== undefined && typeof args['feedback-dir'] !== 'string') { console.log('[studio] --feedback-dir needs a folder'); return 2; }
  const feedbackDir = typeof args['feedback-dir'] === 'string' ? path.resolve(args['feedback-dir']) : DEFAULT_FEEDBACK_DIR;
  const hk = hotkeyOverrides(args);
  if (hk.problems.length) { for (const p of hk.problems) console.log(`[studio] ${p}`); return 2; }
  const lt = liveTestOptions(args, { alpha });
  if (lt.problems.length) { for (const p of lt.problems) console.log(`[studio] ${p}`); return 2; }
  const probe = process.env.UJWALAM_ALPHA_FEEDBACK_PROBE === '1';
  if (probe && (!alpha || args['no-open'] !== true)) { console.log('[studio] UJWALAM_ALPHA_FEEDBACK_PROBE needs --alpha and --no-open'); return 2; }
  const children = [];
  let hostChild = null;
  let hostDiscoveryFile = null;
  let alphaClient = null;
  let stopping = false;
  let endSession = () => {};
  const sessionEnded = new Promise((resolve) => { endSession = resolve; });
  // Ask the host to exit cleanly first (it closes previews and removes its discovery file), then kill what is left.
  const stopAll = async () => {
    stopping = true;
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
    let hostConfigFile;
    if (alpha) {
      try {
        hostConfigFile = writeHostConfig(dataDir, alphaHostConfig({ dataDir, feedbackDir, hotkeys: hk.overrides }));
        console.log(`[studio] host config: ${hostConfigFile} (hotkeys on, replay ${ALPHA_REPLAY_SECONDS} s autostart, feedback folder ${feedbackDir})`);
      } catch (e) { console.log(`[studio] host config could not be written owner-only (${e.message}); stopping`); await stopAll(); return 1; }
    }
    const spec = hostLaunchSpec({ hostCfg, hostDiscovery, args, alpha, corePort, coreApiToken: coreTokens.api, hostConfigFile, coreSystemToken: coreTokens.system });
    for (const n of spec.notes) console.log(`[studio] WARNING: ${n}`);
    const hostArgs = spec.argv;
    const planPath = args.live === true ? ALPHA_LIVE_PLAN : typeof args.outputs === 'string' ? path.resolve(args.outputs) : null;
    if (planPath) {
      // An O1 plan file (app/host/outputs/*.json): validated against data/platforms, configured at host start, nothing
      // started. Real targets only with --live (alpha-live.json; the host then runs with --allow-live).
      const { planFile } = await import('../../app/host/lib/outputs-plan.mjs');
      let planned;
      try { planned = planFile(planPath, { allowLive: args.live === true, ...(lt.select ? { select: lt.select } : {}) }); } catch (e) { console.log(`[studio] outputs plan refused: ${e.message}`); await stopAll(); return 1; }
      const { params, report } = planned;
      const ltp = liveTestPlanProblems(lt, params.sinks);
      if (ltp.length) { for (const p of ltp) console.log(`[studio] ${p}`); await stopAll(); return 2; }
      if (lt.select) console.log(`[studio] LIVE sinks: ${params.sinks.map((s) => s.id).join(', ')} (--sinks)`);
      if (args.live === true) console.log(`[studio] LIVE plan: ${path.relative(REPO, planPath)} (real targets configured, nothing started; start from the control page with "yes, on air")`);
      for (const w of report.warnings) console.log(`[studio] outputs plan warning: ${w.code}`);
      const f = path.join(hostCfg.dataDir, 'outputs-params.json');
      mkdirSync(hostCfg.dataDir, { recursive: true });
      writeFileSync(f, JSON.stringify(params, null, 2));
      hostArgs.push('--outputs', f);
    }
    const logsDir = path.join(dataDir, 'logs');
    const script = /\.m?js$/i.test(hostExe);
    const spawnHost = () => {
      removeStaleDiscovery(hostDiscovery);
      const hostLog = openHostLog(logsDir);
      const child = spawn(script ? process.execPath : hostExe, script ? [hostExe, ...hostArgs] : hostArgs, {
        stdio: ['ignore', hostLog.fd, hostLog.fd],
        env: { ...process.env, ...spec.env, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_DISCOVERY: hostDiscovery },
        windowsHide: true,
      });
      closeSync(hostLog.fd); // the child holds its own handle
      const i = children.indexOf(hostChild);
      if (i >= 0) children.splice(i, 1);
      children.push(child);
      hostChild = child;
      console.log(`[studio] host log: ${hostLog.file}`);
      return child;
    };
    spawnHost();
    hostDiscoveryFile = hostDiscovery;
    // The UI server and the browser start only after the host has written its discovery file (up to 60 s), so the page never meets the fake backend first.
    const disc = await waitForDiscovery(hostDiscovery, hostChild);
    console.log(`[studio] libobs host ${disc ? 'started' : 'NOT ready (see the host log)'}${args['allow-devices'] === true ? ' (devices ALLOWED)' : ' (devices off)'}${alpha ? ', previews H and V' : ''}`);
    if (alpha) {
      if (!disc) { console.log('[studio] alpha: the host is not ready; stopping'); await stopAll(); return 1; }
      try {
        alphaClient = new HostClient({ port: disc.port, token: hostToken });
        await alphaProject({ client: alphaClient, dataDir, args, hostCfg });
        await alphaStatus(alphaClient);
        if (lt.bandwidthTest) {
          const bp = bandwidthTestProblems(await alphaClient.call('outputs.status'));
          if (bp.length) {
            for (const p of bp) console.log(`[studio] TWITCH BANDWIDTH TEST NOT ACTIVE: ${p}; stopping (nothing was started)`);
            await stopAll();
            return 1;
          }
          console.log('[studio] twitch bandwidth test: ON for every twitch sink (the stream is received by Twitch, not broadcast)');
        }
      } catch (e) {
        console.log(`[studio] alpha project failed: ${e.message}`);
        for (const x of (e.errors ?? e.details ?? []).slice(0, 10)) console.log(`[studio]   ${x.path ?? ''} ${x.message ?? x}`);
        await stopAll();
        return 1;
      }
    }
    if (disc) {
      superviseHost({
        logsDir, dataDir, hostCfg, args, alpha, hostToken, hostDiscovery, spawnHost,
        getChild: () => hostChild, isStopping: () => stopping,
        initialClient: alphaClient ?? new HostClient({ port: disc.port, token: hostToken }),
        onClient: (c) => { if (alpha) alphaClient = c; },
        endSession,
      });
    }
  } else {
    console.log('[studio] BLOCKED-ON-HOST: no libobs host executable (build it with node app/host/tools/build.mjs, or set UJWALAM_HOST_EXE / --host-exe); the UI uses its fake backend');
    if (alpha) { console.log('[studio] alpha needs the libobs host; stopping'); await stopAll(); return 1; }
  }

  // 3. UI server
  const uiArgs = [path.join(REPO, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--data-dir', dataDir, '--feedback-dir', feedbackDir];
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
  if (args['no-open'] !== true && !isHeadless()) openBrowser(`http://127.0.0.1:${uiPort}/login?k=${launchKey}`);
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
    if (probe) {
      try { await feedbackProbe({ client: alphaClient, uiPort, launchKey }); } catch (e) { console.log(`[studio] feedback probe failed: ${e.message}`); }
    }
    if (lt.minutes !== null) {
      // Live-test guard: never starts outputs; arms on the first stream started from the control page.
      runGuard({ getClient: () => alphaClient, budget: lt.budget, minutes: lt.minutes, sinkMinutes: lt.sinkMinutes, isCancelled: () => stopping, log: (l) => console.log(`[studio] ${l}`) })
        .then((r) => {
          if (!r) return;
          const stamp = stampOf(new Date());
          const logsDir = path.join(dataDir, 'logs');
          try {
            mkdirSync(logsDir, { recursive: true });
            writeFileSync(path.join(logsDir, `live-test-${stamp}.json`), `${JSON.stringify(r.report, null, 2)}\n`);
            writeFileSync(path.join(logsDir, `live-test-${stamp}.txt`), r.text);
            console.log(`[studio] live-test report: ${path.join(logsDir, `live-test-${stamp}.json`)} (and .txt)`);
          } catch (e) { console.log(`[studio] WARNING: live-test report not written: ${e.message}`); }
          for (const l of r.text.trimEnd().split('\n')) console.log(`[studio] ${l}`);
          endSession(r.code);
        })
        .catch((e) => { console.log(`[studio] live-test guard failed: ${e.message}; stopping all outputs`); alphaClient.call('outputs.stop', {}).catch(() => {}).finally(() => endSession(GUARD_ABORT_EXIT)); });
    }
  }
  if (args['stop-on-stdin'] === true) {
    // Clean stop for scripts and tests: closing stdin (or any input) ends the session; Ctrl-C does not reach a child on Windows.
    process.stdin.resume();
    process.stdin.once('data', () => { stopAll().then(() => process.exit(0)); });
    process.stdin.once('end', () => { stopAll().then(() => process.exit(0)); });
  }
  const code = await new Promise((resolve) => { core.once('exit', () => resolve(0)); ui.once('exit', () => resolve(0)); sessionEnded.then(resolve); });
  await stopAll();
  return code;
}

if (process.argv[1] && process.argv[1].endsWith('launch.mjs') && process.argv[1].includes('studio-ui')) process.exit(await main());
