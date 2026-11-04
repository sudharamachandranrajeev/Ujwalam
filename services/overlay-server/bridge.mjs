// SPDX-License-Identifier: GPL-3.0-or-later
// Overlay bridge: event core -> legacy overlays, in the message formats the legacy overlays already consume.
// Node stdlib only.
//
// Two kinds of frame go down one WebSocket (text JSON), so a legacy page needs no change:
//
//  1. Streamer.bot envelopes, for the pages that open their own Streamer.bot socket (chat-charge, chat-storm) or load
//     kit/sources/streamerbot.js (chat-list, voice-callout, with ?streamerbot=1):
//       { timeStamp, event: { source: 'Twitch'|'YouTube'|'Kick', type: 'ChatMessage'|'Message' }, data: {...} }
//     The pages send { request: 'Subscribe', id, events } first and expect { id, status: 'ok' } back. Point a page at
//     this feed with ?sbHost=127.0.0.1&sbPort=<feed port>&sbPath=/ (or /display), the parameters the pages already have.
//  2. Overlay-bus frames, for the pages that listen on the kit's event bus (gg-burst, alert-box, ...):
//       { rp: 'event', type, data, timeStamp }      the same object tools/preview.html posts with window.postMessage
//     Pages cannot read a socket for these, so /_ujwalam/relay.html (one extra browser source or the host) turns them
//     into the BroadcastChannel 'rp-events' message the kit already listens to. Legacy sockets ignore these frames
//     (they return early when message.event is absent).
//
// Two paths, two scopes:
//   /          effects scope (default). Chat envelopes carry the display name and a MASKED text ('!' for a command,
//              '.' otherwise): enough for chat-charge/chat-storm (they only test empty, leading '!', and ignoreUsers),
//              no chat text leaves the event core. Bus frames: effects only.
//   /display   display scope, for the pages that DRAW chat or alerts (chat-list, alert-box). Full text exactly as the
//              event core delivered it (already moderated, capped), alert bus frames too. Pages are expected to
//              render with textContent, as the legacy ones do. Chat text is untrusted data.
//
// Security: the bridge never sees or sends the event-core API token. It is handed an in-process bus or any
// { subscribe } object and only copies whitelisted fields into frames. It is a read-only feed: every client message
// except Subscribe, UnSubscribe and GetInfo is answered with an error and ignored.
//
// GUARDS HOOK: publishEffect() calls `effectGate(effect)` before anything is sent (guards.mjs plugs in here). The default gate
// allows everything (effects are on, D8). The budget, cooldown, region and flash guards plug in there and return
// { allow: false, reason } to drop an effect. Chat-driven effects use the same gate: a page connected to
// /effects/<name> only gets a chat envelope when the gate admits <name> for that message. Nothing else here knows about guards.

import http from 'node:http';
import { acceptUpgrade } from './ws.mjs';

export const FEED_NAME = 'ujwalam-overlay-bridge';
export const MODES = Object.freeze({ '/': 'effects', '/display': 'display' });
const EFFECT_PATH_RE = /^\/effects\/([a-z0-9][a-z0-9_-]{0,31})$/;

/** Feed path -> { mode, effect? }, or null. '/effects/<name>' is the effects scope for a page that fires the effect
 *  <name> itself when it sees chat (chat-charge: charge, chat-storm: storm). The bridge asks the effect gate once per
 *  chat message for that name and sends the envelope to those pages only when the gate allows it, so chat-driven
 *  effects share the one budget. */
