#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Replay harness for the P3 E7 latency, soak and crash runs. Node stdlib only.
//
//   node tools/soak/replay.mjs --data-root DIR [--mode replay|crash] [--speed 1|10] [--duration-s N] [--max-gap-s G]
//        [--export FILE] [--run-id ID] [--sample-s 10] [--kills 5] [--seed 1] [--resend 200] [--jitter-max-ms N] [--kill-with taskkill|terminate] [--no-loop] [--no-system-probe] [--power-every-s 300]
//        [--live-priority]
//
// Priority: the harness runs BelowNormal. The core child runs BelowNormal too, unless --live-priority: then the child
// sets itself to Normal like the live `serve` (simulating live) and the harness does not lower it.
//
// Reads a real Twitch VOD chat export from <data-root>/chat/twitch (JSON; the format is used by structure only),
// and replays its messages with their original relative timing divided by --speed through a mock Streamer.bot (loopback)
// into the REAL connector -> core -> moderation -> action gate (via the test rule stub in core-child.mjs) -> audit worker ->
// API SSE, all running in a child process. Nothing is sent to any platform.
//
// Export choice: the longest export of at least 2 h that holds at least one message (an export with zero messages cannot
// be replayed). The time before the first message is dropped. If --duration-s is longer than the export, the export
// loops (message ids get a "~N" suffix so each pass is new to the dedupe). --max-gap-s caps each gap between messages
// (dense mode: far more events per hour than a real stream, used as a load supplement and by the crash run).
//
// Data stays outside the repo: <data-root>/soak/<run-id>/ holds the data dir (audit DB, pseudonym key, api.json), the exec
// log (hashes only), and metrics (numbers only). At the end `audit purge --all --confirm yes` runs on the data dir, then
// the dir and run files are scanned for any replayed text or display name and the hits are counted (expected 0).
// This tool prints counts and timings only: never message text, user names or ids.

import { spawn, spawnSync } from 'node:child_process';
import { killTree, stopTracked, track } from '../proc-registry.mjs';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { closeAllMocks, startMockStreamerbot } from '../mock/mock-streamerbot.mjs';
import { rng } from '../mock/mock-chat.mjs';
import { openStore } from '../../services/event-core/audit/store.mjs';
import { DB_NAME } from '../../services/event-core/audit/index.mjs';
import { createSystemSampler } from './system-probe.mjs';
import { createStallTracer } from '../../services/event-core/diag/stall-tracer.mjs';
import { scanStrays } from '../stray-procs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CHILD = path.join(HERE, 'core-child.mjs');
const CORE_CLI = path.join(REPO, 'services', 'event-core', 'cli.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Start-up waits. The core child runs at below-normal priority, so on a machine busy with other test processes it can take
// minutes of wall clock to start; these are ceilings that stop a stuck start, not assertions. Override for slow machines.
const READY_MS = Number(process.env.UJWALAM_SOAK_READY_MS) || 120000;
const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL;
export const WARMUP_S = 600;
// Stated maximum dedupe gap: the audit batch timer (100 ms) plus one write; 250 ms leaves room for a slow commit.
export const GAP_BOUND_MS = 250;

// ---------------------------------------------------------------- args
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (['no-loop', 'no-purge', 'quiet', 'no-system-probe', 'live-priority'].includes(k)) o[k] = true; else o[k] = argv[++i];
  }
  return o;
}

export function resolveDataRoot(args, profilePath = path.join(REPO, 'data', 'profile.local.json')) {
  if (args['data-root']) return path.resolve(args['data-root']);
  if (process.env.UJWALAM_DATA_ROOT) return path.resolve(process.env.UJWALAM_DATA_ROOT);
  if (existsSync(profilePath)) {
    const v = JSON.parse(readFileSync(profilePath, 'utf8'))?.paths?.data_root;
    if (typeof v === 'string' && v && !/^<.*>$/.test(v)) return path.resolve(REPO, v);
  }
  throw new Error('need --data-root DIR (or UJWALAM_DATA_ROOT, or paths.data_root in data/profile.local.json)');
}

