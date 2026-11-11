// SPDX-License-Identifier: GPL-3.0-or-later
// Swappable event core (LU3 service swap, D337; flag `service-swap`, off by default). Node stdlib only.
//
// Same pieces as startService (service.mjs), plus a hand-off between two processes:
//
//   standby (opts.standby): the API listens and serves event streams on its bus, core.status answers (other methods:
//     503 'standby'), the Streamer.bot connector is connected and its events are BUFFERED, not published. The audit
//     database is not opened (one writer per database file: the old core still owns it, audit/lock.mjs), and nothing
//     is published to api.json, system.json or the LAN.
//   activate({ idFloor, live, remotePort }): opens the audit (DB_LOCKED while the old core still holds it), builds the
//     real core on the same bus with ids above idFloor (model.mjs), restores the old core's live state and panic,
//     replays the buffer (what the old core already published is dropped by the dedupe window it persisted), then
//     publishes api.json (opts.publicPort: the supervisor's front, so clients keep one port), the system pipe, the LAN
//     listener (on remotePort when given) and starts live markers and counters.
//   handoff(): stops taking events (connector, markers, counters), lets every event stream send what it has and end
//     cleanly (sse.mjs finish), closes pipe, LAN listener, api.json and the audit (lock released), and returns
//     { lastId, live, remotePort } for the next core's activate(). The API then answers core.status only.
//
// A core that handed over can be activated again: the supervisor's restore path when the new one fails. Pending
// confirmations are not carried over (gate.mjs: they live in memory only; a restart drops them by design). Events
// without a platform message id that arrive while both cores are connected (the overlap, normally under a second) can
// reach clients twice: the dedupe window has nothing to match them on. Events are never lost.

import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createBus } from '../bus.mjs';
import { ensureSecureDir, resolveDataDir } from '../config.mjs';
import { createAudienceCounters } from '../counters.mjs';
import { createStallTracer } from '../diag/stall-tracer.mjs';
import { createEventCore } from '../index.mjs';
import { createFixtureRecorder } from '../streamerbot/anonymise.mjs';
import { checkUrl, createStreamerbotConnector, DEFAULT_URL } from '../streamerbot/connector.mjs';
import { credentialProvider, DEFAULT_TARGET } from '../streamerbot/credential.mjs';
import { chooseLanBind } from '../../common/lan-remote.mjs';
import { createFlags } from '../../flags/index.mjs';
import { publishApiFile, publishSystemFile, tokensFromEnv } from './discovery.mjs';
import { createServiceExecutor } from './executor.mjs';
import { createSystemPipeServer } from './pipe.mjs';
import { createApiServer, newToken } from './server.mjs';
import { REMOTE_FILE, STALL_DEFAULTS, STALL_FILE, stallContext, startLiveMarkers } from './service.mjs';

/** Streamer.bot events a standby core keeps until it is activated. Overflow is counted and reported, never silent. */
export const STANDBY_BUFFER_MAX = 20_000;

