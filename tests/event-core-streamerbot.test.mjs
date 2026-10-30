// SPDX-License-Identifier: GPL-2.0-or-later
// P3 E2: Streamer.bot ingest end to end against the mock: mock WS -> connector -> core -> bus -> subscriber.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventCore } from '../services/event-core/index.mjs';
import { computeAuth } from '../services/event-core/streamerbot/auth.mjs';
import { createFixtureRecorder } from '../services/event-core/streamerbot/anonymise.mjs';
import { BACKOFF, createStreamerbotConnector, SendRefused } from '../services/event-core/streamerbot/connector.mjs';
import { EVENT_TABLE, mapEvent, subscribeEvents } from '../services/event-core/streamerbot/map.mjs';
import { openMocks, startMockStreamerbot, SAMPLES } from '../tools/mock/mock-streamerbot.mjs';
import { createChatSource, NASTY } from '../tools/mock/mock-chat.mjs';

// Every mock started by this file must be closed when it ends.
test.after(() => assert.equal(openMocks(), 0, 'a mock Streamer.bot was left open'));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evsb-')); dirs.push(d); return d; };

async function waitFor(cond, ms = 4000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Build core + collector + connector against a running mock. */
function rig(mock, extra = {}) {
  const core = createEventCore({ key: randomBytes(32) });
  const events = [];
  core.bus.subscribe({ name: 'collect', handler: (e) => { events.push(e); } });
  const notes = [];
  const sb = createStreamerbotConnector({
    core, url: mock.url, backoff: { baseMs: 20, capMs: 80 }, helloTimeoutMs: 1000, authTimeoutMs: 1000,
    onNote: (l, c) => notes.push(c), ...extra,
  });
  return { core, events, notes, sb };
}
const connected = (r) => r.sb.state() === 'connected';

test('constants: documented default URL, backoff values', () => {
  assert.deepEqual({ ...BACKOFF }, { baseMs: 1000, factor: 2, capMs: 30000 });
});

test('mapping table: chat verified, every alert row UNVERIFIED; subscribe object covers all', () => {
  assert.equal(EVENT_TABLE.filter((r) => r.verified).length, 3);
  assert.ok(EVENT_TABLE.filter((r) => r.kind.startsWith('alert.')).every((r) => r.verified === false));
  const ev = subscribeEvents();
  assert.ok(ev.Twitch.includes('ChatMessage') && ev.YouTube.includes('Message') && ev.Kick.includes('ChatMessage'));
  const kinds = new Set(EVENT_TABLE.map((r) => r.kind));
  for (const k of ['alert.follow', 'alert.sub', 'alert.resub', 'alert.giftsub', 'alert.raid', 'alert.bits', 'alert.superchat', 'alert.membership', 'alert.redemption']) assert.ok(kinds.has(k), k);
});

test('chat end to end on all three platforms, old and new shapes, empty text skipped', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  try {
    r.sb.start();
    await waitFor(() => connected(r), 4000, 'connect');
    assert.equal(r.events.filter((e) => e.kind === 'system.connected').length, 1);
    for (const k of ['twitchChat', 'twitchChatOld', 'youtubeChat', 'kickChat', 'chatEmpty', 'chatCommand']) assert.equal(mock.emit(k), 1, k);
    await waitFor(() => r.events.filter((e) => e.kind === 'chat.message').length === 5, 4000, '5 chat events');
    const chats = r.events.filter((e) => e.kind === 'chat.message');
    const by = (id) => chats.find((e) => e.platformMessageId === id);
    assert.equal(by('tw-1').platform, 'twitch');
    assert.equal(by('tw-1').user.displayName, 'Alpha9');          // new shape: user.name
    assert.equal(by('tw-1').text, 'gg that was clean');
    assert.ok(by('tw-1').user.roles.includes('subscriber'));
    assert.equal(by('tw-2').user.displayName, 'BravoK');          // old shape: message.displayName
    assert.equal(by('tw-2').text, 'behind you!');                 // old shape: message.message
    assert.equal(by('yt-1').platform, 'youtube');
    assert.equal(by('yt-1').text, 'W stream');                    // YouTube: data.message is the text
    assert.ok(by('yt-1').user.roles.includes('member'));
    assert.equal(by('k-1').platform, 'kick');
    assert.equal(by('tw-4').text, '!clip');
    assert.equal(r.sb.stats().skipped['empty-text'], 1);
    for (const e of chats) assert.equal(e.source, 'streamerbot');
  } finally { r.sb.stop(); await mock.close(); }
});

