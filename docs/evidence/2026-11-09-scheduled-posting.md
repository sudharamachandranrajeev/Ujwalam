# Scheduled posting (2026-11-09)

User request (2026-11-09): "auto scheduled posting. Check scheduled posts in YT Studio. Post 6 hours ahead of the last
scheduled post and continue this cycle as soon as it gets another clip."

Status: built and tested against a local fake YouTube only. Behind the new flag `post-schedule` (off by default).
Not yet used against real Google. Decision: D310 (proposed). D310 was the next free number in
`docs/plan/2026-10-29-v1-decisions.md` (last one D309) and on every local branch when this was written. If another
branch takes D310 first, renumber at merge.

## What it does

- **Slot per clip.** With `posting`, `auto-post` and `post-schedule` on, every clip the auto-post chain queues is
  uploaded as `privacyStatus: "private"` with `status.publishAt` (RFC 3339, UTC, `Z`). YouTube makes it public at
  that time. Privacy is still hardcoded in `uploadMetadata()`. Neither privacy nor publishAt is ever read from
  post.json. A publishAt that is not a strict UTC ISO string is refused (`bad-publish-at`, permanent failure).
- **Slot rule** (`services/posting/schedule.mjs`, pure):
  - anchor = the later of (a) the latest FUTURE publish time already scheduled on the channel and (b) the latest
    slot already in the upload queue (any state);
  - floor = now + minLeadHours + marginMinutes;
  - slot = anchor + intervalHours, but never sooner than the floor;
  - with no anchor at all: the floor (now + 1 h 15 min with the shipped settings);
  - rounded up to the whole minute. All math is in UTC milliseconds, so time zones and DST do not matter.
- **Settings** are in `data/posting/schedule.json` (source + date), never hardcoded:
  - `intervalHours` 6 (from the user);
  - `minLeadHours` 1, `marginMinutes` 15, `maxPages` 20, `pageSize` 50 (agent defaults);
  - `chunkDeadlineSeconds` 120 (about 2 min, from the round-2 review) and `fallbackKbps` 1000 (agent default).
  A bad file is refused (`schedule-config-bad`), never defaulted.
- **Reading YouTube Studio's schedule** (`services/posting/schedule-read.mjs`):
  - `channels.list part=contentDetails mine=true` gives the uploads playlist;
  - then, per page, `playlistItems.list` and `videos.list part=status`. Titles and descriptions are not read.
  - Only videos that are private and have a `publishAt` after now count. Past, public and unlisted videos are ignored.
  - Quota: 1 + 2 x pages units. The read happens only when a queued clip needs a slot, at most once per chain pass,
    and is capped at maxPages x pageSize (1000) newest uploads (41 quota units). If the channel has more uploads than that, nothing is scheduled (see Fail closed). The result is saved on the queue
    (`schedule: { channelLast, count, scanned, truncated, readAt }`) for the preview.
- **Queue order, persistence, no double booking.** Slots are given out in queue order (the order the chain already
  queues, same as before). Each slot becomes the next anchor. The slot is saved on the queue item (`publishAt`,
  `slotAt`) before the upload starts. A retry, a backoff or a restart reuses it while it is still at least minLeadHours ahead; the channel is not read again.
- **Failure behaviour (nothing is released silently):**
  - a failed upload keeps its slot; the next clip goes after it, so that time stays empty on the channel;
  - the slot is re-checked right before an upload session starts or resumes (inside `uploadVideo`, so also when an
    expired session is restarted): it must be at least minLeadHours ahead. Otherwise no session is started
    (`slot-passed`), the slot is dropped and the clip gets a new slot at the end on the next pass (no attempt used).
    This covers a later clip in a batch whose slot came close while earlier clips uploaded, a long stream, and long
    backoffs;
  - before every chunk the time must still be at least marginMinutes ahead. Otherwise the upload stops between chunks
    (`slot-passed-mid`); the next try drops the unfinished session and gets a new slot. An upload never finishes
    with a passed time;
  - every chunk request (the final one above all) is aborted at publishAt - chunkDeadlineSeconds with an
    AbortSignal. No byte is sent after that, so Google gets the final byte before the time or never. There was no
    per-chunk fetch timeout before; the deadline is the only one. After an abort, Ujwalam asks Google for the
    session's progress: finished = recorded as done now (with the session's time); not finished (or unknown) =
    `slot-passed-mid`, so the next pass drops the unfinished session and gives a new slot;
  - the final chunk only starts when its estimated transfer time fits before that deadline. The estimate uses the
    slowest chunk measured in this upload, or fallbackKbps when none was measured yet (a one-chunk file, a resume).
    chunkDeadlineSeconds must be less than marginMinutes x 60, or the settings file is refused;
  - each session's own publish time is saved with it (`sessionPublishAt`; null = sent without one). An unfinished
    session whose time differs from the slot (e.g. started before `post-schedule` was switched on) or is too close
    is dropped and a new session is started. A FINISHED session is recorded with the time it really carried
    (`sentPublishAt`, `posted[].publishAt`), never the planned one;
  - if a finished session is only confirmed after its time passed (answer lost, then the progress query failed for a
    while), the clip is marked `went-public-early` and the page says plainly "may have gone public early ... check
    YouTube Studio" (never silent);
  - fixing the time after upload with `videos.update status.publishAt` was evaluated and not used: it needs the
    broad `youtube` / `youtube.force-ssl` scope (manage the whole account), not `youtube.upload` + `youtube.readonly`.
