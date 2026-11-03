# BM7: bot clash check (2026-11-03)

## What was built
- `tools/bot-clash-check.mjs` (CLI + exported functions). Read-only: writes only to stdout. `--json` for JSON. Exit 0 no clash, 1 clash, 2 a check could not run (1 wins).
- Ports: the bot port map from `docs/plan/2026-11-03-bot-manager-plan.md` (8083, 8093, 4242/UDP, 7474, 9652, 8059, 8001, 42069) against live listeners (`Get-NetTCPConnection -State Listen`, `Get-NetUDPEndpoint`, PowerShell run by absolute path via `systemTool`, `windowsHide: true`, 30 s timeout). Owner = process name only (no command line is read or printed); expected owner matched by name (`Streamer.bot`, `Speaker.bot`). A bot port held by any other process (including node or the host) is a clash; an unreadable owner also counts as a clash (not proven to be the bot). Free = bot not running, not a clash.
- Static check: scans Ujwalam code (`services`, `app/host/{lib,overlay,src}`, `tools`; tests, mocks and fixtures skipped) for a bot port used on a line about ports or binding, ignoring clients (`ws://`), refusals and comments. Result on this repo: 166 files, 0 hits. Ujwalam's own servers (control page, event-core API, overlay static and feed, host API) all default to port 0 (random); the overlay child and host refuse 8093 already.
- Hotkeys: Ujwalam's combos are read from `app/host/src/host_config.h` (host defaults: panic `Ctrl+Alt+P`, feedback `Ctrl+Alt+F`, marker `Ctrl+Alt+Shift+M`); not duplicated. Streamer.bot's: read from `<streamerbot_exe folder>/data/hotkeys.json` (or `hotkeys.json`) ONLY if `paths.streamerbot_exe` is set and the file parses; only string values under keys named hotkey/keys/key/combo/shortcut are taken as combos, nothing else is read. Otherwise "manual check" with the steps.
- Audio device and duplicate alerts: manual items in `docs/tests/2026-11-04-A0-S1-bot-clash-checklist.md`.

## Tests (headless, `UJWALAM_HEADLESS=1`, no network, no window)
- `node --test tests/bot-clash-check.test.mjs`: 11 passed, 0 failed. Fake listener lists (free, ok, wrong owner, Ujwalam owner, unknown owner, wrong protocol), static-scan line classification, real-repo scan (0 hits), combo normalising, fake Streamer.bot hotkey file (read, missing, unparseable, unset path), hotkey clashes, exit codes 0/1/2 and 1-wins, text output.
- `node tools/lint.mjs`: 0 findings.

## Run on the laptop (read-only, one run, 2026-11-03)
`node tools/bot-clash-check.mjs`, exit 0:
- 8083/tcp Speaker.bot: ok (owner Speaker.bot). 8093/tcp Streamer.bot: ok (owner Streamer.bot).
- 4242/udp, 7474, 9652, 8059, 8001, 42069: free.
- Ujwalam code scan: 0 bot-port hits.
- Hotkeys: Ujwalam panic/feedback/marker as above; Streamer.bot "not checked (paths.streamerbot_exe not set)" -> manual check.

## UNVERIFIED
- Where Streamer.bot keeps hotkeys and the file's format (`hotkeys.json` is a guess); until confirmed the hotkey check is manual on this laptop.
- Streamer.bot's process name as seen by the OS (`Streamer.bot` assumed from the run: it matched).
- Listener owners of a process running elevated may be unreadable from a normal shell (shown as clash "unknown").
- Audio device and duplicate alerts: not machine-checked.

## Files
Created: `tools/bot-clash-check.mjs`, `tests/bot-clash-check.test.mjs`, `docs/tests/2026-11-04-A0-S1-bot-clash-checklist.md`, this file.
Changed: none.
