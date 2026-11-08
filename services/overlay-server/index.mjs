// SPDX-License-Identifier: GPL-3.0-or-later
// Overlay server: read-only static server for the legacy overlay folder plus the event-core bridge feed. Node stdlib only.
//
//   const s = createOverlayServer({ root, bus });       // bus: event-core bus or createRemoteBus()
//   await s.start();                                     // s.staticPort, s.feedPort
//   s.bridge.publishEffect('gg');                        // fire an overlay effect (day-4 guards hook in via effectGate)
//
// Layer URL for an imported browser layer (host builds it; the layer's own query string is kept as it is):
//   http://127.0.0.1:<staticPort>/overlays/<rel>?<layer query>&<feedQuery(feedPort, scope)>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedServer, createOverlayBridge } from './bridge.mjs';
import { createCamPopRule } from './campop-rule.mjs';
import { createEffectGuards, loadFlashMeasurements, loadGuardConfig } from './guards.mjs';
import { createStaticServer } from './static.mjs';

export { createFeedServer, createOverlayBridge, chatEnvelope, alertBusEvent, maskChatText, MODES } from './bridge.mjs';
export { createStaticServer, OVERLAY_CSP } from './static.mjs';
export { createRemoteBus } from './event-source.mjs';
export { createEffectGuards, createPool, loadFlashMeasurements, loadGuardConfig, mulberry32, saveFlashMeasurement, validateFlashMeasurements, validateGuardConfig } from './guards.mjs';
export { createCamPopRule } from './campop-rule.mjs';

export const DEFAULT_GUARDS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'effects', 'guards.json');
export const DEFAULT_FLASH_MEASUREMENTS_FILE = path.join(path.dirname(DEFAULT_GUARDS_FILE), 'flash-measurements.json');

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'relay');
export const OWN_OVERLAYS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages');
/** Feature flags an overlay page may read live at /_ujwalam/flags.json (D196). Nothing else about flags reaches a page. */
export const OVERLAY_FLAGS = Object.freeze(['test-broadcast']);
/** Audience counters (D250): the latest `system.counter` value per platform and counter, served read-only at
 *  /_ujwalam/counters.json while the flag is on ({ on: false } otherwise, so the counter pages show nothing). */
export const COUNTERS_FLAG = 'live-counters';
export function createCounterCache() {
  const latest = {};
  return {
    onEvent(ev) {
      if (!ev || ev.kind !== 'system.counter' || !['twitch', 'youtube', 'kick'].includes(ev.platform)) return;
      if (!['followers', 'subscribers'].includes(ev.counter) || !Number.isInteger(ev.value) || ev.value < 0) return;
      (latest[ev.platform] ??= {})[ev.counter] = ev.value;
    },
    json(flags) {
      let on = false;
      try { on = flags?.isOn(COUNTERS_FLAG) === true; } catch { on = false; }
      return on ? { on: true, counters: structuredClone(latest) } : { on: false };
    },
  };
}
/** Gates chat-fired effects (pages at /effects/<name>) and the cam-pop rule; read by the server, never sent to a page. */
export const CHAT_EFFECTS_FLAG = 'chat-effects';

/** { <id>: bool } for OVERLAY_FLAGS. flags: { isOn(id) } (services/flags) or nothing (then every flag is off). */
export function overlayFlagState(flags) {
  return Object.fromEntries(OVERLAY_FLAGS.map((id) => { try { return [id, flags?.isOn(id) === true]; } catch { return [id, false]; } }));
}

/** Query parameters that point a legacy overlay at the bridge feed: the ones the pages already have
 *  (sbHost, sbPort, sbPath), plus streamerbot=1 for the pages that load kit/sources/streamerbot.js. */
export function feedQuery(feedPort, scope = 'effects', effect = '') {
  if (!Number.isInteger(feedPort) || feedPort < 1 || feedPort > 65535) throw new RangeError('bad feed port');
  if (effect && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(effect)) throw new RangeError('bad effect name');
  const p = scope === 'display' ? '/display' : effect ? `/effects/${effect}` : '/';
  return `streamerbot=1&sbHost=127.0.0.1&sbPort=${feedPort}&sbPath=${p}`;
}

