// SPDX-License-Identifier: GPL-2.0-or-later
// Effect guards tests (v1 F4/F5): shared budget, cooldowns, priority and region overlap (drop, queue, preempt), flash
// limit, seeded pools, audit rows, the cam-pop rule against the legacy capture, and the guards wired into the bridge.
// A fake clock drives everything; no timers, no network except the loopback feed test at the end.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCamPopRule, createEffectGuards, createOverlayServer, createPool, DEFAULT_GUARDS_FILE, loadGuardConfig, mulberry32, validateGuardConfig } from '../services/overlay-server/index.mjs';
import { maxInWindow } from '../services/overlay-server/guards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPOP = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'overlays', 'campop-legacy.json'), 'utf8'));
const real = () => loadGuardConfig(DEFAULT_GUARDS_FILE);
const clone = (o) => JSON.parse(JSON.stringify(o));

function rig(mutate, extra = {}) {
  const config = clone(real());
  mutate?.(config);
  let t = 1_000_000;
  const audit = { rows: [], recordSystem(r) { this.rows.push(r); } };
  const delivered = [];
  const timers = [];
  const guards = createEffectGuards({
    config, now: () => t, audit, deliver: (e) => delivered.push(e.name),
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: () => {}, ...extra,
  });
  return { guards, audit, delivered, timers, config, at: (x) => { t = x; return t; }, adv: (d) => { t += d; return t; }, get t() { return t; } };
}

describe('config as data', () => {
  test('the shipped guards.json validates, carries a source and status for every number, and has the settled flash limit', () => {
    const c = real();
    assert.equal(c.flash.maxPerSecond, 3);
    assert.equal(c.flash.status, 'settled');
    for (const [id, e] of Object.entries(c.effects)) {
      assert.ok(e.durationSource && e.cooldownSource, `${id} has legacy sources`);
      assert.equal(e.status.timing, 'legacy', id);
    }
    assert.equal(c.budget.status, 'unverified');
  });

  test('legacy values are copied: cooldowns, durations, hold, burst, mic spike', () => {
    const c = real();
    assert.deepEqual([c.effects.gg.durationMs, c.effects.gg.cooldownMs], [2400, 1500]);
    assert.deepEqual([c.effects.charge.durationMs, c.effects.charge.cooldownMs], [620, 900]);
    assert.deepEqual([c.effects.storm.durationMs, c.effects.storm.cooldownMs], [750, 250]);
    assert.deepEqual([c.effects.campop.durationMs, c.effects.campop.cooldownMs], [5000, 0]);
    const r = c.rules.campop;
    assert.deepEqual([r.chatBurst.messages, r.chatBurst.windowSec, r.voice.spikeLevel, r.voice.holdMs, r.random.meanMin, r.minGapSec], [5, 10, 0.12, 150, 12, 0]);
  });

  test('a config that would allow more than 3 flashes/s, or has a bad region or unknown pool member, is refused', () => {
    for (const mutate of [(c) => { c.flash.maxPerSecond = 4; }, (c) => { c.effects.gg.region = 'nope'; }, (c) => { c.regions.full.rects = [[0, 0, 2, 1]]; },
      (c) => { c.pools.hype.items.push({ id: 'ghost', weight: 1 }); }, (c) => { c.effects.gg.onOverlap = 'stack'; }, (c) => { c.effects.gg.durationMs = 0; }]) {
      const c = clone(real());
      mutate(c);
      assert.throws(() => validateGuardConfig(c), RangeError);
    }
  });
});