test('legacy field fallbacks (unit): name order, text order, ids', () => {
  const env = (data, source = 'Twitch', type = 'ChatMessage') => ({ event: { source, type }, data });
  const u = (data, s, t) => mapEvent(env(data, s, t)).input;
  assert.equal(u({ text: 'a', user: { name: 'N', displayName: 'D', login: 'L' } }).user.displayName, 'N');
  assert.equal(u({ text: 'a', user: { displayName: 'D', login: 'L' } }).user.displayName, 'D');
  assert.equal(u({ text: 'a', user: { login: 'L' } }).user.displayName, 'L');
  assert.equal(u({ message: { displayName: 'MD', username: 'MU', message: 'm1', text: 'm2' } }).user.displayName, 'MD');
  assert.equal(u({ message: { username: 'MU', text: 'm2' } }).user.displayName, 'MU');
  assert.equal(u({ message: { username: 'MU', text: 'm2' } }).text, 'm2');
  assert.equal(u({ text: 'T', message: { message: 'M' } }).text, 'T');          // d.text before m.message
  assert.equal(u({ message: 'plain', user: { name: 'Y' } }, 'YouTube', 'Message').text, 'plain');
  assert.equal(u({ message: { msgId: 'old1', message: 'x', username: 'q' } }).platformMessageId, 'old1');
  assert.equal(u({ messageId: 'new1', text: 'x', user: { name: 'q' } }).platformMessageId, 'new1');
  assert.equal(u({ eventId: 'yt9', message: 'x', user: { name: 'q' } }, 'YouTube', 'Message').platformMessageId, 'yt9');
  assert.equal(mapEvent(env({ text: '   ' })).skip, 'empty-text');
  assert.equal(mapEvent(env({ text: 'x' }, 'Twitch', 'NotSubscribed')).skip, 'unsubscribed');
  assert.equal(mapEvent({}).skip, 'no-event');
});

test('mapped event carries no raw payload', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  try {
    r.sb.start(); await waitFor(() => connected(r));
    mock.emit('twitchChat');
    await waitFor(() => r.events.some((e) => e.kind === 'chat.message'));
    const e = r.events.find((x) => x.kind === 'chat.message');
    const allowed = new Set(['v', 'id', 'kind', 'platform', 'source', 'platformMessageId', 'receivedAt', 'mono', 'user', 'text', 'emotes']);
    assert.ok(Object.keys(e).every((k) => allowed.has(k)), Object.keys(e).join());
    assert.ok(!JSON.stringify(e).includes('isTest'));
    assert.ok(!JSON.stringify(e).includes('"parts"'));
  } finally { r.sb.stop(); await mock.close(); }
});

