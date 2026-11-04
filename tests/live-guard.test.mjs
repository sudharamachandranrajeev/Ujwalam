// SPDX-License-Identifier: GPL-3.0-or-later
// Live-test guard (services/studio-ui/live-guard.mjs): budget file, option parsing, and the state machine on a
// simulated clock and simulated outputs.status rows (no host, no network, no platform): it arms only on a started
// stream, never starts outputs, stops everything at the time limit (exit 0) or on a failure / drop budget breach
// (exit 4), stops a single sink at its own limit, and reports no key, keyRef or URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGuard, formatReport, GUARD_ABORT_EXIT, LIVE_TEST_BUDGET, loadBudget, parseMinutes, parseSinkMinutes, runGuard } from '../services/studio-ui/live-guard.mjs';

const budget = loadBudget();

test('budget: data/outputs/guard/live-test-budget.json carries the approved values with a source and status', () => {
  assert.ok(LIVE_TEST_BUDGET.endsWith(path.join('data', 'outputs', 'guard', 'live-test-budget.json')));
  assert.equal(budget.status, 'user-approved');
  assert.match(budget.source, /user decision 2026-11-03/);
  assert.equal(budget.pollMs, 2000);
  assert.equal(budget.notLiveMaxSec, 10);
  assert.equal(budget.cumulativePct, 1.0);
  assert.equal(budget.graceSec, 30);
  assert.equal(budget.windowPct, 3.0);
  assert.equal(budget.windowSec, 10);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-budget-'));
  const bad = path.join(dir, 'b.json');
  writeFileSync(bad, JSON.stringify({ source: 'x', pollMs: 2000, notLiveMaxSec: 10, dropped: { cumulativePct: 200, graceSec: 30, windowPct: 3, windowSec: 10, windowMinFrames: 60 }, stopWaitSec: 20 }));
  assert.throws(() => loadBudget(bad), /dropped\.cumulativePct/);
  writeFileSync(bad, JSON.stringify({ pollMs: 2000 }));
  assert.throws(() => loadBudget(bad), /source is required/);
});

test('options: minutes and per-sink minutes', () => {
  assert.equal(parseMinutes('15'), 15);
  assert.equal(parseMinutes('0.5'), 0.5);
  for (const v of ['0', '-1', 'abc', '121', '', true, undefined]) assert.equal(parseMinutes(v), null, String(v));
  assert.deepEqual(parseSinkMinutes('kick=2'), { kick: 2 });
  assert.deepEqual(parseSinkMinutes('kick=2,twitch=1.5'), { kick: 2, twitch: 1.5 });
  assert.deepEqual(parseSinkMinutes(undefined), {});
  for (const v of ['kick', 'kick=0', 'kick=2,kick=3', '=2', 'bad id=2', true]) assert.throws(() => parseSinkMinutes(v), Error, String(v));
});

