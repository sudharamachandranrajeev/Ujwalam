# P3 E2: Streamer.bot ingest (2026-10-28)

Result: **PASS** for the mock half of the E2 "Done when" (mock flow end to end). **Real chat read on a real stream: NOT DONE** (the user runs it; command below). Machine: Windows 11 Pro 10.0.26200, node v26.12.1.

No message was sent to any platform. No Streamer.bot was running locally (no process, nothing listening on 8080, 8093 or 8094), so no real connect/Hello/subscribe smoke check was possible; nothing real was contacted.

## What was built

| Item | File |
|---|---|
| Payload mapping (chat: legacy field order; alerts: UNVERIFIED) and event table | `services/event-core/streamerbot/map.mjs` |
| Authenticate hash | `services/event-core/streamerbot/auth.mjs` |
| Connector (handshake, subscribe, reconnect, send guard, fixture hook) | `services/event-core/streamerbot/connector.mjs` |
| Windows Credential Manager provider | `services/event-core/streamerbot/credential.mjs` |
| Anonymiser and fixture recorder | `services/event-core/streamerbot/anonymise.mjs` |
| Listen CLI | `services/event-core/cli.mjs` |
| Mock Streamer.bot (WS server) | `tools/mock/mock-streamerbot.mjs` |
| Mock chat script source | `tools/mock/mock-chat.mjs` |
| Tests | `tests/event-core-streamerbot.test.mjs`, `...-anonymise.test.mjs`, `...-credential.test.mjs`, `...-cli.test.mjs` |

## Docs read (WebFetch, 2026-10-28)

- https://docs.streamer.bot/api/websocket : landing page only.
- https://docs.streamer.bot/api/websocket/guide/authentication : Hello shape (`authentication.salt`, `authentication.challenge`), hash steps, `Authenticate` request. The page gives no response shape and no default port.
- https://docs.streamer.bot/api/websocket/guide/configuration : defaults 127.0.0.1, port **8080**, endpoint `/`; auth off by default; with auth on, only privileged requests need it unless "Enforce" is on.
- https://docs.streamer.bot/api/websocket/requests : `DoAction` (`action.id` or `action.name`, `args`, `id`), `Subscribe` and responses.
- https://docs.streamer.bot/api/websocket/events/twitch (event name index); `.../twitch/sub`, `gift-sub`, `raid`, `cheer`, `follow`, `reward-redemption` (example field names; the examples are auto-generated random data).
- https://docs.streamer.bot/api/websocket/events/kick (event name index); `.../kick/subscription`, `follow`, `chat-message` (field names only).
- https://docs.streamer.bot/api/websocket/events/you-tube : index page had no event names. HTTP 500 on `twitch/resub`, `you-tube/super-chat`, `you-tube/new-sponsor`, `you-tube/member-milestone`, `twitch/follow`... (follow worked; resub and the three YouTube pages failed). YouTube alert names and fields, and ReSub fields, are therefore from memory, not read. `kick/follow` and `kick/chat-message` worked (field names only).
- Legacy references (read only): `legacy/engage/lib/streamerbot.mjs`, `legacy/kit/sources/streamerbot.js`, `legacy/tools/mock-streamerbot.mjs`, `legacy/tools/mock-chat.mjs`.

## Connector behaviour

