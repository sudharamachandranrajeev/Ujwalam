// SPDX-License-Identifier: GPL-3.0-or-later
// One-command launcher: event core, libobs host (when present) and the studio UI server, then the browser.
// Usage: node services/studio-ui/launch.mjs [--data-dir DIR] [--mock] [--no-open] [--host-exe PATH] [--fake-host] [--allow-devices] [--outputs PLAN.json] [--stop-on-stdin] [--ui-port N]
//                                           [--alpha [--rebuild-alpha] [--profile FILE] [--live] [--feedback-dir DIR]
//                                                    [--hotkey-panic C] [--hotkey-feedback C] [--hotkey-marker C]]
//
// --shell qt|browser (P5a; qt is the default since D277): the Qt studio shell (out/studio/build/ujwalam-studio.exe,
// npm run build:studio) opens instead of the browser. It gets the UI URL and the one-time launch key by environment
// only (shellSpawnSpec), no host or event-core token. Closing its window does not stop the studio (a stream keeps
// running); Ctrl-C here stops everything. When the shell is not built the browser opens as before. --shell browser
// opens the web control page instead.
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
// starts streaming at launch: the user's Start stream click stays the start gate (D332). At start the launcher
// prints per sink keyPresent / urlPresent from outputs.status (never a key or URL), the hotkeys and the replay state.
// Private test stream options (all need --alpha --live):
//   --sinks youtube-h,youtube-v,twitch[,kick]  which REAL sinks of the plan are configured (default: all of them);
//       the recording always stays. A rung left without sinks is not created.
//   --twitch-bandwidth-test  the host runs with --twitch-bandwidth-test: twitch sinks connect with
//       "?bandwidthtest=true" appended to the stored key at connect time (never stored, never printed). The launcher
//       stops (exit 1) unless outputs.status shows bandwidthTest true on every twitch sink.
//   --test-stream-minutes N [--test-sink-minutes id=M,...]  arms the live-test guard (live-guard.mjs, budget
//       data/outputs/guard/live-test-budget.json). The guard never starts anything: it waits for the first stream started
//       by the user (Start stream), then stops ALL outputs after N minutes (exit 0) or at once when a
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
// (a new .mkv file; the old one stays playable, mkv is crash-safe) and a marker (source api) records the restart.
// Streams (D303 proposed, flag stream-recovery, off by default; stream-recovery.mjs): with the flag on, the stream
// sinks that were live before the crash are started again when this launcher's go-live authority is armed (it owns
// it in memory; the UI server arms it after a Start stream click and revokes it before Stop / End all, over
// the IPC channel), the restarted host is ready within maxGapMs of the crash and the recovery limit
// (data/live/recovery.json) is not reached; never a sink that was not live, never after Stop / End all, never after a
// launcher restart (a new launcher has a new, unarmed authority). The decision and the stream.start run in the
// authority's serialized section; a Stop that arrives meanwhile is answered after it, and the launcher stops the
// restarted sinks again. Every decision is logged, written to <data dir>/live/stream-recovery.json (shown on
// the control page) and to the marker. With the flag off streams are NOT restarted (start them by hand). Every exit is a line in
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
import { overlayRootProblem, resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';
import { loadFileIntoHost } from '../../app/host/lib/project.mjs';
import { SYSTEM_FILE, writeSecretFileAtomic } from '../event-core/api/discovery.mjs';
import { createBots, loadBotConfig } from '../bots/index.mjs';
import { resolveDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { loadDevicePresets, matchRoles, overrideProblems } from '../project/device-roles.mjs';
import { hudCoverage, loadHudZones } from '../project/hud-zones.mjs';
import { loadProject } from '../project/store.mjs';
import { alphaBases, alphaFile, buildAlphaProject, prepareAlphaProject, readProfile, stampOf, upgradePresets } from './alpha.mjs';
import { upgradeScenes } from '../project/scene-upgrades.mjs';
import { createRecordClips, isLive } from './record-clips.mjs';
import { killChildTree } from '../common/kill-tree.mjs';
import { createPostChain } from '../posting/auto-chain.mjs';
import { folderProblem, readSettings } from './user-settings.mjs';
import { createMediaInfo } from '../project/media-info.mjs';
import { rpc } from './backends.mjs';
import { collectDiag, CRASH_LOG_FILE, outputsSafe, SNAPSHOT_FILE } from '../../tools/diag/bundle.mjs';
import { writeZip } from '../../tools/package/zip.mjs';
import { createFront } from '../supervisor/front.mjs';
import { createEventCoreSlot, createUiSlot } from '../supervisor/slots.mjs';
import { refuseReason, SERVICES } from '../supervisor/swap.mjs';
import { EXE as STUDIO_EXE, qtDir as studioQtDir } from '../../app/studio/tools/build.mjs';
import { appendRecoveryEvent, createLiveAuthority, labelsOf, loadRecoveryConfig, recoveryPolicy, RECOVERY_FLAG, serveAuthority, SESSION_ENV, waitStreamsUp, writeAuthorityMirror } from './stream-recovery.mjs';
import { readSetup, setupProblems, writePlanFile } from './stream-setup.mjs';
import { botUrl, integrationsInEffect } from './integrations.mjs';
import { INTEGRATIONS_FLAG, STREAM_SETTINGS_FLAG } from './settings-routes.mjs';
import { GUARD_ABORT_EXIT, LIVE_TEST_BUDGET, loadBudget, MAX_TEST_MINUTES, parseMinutes, parseSinkMinutes, runGuard } from './live-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// LU3 service swap (D337): off by default; read once at start (the fronts must exist before the services start).
export const SERVICE_SWAP_FLAG = 'service-swap';
const hex = (n) => randomBytes(n).toString('hex');
export const HOST_LOGS_KEPT = 10;
export const HOST_CONFIG_FILE = 'host-config.json';
export const ALPHA_LIVE_PLAN = path.join(REPO, 'data', 'outputs', 'alpha-live.json');

/** The --live plan file (D327 OS1/OS2). With the `stream-settings` flag on and a saved Settings > Stream setup, the plan
 *  generated from it (<dataDir>/outputs/stream-setup-plan.json, recording "alpha.mkv" on the main H rung like
 *  alpha-live.json); otherwise alpha-live.json. A setup with problems throws (the start stops; the user fixes Settings). */
export function livePlanFile({ dataDir, streamSettingsOn }) {
  if (!streamSettingsOn) return ALPHA_LIVE_PLAN;
  const { exists, setup } = readSetup(dataDir);
  if (!exists) return ALPHA_LIVE_PLAN;
  const problems = setupProblems(setup);
  if (problems.length) throw new Error(`Settings > Stream has problems: ${problems.map((p) => p.message).join('; ')}`);
  return writePlanFile(dataDir, setup, { recordName: 'alpha.mkv' });
}
// The folder that holds services/clip and the Python venv (.venv-gpu or .venv): this tree, or for an installed run the
// clipRoot from ujwalam.json (UJWALAM_CLIP_ROOT; the zip ships no Python, D283).
export const CLIP_ROOT = process.env.UJWALAM_CLIP_ROOT || REPO;
// Record-only plan (H + V .mkv, no stream target): the alpha default when neither --live nor --outputs is given, so a
// normal start can record and clip (D281). Streaming still needs --live.
export const ALPHA_RECORD_PLAN = path.join(REPO, 'data', 'outputs', 'alpha-practice.json');
export const DEFAULT_FEEDBACK_DIR = path.join(REPO, 'feedback');
export const ALPHA_REPLAY_SECONDS = 60; // live clipping (D226): a kill chain plus preSec needs up to 55 s (data/clip/live-clips.json)
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

export const AUDIO_HEALTH_FILE = path.join(REPO, 'data', 'audio', 'health.json');
const AUDIO_HEALTH_KEYS = Object.freeze(['enabled', 'noDataMs', 'checkIntervalMs', 'maxRecreates', 'maxParked', 'shutdownGuardMs']);
/** data/audio/health.json -> the host config's audioHealth (D297 proposed). Range checks are the host's (exit 64). */
export function loadAudioHealth(file = AUDIO_HEALTH_FILE) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof d.source !== 'string' || !d.source) throw new Error('audio health: source is required');
  const out = {};
  for (const k of AUDIO_HEALTH_KEYS) {
    if (!Object.hasOwn(d, k)) throw new Error(`audio health: ${k} is required`);
    if (k === 'enabled' ? typeof d[k] !== 'boolean' : !Number.isInteger(d[k])) throw new Error(`audio health: bad ${k}`);
    out[k] = d[k];
  }
  return out;
}

