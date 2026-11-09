// SPDX-License-Identifier: GPL-3.0-or-later
// Studio UI server (v1 F2, decision D1). Node stdlib only.
//
// Serves ui/ (plain <script>, no CDN) on 127.0.0.1 and offers the page a NARROW same-origin API. The page never gets
// a backend token: this process holds the event-core and host credentials (see backends.mjs) and calls them itself.
//
// Browser trust model (the opposite of the event-core API, which refuses browsers):
//   - Host must be exactly 127.0.0.1:<port> (DNS-rebinding defence). No CORS headers, OPTIONS is refused.
//   - Login: GET /login?k=<launch key> trades the one-time launch key (from the launcher, via env) for a session
//     cookie: HttpOnly, SameSite=Strict, Path=/. The key is single use, expires, and failed tries are rate limited.
//   - Every other request needs the session cookie. Mutating requests (POST) also need Origin == our origin,
//     Content-Type application/json and the X-Ujwalam-Csrf header (value from GET /ui/api/session, never in a cookie).
//   - Sec-Fetch-Site, when present, must be same-origin (or none for the login navigation).
//   - Static files: GET only, extension allowlist, no dotfiles, no traversal (checked on the decoded path and again
//     on the real path), nothing outside ui/.
//
// Confirmation channel (ADR 2026-10-29-confirmation-channel.md, D7): this server is the human-facing surface. A
// confirmation is a typed phrase in the page ("yes", "yes, on air"). The server keeps the pending record, including
// the event-core confirmId and actionHash, and only calls the backend when the typed text matches the phrase.
// TODO(main): event-core still accepts actions.confirm from the api token. When the confirm role exists (ADR option
// 2) this server must be given the separate confirm credential (env, in memory, never in api.json) and use it in
// backends.mjs core.confirm(). The api token is used for it today, as the ADR's interim statement says.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS, BOT_LABELS, GRACEFUL_MS, createBots } from '../bots/index.mjs';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, createPostStore } from '../posting/index.mjs';
import { createYoutubeAuth } from '../posting/oauth.mjs';
import { QUEUE_NAME, createUploadQueue, readQueueSummary, reasonText, streamOnly } from '../posting/auto-chain.mjs';
import { AUTO_FLAG, AUTO_LOG_NAME, createAutoLog, describeMode, liveBlock, loadRules, planAuto } from '../posting/auto-post.mjs';
import { UploadError, checkPostStatus, uploadPost } from '../posting/youtube.mjs';
import { createFeedback } from './feedback.mjs';
import { UNDOABLE, afterOf, beforeOf, createEditHistory, paramsOf } from './edit-history.mjs';
import { addLayer, addScene, duplicateLayer, duplicateScene, moveLayer, removeLayer, removeScene, renameLayer, renameScene } from '../project/structure.mjs';
import { listAssets } from './assets.mjs';
import { loadProject, saveProject } from '../project/store.mjs';
import { MAX_NOTE, MAX_TITLE, REPORT_FLAG, createReporter } from './report.mjs';
import { countsOnly, importSession, resolveSessionFile } from './import.mjs';
import { clipsFolder, guideOnly, readSettings, settingsProblems, writeSettings } from './user-settings.mjs';
import { createTasks } from './tasks.mjs';
import { OVERRIDE_PHRASE, READINESS_FLAG, createReadiness, diskFreeBytes, lastCiPass, listProcessNames, loadReadinessConfig, logOverride, planTargets, readinessSummary } from './readiness.mjs';
import { clipTools } from './record-clips.mjs';
import { authorityClient, readRecoveryStatus, SESSION_ENV, SESSION_RE } from './stream-recovery.mjs';
import { TEST_KIT_FLAG, createFeedbackAutoCollect, liveAlerts, loadTestKitConfig } from './live-test-kit.mjs';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';
import { loadBotConfig, tcpAnswers } from '../bots/index.mjs';

// The app folder (repo or install): settings folders may not point into it (D284).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LOOPBACK = '127.0.0.1';
export const COOKIE = 'ujwalam_ui';
export const CSRF_HEADER = 'x-ujwalam-csrf';

export const LIMITS = Object.freeze({
  maxBodyBytes: 16_384,
  maxHeaderBytes: 8_192,
  launchKeyTtlMs: 120_000,
  loginFailMax: 5,
  loginLockMs: 60_000,
  sessionMax: 8,
  sseMaxClients: 8,
  sseHeartbeatMs: 15_000,
  statusPollMs: 1_000,
  pendingMax: 8,
  pendingTtlMs: 30_000,
  loadRetryMs: [1000, 2000, 4000], // project.load right after record.stop can answer -32009 under load
});

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();
const sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));
const newId = (n = 32) => randomBytes(n).toString('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const pickKeys = (o, ks) => Object.fromEntries(ks.filter((k) => Object.hasOwn(o, k) && Number.isFinite(o[k])).map((k) => [k, o[k]]));

// Calls the page may make on the host. write: true marks a studio write. confirm: when set, the call is not run until
// the human types the phrase (live-aware). Everything else the page sends is refused. Schema: see validate().
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MIXER_ID = /^(?:[A-Za-z0-9_.:-]{1,64}\/[A-Za-z0-9_.:-]{1,64}|audio:[A-Za-z0-9_.:-]{1,64})$/; // "<scene>/<layer>" or "audio:<id>"
const OPT_CANVAS = { type: 'enum', values: ['h', 'v'] };
const CANVAS = { type: 'enum', values: ['h', 'v'], required: true };
const SCENE = { type: 'string', pattern: ID, required: true };
const LAYER = { type: 'string', pattern: ID, required: true };
// Inspector patch (host layers.setPlacement): canvas pixels, degrees, crop in source pixels; same ranges as the host.
const CROP_PX = { type: 'num', min: 0, max: 16384 };
const PLACEMENT = { type: 'object', required: true, schema: {
  x: { type: 'num', min: -16384, max: 16384 }, y: { type: 'num', min: -16384, max: 16384 },
  width: { type: 'num', min: 1, max: 16384 }, height: { type: 'num', min: 1, max: 16384 },
  rotation: { type: 'num', min: -360, max: 360 },
  crop: { type: 'object', schema: { left: CROP_PX, top: CROP_PX, right: CROP_PX, bottom: CROP_PX } },
} };
// Names follow the host contract (docs/evidence/2026-10-29-v1-host-o1.md section 8).
export const HOST_CALLS = Object.freeze({
  'scenes.list': { schema: {} },
  'scenes.activate': { schema: { scene: SCENE, canvas: OPT_CANVAS } },
  'layers.list': { schema: { scene: SCENE, canvas: OPT_CANVAS } },
  'layers.setVisible': { schema: { scene: SCENE, canvas: OPT_CANVAS, layer: LAYER, visible: { type: 'bool', required: true } } },
  // liveConfirm: instant while nothing is live; while live, a layout change needs "yes, on air" (live-lock, D233).
  // Scene switches, visibility and the mixer stay instant: they are the controls a live show needs.
  'layers.move': { schema: { scene: SCENE, canvas: OPT_CANVAS, layer: LAYER, index: { type: 'int', min: 0, max: 255, required: true } }, liveConfirm: true, summary: 'Change the layer order while live' },
  'layers.setPlacement': { schema: { scene: SCENE, canvas: OPT_CANVAS, layer: LAYER, placement: PLACEMENT }, liveConfirm: true, summary: 'Move or resize a layer while live' },
  // Layer effects (D260; the Look panel, D290, no flag): the whole effects list of a layer on every canvas (no canvas field).
  // Flag effect-editor now only shows the Advanced list in the studio window.
  'layers.setEffects': { schema: { scene: SCENE, layer: LAYER, effects: { type: 'effects', required: true } }, liveConfirm: true, summary: 'Change a layer\'s effects while live' },
  // parent/x/y/width/height: the Qt shell embeds the preview in its window (decimal window handle, client pixels).
  'preview.open': { schema: { canvas: CANVAS, parent: { type: 'string', pattern: /^[1-9][0-9]{0,19}$/ }, x: { type: 'int', min: 0, max: 16384 }, y: { type: 'int', min: 0, max: 16384 }, width: { type: 'int', min: 160, max: 8192 }, height: { type: 'int', min: 90, max: 8192 } } },
  'preview.focus': { schema: { canvas: CANVAS } },
  'preview.close': { schema: { canvas: CANVAS } },
  // Clipping from the studio (D281): save the replay buffer (the last 60 s of H and V, or one canvas) as clip files, and
  // write a moment marker for the post-stream clipper. Neither changes the stream or the recording: no confirm.
  'replay.save': { schema: { canvas: OPT_CANVAS } },
  'marker.add': { schema: { source: { type: 'enum', values: ['api'], required: true } } },
  'mixer.list': { schema: {} },
  'mixer.setVolume': { schema: { id: { type: 'string', pattern: MIXER_ID, required: true }, db: { type: 'num', min: -100, max: 0, required: true } } },
  'mixer.setMute': { schema: { id: { type: 'string', pattern: MIXER_ID, required: true }, muted: { type: 'bool', required: true } } },
  // CUE (headphone monitoring, Meld's per-channel button): not a stream change, applied at once.
  'mixer.setCue': { schema: { id: { type: 'string', pattern: MIXER_ID, required: true }, cue: { type: 'bool', required: true } } },
  // Track routing (D273, flag mixer-routing): which project audio tracks a source goes to. Every output encodes track 1,
  // so this changes what the stream and recording hear: instant offline, "yes, on air" while live. Saved to the project.
  'mixer.setTracks': { schema: { id: { type: 'string', pattern: MIXER_ID, required: true }, tracks: { type: 'ids', max: 6, required: true } }, liveConfirm: true, flag: 'mixer-routing', summary: 'Change which tracks a sound goes to while live' },
  'stream.start': { schema: {}, confirm: 'onair', summary: 'Start the stream' },
  'stream.stop': { schema: {}, confirm: 'live', summary: 'Stop the stream' },
  'record.start': { schema: {}, confirm: 'live', summary: 'Start recording' },
  'record.stop': { schema: {}, confirm: 'live', summary: 'Stop recording' },
});

export const DEFAULT_FEEDBACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'feedback');
const FLAG_SET_SCHEMA = { id: { type: 'string', pattern: /^[a-z][a-z0-9-]{0,47}$/, required: true }, on: { type: 'bool', required: true } };
const NOTE_KEYS = ['id', 'text', 'tag', 'severity'];