// ---- simulation ------------------------------------------------------------------------------------------
// A sink script: (sec since the stream started) -> { state, fps, dropPct, kbps } (state defaults to live).
// Counters are integrated over the simulated seconds, like libobs counters; a "reset" restarts them (reconnect).
function simulator(scripts, { startAt = 0 } = {}) {
  const c = {};
  for (const id of Object.keys(scripts)) c[id] = { frames: 0, dropped: 0, bytes: 0, retries: 0, skip: 1000, lag: 50 }; // host-wide counters start above 0
  let last = 0;
  return (t) => {
    const sec = (t - startAt) / 1000;
    const dt = Math.max(0, (t - last) / 1000);
    last = t;
    const sinks = [];
    for (const [id, f] of Object.entries(scripts)) {
      const st = sec < 0 ? { state: 'idle' } : { state: 'live', fps: 60, dropPct: 0, skipPct: 0, lagPct: 0, kbps: 6000, ...f.fn(sec) };
      const x = c[id];
      if (st.reset) { x.frames = 0; x.dropped = 0; x.bytes = 0; x.retries++; }
      if (st.state === 'live') {
        const fr = st.fps * dt;
        x.frames += fr; x.dropped += (fr * st.dropPct) / 100; x.bytes += (st.kbps * 1000 * dt) / 8;
        x.skip += (fr * st.skipPct) / 100; x.lag += (fr * st.lagPct) / 100;
      }
      sinks.push({
        id, kind: f.kind ?? 'stream', platform: f.platform ?? id, state: st.state,
        keyRef: 'Ujwalam/stream/secret-ref', url: 'rtmps://a.example.com/live2', lastError: 'rtmps://a.example.com/live2 failed',
        bandwidthTest: f.platform === 'twitch', retries: x.retries, lastCode: st.state === 'failed' ? -2 : 0,
        totalFrames: Math.floor(x.frames), droppedFrames: Math.floor(x.dropped), bytes: Math.floor(x.bytes),
        ...(f.noVideoCounters ? {} : { encoderSkippedFrames: Math.floor(x.skip), renderLaggedFrames: Math.floor(x.lag) }),
      });
    }
    return { allowLive: true, sinks };
  };
}

// Runs the guard every 2 s from t=0 until it asks to stop everything (or maxSec). Returns events and the guard.
function drive(scripts, { minutes = 15, sinkMinutes = {}, startAt = 4000, maxSec = 20 * 60, statusAt } = {}) {
  const g = createGuard({ budget, minutes, sinkMinutes });
  const sim = simulator(scripts, { startAt });
  const events = [];
  let t = 0;
  for (; t <= maxSec * 1000; t += budget.pollMs) {
    const st = statusAt ? statusAt(t, sim) : sim(t);
    const r = g.observe(st, t);
    if (r.armedNow) events.push({ t, armed: true });
    if (r.action === 'stop-sinks') events.push({ t, stop: r.sinks });
    if (r.action === 'stop-all') { events.push({ t, stopAll: true }); break; }
  }
  return { g, events, t, sim };
}

test('guard: does not arm while nothing streams; arms on the first started stream; a normal end at the time limit is exit 0', () => {
  const { g, events, t } = drive({ 'youtube-h': { fn: () => ({}) }, twitch: { platform: 'twitch', fn: () => ({}) }, record: { kind: 'record', platform: 'local', fn: () => ({}) } }, { minutes: 15 });
  assert.deepEqual(events[0], { t: 4000, armed: true }, 'armed on the first poll that sees a started stream');
  assert.equal(t, 4000 + 15 * 60_000, 'stops exactly at 15 min after arming');
  const e = g.ended();
  assert.deepEqual(e, { reason: 'time-limit', code: 0, sink: null, detail: null });
  const r = g.report(t);
  assert.equal(r.sinks.length, 3);
  const yt = r.sinks.find((s) => s.id === 'youtube-h');
  assert.equal(yt.stoppedBy, 'guard-time-limit');
  assert.equal(yt.droppedPct, 0);
  assert.ok(Math.abs(yt.kbpsAvg - 6000) <= 5, `kbps avg ${yt.kbpsAvg}`);
  assert.ok(Math.abs(yt.kbpsMin - 6000) <= 10, `kbps min ${yt.kbpsMin}`);
  assert.equal(r.sinks.find((s) => s.id === 'twitch').bandwidthTest, true);
  assert.equal(r.end.code, 0);
});

test('guard: before arming it ignores everything (no stream started = no stop), whatever the clock says', () => {
  const g = createGuard({ budget, minutes: 0.01 });
  const idle = { sinks: [{ id: 'youtube-h', kind: 'stream', state: 'idle' }, { id: 'record', kind: 'record', state: 'live' }] };
  for (let t = 0; t < 120_000; t += 2000) assert.equal(g.observe(idle, t).action, 'none');
  assert.equal(g.observe(null, 130_000).action, 'none', 'an unreachable host before arming is not a failure');
  assert.equal(g.armed(), false);
});