// ---------------------------------------------------------------- export reading (structure only)
/** Returns [{ file, lengthS, messages: [{ off, id, text, uid, login, name }] }] for every export in dir. */
export function readExports(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(j?.comments)) continue;
    const messages = j.comments
      .filter((c) => typeof c?.message?.body === 'string' && c.message.body.trim() !== '' && Number.isFinite(c.content_offset_seconds))
      .map((c) => ({ off: c.content_offset_seconds, id: String(c._id), text: c.message.body, uid: String(c.commenter?._id ?? 'u'), login: String(c.commenter?.name ?? 'u'), name: String(c.commenter?.display_name ?? c.commenter?.name ?? 'u') }))
      .sort((a, b) => a.off - b.off);
    out.push({ file: f, lengthS: Number(j.video?.length ?? 0), messages });
  }
  return out;
}

/** Longest export of at least minS seconds that holds at least one message; null when none. */
export function chooseExport(exports, minS = 7200) {
  const ok = exports.filter((e) => e.lengthS >= minS && e.messages.length > 0).sort((a, b) => b.lengthS - a.lengthS);
  return ok[0] ?? null;
}

// ---------------------------------------------------------------- timeline
/** Yields { tRel (export seconds since the first message, gaps capped), loop, seq, msg } forever when loop is true. */
export function* timeline(messages, { maxGapS = null, loop = false, loopGapS = null } = {}) {
  if (!messages.length) return;
  let t = 0; let seq = 0;
  for (let pass = 0; ; pass++) {
    for (let i = 0; i < messages.length; i++) {
      let gap = i === 0 ? (pass === 0 ? 0 : (loopGapS ?? maxGapS ?? 1)) : messages[i].off - messages[i - 1].off;
      if (maxGapS != null) gap = Math.min(gap, maxGapS);
      t += gap;
      yield { tRel: t, loop: pass, seq: ++seq, msg: messages[i] };
    }
    if (!loop) return;
  }
}

export function envelope(item) {
  const m = item.msg;
  const id = item.loop > 0 ? `${m.id}~${item.loop}` : m.id;
  return { event: { source: 'Twitch', type: 'ChatMessage' }, data: { messageId: id, text: m.text, user: { id: m.uid, login: m.login, name: m.name, role: 1, subscribed: false, badges: [] }, parts: [], emotes: [], isTest: true } };
}

// ---------------------------------------------------------------- stats
export const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const median = (xs) => pct(xs, 0.5);

/** Memory growth after the warm-up. rows: timeseries rows. Baseline = median of the first 3 samples at/after warmS; end = median of the last 3. */
export function memoryGrowth(rows, warmS = WARMUP_S, minPostS = 60) {
  const post = rows.filter((r) => r.t >= warmS);
  const last = rows.length ? rows[rows.length - 1].t : 0;
  if (post.length < 6 || last - warmS < minPostS) return { status: 'N/A', reason: `run shorter than the ${warmS} s warm-up plus ${minPostS} s`, samples: post.length };
  const grow = (key) => {
    const a = median(post.slice(0, 3).map((r) => r[key]));
    const b = median(post.slice(-3).map((r) => r[key]));
    const mb = b - a; const p = (mb / a) * 100;
    return { baselineMB: +a.toFixed(2), endMB: +b.toFixed(2), growthMB: +mb.toFixed(2), growthPct: +p.toFixed(2), pass: p <= 5 || mb <= 100 };
  };
  const rss = grow('rssMB');
  return { status: rss.pass ? 'PASS' : 'FAIL', warmupS: warmS, postWarmupSamples: post.length, spanS: last - warmS, rss, heapUsed: grow('heapUsedMB'), peakRssMB: Math.max(...rows.map((r) => r.rssMB)) };
}

