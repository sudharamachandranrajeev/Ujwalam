#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Event-core command line (P3 E2). Node stdlib only.
//
//   node services/event-core/cli.mjs listen [--url ws://127.0.0.1:8080/] [--interval 10000] [--duration SECONDS]
//          [--credential Ujwalam/streamerbot] [--data-dir DIR] [--no-fixtures] [--show-text] [--allow-remote]
//   node services/event-core/cli.mjs serve [--mock] [--port N] [--data-dir DIR] [--url ws://...] [--allow-remote] [--credential NAME] [--no-fixtures] [--duration SECONDS]
//          [--no-stall-tracer]
//   node services/event-core/cli.mjs audit purge|verify|backup|export   (see audit/cli.mjs)
//   node services/event-core/cli.mjs credential set|delete|status [--target Ujwalam/streamerbot] [--stdin]
//
// credential set reads the secret from the terminal with no echo (asks twice), or from stdin with --stdin
// (first line, for piping). It refuses when stdin is not a terminal unless --stdin is given. The secret goes to
// Credential Manager through the provider's stdin path, never argv or environment. status prints only
// whether the credential exists, never its value.
//
// listen is READ-ONLY: it connects, subscribes, counts, and prints a table of counts per platform and kind plus the
// connection state every interval. It never sends a chat message (the connector's send path is disabled).
// It prints no chat text and no user names unless --show-text is given; even then the text goes to the terminal
// only and is never written to a file. Alert payloads are recorded anonymised (see anonymise.mjs) into
// <dataDir>/fixtures/alerts when a data dir resolves (paths.event_core_data), unless --no-fixtures.
// The pseudonym key is an in-memory throwaway for this command: listen persists nothing else.
// Review E8-15: the data dir gets the same protection as serve (ensureSecureDir: current user only, existing files
// re-protected); if that fails, fixtures are turned off rather than written into an unprotected directory.
// --url must be loopback for ws:// unless --allow-remote is given (wss:// is always allowed).
// Review E8-11: with --show-text, control, format (bidi, zero-width, soft hyphen) and line/paragraph separator
// characters in names and text are shown as visible \u{XXXX} escapes (displaySafe). Stored text is unchanged.
//
// serve is the live event core. It first sets its own process priority to Normal (priority.mjs; logged, failure is
// reported and not fatal), and runs the stall tracer unless --no-stall-tracer (stalls over 200 ms only, to
// <dataDir>/stalls.jsonl, rotated at 1 MiB).