- Default URL `ws://127.0.0.1:8080/` (docs default). Note the legacy install used 8093; pass `--url` or config.
- Subscribe object, built from the table: Twitch ChatMessage, Follow, Sub, ReSub, GiftSub, GiftBomb, Raid, Cheer, RewardRedemption; YouTube Message, SuperChat, NewSponsor, MemberMilestone; Kick ChatMessage, Follow, Subscription, Resubscription, GiftSubscription, MassGiftSubscription, RewardRedemption.
- Flow: open, wait for Hello (5 s), authenticate only if Hello has `authentication`, Subscribe, then `system.connected`. Close after connect emits `system.disconnected`.
- **Reconnect**: delay = min(30 000, 1000 * 2^attempt) ms, then equal jitter (random in [d/2, d]). So 0.5-1 s, 1-2 s, 2-4 s, ... capped at 15-30 s. Attempt counter resets after a Subscribe is accepted. Tested with injected timers: random=1 gives 1000, 2000, 4000, 8000, 16000, 30000, 30000; random=0 gives 500 ... 15000.
- **Auth failure** (non-`ok` answer, no answer in 5 s, socket closed during auth, or no password from the provider): state `auth-failed`, `onNote('error', code)`, no reconnect (test: one attempt only across many backoff periods). `start()` restarts it explicitly.
- Chat: legacy order kept (`user.name`, `displayName`, `login`, `message.displayName`, `message.username`; text: string `message`, else `text`, `message.message`, `message.text`). Empty or whitespace text is skipped (counted as `skipped.empty-text`). The event carries no raw payload (test checks the key set).
- Platform message id: `messageId`, `eventId` (YouTube), `message.msgId`, `message.messageId`.

## Send guard

`sendChat(platform, text)` sends `DoAction` with `action.name` from config (`actions: {twitch, youtube, kick}`) and `args {message, platform}` (as legacy). It refuses with `SendRefused` codes: `real-send-disabled`, `not-connected`, `unknown-platform`, `no-action-configured`, `bad-text` (control characters stripped, 1-500 code points).

- Allowed only if built with `sendEnabled === true` (real). **No code in services/, tools/ or tests/ sets it**; `tests/event-core-streamerbot.test.mjs` "source scan" greps all three trees for it.
- The only other route is `allowMockSend: true`, honoured only when the server's Hello announced `info.name === "ujwalam-mock-streamerbot"` AND the URL host is loopback. Used by tests only (scan asserts it appears only in the connector and tests; the CLI does not contain it). A real server (or an impostor named otherwise) gets `real-send-disabled` (tested). So the spec's "explicit sendEnabled: true" gate is kept for real, and tests reach the mock through the marker route instead of setting the flag.

## Credential method

Windows PowerShell 5.1 (`powershell.exe`, present on every Windows) compiles a small P/Invoke wrapper (`advapi32` `CredReadW`/`CredWriteW`/`CredDeleteW`, generic credential) with `Add-Type`. Secret goes in through stdin, the target name through an environment variable, nothing on a command line. Why: `cmdkey` cannot print a secret; WinRT `PasswordVault` does not work in pwsh 7 and is not visible in the Credential Manager UI; a DPAPI file would be our own store. Default target `Ujwalam/streamerbot`; names must start with `Ujwalam`. Each call costs about 1-2 s (PowerShell start + compile), paid only when the server asks for auth. Tests use `Ujwalam-TEST-ONLY-<pid>-<random>` and delete it in `finally`. Verified the round trip with non-ASCII, quotes and `$`.

To store the real password use `node services/event-core/cli.mjs credential set`: hidden terminal entry (raw mode, nothing echoed), asked twice, refused when stdin is not a terminal unless `--stdin` (first line of a pipe) is passed. The secret reaches PowerShell by stdin only. `credential status` prints only "set" or "not set"; `credential delete` removes it; `--target NAME` picks another name (must start with `Ujwalam`). Do not use `cmdkey /pass:`: it puts the password on a command line and in shell history. The hidden-entry path itself needs a real terminal and is not covered by automated tests (UNVERIFIED until the user runs it); the `--stdin`, status, delete and refusal paths are tested.

## Alert fixture recorder

For each alert payload received, `<dataDir>/fixtures/alerts/<kind>/<n>.json` where `<kind>` is the E1 kind without the `alert.` prefix (`follow`, `sub`, `resub`, `giftsub`, `raid`, `bits`, `superchat`, `membership`, `redemption`). Wrapper `{event:{source,type}, data}`. Cap 50 per kind. Refuses a directory inside the repository (`fixture-dir-inside-repo`). Not gitignored by a rule because it lives outside the repo; **committing any fixture needs the user's explicit approval after the user has looked at it** (public repo rule).

