// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 stable-port front (services/supervisor/front.mjs, D337) against in-process fake backends: requests forwarded with
// Host/Origin renamed, an event stream carried across a swap with every sequence number delivered once and in order
// over the same client connection, held requests, duplicate ids skipped, and every refusal / failure path.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { backendHeaders, createFront, notNewer, splitFrames } from '../services/supervisor/front.mjs';
import { HandoverRefused } from '../services/supervisor/swap.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (n) => String(n).padStart(8, '0');

async function backend(name, { delayMs = 0, refuseStreams = false } = {}) {
  const clients = new Set();
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/events')) {
      if (refuseStreams) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, host: req.headers.host, origin: req.headers.origin ?? null, body: b }));
    }, delayMs));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    name, port: srv.address().port, clients,
    emit(n) { for (const c of clients) c.write(`id: ${idOf(n)}\nevent: chat\ndata: {"n":${n}}\n\n`); },
    endAll() { for (const c of clients) c.end(); },
    close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }),
  };
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

function stream(port) {
  const st = { ns: [], comments: 0, ended: false, connections: 0 };
  const req = http.request({ host: '127.0.0.1', port, path: '/events', agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    st.connections++;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      const r = splitFrames(buf + d); buf = r.rest;
      for (const f of r.frames) { const m = /data: (.*)/.exec(f.text); if (m) st.ns.push(JSON.parse(m[1]).n); else st.comments++; }
    });
    res.on('end', () => { st.ended = true; });
  });
  req.on('error', () => { st.ended = true; });
  req.end();
  return { st, close: () => req.destroy() };
}

test('pure: header renaming, frame split, id order', () => {
  const h = backendHeaders({ host: '127.0.0.1:1000', origin: 'http://127.0.0.1:1000', connection: 'keep-alive', cookie: 'a=b' }, 1000, 2000);
  assert.deepEqual(h, { host: '127.0.0.1:2000', origin: 'http://127.0.0.1:2000', cookie: 'a=b' });
  assert.equal(backendHeaders({ host: 'evil.example:1000' }, 1000, 2000).host, 'evil.example:1000');
  assert.equal(backendHeaders({ origin: 'http://127.0.0.1:1001' }, 1000, 2000).origin, 'http://127.0.0.1:1001');
  assert.equal(backendHeaders({ host: 'localhost:1000' }, 1000, 2000).host, 'localhost:2000');
  const r = splitFrames('id: a\ndata: 1\n\n: hb\n\nid: b\nda');
  assert.deepEqual(r.frames.map((f) => f.id), ['a', null]);
  assert.equal(r.rest, 'id: b\nda');
  assert.equal(notNewer('00000002', '00000003'), true);
  assert.equal(notNewer('00000003', '00000003'), true);
  assert.equal(notNewer('00000004', '00000003'), false);
  assert.equal(notNewer('x', '00000003'), false); // other id shapes are never treated as duplicates
  assert.equal(notNewer('00000004', null), false);
});

