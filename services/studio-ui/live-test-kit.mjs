// SPDX-License-Identifier: GPL-3.0-or-later
// Live test kit (flag `live-test-kit`, off by default, D305 proposed). Node stdlib only. Closes the gaps for a
// one-hour test stream (AGENTS.md "Live stream testing"):
//   - liveAlerts(): plain-words lines for the studio window and the control page: audio sources that stopped
//     (host.status audioHealth warnings), the newest stream recovery event of this session (stream-recovery.mjs),
//     a reminder to start the user's own Streamer.bot test action while the stream is young, and the result of the
//     feedback collection after the stream.
//   - createFeedbackAutoCollect(): when a stream ends (live true -> false), collects the viewers' replies read-only
//     from event-core.db into feedback/YYYY-MM-DD-stream-feedback.md (gitignored) with tools/collect-stream-feedback.mjs.
// Ujwalam never posts in chat, never speaks and never triggers a Streamer.bot action (D192: the connection stays
// read-only; a DoAction write path is BM8, P15, after a security review). The announcement and the chat question come
// from the user's own Streamer.bot action; its name and the texts live in data/live/test-kit.json, never in code.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_KIT_FLAG = 'live-test-kit';
export const TEST_KIT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'live', 'test-kit.json');
const MAX_ALERTS = 12;

const text = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`test kit config: bad ${name}`);
  return v;
};
const int = (v, name, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`test kit config: bad ${name}`);
  return v;
};

/** Reads and checks data/live/test-kit.json. Throws on a malformed file. */
export function loadTestKitConfig(file = TEST_KIT_FILE) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const cfg = {
    streamerbotAction: text(j.streamerbotAction, 'streamerbotAction', 100),
    announcement: text(j.announcement, 'announcement', 300),
    question: text(j.question, 'question', 300),
    questionPrefix: text(j.questionPrefix, 'questionPrefix', 100),
    marker: text(j.marker, 'marker', 16),
    windowMin: int(j.windowMin, 'windowMin', 1, 60),
    reminderMin: int(j.reminderMin, 'reminderMin', 0, 120),
  };
  if (!cfg.question.toLowerCase().startsWith(cfg.questionPrefix.toLowerCase())) throw new Error('test kit config: question must start with questionPrefix');
  return cfg;
}

// Host audio warnings are "<Name> audio missing" style lines (app/host/src/audio_health.h); kept as they are, with a
// plain-words lead so the line says what to do.
const AUDIO_HINT = 'Ujwalam is restarting that sound; if it stays silent, check the device and its cable';

/**
 * Pure. snap: the status snapshot ({ host: { live, audioHealth: { warnings } }, recovery: { result, text, count } }).
 * opts: { kit (loadTestKitConfig), liveSinceMs (when this stream went live, or null), nowMs, feedback (last
 * collection result or null) }. Returns [{ id, level: 'error'|'warn'|'info', text }] (newest-relevant first, capped).
 */
export function liveAlerts(snap, opts = {}) {
  const out = [];
  const h = snap?.host ?? {};
  const warnings = Array.isArray(h.audioHealth?.warnings) ? h.audioHealth.warnings.filter((w) => typeof w === 'string' && w.trim()) : [];
  warnings.slice(0, 8).forEach((w, i) => out.push({ id: `audio-${i}`, level: 'warn', text: `Sound problem: ${w.slice(0, 96)}. ${AUDIO_HINT}.` }));
  const rv = snap?.recovery;
  if (rv && typeof rv.text === 'string' && rv.text) {
    const level = rv.result === 'restarted' ? 'warn' : 'error';
    out.unshift({ id: 'recovery', level, text: rv.text.slice(0, 400) });
  }
  const kit = opts.kit ?? null;
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (kit && h.live === true && Number.isFinite(opts.liveSinceMs) && now - opts.liveSinceMs <= kit.reminderMin * 60_000) {
    out.push({ id: 'test-action', level: 'info',
      text: `Test stream: start your Streamer.bot action "${kit.streamerbotAction}" now (it posts the feedback question and has Speaker.bot read the announcement). Ujwalam does not post or speak.` });
  }
  const fb = opts.feedback ?? null;
  if (fb && h.live !== true) {
    out.push(fb.ok
      ? { id: 'feedback', level: 'info', text: `Viewer feedback saved: ${fb.total} message(s) (YouTube ${fb.counts.youtube}, Twitch ${fb.counts.twitch}, Kick ${fb.counts.kick}) in feedback/${fb.name}` }
      : { id: 'feedback', level: 'warn', text: `Viewer feedback was not collected: ${String(fb.error).slice(0, 160)}. Run tools/collect-stream-feedback.mjs by hand.` });
  }
  return out.slice(0, MAX_ALERTS);
}

const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Tracks live on/off and collects feedback when a stream ends.
 * opts: { collect (collectFeedback from tools/collect-stream-feedback.mjs), dbFile, outDir, kit () -> config,
 *         enabled () -> bool (the flag), now?, log? }
 * observe(live) is called with every status poll; it never throws and never blocks the poll (the collection runs on
 * the next turn of the event loop). Returns { observe, liveSince, last }.
 */
export function createFeedbackAutoCollect(opts) {
  const now = opts.now ?? Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let wasLive = null; let since = null; let last = null; let running = false;
  function run(from, to) {
    if (running) return;
    running = true;
    setImmediate(() => {
      try {
        const kit = opts.kit();
        const r = opts.collect({ dbFile: opts.dbFile, date: localDate(from), since: new Date(from).toISOString(), until: new Date(to).toISOString(),
          marker: kit.marker, windowMin: kit.windowMin, questionPrefix: kit.questionPrefix, outDir: opts.outDir });
        last = { ok: true, at: to, total: r.total, added: r.added, counts: r.counts, name: path.basename(r.file) };
        log(`live test kit: viewer feedback ${r.total} message(s) -> feedback/${path.basename(r.file)}`);
      } catch (e) {
        last = { ok: false, at: to, error: String(e?.message ?? e).slice(0, 200) };
        log(`live test kit: feedback not collected (${last.error})`);
      } finally { running = false; }
    });
  }
  function observe(live) {
    if (typeof live !== 'boolean') return;
    const t = now();
    if (live && wasLive !== true) { since = t; last = null; }
    if (!live && wasLive === true && since !== null) {
      let on = false;
      try { on = opts.enabled() === true; } catch { on = false; }
      if (on) run(since, t);
      since = null;
    }
    wasLive = live;
  }
  return { observe, liveSince: () => since, last: () => last };
}
