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

## Codex review of f253771 (2026-11-13): fixes

1. **Delete race (P1).** `delete-uploaded.mjs`: the file is opened once; sha256, device, file id (`ino`), size and
   `mtimeNs` all come from that handle (size and time read again after the hash: a write meanwhile keeps the file).
   Right before `unlink`: `lstat` of the path must give the same device, file id, size and time and not a link; the
   parent folder's real path is resolved again and must still be inside the clips folder's real path, with the same
   relative path as the lexical one (lower-case compare on Windows). UNC, `\\?\` and `\\.\` forms (and `//x`) are
   refused before anything is read. Any mismatch keeps the file and records the reason on the queue item
   (`deleteReason`); `file-changed` is checked again from the start on a later pass.
   **Residual race:** Node has no delete-by-handle (no `FILE_DISPOSITION_INFO` on an open handle), so between the last
   `lstat`/`realpath` and `unlink` (microseconds, same tick) another program that can write the clips folder could
   still swap the file or a parent folder. The window is now a few system calls wide instead of the whole hash, and the
   user's own clips folder is the only thing such a program could reach.
2. **Queued slots re-checked (P1).** `schedule.mjs` `planQueueSlots`: a queued item with a slot and no session keeps
   it only while it is at least the current gap from every channel time and every earlier kept time; otherwise it gets
   a new slot by the same rule (`reval: true`). `auto-chain.mjs`: a due item with such a slot triggers a fresh channel
   read before its upload starts; a failed read keeps it waiting with its slot (never uploaded unchecked).
3. **Lookback cutoff page (P1).** `schedule-read.mjs`: the page whose items are all older than the lookback is still
   status-checked (`videos.list`) before the scan stops. Residual risk unchanged: a post uploaded before the lookback on
   a later page and scheduled ahead is not seen (relies on the uploads list being newest first, UNVERIFIED).
4. **Daily upload budget (P1).** `quota-budget.mjs`, `<data>/posting/quota-day.json`: every upload start or resume
   counts (`uploads`, UTC day) and is checked against the rules' `maxUploadsPerDay` before it starts; earlier approvals
   and retries can no longer exceed it. A budget that is used up stops the pass before any channel read.
5. **One in-flight card read (P2).** `server.mjs`: the fresh-read promise is stored before it is awaited; requests
   that arrive meanwhile share it.
6. **Quota fit 0 and read units (P2).** `loadQuota` (now in `quota-budget.mjs`) allows 0; the Qt card says "No upload
   fits in a quota of N units a day (one upload needs M): nothing uploads until the quota is raised." Every Data API
   read (chain schedule reads, delete status checks, the card's fresh read) counts 1 unit in `units` (Pacific day,
   when Google resets the quota) next to the upload units; a read that may not fit (1 + 2 x maxPages) is not made.
   Fail closed: an unreadable counter or quota file blocks uploads and reads. Two processes counting may lose one
   count in a race (each write re-reads first; atomic rename), never corrupt the file.

Tests for each: `tests/posting-auto-d375.test.mjs` (file swapped / written / folder swapped for a junction between hash
and unlink, UNC forms, slot re-check unit cases, budget counters, day roll-over, fail closed, metered fetch, fit 0),
`tests/posting-e2e.test.mjs` (new channel post clashes with a waiting slot; gap grew; budget stops uploads from earlier
approvals, then the next UTC and Pacific days), `tests/studio-ui-posting-auto.test.mjs` (three concurrent fresh reads,
one channel read, 3 units counted), `tests/studio-qt-autopost.test.mjs` (fit 0 text).

## Codex re-review of 3c8fd62 (2026-11-13): fixes

1. **Delete through a holding folder (P1).** After the checks above, the clip is no longer unlinked at its own path.
   It is moved by one atomic `rename` (same volume) under a random name into `<clips folder>/.ujwalam-deleting/`
   (made if missing; refused when it is a link or junction or resolves elsewhere: `hold-unsafe`). There it is checked
   again through its own handle: a regular file with the same device, file id, size, modified time and sha256. Only
   then is it unlinked. On any mismatch it is moved back to its path when that path is still free (`file-changed`,
   checked again later); if the path was taken meanwhile it stays in the holding folder (`held-in-holding-folder`,
   final: never overwritten, never deleted). The clips scan reads only `YYYY-MM-DD` folders, so it never sees the
   holding folder. No stronger stdlib way exists: Node has no delete-by-handle and no `renameat`/`O_TMPFILE`.
   **What remains:** a program that can write the holding folder and guesses the random 16-hex-digit name within the
   microseconds between the last check and the unlink; and a crash between the rename and the unlink leaves the
   verified file in the holding folder (nothing lost; the user can delete or move it).
