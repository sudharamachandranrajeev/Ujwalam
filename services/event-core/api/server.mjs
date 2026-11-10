// SPDX-License-Identifier: GPL-3.0-or-later
// Event-core HTTP API (P3 E6): JSON-RPC 2.0 over POST /rpc, Server-Sent Events over GET /events. Node stdlib only.
//
// Callers are native local processes (the Qt app, the supervisor, tools), never browsers. Everything a browser could
// do is refused: Origin, Sec-Fetch-*, wrong Host, simple (form / text/plain) POSTs, CORS preflight. See
// docs/evidence/2026-10-28-p3-e6-api.md for the threat model and every limit.
//
// Check order for a request (cheap, information-free refusals first):
//   Host -> Origin -> Sec-Fetch-* -> path/method -> Bearer token (role) -> Content-Type -> body size -> JSON -> method/role -> params.
// The request body is never read before authentication.
//
// The `source` seen by the action gate comes ONLY from the token's role (api -> forSource('api'), system ->
// forSource('system')). Handlers call the gate synchronously; nothing on the request path waits on disk except the
// audit.* methods, which go through the audit worker.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { METHODS, RpcError, E, validateParams } from './methods.mjs';
import { createSseClient, parseKinds } from './sse.mjs';
import { assertLanBind, sameSubnet } from '../../common/lan-remote.mjs';

export const LOOPBACK = '127.0.0.1';

// Connection admission (review E8-03, slowloris and slot exhaustion). A connection is "pending" until one of its
// requests presents a valid token; then it is "authenticated". Any local process can open loopback sockets without a
// token, so pending connections can never block an authenticated caller:
//   - pending connections have their own cap (maxPending). When a new connection arrives and the cap is full, the
//     OLDEST pending connection is closed, never the new one. A real client sends its request at once, so it is
//     authenticated long before maxPending newer connections push it out.
//   - a pending connection is closed after socketIdleMs without any traffic, and after preAuthMs in any case.
//   - authenticated connections have their own cap (maxConnections); the system role (supervisor, panic) has
//     systemReserve extra slots above it, so api-token holders cannot fill the slots panic needs.
//   - node's total connection cap is maxPending + maxConnections + systemReserve + 1, so node itself never drops a new
//     connection before the eviction above runs.
export const DEFAULT_LIMITS = Object.freeze({
  headersTimeoutMs: 2_000,         // whole header block must arrive within this (slowloris); a real client sends it in one write
  requestTimeoutMs: 5_000,         // whole request incl. body (receive side only; a slow handler is not cut off)
  keepAliveTimeoutMs: 2_000,       // idle keep-alive connection (authenticated)
  socketIdleMs: 2_000,             // a pending connection with no traffic for this long is closed (not applied after auth or to SSE)
  preAuthMs: 3_000,                // a connection that has not authenticated within this is closed
  connectionsCheckingIntervalMs: 500, // how often node enforces the header/request timeouts
  maxPending: 128,                 // unauthenticated connections; the oldest is evicted when a new one arrives
  maxConnections: 64,              // authenticated connections (api + system)
  systemReserve: 8,                // extra authenticated slots for the system role only
  maxHeaderBytes: 8_192,
  maxBodyBytes: 65_536,
  authFailPerConn: 3,              // failed auth on one connection -> 429 and the connection is closed
  authFailPerRemote: 20,           // failed auth per remote address per window -> 429 (valid tokens still pass)
  authWindowMs: 60_000,
  sseQueueMax: 256,
  sseHeartbeatMs: 15_000,
  sseStallMs: 30_000,
  sseMaxClients: 16,
});

const TOKEN_HEX = /^[0-9a-f]{64}$/;
export const newToken = () => randomBytes(32).toString('hex');
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** opts: { core, tokens?: { api, system } (64 hex each; generated when absent), host? (only 127.0.0.1), port? (0 = random),
 *  limits?, timers?, status?: () => object (extra, text-free fields for core.status), now?: () => ms,
 *  remote?: { bind: { address, prefixLen }, token } }
 * remote (D327 IN1, "Allow remote connections"): this server is the LAN listener instead of the loopback API. It binds
 * the given private IPv4 address only (lan-remote.mjs; never 0.0.0.0 or a public address), closes any connection from
 * outside that subnet before reading a byte, accepts only the remote pairing token (never the api or system token, so a
 * leaked LAN token cannot confirm or run system methods), gives the remote role core.status and actions.request only
 * (source 'remote': the action gate treats it like api for requests and never lets it confirm) and serves no events. */