test('every alert kind end to end (mapping UNVERIFIED, shapes from docs field names)', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  try {
    r.sb.start(); await waitFor(() => connected(r));
    const keys = ['twitchFollow', 'twitchSub', 'twitchReSub', 'twitchGiftBomb', 'twitchRaid', 'twitchCheer', 'twitchRedemption',
      'youtubeSuperChat', 'youtubeMember', 'kickFollow', 'kickSub'];
    for (const k of keys) assert.equal(mock.emit(k), 1, k);
    await waitFor(() => r.events.filter((e) => e.kind.startsWith('alert.')).length === keys.length, 4000, 'alerts');
    const a = (kind, platform) => r.events.find((e) => e.kind === kind && (!platform || e.platform === platform));
    assert.equal(a('alert.follow', 'twitch').user.displayName, 'EchoRider');
    assert.equal(a('alert.follow', 'kick').platform, 'kick');
    assert.equal(a('alert.sub', 'twitch').tier, '1000');
    assert.equal(a('alert.sub', 'kick').tier, '1000');
    assert.deepEqual([a('alert.resub').tier, a('alert.resub').months, a('alert.resub').message], ['2000', 7, 'still here']);
    assert.deepEqual([a('alert.giftsub').count, a('alert.giftsub').user.displayName], [5, 'Hotel22']);
    assert.deepEqual([a('alert.raid').viewers, a('alert.raid').user.displayName], [42, 'IndiaM']);
    assert.deepEqual([a('alert.bits').amount, a('alert.bits').message], [100, 'cheer100 nice']);
    assert.deepEqual([a('alert.redemption').reward, a('alert.redemption').cost, a('alert.redemption').message], ['Hydrate', 500, 'drink water']);
    assert.deepEqual([a('alert.superchat').amount, a('alert.superchat').currency], [5, 'USD']);
    assert.equal(a('alert.membership').tier, 'Regulars');
    assert.equal(r.events.filter((e) => e.kind.startsWith('alert.')).every((e) => e.platformMessageId === null), true);
  } finally { r.sb.stop(); await mock.close(); }
});

test('alert mapping edge cases (unit)', () => {
  const m = (source, type, data) => mapEvent({ event: { source, type }, data });
  // a GiftBomb is followed by one GiftSub per recipient: count only the bomb
  assert.equal(m('Twitch', 'GiftSub', { user: { name: 'g' }, fromCommunitySubGift: true }).skip, 'duplicate-of-bomb');
  assert.equal(m('Twitch', 'GiftSub', { user: { name: 'g' }, subTier: '1000' }).input.count, 1);
  // prime flag wins over tier
  assert.equal(m('Twitch', 'Sub', { user: { name: 'x' }, isPrime: true, subTier: '1000' }).input.tier, 'prime');
  // missing user -> anonymous placeholder
  assert.equal(m('Twitch', 'Cheer', { bits: 5 }).input.user.displayName, 'anonymous');
  // unusable amounts are dropped, not guessed
  assert.equal(m('Twitch', 'Cheer', { bits: 0 }).skip, 'unmapped');
  assert.equal(m('YouTube', 'SuperChat', { amount: 5 }).skip, 'unmapped');                 // no currency
  assert.equal(m('YouTube', 'SuperChat', { amount: '$12.50', currencyCode: 'usd' }).input.amount, 12.5);
  assert.equal(m('Twitch', 'Raid', { raider: { name: 'r' } }).skip, 'unmapped');          // no viewers
  assert.equal(m('Twitch', 'RewardRedemption', { user: { name: 'u' } }).skip, 'unmapped'); // no reward title
  assert.equal(m('Twitch', 'ReSub', { user: { name: 'u' } }).skip, 'unmapped');           // no months
});

test('auth: correct password connects; hash matches the documented formula', async () => {
  const { createHash } = await import('node:crypto');
  const b64 = (s) => createHash('sha256').update(s).digest('base64');
  assert.equal(computeAuth('pw', 'salt', 'chal'), b64(b64('pwsalt') + 'chal'));
  const mock = await startMockStreamerbot({ password: 'correct horse' });
  const r = rig(mock, { getPassword: async () => 'correct horse' });
  try {
    r.sb.start(); await waitFor(() => connected(r));
    assert.deepEqual(mock.authLog, ['ok']);
    mock.emit('twitchChat');
    await waitFor(() => r.events.some((e) => e.kind === 'chat.message'));
  } finally { r.sb.stop(); await mock.close(); }
});

test('auth: wrong password stops with a clear error and does not reconnect', async () => {
  const mock = await startMockStreamerbot({ password: 'right' });
  const r = rig(mock, { getPassword: async () => 'wrong' });
  try {
    r.sb.start();
    await waitFor(() => r.sb.state() === 'auth-failed');
    await new Promise((x) => setTimeout(x, 400)); // many backoff periods (20-80 ms) pass
    assert.equal(r.sb.state(), 'auth-failed');
    assert.deepEqual(mock.authLog, ['fail']);      // exactly one attempt
    assert.ok(r.notes.includes('auth-failed'));
    assert.equal(r.sb.stats().reconnects, 0);
    assert.equal(r.events.filter((e) => e.kind === 'system.connected').length, 0);
  } finally { r.sb.stop(); await mock.close(); }
});

