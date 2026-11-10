// SPDX-License-Identifier: GPL-3.0-or-later
// Platform sign-in in the studio (D327, PC1-PC3, flag `platform-connect`). Node stdlib only.
//
// What it does:
//   - PC1: per stream output (the live plan's targets, data/outputs/alpha-live.json): "Sign in with YouTube" (Google
//     OAuth, loopback redirect + PKCE + state, services/posting/oauth.mjs reused; YouTube Live Streaming API
//     liveStreams.list / liveStreams.insert gives the stream key), "Sign in with Twitch" (OAuth device-code flow for a
//     public client: no client secret, no redirect; Helix GET streams/key), or a pasted stream key and server address.
//   - PC2: this module is the one writer of the output keys (Ujwalam/stream/<output>, the names the host already reads
//     with CredReadW, stream_keys.cpp) and of its own sign-in tokens (Ujwalam/connect/*). Secrets go only to the
//     credential store (Windows Credential Manager through services/event-core/streamerbot/credential.mjs). Nothing
//     returned from here carries a key, a token, a server address or a credential value: status gives presence, the
//     address scheme and at most the last 4 characters of a key. Errors carry codes, never response bodies.
//   - PC3: disconnect() deletes what is stored for an output (key, server address) and, when no other output still
//     comes from that sign-in, the platform token (Twitch: also revoked at Twitch; Google: deleted locally only, a
//     Google revoke would also end the posting sign-in, which shares the OAuth client). status(): connected | token
//     expired | missing per output.
//
// Non-secret bookkeeping (which output came from which sign-in, the last token check) is <dataDir>/connections.json.
// It never holds a key, token, address or account name.
//
// Live rule (caller supplies outputLive(id) -> 'live' | 'idle' and throws when it cannot tell): a write to an output
// that is live is refused ('output-live'); an unreadable state refuses too ('live-unknown'). Checked again right before
// every credential write. The user's click in the studio is the decision (studio-ui server.mjs, D332).
//
// Test seams: opts.storeFor(target) (credential store double), opts.fetchImpl, opts.endpoints, opts.browserOpen,
// opts.now, opts.sleep. No test touches Google, Twitch or the real Credential Manager.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';
import { systemTool } from '../event-core/config.mjs';
import { createYoutubeAuth, CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../posting/oauth.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONNECT_FLAG = 'platform-connect';
export const META_FILE = 'connections.json';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
export const TWITCH_SCOPE = 'channel:read:stream_key';
export const TARGETS = Object.freeze({
  youtubeRefresh: 'Ujwalam/connect/youtube-refresh',
  twitchRefresh: 'Ujwalam/connect/twitch-refresh',
  twitchClientId: 'Ujwalam/connect/twitch-client-id',
});
export const STREAM_REF_RE = /^Ujwalam\/stream\/[a-z0-9-]{1,32}$/;
export const DEFAULT_ENDPOINTS = Object.freeze({
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  youtubeApi: 'https://www.googleapis.com/youtube/v3',
  twitchDevice: 'https://id.twitch.tv/oauth2/device',
  twitchToken: 'https://id.twitch.tv/oauth2/token',
  twitchValidate: 'https://id.twitch.tv/oauth2/validate',
  twitchRevoke: 'https://id.twitch.tv/oauth2/revoke',
  helix: 'https://api.twitch.tv/helix',
  twitchIngests: 'https://ingest.twitch.tv/ingests',
});
// Where a Twitch device-flow verification page may be (the URL comes from Twitch's answer, so it is checked first).
const TWITCH_VERIFY_ORIGINS = ['https://www.twitch.tv', 'https://id.twitch.tv'];
const PLATFORM_LABEL = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick', custom: 'Custom RTMP' };
const HTTP_TIMEOUT_MS = 15_000;
const JOB_TTL_MS = 10 * 60_000;
const STATUS_CACHE_MS = 10_000;
const ACTIVE_STATES = new Set(['starting', 'live', 'retrying', 'stopping', 'reconnecting']);

export class ConnectError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ConnectError'; this.code = code; }
}

// ---- validation (pure) ----

/** A stream key as the host accepts it (stream_keys.cpp): 1..1023 printable ASCII, no spaces. Returns a problem code or null. */
export function keyProblem(key, platform) {
  if (typeof key !== 'string') return 'key-missing';
  const k = key.trim();
  if (!k) return 'key-missing';
  if (k.length > 1023) return 'key-too-long';
  if (!/^[\x21-\x7e]+$/.test(k)) return 'key-bad-characters';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(k)) return 'key-looks-like-address';
  if (platform === 'twitch' && k.includes('?')) return 'key-has-query'; // e.g. ?bandwidthtest=true: never for a public stream
  return null;
}

// Mirrors Outputs::valid_live_url (app/host/src/outputs.cpp): rtmp(s)://host.name[:port][/path], no IP literal, no
// userinfo, no query, at most 256 characters.
const LIVE_URL_RE = /^(rtmps?):\/\/(([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z][a-z0-9-]{0,61}[a-z0-9]))(:([0-9]{1,5}))?((\/[A-Za-z0-9._~-]+)*\/?)$/i;

/** Problem code or null for a pasted server address; schemes: the schemes this output may use. */
export function serverProblem(url, schemes) {
  if (typeof url !== 'string' || !url.trim()) return 'server-missing';
  const u = url.trim();
  if (u.length > 256) return 'server-too-long';
  const m = LIVE_URL_RE.exec(u);
  if (!m) return 'server-bad-address';
  if (m[7] !== undefined) { const p = Number(m[7]); if (p < 1 || p > 65535) return 'server-bad-port'; }
  if (Array.isArray(schemes) && schemes.length && !schemes.includes(m[1].toLowerCase())) return 'server-wrong-scheme';
  return null;
}

