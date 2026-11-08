# Auto-post chain after a recording (D300 proposed), 2026-11-08

Goal: after a clip job renders, package, approve by the rules and upload privately to YouTube with no CLI step.

## What changed
- `services/posting/auto-chain.mjs` (new): `createPostChain` (`afterRun(runDir, status)`, `tick(status)`), the persistent
  queue `<data>/posting/upload-queue.json` (queued / uploading / done / failed, attempts, nextAt, reason), `readQueueSummary`,
  `markPosted` (fills `posted` in `<data>/clips/uploads.json`), `streamOnly` (ignore record sinks), `backoffMs`.
- `services/posting/youtube.mjs`: `uploadVideo`/`uploadPost` take `sessions` ({get,set}) and `beforeChunk`; a stored resumable
  session is asked for its byte count and continued; a dead session starts a new one; `beforeChunk` runs before every chunk.
- `services/studio-ui/record-clips.mjs`: optional `postChain`; calls `afterRun` after a successful job with clips, `tick` with every status.
- `services/studio-ui/launch.mjs`: creates the chain. `server.mjs`: `/ui/api/posts` adds `queue` summary and per-post `queueState`;
  clips status adds `posting`.
- `services/posting/cli.mjs`: `auto --run` uses `streamOnly` (D217 refusal narrowed, see below).

## Rules
- Flags `posting` and `auto-post` both on, and a rules file with `autoUpload: true` and at least one rule. Otherwise nothing runs.
- Uploads are private only, only for posts the rules auto-approved (a post approved by hand is never queued).
- Live: any stream sink active or starting, or an output state that cannot be read, blocks approvals, uploads and retries.
  The check repeats before every 8 MiB chunk; a stream that starts mid-upload stops it and the session is kept.
- A running local recording does NOT block (decision): a recording uses disk and the encoder, an upload uses network and a
  little CPU. UNVERIFIED on the laptop under a real recording plus upload (bandwidth/CPU).
- Retries: 5 min, doubling, capped at 6 h, 8 attempts then `failed`. "Not signed in" and "stream live" waits cost no attempts
  (sign-in re-checked every 30 min). A restart turns `uploading` back into `queued`. The ledger blocks a second upload.
- Not signed in / no OAuth client: items stay queued with reason `not-signed-in` / `no-oauth-client`; the summary text reads
  "Not signed in to YouTube ...".
- Tokens are never written. The queue holds post ids, states, times, the video id and the resumable session URL.

## Tests (fakes only; temp dirs; no network)
- `tests/posting-auto-chain.test.mjs`: 13 tests pass (flags off, happy path with posted/ledger, live blocks, recording allowed,
  unreadable state, mid-upload stop + restart resume without a new init, backoff + cap + failed, no double upload,
  crash mid-upload, not signed in, hand-approved never queued, autoUpload false).
- `tests/record-clips.test.mjs`: new test for the chain hook. Posting + record-clips + studio-ui-posting files: 109/109 pass.
- Quick CI: lint 0 findings (after fixing the LF line endings), private-scan, registry/outputs/games/legacy-verify, build-host PASS.
  `build` fails only because this fresh worktree has no `app/spike/build` (environment, unrelated).

## Not done / limits
- Qt/web UI rendering of the queue line is not added; the data is in `/ui/api/posts` (`queue`) and the clips status (`posting`).
- Auto-post covers `youtube-shorts` only. The per-day cap applies to auto approvals (uploads are a subset).
- A session that Google completed but whose answer was lost surfaces as an `upload-failed` retry; after 8 tries it is `failed`
  for the user to check on YouTube. UNVERIFIED against real Google behaviour.
- Real upload with the user's account: UNVERIFIED (OAuth client not set).

## Montages, won reels and the queue on screen (D301 proposed), 2026-11-08