test('auth: server wants auth but no password available -> stop, no loop, no auth attempt', async () => {
  const mock = await startMockStreamerbot({ password: 'right' });
  const r = rig(mock, { getPassword: async () => null });
  try {
    r.sb.start();
    await waitFor(() => r.sb.state() === 'auth-failed');
    await new Promise((x) => setTimeout(x, 300));
    assert.ok(r.notes.includes('auth-required-no-password'));
    assert.deepEqual(mock.authLog, []);
    assert.equal(r.sb.stats().reconnects, 0);
  } finally { r.sb.stop(); await mock.close(); }
});

test('auth off: connects when no password is stored (the store is checked once per Hello, nothing is sent)', async () => {
  const mock = await startMockStreamerbot();
  let asked = 0;
  const r = rig(mock, { getPassword: async () => { asked++; return null; } });
  try {
    r.sb.start(); await waitFor(() => connected(r));
    assert.equal(asked, 1);
    assert.deepEqual(mock.authLog, []);
  } finally { r.sb.stop(); await mock.close(); }
  // no password provider at all: connects
  const m2 = await startMockStreamerbot();
  const r2 = rig(m2);
  try { r2.sb.start(); await waitFor(() => connected(r2)); } finally { r2.sb.stop(); await m2.close(); }
});

// Review E8-04: a server that does not ask for auth while a password is stored (or authRequired is set) is refused.
test('E8-04 downgrade: stored password but the Hello asks no auth -> auth-expected, nothing subscribed or published, no reconnect', async () => {
  for (const extra of [{ getPassword: async () => 'stored-secret' }, { authRequired: true }, { authRequired: true, getPassword: async () => null }]) {
    const mock = await startMockStreamerbot({ password: null });
    const r = rig(mock, extra);
    try {
      r.sb.start();
      await waitFor(() => r.sb.state() === 'auth-failed', 4000, 'auth-failed');
      assert.ok(r.notes.includes('auth-expected'), JSON.stringify(r.notes));
      assert.deepEqual(mock.authLog, [], 'no challenge response was sent');
      assert.ok(mock.subscriptions().every((s) => s.length === 0), 'nothing subscribed');
      mock.emit('twitchChat');
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(r.events.filter((e) => e.kind === 'chat.message').length, 0, 'nothing published');
      assert.equal(r.sb.stats().reconnects, 0, 'no reconnect loop');
      assert.ok(!r.events.some((e) => e.kind === 'system.connected'));
    } finally { r.sb.stop(); await mock.close(); }
  }
  // a password read error while the Hello asks no auth also fails closed
  const mock = await startMockStreamerbot({ password: null });
  const r = rig(mock, { getPassword: async () => { throw new Error('store down'); } });
  try {
    r.sb.start();
    await waitFor(() => r.sb.state() === 'auth-failed', 4000, 'auth-failed');
    assert.ok(r.notes.includes('auth-password-read-failed'));
  } finally { r.sb.stop(); await mock.close(); }
});

// Review E8-15 part 2: ws:// to a non-loopback host is refused unless explicitly allowed.
test('E8-15 url check: non-loopback ws:// refused at creation unless allowRemote; wss:// and loopback forms allowed', () => {
  const core = createEventCore({ key: randomBytes(32) });
  for (const url of ['ws://example.invalid:8080/', 'ws://192.168.1.5:8080/', 'ws://10.0.0.1/', 'http://127.0.0.1:8080/', 'not a url', 'ws://127.0.0.1.nip.io:8080/']) {
    assert.throws(() => createStreamerbotConnector({ core, url }), RangeError, url);
  }
  for (const url of ['ws://127.0.0.1:8080/', 'ws://127.0.0.2:8080/', 'ws://localhost:8080/', 'ws://[::1]:8080/', 'wss://example.invalid/']) {
    assert.doesNotThrow(() => createStreamerbotConnector({ core, url }), url);
  }
  assert.doesNotThrow(() => createStreamerbotConnector({ core, url: 'ws://192.168.1.5:8080/', allowRemote: true }));
});

