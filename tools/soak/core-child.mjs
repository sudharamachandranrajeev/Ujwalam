// SPDX-License-Identifier: GPL-2.0-or-later
// Event-core process under test for the E7 soak/crash runs (P3). Node stdlib only.
//
//   node tools/soak/core-child.mjs --data-dir DIR --sb-url ws://127.0.0.1:N/ --metrics-dir DIR --exec-log FILE [--sample-ms 10000]
//        [--live-priority]
//
// Priority: BelowNormal by default (long test runs, resource rule). --live-priority simulates the live core and sets
// Normal, as `serve` does (services/event-core/priority.mjs). The result is in summary.json `priority`.
//
// Starts the real service (connector -> core -> moderation -> action gate -> audit worker -> API) against a mock
// Streamer.bot, plus a TEST rule stub that turns every chat event into gate requests, and an SSE client on its own API.
// Control: a line "stop" on stdin ends the run cleanly; kill -9 ends it hard (the crash test).
// Output: one line `READY {"port":N}` on stdout (never a token). Metrics go to files in --metrics-dir:
//   timeseries.jsonl  one row per sample: RSS/heap, CPU, event-loop delay, audit queues and drops, SSE drops, counts
//   latency.csv       wallMs,ingest_to_dispatch_ms   (one row per chat event)
//   sse-latency.csv   wallMs,bus_to_sse_ms           (one row per chat event received by the SSE client)
//   stalls.jsonl      event-loop stalls over 200 ms with what was running (services/event-core/diag/stall-tracer.mjs)
//   summary.json      written on "stop"
// Chat text is never written: the stub reads ids, kinds and pseudonymous ids only.
//
// The rule stub (TEST ONLY, nothing like it ships). For every chat event n:
//   tainted request, source 'rule' with chat provenance, cycling effect.fire (refused chat-not-allowed),
//     stream.start (refused chat-forbidden), state.read (refused chat-not-allowed);
//   dispatch probe: state.read from an UNTAINTED rule (provenance schedule) with params { k: dedupe key hash }, the one
//     request that reaches the executor, so a duplicate dispatch after a restart can be counted per message hash;
//   every 50th event: scene.create from the untainted rule, which the gate answers with a confirmation (pending state).
// The committed catalogue allows no action from chat, so a chat-tainted request can only be refused; the probe stands in
// for "a rule that reacts to a message" and is the reason the dispatch count exists.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { startService } from '../../services/event-core/api/service.mjs';
import { dedupeKey } from '../../services/event-core/dedupe.mjs';
import { createStallTracer } from '../../services/event-core/diag/stall-tracer.mjs';
import { setBackgroundPriority, setLivePriority } from '../../services/event-core/priority.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const dataDir = arg('data-dir');
const sbUrl = arg('sb-url');
const metricsDir = arg('metrics-dir');
const execLog = arg('exec-log');
const sampleMs = Number(arg('sample-ms', '10000'));
if (!dataDir || !sbUrl || !metricsDir || !execLog) { console.log('usage: core-child --data-dir D --sb-url U --metrics-dir D --exec-log F'); process.exit(2); }

const livePriority = argv.includes('--live-priority');
const priority = livePriority ? setLivePriority() : setBackgroundPriority(0); // never throws; reported in summary.json
mkdirSync(metricsDir, { recursive: true });
const F = (n) => path.join(metricsDir, n);

// Stall tracer first, so start-up is covered too. Context: the audit writer's last write and request, queue depth.
let coreRef = null;
// Longest synchronous file append done by this harness code on the main thread (metrics and exec log), per sample.
let syncWriteMsMax = 0;
const tracer = createStallTracer({
  file: F('stalls.jsonl'), label: 'core-child', thresholdMs: 200,
  context: () => {
    const a = coreRef?.audit?.stats();
    if (!a) return { phase: 'start-up' };
    const ago = (t) => (t == null ? null : Math.round(performance.now() - t));
    return {
      audit: {
        queued: a.queuedAudit + a.queuedRaw + a.queuedDedupe, inflight: a.inflightAudit + a.inflightRaw + a.inflightDedupe, batches: a.batches,
        lastWrite: a.lastWrite ? { agoMs: ago(a.lastWrite.postedAt), ackMs: +a.lastWrite.ackMs.toFixed(2), workerMs: a.lastWrite.workerMs == null ? null : +a.lastWrite.workerMs.toFixed(2), rows: a.lastWrite.rows } : null,
        lastOp: a.lastOp ? { op: a.lastOp.op, agoMs: ago(a.lastOp.startedAt), ms: a.lastOp.ms == null ? null : +a.lastOp.ms.toFixed(2) } : null,
      },
      syncWriteMsMax,
    };
  },
});
const timedAppend = (file, text, tag) => {
  tracer.mark(`${tag}:start`);
  const t = performance.now();
  appendFileSync(file, text);
  const ms = performance.now() - t;
  if (ms > syncWriteMsMax) syncWriteMsMax = ms;
  tracer.mark(`${tag}:end`);
};

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const summarise = (xs) => {
  const s = Float64Array.from(xs).sort();
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s.length ? s[s.length - 1] : null, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null };
};

