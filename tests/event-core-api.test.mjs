// SPDX-License-Identifier: GPL-3.0-or-later
// services/event-core/api: auth, roles, browser and cross-site refusals, JSON-RPC validation, confirm flow, panic,
// audit methods, limits and timeouts. All text is invented. No chat text is printed. Temp dirs and loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createApiServer, roleTable, createSystemPipeServer, pipeRequest, pipeSddl, isOwnerOnlySddl, panicNow, panicViaPipe, withRetry, RETRY_CODES, RETRY_DELAYS_MS } from '../services/event-core/api/index.mjs';
import { currentUserSid } from '../services/event-core/config.mjs';
import { createEventCore } from '../services/event-core/index.mjs';
import { rig, raw, rpc, chat, tick, sleep, cleanup } from './event-core-api-helpers.mjs';

test.after(cleanup);

const NO_STACK = /\n\s+at |node:internal|\.mjs:\d+|[A-Z]:\\/;
const win = process.platform === 'win32';

test('bind: loopback only; non-loopback host config is refused at startup', async () => {
  const r = await rig();
  try {
    const a = r.api.address();
    assert.deepEqual(a, { host: '127.0.0.1', port: r.port });
    assert.ok(r.port > 0);
    // not reachable on the IPv6 loopback either
    await assert.rejects(() => new Promise((res, rej) => { const s = net.connect(r.port, '::1', () => { s.destroy(); res(); }); s.on('error', rej); }));
  } finally { await r.close(); }
  const core = createEventCore({ key: Buffer.alloc(32, 1), moderation: false });
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', 'example.com', '192.168.1.5', '', '127.0.0.2']) {
    assert.throws(() => createApiServer({ core, host }), RangeError, host);
  }
  assert.throws(() => createApiServer({ core, port: 70000 }), RangeError);
  assert.throws(() => createApiServer({ core, tokens: { api: 'x', system: 'y' } }), TypeError);
  const same = 'ab'.repeat(32);
  assert.throws(() => createApiServer({ core, tokens: { api: same, system: same } }), TypeError);
});

test('tokens: 32 random bytes per role, different per launch', async () => {
  const a = await rig();
  const b = await rig();
  try {
    for (const t of [a.tokens.api, a.tokens.system, b.tokens.api, b.tokens.system]) assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(new Set([a.tokens.api, a.tokens.system, b.tokens.api, b.tokens.system]).size, 4);
  } finally { await a.close(); await b.close(); }
});

test('auth: missing, wrong, wrong-length, wrong-scheme and query-string tokens are all 401 (or 400), never 200', async () => {
  const r = await rig({ limits: { authFailPerConn: 1000, authFailPerRemote: 1000 } });
  try {
    const body = { jsonrpc: '2.0', id: 1, method: 'core.status' };
    const cases = [
      ['missing', {}],
      ['empty bearer', { authorization: 'Bearer ' }],
      ['wrong', { authorization: `Bearer ${'0'.repeat(64)}` }],
      ['short', { authorization: 'Bearer abc' }],
      ['long', { authorization: `Bearer ${'a'.repeat(300)}` }],
      ['one char off', { authorization: `Bearer ${r.tokens.api.slice(0, 63)}${r.tokens.api.endsWith('0') ? '1' : '0'}` }],
      ['prefix only', { authorization: `Bearer ${r.tokens.api.slice(0, 32)}` }],
      ['token plus suffix', { authorization: `Bearer ${r.tokens.api}x` }],
      ['basic scheme', { authorization: `Basic ${r.tokens.api}` }],
      ['lower-case scheme', { authorization: `bearer ${r.tokens.api}` }],
      ['no scheme', { authorization: r.tokens.api }],
      ['x-api-key style', { 'x-api-key': r.tokens.api }],
    ];
    for (const [name, headers] of cases) {
      const res = await raw({ port: r.port, headers, body });
      assert.equal(res.status, 401, name);
      assert.ok(!res.text.includes(r.tokens.api), name);
      assert.doesNotMatch(res.text, NO_STACK);
    }
    // a token in the query string is refused outright (400) and never authenticates
    const q = await raw({ port: r.port, path: `/rpc?token=${r.tokens.api}`, body });
    assert.equal(q.status, 400);
    const q2 = await raw({ port: r.port, method: 'GET', path: `/events?token=${r.tokens.api}` });
    assert.equal(q2.status, 401);
    // the right token works
    const ok = await rpc(r, r.tokens.api, 'core.status');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.jsonrpc, '2.0');
  } finally { await r.close(); }
});

test('failed-auth rate limit: 3 on one connection closes it with 429; 20 per remote per minute then 429; valid tokens still pass', async () => {
  const r = await rig();
  try {
    const { default: http } = await import('node:http');
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      try { seen.push((await raw({ port: r.port, token: 'f'.repeat(64), body: { jsonrpc: '2.0', id: 1, method: 'core.status' }, agent })).status); } catch { seen.push('reset'); }
    }
    agent.destroy();
    assert.deepEqual(seen.slice(0, 3), [401, 401, 429]);
    assert.ok(r.api.stats().rateLimited >= 1);
  } finally { await r.close(); }
  const r2 = await rig({ limits: { authFailPerConn: 1000, authFailPerRemote: 5 } });
  try {
    const out = [];
    for (let i = 0; i < 8; i++) out.push((await raw({ port: r2.port, token: 'e'.repeat(64), body: { jsonrpc: '2.0', id: 1, method: 'core.status' } })).status);
    assert.deepEqual(out, [401, 401, 401, 401, 401, 429, 429, 429]);
    const retry = await raw({ port: r2.port, token: 'e'.repeat(64), body: { jsonrpc: '2.0', id: 1, method: 'core.status' } });
    assert.equal(retry.headers['retry-after'], '60');
    // a valid token is not locked out by someone else's failures (a lockout would be a local DoS)
    assert.equal((await rpc(r2, r2.tokens.api, 'core.status')).status, 200);
  } finally { await r2.close(); }
});

