// SPDX-License-Identifier: GPL-3.0-or-later
// Audience counters (D250, flag 'live-counters', default off). Node stdlib only.
//
//   const c = createAudienceCounters({ core, readGlobal, flags, config });   c.start();   c.state();   c.stop();
//
// Streamer.bot has no request that returns follower or subscriber counts (docs.streamer.bot/api/websocket/requests,
// read 2026-11-08), but it can read global variables. The user keeps the counts in persisted globals with their own
// Streamer.bot action; this module only READS them (GetGlobal, read-only, like the rest of Ujwalam's Streamer.bot
// connection) every pollMs while the flag is on, and publishes `system.counter` { platform, counter, value } on the
// event bus whenever a value changes. Between reads a live follow alert (twitch, kick) raises the known follower count
// by 1, so the overlay moves at once; the next read replaces it with the global's value. A count that is not read yet
// is never guessed.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COUNTERS_FLAG = 'live-counters';
export const DEFAULT_COUNTERS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'counters.json');
const PLATFORMS = ['twitch', 'youtube', 'kick'];
const COUNTERS = ['followers', 'subscribers'];
const VAR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_VALUE = 1_000_000_000;

/** Validates a counters config ({ pollMs, variables: { platform: { counter: name } } }); throws on a bad one. */
export function checkCounterConfig(c) {
  if (!c || typeof c !== 'object') throw new Error('counters: config must be an object');
  if (!Number.isInteger(c.pollMs) || c.pollMs < 5000 || c.pollMs > 3_600_000) throw new Error('counters: pollMs must be 5000..3600000');
  const out = [];
  for (const [platform, m] of Object.entries(c.variables ?? {})) {
    if (!PLATFORMS.includes(platform) || !m || typeof m !== 'object') throw new Error(`counters: bad platform ${platform}`);
    for (const [counter, name] of Object.entries(m)) {
      if (!COUNTERS.includes(counter)) throw new Error(`counters: bad counter ${platform}.${counter}`);
      if (typeof name !== 'string' || !VAR_RE.test(name)) throw new Error(`counters: bad variable name for ${platform}.${counter}`);
      out.push({ platform, counter, name });
    }
  }
  return { pollMs: c.pollMs, entries: out };
}

export function loadCounterConfig(file = DEFAULT_COUNTERS_FILE) {
  return checkCounterConfig(JSON.parse(readFileSync(file, 'utf8')));
}

/** A global's value as a count: a whole number 0..MAX_VALUE, or a string of digits (Streamer.bot globals are often
 *  strings). Anything else is null (ignored, the shown count stays). */
export function toCount(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,10}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_VALUE ? n : null;
}

/** opts: { core, readGlobal(name) -> Promise<value|null>, flags: { isOn(id) }, config?, setTimer?, clearTimer?, log? } */
export function createAudienceCounters(opts) {
  const { core, readGlobal } = opts;
  const cfg = opts.config ? checkCounterConfig(opts.config) : loadCounterConfig();
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const log = opts.log ?? (() => {});
  const on = () => { try { return opts.flags?.isOn(COUNTERS_FLAG) === true; } catch { return false; } };
  const values = new Map(); // `${platform}.${counter}` -> { value, from: 'global'|'alert' }
  let timer = null;
  let detach = null;
  let running = false;
  let busy = false;

  function publish(platform, counter, value, from) {
    const k = `${platform}.${counter}`;
    if (values.get(k)?.value === value) { values.set(k, { value, from }); return; }
    values.set(k, { value, from });
    core.ingest({ kind: 'system.counter', platform, source: 'streamerbot', counter, value });
  }

  async function poll() {
    if (busy || !on()) return;
    busy = true;
    try {
      for (const e of cfg.entries) {
        let v = null;
        try { v = toCount(await readGlobal(e.name)); } catch { v = null; }
        if (!running) return;
        if (v !== null) publish(e.platform, e.counter, v, 'global');
      }
    } finally { busy = false; }
  }

  function loop() {
    timer = setTimer(async () => {
      try { await poll(); } catch { log('[counters] warn: poll failed'); }
      if (running) loop();
    }, cfg.pollMs);
    timer?.unref?.();
  }

  function onFollow(ev) {
    if (!on()) return;
    const k = `${ev.platform}.followers`;
    const cur = values.get(k);
    if (!cur || !cfg.entries.some((e) => e.platform === ev.platform && e.counter === 'followers')) return; // never guessed
    if (cur.value < MAX_VALUE) publish(ev.platform, 'followers', cur.value + 1, 'alert');
  }

  return {
    start() {
      if (running) return;
      running = true;
      detach = core.bus.subscribe({ name: 'audience-counters', kinds: ['alert.follow'], handler: onFollow });
      void poll().catch(() => log('[counters] warn: poll failed'));
      loop();
    },
    stop() { running = false; if (timer) clearTimer(timer); timer = null; detach?.(); detach = null; },
    poll,
    state: () => Object.fromEntries([...values].map(([k, v]) => [k, { ...v }])),
  };
}
