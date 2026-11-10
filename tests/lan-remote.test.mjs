// SPDX-License-Identifier: GPL-3.0-or-later
// D327 IN1 "Allow remote connections": LAN-only bind, same-subnet peers, pairing token separate from the api/system
// tokens, remote role limited to core.status and actions.request, off by default. Invented values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertLanBind, chooseLanBind, ipv4ToInt, isPrivateIPv4, lanAddresses, prefixOf, sameSubnet
} from '../services/common/lan-remote.mjs';
import { createApiServer, newToken } from '../services/event-core/api/server.mjs';
import { startService, REMOTE_FILE } from '../services/event-core/api/service.mjs';
import { createEventCore } from '../services/event-core/index.mjs';
import { tmp, cleanup } from './event-core-api-helpers.mjs';

test.after(cleanup);

test('private IPv4 only: 10/8, 172.16/12, 192.168/16; never 0.0.0.0, public, loopback, link-local, CGNAT, IPv6', () => {
  for (const a of ['10.0.0.1', '172.16.5.4', '172.31.255.254', '192.168.1.20']) assert.equal(isPrivateIPv4(a), true, a);
  for (const a of ['0.0.0.0', '8.8.8.8', '127.0.0.1', '169.254.1.1', '100.64.0.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', '::', 'fe80::1', '::ffff:192.168.1.2', '192.168.1', '192.168.01.2', '256.1.1.1', '']) {
    assert.equal(isPrivateIPv4(a), false, a);
  }
  assert.equal(ipv4ToInt('::ffff:10.0.0.1'), ipv4ToInt('10.0.0.1'));
  assert.equal(prefixOf('255.255.255.0'), 24);
  assert.equal(prefixOf('255.255.0.0'), 16);
  assert.equal(prefixOf('255.0.255.0'), null);
  assert.equal(prefixOf('0.0.0.0'), 0);
});

