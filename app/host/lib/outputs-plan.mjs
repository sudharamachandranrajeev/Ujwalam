// SPDX-License-Identifier: GPL-2.0-or-later
// O0 output config -> ujwalam-host outputs.configure params.
//
// The O0 config is validated with services/outputs/validate.mjs against data/platforms/*.json first (platform
// limits are never hardcoded here or in the host). Its resolved, deduplicated rungs become host rungs; each sink
// is bound to its rung (sinks never own encoders). Delivery targets come from a separate map, because O0 sinks
// carry no URL or key by design:
//   targets: { "<sinkId>":
//       loopback (the host builds every URL on 127.0.0.1):
//         { "transport": "rtmp", "port": 19352, "app": "live", "stream": "twitch" | "keyRef": "Ujwalam/stream/<x>" }
//       | { "transport": "srt", "port": 19360, "latencyMs": 120 }
//       | { "transport": "file", "name": "rec-h.mkv" [, "unsafeContainer": true] [, "ownRung": true] }
//       real (A0; refused unless opts.allowLive, and by the host unless it runs with --allow-live):
//       | { "transport": "rtmps"|"rtmp", "server": "<ingest id from data/platforms/<platform>.json>", "keyRef": "..." }
//       | { "transport": "rtmps"|"rtmp", "serverRef": "Ujwalam/stream/<x>-server", "keyRef": "..." } }
// keyRef / serverRef name Windows Credential Manager targets (^Ujwalam/stream/[a-z0-9-]{1,32}$). The host reads them
// itself; no key ever appears in a plan, in params, on argv or in a log. Ingest URLs for "server" come only from the
// platform's "ingest" entry (source + checked date); per-account ingests (serverFrom "keychain") need serverRef.
// Recording: .mkv (crash-safe) unless the target says unsafeContainer: true; when the plan streams, a recording binds
// to a rung that already feeds a stream sink (no extra encoder) unless the target says ownRung: true.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validate, loadPlatforms, formatReport } from '../../../services/outputs/validate.mjs';
import { REPO_ROOT } from './config.mjs';

