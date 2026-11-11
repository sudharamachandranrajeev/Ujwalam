// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 event-core swap (D337): the swappable core in-process (standby refuses everything but core.status, the audit
// lock keeps a second writer out, hand-off and activation carry the live state and continue the id sequence, a core
// that handed over can be activated again), then real core processes behind the supervisor's front: 20 swaps while
// a mock Streamer.bot sends numbered chat, every number reaching the client once over one connection, RPC through the
// front answering throughout, and a crashing new build rolled back with the old core never interrupted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startSwappableService } from '../services/event-core/api/swappable.mjs';
import { parseArgs, swapCommand } from '../services/event-core/cli.mjs';
import { createIdGenerator } from '../services/event-core/model.mjs';
import { createFront, splitFrames } from '../services/supervisor/front.mjs';
import { coreRpc, createEventCoreSlot } from '../services/supervisor/slots.mjs';
import { killChildTree } from '../services/common/kill-tree.mjs';
import { closeAllMocks, SAMPLES, startMockStreamerbot } from '../tools/mock/mock-streamerbot.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = () => randomBytes(32).toString('hex');
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'lu3-')); dirs.push(d); return d; };
test.after(async () => { await closeAllMocks(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const chat = (n) => ({ event: { source: 'Twitch', type: 'ChatMessage' }, data: { ...SAMPLES.twitchChat[2], messageId: `seq-${n}`, text: `message ${n}` } });

/** SSE client: platformMessageId seq numbers in arrival order, event ids, connection count. */
function sse(port, token) {
  const st = { seqs: [], ids: [], connections: 0, ended: false, status: null };
  const req = http.request({ host: '127.0.0.1', port, path: '/events?kinds=chat.', agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
    st.connections++; st.status = res.statusCode;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      const r = splitFrames(buf + d); buf = r.rest;
      for (const f of r.frames) {
        const m = /^data: (.*)$/m.exec(f.text);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        st.ids.push(ev.id);
        const s = /^seq-(\d+)$/.exec(ev.platformMessageId ?? '');
        if (s) st.seqs.push(Number(s[1]));
      }
    });
    res.on('end', () => { st.ended = true; });
  });
  req.on('error', () => { st.ended = true; });
  req.end();
  return { st, close: () => req.destroy() };
}

function checkSeqs(seqs, sent) {
  const seen = new Map();
  for (const s of seqs) seen.set(s, (seen.get(s) ?? 0) + 1);
  const missing = []; const dup = [];
  for (let i = 1; i <= sent; i++) { const c = seen.get(i) ?? 0; if (c === 0) missing.push(i); if (c > 1) dup.push(i); }
  return { missing, dup };
}

test('pure: swap control lines and the id floor', () => {
  assert.deepEqual(swapCommand('swap:handoff'), { cmd: 'handoff' });
  assert.deepEqual(swapCommand(' swap:exit '), { cmd: 'exit' });
  assert.deepEqual(swapCommand('swap:activate'), { cmd: 'activate', params: {} });
  assert.deepEqual(swapCommand('swap:activate {"idFloor":"e0000000000aa-00000003-deadbeef","live":{"liveState":"live","panic":true},"remotePort":4000,"x":1}'),
    { cmd: 'activate', params: { idFloor: 'e0000000000aa-00000003-deadbeef', live: { liveState: 'live', panic: true }, remotePort: 4000 } });
  assert.equal(swapCommand('swap:activate {bad'), null);
  assert.equal(swapCommand('swap:activate []'), null);
  assert.equal(swapCommand('rearm abc'), null);
  // Same millisecond as the floor: the counter continues above it; ids sort after the floor whatever the nonce.
  const floor = createIdGenerator({ wall: () => 1000, random: () => Buffer.from('ffffffff', 'hex') })();
  const g = createIdGenerator({ wall: () => 1000, random: () => Buffer.from('00000000', 'hex'), floor });
  const a = g(); const b = g();
  assert.ok(a > floor && b > a, `${floor} < ${a} < ${b}`);
  const g2 = createIdGenerator({ wall: () => 999, floor }); // clock behind the floor: still after it
  assert.ok(g2() > floor);
  assert.ok(createIdGenerator({ floor: 'nonsense' })().startsWith('e'));
});

test('serve arguments: --lan is a switch, so the launcher argv keeps the next argument (found while wiring the swap flags)', () => {
  const a = parseArgs(['serve', '--data-dir', 'D', '--lan', '--url', 'ws://127.0.0.1:8093/', '--swap-control', '--public-port', '5000']);
  assert.equal(a.lan, true);
  assert.equal(a.url, 'ws://127.0.0.1:8093/');
  assert.equal(a['swap-control'], true);
  assert.equal(a['public-port'], '5000');
  const b = parseArgs(['serve', '--lan', '--lan-address', '192.168.1.20', '--mock']);
  assert.deepEqual({ lan: b.lan, address: b['lan-address'], mock: b.mock }, { lan: true, address: '192.168.1.20', mock: true });
});

test('in-process: standby answers core.status only; the audit lock keeps a second writer out; hand-off and re-activation', async () => {
  const dataDir = tmp();
  const tokens = { UJWALAM_EVENT_CORE_API_TOKEN: hex(), UJWALAM_EVENT_CORE_SYSTEM_TOKEN: hex() };
  const common = { dataDir, env: tokens, noStreamerbot: true, stallTracer: false, systemPipe: false, liveMarkers: false };
  const a = await startSwappableService({ ...common });
  const b = await startSwappableService({ ...common, standby: true });
  try {
    assert.equal(a.state(), 'active');
    assert.equal(b.state(), 'standby');
    const st = await coreRpc(b.port, tokens.UJWALAM_EVENT_CORE_SYSTEM_TOKEN, 'core.status');
    assert.equal(st.swap.state, 'standby');
    await assert.rejects(coreRpc(b.port, tokens.UJWALAM_EVENT_CORE_SYSTEM_TOKEN, 'live.set', { state: 'live' }), /standby/);
    // One writer per database file: the standby core cannot open the audit while the active one holds it.
    await assert.rejects(b.activate(), (e) => e.code === 'DB_LOCKED' || /lock/i.test(e.message));
    assert.equal(b.state(), 'standby');
    await coreRpc(a.port, tokens.UJWALAM_EVENT_CORE_SYSTEM_TOKEN, 'live.set', { state: 'live' });
    a.core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'x1', user: { displayName: 'A' }, text: 'hi' });
    await sleep(20);
    const h = await a.handoff();
    assert.equal(h.live.liveState, 'live');
    assert.match(h.lastId, /^e[0-9a-f]{12}-/);
    await assert.rejects(coreRpc(a.port, tokens.UJWALAM_EVENT_CORE_SYSTEM_TOKEN, 'live.set', { state: 'offline' }), /handed-over/);
    b.facade.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'x1', user: { displayName: 'A' }, text: 'hi' }); // the overlap: a duplicate
    b.facade.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'x2', user: { displayName: 'A' }, text: 'new' });
    const act = await b.activate({ idFloor: h.lastId, live: h.live });
    assert.deepEqual({ replayed: act.replayed, deduped: act.deduped }, { replayed: 2, deduped: 1 });
    const s2 = await coreRpc(b.port, tokens.UJWALAM_EVENT_CORE_SYSTEM_TOKEN, 'core.status');
    assert.equal(s2.live.liveState, 'live', 'the live lock carried over');
    // Restore path: b hands back to a, which activates again on the same process.
    const h2 = await b.handoff();
    await a.activate({ idFloor: h2.lastId, live: h2.live });
    assert.equal(a.state(), 'active');
    const r = a.core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'x3', user: { displayName: 'A' }, text: 'again' });
    assert.equal(r.status, 'published');
    assert.ok(r.event.id > h2.lastId);
  } finally { await b.stop(); await a.stop(); }
});

