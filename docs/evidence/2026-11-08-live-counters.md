# Live audience counters (P5 target layout, D250)

Date: 2026-11-08. Status: tests pass against the mock Streamer.bot; real Streamer.bot answer shape UNVERIFIED; not yet
used on a real stream. Flag `live-counters`, default off.

## Why this design

- User choice (2026-11-08): counts come through the existing Streamer.bot connection, no new platform tokens.
- Streamer.bot's WebSocket requests (https://docs.streamer.bot/api/websocket/requests, read 2026-11-08) include no
  follower or subscriber count. They include `GetGlobal` / `GetGlobals` (read global variables).
- So the counts live in persisted Streamer.bot globals that the user's own Streamer.bot action keeps current, and
  Ujwalam only reads them. Ujwalam's Streamer.bot connection stays read-only (AGENTS.md).
- Legacy counters were fixed numbers in `legacy/brand/brand.config.js` ("static until a live data source is wired up").

## What was built

- `services/event-core/model.mjs`, `schema/event.schema.json`: event kind `system.counter`
  `{ platform, counter: followers|subscribers, value: 0..1e9 }` (no user: a total, not a person).
- `services/event-core/streamerbot/connector.mjs`: `readGlobal(name)`: `GetGlobal` with `persisted: true`;
  `null` when not connected, missing or not ok. The answer shape is UNVERIFIED (accepts `variable.value` or `value`).
- `services/event-core/counters.mjs`, `data/counters.json`: polls every 60 s while the flag is on, publishes on change;
  numbers and digit strings only; a follow alert adds 1 to a known count; an unknown count is never guessed.
- `services/event-core/api/service.mjs`: started with the Streamer.bot connector; any failure leaves it off.
- `services/overlay-server/index.mjs`, `static.mjs`: counter cache from the bus; `/_ujwalam/counters.json`
  (`{ on: false }` while the flag is off). Overlay child and CLI subscribe to `system.counter` too.
- `services/overlay-server/event-source.mjs`: the remote bus now honours each subscriber's `kinds` (before, every
  handler got every event: a counter event would have reached the cam-pop chat rule).
- `services/overlay-server/pages/ujwalam-counter/`: plain script, textContent only, no remote loads, fits the text to
  the box, 300 ms scale pulse on a change, no flashes.
- `registry/presets/scene-default-h.json`, `scene-default-v.json` (0.3.0): the Twitch and YouTube counter layers use
  the new page (`label=Twitch&noun=Followers`, `label=YouTube&noun=Sub`); V boxes are one text line (h 0.03).
- `tools/mock/mock-streamerbot.mjs`: `GetGlobal`, `setGlobal()`, `globalReads`.

## Evidence

```
node --test tests/event-core-counters.test.mjs
ℹ pass 9
ℹ fail 0

node --test tests/event-core-*.test.mjs tests/overlay-server*.test.mjs tests/test-broadcast.test.mjs tests/flags.test.mjs tests/project-scene-preset*.test.mjs tests/studio-ui-alpha.test.mjs tests/hud-zones.test.mjs
ℹ pass 483
ℹ fail 0
```

## User setup (Streamer.bot, once)

Create persisted global variables `ujwalam_twitch_followers`, `ujwalam_youtube_subscribers` and
`ujwalam_kick_followers`, kept current by a Streamer.bot action of yours (for example on a timer and on follow).
Which Streamer.bot sub-actions read the platform counts is UNVERIFIED here. Then turn on `live-counters`.

## Open

- Real `GetGlobal` answer shape and a real stream run.
- A follow that the Streamer.bot action already counted, arriving just after a read, shows +1 until the next read
  (at most 60 s).
- YouTube has no live subscribe alert mapped, so YouTube changes show at the next read only.

## Files

- `services/event-core/{model.mjs,schema/event.schema.json,counters.mjs,streamerbot/connector.mjs,api/service.mjs}`
- `services/overlay-server/{index.mjs,static.mjs,event-source.mjs,cli.mjs,pages/ujwalam-counter/}`, `app/host/overlay/child.mjs`
- `data/counters.json`, `data/flags.json`, `registry/presets/scene-default-{h,v}.json`, `tools/mock/mock-streamerbot.mjs`
- `tests/event-core-counters.test.mjs`, `tests/event-core-model.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D250), `docs/evidence/2026-11-08-live-counters.md`, handover
