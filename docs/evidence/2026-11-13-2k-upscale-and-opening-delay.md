# 2026-11-13 — 2K YouTube H and V (D378), studio opens without Instagram (D379), opening delay (D380)

## D379: a refused live plan never keeps the studio from opening

- Before (alpha.27, installed log `launcher-2026-11-13T18-41-54`): `outputs plan refused: sink "instagram": no server
  address is stored ... Ujwalam/stream/instagram-server`, `launcher ended (exit 1)`, no window. Five starts failed
  between 18:33 and 18:41.
- After (alpha.28, installed, the user's own start at 19:06:57, `launcher-2026-11-13T19-06-57-p47676.log`):
  `WARNING: live plan refused: sink "instagram" ...`, `WARNING: Instagram Live left out of this start (reason above);
  the other outputs are ready`, `LIVE plan: data\outputs\alpha-live.json`, `outputs: real targets ALLOWED (--live);
  6 sink(s)`, UI line, studio window running (ujwalam-studio.exe pid seen).
- Tests: `tests/studio-launch-d327.test.mjs` planForStart (5 cases); full CI 16/16 on 5139e4b (stamp 4231d3730fa3);
  package E2E 20/20 on `ujwalam-0.1.0-alpha.28-win64.zip`.

## D378: stream above the canvas size (flag stream-upscale)

- `node --test tests/stream-setup.test.mjs tests/studio-launch-d327.test.mjs tests/studio-ui-alpha.test.mjs
  tests/outputs/*.test.mjs`: 130 pass, 0 fail. The D378 test: flag off refuses 1440p from a 1080p canvas with the hint;
  flag on gives rungs 2560x1440 and 1440x2560 marked upscale, validator info UPSCALED, planner params carry
  `upscale: true`; summary line `1440x2560 @ 60fps 24,000 kbps · Portrait canvas`; unknown portrait size refused.
- Host: `node --test app/host/tests/host-api.test.mjs app/host/tests/host-defer-outputs.test.mjs`: 17 pass, 0 fail
  (upscale accepted with the canvas aspect ratio; non-boolean and 3840x1600 refused).
- 2K loopback load test: `node tools/soak/live-soak.mjs --short --config
  data/outputs/presets/youtube-1440p60-upscale.json` (new `--config` option): PASS, every check
  (`2026-11-13-live-soak-short-1954.{json,md}`). 3 min, four loopback streams + two recordings: 0 dropped, 0
  render-lagged, 0 encode-skipped frames, 0 timestamp gaps; NVENC load 77-82 %, GPU 16-22 %, CPU 14-22 %. YouTube H
  received about 23 Mbps (172 MB per 60 s segment). A 1-minute `--keep-media` rerun, ffprobe of what the listeners
  received: youtube-h 2560x1440, youtube-v 1440x2560, twitch and kick 1920x1080, all h264 (that run's only failed
  check: no clip save happens in 1 minute, the first is at 80 s).
- 4K portrait (2160x3840 at 35000 kbps) with 2K H and the re-encode: FAIL (`2026-11-13-live-soak-short-2000.*`).
  NVENC load 100 %, youtube-v delivered 8228 of about 11000 frames (about 45 fps), 1 render-lagged frame. Not usable on
  this laptop GPU; the preset is kept as the record (`youtube-1440p60-4kv-upscale.json`).
- No real stream before the user's "start stream test".
- Codex second opinion (codex exec, read-only, medium): one medium finding, fixed (a plan refused after the deferred
  load now falls back to the record plan with a warning, never an empty graph).

## D380: opening delay

- Before, host log 2026-11-13 17:59: host start 04.19, test-card outputs + NVENC probe + replay 06.62-07.70, ready
  07.70, `rpc project.load ... ok 3256.9ms` (replay detach 07.70-08.77, load 08.77-09.97, probe + configure + replay
  again 09.97-11.23). Window at about 11.5 s.
- Host `--defer-outputs` (alpha launcher): the boot plan and the replay buffer wait for the first project.load.
  Expected saving about 2.1 s. Test `app/host/tests/host-defer-outputs.test.mjs`: PASS (nothing built at the start,
  the first project.load builds the plan once).
- Launcher: the event core (measured phases: data folder rights 160-190 ms, audit database 350-490 ms, api.json
  100 ms, system pipe check 360-410 ms) now starts while the host config and plan are prepared, and stored server
  addresses are read at once. Timing with the fake host, `--mock`, same machine: host spawned at 2647 ms before,
  1382 ms after. Launcher tests (fake host): 165 pass, 0 fail.
- Taken out again (same day): full CI failed in `tests/stream-recovery.test.mjs` with `host config could not be
  written owner-only (ACL_FAILED)`. The event core protects the data folder with `icacls /reset /T` (in the service
  and again in the audit database) while the launcher wrote and protected `host-config.json` in the same folder. The
  launcher now waits for the event core again before any data-folder write. Kept: stored server addresses read at
  once, and the host `--defer-outputs`. After the fix: `tests/stream-recovery.test.mjs`, `tests/studio-ui-alpha.test.mjs`,
  `tests/studio-launch-d327.test.mjs`: 62 pass, 0 fail.
- Not changed: D3D and libobs module load (about 2.3 s of the host start) are libobs's own.