export function readJsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- child control
function startChild({ dataDir, metricsDir, execLog, sbUrl, sampleMs, livePriority = false }) {
  return new Promise((resolve, reject) => {
    const p = track(spawn(process.execPath, [CHILD, '--data-dir', dataDir, '--sb-url', sbUrl, '--metrics-dir', metricsDir, '--exec-log', execLog, '--sample-ms', String(sampleMs), ...(livePriority ? ['--live-priority'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    if (!livePriority) { try { os.setPriority(p.pid, BELOW); } catch { /* best effort */ } }
    let buf = ''; let done = false;
    const exited = new Promise((r) => p.once('exit', (code) => r(code)));
    p.stdout.on('data', (d) => {
      buf += d;
      const m = /READY (\{.*\})/.exec(buf);
      if (m && !done) { done = true; clearTimeout(readyTimer); resolve({ proc: p, pid: p.pid, port: JSON.parse(m[1]).port, exited }); }
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.once('exit', (code) => { clearTimeout(readyTimer); if (!done) { done = true; reject(new Error(`core child exited early (code ${code}); stderr bytes ${err.length}, error names ${[...new Set(err.match(/(?:E[A-Z]{3,12}|[A-Z][A-Za-z]{2,24}Error)/g) ?? [])].slice(0, 4).join(',') || 'none'}`)); } });
    const readyTimer = setTimeout(() => { if (!done) { done = true; killTree(p.pid); reject(new Error(`core child did not become ready in ${Math.round(READY_MS / 1000)} s`)); } }, READY_MS);
  });
}

async function stopChild(child, timeoutMs = 120000) {
  try { child.proc.stdin.write('stop\n'); } catch { /* already gone */ }
  const code = await Promise.race([child.exited, sleep(timeoutMs).then(() => 'timeout')]);
  if (code === 'timeout') { killTree(child.pid); return 'timeout'; }
  return code;
}

async function waitSubscribed(mock, ms = READY_MS) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (mock.clientCount() > 0 && mock.subscriptions().some((s) => s.length > 0)) return true;
    await sleep(25);
  }
  throw new Error('core child did not subscribe to the mock Streamer.bot');
}

const readApiFile = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, 'api.json'), 'utf8'));

function rpc(port, token, method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/rpc', agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve({ http: res.statusCode, body: b ? JSON.parse(b) : null }); } catch { resolve({ http: res.statusCode, body: null }); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openSse(port, token) {
  const st = { events: 0, status: null };
  const req = http.request({ host: '127.0.0.1', port, path: '/events?kinds=chat.', agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
    st.status = res.statusCode;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { if (buf.startsWith('id: ')) st.events++; buf = buf.slice(i + 2); } });
  });
  req.on('error', () => {});
  req.end();
  return { st, close: () => req.destroy() };
}

// ---------------------------------------------------------------- replay loop
/** Plays items against the clock. hooks: { before?(item), after?(item) } may await (the clock is shifted by the wait). */
async function play(items, { mock, speed, durationS = null, hooks = {}, sent, mark = () => {} }) {
  let base = performance.now();
  const lag = [];
  let noClient = 0; let count = 0;
  for (const item of items) {
    const targetMs = (item.tRel / speed) * 1000;
    if (durationS != null && targetMs > durationS * 1000) break;
    if (hooks.before) { const t = performance.now(); await hooks.before(item); base += performance.now() - t; }
    let wait = base + targetMs - performance.now();
    while (wait > 1) { await sleep(Math.min(wait, 2000)); wait = base + targetMs - performance.now(); }
    lag.push(Math.max(0, performance.now() - (base + targetMs)));
    const env = envelope(item);
    mark('emit');
    const n = mock.emit(env);
    if (n === 0) noClient++;
    count++;
    sent.push({ env, seq: item.seq });
    if (sent.length > 1000) sent.splice(0, sent.length - 500);
    if (hooks.after) { const t = performance.now(); const r = await hooks.after(item); base += performance.now() - t; if (r === 'stop') break; }
  }
  return { sent: count, noClient, lagMs: { p50: pct(lag, 0.5), p95: pct(lag, 0.95), max: lag.length ? Math.max(...lag) : null } };
}

// ---------------------------------------------------------------- purge proof
function filesIn(dir) {
  const out = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...filesIn(p)); else out.push(p);
  }
  return out;
}
const sizes = (dir) => Object.fromEntries(readdirSync(dir).filter((f) => f.startsWith(DB_NAME)).map((f) => [f, statSync(path.join(dir, f)).size]));