Anonymiser (allowlist):
- Strings: kept only if the key is allowlisted and the value passes that key's pattern (`subTier`/`tier` in prime|1000|2000|3000, `currency`/`currencyCode` three capitals, `event.source`/`event.type` of the wrapper). Id-like keys (`id`, `*Id`, `login`, `userName`) become `<id>`. All other strings become `<str:LEN>`.
- Numbers: kept only for alert-size keys (bits, amount, cost, viewers, months, counts...). Id-like keys become `<id>`, others `<num>`.
- Object keys: kept only if in a known-key set taken from the docs examples; any other key becomes `<key:LEN>#i` (a payload could be keyed by a login). Booleans and null kept. Depth 8, arrays 50.
- Tests: all string leaves and keys of the output are checked against an allowlist; a 300-case seeded fuzz proves random words placed as values, keys, nested keys and array items never appear in the output; allowlisted keys with non-matching values are shaped.

## Mocks

`tools/mock/mock-streamerbot.mjs`: `node tools/mock/mock-streamerbot.mjs [--port N] [--password P] [--every ms] [--once key,key]`. 127.0.0.1 only, random port by default. Hello (with salt and challenge when a password is set), Authenticate verified with the same hash, events delivered only to clients that subscribed to them, scripted `replay()`, `kill()` (drops sockets, keeps listening), every DoAction recorded and never forwarded. All names and values are invented (not copied from legacy).
`tools/mock/mock-chat.mjs`: seeded chat source (normal, nasty, burst, once) that feeds the mock Streamer.bot, so the real ingest path runs. Legacy POSTed to an engage server; that server does not exist here.

## Commands and output

```
$ node --test tests/event-core-streamerbot*.test.mjs
ℹ tests 36   pass 36   fail 0   skipped 0
$ npm run lint
lint: 0 finding(s), 1 allow marker(s)
$ npm test
ℹ tests 352
ℹ pass 352
ℹ fail 0
ℹ skipped 0
```

New in E2: 36 tests (316 before). Listen CLI against the mock (`--every 150`, no text flag):

```
$ node tools/mock/mock-streamerbot.mjs --port 18094 --every 150 &
$ node services/event-core/cli.mjs listen --url ws://127.0.0.1:18094/ --interval 1000 --duration 3.2 --no-fixtures
[listen] ws://127.0.0.1:18094/ read-only; text hidden; fixtures off
[listen] info: connected
[listen] state=connected received=7 published=6 deduped=0 invalid=0 fixtures=0 reconnects=0
  kick chat.message 1
  twitch alert.follow 1
  twitch chat.message 3
  youtube chat.message 1
...
  skipped: empty-text=2
```

```
$ npm run ci
build              PASS  1.5s
lint               PASS  1.2s
test               PASS  29.4s
test-py            PASS  3.8s
test-ocr           PASS  10.8s
test-capture       PASS  71.0s
validate-registry  PASS  0.4s
validate-outputs   PASS  0.3s
validate-games     PASS  0.4s
private-scan       PASS  0.9s
legacy-verify      PASS  0.4s
bench              PASS  8.0s

ci: 12/12 passed in 128.1s
```

## UNVERIFIED (nothing below has been seen in a real payload)

- Every alert event name and field: Twitch Follow, Sub, ReSub, GiftSub, GiftBomb, Raid, Cheer, RewardRedemption; YouTube SuperChat, NewSponsor, MemberMilestone (names from memory, doc pages failed); Kick Follow, Subscription, Resubscription, GiftSubscription, MassGiftSubscription, RewardRedemption. Specific guesses: `subTier`/`isPrime` for tier, `cumulativeMonths` then `durationMonths` for months, `raider.name`, `bits`, `reward.title`/`reward.cost`/`userInput`, YouTube `amount` + `currencyCode`, `levelName`; GiftSub with `fromCommunitySubGift` skipped so a GiftBomb is counted once; `gifts`/`total` for the bomb count; absent tier means 1000.
- Kick has no raid event in the docs index (so none is subscribed); Kick "KicksGifted" is not mapped to bits.
- Chat roles: numeric `role` 2/3/4 = vip/moderator/broadcaster, badge names, `isSponsor` -> member. Emote shape `{id, name}`. User id for old shape (`message.userId`).
- Authenticate: hashing over UTF-8 of the concatenations; the failure answer shape (the mock answers `{status:"error"}`; the connector treats anything but `status:"ok"`, a timeout or a close as failure). Behaviour with "Enforce" off (only privileged requests need auth) is not tested: the connector always authenticates when Hello asks.
- Docs default port 8080 against a real install; the legacy install used 8093.
- Hello timeout of 5 s against a real server.

