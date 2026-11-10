#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Stream-day mock run: the full alpha stack, headless, with loopback outputs only. Node stdlib + repo modules.
//
//   node tools/soak/stream-day.mjs --data-root DIR [--minutes 60] [--sample-s 30] [--run-id ID] [--speed 1]
//        [--replay-every-min 10] [--effects-every-min 5] [--no-record] [--max-gap-s G]
//
// What runs (each piece is the real one; nothing is faked except Streamer.bot and the platforms):
//   - mock Streamer.bot (tools/mock/mock-streamerbot.mjs, 127.0.0.1) replaying a real Twitch VOD chat export from
//     <data-root>/chat/twitch with its original timing (tools/soak/replay.mjs readExports/chooseExport/timeline);
//   - the event core (`services/event-core/cli.mjs serve --url <mock>`) with the launcher's own environment (coreEnv:
//     api/system tokens and the scoped host MARKERS token, D214; never the full host token);
//   - ujwalam-host in alpha mode (launcher hostLaunchSpec: browser layers, overlay server child fed by the event core,
//     host config with the 30 s replay buffer) with UJWALAM_HEADLESS=1 (no preview window), no --allow-devices, no
//     --allow-live, and an outputs plan whose every stream target is a 127.0.0.1 RTMP listener (ffmpeg -listen 1);
//   - the alpha project (launcher alphaProject: Default H + Default V presets, device layers as placeholders);
//   - the studio UI server (login with the one-time launch key in memory; status polled like the page does).
// Global hotkeys are OFF in this run's host config (the alpha default registers Ctrl+Alt+P/F/M on the user's desktop).
// Flags are switched on ONLY in this run's data dir (<run>/core/flags.local.json): live-markers, posting, auto-post,
// chat-effects, test-broadcast. data/flags.json is never touched.
//
// The streams are started with the host's own outputs API (stream.start, record.start) using the host token this
// script made; the control page's typed "yes, on air" gate is not used and not typed. The host refuses real targets
// (no --allow-live), so nothing can leave the machine.
//
// During the run: samples every --sample-s (host.status, outputs.status, replay.status, feedback.status, overlay.stats,
// core.status, UI /ui/api/status, nvidia-smi NVENC sessions and VRAM, per-process memory/handles of the whole tree);
// effect bursts every --effects-every-min through effect.fire (guards: budget, cooldown, region, flash); a replay save
// every --replay-every-min; an auto-post check while live (dry run, and --run with a temporary approve-only rule:
// it must refuse while outputs are live). Event-core latency: mock emit -> API SSE delivery, matched by message id.
// After: clean stop, ffprobe of every loopback-received file, the recording and the replay saves, crash-*.txt count,
// stray processes, `audit purge --all`, then a scan of the run dir for any replayed chat text or display name
// (counts only). Output: <run>/result.json and timeseries.jsonl (numbers only). Prints counts and timings only:
// never chat text, names, ids, tokens or keys.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { probe } from '../../app/host/lib/ffprobe.mjs';
import { createFlags } from '../../services/flags/index.mjs';
import { scanStrays } from '../stray-procs.mjs';
import { chooseExport, envelope, pct, purgeProof, readExports, timeline } from './replay.mjs';
import { filesUnder, gpu, httpReq, LOOPBACK_PORTS, loopbackPlan, openSse, REPO, rpcCore, setBelow, startStack, preflight, summariseProbe, treeOf } from './stack.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[stream-day +${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
export const RUN_FLAGS = Object.freeze(['live-markers', 'posting', 'auto-post', 'chat-effects', 'test-broadcast']);
export { LOOPBACK_PORTS, loopbackPlan }; // kept: tests and other tools import them from here