// Review E8-05: inbound size cap before JSON.parse.
test('E8-05: a message over MAX_MESSAGE_BYTES is never parsed; the socket is closed and the drop counted', async () => {
  const { MAX_MESSAGE_BYTES } = await import('../services/event-core/streamerbot/connector.mjs');
  assert.equal(MAX_MESSAGE_BYTES, 1024 * 1024);
  const [source, type, data] = SAMPLES.twitchChat;
  const chatEnv = (messageId, text) => ({ event: { source, type }, data: { ...data, messageId, text } });
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  const parse = JSON.parse;
  let bigParses = 0;
  JSON.parse = function (s, ...rest) { if (typeof s === 'string' && s.length > MAX_MESSAGE_BYTES) bigParses++; return parse.call(this, s, ...rest); };
  try {
    r.sb.start(); await waitFor(() => connected(r));
    // just under the cap: accepted (text is cut to 500 code points by the model)
    mock.emit(chatEnv('near-cap', 'a'.repeat(MAX_MESSAGE_BYTES - 4096)));
    await waitFor(() => r.events.some((e) => e.kind === 'chat.message'), 4000, 'near-cap message');
    assert.equal(r.sb.stats().oversize, 0);
    // over the cap: dropped unparsed, socket closed, reconnect follows
    mock.emit(chatEnv('over-cap', 'b'.repeat(MAX_MESSAGE_BYTES + 10)));
    await waitFor(() => r.sb.stats().oversize === 1, 4000, 'oversize counted');
    assert.ok(r.notes.includes('message-oversize'));
    await waitFor(() => r.events.some((e) => e.kind === 'system.disconnected'), 4000, 'closed');
    assert.equal(bigParses, 0, 'the oversize message was never parsed');
    await waitFor(() => connected(r), 4000, 'reconnected');
    assert.equal(r.events.filter((e) => e.kind === 'chat.message').length, 1);
  } finally { JSON.parse = parse; r.sb.stop(); await mock.close(); }
});

// Review E8-12: the backoff resets only after the connection has stayed up for stableMs.
test('E8-12: a server that accepts and then drops at once gets a bounded, growing reconnect rate', async () => {
  const mock = await startMockStreamerbot();
  const delays = [];
  const r = rig(mock, {
    backoff: { baseMs: 40, factor: 2, capMs: 640 }, random: () => 1, stableMs: 30000,
    setTimer: (fn, ms) => { if (ms >= 40 && ms <= 640) delays.push(ms); return setTimeout(fn, ms); },
  });
  let drops = 0;
  const iv = setInterval(() => { if (mock.subscriptions().some((s) => s.length)) { mock.kill(); drops++; } }, 5);
  try {
    r.sb.start();
    await new Promise((res) => setTimeout(res, 2500));
    const st = r.sb.stats();
    // waits 40, 80, 160, 320, 640, 640 ... : at most 7 reconnects fit in 2.5 s (the old reset-on-subscribe gave ~60)
    assert.ok(st.reconnects >= 3 && st.reconnects <= 8, JSON.stringify({ reconnects: st.reconnects, drops }));
    const waits = delays.filter((d) => d !== 1000 && d !== 30000);
    assert.deepEqual(waits.slice(0, 5), [40, 80, 160, 320, 640], JSON.stringify(waits));
  } finally { clearInterval(iv); r.sb.stop(); await mock.close(); }
  // a connection that stays up for stableMs resets the counter
  const m2 = await startMockStreamerbot();
  const r2 = rig(m2, { backoff: { baseMs: 40, factor: 2, capMs: 640 }, random: () => 1, stableMs: 150 });
  try {
    r2.sb.start(); await waitFor(() => connected(r2));
    m2.kill(); await waitFor(() => connected(r2) && r2.sb.stats().reconnects === 1, 4000, 'first reconnect');
    await new Promise((res) => setTimeout(res, 300)); // stable for > stableMs
    const t0 = Date.now();
    m2.kill(); await waitFor(() => connected(r2) && r2.sb.stats().reconnects === 2, 4000, 'second reconnect');
    assert.ok(Date.now() - t0 < 400, `after a stable period the wait is back to the base (${Date.now() - t0} ms)`);
  } finally { r2.sb.stop(); await m2.close(); }
});

