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
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS, BOT_LABELS, GRACEFUL_MS, createBots } from '../bots/index.mjs';
import { createFlags } from '../flags/index.mjs';
import { LEDGER_NAME, POSTING_FLAG, createPostStore } from '../posting/index.mjs';
import { createFeedback } from './feedback.mjs';
import { MAX_NOTE, MAX_TITLE, REPORT_FLAG, createReporter } from './report.mjs';
import { countsOnly, importSession, resolveSessionFile } from './import.mjs';

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

// Calls the page may make on the host. write: true marks a studio write. confirm: when set, the call is not run until
// the human types the phrase (live-aware). Everything else the page sends is refused. Schema: see validate().
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MIXER_ID = /^(?:[A-Za-z0-9_.:-]{1,64}\/[A-Za-z0-9_.:-]{1,64}|audio:[A-Za-z0-9_.:-]{1,64})$/; // "<scene>/<layer>" or "audio:<id>"
const OPT_CANVAS = { type: 'enum', values: ['h', 'v'] };
const CANVAS = { type: 'enum', values: ['h', 'v'], required: true };
const SCENE = { type: 'string', pattern: ID, required: true };
const LAYER = { type: 'string', pattern: ID, required: true };
// Names follow the host contract (docs/evidence/2026-10-29-v1-host-o1.md section 8).
export const HOST_CALLS = Object.freeze({
  'scenes.list': { schema: {} },
  'scenes.activate': { schema: { scene: SCENE, canvas: OPT_CANVAS } },
  'layers.list': { schema: { scene: SCENE, canvas: OPT_CANVAS } },
  'layers.setVisible': { schema: { scene: SCENE, canvas: OPT_CANVAS, layer: LAYER, visible: { type: 'bool', required: true } } },
  'layers.move': { schema: { scene: SCENE, canvas: OPT_CANVAS, layer: LAYER, index: { type: 'int', min: 0, max: 255, required: true } } },
  'preview.open': { schema: { canvas: CANVAS } },
  'preview.focus': { schema: { canvas: CANVAS } },
  'preview.close': { schema: { canvas: CANVAS } },
  'mixer.list': { schema: {} },
  'mixer.setVolume': { schema: { id: { type: 'string', pattern: MIXER_ID, required: true }, db: { type: 'num', min: -100, max: 0, required: true } } },
  'mixer.setMute': { schema: { id: { type: 'string', pattern: MIXER_ID, required: true }, muted: { type: 'bool', required: true } } },
  'stream.start': { schema: {}, confirm: 'onair', summary: 'Start the stream' },
  'stream.stop': { schema: {}, confirm: 'live', summary: 'Stop the stream' },
  'record.start': { schema: {}, confirm: 'live', summary: 'Start recording' },
  'record.stop': { schema: {}, confirm: 'live', summary: 'Stop recording' },
});

export const DEFAULT_FEEDBACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'feedback');
const FLAG_SET_SCHEMA = { id: { type: 'string', pattern: /^[a-z][a-z0-9-]{0,47}$/, required: true }, on: { type: 'bool', required: true } };
const NOTE_KEYS = ['id', 'text', 'tag', 'severity'];

export const BOT_FLAG = 'bot-manager';
const BOT_SCHEMA = { bot: { type: 'enum', values: BOTS, required: true } };
const POST_ERR = { 'unknown-post': 404, 'over-limit': 409, 'unresolved-placeholders': 409, 'empty-title': 409, 'video-changed': 409 };
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
      case 'enum': if (!d.values.includes(v)) return `bad field ${k}`; break;
      default: return 'internal schema error';
    }
  }
  return null;
}

const normPhrase = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/** opts: { uiRoot, core, host, launchKey, port?, limits?, now? }
 *  core:  { call(method, params) -> Promise, describe() -> { available } }   (event core; may be unavailable)
 *  host:  { call(method, params) -> Promise, describe() -> { kind: 'host'|'fake', available, blockedOnHost? } } */