- **Fail closed:**
  - the stored sign-in lacks youtube.readonly, Google does not say which scopes it has, or Google answers 401 or
    403 insufficientPermissions: the clip waits with reason `schedule-scope-missing`. The page says "Sign in again
    to allow reading scheduled posts (node services/posting/cli.mjs youtube signin)". It retries after 30 min and
    uses no attempt;
  - any other read failure: `schedule-read-failed`, retry after 5 min, no attempt used;
  - the page cap was hit (the channel has more uploads than maxPages x pageSize): `schedule-read-incomplete`, the page
    says "raise maxPages in data/posting/schedule.json", retry after 30 min. An older scheduled post could be past the
    pages read, so no slot is given out. The preview says the same;
  - a bad settings file: every queued clip waits (the re-check needs the settings);
  - a clip without a slot never uploads, and no slot is guessed.
- **Live:** unchanged. While a stream sink is live or the state cannot be read, nothing is approved, read, slotted
  or uploaded. Clips from live and montages after live are packaged from uploads.json as before. They are queued,
  slotted and uploaded once the stream ends.
- **Sign-in:** `node services/posting/cli.mjs youtube signin` asks for `youtube.upload` + `youtube.readonly` while
  `post-schedule` is on, and `youtube.upload` only while it is off. If Google returns no readonly scope, the CLI
  says scheduled posting will wait. The chain reads the granted scopes from Google's token answer (`scope`), in
  memory only.
- **Other paths:**
  - with the flag on, `auto --run` only approves; the studio queue uploads, so nothing goes up without a slot;
  - `youtube upload --id` (manual, one clip) stays an unscheduled private upload;
  - flag off: behaviour is exactly as before (existing tests run with the flag off and pass unchanged).
- **UI (plain words):**
  - preview (`auto --preview` and the control page "Preview auto-post rules") shows "goes public about <time>" for
    each item that would upload. This is an estimate from the queue's own slots and the last saved channel read.
    The preview stays read-only and makes no request to Google. The real time is set when the clip is queued;
  - the Posts view (control page and studio window) shows "will go public <local time>" / "goes public <local
    time>" per post, and the queue line shows "next goes public ..., last scheduled ...";
  - `uploads.json` `posted` rows carry `publishAt`.

## Evidence

Commands (worktree `post/schedule`, 2026-11-09):

```
node --test tests/posting-schedule.test.mjs tests/posting-e2e.test.mjs
  tests 49, pass 49, fail 0
node --test tests/posting*.test.mjs tests/studio-ui-posting*.test.mjs tests/guide.test.mjs tests/flags.test.mjs
  tests 193, pass 193, fail 0
node --test tests/test-broadcast.test.mjs tests/studio-ui-readiness.test.mjs tests/studio-ui-bots.test.mjs tests/stream-day.test.mjs tests/report-button.test.mjs tests/flags.test.mjs
  tests 87, pass 87, fail 0 (first round; flags.json unchanged since)
node tools/ci.mjs --quick
  ci: 9/9 passed (build, lint, build-host, build-studio, validate-*, private-scan, legacy-verify)
```

`tests/posting-schedule.test.mjs` (pure, no network):

- settings loaded from the data file (6 h, source and date present); bad or missing settings are refused;
- empty channel gives now + 1 h 15 min (lead + margin), rounded up to the minute;
- a future channel schedule gives +6 h; the later of channel and own queue wins;
- an anchor whose +6 h falls inside the floor gives the floor;
- `planSlots` gives 4 in order, 6 h apart;
- DST: starting just before the EU (2026-03-29) and US (2026-11-01) changes, slots stay exactly 6 h apart and end in
  `Z`;