describe('cooldown, busy, unknown', () => {
  test('a second play of the same effect is refused while it runs (busy), then during its cooldown counted from the END, then allowed', () => {
    const r = rig();
    assert.deepEqual(r.guards.gate({ name: 'charge', source: 'chat' }), { allow: true });       // 0..620
    assert.deepEqual(r.guards.gate({ name: 'charge' }), { allow: false, reason: 'busy' });
    r.adv(620);                                                                                    // exactly the end: still running (inclusive)
    assert.equal(r.guards.gate({ name: 'charge' }).reason, 'busy');
    r.adv(1);                                                                                      // ended; cooldown 900 from the end
    assert.equal(r.guards.gate({ name: 'charge' }).reason, 'cooldown');
    r.adv(898);
    assert.equal(r.guards.gate({ name: 'charge' }).reason, 'cooldown');
    r.adv(1);                                                                                      // 900 after the end
    assert.deepEqual(r.guards.gate({ name: 'charge' }), { allow: true });
  });

  test('cooldown 0 (cam-pop) allows an immediate repeat once the play has ended', () => {
    const r = rig();
    assert.equal(r.guards.gate({ name: 'campop' }).allow, true);
    r.adv(5001);
    assert.equal(r.guards.gate({ name: 'campop' }).allow, true);
  });

  test('an unknown or malformed effect name is refused (fail closed)', () => {
    const r = rig();
    assert.equal(r.guards.gate({ name: 'confetti' }).reason, 'unknown-effect');
    assert.equal(r.guards.gate({ name: '../x' }).reason, 'bad-name');
    assert.equal(r.guards.gate({ name: '' }).reason, 'bad-name');
    assert.equal(r.guards.gate(undefined).reason, 'bad-name');
  });
});

describe('shared budget', () => {
  test('effects of all kinds share one budget; exhausting it refuses everything until the window moves on', () => {
    const r = rig((c) => { c.budget.maxPerMinute = 4; c.regions.a = { rects: [[0, 0, 0.1, 0.1]] }; c.regions.b = { rects: [[0.2, 0, 0.1, 0.1]] };
      c.effects.layerx = { ...c.effects.charge, kind: 'layer', region: 'b', cooldownMs: 0, durationMs: 100, flashes: [] };
      c.effects.charge.region = 'a'; c.effects.charge.cooldownMs = 0; c.effects.charge.durationMs = 100; c.effects.charge.flashes = []; });
    const names = ['charge', 'layerx', 'charge', 'layerx'];
    for (const n of names) { assert.equal(r.guards.gate({ name: n }).allow, true, n); r.adv(150); }
    assert.equal(r.guards.stats().budgetUsed, 4);
    assert.equal(r.guards.gate({ name: 'charge' }).reason, 'budget');
    assert.equal(r.guards.gate({ name: 'layerx' }).reason, 'budget', 'an animated layer draws on the same budget');
    r.at(1_000_000 + 59_999);
    assert.equal(r.guards.gate({ name: 'charge' }).reason, 'budget');
    r.at(1_000_000 + 60_000);                                   // the first stamp left the window
    assert.equal(r.guards.gate({ name: 'charge' }).allow, true);
  });
});

