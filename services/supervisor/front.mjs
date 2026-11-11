// SPDX-License-Identifier: GPL-3.0-or-later
// Stable-port front for a swappable HTTP service (LU3, D337). Node stdlib only.
//
// The supervisor owns this listener on 127.0.0.1; clients (studio window, browser, overlay child, host, Streamer.bot
// bridge clients) use ITS port, which never changes. Requests are forwarded to the current backend process. A swap
// (switchTo) moves the API to a new backend without a client noticing:
//
//   1. new requests are held (queued, not refused) and the requests in flight are allowed to finish;
//   2. prepare() runs (e.g. login sessions copied to the new studio-ui server);
//   3. every open event stream (text/event-stream) gets a SECOND upstream request to the new backend, with the same
//      path and headers; what it sends is queued (the hand-off queue) while the old stream still runs;
//   4. handover() runs (the old event core stops taking events, sends every event it has, ends its streams; the new
//      one activates);
//   5. per stream: once the old upstream has ended (or, endOld 'cut', at once) the queued frames of the new upstream
//      are sent, frames whose event id is not newer than the last one sent are skipped (sequence numbers: event-core
//      ids are fixed-length and sort by creation, model.mjs), then the new upstream is piped live;
//   6. the held requests go to the new backend.
//
// The client keeps the same TCP connection to the front throughout, so it never reconnects and never misses a frame.
// A failure before handover() leaves everything on the old backend (HandoverRefused: the swap rolls back). A failure
// in handover() ends the moved streams (their clients reconnect by themselves) and rethrows: the caller restores the
// old service.
//
// Host and Origin headers that name the front (127.0.0.1:<front port>, localhost:<front port>) are rewritten to name
// the backend, so the backends' own DNS-rebinding and same-origin checks keep working unchanged; any other value is
// passed as it is and the backend refuses it as before. WebSocket upgrades are refused (no swappable service uses them).

import http from 'node:http';
import { HandoverRefused } from './swap.mjs';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Request headers for the backend (pure; tested): hop-by-hop headers dropped, Host/Origin naming the front renamed. */
export function backendHeaders(headers, frontPort, backendPort) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk)) continue;
    if (lk === 'host' && typeof v === 'string') {
      const m = /^(127\.0\.0\.1|localhost):(\d+)$/i.exec(v);
      out[k] = m && Number(m[2]) === frontPort ? `${m[1]}:${backendPort}` : v;
    } else if (lk === 'origin' && typeof v === 'string') {
      const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/i.exec(v);
      out[k] = m && Number(m[2]) === frontPort ? `http://${m[1]}:${backendPort}` : v;
    } else out[k] = v;
  }
  return out;
}

/** Response headers for the client (pure): hop-by-hop dropped. */
export function clientHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** Splits SSE text into complete frames; returns { frames: [{ text, id }], rest }. (pure; tested) */
export function splitFrames(buf) {
  const frames = [];
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const text = buf.slice(0, i + 2);
    buf = buf.slice(i + 2);
    const m = /^id: ?(.*)$/m.exec(text);
    frames.push({ text, id: m ? m[1] : null });
  }
  return { frames, rest: buf };
}

/** True when frame id `id` is not newer than `last` (same-length ids compare as strings; others never match). */
export function notNewer(id, last) {
  return typeof id === 'string' && typeof last === 'string' && id.length === last.length && id <= last;
}

const isSse = (res) => /^text\/event-stream/i.test(String(res.headers['content-type'] ?? ''));

