// SPDX-License-Identifier: GPL-3.0-or-later
// Overlay server and bridge tests (v1 F4 part 1): static serving and traversal, Host/Origin checks, Streamer.bot-shaped
// chat frames and overlay-bus frames against the legacy message-shape fixture, the token never reaching the feed, and the
// day-4 effect gate hook. Loopback only. The legacy folder is optional (gitignored): its smoke test skips when absent.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEventCore } from '../services/event-core/index.mjs';
import { chatEnvelope, createOverlayBridge, createOverlayServer, createRemoteBus, feedQuery, maskChatText } from '../services/overlay-server/index.mjs';
import { createParser } from '../services/overlay-server/ws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'overlays', 'legacy-capture.json'), 'utf8'));
const LEGACY = path.resolve(HERE, '..', 'legacy');
const TOKEN = 'ab12cd34'.repeat(8);
const SECRET = 'TOP-SECRET-OUTSIDE-ROOT'; // lint-allow: secret (a test sentinel for files outside the served folders, not a credential)

// ---- tiny clients ----
function get(port, urlPath, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function maskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/** Raw WebSocket client: resolves { status, frames, send(obj), nextJson(), close } after the handshake answer. */
function wsOpen(port, { urlPath = '/', origin, host } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const lines = [`GET ${urlPath} HTTP/1.1`, `Host: ${host ?? `127.0.0.1:${port}`}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13'];
    if (origin) lines.push(`Origin: ${origin}`);
    sock.write(lines.join('\r\n') + '\r\n\r\n');
    let head = Buffer.alloc(0);
    let opened = false;
    const inbox = [];
    let waiter = null;
    let closeCode = null;
    const parse = createServerFrameParser((f) => {
      if (f.opcode === 1) { const j = JSON.parse(f.payload.toString('utf8')); if (waiter) { const w = waiter; waiter = null; w(j); } else inbox.push(j); }
      if (f.opcode === 8) closeCode = f.payload.readUInt16BE(0);
    });
    sock.on('data', (chunk) => {
      if (!opened) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        const status = Number(/^HTTP\/1.1 (\d+)/.exec(head.toString('latin1'))?.[1]);
        opened = true;
        const rest = head.subarray(end + 4);
        const api = {
          status, sock,
          send: (obj) => sock.write(maskedFrame(JSON.stringify(obj))),
          sendRaw: (buf) => sock.write(buf),
          nextJson: (ms = 1000) => new Promise((ok, fail) => {
            if (inbox.length) return ok(inbox.shift());
            const t = setTimeout(() => { waiter = null; fail(new Error('timeout waiting for a frame')); }, ms);
            waiter = (j) => { clearTimeout(t); ok(j); };
          }),
          none: (ms = 120) => new Promise((ok) => setTimeout(() => ok(inbox.length === 0), ms)),
          drain: () => inbox.splice(0),
          get closeCode() { return closeCode; },
          close: () => sock.destroy(),
        };
        resolve(api);
        if (status === 101 && rest.length) parse(rest);
        return;
      }
      parse(chunk);
    });
    sock.on('error', reject);
    sock.on('close', () => { if (!opened) resolve({ status: 0, close() {} }); });
  });
}

// Server frames are unmasked; the shared parser requires masked, so a small local reader.
function createServerFrameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      onFrame({ opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) });
      buf = buf.subarray(off + len);
    }
  };
}

// ---- fixtures on disk ----
let tmp;
let overlayRoot;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'overlay-server-'));
  overlayRoot = path.join(tmp, 'root');
  mkdirSync(path.join(overlayRoot, 'overlays', 'demo'), { recursive: true });
  mkdirSync(path.join(overlayRoot, 'overlays', 'empty'), { recursive: true });
  mkdirSync(path.join(overlayRoot, 'brand'), { recursive: true });
  mkdirSync(path.join(overlayRoot, 'kit'), { recursive: true });
  mkdirSync(path.join(overlayRoot, 'secrets'), { recursive: true });
  writeFileSync(path.join(overlayRoot, 'overlays', 'demo', 'index.html'), '<!doctype html><title>demo</title>');
  writeFileSync(path.join(overlayRoot, 'overlays', 'demo', 'notes.bak'), 'not served');
  writeFileSync(path.join(overlayRoot, 'overlays', 'demo', '.hidden.js'), 'not served');
  writeFileSync(path.join(overlayRoot, 'brand', 'tokens.css'), ':root{--x:1}');
  writeFileSync(path.join(overlayRoot, 'kit', 'rp-kit.js'), 'window.RP={};');
  writeFileSync(path.join(overlayRoot, 'secrets', 'k.txt'), SECRET);
  writeFileSync(path.join(overlayRoot, 'top.txt'), SECRET);
  writeFileSync(path.join(tmp, 'outside.txt'), SECRET);
  mkdirSync(path.join(tmp, 'outside'), { recursive: true });
  writeFileSync(path.join(tmp, 'outside', 'o.txt'), SECRET);
  try { symlinkSync(path.join(tmp, 'outside'), path.join(overlayRoot, 'overlays', 'link'), 'junction'); } catch { /* no junction rights: that case is skipped below */ }
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function newEventCore() {
  return createEventCore({ key: Buffer.alloc(32, 7), moderation: false, actions: false });
}
function chatInput({ platform, user, text }) {
  return { kind: 'chat.message', platform, source: 'mock', platformMessageId: `m-${Math.random()}`, user: { platformUserId: `u-${user}`, displayName: user }, text };
}

describe('static server', () => {
  let s;
  before(async () => { s = createOverlayServer({ root: overlayRoot }); await s.start(); });
  after(() => s.stop());

  test('serves the legacy layout read-only with security headers', async () => {
    const r = await get(s.staticPort, '/overlays/demo/index.html?word=GG&canvas=vertical');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /connect-src 'self' ws:\/\/127\.0\.0\.1:\*/);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS');
    assert.equal((await get(s.staticPort, '/brand/tokens.css')).status, 200);
    assert.equal((await get(s.staticPort, '/kit/rp-kit.js')).status, 200);
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { method: 'HEAD' })).status, 200);
    assert.equal((await get(s.staticPort, '/overlays/demo/')).status, 200, 'a folder URL serves index.html');
  });

  test('serves the relay page from this service, not from the legacy folder', async () => {
    const r = await get(s.staticPort, '/_ujwalam/relay.html?feed=1');
    assert.equal(r.status, 200);
    assert.match(r.body.toString(), /relay\.js/);
    assert.equal((await get(s.staticPort, '/_ujwalam/relay.js')).status, 200);
  });

  test('no directory listing, no files outside the allowed folders, no other methods', async () => {
    assert.equal((await get(s.staticPort, '/overlays')).status, 404);
    assert.equal((await get(s.staticPort, '/overlays/demo')).status, 404);
    assert.equal((await get(s.staticPort, '/overlays/empty/')).status, 404);
    assert.equal((await get(s.staticPort, '/')).status, 404);
    assert.equal((await get(s.staticPort, '/top.txt')).status, 404);
    assert.equal((await get(s.staticPort, '/secrets/k.txt')).status, 404);
    assert.equal((await get(s.staticPort, '/overlays/demo/notes.bak')).status, 404, 'extension allowlist');
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { method: 'POST' })).status, 405);
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { method: 'OPTIONS' })).status, 405);
  });

  test('path traversal is refused in every spelling', async () => {
    const attempts = [
      '/overlays/../top.txt', '/overlays/%2e%2e/top.txt', '/overlays/%2E%2E/secrets/k.txt', '/overlays/..%2ftop.txt',
      '/overlays/%2e%2e%2f%2e%2e%2foutside.txt', '/overlays/demo/..%5c..%5ctop.txt', '/overlays\\..\\top.txt',
      '/overlays//demo/index.html', '/overlays/demo/./index.html', '/overlays/demo/%00.html', '/overlays/demo/index.html%00.png',
      '/overlays/demo/.hidden.js', '/%2e%2e/%2e%2e/top.txt', '/overlays/C:/Windows/win.ini', '/overlays/%252e%252e/top.txt',
      '/overlays/demo/..;/..;/top.txt', '//top.txt', '/brand/../secrets/k.txt',
    ];
    for (const a of attempts) {
      const r = await get(s.staticPort, a);
      assert.ok([400, 403, 404].includes(r.status), `${a} -> ${r.status}`);
      assert.ok(!r.body.toString().includes(SECRET), `${a} leaked`);
    }
  });

  test('a link inside the folder that leads outside it is refused', { skip: !existsSync(path.join(overlayRoot, 'overlays', 'link')) && 'cannot create a junction here' }, async () => {
    const r = await get(s.staticPort, '/overlays/link/o.txt');
    assert.ok([403, 404].includes(r.status), String(r.status));
    assert.ok(!r.body.toString().includes(SECRET));
  });

  test('Host header must be this server on loopback', async () => {
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { host: 'evil.example' })).status, 421);
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { host: `evil.example:${s.staticPort}` })).status, 421);
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { host: '127.0.0.1:1' })).status, 421);
    assert.equal((await get(s.staticPort, '/overlays/demo/index.html', { host: `localhost:${s.staticPort}` })).status, 200);
  });
});

describe('bridge: message shapes against the legacy capture', () => {
  let s;
  let core;
  before(async () => {
    core = newEventCore();
    s = createOverlayServer({ root: overlayRoot, bus: core.bus });
    await s.start();
  });
  after(async () => { await s.stop(); });

  const sbSub = FIXTURE.subscribe.chatCharge;

  async function connect(urlPath) {
    const c = await wsOpen(s.feedPort, { urlPath, origin: `http://127.0.0.1:${s.staticPort}` });
    assert.equal(c.status, 101);
    const hello = await c.nextJson();
    assert.equal(hello.request, 'Hello');
    assert.equal(hello.authentication, undefined, 'the feed asks for no credential');
    return c;
  }

  // The reading rules of the legacy pages (chat-charge textOf/userOf, sources/streamerbot.js chatFrom), restated as data
  // reads so the fixture says what they must find.
  function legacyRead(msg) {
    const d = msg.data || {};
    const u = d.user || {};
    const m = d.message && typeof d.message === 'object' ? d.message : {};
    const text = typeof d.message === 'string' ? d.message : (m.message ?? m.text ?? d.text ?? '');
    return { user: u.name || u.displayName || u.login || m.displayName || m.username || '', text };
  }

  test('chat: Subscribe is acknowledged, envelopes match the capture in display and effects scope', async () => {
    const eff = await connect('/');
    const dis = await connect('/display');
    for (const c of [eff, dis]) {
      c.send(sbSub);
      assert.deepEqual(await c.nextJson(), { id: 'rp-charge', status: 'ok', events: sbSub.events });
    }
    for (const row of FIXTURE.chat) {
      assert.equal(core.ingest(chatInput(row.input)).status, 'published', row.name);
      for (const [c, key] of [[eff, 'effects'], [dis, 'display']]) {
        const got = await c.nextJson();
        const { timeStamp, ...rest } = got;
        assert.match(timeStamp, /^\d{4}-\d\d-\d\dT/);
        assert.deepEqual(rest, row[key], `${row.name} (${key})`);
        const read = legacyRead(got);
        assert.equal(read.user, row.legacyReads.user, row.name);
        if (key === 'display') assert.equal(read.text, row.legacyReads.text, row.name);
        else {
          assert.equal(read.text.trim().length > 0, true, 'non-empty so chat-charge fires');
          assert.equal(read.text.charAt(0) === '!', row.legacyReads.firstChar === '!', 'skipCommands still sees a command');
        }
      }
    }
    eff.close(); dis.close();
  });

  test('chat: nothing is sent before Subscribe, and only for what was subscribed', async () => {
    const c = await connect('/display');
    core.ingest(chatInput({ platform: 'twitch', user: 'ViewerOne', text: 'early' }));
    assert.equal(await c.none(), true, 'no Subscribe, no chat');
    c.send({ request: 'Subscribe', id: 'x', events: { Kick: ['ChatMessage'] } });
    await c.nextJson();
    core.ingest(chatInput({ platform: 'twitch', user: 'ViewerOne', text: 'not kick' }));
    assert.equal(await c.none(), true);
    core.ingest(chatInput({ platform: 'kick', user: 'ViewerThree', text: 'kick one' }));
    assert.equal((await c.nextJson()).event.source, 'Kick');
    c.close();
  });

  test('effects scope never carries chat text; display scope carries it untouched (the page renders it as text)', async () => {
    const eff = await connect('/');
    const dis = await connect('/display');
    eff.send(sbSub); dis.send(sbSub);
    await eff.nextJson(); await dis.nextJson();
    const markup = '<b>gg</b> <script>alert(1)</script>';
    core.ingest(chatInput({ platform: 'kick', user: 'ViewerThree', text: markup }));
    const e = await eff.nextJson();
    const d = await dis.nextJson();
    assert.ok(!JSON.stringify(e).includes('script') && !JSON.stringify(e).includes('gg'));
    assert.equal(d.data.text, markup);
    eff.close(); dis.close();
  });

  test('overlay-bus frames: gg, charge and storm effects match the capture, in both scopes', async () => {
    const eff = await connect('/');
    const dis = await connect('/display');
    for (const row of FIXTURE.bus) {
      assert.deepEqual(s.bridge.publishEffect(row.frame.data.name, { source: 'test' }), { ok: true });
      for (const c of [eff, dis]) {
        const { timeStamp, ...rest } = await c.nextJson();
        assert.ok(timeStamp);
        assert.deepEqual(rest, row.frame, row.name);
      }
    }
    eff.close(); dis.close();
  });

  test('alerts reach the display scope only, in the standard overlay shapes', async () => {
    const eff = await connect('/');
    const dis = await connect('/display');
    for (const row of FIXTURE.alerts) {
      const { kind, platform, user, ...fields } = row.input;
      const r = core.ingest({ kind, platform, source: 'mock', platformMessageId: `a-${Math.random()}`, user: { platformUserId: `u-${user}`, displayName: user }, ...fields });
      assert.equal(r.status, 'published', JSON.stringify(r.errors));
      const { timeStamp, ...rest } = await dis.nextJson();
      assert.ok(timeStamp);
      assert.deepEqual(rest, row.frame);
    }
    assert.equal(await eff.none(), true, 'no alert text in the effects scope');
    eff.close(); dis.close();
  });

  test('the feed is read-only: other requests are answered with an error and change nothing', async () => {
    const c = await connect('/');
    for (const req of [{ request: 'DoAction', id: 'a1', action: { name: 'x' } }, { request: 'Authenticate', id: 'a2', authentication: 'x' }, { request: 'ExecuteCodeTrigger', id: 'a3' }]) {
      c.send(req);
      assert.deepEqual(await c.nextJson(), { id: req.id, status: 'error', error: 'read-only feed' });
    }
    c.send({ request: 'GetInfo', id: 'g' });
    assert.equal((await c.nextJson()).status, 'ok');
    c.close();
  });

  test('a bad frame closes the connection: unmasked, oversize', async () => {
    const a = await connect('/');
    a.sendRaw(Buffer.from([0x81, 0x02, 0x7b, 0x7d])); // unmasked client frame
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.closeCode, 1002);
    const b = await connect('/');
    b.sendRaw(maskedFrame('x'.repeat(20_000)).subarray(0, 14)); // header announces 20 000 bytes
    b.sendRaw(Buffer.from([0x81, 0xfe, 0x4e, 0x20, 1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.closeCode, 1009);
  });

  test('Host, Origin, path and handshake checks on the feed', async () => {
    const ok = `http://127.0.0.1:${s.staticPort}`;
    assert.equal((await wsOpen(s.feedPort, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await wsOpen(s.feedPort, { origin: 'null' })).status, 403);
    assert.equal((await wsOpen(s.feedPort, { origin: `http://127.0.0.1:${s.staticPort + 1}` })).status, 403);
    assert.equal((await wsOpen(s.feedPort, { origin: ok, host: 'evil.example' })).status, 421);
    assert.equal((await wsOpen(s.feedPort, { origin: ok, urlPath: '/secret' })).status, 404);
    assert.equal((await wsOpen(s.feedPort, { origin: ok, urlPath: '/display/..' })).status, 404);
    const noOrigin = await wsOpen(s.feedPort, {});
    assert.equal(noOrigin.status, 101, 'a local process without an Origin may read the read-only feed');
    noOrigin.close();
    const plain = await get(s.feedPort, '/');
    assert.equal(plain.status, 426, 'plain HTTP gets nothing');
  });

  test('the Subscribe the legacy pages send is accepted by the feed (both pages)', async () => {
    const c = await connect('/display');
    c.send(FIXTURE.subscribe.streamerbotSource);
    const ack = await c.nextJson();
    assert.equal(ack.id, 'rp-subscribe');
    assert.equal(ack.status, 'ok');
    assert.deepEqual(ack.events, { Twitch: ['ChatMessage'], YouTube: ['Message'], Kick: ['ChatMessage'] }, 'unknown sources (SpeechToText) are not offered');
    c.close();
  });
});

describe('bridge: unit', () => {
  test('maskChatText keeps only the command marker', () => {
    assert.equal(maskChatText('!clip now'), '!');
    assert.equal(maskChatText('  !clip'), '!');
    assert.equal(maskChatText('hello'), '.');
    assert.equal(maskChatText('<script>'), '.');
  });

  test('chatEnvelope skips unknown platforms and empty text, and copies only whitelisted fields', () => {
    assert.equal(chatEnvelope({ kind: 'chat.message', platform: 'local', text: 'hi', user: { displayName: 'A' } }, 'display'), null);
    assert.equal(chatEnvelope({ kind: 'chat.message', platform: 'twitch', text: '   ', user: { displayName: 'A' } }, 'display'), null);
    const env = chatEnvelope({ kind: 'chat.message', platform: 'twitch', text: 'hi', user: { displayName: 'A', pseudoId: 'p'.repeat(32), platformUserId: 'U9', roles: ['viewer', 'moderator'] }, token: TOKEN, id: 'e1' }, 'display', 'T');
    assert.deepEqual(env, { timeStamp: 'T', event: { source: 'Twitch', type: 'ChatMessage' }, data: { text: 'hi', user: { name: 'A', badges: [{ name: 'moderator' }] } } });
    assert.ok(!JSON.stringify(env).includes(TOKEN) && !JSON.stringify(env).includes('U9'));
  });

  test('effect names are validated and the day-4 gate can drop an effect', async () => {
    const seen = [];
    const bridge = createOverlayBridge({ effectGate: (e) => { seen.push(e); return e.name === 'blocked' ? { allow: false, reason: 'budget' } : { allow: true }; } });
    assert.deepEqual(bridge.publishEffect('../x'), { ok: false, reason: 'bad-name' });
    assert.deepEqual(bridge.publishEffect(''), { ok: false, reason: 'bad-name' });
    assert.deepEqual(bridge.publishEffect('blocked', { source: 'rule' }), { ok: false, reason: 'budget' });
    assert.deepEqual(bridge.publishEffect('GG'), { ok: true });
    assert.deepEqual(seen.map((e) => e.name), ['blocked', 'gg']);
    assert.equal(seen[0].source, 'rule');
    assert.equal(bridge.stats().effectsBlocked, 1);
  });

  test('feedQuery uses the parameters the legacy pages already have', () => {
    assert.equal(feedQuery(8788), 'streamerbot=1&sbHost=127.0.0.1&sbPort=8788&sbPath=/');
    assert.equal(feedQuery(8788, 'display'), 'streamerbot=1&sbHost=127.0.0.1&sbPort=8788&sbPath=/display');
    assert.throws(() => feedQuery(0));
    assert.throws(() => feedQuery('8788'));
    assert.equal(feedQuery(8788, 'effects', 'charge'), 'streamerbot=1&sbHost=127.0.0.1&sbPort=8788&sbPath=/effects/charge');
    assert.throws(() => feedQuery(8788, 'effects', '../x'));
  });

  test('effect pages in feed-scopes.json connect at /effects/<name> and name a guarded effect (D204)', async () => {
    const { overlayUrls, FEED_SCOPES_FILE } = await import('../app/host/lib/project.mjs');
    const scopes = JSON.parse(readFileSync(FEED_SCOPES_FILE, 'utf8'));
    const guards = JSON.parse(readFileSync(path.join(HERE, '..', 'data', 'effects', 'guards.json'), 'utf8'));
    for (const [folder, name] of Object.entries(scopes.effectPages)) {
      assert.ok(Object.hasOwn(guards.effects, name), `${folder} -> ${name} is in guards.json effects`);
      assert.ok(!scopes.display.includes(folder), `${folder} is not a display folder`);
    }
    const ov = (id, rel) => ({ id, file: { base: 'overlays', rel } });
    const layer = (id, overlay, query) => ({ id, type: 'browser', source: { overlay, query } });
    const project = {
      overlays: [ov('o1', 'chat-charge/index.html'), ov('o2', 'chat-list/index.html'), ov('o3', 'gg-burst/index.html')],
      scenes: [{ layers: [layer('l1', 'o1', 'h=1'), layer('l2', 'o2'), layer('l3', 'o3')] }],
    };
    const { browserUrls, relayScope } = overlayUrls(project, { staticPort: 50101, feedPort: 50102 });
    assert.equal(browserUrls.l1, 'http://127.0.0.1:50101/overlays/chat-charge/index.html?h=1&streamerbot=1&sbHost=127.0.0.1&sbPort=50102&sbPath=/effects/charge');
    assert.ok(browserUrls.l2.endsWith('sbPath=/display'));
    assert.ok(browserUrls.l3.endsWith('sbPath=/'));
    assert.equal(relayScope, 'display');
  });

  test('the frame parser demands masked client frames and bounds the payload', () => {
    assert.equal(createParser()(Buffer.from([0x81, 0x01, 0x41])).error, 1002);
    const ok = createParser()(maskedFrame('{"a":1}'));
    assert.equal(ok.frames[0].payload.toString(), '{"a":1}');
    assert.equal(createParser(10)(maskedFrame('x'.repeat(30))).error, 1009);
  });
});

describe('the event-core token never reaches an overlay', () => {
  let fake;
  let fakePort;
  let seenAuth;
  let seenUrl;
  let seenSecFetch;
  let sse;
  before(async () => {
    fake = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      seenSecFetch = Object.keys(req.headers).filter((k) => k.startsWith('sec-fetch-'));
      seenUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse = res;
      res.write(': hello\n\n');
    });
    await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
    fakePort = fake.address().port;
  });
  after(() => { sse?.destroy(); fake.closeAllConnections?.(); fake.close(); });

  test('the token goes only to the event core; frames, pages and stats never contain it', async () => {
    const remote = createRemoteBus({ url: `http://127.0.0.1:${fakePort}/events`, token: TOKEN, kinds: ['chat.', 'alert.'] });
    const s = createOverlayServer({ root: overlayRoot, bus: remote });
    await s.start();
    const c = await wsOpen(s.feedPort, { urlPath: '/display', origin: `http://127.0.0.1:${s.staticPort}` });
    await c.nextJson();
    c.send(FIXTURE.subscribe.chatCharge);
    await c.nextJson();
    for (let i = 0; i < 50 && !sse; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seenAuth, `Bearer ${TOKEN}`, 'the token is used for the one request to the event core');
    assert.ok(!seenUrl.includes(TOKEN), 'and never put in a URL');
    assert.deepEqual(seenSecFetch, [], 'no Sec-Fetch-* headers: the event core refuses those as browser requests (D62)');

    // A hostile or leaky event that carries the token in extra fields: only whitelisted fields are copied.
    const ev = { v: 1, id: 'e000000000000-00000000-aaaaaaaa', kind: 'chat.message', platform: 'twitch', source: 'streamerbot', user: { displayName: 'ViewerOne', roles: ['viewer'], pseudoId: 'a'.repeat(32), platformUserId: 'x' }, text: 'hi', token: TOKEN, authorization: `Bearer ${TOKEN}` };
    sse.write(`id: ${ev.id}\nevent: chat.message\ndata: ${JSON.stringify(ev)}\n\n`);
    const frame = await c.nextJson();
    assert.equal(frame.data.text, 'hi');

    s.bridge.publishEffect('gg');
    const eff = await c.nextJson();
    const pages = await Promise.all(['/overlays/demo/index.html', '/_ujwalam/relay.html', '/_ujwalam/relay.js', '/kit/rp-kit.js'].map((p) => get(s.staticPort, p)));
    const everything = JSON.stringify({ frame, eff, stats: s.bridge.stats() }) + pages.map((p) => JSON.stringify(p.headers) + p.body.toString()).join('');
    assert.ok(!everything.includes(TOKEN), 'token found in what an overlay can read');
    assert.ok(!everything.includes('Bearer'));
    c.close();
    await s.stop();
  });
});

