# 2026-10-26 — Output graph

Amends `docs/2026-10-26-build-plan.md`: replaces §4.11 Outputs and splits P6 into O0–O5. The rest of the plan is unchanged.

## Principle

Inside Ujwalam the composited frame already exists. A lower rung is a GPU scale of that frame: no decode, no second-generation quality loss. Port the intent of the MediaMTX rig, not its plumbing.

## Three layers (strictly separate)

1. **Compositor:** renders at master resolution on one clock (one per canvas: H and V).
2. **Encoder pool:** rungs `{id, canvas, w, h, fps, codec, bitrate, rc, gop_sec}`.
   - Deduplicated: identical rungs are shared.
   - Audio is encoded once (AAC-LC 160 kbps / 48 kHz) and remuxed into every sink, never re-encoded per destination.
3. **Delivery pool:** one supervised sink per destination, bound to one rung. Sinks never own encoders.

Recording and replay buffer bind to existing rungs like sinks; they never get their own encoder unless a rung is added for them.

```yaml
canvases:
  - { id: H, w: 3840, h: 2160, fps: 60 }
  - { id: V, w: 1080, h: 1920, fps: 60 }
encoders:
  - { id: uhd,   canvas: H, w: 3840, h: 2160, codec: hevc, bitrate: 20000, rc: cbr, gop_sec: 2 }
  - { id: multi, canvas: H, w: 1920, h: 1080, codec: h264, bitrate: 6000,  rc: cbr, gop_sec: 2 }   # "MELD MULTI": values migrated from Meld session
  - { id: vert,  canvas: V, w: 1080, h: 1920, codec: h264, bitrate: 6000,  rc: cbr, gop_sec: 2 }
sinks:
  - { id: youtube-h, encoder: uhd,  proto: rtmps, priority: 1 }
  - { id: youtube-v, encoder: vert, proto: rtmps, priority: 2 }
  - { id: twitch,    encoder: multi, proto: rtmp,  priority: 3 }
  - { id: kick,      encoder: multi, proto: rtmps, priority: 4 }
```

The numbers are an example. Real values come from the capability registry and measured upload. The 4K60 H canvas + 4K HEVC rung is likely too heavy for the RTX 4050 Laptop while gaming (UNVERIFIED; O2 budget test measures it).

## Platform capability registry

- `data/platforms/*.json`, data only, editable without a release.
- Per platform: max resolution and fps, codec whitelist, bitrate floor and ceiling, keyframe interval, protocols, multitrack support.
- **Every value carries `source` (official doc URL) and `checked` (date).** Unverified values are marked UNVERIFIED and produce a warning, not a block.
- The validator refuses impossible configs before going live, e.g. a codec a platform doesn't accept.

## Stack answer (encoder-graph design)

- Ujwalam runs **in-process on libobs**.
- Rungs are libobs encoder objects (hardware encoders via libobs); sinks are libobs outputs bound to a shared encoder.
- Rung dedup and session budgeting therefore happen in one process.
- FFmpeg child processes are used only for post-stream rendering and test assertions.
- P1 must confirm in the pinned libobs version (each UNVERIFIED until tested; if one fails, stop and write an ADR):
  - several outputs can share one encoder
  - an encoder can scale from the canvas on the GPU
  - two canvases (H and V) can each feed their own encoders

## Phases (replace P6)

| # | Goal | Done when |
|---|---|---|
| O0 | Output config schema, capability registry, validator that resolves sinks to rungs and reports conflicts. No encoding. (Can run right after P0.) | Validator unit tests cover dedup, codec refusal, bitrate out of range, missing rung |
| O1 | One encoder, N sinks. Per-sink ring buffer with explicit drop policy; reconnect with exponential backoff and jitter; per-sink state in UI and API. **Local loopback target first:** MediaMTX on localhost plus ffprobe assertions on resolution, codec, GOP and bitrate stability. Muxer abstraction designed for Enhanced RTMP (FourCC codecs, multiple video tracks) from day one. | Killing one sink (e.g. Kick) leaves the others untouched, on loopback and then on real test streams |
| O2 | Encoder graph: GPU scale from master, rung dedup, H and V canvases, encoder-session budgeting. Probe hardware session limits at runtime (never hardcode); when over budget, fold rungs or fall back to another encoder. | Four sinks on three rungs run 2 h with ffprobe-verified output; budget fallback tested |
| O3 | Bandwidth governor: measured upload vs total egress; shed the lowest-priority sink instead of degrading all. Encoder-graph panel showing canvases → rungs → sinks with live stats. | Simulated upload drop sheds the right sink; the others hold bitrate |
| O4 *(deferred)* | Remote relay mode: one master feed over SRT to a relay the user runs; sinks resolve remotely, same config model | — |
| O5 *(deferred)* | Enhanced RTMP multitrack (e.g. Twitch higher-resolution path) | — |

## CLAUDE.md additions

```
- Outputs: compositor → encoder pool → delivery pool. Sinks never own encoders. Audio encoded once.
- Platform limits live in data/platforms/*.json with source + checked date; never hardcode them.
- Never test outputs against real platforms until loopback ffprobe assertions pass.
- Never hardcode hardware encoder session limits; probe at runtime.
```