test('reconnect after the mock is killed; disconnected and connected events; subscription redone', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  try {
    r.sb.start(); await waitFor(() => connected(r));
    mock.kill();
    await waitFor(() => r.events.some((e) => e.kind === 'system.disconnected'), 4000, 'disconnected event');
    await waitFor(() => connected(r) && mock.clientCount() === 1 && r.events.filter((e) => e.kind === 'system.connected').length === 2, 4000, 'reconnected');
    assert.ok(r.sb.stats().reconnects >= 1);
    assert.equal(mock.emit('kickChat'), 1); // resubscribed
    await waitFor(() => r.events.some((e) => e.kind === 'chat.message' && e.platform === 'kick'));
  } finally { r.sb.stop(); await mock.close(); }
});

test('reconnect when the server is down at start, and when it appears later', async () => {
  const first = await startMockStreamerbot();
  const port = first.port;
  await first.close();
  const r = rig({ url: `ws://127.0.0.1:${port}/` });
  r.sb.start();
  let mock;
  try {
    await waitFor(() => r.sb.stats().reconnects >= 2, 4000, 'failed attempts');
    mock = await startMockStreamerbot({ port });
    await waitFor(() => connected(r), 4000, 'connect when up');
  } finally { r.sb.stop(); await mock?.close(); }
});

test('hello timeout: a server that never says Hello is dropped and retried', async () => {
  const mock = await startMockStreamerbot({ helloDelayMs: 700 });
  const r = rig(mock, { helloTimeoutMs: 100 });
  try {
    r.sb.start();
    await waitFor(() => r.notes.includes('hello-timeout'), 3000, 'hello-timeout');
    assert.notEqual(r.sb.state(), 'connected');
  } finally { r.sb.stop(); await mock.close(); await new Promise((x) => setTimeout(x, 800)); }
});

test('backoff: exponential with cap and equal jitter (injected timer and random)', () => {
  const delays = [];
  const make = (random) => {
    const d = [];
    // WebSocket that always fails to construct -> every attempt schedules a reconnect
    const core = createEventCore({ key: randomBytes(32) });
    let t = null;
    const sb = createStreamerbotConnector({
      core, url: 'ws://127.0.0.1:1/', random,
      WebSocketImpl: class { constructor() { throw new Error('no'); } },
      setTimer: (fn, ms) => { d.push(ms); t = fn; return 1; }, clearTimer: () => {},
    });
    sb.start();
    for (let i = 0; i < 8; i++) t();
    sb.stop();
    return d;
  };
  assert.deepEqual(make(() => 1).slice(0, 8), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.deepEqual(make(() => 0).slice(0, 8), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  const mid = make(() => 0.5);
  assert.equal(mid[0], 750); assert.equal(mid[7], 22500);
  void delays;
});

test('send guard: refused by default, even connected to the mock; nothing reaches the mock', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock, { actions: { twitch: 'ActionT', youtube: 'ActionY', kick: 'ActionK' } });
  try {
    r.sb.start(); await waitFor(() => connected(r));
    await assert.rejects(() => r.sb.sendChat('twitch', 'hi'), (e) => e instanceof SendRefused && e.code === 'real-send-disabled');
    assert.equal(mock.doActions.length, 0);
  } finally { r.sb.stop(); await mock.close(); }
});

