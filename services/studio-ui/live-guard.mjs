// SPDX-License-Identifier: GPL-3.0-or-later
// Live-test guard (Alpha 0 private test stream; launcher --test-stream-minutes N).
//
// The guard never starts an output. It waits until a stream sink becomes active, which only happens after the
// user's typed "yes, on air" on the control page, then polls outputs.status every budget.pollMs and STOPS ALL
// outputs (streams and recording, outputs.stop {}) when:
//   - a started sink is "failed", or "idle" (the host restarted or reconfigured), or vanishes from the status;
//   - a started sink stays "starting" or "retrying" (disconnected, reconnecting) longer than notLiveMaxSec;
//   - a stream sink's lost frames pass the budget (user decision 2026-11-03): network-dropped (the sink's libobs
//     output) + encoder-skipped (the video its rung encodes from) + render-lagged (the compositor), over the frames
//     that should have gone out (sent + skipped + lagged), after its first graceSec live above cumulativePct, or over
//     any windowSec span above windowPct (spans under windowMinFrames frames are not judged). The three counts are
//     also reported separately;
//   - the host does not answer outputs.status for longer than notLiveMaxSec;
//   - N minutes have passed since the first stream sink became active (normal end, exit code 0).
// --test-sink-minutes id=M stops only that sink after M minutes (e.g. a 2-minute Kick test); that is not a failure.
// A sink the operator stops from the control page ("stopped") is not a failure; when every started stream sink is
// stopped the guard ends (operator-stop, exit 0) and stops what is left (the recording).
// Budget values live in data/outputs/guard/live-test-budget.json (with source), never in this file.
// The report (JSON + text) holds sink ids, platforms, states, counters and codes only: never a key, URL, keyRef or
// error text (error text can carry an ingest URL).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIVE_TEST_BUDGET = path.join(REPO, 'data', 'outputs', 'guard', 'live-test-budget.json');
export const GUARD_ABORT_EXIT = 4;
export const MAX_TEST_MINUTES = 120;
const ACTIVE = new Set(['starting', 'live', 'retrying']);
const NOT_LIVE = new Set(['starting', 'retrying']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reads and checks the budget file; throws on a missing or out-of-range value. */
export function loadBudget(file = LIVE_TEST_BUDGET) {
  const b = JSON.parse(readFileSync(file, 'utf8'));
  const num = (v, name, min, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`live-test budget: ${name} must be a number in [${min}, ${max}]`);
    return v;
  };
  if (typeof b.source !== 'string' || !b.source) throw new Error('live-test budget: source is required');
  const d = b.dropped ?? {};
  return Object.freeze({
    source: b.source,
    status: typeof b.status === 'string' ? b.status : 'unverified',
    checked: typeof b.checked === 'string' ? b.checked : null,
    pollMs: num(b.pollMs, 'pollMs', 250, 10_000),
    notLiveMaxSec: num(b.notLiveMaxSec, 'notLiveMaxSec', 1, 120),
    cumulativePct: num(d.cumulativePct, 'dropped.cumulativePct', 0, 100),
    graceSec: num(d.graceSec, 'dropped.graceSec', 0, 600),
    windowPct: num(d.windowPct, 'dropped.windowPct', 0, 100),
    windowSec: num(d.windowSec, 'dropped.windowSec', 1, 600),
    windowMinFrames: num(d.windowMinFrames, 'dropped.windowMinFrames', 1, 1_000_000),
    stopWaitSec: num(b.stopWaitSec, 'stopWaitSec', 1, 120),
  });
}

/** "--test-stream-minutes" value -> minutes (0 < N <= MAX_TEST_MINUTES), or null when invalid. */
export function parseMinutes(v) {
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return n > 0 && n <= MAX_TEST_MINUTES ? n : null;
}

/** "kick=2,twitch=5" -> { kick: 2, twitch: 5 }; throws on a bad entry. */
export function parseSinkMinutes(v) {
  const out = {};
  if (v === undefined) return out;
  if (typeof v !== 'string' || !v) throw new Error('--test-sink-minutes needs id=minutes[,id=minutes]');
  for (const part of v.split(',')) {
    const m = /^([^=]+)=(.+)$/.exec(part.trim());
    const n = m ? parseMinutes(m[2]) : null;
    if (!m || !ID_RE.test(m[1]) || n === null) throw new Error(`--test-sink-minutes: bad entry "${part}" (id=minutes, 0 < minutes <= ${MAX_TEST_MINUTES})`);
    if (Object.hasOwn(out, m[1])) throw new Error(`--test-sink-minutes: ${m[1]} given twice`);
    out[m[1]] = n;
  }
  return out;
}

