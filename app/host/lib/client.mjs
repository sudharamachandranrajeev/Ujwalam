// SPDX-License-Identifier: GPL-2.0-or-later
// Client for the ujwalam-host JSON-RPC API (POST /rpc on 127.0.0.1, Bearer token).
// Uses node:http, not fetch: fetch adds Sec-Fetch-* headers, which the host refuses (callers are native processes).
// Never logs the token or request params.
import http from 'node:http';
import { readFileSync } from 'node:fs';

export class HostError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function readDiscovery(file) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) throw new Error(`bad port in ${file}`);
  return d;
}

// Raw request: returns { status, headers, body } without interpreting it (used by the security tests).
export function rawRequest({ port, method = 'POST', path = '/rpc', headers = {}, body = '', timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let nextId = 1;

export class HostClient {
  constructor({ port, token, timeoutMs = 30000 }) {
    this.port = port;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  static fromDiscovery(file, token) {
    const d = readDiscovery(file);
    const t = token ?? d.token;
    if (!t) throw new Error('no token: the discovery file has none (passed by environment); give it explicitly');
    return new HostClient({ port: d.port, token: t });
  }

  async call(method, params = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
    const res = await rawRequest({
      port: this.port,
      body,
      timeoutMs: this.timeoutMs,
      headers: {
        Host: `127.0.0.1:${this.port}`,
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    });
    let msg;
    try {
      msg = JSON.parse(res.body);
    } catch {
      throw new HostError(-32700, `HTTP ${res.status}: non-JSON reply`, res.status);
    }
    if (msg.error) throw new HostError(msg.error.code, msg.error.message, res.status);
    return msg.result;
  }
}
