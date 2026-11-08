// SPDX-License-Identifier: GPL-3.0-or-later
// Backend clients held by the studio UI server (never by the page). Node stdlib only.
//
//  - createCoreClient: event-core JSON-RPC (POST /rpc, Bearer api token). Port and token come from the environment
//    (UJWALAM_EVENT_CORE_PORT + UJWALAM_EVENT_CORE_API_TOKEN, set by the launcher) or from <dataDir>/api.json.
//    The system token is never read or used here.
//  - createHostClient: libobs host JSON-RPC (Agent C, app/host). Contract adopted by the host: docs/evidence/2026-10-29-v1-host-o1.md section 8.
//    Discovery file: <dataDir>/host.json = { port, pid, startedAt, token } (or the path in
//    UJWALAM_HOST_DISCOVERY), JSON-RPC 2.0 over POST /rpc on 127.0.0.1 with Authorization: Bearer <token>.
//    Methods used are HOST_CALLS in server.mjs plus host.status.
//  - createFakeHost: in-memory stand-in. BLOCKED-ON-HOST: every use is flagged in the UI and the evidence file; it is
//    never reported as the host working.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const LOOPBACK = '127.0.0.1';
const TOKEN_HEX = /^[0-9a-f]{64}$/;

export function rpc({ port, token, method, params, timeoutMs = 3000, maxBytes = 1_048_576 }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({
      host: LOOPBACK, port, path: '/rpc', method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(Object.assign(new Error('too-large'), { code: 'TOO_LARGE' })); } else chunks.push(c); });
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (j && j.error) reject(Object.assign(new Error(String(j.error.message ?? 'rpc-error')), { code: `RPC_${j.error.code}` }));
          else resolve(j?.result);
        } catch { reject(Object.assign(new Error('bad-response'), { code: 'BAD_RESPONSE' })); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (e) => reject(e));
    req.end(body);
  });
}

