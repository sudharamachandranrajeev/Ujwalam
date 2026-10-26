# 2026-10-26 — Answers to open planning questions

Amends `docs/2026-10-26-build-plan.md`. Source: user answers, 2026-10-26.

## 1. Rename

`docs/build-plan.md` → `docs/2026-10-26-build-plan.md`. The dated build plan is the baseline; future amendments go in new dated files under `docs/plan/`.

## 2. P2 data — existing Meld clips corpus

Folder: `<clips-corpus>` (read-only; never modify, move or delete originals).

Inventory (user-run, 26 Oct 2026):

| Item | Value |
|---|---|
| Files | 5,923 MP4, one flat folder, 162 GB |
| Naming | `MeldStudio_Clip_Clipping_Output_YYYY-MM-DD_at_H.MM.SSam/pm.mp4` (all files parse) |
| Cadence | One clip every 30–31 s, back to back. Continuous automatic segments, **not** hand-picked highlights. |
| Duration | About 28–32 s each; boundaries may overlap or gap by 1–2 s |
| Format | 1080×1920 (vertical program output), 60 fps, H.264 ~7.5 Mbps, AAC stereo 48 kHz ~160 kbps, one audio track |
| Coverage | 24 Sep – 22 Oct 2026, 17 days, 19 sessions (29 min – 7 h 13 min), about 49 hours total |

Requirements for P2:

1. **Rebuild sessions.** Group clips into sessions (gap > 120 s starts a new session). One continuous session index per stream: clip order, start time, overlap trim. Virtual concatenation in the analysis cache; never re-encode or rewrite originals.
2. **Labels.** None exist. Build the labelling page; the user labels 3 sessions first: 20 Oct (7 h 13 min), 18 Oct (6 h 22 min), 17 Oct (3 h 48 min). The user marks highlights; nothing is invented.
3. **Chat.** Collect for labelled dates: Twitch VOD chat (TwitchDownloader, first — VODs expire), YouTube chat replay, legacy engage log (read-only; never paste its contents anywhere). Align to clip time via filename timestamps. Report per-session chat coverage; mark sessions with no chat.
4. **Vertical-only caveat.** Clips are the composited vertical output (camera, overlays, effects included). Check on a sample whether the CODM kill feed is visible and readable before relying on OCR; record as a finding. Ujwalam's own recordings keep a clean horizontal master alongside the vertical program.
5. **Other uses:** audio and voice-cue calibration; Whisper CODM vocabulary from transcripts; kill-feed and banner detector samples (if visible); default clip-window lengths.
6. **Split by session, not by clip.** Hold out ≥ 2 sessions as a test set never used for tuning.
7. **Disk.** Analysis cache (proxies, features, transcripts) goes in a separate folder the user chooses. Estimate its size before generating it.

P2 acceptance ("beats chat-only baseline on 3 streams") stays open until three sessions are labelled. No synthetic chat or invented labels for the acceptance test.

## 3. P1 plugins

Tiers are expectations only; all UNVERIFIED until tested. Pin every plugin to a build for the pinned libobs version. Record results in `docs/plugins/compat-matrix.md`.

| # | Plugin | Why | Expected tier |
|---|---|---|---|
| 1 | Background Removal (locaal-ai) | Local AI camera effect; replaces the unreliable Meld Background toggle | A (UNVERIFIED) |
| 2 | Move (Exeldro) | Animated transform transitions; candidate engine for cam-pop and similar effects | A (UNVERIFIED) |
| 3 | Source Clone (Exeldro) | Mirrors a source onto the vertical canvas; replaces Meld's duplicator | A (UNVERIFIED) |
| 4 | LocalVocal (locaal-ai) | Local whisper captions and speech-to-text; candidate for voice triggers | A/B (UNVERIFIED) |
| 5 | obs-websocket | Needed for Streamer.bot and Stream Deck compatibility | B (UNVERIFIED) |

Stretch (tier C test only): Advanced Scene Switcher.

## 4. "MELD MULTI"

In the user's Meld setup, "MELD MULTI" is the low-bitrate output shared by Twitch and Kick.

In Ujwalam it is **not a destination**; it is one shared rung in the encoder graph (`docs/plan/2026-10-26-output-graph.md`):

- One low-bitrate horizontal encode; two sinks bound to it: `twitch` and `kick`.
- Encoded once, delivered twice; a Kick reset leaves Twitch untouched (O1 acceptance).
- Rung settings (resolution, fps, codec, bitrate) are migrated from the MELD MULTI output in the imported Meld session — read, never guessed.
- Validated against the Twitch and Kick entries in the capability registry. Rejected settings are reported, never changed silently.

Built-in output preset: **"Multi — Twitch + Kick (shared low-bitrate rung)"**. YouTube H and YouTube V stay separate presets on their own rungs.

MediaMTX is used only as a local loopback test sink and, later, an optional remote relay target (O4).