/** Counts how many replayed bodies (>= 6 chars) and display names (>= 5 chars) occur in a file's bytes. Counts only. */
function scanFiles(files, bodies, names) {
  let bodyHits = 0; let nameHits = 0; let filesWithHits = 0;
  for (const f of files) {
    let b;
    try { b = readFileSync(f); } catch { continue; }
    let any = false;
    for (const t of bodies) if (b.includes(Buffer.from(t, 'utf8'))) { bodyHits++; any = true; }
    for (const t of names) if (b.includes(Buffer.from(t, 'utf8'))) { nameHits++; any = true; }
    if (any) filesWithHits++;
  }
  return { bodyHits, nameHits, filesWithHits };
}

function dbCounts(dataDir) {
  const s = openStore({ file: path.join(dataDir, DB_NAME), readOnly: true });
  try {
    const n = (q) => s.db.prepare(q).get().n;
    return { chatRaw: n('SELECT COUNT(*) AS n FROM chat_raw'), audit: n('SELECT COUNT(*) AS n FROM audit'), dedupeKeys: n('SELECT COUNT(*) AS n FROM dedupe_keys'), verify: s.verify() };
  } finally { s.close(); }
}

export function purgeProof({ dataDir, runDir, messages }) {
  const bodies = [...new Set(messages.map((m) => m.text).filter((t) => t.length >= 6))];
  const names = [...new Set(messages.flatMap((m) => [m.name, m.login]).filter((t) => t.length >= 5))];
  const dbFiles = () => readdirSync(dataDir).filter((f) => f.startsWith(DB_NAME) && !f.endsWith('.lock')).map((f) => path.join(dataDir, f));
  const before = { counts: dbCounts(dataDir), sizes: sizes(dataDir), scan: scanFiles(dbFiles(), bodies, names) };
  const r = spawnSync(process.execPath, [CORE_CLI, 'audit', 'purge', '--all', '--confirm', 'yes', '--data-dir', dataDir], { encoding: 'utf8', windowsHide: true });
  const line = String(r.stdout).trim().split(/\r?\n/).pop();
  const v = spawnSync(process.execPath, [CORE_CLI, 'audit', 'verify', '--data-dir', dataDir], { encoding: 'utf8', windowsHide: true });
  const after = { counts: dbCounts(dataDir), sizes: sizes(dataDir), scan: scanFiles(dbFiles(), bodies, names) };
  const others = filesIn(runDir).filter((f) => !dbFiles().includes(f));
  const runFiles = scanFiles(others, bodies, names);
  return {
    command: 'node services/event-core/cli.mjs audit purge --all --confirm yes --data-dir <soak-data-dir>',
    exit: r.status, output: line.replace(/\d+/, (d) => d), verifyExit: v.status, verifyOutput: String(v.stdout).trim(),
    scannedBodies: bodies.length, scannedNames: names.length, before, after, otherRunFilesScanned: others.length, otherRunFiles: runFiles,
  };
}

// ---------------------------------------------------------------- runs
function analyse(runDir, summary, extra = {}) {
  const rows = readJsonl(path.join(runDir, 'metrics', 'timeseries.jsonl'));
  const last = rows[rows.length - 1];
  const i2d = summary.ingestToDispatchMs;
  return {
    ingestToDispatchMs: i2d, busToSseMs: summary.busToSseMs, eldMsAll: summary.eldMsAll, cpuPctOneCore: summary.cpuPctOneCore,
    cpuPctOfMachine: +(summary.cpuPctOneCore.mean / summary.cores).toFixed(3),
    memory: memoryGrowth(rows), peakHeapUsedMB: Math.max(...rows.map((r) => r.heapUsedMB)), samples: rows.length,
    childStalls: summary.stalls ?? null, syncWriteMsMax: Math.max(0, ...rows.map((r) => r.syncWriteMsMax ?? 0)),
    drops: { auditA: summary.audit.droppedA, auditRaw: summary.audit.droppedR, auditDedupe: summary.audit.droppedD, auditLost: summary.audit.lostA + summary.audit.lostR + summary.audit.lostD, auditWriteErrors: summary.audit.writeErrors, sse: summary.sse.droppedTotal, bus: last.busDropped },
    maxQueue: { audit: Math.max(...rows.map((r) => r.audit.queuedAudit)), raw: Math.max(...rows.map((r) => r.audit.queuedRaw)), dedupe: Math.max(...rows.map((r) => r.audit.queuedDedupe)) },
    events: summary.events, connector: summary.connector, stub: summary.stub, auditVerify: summary.auditVerify, sseReceived: summary.sse.received,
    pb12: { budget: 'p95 <= 20 ms', value: i2d.p95, status: i2d.p95 != null && i2d.p95 <= 20 ? 'PASS' : 'FAIL' },
    ...extra,
  };
}

