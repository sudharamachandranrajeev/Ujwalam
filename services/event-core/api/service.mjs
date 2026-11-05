// SPDX-License-Identifier: GPL-3.0-or-later
// The event-core service: core + audit + action gate + Streamer.bot ingest + API (P3 E6). Node stdlib only.
//
//   const svc = await startService({ dataDir, mock: true });   // svc.port, svc.core, svc.api, await svc.stop()
//
// Read-only towards the platforms: the Streamer.bot connector is built without any send option, so its send path
// stays disabled and nothing is ever sent to a chat. Mock mode starts an in-process mock Streamer.bot on a
// random loopback port and feeds it invented chat.
//
// Stall tracer (2026-10-28): on by default. One 25 ms timer and one watchdog thread; it writes only stalls over 200 ms
// to <dataDir>/stalls.jsonl (async appends, rotated to stalls.jsonl.1 at 1 MiB, so at most about 2 MiB on disk).
// Records hold timings, counts, handle type names and audit queue numbers: no chat text, names or ids.
// opts.stallTracer: false turns it off; an object overrides { thresholdMs, maxBytes, tickMs, watchdog }.

import { createEventCore } from '../index.mjs';
import { ensureSecureDir, resolveDataDir } from '../config.mjs';
import { checkUrl, createStreamerbotConnector, DEFAULT_URL } from '../streamerbot/connector.mjs';
import { createFixtureRecorder } from '../streamerbot/anonymise.mjs';
import { credentialProvider, DEFAULT_TARGET } from '../streamerbot/credential.mjs';
import { createApiServer, newToken } from './server.mjs';
import { createServiceExecutor } from './executor.mjs';
import { publishApiFile, publishSystemFile, tokensFromEnv } from './discovery.mjs';
import { createSystemPipeServer } from './pipe.mjs';
import path from 'node:path';
import { createStallTracer } from '../diag/stall-tracer.mjs';
import { createFlags } from '../../flags/index.mjs';
import { createHostLink, createLiveMarkers, loadLiveMarkerConfig } from '../live-markers.mjs';

export const STALL_FILE = 'stalls.jsonl';
export const STALL_DEFAULTS = Object.freeze({ thresholdMs: 200, maxBytes: 1_048_576 });

/** Audit numbers for a stall record: queue depths, the last write and request. Numbers and op names only. */
function stallContext(getCore) {
  const a = getCore()?.audit?.stats();
  if (!a) return { phase: 'start-up' };
  const ago = (t) => (t == null ? null : Math.round(performance.now() - t));
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return {
    audit: {
      queued: a.queuedAudit + a.queuedRaw + a.queuedDedupe + a.queuedActions,
      inflight: a.inflightAudit + a.inflightRaw + a.inflightDedupe + a.inflightActions, batches: a.batches, failed: a.failed ?? null,
      lastWrite: a.lastWrite ? { agoMs: ago(a.lastWrite.postedAt), ackMs: r2(a.lastWrite.ackMs), workerMs: r2(a.lastWrite.workerMs), rows: a.lastWrite.rows } : null,
      lastOp: a.lastOp ? { op: a.lastOp.op, agoMs: ago(a.lastOp.startedAt), ms: r2(a.lastOp.ms) } : null,
    },
  };
}

/** Live markers (F6, flag 'live-markers'): built only when a host markers token is given (opts.hostToken; the launcher
 *  passes UJWALAM_HOST_MARKERS_TOKEN, see cli.mjs serve; the host lets that role call marker.add and mixer.list only). The host is found through opts.hostDiscovery (default <dataDir>/host.json).
 *  Any failure here is a log line and the service runs without markers. Returns the producer or null. */
function startLiveMarkers({ core, dataDir, opts, out }) {
  if (opts.liveMarkers === false) return null;
  const token = opts.hostToken;
  if (!opts.liveMarkers?.host && (token === undefined || token === null || token === '')) { out('[serve] live markers: off (no host token)'); return null; }
  try {
    const config = loadLiveMarkerConfig();
    const host = opts.liveMarkers?.host ?? createHostLink({ discoveryFile: opts.hostDiscovery ?? path.join(dataDir, 'host.json'), token, timeoutMs: config.audio.hostTimeoutMs });
    const flags = opts.liveMarkers?.flags ?? createFlags({ dataDir });
    const lm = createLiveMarkers({ bus: core.bus, flags, host, config, log: out });
    out("[serve] live markers: ready; flag 'live-markers' is read every second (default off)");
    return lm;
  } catch (e) {
    out(`[serve] warn: live markers not started (${String(e?.message ?? 'error').slice(0, 80)})`);
    return null;
  }
}

/** opts: { dataDir?, port?, systemPipe? (false = no system pipe), mock?, url?, allowRemote? (E8-15: ws:// to a non-loopback host), credential?, noFixtures?, noStreamerbot?, env?, limits?, chatIntervalMs?, seed?, out?(line),
 *          stallTracer?: false | { thresholdMs?, maxBytes?, tickMs?, watchdog? }, core?: createEventCore overrides,
 *          hostToken?, hostDiscovery?, liveMarkers?: false | { host?, flags? } (test seams) } */
