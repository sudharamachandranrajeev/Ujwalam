// SPDX-License-Identifier: GPL-2.0-or-later
// Bench: event-core API (P3 E6). SYNTHETIC input: invented chat text and ids, loopback only, in-process server on a
// random port, temp state only. Part of PB-12 (event-core internal p95 <= 20 ms): it shows what the HTTP layer adds.
//   rpc_status_p50_ms / rpc_status_p95_ms   POST /rpc core.status round trip (keep-alive client, auth + parse + reply)
//   rpc_refuse_p50_ms / rpc_refuse_p95_ms   POST /rpc actions.request for an unknown action: the gate refuses
//   sse_p95_ms                              bus publish (core.ingest) to the SSE frame parsed by the client, one at a time
import http from 'node:http';
import { createEventCore } from '../../../services/event-core/index.mjs';
import { createApiServer } from '../../../services/event-core/api/server.mjs';

export const id = 'event-core-api';
export const budget = 'PB-12';
export const metrics = {
  rpc_status_p50_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.05 },
  rpc_status_p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.1 },
  rpc_refuse_p50_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.05 },
  rpc_refuse_p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.1 },
  sse_p95_ms: { unit: 'ms', lowerIsBetter: true, minDelta: 0.1 },
};

const N = 600;
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function post(agent, port, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/rpc', agent, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function run() {
  const core = createEventCore({ key: Buffer.alloc(32, 3), moderation: false });
  const api = createApiServer({ core });
  const { port } = await api.listen();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const timeRpc = async (method, params) => {
      const times = new Float64Array(N);
      for (let i = 0; i < N + 50; i++) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: i + 1, method, params });
        const t0 = performance.now();
        const st = await post(agent, port, api.tokens.api, body);
        if (i >= 50) times[i - 50] = performance.now() - t0; // first 50 are warm-up
        if (st !== 200) throw new Error(`bench rpc ${method} -> ${st}`);
      }
      return Array.from(times);
    };
    const status = await timeRpc('core.status', {});
    const refuse = await timeRpc('actions.request', { id: 'bench.unknown' });

    // SSE: one event at a time so the number is delivery latency, not queueing
    const lat = [];
    let waiting = null;
    const sse = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/events?kinds=chat.', headers: { authorization: `Bearer ${api.tokens.api}` }, agent: false }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith('id: ') && waiting) { JSON.parse(block.slice(block.indexOf('data: ') + 6)); const w = waiting; waiting = null; w(); }
          }
        });
        resolve(req);
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 350; i++) {
      const got = new Promise((r) => { waiting = r; });
      const t0 = performance.now();
      const r = core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: `bench-${i}`, user: { platformUserId: `u${i % 9}`, displayName: `Viewer${i % 9}`, roles: ['viewer'] }, text: `synthetic message ${i}` });
      if (r.status !== 'published') throw new Error(`bench ingest ${r.status}`);
      await got;
      if (i >= 50) lat.push(performance.now() - t0);
    }
    sse.destroy();
    return {
      rpc_status_p50_ms: pct(status, 0.5), rpc_status_p95_ms: pct(status, 0.95),
      rpc_refuse_p50_ms: pct(refuse, 0.5), rpc_refuse_p95_ms: pct(refuse, 0.95),
      sse_p95_ms: pct(lat, 0.95),
    };
  } finally { agent.destroy(); await api.close(); }
}
