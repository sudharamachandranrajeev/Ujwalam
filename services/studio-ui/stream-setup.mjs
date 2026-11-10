// SPDX-License-Identifier: GPL-3.0-or-later
// Stream setup (D327, OS1/OS2): the user's stream settings and output list, kept in <dataDir>/stream-setup.json, and
// the output-graph plan they make (toPlan). The plan goes through the same validator and planner as every other plan
// (services/outputs/validate.mjs, app/host/lib/outputs-plan.mjs), so sinks never own encoders, equal rungs are
// deduplicated and audio is encoded once. Platform limits come from data/platforms only; a value over a limit is
// refused here with the platform's own message (setupProblems), never clamped.
//
// File shape (version 1):
//   { version: 1, canvasMode: "main" | "multi",
//     video: { fps, output: <resolution id>, hardware: bool, bitrateKbps, portraitBitrateKbps, quality: <preset id>, audioKbps },
//     outputs: [ { id, name, platform, canvas: "H" | "V", enabled: bool, video?: { output, bitrateKbps } } ] }
// output.video (H only) gives that output its own rung (e.g. Twitch at 6000 kbps); without it the output uses the main
// rung of its canvas. canvasMode "main": portrait outputs stay in the list but are left out of the plan.
// A missing file is seeded from the live plan (stream-options.json seedPlan), values copied, never guessed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlatforms, validate } from '../outputs/validate.mjs';
import { liveSchemesOf, plan, PLATFORMS_DIR } from '../../app/host/lib/outputs-plan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SETUP_FILE = 'stream-setup.json';
export const OPTIONS_FILE = path.join(REPO, 'data', 'stream', 'stream-options.json');
export const OUTPUT_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_OUTPUTS = 12;
export const CANVAS_MODES = Object.freeze(['main', 'multi']);
// Validator codes that mean "a value is over a platform limit". Severity "warning" in data/platforms is still a limit
// for the settings page: the user asked for values to be refused, with the limit shown (D327).
export const LIMIT_CODES = Object.freeze(['BITRATE_RANGE', 'RESOLUTION_MAX', 'FPS_MAX', 'GOP_MAX', 'CODEC_REFUSED', 'RC_REFUSED', 'PROTO_UNSUPPORTED', 'AUDIO_BITRATE_RANGE', 'AUDIO_CODEC_REFUSED']);

export function readOptions(file = OPTIONS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (o, allowed, where, out) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push({ field: where, message: `${where}: unknown setting "${k}"` }); };

function resolutionOf(options, id) { return options.resolutions.find((r) => r.id === id); }

/** Seeds a setup from a live plan file (copies the rung values of its config; nothing guessed). */
export function seedSetup({ options = readOptions(), planFile = path.join(REPO, options.seedPlan) } = {}) {
  const w = JSON.parse(readFileSync(planFile, 'utf8'));
  const cfg = typeof w.config === 'string' ? JSON.parse(readFileSync(path.resolve(REPO, w.config), 'utf8')) : w.config;
  const enc = new Map(cfg.encoders.map((e) => [e.id, e]));
  const realSinks = cfg.sinks.filter((s) => s.platform !== 'local');
  const hCanvas = cfg.canvases.find((c) => c.id === 'H');
  // The main H rung is the one the first H sink uses (the preset's direct YouTube rung).
  const firstH = realSinks.find((s) => enc.get(s.encoder)?.canvas === 'H');
  const firstV = realSinks.find((s) => enc.get(s.encoder)?.canvas === 'V');
  const mainH = enc.get(firstH.encoder);
  const mainV = firstV ? enc.get(firstV.encoder) : null;
  const resId = (e) => options.resolutions.find((r) => r.w === Math.max(e.w, e.h) && r.h === Math.min(e.w, e.h))?.id;
  const quality = options.qualityPresets.find((q) => q.id === options.seedQuality).id;
  return {
    version: 1,
    canvasMode: mainV ? 'multi' : 'main',
    video: {
      fps: mainH.fps ?? hCanvas.fps,
      output: resId(mainH),
      hardware: (mainH.encoder ?? 'nvenc') === 'nvenc',
      bitrateKbps: mainH.bitrate,
      portraitBitrateKbps: mainV ? mainV.bitrate : mainH.bitrate,
      quality,
      audioKbps: cfg.audio?.tracks?.[0]?.bitrate ?? 160
    },
    outputs: realSinks.map((s) => {
      const e = enc.get(s.encoder);
      const o = { id: s.id, name: platformLabel(options, s.platform) + (e.canvas === 'V' ? ' (portrait)' : ''), platform: s.platform, canvas: e.canvas, enabled: true };
      if (e.canvas === 'H' && e !== mainH) o.video = { output: resId(e), bitrateKbps: e.bitrate };
      return o;
    })
  };
}