test('guard: steady 1.5 % drops stop the test after the 30 s grace (cumulative budget 1 %); 0.8 % runs to the end', () => {
  const bad = drive({ 'youtube-h': { fn: () => ({ dropPct: 1.5 }) } });
  assert.equal(bad.g.ended().reason, 'dropped-cumulative');
  assert.equal(bad.g.ended().code, GUARD_ABORT_EXIT);
  assert.equal(bad.g.ended().sink, 'youtube-h');
  const after = bad.t - 4000;
  assert.ok(after >= 30_000 && after <= 36_000, `stopped ${after} ms after the stream started`);
  const ok = drive({ 'youtube-h': { fn: () => ({ dropPct: 0.8 }) } }, { minutes: 3 });
  assert.equal(ok.g.ended().reason, 'time-limit');
  const r = ok.g.report(ok.t).sinks[0];
  assert.ok(r.droppedPct > 0.7 && r.droppedPct < 0.9, `dropped ${r.droppedPct}`);
});

test('guard: a 10 s burst above 3 % stops the test (window budget); drops inside the grace period alone do not', () => {
  const burst = drive({ twitch: { platform: 'twitch', fn: (s) => ({ dropPct: s >= 300 && s < 315 ? 6 : 0 }) } });
  assert.equal(burst.g.ended().reason, 'dropped-window');
  assert.match(burst.g.ended().detail, /% lost over 1\d s \(network \d+, encoder-skipped 0, render-lagged 0 of \d+; budget 3 % per 10 s\)/);
  const sec = (burst.t - 4000) / 1000;
  assert.ok(sec > 300 && sec <= 316, `stopped at ${sec} s`);
  // 2 % for the first 20 s: under the window budget, excluded from the cumulative budget by the grace period.
  const early = drive({ 'youtube-v': { fn: (s) => ({ dropPct: s < 20 ? 2 : 0 }) } }, { minutes: 2 });
  assert.equal(early.g.ended().reason, 'time-limit');
  const r = early.g.report(early.t).sinks[0];
  assert.ok(r.droppedPct > 0, 'reported in the whole-run figure');
  assert.equal(r.droppedPctAfterGrace, 0);
});

test('guard: reconnecting longer than 10 s stops the test; a 6 s reconnect does not; failed stops at once', () => {
  const long = drive({ kick: { fn: (s) => ({ state: s >= 60 && s < 80 ? 'retrying' : 'live', reset: s >= 80 && s < 82 }) } });
  assert.equal(long.g.ended().reason, 'not-live');
  assert.match(long.g.ended().detail, /^retrying for 1[0-2] s \(budget 10 s\)$/);
  const short = drive({ kick: { fn: (s) => ({ state: s >= 60 && s < 66 ? 'retrying' : 'live', reset: s >= 66 && s < 68 }) } }, { minutes: 3 });
  assert.equal(short.g.ended().reason, 'time-limit', 'a short reconnect is tolerated');
  const rs = short.g.report(short.t).sinks[0];
  assert.equal(rs.retries, 1);
  assert.ok(rs.droppedPct === 0 && rs.frames > 9000, `counters banked across the reconnect (${rs.frames} frames)`);
  const failed = drive({ 'youtube-h': { fn: (s) => ({ state: s >= 40 ? 'failed' : 'live' }) } });
  assert.equal(failed.g.ended().reason, 'failed');
  assert.equal(failed.g.report(failed.t).sinks[0].finalState, 'failed');
  const starting = drive({ 'youtube-h': { fn: () => ({ state: 'starting' }) } });
  assert.equal(starting.g.ended().reason, 'not-live', 'never connecting counts as not live');
});

