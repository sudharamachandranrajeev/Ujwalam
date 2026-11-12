# AN1b Growth window in the studio - evidence (2026-11-12)

Plan: `docs/plan/2026-11-11-growth-content-instagram-plan.md` (AN1), decision D372. Builds on AN1a
(`docs/evidence/2026-11-12-an1a-growth-youtube-data.md`).

Status: **built behind flag `growth` (off by default); tested with a seeded store and a faked Google.** Not run against
the real channel (UNVERIFIED until the user's Google setup in `docs/plan/2026-11-12-growth-setup-notes.md` and a real
fetch). Instagram is not part of this step.

## What was built

- `services/analytics/index.mjs`: `view(store, now)` - per video the trimmed numbers (latest, 24 h, 7 d), the last
  fetch time and when a non-forced fetch is allowed again. No raw snapshots leave the server.
- `services/studio-ui/server.mjs` (owns `<data>/analytics/analytics.db`, session cookie + CSRF like its neighbours):
  - `GET /ui/api/growth` -> `{ videos, lastFetchAt, nextAllowedAt, minIntervalMin, signedIn, hasClient, busy }`.
  - `POST /ui/api/growth/refresh` `{ force? }` -> AN1a `collect`; skipped within the hour unless forced; one run at a
    time (409 `refresh-in-progress`); 401 `analytics-scope-missing` / `youtube-not-signed-in` / `youtube-no-client`;
    502 `growth-failed`. Both routes: 404 `growth-off` with the flag off. Test seam `opts.growth = { auth, fetchImpl }`.
- `app/studio/src/main_window.cpp`: `MainWindow::openGrowth()`, "Growth numbers..." in the More menu (visible only with
  the flag on), sortable table (Video, Kind, Public since, Views, Likes, Avg viewed %, Shares, Subs gained, After 24
  hours, After 7 days), "Last read" line with the next allowed time, Refresh and "Refresh now" (shown after a skipped
  refresh), plain notes for flag off, not signed in, missing permission and no posted videos. Probe hooks:
  `growth-open`, `growth-refresh`, `growth-shot:<name>`.

## Commands and results

    node --test tests/studio-ui-growth.test.mjs tests/analytics.test.mjs
    ... tests 19, pass 19, fail 0   (7 new API tests + 12 AN1a tests)

    node app/studio/tools/build.mjs          (BelowNormal; built ujwalam-studio.exe)
    GROWTH_SHOT_DIR=<scratchpad>/growth node --test tests/studio-qt-growth.test.mjs
    ... tests 5, pass 5, fail 0   (headless, UJWALAM_HEADLESS=1, temp data dir, fake Google)

API tests: flag off (404, no fetch), session needed, trimmed numbers + 24 h checkpoint + last fetch + next allowed
time, not signed in, CSRF and body checks, skipped within the hour with no Google call then forced run, missing scope.
Qt tests: flag off (no menu entry, "switched off" note), flag on (menu entry, 2 rows with checkpoints and dashes for
missing statistics, Refresh skipped note, zero Google calls), not signed in (note, Refresh disabled), empty state.

Picture (placeholder titles, not committed): `growth-window.png` in the session scratchpad `growth\` folder.

## Not covered / UNVERIFIED

- A real Google fetch and the real numbers shape (UNVERIFIED until the user's setup).
- The window on a shown display (tests are offscreen); no charts; Instagram insights (later step).
- No full CI and no GPU tests were run (the installed app was running); the coordinator runs the full CI.
