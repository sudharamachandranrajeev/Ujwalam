# Bot manager: Streamer.bot and Speaker.bot run with Ujwalam

Status: PLAN (user, 2026-11-03: "plan the Streamer.bot and Speaker.bot manager, add it to the appropriate phase").
Flag `bot-manager`, off by default, switchable from the control page while live.

## Goal

One start and one stop for the whole studio. Ujwalam finds the installed Streamer.bot and Speaker.bot, starts them hidden
when they are not running, shows their health on the control page, and closes the ones it started when the studio stops
or on "wind up". It also covers the test-stream needs in AGENTS.md (D192): the "this is a test" announcement on screen and
read aloud, and the viewers' feedback collected into `feedback/YYYY-MM-DD-stream-feedback.md`.

## Not bundled (D193)

Streamer.bot and Speaker.bot are closed-source freeware from another developer. Their files are not put inside the
Ujwalam zip: the licence terms for redistribution are not checked (UNVERIFIED), and a bundled copy would go stale when
they update. Ujwalam manages the copies the user installs. Install hints on the control page link to the official
download pages only.

## What exists today

- Read-only Streamer.bot WebSocket connector (`services/event-core/streamerbot/`): events in, never sends (P3 rule).
- Overlay feed bridge that never binds the real Streamer.bot port (`app/host/overlay/child.mjs`, 8093).
- Installed on the laptop (paths go in `data/profile.local.json`, never committed): Streamer.bot 0.2.8, Speaker.bot 0.1.5.
  Neither was running at 2026-11-03 16:10.

## Steps

| Step | What | Phase | Done when |
|---|---|---|---|
| BM1 | `services/bots/`: profile keys `paths.streamerbot_exe`, `paths.speakerbot_exe` (template placeholders); detect running (process path match), start minimised without focus (`windowsHide`, no activation), stop only what Ujwalam started (graceful close, then a tree kill after 10 s), never touch a copy the user started; health: process up, WebSocket port answering (Streamer.bot: the connector's port; Speaker.bot: its WebSocket server port, default UNVERIFIED, read from its settings or set in the profile) | Alpha 0, before A0-S1 (5 Nov) | unit tests with fake executables; runtime evidence on the laptop: start, health, stop |
| BM2 | Control page: a "Bots" card (Streamer.bot / Speaker.bot: running, connected, started by Ujwalam yes/no; Start / Stop buttons, studio-write confirm, "yes, on air" while live) | Alpha 0, before A0-S1 | UI test with the fake backend; screenshot evidence |
| BM3 | Test-stream announcement: a text layer preset "Test broadcast" (tokens, entrance < 600 ms, exit < 400 ms) on H and V, safe area checked on V; shown at stream start and every 15 min | Alpha 0, before A0-S1 | preset + manifest + registry entry; H/V frame captures |
| BM4 | Chat question and spoken announcement: done in Streamer.bot by the user (Ujwalam stays read-only, D192). Written steps: one action group "Ujwalam test stream" with a timed action every 15 min: send the question to Twitch, YouTube and Kick chat, and a Speaker.bot "speak" sub-action with the announcement. Ujwalam's runbook tells the user to enable the timer at "start stream test" and disable it at "stop" | Alpha 0, before A0-S1 | the user confirms the action fires on a private test |
| BM5 | Feedback collection: during a test stream, chat messages that answer the question (sent within 10 min after it, or starting with a marker the question asks for, e.g. "fb:") are copied from event-core's chat store into `feedback/YYYY-MM-DD-stream-feedback.md` (gitignored; viewer names stay in that local file only); counted per platform | Alpha 0, before A0-S1 | test with recorded mock chat; no real chat in tests |
| BM6 | "wind up" and studio stop close the bots Ujwalam started; the stray check lists Streamer.bot and Speaker.bot too | Alpha 0 | test with fake executables |
| BM7 | Clash checks: ports (8080/8093, Speaker.bot port, overlay ports), global hotkeys (Ujwalam's Ctrl+Alt+P/F/Shift+M against Streamer.bot hotkeys), audio device (Speaker.bot output not captured twice by the mixer), duplicate alerts (Streamer.bot alert + Ujwalam alert for one event) | Alpha 0 check list for A0-S1; fixes in v1 | check list filled on the private test |
| BM8 | Later: Ujwalam triggers named Streamer.bot actions (DoAction) for overlay effects only, never chat sends; needs a security review of a write path into Streamer.bot | P15 (remote control and plugins), not v1 | ADR + security review |

## Rules kept

- Never go live without "start stream test" and "yes, on air" (D192).
- Stream keys stay in Credential Manager; bot settings are never read for keys or tokens.
- Ujwalam's Streamer.bot connection stays read-only; nothing is sent to any platform by Ujwalam.
- No installs: if a bot is missing, the card says where to get it; the user installs it.
- No window takes focus (D191).

## Needs from the user (defaults)

1. Speaker.bot WebSocket server port and whether it is enabled: default, I read it from its settings file, read-only.
2. Announcement text: default "Test broadcast: we are trying new streaming software. Tell us in chat how the video, sound and scenes look."
3. Question interval: default 15 min.
