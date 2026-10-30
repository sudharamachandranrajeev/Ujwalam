# 2026-10-28 P3 E3: moderation

Status: built, tests and ci pass. Star parity: 188/188 cases agree with the legacy pipeline.

## What was built

`services/event-core/moderation/`: `text.mjs` (normalise, cleanName), `blocklist.mjs` (load, compile, local overlay), `echo.mjs` (self-echo), `platforms.mjs` (reply limits from data), `index.mjs` (`createModeration` -> `moderate`, `guardReply`, `planReply`, `recordReply`). Wired as a stage in `createEventCore().ingest` (after validate and dedupe, before `bus.publish`).

## Legacy definitions matched (file:line in `legacy/engage/lib/pipeline.mjs`)

| Item | Legacy | Ujwalam |
|---|---|---|
| Zero-width/bidi set | :14 `U+200B-200F, 202A-202E, 2066-2069, FEFF` | same, as escapes |
| C0 + DEL to space | :15, :17-23 (strip, control to space, collapse `\s+`, trim) | `text.mjs` `normalise` |
| cleanName | :63-73: keep `\p{L}\p{N}\p{M}_- .'`, marks run capped at 3, leading marks removed, 22 UTF-16 unit cap then trim, null if empty or matches a dropMessage pattern | `cleanName` |
| Self-echo check | :96-99: key = `normalise(text).toLowerCase()`, text only, no author; hit when `now - recordedAt < 120 s` (strict) | `echo.mjs` |
| Echo record | :247-249: set on reply actually sent; entries older than the window pruned | `recordReply` |
| Bot drop | :101 lowercased display name in dropUser | reason `bot` |
| Blocklist in | :111-113 each dropMessage regex (`i` flag) tested on normalised text, reason `blocked` | reason `blocked` |
| Bad name | :124-125 cleanName null, reason `bad-name` | reason `bad-name` |
| Reply guard | :218-225 order: empty, length > 120, newline, control char, rejectReply regex | `guardReply`, same order, one reason |
| Window default | :97, :248 `echoWindowSec ?? 120`; `engage.config.json` does not set it, so 120 | `policy.echoWindowSec` 120 |
| Regex flags | `state.mjs:53` `new RegExp(p, 'i')` | same |

Legacy refuses an over-long reply; it never truncates. Ujwalam refuses too (reason `too-long`, or `platform-limit`). The 120 cap is legacy engage policy (`policy.replyMaxChars` in the blocklist file); the platform limit applies on top and is counted in code points.

## Blocklist data

Legacy `engage/blocklist.json` was read and checked by hand. It holds generic terms only. No person's name, handle, channel or identifying entry. It was ported by script to `data/moderation/blocklist.json` (schema `blocklist.schema.json`, `version` 1, `source` `legacy`, `ported` 2026-10-28). Content as category counts only:

- dropMessage 62: profanity and slurs 9, self-harm 7, spam and links 10, cheating 5, politics and religion topics 4, insults and harassment 13, personal-info probes 3, prompt-injection phrases 11.
- dropUser 13: well-known public service bot account names.
- rejectReply 12: links, mentions, profanity, call-to-action phrases.

Local overlay: `data/moderation/blocklist.local.json` (gitignored via `*.local.*`; same array keys, all optional, appended to the committed lists; loaded automatically). Put any real handle, name or channel term there only. Parity and tests turn the overlay off.

## Platform reply limits (`replyMaxChars` in `data/platforms/*.json`)

| Platform | Limit | Source | Checked |
|---|---|---|---|
| twitch | 500 | https://dev.twitch.tv/docs/api/reference/#send-chat-message ("limited to a maximum of 500 characters") | 2026-10-28 |
| kick | 500 (and 2048 bytes UTF-8) | https://docs.kick.com/apis/chat ("The `content` limit is 500 characters") | 2026-10-28 |
| youtube | 200 | UNVERIFIED, source `legacy-observed` (legacy Streamer.bot README: YouTube cuts off at 200). No official page states a limit. | 2026-10-28 |
| local | none (null) | ujwalam | 2026-10-28 |

