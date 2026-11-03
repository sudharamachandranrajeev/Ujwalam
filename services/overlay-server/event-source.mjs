// SPDX-License-Identifier: GPL-2.0-or-later
// Event-core SSE client, for running the overlay server as its own process. Node stdlib only (node:http).
//
// This process is a trusted server-side consumer: it holds the event-core API token (from the environment, never
// from a URL and never written to a file) and sends it only in the Authorization header of its one request to the
// event core. The overlay pages talk to the bridge, never to the event core, and the bridge never forwards the token.
// The object returned has the same subscribe() shape as the in-process bus, so bridge.attach(remoteBus) works.
// The request goes through node:http, not fetch: fetch adds Sec-Fetch-* headers and the event core refuses those as
// browser requests (D62; found in the first alpha run: the stream was refused with 403 and retried forever).
import http from 'node:http';

const RETRY_MIN = 500;
const RETRY_MAX = 10_000;

// fetch-shaped GET over node:http: resolves { ok, status, body } where body is the response stream (async iterable).
export function httpGet(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers, signal, agent: false }, (res) => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res });
    });
    req.on('error', reject);
    req.end();
  });
}

/** opts: { url: 'http://127.0.0.1:<port>/events', token, kinds?: string[], fetchFn?, log? } */
export function createRemoteBus(opts) {
  const fetchFn = opts.fetchFn ?? httpGet;
  const handlers = new Set();
  const state = { connected: false, events: 0, badFrames: 0, reconnects: 0 };
  let abort = null;
  let stopped = true;
  let retry = RETRY_MIN;

  const url = new URL(opts.url);
  if (opts.kinds?.length) url.searchParams.set('kinds', opts.kinds.join(','));

  function dispatch(frame) {
    let ev;
    try { ev = JSON.parse(frame.data); } catch { state.badFrames++; return; }
    if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') { state.badFrames++; return; }
    state.events++;
    for (const h of handlers) { try { h(ev); } catch { /* one handler must not stop the stream */ } }
  }

  async function run() {
    while (!stopped) {
      abort = new AbortController();
      try {
        const res = await fetchFn(url, { headers: { Authorization: `Bearer ${opts.token}`, Accept: 'text/event-stream' }, signal: abort.signal });
        if (!res.ok || !res.body) { res.body?.destroy?.(); throw new Error(`status ${res.status}`); }
        state.connected = true;
        retry = RETRY_MIN;
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
            let data = '';
            for (const line of block.split(/\r?\n/)) if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
            if (data) dispatch({ data });
          }
        }
      } catch (e) {
        if (stopped) return;
        opts.log?.(`event stream: ${e.name === 'AbortError' ? 'aborted' : 'lost'}; retry in ${retry} ms`); // never the token or a body
      }
      state.connected = false;
      if (stopped) return;
      state.reconnects++;
      await new Promise((r) => setTimeout(r, retry).unref?.());
      retry = Math.min(retry * 2, RETRY_MAX);
    }
  }

  return {
    subscribe({ handler }) { handlers.add(handler); return () => handlers.delete(handler); },
    start() { if (stopped) { stopped = false; run(); } },
    stop() { stopped = true; abort?.abort(); },
    stats: () => ({ ...state }),
  };
}