export const platformLabel = (options, id) => options.platforms.find((p) => p.id === id)?.label ?? id;

/** Shape problems (types, ranges of the UI choices, ids). Platform limits are checked by setupProblems. */
export function shapeProblems(s, options = readOptions()) {
  const out = [];
  if (!isObj(s)) return [{ field: '', message: 'the stream setup must be an object' }];
  keysOnly(s, ['version', 'canvasMode', 'video', 'outputs'], 'setup', out);
  if (s.version !== 1) out.push({ field: 'version', message: 'version must be 1' });
  if (!CANVAS_MODES.includes(s.canvasMode)) out.push({ field: 'canvasMode', message: `canvas mode must be ${CANVAS_MODES.join(' or ')}` });
  const b = options.videoBitrateKbps;
  const kbps = (v, field, label) => {
    if (!Number.isInteger(v) || v < b.min || v > b.max) out.push({ field, message: `${label} must be a whole number of kbps from ${b.min} to ${b.max}` });
  };
  const v = s.video;
  if (!isObj(v)) out.push({ field: 'video', message: 'video settings are missing' });
  else {
    keysOnly(v, ['fps', 'output', 'hardware', 'bitrateKbps', 'portraitBitrateKbps', 'quality', 'audioKbps'], 'video', out);
    if (!options.frameRates.includes(v.fps)) out.push({ field: 'video.fps', message: `frame rate must be one of ${options.frameRates.join(', ')}` });
    if (!resolutionOf(options, v.output)) out.push({ field: 'video.output', message: `output resolution must be one of ${options.resolutions.map((r) => r.id).join(', ')}` });
    if (typeof v.hardware !== 'boolean') out.push({ field: 'video.hardware', message: 'hardware encoder must be on or off' });
    kbps(v.bitrateKbps, 'video.bitrateKbps', 'main video bitrate');
    kbps(v.portraitBitrateKbps, 'video.portraitBitrateKbps', 'portrait video bitrate');
    if (!options.qualityPresets.some((q) => q.id === v.quality)) out.push({ field: 'video.quality', message: `quality preset must be one of ${options.qualityPresets.map((q) => q.id).join(', ')}` });
    if (!options.audioBitratesKbps.includes(v.audioKbps)) out.push({ field: 'video.audioKbps', message: `audio bitrate must be one of ${options.audioBitratesKbps.join(', ')} kbps` });
  }
  if (!Array.isArray(s.outputs)) out.push({ field: 'outputs', message: 'outputs must be a list' });
  else {
    if (s.outputs.length > MAX_OUTPUTS) out.push({ field: 'outputs', message: `at most ${MAX_OUTPUTS} outputs` });
    const seen = new Set();
    s.outputs.forEach((o, i) => {
      const w = `outputs[${i}]`;
      if (!isObj(o)) { out.push({ field: w, message: `${w} must be an object` }); return; }
      keysOnly(o, ['id', 'name', 'platform', 'canvas', 'enabled', 'video'], w, out);
      // "record" and "record-v" are the plan's local recording sinks; ids double as Credential Manager names (Ujwalam/stream/<id>).
      if (typeof o.id !== 'string' || !OUTPUT_ID.test(o.id) || o.id.length > 25 || RECORD_IDS.includes(o.id)) out.push({ field: `${w}.id`, message: `${w}: id must be lowercase letters, digits and dashes (at most 25), not "record" or "record-v"` });
      else if (seen.has(o.id)) out.push({ field: `${w}.id`, message: `${w}: id "${o.id}" is used twice` });
      else seen.add(o.id);
      if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 60) out.push({ field: `${w}.name`, message: `${w}: name must be 1 to 60 characters` });
      const p = options.platforms.find((x) => x.id === o.platform);
      if (!p) out.push({ field: `${w}.platform`, message: `${w}: platform must be one of ${options.platforms.map((x) => x.id).join(', ')}` });
      else if (!p.canvases.includes(o.canvas)) out.push({ field: `${w}.canvas`, message: `${w}: ${p.label} takes the ${p.canvases.join(' or ')} canvas` });
      if (typeof o.enabled !== 'boolean') out.push({ field: `${w}.enabled`, message: `${w}: enabled must be true or false` });
      if (o.video !== undefined) {
        if (!isObj(o.video)) out.push({ field: `${w}.video`, message: `${w}: video must be an object` });
        else {
          keysOnly(o.video, ['output', 'bitrateKbps'], `${w}.video`, out);
          if (o.canvas !== 'H') out.push({ field: `${w}.video`, message: `${w}: only main-canvas outputs can have their own resolution and bitrate` });
          if (!resolutionOf(options, o.video.output)) out.push({ field: `${w}.video.output`, message: `${w}: output resolution must be one of ${options.resolutions.map((r) => r.id).join(', ')}` });
          kbps(o.video.bitrateKbps, `${w}.video.bitrateKbps`, `${w} video bitrate`);
        }
      }
    });
  }
  return out;
}

