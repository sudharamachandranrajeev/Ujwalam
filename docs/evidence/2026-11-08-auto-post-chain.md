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