/** Numbers from the time series (pure; tested): memory after a 10 min warm-up (or the first third), frames, sessions. */
export function summarise(rows, warmS = 600) {
  const ok = rows.filter((r) => r.host && r.mem);
  if (!ok.length) return null;
  const warm = ok.find((r) => r.t >= warmS) ?? ok[Math.floor(ok.length / 3)];
  const end = ok[ok.length - 1];
  const grow = (k) => (warm.mem[k] == null || end.mem[k] == null ? null : { atWarmup: warm.mem[k], end: end.mem[k], delta: +(end.mem[k] - warm.mem[k]).toFixed(1) });
  const sinks = {};
  for (const s of end.sinks ?? []) sinks[s.id] = { state: s.state, total: s.total, dropped: s.dropped, retries: s.retries };
  const notLive = ok.reduce((n, r) => n + (r.sinks ?? []).filter((s) => s.state !== 'live').length, 0);
  return {
    samples: ok.length, spanS: end.t, warmupAtS: warm.t,
    fpsMin: Math.min(...ok.map((r) => r.host.fps)), renderLagged: end.host.renderLagged, encodeSkipped: end.host.encodeSkipped,
    nvencSessionsMax: Math.max(...ok.map((r) => r.gpu?.sessions ?? 0)), vramMBMax: Math.max(...ok.map((r) => r.gpu?.memMB ?? 0)),
    hostCpuPctMax: Math.max(...ok.map((r) => r.host.cpuPct ?? 0)), gpuPctMax: Math.max(...ok.map((r) => r.host.gpuPct ?? 0)),
    hostPrivMB: grow('hostPrivMB'), treePrivMB: grow('privMB'), treeHandles: grow('handles'), hostHandles: grow('hostHandles'), procs: grow('procs'),
    coreRttMsMax: Math.max(...ok.map((r) => r.core?.rttMs ?? 0)), uiNon200: ok.filter((r) => r.ui && r.ui.status !== 200).length,
    sinkSamplesNotLive: notLive, sinks, markers: end.markers, captures: end.captures, overlay: end.overlay,
  };
}

