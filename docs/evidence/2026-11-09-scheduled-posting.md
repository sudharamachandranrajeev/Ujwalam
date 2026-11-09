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
  - slot = anchor + intervalHours, but never sooner than now + minLeadHours;
  - with no anchor at all: now + minLeadHours;
  - rounded up to the whole minute. All math is in UTC milliseconds, so time zones and DST do not matter.
- **Settings** are in `data/posting/schedule.json` (source + date), never hardcoded:
  - `intervalHours` 6 (from the user);
  - `minLeadHours` 1, `staleMinutes` 15, `maxPages` 4, `pageSize` 50 (agent defaults).
  A bad file is refused (`schedule-config-bad`), never defaulted.
- **Reading YouTube Studio's schedule** (`services/posting/schedule-read.mjs`):
  - `channels.list part=contentDetails mine=true` gives the uploads playlist;
  - then, per page, `playlistItems.list` and `videos.list part=status`. Titles and descriptions are not read.
  - Only videos that are private and have a `publishAt` after now count. Past, public and unlisted videos are ignored.
  - Quota: 1 + 2 x pages units. The read happens only when a queued clip needs a slot, at most once per chain pass,
    and is capped at maxPages x pageSize (200) newest uploads. The result is saved on the queue
    (`schedule: { channelLast, count, scanned, truncated, readAt }`) for the preview.
- **Queue order, persistence, no double booking.** Slots are given out in queue order (the order the chain already
  queues, same as before). Each slot becomes the next anchor. The slot is saved on the queue item (`publishAt`,
  `slotAt`) before the upload starts. A retry, a backoff or a restart reuses it; the channel is not read again.
- **Failure behaviour (nothing is released silently):**
  - a failed upload keeps its slot; the next clip goes after it, so that time stays empty on the channel;
  - "Retry now" keeps the slot while it is still more than staleMinutes ahead;
  - a slot that is within staleMinutes of now while no upload session exists yet (e.g. the stream ran long, or every
    upload try failed before a session opened) is replaced by a new slot at the end of the schedule;
  - once a resumable session exists, Google already holds the time with it, so the slot stays.
- **Fail closed:**
  - the stored sign-in lacks youtube.readonly, Google does not say which scopes it has, or Google answers 401 or
    403 insufficientPermissions: the clip waits with reason `schedule-scope-missing`. The page says "Sign in again
    to allow reading scheduled posts (node services/posting/cli.mjs youtube signin)". It retries after 30 min and
    uses no attempt;
  - any other read failure: `schedule-read-failed`, retry after 5 min, no attempt used;
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
  tests 38, pass 38, fail 0
node --test tests/posting*.test.mjs tests/studio-ui-posting*.test.mjs tests/guide.test.mjs tests/flags*.test.mjs
  tests 182, pass 182, fail 0
node --test tests/test-broadcast.test.mjs tests/studio-ui-readiness.test.mjs tests/studio-ui-bots.test.mjs tests/stream-day.test.mjs tests/report-button.test.mjs tests/flags.test.mjs
  tests 87, pass 87, fail 0
node tools/ci.mjs --quick
  ci: 9/9 passed (build, lint, build-host, build-studio, validate-*, private-scan, legacy-verify)
```

`tests/posting-schedule.test.mjs` (pure, no network):

- settings loaded from the data file (6 h, source and date present); bad or missing settings are refused;
- empty channel gives now + 1 h, rounded up to the minute;
- a future channel schedule gives +6 h; the later of channel and own queue wins;
- an anchor whose +6 h falls inside the lead time gives the lead time;
- `planSlots` gives 4 in order, 6 h apart;
- DST: starting just before the EU (2026-03-29) and US (2026-11-01) changes, slots stay exactly 6 h apart and end in
  `Z`;
- channel filter: past, public, no-publishAt and bad values are ignored;
- own last slot counts failed items;
- stale margin;
- `schedule.mjs` has no network, auth or write code (the preview imports it);
- `uploadMetadata`: publishAt sits next to `private`; a bad time is refused; privacy is never taken from post.json;
- `authUrl` carries both scopes; `grantedScopes` reads the token answer, and gives null when Google omits `scope`;
  without a sign-in it throws `oauth-reauth-needed`;
- CLI signin asks for both scopes only with the flag on, and warns when readonly was not granted;
- preview estimate: no times with the flag off; with it on, times in order after the saved queue slots and the saved
  channel read; approval-only rules get no time; a bad settings file is reported.

`tests/posting-e2e.test.mjs`: the local fake Google (127.0.0.1 only) gained `channels`, `playlistItems` (paged) and
multi-id `videos` endpoints, and echoes publishAt from the upload metadata. New tests:

- empty channel: 3 clips go up private at +1 h, +7 h, +13 h in queue order. The channel is read once per pass and
  not at all when nothing needs a slot. `posted` rows and the summary carry the times. No token is in the queue file;
- an existing schedule in Studio (past private, future private x2, public with publishAt, unlisted) gives the
  latest future + 6 h;
- another clip 30 min later (channel list hiding our own upload) gives own last slot + 6 h;
- a failed item keeps its slot, and the next clip goes after it;
- retries never re-slot: two failed inits, then success with the same publishAt and one channel read;
- missing readonly scope (only upload, null, no `grantedScopes`): zero requests, no slot, no upload, 0 attempts,
  plain message;
- 403 insufficientPermissions, then 500, then OK: no upload until the read works, then the slot is now + 1 h;
- live: zero requests during live and with an unreadable state; after the stream the slot is set and the clip
  uploads;
- stale slot with no session is re-slotted after a 10 h stream; with an open session it keeps the original time
  (one init);
- pagination cap: maxPages 2 x 50 reads 2 pages. A scheduled post on page 2 is seen; one on page 3 is not. The read
  is saved as `truncated: true, scanned: 100`.

## UNVERIFIED

- That real Google returns `scope` in the refresh-token answer. Google's OAuth docs list it. If Google omits it, the
  chain fails closed and the clip waits with the sign-in message.
- That the uploads playlist lists newest uploads first. A scheduled video uploaded long ago (beyond 200 newer
  uploads) would not be seen. The cap is in the settings file.
- That YouTube accepts `publishAt` on a resumable insert for Shorts, and the minimum lead it requires. 1 h is our own
  margin.
- What YouTube does when a session that already carries a passed publishAt finishes later (publishes at once, or
  refuses). The chain keeps the slot in that case, because a new session could upload the video twice.
- 403 reasons other than insufficientPermissions or scope (e.g. quotaExceeded) are treated as a read failure and
  retried every 5 min. They are not treated as a scope problem.
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
   Optionally tune `data/posting/schedule.json` (interval, lead time).
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
