// SPDX-License-Identifier: GPL-3.0-or-later
// IG1 (D351, flag `instagram-live`, off by default): Instagram Live as an output. Node stdlib only.
//
// Plan: addInstagram() adds the `instagram` sink (data/outputs/addons/instagram-live.json) to an O0 output config, fed
// from the V canvas. Compositor -> encoder pool -> delivery pool: the sink binds to a rung, it never owns an encoder.
// An existing V rung is reused only when the validator (services/outputs/validate.mjs against data/platforms/
// instagram.json) reports no error and no warning for it other than UNVERIFIED_LIMIT / NOT_RECOMMENDED; otherwise the
// add-on's rung is added (GPU-scaled from the V canvas by the host, deduplicated by the validator). Audio stays the
// plan's one shared track (encoded once). NVENC sessions are probed by the host at outputs.configure, never assumed.
// writeInstagramPlan() writes the live plan in effect plus the instagram sink and target to <dataDir>/outputs/, so the
// launcher, the readiness check and Settings > Connections read one plan file, as with the Settings > Stream plan.
//
// Key per broadcast: Instagram's Live Producer gives a new stream URL and key for every broadcast. They are pasted in
// Settings > Connections or on the control page and stored only in Windows Credential Manager (the target names in the
// add-on; services/platform-connect is the writer). This module keeps non-secret bookkeeping only, in
// <dataDir>/outputs/instagram-key.json: { savedAt, startedAt, usedAt } (ISO times; never a key, a URL, a hash or any
// other part or derivative of them).
//   savedAt:   a new URL and key were pasted through Ujwalam (pasting the key already stored keeps the times).
//   startedAt: a start was sent for the instagram sink with that key (noteKeyStarted, before the host call), or the
//              host reported the sink started since its configure (attempts > 0, or running). Any start attempt counts:
//              it may have reached Instagram, so the key is consumed.
//   usedAt:    after startedAt the sink was seen not running (stopped, failed, gone, or the next studio start after a
//              crash). A key with usedAt >= savedAt is "used": readiness fails until a new one is pasted.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, loadPlatforms } from './validate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ADDON_FILE = path.join(REPO, 'data', 'outputs', 'addons', 'instagram-live.json');
export const PLATFORMS_DIR = path.join(REPO, 'data', 'platforms');
export const INSTAGRAM_FLAG = 'instagram-live';
const ACTIVE = new Set(['starting', 'live', 'retrying', 'reconnecting', 'stopping']);
// Warnings that do not stop a rung from being reused: an unconfirmed limit, or a recommendation (e.g. 44.1 kHz audio:
// the one shared audio track stays as it is).
const REUSE_OK = new Set(['UNVERIFIED_LIMIT', 'NOT_RECOMMENDED']);

let addonCache = null;
/** The add-on data (flag, sink, rung, target, file names). */
export function loadAddon(file = ADDON_FILE) {
  if (file === ADDON_FILE && addonCache) return addonCache;
  const a = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['flag', 'sink', 'rung', 'target', 'planName', 'keyStateName']) if (a[k] === undefined) throw new Error(`instagram add-on: "${k}" missing in ${file}`);
  if (file === ADDON_FILE) addonCache = a;
  return a;
}

/** Problems of the instagram sink bound to one rung (validator errors and warnings that block reuse). */
export function rungProblems(config, rungId, { platforms, addon = loadAddon() } = {}) {
  const enc = (config.encoders ?? []).find((e) => e.id === rungId);
  if (!enc) return [`rung "${rungId}" not found`];
  const probe = { canvases: config.canvases, encoders: [enc], ...(config.audio ? { audio: config.audio } : {}), sinks: [{ ...addon.sink, encoder: rungId }] };
  const res = validate(probe, platforms);
  return [...res.errors, ...res.warnings.filter((w) => !REUSE_OK.has(w.code))].map((x) => x.message);
}

