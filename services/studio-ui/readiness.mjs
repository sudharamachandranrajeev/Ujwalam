// SPDX-License-Identifier: GPL-3.0-or-later
// Pre-stream readiness check, "Ready to go live?" (D299 proposed, flag `readiness`). Node stdlib + repo modules.
//
// runReadiness(deps) answers { at, ok, counts: { pass, warn, fail }, items: [{ id, title, status, message, fix? }] }.
// status is 'pass' | 'warn' | 'fail'. ok is true when nothing failed (warnings never block). Each check runs in
// parallel with its own timeout (config.checkTimeoutMs); a check that throws or times out is a 'warn' that says so,
// except audio: while the host answers, audio state that cannot be read is a 'fail' (a dead game audio must not pass
// unseen; the override phrase still goes live). The first host probes (host.status, outputs.status, host.info,
// core.status) have the same timeout, and createReadiness gives a whole run a deadline (readinessDeadlineMs).
// Items (ITEMS): host, credentials, disk, encoders, streamerbot, speakerbot, loopback, clips, audio, gpu.
//
// Secrets: stream keys and per-account server addresses stay in Windows Credential Manager. The host reports
// keyPresent / urlPresent for configured sinks (it reads them itself). Only the server address of a sink with a urlRef
// (twitch-server, kick-server) is read here, in memory, to compare its scheme (rtmp / rtmps) with the plan's transport;
// the value is dropped at once and only the scheme is ever reported. A plan target with transport "auto" (Twitch, D309
// proposed) takes any of its platform's rtmp/rtmps protocols; the host's transport is the one chosen at start, so a
// changed address with another allowed scheme needs a restart. When the host has no live outputs (started
// without --live, or down), the plan file's credential targets are checked for presence directly. Messages, results
// and the override log never carry a key, an address or a credential target's value.
//
// Thresholds and names: data/live/readiness.json (loadReadinessConfig). Nothing here is hardcoded.
// Audio (pluggable): deps.audioCheck(ctx) replaces the default, which calls the host method config.audio.method
// (assumed: { sources: [{ id, name, state }] }) when host.status has no audioHealth; no answer from either = fail.

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemTool } from '../event-core/config.mjs';
import { loadPlatforms } from '../outputs/validate.mjs';
import { liveSchemesOf } from '../../app/host/lib/outputs-plan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const READINESS_FLAG = 'readiness';
export const DEFAULT_CONFIG_FILE = path.join(REPO, 'data', 'live', 'readiness.json');
export const DEFAULT_PLAN_FILE = path.join(REPO, 'data', 'outputs', 'alpha-live.json');
// Typed to go live while a readiness item fails. Different from "yes, on air" on purpose: an override is a choice.
export const OVERRIDE_PHRASE = 'yes, on air, override';
export const OVERRIDE_LOG = 'readiness-overrides.jsonl';
export const ITEMS = Object.freeze(['host', 'credentials', 'disk', 'encoders', 'streamerbot', 'speakerbot', 'loopback', 'clips', 'audio', 'gpu']);
export const TITLES = Object.freeze({
  host: 'Studio host and outputs', credentials: 'Stream keys', disk: 'Disk space', encoders: 'Other streaming apps',
  streamerbot: 'Streamer.bot', speakerbot: 'Speaker.bot', loopback: 'Loopback output test', clips: 'Clip maker',
  audio: 'Audio sources', gpu: 'NVIDIA GPU',
});
const GB = 1024 ** 3;
const ACTIVE = new Set(['starting', 'live', 'retrying']);
const PLATFORM = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

const num = (v, name, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`readiness config: bad ${name}`);
  return v;
};
const strList = (v, name) => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)) throw new Error(`readiness config: bad ${name}`);
  return v;
};

