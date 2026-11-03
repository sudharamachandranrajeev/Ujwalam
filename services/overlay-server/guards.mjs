// SPDX-License-Identifier: GPL-2.0-or-later
// Effect guards (v1 F4/F5): one shared budget for effects and event-driven animated layers. Node stdlib only.
//
//   const guards = createEffectGuards({ config, now, audit, deliver });
//   bridge = createOverlayBridge({ effectGate: guards.gate });          // sync gate: { allow, reason }
//   guards.setDeliver((effect) => bridge.deliverEffect(effect.name));   // used when a queued effect is released
//
// What gate(effect) enforces, in this order (effect = { name, source?, canvas? }):
//   1. unknown effect name                    -> refuse 'unknown-effect' (fail closed: no config, no play)
//   2. the same effect is still running       -> refuse 'busy'            (legacy pages drop while busy)
//   3. per-effect cooldown                    -> refuse 'cooldown'        (legacy counts it from the END of the play)
//   4. shared budget (plays per window)       -> refuse 'budget'
//   5. claimed screen region overlaps a play that is still running:
//        incoming priority higher AND the running one is interruptible -> preempt it (hook onPreempt), go on
//        otherwise the incoming effect's onOverlap: 'drop' -> refuse 'region-busy'; 'queue' -> 'queued'
//        (bounded queue, priority first then arrival order, expires after ttlMs -> dropped 'queue-expired').
//        Effects never stack: an overlapping play is never admitted next to a running one.
//   6. flash safety, per canvas: the flashes the play would add (offsets from its start) plus the flashes already
//        scheduled must stay within maxPerSecond in every windowMs window -> refuse 'flash-limit'.
// Every decision (allow, refuse, queue, release, drop, preempt) is counted, kept in a short ring and sent to the
// audit as a system row with a reason code and numbers only. No chat text, names or ids are ever stored here.
//
// TODO(host): flash rate here is the DECLARED rate from guards.json ('flashes' offsets). The measured rate needs
// the host's rendered frames (luminance per frame, `fx test`), which this service cannot see. Until the host
// provides frames, the declared values are UNVERIFIED and no measurement is claimed. Hook: guards.reportMeasuredFlashes(
// { effect, canvas, flashesPerSecond }) lets `fx test` write the measured peak back; the gate then uses the larger of
// the declared and the measured value for that effect.

import { readFileSync } from 'node:fs';

export const REASONS = Object.freeze(['unknown-effect', 'busy', 'cooldown', 'budget', 'region-busy', 'flash-limit', 'queued', 'queue-expired', 'queue-full', 'preempted', 'bad-name']);
const TOKEN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SOURCE_TOKEN = /^[A-Za-z0-9_.:-]{1,32}$/;
const CANVASES = ['h', 'v'];

// ---- seeded RNG and pools ----
/** mulberry32: small, fast, good enough for picking effects. Same seed, same sequence. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted pick that does not repeat any of the last `noRepeatLast` picks while another choice exists.
 *  items: [{ id, weight > 0 }]. rng: () => [0,1). If every item was used recently the oldest-used rule relaxes:
 *  the most recent pick is still excluded when there are at least two items. */
export function createPool({ items, noRepeatLast = 1, rng }) {
  if (!Array.isArray(items) || !items.length) throw new RangeError('pool needs items');
  for (const it of items) if (typeof it.id !== 'string' || !(it.weight > 0) || !Number.isFinite(it.weight)) throw new RangeError('pool item needs id and weight > 0');
  if (!Number.isInteger(noRepeatLast) || noRepeatLast < 0) throw new RangeError('noRepeatLast must be an integer >= 0');
  const history = [];
  return {
    history: () => [...history],
    pick() {
      const recent = new Set(noRepeatLast ? history.slice(-noRepeatLast) : []);
      let pool = items.filter((i) => !recent.has(i.id));
      if (!pool.length) pool = items.length > 1 ? items.filter((i) => i.id !== history[history.length - 1]) : items;
      const total = pool.reduce((s, i) => s + i.weight, 0);
      let r = rng() * total;
      let chosen = pool[pool.length - 1];
      for (const i of pool) { r -= i.weight; if (r < 0) { chosen = i; break; } }
      history.push(chosen.id);
      if (history.length > Math.max(noRepeatLast, 1) * 4) history.splice(0, history.length - Math.max(noRepeatLast, 1) * 4);
      return chosen.id;
    },
  };
}