describe('priority and region overlap', () => {
  test('non-overlapping regions play side by side (centre + edge); overlapping ones never stack', () => {
    const r = rig();
    assert.equal(r.guards.gate({ name: 'gg' }).allow, true);       // centre
    assert.equal(r.guards.gate({ name: 'charge' }).allow, true);   // edge strips do not touch the centre box
    assert.equal(r.guards.gate({ name: 'storm' }).reason, 'region-busy', 'full canvas overlaps everything running: dropped (legacy: drop)');
    assert.equal(r.guards.gate({ name: 'campop' }).reason, 'region-busy', 'the camera box overlaps the left edge strip while charge runs');
  });

  test('drop policy: the dropped effect is counted with its reason and never plays later', () => {
    const r = rig();
    r.guards.gate({ name: 'storm' });
    assert.equal(r.guards.gate({ name: 'campop' }).reason, 'region-busy');
    r.adv(5000);
    r.guards.tick();
    assert.equal(r.delivered.length, 0);
    assert.equal(r.guards.stats().byReason['region-busy'], 1);
  });

  test('queue policy: a queued effect waits, is released in priority order after the blocker ends, and is delivered once', () => {
    const r = rig((c) => { c.effects.gg.onOverlap = 'queue'; c.effects.campop.onOverlap = 'queue'; c.queue.ttlMs = 10_000; });
    r.guards.gate({ name: 'storm' });                                   // full canvas, 750 ms
    assert.equal(r.guards.gate({ name: 'campop', source: 'rule' }).reason, 'queued');   // priority 80
    r.adv(10);
    assert.equal(r.guards.gate({ name: 'gg' }).reason, 'queued');                      // priority 70, arrived later
    assert.equal(r.guards.stats().queued_now, 2);
    r.adv(500);
    r.guards.tick();
    assert.deepEqual(r.delivered, [], 'still blocked');
    r.adv(300);                                                          // storm over
    r.guards.tick();
    assert.deepEqual(r.delivered, ['campop'], 'higher priority first');
    r.adv(5001);
    r.guards.tick();
    assert.deepEqual(r.delivered, ['campop', 'gg']);
    assert.equal(r.guards.stats().queued_now, 0);
    assert.equal(r.guards.stats().released, 2);
  });

  test('a queued effect that waits longer than the ttl is dropped with queue-expired; a full queue drops with queue-full', () => {
    const r = rig((c) => { c.effects.gg.onOverlap = 'queue'; c.queue.ttlMs = 1000; c.queue.max = 1; });
    r.guards.gate({ name: 'storm' });
    assert.equal(r.guards.gate({ name: 'gg' }).reason, 'queued');
    r.adv(1);
    assert.equal(r.guards.gate({ name: 'gg' }).reason, 'busy', 'the same effect is not queued twice');
    r.adv(1500);
    r.guards.tick();
    assert.equal(r.delivered.length, 0);
    assert.equal(r.guards.stats().byReason['queue-expired'], 1);
    const q = rig((c) => { c.effects.gg.onOverlap = 'queue'; c.effects.storm.onOverlap = 'queue'; c.queue.max = 1; });
    q.guards.gate({ name: 'charge' });
    assert.equal(q.guards.gate({ name: 'storm' }).reason, 'queued');
    assert.equal(q.guards.gate({ name: 'campop' }).reason, 'region-busy');
    q.guards.gate({ name: 'gg' });
    assert.equal(q.guards.gate({ name: 'gg' }).reason, 'busy');
  });

  test('preemption: a higher-priority effect cuts an interruptible lower-priority one; a non-interruptible one is not cut', () => {
    const preempted = [];
    const r = rig((c) => { c.effects.storm.interruptible = true; c.effects.storm.priority = 10; c.effects.storm.flashes = [0, 400]; }, { onPreempt: (p) => preempted.push(p) });
    assert.equal(r.guards.gate({ name: 'storm' }).allow, true);
    r.adv(100);
    assert.deepEqual(r.guards.gate({ name: 'campop' }), { allow: true });
    assert.deepEqual(preempted, [{ name: 'storm', by: 'campop' }]);
    assert.equal(r.guards.stats().preempted, 1);
    assert.ok(r.audit.rows.some((x) => x.verdict === 'preempt' && x.detail.by === 'campop'));
    r.adv(10);
    assert.equal(r.guards.gate({ name: 'storm' }).reason, 'cooldown', 'a cut effect still cools down from the cut');
    r.adv(300);
    assert.equal(r.guards.gate({ name: 'storm' }).reason, 'region-busy', 'now campop (higher) is running and not interruptible');
    // a lower-priority effect cannot cut a higher one even when it is interruptible
    const s = rig((c) => { c.effects.campop.interruptible = true; });
    s.guards.gate({ name: 'campop' });
    assert.equal(s.guards.gate({ name: 'storm' }).reason, 'region-busy');
  });
});

