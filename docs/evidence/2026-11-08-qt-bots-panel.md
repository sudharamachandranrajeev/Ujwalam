# 2026-11-08 Qt shell bots panel (D266)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user starts or stops a bot from
the studio window.

## Build
`node app/studio/tools/build.mjs`: `built ...\ujwalam-studio.exe`, no errors or warnings.

## Behaviour (server side already tested)
Routes used, the browser page's and covered by its bot-manager suites: `GET /ui/api/bots`, `POST /ui/api/bots/start`,
`POST /ui/api/bots/stop`, then the shared typed confirm (`yes`, `yes, on air` while live). The box shows only while
flag `bot-manager` is on; the server answers 404 `bot-manager-off` otherwise. Each bot row shows the same facts as
the page (installed, running, port answering, started by Ujwalam, check or port-setting errors). Start is enabled
only for an installed bot that is not running; Stop only for a copy Ujwalam started, and the server checks that again.
A forced close (bot ignored the close request) is reported in the status note. The status is read every fifth poll
(10 s) because it lists processes, and again after each confirmed action.

## To check by hand (not live)
1. Flags panel: tick `bot-manager` (type `yes`). The Bots box lists Streamer.bot and Speaker.bot within 10 s.
2. Start one (type `yes`): within 10 s it reads `up`. Stop it (type `yes`): it reads `stopped`.
3. Start a bot yourself outside Ujwalam: its Stop button stays disabled.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D266), this file