test('guard: a sink time limit stops only that sink; the rest runs to the end', () => {
  const stopped = new Set();
  const { g, events, t } = drive({
    'youtube-h': { fn: () => ({}) },
    kick: { fn: () => ({}) },
  }, {
    minutes: 5, sinkMinutes: { kick: 2 },
    statusAt: (time, sim) => { const st = sim(time); for (const s of st.sinks) if (stopped.has(s.id)) s.state = 'stopped'; return st; },
  });
  const stop = events.find((e) => e.stop);
  assert.deepEqual(stop.stop, ['kick']);
  assert.equal(stop.t - 4000, 120_000);
  stopped.add('kick');
  assert.equal(g.ended().reason, 'time-limit');
  assert.equal(t - 4000, 300_000);
  const k = g.report(t).sinks.find((s) => s.id === 'kick');
  assert.equal(k.stoppedBy, 'guard-sink-limit');
});

test('guard: the operator stopping every stream ends the test (exit 0); a host restart (idle) or a vanished sink aborts', () => {
  const op = drive({ 'youtube-h': { fn: (s) => ({ state: s >= 50 ? 'stopped' : 'live' }) }, record: { kind: 'record', platform: 'local', fn: () => ({}) } });
  assert.equal(op.g.ended().reason, 'operator-stop');
  assert.equal(op.g.ended().code, 0);
  const rs = op.g.report(op.t).sinks;
  assert.equal(rs.find((s) => s.id === 'youtube-h').stoppedBy, 'operator');
  assert.equal(rs.find((s) => s.id === 'record').stoppedBy, 'guard-operator-stop', 'the recording is stopped too');
  const reset = drive({ 'youtube-h': { fn: (s) => ({ state: s >= 50 ? 'idle' : 'live' }) } });
  assert.equal(reset.g.ended().reason, 'sink-reset');
  assert.equal(reset.g.ended().code, GUARD_ABORT_EXIT);
  const gone = drive({ 'youtube-h': { fn: () => ({}) } }, { statusAt: (time, sim) => { const st = sim(time); if (time > 60_000) st.sinks = []; return st; } });
  assert.equal(gone.g.ended().reason, 'sink-missing');
});

test('guard: the host not answering for more than 10 s after arming aborts', () => {
  const { g, t } = drive({ 'youtube-h': { fn: () => ({}) } }, { statusAt: (time, sim) => (time > 60_000 ? null : sim(time)) });
  assert.equal(g.ended().reason, 'host-unreachable');
  assert.ok(t > 70_000 && t <= 74_000, `aborted at ${t}`);
});

test('guard report: no keyRef, URL or error text even when the status rows carry them', () => {
  const { g, t } = drive({ 'youtube-h': { fn: (s) => ({ state: s >= 20 ? 'failed' : 'live' }) } });
  const r = g.report(t);
  const s = JSON.stringify(r) + formatReport(r);
  for (const bad of ['Ujwalam/stream', 'rtmps://', 'example.com', 'secret']) assert.ok(!s.includes(bad), `report carries ${bad}`);
  assert.match(formatReport(r), /STOPPED BY THE GUARD/);
  assert.match(formatReport(r), /why stopped: failed \(sink youtube-h\)/);
});