function readJsonSafe(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** opts: { dataDir?, env? } */
export function createCoreClient({ dataDir = null, env = process.env } = {}) {
  let lastOk = false;
  function creds() {
    const envPort = Number(env.UJWALAM_EVENT_CORE_PORT);
    const envTok = env.UJWALAM_EVENT_CORE_API_TOKEN;
    if (Number.isInteger(envPort) && envPort > 0 && TOKEN_HEX.test(envTok ?? '')) return { port: envPort, token: envTok };
    const j = dataDir ? readJsonSafe(path.join(dataDir, 'api.json')) : null;
    if (j && Number.isInteger(j.port) && TOKEN_HEX.test(j.tokens?.api ?? '')) return { port: j.port, token: j.tokens.api };
    return null;
  }
  async function call(method, params) {
    const c = creds();
    if (!c) { lastOk = false; throw Object.assign(new Error('core-not-found'), { code: 'CORE_NOT_FOUND' }); }
    try { const r = await rpc({ ...c, method, params }); lastOk = true; return r; } catch (e) { if (!String(e.code).startsWith('RPC_')) lastOk = false; throw e; }
  }
  return {
    call,
    // TODO(main): switch to the separate confirm credential when event-core has the confirm role (ADR option 2).
    confirm: ({ confirmId, phrase, actionHash }) => call('actions.confirm', { confirmId, phrase, actionHash }),
    describe: () => ({ available: creds() !== null, reachable: lastOk }),
  };
}

/** opts: { dataDir?, env? } */
export function createHostClient({ dataDir = null, env = process.env } = {}) {
  const file = env.UJWALAM_HOST_DISCOVERY || (dataDir ? path.join(dataDir, 'host.json') : null);
  const creds = () => {
    const j = file ? readJsonSafe(file) : null;
    // The launcher passes the token by environment (the discovery file then has token: null); otherwise use the file's.
    const token = TOKEN_HEX.test(env.UJWALAM_HOST_TOKEN ?? '') ? env.UJWALAM_HOST_TOKEN : j?.token;
    return j && Number.isInteger(j.port) && TOKEN_HEX.test(token ?? '') ? { port: j.port, token } : null;
  };
  return {
    kind: 'host',
    isPresent: () => creds() !== null,
    async call(method, params) {
      const c = creds();
      if (!c) throw Object.assign(new Error('host-not-found'), { code: 'HOST_NOT_FOUND' });
      return rpc({ ...c, method, params });
    },
    describe: () => ({ kind: 'host', available: creds() !== null }),
  };
}

/** BLOCKED-ON-HOST fake. Behaves like the proposed host API over in-memory data. Outputs are never "ready" unless
 *  outputsReady is passed (tests / UI work only), so start/stop stay disabled by default. */
export function createFakeHost({ outputsReady = false } = {}) {
  const scenes = [
    { id: 'scene-1', name: 'Gameplay', canvas: 'H' }, { id: 'scene-2', name: 'Starting soon', canvas: 'H' }, { id: 'scene-3', name: 'Gameplay V', canvas: 'V' },
  ];
  const layers = {
    'scene-1': [
      { id: 'game', name: 'Game capture', visible: true, placement: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 'cam', name: 'Camera', visible: true, placement: { visible: true, x: 1440, y: 40, width: 440, height: 248 } },
      { id: 'chat', name: 'Chat overlay', visible: false, placement: { visible: false, x: 40, y: 600, width: 480, height: 440 } },
    ], // host order: bottom first
    'scene-2': [{ id: 'text', name: 'Title card', visible: true, placement: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } }],
    'scene-3': [{ id: 'cam', name: 'Camera', visible: true, placement: { visible: true, x: 0, y: 0, width: 1080, height: 608 } }],
  };
  const mixer = [{ id: 'scene-1/cam', name: 'Camera', volumeDb: 0, muted: false, cue: false, audioSource: 'aud-cam', tracks: ['t1'] }, { id: 'scene-1/game', name: 'Game', volumeDb: -6, muted: false, cue: true, audioSource: 'aud-game', tracks: ['t1', 't2'] }, { id: 'scene-2/text', name: 'Music', volumeDb: -18, muted: true, cue: false, audioSource: 'aud-music', tracks: ['t1'] }];
  const TRACKS = [{ id: 't1', name: 'Stream' }, { id: 't2', name: 'Recording' }];
  const active = { H: 'scene-1', V: 'scene-3' };
  const state = { live: false, recording: false };
  const noise = () => randomBytes(1)[0] / 255;
  const need = (o, what) => { if (!o) throw Object.assign(new Error(`unknown-${what}`), { code: 'UNKNOWN' }); return o; };
  return {
    kind: 'fake',
    async call(method, p = {}) {
      switch (method) {
        case 'host.status': return { fake: true, live: state.live, recording: state.recording, droppedFrames: 0, totalFrames: 0, fps: 0, cpuPct: Math.round(noise() * 10), gpuPct: Math.round(noise() * 5), outputsReady: { stream: outputsReady, record: outputsReady } };
        case 'scenes.list': return { scenes: scenes.map((s) => ({ ...s, active: active[s.canvas] === s.id, layers: layers[s.id].length })) };
        case 'scenes.activate': { const s = need(scenes.find((x) => x.id === p.scene), 'scene'); active[s.canvas] = s.id; return { ok: true }; }
        case 'layers.list': { const sc = need(scenes.find((x) => x.id === p.scene), 'scene'); return { scene: sc.id, canvas: sc.canvas, layers: layers[sc.id].map((l) => structuredClone(l)) }; }
        case 'layers.setPlacement': {
          const l = need(need(layers[p.scene], 'scene').find((x) => x.id === p.layer), 'layer');
          const { crop, ...rest } = p.placement;
          Object.assign(l.placement, rest);
          if (crop) l.placement.crop = { ...(l.placement.crop ?? {}), ...crop };
          return { scene: p.scene, layer: p.layer, placement: structuredClone(l.placement) };
        }
        case 'layers.setVisible': need(need(layers[p.scene], 'scene').find((l) => l.id === p.layer), 'layer').visible = p.visible; return { ok: true };
        case 'layers.move': {
          const arr = need(layers[p.scene], 'scene');
          const i = arr.findIndex((l) => l.id === p.layer);
          need(i >= 0 ? arr[i] : null, 'layer');
          arr.splice(Math.min(p.index, arr.length - 1), 0, arr.splice(i, 1)[0]);
          return { ok: true };
        }
        case 'preview.open': case 'preview.focus': return { ok: true, fake: true, note: 'BLOCKED-ON-HOST: no native preview window exists in the fake backend' };
        case 'replay.save': return { saved: [], fake: true, note: 'BLOCKED-ON-HOST: the fake backend has no replay buffer' };
        case 'marker.add': return { ok: true, fake: true };
        case 'mixer.list': return { sources: mixer.map((m) => ({ ...m, mixers: TRACKS.reduce((b, t, n) => (m.tracks.includes(t.id) ? b | (1 << n) : b), 0), peakDb: null })), tracks: TRACKS };
        case 'mixer.setTracks': {
          const m = need(mixer.find((x) => x.id === p.id), 'source');
          if (!p.tracks.every((t) => TRACKS.some((x) => x.id === t))) throw new Error('unknown track');
          m.tracks = TRACKS.filter((t) => p.tracks.includes(t.id)).map((t) => t.id);
          return { id: m.id, audioSource: m.audioSource, tracks: m.tracks, monitoring: m.cue ? (m.tracks.length ? 'monitor-and-output' : 'monitor-only') : 'off' };
        }
        case 'mixer.setVolume': need(mixer.find((m) => m.id === p.id), 'source').volumeDb = p.db; return { ok: true };
        case 'mixer.setMute': need(mixer.find((m) => m.id === p.id), 'source').muted = p.muted; return { ok: true };
        case 'mixer.setCue': need(mixer.find((m) => m.id === p.id), 'source').cue = p.cue; return { id: p.id, cue: p.cue, cueDelayed: false };
        case 'stream.start': case 'stream.stop': case 'record.start': case 'record.stop':
          if (!outputsReady) throw Object.assign(new Error('outputs-not-ready'), { code: 'NOT_READY' });
          if (method.startsWith('stream')) state.live = method.endsWith('start'); else state.recording = method.endsWith('start');
          return { ok: true };
        default: throw Object.assign(new Error('method-not-found'), { code: 'NO_METHOD' });
      }
    },
    describe: () => ({ kind: 'fake', available: true, blockedOnHost: true }),
  };
}