/** The alpha host config (keys of app/host/src/host_config.cpp; pure; tested). Combos: host defaults unless overridden. */
export function alphaHostConfig({ dataDir, feedbackDir = DEFAULT_FEEDBACK_DIR, hotkeys = {}, monitoringOutput = null, audioHealth = loadAudioHealth() }) {
  return {
    $comment: 'Written by services/studio-ui/launch.mjs --alpha at every start (edits are overwritten; use --hotkey-panic/--hotkey-feedback/--hotkey-marker). Host defaults: panic Ctrl+Alt+P, feedback Ctrl+Alt+F, marker Ctrl+Alt+Shift+M.',
    replay: { seconds: ALPHA_REPLAY_SECONDS, autoStart: true },
    hotkeys: { enabled: true, ...hotkeys },
    feedbackDir: path.resolve(feedbackDir),
    eventCore: { systemFile: path.join(path.resolve(dataDir), SYSTEM_FILE) },
    // Low-latency audio buffering: what you hear in the headphones follows the game closely (OBS low-latency mode).
    audio: { lowLatency: true },
    // A device audio source that stops delivering (game audio lost 2026-11-08) is reported and restarted.
    audioHealth,
    // Headphones for monitored sources (profile devices.monitoringOutput.name); absent: the Windows default output.
    ...(typeof monitoringOutput === 'string' && monitoringOutput ? { monitoringDevice: monitoringOutput } : {}),
  };
}

/** Writes <dataDir>/host-config.json atomically and owner-only (fails closed when it cannot protect it). */
export function writeHostConfig(dataDir, cfg) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, HOST_CONFIG_FILE);
  writeSecretFileAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

/** Which window opens (D277): the Qt shell unless --shell browser. null for an unknown value. */
export function shellChoice(args) {
  const v = args.shell === undefined ? 'qt' : args.shell;
  return v === 'qt' || v === 'browser' ? v : null;
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
// Under UJWALAM_HEADLESS=1 only UJWALAM_BROWSER = this Node executable is honoured (a login script, never a browser).
export const headlessLoginScript = (env = process.env) => typeof env.UJWALAM_BROWSER === 'string'
  && path.resolve(env.UJWALAM_BROWSER).toLowerCase() === path.resolve(process.execPath).toLowerCase();
/** Event-core `serve` arguments. sbWs: loadBotConfig().streamerbot ({ ws, wsError }). With --mock no Streamer.bot is
 *  contacted, so no --url. A refused address (not ws://127.0.0.1) is never passed: the core keeps its default and a
 *  note says so. Returns { argv, note|null }. */
/** Environment for the event-core child. It gets the host MARKERS token (UJWALAM_HOST_MARKERS_TOKEN; the host lets
 *  it call marker.add and mixer.list only), never the full host token: UJWALAM_HOST_TOKEN,
 *  UJWALAM_HOST_SYSTEM_TOKEN and the live clipper's UJWALAM_HOST_CLIPS_TOKEN are removed even when the launcher's own
 *  environment has them. */
// Parent pipe (D234, services/common/parent-pipe.mjs): every long-running child gets stdin as a pipe from this
// launcher plus this marker. When the launcher dies, even by a hard kill that sends no signal on Windows, the pipes
// close and the children stop by themselves (the host only once no stream or recording runs) instead of being left
// as orphans holding devices and ports. Nothing is ever written to the pipes.
const PARENT_PIPE = Object.freeze({ UJWALAM_PARENT_PIPE: '1' });

export function coreEnv({ coreTokens, hostMarkersToken, base = process.env }) {
  const env = { ...base, UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: coreTokens.system, UJWALAM_HOST_MARKERS_TOKEN: hostMarkersToken };
  for (const k of Object.keys(env)) if (['UJWALAM_HOST_TOKEN', 'UJWALAM_HOST_SYSTEM_TOKEN', 'UJWALAM_HOST_CLIPS_TOKEN'].includes(k.toUpperCase())) delete env[k];
  return env;
}

/** Environment for the live clipper child (D226). It gets the host CLIPS token (UJWALAM_HOST_CLIPS_TOKEN; the host lets
 *  it call frames.grab, replay.save, replay.status, marker.add with source "clip" and host.status only) and the host
 *  discovery file (UJWALAM_HOST_DISCOVERY, for the port). Every other UJWALAM_*TOKEN* / *KEY* variable of the
 *  launcher's environment is removed (full host, host system, markers, event-core tokens, launch key). */
export function clipsEnv({ hostClipsToken, hostDiscovery, base = process.env }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^UJWALAM_.*(TOKEN|KEY)/i.test(k)) env[k] = v;
  return { ...env, UJWALAM_HOST_CLIPS_TOKEN: hostClipsToken, UJWALAM_HOST_DISCOVERY: hostDiscovery };
}

/** Variables the face AI worker may inherit (case-insensitive): what Windows, Python, onnxruntime-directml and
 *  OpenCV need to start, plus UJWALAM_HEADLESS. Everything else (tokens, keys, discovery path, PYTHON*, proxies, the
 *  user's own variables) is left out. */
export const FACE_ENV_ALLOW = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'UJWALAM_HEADLESS']);

/** Environment for the face AI worker (D295 proposed): an allowlist (FACE_ENV_ALLOW), never a host token, the link key
 *  or the discovery file (that file can hold host-generated tokens). The host pid and the link key reach the worker
 *  on its stdin pipe instead (faceControlLine). */
export function faceEnv({ base = process.env } = {}) {
  const allow = new Set(FACE_ENV_ALLOW);
  const env = {};
  for (const [k, v] of Object.entries(base)) if (allow.has(k.toUpperCase()) && typeof v === 'string') env[k] = v;
  return env;
}

/** One control line for the face worker's stdin: the host pid and the per-launch face link key (64 hex). The same key
 *  goes to the host by environment (UJWALAM_FACE_LINK_KEY); the worker uses a face link only when the key in its
 *  header matches. Written at the worker's start and again after every host restart. */
export function faceControlLine({ key, hostPid }) {
  if (!HEX64.test(key ?? '') || !Number.isInteger(hostPid) || hostPid <= 0) throw new Error('face control line: bad key or pid');
  return `${JSON.stringify({ key, hostPid })}\n`;
}

/** Face AI worker child (D295 proposed): services/face/face_worker.py on .venv-gpu (onnxruntime-directml), or null
 *  with the reason. It idles while the face-ai flag is off. */
export function faceSpec({ dataDir, repo = REPO, exists = existsSync }) {
  const py = path.join(repo, '.venv-gpu', 'Scripts', 'python.exe');
  if (!exists(py)) return { spec: null, reason: 'no .venv-gpu (onnxruntime-directml)' };
  return { spec: { exe: py, argv: ['-I', path.join(repo, 'services', 'face', 'face_worker.py'), '--data-dir', dataDir] } };
}

/** HUD safe-zone warnings (L12/L13, warn only): overlays above the game capture that cover the game's HUD
 *  (data/games/codm/hud-zones.json, unverified zones). Never throws; a missing file or project gives no warnings. */
export function hudWarnings(projectFile, game = 'codm') {
  try {
    const { project } = loadProject(projectFile);
    const zones = loadHudZones(game);
    const out = [];
    for (const s of project.scenes ?? []) {
      for (const [canvas, origin, canvasSize] of [['h', 'scene-default-h/game', { width: 1920, height: 1080 }], ['v', 'scene-default-v/game', { width: 1080, height: 1920 }]]) {
        for (const h of hudCoverage({ scene: s, canvas, gameOrigin: origin, zones, canvasSize })) {
          out.push(`${canvas.toUpperCase()} layer "${h.name}" covers ${Math.round(h.cover * 100)} % of the game's ${h.zone} area (HUD zones unverified)`);
        }
      }
    }
    return out;
  } catch { return []; }
}

/** Live clipper child (D226): the Python worker and its argv, or null with the reason. The worker reads the game
 *  layer of the H scene (preset origin scene-default-h/game, bound to a capture device); a placeholder game layer
 *  (devices off) has no picture to read. Python: .venv-gpu (DirectML OCR) when present, else .venv (CPU OCR).
 *  The reasons are plain words for the task panel and the readiness check (LC1). */
