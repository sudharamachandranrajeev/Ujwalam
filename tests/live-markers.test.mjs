// SPDX-License-Identifier: GPL-3.0-or-later
// F6 live marker producers (services/event-core/live-markers.mjs): config sharing, chat intent and speed, audio peak,
// flag gating, failure isolation, host link, service wiring. Invented counts and levels only; no real chat.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBus } from '../services/event-core/bus.mjs';
import {
  FLAG, LIVE_FILE, RANKING_FILE, MAX_INFLIGHT, createAudioDetector, createChatDetector, createHostLink, createLiveMarkers,
  createRollingWindow, levelOf, loadLiveMarkerConfig,
} from '../services/event-core/live-markers.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';

const cfg = loadLiveMarkerConfig();
const ranking = JSON.parse(readFileSync(RANKING_FILE, 'utf8'));
const S = 1000;

// Manual timers: tick(ms) runs every interval whose period has elapsed, in time order.
function fakeTimers() {
  let t = 0;
  const timers = new Set();
  return {
    now: () => t,
    setInterval: (fn, ms) => { const h = { fn, ms, next: t + ms }; timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let due = null;
        for (const h of timers) if (h.next <= end && (!due || h.next < due.next)) due = h;
        if (!due) break;
        t = due.next;
        due.next += due.ms;
        due.fn();
        await new Promise((r) => setImmediate(r)); // let bus handlers and promise chains run
      }
      t = end;
    },
    count: () => timers.size,
  };
}

function fakeHost({ peakDb = () => null, fail = false, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    addMarker(source, note) {
      calls.push({ method: 'marker.add', source, note });
      if (hang) return new Promise(() => {});
      if (fail === 'throw') throw new Error('boom');
      return fail ? Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' })) : Promise.resolve({ marker: {} });
    },
    mixerList() {
      calls.push({ method: 'mixer.list' });
      if (fail) return Promise.reject(new Error('down'));
      const v = peakDb();
      return Promise.resolve({ sources: [{ id: 'audio:mic', audioSource: 'mic', active: true, muted: false, peakDb: v }] });
    },
  };
}

const flagsOf = (state) => ({ isOn: (id) => id === FLAG && state.on === true });