test('browser and cross-site refusals: Host spoof, Origin, Sec-Fetch-*, preflight, no CORS headers', async () => {
  const r = await rig();
  const body = { jsonrpc: '2.0', id: 1, method: 'core.status' };
  try {
    const call = (extra) => raw({ port: r.port, token: r.tokens.api, body, ...extra });
    // Host must be exactly 127.0.0.1:<port> or localhost:<port>
    for (const host of ['evil.example', 'evil.example:' + r.port, '127.0.0.1', `127.0.0.1:${r.port + 1}`, `127.0.0.1.evil.example:${r.port}`, `[::1]:${r.port}`, `0.0.0.0:${r.port}`, 'localhost', `localhost.evil.example:${r.port}`, `127.0.0.1:${r.port}, evil.example`, ` 127.0.0.1:${r.port}x`]) {
      const res = await call({ host });
      assert.equal(res.status, 403, host);
      assert.equal(res.json.error.code, 'bad-host');
    }
    assert.equal((await call({ host: `127.0.0.1:${r.port}` })).status, 200);
    assert.equal((await call({ host: `localhost:${r.port}` })).status, 200);
    // Origin of any value
    for (const origin of ['https://evil.example', 'http://127.0.0.1:' + r.port, 'null', '']) {
      const res = await call({ headers: { origin } });
      assert.equal(res.status, 403, `origin ${origin}`);
      assert.equal(res.json.error.code, 'origin-refused');
    }
    // Sec-Fetch-Site: the header's presence is refused, whatever the value ('none' = a browser typed navigation)
    for (const v of ['cross-site', 'same-site', 'same-origin', 'none', 'bogus']) {
      const res = await call({ headers: { 'sec-fetch-site': v } });
      assert.equal(res.status, 403, v);
      assert.equal(res.json.error.code, 'browser-request-refused');
    }
    assert.equal((await call({ headers: { 'sec-fetch-mode': 'cors' } })).status, 403);
    assert.equal((await call({ headers: { 'sec-fetch-dest': 'empty' } })).status, 403);
    // the checks run before auth: a spoofed Host with no token says nothing about tokens
    assert.equal((await raw({ port: r.port, host: 'evil.example', body })).status, 403);
    // preflight: OPTIONS is 405 (and 403 first when it carries an Origin, as a browser's does)
    const pre = await raw({ port: r.port, method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403);
    const opt = await raw({ port: r.port, method: 'OPTIONS' });
    assert.equal(opt.status, 405);
    assert.equal((await raw({ port: r.port, method: 'OPTIONS', path: '/events' })).status, 405);
    // no CORS headers anywhere
    for (const res of [pre, opt, await call({}), await call({ headers: { origin: 'https://evil.example' } }), await raw({ port: r.port, body })]) {
      for (const h of Object.keys(res.headers)) assert.ok(!h.startsWith('access-control-'), h);
    }
  } finally { await r.close(); }
});

test('response headers: no-store and nosniff on success, errors and refusals', async () => {
  const r = await rig();
  try {
    const rs = [
      await rpc(r, r.tokens.api, 'core.status'),
      await raw({ port: r.port, body: { jsonrpc: '2.0', id: 1, method: 'core.status' } }),
      await raw({ port: r.port, path: '/nope', method: 'GET' }),
      await raw({ port: r.port, host: 'evil.example', body: {} }),
      await raw({ port: r.port, method: 'GET' }),
    ];
    for (const x of rs) {
      assert.equal(x.headers['cache-control'], 'no-store');
      assert.equal(x.headers['x-content-type-options'], 'nosniff');
    }
    assert.deepEqual(rs.map((x) => x.status), [200, 401, 404, 403, 405]);
    assert.equal(rs[4].headers.allow, 'POST');
    assert.equal((await raw({ port: r.port, method: 'POST', path: '/events', token: r.tokens.api })).headers.allow, 'GET');
  } finally { await r.close(); }
});

test('Content-Type: only application/json (optional utf-8 charset) is accepted; form and text/plain get 415', async () => {
  const r = await rig();
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'core.status' });
    const post = (ct, b = body) => raw({ port: r.port, token: r.tokens.api, body: b, headers: ct === undefined ? {} : { 'content-type': ct } });
    for (const ct of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-patch+json', 'application/jsonx', 'text/json', 'application/xml', '']) {
      assert.equal((await post(ct)).status, 415, ct);
    }
    assert.equal((await raw({ port: r.port, token: r.tokens.api, body })).status, 415, 'no content-type at all');
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8']) {
      assert.equal((await post(ct)).status, 200, ct);
    }
    assert.equal((await post('application/json; charset=latin1')).status, 415);
  } finally { await r.close(); }
});

test('body: 64 KiB cap (Content-Length and chunked), malformed JSON, invalid UTF-8, batches refused, bad envelopes', async () => {
  const r = await rig();
  try {
    const hdr = { 'content-type': 'application/json' };
    const post = (b, extra = {}) => raw({ port: r.port, token: r.tokens.api, headers: hdr, body: b, ...extra });
    const env = (extra) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'core.status', ...extra });
    // exactly 65536 bytes parses; one more is 413
    const base = env({});
    const exact = base + ' '.repeat(65536 - Buffer.byteLength(base));
    assert.equal(Buffer.byteLength(exact), 65536);
    assert.equal((await post(exact)).status, 200);
    assert.equal((await post(exact + ' ')).status, 413);
    // chunked, no Content-Length
    const big = Buffer.alloc(70_000, 0x20);
    const ch = await post(big, { chunked: true });
    assert.equal(ch.status, 413);
    // a lying small Content-Length cannot smuggle a large body: node rejects or truncates it; never 200 with the big text
    // malformed
    for (const bad of ['{', '', 'not json', '{"jsonrpc":"2.0","id":1,"method":', '\u0000']) {
      const res = await post(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.json.error.code, -32700);
    }
    const badUtf8 = await post(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"core.status","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]));
    assert.equal(badUtf8.status, 400);
    // batch: refused (not capped)
    const batch = await post(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'core.status' }]));
    assert.equal(batch.status, 400);
    assert.equal(batch.json.error.message, 'batch-not-supported');
    assert.equal((await post('[]')).status, 400);
    // envelope problems
    for (const b of [
      '"str"', '123', 'null', 'true',
      env({ jsonrpc: '1.0' }), env({ method: 5 }), env({ id: null }), env({ id: 1.5 }), env({ id: {} }), env({ id: '' }), env({ id: 'x'.repeat(65) }),
      env({ source: 'system' }), env({ extra: 1 }), env({ method: 'x'.repeat(65) }),
    ]) {
      const res = await post(b);
      assert.equal(res.status, 400, b);
      assert.equal(res.json.error.code, -32600, b);
    }
    // a notification (no id) is refused: this API always answers
    assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', method: 'core.status' }))).status, 400);
    // __proto__ keys do not pollute and are refused as unknown fields
    const pp = await post('{"jsonrpc":"2.0","id":1,"method":"core.status","params":{"__proto__":{"x":1}}}');
    assert.equal(pp.json.error.code, -32602);
    assert.equal({}.x, undefined);
  } finally { await r.close(); }
});