// ---- config ----
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Throws RangeError listing every problem. Returns the config (not copied). */
export function validateGuardConfig(c) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (!isObj(c)) throw new RangeError('guards config must be an object');
  if (c.version !== 1) bad('version must be 1');
  if (!isObj(c.flash) || !num(c.flash.maxPerSecond, 0, 3)) bad('flash.maxPerSecond must be a number from 0 to 3 (the settled limit)');
  if (isObj(c.flash) && !num(c.flash.windowMs, 100, 10_000)) bad('flash.windowMs must be 100..10000');
  if (!isObj(c.budget) || !num(c.budget.maxPerMinute, 1, 10_000) || !num(c.budget.windowMs, 1000, 3_600_000)) bad('budget.maxPerMinute and windowMs are required numbers');
  if (!isObj(c.queue) || !num(c.queue.max, 0, 64) || !num(c.queue.ttlMs, 0, 60_000)) bad('queue.max and ttlMs are required numbers');
  if (!isObj(c.regions)) bad('regions must be an object');
  else {
    for (const [id, r] of Object.entries(c.regions)) {
      if (!TOKEN.test(id)) bad(`region id ${id}`);
      if (!Array.isArray(r?.rects) || !r.rects.length) { bad(`region ${id}: rects required`); continue; }
      for (const q of r.rects) if (!Array.isArray(q) || q.length !== 4 || !q.every((n) => num(n, 0, 1)) || q[2] <= 0 || q[3] <= 0 || q[0] + q[2] > 1.0001 || q[1] + q[3] > 1.0001) bad(`region ${id}: bad rect ${JSON.stringify(q)}`);
    }
  }
  if (!isObj(c.effects) || !Object.keys(c.effects).length) bad('effects must be a non-empty object');
  else {
    for (const [id, e] of Object.entries(c.effects)) {
      if (!TOKEN.test(id)) bad(`effect id ${id}`);
      if (!num(e?.durationMs, 1, 600_000)) bad(`effect ${id}: durationMs`);
      if (!num(e?.cooldownMs, 0, 600_000)) bad(`effect ${id}: cooldownMs`);
      if (e?.cooldownFrom !== 'end' && e?.cooldownFrom !== 'start') bad(`effect ${id}: cooldownFrom must be end or start`);
      if (!isObj(c.regions) || !c.regions[e?.region]) bad(`effect ${id}: unknown region ${e?.region}`);
      if (!Number.isInteger(e?.priority) || e.priority < 0 || e.priority > 1000) bad(`effect ${id}: priority`);
      if (e?.onOverlap !== 'drop' && e?.onOverlap !== 'queue') bad(`effect ${id}: onOverlap must be drop or queue`);
      if (typeof e?.interruptible !== 'boolean') bad(`effect ${id}: interruptible must be boolean`);
      if (!Array.isArray(e?.flashes) || !e.flashes.every((n) => num(n, 0, 600_000))) bad(`effect ${id}: flashes must be offsets in ms`);
    }
  }
  for (const [id, p] of Object.entries(c.pools ?? {})) {
    if (!Array.isArray(p?.items) || !p.items.length) bad(`pool ${id}: items`);
    else for (const i of p.items) if (!isObj(c.effects) || !c.effects[i?.id] || !(i.weight > 0)) bad(`pool ${id}: item ${i?.id} is not a known effect with weight > 0`);
    if (!Number.isInteger(p?.noRepeatLast) || p.noRepeatLast < 0) bad(`pool ${id}: noRepeatLast`);
  }
  if (c.rules !== undefined && !isObj(c.rules)) bad('rules must be an object');
  else if (c.rules?.campop !== undefined) validateCamPopVoice(c.rules.campop, bad);
  if (errs.length) throw new RangeError(`invalid guards config: ${errs.join('; ')}`);
  return c;
}