describe('flash safety', () => {
  const flashy = (c) => {
    c.regions.a = { rects: [[0, 0, 0.1, 0.1]] }; c.regions.b = { rects: [[0.2, 0, 0.1, 0.1]] }; c.regions.c = { rects: [[0.4, 0, 0.1, 0.1]] }; c.regions.d = { rects: [[0.6, 0, 0.1, 0.1]] };
    for (const [n, reg] of [['f1', 'a'], ['f2', 'b'], ['f3', 'c'], ['f4', 'd']]) c.effects[n] = { ...c.effects.charge, region: reg, cooldownMs: 0, durationMs: 50, flashes: [0], priority: 1 };
  };
  test('at most 3 flashes in any 1 s window per canvas: the fourth is refused, and allowed once the window has moved on', () => {
    const r = rig(flashy);
    assert.equal(r.guards.gate({ name: 'f1' }).allow, true);
    r.adv(100); assert.equal(r.guards.gate({ name: 'f2' }).allow, true);
    r.adv(100); assert.equal(r.guards.gate({ name: 'f3' }).allow, true);
    r.adv(100); assert.equal(r.guards.gate({ name: 'f4' }).reason, 'flash-limit');
    r.at(1_000_000 + 999); assert.equal(r.guards.gate({ name: 'f4' }).reason, 'flash-limit');
    r.at(1_000_000 + 1000); assert.equal(r.guards.gate({ name: 'f4' }).allow, true, 'the first flash is exactly 1 s old');
  });

  test('flashes inside a single play count too: a play that flashes 4 times in a second can never run', () => {
    const r = rig((c) => { c.effects.charge.flashes = [0, 200, 400, 600]; });
    assert.equal(r.guards.gate({ name: 'charge' }).reason, 'flash-limit');
    const ok = rig((c) => { c.effects.charge.flashes = [0, 400, 800, 1200]; });
    assert.equal(ok.guards.gate({ name: 'charge' }).allow, true);
  });

  test('the limit is per canvas: a play on one canvas does not use the other canvas', () => {
    const r = rig(flashy);
    for (const n of ['f1', 'f2', 'f3']) { assert.equal(r.guards.gate({ name: n, canvas: 'h' }).allow, true); r.adv(10); }
    assert.equal(r.guards.gate({ name: 'f4', canvas: 'h' }).reason, 'flash-limit');
    assert.equal(r.guards.gate({ name: 'f4', canvas: 'v' }).allow, true);
  });

  test('a measured flash rate above the limit (from fx test) blocks the effect; below it changes nothing', () => {
    const r = rig();
    r.guards.reportMeasuredFlashes({ effect: 'storm', canvas: 'h', flashesPerSecond: 5.5 });
    assert.equal(r.guards.gate({ name: 'storm' }).reason, 'flash-limit');
    r.guards.reportMeasuredFlashes({ effect: 'storm', canvas: 'h', flashesPerSecond: 2 });
    assert.equal(r.guards.gate({ name: 'storm' }).allow, true);
    assert.throws(() => r.guards.reportMeasuredFlashes({ effect: 'nope', canvas: 'h', flashesPerSecond: 1 }), RangeError);
  });

  test('maxInWindow counts a window that starts at each flash', () => {
    assert.equal(maxInWindow([0, 300, 600, 900], 1000), 4);
    assert.equal(maxInWindow([0, 500, 1000, 1500], 1000), 2);
    assert.equal(maxInWindow([], 1000), 0);
  });
});