## The step the user must run on a real stream

Read only. With Streamer.bot running and its WebSocket server on (Servers/Clients > WebSocket Server), normal stream, chat on:

```
node services/event-core/cli.mjs listen --url ws://127.0.0.1:<port>/ --duration 1800
```

The port is the one Streamer.bot shows: docs default 8080; the legacy install used **8093**. If Streamer.bot has a password, first store it in a terminal (hidden entry, asked twice, never on a command line or in history):

```
node services/event-core/cli.mjs credential set
node services/event-core/cli.mjs credential status    # prints only "set" or "not set"
node services/event-core/cli.mjs credential delete    # when no longer needed
```

Expect `state=connected`, counts per platform and kind every 10 s, and no text or names. Add `--show-text` only if you want to see chat on screen (terminal only, never written). Anonymised alert fixtures go to `paths.event_core_data/fixtures/alerts/` if that is set in `data/profile.local.json`; use `--no-fixtures` to disable. Report back the counts and whether any `skipped` or `invalid` numbers look wrong; real alerts (follow, sub, raid) during the session are what turn the UNVERIFIED rows into verified ones.

## Design choices not in the spec

- Send guard has the mock-marker route (see above) so tests can exercise the DoAction path without setting `sendEnabled`.
- Wait for Hello before Subscribe (legacy subscribed on open); Hello timeout 5 s.
- Auth is attempted only when Hello asks; a close or silence during auth counts as an auth failure (one manual restart if a network drop lands exactly there, never a loop).
- Alerts without a usable user get `displayName "anonymous"` (the E1 model requires a user on alerts); GiftBomb counted once; alerts with unusable numbers are dropped and counted, not guessed.
- Mock events are filtered by subscription, so tests prove the Subscribe object.
- Fixture folder name is the kind without `alert.`; cap of 50 per kind; unknown payload keys are shaped, so a new field name is not visible in a fixture until added to `KNOWN_KEYS` (or passed as `extraAllowedKeys`).
- Listen uses a throwaway in-memory pseudonym key (nothing persisted) and exits with code 2 on `auth-failed`.
- `stop()` emits `system.disconnected` itself (reason `stopped`) and detaches the socket; `start()` can restart after a stop or auth failure.
- Dedupe is live: replaying the same mock message id is counted as `deduped`.

## Files created or changed

Created:

- `services/event-core/streamerbot/map.mjs`
- `services/event-core/streamerbot/auth.mjs`
- `services/event-core/streamerbot/connector.mjs`
- `services/event-core/streamerbot/credential.mjs`
- `services/event-core/streamerbot/anonymise.mjs`
- `services/event-core/cli.mjs`
- `tools/mock/mock-streamerbot.mjs`
- `tools/mock/mock-chat.mjs`
- `tests/event-core-streamerbot.test.mjs`
- `tests/event-core-streamerbot-anonymise.test.mjs`
- `tests/event-core-streamerbot-credential.test.mjs`
- `tests/event-core-streamerbot-cli.test.mjs`
- `docs/evidence/2026-10-28-p3-e2-streamerbot-ingest.md`

Changed after the first report (credential CLI): `services/event-core/cli.mjs` (added `credential set|delete|status`), `tests/event-core-streamerbot-credential.test.mjs` (added a CLI test), this file. No `git add`, no commit, nothing under `legacy/` touched.