export const PLATFORMS_DIR = path.join(REPO_ROOT, 'data', 'platforms');
export const REF_RE = /^Ujwalam\/stream\/[a-z0-9-]{1,32}$/;
// Same rule as the host (Outputs::valid_live_url): DNS name with a dot (no IP literal, no localhost), optional port and
// path, no userinfo, query or fragment, so a key can never ride in a URL.
const LIVE_URL_RE = /^(rtmps?):\/\/(([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(:([0-9]{1,5}))?((\/[A-Za-z0-9._~-]+)*\/?)$/i;

export function validLiveUrl(url, transport) {
  if (typeof url !== 'string' || url.length > 256) return false;
  const m = LIVE_URL_RE.exec(url);
  if (!m || m[1].toLowerCase() !== transport) return false;
  return m[6] === undefined || (Number(m[6]) >= 1 && Number(m[6]) <= 65535);
}

const CRASH_SAFE_WHY = 'it is not crash-safe (a file cut off by a crash or power loss may not play; .mkv stays playable up to the last written cluster)';

function realTarget(s, t, platform, platformId) {
  const where = `sink "${s.id}"`;
  const known = ['transport', 'server', 'serverRef', 'keyRef'];
  for (const k of Object.keys(t)) if (!known.includes(k)) throw new Error(`${where}: unknown real-target field "${k}"`);
  if (t.transport !== s.proto) throw new Error(`${where}: target transport ${t.transport} must equal the sink proto ${s.proto}`);
  const protos = platform?.protocols?.value;
  if (Array.isArray(protos) && !protos.includes(t.transport)) throw new Error(`${where}: ${platformId} does not take ${t.transport} (data/platforms/${platformId}.json protocols: ${protos.join(', ')})`);
  if (typeof t.keyRef !== 'string' || !REF_RE.test(t.keyRef)) throw new Error(`${where}: keyRef must match ${REF_RE} (the key itself never goes in a plan)`);
  if ((t.server === undefined) === (t.serverRef === undefined)) throw new Error(`${where}: give exactly one of server (an ingest id from data/platforms/${platformId}.json) or serverRef`);
  const ingest = platform?.ingest;
  if (!ingest) throw new Error(`${where}: data/platforms/${platformId}.json has no ingest entry`);
  if (t.serverRef !== undefined) {
    if (typeof t.serverRef !== 'string' || !REF_RE.test(t.serverRef)) throw new Error(`${where}: serverRef must match ${REF_RE}`);
    if (t.serverRef === t.keyRef) throw new Error(`${where}: serverRef and keyRef must be different credentials`);
    return { transport: t.transport, urlRef: t.serverRef, keyRef: t.keyRef };
  }
  if (ingest.value?.serverFrom !== 'data') throw new Error(`${where}: ${platformId} ingest servers are chosen per user/account (serverFrom ${ingest.value?.serverFrom}); use serverRef`);
  const srv = (ingest.value.servers ?? []).find((x) => x.id === t.server);
  if (!srv) throw new Error(`${where}: unknown ${platformId} ingest server "${t.server}" (known: ${(ingest.value.servers ?? []).map((x) => x.id).join(', ') || 'none'})`);
  if (!validLiveUrl(srv.url, t.transport)) throw new Error(`${where}: ${platformId} ingest "${srv.id}" is not a valid ${t.transport} URL`);
  return { transport: t.transport, url: srv.url, keyRef: t.keyRef };
}

export function plan(config, targets, { platformsDir = PLATFORMS_DIR, policy, allowLive = false } = {}) {
  const platforms = loadPlatforms(platformsDir);
  const res = validate(config, platforms);
  if (res.errors.length) {
    const err = new Error(`output config has errors:\n${formatReport(res)}`);
    err.report = res;
    throw err;
  }
  const tracks = config.audio?.tracks ?? [{ id: 'master', codec: 'aac', bitrate: 160, sampleRate: 48000 }];
  if (tracks.length !== 1) throw new Error('O1 encodes exactly one audio track (multi-track audio is not wired yet)');
  const rungOf = new Map();
  for (const r of res.rungs) for (const s of r.sinks) rungOf.set(s, r);
  const usedRungs = res.rungs.filter((r) => r.sinks.length > 0);
  const live = [];
  const keyRefs = new Map();
  const sinks = config.sinks.map((s) => {
    const t = targets[s.id];
    if (!t) throw new Error(`sink "${s.id}" has no target`);
    if (s.audioTracks && s.audioTracks.length !== 1) throw new Error(`sink "${s.id}": O1 sends exactly one audio track`);
    let target;
    const isReal = (t.transport === 'rtmp' || t.transport === 'rtmps') && (t.server !== undefined || t.serverRef !== undefined);
    if (isReal) {
      target = realTarget(s, t, platforms[s.platform], s.platform);
      live.push(s.id);
    } else if (t.transport === 'rtmps') {
      throw new Error(`sink "${s.id}": an rtmps target is a real target (server or serverRef, and keyRef)`);
    } else if (t.transport === 'file') {
      const ext = /\.([A-Za-z0-9]+)$/.exec(t.name ?? '')?.[1]?.toLowerCase();
      if (ext !== 'mkv' && t.unsafeContainer !== true) {
        throw new Error(`sink "${s.id}": recording container .${ext ?? '?'} is refused because ${CRASH_SAFE_WHY}; use .mkv, or set "unsafeContainer": true on the target to accept that`);
      }
      const { ownRung, ...rest } = t;
      target = rest;
    } else {
      if (t.keyRef !== undefined && !REF_RE.test(t.keyRef)) throw new Error(`sink "${s.id}": keyRef must match ${REF_RE}`);
      target = t;
    }
    if (target.keyRef) {
      if (keyRefs.has(target.keyRef)) throw new Error(`sink "${s.id}": keyRef ${target.keyRef} is already used by sink "${keyRefs.get(target.keyRef)}" (one key per destination)`);
      keyRefs.set(target.keyRef, s.id);
    }
    return { id: s.id, rung: rungOf.get(s.id).id, platform: s.platform, proto: s.proto, priority: s.priority, target };
  });
  for (const id of Object.keys(targets)) {
    if (!config.sinks.some((s) => s.id === id)) throw new Error(`target "${id}" names no sink`);
  }
  if (live.length && !allowLive) {
    throw new Error(`real (non-loopback) targets for ${live.map((x) => `"${x}"`).join(', ')} are refused: plan with allowLive (the host must run with --allow-live, after the user's "yes, on air")`);
  }
  // Recording binds to an existing stream rung (no extra encoder) when the plan streams.
  const streamRungs = new Set(sinks.filter((x) => x.target.transport !== 'file').map((x) => x.rung));
  if (streamRungs.size) {
    for (const x of sinks) {
      if (x.target.transport !== 'file' || streamRungs.has(x.rung) || targets[x.id].ownRung === true) continue;
      throw new Error(`sink "${x.id}": the recording's rung "${x.rung}" feeds no stream sink, so it would add an encoder; bind it to a stream rung, or set "ownRung": true on the target`);
    }
  }
  const params = {
    rungs: usedRungs.map((r) => {
      const o = {
        id: r.id, canvas: r.canvas, codec: r.codec, encoder: r.encoder ?? 'nvenc', rc: r.rc,
        w: r.w, h: r.h, fps: r.fps, bitrate: r.bitrate, gopSec: r.gop_sec
      };
      if (r.encoderOptions) o.options = r.encoderOptions;
      return o;
    }),
    audio: { bitrate: tracks[0].bitrate, sampleRate: tracks[0].sampleRate },
    sinks
  };
  if (policy) params.policy = policy;
  return { params, report: res, live };
}

// Reads a plan file: { "config": <O0 config> | "<path to O0 config>", "extraSinks": [<O0 sinks>], "targets": {...},
// "policy": {...} }. extraSinks are appended to the config's sinks (e.g. a recording sink on a preset).
// opts.select (launcher --sinks): ids of the plan's REAL sinks to keep; the other real sinks and their targets are
// dropped before validation (a rung left without sinks is then not created). Loopback and file sinks always stay.
export function planFile(file, opts = {}) {
  const { select, ...rest } = opts;
  const w = JSON.parse(readFileSync(file, 'utf8'));
  const base = typeof w.config === 'string'
    ? JSON.parse(readFileSync(path.resolve(REPO_ROOT, w.config), 'utf8'))
    : w.config;
  let config = w.extraSinks ? { ...base, sinks: [...base.sinks, ...w.extraSinks] } : base;
  let targets = w.targets ?? {};
  if (select !== undefined) {
    const real = realSinkIds(config, targets);
    if (!Array.isArray(select) || select.length === 0) throw new Error('select: give at least one real sink id');
    for (const id of select) {
      if (!real.includes(id)) throw new Error(`select: "${id}" is not a real sink of this plan (real sinks: ${real.join(', ') || 'none'})`);
    }
    if (new Set(select).size !== select.length) throw new Error('select: a sink id is given twice');
    const drop = new Set(real.filter((id) => !select.includes(id)));
    config = { ...config, sinks: config.sinks.filter((s) => !drop.has(s.id)) };
    targets = Object.fromEntries(Object.entries(targets).filter(([id]) => !drop.has(id)));
  }
  return { ...plan(config, targets, { ...rest, policy: w.policy }), wrapper: w, config };
}

/** Ids of the sinks whose target is real (rtmp/rtmps with server or serverRef), in config order. */
export function realSinkIds(config, targets) {
  return (config.sinks ?? []).map((s) => s.id).filter((id) => {
    const t = targets[id];
    return t && (t.transport === 'rtmp' || t.transport === 'rtmps') && (t.server !== undefined || t.serverRef !== undefined);
  });
}