/** The plan's local recording sink ids (H on the main rung; V on the portrait rung, LC1). Never an output id. */
export const RECORD_IDS = Object.freeze(['record', 'record-v']);
/** The V recording's file name from the H one: alpha.mkv -> alpha-v.mkv. */
export const vRecordName = (name) => name.replace(/(.[A-Za-z0-9]+)?$/, (ext) => `-v${ext}`);

const keyRefOf = (id) => `Ujwalam/stream/${id}`;

/** A real target for an output, from the platform's ingest data (data/platforms/<id>.json ingest + protocols). */
function targetOf(o, platform) {
  const ingest = platform.ingest?.value;
  const protos = platform.protocols?.value ?? ['rtmps'];
  if (ingest?.serverFrom === 'data') {
    const srv = (ingest.servers ?? []).find((x) => x.url?.startsWith('rtmps://')) ?? ingest.servers?.[0];
    return { transport: srv.url.startsWith('rtmps://') ? 'rtmps' : 'rtmp', server: srv.id, keyRef: keyRefOf(o.id) };
  }
  // Per-account server, stored next to the key: rtmp or rtmps follows the stored address when the platform takes both.
  const transport = protos.includes('rtmp') && protos.includes('rtmps') ? 'auto' : (protos.includes('rtmps') ? 'rtmps' : 'rtmp');
  return { transport, serverRef: keyRefOf(`${o.id}-server`), keyRef: keyRefOf(o.id) };
}

/**
 * Credential targets of every output in a setup, for the platform sign-in service (D327): [{ id, platform, canvas,
 * transport, keyRef, serverRef?, schemes? }]. Same key names as toPlan (Ujwalam/stream/<id>), but all outputs, also those
 * the current canvas mode leaves out of the plan or that are switched off, so a new output can be connected before use.
 */