test('bind chooser: private, non-internal IPv4 interfaces only; a too-wide or host mask is skipped', () => {
  const ifs = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    wan: [{ address: '203.0.113.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    v6: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
    wide: [{ address: '10.1.2.3', netmask: '254.0.0.0', family: 'IPv4', internal: false }],
    lan: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.20/24' }],
    lan2: [{ address: '10.0.0.5', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(lanAddresses(ifs).map((a) => [a.address, a.prefixLen]), [['192.168.1.20', 24], ['10.0.0.5', 16]]);
  assert.deepEqual(chooseLanBind({ interfaces: ifs }), { address: '192.168.1.20', prefixLen: 24, iface: 'lan' });
  assert.equal(chooseLanBind({ interfaces: ifs, preferred: '10.0.0.5' }).address, '10.0.0.5');
  assert.equal(chooseLanBind({ interfaces: ifs, preferred: '203.0.113.7' }), null, 'a preferred public address is never used');
  assert.equal(chooseLanBind({ interfaces: { lo: ifs.lo, wan: ifs.wan } }), null);
});

test('peer filter: same subnet only', () => {
  const b = { address: '192.168.1.20', prefixLen: 24 };
  assert.equal(sameSubnet('192.168.1.99', b), true);
  assert.equal(sameSubnet('::ffff:192.168.1.99', b), true);
  for (const p of ['192.168.2.1', '127.0.0.1', '8.8.8.8', '10.0.0.1', 'fe80::1', undefined, '']) assert.equal(sameSubnet(p, b), false, String(p));
});

test('API server: refuses 0.0.0.0, public, loopback and IPv6 binds for the LAN listener; loopback API unchanged', () => {
  const core = createEventCore({ key: Buffer.alloc(32, 7), moderation: false });
  const token = newToken();
  for (const address of ['0.0.0.0', '8.8.8.8', '127.0.0.1', '::', 'fe80::1']) {
    assert.throws(() => createApiServer({ core, remote: { bind: { address, prefixLen: 24 }, token } }), /private IPv4 LAN address only/, address);
  }
  assert.throws(() => createApiServer({ core, remote: { bind: { address: '192.168.1.20', prefixLen: 0 }, token } }), /subnet/);
  assert.throws(() => createApiServer({ core, remote: { bind: { address: '192.168.1.20', prefixLen: 24 }, token: 'short' } }), /64 hex/);
  assert.throws(() => createApiServer({ core, remote: { bind: { address: '192.168.1.20', prefixLen: 24 }, token }, tokens: { api: newToken(), system: newToken() } }), /remote token only/);
  assert.throws(() => createApiServer({ core, host: '0.0.0.0' }), /127\.0\.0\.1 only/);
});

test('off by default: the service starts no LAN listener and writes no remote.json', async () => {
  const dataDir = tmp();
  const svc = await startService({ dataDir, mock: true, noStreamerbot: true, systemPipe: false, stallTracer: false, liveMarkers: false, counters: false });
  try {
    assert.equal(svc.remoteApi, null);
    assert.equal(svc.remote, null);
    assert.equal(existsSync(path.join(dataDir, REMOTE_FILE)), false);
    assert.equal(svc.api.address().host, '127.0.0.1');
  } finally { await svc.stop(); }
});

test('no private address on this machine: remote stays off (never a wider bind)', async () => {
  const dataDir = tmp();
  const lines = [];
  const svc = await startService({ dataDir, mock: true, noStreamerbot: true, systemPipe: false, stallTracer: false, liveMarkers: false, counters: false, out: (l) => lines.push(l),
    remote: { token: newToken(), interfaces: { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }] } } });
  try {
    assert.equal(svc.remoteApi, null);
    assert.ok(lines.some((l) => /remote connections: off/.test(l)));
  } finally { await svc.stop(); }
});

function req({ address, port, localAddress, token, hostHeader, method = 'POST', pathName = '/rpc', body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: hostHeader ?? `${address}:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ host: address, port, localAddress, method, path: pathName, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const lan = chooseLanBind();
test('LAN listener on a real private address: pairing token only, limited methods, no events, Host checked, other peers cut', { skip: lan ? false : 'no private IPv4 address on this machine (UNVERIFIED here)' }, async () => {
  const dataDir = tmp();
  const svc = await startService({ dataDir, mock: true, noStreamerbot: true, systemPipe: false, stallTracer: false, liveMarkers: false, counters: false, remote: { token: newToken() } });
  try {
    assert.ok(svc.remoteApi, 'listener up');
    const { address, port } = svc.remote;
    assert.equal(address, lan.address);
    assert.ok(isPrivateIPv4(address));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, REMOTE_FILE), 'utf8')), { address, port, prefixLen: lan.prefixLen });
    assert.doesNotMatch(readFileSync(path.join(dataDir, REMOTE_FILE), 'utf8'), /[0-9a-f]{64}/, 'no token in remote.json');
    const rt = svc.remoteApi.tokens.remote;
    const call = (method, params, extra = {}) => req({ address, port, localAddress: address, token: rt, body: { jsonrpc: '2.0', id: 1, method, params }, ...extra });
    // remote token: status works
    const st = await call('core.status', {});
    assert.equal(st.status, 200);
    assert.ok(st.json.result.startedAt);
    // a request goes through the gate as source 'remote'
    const ar = await call('actions.request', { id: 'state.read' });
    assert.equal(ar.status, 200, JSON.stringify(ar.json));
    // never confirm, panic, live.set, audit.*
    for (const m of ['actions.confirm', 'actions.panic', 'live.set', 'audit.verify', 'audit.export', 'audit.purge']) {
      const p = { 'actions.confirm': { confirmId: 'a'.repeat(32), phrase: 'yes', actionHash: 'b'.repeat(64) }, 'live.set': { state: 'live' } }[m] ?? {};
      const r = await call(m, p);
      assert.equal(r.status, 403, m);
    }
    // the loopback api/system tokens are refused on the LAN listener
    for (const t of [svc.tokens.api, svc.tokens.system]) {
      const r = await req({ address, port, localAddress: address, token: t, body: { jsonrpc: '2.0', id: 1, method: 'core.status', params: {} } });
      assert.equal(r.status, 401);
    }
    // the remote token is refused on the loopback API
    const lb = await req({ address: '127.0.0.1', port: svc.port, token: rt, body: { jsonrpc: '2.0', id: 1, method: 'core.status', params: {} } });
    assert.equal(lb.status, 401);
    // no event stream for remote
    const ev = await req({ address, port, localAddress: address, token: rt, method: 'GET', pathName: '/events' });
    assert.equal(ev.status, 403);
    // wrong Host header (DNS rebinding) refused
    const bh = await call('core.status', {}, { hostHeader: `evil.example:${port}` });
    assert.equal(bh.status, 403);
    // a peer outside the subnet (e.g. through a forwarded router port) is cut at the connection, before any byte is read.
    // The OS cannot make such a peer in a test, so the server's connection handler gets sockets with those addresses.
    for (const peer of ['203.0.113.9', '127.0.0.1', '10.255.255.1', undefined]) {
      if (peer === address) continue;
      const s = new net.Socket();
      Object.defineProperty(s, 'remoteAddress', { value: peer });
      svc.remoteApi.server.emit('connection', s);
      assert.equal(s.destroyed, sameSubnet(peer, { address, prefixLen: svc.remote.prefixLen }) ? false : true, String(peer));
      s.destroy();
    }
    assert.ok(svc.remoteApi.stats().peerRefused >= 2);
    // the LAN listener is not on 0.0.0.0: the loopback address does not reach it
    await assert.rejects(new Promise((resolve, reject) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(); }); s.on('error', reject); }));
  } finally { await svc.stop(); }
  assert.equal(existsSync(path.join(dataDir, REMOTE_FILE)), false, 'remote.json removed on stop');
});