export async function startService(opts = {}) {
  const out = opts.out ?? (() => {});
  if (opts.url !== undefined) checkUrl(opts.url, { allowRemote: opts.allowRemote === true }); // before anything starts
  const dataDir = resolveDataDir({ dataDir: opts.dataDir });
  // re-protects an existing directory and everything already in it too (review E8-06)
  const { created, protection: dataDirProtection } = ensureSecureDir(dataDir);
  if (dataDirProtection === 'acl-failed') throw new Error('could not restrict the data directory to the current user (ACL_FAILED)');

  let core;
  // Started first, so start-up is covered too.
  const tracer = opts.stallTracer === false ? null : createStallTracer({
    ...STALL_DEFAULTS, ...(opts.stallTracer && typeof opts.stallTracer === 'object' ? opts.stallTracer : {}),
    file: path.join(dataDir, STALL_FILE), label: 'event-core', stallsOnly: true, context: () => stallContext(() => core),
  });
  const executor = createServiceExecutor({ getCore: () => core, mock: opts.mock === true });
  try {
    core = createEventCore({ dataDir, audit: { dataDir }, actions: { executor }, ...(opts.out ? { log: opts.out } : {}), ...(opts.core ?? {}) });
  } catch (e) { await tracer?.stop(); throw e; }
  await core.ready; // audit open + last dedupe window loaded (E7)
  const closeCoreOnFail = async (e) => { try { await core.audit?.close(); } catch { /* ignore */ } await tracer?.stop(); throw e; };

  let envTokens;
  try { envTokens = tokensFromEnv(opts.env ?? process.env); } catch (e) { return closeCoreOnFail(e); }
  const tokens = envTokens ?? { api: newToken(), system: newToken() };

  let sb = null;
  const api = createApiServer({
    core, tokens, port: opts.port ?? 0, limits: opts.limits,
    status: () => (sb ? { streamerbot: { state: sb.state(), received: sb.stats().received, published: sb.stats().published, reconnects: sb.stats().reconnects } } : {}),
  });
  let addr;
  try { addr = await api.listen(); } catch (e) { return closeCoreOnFail(e); }

  let file;
  try { file = publishApiFile({ dataDir, port: addr.port, tokens: envTokens ? null : tokens }); } catch (e) { await api.close(); return closeCoreOnFail(e); }
  core.audit.recordSystem({ subtype: 'api-start', source: 'api', verdict: 'ok', detail: { port: addr.port, mock: opts.mock === true } });

  // System pipe (E8-03 follow-up): panic for the supervisor on a listener a TCP flood cannot reach. Windows only; off
  // with opts.systemPipe === false. If its owner-only DACL cannot be verified it is not opened (fail closed) and the
  // service runs without it; the TCP API is unaffected.
  let pipe = null;
  let sysFile = null;
  if (opts.systemPipe !== false && process.platform === 'win32') {
    const p = createSystemPipeServer({ core, token: tokens.system, status: api.status });
    try {
      await p.listen();
      sysFile = publishSystemFile({ dataDir, pipe: p.path });
      pipe = p;
      core.audit.recordSystem({ subtype: 'system-pipe-start', source: 'system', verdict: 'ok', detail: { protection: p.stats().protection } });
    } catch (e) {
      await p.close();
      out(`[serve] warn: system pipe not started (${e?.code ?? 'error'}); panic stays available in-process and over the API`);
      core.audit.recordSystem({ subtype: 'system-pipe-start', source: 'system', verdict: 'error', detail: { code: String(e?.code ?? 'error').slice(0, 40) } });
    }
  }

  let mockSb = null;
  let chatTimer = null;
  if (opts.noStreamerbot !== true) {
    let url = opts.url ?? DEFAULT_URL;
    let getPassword = async () => null;
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
    let recorder = null;
    if (!opts.noFixtures && !opts.mock) { try { recorder = createFixtureRecorder({ dir: dataDir }); } catch { recorder = null; } }
    sb = createStreamerbotConnector({ core, url, allowRemote: opts.allowRemote === true, getPassword, recorder, onNote: (level, code) => out(`[serve] ${level}: ${code}`) });
    sb.start();
  }
  const liveMarkers = startLiveMarkers({ core, dataDir, opts, out });

  let stopped = false;
  return {
    core, api, tokens, dataDir, port: addr.port, apiFile: file, dataDirProtection, dataDirCreated: created,
    systemPipe: pipe, systemFile: sysFile,
    mockStreamerbot: mockSb, streamerbot: () => sb, liveMarkers, stallTracer: tracer, stallFile: tracer ? path.join(dataDir, STALL_FILE) : null,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (chatTimer) clearInterval(chatTimer);
      liveMarkers?.stop();
      sb?.stop();
      if (mockSb) await mockSb.close();
      core.audit.recordSystem({ subtype: 'api-stop', source: 'api', verdict: 'ok' });
      await pipe?.close();
      sysFile?.remove();
      await api.close();
      file.remove();
      await core.audit.close();
      await tracer?.stop();
    },
  };
}
