// SPDX-License-Identifier: GPL-3.0-or-later
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
//       | { "transport": "rtmps"|"rtmp"|"auto", "serverRef": "Ujwalam/stream/<x>-server", "keyRef": "..." } }
// keyRef / serverRef name Windows Credential Manager targets (^Ujwalam/stream/[a-z0-9-]{1,32}$). The host reads them
// itself; no key ever appears in a plan, in params, on argv or in a log. Ingest URLs for "server" come only from the
// platform's "ingest" entry (source + checked date); per-account ingests (serverFrom "keychain") need serverRef.
// transport "auto" (D309 proposed, serverRef only): the transport follows the scheme of the stored server address, which
// must be one of the platform's rtmp/rtmps protocols (data/platforms/<platform>.json), so a platform that takes only one
// of them cannot use "auto". The scheme is read at output build time (readServerSchemes: scheme facts only, the address
// is dropped at once and never kept, logged or put in params) and passed to plan() as opts.schemes; the host checks the
// scheme again against the transport on its connect thread. Without opts.schemes an "auto" target stays "auto" in the
// params (validation only; the host refuses it) and is listed in the result's "unresolved".
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

/** Live schemes a real target may use. */
export const LIVE_SCHEMES = Object.freeze(['rtmp', 'rtmps']);

/** The platform's rtmp/rtmps protocols (data/platforms/<id>.json protocols.value), in LIVE_SCHEMES order. */
export function liveSchemesOf(platform) {
  const p = platform?.protocols?.value;
  return Array.isArray(p) ? LIVE_SCHEMES.filter((x) => p.includes(x)) : [];
}

const setCmd = (ref) => `node services/event-core/cli.mjs credential set --target ${ref}`;
const schemesText = (list) => list.map((x) => `${x}://`).join(' or ');
const startsWith = (fact) => (fact.scheme ? `${fact.scheme}://` : 'no rtmp:// or rtmps://');

// The transport of a serverRef target from the stored address's scheme facts (never the address). fact:
// undefined = not read (no opts.schemes entry), { error: true } = could not be read, { present, scheme }.
function schemeTransport(where, t, allowed, platformId, fact) {
  const ref = t.serverRef;
  const named = `the server address in Windows Credential Manager target ${ref}`;
  if (t.transport === 'auto') {
    if (fact === undefined) return 'auto';
    if (fact.error) throw new Error(`${where}: ${named} could not be read, so rtmp or rtmps cannot be chosen. Check it, or leave this output out (--sinks)`);
    if (!fact.present) throw new Error(`${where}: no server address is stored in Windows Credential Manager target ${ref}. Set it (${schemesText(allowed)}) with: ${setCmd(ref)}, or leave this output out (--sinks)`);
    if (!allowed.includes(fact.scheme)) throw new Error(`${where}: ${named} starts with ${startsWith(fact)}, but ${platformId} takes only ${schemesText(allowed)}. Set it again with: ${setCmd(ref)}`);
    return fact.scheme;
  }
  // A named transport: a stored address with another scheme is refused here (missing or unreadable ones are left to
  // the host's urlPresent and the readiness check, as before).
  if (fact && !fact.error && fact.present && fact.scheme !== t.transport) {
    throw new Error(`${where}: ${named} starts with ${startsWith(fact)}, but this output sends ${t.transport}:// (${platformId} takes ${schemesText(allowed) || 'neither rtmp nor rtmps'}). Set it again with ${t.transport}:// using: ${setCmd(ref)}`);
  }
  return t.transport;
}

function realTarget(s, t, platform, platformId, schemes) {
  const where = `sink "${s.id}"`;
  const known = ['transport', 'server', 'serverRef', 'keyRef'];
  for (const k of Object.keys(t)) if (!known.includes(k)) throw new Error(`${where}: unknown real-target field "${k}"`);
  const protos = platform?.protocols?.value;
  if (t.transport === 'auto') {
    if (t.serverRef === undefined) throw new Error(`${where}: transport "auto" needs serverRef (the scheme comes from the stored server address); name rtmp or rtmps for a server from data`);
    const allowed = liveSchemesOf(platform);
    if (allowed.length < 2) throw new Error(`${where}: transport "auto" needs a platform that takes both rtmp and rtmps; ${platformId} takes ${allowed.join(', ') || 'neither'} (data/platforms/${platformId}.json protocols), so name the transport`);
    if (!allowed.includes(s.proto)) throw new Error(`${where}: sink proto ${s.proto} is not one of ${platformId}'s ${allowed.join(', ')}`);
  } else {
    if (t.transport !== s.proto) throw new Error(`${where}: target transport ${t.transport} must equal the sink proto ${s.proto}`);
    if (Array.isArray(protos) && !protos.includes(t.transport)) throw new Error(`${where}: ${platformId} does not take ${t.transport} (data/platforms/${platformId}.json protocols: ${protos.join(', ')})`);
  }
  if (typeof t.keyRef !== 'string' || !REF_RE.test(t.keyRef)) throw new Error(`${where}: keyRef must match ${REF_RE} (the key itself never goes in a plan)`);
  if ((t.server === undefined) === (t.serverRef === undefined)) throw new Error(`${where}: give exactly one of server (an ingest id from data/platforms/${platformId}.json) or serverRef`);
  const ingest = platform?.ingest;
  if (!ingest) throw new Error(`${where}: data/platforms/${platformId}.json has no ingest entry`);
  if (t.serverRef !== undefined) {
    if (typeof t.serverRef !== 'string' || !REF_RE.test(t.serverRef)) throw new Error(`${where}: serverRef must match ${REF_RE}`);
    if (t.serverRef === t.keyRef) throw new Error(`${where}: serverRef and keyRef must be different credentials`);
    const fact = schemes ? (Object.hasOwn(schemes, t.serverRef) ? schemes[t.serverRef] : (t.transport === 'auto' ? { error: true } : undefined)) : undefined;
    return { transport: schemeTransport(where, t, liveSchemesOf(platform), platformId, fact), urlRef: t.serverRef, keyRef: t.keyRef };
  }
  if (ingest.value?.serverFrom !== 'data') throw new Error(`${where}: ${platformId} ingest servers are chosen per user/account (serverFrom ${ingest.value?.serverFrom}); use serverRef`);
  const srv = (ingest.value.servers ?? []).find((x) => x.id === t.server);
  if (!srv) throw new Error(`${where}: unknown ${platformId} ingest server "${t.server}" (known: ${(ingest.value.servers ?? []).map((x) => x.id).join(', ') || 'none'})`);
  if (!validLiveUrl(srv.url, t.transport)) throw new Error(`${where}: ${platformId} ingest "${srv.id}" is not a valid ${t.transport} URL`);
  return { transport: t.transport, url: srv.url, keyRef: t.keyRef };
}