/** Reads and checks data/live/readiness.json. Throws on a malformed file. */
export function loadReadinessConfig(file = DEFAULT_CONFIG_FILE) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const sev = (s) => { if (s !== 'fail' && s !== 'warn') throw new Error('readiness config: bad severity'); return s; };
  const disk = { failBelowGB: num(j.disk?.failBelowGB, 'disk.failBelowGB', 0, 1e6), warnBelowGB: num(j.disk?.warnBelowGB, 'disk.warnBelowGB', 0, 1e6), gbPerHour: num(j.disk?.gbPerHour, 'disk.gbPerHour', 0.1, 1000) };
  if (disk.warnBelowGB < disk.failBelowGB) throw new Error('readiness config: disk.warnBelowGB below failBelowGB');
  let re;
  try { re = new RegExp(String(j.gpu?.adapterPattern ?? ''), 'i'); } catch { throw new Error('readiness config: bad gpu.adapterPattern'); }
  if (!j.gpu?.adapterPattern) throw new Error('readiness config: bad gpu.adapterPattern');
  if (typeof j.audio?.method !== 'string' || !/^[a-z]+\.[A-Za-z]+$/.test(j.audio.method)) throw new Error('readiness config: bad audio.method');
  return {
    checkTimeoutMs: num(j.checkTimeoutMs, 'checkTimeoutMs', 100, 9000),
    goLiveMaxAgeMs: num(j.goLiveMaxAgeMs, 'goLiveMaxAgeMs', 0, 600_000),
    disk,
    otherEncoders: (Array.isArray(j.otherEncoders?.apps) ? j.otherEncoders.apps : []).map((a) => ({
      label: String(a.label).slice(0, 64), prefixes: strList(a.prefixes, 'otherEncoders.prefixes').map((p) => p.toLowerCase()), severity: sev(a.severity),
    })),
    bots: { tcpTimeoutMs: num(j.bots?.tcpTimeoutMs, 'bots.tcpTimeoutMs', 50, 5000) },
    loopback: { maxAgeDays: num(j.loopback?.maxAgeDays, 'loopback.maxAgeDays', 0, 365) },
    gpu: { adapter: re, preference: num(j.gpu?.preference, 'gpu.preference', 0, 9) },
    audio: { method: j.audio.method, failStates: strList(j.audio.failStates, 'audio.failStates'), warnStates: strList(j.audio.warnStates, 'audio.warnStates') },
    endAll: { waitMs: num(j.endAll?.waitMs, 'endAll.waitMs', 0, 9000), pollMs: num(j.endAll?.pollMs, 'endAll.pollMs', 50, 5000) },
  };
}

const item = (id, status, message, extra = {}) => ({ id, title: TITLES[id] ?? id, status, message, ...extra });
const sinkLabel = (s) => {
  const base = PLATFORM[s.platform] ?? s.platform ?? s.id;
  return s.id && s.id !== s.platform ? `${base} (${s.id})` : base;
};
const roundGB = (b) => Math.round((b / GB) * 10) / 10;
const schemesText = (list) => (list ?? []).map((x) => `${x}://`).join(' or ');

/** Scheme of a URL-like string ('rtmp', 'rtmps', ...) or null. The caller drops the value. */
export function schemeOf(value) {
  const m = typeof value === 'string' ? /^\s*([A-Za-z][A-Za-z0-9+.-]{0,15}):\/\//.exec(value) : null;
  return m ? m[1].toLowerCase() : null;
}

/** Reads one credential and returns only facts about it: { present, scheme?, query? }. The value never leaves here. */
export async function credentialFacts(store, { scheme = false, query = false } = {}) {
  let v = await store.get();
  const out = { present: typeof v === 'string' && v !== '' };
  if (out.present && scheme) out.scheme = schemeOf(v);
  if (out.present && query) out.query = v.includes('?');
  v = null; // drop it
  return out;
}

// ---- default system probes (each replaced by a fake in tests) ----

/** Image names of the running processes, lower case (tasklist, no console window). */
export function listProcessNames() {
  return new Promise((resolve, reject) => {
    let exe;
    try { exe = systemTool('tasklist.exe'); } catch (e) { reject(e); return; }
    execFile(exe, ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) { reject(new Error(`tasklist failed (${err.code ?? 'error'})`)); return; }
      resolve(String(stdout).split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]).filter(Boolean).map((n) => n.toLowerCase()));
    });
  });
}

