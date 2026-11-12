# AN1a Growth data, YouTube — evidence (2026-11-12)

Plan: `docs/plan/2026-11-11-growth-content-instagram-plan.md` (AN1), decision D371. Setup notes:
`docs/plan/2026-11-12-growth-setup-notes.md`.

Status: **built behind flag `growth` (off by default); tested with a faked Google only.** Not run against the real
channel: that needs the user's steps (enable the YouTube Analytics API, add the read-only scope, sign in again). A
mock is not a feature: AN1a is done when one real fetch has stored the numbers of the user's posted videos.

## What was built

- `services/posting/oauth.mjs`: `ANALYTICS_SCOPE` (`yt-analytics.readonly`), `joinScopes`; `opts.scope` may be a
  function read at each sign-in.
- Sign-in asks for the statistics permission only with the flag on: `services/posting/cli.mjs youtube signin`
  (upload + youtube.readonly + yt-analytics.readonly; says so when Google did not grant it) and Settings > Connections
  (`services/platform-connect`, `youtube` + yt-analytics.readonly, so that sign-in does not drop it).
- `services/analytics/youtube.mjs`: `readVideos` (Data API videos.list part=status,statistics,snippet; keeps privacy,
  publish times and counts only) and `readAnalytics` (Analytics API v2 reports, ids=channel==MINE, dimensions=video:
  views, minutes watched, average view duration, average viewed %, likes, shares, comments, subscribers gained);
  batches of 50; a missing permission (401/403) is told apart from other errors.
- `services/analytics/index.mjs`: local SQLite `<data>/analytics/analytics.db` (tables `videos`, `snapshots`);
  `collect` (fails closed without both read scopes; the videos are the post store's uploaded entries; the public time
  is the scheduled publish time once past, else the Data API publishedAt — UNVERIFIED for a private upload made public
  by hand; one snapshot per video with its age in hours; analytics only for public videos; a second run within 60 min is
  skipped unless forced; nothing posted, no call at all); `summary` (latest, the first snapshot at 24 h and at 7 d).
- `services/analytics/cli.mjs`: `fetch [--force]`, `show [--json]`; flag off refuses (exit 3).
- `data/flags.json`: `growth`, default false.

## Tests

| Command | Result |
|---|---|
| `node --test tests/analytics.test.mjs` | 12 pass: readers (fields kept, bad ids never sent, Bearer token, batches of 50, columns by name, bad date range, 403 vs 500 vs network); collect fails closed for every missing-scope combination; snapshots with ages, private video counts only and no analytics read, the 1 h guard, 24 h and 7 d checkpoints; a video made private again gets no analytics read (Codex review finding, fixed); a scheduled video is public from its publish time; nothing posted means no call; postedVideos keeps only uploaded entries with a video id; joinScopes; the scope function is read at sign-in; CLI flag off, scope-missing hint, empty show |
| `node --test tests/posting-*.test.mjs tests/platform-connect*.test.mjs tests/flags.test.mjs tests/live-updates.test.mjs tests/studio-ui-flags-feedback.test.mjs` | 246 pass, 0 fail |
| `UJWALAM_HEADLESS=1 node --test tests/studio-ui-connect*.test.mjs tests/studio-qt-connect-button.test.mjs tests/analytics.test.mjs` | 32 pass, 0 fail (before the Codex fix; analytics re-run after it: 12 pass) |
| `npm run lint` | 0 findings |

## Open

- The user's setup steps, then one real `fetch` and `show` (evidence to add then; video ids are not secret but stay out
  of committed files anyway).
- AN1b: the Growth window (Qt, menu bar) showing these numbers; a background fetch (after a stream, never while live).
- Instagram insights (Meta app) when the user asks for it.
