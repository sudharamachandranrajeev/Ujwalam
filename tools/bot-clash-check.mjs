// SPDX-License-Identifier: GPL-3.0-or-later
// BM7: clash check between Ujwalam, Streamer.bot and Speaker.bot. Stdlib only. READ-ONLY: it writes only to stdout.
//
//   node tools/bot-clash-check.mjs [--json] [--profile FILE]
//
// Checks
//   ports    the bots' fixed ports (BOT_PORTS, from docs/plan/2026-11-03-bot-manager-plan.md) against the listeners on this
//            machine (Get-NetTCPConnection / Get-NetUDPEndpoint, owner = process NAME only, never a command line), plus a
//            static scan of Ujwalam's own code for a bot port used as a fixed port.
//   hotkeys  Ujwalam's global hotkeys (read from app/host/src/host_config.h, the host defaults) against Streamer.bot's,
//            when a hotkey file can be found and parsed (key combos only). Otherwise "manual check".
//   audio, duplicate alerts: manual items (see docs/tests/2026-11-04-A0-S1-bot-clash-checklist.md).
//
// Exit codes: 0 no clash, 1 clash, 2 a check could not run (1 wins when both).

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemTool } from '../services/event-core/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fixed bot ports. owner: 'streamerbot' | 'speakerbot'. */
export const BOT_PORTS = Object.freeze([
  { port: 8083, proto: 'tcp', bot: 'speakerbot', what: 'Speaker.bot WebSocket server' },
  { port: 8093, proto: 'tcp', bot: 'streamerbot', what: 'Streamer.bot WebSocket server' },
  { port: 4242, proto: 'udp', bot: 'streamerbot', what: 'Streamer.bot UDP' },
  { port: 7474, proto: 'tcp', bot: 'streamerbot', what: 'Streamer.bot HTTP server' },
  { port: 9652, proto: 'tcp', bot: 'streamerbot', what: 'Streamer.bot PolyPop' },
  { port: 8059, proto: 'tcp', bot: 'streamerbot', what: 'Streamer.bot Stream Deck' },
  { port: 8001, proto: 'tcp', bot: 'streamerbot', what: 'Streamer.bot VTube Studio client' },
  { port: 42069, proto: 'tcp', bot: 'streamerbot', what: 'Streamer.bot throwing system' },
]);

const BOT_NAME = { streamerbot: /^streamer[ ._-]?bot(\.exe)?$/i, speakerbot: /^speaker[ ._-]?bot(\.exe)?$/i };
const UJWALAM_NAME = /^(ujwalam[\w.-]*|node)(\.exe)?$/i;

/** Classify a process name: 'streamerbot' | 'speakerbot' | 'ujwalam' | 'other' | 'unknown'. Name only. */
export function classifyOwner(name) {
  if (typeof name !== 'string' || !name) return 'unknown';
  for (const [bot, re] of Object.entries(BOT_NAME)) if (re.test(name)) return bot;
  if (UJWALAM_NAME.test(name)) return 'ujwalam';
  return 'other';
}

/**
 * Compare listeners with the port map. listeners: [{ proto:'tcp'|'udp', port, name }].
 * Returns rows { port, proto, bot, what, state: 'free'|'ok'|'clash', owner, ownerClass }.
 * clash = held by a process that is not the expected bot. ('unknown' owner, e.g. no rights to see it, is a clash too:
 * it is not proven to be the bot.)
 */
export function evaluatePorts(listeners, ports = BOT_PORTS) {
  return ports.map((p) => {
    const held = listeners.filter((l) => l.port === p.port && l.proto === p.proto);
    if (!held.length) return { ...p, state: 'free', owner: null, ownerClass: null };
    const bad = held.find((l) => classifyOwner(l.name) !== p.bot);
    const l = bad ?? held[0];
    const cls = classifyOwner(l.name);
    return { ...p, state: bad ? 'clash' : 'ok', owner: cls === 'other' ? 'other' : (l.name ?? 'unknown'), ownerClass: cls };
  });
}

