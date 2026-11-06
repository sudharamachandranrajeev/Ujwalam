// SPDX-License-Identifier: GPL-3.0-or-later
// F6 live marker producers (v1). Node stdlib only.
//
// Two producers write host clip markers (app/host/src/moments.h, marker.add) while the feature flag 'live-markers'
// is on (data/flags.json, default off; read about once a second, so a flip on the control page takes effect live):
//   source 'chat'   a "clip it" style message (chat intent), at most one marker per peaks.minGapSec; and a chat-speed
//                   spike: the rolling message count over chat.windowSec reaches max(chat.minMessages, median * ratio),
//                   the median being the running median of that rolling count, at most one marker per minGapSec.
//   source 'audio'  an audio peak: the per-second level (the highest host meter peak, dBFS, over the counted sources,
//                   from mixer.list) has a z-score >= audio.zThreshold against the running median/MAD of the voiced
//                   seconds (level > audio.floorLufs; spread at least audio.minSpread; at least audio.minVoicedSec
//                   voiced seconds first), at most one marker per minGapSec.
// The rules and thresholds are the post-stream ones (services/clip/clip_rank.py chat_events / loudness_events), read
// from the same file, data/clip/ranking.json. Only the live-only values (meter sample rate, sources, baseline length,
// host timeout) are in data/clip/live-markers.json. Both files are status 'proposed' until the user approves them.
// Post-stream picks the strongest peak inside each minGapSec (it sees the future); live is causal: the first crossing
// fires and the next minGapSec of that kind is suppressed (counted).
//
// Chat text is untrusted data: it is only tested against the intent pattern in memory. No chat text, name or id is
// kept, logged or written; marker notes are built from counts only.
// Live path: nothing here can affect the stream. Host calls are fire-and-forget with a timeout, at most MAX_INFLIGHT
// marker calls and one meter read at a time; every failure is counted, never thrown. The bus handler is synchronous and
// O(1) per message; the bus gives it its own bounded queue.
//
//   const lm = createLiveMarkers({ bus: core.bus, flags, host: createHostLink({ discoveryFile, token }) });
//   lm.stats(); lm.stop();

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HostClient, readDiscovery } from '../../app/host/lib/client.mjs';

export const FLAG = 'live-markers';
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'clip');
export const RANKING_FILE = path.join(DATA_DIR, 'ranking.json');
export const LIVE_FILE = path.join(DATA_DIR, 'live-markers.json');
export const MAX_INFLIGHT = 4;
const TICK_MS = 1000;
const LOG_EVERY_MS = 60_000;

function num(v, name, { min = -Infinity, int = false, gt } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (gt !== undefined && !(v > gt)) || (int && !Number.isInteger(v))) {
    throw new Error(`live-markers config: bad ${name}`);
  }
  return v;
}