export const PROBLEM_TEXT = Object.freeze({
  'key-missing': 'Paste the stream key.',
  'key-too-long': 'That stream key is too long.',
  'key-bad-characters': 'A stream key has no spaces or special characters; paste it again.',
  'key-looks-like-address': 'That looks like a server address, not a stream key.',
  'key-has-query': 'The key ends with a "?" part (for example a bandwidth test); paste it without that part.',
  'server-missing': 'Paste the server address (rtmp:// or rtmps://).',
  'server-too-long': 'That server address is too long.',
  'server-bad-address': 'The server address must look like rtmps://server.name/app (no IP address, no "?" part).',
  'server-bad-port': 'The port in the server address is not valid.',
  'server-wrong-scheme': 'This output takes another scheme (rtmp:// or rtmps://); see the hint.',
  'server-not-used': 'This output uses a fixed server; only the key is stored.',
});

const lastFour = (v) => (typeof v === 'string' && v.length >= 12 ? v.slice(-4) : null);
const schemeOf = (v) => { const m = typeof v === 'string' ? /^\s*([A-Za-z][A-Za-z0-9+.-]{0,15}):\/\//.exec(v) : null; return m ? m[1].toLowerCase() : null; };
const platformOf = (id) => (/^youtube(-|$)/.test(id) ? 'youtube' : /^twitch(-|$)/.test(id) ? 'twitch' : /^kick(-|$)/.test(id) ? 'kick' : 'custom');
const httpsOnly = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

/** Outputs from planTargets() rows ({ id, transport, keyRef, serverRef?, schemes? }); ids and refs checked. */
export function outputsFromPlan(targets) {
  const out = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t || typeof t.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(t.id)) continue;
    if (typeof t.keyRef !== 'string' || !STREAM_REF_RE.test(t.keyRef)) continue;
    if (t.serverRef !== undefined && (typeof t.serverRef !== 'string' || !STREAM_REF_RE.test(t.serverRef) || t.serverRef === t.keyRef)) continue;
    // A setup output (Settings > Stream) names its platform and canvas itself; plan rows derive them from the id.
    const platform = typeof t.platform === 'string' && Object.hasOwn(PLATFORM_LABEL, t.platform) ? t.platform : platformOf(t.id);
    const schemes = t.transport === 'auto' ? (Array.isArray(t.schemes) && t.schemes.length ? t.schemes : ['rtmp', 'rtmps']) : (t.transport === 'rtmp' || t.transport === 'rtmps' ? [t.transport] : ['rtmps']);
    const canvas = t.canvas === 'V' || t.canvas === 'H' ? t.canvas : (/-v$/.test(t.id) ? 'V' : 'H');
    out.push({
      id: t.id, platform, label: `${PLATFORM_LABEL[platform]}${platform === 'youtube' ? ` ${canvas}` : ''}`,
      keyRef: t.keyRef, ...(t.serverRef ? { serverRef: t.serverRef } : {}), schemes,
      signIn: platform === 'youtube' || platform === 'twitch' ? platform : null,
    });
  }
  return out;
}

// ---- bookkeeping file (no secrets) ----

function readMeta(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { outputs: j && typeof j.outputs === 'object' && j.outputs ? j.outputs : {}, tokens: j && typeof j.tokens === 'object' && j.tokens ? j.tokens : {} };
  } catch { return { outputs: {}, tokens: {} }; }
}
function writeMeta(file, meta) {
  mkdirSync(path.dirname(file), { recursive: true });
  const clean = {
    version: 1,
    outputs: Object.fromEntries(Object.entries(meta.outputs).filter(([k]) => /^[a-z0-9-]{1,32}$/.test(k)).map(([k, v]) => [k, { source: ['youtube', 'twitch', 'pasted'].includes(v?.source) ? v.source : 'pasted', at: typeof v?.at === 'string' ? v.at : null }])),
    tokens: Object.fromEntries(Object.entries(meta.tokens).filter(([k]) => k === 'youtube' || k === 'twitch').map(([k, v]) => [k, { state: ['ok', 'expired', 'unknown'].includes(v?.state) ? v.state : 'unknown', checkedAt: typeof v?.checkedAt === 'string' ? v.checkedAt : null }])),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  renameSync(tmp, file);
}

// ---- HTTP (fetch, timeout, codes only) ----

// signal: a sign-in job's abort signal (cancel, time-out, superseded): the request stops and 'cancelled' is thrown.
async function httpJson(fetchImpl, url, { method = 'GET', headers = {}, form, json, signal } = {}) {
  const h = { Accept: 'application/json', ...headers };
  let body;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (signal?.aborted) throw new ConnectError('cancelled');
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let res;
  try { res = await fetchImpl(url, { method, headers: h, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); } catch {
    if (signal?.aborted) throw new ConnectError('cancelled');
    throw new ConnectError('network-failed', 'the platform could not be reached');
  }
  let data = null;
  try { const t = await res.text(); data = t ? JSON.parse(t) : null; } catch { data = null; }
  return { status: res.status, data };
}

/** Default browser opener: rundll32 from System32 by absolute path (no shell, no console window). */
export function systemBrowserOpen(url) {
  return new Promise((resolve, reject) => {
    if (!httpsOnly(url)) { reject(new ConnectError('bad-browser-url')); return; }
    let exe;
    try { exe = systemTool('rundll32.exe'); } catch { reject(new ConnectError('browser-open-failed')); return; }
    const p = spawn(exe, ['url.dll,FileProtocolHandler', url], { windowsHide: true, shell: false, stdio: 'ignore' });
    p.on('error', () => reject(new ConnectError('browser-open-failed')));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new ConnectError('browser-open-failed'))));
  });
}

