// SPDX-License-Identifier: GPL-2.0-or-later
// O0 output config -> ujwalam-host outputs.configure params.
//
// The O0 config is validated with services/outputs/validate.mjs against data/platforms/*.json first (platform
// limits are never hardcoded here or in the host). Its resolved, deduplicated rungs become host rungs; each sink
// is bound to its rung (sinks never own encoders). Delivery targets come from a separate loopback map, because
// O0 sinks carry no URL or key by design:
//   targets: { "<sinkId>": { "transport": "rtmp", "port": 19352, "app": "live", "stream": "twitch" }
//                        | { "transport": "srt", "port": 19360, "latencyMs": 120 }
//                        | { "transport": "file", "name": "rec-h.mkv" } }
// O1 is loopback only: the host builds every URL on 127.0.0.1 and has no field for a remote URL or key.
// The sink's real proto (twitch rtmp, kick rtmps, ...) stays validated against its platform; the loopback transport
// is chosen per sink and may differ (O1 tests delivery mechanics, not the platform leg).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validate, loadPlatforms, formatReport } from '../../../services/outputs/validate.mjs';
import { REPO_ROOT } from './config.mjs';

export const PLATFORMS_DIR = path.join(REPO_ROOT, 'data', 'platforms');

export function plan(config, targets, { platformsDir = PLATFORMS_DIR, policy } = {}) {
  const res = validate(config, loadPlatforms(platformsDir));
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
    sinks: config.sinks.map((s) => {
      const t = targets[s.id];
      if (!t) throw new Error(`sink "${s.id}" has no loopback target`);
      if (s.audioTracks && s.audioTracks.length !== 1) throw new Error(`sink "${s.id}": O1 sends exactly one audio track`);
      return { id: s.id, rung: rungOf.get(s.id).id, platform: s.platform, proto: s.proto, priority: s.priority, target: t };
    })
  };
  for (const id of Object.keys(targets)) {
    if (!config.sinks.some((s) => s.id === id)) throw new Error(`target "${id}" names no sink`);
  }
  if (policy) params.policy = policy;
  return { params, report: res };
}

// Reads an O1 plan file: { "config": <O0 config> | "<path to O0 config>", "targets": {...}, "policy": {...} }
export function planFile(file, opts = {}) {
  const w = JSON.parse(readFileSync(file, 'utf8'));
  const config = typeof w.config === 'string'
    ? JSON.parse(readFileSync(path.resolve(REPO_ROOT, w.config), 'utf8'))
    : w.config;
  return { ...plan(config, w.targets ?? {}, { ...opts, policy: w.policy }), wrapper: w, config };
}