/** Reads ranking.json (shared rules) and live-markers.json (live-only values). Throws on a missing or bad value. */
export function loadLiveMarkerConfig({ rankingFile = RANKING_FILE, liveFile = LIVE_FILE } = {}) {
  const r = JSON.parse(readFileSync(rankingFile, 'utf8'));
  const l = JSON.parse(readFileSync(liveFile, 'utf8'));
  const rc = r?.chat ?? {}, ra = r?.audio ?? {}, lc = l?.chat ?? {}, la = l?.audio ?? {};
  if (typeof rc.intentPattern !== 'string' || !rc.intentPattern) throw new Error('live-markers config: bad chat.intentPattern');
  new RegExp(rc.intentPattern, 'i'); // throws on a pattern JavaScript cannot compile
  const sources = la.sources;
  if (sources !== null && sources !== undefined && !(Array.isArray(sources) && sources.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 128))) {
    throw new Error('live-markers config: bad audio.sources');
  }
  return Object.freeze({
    status: Object.freeze({ ranking: String(r.status ?? 'unknown'), live: String(l.status ?? 'unknown') }),
    minGapSec: num(r?.peaks?.minGapSec, 'peaks.minGapSec', { min: 1 }),
    chat: Object.freeze({
      intentPattern: rc.intentPattern,
      windowSec: num(rc.windowSec, 'chat.windowSec', { min: 1, int: true }),
      minMessages: num(rc.minMessages, 'chat.minMessages', { min: 1 }),
      ratio: num(rc.ratio, 'chat.ratio', { gt: 0 }),
      baselineSec: num(lc.baselineSec, 'live chat.baselineSec', { min: 1, int: true }),
      warmupSec: num(lc.warmupSec ?? 0, 'live chat.warmupSec', { min: 0, int: true }),
    }),
    audio: Object.freeze({
      floor: num(ra.floorLufs, 'audio.floorLufs'),
      zThreshold: num(ra.zThreshold, 'audio.zThreshold', { gt: 0 }),
      minSpread: num(ra.minSpread, 'audio.minSpread', { gt: 0 }),
      minVoicedSec: num(ra.minVoicedSec ?? 10, 'audio.minVoicedSec', { min: 1, int: true }),
      sampleMs: num(la.sampleMs, 'live audio.sampleMs', { min: 50, int: true }),
      sources: sources ? Object.freeze([...sources]) : null,
      baselineSec: num(la.baselineSec, 'live audio.baselineSec', { min: 1, int: true }),
      hostTimeoutMs: num(la.hostTimeoutMs, 'live audio.hostTimeoutMs', { min: 100, int: true }),
    }),
  });
}

/** A bounded FIFO of numbers with a sorted copy, for a running median (and MAD on demand). */
export function createRollingWindow(cap) {
  const fifo = [];
  const sorted = [];
  const lower = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
  const medianOf = (a) => { const n = a.length; if (!n) return 0; const h = n >> 1; return n % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };
  return {
    push(x) {
      fifo.push(x);
      sorted.splice(lower(x), 0, x);
      if (fifo.length > cap) sorted.splice(lower(fifo.shift()), 1);
    },
    size: () => fifo.length,
    median: () => medianOf(sorted),
    /** Median absolute deviation around m (unscaled). */
    mad(m) { return medianOf(sorted.map((x) => Math.abs(x - m)).sort((a, b) => a - b)); },
  };
}

const r2 = (x) => Math.round(x * 100) / 100;

/** Chat intent + chat speed. message(text, nowMs) -> marker|null; tick(nowMs) -> marker|null (call once per second). */
export function createChatDetector(cfg, minGapSec) {
  const rx = new RegExp(cfg.intentPattern, 'i'); // no g flag: test() keeps no state
  const gapMs = minGapSec * 1000;
  const counts = []; // last windowSec per-second counts
  let cur = 0, roll = 0, anyChat = false;
  let lastIntent = -Infinity, lastSpeed = -Infinity, ticks = 0;
  const hist = createRollingWindow(cfg.baselineSec);
  const s = { messages: 0, intents: 0, intentSuppressed: 0, speedSuppressed: 0, speedWarmup: 0 };
  return {
    message(text, nowMs) {
      s.messages++;
      cur++;
      if (typeof text !== 'string' || !rx.test(text)) return null;
      s.intents++;
      if (nowMs - lastIntent < gapMs) { s.intentSuppressed++; return null; }
      lastIntent = nowMs;
      return { source: 'chat', kind: 'chat.intent', note: 'chat: clip request' };
    },
    tick(nowMs) {
      ticks++;
      counts.push(cur);
      roll += cur;
      if (counts.length > cfg.windowSec) roll -= counts.shift();
      if (cur > 0) anyChat = true;
      cur = 0;
      hist.push(roll);
      if (!anyChat) return null; // post-stream: no chat at all, no speed events
      const base = hist.median();
      const need = Math.max(cfg.minMessages, base * cfg.ratio);
      if (roll < need) return null;
      // Warm-up (user 2026-11-06): chat starts from zero, so the baseline is ~0 for the first minutes and the opening
      // chat burst would read as a spike every stream. Speed markers wait warmupSec ticks; the baseline still learns.
      if (ticks <= (cfg.warmupSec ?? 0)) { s.speedWarmup++; return null; }
      if (nowMs - lastSpeed < gapMs) { s.speedSuppressed++; return null; }
      lastSpeed = nowMs;
      return { source: 'chat', kind: 'chat.velocity', note: `chat: speed spike, ${roll} messages in ${cfg.windowSec} s (baseline ${r2(base)}, need ${r2(need)})` };
    },
    stats: () => ({ ...s }),
  };
}

