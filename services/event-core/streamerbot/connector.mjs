// SPDX-License-Identifier: GPL-2.0-or-later
// Streamer.bot connector (P3 E2). Node stdlib only (global WebSocket, Node >= 22).
//
//   const sb = createStreamerbotConnector({ core, url?, getPassword?, recorder?, actions?, ... });
//   sb.start();   sb.stop();   sb.state();   sb.stats();   await sb.sendChat('twitch', 'text');
//
// Flow per connection: open -> Hello (wait up to helloTimeoutMs) -> if Hello carries `authentication`:
// ask getPassword(), send Authenticate, wait for the answer -> Subscribe -> system.connected.
// Auth is only attempted when the server asks for it. Downgrade guard (review E8-04): when the Hello does NOT ask for
// auth but a password is stored (getPassword() returns one) or `authRequired: true` is set, the connection is refused
// with the fatal code 'auth-expected' (no reconnect): a server that should ask for the password and does not is not
// the Streamer.bot we configured (for example another local process bound to the port first).
//
// URL (review E8-15): ws:// to a host other than loopback (127.0.0.0/8, localhost, [::1]) is refused at creation
// unless `allowRemote: true` is given (the challenge response would cross the network in clear text). Only ws:// and
// wss:// URLs are accepted.
//
// Inbound size (review E8-05): a message larger than MAX_MESSAGE_BYTES is never parsed. It is counted
// (stats.oversize), noted ('message-oversize') and the socket is closed (code 4009); the normal backoff reconnects.
// The global WebSocket (undici) has no receive-size option, so the frame itself is still buffered before the check.
//
// Reconnect: exponential backoff, base 1000 ms, factor 2, cap 30 000 ms, equal jitter (the wait is a random
// value in [d/2, d]). The attempt counter resets only after a connection has stayed connected for stableMs
// (default 30 000 ms, review E8-12), so a server that accepts and then drops at once is retried with growing waits.
// After an auth failure, a missing password, a downgrade or stop(), it does NOT reconnect
// (state 'auth-failed' / 'stopped').
//
// Safety: nothing is ever SENT to a platform in P3.
//   - sendChat() refuses with SendRefused('real-send-disabled') unless the connector was built with
//     sendEnabled === true. No P3 code path sets it (a test scans the repository source for that).
//   - The only other way a send is allowed is `allowMockSend: true` AND the server's Hello announced the
//     mock marker AND the URL host is loopback. Only tests and the mock tooling set allowMockSend.
//
// Raw payloads: mapEvent() copies only fields the E1 model knows. The raw envelope goes to the fixture
// recorder (anonymised) and nowhere else. Chat text is untrusted data and is never logged here.

import { computeAuth } from './auth.mjs';
import { mapEvent, subscribeEvents } from './map.mjs';

// Documented default port 8080 on 127.0.0.1, endpoint "/"
// (https://docs.streamer.bot/api/websocket/guide/configuration, read 2026-10-28).
export const DEFAULT_URL = 'ws://127.0.0.1:8080/';
export const MOCK_MARKER = 'ujwalam-mock-streamerbot';
export const BACKOFF = Object.freeze({ baseMs: 1000, factor: 2, capMs: 30000 });
// 1 MiB. Real Streamer.bot events are a few KiB at most (a chat message carries <= 500 characters plus metadata);
// this leaves a wide margin and stops a fake or broken server from making the core parse huge frames.
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const STABLE_MS = 30000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export class SendRefused extends Error {
  constructor(code) { super(code); this.name = 'SendRefused'; this.code = code; }
}

