# P3 E1: event model and in-process bus (2026-10-28)

Result: **PASS** for the E1 "Done when" (schema tests). No network, no Streamer.bot (that is E2). Machine: 12th Gen Intel Core i7-12650H, 16 logical cores, Windows 11 Pro 10.0.26200, node v26.12.1, AC power.

## What was built

| Item | File |
|---|---|
| Model: constants, per-kind field table, id generator, pseudonym, construction | `services/event-core/model.mjs` |
| JSON Schema, draft 2020-12 | `services/event-core/schema/event.schema.json` |
| Hand-written stdlib validator | `services/event-core/validate.mjs` |
| Data dir resolution and pseudonym key file | `services/event-core/config.mjs` |
| Dedupe | `services/event-core/dedupe.mjs` |
| Bus with bounded per-subscriber queues | `services/event-core/bus.mjs` |
| Pipeline `createEventCore().ingest()` | `services/event-core/index.mjs` |
| Bench | `tools/bench/benches/event-core-bus.mjs` |
| Tests | `tests/event-core-model.test.mjs`, `tests/event-core-bus.test.mjs` |

## Event v1

Common fields: `v` (1), `id`, `kind`, `platform` (`twitch|youtube|kick|local`), `source` (`streamerbot|mock|api|rule|system`), `platformMessageId` (string or null), `receivedAt`, `mono`. Chat and alert events add `user { pseudoId, platformUserId|null, displayName, roles[] }`. System events have no `user` (the schema and validator reject one). Roles: broadcaster, moderator, vip, subscriber, member, follower, viewer (closed enum, at least one, unique, stored in that order, default `["viewer"]`).

| kind | extra fields (R = required) |
|---|---|
| `chat.message` | `text` R (1-500), `emotes` (<= 50 of `{id, name}`) |
| `alert.follow` | none |
| `alert.sub` | `tier` R (`prime|1000|2000|3000`), `message` |
| `alert.resub` | `tier` R, `months` R (1-1200), `message` |
| `alert.giftsub` | `tier` R, `count` R (1-10000); user = gifter |
| `alert.raid` | `viewers` R (0-10 000 000); user = raider |
| `alert.bits` | `amount` R (int 1-10 000 000), `message` |
| `alert.superchat` | `amount` R (> 0, <= 1e9), `currency` R (`[A-Z]{3}`), `message` |
| `alert.membership` | `tier` (free text 1-64), `months` |
| `alert.redemption` | `reward` R (1-100), `cost` (int >= 0), `message` |
| `system.connected` | `target` R (1-64) |
| `system.disconnected` | `target` R, `reason` (<= 200) |
| `system.livestate` | `live` R (bool) |
| `system.panic` | `reason` (<= 200) |

Optional fields are omitted when absent; null is not allowed for them. No other keys are allowed (`unevaluatedProperties: false` in the schema, "unknown field" in the validator), so a raw platform payload cannot ride along. The builder drops every input key that is not in the table.

### Formats