/** Audio peak. sample(peakDb) any number of times per second; tick(nowMs) -> marker|null once per second. */
export function createAudioDetector(cfg, minGapSec) {
  const gapMs = minGapSec * 1000;
  const hist = createRollingWindow(cfg.baselineSec);
  let secMax = -Infinity, last = -Infinity;
  const s = { samples: 0, voicedSec: 0, suppressed: 0 };
  return {
    sample(db) {
      if (typeof db === 'number' && Number.isFinite(db)) { s.samples++; if (db > secMax) secMax = db; }
    },
    tick(nowMs) {
      const x = secMax;
      secMax = -Infinity;
      if (!(x > cfg.floor)) return null; // silent seconds are not part of the baseline (post-stream: x <= floor skipped)
      hist.push(x);
      s.voicedSec++;
      if (hist.size() < cfg.minVoicedSec) return null;
      const med = hist.median();
      // spread >= minSpread, so (x - med) / minSpread is an upper bound of z: the MAD is computed only when it can matter
      if ((x - med) / cfg.minSpread < cfg.zThreshold) return null;
      const spread = Math.max(cfg.minSpread, hist.mad(med) * 1.4826);
      const z = (x - med) / spread;
      if (z < cfg.zThreshold) return null;
      if (nowMs - last < gapMs) { s.suppressed++; return null; }
      last = nowMs;
      return { source: 'audio', kind: 'audio.peak', note: `audio: peak ${r2(x)} dBFS, z ${r2(z)} (median ${r2(med)})` };
    },
    stats: () => ({ ...s }),
  };
}

/** Level of one mixer.list answer: the highest finite peakDb over the counted sources (active, not muted). */
export function levelOf(list, sources = null) {
  let best = -Infinity;
  for (const m of Array.isArray(list?.sources) ? list.sources : []) {
    if (!m || m.muted === true || m.active === false || typeof m.peakDb !== 'number' || !Number.isFinite(m.peakDb)) continue;
    if (sources && !sources.includes(m.id) && !sources.includes(m.audioSource)) continue;
    if (m.peakDb > best) best = m.peakDb;
  }
  return best;
}

/** A narrow host link: only marker.add and mixer.list. token is the host markers token (UJWALAM_HOST_MARKERS_TOKEN),
 *  which the host itself limits to those two methods (rpc_server.h Role::Markers). The token stays in this closure. The discovery file is
 *  re-read after a failure (a restarted host has a new port), at most once per retryMs. */
export function createHostLink({ discoveryFile, token, timeoutMs = 2000, retryMs = 2000, now = () => performance.now() }) {
  if (typeof discoveryFile !== 'string' || !discoveryFile) throw new Error('host link: discoveryFile required');
  if (!/^[0-9a-f]{64}$/.test(token ?? '')) throw new Error('host link: token must be 64 hex characters');
  let client = null;
  let retryAt = -Infinity;
  const get = () => {
    if (client) return client;
    if (now() < retryAt) throw new Error('host-unavailable');
    try {
      const d = readDiscovery(discoveryFile);
      client = new HostClient({ port: d.port, token, timeoutMs });
      return client;
    } catch { retryAt = now() + retryMs; throw new Error('host-unavailable'); }
  };
  const call = async (method, params) => {
    const c = get();
    try { return await c.call(method, params); } catch (e) { if (client === c) client = null; throw e; }
  };
  return Object.freeze({
    addMarker: (source, note) => call('marker.add', { source, note }),
    mixerList: () => call('mixer.list', {}),
  });
}

