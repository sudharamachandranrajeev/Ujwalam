// SPDX-License-Identifier: GPL-3.0-or-later
// Stream recovery after a host crash (D303 proposed, flag `stream-recovery`, off by default). Node stdlib only.
//
// Authority: the user's typed "yes, on air" on the control page. The UI server writes it, the launcher reads it:
//   <dataDir>/live/stream-intent.json  { v, session, armed, reason, at }   (written by the UI server only)
//     armed true   after a confirmed stream.start the host accepted
//     armed false  BEFORE a confirmed stream.stop or End all reaches the host (a stop pressed while the host is down
//                  still counts), and by the launcher when the recovery limit is reached
//   session: a random id the launcher makes at every start and gives the UI server by environment
//   (UJWALAM_LIVE_SESSION). The launcher deletes the file at start and only honours a record of its own session, so
//   a launcher restart never goes live by itself: the old host and its streams ended with the old launcher, and
//   only the user can start a new broadcast.
// The launcher restarts exactly the stream sinks that its last outputs.status poll saw starting/live/retrying before
// the crash, and only when: the flag is on, the intent of this session is armed, the restarted host is ready within
// maxGapMs of the crash, and fewer than maxRecoveries recoveries happened in windowMs (data/live/recovery.json).
// Each decision is one event in <dataDir>/live/stream-recovery.json (last 20; labels and plain text, no keys, no
// URLs), which the UI server shows on the control page.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECOVERY_FLAG = 'stream-recovery';
export const RECOVERY_CONFIG_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'live', 'recovery.json');
export const LIVE_DIR = 'live';
export const INTENT_FILE = 'stream-intent.json';
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

/** UI server: records the go-live authority (armed) or its end. Throws when it cannot be written. */
export function writeIntent(dataDir, { session, armed, reason, at = new Date() }) {
  if (typeof session !== 'string' || !SESSION_RE.test(session)) throw new Error('stream intent: bad session');
  writeAtomic(path.join(liveDir(dataDir), INTENT_FILE), { v: 1, session, armed: armed === true, reason: String(reason ?? '').slice(0, 40), at: at.toISOString() });
}

/** The intent record, or null when missing or malformed. */
export function readIntent(dataDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(liveDir(dataDir), INTENT_FILE), 'utf8'));
    if (j?.v !== 1 || typeof j.session !== 'string' || !SESSION_RE.test(j.session) || typeof j.armed !== 'boolean') return null;
    return { session: j.session, armed: j.armed, reason: typeof j.reason === 'string' ? j.reason.slice(0, 40) : '', at: typeof j.at === 'string' ? j.at.slice(0, 40) : null };
  } catch { return null; }
}

/** Launcher start: an intent from an earlier launcher never carries over. */
export function clearIntent(dataDir) {
  try { rmSync(path.join(liveDir(dataDir), INTENT_FILE), { force: true }); } catch { /* the session check still refuses it */ }
}

/** Recovery decisions (pure; tested with a fake clock). One instance per launcher. */
export function recoveryPolicy(cfg) {
  const done = [];
  return {
    /** -> { restart: [ids], reason, attempt?, max?, recoveries? }. Counts a recovery only when it restarts. */
    decide({ now, crashAt, flagOn, intent, session, streams }) {
      const ids = Array.isArray(streams) ? streams.filter((s) => typeof s === 'string') : [];
      if (!ids.length) return { restart: [], reason: 'none-live' };
      if (!flagOn) return { restart: [], reason: 'flag-off' };
      if (!intent || typeof session !== 'string' || intent.session !== session) return { restart: [], reason: 'no-confirmation' };
      if (intent.armed !== true) return { restart: [], reason: 'stopped' };
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
  'no-confirmation': 'no "yes, on air" from this session was found',
  stopped: 'you had stopped them',
  'too-late': 'the host took too long to come back',
  config: 'the recovery settings (data/live/recovery.json) could not be read',
  'host-gave-up': 'the host crashed too often and Ujwalam is stopping',
  'project-failed': 'the scenes could not be loaded into the restarted host',
  'start-failed': 'the host did not start them',
};

/** Plain text for the control page and the log (local time of this PC). */
export function eventText(ev) {
  const at = hhmm(Date.parse(ev.crashAt));
  if (ev.result === 'restarted') return `Host crashed at ${at}, streams restarted: ${list(ev.restarted)}`;
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
