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
- Open points: a cancelled YouTube sign-in leaves the loopback listener open up to 3 min; a Google refresh token is kept
  if the sign-in is cancelled after consent; disconnect does not revoke the Google grant (same client as clip uploads,
  revoking would end that too); the stored refresh token has the broad `youtube` scope.