// ---- executor: counts dispatches per message hash, synchronously appended so a kill -9 cannot lose a line ----
const counts = { dispatched: 0, probes: 0, refused: {}, confirms: 0, requests: 0 };
const executor = {
  execute(act) {
    counts.dispatched++;
    if (act.id === 'state.read' && typeof act.params?.k === 'string') {
      counts.probes++;
      timedAppend(execLog, `${Date.now()},${act.params.k}\n`, 'exec-log');
    }
    return { ok: true };
  },
};

const svc = await startService({ dataDir, port: 0, url: sbUrl, noFixtures: true, stallTracer: false, core: { actions: { executor } } });
const core = svc.core;
coreRef = core;
tracer.mark('service-ready');
const gate = core.actions;

// ---- rule stub ----
const lat = []; const latBuf = [];
const TAINTED = ['effect.fire', 'stream.start', 'state.read'];
const CLEAN = { kind: 'rule', parent: { kind: 'schedule' } };
let n = 0;
core.bus.subscribe({
  name: 'soak-rule-stub', kinds: ['chat.'], limit: 20_000,
  handler: (ev) => {
    tracer.mark('rule:start');
    n++;
    const tally = (r) => { counts.requests++; if (r.verdict === 'refuse') counts.refused[r.reason] = (counts.refused[r.reason] ?? 0) + 1; return r; };
    tally(gate.request({ id: TAINTED[n % 3], params: { n }, source: 'rule', actor: ev.user?.pseudoId, provenance: { kind: 'rule', parent: { kind: ev.kind, eventId: ev.id } } }));
    // The probe carries the event id, so the gate keys it to the platform message (idempotency, E7 follow-up).
    tally(gate.request({ id: 'state.read', params: { k: dedupeKey(ev.platform, ev.platformMessageId) }, source: 'rule', actor: 'soak-stub', provenance: { kind: 'rule', parent: { kind: 'schedule', eventId: ev.id } } }));
    if (n % 50 === 0) { const r = tally(gate.request({ id: 'scene.create', params: { n }, source: 'rule', actor: 'soak-stub', provenance: CLEAN })); if (r.verdict === 'confirm') counts.confirms++; }
    const ms = performance.now() - ev.mono;
    lat.push(ms);
    latBuf.push(`${Date.now()},${ms.toFixed(3)}`);
    tracer.mark('rule:end');
  },
});

// ---- SSE client on our own API (real HTTP path, same clock as event.mono) ----
const sseLat = []; const sseBuf = [];
let sseEvents = 0;
const sseReq = http.request({ host: '127.0.0.1', port: svc.port, path: '/events?kinds=chat.', headers: { authorization: `Bearer ${svc.tokens.api}` }, agent: false }, (res) => {
  res.setEncoding('utf8');
  let buf = '';
  res.on('data', (d) => {
    const recv = performance.now();
    tracer.mark('sse:data');
    buf += d;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const at = block.indexOf('data: ');
      if (!block.startsWith('id: ') || at < 0) continue;
      sseEvents++;
      const mono = JSON.parse(block.slice(at + 6)).mono;
      const ms = recv - mono;
      sseLat.push(ms);
      sseBuf.push(`${Date.now()},${ms.toFixed(3)}`);
    }
  });
});
sseReq.on('error', () => {});
sseReq.end();