export function createStudioServer(opts) {
  const limits = { ...LIMITS, ...(opts.limits ?? {}) };
  const now = opts.now ?? Date.now;
  const root = realpathSync(path.resolve(opts.uiRoot));
  const { core, host } = opts;
  // Feature flags (D149) and the post-stream feedback form (D150). opts.flags / opts.feedback are test seams.
  const flags = opts.flags ?? (typeof opts.dataDir === 'string' ? createFlags({ dataDir: opts.dataDir }) : null);
  const feedback = opts.feedback ?? createFeedback({ feedbackDir: opts.feedbackDir ?? DEFAULT_FEEDBACK_DIR, now: () => new Date(now()) });
  // Export-only posting (P16a, flag `posting`): packages are listed from <dataDir>/posting/ledger.json. Nothing is uploaded.
  const posting = opts.posting ?? (typeof opts.dataDir === 'string' ? createPostStore({ ledgerFile: path.join(opts.dataDir, 'posting', LEDGER_NAME) }) : null);
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
  if (typeof opts.launchKey !== 'string' || opts.launchKey.length < 32) throw new Error('launchKey must be at least 32 characters');
  let launchKey = opts.launchKey;
  const launchBorn = now();
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
  let lastImport = null; // { file, project, bases }: server side only, never sent to the page

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

  // ---- status snapshot (text-free: counts, flags and numbers only; never chat text) ----
  async function snapshot() {
    const h = host.describe();
    let hs = null; let cs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    try { cs = core.describe().available ? await core.call('core.status', {}) : null; } catch { cs = null; }
    if (hs && typeof hs.live === 'boolean') live = hs.live;
    const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && Object.hasOwn(o, k)).map((k) => [k, o[k]]));
    return {
      at: now(),
      host: { kind: h.kind, available: hs !== null, blockedOnHost: h.kind === 'fake',
        ...(hs ? pick(hs, ['live', 'recording', 'droppedFrames', 'totalFrames', 'fps', 'cpuPct', 'gpuPct', 'outputsReady']) : {}) },
      core: { available: cs !== null, ...(cs ? { liveState: typeof cs.live?.liveState === 'string' ? cs.live.liveState : null, panic: cs.live?.panic === true } : {}) },
    };
  }
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) { if (!c.write(frame)) { /* slow client: dropped by the stall timer below */ } }
  }
  async function tick() {
    try { lastSnapshot = await snapshot(); broadcast('status', lastSnapshot); } catch { /* keep polling */ }
  }

  // Host call with a retry on CONFLICT (-32009) for project.load.
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
  const publicPending = (id, p) => ({ pendingId: id, summary: p.summary, phrase: p.phrase, expiresAt: p.expiresAt, ...(p.step ? { step: p.step, of: 2 } : {}) });

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
    if (req.method === 'GET' && route === '/ui/api/flags') return json(res, 200, { flags: flags ? flags.list() : [] });
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
    if (req.method === 'GET' && route === '/ui/api/posts') return json(res, 200, { posts: posting.list() });
    if (req.method === 'GET' && route === '/ui/api/posts/media') return postMedia(req, res, url);
    if (req.method !== 'POST') return text(res, 405, 'method-not-allowed');
    // Mutating: Origin == our origin, CSRF header (timing-safe), JSON body.
    if (req.headers.origin !== origin) return text(res, 403, 'bad-origin');
    const h = req.headers[CSRF_HEADER];
    if (typeof h !== 'string' || !sameSecret(h, s.csrf)) return text(res, 403, 'bad-csrf');
    const body = await readBody(req, res);
    if (body === null) return undefined;

    if (route === '/ui/api/host') {
      const spec = typeof body.method === 'string' && Object.hasOwn(HOST_CALLS, body.method) ? HOST_CALLS[body.method] : null;
      if (!spec) return json(res, 400, { error: 'unknown-method' });
      const params = body.params ?? {};
      const bad = validate(spec.schema, params);
      if (bad) return json(res, 400, { error: bad });
      if (spec.confirm) {
        // Stream and recording changes need a typed phrase; while live, the on-air phrase.
        const phrase = (live || spec.confirm === 'onair') ? 'yes, on air' : 'yes';
        const id = addPending({ kind: 'host', summary: spec.summary, phrase, method: body.method, params });
        if (!id) return json(res, 429, { error: 'too-many-pending' });
        return json(res, 200, { verdict: 'confirm', pending: publicPending(id, pending.get(id)) });
      }
      try { return json(res, 200, { result: await host.call(body.method, params) ?? null }); } catch (e) { return json(res, 502, { error: 'host-error', detail: String(e?.code ?? e?.message ?? 'error').slice(0, 80) }); }
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
      try { r = importSession({ dataDir: opts.dataDir, sessionFile: opts.sessionFile === undefined ? resolveSessionFile() : opts.sessionFile, now: () => new Date(now()) }); } catch (e) {
        return json(res, e.code === 'NO_SESSION' ? 503 : 502, { error: String(e.code ?? 'IMPORT_FAILED').toLowerCase().replace('_', '-'), detail: e.code === 'NO_SESSION' ? 'Set UJWALAM_MELD_SESSION or paths.meld_session in the local profile.' : undefined });
      }
      lastImport = { file: r.file, project: r.project, bases: r.bases };
      let plan = null; let planError = null;
      try { plan = countsOnly(await callHost('project.plan', { project: r.project, bases: r.bases })); } catch (e) { planError = String(e?.code ?? 'error').slice(0, 40); }
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
      if ((p.kind === 'host' || p.kind === 'flag' || p.kind === 'bot') && live && p.phrase === 'yes') {
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
          const out = await callHost(p.method, p.params);
          return json(res, 200, { verdict: 'allow', result: p.countsOnly ? countsOnly(out) : (out ?? null) });
        }
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
      for (const c of sseClients) c.write(': bye\n\n');
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
    /** Test seam: current pending confirmations (server-side records, never sent to the page). */
    _pending: () => pending,
  };
}
