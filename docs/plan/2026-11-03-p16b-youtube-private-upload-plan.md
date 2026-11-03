# P16b: YouTube private upload (posting step 2) - plan

Status: PLAN, not started. Needs from the user: a Google OAuth "Desktop app" client and the target channel (below). Builds on P16a (`docs/plan/2026-11-03-p16a-export-posting-plan.md`): only packages with `status: approved` in `post.json` are uploaded, and every upload is **private**. Making a video public stays a manual step in YouTube Studio.

## Goal

From the control page (Posts view, `posting` flag on) or the CLI, upload an approved YouTube Shorts package as a private video with its title, description, tags and cover, record the video id in the ledger, and never upload the same video twice.

## Flow

1. **Sign-in (once).** `node services/posting/cli.mjs youtube signin`. OAuth 2.0 for installed apps: the system browser opens Google's consent page; the redirect goes to a one-shot loopback listener on `127.0.0.1:<random port>`; PKCE (S256) and a random `state` are checked. Scope: `https://www.googleapis.com/auth/youtube.upload` only (upload; no read, no delete, no comments). The refresh token goes to Windows Credential Manager (`Ujwalam/posting/youtube-refresh`); the access token stays in memory only. Nothing is written to files, argv or logs.
2. **Channel check.** After sign-in, show the channel the token belongs to (title only, on screen, never committed) and ask the user to confirm it is the target. If the token is for another channel (for example a Brand Account chosen wrongly at consent), sign out and sign in again. Reading the channel needs `youtube.readonly`; if that extra scope is unwanted, the check is the first private upload, inspected in Studio (decision below).
3. **Upload.** `cli.mjs youtube upload --post <run>/<clip>/youtube-shorts` or the Posts view's "Upload private" button (only on approved packages):
   - re-checks before sending: `status: approved`, video SHA-256 equals `post.json` and the ledger, limits pass (`checkLimits`), no unresolved placeholders, ledger has no `uploaded` entry for this SHA-256 + target;
   - refuses while any stream sink is active (`outputs.status`): uploads never compete with the live upload (stream's critical path);
   - resumable upload (`POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`), `status.privacyStatus: "private"` fixed in code (not taken from `post.json`), `snippet.title/description/tags` from `composeField` exactly as checked; chunked, resumes after a network error from the last acknowledged byte; the session URL stays in memory;
   - cover: `thumbnails.set` with `cover.jpg` (UNVERIFIED for Shorts: YouTube may ignore custom thumbnails on Shorts; then the step is skipped and noted);
   - writes the ledger entry `{ sha256, target, state: "uploaded", videoId, at }` and `post.json` `status: "uploaded"`, before anything else, so a crash after the upload cannot cause a second upload.
4. **Report.** The CLI and Posts view show the video id and "private"; the user opens Studio to review and publish.

## Rules kept

- Nothing is ever published by Ujwalam: privacy is hardcoded `private`. A test asserts no code path sets another value.
- No chat text, viewer names, marker notes or candidate reasons in any field (P16a already enforces this on `post.json`; the uploader sends only the checked fields).
- Network only in `services/posting/youtube.mjs`; Node stdlib `https` only (no googleapis package; no install).
- Tokens only in Credential Manager; diag bundles never include them; logs hold video ids and HTTP status codes only.
- Tests: a local mock of the OAuth token endpoint and the resumable upload endpoint (loopback HTTPS with a test CA, or an injected base URL in tests only). No test touches Google.
- Behind the `posting` flag, off by default.

## Limits and costs (from memory; each UNVERIFIED until checked on Google's pages like D189)

- Quota: `videos.insert` costs about 1600 units of the default 10 000 per day: about 6 uploads per day. `thumbnails.set` costs about 50.
- Apps in "Testing" publishing status: refresh tokens expire after 7 days; the user signs in again weekly, or moves the consent screen to "In production" (unverified apps then show a warning screen; fine for a personal tool).
- Uploads from unaudited API projects may be locked to private by YouTube: matches this plan (private only) but means publishing must be done in Studio.
- Shorts: vertical and up to 3 minutes. The clip pipeline already validates per target (`report.json`).

## Needs from the user

1. **Google Cloud project + OAuth client** (about 10 minutes, free, no billing): create a project, enable "YouTube Data API v3", configure the OAuth consent screen (External, Testing, add your Google account as a test user), create credentials "OAuth client ID" of type **Desktop app**. Store the client id and secret with `credential set --target Ujwalam/posting/youtube-client-id` and `.../youtube-client-secret` (a Desktop client secret is not confidential by Google's own design, but it still stays out of the repo).
2. **Target channel**: which channel the Shorts go to. If it is a Brand Account, pick it at the consent screen.
3. **Channel check scope**: allow `youtube.readonly` for the channel check (default: yes, read-only), or check by first upload.

## Steps (each a small commit; full CI hourly, D190)

1. `services/posting/oauth.mjs`: loopback + PKCE + state, token refresh; mock-endpoint tests.
2. `services/posting/youtube.mjs`: resumable upload, retries, ledger-first write; mock tests including resume after a dropped connection and the "never twice" rule.
3. CLI `youtube signin|status|signout|upload`; Posts view button; live-refusal check.
4. Evidence with mock runs; then one real private upload with the user's yes (a real post), checked in Studio.

## Not in P16b

TikTok and Instagram uploads (TikTok needs a developer app: still unanswered), scheduling, publishing, playlists, comments.