test('requests go to the backend with Host/Origin renamed; a foreign Host is passed as it is', async (t) => {
  const a = await backend('a');
  const f = createFront({ backendPort: a.port });
  const port = await f.listen();
  t.after(async () => { await f.close(); await a.close(); });
  const r = await request(port, 'POST', '/rpc', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{"x":1}' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { name: 'a', host: `127.0.0.1:${a.port}`, origin: `http://127.0.0.1:${a.port}`, body: '{"x":1}' });
  const foreign = await request(port, 'GET', '/x', { headers: { host: 'attacker.example' } });
  assert.equal(foreign.body.host, 'attacker.example');
});

test('swap: one event stream carried over, every sequence number once and in order, same connection; held requests reach the new backend', async (t) => {
  const a = await backend('a');
  const b = await backend('b');
  const f = createFront({ backendPort: a.port });
  const port = await f.listen();
  t.after(async () => { clearInterval(timer); s1.close(); s2.close(); await f.close(); await a.close(); await b.close(); });
  const s1 = stream(port); const s2 = stream(port);
  await sleep(100);
  let n = 0; let target = a;
  const timer = setInterval(() => { if (target) target.emit(++n); }, 1);
  await sleep(100);
  // Requests sent while the swap runs are held, then answered by b.
  let during = null;
  const r = await f.switchTo(b.port, {
    handover: async () => {
      during = Promise.all([request(port, 'POST', '/rpc', { body: '1' }), request(port, 'POST', '/rpc', { body: '2' })]);
      await sleep(30);
      target = null; a.endAll(); // the old one sends everything it has, then ends its streams
      await sleep(5);
      target = b;
    },
  });
  assert.equal(r.streams, 2);
  assert.equal(r.forcedCuts, 0);
  const answers = await during;
  assert.deepEqual(answers.map((x) => x.body.name), ['b', 'b']);
  await sleep(100);
  target = null;
  await sleep(50);
  for (const s of [s1, s2]) {
    assert.equal(s.st.connections, 1);
    assert.equal(s.st.ended, false);
    assert.ok(s.st.ns.length > 50, `${s.st.ns.length} events`);
    const first = s.st.ns[0];
    assert.deepEqual(s.st.ns, Array.from({ length: s.st.ns.length }, (_, i) => first + i), 'no gap, no repeat');
    assert.equal(s.st.ns.at(-1), n);
  }
  assert.equal(f.backendPort(), b.port);
  assert.equal((await request(port, 'GET', '/x')).body.name, 'b');
});

test('swap: frames the new backend repeats (ids not newer than the last one sent) are skipped', async (t) => {
  const a = await backend('a');
  const b = await backend('b');
  const f = createFront({ backendPort: a.port });
  const port = await f.listen();
  const s = stream(port);
  t.after(async () => { s.close(); await f.close(); await a.close(); await b.close(); });
  await sleep(50);
  for (let i = 1; i <= 5; i++) a.emit(i);
  await f.switchTo(b.port, { handover: async () => { for (let i = 3; i <= 8; i++) b.emit(i); a.endAll(); } });
  await sleep(50);
  assert.deepEqual(s.st.ns, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(f.stats().skippedDuplicates, 3);
});

test('refusals keep the old backend: prepare fails, the new one refuses a stream, a request does not finish', async (t) => {
  const a = await backend('a', { delayMs: 300 });
  const bad = await backend('bad', { refuseStreams: true });
  const b = await backend('b');
  const f = createFront({ backendPort: a.port });
  const port = await f.listen();
  t.after(async () => { await f.close(); await a.close(); await bad.close(); await b.close(); });
  await assert.rejects(f.switchTo(b.port, { prepare: async () => { throw new Error('no sessions'); } }), (e) => e instanceof HandoverRefused && /prepare/.test(e.message));
  const s = stream(port);
  await sleep(50);
  await assert.rejects(f.switchTo(bad.port), (e) => e instanceof HandoverRefused && /refused an event stream/.test(e.message));
  s.close();
  const slow = request(port, 'POST', '/rpc', { body: 'slow' });
  await sleep(20);
  await assert.rejects(f.switchTo(b.port, { inflightTimeoutMs: 50 }), (e) => e instanceof HandoverRefused && /still running/.test(e.message));
  assert.equal((await slow).body.name, 'a');
  assert.equal(f.backendPort(), a.port);
  assert.equal((await request(port, 'GET', '/x')).body.name, 'a');
});

test('a failing handover rethrows (not a refusal), ends the moved streams whose old upstream ended and keeps the old port', async (t) => {
  const a = await backend('a');
  const b = await backend('b');
  const f = createFront({ backendPort: a.port });
  const port = await f.listen();
  const s = stream(port);
  t.after(async () => { s.close(); await f.close(); await a.close(); await b.close(); });
  await sleep(50);
  await assert.rejects(f.switchTo(b.port, { handover: async () => { a.endAll(); await sleep(20); throw new Error('activate failed'); } }), (e) => !(e instanceof HandoverRefused) && /activate failed/.test(e.message));
  await sleep(50);
  assert.equal(s.st.ended, true);
  assert.equal(f.backendPort(), a.port);
});

test('an old stream that does not end in time is cut and counted', async (t) => {
  const a = await backend('a');
  const b = await backend('b');
  const f = createFront({ backendPort: a.port });
  const port = await f.listen();
  const s = stream(port);
  t.after(async () => { s.close(); await f.close(); await a.close(); await b.close(); });
  await sleep(50);
  const r = await f.switchTo(b.port, { oldEndTimeoutMs: 50 });
  assert.equal(r.forcedCuts, 1);
  b.emit(1);
  await sleep(50);
  assert.deepEqual(s.st.ns, [1]);
  assert.equal(s.st.connections, 1);
});
