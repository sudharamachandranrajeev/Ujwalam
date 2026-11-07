# 2026-11-07 — kill montages, game-area detect, preview live-lock, parent pipe

Decisions D233–D236 (`docs/plan/2026-10-29-v1-decisions.md`). Branch `claude/alpha0-d1`.

## D236 kill montages (`clipper.py montage`)

User request 2026-11-07: clips of 20–60 s that keep only the useful parts; join clips into one; research the best
Shorts length. User choices: 30–45 s target, 3 s before / 1.5 s after each kill, hard cut with an audio fade, clips
from different matches may be joined.

Unit tests: `python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_montage.py"` → 9/9 OK
(streak-only rule, dead time cut, close kills merged, death cut, 20 s floor, 20–60 s bounds, medal without a feed
line, ffmpeg concat graph with 80 ms fades).

Runtime, 2026-11-07 practice (16 min H + V recordings, game-area hits from D235):
`clipper.py montage --recording <practice-h> --out <dir>` → 2 qualifying streaks ("On a 5 killstreak" at 674 s and
908 s), 9 own kills in them; pieces 666.0–683.5 s and 901.0–923.5 s (the dead time between them cut) → one montage
M01, 40.0 s, score 10, 1080x1920 h264 60 fps + aac. `validate --out <dir>/montage` → 1/1 PASS. The other 23 own
kills of the session are single kills or Double Kills, not streaks, so they stay out (user rule "streaks only").
Output in the local clips folder (`_data/Ujwalam/clips/2026-11-07-practice-game/montage`, not committed).

## D235 detect on the game area only

The 2026-11-07 practice H recording (1920x1080 canvas, game layer at x 468, y 31, 1418x978, crop 177 px left and
right) was first scanned full frame: 61 M5 "own kill" hits on a 60 s cycle (43, 56, 69, 103, 116, 130 s, ...). A
frame at 45 s shows the warm-up lobby, no kill feed; the M5 ROI (game y 0.84–0.96, which on the full frame reaches
y 1037) took in the scrolling bottom ticker, which shows the streamer's name. The live clipper reads the game layer
itself and was not affected.

`project_layout` on the real project: game [307.71, 31.18, 1738.3, 977.84], visible [467.96, 31.18, 1885.76,
1009.02] (1920x1080); the ticker band (y ≥ 1009) is outside. Unit tests `ProjectLayoutTests` (3) in
`tests/py/test_clip_detector_pass.py`: OK.

Re-run with `--project` (GPU OCR, 452 s for 16 min): 251 hits, 71 with signal; M5 own kills 61 → 32, no 60 s
cycle left (first own kill at 127 s, after the warm-up lobby); X1 killstreak cards 1 → 2.

## D233 preview editing: browser skip and live-lock

- UI server (`tests/studio-ui-preview-edit.test.mjs`, 4/4): host editing switched off while `host.status.live`,
  back on after; `layers.setPlacement` while live returns `confirm` with "yes, on air", plain "yes" is refused, the
  confirmed edit is applied and autosaved; `layers.setVisible` stays instant; instant again when nothing is live.
- Host (`app/host/tests/host-browser.test.mjs`, new case): a click on a full-canvas browser layer selects the colour
  layer below it. Host suites `host-preview-edit` + `host-browser`: 13/13 pass after the build.
- Host `Backend.locked` (no press while a stream output is live): UNVERIFIED at runtime (needs a live loopback stream
  in a host test); covered by the UI server switching editing off.

## D234 parent pipe

- `tests/parent-pipe.test.mjs` 3/3: no marker → nothing watched; pipe end → onGone once; a real child process exits
  when its stdin pipe is destroyed (no signal sent).
- `tests/py/test_live_worker.py` `ParentPipeTests` 2/2.
- Host `app/host/tests/host-parent-pipe.test.mjs` 2/2: with the marker, destroying stdin gives a clean exit 0,
  log `shutdown (launcher gone)`, discovery file removed; without the marker the pipe is ignored. The "kept
  running while a stream or recording runs" branch is UNVERIFIED at runtime (needs a live output in a host test).

## Files

New: `services/clip/clip_montage.py`, `data/clip/montage.json`, `tests/py/test_clip_montage.py`,
`services/common/parent-pipe.mjs`, `tests/parent-pipe.test.mjs`, `app/host/tests/host-parent-pipe.test.mjs`, this file.
Changed: `services/clip/{clipper,detector_pass,live_worker}.py`, `data/clip/live-clips.json` (preSec 17),
`tests/py/test_clip_detector_pass.py`, `tests/py/test_live_worker.py`,
`app/host/src/{main.cpp,studio.cpp,preview_edit.h,preview_edit.cpp}`, `app/host/lib/launch.mjs`,
`app/host/tests/host-browser.test.mjs`, `app/studio/src/main_window.cpp`,
`services/studio-ui/{server,launch,cli}.mjs`, `services/event-core/cli.mjs`, `ui/js/app.js`,
`tests/studio-ui-preview-edit.test.mjs`, `tools/package/manifest.mjs`, `docs/plan/2026-10-29-v1-decisions.md`,
`docs/plan/2026-11-03-handover.md`.
