// SPDX-License-Identifier: GPL-3.0-or-later
// Stream recovery after a host crash (D303 proposed, flag `stream-recovery`, off by default). Node stdlib only.
//
// Authority (one owner): the launcher holds the go-live authority in memory (createLiveAuthority); nothing on disk is
// read for a decision. The UI server, its only writer, talks to it over the Node IPC channel the launcher opens
// (authorityClient / serveAuthority):
//   begin            before a Start stream click's stream.start goes to the host -> the current generation g
//   arm(g)           after the host accepted that start; refused when any revoke happened since begin (a newer Stop
//                    wins over a slow Start)
//   revoke(reason)   before a confirmed Stop or End all goes to the host. The generation goes up at once (the
//                    authority is gone from that moment); the answer comes only after an in-flight recovery start has
//                    returned, so the user's stop always reaches the host after it and wins
// Fail closed: if a revoke is not answered, the UI server closes the channel; the launcher closes the authority for the
// rest of its session when the channel closes or the UI server exits. A recovery whose start was overtaken by a
// revoke stops those sinks again itself. The launcher's live-test guard excludes the sinks it stops (exclude) and
// revokes before stopping everything. A new launcher has a new, unarmed authority, so a launcher restart never goes
// live by itself: the old host and its streams ended with the old launcher, and only the user can start a new
// broadcast. <dataDir>/live/stream-authority.json mirrors the state for people and tests only (never read back).
// The launcher restarts exactly the stream sinks that its last outputs.status poll saw starting/live/retrying before
// the crash, and only when: the flag is on, the authority is armed, the restarted host is ready within maxGapMs of the
// crash and fewer than maxRecoveries recoveries happened in windowMs (data/live/recovery.json). The decision and the
// stream.start run inside the authority's serialized section. Each decision is one event in
// <dataDir>/live/stream-recovery.json (last 20; labels and plain text, no keys, no URLs), which the UI server shows on
// the control page (events of this launcher session: UJWALAM_LIVE_SESSION).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECOVERY_FLAG = 'stream-recovery';
export const RECOVERY_CONFIG_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'live', 'recovery.json');
export const LIVE_DIR = 'live';
export const AUTHORITY_FILE = 'stream-authority.json';
export const AUTHORITY_MSG = 'live-authority';
export const STATUS_FILE = 'stream-recovery.json';
export const SESSION_ENV = 'UJWALAM_LIVE_SESSION';
export const SESSION_RE = /^[0-9a-f]{16,64}$/;
const EVENTS_KEPT = 20;
const ACTIVE = new Set(['starting', 'live', 'retrying']);
const PLATFORM = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

const num = (v, name, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`recovery config: bad ${name}`);
  return v;
};

/** Reads and checks data/live/recovery.json. Throws on a malformed file. */
export function loadRecoveryConfig(file = RECOVERY_CONFIG_FILE) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return {
    maxRecoveries: num(j.maxRecoveries, 'maxRecoveries', 0, 10),
    windowMs: num(j.windowMs, 'windowMs', 1000, 24 * 3600_000),
    maxGapMs: num(j.maxGapMs, 'maxGapMs', 1000, 600_000),
    startCheckMs: num(j.startCheckMs, 'startCheckMs', 0, 120_000),
    pollMs: num(j.pollMs, 'pollMs', 50, 5000),
  };
}

/** "YouTube H", "Twitch", ...: a sink's platform name plus its canvas when the id ends in -h / -v. */
export function sinkLabel(id, platform) {
  const sid = String(id ?? '').slice(0, 64);
  const p = PLATFORM[platform] ?? null;
  if (!p) return sid;
  const m = /[-_]([hv])$/i.exec(sid);
  return m ? `${p} ${m[1].toUpperCase()}` : p;
}

/** Labels of the given sink ids from an outputs.status answer (unknown ids keep their id). */
export function labelsOf(outputs, ids) {
  const sinks = Array.isArray(outputs?.sinks) ? outputs.sinks : [];
  return ids.map((id) => sinkLabel(id, sinks.find((s) => s?.id === id)?.platform));
}

const liveDir = (dataDir) => path.join(dataDir, LIVE_DIR);
function writeAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Launcher: the go-live authority (in memory, one per launcher). onChange(state) is called on every change (mirror).
 * run(fn): fn(state) runs alone (serialized with other runs; revoke answers wait for it) and returns
 * { value, revoked, excluded }: revoked when a revoke or close happened while fn ran.
 */