/** In-memory stand-in for services/bots (UI tests and --fake-host): no process is ever started. Same method names.
 *  state: { streamerbot: { installed, running, startedByUs, portAnswering }, ... } overrides the defaults. */
export function createFakeBots(state = {}) {
  const labels = { streamerbot: 'Streamer.bot', speakerbot: 'Speaker.bot' };
  const ports = { streamerbot: 8093, speakerbot: 8083 };
  const st = Object.fromEntries(Object.keys(labels).map((b) => [b, { installed: true, running: false, startedByUs: false, portAnswering: false, ...(state[b] ?? {}) }]));
  const row = (b) => ({ bot: b, label: labels[b], ...st[b], port: ports[b], ok: st[b].running && st[b].portAnswering });
  return {
    calls: [],
    async statusAll() { return Object.keys(st).map(row); },
    async start(b) {
      this.calls.push(['start', b]);
      if (!st[b].installed) return { ok: false, reason: 'not-installed' };
      if (st[b].running) return { ok: false, reason: 'already-running' };
      Object.assign(st[b], { running: true, startedByUs: true, portAnswering: true });
      return { ok: true, pid: 4242 };
    },
    async stop(b) {
      this.calls.push(['stop', b]);
      if (!st[b].startedByUs) return { ok: false, reason: 'not-started-by-ujwalam' };
      Object.assign(st[b], { running: false, startedByUs: false, portAnswering: false });
      return { ok: true, forced: false };
    },
    async stopStarted() { return {}; },
  };
}

/** Real host when its discovery file exists, otherwise the flagged fake (re-checked on each call, so the host can
 *  appear after the UI started). */
export function createHostRouter({ dataDir, env = process.env, fake = createFakeHost({ outputsReady: env.UJWALAM_FAKE_OUTPUTS_READY === '1' }), forceFake = false } = {}) {
  const real = createHostClient({ dataDir, env });
  const pick = () => (!forceFake && real.isPresent() ? real : fake);
  return { call: (m, p) => pick().call(m, p), describe: () => pick().describe() };
}
