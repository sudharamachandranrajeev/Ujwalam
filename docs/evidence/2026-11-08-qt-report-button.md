# 2026-11-08 Qt shell report button (D269)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user presses "Report a problem"
in the studio window.

## Build
`node app/studio/tools/build.mjs`: `built ...\ujwalam-studio.exe`, no errors or warnings.

## Behaviour (server side already tested)
Shown only while flag `report-button` is on (the server answers 404 `report-button-off` otherwise). The button asks
for a title and a description, capped at the report limits (120 and 1500 characters, `services/studio-ui/report.mjs`),
and calls `GET /ui/api/report-url`, the browser page's route (D199; covered by its report suites). The server builds
and redacts the link. The shell opens it only if it is an `https://github.com/` link, in the user's default browser
(`QDesktopServices::openUrl`), where the user reviews it before submitting. Nothing is posted from the app. Not
configured: the note says to set `links.issues_url` in the profile.

## To check by hand
1. Flags panel: tick `report-button` (type `yes`). "Report a problem" appears in the top bar.
2. Press it, type a title and a line: the browser opens a prefilled new-issue page. Close it without submitting.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D269), this file