- **id** `e` + 12 hex (wall ms, never goes backwards) + `-` + 8 hex (counter inside that ms) + `-` + 8 hex (random per-generator nonce). Always 31 chars; string comparison sorts by creation order for one generator. Across generators it sorts by ms then counter then nonce.
- **mono** `performance.now()` in ms rounded to 3 decimals; origin = process start. Non-decreasing (ties possible), unaffected by wall-clock changes, comparable only inside one process run. `receivedAt` is the wall time (`YYYY-MM-DDTHH:MM:SS.mmmZ`, regex with month, day, hour, minute, second ranges; not a leap-day or month-length check, in both schema and validator).
- **Length caps** (code points): text and every `message` 500, displayName 64, platformUserId 64, platformMessageId 128, emote id/name 64, reward 100, membership tier 64, target 64, reason 200, emotes 50 per message.
- **Control characters** (U+0000-001F, U+007F, U+0080-009F): **replaced by a space** at construction; when one was present, whitespace runs are collapsed and the ends trimmed, as legacy `normalise` (changed in E3 so moderation sees `a b`, not `ab`). The validator and the schema **reject** them. Over-long strings are **truncated** at construction (never split a surrogate pair); the validator rejects over-long ones. Bidi and zero-width marks are left alone (E3).
- **pseudoId** first 32 hex chars (128 bits) of `HMAC-SHA256(key, platform + ":" + platformUserId)`. Key: 32 random bytes in `<dataDir>/pseudo.key`, created once with `wx` (no overwrite), reused afterwards; a wrong-sized file is an error and is never replaced.
- **Key protection**: POSIX mode 0600. On Windows mode bits do nothing, so the file gets `icacls /inheritance:r /grant:r <current user>:(F)`; the result is reported as `protection` (`acl` | `acl-failed`). Verified 2026-10-28: `loadKey` on a fresh scratch dir returned `protection: acl`, and `icacls <dir>\pseudo.key` listed exactly one entry, `<host>\<user>:(F)`, with no inherited entries. An administrator can still take ownership (not testable as a user).
- **Data dir**: `dataDir` option, else `paths.event_core_data` in `data/profile.local.json` (read for that key only; relative values resolve against the repo root), else an error. A `<placeholder>` value counts as unset. Placeholder key added to `data/profile.example.json`; `data/profile.local.json` untouched (the user sets the value).
- **Dedupe** key `(platform, platformMessageId)`; window 120 000 ms (monotonic, from the first sighting, repeats do not extend it) and at most 10 000 entries (oldest evicted); both configurable. No id: never deduped, counted as `noPlatformId`. Memory only; behaviour across a restart is decided in E5/E7 (UNVERIFIED until then).
- **Bus** per-subscriber queue, default 1000, configurable per subscriber. Overflow drops the oldest queued event for that subscriber and counts it. `publish` never waits on a handler; handlers run in a microtask, one at a time per subscriber, in order. A throwing or rejecting handler is counted in `errors`. Filter = list of kind prefixes (`startsWith`), none = all. Counters: `published`; per subscriber `matched`, `delivered`, `dropped`, `errors`, `queued`; core adds `deduped`, `noPlatformId`, `invalid`.

## Tests

```
$ npm run lint
lint: 0 finding(s), 1 allow marker(s), in 0.8s
$ npm test
ℹ tests 316
ℹ pass 316
ℹ fail 0
ℹ skipped 0
```

New in E1: 34 (19 model, 15 bus/dedupe/core); 282 before. Covered:

- Schema (ajv 2020, strict, dev dependency, tests only) and the hand-written validator agree on: a valid event of each of the 14 kinds; more than 250 hand-made invalid cases (per-kind mutations: missing/extra/wrong-typed fields, caps, control chars, enum values, user rules, system-with-user); boundary valid values; and 4000 seeded random mutations.
- Ids: 100 000 in a burst are unique, 31 chars, already sorted; clock stepping back keeps order; two generators in the same ms differ.
- mono non-decreasing across 20 000 events. Caps by code points. Control chars replaced by spaces, forged ones rejected. No raw payload kept. Frozen events.
- pseudoId stable per (platform, user), different across platform, user and key. Key file created once, reused, wrong size refused. Data dir resolution (option, profile, placeholder, none).
- Dedupe: by platform, by time, window not extended by repeats, by count, no-id counted. Bus: order, filters, stuck subscriber drops oldest without blocking others or the publisher, handler errors, unsubscribe, counters. Core: end-to-end counters and delivery order.

## Benchmark

`tools/bench/benches/event-core-bus.mjs`, budget `PB-12` (event core internal; the row stays UNVERIFIED until E7 measures ingest to dispatch). It times 5000 synthetic events (labelled synthetic in the file) through construct + validate + dedupe + publish to 3 subscribers; delivery is awaited after the batch and not timed.