// ---- the connect service ----

/**
 * opts: { dataDir, outputs: [from outputsFromPlan], outputLive(id) -> Promise<'live'|'idle'>, storeFor?(target),
 *         fetchImpl?, endpoints?, browserOpen?(url), now?, sleep?(ms), youtubeIngestHost? }
 */
export function createConnect(opts = {}) {
  if (typeof opts.dataDir !== 'string' || !opts.dataDir) throw new Error('connect: dataDir required');
  // opts.outputs: an array, or a function returning one (read on every call, so an output added in Settings > Stream
  // is known without a restart).
  const readOutputs = () => { const v = typeof opts.outputs === 'function' ? opts.outputs() : opts.outputs; return Array.isArray(v) ? v : []; };
  const outputsNow = () => { try { return readOutputs(); } catch { return []; } };
  const storeFor = opts.storeFor ?? ((t) => createCredentialStore(t));
  const stores = new Map();
  const store = (t) => { if (!stores.has(t)) stores.set(t, storeFor(t)); return stores.get(t); };
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ep = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints ?? {}) };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  const browserOpen = opts.browserOpen ?? systemBrowserOpen;
  const metaFile = path.join(opts.dataDir, META_FILE);
  const outputLive = typeof opts.outputLive === 'function' ? opts.outputLive : async () => { throw new Error('no live check'); };
  const ytIngestHost = opts.youtubeIngestHost ?? youtubeDataIngestHost();
  const iso = () => new Date(now()).toISOString();
  let statusCache = null; // { at, value }
  const invalidate = () => { statusCache = null; };

  // A form POST through fetch (also used by the Google OAuth helper as its token request: same code path in tests).
  const formPost = async (url, form) => {
    const r = await httpJson(fetchImpl, url, { method: 'POST', form });
    if (r.status !== 200 || !r.data) throw new ConnectError('token-endpoint-failed', `HTTP ${r.status}`);
    return r.data;
  };
  // The Google sign-in stores its refresh token itself (posting/oauth.mjs). That write goes through this guard, which
  // the running YouTube job sets: a sign-in cancelled, timed out or superseded after consent stores nothing.
  const ytRefresh = store(TARGETS.youtubeRefresh);
  let ytWriteGuard = null;
  const ytRefreshGuarded = {
    get: () => ytRefresh.get(),
    set: async (v) => { if (ytWriteGuard) ytWriteGuard(); return ytRefresh.set(v); },
    delete: () => ytRefresh.delete(),
  };
  const ytAuth = createYoutubeAuth({
    clientIdStore: store(CLIENT_ID_TARGET), clientSecretStore: store(CLIENT_SECRET_TARGET), refreshStore: ytRefreshGuarded,
    scope: YOUTUBE_SCOPE, browserOpen: (u) => browserOpen(u), now, endpoints: { authUrl: ep.googleAuth, tokenUrl: ep.googleToken }, request: formPost,
  });

  // Serial sections: one chain per name. 'creds' covers every output key / server write (read state, write, re-check);
  // 'twitch' covers the Twitch sign-in token (read, exchange, replace, revoke, delete): its refresh token is single use.
  const chains = new Map();
  const exclusive = (name, fn) => {
    const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn);
    chains.set(name, run.catch(() => {}));
    return run;
  };
  // Start gate (opts.gate, the studio-ui server): enter() throws ConnectError('output-starting') while a stream start
  // is on its way, and while the returned leave() is pending every new start is refused there. Without a gate, only
  // the re-check after the write below protects a start that slips in.
  const gate = opts.gate && typeof opts.gate.enter === 'function' ? opts.gate : { enter: () => () => {} };

  async function assertWritable(output) {
    let st;
    try { st = await outputLive(output.id); } catch { throw new ConnectError('live-unknown', 'could not confirm that this output is not live'); }
    if (st !== 'idle') throw new ConnectError('output-live', `${output.label} is streaming: change its key after the stream`);
  }
  /**
   * One update of an output's stored key and server address, as a unit: under the 'creds' lock and the start gate,
   * the output must be idle, then apply() runs, then the output must still be idle; otherwise the previous values are
   * put back and the update is refused. alive() (a sign-in job's check) runs before every step. The previous values
   * are held in memory for the length of the update only.
   */
  function updateOutput(o, apply, alive = () => {}) {
    return exclusive('creds', async () => {
      alive();
      const leave = gate.enter();
      try {
        await assertWritable(o);
        alive();
        const refs = [o.keyRef, ...(o.serverRef ? [o.serverRef] : [])];
        let before = await Promise.all(refs.map((r) => store(r).get()));
        const restore = async () => { for (let i = 0; i < refs.length; i++) { try { if (before[i]) await store(refs[i]).set(before[i]); else await store(refs[i]).delete(); } catch { /* best effort */ } } };
        try {
          alive();
          const result = await apply();
          let st; try { st = await outputLive(o.id); } catch { st = 'unknown'; }
          if (st !== 'idle') { await restore(); throw new ConnectError(st === 'live' ? 'output-live' : 'live-unknown', 'the output started while its key was being changed; the previous key is back'); }
          return result;
        } catch (e) {
          if (e?.code !== 'output-live' && e?.code !== 'live-unknown') await restore();
          throw e;
        } finally { before = null; invalidate(); }
      } finally { leave(); }
    });
  }
  function outputOf(id) {
    const o = typeof id === 'string' ? outputsNow().find((x) => x.id === id) : undefined;
    if (!o) throw new ConnectError('unknown-output');
    return o;
  }
  function noteOutput(id, source) {
    const m = readMeta(metaFile);
    if (source) m.outputs[id] = { source, at: iso() }; else delete m.outputs[id];
    writeMeta(metaFile, m);
  }
  function noteToken(platform, state) {
    const m = readMeta(metaFile);
    if (state) m.tokens[platform] = { state, checkedAt: iso() }; else delete m.tokens[platform];
    writeMeta(metaFile, m);
  }

  // ---- status ----
  async function facts(target, { scheme = false, hint = false } = {}) {
    try {
      let v = await store(target).get();
      const f = { present: typeof v === 'string' && v !== '' };
      if (f.present && scheme) f.scheme = schemeOf(v);
      if (f.present && hint) { const l = lastFour(v); if (l) f.last4 = l; }
      v = null;
      return f;
    } catch { return { present: false, error: true }; }
  }
  async function status({ fresh = false } = {}) {
    const outs = outputsNow();
    const sig = outs.map((o) => `${o.id}|${o.keyRef}|${o.serverRef ?? ''}`).join(',');
    if (!fresh && statusCache && statusCache.sig === sig && now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
    const meta = readMeta(metaFile);
    const [ytId, ytSecret, ytRefresh, twId, twRefresh] = await Promise.all([
      facts(CLIENT_ID_TARGET), facts(CLIENT_SECRET_TARGET), facts(TARGETS.youtubeRefresh), facts(TARGETS.twitchClientId), facts(TARGETS.twitchRefresh),
    ]);
    const account = (signedIn, platform) => ({ signedIn, tokenState: !signedIn ? 'none' : (meta.tokens[platform]?.state ?? 'unknown'), checkedAt: meta.tokens[platform]?.checkedAt ?? null });
    const accounts = {
      youtube: { clientSet: ytId.present && ytSecret.present, ...account(ytRefresh.present, 'youtube') },
      twitch: { clientSet: twId.present, ...account(twRefresh.present, 'twitch') },
    };
    const rows = [];
    for (const o of outs) {
      const key = await facts(o.keyRef, { hint: true });
      const server = o.serverRef ? await facts(o.serverRef, { scheme: true }) : null;
      const source = meta.outputs[o.id]?.source ?? null;
      let state = 'connected'; let detail = '';
      if (key.error || server?.error) { state = 'missing'; detail = 'Could not be read from Windows Credential Manager.'; }
      else if (!key.present) { state = 'missing'; detail = 'No stream key.'; }
      else if (server && !server.present) { state = 'missing'; detail = 'No server address.'; }
      else if (server && server.scheme && !o.schemes.includes(server.scheme)) { state = 'missing'; detail = `The server address starts with ${server.scheme}:// but this output takes ${o.schemes.map((s) => `${s}://`).join(' or ')}.`; }
      else if ((source === 'youtube' || source === 'twitch') && (!accounts[source].signedIn || accounts[source].tokenState === 'expired')) {
        state = 'token-expired';
        detail = `The ${PLATFORM_LABEL[source]} sign-in has expired. The stored key still works; sign in again to fetch a new key.`;
      } else detail = source === 'pasted' || !source ? 'Key stored.' : `Key from ${PLATFORM_LABEL[source]} sign-in.`;
      rows.push({
        id: o.id, platform: o.platform, label: o.label, signIn: o.signIn, source, state, detail,
        key: { present: key.present, ...(key.last4 ? { last4: key.last4 } : {}) },
        ...(o.serverRef ? { server: { present: !!server?.present, scheme: server?.scheme ?? null, schemes: o.schemes } } : {}),
      });
    }
    const value = { outputs: rows, accounts };
    statusCache = { at: now(), sig, value };
    return value;
  }

  // ---- paste ----
  /** Checks a paste without writing. Returns null or a problem code. */
  function checkPaste(id, { key, server } = {}) {
    const o = outputOf(id);
    if (key === undefined && server === undefined) return 'key-missing';
    if (key !== undefined) { const p = keyProblem(key, o.platform); if (p) return p; }
    if (server !== undefined) {
      if (!o.serverRef) return 'server-not-used';
      const p = serverProblem(server, o.schemes); if (p) return p;
    }
    return null;
  }
  async function paste(id, { key, server } = {}) {
    const o = outputOf(id);
    const bad = checkPaste(id, { key, server });
    if (bad) throw new ConnectError(bad, PROBLEM_TEXT[bad]);
    // Key and server address change together (updateOutput): a start in between is refused, or the old pair returns.
    await updateOutput(o, async () => {
      if (server !== undefined) await store(o.serverRef).set(server.trim());
      if (key !== undefined) await store(o.keyRef).set(key.trim());
    });
    noteOutput(o.id, key !== undefined ? 'pasted' : (readMeta(metaFile).outputs[o.id]?.source ?? 'pasted'));
    invalidate();
    return { ok: true, output: o.id };
  }

  // ---- disconnect ----
  async function disconnect(id) {
    const o = outputOf(id);
    const source = readMeta(metaFile).outputs[o.id]?.source ?? null;
    // A running sign-in for this output, or for the same account, would write again after the delete: it ends here.
    if (job && !TERMINAL.has(job.state) && (job.output === o.id || job.platform === source)) endJob(job, 'cancelled');
    const removed = await updateOutput(o, async () => ({ key: await store(o.keyRef).delete(), server: o.serverRef ? await store(o.serverRef).delete() : false, token: false, revoke: 'not-needed' }));
    noteOutput(o.id, null);
    // The platform token goes when no other output still comes from that sign-in.
    if (source === 'youtube' || source === 'twitch') {
      const others = Object.entries(readMeta(metaFile).outputs).some(([k, v]) => k !== o.id && v?.source === source);
      if (!others) { const r = await signOut(source); removed.token = r.local; removed.revoke = r.remote; }
    }
    invalidate();
    return { ok: true, output: o.id, removed };
  }
  /**
   * Ends a platform sign-in. Returns { local: deleted here (bool), remote: 'revoked' | 'failed' | 'not-needed' | 'skipped' }.
   * Google: local only ('skipped'; a revoke would end the posting sign-in too, same OAuth client). Twitch: under the
   * account lock, the refresh token is exchanged for an access token, that access token is revoked (Twitch's revoke
   * takes an access token) and its answer checked; the stored token is deleted whatever Twitch answers. Work already
   * running for the account (a refresh, a device sign-in) is invalidated first so it cannot store a token afterwards.
   */
  async function signOut(platform) {
    if (platform === 'youtube') { const local = await ytAuth.signOut(); noteToken('youtube', null); return { local: local === true, remote: 'skipped' }; }
    twitchGen += 1;
    return exclusive('twitch', async () => {
      const t = store(TARGETS.twitchRefresh);
      const rt = await t.get().catch(() => null);
      const cid = await store(TARGETS.twitchClientId).get().catch(() => null);
      let remote = 'not-needed';
      if (rt && !cid) remote = 'skipped';
      else if (rt && cid) {
        try {
          const ex = await httpJson(fetchImpl, ep.twitchToken, { method: 'POST', form: { client_id: cid, grant_type: 'refresh_token', refresh_token: rt } });
          if (ex.status === 400 || ex.status === 401) remote = 'not-needed'; // already invalid at Twitch
          else if (ex.status !== 200 || typeof ex.data?.access_token !== 'string') remote = 'failed';
          else {
            const rv = await httpJson(fetchImpl, ep.twitchRevoke, { method: 'POST', form: { client_id: cid, token: ex.data.access_token } });
            remote = rv.status === 200 ? 'revoked' : 'failed';
          }
        } catch { remote = 'failed'; }
      }
      let local = false;
      try { local = (await t.delete()) === true; } catch { local = false; }
      noteToken('twitch', null);
      return { local, remote };
    });
  }

  // ---- Twitch client id (a setting the user makes once; not a secret, kept with the other sign-in values) ----
  async function setTwitchClientId(v) {
    if (typeof v !== 'string' || !/^[a-z0-9]{20,64}$/.test(v.trim())) throw new ConnectError('bad-client-id', 'A Twitch client ID is 20 to 64 lower-case letters and digits.');
    await store(TARGETS.twitchClientId).set(v.trim());
    invalidate();
    return { ok: true };
  }

  // ---- sign-in jobs (one at a time; state is memory only) ----
  // A job ends in done, failed or cancelled and never moves again. Ending it aborts its AbortController: its HTTP
  // requests stop, and alive(j), checked after every await and before every credential write, throws. A job past
  // JOB_TTL_MS, or no longer the current one, counts as ended too.
  let job = null; // { id, platform, output, state, ac, startedAt, ... private: streams cache never holds keys }
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);
  const publicJob = (j) => (j ? {
    id: j.id, platform: j.platform, output: j.output, state: j.state,
    ...(j.userCode ? { userCode: j.userCode, verifyUrl: j.verifyUrl } : {}),
    ...(j.streams ? { streams: j.streams } : {}),
    ...(j.error ? { error: j.error, message: j.message ?? null } : {}),
    ...(j.warnings?.length ? { warnings: j.warnings } : {}),
  } : null);
  function endJob(j, state, code) {
    if (TERMINAL.has(j.state)) return;
    j.state = state;
    if (state === 'failed') { j.error = code ?? 'failed'; j.message = ERROR_TEXT[j.error] ?? 'Sign-in did not finish.'; }
    j.streams = null; j.userCode = null; j.verifyUrl = null;
    j.ac.abort();
  }
  const expireIfDue = (j) => { if (j && !TERMINAL.has(j.state) && now() - j.startedAt > JOB_TTL_MS) endJob(j, 'failed', 'timeout'); };
  function alive(j) {
    expireIfDue(j);
    if (j !== job || TERMINAL.has(j.state) || j.ac.signal.aborted) throw new ConnectError('cancelled');
  }
  function currentJob() {
    expireIfDue(job);
    return publicJob(job);
  }
  const fail = (j, e) => endJob(j, 'failed', typeof e?.code === 'string' && e.code !== 'cancelled' ? e.code : 'failed');
  // Moves a live job on; an ended job throws here and its run stops (nothing is written after it ended).
  const step = (j, s) => { alive(j); j.state = s; };
  // The key is stored: that is the outcome, also when a cancel or the time limit landed during the last write.
  const stored = (j) => { j.state = 'done'; delete j.error; delete j.message; j.ac.abort(); };

  async function startSignIn(platform, id) {
    const o = outputOf(id);
    if (o.signIn !== platform) throw new ConnectError('sign-in-not-offered', `${o.label} has no ${PLATFORM_LABEL[platform] ?? platform} sign-in; paste the key instead`);
    expireIfDue(job);
    if (job && !TERMINAL.has(job.state)) throw new ConnectError('sign-in-busy', 'Another sign-in is still running.');
    // Reserved before the first await: a second request sees this job and is refused.
    const j = { id: randomBytes(16).toString('hex'), platform, output: o.id, state: 'starting', startedAt: now(), warnings: [], ac: new AbortController() };
    job = j;
    try { await assertWritable(o); alive(j); } catch (e) { fail(j, e); throw e; }
    const run = platform === 'youtube' ? runYoutube(j, o) : runTwitch(j, o);
    run.catch((e) => fail(j, e)).finally(invalidate);
    j.done = run;
    return publicJob(j);
  }
  function cancelJob(jobId) {
    if (!job || job.id !== jobId) throw new ConnectError('unknown-job');
    endJob(job, 'cancelled');
    return publicJob(job);
  }

  // YouTube: sign in (or reuse a stored sign-in), list the account's live streams, then the user picks one (choose()).
  async function runYoutube(j, o) {
    const sig = j.ac.signal;
    let token = null;
    try { token = await ytAuth.accessToken(); } catch { token = null; }
    alive(j);
    if (token) {
      const scopes = await ytAuth.grantedScopes().catch(() => null);
      alive(j);
      if (scopes && !scopes.includes(YOUTUBE_SCOPE) && !scopes.includes(`${YOUTUBE_SCOPE}.force-ssl`)) token = null;
    }
    if (!token) {
      step(j, 'browser');
      ytWriteGuard = () => alive(j); // the refresh token is stored only while this job still runs
      try { await ytAuth.signIn({ signal: sig }); } finally { if (ytWriteGuard) ytWriteGuard = null; }
      alive(j);
      const scopes = await ytAuth.grantedScopes().catch(() => null);
      alive(j);
      if (!scopes || (!scopes.includes(YOUTUBE_SCOPE) && !scopes.includes(`${YOUTUBE_SCOPE}.force-ssl`))) throw new ConnectError('scope-missing');
      token = await ytAuth.accessToken();
      alive(j);
    }
    noteToken('youtube', 'ok');
    const r = await httpJson(fetchImpl, `${ep.youtubeApi}/liveStreams?part=id,snippet,cdn,contentDetails&mine=true&maxResults=50`, { headers: { Authorization: `Bearer ${token}` }, signal: sig });
    alive(j);
    if (r.status === 401) { noteToken('youtube', 'expired'); throw new ConnectError('youtube-unauthorized'); }
    if (r.status === 403) throw new ConnectError('youtube-live-not-enabled');
    if (r.status !== 200 || !Array.isArray(r.data?.items)) throw new ConnectError('youtube-api-failed', `HTTP ${r.status}`);
    // The list answer carries every stream's key: only ids and plain facts are kept; the key is fetched again on choose().
    j.streams = r.data.items.filter((s) => s?.cdn?.ingestionType === 'rtmp' && typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.id)).slice(0, 50).map((s) => ({
      id: s.id, title: String(s.snippet?.title ?? '').slice(0, 100), resolution: String(s.cdn?.resolution ?? '').slice(0, 16), frameRate: String(s.cdn?.frameRate ?? '').slice(0, 16), reusable: s.contentDetails?.isReusable === true,
    }));
    step(j, 'choose');
  }
  /** YouTube step 2: streamId of one listed stream, or null to create a new reusable stream for this output. */
  async function choose(jobId, streamId) {
    const j = job;
    if (!j || j.id !== jobId || j.platform !== 'youtube') throw new ConnectError('unknown-job');
    expireIfDue(j);
    if (j.state !== 'choose') throw new ConnectError('job-not-waiting');
    if (streamId !== null && !(typeof streamId === 'string' && j.streams.some((s) => s.id === streamId))) throw new ConnectError('unknown-stream');
    const o = outputOf(j.output);
    step(j, 'saving'); // before the first await: a second choose() sees 'saving' and is refused
    const sig = j.ac.signal;
    try {
      const token = await ytAuth.accessToken();
      alive(j);
      const auth = { Authorization: `Bearer ${token}` };
      let item;
      if (streamId === null) {
        const r = await httpJson(fetchImpl, `${ep.youtubeApi}/liveStreams?part=id,snippet,cdn,contentDetails`, {
          method: 'POST', headers: auth, signal: sig,
          json: { snippet: { title: `Ujwalam ${o.label}` }, cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' }, contentDetails: { isReusable: true } },
        });
        alive(j);
        if (r.status !== 200) throw new ConnectError(r.status === 403 ? 'youtube-live-not-enabled' : 'youtube-api-failed', `HTTP ${r.status}`);
        item = r.data;
      } else {
        const r = await httpJson(fetchImpl, `${ep.youtubeApi}/liveStreams?part=id,cdn&id=${encodeURIComponent(streamId)}`, { headers: auth, signal: sig });
        alive(j);
        if (r.status !== 200) throw new ConnectError('youtube-api-failed', `HTTP ${r.status}`);
        item = Array.isArray(r.data?.items) ? r.data.items.find((s) => s?.id === streamId) : null;
      }
      let key = item?.cdn?.ingestionInfo?.streamName;
      if (keyProblem(key, 'youtube')) throw new ConnectError('youtube-no-key');
      // The host sends to the YouTube ingest in data/platforms/youtube.json; a different host in the answer is a warning.
      const ing = item?.cdn?.ingestionInfo?.rtmpsIngestionAddress;
      try { if (ytIngestHost && ing && new URL(ing).hostname.toLowerCase() !== ytIngestHost) j.warnings.push('YouTube gave a different RTMPS server than the one Ujwalam uses; streaming may still work, check YouTube Studio if it does not.'); } catch { /* not a URL: ignored */ }
      await updateOutput(o, async () => { alive(j); await store(o.keyRef).set(key); }, () => alive(j));
      key = null;
      noteOutput(o.id, 'youtube');
      stored(j);
      return publicJob(j);
    } catch (e) { fail(j, e); invalidate(); throw e; }
  }

  // Twitch: device-code flow (or a stored sign-in), then Helix streams/key; the server address only when none is stored.
  async function twitchClientId() {
    const id = await store(TARGETS.twitchClientId).get();
    if (!id) throw new ConnectError('twitch-no-client');
    return id;
  }
  // The Twitch sign-in token. Twitch gives a public client a new, single-use refresh token on every refresh, so the
  // read, the exchange and the replace run under the account lock, and callers at the same time share one refresh.
  // twitchGen grows on every sign-out: work begun before it stores nothing afterwards.
  let twitchGen = 0;
  let twitchRefreshing = null;
  function twitchRefresh(clientId) {
    if (twitchRefreshing) return twitchRefreshing;
    const gen = twitchGen;
    twitchRefreshing = exclusive('twitch', async () => {
      if (gen !== twitchGen) return null;
      const rt = await store(TARGETS.twitchRefresh).get();
      if (!rt) return null;
      const r = await httpJson(fetchImpl, ep.twitchToken, { method: 'POST', form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: rt } });
      if (gen !== twitchGen) return null; // signed out meanwhile: nothing is stored again
      if (r.status === 400 || r.status === 401) { noteToken('twitch', 'expired'); return null; }
      if (r.status !== 200 || typeof r.data?.access_token !== 'string') throw new ConnectError('twitch-token-failed', `HTTP ${r.status}`);
      if (typeof r.data.refresh_token === 'string' && r.data.refresh_token) await store(TARGETS.twitchRefresh).set(r.data.refresh_token);
      noteToken('twitch', 'ok');
      return r.data.access_token;
    }).finally(() => { twitchRefreshing = null; });
    return twitchRefreshing;
  }
  // A new sign-in's refresh token, stored under the account lock, only while the job runs and no sign-out came since.
  const storeTwitchToken = (j, gen, rt) => exclusive('twitch', async () => {
    alive(j);
    if (gen !== twitchGen) throw new ConnectError('cancelled');
    await store(TARGETS.twitchRefresh).set(rt);
    noteToken('twitch', 'ok');
  });
  async function runTwitch(j, o) {
    const sig = j.ac.signal;
    const gen = twitchGen;
    const clientId = await twitchClientId();
    alive(j);
    let access = await twitchRefresh(clientId).catch(() => null);
    alive(j);
    if (!access) {
      const d = await httpJson(fetchImpl, ep.twitchDevice, { method: 'POST', form: { client_id: clientId, scopes: TWITCH_SCOPE }, signal: sig });
      alive(j);
      if (d.status !== 200 || typeof d.data?.device_code !== 'string') throw new ConnectError(d.status === 400 ? 'twitch-bad-client' : 'twitch-device-failed', `HTTP ${d.status}`);
      const verify = String(d.data.verification_uri ?? '');
      const allowed = [...TWITCH_VERIFY_ORIGINS, new URL(ep.twitchDevice).origin];
      let vu;
      try { vu = new URL(verify); } catch { throw new ConnectError('twitch-device-failed'); }
      if (!allowed.includes(vu.origin)) throw new ConnectError('twitch-device-failed');
      j.userCode = String(d.data.user_code ?? '').slice(0, 16);
      j.verifyUrl = vu.href;
      step(j, 'device');
      try { await browserOpen(vu.href); } catch { /* the studio shows the link and the code */ }
      let interval = Math.max(1, Number(d.data.interval) || 5) * 1000;
      const until = now() + Math.min(Number(d.data.expires_in) || 1800, 1800) * 1000;
      const deviceCode = d.data.device_code;
      for (;;) {
        await sleep(interval);
        alive(j);
        if (now() > until) throw new ConnectError('twitch-code-expired');
        const t = await httpJson(fetchImpl, ep.twitchToken, { method: 'POST', form: { client_id: clientId, scopes: TWITCH_SCOPE, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal: sig });
        alive(j);
        if (t.status === 200 && typeof t.data?.access_token === 'string') {
          if (typeof t.data.refresh_token === 'string' && t.data.refresh_token) await storeTwitchToken(j, gen, t.data.refresh_token);
          access = t.data.access_token;
          break;
        }
        const msg = String(t.data?.message ?? '');
        if (msg === 'authorization_pending') continue;
        if (msg === 'slow_down') { interval += 5000; continue; }
        throw new ConnectError(msg === 'access_denied' ? 'twitch-denied' : msg === 'invalid device code' || msg === 'expired_token' ? 'twitch-code-expired' : 'twitch-token-failed');
      }
    }
    j.userCode = null; j.verifyUrl = null;
    step(j, 'saving');
    const v = await httpJson(fetchImpl, ep.twitchValidate, { headers: { Authorization: `OAuth ${access}` }, signal: sig });
    alive(j);
    if (v.status !== 200 || typeof v.data?.user_id !== 'string' || !/^\d{1,20}$/.test(v.data.user_id)) throw new ConnectError('twitch-token-failed');
    if (Array.isArray(v.data.scopes) && !v.data.scopes.includes(TWITCH_SCOPE)) throw new ConnectError('scope-missing');
    const k = await httpJson(fetchImpl, `${ep.helix}/streams/key?broadcaster_id=${v.data.user_id}`, { headers: { Authorization: `Bearer ${access}`, 'Client-Id': clientId }, signal: sig });
    alive(j);
    if (k.status === 401) { noteToken('twitch', 'expired'); throw new ConnectError('twitch-unauthorized'); }
    let key = Array.isArray(k.data?.data) ? k.data.data[0]?.stream_key : null;
    access = null;
    if (k.status !== 200 || keyProblem(key, 'twitch')) throw new ConnectError('twitch-no-key');
    // Server address: kept if one is stored (the user's choice); otherwise Twitch's default ingest, rtmps when offered.
    let srv = null;
    if (o.serverRef && !(await facts(o.serverRef)).present) {
      srv = await twitchDefaultServer(o.schemes, sig).catch(() => null);
      alive(j);
      if (!srv) j.warnings.push('No Twitch server address is stored; paste one (Twitch Dashboard > Settings > Stream, or the Twitch ingest list).');
    }
    // Key and default server go in as one update (updateOutput), checked against the job before each write.
    await updateOutput(o, async () => {
      alive(j);
      if (srv) await store(o.serverRef).set(srv);
      alive(j);
      await store(o.keyRef).set(key);
    }, () => alive(j));
    key = null;
    noteOutput(o.id, 'twitch');
    stored(j);
  }
  async function twitchDefaultServer(schemes, signal) {
    const r = await httpJson(fetchImpl, ep.twitchIngests, { signal });
    const list = Array.isArray(r.data?.ingests) ? r.data.ingests : [];
    const pick = list.find((x) => x?.default === true) ?? list[0];
    for (const tpl of [pick?.url_template_secure, pick?.url_template]) {
      if (typeof tpl !== 'string') continue;
      const u = tpl.replace(/\/?\{stream_key\}$/, '');
      if (!serverProblem(u, schemes)) return u;
    }
    return null;
  }

  /** Checks each stored sign-in once (refresh); updates the token states. Network trouble leaves the state unchanged. */
  async function checkTokens() {
    const out = {};
    if (await facts(TARGETS.youtubeRefresh).then((f) => f.present)) {
      try { await ytAuth.accessToken(); noteToken('youtube', 'ok'); out.youtube = 'ok'; } catch (e) {
        if (e?.code === 'oauth-reauth-needed') { noteToken('youtube', 'expired'); out.youtube = 'expired'; } else out.youtube = 'unknown';
      }
    } else out.youtube = 'none';
    if (await facts(TARGETS.twitchRefresh).then((f) => f.present)) {
      try { const id = await twitchClientId(); out.twitch = (await twitchRefresh(id)) ? 'ok' : 'expired'; } catch { out.twitch = 'unknown'; }
    } else out.twitch = 'none';
    invalidate();
    return out;
  }

  /** Short warnings for the readiness check (no values): outputs whose sign-in expired. */
  async function readinessWarnings() {
    try {
      const s = await status();
      return s.outputs.filter((o) => o.state === 'token-expired').map((o) => `${o.label}: ${o.detail}`);
    } catch { return []; }
  }

  return { outputs: () => outputsNow().map((o) => ({ ...o })), status, checkPaste, paste, disconnect, setTwitchClientId, startSignIn, cancelJob, choose, currentJob, checkTokens, readinessWarnings, _job: () => job };
}

