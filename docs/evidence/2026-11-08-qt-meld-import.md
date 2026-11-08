# 2026-11-08 Qt shell Meld import (D268)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user runs "Import Meld session"
in the studio window.

## Build
`node app/studio/tools/build.mjs`: `built ...\ujwalam-studio.exe`, no errors or warnings.

## Behaviour (server side already tested)
The browser page's flow, same routes: `POST /ui/api/project/import-meld` writes a new project file from the configured
Meld session (the current project file is never changed) and asks the host for a plan (counts only). The window lists
the imported, skipped and plan counts. If the plan has unavailable items, a "Skip the items the host cannot show"
box appears. "Load into the studio" sends `POST /ui/api/project/load` (`skipUnavailable` only when that box is
ticked), which always answers with the typed confirm (`yes`, `yes, on air` while live) before `project.load` replaces
the scenes. No session configured: the window says to set `UJWALAM_MELD_SESSION` or `paths.meld_session`.

## To check by hand (not live)
1. "Import Meld session": the window names the new project file and lists the counts.
2. "Load into the studio", type `yes`: the scene list shows the imported scenes.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D268), this file