describe('every legacy overlay is served unchanged (needs the gitignored legacy folder)', () => {
  const have = existsSync(path.join(LEGACY, 'overlays', 'gg-burst', 'index.html'));
  test('each overlay page and every ../../ asset it references is served byte for byte', { skip: !have && 'legacy/ not present' }, async () => {
    const s = createOverlayServer({ root: LEGACY });
    await s.start();
    try {
      const dirs = readdirSync(path.join(LEGACY, 'overlays'), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(LEGACY, 'overlays', d.name, 'index.html')));
      assert.ok(dirs.length >= 10, `found ${dirs.length} overlays`);
      let assets = 0;
      for (const d of dirs) {
        const file = path.join(LEGACY, 'overlays', d.name, 'index.html');
        const r = await get(s.staticPort, `/overlays/${d.name}/index.html`);
        assert.equal(r.status, 200, d.name);
        assert.ok(r.body.equals(readFileSync(file)), `${d.name} served unchanged`);
        const refs = [...readFileSync(file, 'utf8').matchAll(/(?:href|src)="(\.\.\/\.\.\/[^"?#]+|[a-z][\w-]*\.js)"/g)].map((m) => m[1]);
        for (const ref of refs) {
          const url = ref.startsWith('../../') ? `/${ref.slice(6)}` : `/overlays/${d.name}/${ref}`;
          const a = await get(s.staticPort, url);
          assert.equal(a.status, 200, `${d.name} -> ${url}`);
          assets++;
        }
      }
      assert.ok(assets > 20);
      const css = await get(s.staticPort, '/brand/fonts.css');
      const fonts = [...css.body.toString().matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
      assert.ok(fonts.length > 0);
      for (const f of fonts) assert.equal((await get(s.staticPort, `/brand/${f}`)).status, 200, f);
      assert.equal((await get(s.staticPort, '/engage/engage.config.json')).status, 404, 'engage data is not reachable');
      assert.equal((await get(s.staticPort, '/engage/logs/x.json')).status, 404);
    } finally { await s.stop(); }
  });
});