describe('seeded pools', () => {
  test('the same seed gives the same sequence; a different seed gives a different one', () => {
    const items = [{ id: 'a', weight: 3 }, { id: 'b', weight: 2 }, { id: 'c', weight: 1 }];
    const run = (seed) => { const p = createPool({ items, noRepeatLast: 1, rng: mulberry32(seed) }); return Array.from({ length: 40 }, () => p.pick()); };
    assert.deepEqual(run(7), run(7));
    assert.notDeepEqual(run(7), run(8));
  });

  test('no pick repeats any of the last N while another choice exists', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, weight: 1 }));
    for (const n of [1, 2, 3]) {
      const p = createPool({ items, noRepeatLast: n, rng: mulberry32(11) });
      const seq = Array.from({ length: 300 }, () => p.pick());
      for (let i = n; i < seq.length; i++) assert.ok(!seq.slice(i - n, i).includes(seq[i]), `n=${n} at ${i}`);
    }
  });

  test('weights are respected over many picks, and a one-item or over-constrained pool still answers', () => {
    const p = createPool({ items: [{ id: 'heavy', weight: 9 }, { id: 'light', weight: 1 }, { id: 'mid', weight: 3 }], noRepeatLast: 0, rng: mulberry32(3) });
    const c = { heavy: 0, light: 0, mid: 0 };
    for (let i = 0; i < 6000; i++) c[p.pick()]++;
    assert.ok(c.heavy > c.mid && c.mid > c.light, JSON.stringify(c));
    assert.ok(Math.abs(c.heavy / 6000 - 9 / 13) < 0.04);
    const one = createPool({ items: [{ id: 'x', weight: 1 }], noRepeatLast: 3, rng: mulberry32(1) });
    assert.deepEqual([one.pick(), one.pick()], ['x', 'x']);
    const two = createPool({ items: [{ id: 'x', weight: 1 }, { id: 'y', weight: 1 }], noRepeatLast: 5, rng: mulberry32(1) });
    const s = Array.from({ length: 20 }, () => two.pick());
    for (let i = 1; i < s.length; i++) assert.notEqual(s[i], s[i - 1]);
    assert.throws(() => createPool({ items: [], rng: mulberry32(1) }), RangeError);
    assert.throws(() => createPool({ items: [{ id: 'x', weight: 0 }], rng: mulberry32(1) }), RangeError);
  });

  test('guards.pick uses the configured pool and its seed; an unknown pool is an error', () => {
    const a = rig(); const b = rig();
    const sa = Array.from({ length: 20 }, () => a.guards.pick('hype'));
    const sb = Array.from({ length: 20 }, () => b.guards.pick('hype'));
    assert.deepEqual(sa, sb);
    for (let i = 1; i < sa.length; i++) assert.notEqual(sa[i], sa[i - 1]);
    for (const n of sa) assert.ok(a.config.effects[n]);
    assert.throws(() => a.guards.pick('nope'), RangeError);
  });
});

describe('refusals are visible', () => {
  test('every refuse, queue, drop, release and preempt is in stats, the ring and the audit, with a reason and no text', () => {
    const r = rig((c) => { c.effects.gg.onOverlap = 'queue'; c.queue.ttlMs = 100; });
    r.guards.gate({ name: 'storm', source: 'chat' });
    r.guards.gate({ name: 'storm', source: 'chat' });
    r.guards.gate({ name: 'campop', source: 'campop-chat-message' });
    r.guards.gate({ name: 'gg', source: 'api' });
    r.adv(200); r.guards.tick();
    r.guards.gate({ name: 'confetti', source: 'hello world, a chat sentence' });
    const s = r.guards.stats();
    assert.equal(s.allowed, 1);
    assert.equal(s.byReason.busy, 1);
    assert.equal(s.byReason['region-busy'], 1);
    assert.equal(s.byReason.queued, 1);
    assert.equal(s.byReason['queue-expired'], 1);
    assert.equal(s.byReason['unknown-effect'], 1);
    assert.equal(r.guards.recent().length, 6);
    assert.equal(r.audit.rows.length, 6);
    for (const row of r.audit.rows) {
      assert.equal(row.subtype, 'effect-guard');
      assert.ok(row.verdict && (row.reason || row.verdict === 'allow'));
      assert.match(JSON.stringify(row), /^[\x20-\x7e]*$/);
    }
    const dirty = r.audit.rows.find((x) => x.detail.effect === 'confetti');
    assert.equal(dirty.detail.origin, 'unknown', 'a free-text source never reaches the audit');
    assert.ok(!JSON.stringify([r.guards.recent(), r.audit.rows, s]).includes('chat sentence'));
  });

  test('an audit that throws never breaks the gate', () => {
    const r = rig(null, { audit: { recordSystem() { throw new Error('disk gone'); } } });
    assert.equal(r.guards.gate({ name: 'gg' }).allow, true);
  });
});

