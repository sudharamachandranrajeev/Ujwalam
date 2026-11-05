# v1 effect guards and cam-pop rule (F4/F5)

Date: 2026-10-30. Agent A. Status: guards and rule implemented and tested against a fake clock. The measured flash rate (`fx test`) is NOT done: it needs the host's rendered frames. See "Open hook".

## What was built

- `data/effects/guards.json`: all numbers as data. Each carries a source and a status (`legacy`, `settled`, `unverified`).
- `services/overlay-server/guards.mjs`: `createEffectGuards`, `createPool`, `mulberry32`, `validateGuardConfig`, `loadGuardConfig`. The bridge's `effectGate(effect)` is `guards.gate`.
- `services/overlay-server/campop-rule.mjs`: the cam-pop trigger rule. It decides when to pop and fires `campop` through the same gate.
- Bridge: pages loaded with a feed path `/effects/<name>` get chat envelopes only when the gate admits that effect, so chat-driven effects (charge, storm) share the budget. Admitted effects released from the queue are sent with `deliverEffect`.
- `cli.mjs`: guards on by default, `--no-guards` to turn them off.

## Gate order

1. Unknown or malformed effect name: refused (fail closed).
2. `busy`: the same effect is still running (inclusive of its end tick). The same effect is never queued twice.
3. `cooldown`: counted from the END of the previous play (legacy behaviour).
4. `budget`: one rolling per-minute budget shared by effects and event-driven animated layers.
5. Region overlap with a running play: a higher-priority incoming effect cuts a running play only if that play is `interruptible`; otherwise the incoming effect's `onOverlap` applies (`drop` gives `region-busy`; `queue` gives `queued`, bounded, priority first then arrival order, dropped as `queue-expired` after the ttl or `queue-full`). Plays never stack.
6. `flash-limit`: per canvas, at most 3 flashes in any 1000 ms window, counting already scheduled flashes plus the new play's declared flash offsets. A reported measured rate above the limit also blocks.

Every decision (allow, refuse, queue, release, drop, preempt) is counted by reason and by effect, kept in a ring, and sent to the audit as subtype `effect-guard` with token-only fields. Free-text sources become `unknown`. No chat text is read or stored.

## Legacy values copied (file:line inside the gitignored legacy folder)

| Effect | Duration ms | Cooldown ms (from end) | Source |
|---|---|---|---|
| gg | 2400 | 1500 | overlays/gg-burst/index.html:60-61,122-124 |
| charge | 620 | 900 | overlays/chat-charge/index.html:84-85,294 |
| storm | 750 | 250 | overlays/chat-storm/index.html:128-129,1149 |
| campop | 5000 | 0 | tools/cam-pop.json:3-4 |

Legacy overlays only drop while busy or cooling down. They never queue, never share a budget and cannot be stopped, so `onOverlap: drop` and `interruptible: false` for them match legacy.

Cam-pop rule values (tools/cam-pop.json and tools/cam-pop.mjs): every chat message triggers (:224); burst of 5 messages in 10 s (:225-231); mic level at or above 0.12 held 150 ms (:243-250); random check each minute with chance 1/12 (:252-255); minimum gap 0 (:186-189); a trigger during a pop is dropped (:153). Camera region is the default camera rect from overlays/cam-pop-frame/index.html:197, normalised.

## UNVERIFIED proposals (legacy has no such rule; user to confirm; see decisions D76 to D82)

- Budget 30 effects per minute, queue max 8 with 3000 ms ttl.
- Priorities: campop 80, gg 70, storm 40, charge 20.
- Regions `edge`, `center` (extent approximated from the legacy CSS); `full` and `camera` are from legacy.
- Flash offsets: charge `[0]`, storm `[0]` (one flash at play start); gg and campop none. Not measured.
- gg uses `queue` on overlap; the others `drop`.
- Pool `hype`: gg 3, storm 2, charge 1, no-repeat-last 1.
- The mic level scale: the legacy 0.12 was measured on the legacy mic reader; the host meter must match.

## Cam-pop parity capture

Method: a private copy of the legacy cam-pop tool and its libraries was run from a scratchpad folder (legacy itself was not run or modified), in dry-run mode against the legacy mock Meld and mock Streamer.bot on loopback, with voice and random off, one sample per 1000 ms. Two runs: chat-message trigger on, and off (burst only). Fixture: `tests/fixtures/overlays/campop-legacy.json`. Resolution is one second. Legacy counted a whitespace-only sample as a chat message.

Result: the Ujwalam rule through the gate admits pops at exactly the legacy times: run 1 at +0, +11 s, +22 s; run 2 at +4, +14, +24 s. Voice and random triggers are covered by unit tests only (not captured from legacy).

## Open hook (not faked)

Update 2026-11-05: the `fx test` part is done. See `docs/evidence/2026-11-05-f4-measured-flash.md`. The mic-level part below is unchanged by that update.

TODO(host): `fx test` must render each flashing effect on the host, measure flash rate from rendered-frame luminance per canvas, and call `guards.reportMeasuredFlashes({effect, canvas, flashesPerSecond})`. Until then the flash limit rests on the declared offsets only, which are UNVERIFIED. Also TODO(host/P8): feed `onMicLevel` from the host meter.

## Tests

`node --test tests/effect-guards.test.mjs tests/overlay-server.test.mjs`: 52 tests, 52 pass (30 new). Covered: config validation (flash above 3 refused), cooldown from end and busy, unknown names, shared budget across kinds, region drop, queue release by priority, ttl expiry and queue-full, preemption of interruptible plays only, flash limit 3 per second per canvas and per play, measured-rate block, seeded pool reproducibility, no-repeat-last-N, weights, audit rows (token-only, no text, audit failure never breaks the gate), cam-pop parity for both runs, voice hold, seeded random, min gap, and the bridge (publishEffect through the gate, `/effects/<name>` chat gating, token not in audit).
`npm run lint`: 0 findings.

## Files

Created: `data/effects/guards.json`, `services/overlay-server/guards.mjs`, `services/overlay-server/campop-rule.mjs`, `tests/effect-guards.test.mjs`, `tests/fixtures/overlays/campop-legacy.json`, this document.
Changed: `services/overlay-server/bridge.mjs`, `services/overlay-server/index.mjs`, `services/overlay-server/cli.mjs`, `docs/plan/2026-10-29-v1-decisions.md` (D76 to D83 appended).