/**
 * opts: { bus, flags: { isOn(id) }, host: { addMarker(source, note), mixerList() }, config? (loadLiveMarkerConfig()),
 *         now?() ms monotonic, setInterval?, clearInterval?, log?(line) }.
 * Returns { stop(), stats(), isOn() }. Never throws after construction.
 */
export function createLiveMarkers(opts) {
  const { bus, flags, host } = opts;
  if (!bus || typeof bus.subscribe !== 'function') throw new Error('live-markers: bus required');
  if (!flags || typeof flags.isOn !== 'function') throw new Error('live-markers: flags required');
  if (!host || typeof host.addMarker !== 'function' || typeof host.mixerList !== 'function') throw new Error('live-markers: host required');
  const cfg = opts.config ?? loadLiveMarkerConfig();
  const now = opts.now ?? (() => performance.now());
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const log = opts.log ?? (() => {});
  const st = { flagFlips: 0, written: 0, failures: 0, dropped: 0, tickErrors: 0, meterReads: 0, meterFailures: 0, byKind: {} };
  let on = false, chat = null, audio = null, inflight = 0, reading = false, stopped = false;
  let lastLog = -Infinity;
  const note = (code) => { const t = now(); if (t - lastLog >= LOG_EVERY_MS) { lastLog = t; log(`[live-markers] ${code}`); } };

  function emit(m) {
    if (!m || stopped) return;
    st.byKind[m.kind] = (st.byKind[m.kind] ?? 0) + 1;
    if (inflight >= MAX_INFLIGHT) { st.dropped++; return; }
    inflight++;
    let p;
    try { p = Promise.resolve(host.addMarker(m.source, m.note)); } catch (e) { p = Promise.reject(e); }
    p.then(() => { st.written++; }, (e) => { st.failures++; note(`marker not written (${String(e?.code ?? e?.message ?? 'error').slice(0, 40)})`); })
      .finally(() => { inflight--; });
  }

  function refresh() {
    let want = false;
    try { want = flags.isOn(FLAG) === true; } catch { want = false; }
    if (want !== on) {
      st.flagFlips++;
      if (want) { chat = createChatDetector(cfg.chat, cfg.minGapSec); audio = createAudioDetector(cfg.audio, cfg.minGapSec); }
      else { chat = null; audio = null; }
      on = want;
      log(`[live-markers] ${on ? 'on' : 'off'} (thresholds: ranking ${cfg.status.ranking}, live ${cfg.status.live})`);
    }
    return on;
  }

  const unsubscribe = bus.subscribe({
    name: 'live-markers', kinds: ['chat.message'],
    handler: (ev) => { if (on && chat) emit(chat.message(ev?.text, now())); },
  });

  const tick = si(() => {
    try {
      if (!refresh()) return;
      const t = now();
      emit(chat.tick(t));
      emit(audio.tick(t));
    } catch { st.tickErrors++; }
  }, TICK_MS);
  tick?.unref?.();

  const meter = si(() => {
    if (!on || reading || stopped) return;
    reading = true;
    let p;
    try { p = Promise.resolve(host.mixerList()); } catch (e) { p = Promise.reject(e); }
    p.then((r) => { st.meterReads++; audio?.sample(levelOf(r, cfg.audio.sources)); }, () => { st.meterFailures++; })
      .finally(() => { reading = false; });
  }, cfg.audio.sampleMs);
  meter?.unref?.();

  return {
    isOn: () => on,
    stats: () => ({ on, ...st, byKind: { ...st.byKind }, inflight, chat: chat?.stats() ?? null, audio: audio?.stats() ?? null, status: cfg.status }),
    stop() {
      if (stopped) return;
      stopped = true;
      on = false;
      ci(tick);
      ci(meter);
      try { unsubscribe(); } catch { /* already gone */ }
    },
  };
}