async function runReplay(args, ctx) {
  const speed = Number(args.speed ?? 1);
  const durationS = args['duration-s'] != null ? Number(args['duration-s']) : null;
  const maxGapS = args['max-gap-s'] != null ? Number(args['max-gap-s']) : null;
  const loopWanted = !args['no-loop'] && (durationS != null);
  const items = timeline(ctx.exp.messages, { maxGapS, loop: loopWanted });
  const mock = await startMockStreamerbot();
  const child = await startChild({ ...ctx.paths, sbUrl: mock.url, sampleMs: Number(args['sample-s'] ?? 10) * 1000, livePriority: args['live-priority'] === true });
  ctx.onAbort = () => { try { child.proc.kill(); } catch { /* gone */ } };
  await waitSubscribed(mock);
  const sent = [];
  const t0 = Date.now();
  const played = await play(items, { mock, speed, durationS, sent, mark: ctx.mark });
  // A duration run lasts the whole duration even when the last message comes earlier (idle time is part of a soak).
  if (durationS != null) { const rest = durationS * 1000 - (Date.now() - t0); if (rest > 0) await sleep(rest); }
  await sleep(3000); // let the last events drain through the audit worker and SSE
  const code = await stopChild(child);
  await mock.close();
  const summary = JSON.parse(readFileSync(path.join(ctx.paths.metricsDir, 'summary.json'), 'utf8'));
  return { mode: 'replay', speed, durationS, maxGapS, looped: loopWanted, wallSeconds: Math.round((Date.now() - t0) / 1000), harness: played, childExit: code, ...analyse(ctx.runDir, summary) };
}

function readExecLog(file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    const i = l.indexOf(',');
    const ts = Number(l.slice(0, i)); const k = l.slice(i + 1);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(ts);
  }
  return m;
}

