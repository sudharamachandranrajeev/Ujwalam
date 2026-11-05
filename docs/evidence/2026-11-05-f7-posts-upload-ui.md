# F7: Posts view, private YouTube upload and status check

Date: 2026-11-05. Behind the `posting` feature flag (all routes answer 404 `posting-off` while it is off).

## What was built

- Shared logic moved into `services/posting/youtube.mjs`: `uploadPost` (used by both `cli.mjs youtube upload` and the studio),
  `checkUploadStatus` / `checkPostStatus` (videos.list, part=status,processingDetails), `isStreamLive`. `uploadVideo` now also returns `uploadStatus`.
- `services/posting/index.mjs`: ledger `annotate()` stores the `videoId`; post view exposes `videoId`; edit and status changes are refused
  (`already-uploaded`) once a post is uploaded, so an edit can never reset it to draft and allow a second upload.
- Server routes (`services/studio-ui/server.mjs`): `GET /ui/api/posts/youtube/status` (signedIn, hasClient, phrase; no token),
  `POST .../youtube/upload {id, confirm}`, `POST .../youtube/check {id}`. Same session cookie, Origin and CSRF rules as the other POST routes.
- Upload rules: typed phrase `yes, upload` (case and spacing normalised); post must be `approved`; refused when any stream sink is live
  (`active` or state starting/live/retrying); the live check fails closed (host unreachable = refused); one upload at a time;
  `privacyStatus` stays hardcoded `private`.
- Sign-in stays CLI-only (`node services/posting/cli.mjs youtube signin`). Tokens stay in Credential Manager and server memory; no response carries one.
- UI (`ui/index.html`, `ui/js/api.js`, `ui/js/app.js`): a YouTube box in the Posts form with a typed-confirmation field, "Upload to YouTube (private)"
  and "Check status" buttons. Safe DOM only (textContent), no CDN.

## Tests (fake auth, fake fetch; nothing touches Google)

- New: `tests/studio-ui-posting-youtube.test.mjs` (8 tests): status route without token, confirm required, not-approved, bad params, unknown id,
  live refusal x3 (state live, active flag, live check throws), happy path (video id stored, token absent from every response, second upload refused,
  edit and status locked), expired sign-in maps to 401, check route (not uploaded 409, processed status, unknown 404), `checkUploadStatus` found/empty/403/500,
  UI source rules.
- Run: `node --test tests/posting*.test.mjs tests/studio-ui-*.test.mjs` -> 146 pass, 0 fail.
- Existing CLI and youtube tests still pass after the refactor. `node tools/lint.mjs` -> 0 findings.
- Full `npm run ci` NOT run (another run was in progress).

## UNVERIFIED

- `videos.list` with only the `youtube.upload` scope: Google may answer 401/403. The route maps that to `status-not-permitted` with a plain message.
  The upload response itself carries `uploadStatus`, which is shown. A real check needs either a broader scope (user decision) or a live test.
- No real upload, no real browser pass of the new UI (headless only; DOM wiring checked by source rules, not rendered).
- Upload holds the HTTP request open until finished (large files take a while); the page shows "Uploading..." meanwhile.
- When the host is not running, the live check falls back to `host.status`; if both fail, upload is refused (use the CLI, which treats "no host" as nothing live).