export const ERROR_TEXT = Object.freeze({
  'oauth-no-client': 'The Google app (OAuth client) is not set yet. See Settings > Connections > "How to set up".',
  'oauth-timeout': 'No answer from the browser in time; try again.',
  'oauth-denied': 'Sign-in was cancelled in the browser.',
  'oauth-state-mismatch': 'The sign-in answer did not match this request and was ignored; try again.',
  'oauth-no-refresh-token': 'Google gave no lasting sign-in; remove Ujwalam in your Google Account (Third-party access), then sign in again.',
  'oauth-reauth-needed': 'The sign-in has expired; sign in again.',
  'scope-missing': 'The permission to manage your live streams was not given; sign in again and allow it.',
  'youtube-unauthorized': 'YouTube refused the sign-in; sign in again.',
  'youtube-live-not-enabled': 'Live streaming is not enabled on this YouTube channel (YouTube Studio > Go live), or the app lacks access.',
  'youtube-api-failed': 'YouTube did not answer as expected; try again later.',
  'youtube-no-key': 'YouTube gave no stream key for that stream.',
  'twitch-no-client': 'The Twitch app client ID is not set yet. See "How to set up".',
  'twitch-bad-client': 'Twitch refused the client ID; check it, and that the app is a "Public" client.',
  'twitch-device-failed': 'Twitch sign-in could not start; try again.',
  'twitch-code-expired': 'The Twitch code expired; start again.',
  'twitch-denied': 'Sign-in was cancelled on Twitch.',
  'twitch-token-failed': 'Twitch did not accept the sign-in; try again.',
  'twitch-unauthorized': 'Twitch refused the sign-in; sign in again.',
  'twitch-no-key': 'Twitch gave no stream key.',
  'network-failed': 'The platform could not be reached; check the internet connection.',
  'token-endpoint-failed': 'The sign-in server did not answer as expected; try again.',
  'output-live': 'This output is streaming: change its key after the stream.',
  'live-unknown': 'Could not confirm that this output is not live, so nothing was changed.',
  'output-starting': 'A stream is starting right now, so nothing was changed; try again when it is on air or stopped.',
  cancelled: 'The sign-in was cancelled or ran out of time, so nothing was stored.',
  'oauth-cancelled': 'The sign-in was cancelled.',
  'browser-open-failed': 'No browser could be opened.',
  timeout: 'Sign-in took too long; try again.',
});

function youtubeDataIngestHost() {
  try {
    const j = JSON.parse(readFileSync(path.join(REPO, 'data', 'platforms', 'youtube.json'), 'utf8'));
    const s = (j?.ingest?.value?.servers ?? []).find((x) => x?.proto === 'rtmps');
    return s ? new URL(s.url).hostname.toLowerCase() : null;
  } catch { return null; }
}

/** In-memory credential store family for tests and --fake-host runs: never touches Credential Manager. */
export function createMemoryStores(initial = {}) {
  const m = new Map(Object.entries(initial));
  const calls = [];
  const storeFor = (target) => ({
    target,
    async get() { calls.push(['get', target]); return m.has(target) ? m.get(target) : null; },
    async set(v) { if (typeof v !== 'string' || v === '') throw new Error('credential-empty-secret'); calls.push(['set', target]); m.set(target, v); },
    async delete() { calls.push(['delete', target]); return m.delete(target); },
  });
  return { storeFor, map: m, calls };
}