test('send guard: mock-only path needs the mock marker and a loopback URL', async () => {
  // allowMockSend alone is not enough: the server must announce the mock marker
  const impostor = await startMockStreamerbot({ name: 'Streamer.bot' });
  const r1 = rig(impostor, { allowMockSend: true, actions: { twitch: 'A' } });
  try {
    r1.sb.start(); await waitFor(() => connected(r1));
    await assert.rejects(() => r1.sb.sendChat('twitch', 'hi'), (e) => e.code === 'real-send-disabled');
    assert.equal(impostor.doActions.length, 0);
  } finally { r1.sb.stop(); await impostor.close(); }
  // non-loopback URL: refused at creation (E8-15); even when explicitly allowed, the mock-send path stays refused
  const core = createEventCore({ key: randomBytes(32) });
  assert.throws(() => createStreamerbotConnector({ core, url: 'ws://example.invalid:8080/', allowMockSend: true, actions: { twitch: 'A' } }), RangeError);
  const far = createStreamerbotConnector({ core, url: 'ws://example.invalid:8080/', allowRemote: true, allowMockSend: true, actions: { twitch: 'A' } });
  await assert.rejects(() => far.sendChat('twitch', 'hi'), (e) => e.code === 'real-send-disabled');
});

test('mock send recording: DoAction recorded with the configured action name; other refusals', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock, { allowMockSend: true, actions: { twitch: 'ActionT', youtube: 'ActionY' } });
  try {
    await assert.rejects(() => r.sb.sendChat('twitch', 'x'), (e) => e.code === 'real-send-disabled'); // mock marker not seen yet
    r.sb.start(); await waitFor(() => connected(r));
    assert.deepEqual(await r.sb.sendChat('twitch', 'hello\nthere'), { status: 'ok' });
    assert.deepEqual(await r.sb.sendChat('youtube', 'yo'), { status: 'ok' });
    assert.deepEqual(mock.doActions, [
      { action: { name: 'ActionT' }, args: { message: 'hellothere', platform: 'twitch' } },   // control chars stripped
      { action: { name: 'ActionY' }, args: { message: 'yo', platform: 'youtube' } },
    ]);
    await assert.rejects(() => r.sb.sendChat('kick', 'x'), (e) => e.code === 'no-action-configured');
    await assert.rejects(() => r.sb.sendChat('mixer', 'x'), (e) => e.code === 'unknown-platform');
    await assert.rejects(() => r.sb.sendChat('twitch', ''), (e) => e.code === 'bad-text');
    await assert.rejects(() => r.sb.sendChat('twitch', 'x'.repeat(501)), (e) => e.code === 'bad-text');
    assert.equal(mock.doActions.length, 2);
  } finally { r.sb.stop(); await mock.close(); }
});

test('source scan: no repository code sets the real-send flag', (t) => {
  const FLAG = 'sendEnabled';
  const re = new RegExp(`${FLAG}\\s*[:=]\\s*(true|!0|1\\b)`);
  // Scope: the whole repository (app/, services/, tools/, data/, registry/ and every other folder).
  // Excluded, and listed in this test's output below: tests/ (this file and every other test hold the flag
  // name and the mock-send flag name as plain text on purpose) and generated or private folders.
  const SKIP_ANYWHERE = ['node_modules', '.git', 'legacy', 'out', '.venv', 'docs'];
  const SKIP_TOP = ['tests'];
  const SKIP_PATHS = ['app/spike/build']; // generated build output (28 MB), accepted exclusion; listed in the output below
  const walk = (dir, out = []) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (SKIP_ANYWHERE.includes(n) || (dir === REPO && SKIP_TOP.includes(n)) || SKIP_PATHS.includes(path.relative(REPO, p).split(path.sep).join('/'))) continue;
      if (statSync(p).isDirectory()) walk(p, out); else if (/\.(mjs|js|cjs|json|ps1|cmd)$/.test(n)) out.push(p);
    }
    return out;
  };
  const files = walk(REPO);
  t.diagnostic(`source scan: ${files.length} files; excluded folders: top-level ${SKIP_TOP.join(', ')} (explicit), anywhere ${SKIP_ANYWHERE.join(', ')}, path ${SKIP_PATHS.join(', ')} (generated output)`);
  console.log(`# source scan exclusions: tests/ (explicit, holds the flag names as plain text), ${SKIP_ANYWHERE.join(', ')}, ${SKIP_PATHS.join(', ')} (generated build output); scanned ${files.length} files`);
  assert.ok(files.length > 20);
  assert.ok(files.every((f) => !path.relative(REPO, f).startsWith('tests')), 'tests/ is excluded');
  for (const top of ['services', 'tools']) assert.ok(files.some((f) => path.relative(REPO, f).startsWith(top + path.sep)), `${top}/ is scanned`);
  const hits = files.filter((f) => re.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
  // the mock-send opt-in is used only by the connector (tests are excluded from this scan)
  const mockFlag = 'allowMockSend';
  const users = files.filter((f) => readFileSync(f, 'utf8').includes(mockFlag)).map((f) => path.relative(REPO, f).replaceAll('\\', '/'));
  assert.ok(users.every((f) => f === 'services/event-core/streamerbot/connector.mjs'), users.join());
  assert.ok(!readFileSync(path.join(REPO, 'services/event-core/cli.mjs'), 'utf8').includes(mockFlag));
});