const BOT_PORT_SET = new Set(BOT_PORTS.map((p) => p.port));
const PORT_RE = new RegExp(`(?<![\\d.])(${[...BOT_PORT_SET].join('|')})(?![\\d])`);
// A line that names a bot port while only talking TO the bot or REFUSING the port is not a bind.
const SAFE_LINE = /ws:\/\/|DEFAULT_WS|never|must not|refus|bad --|===|!==|==\s*\d|Streamer|Speaker|streamerbot|speakerbot|STREAMERBOT_PORT|kStreamerbotPort|^\s*(\/\/|\*|#)/;
// Only a line that talks about ports/binding counts (a pid or a count that equals 4242 is not a port).
const PORT_CONTEXT = /port|listen|bind|socket|\bhost\b|:\d{4,5}/i;
const SCAN_DIRS = ['services', 'app/host/lib', 'app/host/overlay', 'app/host/src', 'tools'];
const SCAN_EXT = /\.(mjs|js|json|cpp|h|ps1|py)$/;
const SKIP_DIR = /^(tests?|node_modules|out|\.git|fixtures|mock|bench|soak|label)$/i;

/** Pure: scan text for a bot port used as an Ujwalam fixed port. Returns [{ line, port, text }] (text trimmed to 120). */
export function scanTextForBotPorts(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((ln, i) => {
    const m = PORT_RE.exec(ln);
    if (m && PORT_CONTEXT.test(ln) && !SAFE_LINE.test(ln)) hits.push({ line: i + 1, port: Number(m[1]), text: ln.trim().slice(0, 120) });
  });
  return hits;
}

function walk(dir, out, depth = 0) {
  if (depth > 8) return;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, out, depth + 1); }
    else if (SCAN_EXT.test(e.name) && !/\.test\./.test(e.name)) { try { if (statSync(p).size < 2_000_000) out.push(p); } catch { /* skip */ } }
  }
}

/** Static check of Ujwalam's code. Returns { ok, scanned, hits:[{file,line,port,text}] }. */
export function staticPortCheck(repo = REPO) {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(repo, d), files);
  const hits = [];
  for (const f of files) {
    let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
    for (const h of scanTextForBotPorts(t)) hits.push({ file: path.relative(repo, f).replaceAll('\\', '/'), ...h });
  }
  return { ok: files.length > 0, scanned: files.length, hits };
}

/** Real listener query. Returns { ok, listeners, error }. Windows only; names only. */
export function queryListeners() {
  if (process.platform !== 'win32') return { ok: false, listeners: [], error: 'windows-only' };
  try {
    const script = `$ErrorActionPreference='Stop'; $n=@{}; Get-Process | ForEach-Object { $n[[int]$_.Id]=$_.ProcessName }; $r=@(); ` +
      `Get-NetTCPConnection -State Listen | ForEach-Object { $r += [pscustomobject]@{proto='tcp';port=[int]$_.LocalPort;name=$n[[int]$_.OwningProcess]} }; ` +
      `Get-NetUDPEndpoint | ForEach-Object { $r += [pscustomobject]@{proto='udp';port=[int]$_.LocalPort;name=$n[[int]$_.OwningProcess]} }; ` +
      `if ($r.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $r -Compress }`;
    const r = spawnSync(systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status !== 0 || !r.stdout.trim()) return { ok: false, listeners: [], error: r.error ? String(r.error.code ?? 'spawn') : `exit ${r.status}` };
    const v = JSON.parse(r.stdout);
    return { ok: true, listeners: (Array.isArray(v) ? v : [v]).map((x) => ({ proto: x.proto, port: x.port, name: typeof x.name === 'string' ? x.name : null })), error: null };
  } catch (e) { return { ok: false, listeners: [], error: String(e?.message ?? e).slice(0, 80) }; }
}

