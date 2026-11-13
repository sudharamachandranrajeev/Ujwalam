# Auto-post: scheduled uploads around the channel's schedule, from the clips folder (2026-11-13, D375)

Branch `post/auto-schedule`. Fakes only: no upload, no real channel read, nothing written to the installed data folder.
Decision: D375 in `docs/plan/2026-10-29-v1-decisions.md`.

## What changed

- **Always scheduled.** The chain never uploads without `status.publishAt` (private until that time, "Scheduled" in
  YouTube Studio). Flag `post-schedule` off: the clip waits (`schedule-off`) with no request to Google.
  `cli.mjs auto --run` no longer uploads.
- **Gap filling** (`services/posting/schedule.mjs`, `createSlotter`): earliest whole hour (UTC) >= now + 1 h + 15 min
  that is at least the gap from every taken time (channel scheduled posts, channel posts public in the last 2 days,
  every queue time, slots given earlier in the pass). D314 retries use the same rule; other queued clips keep their
  times. `placement: after-last` keeps the D310 rule. `minGapMinutes` retired.
- **Channel read lookback** (`schedule-read.mjs`): stops at the first page whose uploads were all added more than 120
  days ago; fails closed on a read error or the 40-page cap.
- **Clips folder source** (`clips-source.mjs`): `<clips folder>/<YYYY-MM-DD>/` videos with clip names, oldest first;
  unpackaged files are packaged. Unscored shorts pass a rule whose minScore is not above the ranker floor (3).
- **Quota** (`data/posting/quota.json`): about 6 uploads a day fit (10000 - 100) / 1650; the global
  `maxUploadsPerDay` caps uploads across rules. Steps to ask Google for more:
  `docs/plan/2026-11-12-growth-setup-notes.md`.
- **Delete after posting** (`delete-uploaded.mjs`, flag `post-delete-uploaded`, off, "Delete posted clips forever"):
  permanent delete only after `uploadStatus: processed` with every record matching; log
  `<data>/posting/deleted.jsonl`; one task bar line per batch.
- **Settings card** (Qt `app/studio/src/autopost_card.{h,cpp}`) and routes `GET/POST /ui/api/posts/auto/settings`,
  `GET /ui/api/posts/auto/schedule[?fresh=1]`, `POST /ui/api/posts/auto/queue/move|remove`
  (`services/posting/auto-settings.mjs`).

## Slot examples (asserted in `tests/posting-schedule.test.mjs`)

ASSUMED 27-post channel schedule, now 2026-11-13 10:00 UTC, first 10 new slots:

| Gap | First 10 slots (UTC) |
|---|---|
| 1 h | 13 Nov 12:00, 13:00, 14:00, 15:00, 16:00, 17:00, 19:00, 20:00, 21:00, 22:00 |
| 6 h | 13 Nov 12:00; 15 Nov 06:00, 12:00, 18:00; 16 Nov 06:00, 12:00, 18:00; 17 Nov 06:00, 12:00, 18:00 |

Hourly for 2 months: about 1440 slots, all on the hour, none within 1 h of another or of the channel, under 2 s.

## Tests

```
node --test tests/posting*.test.mjs tests/studio-ui-posting*.test.mjs tests/flags.test.mjs tests/learning-mix.test.mjs \
  tests/data-reload.test.mjs tests/guide.test.mjs tests/package-alpha.test.mjs tests/studio-ui-flags-feedback.test.mjs \
  tests/studio-ui-growth.test.mjs tests/studio-qt-autopost.test.mjs
ℹ tests 334   ℹ pass 332   ℹ fail 0   ℹ skipped 2
```

(The 2 skipped: the Auto-post screenshot test without `AUTOPOST_SHOT_DIR`, and one existing skip in
`package-alpha.test.mjs`.)

New or rewritten files:

- `tests/posting-schedule.test.mjs` (28): schedule math, gap filling, the 27-post example, 1440 hourly slots, DST,
  retries, after-last, cap, preview estimates.
- `tests/posting-auto-d375.test.mjs` (21): lookback with 2500 uploads (stops after 11 pages, not truncated), clips
  folder scan, oldest first, global daily cap, unscored shorts, card defaults and save (checked, nothing written on a
  problem), move and remove, every delete refusal (flag off, failed, rejected, still processing, not found, read
  error, ledger or publish time mismatch, sha256 mismatch, outside the folder, `..` path, folder, junction leading out).
- `tests/posting-e2e.test.mjs` (34, local fake YouTube): every upload scheduled; flag off waits; D314 retries take
  the next free time; delete flag on deletes only after `processed` (log line, one task file, never checked again);
  a changed file or failed upload is kept.
- `tests/studio-ui-posting-auto.test.mjs` (7): routes need the session; POST needs CSRF and same Origin; exact params;
  bad values give `400 invalid` with the problems and write nothing; save writes both files with no temp file left;
  fresh channel read throttled to once per 10 min; missing readonly scope is a plain error; move/remove 404/409/200.
- `tests/studio-qt-autopost.test.mjs` (5, headless Qt): defaults, quota fit, next times saying Scheduled, flags-off
  text, no card with posting off, dirty and blocked Save with no kind, Save writes the user files.

Settings regressions in the Qt shell: `node --test --test-name-pattern="[Ss]ettings" tests/studio-qt-shell.test.mjs`
-> 19 pass, 0 fail (the whole file, 73 tests, was not run: it takes longer than 10 minutes).

Lint: `npm run lint` -> `lint: 0 finding(s)`.
Build: `npm run build:studio` (BelowNormal priority) -> built.

Screenshot (not committed): `settings-shot` of Settings > Posting & growth, saved outside the repo in the session
scratchpad as `autopost-card.png`.

## UNVERIFIED

- That videos.insert now has its own 100-a-day bucket for this project (Google's page says so; `insertUnits` stays
  1600 until the user checks Cloud Console).
- That the uploads list is ordered newest first by `snippet.publishedAt` (the lookback stop relies on it).
- The Cloud Console menu names in the quota-increase steps.
- No real upload or channel read was made; the main session does the real enablement.