/** opts: { backendPort, port? (0), log?(line), name? }. Returns { listen(), port(), backendPort(), switchTo(), stats(), close() }. */
export function createFront(opts) {
  let backend = opts.backendPort;
  const log = opts.log ?? (() => {});
  let frontPort = null;
  let paused = false;
  let switching = false;
  let inflight = 0;
  const held = [];
  const streams = new Set();
  const stats = { requests: 0, held: 0, streams: 0, switches: 0, forcedCuts: 0, skippedDuplicates: 0, upstreamErrors: 0 };

  const server = http.createServer((req, res) => {
    stats.requests++;
    if (paused) { stats.held++; req.pause(); held.push(() => forward(req, res)); return; }
    forward(req, res);
  });
  server.on('upgrade', (_req, socket) => { socket.destroy(); });
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  function forward(req, res) {
    const port = backend;
    inflight++;
    let done = false;
    const finish = () => { if (!done) { done = true; inflight--; } };
    res.once('close', finish);
    const headers = backendHeaders(req.headers, frontPort, port);
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers, agent: false }, (ur) => {
      if (isSse(ur) && req.method === 'GET') {
        finish(); // a stream is not a request in flight: it moves with the swap
        attachStream({ req, res, ur, up, port });
        return;
      }
      res.writeHead(ur.statusCode, clientHeaders(ur.headers));
      ur.pipe(res);
    });
    up.on('error', () => {
      stats.upstreamErrors++;
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 11 }); res.end('bad gateway'); } else res.destroy();
      finish();
    });
    req.pipe(up);
    req.resume();
  }

  // ---- event streams ----
  function attachStream({ req, res, ur, up, port }) {
    stats.streams++;
    const s = { path: req.url, clientHeaders: { ...req.headers }, res, last: null, cur: null, next: null, closed: false, moving: false };
    streams.add(s);
    res.writeHead(ur.statusCode, clientHeaders(ur.headers));
    res.socket?.setNoDelay?.(true);
    s.cur = pipeUpstream(s, ur, up, port);
    res.on('close', () => {
      s.closed = true;
      streams.delete(s);
      try { s.cur?.up.destroy(); } catch { /* gone */ }
      try { s.next?.up.destroy(); } catch { /* gone */ }
    });
  }

  function send(s, f) {
    if (notNewer(f.id, s.last)) { stats.skippedDuplicates++; return true; }
    if (f.id !== null) s.last = f.id;
    return s.res.write(f.text);
  }

  // Live pipe of one upstream into the stream's client response, frame by frame.
  function pipeUpstream(s, ur, up, port) {
    const u = { ur, up, port, rest: '', ended: false, onEnd: null };
    ur.setEncoding('utf8');
    ur.on('data', (d) => {
      const { frames, rest } = splitFrames(u.rest + d);
      u.rest = rest;
      let ok = true;
      for (const f of frames) ok = send(s, f) && ok;
      if (!ok) { ur.pause(); s.res.once('drain', () => ur.resume()); }
    });
    const end = () => {
      if (u.ended) return;
      u.ended = true;
      if (u.onEnd) { u.onEnd(); return; } // a swap waits for this end: the client stays connected
      if (s.cur === u && !s.moving && !s.closed) s.res.end();
    };
    ur.on('end', end);
    ur.on('close', end);
    ur.on('error', end);
    up.on('error', end);
    return u;
  }

  // Second upstream for a stream, to the new backend; frames are queued until the switch.
  function openNext(s, port) {
    return new Promise((resolve, reject) => {
      const headers = backendHeaders(s.clientHeaders, frontPort, port);
      const up = http.request({ host: '127.0.0.1', port, method: 'GET', path: s.path, headers, agent: false }, (ur) => {
        if (ur.statusCode !== 200 || !isSse(ur)) { ur.resume(); up.destroy(); reject(new Error(`stream refused (HTTP ${ur.statusCode})`)); return; }
        up.setTimeout(0); // the timeout guards the connect only; a quiet stream must live on (Codex review P2)
        const n = { ur, up, port, rest: '', queue: [], ended: false };
        ur.setEncoding('utf8');
        n.onData = (d) => { const { frames, rest } = splitFrames(n.rest + d); n.rest = rest; n.queue.push(...frames); };
        ur.on('data', n.onData);
        ur.on('end', () => { n.ended = true; });
        resolve(n);
      });
      up.setTimeout(5000, () => up.destroy(new Error('timeout')));
      up.on('error', reject);
      up.end();
    });
  }

  function waitEnded(u, ms) {
    if (u.ended) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { u.onEnd = null; resolve(false); }, ms);
      t.unref?.();
      u.onEnd = () => { clearTimeout(t); resolve(true); };
    });
  }

  // The new upstream becomes the live one: its queued frames first, then live.
  function promote(s, n) {
    n.ur.removeListener('data', n.onData);
    const { frames, rest } = splitFrames(n.rest);
    n.queue.push(...frames);
    for (const f of n.queue) send(s, f);
    const u = pipeUpstream(s, n.ur, n.up, n.port);
    u.rest = rest;
    s.cur = u;
    s.next = null;
    if (n.ended) { u.ended = true; if (!s.closed) s.res.end(); }
  }

  async function resume() {
    paused = false;
    while (held.length) held.shift()();
  }

  /**
   * Moves the API to newPort (see the header). opts: { prepare?, handover?, endOld?: 'wait' | 'cut', inflightTimeoutMs?,
   * oldEndTimeoutMs? }. Resolves { streams, forcedCuts, held }. Throws HandoverRefused when nothing changed (the old
   * backend keeps serving); any other error comes from handover() (the old one may be half handed over).
   */
  async function switchTo(newPort, { prepare, handover, signal, endOld = 'wait', inflightTimeoutMs = 10_000, oldEndTimeoutMs = 5000 } = {}) {
    if (switching) throw new HandoverRefused('a switch is already running');
    if (!Number.isInteger(newPort) || newPort <= 0) throw new HandoverRefused('bad backend port');
    switching = true;
    paused = true;
    const heldAt = stats.held;
    let moving = [];
    try {
      const t0 = Date.now();
      while (inflight > 0) {
        if (Date.now() - t0 > inflightTimeoutMs) throw new HandoverRefused(`${inflight} request(s) still running`);
        await sleep(5);
      }
      // Collected after the drain (Codex review P2): a request in flight can turn into an event stream while draining.
      moving = [...streams];
      // signal (Codex review P1): the swap gave up on this hand-over; before handover() nothing has changed: refuse.
      if (signal?.aborted) throw new HandoverRefused('cancelled');
      try { await prepare?.(); } catch (e) { throw new HandoverRefused(`prepare: ${e?.message ?? e}`); }
      if (signal?.aborted) throw new HandoverRefused('cancelled');
      for (const s of moving) s.moving = true;
      try {
        await Promise.all(moving.filter((s) => !s.closed).map(async (s) => { s.next = await openNext(s, newPort); }));
      } catch (e) {
        for (const s of moving) { try { s.next?.up.destroy(); } catch { /* gone */ } s.next = null; s.moving = false; }
        throw new HandoverRefused(`the new service refused an event stream: ${e?.message ?? e}`);
      }
      try {
        if (signal?.aborted) throw new HandoverRefused('cancelled');
        await handover?.();
        // Cancelled while the hand-over ran: never point the front at the new backend (the caller restores the old one).
        if (signal?.aborted) throw new Error('cancelled during the hand-over');
      } catch (e) {
        for (const s of moving) {
          try { s.next?.up.destroy(); } catch { /* gone */ }
          s.next = null; s.moving = false;
          if (!s.closed && s.cur?.ended) s.res.end(); // its client reconnects to whatever serves next
        }
        throw e;
      }
      backend = newPort;
      let forcedCuts = 0;
      await Promise.all(moving.map(async (s) => {
        if (s.closed || !s.next) return;
        if (endOld === 'cut') { s.cur.onEnd = () => {}; s.cur.up.destroy(); }
        else if (!(await waitEnded(s.cur, oldEndTimeoutMs))) { forcedCuts++; s.cur.onEnd = () => {}; s.cur.up.destroy(); }
        s.moving = false;
        if (!s.closed) promote(s, s.next);
      }));
      stats.forcedCuts += forcedCuts;
      stats.switches++;
      log(`[front${opts.name ? ` ${opts.name}` : ''}] API moved to the new service (${moving.length} event stream(s) carried over${forcedCuts ? `, ${forcedCuts} cut after ${oldEndTimeoutMs} ms` : ''})`);
      return { streams: moving.length, forcedCuts, held: stats.held - heldAt };
    } finally {
      for (const s of moving) s.moving = false;
      switching = false;
      await resume();
    }
  }

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: opts.port ?? 0 }, () => { server.removeListener('error', reject); resolve(); });
      });
      frontPort = server.address().port;
      return frontPort;
    },
    port: () => frontPort,
    backendPort: () => backend,
    /** Points new requests at another backend without a hand-over (after a plain restart of the service). */
    setBackend(p) { backend = p; },
    switchTo,
    stats: () => ({ ...stats, streamsOpen: streams.size, inflight, paused }),
    async close() {
      for (const s of streams) { try { s.cur?.up.destroy(); s.next?.up.destroy(); s.res.destroy(); } catch { /* gone */ } }
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}