async function runCrash(args, ctx) {
  const speed = Number(args.speed ?? 10);
  const kills = Number(args.kills ?? 5);
  const resendN = Number(args.resend ?? 200);
  const maxGapS = Number(args['max-gap-s'] ?? 1);
  const rand = rng(Number(args.seed ?? 1));
  const killAt = []; let at = 60;
  for (let i = 0; i < kills; i++) { at += 50 + Math.floor(rand() * 60); killAt.push(at); }
  const endSeq = killAt[killAt.length - 1] + 120;
  const items = timeline(ctx.exp.messages, { maxGapS, loop: true });
  const mock = await startMockStreamerbot();
  const mk = () => startChild({ ...ctx.paths, sbUrl: mock.url, sampleMs: Number(args['sample-s'] ?? 10) * 1000, livePriority: args['live-priority'] === true });
  let child = await mk();
  ctx.onAbort = () => { try { child.proc.kill(); } catch { /* gone */ } };
  await waitSubscribed(mock);
  const sent = [];
  const rows = [];
  const missingEver = new Set();
  const reportedDup = new Set();
  let pre = null;

  const hooks = {
    async before(item) {
      if (!killAt.includes(item.seq)) return;
      // Prepare the pre-kill facts: api.json identity and three pending confirmations requested through the API.
      const api = readApiFile(ctx.paths.dataDir);
      const confirms = [];
      for (let i = 0; i < 3; i++) {
        const r = await rpc(api.port, api.tokens.api, 'actions.request', { id: 'scene.create', params: { crashTest: i } });
        const c = r.body?.result?.confirm;
        if (c) confirms.push({ confirmId: c.confirmId, phrase: c.phrase, actionHash: c.actionHash });
      }
      pre = { api, confirms };
    },
    async after(item) {
      if (!killAt.includes(item.seq)) return item.seq >= endSeq ? 'stop' : undefined;
      const k = killAt.indexOf(item.seq) + 1;
      // time between the last emit and the kill: half the kills land within 30 ms of an emit (inside the audit batch window)
      const jitterMs = args['jitter-max-ms'] != null ? Math.floor(rand() * Number(args['jitter-max-ms'])) : (rand() < 0.5 ? Math.floor(rand() * 30) : Math.floor(rand() * 250));
      await sleep(jitterMs);
      const ring = sent.slice(-resendN).map((s) => s.env);
      const killTs = Date.now();
      // Default: taskkill /F /PID (the spec). It costs tens of ms to launch, so --kill-with terminate calls TerminateProcess
      // straight from this process (Node's SIGKILL on Windows) for the gap probe. killMs = call to child exit.
      const tk0 = performance.now();
      let tkStatus = 0;
      if (args['kill-with'] === 'terminate') process.kill(child.pid, 'SIGKILL');
      else tkStatus = spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { windowsHide: true, encoding: 'utf8' }).status;
      await Promise.race([child.exited, sleep(10000)]);
      const row = { kill: k, atSeq: item.seq, jitterMs, killWith: args['kill-with'] ?? 'taskkill', killMs: Math.round(performance.now() - tk0), taskkillExit: tkStatus, staleApiFile: false };
      // --- state on disk after the hard kill, before any restart ---
      try { const st = readApiFile(ctx.paths.dataDir); row.staleApiFile = st.pid === pre.api.pid; } catch { row.staleApiFile = false; }
      try {
        const s = openStore({ file: path.join(ctx.paths.dataDir, DB_NAME), readOnly: true });
        const v = s.verify();
        const keysDb = new Set(s.db.prepare('SELECT key FROM dedupe_keys WHERE seen_at >= ?').all(killTs - 120000).map((r) => r.key));
        s.close();
        row.auditAfterKill = { ok: v.ok, integrity: v.integrity, rows: v.rows, reason: v.reason };
        const exec = readExecLog(ctx.paths.execLog);
        const windowExec = [...exec].filter(([, ts]) => ts[ts.length - 1] >= killTs - 120000);
        const missing = windowExec.filter(([key]) => !keysDb.has(key));
        const execKeys = new Set(exec.keys());
        row.dedupeGap = {
          executedInWindow: windowExec.length, persistedInWindow: keysDb.size,
          executedNotPersisted: missing.length,
          maxAgeBeforeKillMs: missing.length ? Math.max(...missing.map(([, ts]) => killTs - ts[0])) : 0,
          persistedNotExecuted: [...keysDb].filter((key) => !execKeys.has(key)).length,
        };
        for (const [key] of missing) missingEver.add(key);
      } catch (e) { row.auditAfterKill = { ok: false, error: String(e?.code ?? e?.message).slice(0, 60) }; }
      const execBefore = readExecLog(ctx.paths.execLog);
      const execBeforeKeys = new Set(execBefore.keys());

      // --- restart ---
      child = await mk();
      await waitSubscribed(mock);
      const api2 = readApiFile(ctx.paths.dataDir);
      row.apiFile = { replaced: api2.pid !== pre.api.pid && api2.startedAt !== pre.api.startedAt, newPid: api2.pid !== pre.api.pid, tokensChanged: api2.tokens.api !== pre.api.tokens.api && api2.tokens.system !== pre.api.tokens.system, portChanged: api2.port !== pre.api.port };
      const oldTok = await rpc(api2.port, pre.api.tokens.api, 'core.status', {});
      const newTok = await rpc(api2.port, api2.tokens.api, 'core.status', {});
      row.tokens = { oldRejected: oldTok.http === 401, newAccepted: newTok.http === 200 };
      const sse = openSse(api2.port, api2.tokens.api);
      const verifyRpc = await rpc(api2.port, api2.tokens.api, 'audit.verify', {});
      row.auditAfterRestart = { ok: verifyRpc.body?.result?.ok === true, integrity: verifyRpc.body?.result?.integrity, rows: verifyRpc.body?.result?.rows };
      const refused = [];
      for (const c of pre.confirms) {
        const r = await rpc(api2.port, api2.tokens.api, 'actions.confirm', { confirmId: c.confirmId, phrase: c.phrase, actionHash: c.actionHash });
        refused.push(r.body?.result?.reason ?? r.body?.error?.code ?? 'none');
      }
      row.pendingConfirms = { requested: pre.confirms.length, refusedUnknownConfirm: refused.filter((x) => x === 'unknown-confirm').length, reasons: [...new Set(refused)] };
      const seeded = (await rpc(api2.port, api2.tokens.api, 'core.status', {})).body?.result?.events?.dedupe?.seeded ?? null;

      // --- Streamer.bot reconnect overlap: resend the last N events from before the kill ---
      for (let i = 0; i < ring.length; i++) { mock.emit(ring[i]); if (i % 20 === 19) await sleep(0); }
      await sleep(2000);
      // one fresh message after the resend proves SSE delivery from the restarted core
      const probe = structuredClone(ring[ring.length - 1]); probe.data.messageId = `crash-probe-${k}`;
      mock.emit(probe);
      await sleep(400);
      const st = (await rpc(api2.port, api2.tokens.api, 'core.status', {})).body?.result;
      row.resend = { sent: ring.length, seededKeys: seeded, dedupedByCore: st?.events?.deduped ?? null, publishedAfterResend: st?.events?.published ?? null };
      const execAfter = readExecLog(ctx.paths.execLog);
      let dupTotal = 0; let dupInGap = 0; let dupUnexplained = 0; let firstTimeOnResend = 0;
      for (const [key, ts] of execAfter) {
        if (ts.length > 1 && !reportedDup.has(key)) {
          reportedDup.add(key); dupTotal++;
          if (missingEver.has(key)) dupInGap++; else dupUnexplained++;
        }
      }
      for (const [key, ts] of execAfter) if (!execBeforeKeys.has(key) && ts.length >= 1 && ring.length) firstTimeOnResend++;
      row.dispatch = { duplicateKeys: dupTotal, duplicatesInDedupeGap: dupInGap, duplicatesUnexplained: dupUnexplained, keysFirstExecutedOnResend: Math.max(0, firstTimeOnResend - 1) };
      row.sseAfterRestart = { status: sse.st.status, events: sse.st.events };
      row.sseAfterRestartCheck = sse.st.status === 200 && sse.st.events >= 1;
      sse.close();
      pre = null;
      row.pass = {
        auditOk: row.auditAfterKill?.ok === true && row.auditAfterRestart.ok,
        noUnexplainedDuplicate: dupUnexplained === 0,
        gapWithinBound: (row.dedupeGap?.maxAgeBeforeKillMs ?? 0) <= GAP_BOUND_MS,
        sseAfterRestart: row.sseAfterRestartCheck === true,
        confirmsRefused: row.pendingConfirms.requested > 0 && row.pendingConfirms.refusedUnknownConfirm === row.pendingConfirms.requested,
        apiReplaced: row.apiFile.replaced && row.apiFile.tokensChanged && row.tokens.oldRejected && row.tokens.newAccepted,
      };
      rows.push(row);
      if (item.seq >= endSeq) return 'stop';
      return undefined;
    },
  };
  const t0 = Date.now();
  const played = await play(items, { mock, speed, hooks, sent, mark: ctx.mark });
  await sleep(2000);
  const code = await stopChild(child);
  await mock.close();
  const execFinal = readExecLog(ctx.paths.execLog);
  const dupFinal = [...execFinal].filter(([, ts]) => ts.length > 1).length;
  const summary = JSON.parse(readFileSync(path.join(ctx.paths.metricsDir, 'summary.json'), 'utf8'));
  return {
    mode: 'crash', speed, maxGapS, killAtSeq: killAt, resendN, wallSeconds: Math.round((Date.now() - t0) / 1000), harness: played, childExit: code,
    kills: rows, totals: {
      executedKeys: execFinal.size, duplicateKeysFinal: dupFinal,
      gapEventsTotal: rows.reduce((a, r) => a + (r.dedupeGap?.executedNotPersisted ?? 0), 0),
      gapMaxAgeMs: Math.max(0, ...rows.map((r) => r.dedupeGap?.maxAgeBeforeKillMs ?? 0)),
      persistedNotExecutedTotal: rows.reduce((a, r) => a + (r.dedupeGap?.persistedNotExecuted ?? 0), 0),
      allPass: rows.length === kills && rows.every((r) => Object.values(r.pass).every(Boolean)),
    },
    finalChildSummary: { events: summary.events, auditVerify: summary.auditVerify, stub: summary.stub },
  };
}