// Project audio source ids (data/schemas/project.schema.json $defs.id).
const AUDIO_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// rules.campop.voice: the mic spike trigger. audioSource names the project audio source whose meter the host feeds to
// the rule (op "mic" on the overlay child); null or absent = no mic feed. Data, never a device name in engine code.
function validateCamPopVoice(r, bad) {
  if (!isObj(r)) { bad('rules.campop must be an object'); return; }
  const v = r.voice;
  if (!isObj(v)) { bad('rules.campop.voice must be an object'); return; }
  if (typeof v.enabled !== 'boolean') bad('rules.campop.voice.enabled must be boolean');
  if (!num(v.spikeLevel, 0, 1) || v.spikeLevel === 0) bad('rules.campop.voice.spikeLevel must be a linear level above 0, at most 1');
  if (!num(v.holdMs, 0, 60_000)) bad('rules.campop.voice.holdMs must be 0..60000');
  const a = v.audioSource;
  if (a === undefined || a === null) return;
  if (!isObj(a)) { bad('rules.campop.voice.audioSource must be an object or null'); return; }
  if (typeof a.id !== 'string' || !AUDIO_ID.test(a.id)) bad('rules.campop.voice.audioSource.id must be a project audio source id');
  if (a.status !== 'unverified' && a.status !== 'verified') bad('rules.campop.voice.audioSource.status must be unverified or verified');
  if (typeof a.source !== 'string' || !a.source.trim()) bad('rules.campop.voice.audioSource.source is required');
  if (typeof a.checked !== 'string' || !DATE.test(a.checked) || Number.isNaN(Date.parse(a.checked))) bad('rules.campop.voice.audioSource.checked must be a YYYY-MM-DD date');
}

export function loadGuardConfig(file) {
  return validateGuardConfig(JSON.parse(readFileSync(file, 'utf8')));
}

// ---- geometry ----
const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const regionsOverlap = (ra, rb) => ra.some((a) => rb.some((b) => overlap(a, b)));

