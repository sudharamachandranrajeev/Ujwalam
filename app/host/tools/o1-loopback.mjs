#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// O1/O2 loopback run: compositor -> encoder pool -> delivery pool, against local listeners only.
//
//   node app/host/tools/o1-loopback.mjs [--plan app/host/outputs/o1-loopback.json] [--seconds 60] [--out <dir>]
//                                       [--project <host test format file>]
//   O2: --plan app/host/outputs/o2-loopback.json (YouTube 1440p60 H direct, the Multi rung GPU-scaled to 1080p60).
//
// 1. Starts one ffmpeg listener per network sink, bound to 127.0.0.1 (rtmp -listen 1, srt mode=listener).
// 2. Starts ujwalam-host with the test card project (generated sources only; no devices, no network). When the plan's
//    canvases differ from the card's, a copy with those canvas sizes is written to <out> (layer geometry scaled; the
//    lavfi sources keep their own size, so a larger canvas costs no extra CPU), unless --project is given.
// 3. outputs.configure with the plan (O0 config validated against data/platforms), then outputs.start.
// 4. Mid-run, closes one listener (a platform-side drop), checks every other sink stays live, restarts the listener
//    and checks the host supervisor reconnects with backoff.
// 5. Stops, shuts the host down, and runs ffprobe assertions on every received file and the local recording:
//    codec, resolution, fps, bitrate within tolerance, GOP, exactly one audio stream (AAC 48 kHz stereo), and that
//    sinks on one rung carry byte-identical packets (one encoder, N sinks) while different rungs do not.
// Output: <out>/result.json (+ status samples, host log, ffmpeg logs). Media stays under out/ (gitignored).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { planFile } from '../lib/outputs-plan.mjs';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { probe, packetHashes, overlap, ffprobeVersion } from '../lib/ffprobe.mjs';
import { resolveConfig, REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const planPath = path.resolve(arg('--plan', path.join(HOST_DIR, 'outputs', 'o1-loopback.json')));
const seconds = Number(arg('--seconds', '60'));
const dropSink = arg('--drop', 'kick');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runName = path.basename(planPath, '.json').replace(/-loopback$/, '') || 'o1';
const outDir = path.resolve(arg('--out', path.join(REPO_ROOT, 'out', 'host', runName, stamp)));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${runName} ${new Date().toISOString().slice(11, 23)}]`, ...a);

mkdirSync(outDir, { recursive: true });
const cfg = resolveConfig({ dataDir: path.join(outDir, 'host-data') });
const { params, report, config: planConfig } = planFile(planPath);
writeFileSync(path.join(outDir, 'configure-params.json'), JSON.stringify(params, null, 2));

// ---- listeners (127.0.0.1 only) -------------------------------------------------------------------------
const listeners = new Map(); // sinkId -> { proc, file, n }
function listenerArgs(t, file) {
  if (t.transport === 'rtmp')
    return ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', `rtmp://127.0.0.1:${t.port}/${t.app}/${t.stream}`,
      '-c', 'copy', '-f', 'matroska', '-y', file];
  if (t.transport === 'srt')
    return ['-hide_banner', '-loglevel', 'info', '-i', `srt://127.0.0.1:${t.port}?mode=listener&latency=${(t.latencyMs ?? 120) * 1000}`,
      '-c', 'copy', '-f', 'mpegts', '-y', file];
  throw new Error('not a network target');
}
function startListener(sinkId) {
  const t = params.sinks.find((s) => s.id === sinkId).target;
  const prev = listeners.get(sinkId);
  const n = (prev?.n ?? 0) + 1;
  const file = path.join(outDir, `${sinkId}-${n}.${t.transport === 'srt' ? 'ts' : 'mkv'}`);
  const errLog = path.join(outDir, `${sinkId}-${n}.ffmpeg.log`);
  const proc = spawn(FFMPEG, listenerArgs(t, file), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const chunks = [];
  proc.stderr.on('data', (d) => chunks.push(d));
  const exited = new Promise((r) => proc.on('exit', (code) => { writeFileSync(errLog, Buffer.concat(chunks)); r(code); }));
  const l = { proc, file, n, exited, files: [...(prev?.files ?? []), file] };
  listeners.set(sinkId, l);
  return l;
}
async function stopListener(sinkId, how = 'q') {
  const l = listeners.get(sinkId);
  if (how === 'q') l.proc.stdin.write('q');
  else l.proc.kill();
  const code = await Promise.race([l.exited, sleep(10000).then(() => 'timeout')]);
  if (code === 'timeout') { l.proc.kill(); await l.exited; }
  return code;
}

// ---- run ---------------------------------------------------------------------------------------------------
const result = {
  startedAt: new Date().toISOString(), plan: path.relative(REPO_ROOT, planPath).replaceAll('\\', '/'), seconds, dropSink,
  tools: { ffmpeg: spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', windowsHide: true }).stdout?.split('\n')[0]?.trim(), ffprobe: ffprobeVersion() },
  validatorWarnings: report.warnings.map((w) => `${w.code}: ${w.message}`), events: [], checks: []
};
const ev = (what, extra = {}) => { const e = { t: Date.now(), what, ...extra }; result.events.push(e); log(what, JSON.stringify(extra)); };
const check = (name, pass, detail) => { result.checks.push({ name, pass: !!pass, detail }); log(pass ? 'PASS' : 'FAIL', name, detail ?? ''); };

for (const s of params.sinks) if (s.target.transport !== 'file') startListener(s.id);
await sleep(1500); // listeners bound
ev('listeners started', { sinks: [...listeners.keys()] });

// Test card with the plan's canvas sizes (host test format; generated sources only).
function cardFor(canvases) {
  const card = JSON.parse(readFileSync(path.join(HOST_DIR, 'projects', 'test-card.project.json'), 'utf8'));
  let changed = false;
  for (const cv of card.canvases) {
    const want = canvases?.find((x) => x.id === cv.id);
    if (!want || (want.w === cv.w && want.h === cv.h && (want.fps ?? cv.fps) === cv.fps)) continue;
    const sx = want.w / cv.w, sy = want.h / cv.h;
    for (const sc of card.scenes.filter((x) => x.canvas === cv.id)) {
      for (const l of sc.layers) {
        if (l.transform) for (const [k, f] of [['x', sx], ['y', sy], ['w', sx], ['h', sy]]) if (typeof l.transform[k] === 'number') l.transform[k] = Math.round(l.transform[k] * f);
        if (l.type === 'test_pattern') { l.settings.width ??= cv.w; l.settings.height ??= cv.h; } // lavfi stays at the card's size
      }
    }
    Object.assign(cv, { w: want.w, h: want.h, fps: want.fps ?? cv.fps });
    changed = true;
  }
  if (!changed) return path.join(HOST_DIR, 'projects', 'test-card.project.json');
  card.name += ` (canvases ${card.canvases.map((c) => `${c.id} ${c.w}x${c.h}@${c.fps}`).join(', ')})`;
  const f = path.join(outDir, 'test-card.project.json');
  writeFileSync(f, JSON.stringify(card, null, 2));
  return f;
}
const project = arg('--project') ? path.resolve(arg('--project')) : cardFor(planConfig.canvases);
const host = await launchHost({ cfg, dataDir: cfg.dataDir, project, extraArgs: ['--recordings', path.join(outDir, 'recordings')] });
ev('host ready', { pid: host.child.pid, port: host.discoveryJson.port, discoveryTokenNull: host.discoveryJson.token === null });
const c = host.client;
const samples = [];
const sample = async (tag) => {
  const [st, hs] = await Promise.all([c.call('outputs.status'), c.call('host.status')]);
  const s = { t: Date.now(), tag, host: { fps: hs.fps, cpuPct: hs.cpuPct, gpuPct: hs.gpuPct, renderLagged: hs.render.renderLagged, encodeSkipped: hs.render.encodeSkipped, gpu: hs.gpu }, sinks: st.sinks.map((x) => ({ id: x.id, state: x.state, kbps: x.kbps, totalFrames: x.totalFrames, droppedFrames: x.droppedFrames, retries: x.retries, consecutiveFailures: x.consecutiveFailures, nextRetryInMs: x.nextRetryInMs, lastCode: x.lastCode })) };
  samples.push(s);
  return { st, hs, s };
};

let exitCode = 0;
try {
  const info = await c.call('host.info');
  result.host = { obsVersion: info.obsVersion, adapter: info.adapter, flags: info.flags, gpuPreference: info.gpuPreference, disabledModules: info.disabledModules };
  check('devices off (win-dshow, win-wasapi not loaded)', info.flags.allowDevices === false && info.disabledModules.includes('win-dshow') && info.disabledModules.includes('win-wasapi'));
  const before = (await c.call('host.status')).gpu.encoderSessions ?? null;
  const conf = await c.call('outputs.configure', params);
  result.project = { file: path.relative(REPO_ROOT, project).replaceAll(path.sep, '/'), canvases: (await c.call('project.get')).project?.canvases };
  result.configure = { rungs: conf.rungs.map((r) => ({ id: r.id, canvas: r.canvas, encoderId: r.encoderId, w: r.w, h: r.h, fps: r.fps, bitrate: r.bitrate, scaled: r.scaled, gpuScaled: r.gpuScaled, encodeW: r.encodeW, encodeH: r.encodeH, sinks: r.sinks })), audio: conf.audio, probe: conf.probe, warnings: conf.warnings };
  const canv = new Map((await c.call('host.status')).canvases?.map((x) => [x.id, x]) ?? (result.project.canvases ?? []).map((x) => [x.id, x]));
  for (const r of conf.rungs) {
    const cv = canv.get(r.canvas);
    if (!cv) continue;
    const needScale = cv.w !== r.w || cv.h !== r.h;
    check(`rung ${r.id}: ${needScale ? `GPU-scaled ${cv.w}x${cv.h} -> ${r.w}x${r.h}` : `canvas size ${r.w}x${r.h}, not scaled`} from canvas ${r.canvas}`,
      needScale ? r.scaled && r.gpuScaled && r.encodeW === r.w && r.encodeH === r.h : !r.scaled,
      `scaled ${r.scaled}, gpuScaled ${r.gpuScaled}, encoder size ${r.encodeW}x${r.encodeH}, canvas ${cv.w}x${cv.h}`);
  }
  check('one AAC encoder for all sinks', conf.audio.encoders === 1, `audio encoders: ${conf.audio.encoders}, sinks: ${conf.sinks.length}`);
  check('NVENC sessions probed at runtime before configure', conf.probe?.started >= conf.rungs.length, `probe started ${conf.probe?.started} of ${conf.probe?.requested}, nvml before ${conf.probe?.nvmlSessionsBefore}`);
  check('every URL is 127.0.0.1', conf.sinks.filter((s) => s.kind === 'stream').every((s) => /^(rtmp|srt):\/\/127\.0\.0\.1:/.test(s.url)), conf.sinks.map((s) => s.url ?? s.kind).join(' '));

  ev('start all');
  await c.call('outputs.start', {});
  const t0 = Date.now();
  let allLive = false;
  while (Date.now() - t0 < 20000) {
    const { st } = await sample('starting');
    if (st.sinks.every((s) => s.state === 'live')) { allLive = true; break; }
    await sleep(500);
  }
  check('all sinks live', allLive, `${Date.now() - t0} ms`);
  const third = Math.max(10, Math.floor(seconds / 3)) * 1000;
  for (const end = Date.now() + third; Date.now() < end;) { await sample('steady-1'); await sleep(2000); }
  // NVML counts every NVENC session on the GPU (other apps too) and lags start/stop by a sample or two: compare the
  // steady-state median, not the first sample after start (O2 saw a transient 7 for 3 rungs + 2 external sessions).
  const steady = samples.filter((x) => x.tag === 'steady-1').map((x) => x.host.gpu?.encoderSessions).filter((v) => v != null).sort((a, b) => a - b);
  const during = steady.length ? steady[Math.floor(steady.length / 2)] : null;
  result.nvenc = { sessionsBefore: before, sessionsSteadyMedian: during, sessionsSteadyMax: steady.at(-1) ?? null, rungs: params.rungs.length, sinks: params.sinks.length };
  check('NVENC sessions = rungs, not sinks', before !== null && during - before === params.rungs.length, `nvml ${before} before -> steady median ${during} (max ${steady.at(-1)}); rungs ${params.rungs.length}, sinks ${params.sinks.length}`);

  // ---- drop one sink at the "platform" side
  ev('drop listener', { sink: dropSink });
  await stopListener(dropSink, 'q');
  let sawRetry = false;
  const othersLive = [];
  for (const end = Date.now() + 8000; Date.now() < end;) {
    const { st } = await sample('dropped');
    const d = st.sinks.find((s) => s.id === dropSink);
    if (d.state === 'retrying') sawRetry = true;
    othersLive.push(st.sinks.filter((s) => s.id !== dropSink).every((s) => s.state === 'live'));
    await sleep(500);
  }
  const dropped = samples.filter((s) => s.tag === 'dropped').map((s) => s.sinks.find((x) => x.id === dropSink));
  check(`${dropSink}: supervisor retries after the drop`, sawRetry, `states: ${[...new Set(dropped.map((d) => d.state))].join(',')}; consecutiveFailures max ${Math.max(...dropped.map((d) => d.consecutiveFailures))}`);
  check('other sinks stay live during the drop', othersLive.every(Boolean), `${othersLive.filter(Boolean).length}/${othersLive.length} samples`);
  ev('restart listener', { sink: dropSink });
  startListener(dropSink);
  let back = false;
  const tr = Date.now();
  for (const end = Date.now() + 30000; Date.now() < end;) {
    const { st } = await sample('reconnect');
    if (st.sinks.find((s) => s.id === dropSink).state === 'live') { back = true; break; }
    await sleep(500);
  }
  check(`${dropSink}: reconnects after the listener returns`, back, `${Date.now() - tr} ms after restart`);

  for (const end = Date.now() + third; Date.now() < end;) { await sample('steady-2'); await sleep(2000); }

  ev('stop all');
  await c.call('outputs.stop', {});
  for (const end = Date.now() + 15000; Date.now() < end;) {
    const { st } = await sample('stopping');
    if (st.sinks.every((s) => s.state === 'stopped')) break;
    await sleep(500);
  }
  const fin = await c.call('outputs.status');
  result.finalSinks = fin.sinks.map((s) => ({ id: s.id, state: s.state, attempts: s.attempts, retries: s.retries, totalFrames: s.totalFrames, droppedFrames: s.droppedFrames, bytes: s.bytes, lastCode: s.lastCode, path: s.path ?? undefined }));
  check('all sinks stopped cleanly', fin.sinks.every((s) => s.state === 'stopped'));
} catch (e) {
  exitCode = 1;
  result.error = String(e.stack || e);
  log('ERROR', e.message);
}

const stop = await stopHost(host);
result.hostExit = stop;
check('host shut down cleanly (exit 0)', stop.code === 0, JSON.stringify(stop));
check('discovery file removed on shutdown', !existsSync(host.discovery));
for (const id of listeners.keys()) await stopListener(id, 'q').catch(() => {});
writeFileSync(path.join(outDir, 'status-samples.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
const hostLogDir = path.join(cfg.dataDir, 'logs');
const hostLog = existsSync(hostLogDir) ? readdirSync(hostLogDir).filter((f) => f.endsWith('.log')).sort().pop() : null;
let hostLogText = '';
if (hostLog) {
  copyFileSync(path.join(hostLogDir, hostLog), path.join(outDir, 'host.log'));
  hostLogText = readFileSync(path.join(hostLogDir, hostLog), 'utf8');
}
const aacInits = (hostLogText.match(/\[FFmpeg aac encoder: 'ujw:enc:audio'\]/g) ?? []).length;
const aacOther = (hostLogText.match(/\[FFmpeg aac encoder: '(?!ujw:enc:audio|ujw:probe)[^']*'\]/g) ?? []).length;
result.audioEncoderLog = { initLines: aacInits, otherAacEncoders: aacOther };
check('audio encoded once (host log: one AAC encoder, no per-sink AAC)', aacInits >= 1 && aacOther === 0, `ujw:enc:audio lines ${aacInits}, other ${aacOther}`);
// libobs's own counters at stop. Packet counts in the files cannot show these: a frame skipped for encoding lag is
// sent again in the next slot, so the files still measure 60 fps while motion is lost.
const MAX_LAG_PCT = 1.0;
const encLag = [...hostLogText.matchAll(/Video stopped, number of skipped frames due to encoding lag: (\d+)\/(\d+) \(([\d.]+)%\)/g)].map((m) => ({ skipped: +m[1], total: +m[2], pct: +m[3] }));
const renderLag = [...hostLogText.matchAll(/Output 'ujw:out:([^']+)': Number of lagged frames due to rendering lag\/stalls: (\d+) \(([\d.]+)%\)/g)].map((m) => ({ sink: m[1], frames: +m[2], pct: +m[3] }));
// libobs prints these two lines only when the count is non-zero (obs 32.1.2 media-io/video-io.c `if (skipped)`,
// obs-output.c `if (drawn && lagged)`), so a missing line means 0. To tell "0" from "never stopped", every sink must
// have logged its stop counters ("Total frames output"), which libobs prints unconditionally.
const stopped = new Set([...hostLogText.matchAll(/Output 'ujw:out:([^']+)': Total frames output: \d+/g)].map((m) => m[1]));
const notStopped = params.sinks.map((s) => s.id).filter((id) => !stopped.has(id));
result.lag = { maxPct: MAX_LAG_PCT, encode: encLag, render: renderLag, stopCounters: [...stopped] };
check(`encoding keeps up: skipped frames due to encoding lag <= ${MAX_LAG_PCT}% on every video mix`, notStopped.length === 0 && encLag.every((x) => x.pct <= MAX_LAG_PCT), notStopped.length ? `no stop counters for ${notStopped.join(', ')}` : encLag.map((x) => `${x.skipped}/${x.total} (${x.pct}%)`).join(', ') || '0 (libobs logs no line when nothing was skipped)');
check(`rendering keeps up: lagged frames <= ${MAX_LAG_PCT}% on every output`, notStopped.length === 0 && renderLag.every((x) => x.pct <= MAX_LAG_PCT), notStopped.length ? `no stop counters for ${notStopped.join(', ')}` : renderLag.map((x) => `${x.sink} ${x.frames} (${x.pct}%)`).join(', ') || '0 on every output (libobs logs no line when nothing lagged)');

// ---- ffprobe assertions -------------------------------------------------------------------------------------
const rungById = new Map(params.rungs.map((r) => [r.id, r]));
const files = [];
for (const s of params.sinks) {
  if (s.target.transport === 'file') {
    const p = result.finalSinks?.find((x) => x.id === s.id)?.path;
    if (p) files.push({ sink: s.id, file: p, segment: 1 });
  } else {
    (listeners.get(s.id)?.files ?? []).forEach((f, i) => files.push({ sink: s.id, file: f, segment: i + 1 }));
  }
}
result.files = [];
const TOL = { kbpsLow: 0.80, kbpsHigh: 1.10, fps: 0.5 };
result.tolerance = TOL;
for (const f of files) {
  if (!existsSync(f.file) || statSync(f.file).size === 0) { check(`${f.sink}#${f.segment}: file exists`, false, f.file); continue; }
  const r = rungById.get(params.sinks.find((s) => s.id === f.sink).rung);
  let p;
  try { p = probe(f.file); } catch (e) { check(`${f.sink}#${f.segment}: ffprobe`, false, e.message); continue; }
  const v = p.streams.filter((s) => s.type === 'video');
  const a = p.streams.filter((s) => s.type === 'audio');
  const rec = { sink: f.sink, segment: f.segment, file: path.relative(REPO_ROOT, f.file).replaceAll('\\', '/'), format: p.format, durationSec: p.durationSec, video: v, audio: a };
  result.files.push(rec);
  const tag = `${f.sink}#${f.segment}`;
  check(`${tag}: exactly one video stream, ${r.codec}`, v.length === 1 && v[0].codec === r.codec, `${v.length} video, codec ${v[0]?.codec}`);
  if (v.length !== 1) continue;
  const vv = v[0];
  check(`${tag}: resolution ${r.w}x${r.h}`, vv.width === r.w && vv.height === r.h, `${vv.width}x${vv.height}`);
  check(`${tag}: fps ${r.fps}`, Math.abs(vv.measuredFps - r.fps) <= TOL.fps || (f.segment > 1 && vv.spanSec < 5), `measured ${vv.measuredFps.toFixed(2)} over ${vv.spanSec.toFixed(1)} s (avg_frame_rate ${vv.avgFps.toFixed(2)})`);
  const ratio = vv.measuredKbps / r.bitrate;
  check(`${tag}: video bitrate ${r.bitrate} kbps within -${Math.round((1 - TOL.kbpsLow) * 100)}%/+${Math.round((TOL.kbpsHigh - 1) * 100)}%`, ratio >= TOL.kbpsLow && ratio <= TOL.kbpsHigh, `measured ${vv.measuredKbps.toFixed(0)} kbps (${(ratio * 100).toFixed(1)}%)`);
  check(`${tag}: GOP ${r.gopSec} s`, vv.gopSecMedian !== undefined && Math.abs(vv.gopSecMedian - r.gopSec) < 0.05, `median keyframe gap ${vv.gopSecMedian?.toFixed(3)} s, ${vv.keyframes} keyframes`);
  check(`${tag}: exactly one audio stream, AAC 48 kHz stereo`, a.length === 1 && a[0].codec === 'aac' && a[0].sampleRate === 48000 && a[0].channels === 2, `${a.length} audio, ${a[0]?.codec} ${a[0]?.sampleRate} ch${a[0]?.channels}, ${a[0]?.measuredKbps?.toFixed(0)} kbps`);
}

// one encoder, N sinks: sinks on the same rung carry identical packets; different rungs do not
const first = (id) => files.find((f) => f.sink === id && f.segment === 1)?.file;
for (const r of params.rungs) {
  const ss = params.sinks.filter((s) => s.rung === r.id).map((s) => s.id);
  if (ss.length < 2) continue;
  const [x, y] = [first(ss[0]), first(ss[1])];
  if (!x || !y) continue;
  const o = overlap(packetHashes(x, 'v'), packetHashes(y, 'v'));
  const oa = overlap(packetHashes(x, 'a'), packetHashes(y, 'a'));
  result[`shared_${r.id}`] = { sinks: ss, video: o, audio: oa };
  check(`rung ${r.id}: ${ss.join(' + ')} carry identical video packets (one encoder)`, o.ratio > 0.9, `${o.common} common of ${Math.min(o.ofA, o.ofB)}`);
  check(`rung ${r.id}: ${ss.join(' + ')} carry identical audio packets (audio encoded once)`, oa.ratio > 0.9, `${oa.common} common of ${Math.min(oa.ofA, oa.ofB)}`);
}
const rx = first('youtube-h'), ry = first('twitch');
if (rx && ry) {
  const o = overlap(packetHashes(rx, 'v'), packetHashes(ry, 'v'));
  const oa = overlap(packetHashes(rx, 'a'), packetHashes(ry, 'a'));
  result.crossRung = { pair: ['youtube-h', 'twitch'], video: o, audio: oa };
  check('different rungs (yt-h vs reencode-tk) carry different video', o.ratio < 0.05, `${o.common} common`);
  check('different rungs share the one audio encoder (identical audio packets)', oa.ratio > 0.9, `${oa.common} common of ${Math.min(oa.ofA, oa.ofB)}`);
}

result.finishedAt = new Date().toISOString();
result.pass = result.checks.every((c) => c.pass) && exitCode === 0;
writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
log(`${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks passed -> ${path.join(outDir, 'result.json')}`);
process.exit(result.pass ? 0 : 1);
