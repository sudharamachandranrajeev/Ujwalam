# 2026-11-08 Qt shell feedback notes (D267)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user opens "Feedback notes" in
the studio window and saves a note.

## Build
`node app/studio/tools/build.mjs`: `built ...\ujwalam-studio.exe`, no errors or warnings.

## Behaviour (server side already tested)
A "Feedback notes" button in the top bar opens a window listing the feedback moments (`GET /ui/api/feedback`, the
moments the feedback hotkey captured). Picking one shows its time, scene and stats and its note; Save sends
`POST /ui/api/feedback/note` with id, text, tag (bug, annoying, wish, works-well) and severity (high, medium, low),
the same route and checks as the browser page's form (D150; covered by its feedback suites). Notes stay in the
gitignored `feedback/` folder. The window opens only when the user presses the button; a reply after it is closed is
dropped.

## To check by hand
1. Press the feedback hotkey once during a test recording, then "Feedback notes": the moment is listed.
2. Pick it, write a note, tag `bug`, severity `low`, Save: the row shows `bug/low`, the window says `Saved.`

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D267), this file
