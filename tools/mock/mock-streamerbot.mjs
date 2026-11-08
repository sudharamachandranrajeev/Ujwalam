#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Mock Streamer.bot WebSocket server (P3 E2). Node stdlib only; binds 127.0.0.1 only; random port by default.
// Ported in behaviour from the legacy mock: same envelope, Hello before anything else, Subscribe/UnSubscribe/GetInfo
// answered ok, unknown requests answered ok. Additions: optional password auth (Hello carries salt+challenge,
// Authenticate verified with the same function the client uses), events delivered only to clients that subscribed
// to them, scripted replay, and a record of every DoAction (nothing is ever forwarded anywhere).
//
//   node tools/mock/mock-streamerbot.mjs [--port N] [--password P] [--every ms] [--once key,key] [--ttl-s N]
//
// Cleanup: every started mock is tracked (openMocks()) until close(); tests assert the count is 0 when they end. The CLI
// shuts itself down after --ttl-s seconds (default 900, 0 = never) and on SIGINT/SIGTERM, so a forgotten background
// copy cannot outlive a working session. tools/stray-procs.mjs reports any that is still running.
//
// The authentication failure answer shape ({status:'error'}) is a guess: UNVERIFIED against a real server.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { computeAuth } from '../../services/event-core/streamerbot/auth.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MOCK_NAME = 'ujwalam-mock-streamerbot';
const live = new Set();
/** How many mocks started in this process and not yet closed. */
export const openMocks = () => live.size;
/** Close every mock this process started and has not closed (test teardown). Returns how many were open. */
export async function closeAllMocks() { const hs = [...live]; await Promise.all(hs.map((h) => h.close())); return hs.length; }

