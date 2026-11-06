# 2026-11-06 Stream-day mock run (headless, loopback only)

Status: **PASS (mock)**. Awaiting the first real test stream; nothing here is a live-feature "done".

Purpose: before the first real test stream, run the full stack for an hour as it will run on the day,
with everything pointed at local loopback receivers, and look for failures, leaks and lag.

## Setup

- Branch `claude/alpha0-d1`, working tree (uncommitted), Windows 11, RTX 4050 Laptop (6 GB).
- Host: `ujwalam-host.exe`, OBS 32.1.2 with the patched `obs-nvenc.dll`
  (`node tools/obs-patch/build-obs-nvenc.mjs --check` -> patched; checked by the driver before start).
- `UJWALAM_HEADLESS=1`, no `--allow-devices`, no `--allow-live`, no window, global hotkeys off in the host config.
- Outputs: a copy of `data/outputs/alpha-live.json` with every stream target replaced by
  `rtmp://127.0.0.1:19551-19554` (no keyRef or serverRef; test `tests/stream-day.test.mjs`).
  Receivers: `ffmpeg -listen 1`, segmented (300 s, wrap 3) to bound disk.
  Rungs: yt-h 1920x1080@60 17000 kbps; reencode-tk 1920x1080@60 6000 kbps (twitch + kick); vert 1080x1920@60 7500 kbps; recording on yt-h.
- Event core with the mock Streamer.bot replaying one real chat export (counts only, never text).
- Flags on, in a temporary data dir only: `live-markers`, `posting`, `auto-post` (dry-run, autoUpload false),
  `chat-effects`, `test-broadcast`. Flash guards from `data/effects/guards.json`; the scoped markers host
  token (D214); replay buffer saves.
- The driver starts the outputs by calling the host's own API with its own token (loopback only).
  The control page's "yes, on air" gate was not used or typed.
- All processes at BelowNormal priority. `Get-Process MeldStudio*` checked before each run: not running.
- Driver: `tools/soak/stream-day.mjs` (new), reusing `tools/soak/replay.mjs` (export choice, timeline, purge proof)
  and `services/studio-ui/launch.mjs` (same launch wiring as `npm run alpha`).

## Commands

```
UJWALAM_HEADLESS=1 node tools/soak/stream-day.mjs --data-root <data-root> --minutes 3 --run-id stream-day-smoke1
UJWALAM_HEADLESS=1 node tools/soak/stream-day.mjs --data-root <data-root> --minutes 60 --sample-s 30 --run-id stream-day-60m
UJWALAM_HEADLESS=1 node tools/soak/stream-day.mjs --data-root <data-root> --minutes 10 --max-gap-s 0.25 --no-record
node --test tests/stream-day.test.mjs tests/posting-live-check.test.mjs   # 14 pass, 0 fail
node tools/lint.mjs                                                       # 0 findings
```

`<data-root>` is the local data folder outside the repo. Per-run output: `<data-root>/soak/<run-id>/`
(`result.json`, `timeseries.jsonl`, logs); media in `<data-root>/soak/<run-id>-media/`.

## 60-minute run (stream-day-60m)

| Check | Result | Numbers |
|---|---|---|
| Stream and record start/stop | PASS | all ok; host exit code 0 |
| Frame rate and render | PASS | 124 samples over 3605 s; fps min 60.0; renderLagged 0; encodeSkipped 0 |
| Sinks | PASS | 5 sinks, never not-live; dropped 0, retries 0 on every sink (~216,200 frames each) |
| NVENC / GPU | PASS | NVENC sessions max 3; VRAM max 1418 MB; GPU max 21 %; host CPU max 6.6 %; 0 sessions after stop |
| Memory (after warm-up, t=618 s) | PASS | host private 1647.7 -> 1649.4 MB (+1.7); process tree private +33.1 MB; host handles +0; tree handles +15; processes 42 -> 42 |
| Event core | PASS | core RTT max 2 ms; control page non-200 responses 0 |
| Chat delivery | PASS | 12/12 messages delivered by SSE; latency p50 1.07 ms, p95 5.45 ms, max 5.45 ms |
| Replay saves | PASS | 6/6 ok, 2 files each (H 1920x1080 17 Mbps, V 1080x1920 7.5 Mbps), 28.5-29.7 s each |
| Effects and guards | PASS | 12 bursts, 17 fires each: 3 delivered, 11 refused busy, 3 refused region-busy per burst; overlay 6 clients, 36 effects shown |
| Live markers | PASS (limited) | 1 marker (chat speed spike at start); see "Findings" |
| Feedback capture | PASS | 1 capture, ok |
| Recording | PASS | 7309 MB, 3604.6 s, ffprobe ok |
| Received streams (ffprobe) | PASS | h264 1920x1080@60 ~6000 kbps (twitch, kick), ~17000 (yt-h); 1080x1920@60 ~7500 (yt-v); GOP 2 s; AAC 48 kHz stereo |
| Auto-post while live and after stop | PASS (after fix) | `auto --run`: refused (output-state-unreadable), exit 1; dry run exit 0 |
| Crash reports | PASS | 0 `crash-*.txt` |
| Stray processes | PASS | node 0, host 0, ffmpeg 0, cef 0 after teardown |
| Chat text in run files | PASS | before purge: body hits only in the audit DB (1 file); after purge 0; other 95 run files 0/0; verify exit 0 |