test('methods: unknown method, strict params (unknown field, wrong type, positional) are refused', async () => {
  const r = await rig({ audit: true });
  try {
    const t = r.tokens.api;
    assert.equal((await rpc(r, t, 'nope.nothing')).error.code, -32601);
    assert.equal((await rpc(r, t, 'constructor')).error.code, -32601);
    assert.equal((await rpc(r, t, '__proto__')).error.code, -32601);
    assert.equal((await rpc(r, t, 'toString')).error.code, -32601);
    const bad = [
      ['core.status', { x: 1 }], ['core.status', []], ['core.status', 'str'], ['core.status', null],
      ['actions.request', {}], ['actions.request', { id: 5 }], ['actions.request', { id: 'Bad Id' }], ['actions.request', { id: 'state.read', extra: 1 }],
      ['actions.request', { id: 'state.read', params: [] }], ['actions.request', { id: 'state.read', params: 'x' }],
      ['actions.confirm', { confirmId: 'x', phrase: 'yes', actionHash: 'y' }], ['actions.confirm', { confirmId: 'a'.repeat(32), phrase: 'y'.repeat(41), actionHash: 'b'.repeat(64) }],
      ['actions.panic', { reason: 'has <script>' }], ['actions.panic', { reason: 'x'.repeat(201) }], ['actions.panic', { why: 'x' }],
      ['audit.export', { limit: 0 }], ['audit.export', { limit: 501 }], ['audit.export', { afterId: -1 }], ['audit.export', { afterId: 1.5 }], ['audit.export', { limit: '5' }],
      ['audit.purge', { all: 'yes' }], ['audit.purge', { olderThanDays: -1 }], ['audit.purge', { olderThanDays: Infinity }], ['audit.purge', { olderThanDays: 5, all: true }], ['audit.purge', { force: true }],
      ['audit.verify', { x: 1 }],
    ];
    for (const [m, p] of bad) {
      const res = await rpc(r, t, m, p);
      assert.equal(res.error?.code, -32602, `${m} ${JSON.stringify(p)}`);
    }
    // positional params
    const pos = await raw({ port: r.port, token: t, body: { jsonrpc: '2.0', id: 1, method: 'core.status', params: [] } });
    assert.equal(pos.json.error.code, -32602);
    assert.equal(r.calls.length, 0);
  } finally { await r.close(); }
});

test('roles table: each method is callable by exactly its declared roles (403 otherwise)', async () => {
  const expected = {
    // 'remote' (D327 IN1) exists only on the LAN listener; tests/lan-remote.test.mjs covers it
    'core.status': ['api', 'system', 'remote'], 'actions.request': ['api', 'system', 'remote'], 'actions.confirm': ['api'], 'actions.panic': ['api', 'system'],
    'live.set': ['system'], 'audit.verify': ['api', 'system'], 'audit.export': ['api'], 'audit.purge': ['api'],
  };
  assert.deepEqual(roleTable(), expected);
  const r = await rig({ audit: true });
  try {
    const valid = {
      'core.status': {}, 'actions.request': { id: 'state.read' }, 'actions.confirm': { confirmId: 'a'.repeat(32), phrase: 'yes', actionHash: 'b'.repeat(64) },
      'actions.panic': { reason: 'role table test' }, 'live.set': { state: 'unknown' }, 'audit.verify': {}, 'audit.export': { limit: 1 }, 'audit.purge': { olderThanDays: 30 },
    };
    assert.deepEqual(Object.keys(valid).sort(), Object.keys(expected).sort());
    for (const role of ['api', 'system']) {
      for (const [m, roles] of Object.entries(expected)) {
        const res = await rpc(r, r.tokens[role], m, valid[m]);
        if (roles.includes(role)) assert.notEqual(res.status, 403, `${role} ${m}`);
        else { assert.equal(res.status, 403, `${role} ${m}`); assert.equal(res.error.code, -32001); }
        assert.doesNotMatch(res.text, NO_STACK);
      }
    }
  } finally { await r.close(); }
});

test('source comes from the token role only: "source" in a body is refused or has no effect', async () => {
  const r = await rig();
  try {
    const t = r.tokens.api;
    // 1. a top-level params field named source is an unknown field: refused, the gate is never called
    for (const s of ['chat', 'system']) {
      for (const m of ['actions.request', 'actions.panic', 'core.status', 'live.set']) {
        const res = await rpc(r, t, m, { ...(m === 'actions.request' ? { id: 'state.read' } : m === 'live.set' ? { state: 'live' } : {}), source: s });
        assert.ok(res.status === 403 || res.error?.code === -32602, `${m} ${s}`);
      }
    }
    assert.equal(r.decisions.length, 0);
    // 2. envelope-level source is an unknown field
    assert.equal((await raw({ port: r.port, token: t, body: { jsonrpc: '2.0', id: 1, method: 'core.status', source: 'system' } })).json.error.code, -32600);
    // 3. a source inside the free-form action params reaches the gate as data and is ignored: the decision is from 'api', untainted
    for (const s of ['chat', 'system', 'rule']) {
      const res = await rpc(r, t, 'actions.request', { id: 'state.read', params: { source: s, provenance: { kind: 'chat' }, actor: 'x' } });
      assert.equal(res.result.verdict, 'allow', s);
    }
    const last = r.decisions.slice(-3);
    assert.equal(last.length, 3);
    for (const d of last) { assert.equal(d.source, 'api'); assert.equal(d.provenance.tainted, false); }
    // 4. api token cannot reach live.set even when the params say system; live state is unchanged
    const before = r.core.actions.state();
    const ls = await rpc(r, t, 'live.set', { state: 'live', source: 'system' });
    assert.equal(ls.status, 403);
    const ls2 = await rpc(r, t, 'live.set', { state: 'live' });
    assert.equal(ls2.status, 403);
    assert.equal(r.core.actions.state().liveEpoch, before.liveEpoch);
    // 5. the system token's decisions are labelled 'system'
    await rpc(r, r.tokens.system, 'actions.request', { id: 'state.read' });
    assert.equal(r.decisions.at(-1).source, 'system');
  } finally { await r.close(); }
});