function frame(obj, opcode = 0x1) {
  const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

/** Sample envelopes, shaped like the docs' payloads (invented values). Old-shape Twitch kept: the client reads both. */
export const SAMPLES = {
  twitchChat: ['Twitch', 'ChatMessage', { messageId: 'tw-1', text: 'gg that was clean', user: { id: '101', login: 'alpha9', name: 'Alpha9', role: 1, subscribed: true, badges: [{ name: 'subscriber' }] }, meta: { firstMessage: false, isMe: false }, parts: [], emotes: [], isTest: true }],
  twitchChatOld: ['Twitch', 'ChatMessage', { message: { msgId: 'tw-2', username: 'bravok', displayName: 'BravoK', message: 'behind you!', badges: [], role: 1 }, isTest: true }],
  youtubeChat: ['YouTube', 'Message', { eventId: 'yt-1', message: 'W stream', publishedAt: '2026-01-01T00:00:00Z', user: { id: 'UCmock1', name: 'Charlie77', isOwner: false, isModerator: false, isSponsor: true }, isTest: true }],
  kickChat: ['Kick', 'ChatMessage', { messageId: 'k-1', text: 'lets go', user: { id: '9', login: 'deltax', name: 'DeltaX', isSubscribed: false, badges: [] }, isTest: true }],
  chatEmpty: ['Twitch', 'ChatMessage', { messageId: 'tw-3', text: '   ', user: { name: 'QuietOne' }, isTest: true }],
  chatCommand: ['Twitch', 'ChatMessage', { messageId: 'tw-4', text: '!clip', user: { name: 'ClipFan' }, isTest: true }],
  // alerts: invented, shaped from the docs' example field names (UNVERIFIED)
  twitchFollow: ['Twitch', 'Follow', { user: { id: '201', login: 'echorider', name: 'EchoRider' }, followedAt: '2026-01-01T00:00:00Z', isTest: true }],
  twitchSub: ['Twitch', 'Sub', { user: { id: '202', login: 'foxj', name: 'FoxJ' }, subTier: '1000', isPrime: false, durationMonths: 1, isTest: true }],
  twitchReSub: ['Twitch', 'ReSub', { user: { id: '203', login: 'golfk', name: 'GolfKing' }, subTier: '2000', isPrime: false, cumulativeMonths: 7, durationMonths: 7, text: 'still here', isTest: true }],
  twitchGiftBomb: ['Twitch', 'GiftBomb', { user: { id: '204', login: 'hotel22', name: 'Hotel22' }, subTier: '1000', gifts: 5, isTest: true }],
  twitchRaid: ['Twitch', 'Raid', { raider: { id: '205', login: 'indiam', name: 'IndiaM' }, viewers: 42, isTest: true }],
  twitchCheer: ['Twitch', 'Cheer', { user: { id: '206', login: 'julietsam', name: 'JulietSam' }, bits: 100, text: 'cheer100 nice', isTest: true }],
  twitchRedemption: ['Twitch', 'RewardRedemption', { redemptionId: 'r-1', user: { id: '207', login: 'kilo7', name: 'Kilo7' }, reward: { title: 'Hydrate', cost: 500 }, userInput: 'drink water', isTest: true }],
  youtubeSuperChat: ['YouTube', 'SuperChat', { user: { id: 'UCmock2', name: 'Lima' }, amount: 5, currencyCode: 'USD', message: 'great stream', isTest: true }],
  youtubeMember: ['YouTube', 'NewSponsor', { user: { id: 'UCmock3', name: 'Mike' }, levelName: 'Regulars', isTest: true }],
  kickFollow: ['Kick', 'Follow', { user: { id: '301', login: 'nov', name: 'November' }, isTest: true }],
  kickSub: ['Kick', 'Subscription', { user: { id: '302', login: 'osc', name: 'Oscar' }, duration: 1, isTest: true }],
};

/**
 * opts: { port = 0, password = null, enforce = true, helloDelayMs = 0 }
 * Returns { url, port, emit(envelope|sampleKey), replay(script), doActions, subscriptions(), clientCount(), kill(), close(),
 *   setGlobal(name, value), globalReads }. GetGlobal answers { variable: { name, value }, status: 'ok' } for a set name,
 *   an error otherwise (the real answer shape is UNVERIFIED; D250).
 * kill() destroys all client sockets (simulates a crash) and keeps listening; close() stops the server.
 */
export function startMockStreamerbot(opts = {}) {
  const password = opts.password ?? null;
  const clients = new Set();
  const doActions = [];
  const authLog = [];
  const globals = new Map();
  const globalReads = [];

  function onMessage(c, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.request === 'Authenticate') {
      const ok = password != null && m.authentication === computeAuth(password, c.salt, c.challenge);
      authLog.push(ok ? 'ok' : 'fail');
      if (ok) { c.authed = true; c.send({ id: m.id, status: 'ok' }); }
      else { c.send({ id: m.id, status: 'error', error: 'authentication failed' }); setTimeout(() => c.end(), 20); }
      return;
    }
    if (password != null && opts.enforce !== false && !c.authed) {
      c.send({ id: m.id, status: 'error', error: 'authentication required' });
      return;
    }
    if (m.request === 'Subscribe') {
      for (const [src, types] of Object.entries(m.events ?? {})) for (const t of types) c.subs.add(`${src}.${t}`);
      c.send({ id: m.id, status: 'ok', events: m.events ?? {} });
    } else if (m.request === 'UnSubscribe') {
      for (const [src, types] of Object.entries(m.events ?? {})) for (const t of types) c.subs.delete(`${src}.${t}`);
      c.send({ id: m.id, status: 'ok', events: m.events ?? {} });
    } else if (m.request === 'GetInfo') {
      c.send({ id: m.id, status: 'ok', info: { name: MOCK_NAME, version: '0.0.0-mock', os: 'windows' } });
    } else if (m.request === 'GetGlobal') {
      globalReads.push({ variable: m.variable ?? null, persisted: m.persisted ?? null });
      if (globals.has(m.variable)) c.send({ id: m.id, status: 'ok', variable: { name: m.variable, value: globals.get(m.variable) } });
      else c.send({ id: m.id, status: 'error', error: 'variable not found' });
    } else if (m.request === 'DoAction') {
      doActions.push({ action: m.action ?? null, args: m.args ?? null }); // recorded, never forwarded
      c.send({ id: m.id, status: 'ok' });
    } else if (m.request) {
      c.send({ id: m.id, status: 'ok' });
    }
  }

  function parseFrames(c, buf) {
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 0x80; const maskOff = off; if (masked) off += 4;
      if (buf.length < off + len) break;
      let data = buf.subarray(off, off + len);
      if (masked) { const mask = buf.subarray(maskOff, maskOff + 4); data = Buffer.from(data.map((b, i) => b ^ mask[i % 4])); }
      buf = buf.subarray(off + len);
      if (op === 8) { c.end(); return Buffer.alloc(0); }
      if (op === 9) { c.sock.write(frame(data, 0xa)); continue; }
      if (op === 1) onMessage(c, data.toString('utf8'));
    }
    return buf;
  }

  const server = createServer((req, res) => { res.writeHead(426); res.end('WebSocket only'); });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { sock.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c = {
      sock, subs: new Set(), authed: false,
      salt: randomBytes(12).toString('base64'), challenge: randomBytes(12).toString('base64'),
      send: (o) => { if (!sock.destroyed) sock.write(frame(o)); },
      end: () => { try { sock.write(frame('', 0x8)); sock.end(); } catch { /* gone */ } clients.delete(c); },
    };
    clients.add(c);
    const hello = {
      timestamp: new Date().toISOString(), request: 'Hello', session: 'mock-session',
      info: { name: opts.name ?? MOCK_NAME, version: '0.0.0-mock', os: 'windows', mode: 'ui' },
    };
    if (password != null) hello.authentication = { salt: c.salt, challenge: c.challenge };
    const sendHello = () => c.send(hello);
    if (opts.helloDelayMs) setTimeout(sendHello, opts.helloDelayMs); else sendHello();
    let pending = Buffer.alloc(0);
    sock.on('data', (chunk) => { pending = parseFrames(c, Buffer.concat([pending, chunk])); });
    sock.on('close', () => clients.delete(c));
    sock.on('error', () => clients.delete(c));
  });

  function emit(what) {
    let env = what;
    if (typeof what === 'string') {
      const s = SAMPLES[what];
      if (!s) throw new Error(`no sample called ${what}`);
      env = { event: { source: s[0], type: s[1] }, data: s[2] };
    }
    const msg = { timeStamp: new Date().toISOString(), event: env.event, data: env.data };
    const name = `${env.event.source}.${env.event.type}`;
    let n = 0;
    for (const c of clients) if (c.subs.has(name)) { c.send(msg); n++; }
    return n; // how many clients got it
  }

  /** script: [{ sample | envelope, delayMs }]. Resolves when all are sent. */
  async function replay(script) {
    for (const s of script) {
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      emit(s.sample ?? s.envelope);
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      const handle = {
        port, url: `ws://127.0.0.1:${port}/`,
        emit, replay, doActions, authLog, globalReads,
        setGlobal: (name, value) => { globals.set(name, value); },
        subscriptions: () => [...clients].map((c) => [...c.subs]),
        clientCount: () => clients.size,
        kill() { for (const c of clients) c.sock.destroy(); clients.clear(); },
        close() { live.delete(handle); return new Promise((r) => { for (const c of clients) c.sock.destroy(); clients.clear(); server.close(() => r()); }); },
      };
      live.add(handle);
      resolve(handle);
    });
  });
}

// ---- CLI --------------------------------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith('mock-streamerbot.mjs')) {
  const arg = (name, d) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : d; };
  const mock = await startMockStreamerbot({ port: Number(arg('port', 0)), password: arg('password', null) });
  console.log(`[mock-sb] pretend Streamer.bot on ${mock.url}  (nothing here reaches a real platform)`);
  const keys = arg('once', '') ? arg('once', '').split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(SAMPLES);
  const every = Number(arg('every', 2500));
  let i = 0;
  const once = Boolean(arg('once', ''));
  const ttlS = Number(arg('ttl-s', 900));
  const stop = () => { clearInterval(t); mock.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (ttlS > 0) setTimeout(stop, ttlS * 1000).unref();
  const t = setInterval(() => {
    if (!mock.clientCount()) return;
    if (once && i >= keys.length) { clearInterval(t); return; }
    mock.emit(keys[i++ % keys.length]);
  }, every);
}