Audio in the received streams is ~2 kbps (silence): with devices off there is no audio source. Real audio is not checked.

## Dense chat run (10 min, `--max-gap-s 0.25`)

The corpus chat is sparse (the chosen export has 18 messages over about 3.7 h), so a second run compressed the gaps.

- 2529 messages sent, 2529 delivered by SSE, 0 with no client.
- Latency p50 0.61 ms, p95 0.91 ms, p99 1.16 ms, max 4.75 ms; emit lag max 54 ms.
- dropped 0, retries 0, fps 60, NVENC 3, memory flat (delta 0), overlay chat frames 5058.
- Markers 1 (speed spike at start); crashes 0; strays 0; text scans clean.
- Recording ran in this run despite `--no-record` (driver bug, fixed; see below). No effect on the numbers.

## Findings and fixes

1. **Posting live check failed open in a studio session (fixed).**
   `services/posting/cli.mjs` read only the standalone host's discovery file. In a studio session that file
   does not exist, so a live session read as "nothing live". In the 3-minute smoke run (old code),
   `auto --run` while live exited 0 with `auto-post: {}`.
   Fix: `outputsStatusFor(dataDir)` reads the studio's `<event-core data dir>/host.json` first, then the
   standalone file. A file with a dead pid is skipped. A running host whose state cannot be read
   (unreadable file, or no host token in the shell) refuses. Decision D217.
   Test: `tests/posting-live-check.test.mjs` (8 tests, including the CLI refusing with a studio host.json and no token).
   Effect for the user: from a shell, `auto --run` and `youtube upload` refuse while the studio runs; use the
   control page's Posts view instead.
2. **Driver argument bug (fixed).** `--no-record` took the next argument as its value, so `--run-id` was lost.
   Fix: `parseRunArgs` with boolean options; test in `tests/stream-day.test.mjs`.
3. **Driver teardown and scan scope (fixed during development).** Variables used in teardown are declared
   before any step that can fail; media lives outside the run folder so the text scan does not read GBs of
   video; names that come from the local profile (overlay URL in the local project file) are counted
   separately from chat names.

## Not checked / UNVERIFIED

- Real devices: mic, facecam, capture card, real audio levels. Audio markers not exercised.
- Real platforms and RTMPS (loopback RTMP only, by rule).
- Chat-intent markers ("clip it") end to end: the corpus has 0 matches; covered by unit tests only.
- Speed-spike marker fires at stream start when the baseline is about 0: a likely false positive on every
  stream. The threshold is `proposed` in `data/clip/live-markers.json`; needs a user decision.
- Flash limit at its cap: busy and cooldown guards refuse first, so the 3/s flash refusal was not reached.
  `npm run fx:test` covers the flash rate itself.
- Event-core `liveState` stays `unknown` while the host is live (nothing calls `live.set`). The gate treats
  unknown as live, so it fails closed. Known gap, not a blocker.
- Priority: the run used BelowNormal; on the day the stack runs at Normal.
- Another agent may have run a bench calibration during these runs (uncommitted D216); the GPU numbers
  could include that noise. They stayed far inside the limits either way.

## Files

Created: `tools/soak/stream-day.mjs`, `tests/stream-day.test.mjs`, `tests/posting-live-check.test.mjs`,
`docs/procedures/2026-11-06-stream-test-checklist.md`, this file.
Changed: `services/posting/cli.mjs` (fix), `services/studio-ui/launch.mjs` (exports only),
`docs/plan/2026-10-29-v1-decisions.md` (D217).
