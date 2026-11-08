# 2026-11-08 Qt shell feature-flags panel (D264)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user switches a flag in the studio
window.

## Build
`node app/studio/tools/build.mjs`: `[5/5] Linking CXX executable ujwalam-studio.exe`.

## Behaviour (server side already tested)
The panel uses only existing routes: `GET /ui/api/flags`, `POST /ui/api/flags/set`, `POST /ui/api/confirm` and
`POST /ui/api/cancel`, covered by the UI server flag suites (on needs the typed phrase, off is instant, live needs
"yes, on air"). The shell keeps no flag state of its own: each status poll (2 s) reloads the list and sets the boxes
with signals blocked, so a cancelled confirm or a change made in the browser page shows within one poll and a refresh
never sends a change.

## To check by hand
1. Tick `effect-editor`: a Confirm box asks for `yes`; type it, the row stays ticked and the Effects panel appears.
2. Untick it: no question, the note says `Flag effect-editor off.`, the Effects panel goes.
3. Tick one and press Cancel: the tick goes away within 2 s.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D264), this file