/**
 * The config with the instagram sink added: { config, rung, reused, why }. rung = the encoder id the sink binds to;
 * reused = an existing V rung fits; why = the first problem of each V rung that did not fit (for the report).
 * The add-on rung takes the encoder and encoder options of the plan's own V rung, and an fps that divides the V canvas fps.
 */
export function addInstagram(config, { platforms = loadPlatforms(PLATFORMS_DIR), addon = loadAddon() } = {}) {
  const sinkId = addon.sink.id;
  if ((config.sinks ?? []).some((s) => s.id === sinkId)) throw new Error(`the plan already has a sink "${sinkId}"`);
  const canvasId = addon.rung.canvas;
  const canvas = (config.canvases ?? []).find((c) => c.id === canvasId);
  if (!canvas) throw new Error(`the plan has no ${canvasId} canvas for Instagram (9:16)`);
  const vRungs = (config.encoders ?? []).filter((e) => e.canvas === canvasId);
  const why = {};
  for (const e of vRungs) {
    const p = rungProblems(config, e.id, { platforms, addon });
    if (!p.length) {
      return { config: { ...config, sinks: [...config.sinks, { ...addon.sink, encoder: e.id }] }, rung: e.id, reused: true, why };
    }
    why[e.id] = p[0];
  }
  const base = vRungs[0];
  const rung = { ...addon.rung };
  if (base?.encoder) rung.encoder = base.encoder;
  if (base?.encoderOptions) rung.encoderOptions = base.encoderOptions;
  if (!(canvas.fps % rung.fps === 0)) rung.fps = canvas.fps / Math.ceil(canvas.fps / rung.fps);
  let id = rung.id;
  for (let n = 2; (config.encoders ?? []).some((e) => e.id === id); n++) id = `${rung.id}-${n}`;
  rung.id = id;
  const out = { ...config, encoders: [...(config.encoders ?? []), rung], sinks: [...config.sinks, { ...addon.sink, encoder: id }] };
  return { config: out, rung: id, reused: false, why };
}

/**
 * Writes <dataDir>/outputs/<planName>: the plan file `basePlan` with the instagram sink, rung and target added, its
 * config inlined. Returns { file, rung, reused, why }. The plan holds target names only, never a key or a URL.
 */