describe('config', () => {
  test('rules and thresholds are the post-stream ones from data/clip/ranking.json', () => {
    assert.equal(cfg.chat.intentPattern, ranking.chat.intentPattern);
    assert.equal(cfg.chat.windowSec, ranking.chat.windowSec);
    assert.equal(cfg.chat.minMessages, ranking.chat.minMessages);
    assert.equal(cfg.chat.ratio, ranking.chat.ratio);
    assert.equal(cfg.audio.floor, ranking.audio.floorLufs);
    assert.equal(cfg.audio.zThreshold, ranking.audio.zThreshold);
    assert.equal(cfg.audio.minSpread, ranking.audio.minSpread);
    assert.equal(cfg.audio.minVoicedSec, ranking.audio.minVoicedSec);
    assert.equal(cfg.minGapSec, ranking.peaks.minGapSec);
  });
  test('both files are status proposed (not approved values)', () => {
    assert.equal(cfg.status.ranking, 'proposed');
    assert.equal(cfg.status.live, 'proposed');
    assert.equal(JSON.parse(readFileSync(LIVE_FILE, 'utf8')).approvedBy, null);
  });
  test('the flag exists and is off by default', () => {
    const f = loadDefinitions().find((d) => d.id === FLAG);
    assert.ok(f);
    assert.equal(f.default, false);
  });
  test('a bad value is refused', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'lm-cfg-'));
    try {
      const r = path.join(d, 'r.json');
      writeFileSync(r, JSON.stringify({ ...ranking, chat: { ...ranking.chat, ratio: 0 } }));
      assert.throws(() => loadLiveMarkerConfig({ rankingFile: r }), /chat\.ratio/);
      writeFileSync(r, JSON.stringify({ ...ranking, chat: { ...ranking.chat, intentPattern: '(' } }));
      assert.throws(() => loadLiveMarkerConfig({ rankingFile: r }));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('rolling window', () => {
  test('median and MAD over the last cap values', () => {
    const w = createRollingWindow(3);
    for (const x of [5, 1, 9, 3]) w.push(x); // keeps 1, 9, 3
    assert.equal(w.size(), 3);
    assert.equal(w.median(), 3);
    assert.equal(w.mad(3), 2); // |1-3|=2, |9-3|=6, 0 -> median 2
    w.push(4); // 9, 3, 4
    assert.equal(w.median(), 4);
  });
});

describe('chat intent', () => {
  test('matches the ranking.json intent pattern, case-insensitive', () => {
    const c = createChatDetector(cfg.chat, cfg.minGapSec);
    const hits = ['clip it', 'CLIP THAT!!', 'lol !clip', 'someone clip this', 'Clip   it now'];
    const misses = ['clipping', 'eclipse it', 'clipit', 'nice clip', '!clipboard', ''];
    let t = 0;
    for (const h of hits) { t += 40 * S; assert.ok(c.message(h, t), h); }
    for (const m of misses) { t += 40 * S; assert.equal(c.message(m, t), null, m); }
    assert.equal(c.message(null, t + 40 * S), null);
  });
  test('one marker per minGapSec; the rest are counted, not written', () => {
    const c = createChatDetector(cfg.chat, cfg.minGapSec);
    const m = c.message('clip it', 0);
    assert.deepEqual(m, { source: 'chat', kind: 'chat.intent', note: 'chat: clip request' });
    for (let i = 1; i < 10; i++) assert.equal(c.message('clip it', i * S), null);
    assert.equal(c.message('clip it', cfg.minGapSec * S - 1), null);
    assert.ok(c.message('clip it', cfg.minGapSec * S));
    assert.equal(c.stats().intentSuppressed, 10);
  });
  test('the note never carries chat text', () => {
    const c = createChatDetector(cfg.chat, cfg.minGapSec);
    const m = c.message('clip it SECRET_NAME_42', 0);
    assert.ok(!m.note.includes('SECRET'));
  });
});

describe('chat speed', () => {
  const run = (perSec) => {
    const c = createChatDetector(cfg.chat, cfg.minGapSec);
    const out = [];
    perSec.forEach((n, i) => { for (let k = 0; k < n; k++) c.message('hi', i * S); const m = c.tick(i * S); if (m) out.push({ t: i, m }); });
    return { out, c };
  };
  test('no chat, no marker', () => { assert.equal(run(new Array(120).fill(0)).out.length, 0); });
  test('warm-up: an opening burst gives no speed marker before warmupSec; the same burst after it does', () => {
    assert.equal(cfg.chat.warmupSec, 120, 'data/clip/live-markers.json chat.warmupSec (user 2026-11-06)');
    const opening = run([...new Array(30).fill(0), ...new Array(40).fill(3)]); // quiet start, then the opening burst
    assert.equal(opening.out.length, 0, JSON.stringify(opening.out));
    assert.ok(opening.c.stats().speedWarmup > 0);
    const later = run([...new Array(130).fill(0), ...new Array(40).fill(3)]);
    assert.ok(later.out.length >= 1 && later.out.every((o) => o.t > cfg.chat.warmupSec), JSON.stringify(later.out));
  });
  test('steady chat at the baseline does not fire; a burst does, once per gap', () => {
    // 1 message every 2 s for 10 min (rolling 20 s ~ 10), then 3 messages/s for 40 s (rolling 60 >= 10 * ratio 3)
    const quiet = Array.from({ length: 600 }, (_, i) => (i % 2 ? 1 : 0));
    const { out, c } = run([...quiet, ...new Array(40).fill(3)]);
    assert.equal(out.filter((o) => o.t < 600).length, 0);
    const burst = out.filter((o) => o.t >= 600);
    assert.ok(burst.length >= 1 && burst.length <= 2, JSON.stringify(burst));
    assert.equal(burst[0].m.kind, 'chat.velocity');
    assert.match(burst[0].m.note, /^chat: speed spike, \d+ messages in 20 s \(baseline [\d.]+, need [\d.]+\)$/);
    if (burst[1]) assert.ok(burst[1].t - burst[0].t >= cfg.minGapSec);
    assert.ok(c.stats().speedSuppressed > 0);
  });
  test('below minMessages never fires, even from a zero baseline', () => {
    const seq = new Array(200).fill(0);
    seq[50] = cfg.chat.minMessages - 1;
    assert.equal(run(seq).out.length, 0);
    seq[150] = cfg.chat.minMessages;
    assert.equal(run(seq).out.length, 1);
  });
});

describe('audio peak', () => {
  const run = (levels) => {
    const a = createAudioDetector(cfg.audio, cfg.minGapSec);
    const out = [];
    levels.forEach((v, i) => { if (v !== null) { a.sample(v - 3); a.sample(v); } const m = a.tick(i * S); if (m) out.push({ t: i, m }); });
    return { out, a };
  };
  const speech = (n) => Array.from({ length: n }, (_, i) => -30 + ((i * 7) % 5) - 2); // -32..-28 dBFS
  test('a loud second over a steady baseline fires; the gap holds the next one', () => {
    const { out } = run([...speech(120), -5, -5, ...speech(10), -4, ...speech(40), -4]);
    assert.deepEqual(out.map((o) => o.t), [120, 173]);
    assert.equal(out[0].m.source, 'audio');
    assert.match(out[0].m.note, /^audio: peak -5 dBFS, z [\d.]+ \(median -?[\d.]+\)$/);
  });
  test('needs minVoicedSec voiced seconds first; silence is not baseline', () => {
    assert.equal(run([...speech(cfg.audio.minVoicedSec - 2), -1]).out.length, 0); // 9 voiced seconds with the peak
    assert.equal(run([...speech(cfg.audio.minVoicedSec * 3), -1]).out.length, 1);
    const silent = run([...new Array(100).fill(null), ...new Array(100).fill(-90), -1]);
    assert.equal(silent.out.length, 0);
    assert.equal(silent.a.stats().voicedSec, 1);
  });
  test('levelOf: highest finite peak over active, unmuted, counted sources', () => {
    const list = { sources: [
      { id: 'a', audioSource: 'mic', active: true, muted: false, peakDb: -20 },
      { id: 'b', audioSource: 'desk', active: true, muted: true, peakDb: -1 },
      { id: 'c', audioSource: 'game', active: false, muted: false, peakDb: -2 },
      { id: 'd', audioSource: 'music', active: true, muted: false, peakDb: null },
      { id: 'e', audioSource: 'game2', active: true, muted: false, peakDb: -10 },
    ] };
    assert.equal(levelOf(list), -10);
    assert.equal(levelOf(list, ['mic']), -20);
    assert.equal(levelOf(list, ['b']), -Infinity);
    assert.equal(levelOf(null), -Infinity);
    // a metered layer that is in no track (looping video, mixers 0) is not heard: no peak from it
    list.sources.push({ id: 's/wordmark', active: true, muted: false, mixers: 0, peakDb: -3 });
    assert.equal(levelOf(list), -10);
  });
});

describe('runner', () => {
  test('flag off: no host call at all, chat ignored', async () => {
    const ft = fakeTimers();
    const bus = createBus();
    const host = fakeHost();
    const lm = createLiveMarkers({ bus, flags: flagsOf({ on: false }), host, config: cfg, ...ft });
    for (let i = 0; i < 30; i++) bus.publish({ kind: 'chat.message', text: 'clip it' });
    await ft.advance(60 * S);
    assert.equal(host.calls.length, 0);
    assert.equal(lm.isOn(), false);
    lm.stop();
    assert.equal(ft.count(), 0);
  });
  test('flag read live: on writes chat and audio markers, off stops them at once', async () => {
    const ft = fakeTimers();
    const bus = createBus();
    let level = -30;
    const host = fakeHost({ peakDb: () => level });
    const state = { on: false };
    const lines = [];
    const lm = createLiveMarkers({ bus, flags: flagsOf(state), host, config: cfg, log: (l) => lines.push(l), ...ft });
    await ft.advance(5 * S);
    state.on = true;
    await ft.advance(1 * S);
    assert.equal(lm.isOn(), true);
    bus.publish({ kind: 'chat.message', text: 'CLIP IT' });
    bus.publish({ kind: 'chat.message', text: 'clip it' });
    await ft.advance(30 * S); // baseline: steady -30 dBFS
    level = -3;
    await ft.advance(1 * S);
    level = -30;
    await ft.advance(1 * S);
    const markers = host.calls.filter((c) => c.method === 'marker.add');
    assert.deepEqual(markers.map((m) => m.source).sort(), ['audio', 'chat']);
    assert.ok(host.calls.some((c) => c.method === 'mixer.list'));
    assert.ok(lines.some((l) => /on \(thresholds: ranking proposed, live proposed\)/.test(l)));
    state.on = false;
    await ft.advance(1 * S);
    const n = host.calls.length;
    bus.publish({ kind: 'chat.message', text: 'clip it' });
    await ft.advance(40 * S);
    assert.equal(host.calls.length, n);
    lm.stop();
  });
  test('host failures (reject, throw, hang) never throw and are counted', async () => {
    for (const fail of [true, 'throw']) {
      const ft = fakeTimers();
      const bus = createBus();
      const host = fakeHost({ fail });
      const lm = createLiveMarkers({ bus, flags: flagsOf({ on: true }), host, config: cfg, ...ft });
      await ft.advance(1 * S);
      bus.publish({ kind: 'chat.message', text: 'clip it' });
      await ft.advance(2 * S);
      const s = lm.stats();
      assert.equal(s.failures, 1, String(fail));
      assert.equal(s.written, 0);
      lm.stop();
    }
    const ft = fakeTimers();
    const bus = createBus();
    const host = fakeHost({ hang: true });
    const lm = createLiveMarkers({ bus, flags: flagsOf({ on: true }), host, config: cfg, ...ft });
    await ft.advance(1 * S);
    for (let i = 0; i < MAX_INFLIGHT + 3; i++) { bus.publish({ kind: 'chat.message', text: 'clip it' }); await ft.advance(cfg.minGapSec * S); }
    const s = lm.stats();
    assert.equal(host.calls.filter((c) => c.method === 'marker.add').length, MAX_INFLIGHT);
    assert.ok(s.dropped >= 3);
    lm.stop();
  });
  test('a throwing flag reader means off', async () => {
    const ft = fakeTimers();
    const host = fakeHost();
    const lm = createLiveMarkers({ bus: createBus(), flags: { isOn: () => { throw new Error('x'); } }, host, config: cfg, ...ft });
    await ft.advance(10 * S);
    assert.equal(lm.isOn(), false);
    assert.equal(host.calls.length, 0);
    lm.stop();
  });
});

describe('host link', () => {
  test('exposes marker.add and mixer.list only; re-reads discovery after a failure', async () => {
    const token = randomBytes(32).toString('hex');
    const seen = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const j = JSON.parse(b);
        seen.push({ method: j.method, auth: req.headers.authorization === `Bearer ${token}`, params: j.params });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { ok: true } }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const d = mkdtempSync(path.join(tmpdir(), 'lm-host-'));
    const disc = path.join(d, 'host.json');
    let t = 0;
    try {
      const link = createHostLink({ discoveryFile: disc, token, now: () => t, retryMs: 2000 });
      assert.deepEqual(Object.keys(link).sort(), ['addMarker', 'mixerList']);
      assert.ok(!JSON.stringify(link).includes(token));
      await assert.rejects(link.addMarker('chat', 'x'), /host-unavailable/); // no discovery file yet
      writeFileSync(disc, JSON.stringify({ port: srv.address().port }));
      await assert.rejects(link.addMarker('chat', 'x'), /host-unavailable/); // still inside retryMs
      t = 2500;
      await link.addMarker('chat', 'chat: clip request');
      await link.mixerList();
      assert.deepEqual(seen.map((s) => [s.method, s.auth]), [['marker.add', true], ['mixer.list', true]]);
      assert.deepEqual(seen[0].params, { source: 'chat', note: 'chat: clip request' });
      assert.throws(() => createHostLink({ discoveryFile: disc, token: 'nope' }), /64 hex/);
    } finally {
      srv.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('service wiring', () => {
  test('without a host token the service starts and says live markers are off', async () => {
    const { startService } = await import('../services/event-core/api/service.mjs');
    const d = mkdtempSync(path.join(tmpdir(), 'lm-svc-'));
    const lines = [];
    const svc = await startService({ dataDir: d, noStreamerbot: true, systemPipe: false, stallTracer: false, out: (l) => lines.push(l), env: {} });
    try {
      assert.equal(svc.liveMarkers, null);
      assert.ok(lines.includes('[serve] live markers: off (no host token)'));
    } finally { await svc.stop(); rmSync(d, { recursive: true, force: true }); }
  });
  test('cli serve: takes UJWALAM_HOST_MARKERS_TOKEN only; a full host token is removed unread', async () => {
    const { serve } = await import('../services/event-core/cli.mjs');
    const run = async (env) => {
      const keys = ['UJWALAM_HOST_TOKEN', 'UJWALAM_HOST_SYSTEM_TOKEN', 'UJWALAM_HOST_MARKERS_TOKEN', 'UJWALAM_HOST_DISCOVERY'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      const d = mkdtempSync(path.join(tmpdir(), 'lm-cli-'));
      const out = [];
      const ac = new AbortController();
      const io = { out: (l) => { out.push(l); if (l.startsWith('[serve] api on')) setImmediate(() => ac.abort()); }, signal: ac.signal, setPriority: () => ({ ok: true, target: 'normal', before: 'normal', after: 'normal' }) };
      try {
        const code = await serve({ 'data-dir': d, mock: true, 'no-stall-tracer': true }, io);
        const left = keys.filter((k) => k !== 'UJWALAM_HOST_DISCOVERY' && process.env[k] !== undefined);
        return { code, out, left };
      } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        rmSync(d, { recursive: true, force: true });
      }
    };
    const full = randomBytes(32).toString('hex');
    const sys = randomBytes(32).toString('hex');
    let r = await run({ UJWALAM_HOST_TOKEN: full, UJWALAM_HOST_SYSTEM_TOKEN: sys });
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('[serve] live markers: off (no host token)'), r.out.join(' | '));
    assert.deepEqual(r.left, [], 'host tokens removed from the environment');
    r = await run({ UJWALAM_HOST_MARKERS_TOKEN: randomBytes(32).toString('hex'), UJWALAM_HOST_TOKEN: full });
    assert.equal(r.code, 0);
    assert.ok(r.out.some((l) => l.startsWith('[serve] live markers: ready')), r.out.join(' | '));
    assert.deepEqual(r.left, []);
    assert.ok(!r.out.some((l) => /[0-9a-f]{64}/.test(l)), 'no token printed');
  });
  test('a published chat.message reaches the producer through the real core', async () => {
    const { startService } = await import('../services/event-core/api/service.mjs');
    const d = mkdtempSync(path.join(tmpdir(), 'lm-svc-'));
    const host = fakeHost();
    const svc = await startService({ dataDir: d, noStreamerbot: true, systemPipe: false, stallTracer: false, out: () => {}, env: {}, liveMarkers: { host, flags: flagsOf({ on: true }) } });
    try {
      assert.ok(svc.liveMarkers);
      await new Promise((r) => setTimeout(r, 1200)); // first tick reads the flag
      const r = svc.core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: 'm1', user: { platformUserId: 'u1', displayName: 'Viewer A' }, text: 'clip that' });
      assert.equal(r.status, 'published');
      await new Promise((r2) => setTimeout(r2, 50));
      const m = host.calls.filter((c) => c.method === 'marker.add');
      assert.deepEqual(m, [{ method: 'marker.add', source: 'chat', note: 'chat: clip request' }]);
    } finally { await svc.stop(); rmSync(d, { recursive: true, force: true }); }
  });
});
