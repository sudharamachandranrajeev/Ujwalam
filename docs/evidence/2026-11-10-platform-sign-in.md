# Evidence: platform sign-in from the app (D327 PC1-PC3)

Date: 2026-11-10. Branch: `pc/platform-sign-in`. Flag: `platform-connect` (data/flags.json, off by default).
Status: **tested against loopback mocks only**. Real sign-ins and real Credential Manager writes from the app are UNVERIFIED (they need the user).

## What was built

- `services/platform-connect/index.mjs`: per-output status, paste key / server, disconnect, Google OAuth sign-in for YouTube
  (loopback redirect, PKCE S256 + state, scope `https://www.googleapis.com/auth/youtube`, liveStreams list / insert),
  Twitch device-code sign-in (scope `channel:read:stream_key`, Helix `streams/key`, token validate / refresh / revoke).
  Writes go to Windows Credential Manager through `services/posting/credential.mjs` under the targets the host already
  reads (`Ujwalam/stream/<id>`); sign-in tokens under `Ujwalam/connect/{youtube-refresh,twitch-refresh,twitch-client-id}`.
  `<dataDir>/connections.json` holds only the source (youtube / twitch / pasted) and token state per output, no secrets.
- `services/studio-ui/server.mjs`: `GET /ui/api/connect`, `POST /ui/api/connect/{paste,sign-in,disconnect,twitch-client,choose,cancel,check}`.
  All 404 while the flag is off. Writes need the typed "yes" ("yes, on air" while live, upgraded if the stream went live
  while pending). A live output's own key is refused (checked at request, at confirm and right before each write;
  unreadable live state = refuse).
- `services/studio-ui/readiness.mjs`: the missing-key fix text points at Settings > Connections; expired sign-ins are warnings.
- `tools/diag/redact.mjs`: new rules for `OAuth <token>`, Google `ya29.` / `1//` tokens, device / user / authorization
  codes and code verifiers, Twitch-style 30-character tokens; the Kick `sk_` rule now covers dashed region keys.
- `app/studio/src/connections_page.{h,cpp}`: Settings > Connections page in the studio (rows per output, sign-in
  buttons, password-echo paste dialog, disconnect, Twitch client ID field, set-up text, Check sign-ins).

## Tests (UJWALAM_HEADLESS=1)

```
node --test tests/platform-connect.test.mjs tests/studio-ui-connect.test.mjs tests/diag-bundle.test.mjs tests/studio-ui-readiness.test.mjs
```

Result: 75 tests, 75 pass, 0 fail.

- `tests/platform-connect.test.mjs` (24): key / server validation mirroring the host; paste and disconnect against an
  in-memory credential store (no real Credential Manager); live refusal (live and unknown); YouTube sign-in with PKCE
  verify, state check, scope in the auth URL, choose an existing stream or create one, state mismatch, missing scope,
  no client, output going live between steps, expired token; Twitch device flow with pending polls, server kept,
  refresh-token rotation, no client id, user denied, client id validation, expired token + revoke on disconnect;
  Kick offers no sign-in; one sign-in at a time; cancel stops all writes.
- `tests/studio-ui-connect.test.mjs` (12): flag gate; CSRF and Origin refusal; paste with typed confirm, key never echoed,
  status masked to last 4; pending record does not serialise the key; bad values 400; live rules (own output 409,
  other output "yes, on air", went-live-while-pending upgrade then 409); YouTube and Twitch sign-in through the server;
  disconnect; readiness fix and warnings; redaction. A leak check scans every HTTP response, every log line and every
  file in the data dir for the key and token markers.
- Mocks: `tests/helpers/platform-mocks.mjs` (loopback Google token + liveStreams, Twitch device / token / validate /
  revoke / Helix / ingests). No real platform is contacted.
- `npm run ci` (commit hook): 9/9 PASS on each commit, including build-studio with the new page.

## UNVERIFIED (needs the user)

- A real Google sign-in with the `youtube` scope, and liveStreams list / insert on the real channel.
- A real Twitch device sign-in and `streams/key` with the user's registered app.
- Real Credential Manager writes and deletes from the app (the PowerShell CredWriteW path is shared with posting, which
  is already in use, but these targets are new).
- The Qt Connections page at runtime (it builds; it was not clicked through).
- The host picking up a key written by the app at the next stream start (same target names it reads today).
- The Twitch default ingest from `ingest.twitch.tv` when no server is stored.

## User actions

1. Turn on the flag `platform-connect` (Settings > Advanced) when ready to try it.
2. Twitch: register an app at dev.twitch.tv (Client Type: Public, redirect `http://localhost`) and paste its Client ID
   in Settings > Connections.
3. Google: the YouTube sign-in uses the Google client already set for clip uploads. Add the `.../auth/youtube` scope to
   the consent screen if Google asks, and sign in again: the new permission (manage live streams) needs a new consent.

## Security self-review

- Keys and tokens live only in Credential Manager; responses carry presence, scheme and last 4 at most; errors carry codes.
- Google loopback uses PKCE S256 and a random state; another local process can hit the redirect, but a wrong state only
  ends that sign-in (DoS, not takeover). The Twitch verify URL is origin-checked before the browser opens it.