test('live.set: system role only; it changes the gate state the approval is bound to', async () => {
  const r = await rig();
  try {
    assert.equal(r.core.actions.state().liveState, 'unknown');
    const res = await rpc(r, r.tokens.system, 'live.set', { state: 'offline' });
    assert.deepEqual(res.result, { ok: true, reason: 'changed' });
    assert.equal(r.core.actions.state().liveState, 'offline');
    assert.equal((await rpc(r, r.tokens.api, 'live.set', { state: 'live' })).status, 403);
    assert.equal(r.core.actions.state().liveState, 'offline');
    assert.equal((await rpc(r, r.tokens.system, 'live.set', { state: 'maybe' })).error.code, -32602);
    await rpc(r, r.tokens.system, 'live.set', { state: 'live' });
    // a write the system role asks for waits for one approval, bound to the live state at the request
    const req = await rpc(r, r.tokens.system, 'actions.request', { id: 'scene.create', params: { name: 'invented' } });
    assert.deepEqual([req.result.verdict, req.result.confirm.liveStateAtRequest, req.result.confirm.phrase], ['confirm', 'live', undefined]);
    // the api client's own write runs at once while live too (D332)
    const own = await rpc(r, r.tokens.api, 'actions.request', { id: 'scene.create', params: { name: 'invented' } });
    assert.deepEqual([own.result.verdict, own.result.reason], ['allow', 'ui-direct']);
  } finally { await r.close(); }
});

test('confirm flow end to end: system request -> api approval -> executor once -> replay refused; system cannot confirm', async () => {
  const r = await rig();
  try {
    await rpc(r, r.tokens.system, 'live.set', { state: 'offline' });
    const req = await rpc(r, r.tokens.system, 'actions.request', { id: 'scene.create', params: { name: 'invented scene' } });
    assert.equal(req.result.verdict, 'confirm');
    const c = req.result.confirm;
    assert.equal(c.phrase, undefined); // D332: no typed phrase
    assert.equal(r.calls.length, 0);
    // wrong role
    assert.equal((await rpc(r, r.tokens.system, 'actions.confirm', { confirmId: c.confirmId, actionHash: c.actionHash })).status, 403);
    // a wrong hash spends the confirmation, so use a fresh one
    const req2 = await rpc(r, r.tokens.system, 'actions.request', { id: 'scene.create', params: { name: 'invented scene' } });
    const bad = await rpc(r, r.tokens.api, 'actions.confirm', { confirmId: req2.result.confirm.confirmId, actionHash: 'c'.repeat(64) });
    assert.deepEqual([bad.result.verdict, bad.result.reason], ['refuse', 'hash-mismatch']);
    assert.equal(r.calls.length, 0);
    // the real one (an old client's phrase is accepted and ignored)
    const ok = await rpc(r, r.tokens.api, 'actions.confirm', { confirmId: c.confirmId, phrase: 'yes', actionHash: c.actionHash });
    assert.deepEqual([ok.result.verdict, ok.result.reason], ['allow', 'confirmed']);
    assert.deepEqual(ok.result.dispatch, { ok: true, result: { mock: true } });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].id, 'scene.create');
    assert.equal(r.calls[0].source, 'system');
    // replay
    const again = await rpc(r, r.tokens.api, 'actions.confirm', { confirmId: c.confirmId, actionHash: c.actionHash });
    assert.deepEqual([again.result.verdict, again.result.reason], ['refuse', 'replayed']);
    assert.equal(r.calls.length, 1);
    // the api client's own write runs on its request, once
    const own = await rpc(r, r.tokens.api, 'actions.request', { id: 'scene.create', params: { name: 'invented scene' } });
    assert.deepEqual([own.result.verdict, own.result.reason, own.result.dispatch], ['allow', 'ui-direct', { ok: true, result: { mock: true } }]);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1].source, 'api');
    // reads go straight through
    const read = await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read' });
    assert.equal(read.result.verdict, 'allow');
    assert.equal(r.calls.length, 3);
    // refusals
    assert.equal((await rpc(r, r.tokens.api, 'actions.request', { id: 'no.such.thing' })).result.reason, 'unknown-action');
  } finally { await r.close(); }
});

test('panic over the API: engages from api and system, clears pending confirmations, event on the bus, api clears it with one click', async () => {
  const r = await rig();
  try {
    const seen = [];
    r.core.bus.subscribe({ name: 'p', kinds: ['system.panic'], handler: (e) => { seen.push(e); } });
    const req = await rpc(r, r.tokens.system, 'actions.request', { id: 'scene.create', params: {} });
    assert.equal(req.result.verdict, 'confirm');
    assert.equal(r.core.actions.state().pending, 1);
    const p = await rpc(r, r.tokens.api, 'actions.panic', { reason: 'api test' });
    assert.deepEqual(p.result, { ok: true, reason: 'panic-engaged' });
    assert.equal(r.core.actions.state().panic, true);
    assert.equal(r.core.actions.state().pending, 0);
    await tick();
    assert.equal(seen.length, 1);
    // the pending confirmation is gone
    const late = await rpc(r, r.tokens.api, 'actions.confirm', { confirmId: req.result.confirm.confirmId, actionHash: req.result.confirm.actionHash });
    assert.equal(late.result.verdict, 'refuse');
    assert.equal(r.calls.length, 0);
    // the system role may also panic; second call reports already-panic
    assert.equal((await rpc(r, r.tokens.system, 'actions.panic', {})).result.reason, 'already-panic');
    // clearing is a catalogue action: the api client's click clears it directly (D332, no confirmation round trip)
    const clr = await rpc(r, r.tokens.api, 'actions.request', { id: 'panic.clear' });
    assert.deepEqual(clr.result, { verdict: 'allow', reason: 'panic-cleared' });
    assert.equal(r.core.actions.state().panic, false);
    // system cannot clear
    await rpc(r, r.tokens.api, 'actions.panic', {});
    const sys = await rpc(r, r.tokens.system, 'actions.request', { id: 'panic.clear' });
    assert.equal(sys.result.reason, 'source-not-permitted');
  } finally { await r.close(); }
});