export const LIVE_WORKER = path.join('services', 'clip', 'live_worker.py');
export function liveClipsSpec({ project, dataDir, repo = REPO, exists = existsSync }) {
  const game = (project?.scenes ?? []).flatMap((s) => s.layers ?? []).find((l) => l.origin?.id === 'scene-default-h/game');
  if (!game) return { spec: null, reason: 'the main (H) scene has no game layer' };
  if (game.type !== 'capture') return { spec: null, reason: 'the game layer has no capture device (devices are off or none is chosen)' };
  const venv = ['.venv-gpu', '.venv'].map((v) => path.join(repo, v, 'Scripts', 'python.exe')).find((p) => exists(p));
  if (!venv) return { spec: null, reason: "the clip maker's Python is missing (no .venv-gpu or .venv)" };
  const worker = path.join(repo, LIVE_WORKER);
  if (!exists(worker)) return { spec: null, reason: 'the live clipper is missing (no services\\clip\\live_worker.py)' };
  return {
    spec: { exe: venv, gpu: venv.includes('.venv-gpu'), argv: [worker, '--layer', game.id, '--data-dir', dataDir] },
    reason: null,
  };
}

/** Restarts of a crashed live clipper before the launcher gives up (D226). */
export const LIVE_CLIPPER_MAX_RESTARTS = 5;

/** The live clipper's state after its process exited: { view, restart } (pure). restart = schedule one more start.
 *  "gave-up" only when every allowed restart was used and the last restarted process also stopped; while a restart is
 *  scheduled (the last one included) the state is "restarting" (Codex review of LC1). */
export function clipperExited(view, code, max = LIVE_CLIPPER_MAX_RESTARTS) {
  if (view.restarts >= max) {
    return { restart: false, view: { ...view, state: 'gave-up', reason: `it stopped (exit ${code}) and was restarted ${max} times; restart Ujwalam to try again` } };
  }
  return { restart: true, view: { ...view, state: 'restarting', restarts: view.restarts + 1, reason: `it stopped (exit ${code}); restarting in 10 s` } };
}

export function coreServeArgs({ dataDir, mock = false, sbWs = {}, remote = null }) {
  const argv = ['serve', '--data-dir', dataDir];
  // D327 IN1 "Allow remote connections": the LAN listener (the pairing token goes by environment, never argv).
  if (remote) argv.push('--lan', ...(typeof remote.address === 'string' ? ['--lan-address', remote.address] : []));
  if (mock) return { argv: [...argv, '--mock'], note: null };
  if (typeof sbWs.ws !== 'string' || sbWs.wsError) return { argv, note: `Streamer.bot address refused (${sbWs.wsError ?? 'unset'}); the event core uses its default` };
  return { argv: [...argv, '--url', sbWs.ws], note: null };
}

/** The cmd.exe line that opens url in the default browser, or null if url is not a plain loopback http URL.
 *  Only [A-Za-z0-9:/.?=_-] are allowed, so nothing in it is special to cmd (no & | ^ % " < >). */
/** Where the Qt shell exe and its Qt DLLs are (pure; tested). Development: the built exe in out/studio/build and the
 *  Qt kit's bin. Installed package: <root>/studio/ujwalam-studio.exe, self-contained (its Qt DLLs beside it and
 *  platforms/ below it, found by Qt itself; D277). null when neither exe exists. */
export function studioShellPaths({ root = REPO, devExe = STUDIO_EXE, devQtDir = null, exists = existsSync } = {}) {
  if (devExe && exists(devExe)) return { exe: devExe, qtBin: devQtDir ? path.join(devQtDir, 'bin') : null, qtPlugins: null };
  const exe = path.join(root, 'studio', 'ujwalam-studio.exe');
  return exists(exe) ? { exe, qtBin: null, qtPlugins: null } : null;
}

/** Qt shell spawn spec (pure; tested). null when the exe is missing. env: the launcher's environment without any
 *  UJWALAM_*TOKEN* or *_KEY variable, plus the UI URL, the one-time launch key, qtBin (the folder holding the Qt
 *  DLLs) first on PATH and, when given, QT_QPA_PLATFORM_PLUGIN_PATH = qtPlugins (packaged build). */
export function shellSpawnSpec({ uiPort, launchKey, exe, qtBin = null, qtPlugins = null, logsDir = null, version = null, env = process.env, exists = existsSync }) {
  if (!exe || !exists(exe) || !Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) return null;
  const clean = {};
  for (const [k, v] of Object.entries(env)) if (!/^UJWALAM_.*(TOKEN|KEY)/i.test(k)) clean[k] = v;
  const pathKey = Object.keys(clean).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  if (qtBin) clean[pathKey] = `${qtBin}${path.delimiter}${clean[pathKey] ?? ''}`;
  if (qtPlugins) clean.QT_QPA_PLATFORM_PLUGIN_PATH = qtPlugins;
  // logsDir: the studio writes studio-*.log and, on a crash, studio-crash-*.txt there (app/studio/src/studio_log.h).
  if (logsDir) clean.UJWALAM_STUDIO_LOG_DIR = logsDir;
  if (version) clean.UJWALAM_STUDIO_VERSION = version;
  return { cmd: exe, env: { ...clean, UJWALAM_UI_URL: `http://127.0.0.1:${uiPort}/`, UJWALAM_UI_LAUNCH_KEY: launchKey } };
}

export const SHELL_EXITS_FILE = 'studio-exits.jsonl';
export const SHELL_RELAUNCH_MAX = 3;
export const SHELL_RELAUNCH_WINDOW_MS = 10 * 60_000;

/** After a studio window crash: reopen it unless it crashed SHELL_RELAUNCH_MAX times within the window (pure; tested). */
export function shellRelaunchAllowed(crashTimes, now = Date.now(), max = SHELL_RELAUNCH_MAX, windowMs = SHELL_RELAUNCH_WINDOW_MS) {
  return crashTimes.filter((t) => now - t <= windowMs).length <= max;
}

/** One line for <logs>/studio-exits.jsonl when the Qt shell ends (pure; tested): exit code (also as hex, so 3221225477
 *  reads 0xc0000005), whether it counts as a crash, and the studio's own crash report written since it started. */
export function shellExitRecord({ code, signal = null, startedAt, now = Date.now(), reports = [] }) {
  const n = Number.isInteger(code) ? code >>> 0 : null;
  const since = (name) => { const m = /^studio-crash-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/.exec(name); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN; };
  const report = reports.filter((r) => since(r) >= startedAt - 1000).sort().pop() ?? null;
  return { at: new Date(now).toISOString(), code: n, codeHex: n === null ? null : `0x${n.toString(16).padStart(8, '0')}`, signal, crash: code !== 0, upMs: now - startedAt, report };
}

/** release.json version of this install ('dev' in a checkout without one). Named in the studio's crash report. */
export function releaseVersion(file = path.join(REPO, 'release.json')) {
  try { const v = JSON.parse(readFileSync(file, 'utf8')).version; return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? v : 'dev'; } catch { return 'dev'; }
}

export function startCommandLine(url) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/.?=_-]*$/.test(url)) return null;
  return `"start "" "${url}""`;
}