/** Free bytes for the drive that holds dir. */
export function diskFreeBytes(dir) {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Newest full-CI pass stamp { at } (tools/ci-stamp.mjs) or null (no git, no stamp). */
export function lastCiPass(root = REPO) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--git-path', 'ujwalam-ci-pass.json'], { cwd: root, windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const j = JSON.parse(readFileSync(path.resolve(root, String(stdout).trim()), 'utf8'));
        const ats = (Array.isArray(j.passes) ? j.passes : []).map((p) => Date.parse(p?.at)).filter(Number.isFinite);
        resolve(ats.length ? { at: new Date(Math.max(...ats)).toISOString() } : null);
      } catch { resolve(null); }
    });
  });
}

// ---- checks ----

async function checkHost(ctx) {
  if (ctx.hostKind !== 'host') return item('host', 'fail', 'The studio host is not connected (the page runs on a stand-in). Start the studio with npm run alpha.');
  if (!ctx.hostStatus) return item('host', 'fail', 'The studio host does not answer.');
  if (!ctx.outputs) return item('host', 'fail', 'The host does not report its outputs.');
  if (ctx.outputs.configured === false) return item('host', 'fail', 'No outputs are set up in the host.');
  const streams = ctx.streamSinks;
  if (!streams.length) return item('host', 'fail', 'No stream outputs are set up (only recording). Start the studio with --live to stream.');
  const live = streams.filter((s) => s.target === 'live');
  if (!live.length) return item('host', 'warn', `Streams go to local test targets only (${streams.length} output(s)): start the studio with --live to reach the platforms.`);
  const running = live.filter((s) => ACTIVE.has(s.state));
  return item('host', 'pass', `Host up. Stream outputs: ${live.map(sinkLabel).join(', ')}${running.length ? ` (${running.length} already running)` : ''}.`);
}