test('core.status: counters and connection state, no text', async () => {
  const r = await rig({ audit: true, status: () => ({ streamerbot: { state: 'connected' } }) });
  try {
    const MARK = 'zq-status-marker-text';
    chat(r.core, MARK);
    await tick();
    const res = await rpc(r, r.tokens.api, 'core.status');
    assert.equal(res.result.events.published >= 1, true);
    assert.equal(res.result.streamerbot.state, 'connected');
    assert.equal(res.result.live.liveState, 'unknown');
    assert.ok(res.result.audit);
    assert.ok(!res.text.includes(MARK));
    assert.ok(!res.text.includes('Viewer'));
    assert.ok(!res.text.includes(r.tokens.api));
  } finally { await r.close(); }
});

test('audit methods: verify, paged export (audit rows only), purge routed through the gate as chat.raw.purge', async () => {
  const r = await rig({ audit: true });
  try {
    const MARK = 'zq-export-marker-text';
    for (let i = 0; i < 6; i++) chat(r.core, `${MARK} ${i}`);
    for (let i = 0; i < 5; i++) await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read' });
    await tick();
    const v = await rpc(r, r.tokens.api, 'audit.verify');
    assert.equal(v.result.ok, true);
    assert.ok(v.result.rows >= 5);
    // paged export
    const rows = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const p = await rpc(r, r.tokens.api, 'audit.export', { afterId: after, limit: 2 });
      assert.ok(p.result.rows.length <= 2);
      rows.push(...p.result.rows);
      pages++;
      assert.ok(!p.text.includes(MARK), 'no raw chat in the export');
      if (p.result.nextAfterId === null) break;
      after = p.result.nextAfterId;
    }
    assert.ok(pages >= 2);
    assert.equal(rows.length, v.result.rows);
    assert.deepEqual(rows.map((x) => x.id), rows.map((_, i) => i + 1));
    // purge: chat can never reach it, whatever the provenance
    const gate = r.core.actions;
    assert.equal(gate.forSource('chat').request({ id: 'chat.raw.purge', params: { all: true } }).reason, 'chat-forbidden');
    assert.equal(gate.request({ id: 'chat.raw.purge', source: 'rule', provenance: { kind: 'chat', eventId: 'e000000000001-00000000-aaaaaaaa' } }).reason, 'chat-forbidden');
    assert.equal(gate.catalogue.get('chat.raw.purge').class, 'write');
    // api: the purge is the api client's own write, so it runs on that request (D332), through the gate
    await r.core.audit.flush();
    const rawBefore = (await r.core.audit.purge({ olderThanDays: 99999 })).purged;
    assert.equal(rawBefore, 0);
    const callsBefore = r.calls.length; // the five state.read requests above ran the executor
    assert.equal(callsBefore, 5);
    const done = await rpc(r, r.tokens.api, 'audit.purge', { all: true });
    assert.deepEqual([done.result.verdict, done.result.reason], ['allow', 'ui-direct']);
    assert.equal(done.result.dispatch.ok, true);
    assert.equal(done.result.dispatch.result.purged, 6);
    assert.equal(done.result.dispatch.result.all, true);
    assert.equal(r.calls.length, callsBefore + 1);
    assert.equal(r.calls.at(-1).id, 'chat.raw.purge');
    assert.equal((await rpc(r, r.tokens.api, 'audit.verify')).result.ok, true);
    // the purge itself is in the audit as a decision plus a system row, with counts only
    const all = (await rpc(r, r.tokens.api, 'audit.export', { limit: 500 })).result.rows;
    assert.ok(all.some((x) => x.type === 'system' && x.subtype === 'purge'));
    assert.ok(all.some((x) => x.type === 'decision' && x.action_id === 'chat.raw.purge' && x.subtype === 'request' && x.verdict === 'allow' && x.reason === 'ui-direct'));
  } finally { await r.close(); }
});

test('audit methods without an audit are a clean error, not a crash', async () => {
  const r = await rig();
  try {
    for (const m of ['audit.verify', 'audit.export', 'audit.purge']) {
      const res = await rpc(r, r.tokens.api, m, m === 'audit.verify' ? {} : m === 'audit.export' ? {} : { all: true });
      assert.equal(res.error.code, -32004, m);
    }
  } finally { await r.close(); }
});

test('no stack traces or internals in any error body', async () => {
  const r = await rig({ audit: true });
  try {
    r.core.stats = () => { throw new Error('boom inside C:\\secret\\place\\file.mjs:12'); };
    const res = await rpc(r, r.tokens.api, 'core.status');
    assert.equal(res.status, 200);
    assert.equal(res.error.code, -32603);
    assert.equal(res.error.message, 'internal-error');
    assert.doesNotMatch(res.text, NO_STACK);
    assert.ok(!res.text.includes('boom'));
    const bodies = [
      (await raw({ port: r.port, token: r.tokens.api, headers: { 'content-type': 'application/json' }, body: '{' })).text,
      (await raw({ port: r.port, path: '/x', method: 'GET' })).text,
      (await raw({ port: r.port, host: 'evil.example', body: {} })).text,
      (await rpc(r, r.tokens.api, 'actions.request', { id: 'state.read', params: { a: { b: 1n === 1n } } })).text,
      (await rpc(r, 'x', 'core.status')).text,
    ];
    for (const b of bodies) assert.doesNotMatch(b, NO_STACK);
    // a request line that is not valid HTTP gets node's bare 400 without any detail
    const bare = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () => s.write('GARBAGE\r\n\r\n'));
      let d = '';
      s.on('data', (b) => { d += b; });
      s.on('close', () => resolve(d));
    });
    assert.doesNotMatch(bare, NO_STACK);
  } finally { await r.close(); }
});