function openBrowser(url) {
  const opts = { stdio: 'ignore', detached: true, windowsHide: true };
  if (process.env.UJWALAM_BROWSER) {
    spawn(process.env.UJWALAM_BROWSER, [...(process.env.UJWALAM_BROWSER_ARGS ?? '').split(' ').filter(Boolean), url], { ...opts, windowsHide: true }).unref();
    return;
  }
  if (process.platform === 'win32') {
    const line = startCommandLine(url);
    if (!line) { console.log('[studio] control page URL has unexpected characters; open it from the terminal line above'); return; }
    // Verbatim: with Node's default quoting cmd received `start "\"\"" <url>` (2026-11-06: no browser opened).
    spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsHide: true, windowsVerbatimArguments: true }).unref();
  }
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
export function hostLaunchSpec({ hostCfg, hostDiscovery, args, alpha = false, corePort, coreApiToken, hostConfigFile, coreSystemToken, headless = isHeadless(), embedded = false }) {
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
    else if (embedded) { /* D280: the Qt shell shows the previews inside its window */ }
    else argv.push('--preview', 'h,v');
    const overlayProblem = overlayRootProblem(hostCfg.overlayRoot);
    if (!overlayProblem) {
      argv.push('--allow-browser', '--overlay-root', hostCfg.overlayRoot, '--overlay-script', hostCfg.overlayScript, '--node', process.execPath);
      if (Number.isInteger(corePort) && corePort > 0 && /^[0-9a-f]{64}$/.test(coreApiToken ?? '')) {
        argv.push('--overlay-events-url', `http://127.0.0.1:${corePort}/events`);
        env.UJWALAM_EVENT_CORE_API_TOKEN = coreApiToken;
      } else notes.push('no event core port or token: overlays get no Streamer.bot events');
    } else {
      notes.push(`${overlayProblem}: overlays are off`);
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

export async function waitForDiscovery(file, child, timeoutMs = 60_000) {
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
// Exported for tools/soak/stream-day.mjs (the stream-day mock run builds the same alpha session).
export async function alphaProject({ client, dataDir, args, hostCfg, embedded = false }) {
  const profileFile = typeof args.profile === 'string' ? path.resolve(args.profile) : path.join(REPO, 'data', 'profile.local.json');
  const profile = readProfile(profileFile);
  let report = null;
  // A start with devices allowed rebuilds a project that was built without them (D282): otherwise game capture,
  // facecam and mic stay placeholders and nothing real is recorded or streamed. The old file is kept in projects/_old/.
  let noDevicesBuild = false;
  if (args['allow-devices'] === true && existsSync(alphaFile(dataDir))) {
    try { const o = loadProject(alphaFile(dataDir)).project.origin; noDevicesBuild = o?.importer === 'alpha' && o.id === 'no-devices'; } catch { /* unreadable: loaded (and reported) below as before */ }
  }
  if (noDevicesBuild && args['rebuild-alpha'] !== true) console.log('[studio] the alpha project was built without devices: rebuilding it with devices (the old one goes to projects/_old/)');
  const r = await prepareAlphaProject({
    dataDir,
    rebuild: args['rebuild-alpha'] === true || noDevicesBuild,
    build: async () => {
      let bindings = { bound: {}, unavailable: [] };
      if (args['allow-devices'] === true) {
        const overrides = profile?.devices?.roles ?? {};
        const problems = overrideProblems(overrides);
        if (problems.length) throw new Error(`profile devices.roles: ${problems.join('; ')}`);
        const list = await client.call('devices.list');
        bindings = matchRoles({ list, presets: loadDevicePresets(path.join(REPO, 'registry', 'presets')), overrides });
      }
      const flagState = createFlags({ dataDir });
      const flags = Object.fromEntries(flagState.ids().map((id) => [id, flagState.isOn(id)]));
      // preset layers with `fit` (the wordmark) measure their file once (D251)
      const mediaInfo = createMediaInfo({ bases: alphaBases({ profile, overlayRoot: hostCfg.overlayRoot }) });
      const b = buildAlphaProject({ presetsDir: path.join(REPO, 'registry', 'presets'), profile, bindings, devicesListed: args['allow-devices'] === true, flags, mediaInfo });
      report = b.report;
      return b.project;
    },
    // one-time scene upgrades of an existing project (D331: the blurred game backdrop replaces the browser background);
    // applied at start, before the host load, so a running stream is never touched
    upgrade: (project) => upgradeScenes(project, { presets: upgradePresets(path.join(REPO, 'registry', 'presets')) }),
  });
  console.log(`[studio] alpha project ${r.action}: ${path.basename(r.file)}${r.moved ? ' (old one moved to projects/_old/)' : ''}`);
  for (const c of r.upgraded ?? []) console.log(`[studio] scene upgrade ${c.upgrade}: ${c.canvas.toUpperCase()} ${c.action} (background ${c.background})`);
  if (r.backup) console.log(`[studio] project before the upgrade kept in projects/_old/${path.basename(r.backup)}`);
  if (r.upgradeError) console.log(`[studio] WARNING: scene upgrade not applied (project loaded as it is): ${r.upgradeError}`);
  if (report) {
    for (const w of report.warnings) console.log(`[studio] WARNING: ${w}`);
    for (const [role, b] of Object.entries(report.roles)) console.log(`[studio] role ${role}: bound (${b.by}${b.preset ? ` ${b.preset}` : ''})`);
    for (const u of report.unavailableRoles) console.log(`[studio] role ${u.role}: not bound: ${u.reason}`);
    if (args['allow-devices'] !== true) console.log('[studio] devices off: game capture and facecam are placeholders (run with --allow-devices --rebuild-alpha after "devices ready")');
  }
  const bases = alphaBases({ profile, overlayRoot: hostCfg.overlayRoot });
  const loaded = await loadFileIntoHost(client, r.file, { bases, skipUnavailable: true });
  console.log(`[studio] alpha project loaded into the host: ${JSON.stringify(loaded.built ?? {})}; not built: ${loaded.unavailable?.length ?? 0}`);
  for (const u of loaded.unavailable ?? []) console.log(`[studio]   not built: ${u.layer ?? u.audio}: ${u.code}: ${u.reason}`);
  for (const w of hudWarnings(r.file)) console.log(`[studio] WARNING: ${w}`);
  // A preview that did not open at start (e.g. closed by hand on a reused host) is opened now. The host opens previews
  // as normal windows on the main display, also with one display (D316); if it refuses, this says why.
  // With the Qt shell the previews live inside its window instead (D280).
  if (!isHeadless() && !embedded) {
    let open = new Set();
    try { open = new Set(((await client.call('preview.list')).previews ?? []).filter((p) => p.open === true).map((p) => String(p.canvas).toUpperCase())); } catch { /* listed below per canvas */ }
    for (const c of ['H', 'V']) {
      if (open.has(c)) continue;
      try { const w = await client.call('preview.open', { canvas: c }); console.log(`[studio] preview ${c} opened after the load on the ${w.display ?? 'main display'}`); } catch (e) { console.log(`[studio] preview ${c} not shown: ${e.message}`); }
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
export async function alphaStatus(client) {
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
  const { logsDir, dataDir, hostCfg, args, alpha, hostToken, hostDiscovery, spawnHost, getChild, isStopping, onClient, endSession, embedded = false, liveSession = null, authority = null } = o;
  const backoffEnv = Number(process.env.UJWALAM_HOST_RESTART_BACKOFF_MS);
  const policy = restartPolicy(Number.isFinite(backoffEnv) && backoffEnv >= 0 ? { backoffMs: [backoffEnv] } : {});
  const watchMs = Math.max(100, Number(process.env.UJWALAM_HOST_WATCH_MS ?? 2000) || 2000);
  let client = o.initialClient;
  let lastOutputs = null;
  let busy = false;
  // Stream recovery (D303 proposed): the streams seen live before the crash wait here until a restarted host is ready
  // (a host that is not ready keeps them for the next attempt; the crash time stays the first one).
  let carry = null;
  let recCfg = null;
  try { recCfg = loadRecoveryConfig(); } catch (e) { console.log(`[studio] WARNING: data/live/recovery.json not usable (${e.message}); streams are not restarted after a crash`); }
  const recPolicy = recCfg ? recoveryPolicy(recCfg) : null;
  const flagOn = () => { try { return createFlags({ dataDir }).isOn(RECOVERY_FLAG); } catch { return false; } };
  const recoveryEvent = (ev) => {
    const full = appendRecoveryEvent(dataDir, { session: liveSession, at: new Date().toISOString(), ...ev });
    console.log(`[studio] ${full.result === 'restarted' ? '' : 'WARNING: '}${full.text}`);
    return full;
  };
  async function recoverStreams(c, projectOk) {
    const { crashAt, streams, labels } = carry;
    carry = null;
    const label = (ids) => ids.map((id) => labels[streams.indexOf(id)] ?? id);
    const base = { crashAt: new Date(crashAt).toISOString(), streams: labels };
    const refused = (reason, extra = {}) => {
      recoveryEvent({ ...base, result: 'not-restarted', reason, restarted: [], failed: labels, ...extra });
      return { restarted: [], byHand: labels };
    };
    if (!recPolicy) return refused('config');
    if (!projectOk) return refused('project-failed');
    if (!authority) return refused('no-confirmation');
    // Decide and send stream.start alone: a revoke (Stop / End all) is answered only after this, so the user's stop
    // reaches the host after the restart and wins.
    const r = await authority.run(async (st) => {
      const d = recPolicy.decide({ now: Date.now(), crashAt, flagOn: flagOn(), authority: st, streams });
      if (!d.restart.length) {
        // Repeating crashes while live: the go-live authority ends here; only the user can go live again.
        if (d.reason === 'limit') authority.revoke('recovery-limit');
        return { d, started: false };
      }
      try { await c.call('stream.start', { sinks: d.restart }); return { d, started: true }; }
      catch (e) { console.log(`[studio] WARNING: stream.start after the restart failed: ${e.message}`); return { d, started: false, failed: true }; }
    });
    const { d, started } = r.value;
    if (!d.restart.length) return refused(d.reason, d.reason === 'limit' ? { recoveries: d.recoveries, windowMs: recCfg.windowMs } : {});
    // A Stop / End all (or a guard stop) arrived while the start was on its way: stop those sinks again here too.
    const late = r.revoked ? d.restart : d.restart.filter((id) => r.excluded.includes(id));
    if (started && late.length) {
      try { await c.call('stream.stop', { sinks: late }); } catch (e) { console.log(`[studio] WARNING: stream.stop after a cancelled restart failed: ${e.message}`); }
    }
    if (started && r.revoked) {
      recoveryEvent({ ...base, result: 'cancelled', reason: 'stopped', attempt: d.attempt, max: d.max, restarted: [], failed: label(d.restart) });
      return { restarted: [], byHand: [] };
    }
    const want = d.restart.filter((id) => !late.includes(id));
    let up = []; let down = want;
    if (started) {
      try { ({ up, down } = await waitStreamsUp((m) => c.call(m), want, recCfg)); } catch { /* reported as not restarted */ }
    }
    recoveryEvent({ ...base, result: !down.length ? 'restarted' : up.length ? 'partial' : 'not-restarted', reason: down.length && !up.length ? 'start-failed' : 'restart',
      attempt: d.attempt, max: d.max, restarted: label(up), failed: label(down) });
    return { restarted: label(up), byHand: label(down) };
  }
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
    if (streams.length && !carry) carry = { crashAt: at.getTime(), streams, labels: labelsOf(lastOutputs, streams) };
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
      if (carry) {
        recoveryEvent({ crashAt: new Date(carry.crashAt).toISOString(), streams: carry.labels, result: 'not-restarted', reason: 'host-gave-up', restarted: [], failed: carry.labels });
        carry = null;
      }
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
    let projectOk = true;
    try {
      if (alpha) await alphaProject({ client, dataDir, args, hostCfg, embedded });
    } catch (e) { projectOk = false; console.log(`[studio] WARNING: project reload after the restart failed: ${e.message}`); }
    let resumed = [];
    if (recording.length) {
      try {
        await client.call('record.start', { sinks: recording });
        resumed = recording;
        console.log(`[studio] recording started again in a new file (${recording.join(', ')}); the file before the crash stays playable (mkv)`);
      } catch (e) { console.log(`[studio] WARNING: recording could not be started again: ${e.message}`); }
    }
    // A host without its scenes would broadcast an empty picture: streams come back only after a good project load.
    const sr = carry ? await recoverStreams(client, projectOk) : { restarted: [], byHand: [] };
    if (sr.byHand.length) console.log(`[studio] WARNING: streams ${sr.byHand.join(', ')} are NOT running: start them with Start stream`);
    const note = `host restarted after an unexpected exit (${base.exit}); restart ${d.attempt} of ${d.max}; recording resumed: ${resumed.join(', ') || 'none'}; ${sr.restarted.length ? `streams restarted: ${sr.restarted.join(', ')}; ` : ''}streams to restart by hand: ${sr.byHand.join(', ') || 'none'}`;
    try { await client.call('marker.add', { source: 'api', note: note.slice(0, 500) }); } catch (e) { console.log(`[studio] WARNING: restart marker not written: ${e.message}`); }
    crashLog({ at: new Date().toISOString(), action: 'restarted', attempt: d.attempt, resumed, streams, streamsRestarted: sr.restarted, streamsByHand: sr.byHand });
    if (alpha) await alphaStatus(client);
    await writeSnapshot(client, logsDir);
    busy = false;
  }
  arm(getChild());
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const alpha = args.alpha === true;
  const shellMode = shellChoice(args);
  if (!shellMode) { console.log('[studio] --shell takes qt (the default) or browser'); return 2; }
  // The Qt shell shows the previews inside its window (D280): known before the host starts, so the host then opens
  // no separate preview windows.
  const shellPaths = shellMode === 'qt' && args['no-open'] !== true && !isHeadless() ? studioShellPaths({ devQtDir: studioQtDir() }) : null;
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
  let livePlan = null; // the --live plan file, for the UI server's readiness check (D327)
  let alphaClient = null;
  let stopping = false;
  let recordClips = null;
  let endSession = () => {};
  const sessionEnded = new Promise((resolve) => { endSession = resolve; });
  const fronts = []; // LU3 (flag service-swap): the stable-port fronts, closed after the services
  // Ask the host to exit cleanly first (it closes previews and removes its discovery file), then kill what is left.
  const stopAll = async () => {
    stopping = true;
    recordClips?.stop();
    if (hostChild && hostChild.exitCode === null && hostDiscoveryFile) {
      try {
        const d = JSON.parse(readFileSync(hostDiscoveryFile, 'utf8'));
        await rpc({ port: d.port, token: hostToken, method: 'host.shutdown', params: {}, timeoutMs: 2000 }); // node:http: the host refuses fetch (it sends Sec-Fetch headers)
        await new Promise((r) => { hostChild.once('exit', r); setTimeout(r, 8000); });
      } catch { /* fall through to kill */ }
    }
    // The whole tree of each child (D311 proposed): a plain kill left a clip job's ffmpeg running after close.
    for (const c of [...children]) killChildTree(c);
    for (const f of fronts) f.close();
    // BM6: with the `bot-manager` flag on, close the bots Ujwalam started. A copy the user started is never touched.
    try {
      if (createFlags({ dataDir }).isOn('bot-manager')) {
        const r = await createBots({ dataDir }).stopStarted();
        for (const [bot, v] of Object.entries(r)) console.log(`[studio] bot ${bot}: ${v.ok ? 'stopped' : `not stopped (${v.reason})`}`);
      }
    } catch (e) { console.log(`[studio] bots: could not stop the ones Ujwalam started (${String(e?.message ?? e).slice(0, 80)})`); }
  };
  process.once('SIGINT', () => { stopAll().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { stopAll().then(() => process.exit(0)); });

  const hostToken = hex(32);
  // Least-privilege host token for the event core (F6 live markers): the host lets it call marker.add (chat/audio)
  // and mixer.list only. The event core processes untrusted chat, so it never gets hostToken.
  const hostMarkersToken = hex(32);
  // Least-privilege host token for the live clipper (D226): frames.grab, replay.save, replay.status, marker.add (clip)
  // and host.status only. A clipper child gets it through clipsEnv({ hostClipsToken, hostDiscovery }), never hostToken.
  const hostClipsToken = hex(32);
  const coreTokens = { api: hex(32), system: hex(32) };
  const launchKey = hex(32);
  // Stream recovery (D303 proposed): this launcher owns the go-live authority (in memory, unarmed at start, so a
  // launcher restart never goes live by itself); the UI server arms and revokes it over its IPC channel. liveSession
  // tags this launcher's recovery events for the control page.
  const liveSession = hex(16);
  const authority = createLiveAuthority({ onChange: (st) => writeAuthorityMirror(dataDir, liveSession, st) });
  writeAuthorityMirror(dataDir, liveSession, authority.state());
  // Face link key (D295): the host gets it by environment, the face worker on its stdin (faceControlLine), nobody else.
  const faceKey = hex(32);
  let faceChild = null;
  const faceTell = () => {
    if (!faceChild || !hostChild?.pid || !faceChild.stdin?.writable) return;
    try { faceChild.stdin.write(faceControlLine({ key: faceKey, hostPid: hostChild.pid })); } catch { /* worker gone */ }
  };

  // 1. event core (port 0; its own log line reports the port). Its read-only Streamer.bot connection uses the same
  //    address as the bot manager (profile bots.streamerbot_ws, else 8093, D194); the connector's own default is
  //    Streamer.bot's documented 8080, which the user's Streamer.bot does not use (D198).
  // D327 IN1 (flag `integrations`): Settings > Integrations gives the Streamer.bot port and "Allow remote connections".
  // The remote pairing token is new for each start and lives only in the core's and the UI server's memory.
  const botCfg = loadBotConfig();
  const integOn = (() => { try { return createFlags({ dataDir }).isOn(INTEGRATIONS_FLAG); } catch { return false; } })();
  const integ = integrationsInEffect(dataDir, botCfg, integOn);
  const remoteToken = integOn && integ.remote.enabled ? hex(32) : null;
  const coreArgs = coreServeArgs({ dataDir, mock: args.mock === true, sbWs: integOn ? { ws: botUrl(integ.bots.streamerbot.port) } : botCfg.streamerbot,
    remote: remoteToken ? { address: integ.remote.address } : null });
  if (coreArgs.note) console.log(`[studio] ${coreArgs.note}`);
  if (remoteToken) console.log('[studio] remote connections: ON (Settings > Integrations); LAN only, pairing token not printed');
  // LU3 service swap (D337, flag service-swap, off by default): the event core and the UI server sit behind fronts the
  // launcher owns (services/supervisor/front.mjs). Clients only ever see the front ports, so a swap to a new version
  // (serveSwaps below) changes no port, token or connection. Flag off: started exactly as before.
  const swapOn = (() => { try { return createFlags({ dataDir }).isOn(SERVICE_SWAP_FLAG); } catch { return false; } })();
  const track = { onSpawn: (c) => children.push(c), onGone: (c) => { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); }, log: (l) => console.log(`[studio] ${l}`) };
  let coreFront = null;
  if (swapOn) { coreFront = createFront({ backendPort: null, name: 'event-core', log: track.log }); fronts.push(coreFront); await coreFront.listen(); }
  // The swap switches go right after 'serve', before the arguments that take values.
  const spawnCore = (root, { standby = false } = {}) => spawn(process.execPath, [path.join(root, 'services', 'event-core', 'cli.mjs'), coreArgs.argv[0],
    ...(coreFront ? ['--swap-control', '--public-port', String(coreFront.port()), ...(standby ? ['--standby'] : [])] : []), ...coreArgs.argv.slice(1)], {
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, // stdin: the parent pipe (D234)
    // UJWALAM_HOST_MARKERS_TOKEN: the F6 live markers (flag live-markers) write host markers; the host is found at
    // <dataDir>/host.json. coreEnv never passes the full host token.
    env: { ...coreEnv({ coreTokens, hostMarkersToken }), ...PARENT_PIPE, UJWALAM_REMOTE_TOKEN: remoteToken ?? '' },
  });
  let core = null; // flag off: the event core process; flag on: coreSlot owns it
  let coreSlot = null;
  let corePort = null;
  if (coreFront) {
    coreSlot = createEventCoreSlot({ front: coreFront, root: REPO, spawn: spawnCore, systemToken: coreTokens.system, onLine: (l) => console.log(l), onUnexpectedExit: () => endSession(0), ...track });
    try { await coreSlot.start(); corePort = coreFront.port(); } catch (e) { console.log(`[studio] event core: ${e.message}`); }
    if (corePort) console.log(`[studio] service swap on: the event core is reached through port ${corePort}`);
  } else {
    core = spawnCore(REPO);
    children.push(core);
    corePort = await portFrom(core, /api on 127\.0\.0\.1:(\d+)/);
  }
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
  // Recordings folder from Settings (D284), used from this start on; the default stays <host data>/recordings.
  if (hostCfg) {
    const rf = readSettings(dataDir).folders.recordings;
    let corpus = null;
    try { corpus = readProfile(typeof args.profile === 'string' ? path.resolve(args.profile) : path.join(REPO, 'data', 'profile.local.json'))?.paths?.clips_corpus ?? null; } catch { corpus = null; }
    const why = rf ? folderProblem(rf, { forbidden: [REPO, corpus] }) : null;
    if (why) console.log(`[studio] WARNING: recordings folder from Settings not used: it ${why}; using ${hostCfg.recordings}`);
    else if (rf) {
      try { mkdirSync(rf, { recursive: true }); hostCfg.recordings = rf; console.log(`[studio] recordings folder (Settings): ${rf}`); } catch (e) { console.log(`[studio] WARNING: recordings folder from Settings not usable (${e.message}); using ${hostCfg.recordings}`); }
    }
  }
  const hostExe = hostCfg?.exe;
  const hostDiscovery = path.join(dataDir, 'host.json');
  if (args['fake-host'] !== true && hostExe && existsSync(hostExe) && hostCfg.runtime) {
    let hostConfigFile;
    if (alpha) {
      try {
        const monitoringOutput = readProfile(typeof args.profile === 'string' ? path.resolve(args.profile) : path.join(REPO, 'data', 'profile.local.json'))?.devices?.monitoringOutput?.name ?? null;
        hostConfigFile = writeHostConfig(dataDir, alphaHostConfig({ dataDir, feedbackDir, hotkeys: hk.overrides, monitoringOutput }));
        console.log(`[studio] host config: ${hostConfigFile} (hotkeys on, replay ${ALPHA_REPLAY_SECONDS} s autostart, feedback folder ${feedbackDir}, monitoring output ${monitoringOutput ? 'from the profile' : 'Windows default'})`);
      } catch (e) { console.log(`[studio] host config could not be written owner-only (${e.message}); stopping`); await stopAll(); return 1; }
    }
    const spec = hostLaunchSpec({ hostCfg, hostDiscovery, args, alpha, corePort, coreApiToken: coreTokens.api, hostConfigFile, coreSystemToken: coreTokens.system, embedded: !!shellPaths });
    for (const n of spec.notes) console.log(`[studio] WARNING: ${n}`);
    const hostArgs = spec.argv;
    let planPath;
    try {
      planPath = args.live === true ? livePlanFile({ dataDir, streamSettingsOn: createFlags({ dataDir }).isOn(STREAM_SETTINGS_FLAG) })
        : typeof args.outputs === 'string' ? path.resolve(args.outputs) : alpha ? ALPHA_RECORD_PLAN : null;
    } catch (e) { console.log(`[studio] outputs plan refused: ${e.message}`); await stopAll(); return 1; }
    livePlan = args.live === true ? planPath : null;
    if (planPath) {
      // An O1 plan file (app/host/outputs/*.json): validated against data/platforms, configured at host start, nothing
      // started. Real targets only with --live (alpha-live.json; the host then runs with --allow-live).
      const { planFile, readServerSchemes } = await import('../../app/host/lib/outputs-plan.mjs');
      let planned;
      try {
        // Real host + --live: the stored server addresses' schemes (only the scheme, the value is dropped at once)
        // choose "auto" transports (Twitch: rtmp or rtmps) and check named ones. A stand-in (script) host reaches no
        // platform, so nothing is read for it and "auto" stays unresolved.
        let schemes;
        if (args.live === true && !/\.m?js$/i.test(hostExe)) {
          const [{ createCredentialStore }, { credentialFacts }] = await Promise.all([import('../event-core/streamerbot/credential.mjs'), import('./readiness.mjs')]);
          schemes = await readServerSchemes(planPath, (ref) => credentialFacts(createCredentialStore(ref), { scheme: true }), lt.select ? { select: lt.select } : {});
        }
        planned = planFile(planPath, { allowLive: args.live === true, ...(lt.select ? { select: lt.select } : {}), ...(schemes ? { schemes } : {}) });
      } catch (e) { console.log(`[studio] outputs plan refused: ${e.message}`); await stopAll(); return 1; }
      const { params, report } = planned;
      if (planned.dropped?.length) console.log(`[studio] outputs: ${planned.dropped.join(', ')} left out (optional recording; its stream is not in this start, so it would add an encoder)`);
      if (planned.unresolved?.length) console.log(`[studio] outputs: ${planned.unresolved.join(', ')} transport "auto" not chosen (stand-in host: no server address read)`);
      else if (args.live === true) for (const s of params.sinks) if (s.target?.urlRef) console.log(`[studio] sink ${s.id}: transport ${s.target.transport} (the scheme of the server address in ${s.target.urlRef})`);
      const ltp = liveTestPlanProblems(lt, params.sinks);
      if (ltp.length) { for (const p of ltp) console.log(`[studio] ${p}`); await stopAll(); return 2; }
      if (lt.select) console.log(`[studio] LIVE sinks: ${params.sinks.map((s) => s.id).join(', ')} (--sinks)`);
      if (args.live === true) console.log(`[studio] LIVE plan: ${path.relative(REPO, planPath)} (real targets configured, nothing started; start with Start stream)`);
      else if (planPath === ALPHA_RECORD_PLAN) console.log(`[studio] record plan: ${path.relative(REPO, planPath)} (Record saves H and V .mkv; streaming needs the LIVE start: Ujwalam.cmd --live)`);
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
        stdio: ['pipe', hostLog.fd, hostLog.fd], // stdin: the parent pipe (D234)
        env: { ...process.env, ...spec.env, ...PARENT_PIPE, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_HOST_MARKERS_TOKEN: hostMarkersToken, UJWALAM_HOST_CLIPS_TOKEN: hostClipsToken, UJWALAM_HOST_DISCOVERY: hostDiscovery, UJWALAM_FACE_LINK_KEY: faceKey },
        windowsHide: true,
      });
      closeSync(hostLog.fd); // the child holds its own handle
      const i = children.indexOf(hostChild);
      if (i >= 0) children.splice(i, 1);
      children.push(child);
      hostChild = child;
      faceTell(); // a restarted host has a new pid: the face worker follows it
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
        await alphaProject({ client: alphaClient, dataDir, args, hostCfg, embedded: !!shellPaths });
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
    // Live clipper state (LC1, D333 proposed): shown in the task panel and in clips/status.json (record-clips.mjs), read
    // by the readiness check. state: running | restarting (it stopped; a restart is scheduled) | gave-up (the last allowed
    // restart also stopped) | not-started (reason). Codex review of LC1: "gave-up" is set only when no restart is pending.
    const lcView = { state: 'not-started', reason: 'the studio is starting', restarts: 0, maxRestarts: LIVE_CLIPPER_MAX_RESTARTS };
    let tryStartClipper = () => {};
    if (disc && alpha) {
      // Clips from each finished recording (D283, flag clip-pipeline): outputs.status every 5 s; the discovery file is
      // read each time, so a restarted host is followed.
      const liveClipsFlag = () => { try { return createFlags({ dataDir }).isOn('live-clips'); } catch { return false; } };
      recordClips = createRecordClips({ clipRoot: CLIP_ROOT, dataDir, project: alpha ? alphaFile(dataDir) : null, log: (l) => console.log(`[studio] ${l}`), postChain: createPostChain({ dataDir, log: (l) => console.log(`[studio] ${l}`) }),
        liveClipper: () => ({ ...lcView, flagOn: liveClipsFlag() }) });
      const clipTick = async () => {
        if (stopping) return;
        tryStartClipper(); // a clipper that could not start (no capture device yet) starts once it can
        try {
          const d = JSON.parse(readFileSync(hostDiscovery, 'utf8'));
          recordClips.feed(await new HostClient({ port: d.port, token: hostToken }).call('outputs.status'));
        } catch { /* host restarting: next tick */ }
      };
      setInterval(clipTick, 5000).unref();
      void clipTick();
    }
    if (disc && alpha) {
      // Live clipper (D226): started with the alpha session, idles while the live-clips flag is off (re-read every
      // 5 s). Only the clips token reaches it. Restarted after a crash at most LIVE_CLIPPER_MAX_RESTARTS times; never
      // stops the stream. One that cannot start yet (e.g. no capture device on the game layer) is tried again on every
      // clip tick (5 s), so binding the device later starts it (LC1).
      let lastReason = null;
      tryStartClipper = () => {
        if (stopping || lcView.state !== 'not-started') return;
        let lc = { spec: null, reason: 'the scene file could not be read' };
        try { lc = liveClipsSpec({ project: loadProject(alphaFile(dataDir)).project, dataDir, repo: CLIP_ROOT }); } catch { /* reason above */ }
        if (!lc.spec) {
          lcView.reason = lc.reason;
          if (lc.reason !== lastReason) console.log(`[studio] live clipper not started: ${lc.reason}`);
          lastReason = lc.reason;
          return;
        }
        const startClipper = () => {
          const c = spawn(lc.spec.exe, lc.spec.argv, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, env: { ...clipsEnv({ hostClipsToken, hostDiscovery }), ...PARENT_PIPE } });
          children.push(c);
          lcView.state = 'running'; lcView.reason = null;
          c.once('exit', (code) => {
            const i = children.indexOf(c);
            if (i >= 0) children.splice(i, 1);
            if (stopping) return;
            const next = clipperExited(lcView, code);
            Object.assign(lcView, next.view);
            if (!next.restart) {
              console.log(`[studio] live clipper exited (${code}); not restarted again`);
              return;
            }
            console.log(`[studio] live clipper exited (${code}); restart ${lcView.restarts}/${LIVE_CLIPPER_MAX_RESTARTS} in 10 s`);
            setTimeout(() => { if (!stopping) startClipper(); }, 10_000).unref();
          });
        };
        startClipper();
        console.log(`[studio] live clipper started (OCR ${lc.spec.gpu ? 'GPU, DirectML' : 'CPU'}; acts only while the live-clips flag is on or clips are set to "while live")`);
      };
      tryStartClipper();
      // Face AI worker (D295 proposed): idles while the face-ai flag is off; no host token. A crash only makes the
      // host's face effects fall back to the plain camera. Restarted at most 5 times.
      const fs_ = faceSpec({ dataDir, repo: CLIP_ROOT });
      if (!fs_.spec) console.log(`[studio] face worker not started: ${fs_.reason}`);
      else {
        let restarts = 0;
        const startFace = () => {
          // stdin: the parent pipe (D234) and the control line (host pid + face link key); never env, never argv
          const c = spawn(fs_.spec.exe, fs_.spec.argv, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, env: { ...faceEnv(), ...PARENT_PIPE } });
          c.stdin.on('error', () => {}); // a worker that died mid-write: its exit handler below deals with it
          children.push(c);
          faceChild = c;
          faceTell();
          c.once('exit', (code) => {
            const i = children.indexOf(c);
            if (i >= 0) children.splice(i, 1);
            if (stopping) return;
            if (restarts >= 5) { console.log(`[studio] face worker exited (${code}); not restarted again`); return; }
            restarts += 1;
            console.log(`[studio] face worker exited (${code}); restart ${restarts}/5 in 10 s`);
            setTimeout(() => { if (!stopping) startFace(); }, 10_000).unref();
          });
        };
        startFace();
        console.log('[studio] face worker started (acts only while the face-ai flag is on)');
      }
    }
    if (disc) {
      superviseHost({
        logsDir, dataDir, hostCfg, args, alpha, hostToken, hostDiscovery, spawnHost, embedded: !!shellPaths,
        getChild: () => hostChild, isStopping: () => stopping,
        initialClient: alphaClient ?? new HostClient({ port: disc.port, token: hostToken }),
        onClient: (c) => { if (alpha) alphaClient = c; },
        endSession, liveSession, authority,
      });
    }
  } else {
    console.log('[studio] BLOCKED-ON-HOST: no libobs host executable (build it with node app/host/tools/build.mjs, or set UJWALAM_HOST_EXE / --host-exe); the UI uses its fake backend');
    if (alpha) { console.log('[studio] alpha needs the libobs host; stopping'); await stopAll(); return 1; }
  }

  // 3. UI server
  const uiArgs = [path.join(REPO, 'services', 'studio-ui', 'cli.mjs'), 'serve', '--data-dir', dataDir, '--feedback-dir', feedbackDir];
  uiArgs.push('--profile', typeof args.profile === 'string' ? path.resolve(args.profile) : path.join(REPO, 'data', 'profile.local.json'), '--release', path.join(REPO, 'release.json'));
  if (typeof args['ui-port'] === 'string') uiArgs.push('--port', args['ui-port']);
  if (livePlan) uiArgs.push('--live-plan', livePlan);
  if (args['fake-host'] === true) uiArgs.push('--fake-host');
  // P5b autosave: layer edits accepted by the host are written into the alpha project file (project-sync.mjs).
  else if (alpha) uiArgs.push('--project', alphaFile(dataDir));
  // Flag service-swap: the front takes --ui-port (the port the user chose); each UI server process gets a free one.
  let uiFront = null;
  if (swapOn) {
    const want = uiArgs.indexOf('--port');
    uiFront = createFront({ backendPort: null, name: 'studio-ui', log: track.log, ...(want >= 0 ? { port: Number(uiArgs[want + 1]) } : {}) });
    if (want >= 0) uiArgs.splice(want, 2);
    fronts.push(uiFront);
    await uiFront.listen();
  }
  let uiSlot = null;
  const spawnUi = (root) => {
    const c = spawn(process.execPath, [path.join(root, 'services', 'studio-ui', 'cli.mjs'), ...uiArgs.slice(1)], {
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'], windowsHide: true, // stdin: the parent pipe (D234); ipc: the go-live authority (D303)
      env: { ...process.env, ...PARENT_PIPE, [SESSION_ENV]: liveSession, UJWALAM_UI_LAUNCH_KEY: launchKey, UJWALAM_HOST_TOKEN: hostToken, UJWALAM_EVENT_CORE_PORT: String(corePort), UJWALAM_EVENT_CORE_API_TOKEN: coreTokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: '', UJWALAM_REMOTE_TOKEN: remoteToken ?? '' },
    });
    // Every UI server process serves the one authority; only the exit of the current one closes it (LU3).
    serveAuthority(c, authority, { isOwner: (x) => !uiSlot || x === uiSlot.child() });
    return c;
  };
  let ui = null; // flag off: the UI server process; flag on: uiSlot owns it (uiChild() is the current one)
  let uiPort = null;
  if (uiFront) {
    uiSlot = createUiSlot({ front: uiFront, root: REPO, spawn: spawnUi, onLine: (l) => console.log(l), onUnexpectedExit: () => endSession(0), ...track });
    try { await uiSlot.start(); uiPort = uiFront.port(); } catch (e) { console.log(`[studio] UI server: ${e.message}`); }
  } else {
    ui = spawnUi(REPO);
    children.push(ui);
    uiPort = await portFrom(ui, /listening on http:\/\/127\.0\.0\.1:(\d+)\//);
  }
  const uiChild = () => uiSlot?.child() ?? ui;
  if (!uiPort) { console.log('[studio] UI server did not start; stopping'); await stopAll(); return 1; }

  console.log(`[studio] UI at http://127.0.0.1:${uiPort}/ (the login key is one-time and not printed). ${process.env.UJWALAM_NO_CONSOLE === '1' ? 'Closing the studio window stops everything (started without a console: ujwalam-start.exe).' : 'Ctrl-C stops everything.'}`);
  // Headless (D191): no browser. One exception for scripted runs (F2 real-host test): UJWALAM_BROWSER naming this
  // Node runs that script (windowsHide, no window) with the login URL, so it can drive the page API like the browser.
  const wantShell = shellMode === 'qt';
  const shellLogs = path.join(dataDir, 'logs');
  const shellSpec = shellPaths ? shellSpawnSpec({ uiPort, launchKey, ...shellPaths, logsDir: shellLogs, version: releaseVersion() }) : null;
  if (wantShell && !shellSpec && args['no-open'] !== true && !isHeadless()) console.log('[studio] the Qt studio shell is not built (npm run build:studio); opening the browser instead');
  if (args['no-open'] !== true && shellSpec && !isHeadless()) {
    const crashTimes = [];
    const startShell = (spec) => {
      const shell = spawn(spec.cmd, [], {
        stdio: 'ignore', env: spec.env,
        windowsHide: false // GUI window: the Qt studio window (default, D277); a GUI exe, no console
      });
      shell.on('error', (e) => console.log(`[studio] Qt shell failed to start: ${e.code ?? 'error'}`));
      // One close (D280): the window closed by the user (exit 0; while live too, D332) stops
      // everything. Any other exit is a crash: the studio keeps running (a stream is never cut by a UI crash) and the
      // window is opened again (at most SHELL_RELAUNCH_MAX times in SHELL_RELAUNCH_WINDOW_MS), with a new one-time key
      // the UI server gets on its stdin pipe. Without a console (ujwalam-start.exe) the window is the only way to stop.
      const shellStarted = Date.now();
      shell.on('exit', (code, signal) => {
        const i = children.indexOf(shell);
        if (i >= 0) children.splice(i, 1);
        // Every exit goes to <logs>/studio-exits.jsonl too (the console may be hidden or gone; 2026-11-08 crash).
        let rec = null;
        try {
          mkdirSync(shellLogs, { recursive: true });
          rec = shellExitRecord({ code, signal, startedAt: shellStarted, reports: readdirSync(shellLogs).filter((n) => n.startsWith('studio-crash-')) });
          appendFileSync(path.join(shellLogs, SHELL_EXITS_FILE), `${JSON.stringify({ ...rec, stopping })}\n`);
        } catch { /* best effort: the log line below still says it */ }
        if (stopping) return;
        if (code === 0) {
          console.log('[studio] studio window closed: stopping Ujwalam');
          stopAll().then(() => process.exit(0));
          return;
        }
        const what = `exit ${code}${rec?.codeHex ? ` = ${rec.codeHex}` : ''}${rec?.report ? `; crash report logs/${rec.report}` : ''}`;
        const t = Date.now();
        crashTimes.push(t);
        if (!shellRelaunchAllowed(crashTimes, t) || !uiChild()?.stdin?.writable) {
          // Nothing may run on with no window (user 2026-11-09, D311 proposed): unless a stream is live (a UI crash
          // never cuts a stream), everything stops, the clip job's whole process tree included.
          console.log(`[studio] Qt shell ended unexpectedly (${what}); NOT reopened (more than ${SHELL_RELAUNCH_MAX} crashes in ${SHELL_RELAUNCH_WINDOW_MS / 60000} min).`);
          void (async () => {
            let live = true; // unreadable: assume live, never cut a stream
            try { live = alphaClient ? isLive(await alphaClient.call('outputs.status')) : false; } catch { /* keep live = true */ }
            if (live) { console.log('[studio] a stream is live, so the studio keeps running without its window; stop the stream from the control page, then end it'); return; }
            console.log('[studio] nothing is live: stopping Ujwalam so nothing runs on without a window');
            stopAll().then(() => process.exit(0));
          })();
          return;
        }
        const key = hex(32);
        try { uiChild().stdin.write(`rearm ${key}\n`); } catch { console.log(`[studio] Qt shell ended unexpectedly (${what}); could not reopen it`); return; }
        console.log(`[studio] Qt shell ended unexpectedly (${what}); the studio keeps running. Reopening the window in 2 s.`);
        setTimeout(() => {
          if (stopping) return;
          const again = shellSpawnSpec({ uiPort, launchKey: key, ...shellPaths, logsDir: shellLogs, version: releaseVersion() });
          if (again) startShell(again);
        }, 2000).unref();
      });
      children.push(shell);
    };
    startShell(shellSpec);
    console.log('[studio] Qt studio shell started');
  } else if (args['no-open'] !== true && (!isHeadless() || headlessLoginScript())) openBrowser(`http://127.0.0.1:${uiPort}/login?k=${launchKey}`);
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
      runGuard({ getClient: () => alphaClient, budget: lt.budget, minutes: lt.minutes, sinkMinutes: lt.sinkMinutes, isCancelled: () => stopping, log: (l) => console.log(`[studio] ${l}`),
        onStop: (sinks) => (sinks ? authority.exclude(sinks) : authority.revoke('live-guard')) })
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
        .catch((e) => { console.log(`[studio] live-test guard failed: ${e.message}; stopping all outputs`); authority.revoke('live-guard').then(() => alphaClient.call('outputs.stop', {})).catch(() => {}).finally(() => endSession(GUARD_ABORT_EXIT)); });
    }
  }
  if (args['stop-on-stdin'] === true) {
    // Clean stop for scripts and tests: closing stdin (or any input) ends the session; Ctrl-C does not reach a child on Windows.
    process.stdin.resume();
    process.stdin.once('data', () => { stopAll().then(() => process.exit(0)); });
    process.stdin.once('end', () => { stopAll().then(() => process.exit(0)); });
  }
  if (swapOn) serveSwaps({ slots: { 'event-core': coreSlot, 'studio-ui': uiSlot }, log: track.log });
  // Flag on: an exit of the current core or UI process that no swap planned ends the session through endSession.
  const code = await new Promise((resolve) => { core?.once('exit', () => resolve(0)); ui?.once('exit', () => resolve(0)); sessionEnded.then(resolve); });
  await stopAll();
  return code;
}

/**
 * LU3 swap requests (D337, flag service-swap). Only the process that started this launcher can ask, over its IPC
 * channel (no port, no file): { t: 'ujwalam-swap', id, service, root } -> { t, id, result, ... }. root is the folder
 * of the new version (a staged install, LU6) and must hold the service's entry file. The host and the overlay server
 * (a child of the host) are refused (LU5); the workers have a stop-start slot (slots.mjs) that is not wired here yet.
 */
export function serveSwaps({ slots, log, proc = process }) {
  if (typeof proc.send !== 'function') return false;
  proc.on('message', async (m) => {
    if (m?.t !== 'ujwalam-swap' || !Number.isInteger(m.id)) return;
    const reply = (r) => { try { if (proc.connected) proc.send({ t: 'ujwalam-swap', id: m.id, ...r }); } catch { /* the asker is gone */ } };
    const why = refuseReason(m.service, {});
    if (why) { reply({ result: 'refused', reason: why }); return; }
    const slot = slots[m.service];
    if (!slot) { reply({ result: 'refused', reason: SERVICES[m.service] ? 'not wired in the launcher yet' : 'unknown service' }); return; }
    const entry = m.service === 'event-core' ? ['services', 'event-core', 'cli.mjs'] : ['services', 'studio-ui', 'cli.mjs'];
    if (typeof m.root !== 'string' || !path.isAbsolute(m.root) || !existsSync(path.join(m.root, ...entry))) { reply({ result: 'refused', reason: 'root must be an absolute folder that holds the service entry file' }); return; }
    log(`swap ${m.service} requested`);
    try {
      const r = await slot.swap(path.resolve(m.root));
      reply({ result: r.result, ms: r.ms, reason: r.reason, failed: r.history?.filter((h) => !h.ok).map((h) => `${h.action}: ${h.error}`) });
    } catch (e) { reply({ result: 'failed', reason: String(e?.message ?? e).slice(0, 200) }); }
  });
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('launch.mjs') && process.argv[1].includes('studio-ui')) process.exit(await main());