export const BOT_FLAG = 'bot-manager';
// Mouse editing on the preview (P5, D230): the host does the editing; this server keeps the host's switch equal to the
// flag and saves the host's committed edits (preview.edits) into the project file like inspector edits.
export const PREVIEW_EDIT_FLAG = 'preview-edit';
// Scene transitions (D239): while on, the host's per-canvas transition follows the project's canvases[].transition
// (Meld import: fade of Meld's duration); off (default) = cut.
export const TRANSITIONS_FLAG = 'transitions';
// Scene and layer structure edits (D240): add/remove scenes and layers from the control page, saved into the project.
export const SCENE_EDIT_FLAG = 'scene-edit';
// D292 (proposed): adding, duplicating and renaming lose nothing, so they work without the scene-edit flag (still
// refused while live). Removing a scene or layer and the project-file move stay behind the flag.
const FREE_STRUCTURE_OPS = ['scene.add', 'layer.add', 'layer.duplicate', 'layer.rename', 'scene.duplicate', 'scene.rename'];
const STRUCTURE_OPS = ['scene.add', 'scene.remove', 'layer.add', 'layer.remove', 'layer.move', ...FREE_STRUCTURE_OPS];
const STRUCTURE_KEYS = { 'scene.add': ['name'], 'scene.remove': ['scene'], 'layer.add': ['scene', 'kind', 'of', 'color', 'text', 'device', 'overlay', 'file'], 'layer.remove': ['scene', 'layer'], 'layer.move': ['scene', 'layer', 'canvas', 'direction'],
  'layer.duplicate': ['scene', 'layer'], 'layer.rename': ['scene', 'layer', 'name'], 'scene.duplicate': ['scene'], 'scene.rename': ['scene', 'name'] };
const BOT_SCHEMA = { bot: { type: 'enum', values: BOTS, required: true } };
const POST_ERR = { 'unknown-post': 404, 'over-limit': 409, 'unresolved-placeholders': 409, 'empty-title': 409, 'video-changed': 409, 'already-uploaded': 409 };
const YT_ERR = { 'unknown-post': 404, 'not-approved': 409, 'video-changed': 409, 'over-limit': 409, 'unresolved-placeholders': 409, 'already-uploaded': 409, 'stream-active': 409, 'not-uploaded': 409, 'video-missing': 409, 'status-not-permitted': 403 };
export const UPLOAD_PHRASE = 'yes, upload';
const POST_EDIT_KEYS = ['id', 'title', 'description', 'tags', 'hashtags'];

// "Open folder" for a package (local only, no shell). explorer.exe comes from SystemRoot, never from PATH.
function defaultOpenFolder(dir) {
  let cmd; let args = [dir];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot;
    cmd = typeof root === 'string' && path.isAbsolute(root) ? path.join(root, 'explorer.exe') : null;
    if (!cmd || !existsSync(cmd)) return false;
  } else if (process.platform === 'darwin') cmd = '/usr/bin/open';
  else { cmd = 'xdg-open'; args = [dir]; }
  try {
    spawn(cmd, args, {
      detached: true, stdio: 'ignore',
      windowsHide: false // GUI window: the folder window the user clicked "Open folder" for
    }).on('error', () => {}).unref();
    return true;
  } catch { return false; }
}

const CORE_ACTION_ID =/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

/** Returns an error string or null. */
export function validate(schema, p) {
  if (!isPlain(p)) return 'params must be an object';
  for (const k of Object.keys(p)) if (!Object.hasOwn(schema, k)) return `unknown field ${JSON.stringify(k.slice(0, 32))}`;
  for (const [k, d] of Object.entries(schema)) {
    if (!Object.hasOwn(p, k)) { if (d.required) return `missing field ${k}`; continue; }
    const v = p[k];
    switch (d.type) {
      case 'string': if (typeof v !== 'string' || v.length > 64 || (d.pattern && !d.pattern.test(v))) return `bad field ${k}`; break;
      case 'int': if (!Number.isSafeInteger(v) || v < (d.min ?? 0) || v > (d.max ?? 1e9)) return `bad field ${k}`; break;
      case 'num': if (typeof v !== 'number' || !Number.isFinite(v) || v < (d.min ?? 0) || v > (d.max ?? 1e9)) return `bad field ${k}`; break;
      case 'bool': if (typeof v !== 'boolean') return `bad field ${k}`; break;
      // A layer's effects list (D260): shape and size only here; the host checks each effect in full (model.cpp)
      // and the project file is validated again when it is saved.
      case 'effects': if (!Array.isArray(v) || v.length > 6 || !v.every((e) => isPlain(e) && typeof e.type === 'string')
        || JSON.stringify(v).length > 4096) return `bad field ${k}`; break;
      case 'enum': if (!d.values.includes(v)) return `bad field ${k}`; break;
      // A list of distinct ids (track routing, D273).
      case 'ids': if (!Array.isArray(v) || v.length > (d.max ?? 6) || new Set(v).size !== v.length
        || !v.every((x) => typeof x === 'string' && ID.test(x))) return `bad field ${k}`; break;
      case 'object': {
        if (!isPlain(v) || Object.keys(v).length === 0) return `bad field ${k}`;
        const e = validate(d.schema, v);
        if (e) return `${k}: ${e}`;
        break;
      }
      default: return 'internal schema error';
    }
  }
  return null;
}

const normPhrase = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/** opts: { uiRoot, core, host, launchKey, port?, limits?, now? }
 *  core:  { call(method, params) -> Promise, describe() -> { available } }   (event core; may be unavailable)
 *  host:  { call(method, params) -> Promise, describe() -> { kind: 'host'|'fake', available, blockedOnHost? } } */
/** host.status audioHealth -> the page's readiness view (pure; tested): ok, warnings and per source state only. */
export function audioReadiness(ah) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const sources = (Array.isArray(ah?.sources) ? ah.sources : []).slice(0, 16).map((s) => ({
    id: str(s.id, 80), name: str(s.name, 64), state: str(s.state, 16),
    receiving: typeof s.receiving === 'boolean' ? s.receiving : null,
    lastDataMs: Number.isFinite(s.lastDataMs) ? s.lastDataMs : null,
    recreates: Number.isInteger(s.recreates) ? s.recreates : 0,
  }));
  const warnings = (Array.isArray(ah?.warnings) ? ah.warnings : []).filter((w) => typeof w === 'string').slice(0, 16).map((w) => w.slice(0, 96));
  return { ok: warnings.length === 0, warnings, sources };
}

// A confirmed start overtaken by a Stop is stopped again (D303): waits between the tries, and the page's text when
// every try failed.
const STOP_AGAIN_WAITS = [300, 1000];
const STOP_AGAIN_FAILED = 'Streams may still be live: press Stop or End all';

