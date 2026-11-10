// SPDX-License-Identifier: GPL-3.0-or-later
// Fake ujwalam-host for the launcher tests (services/studio-ui/launch.mjs --host-exe <this file>). No libobs, no
// devices, no GPU. It records its argv, the NAMES of its UJWALAM_* environment variables and whether an event-core
// token came in (never the value), and the RPC calls it got, into the file named by UJWALAM_FAKE_HOST_RECORD.
// devices.list answers from UJWALAM_FAKE_HOST_DEVICES (a devices.list fixture), only with --allow-devices.
// --host-config is read and recorded (it holds no secret); outputs.status answers from the --outputs params file with
// keyPresent/urlPresent false (the fake reads no keychain); feedback.capture writes a host-shaped moment.json into the
// host config's feedbackDir. The event-core system token is checked for shape only and never recorded.
// Crash simulation (launcher crash-recovery tests): UJWALAM_FAKE_HOST_RUNS names a counter file (one start = one
// run); UJWALAM_FAKE_HOST_CRASH_RUNS="1,2" makes those runs exit with code 3, UJWALAM_FAKE_HOST_CRASH_MS (default
// 1500) after the discovery file is written. UJWALAM_FAKE_HOST_RECORDING=1 adds a record sink "record" that is live in
// run 1 (idle in later runs until record.start). Each run's start and crash, and record.start / marker.add with their
// params, are appended to <UJWALAM_FAKE_HOST_RECORD>.calls.jsonl.
// Stream recovery (D303): UJWALAM_FAKE_HOST_STREAMS="youtube-h:youtube,twitch:twitch" adds stream sinks (idle at
// start); stream.start / stream.stop ({ sinks } or all) switch them live / stopped and are logged with their params;
// host.status reports live while one is live. UJWALAM_FAKE_HOST_STREAM_FAIL="kick" makes those sinks go 'failed' on
// stream.start. UJWALAM_FAKE_HOST_CRASH_ON=<file>: a crash run exits (code 3) once that file exists (the file is
// removed), instead of after UJWALAM_FAKE_HOST_CRASH_MS.
// Live-test guard simulation: UJWALAM_FAKE_HOST_STREAM_AFTER_MS=N makes every planned sink (streams and recordings) go
// live N ms after start (as if the user clicked Start stream), with 60 fps frame counters, 6000 kbps and
// UJWALAM_FAKE_HOST_DROP_PCT % network-dropped and UJWALAM_FAKE_HOST_SKIP_PCT % encoder-skipped frames (default 0;
// the skipped and render-lagged counters start above 0, as host-wide counters do); outputs.stop (logged with its params) stops them.
// --twitch-bandwidth-test is reflected as bandwidthTest on twitch stream sinks, like the real host.
// UJWALAM_HOST_MARKERS_TOKEN (the event core's least-privilege token) is accepted for marker.add and mixer.list only,
// like the real host's markers role; any other method with it answers -32001 forbidden. Recorded: shape ok, whether it
// equals the api token or appears in argv (never the value).
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const token = process.env.UJWALAM_HOST_TOKEN ?? '';
const markersToken = process.env.UJWALAM_HOST_MARKERS_TOKEN ?? '';
const clipsToken = process.env.UJWALAM_HOST_CLIPS_TOKEN ?? '';
const MARKERS_METHODS = new Set(['marker.add', 'mixer.list']);
const eventToken = process.env.UJWALAM_EVENT_CORE_API_TOKEN ?? '';
const systemToken = process.env.UJWALAM_EVENT_CORE_SYSTEM_TOKEN ?? '';
const readJson = (f) => (f ? JSON.parse(readFileSync(f, 'utf8')) : null);
const hostConfig = readJson(arg('--host-config'));
const outputs = readJson(arg('--outputs'));
const record = {
  argv,
  envNames: Object.keys(process.env).filter((k) => k.startsWith('UJWALAM_')).sort(),
  eventTokenOk: /^[0-9a-f]{64}$/.test(eventToken),
  eventTokenInArgv: eventToken !== '' && argv.some((a) => a.includes(eventToken)),
  hostTokenInArgv: token !== '' && argv.some((a) => a.includes(token)),
  markersTokenOk: /^[0-9a-f]{64}$/.test(markersToken),
  markersTokenInArgv: markersToken !== '' && argv.some((a) => a.includes(markersToken)),
  markersTokenIsApiToken: markersToken !== '' && markersToken === token,
  clipsTokenOk: /^[0-9a-f]{64}$/.test(clipsToken),
  clipsTokenInArgv: clipsToken !== '' && argv.some((a) => a.includes(clipsToken)),
  clipsTokenIsOtherToken: clipsToken !== '' && (clipsToken === token || clipsToken === markersToken),
  systemTokenOk: /^[0-9a-f]{64}$/.test(systemToken),
  systemTokenInArgv: systemToken !== '' && argv.some((a) => a.includes(systemToken)),
  systemTokenIsApiToken: systemToken !== '' && systemToken === eventToken,
  hostConfig,
  outputsParams: outputs,
  calls: [],
};
delete process.env.UJWALAM_HOST_TOKEN;
delete process.env.UJWALAM_HOST_MARKERS_TOKEN;
delete process.env.UJWALAM_HOST_CLIPS_TOKEN;
delete process.env.UJWALAM_EVENT_CORE_API_TOKEN;
delete process.env.UJWALAM_EVENT_CORE_SYSTEM_TOKEN;
let captures = 0;
let run = 1;
if (process.env.UJWALAM_FAKE_HOST_RUNS) {
  try { run = Number(readFileSync(process.env.UJWALAM_FAKE_HOST_RUNS, 'utf8')) + 1; } catch { run = 1; }
  writeFileSync(process.env.UJWALAM_FAKE_HOST_RUNS, String(run));
}
record.run = run;
const crashRuns = (process.env.UJWALAM_FAKE_HOST_CRASH_RUNS ?? '').split(',').filter(Boolean).map(Number);
const withRecordSink = process.env.UJWALAM_FAKE_HOST_RECORDING === '1';
let recordState = withRecordSink && run === 1 ? 'live' : 'idle';
const fakeStreams = (process.env.UJWALAM_FAKE_HOST_STREAMS ?? '').split(',').filter(Boolean).map((x) => { const [id, platform] = x.split(':'); return { id, platform }; });
const streamFail = new Set((process.env.UJWALAM_FAKE_HOST_STREAM_FAIL ?? '').split(',').filter(Boolean));
// UJWALAM_FAKE_HOST_START_DELAY_MS=N: stream.start applies and answers after N ms (logged as stream.start.done).
const startDelayMs = Number(process.env.UJWALAM_FAKE_HOST_START_DELAY_MS ?? 0);
// UJWALAM_FAKE_HOST_STOP_FAIL_FROM=k [UJWALAM_FAKE_HOST_STOP_FAIL_COUNT=n]: stream.stop calls k .. k+n-1 (1-based, per
// run) fail (logged with failed: true). Default n: every call from k on.
const stopFailFrom = Number(process.env.UJWALAM_FAKE_HOST_STOP_FAIL_FROM ?? Infinity);
const stopFailCount = Number(process.env.UJWALAM_FAKE_HOST_STOP_FAIL_COUNT ?? Infinity);
let stopCalls = 0;
const streamState = new Map(fakeStreams.map((x) => [x.id, 'idle']));
const callLog = (o) => appendFileSync(`${process.env.UJWALAM_FAKE_HOST_RECORD}.calls.jsonl`, `${JSON.stringify({ run, ...o })}\n`);
callLog({ event: 'start' });
const save = () => writeFileSync(process.env.UJWALAM_FAKE_HOST_RECORD, JSON.stringify(record, null, 2));
save();