- channel filter: past, public, no-publishAt and bad values are ignored;
- own last slot counts failed items;
- too-close rule: less than 1 h ahead is too close; a fresh slot passes the check for the whole 15 min margin;
- `schedule.mjs` has no network, auth or write code (the preview imports it);
- `uploadMetadata`: publishAt sits next to `private`; a bad time is refused; privacy is never taken from post.json;
- `authUrl` carries both scopes; `grantedScopes` reads the token answer, and gives null when Google omits `scope`;
  without a sign-in it throws `oauth-reauth-needed`;
- CLI signin asks for both scopes only with the flag on, and warns when readonly was not granted;
- preview estimate:
  - no times with the flag off;
  - with it on, times in order after the saved queue slots and the saved channel read;
  - approval-only rules get no time;
  - a bad settings file is reported;
  - a saved read that hit the page cap gives no times and says "raise maxPages".

`tests/posting-e2e.test.mjs`: the local fake Google (127.0.0.1 only) gained `channels`, `playlistItems` (paged) and
multi-id `videos` endpoints, and echoes publishAt from the upload metadata. New tests:

- empty channel: 3 clips go up private at +1 h 15, +7 h 15, +13 h 15 in queue order.
  - The channel is read once per pass, and not at all when nothing needs a slot.
  - Recorded `sentPublishAt`, the `posted` rows and the summary carry the times. No token is in the queue file;
- an existing schedule in Studio (past private, future private x2, public with publishAt, unlisted) gives the
  latest future + 6 h;
- another clip 30 min later (channel list hiding our own upload) gives own last slot + 6 h;
- a failed item keeps its slot, and the next clip goes after it;
- a retry while the time is still more than 1 h ahead keeps the same publishAt and makes no new channel read;
- missing readonly scope (only upload, null, no `grantedScopes`): zero requests, no slot, no upload, 0 attempts,
  plain message;
- 403 insufficientPermissions, then 500, then OK: no upload until the read works, then the slot is the floor;
- live: zero requests during live and with an unreadable state; after the stream the slot is set and the clip
  uploads;
- review fix 1 (time too close before the session starts):
  - the second clip of a batch whose slot came within 55 min while the first uploaded starts no session
    (`slot-passed`, 0 attempts);
  - the next pass gives it a new slot at least 1 h ahead;
- review fix 1 (time too close during the upload): stopped after the first chunk, then the unfinished session is
  dropped (progress query), then a new slot and a new session. One video; the first session never became a video;
- review fix 1 (long stream): a passed slot with no session gets a new slot. With an unfinished session open, the
  session is dropped first, then a new slot and a new session (2 inits);
- review fix 1 (confirmed late): a scheduled upload that finished but was confirmed only after its time passed is
  `went-public-early`. The summary has `attention: 1` and "may have gone public early";
- review fix 3 (session metadata): an unfinished session started with the flag off (`sessionPublishAt: null`) is
  dropped when the flag is on. A new session is sent with the slot, and posted carries that slot. A FINISHED
  unscheduled session is recorded with no publishAt (one init, nothing shown as scheduled);
- review fix 2 (pagination cap): maxPages 2 x 50 on a 160-upload channel reads 2 pages, then:
  - schedules and uploads nothing: `schedule-read-incomplete`, 0 attempts, "raise maxPages";
  - saves `truncated: true, scanned: 100`.
  With 90 uploads (within the cap), the scheduled post on page 2 is found.
- round 2 (chunk deadline), each with margin 1 min, deadline 59.5 s and the clock jumped to 60 s before the slot after
  the first chunk, so each chunk request has 500 ms of real time:
  - the final chunk stalls (Google holds it, never finishes): aborted after about 500 ms (asserted 400 ms to 5 s), one
    progress query, `slot-passed`, 0 attempts. The next pass drops the session; the one after gives a new slot and a
    new session. One video, and the stalled session never became one;
  - the final chunk stalls but Google had finished it: after the abort the progress query returns the video, which
    is recorded as done with its slot (no new session, no `went-public-early`);
  - a fast final chunk under the same deadline: done with its slot, no progress query, one session;
  - one-chunk file, no speed measured, fallbackKbps 64 (about 46 ms for about 370 bytes) with only 10 ms left: no
    byte is sent and the clip is re-slotted (`slot-passed`). With fallbackKbps 1000 and 500 ms left it goes up.
- settings: chunkDeadlineSeconds 0, fallbackKbps 10, and a chunkDeadlineSeconds not below marginMinutes x 60 are
  each refused.