export function createLiveAuthority({ onChange = () => {} } = {}) {
  let gen = 0; let armed = false; let reason = 'none'; let closed = false;
  const excluded = new Set();
  let chain = Promise.resolve();
  const state = () => ({ gen, armed: armed && !closed, reason, closed, excluded: [...excluded] });
  const changed = () => { try { onChange(state()); } catch { /* the mirror is best effort */ } };
  const settled = () => chain.then(() => undefined);
  return {
    state,
    /** -> the generation a start began in, or null when closed. */
    begin: () => (closed ? null : gen),
    /** After the host accepted a confirmed start that began in generation g. */
    arm(g) {
      if (closed || g !== gen) return { armed: false, gen };
      armed = true; reason = 'stream.start'; excluded.clear();
      changed();
      return { armed: true, gen };
    },
    /** Takes effect at once; resolves after the run in flight (if any) has finished. */
    revoke(why) {
      gen += 1; armed = false; reason = String(why ?? 'revoked').slice(0, 40);
      changed();
      return settled().then(() => ({ gen }));
    },
    /** Sinks stopped on purpose (live-test guard): never restarted until the next confirmed start. */
    exclude(ids) {
      for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string') excluded.add(id);
      changed();
      return settled();
    },
    /** Fail closed for the rest of this launcher session (the UI server's channel is gone). */
    close(why) {
      if (closed) return;
      closed = true; gen += 1; armed = false; reason = String(why ?? 'closed').slice(0, 40);
      changed();
    },
    run(fn) {
      const p = chain.then(async () => {
        const g = gen;
        const value = await fn(state());
        return { value, revoked: closed || gen !== g, excluded: [...excluded] };
      });
      chain = p.then(() => undefined, () => undefined);
      return p;
    },
  };
}

/** Launcher: answers the UI server's authority requests on its IPC channel; a closed channel closes the authority. */
export function serveAuthority(child, authority) {
  child.on('message', (m) => {
    if (m?.t !== AUTHORITY_MSG || !Number.isInteger(m.id)) return;
    const reply = (r) => { try { if (child.connected) child.send({ t: AUTHORITY_MSG, id: m.id, ...r }); } catch { /* the UI server times out and fails closed */ } };
    if (m.op === 'begin') reply({ gen: authority.begin() });
    else if (m.op === 'arm') reply(authority.arm(m.gen));
    else if (m.op === 'revoke') authority.revoke(m.reason).then(reply, () => reply({ gen: null }));
  });
  const gone = () => authority.close('ui-link-lost');
  child.once('disconnect', gone);
  child.once('exit', gone);
}

/**
 * UI server: the launcher's authority over this process's IPC channel, or null without one (started by hand, tests).
 * revoke() never throws: when the launcher does not answer within timeoutMs it closes the channel (the launcher then
 * closes the authority) and returns false. begin()/arm() failures only mean the start is not armed.
 */
export function authorityClient({ proc = process, timeoutMs = 10_000 } = {}) {
  if (typeof proc.send !== 'function' || proc.connected !== true) return null;
  try { proc.channel?.unref?.(); } catch { /* keeps the process alive only while it has other work */ }
  let seq = 0;
  const waiting = new Map();
  proc.on('message', (m) => {
    if (m?.t !== AUTHORITY_MSG || !waiting.has(m.id)) return;
    const done = waiting.get(m.id); waiting.delete(m.id); done(m);
  });
  const ask = (op, extra = {}) => new Promise((resolve, reject) => {
    if (proc.connected !== true) { reject(new Error('launcher link closed')); return; }
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('launcher did not answer')); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    try { proc.send({ t: AUTHORITY_MSG, id, op, ...extra }); } catch (e) { clearTimeout(t); waiting.delete(id); reject(e); }
  });
  const failClosed = () => { try { if (proc.connected) proc.disconnect(); } catch { /* already gone: the launcher closed it */ } };
  return {
    async begin() { try { const m = await ask('begin'); return Number.isInteger(m.gen) ? m.gen : null; } catch { return null; } },
    async arm(gen) { if (!Number.isInteger(gen)) return false; try { return (await ask('arm', { gen })).armed === true; } catch { return false; } },
    async revoke(reason) {
      try { const m = await ask('revoke', { reason }); if (Number.isInteger(m.gen)) return true; } catch { /* below */ }
      failClosed();
      return false;
    },
  };
}

/** Launcher: the diagnostic mirror of the authority (never read for a decision). Best effort. */
export function writeAuthorityMirror(dataDir, session, st) {
  try { writeAtomic(path.join(liveDir(dataDir), AUTHORITY_FILE), { v: 1, session, ...st, at: new Date().toISOString() }); } catch { /* diagnostics only */ }
}