export function createApiServer(opts) {
  const core = opts.core;
  const remote = opts.remote ?? null;
  if (remote) assertLanBind(remote.bind);
  const host = remote ? remote.bind.address : (opts.host ?? LOOPBACK);
  if (!remote && host !== LOOPBACK) throw new RangeError('the API binds 127.0.0.1 only');
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be 0..65535');
  const L = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  if (remote && opts.tokens) throw new TypeError('the LAN listener takes the remote token only');
  if (remote && !TOKEN_HEX.test(remote.token ?? '')) throw new TypeError('the remote token must be 64 hex characters');
  const tokens = remote ? { remote: remote.token } : (opts.tokens ?? { api: newToken(), system: newToken() });
  if (!remote && (!TOKEN_HEX.test(tokens.api) || !TOKEN_HEX.test(tokens.system))) throw new TypeError('tokens must be 64 hex characters');
  if (!remote && tokens.api === tokens.system) throw new TypeError('api and system tokens must differ');
  const dig = remote ? { remote: digest(tokens.remote) } : { api: digest(tokens.api), system: digest(tokens.system) };
  const handles = !core.actions ? { api: null, system: null, remote: null }
    : remote ? { remote: core.actions.forSource('remote') } : { api: core.actions.forSource('api'), system: core.actions.forSource('system') };
  const timers = opts.timers ?? undefined;
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const t0 = performance.now();

  const stats = { requests: 0, rpcOk: 0, rpcErrors: 0, refused: 0, authFailures: 0, rateLimited: 0, sseOpened: 0, sseDropped: 0, pendingEvicted: 0, pendingTimedOut: 0, authedRefused: 0, peerRefused: 0 };
  const sse = new Set();
  const pending = new Set();  // sockets without an authenticated request yet, oldest first (Set keeps insertion order)
  const authed = new Map();   // socket -> role
  const connFails = new WeakMap(); // socket -> failed auth count
  const remoteFails = new Map();   // remote address -> { n, start }
  let seq = 0;
  let allowedHosts = new Set();

  const server = http.createServer({ maxHeaderSize: L.maxHeaderBytes, connectionsCheckingInterval: L.connectionsCheckingIntervalMs, requestTimeout: L.requestTimeoutMs, headersTimeout: L.headersTimeoutMs, keepAliveTimeout: L.keepAliveTimeoutMs }, (req, res) => {
    handle(req, res).catch(() => {
      // never leak a stack or message
      if (!res.headersSent) fail(res, 500, 'internal'); else res.destroy();
    });
  });
  server.maxConnections = L.maxPending + L.maxConnections + L.systemReserve + 1;
  server.on('connection', (socket) => {
    socket.on('error', () => {});
    // LAN listener: a peer outside the bind subnet (e.g. through a forwarded router port) is closed at once.
    if (remote && !sameSubnet(socket.remoteAddress, remote.bind)) { stats.peerRefused++; socket.destroy(); return; }
    pending.add(socket);
    if (pending.size > L.maxPending) {
      const oldest = pending.values().next().value;
      pending.delete(oldest);
      stats.pendingEvicted++;
      oldest.destroy();
    }
    // No traffic at all for socketIdleMs while pending: closed (node's header timer only starts at the first byte).
    socket.setTimeout(L.socketIdleMs, () => { if (pending.has(socket)) { stats.pendingTimedOut++; socket.destroy(); } });
    const pre = setTimeout(() => { if (pending.has(socket)) { stats.pendingTimedOut++; socket.destroy(); } }, L.preAuthMs);
    pre.unref();
    socket.on('close', () => { clearTimeout(pre); pending.delete(socket); authed.delete(socket); });
  });
  /** Moves a socket from pending to authenticated. false = no authenticated slot for this role. */
  function admit(socket, role) {
    if (authed.has(socket)) return true;
    const cap = role === 'system' ? L.maxConnections + L.systemReserve : L.maxConnections;
    if (authed.size >= cap) return false;
    pending.delete(socket);
    authed.set(socket, role);
    socket.setTimeout(0); // from here node's keep-alive, header and request timeouts apply; a slow handler is not cut off
    return true;
  }

  function baseHeaders(extra) {
    return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  }
  function send(res, status, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra }));
    res.end(body);
  }
  function fail(res, status, code, extra = {}) {
    stats.refused++;
    send(res, status, { error: { code } }, { Connection: 'close', ...extra });
  }

  // ---- auth ----
  function roleOf(req) {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]{1,256})$/.exec(h) : null;
    const d = digest(m ? m[1] : ''); // same work whether or not a token was presented
    if (remote) { const ok = timingSafeEqual(d, dig.remote); return m && ok ? 'remote' : null; }
    const isApi = timingSafeEqual(d, dig.api);   // fixed-length SHA-256 digests: equal-length buffers, no length leak
    const isSys = timingSafeEqual(d, dig.system);
    if (!m) return null;
    return isApi ? 'api' : isSys ? 'system' : null;
  }
  function noteAuthFailure(req) {
    stats.authFailures++;
    const sock = req.socket;
    const c = (connFails.get(sock) ?? 0) + 1;
    connFails.set(sock, c);
    const key = sock.remoteAddress ?? '?';
    const t = performance.now();
    let r = remoteFails.get(key);
    if (!r || t - r.start > L.authWindowMs) { r = { n: 0, start: t }; remoteFails.set(key, r); if (remoteFails.size > 1024) remoteFails.delete(remoteFails.keys().next().value); }
    r.n++;
    return c >= L.authFailPerConn || r.n > L.authFailPerRemote;
  }

  // ---- body ----
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (b) => {
        n += b.length;
        if (n > L.maxBodyBytes) { req.removeAllListeners('data'); req.resume(); reject(new RpcError(E.INVALID_REQUEST, 'body-too-large', 413)); return; }
        chunks.push(b);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => reject(new RpcError(E.INVALID_REQUEST, 'read-error', 400)));
      req.on('aborted', () => reject(new RpcError(E.INVALID_REQUEST, 'aborted', 400)));
    });
  }

  function status() {
    const a = core.audit?.stats();
    return {
      startedAt, uptimeMs: Math.round(performance.now() - t0),
      live: core.actions ? core.actions.state() : null,
      events: core.stats(),
      api: { sseClients: sse.size, ...stats },
      audit: a ? { mode: a.mode, queuedAudit: a.queuedAudit, queuedRaw: a.queuedRaw, writtenA: a.writtenA, writtenR: a.writtenR, droppedA: a.droppedA, droppedR: a.droppedR, writeErrors: a.writeErrors, failed: a.failed } : null,
      ...(opts.status ? opts.status() : {}),
    };
  }

  // ---- JSON-RPC ----
  function rpcErr(res, http_, id, code, message, extra) {
    stats.rpcErrors++;
    send(res, http_, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, extra);
  }

  async function handleRpc(req, res, role) {
    const ct = req.headers['content-type'];
    const okCt = typeof ct === 'string' && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(ct.trim());
    if (!okCt) return rpcErr(res, 415, null, E.INVALID_REQUEST, 'content-type must be application/json', { Connection: 'close' });
    const cl = req.headers['content-length'];
    if (cl !== undefined && (!/^\d{1,10}$/.test(cl) || Number(cl) > L.maxBodyBytes)) return rpcErr(res, 413, null, E.INVALID_REQUEST, 'body-too-large', { Connection: 'close' });
    let raw;
    try { raw = await readBody(req); } catch (e) { return rpcErr(res, e.http ?? 400, null, e.rpcCode ?? E.INVALID_REQUEST, e.message, { Connection: 'close' }); }
    let msg;
    try { msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return rpcErr(res, 400, null, E.PARSE, 'parse-error'); }
    if (Array.isArray(msg)) return rpcErr(res, 400, null, E.INVALID_REQUEST, 'batch-not-supported');
    if (!isPlain(msg)) return rpcErr(res, 400, null, E.INVALID_REQUEST, 'invalid-request');
    const id = msg.id;
    const idOk = (typeof id === 'string' && id.length >= 1 && id.length <= 64) || Number.isSafeInteger(id);
    if (!idOk) return rpcErr(res, 400, null, E.INVALID_REQUEST, 'id must be a string (1..64) or an integer');
    for (const k of Object.keys(msg)) if (!['jsonrpc', 'method', 'params', 'id'].includes(k)) return rpcErr(res, 400, id, E.INVALID_REQUEST, 'unknown-field');
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.method.length > 64) return rpcErr(res, 400, id, E.INVALID_REQUEST, 'invalid-request');
    const m = Object.hasOwn(METHODS, msg.method) ? METHODS[msg.method] : null;
    if (!m) return rpcErr(res, 200, id, E.METHOD_NOT_FOUND, 'method-not-found');
    if (!m.roles.includes(role)) return rpcErr(res, 403, id, E.FORBIDDEN, 'forbidden');
    const params = msg.params === undefined ? {} : msg.params;
    const bad = validateParams(m.schema, params);
    if (bad) return rpcErr(res, 200, id, E.INVALID_PARAMS, bad);
    try {
      const result = await m.run({ core, handle: handles[role], role, status }, params);
      stats.rpcOk++;
      send(res, 200, { jsonrpc: '2.0', id, result });
    } catch (e) {
      if (e instanceof RpcError) return rpcErr(res, e.http, id, e.rpcCode, e.message);
      rpcErr(res, 200, id, E.INTERNAL, 'internal-error'); // never the message or stack of an unexpected error
    }
  }

  function handleEvents(req, res, role, url) {
    for (const k of url.searchParams.keys()) if (k !== 'kinds') return fail(res, 400, 'bad-query');
    let kinds = parseKinds(url.searchParams.get('kinds'));
    if (kinds === null) return fail(res, 400, 'bad-kinds');
    if (role === 'system') { // the supervisor gets text-free system events only
      kinds = kinds.length ? kinds.filter((k) => k.startsWith('system.') || k === 'system') : ['system.'];
      if (!kinds.length) return fail(res, 403, 'kinds-not-permitted');
    }
    if (sse.size >= L.sseMaxClients) return fail(res, 503, 'too-many-streams');
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }));
    req.socket.setNoDelay(true);
    res.write(': connected\n\n');
    const client = createSseClient({
      res, bus: core.bus, name: `sse-${++seq}`, prefixes: kinds, queueMax: L.sseQueueMax,
      heartbeatMs: L.sseHeartbeatMs, stallMs: L.sseStallMs, timers,
    });
    sse.add(client);
    stats.sseOpened++;
    const done = () => { if (sse.delete(client)) { stats.sseDropped += client.stats().dropped; client.close(); } };
    req.on('close', done);
    res.on('close', done);
  }

  async function handle(req, res) {
    stats.requests++;
    const h = req.headers;
    if (typeof h.host !== 'string' || !allowedHosts.has(h.host.toLowerCase())) return fail(res, 403, 'bad-host');
    if (Object.hasOwn(h, 'origin')) return fail(res, 403, 'origin-refused');
    for (const k of Object.keys(h)) if (k.startsWith('sec-fetch-')) return fail(res, 403, 'browser-request-refused');
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return fail(res, 400, 'bad-url');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'bad-url'); }
    const route = url.pathname === '/rpc' ? 'POST' : url.pathname === '/events' ? 'GET' : null;
    if (!route) return fail(res, 404, 'not-found');
    if (req.method !== route) return fail(res, 405, 'method-not-allowed', { Allow: route });
    if (route === 'POST' && url.search) return fail(res, 400, 'bad-query'); // never a token (or anything) in the query

    const role = roleOf(req);
    if (!role) {
      const limited = noteAuthFailure(req);
      if (limited) { stats.rateLimited++; return fail(res, 429, 'too-many-failures', { 'Retry-After': String(Math.ceil(L.authWindowMs / 1000)) }); }
      stats.refused++; // keep-alive stays open until the per-connection limit, so that limit can trigger
      return send(res, 401, { error: { code: 'unauthorized' } }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (!admit(req.socket, role)) { stats.authedRefused++; return fail(res, 503, 'too-many-connections', { 'Retry-After': '1' }); }
    if (route === 'GET') return role === 'remote' ? fail(res, 403, 'events-not-permitted') : handleEvents(req, res, role, url);
    return handleRpc(req, res, role);
  }

  let listening = null;
  return {
    tokens: Object.freeze({ ...tokens }),
    server, limits: L,
    status, // core.status payload, shared with the system pipe (pipe.mjs)
    stats: () => ({ ...stats, sseClients: sse.size, pending: pending.size, authenticated: authed.size }),
    sseClients: () => [...sse].map((c) => c.stats()),
    async listen() {
      if (listening) return listening;
      listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port }, () => {
          const a = server.address();
          if (!a || typeof a === 'string' || a.address !== host) { server.close(); reject(new Error(remote ? 'LAN listener bound another address' : 'API bound a non-loopback address')); return; }
          allowedHosts = remote ? new Set([`${host}:${a.port}`]) : new Set([`127.0.0.1:${a.port}`, `localhost:${a.port}`]);
          resolve({ host: a.address, port: a.port });
        });
      });
      return listening;
    },
    address: () => { const a = server.address(); return a && typeof a === 'object' ? { host: a.address, port: a.port } : null; },
    async close() {
      for (const c of [...sse]) c.close();
      sse.clear();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}
