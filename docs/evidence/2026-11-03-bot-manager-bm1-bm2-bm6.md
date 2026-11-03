# BM1, BM2, BM6: bot manager, Bots card, stop on studio stop (2026-11-03)

## What was built
- `services/bots/index.mjs` (BM1): finds the user's installed Streamer.bot and Speaker.bot from `paths.streamerbot_exe` / `paths.speakerbot_exe` in the gitignored local profile, starts them hidden (`windowsHide: true`, detached), reports health, stops only a copy Ujwalam started.
  - "Started by Ujwalam" = pid + process creation time (from the OS, not our clock) in `<dataDir>/bots/state.json`; a reused pid never matches. Identity is checked again before a hard kill.
  - Health is a bare TCP connect to the loopback port and close; no WebSocket frame is sent (D192 read-only). Addresses other than `ws://127.0.0.1:<port>/` are refused.
  - A failed process list is an error ("Check failed"), never "not running".
- Control page Bots card (BM2), shown only with the `bot-manager` flag on (default off). Start and Stop are typed-confirmation writes: "yes", or "yes, on air" while live (a pending "yes" is upgraded if the stream goes live meanwhile). API: `GET /ui/api/bots`, `POST /ui/api/bots/start|stop`, behind the existing POST, CSRF and origin checks; 404 when the flag is off.
- Studio stop (BM6): with the flag on, `launch.mjs` closes the bots Ujwalam started. `tools/stray-procs.mjs` lists started bots still running as a report only; the stray-mocks CI step and its exit code are unchanged.
- Decision D194 (choices 1–7).

## Tests (headless, `UJWALAM_HEADLESS=1`)
- `node --test tests/bots.test.mjs tests/studio-ui-bots.test.mjs`: 26 passed, 0 failed, 8 suites (about 18 s). Suites: configuration; health (plain TCP connect, nothing sent); start and stop; stray report (report only); real process query (Windows CIM); flag gate; Bots API with fake bots (validation, CSRF, origin, phrase upgrade while live, flag switched off between request and confirmation, failing check = 502); Bots API over the real bot manager (a copied node executable stands in for a bot; started, then stopped).
- `node tools/lint.mjs`: 0 findings.
- No real Streamer.bot or Speaker.bot was started.

## UNVERIFIED (needs the laptop, with the user's yes)
- What `windowsHide` (SW_HIDE) does to each bot's main window, and whether either bot takes focus at start.
- A bot running elevated (as administrator) reports no executable path to a normal process, so it would show "not running" and Start could open a second copy.
- A bot that relaunches itself under a new pid (single-instance handoff) would report `exited-early`.
- Ports 8093 / 8083 answering on the real bots.

## Files
Created: `services/bots/index.mjs`, `tests/bots.test.mjs`, `tests/studio-ui-bots.test.mjs`, this file.
Changed: `data/flags.json`, `data/profile.example.json`, `data/profile.schema.json`, `docs/plan/2026-10-29-v1-decisions.md` (D194), `services/studio-ui/backends.mjs`, `services/studio-ui/cli.mjs`, `services/studio-ui/launch.mjs`, `services/studio-ui/server.mjs`, `tools/package/manifest.mjs`, `tools/stray-procs.mjs`, `ui/index.html`, `ui/js/api.js`, `ui/js/app.js`.