export function writeInstagramPlan(dataDir, basePlan, { platformsDir = PLATFORMS_DIR, addon = loadAddon() } = {}) {
  const w = JSON.parse(readFileSync(basePlan, 'utf8'));
  const cfg = typeof w.config === 'string' ? JSON.parse(readFileSync(path.resolve(REPO, w.config), 'utf8')) : w.config;
  if ((w.extraSinks ?? []).some((s) => s.id === addon.sink.id) || Object.hasOwn(w.targets ?? {}, addon.sink.id)) {
    throw new Error(`the live plan already names an output "${addon.sink.id}"`);
  }
  const r = addInstagram(cfg, { platforms: loadPlatforms(platformsDir), addon });
  const plan = {
    $comment: `Generated at the --live start (IG1, D351, flag ${addon.flag}): ${path.basename(basePlan)} plus the ${addon.sink.id} sink (data/outputs/addons/instagram-live.json). Rebuilt on every start; edit the source plans, not this file.`,
    config: r.config,
    ...(w.extraSinks ? { extraSinks: w.extraSinks } : {}),
    targets: { ...(w.targets ?? {}), [addon.sink.id]: { ...addon.target } },
    ...(w.policy ? { policy: w.policy } : {}),
  };
  const dir = path.join(dataDir, 'outputs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, addon.planName);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(tmp, file);
  return { file, rung: r.rung, reused: r.reused, why: r.why };
}

/** The settings-page row for the instagram output (platform-connect outputsFromPlan form). */
export function connectRow({ platforms = loadPlatforms(PLATFORMS_DIR), addon = loadAddon() } = {}) {
  const p = platforms[addon.sink.platform];
  const schemes = ['rtmp', 'rtmps'].filter((x) => (p?.protocols?.value ?? []).includes(x));
  return {
    id: addon.sink.id, platform: addon.sink.platform, canvas: addon.rung.canvas, transport: addon.target.transport,
    keyRef: addon.target.keyRef, serverRef: addon.target.serverRef, schemes, perBroadcast: p?.ingest?.value?.perBroadcast === true,
  };
}

// ---- key per broadcast (no secrets) ----

const stateFile = (dataDir, addon) => path.join(dataDir, 'outputs', addon.keyStateName);
const ms = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

/** { savedAt, startedAt, usedAt } (ISO strings or null). */
export function readKeyState(dataDir, { addon = loadAddon() } = {}) {
  try {
    const j = JSON.parse(readFileSync(stateFile(dataDir, addon), 'utf8'));
    const t = (v) => (Number.isFinite(ms(v)) ? v : null);
    // Version 1 files called the start liveAt: kept as startedAt, so an upgrade mid-broadcast still sees the key consumed.
    return { savedAt: t(j.savedAt), startedAt: t(j.startedAt) ?? t(j.liveAt), usedAt: t(j.usedAt) };
  } catch { return { savedAt: null, startedAt: null, usedAt: null }; }
}
function writeKeyState(dataDir, st, addon) {
  const f = stateFile(dataDir, addon);
  mkdirSync(path.dirname(f), { recursive: true });
  const clean = { version: 2, savedAt: st.savedAt ?? null, startedAt: st.startedAt ?? null, usedAt: st.usedAt ?? null };
  writeFileSync(`${f}.tmp`, `${JSON.stringify(clean, null, 2)}\n`);
  renameSync(`${f}.tmp`, f);
  return clean;
}
/**
 * The URL and key were pasted through Ujwalam. sameKey (the caller compared the pasted key with the stored one in
 * memory): the state is kept, so a used key pasted again stays used; only a key never pasted through Ujwalam gets its
 * savedAt. Otherwise a fresh key.
 */
export function noteKeySaved(dataDir, { now = Date.now, addon = loadAddon(), sameKey = false } = {}) {
  const st = readKeyState(dataDir, { addon });
  if (sameKey && st.savedAt) return writeKeyState(dataDir, st, addon);
  return writeKeyState(dataDir, { savedAt: new Date(now()).toISOString(), startedAt: null, usedAt: null }, addon);
}
/** A start that includes the instagram sink is about to be sent: the key is consumed (called before the host call). */
export function noteKeyStarted(dataDir, { now = Date.now, addon = loadAddon() } = {}) {
  const st = readKeyState(dataDir, { addon });
  if (!Number.isFinite(ms(st.savedAt)) || ms(st.startedAt) >= ms(st.savedAt)) return null;
  return writeKeyState(dataDir, { ...st, startedAt: new Date(now()).toISOString() }, addon);
}
/**
 * Freshness: { fresh, state: 'fresh' | 'started' | 'used' | 'not-pasted', savedAt, startedAt, usedAt }. 'started': the
 * broadcast with this key has not been seen ending yet. A key never pasted through
 * Ujwalam (no savedAt, e.g. set with the credential command) is not fresh: there is no way to know it is this broadcast's.
 */
export function keyFreshness(dataDir, { addon = loadAddon() } = {}) {
  const st = readKeyState(dataDir, { addon });
  const saved = ms(st.savedAt);
  if (!Number.isFinite(saved)) return { fresh: false, state: 'not-pasted', ...st };
  if (ms(st.usedAt) >= saved) return { fresh: false, state: 'used', ...st };
  if (ms(st.startedAt) >= saved) return { fresh: true, state: 'started', ...st };
  return { fresh: true, state: 'fresh', ...st };
}

/**
 * Reconciles the key state with outputs.status (the host's lifecycle record of the sink; polled, and read again right
 * before each start and at studio start). observe(status, { startInFlight }) returns 'started' | 'used' | null (the
 * last thing it wrote). Only sink ids, states and start counts are read.
 *   - The sink running, or its start count (attempts, counted by the host since configure and kept after a stop) grown
 *     since the last observation, marks the key started: a broadcast shorter than a poll, or a start sent by another
 *     path (crash recovery), is still seen. The first observation only takes the count (the host reads the key at each
 *     start, so starts before it may belong to an earlier key), and a count that grew while a new key was pasted is not
 *     counted for that key (the start may have been the earlier one's); starts sent through the studio server are marked
 *     before they are sent (noteKeyStarted), so a crash in between still leaves the key started.
 *   - Started and the sink not running (stopped, failed, gone; a new host after a crash has it stopped with no
 *     attempts) marks it used, unless a start is on its way (startInFlight), when the sink may not have begun yet.
 */
export function createUseWatcher({ dataDir, now = Date.now, addon = loadAddon() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('instagram watcher: dataDir required');
  let lastAttempts = null; // the sink's start count at the last observation (null: none yet)
  let lastAt = -Infinity; // the time of the last observation
  let runningSince = null; // when this watcher first saw the current run of the sink (null: not running)
  return {
    observe(status, { startInFlight = false } = {}) {
      const sinks = Array.isArray(status?.sinks) ? status.sinks : null;
      if (!sinks) return null; // unreadable: decide nothing
      const s = sinks.find((x) => x && x.id === addon.sink.id && (x.kind === undefined || x.kind === 'stream'));
      const attempts = s && Number.isInteger(s.attempts) && s.attempts >= 0 ? s.attempts : 0;
      const grew = lastAttempts !== null && attempts > lastAttempts;
      const since = lastAt;
      const running = !!s && (s.state === 'live' || ACTIVE.has(s.state) || s.active === true);
      lastAttempts = attempts; // a lower count: a new configure or a new host, counted from there
      lastAt = now();
      // A run that began again (count grew) or was first seen now starts at this observation.
      runningSince = running ? (runningSince === null || grew ? lastAt : runningSince) : null;
      let st = readKeyState(dataDir, { addon });
      const saved = ms(st.savedAt);
      if (!Number.isFinite(saved)) return null; // never pasted through Ujwalam: already not fresh
      // A run already seen before the key was pasted belongs to the earlier key (the next broadcast's key pasted while
      // the current one is live): it neither starts nor uses the new key.
      const ownRun = running && !(runningSince < saved);
      const reached = ownRun || (grew && saved < since);
      const iso = new Date(now()).toISOString();
      let wrote = null;
      if (reached && !(ms(st.startedAt) >= saved)) { st = writeKeyState(dataDir, { ...st, startedAt: iso }, addon); wrote = 'started'; }
      const started = ms(st.startedAt);
      if (!running && !startInFlight && started >= saved && !(ms(st.usedAt) >= started)) {
        writeKeyState(dataDir, { ...st, usedAt: iso }, addon);
        wrote = 'used';
      }
      return wrote;
    },
  };
}

/** Plain text for a key that is not fresh (readiness and Settings). */
export function freshnessText(f, { connectOn = true } = {}) {
  const how = 'Open Instagram Live Producer (instagram.com: Create, Live), copy the new stream URL and stream key, and paste both in Settings > Connections > Instagram or in the Instagram Live box on the control page';
  const flag = connectOn ? '' : ' (switch on the feature flag platform-connect first)';
  if (f.state === 'used') return { message: 'Instagram: the stream key was used for a broadcast that ended. Instagram gives a new URL and key for every broadcast.', fix: `${how}${flag}.` };
  return { message: 'Instagram: no stream URL and key pasted for this broadcast. Instagram gives a new URL and key for every broadcast.', fix: `${how}${flag}.` };
}
