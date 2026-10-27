// SPDX-License-Identifier: GPL-2.0-or-later
// Output config validator (O0). Pure: (config, platforms) -> { rungs, errors, warnings, info }.
// It reports only; it never mutates or "fixes" settings. Node stdlib only (no ajv at runtime).
//
// NOT checked here: hardware encoder session limits (NVENC sessions etc.). Those are
// probed at runtime in O2 and never hardcoded.
//
// Usage: node services/outputs/validate.mjs <config.json> [platformsDir]
//   platformsDir  default data/platforms (relative to cwd); every *.json except
//                 platform.schema.json is loaded and keyed by file name without extension.
// Exit code 1 only if there is an error-severity finding (warnings never fail). Messages never contain stream keys or ingest URLs.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AUDIO = { tracks: [{ id: 'master', name: 'Master Track', codec: 'aac', bitrate: 160, sampleRate: 48000 }] };

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// Fields that make two encoders the same rung (encoderOptions included so that
// different presets/tunings are never merged).
function rungKey(e, canvas) {
  return JSON.stringify({
    canvas: e.canvas, w: e.w, h: e.h, fps: e.fps ?? canvas?.fps, codec: e.codec, bitrate: e.bitrate,
    rc: e.rc, gop_sec: e.gop_sec, encoder: e.encoder ?? null, encoderOptions: sortKeys(e.encoderOptions ?? null)
  });
}

function dupIds(list, kind, errors) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) errors.push({ code: 'DUP_ID', message: `duplicate ${kind} id "${x.id}"`, kind, id: x.id });
    seen.add(x.id);
  }
}