2. **Locked counters (P1).** `quota-budget.mjs`: every change (charge, reservation, refund) runs under an exclusive lock
   file `quota-day.json.lock` (created with `wx`); the limit check and the charge are one locked step
   (`reserveUpload`, `reserveRead`). A lock older than 30 s is renamed away and removed (its holder died); a lock busy
   for 3 s gives `quota-busy` (nothing uploads or reads). Windows "delete pending" (`EPERM`) on the lock and a busy
   replace of the counter file are retried, not errors. Tested with four processes charging at once (no charge lost).
3. **Reads reserved before sending (P1).** The chain's and the card's schedule reads reserve 1 + 2 x maxPages units up
   front (`reserveScan`) and give back what they did not use; a request past the reservation is refused unsent. Other
   reads (status checks for the delete) reserve 1 unit each before sending (`meter`); over budget nothing is sent.
4. **Strict counter file (P1).** The file must be an object with both counters, each `{ day: YYYY-MM-DD, n: whole
   number >= 0 }`. Anything else (string, negative or fractional n, a missing counter or day, not JSON) blocks uploads
   and reads (`quota-unreadable`). Only a valid counter from another day starts again at 0; a missing file is day one.
5. **Strict user settings (P1).** An absent `<data>/posting/schedule.json` uses the shipped quota; an existing file that
   cannot be read, is not JSON, or has any invalid value blocks uploads and reads. The card still loads (shipped
   numbers plus the reason) so the user can save a fix.
6. **Read reserve in admission (P2).** An upload may start only while used units + one upload <= quotaUnitsPerDay -
   readReserveUnits, the same sum as the "uploads a day fit" number: a fit of 0 never uploads. Reads may use the whole
   quota.

Tests for each: `tests/posting-auto-d375.test.mjs` (holding folder used and left empty; a swap there moved back; a taken
path keeps it in the holding folder; a junction holding folder refused; four processes, no charge lost; busy and stale
locks; check-and-charge in one step; reads reserved, refused unsent, unused given back; every malformed counter; user
settings absent / broken / invalid; fit 0 with the reserve), `tests/posting-e2e.test.mjs` (fit 0 and a broken settings
file: nothing uploads). The D314 retry e2e test now gets a larger quota: its six attempts in one day no longer fit the
shipped quota once the read reserve is kept.

## Tests

```
node --test tests/posting*.test.mjs tests/studio-ui-posting*.test.mjs tests/flags.test.mjs tests/learning-mix.test.mjs \
  tests/data-reload.test.mjs tests/guide.test.mjs tests/package-alpha.test.mjs tests/studio-ui-flags-feedback.test.mjs \
  tests/studio-ui-growth.test.mjs tests/studio-qt-autopost.test.mjs
ℹ tests 362   ℹ pass 360   ℹ fail 0   ℹ skipped 2   (after the Codex re-review fixes; 3c8fd62: 350 / 348; f253771: 334 / 332)
```

(The 2 skipped: the Auto-post screenshot test without `AUTOPOST_SHOT_DIR`, and one existing skip in
`package-alpha.test.mjs`.)

New or rewritten files:

- `tests/posting-schedule.test.mjs` (28): schedule math, gap filling, the 27-post example, 1440 hourly slots, DST,
  retries, after-last, cap, preview estimates.
- `tests/posting-auto-d375.test.mjs` (43): lookback with 2500 uploads (stops after 11 pages, not truncated), clips
  folder scan, oldest first, global daily cap, unscored shorts, card defaults and save (checked, nothing written on a
  problem), move and remove, every delete refusal (flag off, failed, rejected, still processing, not found, read
  error, ledger or publish time mismatch, sha256 mismatch, outside the folder, `..` path, folder, junction leading out).
- `tests/posting-e2e.test.mjs` (38, local fake YouTube): every upload scheduled; flag off waits; D314 retries take
  the next free time; delete flag on deletes only after `processed` (log line, one task file, never checked again);
  a changed file or failed upload is kept.
- `tests/studio-ui-posting-auto.test.mjs` (8): routes need the session; POST needs CSRF and same Origin; exact params;
  bad values give `400 invalid` with the problems and write nothing; save writes both files with no temp file left;
  fresh channel read throttled to once per 10 min; missing readonly scope is a plain error; move/remove 404/409/200.
- `tests/studio-qt-autopost.test.mjs` (6, headless Qt): defaults, quota fit, next times saying Scheduled, flags-off
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