/** Largest number of times inside any window of `windowMs` (a window starts at one of the times). */
export function maxInWindow(times, windowMs) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    while (t[i] - t[j] >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** opts: { config, now?, audit?, deliver?, onPreempt?, onDecision?, setTimer?, clearTimer?, seed?, ringSize? }
 *  audit: anything with recordSystem({subtype, source, verdict, reason, detail}) (the event-core audit). */
export function createEffectGuards(opts) {
  const cfg = validateGuardConfig(opts.config);
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const ringSize = opts.ringSize ?? 200;
  let deliver = opts.deliver ?? null;
  const rng = mulberry32(opts.seed ?? cfg.seed ?? 1);
  const pools = new Map(Object.entries(cfg.pools ?? {}).map(([id, p]) => [id, createPool({ items: p.items, noRepeatLast: p.noRepeatLast, rng })]));

  const active = [];                    // admitted plays: { id, name, start, end, priority, interruptible, rects }
  const lastEnd = new Map();            // effect -> end of its last admitted play
  const budgetStamps = [];              // start times of admitted plays inside the budget window
  const flashTimes = { h: [], v: [] };  // scheduled flash instants per canvas
  const measured = new Map();           // `${effect}:${canvas}` -> measured flashes per second (from fx test)
  const queue = [];                     // { effect, queuedAt, seq }
  const ftOwner = new Map();            // flash instant -> play (only to cut a preempted play's later flashes)
  let seq = 0;
  let playId = 0;
  let timer = null;

  const stats = { allowed: 0, refused: 0, queued: 0, released: 0, dropped: 0, preempted: 0, byReason: {}, byEffect: {} };
  const ring = [];

  function count(name, key) {
    const e = (stats.byEffect[name] ??= { allowed: 0, refused: 0, queued: 0, released: 0, dropped: 0, preempted: 0 });
    e[key]++;
  }

  function record(verdict, effect, reason, extra = {}) {
    const key = { allow: 'allowed', refuse: 'refused', queue: 'queued', release: 'released', drop: 'dropped', preempt: 'preempted' }[verdict];
    stats[key]++;
    if (reason) stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    count(effect.name, key);
    const row = { at: now(), effect: effect.name, source: effect.source, verdict, reason: reason ?? null, ...extra };
    ring.push(row);
    if (ring.length > ringSize) ring.shift();
    try {
      opts.audit?.recordSystem({
        subtype: 'effect-guard', source: 'rule', verdict, reason: reason ?? undefined,
        detail: { effect: effect.name, origin: effect.source, ...extra },
      });
    } catch { /* the audit never blocks the gate */ }
    try { opts.onDecision?.(row); } catch { /* observer bug */ }
  }

  function prune(t) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].end < t) active.splice(i, 1);
    while (budgetStamps.length && t - budgetStamps[0] >= cfg.budget.windowMs) budgetStamps.shift();
    for (const c of CANVASES) while (flashTimes[c].length && flashTimes[c][0] < t - cfg.flash.windowMs) flashTimes[c].shift();
  }

  function normalise(e) {
    const name = String(e?.name ?? '').toLowerCase();
    const source = SOURCE_TOKEN.test(String(e?.source ?? '')) ? String(e.source) : 'unknown';
    const canvases = e?.canvas === 'h' || e?.canvas === 'v' ? [e.canvas] : CANVASES;
    return { name, source, canvases };
  }

  /** Pure check against current state. Returns { ok:true, preempt: [plays], flashes } or { ok:false, reason, mode }. */
  function evaluate(effect, t, { allowQueue }) {
    const def = cfg.effects[effect.name];
    if (!TOKEN.test(effect.name) || !def) return { ok: false, reason: TOKEN.test(effect.name) ? 'unknown-effect' : 'bad-name', mode: 'refuse' };
    if (active.some((p) => p.name === effect.name && t <= p.end)) return { ok: false, reason: 'busy', mode: 'refuse' };
    const le = lastEnd.get(effect.name);
    if (le !== undefined) {
      const from = def.cooldownFrom === 'end' ? le : le - def.durationMs;
      if (t - from < def.cooldownMs) return { ok: false, reason: 'cooldown', mode: 'refuse' };
    }
    if (budgetStamps.length >= cfg.budget.maxPerMinute) return { ok: false, reason: 'budget', mode: 'refuse' };
    const rects = cfg.regions[def.region].rects;
    const running = active.filter((p) => t <= p.end && regionsOverlap(rects, p.rects));
    const preempt = [];
    for (const p of running) {
      if (def.priority > p.priority && p.interruptible) preempt.push(p);
      else return def.onOverlap === 'queue' && allowQueue ? { ok: false, reason: 'queued', mode: 'queue' } : { ok: false, reason: 'region-busy', mode: 'refuse' };
    }
    // Flash safety on the schedule that would exist after this play (preempted plays' later flashes are cut).
    const cut = new Set(preempt.map((p) => p.id));
    const flashes = def.flashes.map((o) => t + o);
    const rate = Math.max(...effect.canvases.map((c) => measured.get(`${effect.name}:${c}`) ?? 0), 0);
    if (rate > cfg.flash.maxPerSecond) return { ok: false, reason: 'flash-limit', mode: 'refuse' };
    for (const c of effect.canvases) {
      const kept = flashTimes[c].filter((ft) => !cut.has(ftOwner.get(ft)?.id) || ft <= t);
      if (flashes.length && maxInWindow([...kept, ...flashes], cfg.flash.windowMs) > cfg.flash.maxPerSecond) return { ok: false, reason: 'flash-limit', mode: 'refuse' };
    }
    return { ok: true, preempt, flashes };
  }

  function admit(effect, t, ev) {
    const def = cfg.effects[effect.name];
    for (const p of ev.preempt) {
      p.end = t;
      for (const c of CANVASES) flashTimes[c] = flashTimes[c].filter((ft) => !(ft > t && ftOwner.get(ft)?.id === p.id));
      lastEnd.set(p.name, t);
      record('preempt', { name: p.name, source: effect.source }, 'preempted', { by: effect.name });
      try { opts.onPreempt?.({ name: p.name, by: effect.name }); } catch { /* hook bug */ }
    }
    const play = { id: ++playId, name: effect.name, start: t, end: t + def.durationMs, priority: def.priority, interruptible: def.interruptible, rects: cfg.regions[def.region].rects };
    active.push(play);
    lastEnd.set(effect.name, play.end);
    budgetStamps.push(t);
    for (const c of effect.canvases) for (const ft of ev.flashes) { flashTimes[c].push(ft); ftOwner.set(ft, play); }
    if (ftOwner.size > 512) for (const k of [...ftOwner.keys()].slice(0, 256)) ftOwner.delete(k);
  }

  function gate(raw) {
    const t = now();
    prune(t);
    const effect = normalise(raw);
    const ev = evaluate(effect, t, { allowQueue: true });
    if (ev.ok) { admit(effect, t, ev); record('allow', effect, null); return { allow: true }; }
    if (ev.mode === 'queue') {
      if (queue.some((q) => q.effect.name === effect.name)) { record('refuse', effect, 'busy'); return { allow: false, reason: 'busy' }; }
      if (queue.length >= cfg.queue.max) { record('drop', effect, 'queue-full'); return { allow: false, reason: 'queue-full' }; }
      queue.push({ effect, queuedAt: t, seq: ++seq });
      record('queue', effect, 'queued', { queueLength: queue.length });
      schedule(t);
      return { allow: false, reason: 'queued' };
    }
    record('refuse', effect, ev.reason);
    return { allow: false, reason: ev.reason };
  }

  /** Try to release queued effects (priority first, then arrival order). Call from a timer or a test. */
  function tick() {
    const t = now();
    prune(t);
    queue.sort((a, b) => cfg.effects[b.effect.name].priority - cfg.effects[a.effect.name].priority || a.seq - b.seq);
    for (let i = 0; i < queue.length;) {
      const q = queue[i];
      if (t - q.queuedAt > cfg.queue.ttlMs) { queue.splice(i, 1); record('drop', q.effect, 'queue-expired'); continue; }
      const ev = evaluate(q.effect, t, { allowQueue: false });
      if (ev.ok) {
        queue.splice(i, 1);
        admit(q.effect, t, ev);
        record('release', q.effect, null, { waitedMs: t - q.queuedAt });
        try { deliver?.(q.effect); } catch { /* a delivery bug must not stop the queue */ }
        continue;
      }
      if (ev.reason === 'budget' || ev.reason === 'unknown-effect' || ev.reason === 'bad-name') { queue.splice(i, 1); record('drop', q.effect, ev.reason); continue; }
      i++;
    }
    if (queue.length) schedule(t);
  }

  function schedule(t) {
    if (timer) { clearTimer(timer); timer = null; }
    if (!queue.length) return;
    const next = [...active.map((p) => p.end + 1), ...[...lastEnd.values()].map((e) => e + 1), t + 250].filter((x) => x > t);
    const at = Math.min(...next, t + 250);
    timer = setTimer(() => { timer = null; tick(); }, Math.max(1, at - t));
  }

  return {
    gate,
    tick,
    setDeliver(fn) { deliver = fn; },
    /** Weighted, seeded, no-repeat pick from a configured pool. Returns an effect name; run it through gate() as usual. */
    pick(poolId) {
      const p = pools.get(poolId);
      if (!p) throw new RangeError(`unknown pool ${String(poolId).slice(0, 32)}`);
      return p.pick();
    },
    /** TODO(host): fx test writes the measured peak flashes/s of an effect here (from rendered-frame luminance). */
    reportMeasuredFlashes({ effect, canvas, flashesPerSecond }) {
      if (!cfg.effects[effect] || !CANVASES.includes(canvas) || !num(flashesPerSecond, 0, 1000)) throw new RangeError('bad measurement');
      measured.set(`${effect}:${canvas}`, flashesPerSecond);
    },
    stats: () => JSON.parse(JSON.stringify({ ...stats, active: active.length, queued_now: queue.length, budgetUsed: budgetStamps.length })),
    recent: () => ring.map((r) => ({ ...r })),
    config: cfg,
    stop() { if (timer) clearTimer(timer); timer = null; },
  };
}