export function connectTargets(setup, { platforms = loadPlatforms(PLATFORMS_DIR) } = {}) {
  const out = [];
  for (const o of Array.isArray(setup?.outputs) ? setup.outputs : []) {
    const pf = platforms[o?.platform];
    if (!pf || typeof o.id !== 'string') continue;
    const t = targetOf(o, pf);
    out.push({ id: o.id, platform: o.platform, canvas: o.canvas, transport: t.transport, keyRef: t.keyRef, ...(t.serverRef ? { serverRef: t.serverRef } : {}),
      ...(t.transport === 'auto' ? { schemes: liveSchemesOf(pf) } : {}) });
  }
  return out;
}

/**
 * The output-graph config and targets for a setup: { config, targets, included }.
 * canvases: { H: {w,h}, V: {w,h} } the project's canvas sizes (default: the main output size and stream-options portrait).
 * opts.platforms: loaded data/platforms (tests); opts.recordName: the local recording file on the main H rung (null = none).
 * With a recording and a portrait (V) stream in the plan, the V canvas is recorded too ("record-v", <name>-v.mkv) on the
 * portrait stream's rung, so the kill montages and match reels can be cut after the stream (LC1, D333 proposed). It is
 * optional: a start without the V stream (output toggles) leaves it out, so it never adds an encoder.
 */
export function toPlan(setup, { options = readOptions(), canvases, platforms = loadPlatforms(PLATFORMS_DIR), recordName = 'stream.mkv' } = {}) {
  const v = setup.video;
  const main = resolutionOf(options, v.output);
  const cv = { H: canvases?.H ?? { w: main.w, h: main.h }, V: canvases?.V ?? options.portrait };
  const q = options.qualityPresets.find((x) => x.id === v.quality);
  const encoder = v.hardware ? 'nvenc' : 'x264';
  const rung = (id, canvas, w, h, bitrate) => ({
    id, canvas, w, h, fps: v.fps, codec: options.codec, bitrate, rc: options.rateControl, gop_sec: options.keyframeSec, encoder,
    encoderOptions: { preset: q[encoder] }
  });
  const included = setup.outputs.filter((o) => setup.canvasMode === 'multi' || o.canvas === 'H');
  const encoders = [rung('h-main', 'H', main.w, main.h, v.bitrateKbps)];
  if (included.some((o) => o.canvas === 'V')) encoders.push(rung('v-main', 'V', options.portrait.w, options.portrait.h, v.portraitBitrateKbps));
  const sinks = [];
  const targets = {};
  included.forEach((o, i) => {
    let enc = o.canvas === 'V' ? 'v-main' : 'h-main';
    if (o.video) {
      const r = resolutionOf(options, o.video.output);
      enc = `h-${o.id}`;
      encoders.push(rung(enc, 'H', r.w, r.h, o.video.bitrateKbps));
    }
    sinks.push({ id: o.id, platform: o.platform, encoder: enc, proto: 'rtmps', priority: i + 1 });
    targets[o.id] = targetOf(o, platforms[o.platform]);
  });
  if (recordName) {
    sinks.push({ id: 'record', platform: 'local', encoder: 'h-main', proto: 'file', priority: included.length + 1 });
    targets.record = { transport: 'file', name: recordName };
    if (encoders.some((e) => e.id === 'v-main')) {
      sinks.push({ id: 'record-v', platform: 'local', encoder: 'v-main', proto: 'file', priority: included.length + 2 });
      targets['record-v'] = { transport: 'file', name: vRecordName(recordName), optional: true };
    }
  }
  const config = {
    name: 'Stream setup (Settings > Stream)',
    canvases: [{ id: 'H', w: cv.H.w, h: cv.H.h, fps: v.fps }, { id: 'V', w: cv.V.w, h: cv.V.h, fps: v.fps }],
    encoders,
    audio: { tracks: [{ id: 'master', name: 'Master Track', codec: 'aac', bitrate: v.audioKbps, sampleRate: 48000 }] },
    sinks
  };
  return { config, targets, included: included.map((o) => o.id) };
}