const pct = (d, f) => (f > 0 ? (d / f) * 100 : 0);
// Lost frames between two samples: network-dropped (part of the output's sent frames) plus encoder-skipped and
// render-lagged (never reached the output), over the frames that should have gone out (sent + skipped + lagged).
function loss(a, b) {
  if (!a || !b) return { frames: 0, net: 0, skip: 0, lag: 0, expected: 0, pct: 0 };
  const d = (k) => Math.max(0, b[k] - a[k]);
  const x = { frames: d('frames'), net: d('net'), skip: d('skip'), lag: d('lag') };
  x.expected = x.frames + x.skip + x.lag;
  x.pct = pct(x.net + x.skip + x.lag, x.expected);
  return x;
}
const lossText = (x) => `network ${x.net}, encoder-skipped ${x.skip}, render-lagged ${x.lag} of ${x.expected}`;
const round = (x, n = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The guard's state machine (pure; the clock is passed in). observe(status, t) returns
 *   { action: 'none' | 'stop-sinks' | 'stop-all', sinks?: string[], armedNow?: boolean }.
 * After 'stop-all', settle(status, t) records final states until done() is true; report() builds the report.
 */
export function createGuard({ budget, minutes, sinkMinutes = {} }) {
  if (!(minutes > 0)) throw new Error('guard: minutes must be > 0');
  const tracks = new Map();
  let armedAt = null;
  let end = null;
  let unreachableSince = null;
  let endedAt = null;
  const windowMs = budget.windowSec * 1000;

  const newTrack = (s, t) => ({
    id: s.id, kind: s.kind, platform: typeof s.platform === 'string' ? s.platform : null, bandwidthTest: s.bandwidthTest === true,
    firstActive: t, lastT: t, liveSince: null, notLiveSince: null, samples: [], first: null, base: null,
    raw: null, off: { frames: 0, net: 0, bytes: 0, skip: 0, lag: 0 },
    bytesSum: 0, msSum: 0, kbpsMin: null, maxWindowPct: 0, hasSkip: false, hasLag: false,
    retries: 0, state: s.state, lastCode: 0, stoppedBy: null, endT: null,
  });

  // Counter bookkeeping for one status row. Output counters (frames, net = network-dropped, bytes) restart at 0
  // when libobs starts the output again (a reconnect); an offset keeps them increasing. skip (encoder-skipped frames
  // of the video the sink's rung encodes from) and lag (render-lagged frames, the compositor) are host-wide
  // counters; only their change while the sink runs counts. Returns the new sample (null: the row has no counters).
  function sample(tr, s, t, rate = true) {
    const raw = { frames: s.totalFrames, net: s.droppedFrames, bytes: s.bytes, skip: s.encoderSkippedFrames, lag: s.renderLaggedFrames };
    if (!isNum(raw.frames) || !isNum(raw.net) || !isNum(raw.bytes)) return null;
    if (isNum(raw.skip)) tr.hasSkip = true; else raw.skip = tr.raw?.skip ?? 0;
    if (isNum(raw.lag)) tr.hasLag = true; else raw.lag = tr.raw?.lag ?? 0;
    const r = tr.raw;
    let reset = false;
    if (r && (raw.frames < r.frames || raw.net < r.net || raw.bytes < r.bytes)) {
      for (const k of ['frames', 'net', 'bytes']) tr.off[k] += r[k];
      reset = true;
    }
    for (const k of ['skip', 'lag']) if (r && raw[k] < r[k]) tr.off[k] += r[k];
    tr.raw = raw;
    const cur = { t };
    for (const k of Object.keys(tr.off)) cur[k] = raw[k] + tr.off[k];
    tr.first ??= cur;
    const prev = tr.samples.at(-1);
    if (rate && prev && !reset && t > prev.t) {
      const kbps = ((cur.bytes - prev.bytes) * 8) / (t - prev.t);
      tr.kbpsMin = tr.kbpsMin === null ? kbps : Math.min(tr.kbpsMin, kbps);
      tr.bytesSum += cur.bytes - prev.bytes;
      tr.msSum += t - prev.t;
    }
    tr.samples.push(cur);
    const keepFrom = t - windowMs - 4 * budget.pollMs;
    while (tr.samples.length > 2 && tr.samples[1].t <= keepFrom) tr.samples.shift();
    return cur;
  }

  function finish(reason, code, t, sink = null, detail = null) {
    end = { reason, code, sink, detail };
    endedAt = t;
    for (const tr of tracks.values()) {
      if (!tr.stoppedBy && ACTIVE.has(tr.state)) tr.stoppedBy = code === 0 ? `guard-${reason}` : 'guard-abort';
    }
    return { action: 'stop-all' };
  }

  function observe(status, t) {
    if (end) return { action: 'stop-all' };
    const list = Array.isArray(status?.sinks) ? status.sinks : null;
    if (!list) {
      if (armedAt === null) return { action: 'none' };
      unreachableSince ??= t;
      if (t - unreachableSince > budget.notLiveMaxSec * 1000) return finish('host-unreachable', GUARD_ABORT_EXIT, t, null, `no outputs.status for ${Math.round((t - unreachableSince) / 1000)} s`);
      return { action: 'none' };
    }
    unreachableSince = null;
    let armedNow = false;
    if (armedAt === null) {
      if (!list.some((s) => s?.kind === 'stream' && ACTIVE.has(s.state))) return { action: 'none' };
      armedAt = t;
      armedNow = true;
    }
    const seen = new Set();
    for (const s of list) {
      if (!s || typeof s.id !== 'string' || (s.kind !== 'stream' && s.kind !== 'record')) continue;
      let tr = tracks.get(s.id);
      if (!tr) {
        if (!ACTIVE.has(s.state)) continue;
        tr = newTrack(s, t);
        tracks.set(s.id, tr);
      }
      seen.add(s.id);
      tr.state = s.state;
      tr.lastT = t;
      if (isNum(s.retries)) tr.retries = Math.max(tr.retries, s.retries);
      if (Number.isInteger(s.lastCode)) tr.lastCode = s.lastCode;
      if (s.bandwidthTest === true) tr.bandwidthTest = true;
      if (tr.stoppedBy) { if (!ACTIVE.has(s.state)) tr.endT ??= t; continue; } // stopped by the guard or the operator
      if (s.state === 'live') {
        tr.notLiveSince = null;
        tr.liveSince ??= t;
        const ref = [...tr.samples].reverse().find((x) => x.t <= t - windowMs) ?? null;
        const cur = sample(tr, s, t);
        if (!cur || tr.kind !== 'stream') continue;
        if (ref && tr.samples.includes(ref)) {
          const w = loss(ref, cur);
          if (w.expected >= budget.windowMinFrames) {
            tr.maxWindowPct = Math.max(tr.maxWindowPct, w.pct);
            if (w.pct > budget.windowPct) return finish('dropped-window', GUARD_ABORT_EXIT, t, tr.id, `${round(w.pct)} % lost over ${Math.round((t - ref.t) / 1000)} s (${lossText(w)}; budget ${budget.windowPct} % per ${budget.windowSec} s)`);
          }
        }
        if (!tr.base && t - tr.liveSince >= budget.graceSec * 1000) tr.base = cur;
        if (tr.base) {
          const c = loss(tr.base, cur);
          if (c.expected >= budget.windowMinFrames && c.pct > budget.cumulativePct) {
            return finish('dropped-cumulative', GUARD_ABORT_EXIT, t, tr.id, `${round(c.pct)} % lost after the first ${budget.graceSec} s (${lossText(c)}; budget ${budget.cumulativePct} %)`);
          }
        }
      } else if (NOT_LIVE.has(s.state)) {
        tr.notLiveSince ??= t;
        if (t - tr.notLiveSince > budget.notLiveMaxSec * 1000) return finish('not-live', GUARD_ABORT_EXIT, t, tr.id, `${s.state} for ${Math.round((t - tr.notLiveSince) / 1000)} s (budget ${budget.notLiveMaxSec} s)`);
      } else if (s.state === 'failed') {
        return finish('failed', GUARD_ABORT_EXIT, t, tr.id, `failed (code ${tr.lastCode})`);
      } else if (s.state === 'stopping' || s.state === 'stopped') {
        tr.stoppedBy = 'operator';
        tr.endT = t;
      } else {
        return finish('sink-reset', GUARD_ABORT_EXIT, t, tr.id, `state ${s.state} (host restarted or outputs reconfigured)`);
      }
    }
    for (const tr of tracks.values()) {
      if (!seen.has(tr.id)) return finish('sink-missing', GUARD_ABORT_EXIT, t, tr.id, 'no longer in outputs.status');
    }
    if (t - armedAt >= minutes * 60_000) return finish('time-limit', 0, t);
    const streams = [...tracks.values()].filter((x) => x.kind === 'stream');
    if (streams.length && streams.every((x) => x.stoppedBy !== null && !ACTIVE.has(x.state))) {
      const anyOperator = streams.some((x) => x.stoppedBy === 'operator');
      return finish(anyOperator ? 'operator-stop' : 'sink-limits-done', 0, t);
    }
    const stop = [];
    for (const tr of tracks.values()) {
      const m = sinkMinutes[tr.id];
      if (m && !tr.stoppedBy && t - tr.firstActive >= m * 60_000) { tr.stoppedBy = 'guard-sink-limit'; stop.push(tr.id); }
    }
    if (stop.length) return { action: 'stop-sinks', sinks: stop, armedNow };
    return { action: 'none', armedNow };
  }

  /** After stop-all: records final states and counters (no checks). */
  function settle(status, t) {
    const list = Array.isArray(status?.sinks) ? status.sinks : [];
    for (const s of list) {
      const tr = tracks.get(s?.id);
      if (!tr) continue;
      tr.state = s.state;
      if (isNum(s.retries)) tr.retries = Math.max(tr.retries, s.retries);
      if (Number.isInteger(s.lastCode)) tr.lastCode = s.lastCode;
      if (s.state === 'live' || s.state === 'stopping' || s.state === 'stopped') sample(tr, s, t, false);
      if (!ACTIVE.has(s.state) && s.state !== 'stopping') tr.endT ??= t;
    }
  }

  const done = () => [...tracks.values()].every((x) => !ACTIVE.has(x.state) && x.state !== 'stopping');

  function report(t) {
    const iso = (x) => (x === null ? null : new Date(x).toISOString());
    const sinks = [...tracks.values()].map((tr) => {
      const last = tr.samples.at(-1);
      const all = tr.first && last ? loss(tr.first, last) : loss(null, null);
      const ag = tr.base && last ? loss(tr.base, last) : null;
      return {
        id: tr.id, kind: tr.kind, platform: tr.platform, bandwidthTest: tr.bandwidthTest,
        durationSec: round(((tr.endT ?? t) - tr.firstActive) / 1000, 1),
        kbpsAvg: tr.msSum > 0 ? round((tr.bytesSum * 8) / tr.msSum, 0) : null,
        kbpsMin: tr.kbpsMin === null ? null : round(tr.kbpsMin, 0),
        frames: all.frames,
        networkDropped: all.net, encoderSkipped: tr.hasSkip ? all.skip : null, renderLagged: tr.hasLag ? all.lag : null,
        networkDroppedPct: round(pct(all.net, all.expected), 3), encoderSkippedPct: round(pct(all.skip, all.expected), 3), renderLaggedPct: round(pct(all.lag, all.expected), 3),
        droppedPct: round(all.pct, 3),
        droppedPctAfterGrace: ag && ag.expected > 0 ? round(ag.pct, 3) : null,
        maxWindowDroppedPct: tr.kind === 'stream' ? round(tr.maxWindowPct, 3) : null,
        retries: tr.retries, finalState: tr.state, lastCode: tr.lastCode, stoppedBy: tr.stoppedBy ?? 'not-stopped',
      };
    });
    const notes = [];
    for (const s of sinks) {
      if (s.kind !== 'stream') continue;
      if (s.bandwidthTest) notes.push(`${s.id}: Twitch bandwidth-test mode (received by Twitch, not broadcast)`);
      else if (s.platform === 'twitch' || s.platform === 'kick') notes.push(`${s.id}: public when live; the stream title is set by the user on the platform, not by Ujwalam`);
    }
    return {
      v: 1, kind: 'live-test-report',
      armedAt: iso(armedAt), endedAt: iso(endedAt), reportAt: iso(t), plannedMinutes: minutes, sinkMinutes,
      end: end ?? { reason: 'not-ended', code: GUARD_ABORT_EXIT, sink: null, detail: null },
      budget: { ...budget },
      sinks,
      notes,
    };
  }

  return { observe, settle, done, report, armed: () => armedAt !== null, ended: () => end };
}

/** Plain-text form of a report (no keys, URLs or error text: the report holds none). */
export function formatReport(r) {
  const lines = [
    `Live test report (${r.end.code === 0 ? 'ENDED NORMALLY' : 'STOPPED BY THE GUARD'})`,
    `why stopped: ${r.end.reason}${r.end.sink ? ` (sink ${r.end.sink})` : ''}${r.end.detail ? `: ${r.end.detail}` : ''}`,
    `armed ${r.armedAt ?? '-'}; ended ${r.endedAt ?? '-'}; planned ${r.plannedMinutes} min${Object.keys(r.sinkMinutes ?? {}).length ? `; sink limits ${Object.entries(r.sinkMinutes).map(([k, v]) => `${k} ${v} min`).join(', ')}` : ''}`,
    `budget (${r.budget.status}; ${r.budget.source}): lost frames (network-dropped + encoder-skipped + render-lagged) > ${r.budget.cumulativePct} % after ${r.budget.graceSec} s, or > ${r.budget.windowPct} % in any ${r.budget.windowSec} s; not live > ${r.budget.notLiveMaxSec} s`,
    ...(r.notes ?? []).map((n) => `note: ${n}`),
  ];
  for (const s of r.sinks) {
    lines.push(`  ${s.id} (${s.kind}${s.platform ? `, ${s.platform}` : ''}${s.bandwidthTest ? ', twitch bandwidth test' : ''}): ${s.durationSec} s, kbps avg ${s.kbpsAvg ?? '-'} min ${s.kbpsMin ?? '-'}, lost ${s.droppedPct} % of ${s.frames} sent (network ${s.networkDropped} = ${s.networkDroppedPct} %, encoder-skipped ${s.encoderSkipped ?? 'n/a'} = ${s.encoderSkippedPct} %, render-lagged ${s.renderLagged ?? 'n/a'} = ${s.renderLaggedPct} %; after grace ${s.droppedPctAfterGrace ?? '-'} %; worst window ${s.maxWindowDroppedPct ?? '-'} %), retries ${s.retries}, final ${s.finalState} (code ${s.lastCode}), stopped by ${s.stoppedBy}`);
  }
  if (!r.sinks.length) lines.push('  (no sink was started)');
  return `${lines.join('\n')}\n`;
}

/**
 * Runs the guard against a host client until it ends. getClient() returns the current client (the launcher swaps it
 * after a host restart). Never calls outputs.start. Returns { code, report, text }.
 */
export async function runGuard({ getClient, budget, minutes, sinkMinutes = {}, log = console.log, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isCancelled = () => false }) {
  const g = createGuard({ budget, minutes, sinkMinutes });
  log(`[guard] waiting for the first stream to start (control page, "yes, on air"); then ${minutes} min, polling every ${budget.pollMs} ms`);
  const status = async () => { try { return await getClient().call('outputs.status'); } catch { return null; } };
  for (;;) {
    if (isCancelled()) return null;
    const r = g.observe(await status(), now());
    if (r.armedNow) log(`[guard] ARMED: a stream started; the test ends in ${minutes} min, sooner if a destination fails or drops frames past the budget`);
    if (r.action === 'stop-sinks') {
      log(`[guard] sink time limit reached: stopping ${r.sinks.join(', ')}`);
      try { await getClient().call('outputs.stop', { sinks: r.sinks }); } catch (e) { log(`[guard] WARNING: stopping ${r.sinks.join(', ')} failed: ${e.message}`); }
    }
    if (r.action === 'stop-all') break;
    await sleep(budget.pollMs);
  }
  const e = g.ended();
  log(`[guard] ${e.code === 0 ? 'END' : 'ABORT'}: ${e.reason}${e.sink ? ` (sink ${e.sink})` : ''}${e.detail ? `: ${e.detail}` : ''}; stopping all outputs`);
  try { await getClient().call('outputs.stop', {}); } catch (err) { log(`[guard] WARNING: outputs.stop failed: ${err.message}`); }
  const until = now() + budget.stopWaitSec * 1000;
  for (;;) {
    g.settle(await status(), now());
    if (g.done() || now() >= until) break;
    await sleep(Math.min(500, budget.pollMs));
  }
  if (!g.done()) log(`[guard] WARNING: not every sink reported stopped within ${budget.stopWaitSec} s`);
  const report = g.report(now());
  return { code: e.code, report, text: formatReport(report) };
}