function rig(t) {
  const dataDir = tmp();
  const tokens = { api: hex(), system: hex() };
  const lines = [];
  return {
    dataDir, tokens, lines,
    spawnFor: (mock, frontPort) => (root, { standby }) => {
      const c = spawn(process.execPath, [path.join(root, 'services', 'event-core', 'cli.mjs'), 'serve', '--data-dir', dataDir, '--url', mock.url, '--no-fixtures', '--no-stall-tracer',
        '--swap-control', '--public-port', String(frontPort), ...(standby ? ['--standby'] : [])], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, UJWALAM_EVENT_CORE_API_TOKEN: tokens.api, UJWALAM_EVENT_CORE_SYSTEM_TOKEN: tokens.system, UJWALAM_PARENT_PIPE: '1', UJWALAM_HOST_MARKERS_TOKEN: '' },
      });
      c.stderr.on('data', (d) => lines.push(`ERR ${d}`));
      t.after(() => killChildTree(c));
      return c;
    },
  };
}

test('processes: 20 swaps under numbered chat, 0 lost, 0 duplicated, one client connection, RPC answered throughout, live lock kept', async (t) => {
  const r = rig(t);
  const mock = await startMockStreamerbot();
  const front = createFront({ backendPort: null });
  const fport = await front.listen();
  t.after(() => front.close());
  const unexpected = [];
  const slot = createEventCoreSlot({ front, root: REPO, spawn: r.spawnFor(mock, fport), systemToken: r.tokens.system, onLine: (l) => r.lines.push(l), onUnexpectedExit: (c, code) => unexpected.push(code) });
  await slot.start();
  for (let i = 0; i < 100 && !(mock.clientCount() > 0 && mock.subscriptions().some((s) => s.length)); i++) await sleep(50);
  await coreRpc(fport, r.tokens.system, 'live.set', { state: 'live' });
  const client = sse(fport, r.tokens.api);
  t.after(() => client.close());
  await sleep(200);
  let sent = 0;
  const emitter = setInterval(() => { mock.emit(chat(++sent)); }, 5);
  // RPC through the front the whole time; every answer must succeed (held during the move, never refused).
  const rpc = { ok: 0, failed: [] };
  let rpcOn = true;
  const rpcLoop = (async () => { while (rpcOn) { try { await coreRpc(fport, r.tokens.system, 'live.set', { state: 'live' }, 10_000); rpc.ok++; } catch (e) { rpc.failed.push(e.message); } await sleep(25); } })();
  const results = [];
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const s = await slot.swap(REPO);
    results.push(s.result);
    if (s.result !== 'swapped') { r.lines.push(JSON.stringify(s.history)); break; }
  }
  await sleep(300);
  clearInterval(emitter);
  await sleep(500);
  rpcOn = false; await rpcLoop;
  const status = await coreRpc(fport, r.tokens.system, 'core.status');
  await slot.stop();
  await mock.close();
  assert.deepEqual(results, Array(20).fill('swapped'), r.lines.slice(-30).join('\n'));
  const { missing, dup } = checkSeqs(client.st.seqs, sent);
  assert.equal(client.st.connections, 1, 'the client never reconnected');
  assert.deepEqual({ missing: missing.length, dup: dup.length }, { missing: 0, dup: 0 }, `missing ${missing.slice(0, 10)} dup ${dup.slice(0, 10)} of ${sent}`);
  assert.ok(sent > 500, `${sent} sent`);
  for (let i = 1; i < client.st.ids.length; i++) assert.ok(client.st.ids[i] > client.st.ids[i - 1], `ids in order at ${i}`);
  assert.deepEqual(rpc.failed, []);
  assert.ok(rpc.ok > 20);
  assert.equal(status.live.liveState, 'live');
  assert.deepEqual(unexpected, []);
  assert.equal(front.stats().forcedCuts, 0);
  t.diagnostic(`swaps 20, chat sent ${sent}, received ${client.st.seqs.length}, rpc ok ${rpc.ok}, held ${front.stats().held}`);
});