- Local API: session cookie, CSRF header and Origin check on every write; typed phrase for every credential write.
- A pasted key waits in memory (pending closure) for up to 30 s until confirmed or cancelled; never on disk.
- Open points: disconnect does not revoke the Google grant (same client as clip uploads, revoking would end that too);
  the stored refresh token has the broad `youtube` scope.

## Codex second review (2026-11-10): five P2 findings, fixed

Each has regression tests; the 14 new service tests in `tests/platform-connect.test.mjs` all fail on the code before
the fix (checked) and pass after it.

1. Check-then-write race. An output's key and server address now change as one update (`updateOutput`): under one
   lock for all output writes and the studio-ui start gate, idle check, write, idle re-check; if the output went live,
   the previous pair is restored and the update refused. While an update holds the gate, a confirmed stream start is
   refused (409 `credentials-updating`); while a start is on its way, an update is refused (409 `output-starting`).
   Tests: paste and disconnect with a start in between, gate held for the whole update, two pastes serialised, and two
   server tests in `tests/studio-ui-connect.test.mjs`.
2. Ended jobs writing. A job ends in done, failed or cancelled for good (also past 10 min, or superseded); ending it
   aborts its AbortController (HTTP requests and the Google loopback listener stop at once) and every await and
   credential write checks it. The Google refresh token is written through a guard tied to the job. Tests: cancel
   during choose(), Twitch token answer after cancel, Google cancel after consent and before (listener closed), time-out.
3. Concurrent requests. The job is reserved before the first await; choose() moves to saving before its first await.
   Tests: two sign-ins at once, two choose() at once (one stream created).
4. Twitch single-use refresh token. Read, exchange and replace run under one account lock; callers at the same time
   share one refresh; a sign-out invalidates refreshes and device sign-ins already running. Tests: two refreshes, one
   exchange; a refresh in flight during disconnect stores nothing afterwards.
5. Revoke. Sign-out exchanges the refresh token for an access token and revokes that (Twitch's revoke takes an access
   token), checks the answer, and reports `removed.token` (local delete) and `removed.revoke` (revoked | failed |
   not-needed | skipped) apart. Test: revoke failing with 503 still deletes locally and reports `failed`.
   UNVERIFIED: whether Twitch also invalidates the refresh token when its access token is revoked (deleted locally anyway).

`services/posting/oauth.mjs`: `signIn({ signal })` and `loopbackListener({ signal })` are optional additions; posting's
calls are unchanged (posting suites pass).

## Edit output > Connect wired to the Connections flow (branch ui/connect-button, 2026-11-10)

What changed:
- `app/studio/src/stream_pages.cpp`: the "Connect" button of the Edit output window (`outputConnect`) is no longer a placeholder.
  Flag `platform-connect` off: disabled, tooltip names the flag and Settings > Advanced. On, and the connection service knows
  the output: enabled; a click opens the Connections flow for that output alone (`connections::openForOutput`, the same
  `connections::Page` as Settings > Connections with a one-output filter; no sign-in code duplicated). On, but the output is new
  and not saved yet: disabled, tooltip says to save it first (the service reads saved outputs). The window and each output row
  show the state: Connected / Sign-in expired / Not connected, with at most `(key ....last4)`.
- `services/platform-connect/index.mjs`: `outputs` may be a function, read on every call; the status cache is keyed on the
  output list; `outputsFromPlan` takes an optional `platform` and `canvas` per row.
- `services/studio-ui/server.mjs` + `stream-setup.mjs` (`connectTargets`): with `stream-settings` on and a saved setup, every
  output of the setup (also switched-off and portrait ones) is added to the live plan's outputs, key name
  `Ujwalam/stream/<id>` (and `-server` where the platform has a per-account server), without a restart.

Tests (all headless, in-memory credential store, no real platform or Credential Manager):
- `tests/studio-ui-connect-setup.test.mjs` (4): a setup-only output (`kick-2`) is listed, pasted under
  `Ujwalam/stream/kick-2` and `-server` after the typed "yes", status shows only the last 4; an output saved after the server
  started is known without a restart (status cache does not hide it); `stream-settings` off: not used (404); the platform of a
  setup output comes from the setup, not its id. Leak check over every HTTP response, log line and data file.
- `tests/studio-qt-connect-button.test.mjs` (3, Qt shell, `UJWALAM_HEADLESS=1`): flag off: disabled + tooltip, no row status;
  flag on: enabled, window status `Connected  (key ....yZZ9)`, row statuses, click opens the flow with one row (Twitch);
  unsaved new output: disabled, "Save this output first". Leak check: the stored key is in no shell output, log line or file.
  Pictures: `%TEMP%\ujwalam-connect-shots` (not committed).
- Results: `studio-ui-connect-setup`, `studio-ui-connect`, `platform-connect`, `studio-qt-connect-button`, `studio-qt-d327`,
  `studio-launch-d327`: 67 pass, 0 fail; `stream-setup`, `studio-ui-stream-settings`, `studio-ui-readiness`: 59 pass, 0 fail.
  Commit hook (quick CI) passed on every commit.

UNVERIFIED: a real sign-in through the new button (YouTube, Twitch) on a real account; the window on a physical display
(only the offscreen picture was checked); an output added in Settings > Stream and saved, then connected in the same
Settings window session (the Stream page must be saved first; the tests cover the server side and the unsaved tooltip).