/** --key value pairs; BOOLEAN_ARGS take no value (replay.mjs's parser would eat the next flag as their value). */
export const BOOLEAN_ARGS = Object.freeze(['no-record']);
export function parseRunArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOLEAN_ARGS.includes(k)) o[k] = true;
    else if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${k} needs a value`);
    else o[k] = argv[++i];
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRunArgs(argv);
  const minutes = Number(args.minutes ?? 60);
  const sampleMs = Number(args['sample-s'] ?? 30) * 1000;
  const speed = Number(args.speed ?? 1);
  const replayEveryMs = Number(args['replay-every-min'] ?? 10) * 60000;
  const effectsEveryMs = Number(args['effects-every-min'] ?? 5) * 60000;
  if (!args['data-root']) { console.log('usage: node tools/soak/stream-day.mjs --data-root DIR [--minutes 60]'); return 2; }
  const dataRoot = path.resolve(args['data-root']);
  const runId = String(args['run-id'] ?? `stream-day-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const runDir = path.join(dataRoot, 'soak', runId);
  const coreDir = path.join(runDir, 'core');
  const hostData = path.join(runDir, 'host');
  // Media (loopback receives, recording, replay saves, feedback clips) goes next to the run dir, not in it: the
  // text scan at the end reads every file of the run dir.
  const mediaDir = path.join(dataRoot, 'soak', `${runId}-media`);
  const recvDir = path.join(mediaDir, 'recv');
  const recordingsDir = path.join(mediaDir, 'recordings');
  const feedbackDir = path.join(mediaDir, 'feedback');
  for (const d of [coreDir, hostData, recvDir, recordingsDir, feedbackDir]) mkdirSync(d, { recursive: true });
  setBelow(process.pid);
  const result = { runId, startedAt: new Date().toISOString(), minutes, speed, maxGapS: args['max-gap-s'] != null ? Number(args['max-gap-s']) : null, sampleS: sampleMs / 1000, checks: [], notes: [] };
  const check = (name, pass, detail) => { result.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
  const tsFile = path.join(runDir, 'timeseries.jsonl');

  // ---- pre-flight
  if (!preflight({ log, check })) return 4;
  const gpuBefore = await gpu();
  result.gpuBefore = gpuBefore;
  const exp = chooseExport(readExports(path.join(dataRoot, 'chat', 'twitch')), 3600);
  if (!exp) { log('no chat export of at least 1 h'); return 2; }
  result.chat = { exportLengthS: exp.lengthS, messages: exp.messages.length };

  // ---- flags (this run's data dir only)
  const flags = createFlags({ dataDir: coreDir });
  for (const id of RUN_FLAGS) flags.set(id, true);
  result.flags = Object.fromEntries(RUN_FLAGS.map((id) => [id, flags.isOn(id)]));
  check('run flags on in the temp data dir only', RUN_FLAGS.every((id) => flags.isOn(id)) && !createFlags({ dataDir: path.join(runDir, 'nonexistent') }).isOn('live-markers'));

  // ---- the stack: loopback listeners, mock Streamer.bot, event core, host, alpha project, UI server (stack.mjs)
  const st = await startStack({ runDir, coreDir, hostData, recvDir, recordingsDir, feedbackDir, log, check, profile: path.join(REPO, 'data', 'profile.local.json') });
  if (!st) return 1;
  const { c, corePort, coreTokens, uiPort, cookie, mock, host, params } = st;
  result.plan = { rungs: params.rungs?.map((r) => ({ id: r.id, canvas: r.canvas, w: r.w, h: r.h, fps: r.fps, kbps: r.bitrate })) ?? null, sinks: params.sinks.map((s) => s.id), warnings: st.planReport.warnings.map((w) => w.code) };
  result.hostNotes = st.hostNotes;
  result.host = st.hostInfo;
  const emitted = new Map(); const lat = [];
  const sse = openSse(corePort, coreTokens.api, emitted, lat);

  // ---- start outputs (host API; loopback only)
  const startedAt = Date.now();
  result.streamStart = await c.call('stream.start').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
  if (args['no-record'] !== true) result.recordStart = await c.call('record.start').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
  await sleep(3000);

  // ---- run loop
  const endAt = startedAt + minutes * 60000;
  const actions = { replaySaves: [], effects: [], autoPost: [], feedback: [] };
  const coreRtt = []; const playLag = [];
  let sent = 0; let noClient = 0;
  const player = (async () => {
    // --max-gap-s caps each gap (dense mode, as in replay.mjs): the local exports are sparse, so a dense run is the
    // load supplement for the event core, the overlay chat feed and the chat-speed live markers.
    const items = timeline(exp.messages, { loop: true, maxGapS: args['max-gap-s'] != null ? Number(args['max-gap-s']) : null });
    let base = performance.now();
    for (const item of items) {
      const target = base + (item.tRel / speed) * 1000;
      if (Date.now() + (target - performance.now()) > endAt) break;
      let wait = target - performance.now();
      while (wait > 1) { await sleep(Math.min(wait, 2000)); wait = target - performance.now(); }
      if (Date.now() > endAt) break;
      playLag.push(Math.max(0, performance.now() - target));
      const env = envelope(item);
      emitted.set(env.data.messageId, performance.now());
      if (emitted.size > 5000) emitted.delete(emitted.keys().next().value);
      if (mock.emit(env) === 0) noClient++;
      sent++;
    }
  })();

  async function sample(tag) {
    const row = { t: Math.round((Date.now() - startedAt) / 1000), tag };
    try {
      const [hs, os2, rs, fs, ov] = await Promise.all([c.call('host.status'), c.call('outputs.status'), c.call('replay.status'), c.call('feedback.status'), c.call('overlay.stats').catch(() => null)]);
      row.host = { fps: hs.fps, cpuPct: hs.cpuPct, gpuPct: hs.gpuPct, renderLagged: hs.render?.renderLagged, encodeSkipped: hs.render?.encodeSkipped, encoderSessions: hs.gpu?.encoderSessions ?? null, live: hs.live, recording: hs.recording, dropped: hs.droppedFrames, total: hs.totalFrames };
      row.sinks = os2.sinks.map((s) => ({ id: s.id, state: s.state, kbps: s.kbps, total: s.totalFrames, dropped: s.droppedFrames, retries: s.retries }));
      row.replay = (rs.canvases ?? []).map((x) => `${x.canvas}:${x.state}`);
      row.markers = fs.markers ?? null; row.captures = fs.captures ?? null;
      row.overlay = ov ? { clients: ov.clients, chatFrames: ov.chatFrames, busFrames: ov.busFrames, effects: ov.effects, refused: ov.refused ?? ov.guards ?? null } : null;
    } catch (e) { row.hostError = String(e.code ?? e.message).slice(0, 60); }
    const cs = await rpcCore(corePort, coreTokens.api, 'core.status'); coreRtt.push(cs.ms);
    row.core = { rttMs: Math.round(cs.ms), error: cs.error, liveState: cs.result?.live?.liveState ?? null };
    if (cookie) { const u = await httpReq(uiPort, 'GET', '/ui/api/status', { cookie }); row.ui = { status: u.status, hostAvailable: u.body?.host?.available ?? null, coreAvailable: u.body?.core?.available ?? null }; }
    row.gpu = await gpu();
    const tree = await treeOf(process.pid);
    if (tree) {
      const by = (re) => tree.filter((p) => re.test(p.name));
      const sum = (ps, k) => +ps.reduce((a, p) => a + p[k], 0).toFixed(1);
      const hostP = tree.find((p) => p.pid === host.pid);
      row.mem = { procs: tree.length, privMB: sum(tree, 'privMB'), handles: sum(tree, 'handles'), hostPrivMB: hostP ? +hostP.privMB.toFixed(1) : null, hostHandles: hostP?.handles ?? null, nodePrivMB: sum(by(/^node/i), 'privMB'), ffmpegN: by(/^ffmpeg/i).length, cefN: by(/obs-browser-page|cef/i).length };
    }
    row.chat = { sent, noClient, sse: sse.st.events, matched: sse.st.matched };
    appendFileSync(tsFile, `${JSON.stringify(row)}\n`);
    return row;
  }

  async function effectBurst() {
    const out = { at: Math.round((Date.now() - startedAt) / 1000), fired: 0, delivered: 0, refused: {} };
    for (const [name, n, gapMs] of [['storm', 8, 60], ['charge', 6, 100], ['gg', 3, 200]]) {
      for (let i = 0; i < n; i++) {
        const r = await c.call('effect.fire', { name, meta: { source: 'stream-day' } }).catch((e) => ({ ok: false, reason: `error-${e.code ?? 'x'}` }));
        out.fired++;
        if (r.ok) out.delivered++; else out.refused[r.reason ?? 'unknown'] = (out.refused[r.reason ?? 'unknown'] ?? 0) + 1;
        await sleep(gapMs);
      }
    }
    actions.effects.push(out);
    log('effects', JSON.stringify(out));
  }

  async function replaySave() {
    const r = await c.call('replay.save').then((x) => ({ ok: true, files: (x.saved ?? x.files ?? []).length ?? null }), (e) => ({ ok: false, code: e.code ?? e.message }));
    actions.replaySaves.push({ at: Math.round((Date.now() - startedAt) / 1000), ...r });
    log('replay.save', JSON.stringify(r));
  }

  function postingCli(extra) {
    // The environment of a user's shell: no host token, no host discovery override.
    const env = { ...process.env }; for (const k of ['UJWALAM_HOST_TOKEN', 'UJWALAM_HOST_DISCOVERY', 'UJWALAM_HOST_DATA', 'UJWALAM_HOST_MARKERS_TOKEN']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(REPO, 'services', 'posting', 'cli.mjs'), 'auto', '--data-dir', coreDir, ...extra], { encoding: 'utf8', windowsHide: true, env, timeout: 60000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(0, 3).map((l) => l.slice(0, 160)) };
  }
  const rulesFile = path.join(runDir, 'auto-rules.json');
  writeFileSync(rulesFile, JSON.stringify({ autoUpload: false, rules: [{ id: 'mock-run', target: 'youtube-shorts', minScore: 0, maxPerDay: 1 }] }));

  let nextReplay = startedAt + Math.min(replayEveryMs, 120000);
  let nextEffects = startedAt + 60000;
  let autoDone = false;
  let stopEarly = null;
  while (Date.now() < endAt) {
    const row = await sample('tick');
    const failed = row.sinks?.filter((s) => s.state !== 'live').map((s) => `${s.id}:${s.state}`) ?? [];
    if (row.hostError || st.hostExit !== null) { stopEarly = `host ${row.hostError ?? `exited ${st.hostExit}`}`; break; }
    log(`t=${row.t}s fps ${row.host?.fps} lagged ${row.host?.renderLagged} skipped ${row.host?.encodeSkipped} nvenc ${row.gpu?.sessions} hostPriv ${row.mem?.hostPrivMB}MB chat ${row.chat.sent}/${row.chat.sse} markers ${row.markers} effects ${row.overlay?.effects}${failed.length ? ` NOT LIVE ${failed.join(',')}` : ''}`);
    if (Date.now() >= nextEffects) { await effectBurst(); nextEffects += effectsEveryMs; }
    if (Date.now() >= nextReplay) { await replaySave(); nextReplay += replayEveryMs; }
    if (!autoDone && Date.now() - startedAt > 90000) {
      autoDone = true;
      actions.autoPost.push({ phase: 'live', dry: postingCli([]), run: postingCli(['--run', '--rules', rulesFile]) });
      log('auto-post while live', JSON.stringify(actions.autoPost.at(-1)));
    }
    const fc = await c.call('feedback.status').catch(() => null);
    if (fc && actions.feedback.length === 0 && Date.now() - startedAt > 5 * 60000) {
      actions.feedback.push(await c.call('feedback.capture', { note: '' }).then(() => 'ok', (e) => `error ${e.code ?? e.message}`));
    }
    await sleep(Math.max(0, sampleMs - 1500));
  }
  if (stopEarly) result.notes.push(`stopped early: ${stopEarly}`);
  await player.catch(() => {});
  await sleep(5000);
  const last = await sample('end').catch(() => null);
  result.endSample = last;

  // ---- stop outputs
  if (st.hostExit === null) {
    result.streamStop = await c.call('stream.stop').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    if (args['no-record'] !== true) result.recordStop = await c.call('record.stop').then(() => 'ok', (e) => `error ${e.code ?? e.message}`);
    for (let i = 0; i < 60; i++) { const s = await c.call('outputs.status').catch(() => null); if (!s || s.sinks.every((x) => !['starting', 'live', 'retrying', 'stopping'].includes(x.state))) break; await sleep(500); }
    actions.autoPost.push({ phase: 'after-stop', dry: postingCli([]), run: postingCli(['--run', '--rules', rulesFile]) });
    log('auto-post after stop', JSON.stringify(actions.autoPost.at(-1)));
  }
  result.actions = actions;
  result.chatPlayed = { sent, noClient, sse: sse.st.events, matched: sse.st.matched, emitLagMs: { p50: pct(playLag, 0.5), p95: pct(playLag, 0.95), max: playLag.length ? Math.max(...playLag) : null } };
  result.eventCoreLatencyMs = { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat.length ? Math.max(...lat) : null };
  result.coreRttMs = { p50: pct(coreRtt, 0.5), p95: pct(coreRtt, 0.95), max: coreRtt.length ? Math.max(...coreRtt) : null };
  sse.close();

  await st.teardown();

  // ---- after: probes, crash reports, strays, purge, text scan
  result.st.hostExitCode = st.hostExit;
  result.received = {};
  for (const f of filesUnder(recvDir, /\.mkv$/)) {
    try { result.received[path.basename(f)] = summariseProbe(probe(f)); } catch (e) { result.received[path.basename(f)] = { error: String(e.message).slice(0, 80) }; }
  }
  result.recordings = {};
  for (const f of filesUnder(mediaDir, /\.mkv$/).filter((x) => !x.startsWith(recvDir))) {
    const key = path.relative(mediaDir, f).replaceAll('\\', '/');
    const size = statSync(f).size;
    try { result.recordings[key] = { sizeMB: Math.round(size / 1048576), ...(size < 512 * 1048576 ? summariseProbe(probe(f)) : { note: 'large file: format only', durationSec: Number(JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', f], { encoding: 'utf8', windowsHide: true }).stdout).format.duration) }) }; } catch (e) { result.recordings[key] = { sizeMB: Math.round(size / 1048576), error: String(e.message).slice(0, 80) }; }
  }
  result.crashReports = [...filesUnder(runDir, /^crash-.*\.txt$/), ...filesUnder(mediaDir, /^crash-.*\.txt$/)].map((f) => path.basename(f));
  const markerFiles = filesUnder(coreDir, /\.jsonl$/).concat(filesUnder(hostData, /\.jsonl$/)).filter((f) => /marker/i.test(f));
  result.markerFiles = markerFiles.map((f) => {
    const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const by = {}; for (const r of rows) by[r.source ?? 'unknown'] = (by[r.source ?? 'unknown'] ?? 0) + 1;
    return { file: path.relative(runDir, f), count: rows.length, bySource: by };
  });
  await sleep(2000);
  const strays = scanStrays();
  result.strays = { node: Array.isArray(strays) ? strays.length : null };
  const left = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process ujwalam-host,ffmpeg,obs-browser-page -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8', windowsHide: true });
  result.strays.hostFfmpegCef = Number(left.stdout?.trim());
  // Names that are also profile values (the streamer's own channel names, used in overlay URLs of the local alpha
  // project) are not chat data; they are left out of the name scan and counted separately.
  let profileText = '';
  try { profileText = readFileSync(path.join(REPO, 'data', 'profile.local.json'), 'utf8').toLowerCase(); } catch { /* no profile */ }
  const inProfile = (n) => n.length >= 5 && profileText.includes(n.toLowerCase());
  const scanMsgs = exp.messages.map((m) => ({ ...m, name: inProfile(m.name) ? '' : m.name, login: inProfile(m.login) ? '' : m.login }));
  result.textScanProfileNamesExcluded = new Set(exp.messages.flatMap((m) => [m.name, m.login]).filter(inProfile)).size;
  try { result.textScan = purgeProof({ dataDir: coreDir, runDir, messages: scanMsgs }); } catch (e) { result.textScan = { error: String(e.message).slice(0, 80) }; }
  result.gpuAfter = await gpu();
  result.summary = summarise(readFileSync(tsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  result.endedAt = new Date().toISOString();
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  log('result:', path.join(runDir, 'result.json'));
  return 0;

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
