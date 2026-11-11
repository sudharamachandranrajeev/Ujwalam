// SPDX-License-Identifier: GPL-3.0-or-later
// LU3 service-swap soak (D337): swaps every swappable service N times (default 20) while the headless alpha stack
// streams to its loopback listeners, then rolls back a crashing build of each. Node stdlib + repo modules.
//
//   node tools/soak/swap-soak.mjs [--swaps 20] [--work-dir DIR] [--wait]
//
// What runs: the live-soak stack (stack.mjs) with swap: true, from a staged copy of the runtime (stage A). A second
// staged copy (stage B) stands in for the new version: each round swaps the event core and the UI server to the other
// stage, and a stand-in worker (stop-start slot; the Python workers are not wired to the launcher yet) to a new
// script. A numbered chat message goes to the mock Streamer.bot every 20 ms; one event-stream client on the core's
// front port must receive every number exactly once, in id order, on one connection. A UI client keeps calling the
// studio API with its login session. Then a build that exits at start is swapped in for each service: it must be
// rolled back with the old one still serving.
// Pass: every swap 'swapped', every rollback kept or restored the old one, 0 dropped / render-lagged / encode-skipped
// frames on the host, 0 dropped frames on every sink, every required stream live throughout, 0 lost and 0 duplicated
// chat events, every UI call answered with the same session. Loopback only: the stack refuses real targets.
// Not covered here: the host and the overlay server (never swapped while live, LU5).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { busyProcesses, missingRequiredStreams, REQUIRED_STREAMS } from './live-soak.mjs';
import { preflight, REPO, setBelow, startStack } from './stack.mjs';
import { stageRuntime } from './stage.mjs';
import { createWorkerSlot } from '../../services/supervisor/slots.mjs';
import { splitFrames } from '../../services/supervisor/front.mjs';
import { SAMPLES } from '../mock/mock-streamerbot.mjs';
import { track } from '../proc-registry.mjs';