test('timeouts: a slow-headers client is cut off; an idle silent connection is dropped; the pending cap evicts the oldest', async () => {
  const r = await rig({ limits: { headersTimeoutMs: 300, requestTimeoutMs: 600, connectionsCheckingIntervalMs: 50, socketIdleMs: 400, maxPending: 3 } });
  try {
    assert.equal(r.api.limits.headersTimeoutMs, 300);
    // slowloris: send part of the header block and then dribble
    const t0 = Date.now();
    const closed = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () => {
        s.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nX-A: `);
        const iv = setInterval(() => { try { s.write('b'); } catch { /* closed */ } }, 80);
        s.on('close', () => { clearInterval(iv); resolve(Date.now() - t0); });
      });
      s.on('error', () => {});
      s.setTimeout(5000, () => { s.destroy(); });
    });
    assert.ok(closed < 3000, `closed after ${closed} ms`);
    // a connection that never sends a byte
    const t1 = Date.now();
    const idle = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1');
      s.resume();
      s.on('close', () => resolve(Date.now() - t1));
      s.on('error', () => {});
    });
    assert.ok(idle < 3000, `idle closed after ${idle} ms`);
    // pending cap (E8-03): with 3 unauthenticated connections held open, a 4th is still served and the OLDEST is closed
    const held = [];
    const closedHeld = [];
    for (let i = 0; i < 3; i++) {
      await new Promise((res) => { const s = net.connect(r.port, '127.0.0.1', res); s.on('error', () => {}); s.on('close', () => closedHeld.push(i)); held.push(s); s.resume(); });
      await sleep(5);
    }
    const fourth = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1');
      s.on('connect', () => s.write(`GET /nope HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n\r\n`));
      let got = '';
      s.on('data', (b) => { got += b; });
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
    });
    assert.match(fourth, /^HTTP\/1\.1 404 /, 'the 4th connection is served');
    await sleep(20);
    assert.deepEqual(closedHeld, [0], 'only the oldest pending connection was evicted');
    assert.equal(r.api.stats().pendingEvicted, 1);
    held.forEach((s) => s.destroy());
  } finally { await r.close(); }
  const d = (await import('../services/event-core/api/server.mjs')).DEFAULT_LIMITS;
  assert.deepEqual(
    [d.headersTimeoutMs, d.requestTimeoutMs, d.keepAliveTimeoutMs, d.socketIdleMs, d.preAuthMs, d.maxPending, d.maxConnections, d.systemReserve, d.maxBodyBytes],
    [2_000, 5_000, 2_000, 2_000, 3_000, 128, 64, 8, 65_536],
  );
});

// ---- E8-03 flood helpers ----
// The attacker: N half-open sockets (a partial header block, never finished), each reopened 1 ms after it closes.
// FLOOD_SRC runs in a child process (the real threat: another local process) or, via inProcessFlood, in this one.
const FLOOD_SRC = `
import net from 'node:net';
const port = Number(process.argv[1]);
const n = Number(process.argv[2]);
let opened = 0;
let run = true;
const open = () => {
  if (!run) return;
  const s = net.connect(port, '127.0.0.1');
  opened++;
  s.on('error', () => {});
  s.on('connect', () => s.write('POST /rpc HTTP/1.1\\r\\nHost: 127.0.0.1:' + port + '\\r\\n'));
  s.on('close', () => setTimeout(open, 1));
};
for (let i = 0; i < n; i++) open();
process.send({ started: true });
process.on('message', () => { run = false; process.send({ opened }); setTimeout(() => process.exit(0), 20); });
`;
/** Starts the flood in a child process. stop() -> sockets opened; kill() always safe. */
async function childFlood(port, n = 256) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', FLOOD_SRC, String(port), String(n)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  await new Promise((ok, no) => { child.once('message', ok); child.once('error', no); child.once('exit', (c) => no(new Error(`attacker exited ${c}`))); });
  return {
    stop: () => new Promise((ok) => { child.once('message', (m) => ok(m.opened)); child.send('stop'); }),
    kill: () => { try { child.kill(); } catch { /* gone */ } },
  };
}
/** The same flood in this process (it shares the server's event loop). */
function inProcessFlood(port, n = 256) {
  let run = true;
  let opened = 0;
  const socks = new Set();
  const open = () => {
    if (!run) return;
    const s = net.connect(port, '127.0.0.1');
    opened++; socks.add(s);
    s.on('error', () => {});
    s.on('connect', () => s.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`));
    s.on('close', () => { socks.delete(s); setTimeout(open, 1); });
  };
  for (let i = 0; i < n; i++) open();
  const stop = () => { run = false; socks.forEach((s) => s.destroy()); return opened; };
  return { stop: async () => stop(), kill: stop };
}
/** Waits for a condition (polls every 10 ms); throws after ms. Used to start measuring only once the flood is on. */
async function until(pred, ms = 20_000, what = 'condition') {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); }
}

// Review E8-03: an unauthenticated local process must not be able to starve actions.panic.
// The attacker runs in its own process, as a real one would. Panics start once the flood is over the pending cap
// (the server has evicted at least one connection), then the same 200 ms, 10 single-shot calls, no retry.
// The in-process variant of this flood is measured, not tested, here: the Windows accept queue (~232) and libuv's
// 32-per-turn drain make a single connect fail while the shared loop is starved (2026-10-29-p3-e8-03-panic-under-load.md).
test('E8-03: panic gets through while more than maxPending half-open connections are held and reopened', async () => {
  const r = await rig(); // default limits: maxPending 128
  const flood = await childFlood(r.port, 256); // 2x the pending cap, each reopened at once when closed
  try {
    await until(() => r.api.stats().pendingEvicted > 0, 20_000, 'the flood to pass the pending cap');
    await sleep(200);
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await rpc(r, r.tokens.system, 'actions.panic', { reason: 'e8-03-test' }).then((x) => x.status).catch((e) => e.code));
      await sleep(50);
    }
    assert.deepEqual(results, Array(10).fill(200), JSON.stringify(results));
    const opened = await flood.stop();
    assert.ok(opened > 256, `the attacker reconnected (${opened})`);
    assert.ok(r.api.stats().pendingEvicted > 0);
  } finally {
    flood.kill();
    await r.close();
  }
});