/** Every problem of a setup: shape first, then the platform limits (validator), with the limit's message. */
export function setupProblems(setup, { options = readOptions(), canvases, platforms = loadPlatforms(PLATFORMS_DIR) } = {}) {
  const shape = shapeProblems(setup, options);
  if (shape.length) return shape;
  const { config } = toPlan(setup, { options, canvases, platforms });
  const res = validate(config, platforms);
  const out = [];
  const seen = new Set();
  for (const e of [...res.errors, ...res.warnings.filter((w) => LIMIT_CODES.includes(w.code))]) {
    if (e.code === 'SHARED_RUNG_CONFLICT' || !e.message || seen.has(e.message)) continue;
    seen.add(e.message);
    out.push({ field: e.sink ? `output:${e.sink}` : 'video', code: e.code, platform: e.platform, message: e.message });
  }
  return out;
}

/** Plans a setup through the host planner (refuses what the planner refuses). allowLive for real targets. */
export function planSetup(setup, opts = {}) {
  const { config, targets } = toPlan(setup, opts);
  return { ...plan(config, targets, { platformsDir: opts.platformsDir, allowLive: opts.allowLive === true, policy: opts.policy, schemes: opts.schemes }), config, targets };
}

export const setupExists = (dataDir) => existsSync(path.join(dataDir, SETUP_FILE));

/** The stored setup, or the seed when there is none ({ exists }). A corrupt file throws (never silently replaced). */
export function readSetup(dataDir, { options = readOptions() } = {}) {
  const f = path.join(dataDir, SETUP_FILE);
  if (!existsSync(f)) return { exists: false, setup: seedSetup({ options }) };
  const { $comment, ...setup } = JSON.parse(readFileSync(f, 'utf8'));
  return { exists: true, setup };
}

/** Writes a setup after every check; returns { ok, problems, setup }. Nothing is written when a check fails. */
export function writeSetup(dataDir, setup, opts = {}) {
  const problems = setupProblems(setup, opts);
  if (problems.length) return { ok: false, problems };
  mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, SETUP_FILE);
  writeFileSync(`${f}.tmp`, JSON.stringify({ $comment: 'Ujwalam stream setup (Settings > Stream, D327). Used at the next live start.', ...setup }, null, 2));
  renameSync(`${f}.tmp`, f);
  return { ok: true, problems: [], setup };
}

/** Writes the plan file launch.mjs passes to the planner (planFile format), next to the setup. Returns its path. */
export function writePlanFile(dataDir, setup, opts = {}) {
  const { config, targets } = toPlan(setup, opts);
  const dir = path.join(dataDir, 'outputs');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'stream-setup-plan.json');
  const body = { $comment: 'Generated from stream-setup.json at live start (D327). Do not edit; change Settings > Stream.', config, targets, policy: opts.policy ?? { retryBaseMs: 2000, retryCapMs: 30000, retryMax: 0, retryResetLiveMs: 30000 } };
  writeFileSync(`${f}.tmp`, JSON.stringify(body, null, 2));
  renameSync(`${f}.tmp`, f);
  return f;
}

/** A one-line summary for an output row: "1080p @ 60fps 7,500 kbps · Main canvas". */
export function outputSummary(setup, o, options = readOptions()) {
  const v = setup.video;
  const res = o.canvas === 'V' ? `${options.portrait.w}x${options.portrait.h}` : (o.video?.output ?? v.output);
  const kbps = o.canvas === 'V' ? v.portraitBitrateKbps : (o.video?.bitrateKbps ?? v.bitrateKbps);
  const canvas = o.canvas === 'V' ? 'Portrait canvas' : 'Main canvas';
  return `${res} @ ${v.fps}fps ${kbps.toLocaleString('en-US')} kbps · ${canvas}`;
}

/** A free output id for a platform (youtube-2, twitch-2, ...). */
export function newOutputId(setup, platform) {
  const ids = new Set(setup.outputs.map((o) => o.id));
  if (!ids.has(platform)) return platform;
  for (let n = 2; ; n++) if (!ids.has(`${platform}-${n}`)) return `${platform}-${n}`;
}