const t0 = performance.now();
const log = (...a) => console.log(`[swap-soak +${Math.round((performance.now() - t0) / 1000)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseSwapArgs(argv) {
  const a = { swaps: 20, workDir: null, wait: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--wait') a.wait = true;
    else if (k === '--swaps') { a.swaps = Number(argv[++i]); if (!Number.isInteger(a.swaps) || a.swaps < 1 || a.swaps > 200) throw new Error('--swaps takes 1..200'); }
    else if (k === '--work-dir') { a.workDir = argv[++i]; if (!a.workDir) throw new Error('--work-dir needs a folder'); }
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** Numbers missing from 1..sent and numbers seen more than once (pure). */
export function seqProblems(seqs, sent) {
  const seen = new Map();
  for (const s of seqs) seen.set(s, (seen.get(s) ?? 0) + 1);
  const missing = []; const dup = [];
  for (let i = 1; i <= sent; i++) { const c = seen.get(i) ?? 0; if (c === 0) missing.push(i); else if (c > 1) dup.push(i); }
  return { missing, dup };
}

function chatClient(port, token) {
  const st = { seqs: [], outOfOrder: 0, connections: 0, last: '' };
  const req = http.request({ host: '127.0.0.1', port, path: '/events?kinds=chat.', agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
    st.connections++;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      const r = splitFrames(buf + d); buf = r.rest;
      for (const f of r.frames) {
        const m = /^data: (.*)$/m.exec(f.text);
        if (!m) continue;
        const ev = JSON.parse(m[1]);
        if (ev.id <= st.last) st.outOfOrder++;
        st.last = ev.id;
        const s = /^swap-soak-(\d+)$/.exec(ev.platformMessageId ?? '');
        if (s) st.seqs.push(Number(s[1]));
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return { st, close: () => req.destroy() };
}

function uiGet(port, route, cookie) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, agent: false, headers: { cookie } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(15_000, () => req.destroy());
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseSwapArgs(argv); } catch (e) { console.log(`swap-soak: ${e.message}`); return 2; }
  setBelow(process.pid);
  let busy = busyProcesses();
  if (busy.length && a.wait) { log('waiting for other heavy jobs to finish'); while (busy.length) { await sleep(30_000); busy = busyProcesses(); } }
  if (busy.length) { log(`not starting: ${[...new Set(busy.map((b) => b.what))].join(', ')} running (use --wait)`); return 4; }

  const started = new Date();
  const workDir = path.resolve(a.workDir ?? path.join(os.tmpdir(), 'ujwalam-soak', `${started.toISOString().slice(0, 10)}-swap-soak-${started.getTime()}`));
  const runDir = path.join(workDir, 'run');
  const coreDir = path.join(runDir, 'core');
  const hostData = path.join(runDir, 'host');
  const recvDir = path.join(workDir, 'media', 'recv');
  const recordingsDir = path.join(workDir, 'media', 'recordings');
  const feedbackDir = path.join(workDir, 'media', 'feedback');
  for (const d of [coreDir, hostData, recvDir, recordingsDir, feedbackDir]) mkdirSync(d, { recursive: true });
  const result = { startedAt: started.toISOString(), swaps: a.swaps, checks: [], rounds: [], notes: [] };
  const check = (name, pass, detail) => { result.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
  const finish = (code) => { writeFileSync(path.join(workDir, 'swap-soak.json'), `${JSON.stringify(result, null, 2)}\n`); log(`result: ${path.join(workDir, 'swap-soak.json')}`); return code; };
  if (!preflight({ log, check })) return finish(4);

  // Two staged versions and a build that cannot start.
  const stageA = stageRuntime(path.join(workDir, 'stage-a'), { eventCoreData: coreDir }).root;
  const stageB = stageRuntime(path.join(workDir, 'stage-b'), { eventCoreData: coreDir }).root;
  const crash = path.join(workDir, 'crash-build');
  for (const svc of ['event-core', 'studio-ui']) {
    mkdirSync(path.join(crash, 'services', svc), { recursive: true });
    writeFileSync(path.join(crash, 'services', svc, 'cli.mjs'), "console.log('broken build'); process.exit(3);\n");
  }
  const worker = path.join(workDir, 'worker');
  mkdirSync(worker, { recursive: true });
  writeFileSync(path.join(worker, 'good.mjs'), "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);\n");
  writeFileSync(path.join(worker, 'bad.mjs'), "setTimeout(() => process.exit(4), 100);\n");

  const st = await startStack({ runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check, root: stageA, profile: path.join(REPO, 'data', 'profile.local.json'), swap: true });
  if (!st) { result.notes.push('the stack did not start'); return finish(1); }
  const { c, mock } = st;
  let code = 1;
  const workerSlot = createWorkerSlot({
    name: 'stand-in-worker', healthMs: 1000,
    spawn: (spec) => { const p = track(spawn(process.execPath, [spec.script], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })); p.once('spawn', () => setBelow(p.pid)); return p; },
    onUnexpectedExit: (ch, x) => result.notes.push(`stand-in worker exited unplanned (${x})`),
  });
  try {
    check(`the plan has every required stream (${REQUIRED_STREAMS.join(', ')})`, missingRequiredStreams(st.params).length === 0);
    const before = await c.call('host.status');
    check('stream start accepted', await c.call('stream.start').then(() => true, () => false));
    let allLive = false;
    for (let i = 0; i < 80 && !allLive; i++) { const o = await c.call('outputs.status').catch(() => null); allLive = !!o && REQUIRED_STREAMS.every((id) => o.sinks.find((s) => s.id === id)?.state === 'live'); if (!allLive) await sleep(250); }
    check('every required stream live within 20 s', allLive);
    const base = { dropped: before.droppedFrames ?? 0, lagged: before.render?.renderLagged ?? 0, skipped: before.render?.encodeSkipped ?? 0 };
    workerSlot.start({ script: path.join(worker, 'good.mjs') });

    // Frame counters and stream state every second.
    const frames = { worst: { dropped: 0, lagged: 0, skipped: 0 }, notLive: 0 };
    let watching = true;
    const watch = (async () => {
      while (watching) {
        try {
          const hs = await c.call('host.status');
          const now = { dropped: (hs.droppedFrames ?? 0) - base.dropped, lagged: (hs.render?.renderLagged ?? 0) - base.lagged, skipped: (hs.render?.encodeSkipped ?? 0) - base.skipped };
          for (const k of Object.keys(now)) frames.worst[k] = Math.max(frames.worst[k], now[k]);
          const o = await c.call('outputs.status');
          if (!REQUIRED_STREAMS.every((id) => o.sinks.find((s) => s.id === id)?.state === 'live')) frames.notLive++;
        } catch { frames.notLive++; }
        await sleep(1000);
      }
    })();

    // Numbered chat in, one client out through the core's front.
    const client = chatClient(st.corePort, st.coreTokens.api);
    await sleep(500);
    let sent = 0;
    const emitter = setInterval(() => { mock.emit({ event: { source: 'Twitch', type: 'ChatMessage' }, data: { ...SAMPLES.twitchChat[2], messageId: `swap-soak-${++sent}`, text: `swap soak ${sent}` } }); }, 20);
    const s0 = await uiGet(st.uiPort, '/ui/api/session', st.cookie);
    const csrf = s0.status === 200 ? JSON.parse(s0.body).csrf : null;
    check('UI session before the swaps', !!csrf);
    const uiCalls = { ok: 0, bad: [] };
    let calling = true;
    const caller = (async () => {
      while (calling) {
        const r = await uiGet(st.uiPort, '/ui/api/session', st.cookie);
        if (r.status === 200 && JSON.parse(r.body).csrf === csrf) uiCalls.ok++; else uiCalls.bad.push(r.status);
        await sleep(100);
      }
    })();

    for (let i = 0; i < a.swaps; i++) {
      const to = i % 2 === 0 ? stageB : stageA;
      const core = await st.coreSlot.swap(to);
      await sleep(300);
      const ui = await st.uiSlot.swap(to);
      await sleep(300);
      const wk = await workerSlot.swap({ script: path.join(worker, 'good.mjs') });
      result.rounds.push({ round: i + 1, core: [core.result, core.ms], ui: [ui.result, ui.ms], worker: [wk.result, wk.ms] });
      log(`round ${i + 1}: core ${core.result} ${core.ms} ms, ui ${ui.result} ${ui.ms} ms, worker ${wk.result} ${wk.ms} ms; chat sent ${sent}, received ${client.st.seqs.length}`);
      await sleep(500);
    }
    const rb = {
      core: await st.coreSlot.swap(crash),
      ui: await st.uiSlot.swap(crash),
      worker: await workerSlot.swap({ script: path.join(worker, 'bad.mjs') }),
    };
    result.rollback = Object.fromEntries(Object.entries(rb).map(([k, v]) => [k, { result: v.result, failed: v.history?.filter((h) => !h.ok).map((h) => `${h.action}: ${h.error}`) }]));
    await sleep(2000);
    clearInterval(emitter);
    await sleep(1500);
    calling = false; await caller;
    watching = false; await watch;
    client.close();
    const os2 = await c.call('outputs.status');

    const { missing, dup } = seqProblems(client.st.seqs, sent);
    result.chat = { sent, received: client.st.seqs.length, missing: missing.length, duplicated: dup.length, outOfOrder: client.st.outOfOrder, connections: client.st.connections };
    result.ui = { calls: uiCalls.ok, bad: uiCalls.bad.length };
    result.frames = frames;
    result.sinks = os2.sinks.map((s) => ({ id: s.id, state: s.state, dropped: s.droppedFrames ?? 0, total: s.totalFrames ?? 0 }));
    for (const svc of ['core', 'ui', 'worker']) check(`${svc}: ${a.swaps} swaps, every one swapped`, result.rounds.every((r) => r[svc][0] === 'swapped'), result.rounds.map((r) => r[svc][0]).filter((x) => x !== 'swapped'));
    check('crashing build of the event core rolled back (kept-old)', rb.core.result === 'kept-old', result.rollback.core);
    check('crashing build of the UI server rolled back (kept-old)', rb.ui.result === 'kept-old', result.rollback.ui);
    check('crashing build of the worker rolled back (restored-old)', rb.worker.result === 'restored-old', result.rollback.worker);
    check('0 lost and 0 duplicated chat events (sequence numbers), in id order, one connection', missing.length === 0 && dup.length === 0 && client.st.outOfOrder === 0 && client.st.connections === 1 && sent > 0, result.chat);
    check('every UI call answered with the same login session', uiCalls.bad.length === 0 && uiCalls.ok > 0, result.ui);
    check('0 dropped, 0 render-lagged, 0 encode-skipped frames on the host', frames.worst.dropped === 0 && frames.worst.lagged === 0 && frames.worst.skipped === 0, frames.worst);
    check('0 dropped frames on every sink', result.sinks.every((s) => s.dropped === 0), result.sinks);
    check('every required stream live at every sample', frames.notLive === 0, { notLiveSamples: frames.notLive });
    check('no unplanned exit of the core, the UI server or the host', st.coreExit === null && st.uiExit === null && st.hostExit === null, { core: st.coreExit, ui: st.uiExit, host: st.hostExit });
    check('stream stop accepted', await c.call('stream.stop').then(() => true, () => false));
    code = result.checks.every((x) => x.pass) ? 0 : 1;
  } catch (e) {
    result.notes.push(`error: ${String(e?.message ?? e).slice(0, 300)}`);
    log('error', e?.stack ?? e);
  } finally {
    await workerSlot.stop().catch(() => {});
    await st.teardown();
  }
  log(code === 0 ? 'PASS' : 'FAIL', `${result.checks.filter((x) => x.pass).length}/${result.checks.length} checks`);
  return finish(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(REPO, 'tools', 'soak', 'swap-soak.mjs')) {
  const code = await main();
  process.exit(code);
}