export const isLoopback = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '[::1]' || /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(h);
  } catch { return false; }
};
/** Throws a RangeError for a URL the connector must not use. */
export function checkUrl(url, { allowRemote = false } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new RangeError('streamerbot url is not a valid URL'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new RangeError('streamerbot url must be ws:// or wss://');
  if (u.protocol === 'ws:' && !isLoopback(url) && allowRemote !== true) {
    throw new RangeError('streamerbot url: ws:// to a non-loopback host is refused (pass allowRemote / --allow-remote to allow it)');
  }
}
const sizeOf = (data) => {
  if (typeof data === 'string') return data.length > MAX_MESSAGE_BYTES ? data.length : Buffer.byteLength(data, 'utf8');
  if (data && typeof data.byteLength === 'number') return data.byteLength; // ArrayBuffer / Buffer
  if (data && typeof data.size === 'number') return data.size;             // Blob
  return 0;
};

/**
 * opts: {
 *   core (required: createEventCore()), url, getPassword?: async () => string|null,
 *   recorder?: { record(kind, envelope) },
 *   actions?: { twitch?: name, youtube?: name, kick?: name }   // DoAction names, from config
 *   sendEnabled?, allowMockSend?,                               // see Safety above
 *   authRequired?,                                              // E8-04: refuse a Hello that asks no auth
 *   allowRemote?,                                               // E8-15: allow ws:// to a non-loopback host
 *   stableMs?, maxMessageBytes?,                                // E8-12 / E8-05 (tests shrink them)
 *   backoff?, random?, setTimer?, clearTimer?, WebSocketImpl?, helloTimeoutMs?, authTimeoutMs?, actionTimeoutMs?,
 *   onNote?: (level, code) => void                              // codes only, never payload text
 * }
 */
export function createStreamerbotConnector(opts) {
  const core = opts.core;
  const url = opts.url ?? DEFAULT_URL;
  checkUrl(url, { allowRemote: opts.allowRemote === true });
  const authRequired = opts.authRequired === true;
  const stableMs = opts.stableMs ?? STABLE_MS;
  const maxMessageBytes = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const backoff = { ...BACKOFF, ...(opts.backoff ?? {}) };
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const authTimeoutMs = opts.authTimeoutMs ?? 5000;
  const actionTimeoutMs = opts.actionTimeoutMs ?? 4000;
  const onNote = opts.onNote ?? (() => {});
  const actions = opts.actions ?? {};
  const sendEnabled = opts.sendEnabled === true;
  const allowMockSend = opts.allowMockSend === true;
  const events = subscribeEvents();

  let ws = null;
  let state = 'idle'; // idle | connecting | authenticating | subscribing | connected | waiting | auth-failed | stopped
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;
  let stableTimer = null;
  let connectedEmitted = false;
  let serverIsMock = false;
  let seq = 0;
  const pending = new Map();
  const counts = { received: 0, published: 0, deduped: 0, invalid: 0, skipped: {}, byKey: {}, reconnects: 0, fixtures: 0, parseErrors: 0, oversize: 0, binary: 0 };

  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  const sys = (kind, extra) => core.ingest({ kind, platform: 'local', source: 'streamerbot', ...extra });
  const nid = (p) => `${p}-${process.pid}-${++seq}`;

  function delayFor(n) {
    const d = Math.min(backoff.capMs, backoff.baseMs * backoff.factor ** n);
    return Math.round(d / 2 + random() * (d / 2));
  }

  function failPending(reason) {
    for (const [id, p] of pending) { clearTimer(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  }

  function request(sock, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => { pending.delete(payload.id); reject(new Error('timeout')); }, timeoutMs);
      pending.set(payload.id, { resolve, reject, timer });
      try { sock.send(JSON.stringify(payload)); } catch (e) { clearTimer(timer); pending.delete(payload.id); reject(e); }
    });
  }

  function scheduleReconnect() {
    if (stopped || state === 'auth-failed') return;
    state = 'waiting';
    const wait = delayFor(attempt++);
    counts.reconnects++;
    retryTimer = setTimer(open, wait);
  }

  function fatal(code) {
    // Stop for good: auth failure or missing password. No reconnect loop.
    stopped = true; // blocks reconnect; start() can restart explicitly
    state = 'auth-failed';
    // A caching password provider (credential.mjs) forgets its value, so the next start() reads the store again.
    try { opts.getPassword?.invalidate?.(); } catch { /* a provider hook never changes the outcome */ }
    onNote('error', code);
    try { ws?.close(); } catch { /* closing */ }
  }

  function handleEvent(msg) {
    counts.received++;
    const r = mapEvent(msg);
    if (r.skip) { bump(counts.skipped, r.skip); return; }
    const res = core.ingest(r.input);
    if (res.status === 'published') counts.published++;
    else if (res.status === 'deduped') counts.deduped++;
    else counts.invalid++;
    if (res.status === 'published') bump(counts.byKey, `${r.input.platform} ${r.input.kind}`);
    if (opts.recorder && r.input.kind.startsWith('alert.') && res.status !== 'invalid') {
      // The recorder writes asynchronously (anonymise.mjs); a sync result from a custom recorder works too.
      const fail = () => onNote('warn', 'fixture-write-failed');
      try {
        Promise.resolve(opts.recorder.record(r.input.kind, msg)).then((p) => { if (p) counts.fixtures++; }, fail);
      } catch { fail(); }
    }
  }

  async function onMessage(sock, data) {
    if (sizeOf(data) > maxMessageBytes) { // never parsed (E8-05)
      counts.oversize++;
      onNote('warn', 'message-oversize');
      try { sock.close(4009, 'message too big'); } catch { /* closing */ }
      return;
    }
    if (typeof data !== 'string') { counts.binary++; return; } // Streamer.bot sends text frames only
    let m;
    try { m = JSON.parse(data); } catch { counts.parseErrors++; return; }
    if (!m || typeof m !== 'object') return;

    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id); clearTimer(p.timer); p.resolve(m);
      return;
    }
    if (m.request === 'Hello') { await onHello(sock, m); return; }
    if (m.event && typeof m.event === 'object') handleEvent(m);
  }

  async function onHello(sock, hello) {
    clearTimer(helloTimer);
    serverIsMock = hello.info?.name === MOCK_MARKER;
    try {
      if (hello.authentication) {
        state = 'authenticating';
        const a = hello.authentication;
        // getPassword is async (credential.mjs reads Credential Manager in a child process); the loop keeps running.
        let pw = null;
        try { pw = opts.getPassword ? await opts.getPassword() : null; } catch { return fatal('auth-password-read-failed'); }
        if (stopped || ws !== sock) return; // stopped or replaced while the password was being read
        if (pw == null || pw === '') return fatal('auth-required-no-password');
        if (typeof a.salt !== 'string' || typeof a.challenge !== 'string') return fatal('auth-bad-hello');
        const id = nid('auth');
        const res = await request(sock, { request: 'Authenticate', id, authentication: computeAuth(pw, a.salt, a.challenge) }, authTimeoutMs);
        if (res.status !== 'ok') return fatal('auth-failed'); // answer shape on failure is UNVERIFIED: anything but status ok counts
      } else {
        // Downgrade guard (E8-04): no auth asked, but we expect it. A read error fails closed too.
        if (authRequired) return fatal('auth-expected');
        if (opts.getPassword) {
          state = 'authenticating';
          let pw = null;
          try { pw = await opts.getPassword(); } catch { return fatal('auth-password-read-failed'); }
          if (stopped || ws !== sock) return;
          if (pw != null && pw !== '') return fatal('auth-expected');
        }
      }
      state = 'subscribing';
      const id = nid('sub');
      const res = await request(sock, { request: 'Subscribe', id, events }, authTimeoutMs);
      if (res.status !== 'ok') { onNote('warn', 'subscribe-refused'); sock.close(); return; }
      // The backoff resets only after the connection has stayed up for stableMs (E8-12).
      clearTimer(stableTimer);
      stableTimer = setTimer(() => { stableTimer = null; if (ws === sock && state === 'connected') attempt = 0; }, stableMs);
      state = 'connected';
      connectedEmitted = true;
      sys('system.connected', { target: 'streamerbot' });
      onNote('info', 'connected');
    } catch (e) {
      // No answer, or the server closed the socket, while authenticating: treat as an auth failure and stop.
      // A network drop at exactly this moment also lands here; the cost is one manual restart, never a loop.
      if (state === 'authenticating' && !stopped) return fatal(e && e.message === 'closed' ? 'auth-closed' : 'auth-no-answer');
      if (e && e.message === 'closed') return; // closed under us; the close handler reconnects
      onNote('warn', 'handshake-failed');
      try { sock.close(); } catch { /* closing */ }
    }
  }

  let helloTimer = null;

  function open() {
    retryTimer = null;
    if (stopped) return;
    state = 'connecting';
    let sock;
    try { sock = new WS(url); } catch { scheduleReconnect(); return; }
    ws = sock;
    serverIsMock = false;
    helloTimer = setTimer(() => { onNote('warn', 'hello-timeout'); try { sock.close(); } catch { /* closing */ } }, helloTimeoutMs);

    sock.addEventListener('message', (e) => { if (ws === sock) void onMessage(sock, e.data); });
    sock.addEventListener('error', () => { /* close does the retry */ });
    sock.addEventListener('close', (e) => {
      if (ws !== sock) return;
      ws = null;
      clearTimer(helloTimer);
      clearTimer(stableTimer); stableTimer = null;
      failPending('closed');
      if (connectedEmitted) {
        connectedEmitted = false;
        sys('system.disconnected', { target: 'streamerbot', reason: stopped ? 'stopped' : `closed ${e?.code ?? ''}`.trim() });
      }
      if (state !== 'auth-failed') scheduleReconnect();
    });
  }

  function start() {
    if (retryTimer || (ws && !stopped)) return;
    ws = null; // a socket left from a stop() or an auth failure is already closing; its events are ignored
    stopped = false; attempt = 0;
    open();
  }

  function stop() {
    stopped = true;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    clearTimer(helloTimer);
    clearTimer(stableTimer); stableTimer = null;
    const sock = ws;
    ws = null; // detach first: the close handler of this socket is then ignored
    failPending('closed');
    if (connectedEmitted) {
      connectedEmitted = false;
      sys('system.disconnected', { target: 'streamerbot', reason: 'stopped' });
    }
    if (sock) { try { sock.close(); } catch { /* closing */ } }
    if (state !== 'auth-failed') state = 'stopped';
  }

  /** Reply path. In P3 this only ever reaches the mock. */
  async function sendChat(platform, text) {
    if (!(sendEnabled || (allowMockSend && serverIsMock && isLoopback(url)))) throw new SendRefused('real-send-disabled');
    if (state !== 'connected' || !ws) throw new SendRefused('not-connected');
    const name = actions[platform];
    if (!['twitch', 'youtube', 'kick'].includes(platform)) throw new SendRefused('unknown-platform');
    if (typeof name !== 'string' || name === '') throw new SendRefused('no-action-configured');
    if (typeof text !== 'string') throw new SendRefused('bad-text');
    const clean = text.replace(CONTROL, '');
    if (clean === '' || [...clean].length > 500) throw new SendRefused('bad-text');
    const id = nid('do');
    const res = await request(ws, { request: 'DoAction', id, action: { name }, args: { message: clean, platform } }, actionTimeoutMs);
    return { status: res.status === 'ok' ? 'ok' : 'error' };
  }

  return {
    start, stop, sendChat,
    state: () => state,
    url: () => url,
    stats: () => ({ ...counts, skipped: { ...counts.skipped }, byKey: { ...counts.byKey }, state }),
  };
}