export function createStudioServer(opts) {
  const limits = { ...LIMITS, ...(opts.limits ?? {}) };
  const now = opts.now ?? Date.now;
  const root = realpathSync(path.resolve(opts.uiRoot));
  const { core, host } = opts;
  // P5b autosave of layer edits into the project file (project-sync.mjs); null: edits stay live-only.
  const projectSync = opts.projectSync ?? null;
  // The user's stream assets folder (D241; base "media" of the alpha load); null: no image or video layers.
  const assetsDir = typeof opts.assetsDir === 'string' ? opts.assetsDir : null;
  // Undo / redo of layer edits (P5b, D238): in memory, newest 50; inspector, layer-list and preview-mouse edits.
  const history = opts.history ?? createEditHistory();
  // Feature flags (D149) and the post-stream feedback form (D150). opts.flags / opts.feedback are test seams.
  const flags = opts.flags ?? (typeof opts.dataDir === 'string' ? createFlags({ dataDir: opts.dataDir }) : null);
  // Stream recovery (D303 proposed, stream-recovery.mjs): the launcher owns the go-live authority; this server reaches
  // it over the IPC channel the launcher opens (only when started by the launcher: parent pipe and session id). A
  // confirmed "yes, on air" start takes a generation before the host call and arms it after (refused when a Stop came
  // in between); a confirmed Stop or End all revokes it BEFORE the host is asked and waits for the answer, so an
  // in-flight recovery start reaches the host first and the stop wins. A revoke the launcher does not answer closes
  // the channel, which closes the authority (fail closed). Done whatever the flag; the launcher reads the flag.
  // A start whose generation is no longer current right before the host call is not sent; one that the host accepted
  // but that can no longer arm (a Stop came in meanwhile) is stopped again at once, so the newer Stop always wins.
  // opts.authority: test seam ({ begin, arm, revoke } or null).
  const liveSession = (() => { const v = opts.liveSession ?? process.env[SESSION_ENV]; return typeof v === 'string' && SESSION_RE.test(v) ? v : null; })();
  const authority = opts.authority !== undefined ? opts.authority
    : liveSession && process.env.UJWALAM_PARENT_PIPE === '1' ? authorityClient() : null;
  const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
  // Test only (race tests): a pause right before a confirmed stream.start goes to the host. 0 = none.
  const startPauseMs = Math.min(10_000, Math.max(0, Number(opts.startPauseMs ?? process.env.UJWALAM_TEST_START_PAUSE_MS ?? 0) || 0));
  const feedback = opts.feedback ?? createFeedback({ feedbackDir: opts.feedbackDir ?? DEFAULT_FEEDBACK_DIR, now: () => new Date(now()) });
  // Live test kit (flag `live-test-kit`, D305 proposed; live-test-kit.mjs): plain-words alerts in the status snapshot
  // (audio sources that stopped, stream recovery, the Streamer.bot test-action reminder, the feedback result) and, when
  // a stream ends, the viewers' replies collected read-only from <dataDir>/event-core.db into the feedback folder.
  // Never posts, speaks or triggers anything. opts.testKit = { kit, collect } are test seams.
  const testKitOn = () => !!flags && flags.isOn(TEST_KIT_FLAG);
  let kitCfg;
  const testKit = () => {
    if (kitCfg === undefined) { try { kitCfg = opts.testKit?.kit ?? loadTestKitConfig(); } catch (e) { kitCfg = null; log(`[studio-ui] live test kit: ${e.message}`); } }
    return kitCfg;
  };
  const feedbackCollect = createFeedbackAutoCollect({
    ...(opts.testKit?.collect ? { collect: opts.testKit.collect } : {}), // default: the collector in a child process
    dbFile: typeof opts.dataDir === 'string' ? path.join(opts.dataDir, 'event-core.db') : null,
    outDir: opts.feedbackDir ?? DEFAULT_FEEDBACK_DIR,
    kit: () => { const k = testKit(); if (!k) throw new Error('data/live/test-kit.json could not be read'); return k; },
    enabled: testKitOn, now, log: (m) => log(`[studio-ui] ${m}`),
  });
  // Export-only posting (P16a, flag `posting`): packages are listed from <dataDir>/posting/ledger.json. Nothing is uploaded.
  const posting = opts.posting ?? (typeof opts.dataDir === 'string' ? createPostStore({ ledgerFile: path.join(opts.dataDir, 'posting', LEDGER_NAME) }) : null);
  // YouTube private upload (P16b, behind `posting`). Sign-in stays CLI-only: tokens live in the Credential Manager and never
  // reach the browser. opts.youtube = { auth, fetchImpl, outputsStatus } are test seams.
  let ytAuth = opts.youtube?.auth ?? null;
  const youtubeAuth = () => (ytAuth ??= createYoutubeAuth({ browserOpen: async () => { throw new Error('sign-in runs from the command line'); } }));
  const uploading = new Set();
  // Live check, fail closed: outputs.status (any stream sink running), falling back to host.status.live; both failing = refuse.
  async function ytOutputsStatus() {
    if (opts.youtube?.outputsStatus) return opts.youtube.outputsStatus();
    try { return await host.call('outputs.status', {}); } catch { /* try host.status */ }
    const hs = await host.call('host.status', {});
    return { sinks: hs?.live === true ? [{ kind: 'stream', active: true }] : [] };
  }
  // Task bar (progress of what the software is doing): its own long actions here, launcher jobs as files in <dataDir>/tasks.
  const tasks = opts.tasks ?? createTasks({ dataDir: typeof opts.dataDir === 'string' ? opts.dataDir : null, now });
  const openFolder = opts.openFolder ?? defaultOpenFolder;
  // Bot manager (BM2, flag `bot-manager`): Streamer.bot and Speaker.bot. opts.bots is a test seam (see createFakeBots).
  const bots = opts.bots ?? (typeof opts.dataDir === 'string' ? createBots({ dataDir: opts.dataDir }) : null);
  const botsOn = () => !!bots && !!flags && flags.isOn(BOT_FLAG);
  const postingOn = () => !!posting && !!flags && flags.isOn(POSTING_FLAG);
  // Report button (flag `report-button`, D199): builds a prefilled GitHub new-issue link; the page opens it. No network here.
  const reporter = opts.reporter ?? createReporter({ profileFile: opts.profileFile, releaseFile: opts.releaseFile });
  const reportOn = () => !!flags && flags.isOn(REPORT_FLAG);
  async function reportContext(q) {
    const h = lastSnapshot ?? await snapshot();
    let outputs = null; let crashes = null;
    try { outputs = await host.call('outputs.status', {}); } catch { outputs = null; }
    try {
      if (typeof opts.dataDir === 'string') crashes = readFileSync(path.join(opts.dataDir, 'logs', 'host-crashes.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length;
    } catch { crashes = 0; }
    return { title: q.get('title') ?? '', note: q.get('note') ?? '', flags: flags ? flags.list() : [], host: h.host, outputs, crashes };
  }
  // Pre-stream readiness (D299 proposed, flag `readiness`): readiness.mjs. Built on first use (the config file is read
  // then). opts.readiness = { run({ maxAgeMs }), config } is a test seam; opts.readinessDeps overrides single probes.
  const readinessOn = () => !!flags && flags.isOn(READINESS_FLAG);
  let readinessRunner = opts.readiness ?? null;
  function readiness() {
    if (readinessRunner) return readinessRunner;
    const config = loadReadinessConfig(opts.readinessConfigFile);
    const bc = loadBotConfig(opts.profileFile ? { profilePath: opts.profileFile } : {});
    const clipRoot = opts.clipRoot ?? (process.env.UJWALAM_CLIP_ROOT || REPO_ROOT);
    readinessRunner = createReadiness({
      host, core, config, now, dataDir: typeof opts.dataDir === 'string' ? opts.dataDir : null,
      flagOn: (id) => !!flags && flags.isOn(id),
      store: (ref) => createCredentialStore(ref), listProcesses: listProcessNames, diskFree: diskFreeBytes, tcp: tcpAnswers,
      botPorts: { streamerbot: bc.streamerbot?.port ?? null, speakerbot: bc.speakerbot?.port ?? null },
      ciPass: () => lastCiPass(REPO_ROOT), clipTools: () => clipTools({ clipRoot }), planTargets: planTargets(opts.livePlanFile),
      ...(opts.readinessDeps ?? {}),
    });
    return readinessRunner;
  }
  // Public form of a readiness result for the page (the Qt shell reads the summary text of the confirm window).
  const publicReadiness = (r) => ({ at: r.at, ok: r.ok, counts: r.counts, items: r.items.map((i) => ({ id: i.id, title: i.title, status: i.status, message: i.message, ...(i.fix ? { fix: i.fix } : {}), ...(i.unknown ? { unknown: true } : {}) })) });
  // End all streams (D299): the host's stream.stop with no sinks stops every stream sink (both YouTube, Twitch, Kick) and
  // closes their connections; the recording is not touched. Then outputs.status is polled until every stream sink is
  // stopped or the wait ends. Returns ids, platforms and states only.
  async function endAllStreams() {
    let waitMs = 6000; let pollMs = 500;
    try { ({ waitMs, pollMs } = readiness().config.endAll ?? { waitMs, pollMs }); } catch { /* defaults */ }
    await host.call('stream.stop', {});
    const until = now() + waitMs;
    let sinks = []; let recording = null;
    for (;;) {
      let st = null;
      try { st = await host.call('outputs.status', {}); } catch { st = null; }
      const all = Array.isArray(st?.sinks) ? st.sinks : [];
      sinks = all.filter((s) => s?.kind === 'stream').map((s) => ({ id: String(s.id).slice(0, 64), platform: typeof s.platform === 'string' ? s.platform.slice(0, 32) : null, state: String(s.state).slice(0, 16) }));
      recording = all.some((s) => s?.kind === 'record' && ['starting', 'live', 'retrying'].includes(s.state));
      const busy = sinks.some((s) => ['starting', 'live', 'retrying', 'stopping'].includes(s.state));
      if (!busy || now() >= until) return { allStopped: !busy, sinks, recording };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  if (typeof opts.launchKey !== 'string' || opts.launchKey.length < 32) throw new Error('launchKey must be at least 32 characters');
  let launchKey = opts.launchKey;
  let launchBorn = now(); // reset by rearmLaunchKey
  let loginFails = 0;
  let loginLockedUntil = 0;
  const sessions = new Map(); // sid -> { csrf }
  const pending = new Map(); // pendingId -> record
  const sseClients = new Set();
  let origin = null;
  let hostHeader = null;
  let pollTimer = null;
  let lastSnapshot = null;
  let live = false;
  const renamed = new Map(); // 'layer:<id>' | 'scene:<id>' -> new name, until the host reloads the project (D292)
  let lastImport = null; // { file, project, bases }: server side only, never sent to the page
  let previewSeen = null; // last host preview edit seq handled (null: not read yet)
  let previewBusy = null; // one previewSync at a time
  let previewLast = null; // { seq, scene, canvas, layer } of the newest host preview edit, for the status snapshot

  const sec = (res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
  };
  const text = (res, code, msg) => { sec(res); res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  const json = (res, code, obj) => {
    sec(res);
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };

  function cookieSid(req) {
    const h = req.headers.cookie;
    if (typeof h !== 'string' || h.length > 512) return null;
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) {
        const v = part.slice(i + 1).trim();
        return /^[0-9a-f]{64}$/.test(v) && sessions.has(v) ? v : null;
      }
    }
    return null;
  }

  function readBody(req, res) {
    return new Promise((resolve) => {
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') { text(res, 415, 'json-only'); return resolve(null); }
      const len = Number(req.headers['content-length']);
      if (!Number.isFinite(len) || len > limits.maxBodyBytes) { text(res, 413, 'too-large'); return resolve(null); }
      const chunks = []; let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > limits.maxBodyBytes) { text(res, 413, 'too-large'); req.destroy(); resolve(null); } else chunks.push(c);
      });
      req.on('end', () => {
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(isPlain(v) ? v : (text(res, 400, 'bad-json'), null)); } catch { text(res, 400, 'bad-json'); resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  // Clips (D283, D284): the launcher's <dataDir>/clips/status.json plus the user's settings. Names, counts and the
  // clips folder only.
  function clipStatus() {
    if (typeof opts.dataDir !== 'string') return null;
    const st = readSettings(opts.dataDir);
    const base = { settings: st.clips, settingsSaved: st.exists, folder: clipsFolder(opts.dataDir, st), available: null, reason: null, state: 'idle', running: null, queued: 0, asks: [], last: null };
    try {
      const s = JSON.parse(readFileSync(path.join(opts.dataDir, 'clips', 'status.json'), 'utf8'));
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
      const l = s.last && typeof s.last === 'object' ? s.last : null;
      return { ...base, available: s.available === true, reason: str(s.reason, 200), state: str(s.state, 16) ?? 'idle',
        running: s.running ? { name: str(s.running.name, 120), kind: str(s.running.kind, 16) } : null,
        queued: Array.isArray(s.queued) ? s.queued.length : 0,
        asks: (Array.isArray(s.asks) ? s.asks : []).slice(0, 5).map((a) => ({ id: str(a.id, 160), name: str(a.name, 120), kind: str(a.kind, 16), minutes: Number.isFinite(a.minutes) ? a.minutes : null })),
        posting: (() => { try { return readQueueSummary(opts.dataDir, flags); } catch { return null; } })(),
        last: l ? { name: str(l.name, 120), kind: str(l.kind, 16), result: str(l.result, 16), reason: str(l.reason, 200), clips: Number(l.clips) || 0, out: str(l.out, 400), folder: str(l.folder, 400) } : null };
    } catch { return base; }
  }

  // Settings (D284): clip choices and folders. Refused while live (a change would load the GPU or move files mid-show).
  async function settingsRoute(res, body) {
    if (typeof opts.dataDir !== 'string') return json(res, 404, { error: 'no-data-dir' });
    if (live && !guideOnly(body)) return json(res, 409, { error: 'live', detail: 'Change settings after the stream.' }); // guide: tips only change what the window shows
    const problems = settingsProblems(body, { forbidden: [REPO_ROOT] });
    if (problems.length) return json(res, 400, { error: 'bad-settings', detail: problems.join('; ').slice(0, 400) });
    if (guideOnly(body)) { try { return json(res, 200, { settings: writeSettings(opts.dataDir, body) }); } catch (e) { return json(res, 500, { error: 'not-saved', detail: String(e.message).slice(0, 200) }); } } // guide: no task, no toast
    const t = tasks.start({ title: 'Saving your settings', kind: 'settings' });
    try { const settings = writeSettings(opts.dataDir, body); t.done(); return json(res, 200, { settings }); } catch (e) { t.fail('Could not save'); return json(res, 500, { error: 'not-saved', detail: String(e.message).slice(0, 200) }); }
  }
  // Tips and tours (D294 proposed): data/guide/tour.json and hints.json, plain text for the studio window. A missing or
  // broken file gives an empty list: the window then shows no tips, and nothing else changes.
  function guideData() {
    const read = (n, key) => { try { const j = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'guide', n), 'utf8')); return Array.isArray(j[key]) ? j[key] : []; } catch { return []; } };
    return { tours: read('tour.json', 'tours'), hints: read('hints.json', 'hints') };
  }
  // The answer to "make clips from it?": the launcher picks it up (record-clips.mjs).
  function clipAnswer(res, body) {
    if (typeof opts.dataDir !== 'string') return json(res, 404, { error: 'no-data-dir' });
    const keys = ['id', 'make', 'remember'];
    if (typeof body.id !== 'string' || body.id.length > 160 || typeof body.make !== 'boolean' || (body.remember !== undefined && typeof body.remember !== 'boolean') || Object.keys(body).some((k) => !keys.includes(k))) return json(res, 400, { error: 'bad-params' });
    const dir = path.join(opts.dataDir, 'clips');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'answer.json.tmp'), JSON.stringify({ id: body.id, make: body.make, remember: body.remember === true }));
    renameSync(path.join(dir, 'answer.json.tmp'), path.join(dir, 'answer.json'));
    return json(res, 200, { ok: true });
  }

  // ---- status snapshot (text-free: counts, flags and numbers only; never chat text) ----
  async function snapshot() {
    const h = host.describe();
    let hs = null; let cs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    try { cs = core.describe().available ? await core.call('core.status', {}) : null; } catch { cs = null; }
    if (hs && typeof hs.live === 'boolean') live = hs.live;
    if (hs) feedbackCollect.observe(hs.live);
    if (hs) await previewSync(hs);
    if (hs) await transitionSync(hs);
    const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && Object.hasOwn(o, k)).map((k) => [k, o[k]]));
    const snap = {
      at: now(),
      host: { kind: h.kind, available: hs !== null, blockedOnHost: h.kind === 'fake',
        ...(hs ? pick(hs, ['live', 'recording', 'droppedFrames', 'totalFrames', 'fps', 'cpuPct', 'gpuPct', 'outputsReady', 'previewEditing', 'uptimeMs']) : {}),
        ...(hs && hs.audioHealth ? { audioHealth: audioReadiness(hs.audioHealth) } : {}),
        ...(previewLast ? { previewEdit: previewLast } : {}),
        effectEditing: !!flags && flags.isOn('effect-editor') },
      clips: clipStatus(),
      recovery: typeof opts.dataDir === 'string' ? readRecoveryStatus(opts.dataDir, liveSession) : null,
      tasks: tasks.list(),
      core: { available: cs !== null, ...(cs ? { liveState: typeof cs.live?.liveState === 'string' ? cs.live.liveState : null, panic: cs.live?.panic === true } : {}) },
    };
    if (testKitOn()) snap.alerts = liveAlerts(snap, { kit: testKit(), liveSinceMs: feedbackCollect.liveSince(), nowMs: now(), feedback: feedbackCollect.last() });
    return snap;
  }
  // Host preview mouse edits (D230). Called with each host.status: (1) the host's editing switch follows flag
  // preview-edit (a restarted host starts off and is switched on again here); (2) when previewEditSeq moved, the new
  // edits are read with preview.edits and recorded into the project file through the same projectSync.record as an
  // inspector layers.setPlacement (they already went through the host's layer_set_placement). The first read only
  // notes the current seq: edits from before this server started are not replayed over newer saves. A host restart
  // (seq went down) reads from 0. Pages and the Qt shell see the newest edit in the status snapshot (previewEdit) and
  // as an SSE 'layers' event, and reload the layer list. Failures are ignored here and retried on the next poll.
  // The project's transitions, re-read when the project file changes (mtime). opts.transitions = { h, v } is a test seam.
  let projTr = { mtimeMs: -1, value: {} };
  function projectTransitions() {
    if (opts.transitions) return opts.transitions;
    const file = projectSync?.status?.().file;
    if (typeof file !== 'string') return {};
    try {
      const m = statSync(file).mtimeMs;
      if (m !== projTr.mtimeMs) {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        const value = {};
        for (const c of Array.isArray(doc?.canvases) ? doc.canvases : []) if (isPlain(c?.transition) && (c.id === 'h' || c.id === 'v')) value[c.id] = c.transition;
        projTr = { mtimeMs: m, value };
      }
    } catch { /* unreadable: keep the last value */ }
    return projTr.value;
  }
  // Keeps host.status.transitions equal to what flag + project want; a mismatch is set again on the next poll.
  // A stinger the host refused (file missing, module absent) is not asked for again until the project changes it; the
  // canvas cuts meanwhile (D242).
  const trRefused = {};
  const trKey = (t) => JSON.stringify([t.type, t.durationMs, t.file ?? null, t.pointMs ?? null, t.audio ?? null]);
  async function transitionSync(hs) {
    if (!isPlain(hs.transitions)) return; // older host or fake: nothing to sync
    const on = !!flags && flags.isOn(TRANSITIONS_FLAG);
    const want = on ? projectTransitions() : {};
    for (const [hid, cur] of Object.entries(hs.transitions)) {
      const t = want[hid.toLowerCase()];
      let p = { type: 'cut', durationMs: 0 };
      if (t?.type === 'fade' && Number.isInteger(t.durationMs)) p = { type: 'fade', durationMs: Math.min(10000, Math.max(0, t.durationMs)) };
      else if (t?.type === 'stinger' && isPlain(t.file) && typeof t.file.base === 'string' && typeof t.file.rel === 'string' && Number.isInteger(t.pointMs)) {
        p = { type: 'stinger', durationMs: 0, file: { base: t.file.base, rel: t.file.rel }, pointMs: Math.min(10000, Math.max(0, t.pointMs)), audio: t.audio !== false };
      }
      if (p.type === 'stinger' && trRefused[hid] === trKey(p)) p = { type: 'cut', durationMs: 0 };
      const same = cur?.type === p.type && cur?.durationMs === p.durationMs
        && (p.type !== 'stinger' || (cur?.file === `${p.file.base}:${p.file.rel}` && cur?.pointMs === p.pointMs && (cur?.audio ?? true) === p.audio));
      if (same) continue;
      try { await host.call('transitions.set', { canvas: hid, ...p }); } catch { if (p.type === 'stinger') trRefused[hid] = trKey(p); }
    }
  }
  async function previewSync(hs) {
    if (host.describe().kind !== 'host') return;
    if (previewBusy) return previewBusy;
    previewBusy = (async () => {
      try {
        // Off while live (live-lock, D233; the host also refuses a press while a stream output is live).
        const want = !!flags && flags.isOn(PREVIEW_EDIT_FLAG) && hs.live !== true;
        if (typeof hs.previewEditing === 'boolean' && hs.previewEditing !== want) {
          try { await host.call('preview.setEditing', { enabled: want }); } catch { /* next poll */ }
        }
        const seq = hs.previewEditSeq;
        if (!Number.isSafeInteger(seq) || seq < 0) return;
        if (previewSeen === null) { previewSeen = seq; return; }
        if (seq < previewSeen) previewSeen = 0;
        if (seq === previewSeen) return;
        const r = await host.call('preview.edits', { since: previewSeen });
        const edits = Array.isArray(r?.edits) ? r.edits : [];
        for (const e of edits) {
          if (!e || typeof e.scene !== 'string' || typeof e.layer !== 'string' || typeof e.canvas !== 'string' || !isPlain(e.placement)) continue;
          const params = { scene: e.scene, canvas: e.canvas.toLowerCase(), layer: e.layer, placement: e.placement };
          if (projectSync) projectSync.record('layers.setPlacement', params);
          if (isPlain(e.before)) remember('layers.setPlacement', params, { placement: pickKeys(e.before, Object.keys(e.placement)) });
          previewLast = { seq: e.seq, scene: e.scene, canvas: params.canvas, layer: e.layer };
        }
        if (edits.length) broadcast('layers', { source: 'preview', edit: previewLast });
        previewSeen = Number.isSafeInteger(r?.seq) ? r.seq : seq;
      } catch { /* host busy or gone: next poll */ }
    })().finally(() => { previewBusy = null; }); // after the assignment, even when the body never awaited
    return previewBusy;
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) { if (!c.write(frame)) { /* slow client: dropped by the stall timer below */ } }
  }
  async function tick() {
    try { lastSnapshot = await snapshot(); broadcast('status', lastSnapshot); } catch { /* keep polling */ }
  }

  // Host call with a retry on CONFLICT (-32009) for project.load.
  // Undo history (D238): the layer's value before an edit, read from the host just before the call. A failed read
  // only means the edit is not undoable; the edit itself goes ahead.
  // What the project file records for an accepted edit: the request, except track routing, which is keyed by the
  // project audio source the host resolved (a mixer id names a scene/layer or a device, D273).
  const syncParams = (method, params, result) => method === 'mixer.setTracks'
    ? { audioSource: result?.audioSource, tracks: result?.tracks, monitoring: result?.monitoring } : params;
  async function readBefore(method, params) {
    if (!UNDOABLE.includes(method)) return null;
    try { return beforeOf(method, params, await host.call('layers.list', { scene: params.scene, ...(params.canvas ? { canvas: params.canvas } : {}) })); } catch { return null; }
  }
  function remember(method, params, before) {
    if (before && history.record({ method, scene: params.scene, canvas: params.canvas, layer: params.layer, before, after: afterOf(method, params) })) broadcast('edits', history.state());
  }
  // Structure edits (D240). Order: fresh host.status (refused while live, fail closed) -> pending layer edits written ->
  // project file read -> pure change (services/project/structure.mjs, validated) -> host -> file saved. The host goes
  // first so a refusal there saves nothing; a failed save leaves the host change live-only and says so. Undo history
  // is cleared: its entries may name a layer or scene that is gone.
  // Transitions form (D242, flag transitions): each canvas's project transition, and the videos a stinger may use (the
  // stream assets folder, base "media").
  function transitionChoices(res) {
    const on = !!flags && flags.isOn(TRANSITIONS_FLAG);
    const file = projectSync?.status?.().file;
    if (!on || typeof file !== 'string') return json(res, 200, { on, available: false });
    let doc;
    try { projectSync.flush(); doc = loadProject(file).project; } catch { return json(res, 200, { on, available: false }); }
    return json(res, 200, { on, available: true, canvases: doc.canvases.map((c) => ({ id: c.id, transition: c.transition ?? { type: 'cut', durationMs: 0 } })),
      videos: listAssets(assetsDir).filter((a) => a.kind === 'media').map((a) => a.rel) });
  }
  // Sets one canvas's project transition (refused while live); the status poll then applies it to the host.
  async function transitionEdit(res, body) {
    const t = tasks.start({ title: 'Applying the scene transition', kind: 'transition' });
    try { return await transitionEditRun(res, body); } finally { if (res.statusCode < 400) t.done(); else t.fail('Not applied'); }
  }
  async function transitionEditRun(res, body) {
    if (!flags || !flags.isOn(TRANSITIONS_FLAG)) return json(res, 404, { error: 'transitions-off' });
    const file = projectSync?.status?.().file;
    if (typeof file !== 'string') return json(res, 409, { error: 'no-project-file' });
    const keys = ['canvas', 'type', 'durationMs', 'file', 'pointMs', 'audio'];
    if (!isPlain(body) || Object.keys(body).some((k) => !keys.includes(k)) || !['h', 'v'].includes(body.canvas) || !['cut', 'fade', 'stinger'].includes(body.type)) return json(res, 400, { error: 'bad-params' });
    const ms = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
    if (body.type === 'fade' && !ms(body.durationMs)) return json(res, 400, { error: 'bad-params' });
    if (body.type === 'stinger' && (!ms(body.pointMs) || typeof body.file !== 'string' || (body.audio !== undefined && typeof body.audio !== 'boolean'))) return json(res, 400, { error: 'bad-params' });
    if (body.type !== 'stinger' && body.audio !== undefined) return json(res, 400, { error: 'bad-params' });
    if (body.type === 'stinger' && !listAssets(assetsDir).some((a) => a.kind === 'media' && a.rel === body.file)) return json(res, 409, { error: 'unknown-asset' });
    let hs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    if (!hs || hs.live !== false) return json(res, 409, { error: hs ? 'live-locked' : 'host-unavailable' });
    projectSync.reload();
    let doc;
    try { doc = loadProject(file).project; } catch { return json(res, 409, { error: 'project-unreadable' }); }
    const c = doc.canvases.find((x) => x.id === body.canvas);
    if (!c) return json(res, 409, { error: 'unknown-canvas' });
    c.transition = body.type === 'stinger' ? { type: 'stinger', durationMs: 0, file: { base: 'media', rel: body.file }, pointMs: body.pointMs, ...(body.audio === false ? { audio: false } : {}) }
      : { type: body.type, durationMs: body.type === 'fade' ? body.durationMs : 0 };
    try { saveProject(file, doc); } catch { return json(res, 409, { error: 'not-saved' }); }
    projectSync.reload();
    return json(res, 200, { ok: true, canvas: c.id, transition: c.transition });
  }
  // What the add-layer form can offer (D240): ids and names from the project file only (shown on this local page).
  function structureChoices(res) {
    const on = !!flags && flags.isOn(SCENE_EDIT_FLAG); // `on` now only says whether removing is allowed; choices need no flag (D292)
    const file = projectSync?.status?.().file;
    if (typeof file !== 'string') return json(res, 200, { on, available: false });
    let doc;
    try { projectSync.flush(); doc = loadProject(file).project; } catch { return json(res, 200, { on, available: false }); }
    return json(res, 200, { on, available: true, canvases: doc.canvases.map((c) => c.id),
      scenes: doc.scenes.map((s) => ({ id: s.id, name: s.name, active: s.id === doc.activeScene })),
      layers: doc.scenes.flatMap((s) => s.layers.map((l) => ({ id: l.id, name: l.name, scene: s.id, sceneName: s.name, type: l.type }))),
      devices: (doc.devices ?? []).filter((d) => d.kind === 'camera' || d.kind === 'capture-card').map((d) => ({ id: d.id, name: d.name })),
      overlays: (doc.overlays ?? []).map((o) => ({ id: o.id, name: o.name })),
      assets: listAssets(assetsDir) });
  }
  async function structureEdit(res, body) {
    if (!isPlain(body) || !STRUCTURE_OPS.includes(body.op)) return json(res, 400, { error: 'bad-params' });
    if (!FREE_STRUCTURE_OPS.includes(body.op) && (!flags || !flags.isOn(SCENE_EDIT_FLAG))) return json(res, 404, { error: 'scene-edit-off' });
    const file = projectSync?.status?.().file;
    if (typeof file !== 'string') return json(res, 409, { error: 'no-project-file' });
    if (!isPlain(body) || !STRUCTURE_OPS.includes(body.op) || Object.keys(body).some((k) => k !== 'op' && !STRUCTURE_KEYS[body.op].includes(k))) return json(res, 400, { error: 'bad-params' });
    for (const k of ['name', 'scene', 'kind', 'of', 'color', 'text', 'device', 'overlay', 'layer', 'file', 'canvas', 'direction']) {
      if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length > (k === 'text' ? 2000 : k === 'file' ? 260 : 120))) return json(res, 400, { error: 'bad-params' });
    }
    // An asset layer may only name a file the assets listing offers right now (never a path the page made up).
    if (body.kind === 'image' || body.kind === 'media') {
      const hit = listAssets(assetsDir).find((a) => a.rel === body.file);
      if (!hit || hit.kind !== body.kind) return json(res, 409, { error: 'unknown-asset' });
    }
    let hs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    if (!hs || hs.live !== false) return json(res, 409, { error: hs ? 'live-locked' : 'host-unavailable' });
    projectSync.reload();
    let doc;
    try { doc = loadProject(file).project; } catch { return json(res, 409, { error: 'project-unreadable' }); }
    const { op } = body;
    const r = op === 'scene.add' ? addScene(doc, body) : op === 'scene.remove' ? removeScene(doc, body)
      : op === 'layer.add' ? addLayer(doc, body) : op === 'layer.move' ? moveLayer(doc, body)
      : op === 'layer.duplicate' ? duplicateLayer(doc, body) : op === 'layer.rename' ? renameLayer(doc, body)
      : op === 'scene.duplicate' ? duplicateScene(doc, body) : op === 'scene.rename' ? renameScene(doc, body) : removeLayer(doc, body);
    if (r.error) return json(res, 409, { error: r.error, ...(r.errors ? { detail: r.errors.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300) } : {}) });
    const canvases = doc.canvases.map((c) => c.id.toUpperCase());
    try {
      if (op === 'scene.add') for (const canvas of canvases) await host.call('scenes.create', { scene: { id: r.scene.id, canvas, name: r.scene.name } });
      else if (op === 'scene.remove') await host.call('scenes.remove', { scene: body.scene });
      else if (op === 'layer.add') await host.call('layers.addFromProject', { project: r.project, scene: body.scene, layer: r.layer.id });
      else if (op === 'layer.move') await host.call('layers.orderFromProject', { project: r.project, scene: body.scene });
      else if (op === 'layer.duplicate') {
        await host.call('layers.addFromProject', { project: r.project, scene: body.scene, layer: r.layer.id });
        await host.call('layers.orderFromProject', { project: r.project, scene: body.scene }); // the copy lands just above its source
      } else if (op === 'scene.duplicate') {
        for (const canvas of canvases) await host.call('scenes.create', { scene: { id: r.scene.id, canvas, name: r.scene.name } });
        for (const l of r.layers) await host.call('layers.addFromProject', { project: r.project, scene: r.scene.id, layer: l.id }); // bottom first
      } else if (op === 'layer.rename' || op === 'scene.rename') {
        // The host has no rename call: it takes the name from the saved project at its next load. Until then the lists
        // below carry the new name (renamed), so the studio shows it at once.
        renamed.set(op === 'layer.rename' ? `layer:${body.layer}` : `scene:${body.scene}`, r.layer?.name ?? r.scene.name);
      } else await host.call('layers.remove', { scene: body.scene, layer: body.layer });
    } catch (e) {
      return json(res, 502, { error: 'host-error', detail: String(e?.message ?? e?.code ?? 'error').slice(0, 160) });
    }
    let saved = true;
    try { saveProject(file, r.project); } catch { saved = false; }
    projectSync.reload(); // its cached document is older than the file now
    history.clear();
    broadcast('edits', history.state());
    broadcast('layers', { source: 'structure', edit: { op, scene: r.scene?.id ?? body.scene, layer: r.layer?.id ?? body.layer ?? null } });
    return json(res, 200, { ok: true, op, ...(r.scene ? { scene: { id: r.scene.id, name: r.scene.name } } : {}), ...(r.layer ? { layer: { id: r.layer.id, name: r.layer.name, type: r.layer.type } } : {}), saved });
  }
  function withRenames(method, result) {
    if (!renamed.size || !isPlain(result)) return result;
    const fix = (o, kind) => (isPlain(o) && typeof o.id === 'string' && renamed.has(`${kind}:${o.id}`) ? { ...o, name: renamed.get(`${kind}:${o.id}`) } : o);
    if (method === 'layers.list' && Array.isArray(result.layers)) return { ...result, layers: result.layers.map((l) => fix(l, 'layer')) };
    if (method === 'scenes.list' && Array.isArray(result.scenes)) return { ...result, scenes: result.scenes.map((x) => fix(x, 'scene')) };
    return result;
  }
  async function callHost(method, params) {
    const waits = method === 'project.load' ? limits.loadRetryMs : [];
    for (let i = 0; ; i++) {
      try { return await host.call(method, params); } catch (e) {
        if (i >= waits.length || e?.code !== 'RPC_-32009') throw e;
        await new Promise((r) => setTimeout(r, waits[i]));
      }
    }
  }

  // ---- confirmations ----
  function addPending(rec) {
    const t = now();
    for (const [id, p] of pending) if (p.expiresAt <= t) pending.delete(id);
    if (pending.size >= limits.pendingMax) return null;
    const id = newId(16);
    pending.set(id, { ...rec, expiresAt: t + limits.pendingTtlMs });
    return id;
  }
  const publicPending = (id, p) => ({ pendingId: id, summary: p.summary, phrase: p.phrase, expiresAt: p.expiresAt, ...(p.step ? { step: p.step, of: 2 } : {}), ...(p.readiness ? { readiness: publicReadiness(p.readiness) } : {}) });

  async function handleCoreOutcome(r, summary) {
    // r: { verdict, reason, confirm?, dispatch? } from the event core. The page gets verdict/reason and, when a
    // confirmation is needed, the phrase to type. confirmId and actionHash stay on the server.
    if (r && r.confirm && typeof r.confirm.confirmId === 'string') {
      const id = addPending({ kind: 'core', summary, phrase: normPhrase(r.confirm.phrase), confirmId: r.confirm.confirmId, actionHash: r.confirm.actionHash, step: r.confirm.step });
      if (!id) return { verdict: 'refuse', reason: 'too-many-pending' };
      return { verdict: 'confirm', reason: r.reason, pending: publicPending(id, pending.get(id)) };
    }
    return { verdict: r?.verdict ?? 'unknown', reason: r?.reason ?? null, ...(r && r.dispatch !== undefined ? { dispatch: r.dispatch } : {}) };
  }

  function applyFlag(id, on) {
    const out = flags.set(id, on);
    // Preview mouse editing switches at once (off is instant safety); previewSync re-checks on every poll anyway.
    if (id === PREVIEW_EDIT_FLAG && host.describe().kind === 'host') host.call('preview.setEditing', { enabled: on && !live }).catch(() => {});
    broadcast('flags', { flags: out });
    return out;
  }

  // ---- API routes ----
  async function api(req, res, url, sid) {
    const s = sessions.get(sid);
    const route = url.pathname;
    if (req.method === 'GET' && route === '/ui/api/session') {
      return json(res, 200, { csrf: s.csrf, host: host.describe(), core: core.describe(), limits: { confirmTtlMs: limits.pendingTtlMs } });
    }
    if (req.method === 'GET' && route === '/ui/api/status') return json(res, 200, lastSnapshot ?? await snapshot());
    if (req.method === 'GET' && route === '/ui/api/events') return sse(req, res);
    if (req.method === 'GET' && route === '/ui/api/tasks') return json(res, 200, { tasks: tasks.list() });
    if (req.method === 'GET' && route === '/ui/api/flags') return json(res, 200, { flags: flags ? flags.list() : [] });
    if (req.method === 'GET' && route === '/ui/api/guide') return json(res, 200, guideData()); // guide (D294 proposed)
    if (req.method === 'GET' && route === '/ui/api/readiness') {
      if (!readinessOn()) return json(res, 404, { error: 'readiness-off' });
      try { return json(res, 200, publicReadiness(await readiness().run({ maxAgeMs: 0 }))); } catch { return json(res, 500, { error: 'readiness-failed' }); }
    }
    if (req.method === 'GET' && route === '/ui/api/settings') return json(res, 200, typeof opts.dataDir === 'string' ? { settings: readSettings(opts.dataDir), clips: clipStatus() } : { settings: null });
    if (req.method === 'GET' && route === '/ui/api/edits') return json(res, 200, history.state());
    if (req.method === 'GET' && route === '/ui/api/project/structure') return structureChoices(res);
    if (req.method === 'GET' && route === '/ui/api/project/transitions') return transitionChoices(res);
    if (req.method === 'GET' && route === '/ui/api/feedback') return json(res, 200, { moments: feedback.list() });
    if (route === '/ui/api/report-url') {
      if (!reportOn()) return json(res, 404, { error: 'report-button-off' });
      if (req.method !== 'GET') return text(res, 405, 'method-not-allowed');
      if ([...url.searchParams.keys()].some((k) => k !== 'title' && k !== 'note')
        || (url.searchParams.get('title') ?? '').length > MAX_TITLE * 4 || (url.searchParams.get('note') ?? '').length > MAX_NOTE * 4) return json(res, 400, { error: 'bad-params' });
      try { return json(res, 200, reporter.build(await reportContext(url.searchParams))); } catch { return json(res, 500, { error: 'report-failed' }); }
    }
    if (route.startsWith('/ui/api/posts') && !postingOn()) return json(res, 404, { error: 'posting-off' });
    if (route.startsWith('/ui/api/bots') && !botsOn()) return json(res, 404, { error: 'bot-manager-off' });
    if (req.method === 'GET' && route === '/ui/api/bots') {
      try { return json(res, 200, { bots: await bots.statusAll() }); } catch { return json(res, 502, { error: 'bots-error' }); }
    }
    if (req.method === 'GET' && route === '/ui/api/posts') {
      // D300: each post carries its auto-upload queue state; `queue` is the plain-language summary (e.g. not signed in to YouTube).
      let qs = new Map(); let queue = null;
      if (typeof opts.dataDir === 'string') {
        try { qs = new Map(createUploadQueue(path.join(opts.dataDir, 'posting', QUEUE_NAME)).items().map((i) => [i.id, i])); queue = readQueueSummary(opts.dataDir, flags); } catch { /* the list still works */ }
      }
      return json(res, 200, { posts: posting.list().map((p) => { const q = qs.get(p.id); const url = p.videoId ? `https://youtu.be/${p.videoId}` : null; return q ? { ...p, videoUrl: url, queueState: q.state, queueAttempts: q.attempts, queueNextAt: q.nextAt, queueReason: q.reason, queueReasonText: reasonText(q.reason) } : { ...p, videoUrl: url }; }), queue });
    }
    if (req.method === 'GET' && route === '/ui/api/posts/auto') {
      // Read-only: the auto-post mode and what a run would do now. Enabling stays a flag; nothing is changed here.
      try {
        const rules = loadRules(opts.autoRulesFile);
        const mode = describeMode({ flagOn: !!flags && flags.isOn(AUTO_FLAG), rules });
        const log = typeof opts.dataDir === 'string' ? createAutoLog(path.join(opts.dataDir, 'posting', AUTO_LOG_NAME)).list() : [];
        return json(res, 200, { mode, plan: planAuto({ posts: posting.list(), rules: rules.rules, autoUpload: rules.autoUpload, log, now: new Date(now()) }).filter((x) => x.action !== 'skip' || x.reason === 'max-per-day') });
      } catch { return json(res, 200, { mode: { enabled: false, flagOn: false, autoUpload: false, ruleCount: 0, privacy: 'private', error: 'rules-unreadable' }, plan: [] }); }
    }
    if (req.method === 'GET' && route === '/ui/api/posts/media') return postMedia(req, res, url);
    if (req.method === 'GET' && route === '/ui/api/posts/youtube/status') {
      try { const st = await youtubeAuth().status(); return json(res, 200, { signedIn: st.signedIn === true, hasClient: st.hasClient === true, phrase: UPLOAD_PHRASE }); } catch { return json(res, 502, { error: 'youtube-status-failed' }); }
    }
    if (req.method !== 'POST') return text(res, 405, 'method-not-allowed');
    // Mutating: Origin == our origin, CSRF header (timing-safe), JSON body.
    if (req.headers.origin !== origin) return text(res, 403, 'bad-origin');
    const h = req.headers[CSRF_HEADER];
    if (typeof h !== 'string' || !sameSecret(h, s.csrf)) return text(res, 403, 'bad-csrf');
    const body = await readBody(req, res);
    if (body === null) return undefined;

    if (route === '/ui/api/edits/undo' || route === '/ui/api/edits/redo') {
      // Not while live (D238): a live layout change needs the typed on-air phrase, so undo there is the inspector's
      // job. Fresh host.status, fail closed.
      let hs = null;
      try { hs = await host.call('host.status', {}); } catch { hs = null; }
      if (!hs || hs.live !== false) return json(res, 409, { error: hs ? 'live-locked' : 'host-unavailable', edits: history.state() });
      const undo = route.endsWith('/undo');
      const e = undo ? history.peekUndo() : history.peekRedo();
      if (!e) return json(res, 409, { error: undo ? 'nothing-to-undo' : 'nothing-to-redo', edits: history.state() });
      const params = paramsOf(e, undo ? 'before' : 'after');
      try { await host.call(e.method, params); } catch (err) {
        // The layer or scene is gone (or the host refused): this edit cannot be undone any more; drop the history.
        history.clear();
        broadcast('edits', history.state());
        return json(res, 409, { error: 'edit-gone', detail: String(err?.code ?? err?.message ?? 'error').slice(0, 80), edits: history.state() });
      }
      if (undo) history.commitUndo(); else history.commitRedo();
      const saved = projectSync && host.describe().kind === 'host' ? projectSync.record(e.method, params) : false;
      broadcast('edits', history.state());
      broadcast('layers', { source: undo ? 'undo' : 'redo', edit: { scene: e.scene, canvas: e.canvas ?? null, layer: e.layer } });
      return json(res, 200, { ok: true, method: e.method, scene: e.scene, layer: e.layer, edits: history.state(), ...(saved ? { saved: 'pending' } : {}) });
    }
    if (route === '/ui/api/settings') return settingsRoute(res, body);
    if (route === '/ui/api/clips/answer') return clipAnswer(res, body);
    if (route === '/ui/api/clips/open') {
      if (typeof opts.dataDir !== 'string') return json(res, 404, { error: 'no-data-dir' });
      const dir = clipsFolder(opts.dataDir);
      mkdirSync(dir, { recursive: true });
      return openFolder(dir) ? json(res, 200, { ok: true }) : json(res, 502, { error: 'open-failed' });
    }
    if (route === '/ui/api/project/structure') return structureEdit(res, body);
    if (route === '/ui/api/project/transition') return transitionEdit(res, body);
    if (route === '/ui/api/host') {
      const spec = typeof body.method === 'string' && Object.hasOwn(HOST_CALLS, body.method) ? HOST_CALLS[body.method] : null;
      if (!spec) return json(res, 400, { error: 'unknown-method' });
      const params = body.params ?? {};
      const bad = validate(spec.schema, params);
      if (bad) return json(res, 400, { error: bad });
      if (spec.flag && !(flags && flags.isOn(spec.flag))) return json(res, 404, { error: `${spec.flag}-off` });
      if (spec.confirm || (live && spec.liveConfirm)) {
        // Stream and recording changes need a typed phrase; while live, the on-air phrase (also for layout changes).
        let phrase = (live || spec.confirm === 'onair') ? 'yes, on air' : 'yes';
        let summary = spec.summary; let ready = null;
        // Go-live readiness (flag readiness): the confirm window shows the check first. A failed item asks for the
        // override phrase instead of "yes, on air"; confirming with it is logged. Warnings never change the phrase.
        if (body.method === 'stream.start' && readinessOn()) {
          try { ready = await readiness().run({ maxAgeMs: readiness().config?.goLiveMaxAgeMs ?? 0 }); } catch { ready = null; }
          if (!ready) return json(res, 503, { error: 'readiness-failed', detail: 'The readiness check could not run; switch the readiness flag off to go live without it.' });
          summary = `${spec.summary}.\n\n${readinessSummary(ready)}`;
          if (!ready.ok) phrase = OVERRIDE_PHRASE;
        }
        // Pre-stream / pre-recording audio readiness (D297): a device sound that delivers nothing is named in the
        // confirmation, so "Game audio missing" is seen before going live. Never blocks the start by itself.
        if (body.method === 'stream.start' || body.method === 'record.start') {
          let hs = null;
          try { hs = await host.call('host.status', {}); } catch { hs = null; }
          const w = hs && hs.audioHealth ? audioReadiness(hs.audioHealth).warnings : [];
          if (w.length) summary = `${summary}. WARNING: ${w.join(', ')}`;
        }
        const id = addPending({ kind: 'host', summary, phrase, method: body.method, params, ...(ready ? { readiness: ready, readinessOverride: !ready.ok } : {}) });
        if (!id) return json(res, 429, { error: 'too-many-pending' });
        return json(res, 200, { verdict: 'confirm', pending: publicPending(id, pending.get(id)) });
      }
      let result;
      const before = await readBefore(body.method, params);
      const pt = body.method === 'preview.open' ? tasks.start({ title: `Opening the ${params.canvas === 'v' ? 'vertical' : 'horizontal'} preview`, kind: 'preview' }) : null;
      try { result = await host.call(body.method, params) ?? null; } catch (e) { pt?.fail('Could not open'); return json(res, 502, { error: 'host-error', detail: String(e?.code ?? e?.message ?? 'error').slice(0, 80) }); }
      pt?.done();
      result = withRenames(body.method, result);
      remember(body.method, params, before);
      // P5b autosave: only after the host accepted the edit; the real host only (the fake has no project file).
      const saved = projectSync && host.describe().kind === 'host' ? projectSync.record(body.method, syncParams(body.method, params, result)) : false;
      return json(res, 200, saved ? { result, saved: 'pending' } : { result });
    }
    if (route === '/ui/api/streams/end-all') {
      // End all streams (D299, no flag: it is the host's existing stream.stop, plus a check that every stream sink
      // stopped). A studio write like Stop stream: typed "yes", or "yes, on air" while live. Recording keeps running.
      if (Object.keys(body).length) return json(res, 400, { error: 'bad-params' });
      const id = addPending({ kind: 'end-all', summary: 'End all streams: both YouTube outputs, Twitch and Kick stop and their connections close. The recording keeps running (stop it separately).', phrase: live ? 'yes, on air' : 'yes' });
      if (!id) return json(res, 429, { error: 'too-many-pending' });
      return json(res, 200, { verdict: 'confirm', pending: publicPending(id, pending.get(id)) });
    }
    if (route === '/ui/api/bots/start' || route === '/ui/api/bots/stop') {
      // Studio write: typed "yes", or "yes, on air" while live. Stop only ever ends a copy Ujwalam started (checked in the module).
      const bad = validate(BOT_SCHEMA, body);
      if (bad) return json(res, 400, { error: bad });
      const verb = route.endsWith('/start') ? 'start' : 'stop';
      // Stop asks the bot to close, then force-closes it after the grace time (Streamer.bot 0.2.8 ignores the request,
      // BM1 runtime evidence): a forced close can lose unsaved bot changes, so the confirm says so first.
      const summary = verb === 'start' ? `Start ${BOT_LABELS[body.bot]}`
        : `Stop ${BOT_LABELS[body.bot]}. If it does not close within ${GRACEFUL_MS / 1000} s it is force-closed: save your ${BOT_LABELS[body.bot]} changes first.`;
      const id = addPending({ kind: 'bot', summary, phrase: live ? 'yes, on air' : 'yes', bot: body.bot, verb });
      if (!id) return json(res, 429, { error: 'too-many-pending' });
      return json(res, 200, { verdict: 'confirm', pending: publicPending(id, pending.get(id)) });
    }
    if (route === '/ui/api/flags/set') {
      if (!flags) return json(res, 503, { error: 'flags-unavailable' });
      const bad = validate(FLAG_SET_SCHEMA, body);
      if (bad) return json(res, 400, { error: bad });
      if (!flags.ids().includes(body.id)) return json(res, 404, { error: 'unknown-flag' });
      if (!body.on) return json(res, 200, { verdict: 'allow', flags: applyFlag(body.id, false) }); // OFF is instant safety: never confirmed
      if (flags.isOn(body.id)) return json(res, 200, { verdict: 'allow', flags: flags.list() });
      const id = addPending({ kind: 'flag', summary: `Turn feature flag ${body.id} on`, phrase: live ? 'yes, on air' : 'yes', flagId: body.id });
      if (!id) return json(res, 429, { error: 'too-many-pending' });
      return json(res, 200, { verdict: 'confirm', pending: publicPending(id, pending.get(id)) });
    }
    if (route === '/ui/api/feedback/note') {
      if (Object.keys(body).some((k) => !NOTE_KEYS.includes(k))) return json(res, 400, { error: 'bad-params' });
      const err = feedback.saveNote(body.id, { text: body.text, tag: body.tag, severity: body.severity });
      if (err) return json(res, err === 'unknown-moment' ? 404 : (err === 'write-failed' ? 500 : 400), { error: err });
      return json(res, 200, { ok: true, moments: feedback.list() });
    }
    if (route === '/ui/api/posts/youtube/upload' || route === '/ui/api/posts/youtube/check') {
      const isUpload = route.endsWith('/upload');
      if (typeof body.id !== 'string' || body.id.length > 64 || Object.keys(body).some((k) => !(isUpload ? ['id', 'confirm'] : ['id']).includes(k))) return json(res, 400, { error: 'bad-params' });
      const fail = (e) => {
        if (e instanceof UploadError) return json(res, YT_ERR[e.code] ?? 502, { error: e.code, detail: e.message.slice(0, 200) });
        if (e?.code === 'oauth-no-client' || e?.code === 'oauth-reauth-needed') return json(res, 401, { error: e.code === 'oauth-no-client' ? 'youtube-no-client' : 'youtube-not-signed-in' });
        return json(res, 502, { error: 'youtube-failed' });
      };
      const v = posting.get(body.id);
      if (!v) return json(res, 404, { error: 'unknown-post' });
      if (!isUpload) {
        try { return json(res, 200, await checkPostStatus({ id: body.id, store: posting, auth: youtubeAuth(), fetchImpl: opts.youtube?.fetchImpl })); } catch (e) { return fail(e); }
      }
      if (typeof body.confirm !== 'string' || normPhrase(body.confirm) !== UPLOAD_PHRASE) return json(res, 400, { error: 'confirm-required', phrase: UPLOAD_PHRASE });
      if (v.status === 'uploaded') return json(res, 409, { error: 'already-uploaded', videoId: v.videoId });
      if (v.status !== 'approved') return json(res, 409, { error: 'not-approved' });
      if (uploading.size) return json(res, 409, { error: 'upload-in-progress' });
      uploading.add(body.id);
      const ut = tasks.start({ title: 'Uploading a clip to YouTube (private)', kind: 'upload', note: 'Sending the video' });
      try {
        // Live is re-checked inside uploadPost just before the transfer; here a failed check also refuses (fail closed).
        const r = await uploadPost({ id: body.id, store: posting, auth: youtubeAuth(), fetchImpl: opts.youtube?.fetchImpl, outputsStatus: async () => { try { return await ytOutputsStatus(); } catch { throw new UploadError('stream-active', 'could not confirm that nothing is live; upload refused'); } } });
        ut.done();
        return json(res, 200, { videoId: r.videoId, uploadStatus: r.uploadStatus, thumbnailOk: r.thumbnailOk, privacy: 'private' });
      } catch (e) { ut.fail('The upload did not finish'); return fail(e); } finally { uploading.delete(body.id); }
    }
    if (route === '/ui/api/posts/queue/retry') {
      // D301 "Retry now": puts a failed (or waiting) item back in the upload queue at once; the chain's next tick uploads it.
      // Nothing is sent from here. Refused while a stream is live or when the live state cannot be read (fail closed).
      if (typeof body.id !== 'string' || body.id.length > 64 || Object.keys(body).some((k) => k !== 'id') || typeof opts.dataDir !== 'string') return json(res, 400, { error: 'bad-params' });
      const q = createUploadQueue(path.join(opts.dataDir, 'posting', QUEUE_NAME));
      const cur = q.get(body.id);
      if (!cur) return json(res, 404, { error: 'unknown-queue-item' });
      if (cur.state !== 'failed' && cur.state !== 'queued') return json(res, 409, { error: 'not-retryable', state: cur.state });
      const blocked = await liveBlock(streamOnly(ytOutputsStatus));
      if (blocked) return json(res, 409, { error: blocked === 'output-live' ? 'stream-live' : blocked });
      const it = q.retryNow(body.id);
      return it ? json(res, 200, { ok: true, state: it.state, queue: readQueueSummary(opts.dataDir, flags) }) : json(res, 409, { error: 'not-retryable' });
    }
    if (route === '/ui/api/posts/edit' || route === '/ui/api/posts/status' || route === '/ui/api/posts/open') {
      // Local files only: post.json and the ledger. Nothing is uploaded; approving only marks the package.
      const keys = route.endsWith('/edit') ? POST_EDIT_KEYS : (route.endsWith('/status') ? ['id', 'status'] : ['id']);
      if (typeof body.id !== 'string' || body.id.length > 64 || Object.keys(body).some((k) => !keys.includes(k))) return json(res, 400, { error: 'bad-params' });
      let r;
      if (route.endsWith('/open')) {
        const dir = posting.dir(body.id);
        if (!dir) return json(res, 404, { error: 'unknown-post' });
        return openFolder(dir) ? json(res, 200, { ok: true }) : json(res, 502, { error: 'open-failed' });
      }
      if (route.endsWith('/edit')) { const { id, ...fields } = body; r = posting.edit(id, fields); } else r = await posting.setStatus(body.id, body.status);
      if (typeof r === 'string') return json(res, POST_ERR[r] ?? 400, { error: r });
      return json(res, 200, { post: r });
    }
    if (route === '/ui/api/core/request') {
      if (typeof body.id !== 'string' || body.id.length > 64 || !CORE_ACTION_ID.test(body.id)) return json(res, 400, { error: 'bad-action-id' });
      if (body.params !== undefined && !isPlain(body.params)) return json(res, 400, { error: 'bad-params' });
      if (!core.describe().available) return json(res, 503, { error: 'core-unavailable' });
      try { return json(res, 200, await handleCoreOutcome(await core.call('actions.request', { id: body.id, params: body.params ?? {} }), `Action ${body.id}`)); } catch (e) { return json(res, 502, { error: 'core-error', detail: String(e?.code ?? e?.message ?? 'error').slice(0, 80) }); }
    }
    if (route === '/ui/api/project/import-meld') {
      let r;
      const it = tasks.start({ title: 'Reading your Meld session', kind: 'import' });
      try { r = importSession({ dataDir: opts.dataDir, sessionFile: opts.sessionFile === undefined ? resolveSessionFile() : opts.sessionFile, now: () => new Date(now()) }); } catch (e) {
        it.fail(e.code === 'NO_SESSION' ? 'No Meld session found' : 'Could not read it');
        return json(res, e.code === 'NO_SESSION' ? 503 : 502, { error: String(e.code ?? 'IMPORT_FAILED').toLowerCase().replace('_', '-'), detail: e.code === 'NO_SESSION' ? 'Set UJWALAM_MELD_SESSION or paths.meld_session in the local profile.' : undefined });
      }
      lastImport = { file: r.file, project: r.project, bases: r.bases };
      let plan = null; let planError = null;
      it.update({ note: 'Checking it against the studio' });
      try { plan = countsOnly(await callHost('project.plan', { project: r.project, bases: r.bases })); } catch (e) { planError = String(e?.code ?? 'error').slice(0, 40); }
      if (planError) it.fail('Read, but the check did not finish'); else it.done();
      return json(res, 200, { imported: r.summary, plan, planError });
    }
    if (route === '/ui/api/project/load') {
      if (!lastImport) return json(res, 409, { error: 'nothing-imported' });
      if (Object.keys(body).some((k) => k !== 'skipUnavailable') || (body.skipUnavailable !== undefined && typeof body.skipUnavailable !== 'boolean')) return json(res, 400, { error: 'bad-params' });
      const params = { project: lastImport.project, bases: lastImport.bases, ...(body.skipUnavailable === true ? { skipUnavailable: true } : {}) };
      const id = addPending({ kind: 'host', summary: 'Load the imported project into the studio (replaces the current scenes)', phrase: live ? 'yes, on air' : 'yes', method: 'project.load', params, countsOnly: true });
      if (!id) return json(res, 429, { error: 'too-many-pending' });
      return json(res, 200, { verdict: 'confirm', pending: publicPending(id, pending.get(id)) });
    }
    if (route === '/ui/api/confirm' || route === '/ui/api/cancel') {
      const p = typeof body.pendingId === 'string' ? pending.get(body.pendingId) : undefined;
      if (!p || p.expiresAt <= now()) { pending.delete(body.pendingId); return json(res, 410, { error: 'expired-or-unknown' }); }
      if (route === '/ui/api/cancel') { pending.delete(body.pendingId); return json(res, 200, { verdict: 'cancelled' }); }
      if (typeof body.text !== 'string' || body.text.length > 40) return json(res, 400, { error: 'bad-text' });
      // The phrase was chosen when the request was made. If the stream went live since, plain "yes" no longer counts:
      // the record upgrades to the on-air phrase and the page shows it again (D151).
      if ((p.kind === 'host' || p.kind === 'flag' || p.kind === 'bot' || p.kind === 'end-all') && live && p.phrase === 'yes') {
        p.phrase = 'yes, on air';
        return json(res, 200, { verdict: 'wrong-phrase', pending: publicPending(body.pendingId, p) });
      }
      if (normPhrase(body.text) !== p.phrase) return json(res, 200, { verdict: 'wrong-phrase', pending: publicPending(body.pendingId, p) }); // stays pending until it expires
      pending.delete(body.pendingId);
      try {
        if (p.kind === 'flag') return json(res, 200, { verdict: 'allow', flags: applyFlag(p.flagId, true) });
        if (p.kind === 'bot') {
          if (!botsOn()) return json(res, 404, { error: 'bot-manager-off' }); // the flag may have been switched off meanwhile
          const r = p.verb === 'start' ? await bots.start(p.bot) : await bots.stop(p.bot);
          return json(res, 200, { verdict: r.ok ? 'allow' : 'refuse', reason: r.ok ? null : r.reason, forced: r.forced === true, bots: await bots.statusAll() });
        }
        if (p.kind === 'host') {
          const fl = HOST_CALLS[p.method]?.flag; // switched off while the phrase was pending: refuse
          if (fl && !(flags && flags.isOn(fl))) return json(res, 404, { error: `${fl}-off` });
          // A go-live past a failed readiness item (typed override phrase): logged before the stream starts.
          let overrideLogged;
          if (p.readinessOverride) { try { overrideLogged = logOverride(opts.dataDir, p.readiness, new Date(now())); } catch { overrideLogged = false; } }
          if (p.method === 'stream.stop' && authority) await authority.revoke('stream.stop');
          const startGen = p.method === 'stream.start' && authority ? await authority.begin() : null;
          const before = await readBefore(p.method, p.params);
          if (Number.isInteger(startGen)) {
            if (startPauseMs) await new Promise((r) => setTimeout(r, startPauseMs));
            // A Stop / End all confirmed since this start began wins: the start is not sent.
            if ((await authority.begin()) !== startGen) return json(res, 200, { verdict: 'refuse', reason: 'stopped-meanwhile' });
          }
          const ht = p.method === 'project.load' ? tasks.start({ title: 'Loading your scenes into the studio', kind: 'project' }) : null;
          let out;
          try { out = await callHost(p.method, p.params); } catch (e) { ht?.fail('Did not finish'); throw e; }
          ht?.done();
          if (Number.isInteger(startGen) && !(await authority.arm(startGen))) {
            // A Stop / End all came in while this start was on its way to the host (after the check above): the newer
            // stop wins, so the streams this start turned on are stopped again at once.
            // Tried STOP_AGAIN_WAITS.length + 1 times; if every try fails the streams may still be live: a loud error.
            let lastErr = null;
            for (let i = 0; ; i++) {
              try { await callHost('stream.stop', {}); lastErr = null; break; } catch (e) { lastErr = e; }
              if (i >= STOP_AGAIN_WAITS.length) break;
              await new Promise((r) => setTimeout(r, STOP_AGAIN_WAITS[i]));
            }
            if (lastErr) {
              log(`[studio-ui] WARNING: a start overtaken by a Stop could not be stopped again (${String(lastErr?.code ?? lastErr?.message ?? 'error').slice(0, 80)}); streams may still be live`);
              return json(res, 502, { error: STOP_AGAIN_FAILED, detail: 'stop-again-failed' });
            }
            return json(res, 200, { verdict: 'refuse', reason: 'stopped-meanwhile', stoppedAgain: true });
          }
          remember(p.method, p.params, before);
          // A layout change confirmed while live autosaves like an instant one (P5b).
          const saved = HOST_CALLS[p.method]?.liveConfirm && projectSync && host.describe().kind === 'host' ? projectSync.record(p.method, syncParams(p.method, p.params, out)) : false;
          return json(res, 200, { verdict: 'allow', result: p.countsOnly ? countsOnly(out) : (out ?? null), ...(saved ? { saved: 'pending' } : {}), ...(p.readinessOverride ? { override: true, overrideLogged: overrideLogged === true } : {}) });
        }
        if (p.kind === 'end-all') { if (authority) await authority.revoke('end-all'); return json(res, 200, { verdict: 'allow', endAll: await endAllStreams() }); }
        const r = await core.confirm({ confirmId: p.confirmId, phrase: p.phrase, actionHash: p.actionHash });
        return json(res, 200, await handleCoreOutcome(r, p.summary));
      } catch (e) { return json(res, 502, { error: 'backend-error', detail: String(e?.code ?? e?.message ?? 'error').slice(0, 80) }); }
    }
    return text(res, 404, 'not-found');
  }

  // GET /ui/api/posts/media?id=<post id>&kind=video|cover. The file name never comes from the request: the store maps
  // id + kind to a plain file with an allowlisted extension inside the package folder (see createPostStore.media).
  function postMedia(req, res, url) {
    const m = posting.media(url.searchParams.get('id'), url.searchParams.get('kind'));
    if (!m) return text(res, 404, 'not-found');
    let start = 0; let end = m.size - 1; let code = 200;
    const range = req.headers.range;
    if (typeof range === 'string') {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!r || (r[1] === '' && r[2] === '')) { sec(res); res.writeHead(416, { 'Content-Range': `bytes */${m.size}` }); return res.end(); }
      if (r[1] === '') { start = Math.max(0, m.size - Number(r[2])); } else { start = Number(r[1]); if (r[2] !== '') end = Math.min(end, Number(r[2])); }
      if (start > end || start >= m.size) { sec(res); res.writeHead(416, { 'Content-Range': `bytes */${m.size}` }); return res.end(); }
      code = 206;
    }
    sec(res);
    const h = { 'Content-Type': m.type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
    if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${m.size}`;
    res.writeHead(code, h);
    if (m.size === 0) return res.end();
    createReadStream(m.file, { start, end }).on('error', () => res.destroy()).pipe(res);
    return undefined;
  }

  function sse(req, res) {
    if (sseClients.size >= limits.sseMaxClients) return text(res, 429, 'too-many-streams');
    sec(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client = { write: (f) => res.write(f) };
    sseClients.add(client);
    res.write(': open\n\n');
    if (lastSnapshot) res.write(`event: status\ndata: ${JSON.stringify(lastSnapshot)}\n\n`);
    const hb = setInterval(() => res.write(': hb\n\n'), limits.sseHeartbeatMs);
    hb.unref();
    const done = () => { clearInterval(hb); sseClients.delete(client); };
    req.on('close', done); res.on('error', done);
  }

  // ---- static ----
  function serveStatic(req, res, url) {
    if (req.method !== 'GET') return text(res, 405, 'method-not-allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return text(res, 400, 'bad-path'); }
    if (rel === '/') rel = '/index.html';
    if (/[\0\\]/.test(rel) || rel.includes('//') || !rel.startsWith('/')) return text(res, 400, 'bad-path');
    const parts = rel.slice(1).split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return text(res, 404, 'not-found');
    const ext = path.extname(rel).toLowerCase();
    if (!Object.hasOwn(MIME, ext)) return text(res, 404, 'not-found');
    let real;
    try { real = realpathSync(path.join(root, ...parts)); } catch { return text(res, 404, 'not-found'); }
    if (real !== root && !real.startsWith(root + path.sep)) return text(res, 404, 'not-found');
    let st;
    try { st = statSync(real); } catch { return text(res, 404, 'not-found'); }
    if (!st.isFile()) return text(res, 404, 'not-found');
    sec(res);
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': st.size });
    createReadStream(real).on('error', () => res.destroy()).pipe(res);
    return undefined;
  }

  // ---- request entry ----
  async function onRequest(req, res) {
    try {
      if (req.headers.host !== hostHeader) return text(res, 403, 'bad-host');
      const sfs = req.headers['sec-fetch-site'];
      let url;
      try { url = new URL(req.url, origin); } catch { return text(res, 400, 'bad-url'); }
      if (url.origin !== origin) return text(res, 400, 'bad-url');
      if (req.method === 'OPTIONS') return text(res, 405, 'no-cors');
      if (url.pathname === '/login') {
        if (req.method !== 'GET') return text(res, 405, 'method-not-allowed');
        if (sfs !== undefined && sfs !== 'none' && sfs !== 'same-origin') return text(res, 403, 'cross-site');
        const t = now();
        if (t < loginLockedUntil) return text(res, 429, 'locked');
        const k = url.searchParams.get('k');
        const fresh = launchKey !== null && t - launchBorn <= limits.launchKeyTtlMs;
        if (!fresh || typeof k !== 'string' || !sameSecret(k, launchKey)) {
          if (++loginFails >= limits.loginFailMax) { loginFails = 0; loginLockedUntil = t + limits.loginLockMs; }
          return text(res, 401, 'unauthorized');
        }
        launchKey = null; // single use
        if (sessions.size >= limits.sessionMax) sessions.delete(sessions.keys().next().value);
        const sid = newId(32);
        sessions.set(sid, { csrf: newId(24) });
        sec(res);
        res.writeHead(302, { Location: '/', 'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`, 'Content-Length': 0 });
        return res.end();
      }
      if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return text(res, 403, 'cross-site');
      const sid = cookieSid(req);
      if (!sid) return text(res, 401, 'unauthorized');
      if (url.pathname.startsWith('/ui/api/')) return await api(req, res, url, sid);
      if (url.pathname.startsWith('/ui/')) return text(res, 404, 'not-found');
      return serveStatic(req, res, url);
    } catch {
      if (!res.headersSent) text(res, 500, 'internal'); else res.destroy();
      return undefined;
    }
  }

  const server = http.createServer({ maxHeaderSize: limits.maxHeaderBytes }, (req, res) => { onRequest(req, res); });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.on('clientError', (_e, sock) => { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else sock.destroy(); });

  return {
    server,
    /** Starts listening on 127.0.0.1 only. Resolves { port, origin }. */
    listen(port = opts.port ?? 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK, () => {
          const p = server.address().port;
          origin = `http://${LOOPBACK}:${p}`; hostHeader = `${LOOPBACK}:${p}`;
          pollTimer = setInterval(tick, limits.statusPollMs); pollTimer.unref();
          tick();
          resolve({ port: p, origin });
        });
      });
    },
    async close() {
      clearInterval(pollTimer);
      projectSync?.flush(); // write a pending layer edit now rather than lose it
      for (const c of sseClients) c.write(': bye\n\n');
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
    /** A new one-time login key, same rules as the first (single use, launchKeyTtlMs from now); replaces an unused one.
     *  Only the launcher calls it, over the UI server's stdin pipe (cli.mjs), to reopen a crashed studio window. */
    rearmLaunchKey(k) {
      if (typeof k !== 'string' || k.length < 32) return false;
      launchKey = k; launchBorn = now(); loginFails = 0;
      return true;
    },
    /** Test seam: current pending confirmations (server-side records, never sent to the page). */
    _pending: () => pending,
  };
}