// ---- hotkeys ----
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'win'];
const MOD_ALIAS = { control: 'ctrl', ctl: 'ctrl', menu: 'alt', windows: 'win', super: 'win', meta: 'win', cmd: 'win' };
/** "Ctrl+Alt+Shift+M" / "alt + control + m" -> "ctrl+alt+shift+m". null if not a combo (needs a key and a modifier). */
export function normalizeCombo(s) {
  if (typeof s !== 'string' || s.length > 60) return null;
  const parts = s.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => MOD_ALIAS[x] ?? x);
  if (parts.length < 2) return null;
  const key = parts.filter((x) => !MOD_ORDER.includes(x));
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  if (key.length !== 1 || !mods.length || !/^[a-z0-9]$|^f([1-9]|1\d|2[0-4])$|^[a-z]{2,12}$/.test(key[0])) return null;
  return [...mods, key[0]].join('+');
}

/** Ujwalam's host defaults from app/host/src/host_config.h. Returns { ok, combos:[{name, combo}] }. */
export function ujwalamHotkeys(repo = REPO) {
  try {
    const t = readFileSync(path.join(repo, 'app', 'host', 'src', 'host_config.h'), 'utf8');
    const block = /hotkeys\s*=\s*\{([\s\S]*?)\};/.exec(t);
    if (!block) return { ok: false, combos: [], error: 'no hotkeys block' };
    const combos = [...block[1].matchAll(/\{\s*"(\w+)"\s*,\s*"([^"]+)"\s*\}/g)].map((m) => ({ name: m[1], combo: normalizeCombo(m[2]) })).filter((c) => c.combo);
    return { ok: combos.length > 0, combos, error: combos.length ? null : 'no combos parsed' };
  } catch (e) { return { ok: false, combos: [], error: String(e?.code ?? 'read-failed') }; }
}

/** Pure: collect key combos from a parsed hotkey JSON. Only string values under keys named like a hotkey; nothing else is read. */
export function extractCombos(json) {
  const found = new Set();
  const KEYNAME = /^(hotkey|hotkeys|keys|key|combo|shortcut|keycombo)$/i;
  const visit = (v, under, d) => {
    if (d > 8 || v == null) return;
    if (typeof v === 'string') { if (under) { const c = normalizeCombo(v); if (c) found.add(c); } return; }
    if (Array.isArray(v)) { for (const x of v.slice(0, 5000)) visit(x, under, d + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, KEYNAME.test(k), d + 1);
  };
  visit(json, false, 0);
  return [...found];
}

const SB_HOTKEY_FILES = [['data', 'hotkeys.json'], ['hotkeys.json'], ['data', 'hotkey.json']]; // UNVERIFIED names

/** Streamer.bot hotkeys: { status: 'checked'|'manual', combos, reason }. Reads only the key combos of a clearly identified file. */
export function streamerbotHotkeys(profilePath = path.join(REPO, 'data', 'profile.local.json')) {
  let exe = null;
  try { exe = JSON.parse(readFileSync(profilePath, 'utf8'))?.paths?.streamerbot_exe ?? null; } catch { /* unset */ }
  if (typeof exe !== 'string' || !exe || /^<.*>$/.test(exe) || !path.isAbsolute(exe)) return { status: 'manual', combos: [], reason: 'paths.streamerbot_exe not set' };
  const dir = path.dirname(exe);
  for (const rel of SB_HOTKEY_FILES) {
    const f = path.join(dir, ...rel);
    let raw; try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    try { return { status: 'checked', combos: extractCombos(JSON.parse(raw)), reason: null }; } catch { return { status: 'manual', combos: [], reason: 'hotkey file found but not parseable' }; }
  }
  return { status: 'manual', combos: [], reason: 'no hotkey definition file found (UNVERIFIED where Streamer.bot keeps it)' };
}

/** Pure: Ujwalam combos vs Streamer.bot combos (and Ujwalam vs itself). Returns clash rows. */
export function evaluateHotkeys(ujw, sbCombos) {
  const clashes = [];
  const seen = new Map();
  for (const u of ujw) {
    if (seen.has(u.combo)) clashes.push({ combo: u.combo, with: `Ujwalam ${seen.get(u.combo)}`, ujwalam: u.name });
    else seen.set(u.combo, u.name);
    if (sbCombos.includes(u.combo)) clashes.push({ combo: u.combo, with: 'Streamer.bot', ujwalam: u.name });
  }
  return clashes;
}

export const MANUAL = Object.freeze([
  'Audio: Speaker.bot output device is not also captured by an Ujwalam mixer input (see checklist).',
  'Alerts: one real event must raise one alert, not one from Streamer.bot and one from Ujwalam (see checklist).',
]);

/** Run everything. deps are injectable for tests. */
export function runChecks({ listen = queryListeners, staticCheck = staticPortCheck, uHot = ujwalamHotkeys, sHot = streamerbotHotkeys } = {}) {
  const res = { clashes: [], couldNotRun: [], ports: [], static: null, hotkeys: { ujwalam: [], streamerbot: null, clashes: [] }, manual: [...MANUAL] };
  const L = listen();
  if (!L.ok) res.couldNotRun.push(`ports: listener query failed (${L.error})`);
  else {
    res.ports = evaluatePorts(L.listeners);
    for (const r of res.ports) if (r.state === 'clash') res.clashes.push(`port ${r.port}/${r.proto} (${r.what}) is held by ${r.owner}`);
  }
  const S = staticCheck();
  res.static = S;
  if (!S.ok) res.couldNotRun.push('ports: static scan found no files');
  for (const h of S.hits ?? []) res.clashes.push(`Ujwalam code uses bot port ${h.port} at ${h.file}:${h.line}`);
  const U = uHot();
  if (!U.ok) res.couldNotRun.push(`hotkeys: Ujwalam hotkeys unreadable (${U.error})`);
  else {
    res.hotkeys.ujwalam = U.combos;
    const SB = sHot();
    res.hotkeys.streamerbot = SB;
    if (SB.status === 'checked') {
      res.hotkeys.clashes = evaluateHotkeys(U.combos, SB.combos);
      for (const c of res.hotkeys.clashes) res.clashes.push(`hotkey ${c.combo} (Ujwalam ${c.ujwalam}) also used by ${c.with}`);
    } else res.manual.unshift(`Hotkeys: manual check (${SB.reason}). Ujwalam uses ${U.combos.map((c) => c.combo).join(', ')}; open Streamer.bot hotkeys and confirm none match.`);
  }
  res.exit = res.clashes.length ? 1 : res.couldNotRun.length ? 2 : 0;
  return res;
}

export function formatText(r) {
  const o = ['BOT CLASH CHECK (read-only)', '', 'PORT   PROTO  BOT          STATE  OWNER'];
  for (const p of r.ports) o.push(`${String(p.port).padEnd(6)} ${p.proto.padEnd(6)} ${p.bot.padEnd(12)} ${p.state.padEnd(6)} ${p.owner ?? '-'}`);
  if (!r.ports.length) o.push('(listener query did not run)');
  o.push('', `Ujwalam code scan: ${r.static ? `${r.static.scanned} files, ${r.static.hits.length} bot-port hits` : 'not run'}`);
  o.push(`Hotkeys (Ujwalam): ${r.hotkeys.ujwalam.map((c) => `${c.name}=${c.combo}`).join(' ') || 'unknown'}`);
  o.push(`Hotkeys (Streamer.bot): ${r.hotkeys.streamerbot ? (r.hotkeys.streamerbot.status === 'checked' ? `${r.hotkeys.streamerbot.combos.length} combos read` : `not checked (${r.hotkeys.streamerbot.reason})`) : 'not run'}`);
  o.push('', 'CLASHES:', ...(r.clashes.length ? r.clashes.map((c) => `  - ${c}`) : ['  none']));
  if (r.couldNotRun.length) o.push('', 'COULD NOT RUN:', ...r.couldNotRun.map((c) => `  - ${c}`));
  o.push('', 'MANUAL:', ...r.manual.map((c) => `  - ${c}`), '', `Exit ${r.exit}`);
  return o.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--profile');
  const profilePath = pi >= 0 ? argv[pi + 1] : undefined;
  const r = runChecks(profilePath ? { sHot: () => streamerbotHotkeys(profilePath) } : {});
  process.stdout.write((argv.includes('--json') ? JSON.stringify(r, null, 2) : formatText(r)) + '\n');
  process.exitCode = r.exit;
}