/** Recovery decisions (pure; tested with a fake clock). One instance per launcher. */
export function recoveryPolicy(cfg) {
  const done = [];
  return {
    /** -> { restart: [ids], reason, attempt?, max?, recoveries? }. Counts a recovery only when it restarts. */
    decide({ now, crashAt, flagOn, authority, streams }) {
      const all = Array.isArray(streams) ? streams.filter((s) => typeof s === 'string') : [];
      if (!all.length) return { restart: [], reason: 'none-live' };
      if (!flagOn) return { restart: [], reason: 'flag-off' };
      if (!authority || authority.armed !== true) {
        const why = authority?.closed ? 'authority-lost' : !authority || authority.reason === 'none' ? 'no-confirmation' : authority.reason === 'recovery-limit' ? 'limit-earlier' : 'stopped';
        return { restart: [], reason: why };
      }
      const off = new Set(Array.isArray(authority.excluded) ? authority.excluded : []);
      const ids = all.filter((id) => !off.has(id));
      if (!ids.length) return { restart: [], reason: 'stopped' };
      if (!(now - crashAt <= cfg.maxGapMs)) return { restart: [], reason: 'too-late' };
      while (done.length && now - done[0] > cfg.windowMs) done.shift();
      if (done.length >= cfg.maxRecoveries) return { restart: [], reason: 'limit', recoveries: done.length };
      done.push(now);
      return { restart: ids, reason: 'restart', attempt: done.length, max: cfg.maxRecoveries };
    },
  };
}

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const list = (a) => a.join(', ');
const WHY = {
  'flag-off': 'stream recovery is off (feature flag stream-recovery)',
  'no-confirmation': 'no Start stream click from this session was found',
  stopped: 'you had stopped them',
  'too-late': 'the host took too long to come back',
  config: 'the recovery settings (data/live/recovery.json) could not be read',
  'host-gave-up': 'the host crashed too often and Ujwalam is stopping',
  'project-failed': 'the scenes could not be loaded into the restarted host',
  'start-failed': 'the host did not start them',
  'authority-lost': 'the control page lost its link to the launcher, so a Stop could not be confirmed',
  'limit-earlier': 'the crash limit was reached earlier; go live again from the control page',
};

/** Plain text for the control page and the log (local time of this PC). */
export function eventText(ev) {
  const at = hhmm(Date.parse(ev.crashAt));
  if (ev.result === 'restarted') return `Host crashed at ${at}, streams restarted: ${list(ev.restarted)}`;
  if (ev.result === 'cancelled') return `Host crashed at ${at}; streams started again, then stopped because you pressed Stop or End all: ${list(ev.failed)}`;
  if (ev.result === 'partial') return `Host crashed at ${at}, streams restarted: ${list(ev.restarted)}; NOT restarted: ${list(ev.failed)} (start them from the control page)`;
  if (ev.reason === 'limit') return `Host crashed at ${at} again (${ev.recoveries} stream restart(s) already in ${Math.round(ev.windowMs / 60000)} min): streams NOT restarted: ${list(ev.streams)}. Check the host log before going live again.`;
  return `Host crashed at ${at}; streams NOT restarted (${WHY[ev.reason] ?? ev.reason}): ${list(ev.streams)}`;
}

/** Launcher: appends one recovery event (keeps the last EVENTS_KEPT). Best effort. Returns the event with text. */
export function appendRecoveryEvent(dataDir, ev) {
  const full = { ...ev, text: eventText(ev) };
  try {
    const file = path.join(liveDir(dataDir), STATUS_FILE);
    let events = [];
    try { const j = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(j.events)) events = j.events; } catch { /* first event */ }
    writeAtomic(file, { v: 1, events: [...events, full].slice(-EVENTS_KEPT) });
  } catch { /* the log line still says it */ }
  return full;
}

/** UI server: the newest recovery event of this session for the status snapshot, or null. Strings capped. */
export function readRecoveryStatus(dataDir, session) {
  if (typeof dataDir !== 'string' || typeof session !== 'string') return null;
  try {
    const j = JSON.parse(readFileSync(path.join(liveDir(dataDir), STATUS_FILE), 'utf8'));
    const mine = (Array.isArray(j.events) ? j.events : []).filter((e) => e && e.session === session);
    const e = mine.at(-1);
    if (!e) return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    return { at: str(e.at, 40), crashAt: str(e.crashAt, 40), result: str(e.result, 16), reason: str(e.reason, 24), text: str(e.text, 400), count: mine.length };
  } catch { return null; }
}

/** Stream sink ids that were starting/live/retrying in an outputs.status answer. */
export const activeStreams = (outputs) => (Array.isArray(outputs?.sinks) ? outputs.sinks : [])
  .filter((s) => s?.kind === 'stream' && ACTIVE.has(s.state) && typeof s.id === 'string').map((s) => s.id);

/** After stream.start: polls outputs.status until every id is active or startCheckMs passes. -> { up, down } ids. */
export async function waitStreamsUp(call, ids, { startCheckMs, pollMs }, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const until = now() + startCheckMs;
  let up = [];
  for (;;) {
    try { const a = new Set(activeStreams(await call('outputs.status'))); up = ids.filter((id) => a.has(id)); } catch { /* host busy: next poll */ }
    if (up.length === ids.length || now() >= until) return { up, down: ids.filter((id) => !up.includes(id)) };
    await sleep(pollMs);
  }
}