/** opts: { root, bus?, staticPort?, feedPort?, guards?, flashMeasurements?, audit?, now?, effectGate?, extraOrigins?, csp?, log?, flags? }.
 *  flags: { isOn(id) } read on every /_ujwalam/flags.json request, so a flip on the control page reaches the pages live.
 *  guards: true (data/effects/guards.json), a file path, or a parsed config object; it builds the effect guards and
 *  the cam-pop rule and plugs them in. Without guards the gate allows everything (tests only). */
export function createOverlayServer(opts) {
  let guards = null;
  let rule = null;
  if (opts.guards) {
    const config = typeof opts.guards === 'object' ? opts.guards : loadGuardConfig(opts.guards === true ? DEFAULT_GUARDS_FILE : opts.guards);
    // Measured flash rates (fx test): flashMeasurements is a file path, a parsed object, or false for none; by default
    // the repo file is used with guards: true (the live path), and none with a config object or file (tests).
    const fm = opts.flashMeasurements ?? (opts.guards === true ? DEFAULT_FLASH_MEASUREMENTS_FILE : false);
    const measurements = fm === false ? null : typeof fm === 'object' ? fm : loadFlashMeasurements(fm);
    guards = createEffectGuards({ config, now: opts.now, audit: opts.audit, measurements });
  }
  // Flag `chat-effects` (D149, D204): chat-fired effects and the cam-pop rule run only while it is on; it is read on
  // every decision, so a flip on the control page acts at once, also while live. No flags object: off.
  const chatFx = () => { try { return opts.flags?.isOn(CHAT_EFFECTS_FLAG) === true; } catch { return false; } };
  const baseGate = guards ? guards.gate : opts.effectGate;
  const effectGate = (e) => (e?.source === 'chat' && !chatFx() ? { allow: false, reason: 'flag-off' } : (baseGate ? baseGate(e) : { allow: true }));
  const bridge = createOverlayBridge({ effectGate, log: opts.log });
  if (guards) {
    guards.setDeliver((e) => bridge.deliverEffect(e.name));
    if (guards.config.rules?.campop) rule = createCamPopRule({ config: guards.config.rules.campop, fire: (e) => (chatFx() ? bridge.publishEffect(e.name, { source: e.source }) : { ok: false, reason: 'flag-off' }), now: opts.now });
  }
  const counters = createCounterCache();
  const stat = createStaticServer({ root: opts.root, port: opts.staticPort ?? 0, csp: opts.csp, extraMounts: { '/_ujwalam': RELAY_DIR }, ownOverlays: OWN_OVERLAYS_DIR, flagsJson: () => overlayFlagState(opts.flags), countersJson: () => counters.json(opts.flags) });
  const feed = createFeedServer({ bridge, port: opts.feedPort ?? 0, allowedOrigins: opts.extraOrigins ?? [] });
  let detach = null;
  let detachRule = null;
  let detachCounters = null;
  return {
    bridge,
    counters,
    guards,
    rule,
    get staticPort() { return stat.port; },
    get feedPort() { return feed.port; },
    async start() {
      await stat.listen();
      for (const host of ['127.0.0.1', 'localhost']) feed.allowOrigin(`http://${host}:${stat.port}`);
      await feed.listen();
      if (opts.bus) detach = bridge.attach(opts.bus);
      if (opts.bus) detachCounters = opts.bus.subscribe({ name: 'counter-cache', kinds: ['system.counter'], handler: (e) => counters.onEvent(e) });
      if (opts.bus && rule) { detachRule = opts.bus.subscribe({ name: 'campop-rule', kinds: ['chat.'], handler: () => rule.onChat() }); rule.start(); }
      opts.bus?.start?.();
      return { staticPort: stat.port, feedPort: feed.port };
    },
    async stop() { opts.bus?.stop?.(); detach?.(); detachRule?.(); detachCounters?.(); rule?.stop(); guards?.stop(); await feed.close(); await stat.close(); },
  };
}