test('mock: events go only to clients subscribed to them; GetInfo and unknown requests answered', async () => {
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  try {
    r.sb.start(); await waitFor(() => connected(r));
    assert.ok(mock.subscriptions()[0].includes('Twitch.ChatMessage'));
    assert.equal(mock.emit({ event: { source: 'Twitch', type: 'ViewerCountUpdate' }, data: {} }), 0);
    assert.throws(() => mock.emit('nope'), /no sample/);
  } finally { r.sb.stop(); await mock.close(); }
});

test('mock chat script source: seeded and repeatable; nasty pool; replay through the real path', async () => {
  const a = createChatSource({ seed: 7 }); const b = createChatSource({ seed: 7 });
  const take = (s) => Array.from({ length: 20 }, () => JSON.stringify(s.next()));
  assert.deepEqual(take(a), take(b));
  assert.notDeepEqual(take(createChatSource({ seed: 8 })), take(createChatSource({ seed: 7 })));
  const nasty = createChatSource({ seed: 1, mode: 'nasty' });
  assert.deepEqual(nasty.pool, NASTY);
  const mock = await startMockStreamerbot();
  const r = rig(mock);
  try {
    r.sb.start(); await waitFor(() => connected(r));
    const burst = createChatSource({ seed: 3 }).burst();
    for (const e of burst) mock.emit(e);
    await waitFor(() => r.events.filter((e) => e.kind === 'chat.message').length === burst.length, 4000, 'burst');
    const plats = new Set(r.events.filter((e) => e.kind === 'chat.message').map((e) => e.platform));
    assert.ok(plats.size >= 2);
  } finally { r.sb.stop(); await mock.close(); }
});

test('alert fixtures recorded anonymised through the connector; chat is never recorded', async () => {
  const dir = tmp();
  const mock = await startMockStreamerbot();
  const r = rig(mock, { recorder: createFixtureRecorder({ dir }) });
  try {
    r.sb.start(); await waitFor(() => connected(r));
    for (const k of ['twitchChat', 'twitchFollow', 'twitchRaid', 'youtubeSuperChat', 'twitchRedemption']) mock.emit(k);
    await waitFor(() => r.sb.stats().fixtures === 4, 4000, 'fixtures');
    const root = path.join(dir, 'fixtures', 'alerts');
    assert.deepEqual(readdirSync(root).sort(), ['follow', 'raid', 'redemption', 'superchat']);
    const all = readdirSync(root).flatMap((k) => readdirSync(path.join(root, k)).map((f) => readFileSync(path.join(root, k, f), 'utf8'))).join('\n');
    for (const secret of ['EchoRider', 'echorider', 'IndiaM', 'indiam', 'Hydrate', 'drink water', 'Lima', 'great stream', 'UCmock2', '"201"', '205']) {
      assert.ok(!all.includes(secret), `leaked ${secret}`);
    }
    assert.ok(all.includes('"viewers": 42'));
    assert.ok(all.includes('"currencyCode": "USD"'));
    assert.ok(all.includes('<id>'));
  } finally { r.sb.stop(); await mock.close(); }
});
