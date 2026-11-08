// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only static server for the overlay folder, 127.0.0.1 only. Node stdlib only.
//
// Layout (kept from the legacy server so imported browser layers resolve unchanged):
//   <root>/overlays/<name>/index.html?<query>   the overlays
//   <root>/brand/..., <root>/kit/...            what the overlays load with ../../brand and ../../kit
//   /_ujwalam/<file>                            the relay page, from this service (never from the legacy folder)
//   /overlays/ujwalam-<name>/...                pages authored in this repo (opts.ownOverlays), looked up before <root>/overlays;
//                                               only folders named ujwalam-* are taken from there, so they never shadow a legacy page
//   /_ujwalam/flags.json                        live state of the overlay feature flags (opts.flagsJson), read-only
//   /_ujwalam/counters.json                     latest audience counts while flag live-counters is on (opts.countersJson, D250)
// Only the top-level folders in `allowDirs` are served; nothing else under <root> is reachable.
//
// Refused: any method but GET and HEAD (405), a Host that is not 127.0.0.1:<port> or localhost:<port> (421),
// dot segments / backslash / NUL / colon / dotfiles / double slash in the decoded path (400), a path whose real
// location (symlinks resolved) is outside the allowed folder (403), an extension outside the allowlist (404).
// A directory is never listed: "/overlays/name/" serves its index.html, any other directory is 404.
// No CORS headers (a page on another origin cannot read these files in a script).

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const LOOPBACK = '127.0.0.1';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
});

/** The overlays are plain pages with inline scripts, so script-src stays open. What is pinned is where a page may
 *  connect (this machine only), so a page cannot send what it receives to another host.
 *  UNVERIFIED inside the libobs browser source (CEF): check with a real layer before relying on it. */
export const OVERLAY_CSP = "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; frame-ancestors 'self'";

function safeSegments(decoded) {
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':') || decoded.includes('//')) return null;
  const parts = decoded.split('/').filter((s, i, a) => !(s === '' && (i === 0 || i === a.length - 1)));
  for (const p of parts) if (p === '' || p === '.' || p === '..' || p.startsWith('.')) return null;
  return parts;
}

/** Live feature-flag state for overlay pages (D196): GET returns { <id>: true|false } for the overlay flags only. */
export const FLAGS_PATH = '/_ujwalam/flags.json';
export const COUNTERS_PATH = '/_ujwalam/counters.json';

/** opts: { root, allowDirs?: string[], extraMounts?: { '/_ujwalam': absDir }, ownOverlays?: absDir, flagsJson?: () => object, countersJson?: () => object,
 *  port, csp?: string|false }. root is the folder that holds overlays/, brand/ and kit/. Returns { server, port, listen(), close() }. */
export function createStaticServer(opts) {
  const root = realpathSync(opts.root);
  const allowDirs = opts.allowDirs ?? ['overlays', 'brand', 'kit'];
  const mounts = new Map(Object.entries(opts.extraMounts ?? {}).map(([k, v]) => [k.replace(/^\/|\/$/g, ''), realpathSync(v)]));
  const own = opts.ownOverlays ? realpathSync(opts.ownOverlays) : null;
  const csp = opts.csp === undefined ? OVERLAY_CSP : opts.csp;
  let boundPort = opts.port ?? 0;

  const hostOk = (h) => typeof h === 'string' && (h === `${LOOPBACK}:${boundPort}` || h === `localhost:${boundPort}`);

  function send(res, status, headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end();
  }

  function scopeOf(parts) {
    if (parts.length && mounts.has(parts[0])) return { base: mounts.get(parts[0]), rest: parts.slice(1), scope: mounts.get(parts[0]) };
    if (own && parts[0] === 'overlays' && /^ujwalam-[a-z0-9-]+$/.test(parts[1] ?? '') && existsSync(path.join(own, parts[1]))) {
      return { base: own, rest: parts.slice(1), scope: path.join(own, parts[1]) };
    }
    if (parts.length && allowDirs.includes(parts[0])) return { base: root, rest: parts, scope: path.join(root, parts[0]) };
    return null;
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req.headers.host)) return send(res, 421);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD' });
    // The raw request path, not new URL().pathname: the URL parser silently folds dot segments, and those are refused here.
    const rawPath = String(req.url).split(/[?#]/, 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { return send(res, 400); }
    if (!decoded.startsWith('/')) return send(res, 400);
    const parts = safeSegments(decoded);
    if (!parts) return send(res, 400);
    const jsonFn = decoded === FLAGS_PATH ? opts.flagsJson : decoded === COUNTERS_PATH ? opts.countersJson : null;
    if (typeof jsonFn === 'function') {
      let body;
      try { body = JSON.stringify(jsonFn()); } catch { body = '{}'; } // a failed read reads as "all off"
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const s = scopeOf(parts);
    if (!s) return send(res, 404);
    try {
      const scopeReal = realpathSync(s.scope);
      let real = realpathSync(path.join(s.base, ...s.rest));
      if (real !== scopeReal && !real.startsWith(scopeReal + path.sep)) return send(res, 403);
      let st = statSync(real);
      if (st.isDirectory()) {
        if (!decoded.endsWith('/')) return send(res, 404);
        real = realpathSync(path.join(real, 'index.html'));
        if (!real.startsWith(scopeReal + path.sep)) return send(res, 403);
        st = statSync(real);
      }
      if (!st.isFile()) return send(res, 404);
      const type = MIME[path.extname(real).toLowerCase()];
      if (!type) return send(res, 404);
      const headers = {
        'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      if (csp && type.startsWith('text/html')) headers['Content-Security-Policy'] = csp;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(real);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { send(res, 404); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ } });

  return {
    server,
    get port() { return boundPort; },
    listen() {
      return new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(opts.port ?? 0, LOOPBACK, () => { boundPort = server.address().port; server.off('error', fail); ok(boundPort); });
      });
    },
    close() { return new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }); },
  };
}
