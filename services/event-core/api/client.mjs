// SPDX-License-Identifier: GPL-2.0-or-later
// Client helpers for panic senders (review E8-03 follow-up, user decision 2026-10-29). Node stdlib only.
//
//  - withRetry(fn): bounded retry for idempotent-safe calls (panic). 5 tries, 50 / 100 / 200 / 400 ms apart, and only
//    on ECONNREFUSED or ECONNRESET (a refused or reset connect: the request may not have arrived). Any other error,
//    including a JSON-RPC error answer, is returned at once. Worst case about 750 ms of waiting plus 5 attempts.
//  - pipeRequest(): one JSON-RPC call over the system pipe (pipe.mjs protocol: auth line, request line, reply line).
//  - panicViaPipe(): actions.panic over the system pipe with withRetry. Panic is idempotent (a repeat answers
//    already-panic), so a retry after a lost reply is safe.
//  - readSystemFile(dataDir): the pipe name the core published for the system role.
// Errors carry a code; messages never carry the token or the reply body.

import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SYSTEM_FILE } from './discovery.mjs';

export const RETRY_CODES = Object.freeze(['ECONNREFUSED', 'ECONNRESET']);
export const RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400]); // 4 waits = 5 tries

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls fn() until it resolves, a non-retryable error is thrown, or the tries are used up (the last error is thrown).
 *  opts: { delays?, codes?, sleep?, onRetry?(attempt, code) }. The attempt count is on the error as e.attempts. */
export async function withRetry(fn, { delays = RETRY_DELAYS_MS, codes = RETRY_CODES, sleep = sleepMs, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(attempt); } catch (e) {
      const retry = e && codes.includes(e.code) && attempt <= delays.length;
      if (!retry) { if (e && typeof e === 'object') e.attempts = attempt; throw e; }
      onRetry?.(attempt, e.code);
      await sleep(delays[attempt - 1]);
    }
  }
}

let nextId = 1;
/** One call over the system pipe. Resolves the JSON-RPC result. Rejects with code RPC_<n> for an error answer,
 *  UNAUTHORIZED / BUSY for a refused handshake, TIMEOUT, BAD_RESPONSE, CLOSED, or the socket's own code. */
export function pipeRequest({ path: where, token, method, params, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const s = net.connect(where);
    let buf = '';
    let stage = 0; // 0 = waiting for the handshake reply, 1 = waiting for the result
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); fn(v); };
    const fail = (code) => finish(reject, Object.assign(new Error(code), { code }));
    const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => {
      s.write(`${JSON.stringify({ auth: token })}\n${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
    s.on('data', (d) => {
      buf += d;
      if (buf.length > 65_536) { fail('BAD_RESPONSE'); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let j;
        try { j = JSON.parse(line); } catch { fail('BAD_RESPONSE'); return; }
        if (stage === 0) {
          if (j && j.ok === true) { stage = 1; continue; }
          fail(j?.error === 'busy' ? 'BUSY' : 'UNAUTHORIZED'); return;
        }
        if (!j || j.id !== id) { fail('BAD_RESPONSE'); return; }
        if (j.error) { finish(reject, Object.assign(new Error(String(j.error.message ?? 'rpc-error')), { code: `RPC_${j.error.code}` })); return; }
        finish(resolve, j.result);
        return;
      }
    });
    s.on('error', (e) => fail(e?.code ?? 'ERROR'));
    s.on('close', () => fail('CLOSED'));
  });
}

/** actions.panic over the system pipe, with the bounded retry. Resolves the gate's { ok, reason }. */
export function panicViaPipe({ path: where, token, reason = 'hotkey', timeoutMs, retry = {} }) {
  return withRetry(() => pipeRequest({ path: where, token, method: 'actions.panic', params: { reason }, timeoutMs }), retry);
}

/** Reads <dataDir>/system.json -> { pipe, pid, startedAt } or null. */
export function readSystemFile(dataDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(dataDir, SYSTEM_FILE), 'utf8'));
    return j && typeof j.pipe === 'string' && Number.isInteger(j.pid) ? { pipe: j.pipe, pid: j.pid, startedAt: j.startedAt } : null;
  } catch { return null; }
}