- round 3 (timer limit): a slot 30 days ahead uploads normally in several chunks with no abort and no progress query.
  setTimeout takes at most 2^31-1 ms (about 24.8 days; longer fires after 1 ms), so no timer is set for a deadline
  further away; the fit check still uses the real deadline. The test failed before the fix.

## Review fixes (Codex review, 2026-11-09)

1. HIGH, past publishAt: fixed. The time is re-checked inside `uploadVideo` right before a session starts or
   resumes (>= now + minLead), so a later batch item or a restarted expired session can never send a passed or
   too-close time. It is also re-checked before every chunk (>= now + margin). An unfinished session is dropped
   and the clip re-slotted. A finished one confirmed late is marked `went-public-early` with a plain message.
   `videos.update` after upload needs the broad `youtube` scope, so it was not used.
2. MEDIUM, truncated read: now fails closed (`schedule-read-incomplete`, plain message). The default page cap was
   raised to 20 x 50 = 1000 uploads; the settings file allows up to 100 pages.
3. MEDIUM, unscheduled session resumed as scheduled: each session's publish time is saved
   (`sessionPublishAt`). A mismatch drops an unfinished session and starts a new one with the slot. The time
   recorded is always the one the finished session carried (`sentPublishAt`, `posted[].publishAt`).
4. HIGH (round 2), a final chunk could finish after its time: every chunk request now has an abort deadline at
   publishAt - chunkDeadlineSeconds (120 s), and the final chunk only starts when its estimated transfer time fits.
   After an abort, a progress query decides: finished = done; otherwise re-slotted as in fix 1.

## UNVERIFIED

- That real Google returns `scope` in the refresh-token answer. Google's OAuth docs list it. If Google omits it, the
  chain fails closed and the clip waits with the sign-in message.
- That Google never turns an unfinished resumable upload session into a video. Dropping such a session relies on it.
- Whether Google finalizes a session whose last byte arrived just before the abort. If it does, the progress query
  after the abort sees it and records it as done before its time; if that query fails, the next pass asks again,
  and a late confirmation is marked `went-public-early`.
- That aborting the request really stops the bytes at the deadline on a real network (Node's fetch closes the
  connection; bytes already in OS or network buffers may still arrive). The 2 min deadline is the safety margin for
  this.
- That YouTube accepts `publishAt` on a resumable insert for Shorts, and the minimum lead it requires. 1 h is our own
  lead.
- 403 reasons other than insufficientPermissions or scope (e.g. quotaExceeded) are treated as a read failure and
  retried every 5 min. They are not treated as a scope problem.
- A channel with more than 1000 uploads schedules nothing until maxPages is raised. That costs 1 + 2 quota units per
  page per read.
- The studio window (Qt) change was compiled by `build-studio` but not looked at on screen.

## What the user must do

1. Google Cloud console > your OAuth app > Data Access (scopes): add
   `https://www.googleapis.com/auth/youtube.readonly` next to `youtube.upload`, and save. If the app is in
   "Testing", your account must stay a test user.
2. Switch on the flags `posting`, `auto-post` and `post-schedule` on the control page.
3. Sign in again so the stored sign-in carries the read permission: `node services/posting/cli.mjs youtube signin`.
   On Google's consent screen, tick both permissions (upload, and view your YouTube account). The CLI says so if
   reading was not allowed.
4. Rules: `data/posting/auto-post-rules.json` needs `"autoUpload": true` and at least one rule (as before).
   Optionally tune `data/posting/schedule.json` (interval, lead time, margin, chunk deadline, fallback speed, page cap).
5. Check with "Preview auto-post rules" (or `node services/posting/cli.mjs auto --preview`). After the first real
   upload, check in YouTube Studio > Content that the video shows "Scheduled" with the expected time.

## Files changed

- `services/posting/schedule.mjs` (new)
- `services/posting/schedule-read.mjs` (new)
- `data/posting/schedule.json` (new)
- `services/posting/auto-chain.mjs`
- `services/posting/youtube.mjs`
- `services/posting/oauth.mjs`
- `services/posting/cli.mjs`
- `services/posting/preview.mjs`
- `services/studio-ui/server.mjs`
- `ui/js/app.js`
- `app/studio/src/main_window.cpp`
- `data/flags.json`
- `tests/posting-schedule.test.mjs` (new)
- `tests/posting-e2e.test.mjs`
- `tests/posting-auto-chain.test.mjs`, `tests/posting-uploads.test.mjs` (keep post-schedule off)
- `docs/plan/2026-10-29-v1-decisions.md` (D310 proposed)
- `docs/evidence/2026-11-09-scheduled-posting.md` (this file)