test('runGuard: polls outputs.status, never starts anything, stops a sink at its limit and then everything, settles, reports', async () => {
  let t = 0;
  const calls = [];
  const stopped = new Set();
  const sim = simulator({ 'youtube-h': { fn: () => ({}) }, twitch: { platform: 'twitch', fn: () => ({}) } }, { startAt: 6000 });
  const client = {
    call: async (m, p) => {
      calls.push({ m, p });
      if (m === 'outputs.status') { const st = sim(t); for (const s of st.sinks) if (stopped.has(s.id)) s.state = 'stopped'; return st; }
      if (m === 'outputs.stop') { for (const s of (p.sinks?.length ? p.sinks : ['youtube-h', 'twitch'])) stopped.add(s); return {}; }
      throw new Error(`unexpected ${m}`);
    },
  };
  const logs = [];
  const r = await runGuard({ getClient: () => client, budget, minutes: 1, sinkMinutes: { twitch: 0.5 }, log: (l) => logs.push(l), now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(r.code, 0);
  assert.equal(r.report.end.reason, 'time-limit');
  assert.ok(calls.every((c) => c.m === 'outputs.status' || c.m === 'outputs.stop'), 'only status and stop');
  const stops = calls.filter((c) => c.m === 'outputs.stop').map((c) => c.p);
  assert.deepEqual(stops, [{ sinks: ['twitch'] }, {}]);
  assert.deepEqual(r.report.sinks.map((s) => [s.id, s.finalState, s.stoppedBy]), [['youtube-h', 'stopped', 'guard-time-limit'], ['twitch', 'stopped', 'guard-sink-limit']]);
  assert.ok(logs.some((l) => /ARMED/.test(l)));
  assert.match(r.text, /ENDED NORMALLY/);
});

test('guard: network-dropped + encoder-skipped + render-lagged count together (user decision); each is reported separately', () => {
  // 0.5 % network + 0.4 % encoder-skipped + 0.3 % render-lagged: each alone is under 1 %, together they are not.
  const sum = drive({ 'youtube-h': { fn: () => ({ dropPct: 0.5, skipPct: 0.4, lagPct: 0.3 }) } });
  assert.equal(sum.g.ended().reason, 'dropped-cumulative');
  assert.match(sum.g.ended().detail, /% lost after the first 30 s \(network \d+, encoder-skipped \d+, render-lagged \d+ of \d+; budget 1 %\)/);
  const r = sum.g.report(sum.t).sinks[0];
  assert.ok(r.networkDropped > 0 && r.encoderSkipped > 0 && r.renderLagged > 0, JSON.stringify(r));
  assert.ok(r.encoderSkipped < 100, `host-wide counters count from the sink's first sample only (${r.encoderSkipped})`);
  assert.ok(Math.abs(r.networkDroppedPct - 0.5) < 0.1 && Math.abs(r.encoderSkippedPct - 0.4) < 0.1 && Math.abs(r.renderLaggedPct - 0.3) < 0.1, JSON.stringify(r));
  assert.match(formatReport(sum.g.report(sum.t)), /network \d+ = 0\.\d+ %, encoder-skipped \d+ = 0\.\d+ %, render-lagged \d+ = 0\.\d+ %/);
  // An encoder-skip burst alone trips the window budget.
  const skip = drive({ 'youtube-v': { fn: (s) => ({ skipPct: s >= 100 && s < 115 ? 8 : 0 }) } });
  assert.equal(skip.g.ended().reason, 'dropped-window');
  // A host without the video counters (older build): judged on network drops only, reported as null / n/a.
  const old = drive({ 'youtube-h': { noVideoCounters: true, fn: () => ({}) } }, { minutes: 1 });
  assert.equal(old.g.ended().reason, 'time-limit');
  const o = old.g.report(old.t).sinks[0];
  assert.equal(o.encoderSkipped, null);
  assert.equal(o.renderLagged, null);
  assert.match(formatReport(old.g.report(old.t)), /encoder-skipped n\/a/);
});

test('guard report notes: Twitch bandwidth-test mode; Twitch/Kick without it are public and titled by the user', () => {
  const { g, t } = drive({ twitch: { platform: 'twitch', fn: () => ({}) }, kick: { platform: 'kick', fn: () => ({}) }, 'youtube-h': { platform: 'youtube', fn: () => ({}) } }, { minutes: 1 });
  const r = g.report(t);
  assert.deepEqual(r.notes, ['twitch: Twitch bandwidth-test mode (received by Twitch, not broadcast)', 'kick: public when live; the stream title is set by the user on the platform, not by Ujwalam']);
  assert.match(formatReport(r), /note: kick: public when live/);
});