test('processes: a crashing new build is rolled back; the old core keeps serving with no event lost', async (t) => {
  const r = rig(t);
  const crash = tmp();
  mkdirSync(path.join(crash, 'services', 'event-core'), { recursive: true });
  writeFileSync(path.join(crash, 'services', 'event-core', 'cli.mjs'), "console.log('broken build'); process.exit(3);\n");
  const hang = tmp(); // starts, prints its port line, never becomes healthy
  mkdirSync(path.join(hang, 'services', 'event-core'), { recursive: true });
  writeFileSync(path.join(hang, 'services', 'event-core', 'cli.mjs'), "console.log('[serve] standby: api on 127.0.0.1:9'); setInterval(() => {}, 1000);\n");
  const mock = await startMockStreamerbot();
  const front = createFront({ backendPort: null });
  const fport = await front.listen();
  t.after(() => front.close());
  const unexpected = [];
  const slot = createEventCoreSlot({ front, root: REPO, spawn: r.spawnFor(mock, fport), systemToken: r.tokens.system, onLine: (l) => r.lines.push(l), onUnexpectedExit: (c, code) => unexpected.push(code), timeouts: { check: 2000 } });
  const port0 = await slot.start();
  for (let i = 0; i < 100 && !(mock.clientCount() > 0 && mock.subscriptions().some((s) => s.length)); i++) await sleep(50);
  const client = sse(fport, r.tokens.api);
  t.after(() => client.close());
  await sleep(200);
  let sent = 0;
  const emitter = setInterval(() => { mock.emit(chat(++sent)); }, 5);
  const a = await slot.swap(crash);
  const b = await slot.swap(hang);
  const c = await slot.swap(REPO); // a good build still swaps afterwards
  await sleep(300);
  clearInterval(emitter);
  await sleep(500);
  await slot.stop();
  await mock.close();
  assert.equal(a.result, 'kept-old');
  assert.match(a.history.find((h) => !h.ok).error, /exited \(3\)/);
  assert.equal(b.result, 'kept-old');
  assert.match(b.history.find((h) => !h.ok).error, /timed out/);
  assert.equal(c.result, 'swapped');
  assert.notEqual(front.backendPort(), port0);
  const { missing, dup } = checkSeqs(client.st.seqs, sent);
  assert.deepEqual({ missing: missing.length, dup: dup.length, connections: client.st.connections }, { missing: 0, dup: 0, connections: 1 });
  assert.deepEqual(unexpected, []);
});