// ---- sampler ----
const eld = monitorEventLoopDelay({ resolution: 5 }); eld.enable();
const eldAll = monitorEventLoopDelay({ resolution: 5 }); eldAll.enable();
const t0 = Date.now();
let lastCpu = process.cpuUsage(); let lastT = performance.now();
const cores = os.cpus().length;
const cpuRows = [];
function sample(final = false) {
  tracer.mark('sample:start');
  const now = performance.now();
  const cpu = process.cpuUsage(lastCpu);
  const cpuPct = ((cpu.user + cpu.system) / 1000) / (now - lastT) * 100; // % of ONE core
  lastCpu = process.cpuUsage(); lastT = now;
  cpuRows.push(cpuPct);
  const m = process.memoryUsage();
  const a = core.audit.stats();
  const bus = core.bus.stats();
  const sseC = svc.api.sseClients();
  const sseDropped = svc.api.stats().sseDropped + sseC.reduce((x, c) => x + c.dropped, 0);
  const busDropped = Object.values(bus.subscribers).reduce((x, s) => x + s.dropped, 0);
  const row = {
    t: Math.round((Date.now() - t0) / 1000), wall: Date.now(), final,
    rssMB: +(m.rss / 1048576).toFixed(2), heapUsedMB: +(m.heapUsed / 1048576).toFixed(2), heapTotalMB: +(m.heapTotal / 1048576).toFixed(2), externalMB: +(m.external / 1048576).toFixed(2),
    cpuPctOneCore: +cpuPct.toFixed(2),
    eldMs: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
    audit: { queuedAudit: a.queuedAudit, queuedRaw: a.queuedRaw, queuedDedupe: a.queuedDedupe, droppedA: a.droppedA, droppedR: a.droppedR, droppedD: a.droppedD, lostA: a.lostA, lostR: a.lostR, lostD: a.lostD, writeErrors: a.writeErrors, batches: a.batches, writtenD: a.writtenD, blockMsP95: a.blockMs.p95 },
    sse: { clients: sseC.length, dropped: sseDropped, received: sseEvents },
    busDropped, received: svc.streamerbot()?.stats().received ?? null, ingested: core.stats().published, stub: n, dispatched: counts.dispatched,
    auditInflight: a.inflightAudit + a.inflightRaw + a.inflightDedupe,
    syncWriteMsMax: +syncWriteMsMax.toFixed(3), stalls: tracer.summary().stalls,
  };
  eld.reset();
  syncWriteMsMax = 0;
  timedAppend(F('timeseries.jsonl'), `${JSON.stringify(row)}\n`, 'sample-write');
  if (latBuf.length) { timedAppend(F('latency.csv'), `${latBuf.join('\n')}\n`, 'sample-write'); latBuf.length = 0; }
  if (sseBuf.length) { timedAppend(F('sse-latency.csv'), `${sseBuf.join('\n')}\n`, 'sample-write'); sseBuf.length = 0; }
  tracer.mark('sample:end');
  return row;
}
writeFileSync(F('latency.csv'), 'wallMs,ingest_to_dispatch_ms\n', { flag: 'a' });
writeFileSync(F('sse-latency.csv'), 'wallMs,bus_to_sse_ms\n', { flag: 'a' });
const timer = setInterval(() => sample(), sampleMs);

process.stdout.write(`READY ${JSON.stringify({ port: svc.port })}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 500));
  const last = sample(true);
  const stalls = await tracer.stop();
  await core.audit.flush();
  const audit = core.audit.stats();
  const verify = await core.audit.verify();
  const sb = svc.streamerbot()?.stats();
  const sseC = svc.api.sseClients();
  const summary = {
    durationS: Math.round((Date.now() - t0) / 1000), cores, last,
    ingestToDispatchMs: summarise(lat), busToSseMs: summarise(sseLat),
    eldMsAll: { n: eldAll.count, mean: eldAll.mean / 1e6, p50: eldAll.percentile(50) / 1e6, p99: eldAll.percentile(99) / 1e6, p999: eldAll.percentile(99.9) / 1e6, max: eldAll.max / 1e6, resolutionMs: 5 },
    cpuPctOneCore: { mean: cpuRows.reduce((a, b) => a + b, 0) / Math.max(1, cpuRows.length), max: Math.max(0, ...cpuRows) },
    events: core.stats(), connector: sb ? { received: sb.received, published: sb.published, deduped: sb.deduped, invalid: sb.invalid, skipped: sb.skipped, reconnects: sb.reconnects } : null,
    stub: { events: n, ...counts }, audit, auditVerify: verify,
    sse: { received: sseEvents, droppedTotal: svc.api.stats().sseDropped + sseC.reduce((x, c) => x + c.dropped, 0) },
    stalls, priority: { live: livePriority, ...priority },
  };
  writeFileSync(F('summary.json'), JSON.stringify(summary, null, 2));
  sseReq.destroy();
  await svc.stop();
  process.exit(0);
}
process.stdin.setEncoding('utf8');
let inbuf = '';
process.stdin.on('data', (d) => { inbuf += d; if (/(^|\n)stop\r?\n/.test(inbuf)) stop(); });
process.stdin.on('end', () => { stop(); });