// User decision 2026-10-29: panic must not depend only on the shared TCP port. The system pipe and the in-process
// entry (the hotkey path) must work during the same flood, with the attacker in another process AND in this one.
for (const mode of ['child-process', 'in-process']) {
  test(`E8-03: panic via the system pipe and the in-process hotkey entry succeeds during a 256-socket TCP flood (${mode} attacker)`, { skip: !win && 'named pipe is Windows' }, async () => {
    const r = await rig();
    const pipe = createSystemPipeServer({ core: r.core, token: r.tokens.system, status: r.api.status });
    assert.equal((await pipe.listen()).protection, 'acl');
    const flood = mode === 'child-process' ? await childFlood(r.port, 256) : inProcessFlood(r.port, 256);
    try {
      await until(() => r.api.stats().pendingEvicted > 0, 20_000, 'the flood to pass the pending cap');
      await sleep(200);
      const viaPipe = [];
      const viaHotkey = [];
      for (let i = 0; i < 10; i++) {
        // single shot, no retry: the pipe has its own queue, which the TCP flood never reaches
        viaPipe.push(await pipeRequest({ path: pipe.path, token: r.tokens.system, method: 'actions.panic', params: { reason: 'e8-03-pipe' }, timeoutMs: 30_000 }).then((x) => x.ok).catch((e) => e.code));
        viaHotkey.push(panicNow(r.core, { reason: 'e8-03-hotkey' }).ok);
        await sleep(50);
      }
      assert.deepEqual(viaPipe, Array(10).fill(true), JSON.stringify(viaPipe));
      assert.deepEqual(viaHotkey, Array(10).fill(true), JSON.stringify(viaHotkey));
      assert.equal(r.core.actions.state().panic, true);
      const opened = await flood.stop();
      assert.ok(opened > 256, `the attacker reconnected (${opened})`);
      assert.ok(r.api.stats().pendingEvicted > 0, 'the TCP flood was over the cap');
      const ps = pipe.stats();
      assert.equal(ps.authOk, 10);
      assert.equal(ps.pendingEvicted, 0, 'the TCP flood never reached the pipe');
    } finally {
      flood.kill();
      await pipe.close();
      await r.close();
    }
  });
}

test('system pipe: owner-only DACL (the default one lets Everyone read), fail closed, system token only, two methods, limits', { skip: !win && 'named pipe is Windows' }, async () => {
  const r = await rig();
  const sid = currentUserSid();
  // libuv's default DACL, which is why the pipe is re-protected: Everyone (WD) and Anonymous (AN) may read
  const bare = createSystemPipeServer({ core: r.core, token: r.tokens.system, protect: async () => 'acl' });
  await bare.listen();
  const dflt = await pipeSddl(bare.name, 'read');
  await bare.close();
  assert.match(dflt, /\(A;;FR;;;WD\)/);
  assert.ok(!isOwnerOnlySddl(dflt, sid));
  // fail closed: when protection fails, listen rejects and nothing listens
  const failing = createSystemPipeServer({ core: r.core, token: r.tokens.system, protect: async () => 'acl-failed' });
  await assert.rejects(() => failing.listen(), (e) => e.code === 'PIPE_ACL_FAILED');
  await assert.rejects(() => pipeRequest({ path: failing.path, token: r.tokens.system, method: 'core.status' }), (e) => e.code === 'ENOENT');
  const p = createSystemPipeServer({ core: r.core, token: r.tokens.system, status: r.api.status, limits: { preAuthMs: 200, maxPending: 2, maxLineBytes: 512 } });
  try {
    assert.equal((await p.listen()).protection, 'acl');
    assert.ok(isOwnerOnlySddl(await pipeSddl(p.name, 'read'), sid), 'owner-only DACL read back from a fresh connection');
    assert.match(p.path, /^\\\\\.\\pipe\\ujwalam-core-system-[0-9a-f]{32}$/);
    // a second listener on the same name is refused (no squatting)
    const twin = createSystemPipeServer({ core: r.core, token: r.tokens.system, name: p.name, protect: async () => 'acl' });
    await assert.rejects(() => twin.listen(), (e) => e.code === 'EADDRINUSE');
    // auth: only the system token
    const call = (token, method, params) => pipeRequest({ path: p.path, token, method, params }).then((x) => x, (e) => e.code);
    assert.equal(await call(r.tokens.api, 'actions.panic', {}), 'UNAUTHORIZED');
    assert.equal(await call('0'.repeat(64), 'actions.panic', {}), 'UNAUTHORIZED');
    assert.equal(await call('not a token', 'core.status'), 'UNAUTHORIZED');
    // methods: actions.panic and core.status only
    for (const [m, params] of [['live.set', { state: 'live' }], ['actions.request', { id: 'panic.clear' }], ['actions.confirm', {}], ['audit.export', {}], ['audit.purge', { all: true }], ['nope', {}]]) {
      assert.equal(await call(r.tokens.system, m, params), 'RPC_-32601', m);
    }
    assert.equal(await call(r.tokens.system, 'actions.panic', { reason: 'has <script>' }), 'RPC_-32602');
    assert.equal(await call(r.tokens.system, 'actions.panic', { why: 'x' }), 'RPC_-32602');
    const st = await call(r.tokens.system, 'core.status');
    assert.equal(st.live.panic, false);
    assert.deepEqual(await call(r.tokens.system, 'actions.panic', { reason: 'pipe test' }), { ok: true, reason: 'panic-engaged' });
    assert.deepEqual(await call(r.tokens.system, 'actions.panic', {}), { ok: true, reason: 'already-panic' }); // idempotent
    assert.equal(r.core.actions.state().panic, true);
    // limits: a silent connection is closed after preAuthMs; an over-long line closes the connection; the pending cap evicts the oldest
    const t0 = Date.now();
    const silentMs = await new Promise((ok) => { const s = net.connect(p.path); s.on('error', () => {}); s.on('close', () => ok(Date.now() - t0)); });
    assert.ok(silentMs < 3000, `silent pipe connection closed after ${silentMs} ms`);
    const long = await new Promise((ok) => { const s = net.connect(p.path, () => s.write('x'.repeat(2000))); s.on('error', () => {}); s.on('close', () => ok(true)); });
    assert.equal(long, true);
    assert.ok(p.stats().oversize >= 1);
    const closed = [];
    const held = [];
    for (let i = 0; i < 3; i++) {
      await new Promise((ok) => { const s = net.connect(p.path, ok); s.on('error', () => {}); s.on('close', () => closed.push(i)); held.push(s); });
      await sleep(30);
    }
    await sleep(50);
    assert.deepEqual(closed, [0], 'only the oldest pending pipe connection was evicted');
    held.forEach((s) => s.destroy());
  } finally { await p.close(); await r.close(); }
});