export function parseFeedPath(p) {
  if (MODES[p]) return { mode: MODES[p] };
  const m = EFFECT_PATH_RE.exec(p);
  return m ? { mode: 'effects', effect: m[1] } : null;
}
export const EFFECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const PLATFORM_SOURCES = {
  twitch: { source: 'Twitch', type: 'ChatMessage' },
  youtube: { source: 'YouTube', type: 'Message' },
  kick: { source: 'Kick', type: 'ChatMessage' },
};
const TIER_NUMBER = { prime: 1, 1000: 1, 2000: 2, 3000: 3 };
const BADGE_ROLES = ['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'follower'];
const nowIso = () => new Date().toISOString();

/** Text for the effects scope. Keeps only what the legacy effect pages look at: empty never reaches here, a leading '!'. */
export function maskChatText(text) {
  return String(text).trimStart().startsWith('!') ? '!' : '.';
}

/** Event-core chat.message -> Streamer.bot envelope (the new payload shape the legacy pages read first), or null. */
export function chatEnvelope(ev, scope, timeStamp = nowIso()) {
  const p = PLATFORM_SOURCES[ev?.platform];
  if (!p || ev.kind !== 'chat.message' || typeof ev.text !== 'string' || !ev.text.trim()) return null;
  const text = scope === 'display' ? ev.text : maskChatText(ev.text);
  const user = { name: String(ev.user?.displayName ?? '') };
  if (scope === 'display') {
    const badges = (ev.user?.roles ?? []).filter((r) => BADGE_ROLES.includes(r)).map((name) => ({ name }));
    if (badges.length) user.badges = badges;
  }
  const data = ev.platform === 'youtube' ? { message: text, user } : { text, user };
  return { timeStamp, event: { source: p.source, type: p.type }, data };
}

const money = (amount, currency) => (currency === 'USD' ? `$${Number(amount).toFixed(2)}` : `${Number(amount).toFixed(2)} ${currency}`);

/** Event-core alert.* -> overlay-bus { type, data } (the standard shapes in kit/rp-kit.js), or null. */
export function alertBusEvent(ev) {
  if (!ev || typeof ev.kind !== 'string' || !ev.kind.startsWith('alert.')) return null;
  const platform = ev.platform;
  const user = String(ev.user?.displayName ?? '');
  switch (ev.kind) {
    case 'alert.follow': return { type: 'follow', data: { platform, user } };
    case 'alert.sub': return { type: 'sub', data: { platform, user, tier: TIER_NUMBER[ev.tier] ?? 1 } };
    case 'alert.resub': return { type: 'sub', data: { platform, user, tier: TIER_NUMBER[ev.tier] ?? 1, months: ev.months } };
    case 'alert.giftsub': return { type: 'gift', data: { platform, user, count: ev.count, tier: TIER_NUMBER[ev.tier] ?? 1 } };
    case 'alert.raid': return { type: 'raid', data: { platform, user, viewers: ev.viewers } };
    case 'alert.membership': return { type: 'member', data: { platform, user, level: ev.tier ?? '' } };
    case 'alert.superchat': return { type: 'donation', data: { platform, user, amount: money(ev.amount, ev.currency), message: ev.message ?? '' } };
    case 'alert.bits': return { type: 'donation', data: { platform, user, amount: `${ev.amount} bits`, message: ev.message ?? '' } };
    default: return null; // alert.redemption has no legacy overlay
  }
}

/** opts: { effectGate?, maxClients?, maxBuffered?, log?, wall? }. */
export function createOverlayBridge(opts = {}) {
  const maxClients = opts.maxClients ?? 32;
  const maxBuffered = opts.maxBuffered ?? 262_144;
  const effectGate = typeof opts.effectGate === 'function' ? opts.effectGate : () => ({ allow: true });
  const wall = opts.wall ?? nowIso;
  const clients = new Set();
  const stats = { clients: 0, chatFrames: 0, busFrames: 0, effects: 0, effectsBlocked: 0, chatEffects: 0, chatGated: 0, slowDropped: 0, refused: 0 };

  function sendTo(c, obj) {
    if (c.conn.closed) return;
    if (c.conn.socket.writableLength > maxBuffered) { stats.slowDropped++; c.conn.close(1013); return; }
    c.conn.send(JSON.stringify(obj));
  }

  function addClient(conn, mode, effect) {
    if (clients.size >= maxClients) { stats.refused++; conn.close(1013); return null; }
    const c = { conn, mode, effect: effect ?? null, subs: new Map() }; // subs: Streamer.bot source -> Set of types
    clients.add(c);
    stats.clients = clients.size;
    conn.onClose(() => { clients.delete(c); stats.clients = clients.size; });
    // The real server greets first. No `authentication` member: this feed has no credential and takes none.
    sendTo(c, { timeStamp: wall(), request: 'Hello', session: 'overlay-bridge', info: { name: FEED_NAME, version: '1', mode } });
    conn.onText((text) => onClientText(c, text));
    return c;
  }

  function onClientText(c, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    const id = typeof m.id === 'string' ? m.id.slice(0, 64) : undefined;
    if (m.request === 'Subscribe') {
      const events = {};
      if (m.events && typeof m.events === 'object') {
        for (const [src, types] of Object.entries(m.events)) {
          if (!Array.isArray(types) || !Object.values(PLATFORM_SOURCES).some((p) => p.source === src)) continue;
          const keep = types.filter((t) => typeof t === 'string').slice(0, 8);
          c.subs.set(src, new Set([...(c.subs.get(src) ?? []), ...keep]));
          events[src] = keep;
        }
      }
      sendTo(c, { id, status: 'ok', events });
    } else if (m.request === 'UnSubscribe') {
      c.subs.clear();
      sendTo(c, { id, status: 'ok', events: {} });
    } else if (m.request === 'GetInfo') {
      sendTo(c, { id, status: 'ok', info: { name: FEED_NAME, version: '1', mode: c.mode } });
    } else if (m.request !== undefined) {
      sendTo(c, { id, status: 'error', error: 'read-only feed' });
    }
  }

  function broadcastBus(type, data, scopes) {
    const frame = { rp: 'event', type, data, timeStamp: wall() };
    for (const c of clients) if (scopes.includes(c.mode)) { sendTo(c, frame); stats.busFrames++; }
  }

  /** Event-core bus handler. Never throws. */
  function onEvent(ev) {
    try {
      if (ev?.kind === 'chat.message') {
        const verdicts = new Map(); // effect name -> allowed, one gate decision per chat message per effect
        for (const scope of ['effects', 'display']) {
          const targets = [...clients].filter((c) => c.mode === scope);
          if (!targets.length) continue;
          const env = chatEnvelope(ev, scope, wall());
          if (!env) continue;
          for (const c of targets) {
            if (!c.subs.get(env.event.source)?.has(env.event.type)) continue;
            if (c.effect) {
              if (!verdicts.has(c.effect)) verdicts.set(c.effect, effectGate({ name: c.effect, source: 'chat' })?.allow !== false);
              if (!verdicts.get(c.effect)) { stats.chatGated++; continue; }
              stats.chatEffects++;
            }
            sendTo(c, env); stats.chatFrames++;
          }
        }
      } else if (ev?.kind?.startsWith('alert.')) {
        const a = alertBusEvent(ev);
        if (a) broadcastBus(a.type, a.data, ['display']);
      }
    } catch { /* a bad event must not stop the feed */ }
  }

  /** Fire a named effect on the overlay bus (gg, charge, storm, campop, ...). The guards plug into effectGate. */
  function publishEffect(name, meta = {}) {
    const n = String(name ?? '').toLowerCase();
    if (!EFFECT_NAME_RE.test(n)) return { ok: false, reason: 'bad-name' };
    const verdict = effectGate({ name: n, ...meta }) ?? { allow: true };
    if (!verdict.allow) { stats.effectsBlocked++; return { ok: false, reason: String(verdict.reason ?? 'blocked') }; }
    stats.effects++;
    broadcastBus('effect', { name: n }, ['effects', 'display']);
    return { ok: true };
  }

  /** Send an effect frame that the gate has ALREADY admitted (a queued effect being released). Not for other callers. */
  function deliverEffect(name) {
    const n = String(name ?? '').toLowerCase();
    if (!EFFECT_NAME_RE.test(n)) return false;
    stats.effects++;
    broadcastBus('effect', { name: n }, ['effects', 'display']);
    return true;
  }

  /** Subscribe to chat and alert events on an event-core bus. Returns the unsubscribe function. */
  function attach(bus, name = 'overlay-bridge') {
    return bus.subscribe({ name, kinds: ['chat.', 'alert.'], handler: onEvent });
  }

  return { addClient, onEvent, publishEffect, deliverEffect, attach, stats: () => ({ ...stats, clients: clients.size }), closeAll() { for (const c of clients) c.conn.close(1001); } };
}

/** The feed's own HTTP server: WebSocket upgrades only, on its own port. opts: { bridge, port, allowedOrigins: string[] }.
 *  Host must be 127.0.0.1:<port> or localhost:<port>. A browser Origin must be in allowedOrigins; a request with no
 *  Origin (a local process, not a page) is allowed because the feed holds nothing secret and is read-only. */
export function createFeedServer({ bridge, port = 0, allowedOrigins = [] }) {
  let bound = port;
  const origins = new Set(allowedOrigins);
  const server = http.createServer((req, res) => { res.writeHead(426, { Upgrade: 'websocket', 'Cache-Control': 'no-store' }); res.end(); });
  const refuse = (socket, line) => { try { socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ } };
  server.on('upgrade', (req, socket) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return refuse(socket, '421 Misdirected Request');
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return refuse(socket, '403 Forbidden');
    const target = parseFeedPath(String(req.url).split(/[?#]/, 1)[0]); // exact match on the raw path
    if (!target) return refuse(socket, '404 Not Found');
    const conn = acceptUpgrade(req, socket);
    if (!conn) return refuse(socket, '400 Bad Request');
    bridge.addClient(conn, target.mode, target.effect);
  });
  server.on('clientError', (_e, socket) => refuse(socket, '400 Bad Request'));
  return {
    server,
    get port() { return bound; },
    allowOrigin(o) { origins.add(o); },
    listen() {
      return new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, '127.0.0.1', () => { bound = server.address().port; server.off('error', fail); ok(bound); });
      });
    },
    close() { bridge.closeAll(); return new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }); },
  };
}