export function plan(config, targets, { platformsDir = PLATFORMS_DIR, policy, allowLive = false, schemes } = {}) {
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
  const unresolved = [];
  const keyRefs = new Map();
  const sinks = config.sinks.map((s) => {
    const t = targets[s.id];
    if (!t) throw new Error(`sink "${s.id}" has no target`);
    if (s.audioTracks && s.audioTracks.length !== 1) throw new Error(`sink "${s.id}": O1 sends exactly one audio track`);
    let target;
    const isReal = isRealTarget(t);
    let proto = s.proto;
    if (isReal) {
      target = realTarget(s, t, platforms[s.platform], s.platform, schemes);
      if (target.transport === 'auto') unresolved.push(s.id);
      else proto = target.transport; // = s.proto for a named transport; the chosen scheme for "auto"
      live.push(s.id);
    } else if (t.transport === 'rtmps' || t.transport === 'auto') {
      throw new Error(`sink "${s.id}": an ${t.transport} target is a real target (${t.transport === 'auto' ? 'serverRef' : 'server or serverRef'}, and keyRef)`);
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
    return { id: s.id, rung: rungOf.get(s.id).id, platform: s.platform, proto, priority: s.priority, target };
  });
  for (const id of Object.keys(targets)) {
    if (!config.sinks.some((s) => s.id === id)) throw new Error(`target "${id}" names no sink`);
  }
  if (live.length && !allowLive) {
    throw new Error(`real (non-loopback) targets for ${live.map((x) => `"${x}"`).join(', ')} are refused: plan with allowLive (the host must run with --allow-live, after the user's Start stream click)`);
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
  return { params, report: res, live, unresolved };
}

// Reads a plan file: { "config": <O0 config> | "<path to O0 config>", "extraSinks": [<O0 sinks>], "targets": {...},
// "policy": {...} }. extraSinks are appended to the config's sinks (e.g. a recording sink on a preset).
// opts.select (launcher --sinks): ids of the plan's REAL sinks to keep; the other real sinks and their targets are
// dropped before validation (a rung left without sinks is then not created). Loopback and file sinks always stay.
// opts.schemes (readServerSchemes) resolves "auto" targets and checks named transports against the stored scheme.
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

/** Ids of the sinks whose target is real (rtmp/rtmps/auto with server or serverRef), in config order. */
export function realSinkIds(config, targets) {
  return (config.sinks ?? []).map((s) => s.id).filter((id) => {
    const t = targets[id];
    return isRealTarget(t);
  });
}

/** True for a real target: rtmp, rtmps or auto with server or serverRef. */
export function isRealTarget(t) {
  return !!t && (t.transport === 'rtmp' || t.transport === 'rtmps' || t.transport === 'auto') && (t.server !== undefined || t.serverRef !== undefined);
}

/**
 * Scheme facts of the stored server addresses a plan file names (serverRef of its real targets; with opts.select only
 * the selected sinks'), for planFile's opts.schemes: { "<serverRef>": { present, scheme } | { error: true } }.
 * readFacts(ref) resolves { present, scheme } and must drop the value itself (readiness.mjs credentialFacts with
 * { scheme: true }); nothing else of the address ever reaches this module. A failed read becomes { error: true }.
 */
export async function readServerSchemes(file, readFacts, { select } = {}) {
  const w = JSON.parse(readFileSync(file, 'utf8'));
  const refs = new Set();
  for (const [id, t] of Object.entries(w.targets ?? {})) {
    if (!isRealTarget(t) || typeof t.serverRef !== 'string' || !REF_RE.test(t.serverRef)) continue;
    if (Array.isArray(select) && !select.includes(id)) continue;
    refs.add(t.serverRef);
  }
  const out = {};
  for (const ref of refs) {
    try {
      const f = await readFacts(ref);
      out[ref] = { present: f?.present === true, scheme: f?.present === true && typeof f.scheme === 'string' ? f.scheme : null };
    } catch {
      out[ref] = { error: true };
    }
  }
  return out;
}