Schema `platform.schema.json` gained optional `replyMaxChars` (existing data stays valid). `tests/outputs/schema.test.mjs` source allow-list gained `docs.kick.com`. Kick's 2048-byte rule is not enforced (500 characters fits except under heavy multi-byte text; proposal below).

## Design choices beyond the spec

1. Chat is dropped on `self-echo`, `bot`, `blocked`, `bad-name` (all legacy drops). Alerts are never dropped: `blocked` text or `bad-name` gives `flag`, and the stage publishes a frozen copy with `message` removed and an unusable display name replaced by `viewer`. The alert is real; only the text is unsafe.
2. Legacy drops for commands, too-short, too-long, emote-only, duplicate and rate gates are engage-bot policy (P13), not moderation. Not built here.
3. Self-echo scope defaults to `global`, the exact legacy behaviour that star parity requires (coordinator decision, E3 close). `echoScope: 'platform'` is an opt-in, NON-PARITY variant: another viewer saying the same words on another platform is then not dropped. Both are tested.
4. Display-name results are cached (2000 entries, oldest evicted) because the Unicode regexes added about 4 us per event (bench `event-core-bus` p50 6.4 us to 10.4 us, flagged as a 62 % regression by the E0 harness); with the cache the bench passes without changing the baseline.
5. `guardReply` control check is stateless. Legacy tests a module-level `/g` regex, so after one refusal a following control-character reply can pass (verified: `guard('a\u0001b')` -> `control-char`, then `guard('\u0001ab')` -> `null`, then again `control-char`). Not ported; the parity tool resets legacy state before each guard call. Listed as a legacy bug below.
6. `moderate` returns extra fields `matched` (pattern indexes, not text) and `cleanName`. `reasons[0]` is the legacy reason.
7. The E1 builder (`model.mjs` `cleanString`) now replaces each control character with a space, and when one was present collapses whitespace runs and trims, as legacy `normalise` does. Moderation therefore sees `a b` for an embedded newline, tab or CR. The validator and schema still reject control characters. E1 tests and the E1 evidence line were updated.
8. Dedupe runs before moderation: a duplicate of a dropped message is `deduped`, not re-audited.

### Audit of dropped events (proposed, not built)

Built: `createEventCore({ onVerdict(event, verdict) })` is called for every `drop` and `flag` with the original (unredacted) event. Dropped events do NOT reach normal bus subscribers. Proposal for E5: the audit store subscribes via `onVerdict` (synchronous, off nothing on the hot path, so it must only enqueue to the E5 batch writer), stores action, reasons, `matched` indexes, pseudoId, kind and timestamps, and keeps raw text only under the 30-day retention rule (decision 6). Not built: a separate bus topic, persistence, any UI.

## Gaps proposed, not built (legacy matches fewer evasions)

- Separators and spacing: `f u c k`, `f.u.c.k` pass (tested as parity).
- Soft hyphen U+00AD and word joiner U+2060 are not stripped by normalise; `f­uck` passes.
- C1 controls U+0080-009F are not handled by legacy normalise (the E1 builder replaces them with spaces upstream).
- Look-alike letters (Cyrillic/Greek homoglyphs, dotless i) and leetspeak beyond the few `[i1]`/`[a4]` patterns.
- cleanName slices at 22 UTF-16 units and can cut a surrogate pair or split a base from its marks.
- Name check uses only dropMessage regexes (so a name matching a bot-name list is not checked).
- Legacy `/g` regex state bug in `guard` (see above).
- Kick 2048-byte rule; YouTube limit needs a verified source.
- Event `moderation` field in event v2 so subscribers can see a flag verdict (today only `onVerdict` sees it).

## UNVERIFIED

- YouTube `replyMaxChars` 200 (no official page states it).
- Windows file-ACL and live behaviour of Streamer.bot reply paths: not exercised; no message was sent to any platform.