### What changed
- `packageUploads` (services/posting/index.mjs): packages every validated, published video in `<data>/clips/uploads.json`
  (kinds short, montage, won-reel) that is not posted and not packaged yet. The chain calls it after `packageRun` for the
  finished run. A montage-only run (no candidates.json / report.json) is no longer "could not package": it goes straight
  to uploads.json. Same bytes already packaged by `packageRun` are skipped (the ledger key is the SHA-256 plus target).
  Packages live in `<data>/posting/packages/<run>/<kind>-<sha16>/<target>/`; nothing is written into the run folder.
- Target by length and aspect, from data (never in code): `data/posting/limits.json` `youtube-shorts.video.maxDurationSec`
  (60, user instruction 2026-11-08, status unverified). A vertical video (canvas token `v` or `v-<layout>` in the file
  name) within the limit goes to `youtube-shorts`; anything longer or horizontal goes to the new `youtube-video` target
  (same YouTube text limits, no duration cap, marked `uploadsOnly` so clip packaging never uses it).
- Text: `data/posting/templates.json` targets carry `kinds.montage` and `kinds.won-reel` overrides (placeholders only);
  `youtube-video` is new. A short uses the base text.
- Rules: optional `kinds` per rule (default `["short"]`). `minScore` applies to shorts only; a montage or won reel has no
  clip score, so naming its kind in a rule is the opt-in. The committed rules file is still empty (nothing auto-posts).
  Upload targets: `youtube-shorts` and `youtube-video`; `markPosted` records the real target.
- Control page (ui/index.html, ui/js/app.js, ui/js/api.js): queue summary line (waiting / uploading / done / failed, next
  retry time, plain reason such as "Not signed in to YouTube: the Google sign-in client is not set up yet" or "Waiting
  until the stream ends"), per-item state in the list, per-item reason, attempts, link to the uploaded video, and a
  "Retry now" button for failed or waiting items. Safe DOM only.
- Server: `/ui/api/posts` adds `kind`, `videoUrl`, `queueReasonText`; new `POST /ui/api/posts/queue/retry {id}`: session +
  CSRF like every write, refused with 409 while a stream sink is live or the live state cannot be read (a local recording
  does not block), only for failed or waiting items; it only re-queues, the chain's next tick uploads. No typed phrase.
- Qt Posts view (app/studio/src/main_window.cpp; its data path is `/ui/api/posts`): same queue line, per-item state, reason,
  link text and "Retry now". Rebuilt with `node app/studio/tools/build.mjs`: built `out/studio/build/ujwalam-studio.exe`.

### Tests (fakes only, temp dirs, `UJWALAM_HEADLESS=1`)
- `tests/posting-uploads.test.mjs` (8): target by length/aspect and that the line moves with the data; templates per kind;
  packaging of 5 videos across kinds (targets, titles, hashtags, private draft, byte copy, unreadable/unknown/posted/missing
  rows skipped, second run adds nothing, run filter, empty profile leaves placeholders listed); rule `kinds` validation and
  planning (scoreless montage approved, scoreless short still skipped); chain end to end on a montage-only run: two
  montages uploaded private to the two targets, `posted` filled with the right target, second run uploads nothing.
- `tests/studio-ui-posting-queue.test.mjs` (6): list carries queue/summary/reason/link/kind; retry resets a failed item;
  refused when live and when the state is unreadable, allowed during a recording; done/unknown/bad body refused; CSRF.
- Posting + studio-ui-posting + record-clips files: 123/123 pass. Existing `posting.test.mjs` needed the `uploadsOnly` flag
  so default clip packaging does not offer `youtube-video`.

### UNVERIFIED / limits
- The 60 s Shorts line is the user's instruction, not checked against YouTube's page (YouTube has raised the Shorts limit
  before); change `maxDurationSec` in limits.json if it differs.
- Aspect comes from the canvas token in the published file name (`_v` / `_v-<layout>` / `_h`), not from ffprobe.
- A real upload of a montage with the user's account; the Qt dialog on screen (built, not opened); the web page in a browser.
- The auto-approval of montages needs the user to write a rule with `kinds`; none is added.