export async function startSwappableService(opts = {}) {
  const out = opts.out ?? (() => {});
  if (opts.url !== undefined) checkUrl(opts.url, { allowRemote: opts.allowRemote === true });
  const dataDir = resolveDataDir({ dataDir: opts.dataDir });
  const { created, protection: dataDirProtection } = ensureSecureDir(dataDir);
  if (dataDirProtection === 'acl-failed') throw new Error('could not restrict the data directory to the current user (ACL_FAILED)');

  let core = null;
  const tracer = opts.stallTracer === false ? null : createStallTracer({
    ...STALL_DEFAULTS, ...(opts.stallTracer && typeof opts.stallTracer === 'object' ? opts.stallTracer : {}),
    file: path.join(dataDir, STALL_FILE), label: 'event-core', stallsOnly: true, context: () => stallContext(() => core),
  });
  const executor = createServiceExecutor({ getCore: () => core, mock: opts.mock === true });
  const bus = createBus({ queueLimit: opts.core?.queueLimit });
  const buffer = [];
  const bufferMax = Number.isInteger(opts.standbyBufferMax) && opts.standbyBufferMax > 0 ? opts.standbyBufferMax : STANDBY_BUFFER_MAX; // test seam
  const counts = { buffered: 0, overflow: 0, replayed: 0, replayDeduped: 0, activations: 0, handoffs: 0 };
  // What the API and the connector hold. Standby: buffering ingest, no gate, no audit. activate() copies the real
  // core's members onto it, so every holder sees the real core from then on.
  const facade = {
    standby: true, handedOff: false, bus, audit: null, actions: null, moderation: null, ready: Promise.resolve(0),
    pseudoId: () => null,
    ingest(input) {
      if (buffer.length >= bufferMax) { counts.overflow++; return { status: 'invalid', errors: [{ path: '', message: 'standby buffer full' }] }; }
      buffer.push(input);
      counts.buffered++;
      return { status: 'buffered' };
    },
    stats: () => ({ standby: true, published: bus.stats().published, buffered: buffer.length, subscribers: bus.stats().subscribers }),
  };
  let lastId = null;
  bus.subscribe({ name: 'swap-last-id', limit: 100_000, handler: (ev) => { lastId = ev.id; } });

  let envTokens;
  try { envTokens = tokensFromEnv(opts.env ?? process.env); } catch (e) { await tracer?.stop(); throw e; }
  const tokens = envTokens ?? { api: newToken(), system: newToken() };
  let state = 'standby';
  let sb = null;
  const api = createApiServer({
    core: facade, tokens, port: opts.port ?? 0, limits: opts.limits,
    status: () => ({
      swap: { state, ...counts, bufferedNow: buffer.length },
      ...(sb ? { streamerbot: { state: sb.state(), received: sb.stats().received, published: sb.stats().published, reconnects: sb.stats().reconnects } } : {}),
    }),
  });
  let addr;
  try { addr = await api.listen(); } catch (e) { await tracer?.stop(); throw e; }

  let mockSb = null;
  let chatTimer = null;
  let url = opts.url ?? DEFAULT_URL;
  let getPassword = async () => null;
  if (opts.noStreamerbot !== true) {
    if (opts.mock) {
      const { startMockStreamerbot } = await import('../../../tools/mock/mock-streamerbot.mjs');
      const { createChatSource } = await import('../../../tools/mock/mock-chat.mjs');
      mockSb = await startMockStreamerbot();
      url = mockSb.url;
      const src = createChatSource({ seed: opts.seed ?? 1 });
      chatTimer = setInterval(() => { if (mockSb.clientCount() > 0) mockSb.emit(src.next()); }, opts.chatIntervalMs ?? 1000);
      chatTimer.unref?.();
    } else if (process.platform === 'win32') {
      getPassword = credentialProvider(opts.credential ?? DEFAULT_TARGET);
    }
  }
  const startIngest = () => {
    if (opts.noStreamerbot === true) return;
    let recorder = null;
    if (!opts.noFixtures && !opts.mock) { try { recorder = createFixtureRecorder({ dir: dataDir }); } catch { recorder = null; } }
    sb = createStreamerbotConnector({ core: facade, url, allowRemote: opts.allowRemote === true, getPassword, recorder, onNote: (level, code) => out(`[serve] ${level}: ${code}`) });
    sb.start();
  };

  let file = null; let pipe = null; let sysFile = null; let remoteApi = null; let remoteInfo = null;
  let liveMarkers = null; let counters = null;
  startIngest(); // in standby too: connected and buffering, so nothing is missed while the old core hands over

  async function activate({ idFloor = null, live = null, remotePort = null } = {}) {
    if (state !== 'standby' && state !== 'handed-off') throw new Error(`activate: not in standby (${state})`);
    // A candidate whose standby buffer overflowed has lost events: it never becomes the core (Codex review P2). The
    // supervisor checks this before the hand-off too (kept-old); here it is the last guard (the old core is restored).
    if (state === 'standby' && counts.overflow > 0) throw new Error(`activate: the standby buffer overflowed (${counts.overflow} events not kept); this core is not used`);
    // Throws DB_LOCKED while the previous core still owns the audit database; nothing below has run then.
    const c = createEventCore({ dataDir, audit: { dataDir }, actions: { executor }, bus, idFloor, ...(opts.out ? { log: opts.out } : {}), ...(opts.core ?? {}) });
    try { await c.ready; } catch (e) { try { await c.audit?.close(); } catch { /* ignore */ } throw e; }
    core = c;
    Object.assign(facade, c, { standby: false, handedOff: false });
    api.reopenStreams(); // a core activated again after its hand-off admits event streams again (Codex review P2)
    // The old core's live state and panic carry over: a swap never takes the live lock off.
    const sys = c.actions?.forSource('system');
    if (sys && live && ['offline', 'live', 'unknown'].includes(live.liveState)) sys.setLiveState(live.liveState, { reason: 'service-swap' });
    if (sys && live?.panic === true) sys.panic({ reason: 'service-swap' });
    const pending = buffer.splice(0);
    let deduped = 0;
    for (const input of pending) {
      if (c.ingest(input).status === 'deduped') deduped++;
    }
    counts.replayed += pending.length;
    counts.replayDeduped += deduped;
    file = publishApiFile({ dataDir, port: opts.publicPort ?? addr.port, tokens: envTokens ? null : tokens });
    c.audit.recordSystem({ subtype: 'api-start', source: 'api', verdict: 'ok', detail: { port: addr.port, mock: opts.mock === true, swap: true } });
    if (opts.systemPipe !== false && process.platform === 'win32') {
      const p = createSystemPipeServer({ core: facade, token: tokens.system, status: api.status });
      try {
        await p.listen();
        sysFile = publishSystemFile({ dataDir, pipe: p.path });
        pipe = p;
      } catch (e) {
        await p.close();
        out(`[serve] warn: system pipe not started (${e?.code ?? 'error'}); panic stays available in-process and over the API`);
      }
    }
    if (opts.remote) {
      const bind = chooseLanBind({ preferred: opts.remote.address, interfaces: opts.remote.interfaces });
      if (!bind) out('[serve] remote connections: off (no private LAN address on this machine)');
      else {
        const r = createApiServer({ core: facade, remote: { bind, token: opts.remote.token }, port: remotePort ?? opts.remote.port ?? 0, limits: opts.limits, status: () => ({}) });
        try {
          const a = await r.listen();
          remoteApi = r;
          remoteInfo = { address: a.host, port: a.port, prefixLen: bind.prefixLen };
          writeFileSync(path.join(dataDir, REMOTE_FILE), JSON.stringify(remoteInfo));
        } catch (e) { await r.close(); out(`[serve] warn: remote connections not started (${e?.code ?? 'error'})`); }
      }
    }
    if (!sb) startIngest(); // activated again after a hand-over (restore path): ingest had stopped
    liveMarkers = startLiveMarkers({ core: c, dataDir, opts, out });
    if (sb && opts.counters !== false) {
      try {
        counters = createAudienceCounters({ core: c, readGlobal: (n) => sb.readGlobal(n), flags: opts.counters?.flags ?? createFlags({ dataDir }), config: opts.counters?.config, log: out });
        counters.start();
      } catch (e) { out(`[serve] warn: audience counters not started (${String(e?.message ?? 'error').slice(0, 80)})`); counters = null; }
    }
    state = 'active';
    counts.activations++;
    return { replayed: pending.length, deduped, overflow: counts.overflow };
  }

  async function handoff({ streamTimeoutMs = 5000 } = {}) {
    if (state !== 'active') throw new Error(`handoff: not active (${state})`);
    state = 'handing-off';
    sb?.stop(); sb = null;
    liveMarkers?.stop(); liveMarkers = null;
    counters?.stop(); counters = null;
    const g = core.actions?.state();
    const live = g ? { liveState: g.liveState, panic: g.panic === true } : null;
    facade.handedOff = true;
    // Everything published so far reaches every stream before it ends (the bus queues drain first).
    const streams = await api.endStreams(streamTimeoutMs);
    await pipe?.close(); pipe = null;
    sysFile?.remove(); sysFile = null;
    const remotePort = remoteInfo?.port ?? null;
    if (remoteApi) { await remoteApi.close(); rmSync(path.join(dataDir, REMOTE_FILE), { force: true }); remoteApi = null; remoteInfo = null; }
    core.audit.recordSystem({ subtype: 'api-stop', source: 'api', verdict: 'ok', detail: { swap: true } });
    await core.audit.close(); // lock released: the next core may open the database now
    file?.remove(); file = null;
    state = 'handed-off';
    counts.handoffs++;
    return { lastId, live, remotePort, streams };
  }

  if (opts.standby !== true) {
    try { await activate(); } catch (e) { await api.close(); sb?.stop(); if (mockSb) await mockSb.close(); await tracer?.stop(); throw e; }
  }

  let stopped = false;
  return {
    get core() { return core; }, facade, api, tokens, dataDir, port: addr.port, dataDirProtection, dataDirCreated: created,
    get apiFile() { return file; }, get systemPipe() { return pipe; }, get systemFile() { return sysFile; }, get remote() { return remoteInfo; },
    mockStreamerbot: mockSb, streamerbot: () => sb, stallTracer: tracer, stallFile: tracer ? path.join(dataDir, STALL_FILE) : null,
    state: () => state, swapStats: () => ({ ...counts, bufferedNow: buffer.length }),
    activate, handoff,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (chatTimer) clearInterval(chatTimer);
      liveMarkers?.stop();
      counters?.stop();
      sb?.stop();
      if (mockSb) await mockSb.close();
      const wasActive = state === 'active';
      if (wasActive) {
        core.audit.recordSystem({ subtype: 'api-stop', source: 'api', verdict: 'ok' });
        await pipe?.close();
        sysFile?.remove();
        if (remoteApi) { await remoteApi.close(); rmSync(path.join(dataDir, REMOTE_FILE), { force: true }); }
      }
      await api.close();
      file?.remove();
      if (wasActive) await core.audit.close();
      state = 'stopped';
      await tracer?.stop();
    },
  };
}