export function validate(config, platforms = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const canvases = config.canvases ?? [];
  const encoders = config.encoders ?? [];
  const sinks = config.sinks ?? [];
  const tracks = (config.audio ?? DEFAULT_AUDIO).tracks ?? [];

  dupIds(canvases, 'canvas', errors);
  dupIds(encoders, 'encoder', errors);
  dupIds(sinks, 'sink', errors);
  dupIds(tracks, 'audio track', errors);

  const canvasById = new Map(canvases.map((c) => [c.id, c]));
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  // ---- resolve rungs (dedup) ---------------------------------------------------
  const rungs = [];
  const rungOfEncoder = new Map(); // encoder id -> resolved rung
  const byKey = new Map();
  for (const e of encoders) {
    const pending = e.migration?.status === 'pending';
    if (pending) {
      errors.push({
        code: 'MIGRATION_PENDING', class: 'BLOCKED', rung: e.id,
        message: `rung "${e.id}": migration pending from "${e.migration.from}"; values must come from the Meld session/prefs; not guessed`
      });
    }
    const canvas = canvasById.get(e.canvas);
    if (!canvas) errors.push({ code: 'MISSING_CANVAS', rung: e.id, message: `rung "${e.id}": canvas "${e.canvas}" not found` });
    const rung = {
      id: e.id, canvas: e.canvas, w: e.w, h: e.h, fps: e.fps ?? canvas?.fps, codec: e.codec, bitrate: e.bitrate,
      rc: e.rc, gop_sec: e.gop_sec, encoder: e.encoder ?? null, mergedFrom: [], sinks: [], pending
    };
    if (e.encoderOptions) rung.encoderOptions = e.encoderOptions;
    // Pending or canvas-less rungs are never merged: their values are not real.
    const key = pending || !canvas ? null : rungKey(e, canvas);
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.mergedFrom.push(e.id);
      rungOfEncoder.set(e.id, existing);
      info.push({
        code: 'RUNG_DEDUP', rung: existing.id, mergedFrom: [...existing.mergedFrom],
        message: `rungs ${[existing.id, ...existing.mergedFrom].map((i) => `"${i}"`).join(', ')} are identical; resolved to one rung "${existing.id}"`
      });
      continue;
    }
    rungs.push(rung);
    rungOfEncoder.set(e.id, rung);
    if (key) byKey.set(key, rung);
  }

  // ---- rung-only checks (against canvas) ---------------------------------------
  for (const r of rungs) {
    const canvas = canvasById.get(r.canvas);
    if (!canvas || r.pending) continue;
    if (r.w > canvas.w || r.h > canvas.h) {
      errors.push({ code: 'UPSCALE', rung: r.id, message: `rung "${r.id}": ${r.w}x${r.h} is larger than canvas "${canvas.id}" ${canvas.w}x${canvas.h}` });
    }
    if (r.fps > canvas.fps || !Number.isInteger(canvas.fps / r.fps)) {
      errors.push({ code: 'FPS_DIVISOR', rung: r.id, message: `rung "${r.id}": canvas fps ${canvas.fps} is not an integer multiple of rung fps ${r.fps}` });
    }
  }

  // ---- sink checks ----------------------------------------------------------------
  // Every platform value carries a severity ("error" | "warning"). A failed check is
  // reported as an error or a warning according to the rule it used, with the same code.
  // UNVERIFIED values are always warnings.
  const unverifiedSeen = new Set();
  const sinkFailures = new Map(); // rung id -> Map(sink id -> worst severity) for video checks
  const notRecSeen = new Set();

  const worse = (a, b) => (a === 'error' || b === 'error' ? 'error' : 'warning');

  // Returns { v, sev, message } or undefined when the rule has no value (null).
  // Unverified nodes add one UNVERIFIED_LIMIT warning per platform field.
  function lim(platformId, node, field) {
    if (!node) return undefined;
    if (node.unverified) {
      const k = `${platformId}.${field}`;
      if (!unverifiedSeen.has(k)) {
        unverifiedSeen.add(k);
        warnings.push({
          code: 'UNVERIFIED_LIMIT', severity: 'warning', platform: platformId, field,
          message: `${platformId}.${field} is UNVERIFIED (${node.note ?? 'no note'}); ${node.value === null ? 'not checked' : 'checked against an unconfirmed value (warning only)'}`
        });
      }
    }
    if (node.value === null) return undefined;
    return { v: node.value, sev: node.unverified ? 'warning' : (node.severity ?? 'error'), message: node.message };
  }

  for (const s of sinks) {
    const rung = rungOfEncoder.get(s.encoder);
    if (!rung) errors.push({ code: 'MISSING_RUNG', sink: s.id, message: `sink "${s.id}": encoder "${s.encoder}" not found` });
    else rung.sinks.push(s.id);
    for (const tid of s.audioTracks ?? []) {
      if (!trackById.has(tid)) errors.push({ code: 'MISSING_AUDIO_TRACK', sink: s.id, message: `sink "${s.id}": audio track "${tid}" not found` });
    }
    const p = platforms[s.platform];
    if (!p) {
      errors.push({ code: 'MISSING_PLATFORM', sink: s.id, message: `sink "${s.id}": platform "${s.platform}" not in registry` });
      continue;
    }
    // l = the lim() result of the rule that failed; its severity and optional message decide the report.
    const fail = (l, code, message, video = true) => {
      const sev = l.sev;
      const entry = { code, severity: sev, sink: s.id, platform: s.platform, rung: rung?.id, message: l.message ? `${l.message} (${message})` : message };
      (sev === 'error' ? errors : warnings).push(entry);
      if (rung && video) {
        if (!sinkFailures.has(rung.id)) sinkFailures.set(rung.id, new Map());
        const m = sinkFailures.get(rung.id);
        m.set(s.id, worse(m.get(s.id) ?? 'warning', sev));
      }
    };

    const proto = lim(s.platform, p.protocols, 'protocols');
    if (proto && !proto.v.includes(s.proto)) fail(proto, 'PROTO_UNSUPPORTED', `sink "${s.id}": protocol ${s.proto} not supported by ${s.platform} (${proto.v.join(', ')})`, false);

    // Audio: each sink receives the listed tracks (default: all).
    const sinkTracks = (s.audioTracks ?? tracks.map((t) => t.id)).map((id) => trackById.get(id)).filter(Boolean);
    const maxTracks = lim(s.platform, p.audioTracksMax, 'audioTracksMax');
    if (maxTracks && sinkTracks.length > maxTracks.v) fail(maxTracks, 'AUDIO_TRACKS_MAX', `sink "${s.id}": ${sinkTracks.length} audio tracks exceed ${s.platform} max ${maxTracks.v}`, false);
    const aCodecs = lim(s.platform, p.audioCodecs, 'audioCodecs');
    const aMax = lim(s.platform, p.audioBitrateKbps?.max, 'audioBitrateKbps.max');
    // Recommended (not max) audio values: warning only, once per platform/track/field.
    const aRec = lim(s.platform, p.audioBitrateKbps?.recommended, 'audioBitrateKbps.recommended');
    const srRec = lim(s.platform, p.audioSampleRateHz?.recommended, 'audioSampleRateHz.recommended');
    for (const t of sinkTracks) {
      for (const [field, have, rec, unit] of [['audioBitrateKbps', t.bitrate, aRec, 'kbps'], ['audioSampleRateHz', t.sampleRate, srRec, 'Hz']]) {
        const k = `${s.platform}.${t.id}.${field}`;
        if (rec && have !== rec.v && !notRecSeen.has(k)) {
          notRecSeen.add(k);
          warnings.push({ code: 'NOT_RECOMMENDED', severity: 'warning', platform: s.platform, sink: s.id, field, message: `sink "${s.id}": audio track "${t.id}" ${have} ${unit} differs from ${s.platform} recommended ${rec.v} ${unit}` });
        }
      }
      if (aCodecs && !aCodecs.v.includes(t.codec)) fail(aCodecs, 'AUDIO_CODEC_REFUSED', `sink "${s.id}": audio track "${t.id}" codec ${t.codec} refused by ${s.platform} (${aCodecs.v.join(', ')})`, false);
      if (aMax && t.bitrate > aMax.v) fail(aMax, 'AUDIO_BITRATE_RANGE', `sink "${s.id}": audio track "${t.id}" ${t.bitrate} kbps exceeds ${s.platform} max ${aMax.v}`, false);
    }

    if (!rung || rung.pending || !canvasById.has(rung.canvas)) continue;

    const codecs = lim(s.platform, p.videoCodecs, 'videoCodecs');
    if (codecs && !codecs.v.includes(rung.codec)) fail(codecs, 'CODEC_REFUSED', `rung "${rung.id}" (sink "${s.id}"): codec ${rung.codec} refused by ${s.platform} (${codecs.v.join(', ')})`);

    const rcs = lim(s.platform, p.rateControl, 'rateControl');
    if (rcs && !rcs.v.includes(rung.rc)) fail(rcs, 'RC_REFUSED', `rung "${rung.id}" (sink "${s.id}"): rate control ${rung.rc} refused by ${s.platform} (${rcs.v.join(', ')})`);

    const bMin = lim(s.platform, p.videoBitrateKbps?.min, 'videoBitrateKbps.min');
    const bMax = lim(s.platform, p.videoBitrateKbps?.max, 'videoBitrateKbps.max');
    if (bMin && rung.bitrate < bMin.v) fail(bMin, 'BITRATE_RANGE', `rung "${rung.id}" (sink "${s.id}"): bitrate ${rung.bitrate} kbps below ${s.platform} min ${bMin.v}`);
    if (bMax && rung.bitrate > bMax.v) fail(bMax, 'BITRATE_RANGE', `rung "${rung.id}" (sink "${s.id}"): bitrate ${rung.bitrate} kbps above ${s.platform} max ${bMax.v}`);

    // Orientation rule: platform maxima are expressed for landscape (maxWidth x maxHeight).
    // Compare the rung's long side to the platform's long side and its short side to the
    // platform's short side, so a vertical 1080x1920 rung is judged like landscape 1920x1080.
    const mw = lim(s.platform, p.maxWidth, 'maxWidth');
    const mh = lim(s.platform, p.maxHeight, 'maxHeight');
    if (mw && mh) {
      const rl = Math.max(rung.w, rung.h);
      const rs = Math.min(rung.w, rung.h);
      if (rl > Math.max(mw.v, mh.v) || rs > Math.min(mw.v, mh.v)) {
        fail({ sev: worse(mw.sev, mh.sev), message: mw.message ?? mh.message }, 'RESOLUTION_MAX', `rung "${rung.id}" (sink "${s.id}"): ${rung.w}x${rung.h} exceeds ${s.platform} max ${mw.v}x${mh.v} (orientation-aware)`);
      }
    }
    const mf = lim(s.platform, p.maxFps, 'maxFps');
    if (mf && rung.fps > mf.v) fail(mf, 'FPS_MAX', `rung "${rung.id}" (sink "${s.id}"): ${rung.fps} fps exceeds ${s.platform} max ${mf.v}`);

    // Keyframe: a value may carry a hard max and a recommendation; both are checked.
    // A rung already over the max is not additionally reported as not recommended.
    const gMax = lim(s.platform, p.keyframeIntervalSec?.max, 'keyframeIntervalSec.max');
    let gopOver = false;
    if (gMax && rung.gop_sec > gMax.v) {
      gopOver = true;
      fail(gMax, 'GOP_MAX', `rung "${rung.id}" (sink "${s.id}"): keyframe interval ${rung.gop_sec}s exceeds ${s.platform} max ${gMax.v}s`);
    }
    const gRec = lim(s.platform, p.keyframeIntervalSec?.recommended, 'keyframeIntervalSec.recommended');
    const gk = `${s.platform}.${rung.id}.keyframe`;
    if (gRec && !gopOver && rung.gop_sec !== gRec.v && !notRecSeen.has(gk)) {
      notRecSeen.add(gk);
      warnings.push({ code: 'NOT_RECOMMENDED', severity: 'warning', platform: s.platform, sink: s.id, rung: rung.id, field: 'keyframeIntervalSec', message: `rung "${rung.id}" (sink "${s.id}"): keyframe interval ${rung.gop_sec}s differs from ${s.platform} recommended ${gRec.v}s` });
    }
  }

  // ---- shared rung conflicts ------------------------------------------------------
  // Severity is the worst severity among the failing sinks.
  for (const [rid, failed] of sinkFailures) {
    const rung = rungs.find((r) => r.id === rid);
    if (rung.sinks.length >= 2) {
      const sev = [...failed.values()].reduce(worse, 'warning');
      (sev === 'error' ? errors : warnings).push({
        code: 'SHARED_RUNG_CONFLICT', severity: sev, rung: rid, failedSinks: [...failed.keys()], sinks: [...rung.sinks],
        message: `rung "${rid}" is shared by sinks ${rung.sinks.map((i) => `"${i}"`).join(', ')} and fails for ${[...failed.keys()].map((i) => `"${i}"`).join(', ')}; change the rung or give the failing sink its own rung`
      });
    }
  }

  // Total egress: each sink sends its rung's video plus every audio track it receives.
  let egressKbps = 0;
  for (const s of sinks) {
    const rung = rungOfEncoder.get(s.encoder);
    const st = (s.audioTracks ?? tracks.map((t) => t.id)).map((id) => trackById.get(id)).filter(Boolean);
    egressKbps += (rung && !rung.pending ? rung.bitrate : 0) + st.reduce((a, t) => a + t.bitrate, 0);
  }

  return {
    rungs: rungs.map(({ pending, ...r }) => r),
    errors: errors.map((e) => ({ severity: 'error', ...e })),
    warnings: warnings.map((w) => ({ severity: 'warning', ...w })),
    info,
    egressKbps
  };
}