const streamAfter = process.env.UJWALAM_FAKE_HOST_STREAM_AFTER_MS === undefined ? null : Number(process.env.UJWALAM_FAKE_HOST_STREAM_AFTER_MS);
const dropPct = Number(process.env.UJWALAM_FAKE_HOST_DROP_PCT ?? 0);
const skipPct = Number(process.env.UJWALAM_FAKE_HOST_SKIP_PCT ?? 0);
const t0 = Date.now();
const stoppedAt = new Map(); // sink id -> ms since t0
const sim = (s, base) => {
  if (streamAfter === null) return base;
  const now = Date.now() - t0;
  const end = stoppedAt.get(s.id) ?? now;
  const liveMs = Math.max(0, end - streamAfter);
  if (now < streamAfter) return base;
  const frames = Math.floor(liveMs * 0.06);
  return { ...base, state: stoppedAt.has(s.id) ? 'stopped' : 'live', totalFrames: frames, droppedFrames: base.kind === 'stream' ? Math.floor((frames * dropPct) / 100) : 0, bytes: Math.floor(liveMs * 750), retries: 0, lastCode: 0,
    encoderSkippedFrames: 100 + Math.floor((frames * skipPct) / 100), renderLaggedFrames: 7 };
};

const methods = {
  'host.shutdown': () => { setTimeout(() => { save(); process.exit(0); }, 50); return { shuttingDown: true }; },
  'overlay.status': () => ({ state: 'ready', staticPort: 50101, feedPort: 50102, eventFeed: argv.includes('--overlay-events-url'), childHasEventToken: record.eventTokenOk, browserAllowed: argv.includes('--allow-browser') }),
  'overlay.stats': () => ({ clients: 3, chatFrames: 7, busFrames: 2, effects: 0, effectsBlocked: 0, chatEffects: 0, chatGated: 0, slowDropped: 0, refused: 0 }),
  'devices.list': () => {
    if (!argv.includes('--allow-devices')) { const e = new Error('devices are disabled'); e.code = -32001; throw e; }
    return JSON.parse(readFileSync(process.env.UJWALAM_FAKE_HOST_DEVICES, 'utf8'));
  },
  'project.load': (p) => {
    const layers = p.project.scenes.flatMap((s) => s.layers);
    record.load = {
      scenes: p.project.scenes.length,
      layers: layers.length,
      browserLayers: layers.filter((l) => l.type === 'browser').length,
      captureLayers: layers.filter((l) => l.type === 'capture').length,
      browserUrls: Object.keys(p.browserUrls ?? {}).length,
      urlsOk: Object.values(p.browserUrls ?? {}).every((u) => u.startsWith('http://127.0.0.1:50101/overlays/')),
      relayScope: p.relayScope ?? null,
      bases: Object.keys(p.bases ?? {}).sort(),
      skipUnavailable: p.skipUnavailable === true,
    };
    return { built: { scenes: p.project.scenes.length, layers: layers.length }, unavailable: [], warnings: [] };
  },
  'preview.list': () => ({ previews: (arg('--preview') ?? '').split(',').filter(Boolean).map((c) => ({ canvas: c.toUpperCase(), open: true })) }),
  'log.tail': () => ({ lines: [], total: 0, capacity: 1000 }),
  'stream.start': (p) => {
    callLog({ method: 'stream.start', params: p });
    const ids = Array.isArray(p.sinks) && p.sinks.length ? p.sinks : fakeStreams.map((x) => x.id);
    const apply = () => { for (const id of ids) if (streamState.has(id)) streamState.set(id, streamFail.has(id) ? 'failed' : 'live'); return { started: ids }; };
    if (!(startDelayMs > 0)) return apply();
    // A slow start (race tests): the sinks go live and the answer comes only after the delay.
    return new Promise((r) => setTimeout(() => { const out = apply(); callLog({ method: 'stream.start.done', params: p }); r(out); }, startDelayMs));
  },
  'stream.stop': (p) => {
    stopCalls += 1;
    if (stopCalls >= stopFailFrom && stopCalls < stopFailFrom + stopFailCount) {
      callLog({ method: 'stream.stop', params: p, failed: true });
      throw Object.assign(new Error('fake stream.stop failure'), { code: -32603 });
    }
    callLog({ method: 'stream.stop', params: p });
    const ids = Array.isArray(p.sinks) && p.sinks.length ? p.sinks : fakeStreams.map((x) => x.id);
    for (const id of ids) if (streamState.has(id)) streamState.set(id, 'stopped');
    return { stopped: ids };
  },
  'record.start': (p) => { callLog({ method: 'record.start', params: p }); recordState = 'live'; return { started: p.sinks ?? [] }; },
  'marker.add': (p) => { callLog({ method: 'marker.add', params: p }); return { marker: { v: 1, source: p.source, note: p.note }, file: 'fake.jsonl' }; },
  'outputs.stop': (p) => {
    callLog({ method: 'outputs.stop', params: p });
    const ids = Array.isArray(p.sinks) && p.sinks.length ? p.sinks : (outputs?.sinks ?? []).map((s) => s.id);
    for (const id of ids) if (!stoppedAt.has(id)) stoppedAt.set(id, Date.now() - t0);
    return { stopped: ids };
  },
  'host.info': () => ({ name: 'ujwalam-host', version: 'fake', obsVersion: '0.0.0', adapter: 'fake adapter', encoders: ['fake_enc'], run }),
  'host.status': () => ({ run, uptimeMs: 1, ...(fakeStreams.length ? { live: [...streamState.values()].includes('live'), outputsReady: { stream: true, record: withRecordSink } } : {}) }),
  'outputs.status': () => ({
    allowLive: argv.includes('--allow-live'),
    twitchBandwidthTest: argv.includes('--twitch-bandwidth-test'),
    sinks: [...(withRecordSink ? [{ id: 'record', kind: 'record', platform: 'local', container: 'mkv', path: 'C:/fake/rec.mkv', state: recordState }] : []),
      ...fakeStreams.map((x) => ({ id: x.id, kind: 'stream', platform: x.platform, target: 'loopback', state: streamState.get(x.id) })), ...(outputs?.sinks ?? []).map((s) => {
      const t = s.target ?? {};
      if (s.proto === 'file') return sim(s, { id: s.id, kind: 'record', platform: s.platform, container: 'mkv', state: 'idle' });
      const o = { id: s.id, kind: 'stream', platform: s.platform, target: t.keyRef || t.urlRef ? 'live' : 'loopback', keyRef: t.keyRef ?? null, keyPresent: t.keyRef ? false : null, state: 'idle' };
      if (t.urlRef) Object.assign(o, { urlRef: t.urlRef, urlPresent: false });
      o.bandwidthTest = argv.includes('--twitch-bandwidth-test') && s.platform === 'twitch' && Boolean(t.keyRef);
      return sim(s, o);
    })],
  }),
  'hotkeys.status': () => ({
    enabled: hostConfig?.hotkeys?.enabled === true,
    bindings: [['panic', 'Ctrl+Alt+P'], ['feedback', 'Ctrl+Alt+F'], ['marker', 'Ctrl+Alt+M']].map(([name, combo]) => ({ name, combo, registered: hostConfig?.hotkeys?.enabled === true, error: null, presses: 0 })),
  }),
  'replay.status': () => {
    const on = hostConfig?.replay?.autoStart === true;
    return { wanted: on, seconds: hostConfig?.replay?.seconds ?? 30, canvases: ['H', 'V'].map((canvas) => ({ canvas, state: on ? 'running' : 'stopped', fallback: true })) };
  },
  'feedback.capture': (p) => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const tod = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
    captures++;
    const dir = path.join(hostConfig.feedbackDir, day, captures === 1 ? tod : `${tod}-${captures}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'log.txt'), 'fake host log\n');
    writeFileSync(path.join(dir, 'moment.json'), JSON.stringify({
      v: 1, kind: 'feedback', at: d.toISOString(), local: `${day} ${tod}`, trigger: 'api', note: p.note,
      scenes: { H: 'scene-default', V: 'scene-default' }, stats: { fps: 60, droppedFrames: 0, live: false },
      replay: { state: 'done', saved: [{ canvas: 'H', file: 'replay-H.mkv' }, { canvas: 'V', file: 'replay-V.mkv' }], errors: [], seconds: 30 },
    }));
    return { dir: dir.replaceAll('\\', '/'), replay: 'pending' };
  },
  'feedback.status': () => ({ feedbackDir: hostConfig?.feedbackDir ?? null, captures, queued: 0, busy: 0 }),
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const asMarkers = markersToken !== '' && req.headers.authorization === `Bearer ${markersToken}`;
    if (!asMarkers && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    let m;
    try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
    if (asMarkers && !MARKERS_METHODS.has(m.method)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'forbidden' } })); return; }
    record.calls.push(m.method);
    save();
    const fn = methods[m.method];
    Promise.resolve().then(() => (fn ? fn(m.params ?? {}) : {})).then(
      (result) => send({ jsonrpc: '2.0', id: m.id, result }),
      (e) => send({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32603, message: e.message } }));
  });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`fake host: rpc on 127.0.0.1:${port}`);
  writeFileSync(arg('--discovery'), JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), token: null, path: '/rpc', apiVersion: 1 }) + '\n');
  if (process.env.UJWALAM_FAKE_HOST_EXIT0_MS) setTimeout(() => { callLog({ event: 'exit0' }); save(); process.exit(0); }, Number(process.env.UJWALAM_FAKE_HOST_EXIT0_MS));
  const crashOn = process.env.UJWALAM_FAKE_HOST_CRASH_ON;
  if (crashRuns.includes(run) && crashOn) {
    setInterval(() => { if (existsSync(crashOn)) { try { rmSync(crashOn); } catch { /* next tick */ return; } callLog({ event: 'crash' }); save(); process.exit(3); } }, 100);
  } else if (crashRuns.includes(run)) setTimeout(() => { callLog({ event: 'crash' }); save(); process.exit(3); }, Number(process.env.UJWALAM_FAKE_HOST_CRASH_MS ?? 1500));
});