```
$ npm run bench -- --calibrate
bench: calibrated private-scan-worktree-wall.wall_ms: n=10 mean=864.809 stddev=31.899 minDelta=95.697 ms
bench: calibrated registry-validate-wall.wall_ms: n=10 mean=157.026 stddev=2.949 minDelta=8.848 ms
bench: calibrated event-core-bus.p50_ms: n=10 mean=0.007 stddev=0.001 minDelta=0.003 ms
bench: calibrated event-core-bus.p95_ms: n=10 mean=0.009 stddev=0.004 minDelta=0.011 ms
$ npm run bench
bench: event-core-bus.p50_ms = 0.01 ms
bench: event-core-bus.p95_ms = 0.01 ms
bench: private-scan-worktree-wall.wall_ms = 852.12 ms
bench: registry-validate-wall.wall_ms = 156.12 ms
bench: PASS
```

Baseline stored from this run (5 samples, medians): p50 0.0064 ms, p95 0.0081 ms per event, AC power, system CPU 6.3 % before and 9.8 % during (not noisy). That is about 6 us per event, far under the PB-12 p95 <= 20 ms, but that budget covers the whole ingest to dispatch path, so it is not replaced here. At this scale the timer resolution and one-off GC pauses matter: the calibration stddev of p95 (0.004 ms) is about half its mean, so minDelta (0.011 ms) is larger than the p95 value itself and the 10 % flag effectively only catches large slowdowns for these two metrics. The private-scan calibration moved (stddev 8.3 -> 31.9 ms, minDelta 24.9 -> 95.7 ms) compared with E0 even on a quiet machine, so calibration is not very stable across runs (UNVERIFIED why). `out/bench/calibration.json` was overwritten by this run.

## Full CI

```
$ npm run ci
build              PASS  1.4s
lint               PASS  1.1s
test               PASS  28.6s
test-py            PASS  4.0s
test-ocr           PASS  10.8s
test-capture       PASS  71.1s
validate-registry  PASS  0.4s
validate-outputs   PASS  0.3s
validate-games     PASS  0.4s
private-scan       PASS  0.9s
legacy-verify      PASS  0.3s
bench              PASS  8.0s

ci: 12/12 passed in 127.4s
```

## Design choices not in the plan

- Events are deep-frozen; subscribers share one object and cannot mutate it.
- `ingest()` returns `{status: published|deduped|invalid, event?, errors?}` and never throws on bad input; invalid events are counted, not published.
- System events carry no `user`. Alerts carry the acting user (gifter, raider).
- Roles default to `["viewer"]`; unknown roles are kept by the builder so the validator rejects them.
- A missing `platformUserId` yields a pseudoId from `platform:name:<lowercased displayName>` (stable but weaker; documented).
- Truncate over-long strings at construction instead of rejecting the event.
- Duplicates are detected after validation; a duplicate still consumes an id.
- Subscriber names must be unique (they key the counters).
- The schema `$id` uses the reserved `.invalid` domain; nothing is fetched.
- `mono` rounded to 3 decimals; membership `tier` is free text while sub tiers are an enum.

## UNVERIFIED

- Key creation race between two processes (relies on the `wx` flag, not tested with two processes).
- Field mapping from real Streamer.bot payloads (E2): emote shape `{id, name}`, sub tiers, bits/superchat fields may need adjusting.
- Dedupe across restart (E5/E7). PB-12 end to end (E7).
- Bench noise at the 6 us scale (see above).

## Files created or changed

Created:

- `services/event-core/model.mjs`
- `services/event-core/validate.mjs`
- `services/event-core/config.mjs`
- `services/event-core/dedupe.mjs`
- `services/event-core/bus.mjs`
- `services/event-core/index.mjs`
- `services/event-core/schema/event.schema.json`
- `tools/bench/benches/event-core-bus.mjs`
- `tests/event-core-model.test.mjs`
- `tests/event-core-bus.test.mjs`
- `docs/evidence/2026-10-28-p3-e1-event-model.md`

Changed:

- `data/profile.example.json` (placeholder `paths.event_core_data`)

Ignored output: `out/bench/` (baseline and calibration, gitignored). `package.json` unchanged (`tests/*.test.mjs` glob already covers the new tests).