export function loadPlatforms(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'platform.schema.json').sort()) {
    out[path.basename(f, '.json')] = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  }
  return out;
}

export function formatReport(res) {
  const lines = [];
  for (const e of res.errors) lines.push(`ERROR   ${e.code}${e.class ? ` [${e.class}]` : ''} [error]: ${e.message}`);
  for (const w of res.warnings) lines.push(`WARN    ${w.code} [warning]: ${w.message}`);
  for (const i of res.info) lines.push(`INFO    ${i.code}: ${i.message}`);
  lines.push('Resolved rungs:');
  for (const r of res.rungs) {
    lines.push(`  ${r.id} (${r.canvas} ${r.w}x${r.h}@${r.fps} ${r.codec} ${r.bitrate}k ${r.rc} gop ${r.gop_sec}s) -> ${r.sinks.join(', ') || '(no sinks)'}`);
  }
  lines.push(`Total egress: ${res.egressKbps} kbps`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cfgPath, platDir = 'data/platforms'] = process.argv.slice(2);
  if (!cfgPath) {
    console.error('usage: node services/outputs/validate.mjs <config.json> [platformsDir]');
    process.exit(2);
  }
  const res = validate(JSON.parse(readFileSync(cfgPath, 'utf8')), loadPlatforms(platDir));
  console.log(cfgPath);
  console.log(formatReport(res));
  process.exit(res.errors.length ? 1 : 0);
}
