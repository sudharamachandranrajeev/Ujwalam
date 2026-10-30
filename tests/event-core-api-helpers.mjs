// SPDX-License-Identifier: GPL-2.0-or-later
// Shared test rig for the event-core API tests (P3 E6). All text, ids and names are invented. Temp dirs only.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventCore } from '../services/event-core/index.mjs';
import { createApiServer } from '../services/event-core/api/server.mjs';
import { createServiceExecutor } from '../services/event-core/api/executor.mjs';

const dirs = [];
export const cleanup = () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
export const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'evapi-')); dirs.push(d); return d; };
export const tick = () => new Promise((r) => setImmediate(r));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** core + gate (real catalogue) + API on a random loopback port. opts: { audit?, limits?, status?, executor? } */
export async function rig(opts = {}) {
  const calls = [];
  const decisions = [];
  let core;
  const executor = opts.executor ?? createServiceExecutor({ getCore: () => core, mock: true, onCall: (a) => calls.push(a) });
  core = createEventCore({
    key: Buffer.alloc(32, 7), moderation: false,
    ...(opts.audit ? { audit: { dataDir: tmp(), purgeOnStart: false } } : {}),
    actions: { executor, onDecision: (r) => decisions.push(r) },
  });
  if (core.audit) await core.audit.ready;
  const api = createApiServer({ core, limits: opts.limits, status: opts.status });
  const { port } = await api.listen();
  return {
    core, api, port, calls, decisions, tokens: api.tokens,
    async close() { await api.close(); await core.audit?.close(); },
  };
}

/** One raw HTTP request. opts: { port, method, path, headers, body (string|Buffer|object), token, host, agent, chunks } */
export function raw(opts) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.host !== undefined) headers.host = opts.host;
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    let body = opts.body;
    if (body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      headers['content-type'] ??= 'application/json';
    }
    if (body !== undefined && !opts.chunked) headers['content-length'] ??= Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port: opts.port, method: opts.method ?? 'POST', path: opts.path ?? '/rpc', headers, agent: opts.agent ?? false }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let nextId = 1;
/** JSON-RPC call with a token. Returns the raw response plus body.result / body.error. */
export async function rpc(r, token, method, params, extra = {}) {
  const res = await raw({ port: r.port, token, body: { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, ...extra });
  return { ...res, result: res.json?.result, error: res.json?.error };
}

/** Open an SSE stream; collects frames and comments. */
export function openSse({ port, token, query = '', headers = {} }) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const comments = [];
    let buf = '';
    const waiters = [];
    const req = http.request({ host: '127.0.0.1', port, path: `/events${query}`, method: 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        const parts = [];
        res.on('data', (b) => parts.push(b));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8'), frames, comments, close() {} }));
        return;
      }
      res.setEncoding('utf8');
      const notify = () => { for (const w of [...waiters]) w(); };
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) comments.push(block);
          else {
            const f = {};
            for (const line of block.split('\n')) { const k = line.slice(0, line.indexOf(':')); f[k] = line.slice(line.indexOf(':') + 2); }
            if (f.data) f.json = JSON.parse(f.data);
            frames.push(f);
          }
        }
        notify();
      });
      const waitFor = (pred, ms = 3000) => new Promise((ok, no) => {
        const t = setTimeout(() => { const k = waiters.indexOf(chk); if (k >= 0) waiters.splice(k, 1); no(new Error('sse wait timeout')); }, ms);
        const chk = () => { if (pred()) { clearTimeout(t); const k = waiters.indexOf(chk); if (k >= 0) waiters.splice(k, 1); ok(); } };
        waiters.push(chk);
        chk();
      });
      resolve({ status: 200, headers: res.headers, frames, comments, waitFor, close: () => req.destroy() });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

let msgN = 0;
/** Ingest an invented chat message. */
export function chat(core, text = 'invented line', extra = {}) {
  return core.ingest({
    kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: `api-test-${++msgN}`,
    user: { platformUserId: `u${msgN % 7}`, displayName: `Viewer${msgN % 7}`, roles: ['viewer'] }, text, ...extra,
  });
}
