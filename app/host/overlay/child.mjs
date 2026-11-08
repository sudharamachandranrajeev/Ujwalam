// SPDX-License-Identifier: GPL-3.0-or-later
// Overlay server as a child of ujwalam-host (the host supervises it: start, restart with backoff, stop).
// It runs Agent A's services/overlay-server unchanged and adds a parent-only control channel on stdin/stdout:
//   stdout: one JSON object per line, nothing else
//     {"type":"ready","staticPort":n,"feedPort":n,"envKeys":[names],"eventToken":bool,"micSource":"<audio id>"|null}
//       micSource: rules.campop.voice.audioSource.id from data/effects/guards.json while the voice trigger is
//       enabled, else null; the host feeds that project audio source's meter with op "mic"
//     {"type":"reply","id":n,"ok":true,"result":{...}} | {"type":"reply","id":n,"ok":false,"error":"..."}
//   stdin: one JSON object per line from the host
//     {"id":n,"op":"effect","name":"gg","meta":{...}}   -> bridge.publishEffect(name, meta)
//     {"id":n,"op":"stats"}                              -> bridge.stats() plus campop: the cam-pop rule counters
//     {"op":"mic","level":0..1}                          -> rule.onMicLevel(level); fire-and-forget: no id, no reply,
//                                                           nothing on stdout. A level that is not a finite number in
//                                                           0..1 is ignored (one stderr warning per 10 s at most).
//                                                           The host sends it about every 50 ms (the legacy poll rate).
//   stdin closed (host gone or stopping) -> the servers stop and the process exits 0.
// No new port: only the parent can fire effects. Logs go to stderr (the host copies them, truncated, to its log).
//   node app/host/overlay/child.mjs --root <legacy dir> [--port 0] [--feed-port 0] [--events-url http://127.0.0.1:<p>/events]
// The event-core token, if any, comes only from UJWALAM_EVENT_CORE_API_TOKEN (the host passes it only with
// --events-url) and goes only into the one SSE request header (services/overlay-server/event-source.mjs).
import path from 'node:path';
import { createInterface } from 'node:readline';
import { resolveDataDir } from '../../../services/event-core/config.mjs';
import { createFlags } from '../../../services/flags/index.mjs';
import { createOverlayServer, createRemoteBus } from '../../../services/overlay-server/index.mjs';

const STREAMERBOT_PORT = 8093; // the real Streamer.bot keeps this port; the feed must never take it
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const warn = (m) => process.stderr.write(`overlay-child: ${String(m).slice(0, 300)}\n`);

const root = arg('--root');
if (!root) { warn('--root is required'); process.exit(64); }
const port = Number(arg('--port', '0'));
const feedPort = Number(arg('--feed-port', '0'));
for (const [k, v] of [['--port', port], ['--feed-port', feedPort]]) {
  if (!Number.isInteger(v) || v < 0 || v > 65535 || v === STREAMERBOT_PORT) { warn(`bad ${k}`); process.exit(64); }
}
const eventsUrl = arg('--events-url', '');
if (eventsUrl && !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/[^\s]*$/.test(eventsUrl)) { warn('--events-url must be http://127.0.0.1'); process.exit(64); }
const token = process.env.UJWALAM_EVENT_CORE_API_TOKEN ?? '';
delete process.env.UJWALAM_EVENT_CORE_API_TOKEN;
if (eventsUrl && !/^[0-9a-f]{64}$/.test(token)) { warn('--events-url needs UJWALAM_EVENT_CORE_API_TOKEN'); process.exit(64); }

const bus = eventsUrl ? createRemoteBus({ url: eventsUrl, token, kinds: ['chat.', 'alert.', 'system.counter'], log: warn }) : undefined;
// Effects pass Agent A's guards (data/effects/guards.json: budget, cooldowns, regions, flash limit; D76-D83).
// Overlay feature flags (D196): read from the data dir the profile names, the same one the studio writes. No data dir
// (no profile, or a studio run with an explicit --data-dir): every overlay flag reads as off.
let flags;
try { flags = createFlags({ dataDir: resolveDataDir() }); } catch (e) { warn(`overlay flags off (${e.message})`); }
const server = createOverlayServer({ root: path.resolve(root), bus, staticPort: port, feedPort, guards: true, log: warn, flags });
const ports = await server.start();
if (ports.feedPort === STREAMERBOT_PORT || ports.staticPort === STREAMERBOT_PORT) { warn('bound to 8093; stopping'); await server.stop(); process.exit(70); }
// envKeys: the NAMES of the variables this process got (never values), so the host can show that no token came in.
const voice = server.guards?.config?.rules?.campop?.voice;
const micSource = server.rule && voice?.enabled === true && typeof voice.audioSource?.id === 'string' ? voice.audioSource.id : null;
out({ type: 'ready', staticPort: ports.staticPort, feedPort: ports.feedPort, envKeys: Object.keys(process.env).sort().slice(0, 64), eventToken: Boolean(token), micSource });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MIC_WARN_MS = 10_000;
let micWarnAt = -Infinity;
function onMic(m) {
  const level = m.level;
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) {
    const t = Date.now();
    if (t - micWarnAt >= MIC_WARN_MS) { micWarnAt = t; warn('mic: ignored a level that is not a number in 0..1'); }
    return;
  }
  try { server.rule?.onMicLevel(level); } catch (e) { warn(`mic: ${e?.message ?? e}`); }
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!isPlain(m)) return;
  if (m.op === 'mic') { onMic(m); return; } // fire-and-forget: never a reply
  if (!Number.isInteger(m.id)) return;
  try {
    if (m.op === 'effect') {
      const meta = isPlain(m.meta) ? m.meta : {};
      out({ type: 'reply', id: m.id, ok: true, result: server.bridge.publishEffect(m.name, meta) });
    } else if (m.op === 'stats') {
      out({ type: 'reply', id: m.id, ok: true, result: { ...server.bridge.stats(), campop: server.rule ? server.rule.stats() : null } });
    } else {
      out({ type: 'reply', id: m.id, ok: false, error: 'unknown op' });
    }
  } catch (e) {
    out({ type: 'reply', id: m.id, ok: false, error: String(e?.message ?? e).slice(0, 200) });
  }
});
rl.on('close', () => { server.stop().finally(() => process.exit(0)); });