// ---------------------------------------------------------------- main
export async function main(argv) {
  const args = parseArgs(argv);
  try { os.setPriority(0, BELOW); } catch { /* best effort */ }
  const dataRoot = resolveDataRoot(args);
  const exports = readExports(path.join(dataRoot, 'chat', 'twitch'));
  let exp = args.export ? exports.find((e) => e.file === path.basename(args.export)) : chooseExport(exports);
  if (!exp) throw new Error('no export of at least 2 h with messages found');
  const mode = args.mode ?? 'replay';
  const runId = args['run-id'] ?? `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${mode}`;
  const runDir = path.join(dataRoot, 'soak', runId);
  if (existsSync(runDir)) throw new Error('run dir already exists; pick another --run-id');
  const paths = { dataDir: path.join(runDir, 'data'), metricsDir: path.join(runDir, 'metrics'), execLog: path.join(runDir, 'exec.log') };
  mkdirSync(paths.dataDir, { recursive: true }); mkdirSync(paths.metricsDir, { recursive: true });
  writeFileSync(paths.execLog, '');
  const msgs = exp.messages;
  const spanS = msgs.length ? msgs[msgs.length - 1].off - msgs[0].off : 0;
  const info = { runId, mode, exportLengthS: exp.lengthS, exportLengthH: +(exp.lengthS / 3600).toFixed(2), messages: msgs.length, firstToLastS: Math.round(spanS), machine: { cpu: os.cpus()[0].model, logicalCores: os.cpus().length, ramGB: +(os.totalmem() / 2 ** 30).toFixed(1), os: `${os.type()} ${os.release()}`, node: process.version }, chosenBy: 'longest export >= 2 h with >= 1 message', exportsSeen: exports.length };
  const say = (x) => { if (!args.quiet) console.log(x); };
  say(`[replay] ${JSON.stringify(info)}`);
  // Harness-side stall tracer: a stall here delays emits (harness lag) and must not be counted as a core stall.
  const harnessTracer = createStallTracer({ file: path.join(paths.metricsDir, 'harness-stalls.jsonl'), label: 'harness', thresholdMs: 200 });
  const ctx = { exp, runDir, paths, onAbort: null, mark: harnessTracer.mark };
  const abort = () => { ctx.onAbort?.(); process.exit(130); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);

  // Power (AC/battery) and system CPU load for the whole run, same noise thresholds as the bench harness.
  const sysProbe = args['no-system-probe'] ? null : createSystemSampler({ file: path.join(paths.metricsDir, 'system.jsonl'), everyMs: Number(args['sample-s'] ?? 10) * 1000, powerEveryMs: Number(args['power-every-s'] ?? 300) * 1000, mark: harnessTracer.mark });
  await sysProbe?.start();
  let result;
  try { result = mode === 'crash' ? await runCrash(args, ctx) : await runReplay(args, ctx); } finally {
    // Whatever the run ended with (done, thrown, timed out), no child or mock of this run outlives it.
    await stopTracked(); await closeAllMocks();
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    ctx.system = await sysProbe?.stop(); ctx.harnessStalls = await harnessTracer.stop();
  }
  result.system = ctx.system ?? { status: 'NOT RECORDED' };
  result.harnessStalls = ctx.harnessStalls;
  // Nothing this run started may still be running (mock server, core child). pid, script and age only.
  result.strayProcesses = scanStrays();
  result.info = info;
  if (!args['no-purge']) result.purge = purgeProof({ dataDir: paths.dataDir, runDir, messages: msgs });
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  say(`[replay] result ${path.join(runDir, 'result.json')}`);
  say(JSON.stringify(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.log(`[replay] failed: ${e?.message ?? e}`); process.exit(1); });
}