async function checkCredentials(ctx) {
  const problems = []; const warns = []; const okNames = [];
  // Platform sign-in (D327, flag platform-connect): keys are set in the studio; an expired sign-in is a warning only
  // (the stored key keeps working). Without it, the fix is the credential command.
  const conn = typeof ctx.connect === 'function' ? ctx.connect() : null;
  const fix = conn?.fix ?? 'node services/event-core/cli.mjs credential set --target <the output\'s target>';
  if (conn) { try { warns.push(...(await conn.warnings()).map((w) => String(w).slice(0, 200))); } catch { /* status unreadable: the key checks below still run */ } }
  const live = ctx.streamSinks.filter((s) => s.target === 'live');
  if (live.length) {
    for (const s of live) {
      const label = sinkLabel(s);
      if (s.keyRef && s.keyPresent !== true) { problems.push(`${label}: stream key not found in Windows Credential Manager`); continue; }
      if (s.bandwidthTest === true) warns.push(`${label}: Twitch bandwidth test is on, viewers will not see this stream`);
      if (s.urlRef) {
        if (s.urlPresent !== true) { problems.push(`${label}: server address not found in Windows Credential Manager`); continue; }
        let f;
        try { f = await credentialFacts(ctx.store(s.urlRef), { scheme: true }); } catch { warns.push(`${label}: server address could not be read to check rtmp/rtmps`); continue; }
        if (!f.present) { problems.push(`${label}: server address not found in Windows Credential Manager`); continue; }
        if (s.transport && f.scheme !== s.transport) {
          const pt = ctx.planTargets.find((x) => x.id === s.id);
          const head = `${label}: server address starts with ${f.scheme ? `${f.scheme}://` : 'no rtmp:// or rtmps://'} but this output sends ${s.transport}://`;
          if (pt?.transport !== 'auto') problems.push(`${head}. Set it again with ${s.transport}://`);
          else if (pt.schemes.includes(f.scheme)) problems.push(`${head}. The address was changed after the studio started; restart the studio with --live to use it`);
          else problems.push(`${head}. ${label} takes only ${schemesText(pt.schemes)}; set it again with one of those`);
          continue;
        }
      }
      okNames.push(label);
    }
    if (problems.length) return item('credentials', 'fail', problems.concat(warns).join('. ') + '.', { fix });
    if (warns.length) return item('credentials', 'warn', warns.join('. ') + '.', conn ? { fix } : undefined);
    return item('credentials', 'pass', `Keys present for ${okNames.join(', ')}${live.some((s) => s.urlRef) ? '; server addresses use the right scheme' : ''}.`);
  }
  // Not live-configured: check the live plan's targets directly (presence only), so keys can be fixed before a --live start.
  const targets = ctx.planTargets;
  if (!targets.length) return item('credentials', 'warn', 'No live plan to check stream keys against.');
  for (const t of targets) {
    const label = PLATFORM[t.id.split('-')[0]] ? `${PLATFORM[t.id.split('-')[0]]} (${t.id})` : t.id;
    try {
      if (t.keyRef) {
        const k = await credentialFacts(ctx.store(t.keyRef), { query: true });
        if (!k.present) { problems.push(`${label}: stream key not set`); continue; }
        if (k.query) warns.push(`${label}: stream key has a "?" ending (set it again without it for a public stream)`);
      }
      if (t.serverRef) {
        const u = await credentialFacts(ctx.store(t.serverRef), { scheme: true });
        if (!u.present) { problems.push(`${label}: server address not set`); continue; }
        if (t.transport === 'auto') {
          if (!t.schemes.includes(u.scheme)) { problems.push(`${label}: server address starts with ${u.scheme ? `${u.scheme}://` : 'no rtmp:// or rtmps://'}, but this output takes only ${schemesText(t.schemes) || 'what data/platforms allows'}`); continue; }
        } else if (t.transport && u.scheme !== t.transport) { problems.push(`${label}: server address starts with ${u.scheme ? `${u.scheme}://` : 'no rtmp:// or rtmps://'} but the plan sends ${t.transport}://`); continue; }
      }
      okNames.push(label);
    } catch { warns.push(`${label}: could not be read from Windows Credential Manager`); }
  }
  const pre = 'Not started with --live, so these are the live plan\'s keys: ';
  if (problems.length || warns.length) return item('credentials', 'warn', pre + problems.concat(warns).join('. ') + '.', { fix });
  return item('credentials', 'pass', `${pre}all present (${okNames.join(', ')}).`);
}

async function checkDisk(ctx) {
  const dir = ctx.recordingsDir || ctx.dataDir;
  if (!dir) return item('disk', 'warn', 'No recordings folder known to check.');
  const free = await ctx.diskFree(dir);
  const drive = path.parse(path.resolve(dir)).root || dir;
  const { failBelowGB, warnBelowGB } = ctx.config.disk;
  const g = roundGB(free);
  const hours = (free / GB / ctx.config.disk.gbPerHour).toFixed(1);
  if (free < failBelowGB * GB) return item('disk', 'fail', `Only ${g} GB free on ${drive} (needs at least ${failBelowGB} GB). Free space before going live.`);
  if (free < warnBelowGB * GB) return item('disk', 'warn', `${g} GB free on ${drive} (below ${warnBelowGB} GB, about ${hours} h of H+V recording).`);
  return item('disk', 'pass', `${g} GB free on ${drive}.`);
}

async function checkEncoders(ctx) {
  const names = await ctx.listProcesses();
  const hits = ctx.config.otherEncoders.filter((a) => names.some((n) => a.prefixes.some((p) => n.startsWith(p))));
  if (!hits.length) return item('encoders', 'pass', 'No other streaming app is running.');
  const fail = hits.filter((a) => a.severity === 'fail');
  const msg = `Running: ${hits.map((a) => a.label).join(', ')}. Close ${hits.length > 1 ? 'them' : 'it'} first: ${hits.length > 1 ? 'they' : 'it'} can use the GPU encoder and the same stream keys.`;
  return item('encoders', fail.length ? 'fail' : 'warn', msg);
}

async function checkStreamerbot(ctx) {
  const port = ctx.botPorts.streamerbot;
  const answering = port ? await ctx.tcp(port, ctx.config.bots.tcpTimeoutMs) : false;
  const sb = ctx.coreStatus?.streamerbot?.state ?? null;
  if (sb === 'connected') return item('streamerbot', 'pass', 'Connected (chat and alerts come in).');
  if (answering) return item('streamerbot', 'warn', `Streamer.bot answers but the event core is not connected to it (${sb ?? 'no connection'}): chat and alerts will not reach Ujwalam.`);
  return item('streamerbot', 'warn', 'Streamer.bot does not answer. Chat feedback, alerts and Kick need it.');
}

async function checkSpeakerbot(ctx) {
  const port = ctx.botPorts.speakerbot;
  const answering = port ? await ctx.tcp(port, ctx.config.bots.tcpTimeoutMs) : false;
  return answering ? item('speakerbot', 'pass', 'Speaker.bot answers.') : item('speakerbot', 'warn', 'Speaker.bot does not answer: the spoken test announcement will not play.');
}

async function checkLoopback(ctx) {
  const last = await ctx.ciPass();
  if (!last) return item('loopback', 'warn', 'No full CI pass recorded on this PC. The full CI runs the loopback output tests (ffprobe).');
  const ageDays = (ctx.now() - Date.parse(last.at)) / 86_400_000;
  const when = ageDays < 1 ? `${Math.max(0, Math.round(ageDays * 24))} h ago` : `${Math.round(ageDays)} day(s) ago`;
  if (ageDays > ctx.config.loopback.maxAgeDays) return item('loopback', 'warn', `Last full CI pass (loopback ffprobe tests) was ${when}, older than ${ctx.config.loopback.maxAgeDays} days.`);
  return item('loopback', 'pass', `Last full CI pass (loopback ffprobe tests) ${when}.`);
}

async function checkClips(ctx) {
  const t = ctx.clipTools();
  const lc = ctx.flagOn('live-clips') ? 'on' : 'off';
  if (!t.py) return item('clips', 'warn', `Clips cannot be made: ${t.reason}. Live clipping is ${lc}.`, t.fix ? { fix: t.fix } : {});
  return item('clips', 'pass', `Clip maker ready. Live clipping is ${lc}.`);
}

const audioUnreadable = (why, note = '') => item('audio', 'fail', `Live audio state could not be read: ${why}. Check the mixer meters by ear before going live.${note}`, { unknown: true });

/** Default audio check: host.status audioHealth, else ctx.host.call(config.audio.method). Unreadable while the host is up = fail. */
export async function defaultAudioCheck(ctx) {
  if (ctx.hostKind !== 'host' || !ctx.hostStatus) return item('audio', 'warn', 'Audio state is unknown: the studio host is not answering.', { unknown: true });
  const muted = [];
  try {
    const mx = await ctx.host.call('mixer.list', {});
    for (const m of Array.isArray(mx?.sources) ? mx.sources : []) if (m && m.muted === true && m.mixers !== 0 && typeof m.name === 'string') muted.push(m.name.slice(0, 40));
  } catch { /* mixer not available: only the state call below */ }
  const mutedNote = muted.length ? ` Muted in the stream mix: ${muted.join(', ')}.` : '';
  // D297: the host reports live audio state in host.status.audioHealth ({ sources: [{ id, name, state }] }). The separate
  // method call stays as the fallback for a host without it.
  // The host is up, so audio state that cannot be read fails (D297 second opinion): it is the check that would have
  // caught the 2026-11-08 game audio loss. An old host without the method fails too; the override still goes live.
  let r = Array.isArray(ctx.hostStatus.audioHealth?.sources) ? ctx.hostStatus.audioHealth : null;
  if (!r) try { r = await ctx.host.call(ctx.config.audio.method, {}); } catch (e) {
    const missing = e?.code === 'RPC_-32601' || e?.code === 'NO_METHOD' || /method.not.found/i.test(String(e?.message));
    return audioUnreadable(missing ? 'the host cannot report it (update the studio)' : 'the host did not answer', mutedNote);
  }
  // An answer without a sources list (null, {}, a string) is unreadable state, not "no sources" (2026-11-09 failure
  // sims): it fails like a host that cannot report it. An empty list is a real answer (no device audio): warn below.
  if (!Array.isArray(r?.sources)) return audioUnreadable('the host\'s answer cannot be read', mutedNote);
  const sources = r.sources;
  if (!sources.length) return item('audio', 'warn', `The host reports no audio sources.${mutedNote}`);
  const nameOf = (s) => String(s?.name ?? s?.id ?? 'source').slice(0, 40);
  const bad = sources.filter((s) => ctx.config.audio.failStates.includes(s?.state));
  const weak = sources.filter((s) => ctx.config.audio.warnStates.includes(s?.state));
  if (bad.length) return item('audio', 'fail', `Not working: ${bad.map((s) => `${nameOf(s)} (${s.state})`).join(', ')}.${mutedNote}`);
  if (weak.length || muted.length) return item('audio', 'warn', `${weak.length ? `Check: ${weak.map((s) => `${nameOf(s)} (${s.state})`).join(', ')}.` : ''}${mutedNote}`.trim());
  return item('audio', 'pass', `${sources.length} audio source(s) working.`);
}

async function checkGpu(ctx) {
  const info = ctx.hostInfo;
  if (!info) return item('gpu', 'warn', 'The host does not report its GPU.');
  const adapter = typeof info.adapter === 'string' ? info.adapter : '';
  const pref = info.gpuPreference && typeof info.gpuPreference === 'object' ? info.gpuPreference.gpuPreference : null;
  if (!ctx.config.gpu.adapter.test(adapter)) return item('gpu', 'fail', `The studio renders on ${adapter || 'an unknown GPU'}, not the NVIDIA GPU. Set Windows graphics settings for the host to High performance and restart the studio.`);
  if (pref !== ctx.config.gpu.preference) return item('gpu', 'warn', 'Running on the NVIDIA GPU, but Windows has no High performance setting stored for the host; it may move to the other GPU after an update.');
  return item('gpu', 'pass', `Running on ${adapter} (Windows setting: High performance).`);
}

const CHECKS = { host: checkHost, credentials: checkCredentials, disk: checkDisk, encoders: checkEncoders, streamerbot: checkStreamerbot, speakerbot: checkSpeakerbot, loopback: checkLoopback, clips: checkClips, gpu: checkGpu };

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

/**
 * deps: { host, core?, config, flagOn(id), store(ref), listProcesses(), diskFree(dir), tcp(port, ms), botPorts,
 *         ciPass(), clipTools(), planTargets?, dataDir?, audioCheck?(ctx), now? }
 */
export async function runReadiness(deps) {
  const now = deps.now ?? Date.now;
  const host = deps.host;
  const hostKind = host.describe?.().kind ?? 'host';
  // Each first probe has the per-check timeout: a hung call answers null (host / outputs / GPU then say so).
  const safe = async (fn) => { try { return await withTimeout(Promise.resolve().then(fn), deps.config.checkTimeoutMs); } catch { return null; } };
  const [hostStatus, outputs, hostInfo, coreStatus] = await Promise.all([
    safe(() => host.call('host.status', {})),
    safe(() => host.call('outputs.status', {})),
    safe(() => host.call('host.info', {})),
    safe(async () => (deps.core && deps.core.describe().available ? deps.core.call('core.status', {}) : null)),
  ]);
  const sinks = Array.isArray(outputs?.sinks) ? outputs.sinks : [];
  const ctx = {
    ...deps, now, host, hostKind, hostStatus, outputs, hostInfo, coreStatus,
    streamSinks: sinks.filter((s) => s && s.kind === 'stream'),
    recordingsDir: typeof hostInfo?.recordingsDir === 'string' && hostInfo.recordingsDir ? hostInfo.recordingsDir : null,
    planTargets: deps.planTargets ?? [],
    botPorts: deps.botPorts ?? {},
  };
  const audio = deps.audioCheck ?? defaultAudioCheck;
  const hostUp = hostKind === 'host' && !!hostStatus;
  const run = (id) => withTimeout(Promise.resolve().then(() => (id === 'audio' ? audio : CHECKS[id])(ctx)), deps.config.checkTimeoutMs)
    .then((r) => (r && ['pass', 'warn', 'fail'].includes(r.status) ? { ...r, id, title: TITLES[id] } : item(id, 'warn', 'The check gave no answer.')))
    .catch((e) => {
      const why = e?.code === 'TIMEOUT' ? 'the check did not finish in time' : 'the check could not run';
      if (id === 'audio' && hostUp) return audioUnreadable(why);
      return item(id, 'warn', e?.code === 'TIMEOUT' ? 'The check did not finish in time.' : 'The check could not run.');
    });
  const items = await Promise.all(ITEMS.map(run));
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const i of items) counts[i.status]++;
  return { at: new Date(now()).toISOString(), ok: counts.fail === 0, counts, items };
}

/**
 * Credential targets of a live plan file: [{ id, transport, keyRef?, serverRef?, schemes? }] (stream targets only).
 * schemes (transport "auto" only): the rtmp/rtmps protocols of the sink's platform (data/platforms), [] if unknown.
 */
export function planTargets(file = DEFAULT_PLAN_FILE, platformsDir = path.join(REPO, 'data', 'platforms')) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const autoSchemes = (id) => {
      try {
        const cfg = typeof j.config === 'string' ? JSON.parse(readFileSync(path.resolve(REPO, j.config), 'utf8')) : j.config;
        const sink = [...(cfg?.sinks ?? []), ...(j.extraSinks ?? [])].find((x) => x.id === id);
        return sink ? liveSchemesOf(loadPlatforms(platformsDir)[sink.platform]) : [];
      } catch { return []; }
    };
    return Object.entries(j.targets ?? {}).filter(([, t]) => t && (t.keyRef || t.serverRef))
      .map(([id, t]) => ({
        id, transport: typeof t.transport === 'string' ? t.transport : null, ...(t.keyRef ? { keyRef: t.keyRef } : {}), ...(t.serverRef ? { serverRef: t.serverRef } : {}),
        ...(t.transport === 'auto' ? { schemes: autoSchemes(id) } : {}),
      }));
  } catch { return []; }
}

/** One short text for a confirm window (Qt and the page show it above the phrase). */
export function readinessSummary(r) {
  const lines = [`Ready to go live? ${r.counts.pass} ok, ${r.counts.warn} warning(s), ${r.counts.fail} problem(s).`];
  for (const i of r.items) if (i.status !== 'pass') lines.push(`${i.status === 'fail' ? 'PROBLEM' : 'Warning'} - ${i.title}: ${i.message}`.slice(0, 300));
  if (!r.ok) lines.push(`Fix the problems first, or type "${OVERRIDE_PHRASE}" to go live anyway (the override is logged).`);
  return lines.join('\n');
}

/** Appends one override line (ids and statuses only, no messages) to <dataDir>/logs/readiness-overrides.jsonl. */
export function logOverride(dataDir, r, at = new Date()) {
  if (typeof dataDir !== 'string') return false;
  const dir = path.join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const line = { at: at.toISOString(), checkedAt: r.at, failed: r.items.filter((i) => i.status === 'fail').map((i) => i.id), warned: r.items.filter((i) => i.status === 'warn').map((i) => i.id) };
  appendFileSync(path.join(dir, OVERRIDE_LOG), `${JSON.stringify(line)}\n`);
  return true;
}

/** A whole run's deadline: the probes and then the checks, each bounded by checkTimeoutMs, plus a margin. */
export const readinessDeadlineMs = (config) => 2 * config.checkTimeoutMs + 1000;

/**
 * Cached runner: run({ maxAgeMs }) reuses a result younger than maxAgeMs; concurrent calls share one run. A run that
 * passes its deadline rejects (code TIMEOUT) and is dropped, so the next call starts a new one.
 */
export function createReadiness(deps) {
  let last = null; let lastT = -Infinity; let inflight = null;
  const now = deps.now ?? Date.now;
  return {
    config: deps.config,
    async run({ maxAgeMs = 0 } = {}) {
      if (last && now() - lastT <= maxAgeMs) return last;
      if (inflight) return inflight;
      const p = withTimeout(Promise.resolve().then(() => runReadiness(deps)), deps.deadlineMs ?? readinessDeadlineMs(deps.config))
        .then((r) => { last = r; lastT = now(); return r; })
        .finally(() => { if (inflight === p) inflight = null; });
      inflight = p;
      return p;
    },
    last: () => last,
  };
}