test('in-process panic entry: engages through the gate as system, idempotent, never throws, no core actions -> refused', async () => {
  const r = await rig();
  try {
    assert.deepEqual(panicNow(r.core, { reason: 'hotkey' }), { ok: true, reason: 'panic-engaged' });
    assert.deepEqual(panicNow(r.core), { ok: true, reason: 'already-panic' });
    assert.deepEqual(panicNow(r.core, { reason: '<b>not text</b>' }), { ok: true, reason: 'already-panic' }); // a bad reason is replaced, panic still engages
    assert.equal(r.core.actions.state().panic, true);
  } finally { await r.close(); }
  assert.deepEqual(panicNow({}), { ok: false, reason: 'actions-unavailable' });
  assert.deepEqual(panicNow(null), { ok: false, reason: 'actions-unavailable' });
});

test('retry helper: 5 tries, 50/100/200/400 ms, only ECONNREFUSED and ECONNRESET; real refused connect; a missing pipe is not retried', async () => {
  const fake = (codes) => { let i = 0; return async () => { const c = codes[i++]; if (c) throw Object.assign(new Error(c), { code: c }); return 'ok'; }; };
  let waits = [];
  const sleepRec = async (ms) => { waits.push(ms); };
  assert.equal(await withRetry(fake(['ECONNREFUSED', 'ECONNRESET', 'ECONNREFUSED', 'ECONNRESET']), { sleep: sleepRec }), 'ok');
  assert.deepEqual(waits, [50, 100, 200, 400]);
  waits = [];
  await assert.rejects(() => withRetry(fake(Array(9).fill('ECONNREFUSED')), { sleep: sleepRec }), (e) => e.code === 'ECONNREFUSED' && e.attempts === 5);
  assert.deepEqual(waits, [50, 100, 200, 400]);
  for (const code of ['EACCES', 'ENOENT', 'TIMEOUT', 'UNAUTHORIZED', 'RPC_-32601', 'EPIPE']) {
    waits = [];
    await assert.rejects(() => withRetry(fake([code]), { sleep: sleepRec }), (e) => e.code === code && e.attempts === 1, code);
    assert.deepEqual(waits, [], code);
  }
  assert.deepEqual([...RETRY_DELAYS_MS], [50, 100, 200, 400]);
  assert.deepEqual([...RETRY_CODES], ['ECONNREFUSED', 'ECONNRESET']);
  // a real refused TCP connect, with the real delays: 5 attempts, at least 750 ms in all
  const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  let attempts = 0;
  const t0 = Date.now();
  await assert.rejects(() => withRetry(() => { attempts++; return new Promise((ok, no) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(); }); s.on('error', no); }); }), (e) => e.code === 'ECONNREFUSED');
  assert.equal(attempts, 5);
  assert.ok(Date.now() - t0 >= 740, `waited ${Date.now() - t0} ms`);
  if (win) {
    const t1 = Date.now();
    await assert.rejects(() => panicViaPipe({ path: '\\\\.\\pipe\\ujwalam-core-system-00000000000000000000000000000000', token: 'a'.repeat(64) }), (e) => e.code === 'ENOENT' && e.attempts === 1);
    assert.ok(Date.now() - t1 < 1000);
  }
});

test('E8-03: authenticated slots: api holders cannot use the system reserve; a pending socket is closed after preAuthMs', async () => {
  const r = await rig({ limits: { maxConnections: 2, systemReserve: 1, keepAliveTimeoutMs: 5000, preAuthMs: 300, socketIdleMs: 5000, connectionsCheckingIntervalMs: 50 } });
  const http = await import('node:http');
  const agents = [];
  const call = (token, agent) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'core.status' });
    const req = http.request({ host: '127.0.0.1', port: r.port, method: 'POST', path: '/rpc', agent, headers: { host: `127.0.0.1:${r.port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  try {
    // two api keep-alive connections fill maxConnections
    for (let i = 0; i < 2; i++) { const a = new http.Agent({ keepAlive: true, maxSockets: 1 }); agents.push(a); assert.equal(await call(r.tokens.api, a), 200); }
    assert.equal(await call(r.tokens.api, false), 503, 'a third api connection is refused');
    assert.equal(await call(r.tokens.system, false), 200, 'the system role still gets its reserved slot');
    assert.ok(r.api.stats().authedRefused >= 1);
    // a connection that sends bytes but never authenticates is closed after preAuthMs
    const t0 = Date.now();
    const ms = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () => s.write('POST /rpc HTTP/1.1\r\n'));
      s.on('error', () => {});
      s.on('close', () => resolve(Date.now() - t0));
    });
    assert.ok(ms < 2000, `closed after ${ms} ms`);
  } finally {
    agents.forEach((a) => a.destroy());
    await r.close();
  }
});

test('a slow request body is cut off by the request timeout', async () => {
  const r = await rig({ limits: { headersTimeoutMs: 300, requestTimeoutMs: 500, connectionsCheckingIntervalMs: 50, socketIdleMs: 5000 } });
  try {
    const t0 = Date.now();
    const closed = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () => {
        s.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nAuthorization: Bearer ${r.tokens.api}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"jsonrpc"`);
      });
      s.resume();
      s.on('close', () => resolve(Date.now() - t0));
      s.on('error', () => {});
    });
    assert.ok(closed < 4000, `closed after ${closed} ms`);
    await sleep(10);
  } finally { await r.close(); }
});