describe('cam-pop rule against the legacy capture', () => {
  function drive(run) {
    const r = rig();
    const rule = createCamPopRule({ config: { ...r.config.rules.campop, chatMessage: { ...r.config.rules.campop.chatMessage, enabled: run.config.chatMessageEnabled } },
      fire: (e) => { const v = r.guards.gate(e); const ok = v.allow; if (ok) pops.push(r.t - 1_000_000); return { ok }; }, now: () => r.t });
    const pops = [];
    for (const at of run.chatMessagesMs) { r.at(1_000_000 + at); rule.onChat(); }
    return { pops, rule, r };
  }

  for (const run of CAPOP.runs) {
    test(`${run.name}: the same pops at the same times as the legacy tool`, () => {
      const { pops, rule } = drive(run);
      assert.deepEqual(pops, run.expectedPopsMs);
      if (run.config.chatMessageEnabled) assert.ok(rule.stats().refused > 0, 'triggers during a pop are dropped, not queued');
    });
  }

  test('through the gate, a trigger during a pop is refused busy and counted; nothing is queued', () => {
    const { r } = drive(CAPOP.runs[0]);
    const s = r.guards.stats();
    assert.equal(s.queued_now, 0);
    assert.ok(s.byReason.busy >= 10);
    assert.equal(s.byEffect.campop.allowed, 3);
  });

  test('voice: a level at or above 0.12 for 150 ms fires once; a dip resets the hold', () => {
    const r = rig();
    const fired = [];
    const rule = createCamPopRule({ config: r.config.rules.campop, fire: (e) => { fired.push(e.source); return { ok: true }; }, now: () => r.t });
    for (const [dt, lvl] of [[0, 0.05], [50, 0.13], [50, 0.2], [50, 0.2], [50, 0.2]]) { r.adv(dt); rule.onMicLevel(lvl); }
    assert.deepEqual(fired, ['campop-voice-spike'], 'fires at 150 ms above the threshold');
    fired.length = 0;
    for (const [dt, lvl] of [[100, 0.13], [50, 0.13], [50, 0.05], [50, 0.13], [50, 0.13]]) { r.adv(dt); rule.onMicLevel(lvl); }
    assert.deepEqual(fired, [], 'a dip below the level resets the timer');
    rule.onMicLevel(0.11);
    r.adv(500); rule.onMicLevel(0.119);
    assert.deepEqual(fired, []);
  });

  test('random: fires with chance 1/meanMin per check (seeded RNG decides), not otherwise', () => {
    const r = rig();
    const fired = [];
    const seq = [0.5, 0.0, 0.0833, 0.0834, 0.99];
    let i = 0;
    const rule = createCamPopRule({ config: r.config.rules.campop, fire: (e) => { fired.push(e.source); return { ok: true }; }, now: () => r.t, rng: () => seq[i++] });
    for (let k = 0; k < seq.length; k++) { r.adv(60_000); rule.tickRandom(); }
    assert.deepEqual(fired, ['campop-random', 'campop-random']);
  });

  test('minGapSec is honoured after an admitted pop (legacy default 0 = none)', () => {
    const r = rig((c) => { c.rules.campop.minGapSec = 30; });
    const rule = createCamPopRule({ config: r.config.rules.campop, fire: (e) => ({ ok: r.guards.gate(e).allow }), now: () => r.t });
    rule.onChat();                                  // pop at 0
    r.adv(6000); rule.onChat();                     // gate would allow (5 s over) but the gap of 30 s has not passed
    assert.equal(r.guards.stats().byEffect.campop.allowed, 1);
    r.adv(25_000); rule.onChat();
    assert.equal(r.guards.stats().byEffect.campop.allowed, 2);
    assert.equal(rule.stats().gap, 1);
  });
});