import { randomBytes } from 'node:crypto';
import { createEventCore, resolveDataDir } from './index.mjs';
import { ensureSecureDir } from './config.mjs';
import { createFixtureRecorder } from './streamerbot/anonymise.mjs';
import { checkUrl, createStreamerbotConnector, DEFAULT_URL, isLoopback } from './streamerbot/connector.mjs';
import { startService } from './api/service.mjs';
import { auditCommand } from './audit/cli.mjs';
import { formatPriority, setLivePriority } from './priority.mjs';
import { createCredentialStore, credentialProvider, DEFAULT_TARGET } from './streamerbot/credential.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['show-text', 'no-fixtures', 'stdin', 'all', 'mock', 'no-stall-tracer', 'allow-remote'].includes(k)) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/** Terminal-safe form of untrusted text: C0/C1 controls, format characters (bidi overrides and isolates, zero-width,
 *  soft hyphen, word joiner, BOM), line and paragraph separators and invisible fillers become visible \u{XXXX}
 *  escapes, so a name cannot reorder, hide or break the line it is printed on (review E8-11). Display only; never
 *  applied to stored text. */
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u3164\uFFA0]/gu;
export function displaySafe(s) {
  return String(s).replace(UNSAFE_DISPLAY, (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`);
}

export async function listen(args, io = { out: (s) => console.log(s), signal: null }) {
  const url = args.url ?? DEFAULT_URL;
  const allowRemote = args['allow-remote'] === true;
  try { checkUrl(url, { allowRemote }); } catch (e) {
    io.out(`[listen] refused: ${e.message}`);
    return { state: 'refused', counts: {}, stats: null, notes: ['url-refused'] };
  }
  if (!isLoopback(url)) io.out(`[listen] warn: ${new URL(url).protocol}// to a non-loopback host${allowRemote ? ' (--allow-remote)' : ''}`);
  const interval = Number(args.interval ?? 10000);
  const core = createEventCore({ key: randomBytes(32) });
  const counts = new Map();
  const showText = args['show-text'] === true;
  core.bus.subscribe({
    name: 'listen-counts',
    handler: (ev) => {
      if (ev.kind.startsWith('system.')) return;
      const k = `${ev.platform} ${ev.kind}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (showText && ev.kind === 'chat.message') io.out(`  [${displaySafe(ev.platform)}] ${displaySafe(ev.user.displayName)}: ${displaySafe(ev.text)}`);
    },
  });

  let recorder = null;
  if (!args['no-fixtures']) {
    try {
      const dir = resolveDataDir({ dataDir: args['data-dir'] });
      if (ensureSecureDir(dir).protection === 'acl-failed') io.out('[listen] warn: could not restrict the data dir to the current user (ACL_FAILED); fixtures off');
      else recorder = createFixtureRecorder({ dir });
    } catch { recorder = null; }
  }
  const getPassword = process.platform === 'win32' ? credentialProvider(args.credential ?? DEFAULT_TARGET) : async () => null;
  const notes = [];
  const sb = createStreamerbotConnector({
    core, url, allowRemote, getPassword, recorder,
    onNote: (level, code) => { notes.push(code); io.out(`[listen] ${level}: ${code}`); },
  });

  const report = () => {
    const s = sb.stats();
    io.out(`[listen] state=${sb.state()} received=${s.received} published=${s.published} deduped=${s.deduped} invalid=${s.invalid} fixtures=${s.fixtures} reconnects=${s.reconnects}`);
    for (const [k, n] of [...counts].sort()) io.out(`  ${k} ${n}`);
    const sk = Object.entries(s.skipped);
    if (sk.length) io.out(`  skipped: ${sk.map(([k, n]) => `${k}=${n}`).join(' ')}`);
  };

  sb.start();
  io.out(`[listen] ${sb.url()} read-only; text ${showText ? 'SHOWN on terminal only' : 'hidden'}; fixtures ${recorder ? 'on' : 'off'}`);
  const timer = setInterval(report, interval);
  await new Promise((resolve) => {
    const done = () => resolve();
    if (args.duration) setTimeout(done, Number(args.duration) * 1000);
    process.once('SIGINT', done);
    io.signal?.addEventListener('abort', done);
    if (io.signal?.aborted) done();
  });
  clearInterval(timer);
  report();
  sb.stop();
  return { state: sb.state(), counts: Object.fromEntries(counts), stats: sb.stats(), notes };
}

/** Starts the core with Streamer.bot ingest, the audit and the API. Prints the port, never a token. Read-only towards platforms.
 *  io.setPriority is a test seam (default priority.mjs setLivePriority); it returns { ok, target, before, after, error? }. */
export async function serve(args, io = { out: (s) => console.log(s), signal: null }) {
  const port = args.port === undefined ? 0 : Number(args.port);
  // The live path never runs below background work: Normal, before anything else starts.
  let pr;
  try { pr = (io.setPriority ?? setLivePriority)(); } catch (e) { pr = { ok: false, target: 'normal', before: null, after: null, error: e?.code ?? 'ERROR' }; }
  io.out(`[serve] ${formatPriority(pr)}`);
  // F6 live markers: the launcher passes the host api token by environment only; it is taken out of the environment at
  // once and handed to the narrow host link (marker.add, mixer.list). Without it the live markers stay off.
  const hostToken = process.env.UJWALAM_HOST_TOKEN;
  const hostDiscovery = process.env.UJWALAM_HOST_DISCOVERY;
  delete process.env.UJWALAM_HOST_TOKEN;
  const svc = await startService({
    hostToken, ...(hostDiscovery ? { hostDiscovery } : {}),
    dataDir: args['data-dir'], port, mock: args.mock === true, url: args.url, allowRemote: args['allow-remote'] === true, credential: args.credential,
    noFixtures: args['no-fixtures'] === true, out: io.out, ...(args['no-stall-tracer'] === true ? { stallTracer: false } : {}),
  });
  io.out(`[serve] stall tracer ${svc.stallTracer ? `on (> ${svc.stallTracer.summary().thresholdMs} ms, ${svc.stallFile ? 'stalls.jsonl in the data dir' : 'no file'})` : 'off'}`);
  io.out(`[serve] api on 127.0.0.1:${svc.port}${args.mock === true ? ' (mock Streamer.bot)' : ''}; api.json written (${svc.apiFile.protection}); data dir ${svc.dataDirProtection}; no token printed; sending to platforms is off`);
  await new Promise((resolve) => {
    if (args.duration) setTimeout(resolve, Number(args.duration) * 1000);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    io.signal?.addEventListener('abort', resolve);
  });
  await svc.stop();
  io.out('[serve] stopped; api.json removed');
  return 0;
}

/** Read one line from the terminal with no echo. Resolves the line, rejects on Ctrl-C. */
function readHidden(prompt, input = process.stdin, output = process.stderr) {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let buf = '';
    const finish = (fn, v) => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); output.write('\n'); fn(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(resolve, buf);
        if (ch === '\u0003') return finish(reject, new Error('aborted'));
        if (ch === '\u007f' || ch === '\b') buf = [...buf].slice(0, -1).join('');
        else if (ch >= ' ') buf += ch;
      }
    };
    input.on('data', onData);
  });
}

async function readStdinLine(input = process.stdin) {
  let data = '';
  input.setEncoding('utf8');
  for await (const chunk of input) data += chunk;
  return data.split(/\r?\n/)[0];
}

export async function credentialCommand(args, io = { out: (t) => console.log(t) }) {
  const sub = args._[1];
  const store = createCredentialStore(args.target ?? DEFAULT_TARGET);
  if (sub === 'status') {
    // Only presence and one shape fact are printed, never the value: a stored "?query" (e.g. Twitch's
    // ?bandwidthtest=true) must be removed before a public stream; the host adds that suffix at connect time itself.
    const v = await store.get();
    io.out(v == null ? 'credential: not set' : String(v).includes('?') ? 'credential: set (WARNING: it contains a "?" query suffix; set it again without it for a public stream)' : 'credential: set');
    return 0;
  }
  if (sub === 'delete') { io.out((await store.delete()) ? 'credential: deleted' : 'credential: not set (nothing to delete)'); return 0; }
  if (sub !== 'set') { io.out('usage: credential set|delete|status [--target NAME] [--stdin]'); return 1; }
  let secret;
  if (args.stdin === true) secret = await readStdinLine();
  else {
    if (!process.stdin.isTTY) { io.out('credential set: stdin is not a terminal; run it in a terminal, or pass --stdin to pipe the secret'); return 1; }
    try {
      secret = await readHidden('Password (hidden): ');
      const again = await readHidden('Again: ');
      if (secret !== again) { io.out('credential set: the two entries differ; nothing stored'); return 1; }
    } catch { io.out('credential set: aborted; nothing stored'); return 1; }
  }
  if (!secret) { io.out('credential set: empty secret; nothing stored'); return 1; }
  await store.set(secret);
  io.out('credential: stored');
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] === 'serve') {
    try { process.exit(await serve(args)); } catch (e) { console.log(`serve: failed (${e.message})`); process.exit(1); }
  } else if (args._[0] === 'listen') {
    // A parent that spawned listen with an IPC channel (tests, a supervisor) stops it cleanly with 'stop' or by
    // disconnecting: on Windows a kill is TerminateProcess, so SIGINT never arrives and the final report would be lost.
    const ac = new AbortController();
    if (process.channel) {
      process.on('message', (m) => { if (m === 'stop') ac.abort(); });
      process.once('disconnect', () => ac.abort());
    }
    const r = await listen(args, { out: (s) => console.log(s), signal: ac.signal });
    process.exit(r.state === 'auth-failed' ? 2 : r.state === 'refused' ? 1 : 0);
  } else if (args._[0] === 'audit') {
    process.exit(await auditCommand(args));
  } else if (args._[0] === 'credential') {
    try { process.exit(await credentialCommand(args)); } catch (e) { console.log(`credential: failed (${e.message})`); process.exit(1); }
  } else {
    console.log('usage: node services/event-core/cli.mjs serve [--mock] [--port N] [--data-dir DIR] [--duration S] [--no-stall-tracer] | audit purge|verify|backup|export | credential set|delete|status | listen [--url URL] [--allow-remote] [--interval MS] [--duration S] [--credential NAME] [--data-dir DIR] [--no-fixtures] [--show-text]');
    process.exit(1);
  }
}