## Parity (star)

Tool: `tools/parity/moderation-parity.mjs`. Imports legacy `lib/pipeline.mjs` and `lib/state.mjs` read only (no import side effects, no shim needed). Inputs are invented strings and names. `logs/` and `memory/` are never opened. Fixture: `tests/fixtures/moderation/parity.json` (`generatedFrom`: pipeline.mjs sha256 and blocklist hashes). Normal test `tests/event-core-moderation-parity.test.mjs` needs no `legacy/`, and also checks that the committed blocklist lists hash-equal the legacy ones.

```
$ node tools/parity/moderation-parity.mjs
group      cases  agree
normalise     22     22
cleanName     24     24
blockIn       60     60
guard         34     34
pathText      11     11
pathBlock     14     14
pathEcho       7      7
echo          16     16
TOTAL        188    188  PASS
generatedFrom pipeline.mjs sha256 c92f509ee4e0b5041ff2ca5f0951c6f6f6bd28de3e5982421f70f4ead968f642
fixture written: tests\fixtures\moderation\parity.json
```

Covers: blocklist in (36 blocked, 5 bot, 2 bad-name, 17 pass), guard/blocklist out (13 blocklist, others by check), self-echo at 0, 1, 119.999, 120.000, 120.001 and 600 s plus case, spacing, zero-width and other-author variants, cleanName and normalise (Malayalam, Hindi, Tamil, mark stacking, bidi, zero-width, emoji).

## Commands and results

```
$ npm run lint
lint: 0 finding(s), 1 allow marker(s), in 1.0s
$ npm test
ℹ tests 408  ℹ pass 408  ℹ fail 0  ℹ skipped 0
$ npm run ci
build PASS, lint PASS, test PASS, test-py PASS, test-ocr PASS, test-capture PASS, validate-registry PASS,
validate-outputs PASS, validate-games PASS, private-scan PASS, legacy-verify PASS, bench PASS
ci: 12/12 passed in 130.0s
```

New tests: 52 (E3 suites unchanged in count); E1 model test updated (`event-core-moderation-text` 14, `event-core-moderation` 31, `event-core-moderation-parity` 7). Bench baseline was not changed (no `--accept`).

## Files created or changed

Created:
- `data/moderation/blocklist.json`, `data/moderation/blocklist.schema.json`
- `services/event-core/moderation/{text,blocklist,echo,platforms,index}.mjs`
- `tools/parity/moderation-parity.mjs`, `tools/parity/moderation-ujwalam.mjs`
- `tests/fixtures/moderation/parity.json`
- `tests/event-core-moderation.test.mjs`, `tests/event-core-moderation-text.test.mjs`, `tests/event-core-moderation-parity.test.mjs`
- `docs/evidence/2026-10-28-p3-e3-moderation.md`

Changed:
- `services/event-core/index.mjs` (moderation stage, `onVerdict`, `status: 'dropped'`, `moderation` handle, `moderated` stat)
- `data/platforms/{platform.schema,twitch,youtube,kick,local}.json` (`replyMaxChars`)
- `tests/outputs/schema.test.mjs` (allow `docs.kick.com` as an official source)
- `services/event-core/model.mjs` (control characters become spaces, whitespace collapsed when one was present), `tests/event-core-model.test.mjs`, `docs/evidence/2026-10-28-p3-e1-event-model.md`
- `services/event-core/moderation/{echo,index}.mjs` (`echoScope` default `global`)
- `data/platforms/youtube.json` (source `legacy-observed`, still UNVERIFIED) and `data/platforms/platform.schema.json` (the unverified variant may carry `source` and `checked`); `tests/outputs/schema.test.mjs` also allows `legacy-observed`
- Parity: `tools/parity/moderation-ujwalam.mjs`, `tools/parity/moderation-parity.mjs`, `tests/fixtures/moderation/parity.json` regenerated (new groups pathText 11, pathBlock 14, pathEcho 7: raw newline, tab, CR through build then moderate)