describe('guards wired into the bridge', () => {
  function wsOpen(port, urlPath, origin) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.write([`GET ${urlPath} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Origin: ${origin}`].join('\r\n') + '\r\n\r\n');
      const frames = [];
      let opened = false;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!opened) { const e = buf.indexOf('\r\n\r\n'); if (e === -1) return; opened = true; buf = buf.subarray(e + 4); resolve({ sock, frames, send: (o) => sock.write(masked(JSON.stringify(o))) }); }
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f; let off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) break;
          if ((buf[0] & 0x0f) === 1) frames.push(JSON.parse(buf.subarray(off, off + len).toString()));
          buf = buf.subarray(off + len);
        }
      });
      sock.on('error', reject);
    });
  }
  function masked(text) {
    const p = Buffer.from(text); const m = randomBytes(4); const b = Buffer.from(p);
    for (let i = 0; i < b.length; i++) b[i] ^= m[i % 4];
    return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, b]);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('publishEffect goes through the guards; chat for /effects/<name> pages is gated per message; refusals are audited', async () => {
    const audit = { rows: [], recordSystem(r) { this.rows.push(r); } };
    const { createEventCore } = await import('../services/event-core/index.mjs');
    const core = createEventCore({ key: Buffer.alloc(32, 7), moderation: false, actions: false });
    const cfg = clone(real());
    const s = createOverlayServer({ root: path.join(HERE, '..', 'services', 'overlay-server', 'relay'), bus: core.bus, guards: cfg, audit });
    // the static root only has to exist for this test
    await s.start();
    try {
      const origin = `http://127.0.0.1:${s.staticPort}`;
      const charge = await wsOpen(s.feedPort, '/effects/charge', origin);
      const plain = await wsOpen(s.feedPort, '/', origin);
      for (const c of [charge, plain]) c.send({ request: 'Subscribe', id: 's', events: { Twitch: ['ChatMessage'] } });
      await wait(60);
      const chat = (t) => core.ingest({ kind: 'chat.message', platform: 'twitch', source: 'mock', platformMessageId: `m${Math.random()}`, user: { platformUserId: 'u1', displayName: 'ViewerOne' }, text: t });
      chat('one');
      await wait(60);
      const envelopes = (c) => c.frames.filter((f) => f.event);
      assert.equal(envelopes(charge).length, 1, 'gate admitted charge for the first message');
      assert.equal(envelopes(plain).length, 1, 'the ungated /: path always gets chat');
      chat('two');                                         // charge is busy (620 ms) and cooling down: gated
      await wait(60);
      assert.equal(envelopes(charge).length, 1, 'refused by the gate: the page gets no envelope, so it draws nothing');
      assert.equal(envelopes(plain).length, 2);
      assert.deepEqual(s.bridge.publishEffect('gg', { source: 'api' }), { ok: true });
      assert.deepEqual(s.bridge.publishEffect('gg', { source: 'api' }), { ok: false, reason: 'busy' });
      assert.deepEqual(s.bridge.publishEffect('confetti'), { ok: false, reason: 'unknown-effect' });
      await wait(60);
      assert.equal(plain.frames.filter((f) => f.rp === 'event' && f.data.name === 'gg').length, 1, 'only the admitted gg reached the overlay bus');
      const reasons = audit.rows.map((x) => x.reason ?? 'allow');
      assert.ok(reasons.includes('busy') && reasons.includes('unknown-effect'));
      assert.ok(s.bridge.stats().chatGated >= 1);
      assert.ok(!JSON.stringify(audit.rows).includes('ViewerOne') && !JSON.stringify(audit.rows).includes('two'));
      charge.sock.destroy(); plain.sock.destroy();
    } finally { await s.stop(); }
  });
});
