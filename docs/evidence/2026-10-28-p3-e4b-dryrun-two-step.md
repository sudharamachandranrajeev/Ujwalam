# 2026-10-28 P3 E4b: chat dry-run and two-step on-air confirmation

User decisions of 2026-10-28. Code: `services/event-core/livelock/{gate,catalogue,index}.mjs`, `services/event-core/audit/index.mjs`
(`recordDecision`), `data/actions/catalogue{,.schema}.json`. Tests: `tests/event-core-dryrun-twostep.test.mjs` (new), plus
updates to the E4 and idempotency tests listed at the end. All test text is invented. Chat text is never in this file.

## 1. Dry-run for chat-triggered actions

### Design

| Item | Value |
|---|---|
| New catalogue field | `chatMode`: `off` \| `dry-run` \| `on` (schema enum has all three). Omitted means `off`. |
| `chatAllowed` | Unchanged. It is whether chat may ever trigger the action (deny categories force it false). `chatMode` is the rollout state. |
| `on` | Refused at load for every action: `chatMode "on" is not permitted: lost-action gap must be closed first (plan 2026-10-28-p3-plan.md, Blockers before C2/C3)`. Enforced in `buildCatalogue`, so it covers the file, a parsed document and a Map. |
| Deny categories | `chatMode` must be `off` on them (load error otherwise). Dry-run never widens what chat may do. |
| Committed file | `chatMode: "dry-run"` on the 14 non-deny actions, `"off"` on the 14 deny-category ones. `chatAllowed` is still false everywhere (owner default, not changed), so in the committed catalogue chat is still refused with `chat-not-allowed`. Opening an action for dry-run needs both `chatAllowed: true` and `chatMode: "dry-run"`; that is a rule change for the user (open question 1). |
| Gate order for a chat-tainted request | bad shape / unknown / bad params, then panic, then deny category (`chat-forbidden`), then `chatAllowed` false (`chat-not-allowed`), then `chatMode` not dry-run (`chat-off`), then dry-run. Nothing before the dry-run step changed. |
| Dry-run answer | `{ verdict: 'dry-run', reason: 'chat-dry-run' }`. No `dispatch`, no `confirm`. The executor is not called, so there is no idempotency claim and no `started` marker (nothing becomes "ambiguous" after a restart). |
| Resend | The gate remembers the idempotency key of each recorded dry run (memory, 4096 keys). A repeat gets `{ verdict: 'dry-run', reason: 'dry-run-duplicate' }` and no second audit row; counted in `gate.state().dryDuplicates`. After a restart the persistent bus dedupe is the guard, as for every other event; a resend that gets past it records one more row (harmless: nothing executes). |
| Request field `ruleId` | Optional rule label (`^[a-z][a-z0-9._-]{0,47}$`), kept for the audit `rule_id` even when the actor is a pseudonymous viewer id. Anything else is dropped. |

### Audit row (hash-chained `audit` table)

```
type=decision subtype=request source=rule|chat verdict=dry-run reason=chat-dry-run
action_id=<action id>  rule_id=<ruleId or null>  pseudo_id=<32 hex pseudoId>  event_id=<e-id>  ts=<ISO>
detail={"tainted":true,"kinds":[...],"eventIds":[...],"liveState":"...","panic":false,
        "dryRun":true,"wouldDecision":"allow","wouldClass":"on-air-write","wouldTarget":"effect"}
```

What the gate decided is `wouldDecision` (always `allow`: refusals are normal `refuse` rows with their reason, which already
carry action, source, pseudo id and time). What would have executed is the action id plus `wouldClass` and `wouldTarget`.
No params, no chat text, no display name, no platform user id (`sanitise.mjs` patterns still guard every field).

### Retention

`audit` rows are append-only and outside the purge: the purge deletes from `chat_raw` only. Test "dry-run rows survive the raw-chat
purge" runs `purge({ all: true })` (every raw row, whatever its age), then re-reads the row (same action, rule, pseudo id, ts,
hash), then `verify()` (chain ok), then reopens the database and runs the startup purge path again.

### Tests (new file, all pass)

- catalogue: schema enum; committed file has only `off`/`dry-run`; omitted = off.
- `on` refused for each of the 28 actions with the blocker text; also via `createActionGate`, a Map, and `createEventCore`; bad values (`'ON'`, `true`, `1`, `null`, `''`) refused; dry-run refused on every `DENY_SET` id.
- chat event triggers an action: nothing executes, answer has no dispatch, exactly one audit row with exactly the permitted fields, no chat text, name or platform id in it (real core + audit database).
- forbidden actions are still refused, not logged as allowed: every `DENY_SET` id gives `chat-forbidden`; `chatAllowed` false gives `chat-not-allowed`; `chatMode` off gives `chat-off`; panic gives `panic`; a rule chain with chat provenance is dry-run, never executed; an untainted hotkey rule still gets a confirmation.
- idempotency: a resend of the same platform message gives `dry-run-duplicate`, one row, still nothing executed.
- purge keeps the rows and the chain verifies.

## 2. Two-step on-air confirmation while live

### Design

| Item | Value |
|---|---|
| Applies to | `class: on-air-write` when the effective live state is `live` or `unknown` (unknown counts as live). Other writes while live keep one `yes, on air`. Offline keeps one `yes`. Panic-clear is unchanged. |
| Step 1 | `actions.request` returns `confirm: { confirmId, phrase: 'yes', step: 1, of: 2, actionHash, expiresAt, liveStateAtRequest }`. |
| Step 2 | Sending step 1 correctly runs nothing and returns `{ verdict: 'confirm', reason: 'second-confirmation-required', confirm: { confirmId (new), phrase: 'yes, on air', step: 2, of: 2, actionHash, expiresAt } }`. Sending step 2 correctly dispatches. |
| Timeout | **30 s per step** (`DEFAULT_STEP_TTL_MS`, option `stepTtlMs`). Step 2's 30 s starts when step 1 is accepted. The single-step TTL stays 60 s. |
| Single use | Every confirmId is spent by any attempt that reaches the checks (right or wrong); step 1's id is spent when step 2 is issued. Replays report `replayed`. |
| Hash binding | Step 1: `sha256(canonical{ id, params, source, actor, phrase:'yes', step:1, epoch })`. Step 2: `sha256(canonical{ ..., phrase:'yes, on air', step:2, epoch, prev: <step 1 hash> })`. `epoch` is the live-state epoch. The hash of every single-step confirmation is unchanged (step, epoch and prev are only added when set). The gate keeps params in memory; a hash for another action or params does not match. |
| Order | Step 2 does not exist until step 1 is accepted, unexpired, in the same epoch, and from an allowed source. A step-1 id given `yes, on air` gets `wrong-phrase` and is spent. Step 1's phrase or hash on step 2 gets `wrong-phrase`/`hash-mismatch` and spends step 2. "Step 2 expires if step 1 expired": an expired step 1 gives `expired` and no step 2 is ever issued; step 2 then has its own 30 s. |
| Same source | Step 2 must be confirmed by the same source (`ui` or `api`) as step 1: `step-source-mismatch`. |
| Chat | `confirm()` refuses `source: chat/rule/remote/system` (`source-not-permitted`) and any `ctx.provenance` that is chat-tainted, unknown kind or unreadable (`tainted-confirmation`). Neither refusal spends the pending step (chat cannot burn a user's confirmation). |
| Live change | Any epoch change, or a state different from the one at issue, between or before steps gives `live-state-changed`, which invalidates both. Panic clears pending steps (`unknown-confirm`). |
| Audit | `confirm-issued` (step 1), `confirm-accepted` reason `step-1-accepted` (step 1), `confirm-issued` (step 2, reason `second-confirmation-required`), `confirm-accepted` reason `confirmed` (step 2). Detail carries `step`, `actionHash`, `confirmingSource`. |
| Quota | Per-source pending cap unchanged; step 2 replaces step 1 in the same slot. |

### Tests

New file (all pass): happy path; unknown = live; non-on-air write stays one step; offline one step; 30 s expiry of each step with the
29 999 ms boundary; skip step 1 (wrong phrase, spent, no guessable step-2 id); replay of step 1 and step 2; wrong order and wrong
hash; rebind to other action/params (three concurrent requests); params mutation after request; hash recipe (step, epoch, prev);
same-source rule; live change before, between (four flip paths) and stale; panic between; chat source and provenance (nine
variants, step not spent, clean hotkey provenance accepted); audit order; quota; two steps over the idempotent executor with a
client key (second identical key skipped).
E4 invariant matrix (`tests/event-core-livelock-matrix.test.mjs`) extended: R3 now states two steps for on-air writes while live;
new R9 (a chat-tainted request is never `allow`, and `dry-run` only where the data and the rules permit, never with a dispatch);
R4 enumerates both steps for every on-air action x live/unknown x confirmer source (main matrix: 6384 cases, unchanged count; its max-open variant now sets `chatMode`); new test for an epoch flip between step 1 and step 2.

## 3. Commands and output

```
$ node --test tests/event-core-dryrun-twostep.test.mjs tests/event-core-livelock.test.mjs tests/event-core-livelock-matrix.test.mjs \
    tests/event-core-livelock-review.test.mjs tests/event-core-idempotency.test.mjs tests/idempotency-crash.test.mjs
matrix cases: 6384 (2 catalogues x 28 actions x 19 sources x 3 live states x 2 panic)
ℹ tests 99
ℹ pass 99
ℹ fail 0

$ npm run lint        -> 2 findings, both in docs/evidence/2026-10-28-p3-e7-bench-isolation-dodges.md (user-path, another agent's file); none in this change
$ npm test            -> tests 656, pass 649, fail 7
```

The 7 failures are in files owned by the parallel agents, not this change: `tests/event-core-failclosed.test.mjs` (3: `rule: on-air-write is
strict...`, `wrapper: reads, writes and on-air writes while offline...`, `core: audit stalled ... read and write still run`; they follow
the in-progress change of `requiresDurableAudit` to include class `write`), and the credential tests (4, Windows credential store).
In the same file, 4 other tests that failed only because of the two-step flow now pass after the helper edits (section 4).

## 4. Test and tool changes forced by the new behaviour

- `tests/event-core-livelock.test.mjs`, `-matrix`, `-review`: seeds set `chatMode: 'dry-run'` with `chatAllowed: true`; helpers follow step 2; assertions for chat now expect `dry-run` and no executor call; scenarios that used a live `scene.switch` to test single-step behaviour use a `write` action or go offline.
- `tests/event-core-failclosed.test.mjs`: `confirmed()` and three API/SSE tests follow step 2 (minimal edits).
- `tests/event-core-idempotency.test.mjs`, `tools/idem-crash-child.mjs`: they drove the executor with a chat-triggered action, which can no longer execute. They now drive it with an untainted `api` request and a client key derived from the message id (and the crash child confirms both on-air steps), so restart, ambiguous-key and kill-window behaviour is exercised on the same code. Consequence: the `pm:` (platform message) key origin has no end-to-end test through the executor until C2/C3 can run chat actions; `idempotencyKeyFor` itself is still unit-tested for it.

## 5. UNVERIFIED and open

- UNVERIFIED: a real UI/API client against the new two-step flow (the API passes the step-2 object through unchanged; covered by the SSE test in failclosed).
- `tools/bench/benches/event-core-livelock.mjs` (other agent) still describes chat as "allowed"; the bench suite passes, not touched.
- No `chatAllowed` was flipped; no budget, baseline or exclusion was changed.

## 6. Risks for the phase gate

From the independent review (`docs/evidence/2026-10-28-p3-e4b-opus-review.md`), findings 3 to 7, with the review's wording
and the fix status on 2026-10-29. Findings 6 and 7 are user decisions and are not fixed.

| # | Class | Review wording | Status |
|---|---|---|---|
| 3 | should-fix | "With no audit attached, live writes run with nothing durable (A4)." | **Fixed.** Without an audit, a write while not offline is refused `audit-unavailable` unless the test-only option `allowUnaudited: true` is set (wrapper option, and `actions.allowUnaudited` on `createEventCore`). Residual: `createActionGate` used on its own with a raw executor (no idempotent wrapper) still has no fail-closed rule; the gate is the decision layer and the wrapper is the fail-closed layer. Every production path (`createEventCore`, the service) goes through the wrapper. |
| 4 | should-fix | "A fail-closed refusal spends the idempotency key, so the legitimate retry can never run within the retention window (A5)." | **Fixed.** A refusal forgets the key in memory and persists outcome `refused`, which `seed()` ignores; a later start for that key clears the refusal in `action_keys`. Residual: if the audit queue fills between the start marker and the `refused` marker and the process then restarts, the key seeds as `ambiguous` (never re-run) for the retention window; an in-process retry before the restart still runs. |
| 5 | should-fix | "The dry-run row says `wouldDecision: 'allow'` for writes and on-air writes." | **Fixed.** The row records what the non-chat rules would answer: `allow` (`wouldReason: read`), `confirm` with `wouldSteps` 1 or 2 (`confirmation-required` / `two-step-confirmation`), or `refuse` with `wouldReason`; `liveState` is already in the detail. A `confirm` would-be result is never satisfiable from chat (chat cannot confirm). Still open from the review: before `on` is ever unblocked, an ADR must record how chat-on interacts with the confirmation rule. |
| 6 | should-fix | "Dry-run is unreachable with the committed catalogue, and P3 has no runtime caller that sends chat to the gate." | **Not fixed (user decision).** The phase gate should mark requirement 1 as "mechanism done, no runtime trigger until rules exist". The user decides whether non-deny entries get `chatAllowed: true` with `chatMode: dry-run` in P3. |
| 7 | should-fix (design) | "The same API token can request and give both confirmations." | **Not fixed (user decision).** Known limitation: the two steps protect against UI mistakes, not against a compromised or buggy API client or anything else holding the API token. Must not carry into P4/P5: when the UI lands, move confirmation to a separate `ui` role and token the requester does not hold, or have the Qt app collect the phrase. |

## 7. Review fixes (2026-10-29)

Findings 1, 2, 3, 4, 5, 8, 9, 10 and 11 of the independent review. Findings 6 and 7 are recorded above and not changed.

### What changed

| # | Fix |
|---|---|
| 1 (fix-first) | With an audit attached, **every write is strict** (class `write` or `on-air-write`, whatever the live state at dispatch): it runs only after its start marker and `action/start` row commit, else it is refused `audit-unavailable`. Why this option: strictness then never depends on a live state that can change during the wait, so "decided offline, run live" cannot happen by construction; offline writes have no live-path cost (they wait up to 250 ms and are refused when the audit is down, the safe side). On top of that, the re-check below runs immediately before `inner.execute` and also evaluates `requiresDurableAudit` for the CURRENT live state, refusing `audit-unavailable` if the write now needs a record and has none. |
| 2 | The gate gives each dispatch a guard, `execute(act, guard)`; the act carries `liveState` and `liveEpoch`. Right before `inner.execute`, in the same synchronous step (no await between the check and the call, so no TOCTOU window), the wrapper calls `guard.revalidate()`: panic engaged since dispatch (a panic generation counter, so engage-then-clear during the wait still refuses), or panic on for a tainted or rule action, gives `panic`; a different live epoch or effective live state (including going stale to `unknown`) gives `live-state-changed`. Both refuse the write like `audit-unavailable` (system.refused with the reason, log line, counters `refusedPanic` / `refusedLiveChanged`, core `refusedRecheck`). Reads are not re-checked (harmless). A raw executor ignores the guard. |
| 3 | No audit attached: a write while not offline is refused `audit-unavailable` (cause `no-audit`) unless `allowUnaudited: true` (test only; documented in the `createEventCore` and wrapper headers; never set in the service). |
| 4 | A refusal (any reason) does not spend the key: deleted from memory, `done` marker with outcome `refused` (audit `recordActionDone` and the store accept it); `seed()` skips `refused` rows (`seededRefused` counter); the `action_keys` start insert is now an upsert that clears `completed_at`/`outcome` only when the row says `refused`. No schema change (same table and columns). |
| 5 | Dry-run rows record `wouldDecision`, `wouldReason`, `wouldSteps` (section 6). The sanitised audit detail carries the two new fields. |
| 8 | A skipped dispatch answers `{ ok: false, error: 'skipped', skipped: 'completed' \| 'running' \| 'ambiguous' }` (the `refused` skip state no longer exists). Detected by exact shape, getter-safe. |
| 9 | `data/actions/catalogue.schema.json`: the `chatMode` enum is `["off", "dry-run"]`, with a note that `on` returns when the lost-action blocker is closed. The loader refusal of `on` with the blocker text stays (defence in depth). |
| 10 | The PowerShell credential child gets a minimal environment (`credentialChildEnv`: SystemRoot, windir, SystemDrive, Path, PATHEXT, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA, PROCESSOR_ARCHITECTURE, plus the two `UJW_CRED_` variables). PSModulePath is left out on purpose. Tested: a unit test on the built env with a sentinel and a token-like variable; a real PowerShell child started with that env prints an empty sentinel; the existing Windows set/get/delete, handshake and CLI tests still pass. |
| 11 | Note appended to the E5 evidence, section 7 (pseudonymity and privacy): a dry-run row's `event_id` joins to `chat_raw` until the purge, by design. |

Superseded by these fixes: in section 1 of this file, "schema enum has all three" and `wouldDecision` "always `allow`"; in
`docs/evidence/2026-10-28-p3-e7-priority-failclosed-tracer.md` sections 2 and 9, "the key is spent ... `{ skipped:
'refused' }`" and "writes of either class while `offline`" not strict. Those statements are not edited here.

### Attack results before and after

Reviewer's scratch file (13 tests; each asserts the secure behaviour, FAIL = the attack works), `node --test <file>`:

| Test | Before | After |
|---|---|---|
| A1 offline-confirmed keyed write runs live, unaudited | FAIL | PASS |
| A2 panic during the audit wait | FAIL | PASS |
| A3 epoch change during the audit wait | FAIL | PASS |
| A4 core without audit runs a live write | FAIL | PASS |
| A5 refusal spends the client key | FAIL | PASS |
| A5b skipped dispatch reported ok:true | FAIL | PASS |
| A6 to A12 | PASS | PASS |
| Total | 7 pass, 6 fail | 13 pass, 0 fail |

Ported into the repo as `tests/event-core-livelock-attack-e4b.test.mjs`: A1 to A12 (with stricter asserts on the refusal
reason), plus 11 tests for the same fixes from other angles (slow healthy audit and the stream going live, stale live
state, offline writes strict, panic engaged and cleared during the wait, refusal reasons and key reuse in the core,
refused outcome across a restart, `seed()` on refused rows, no-audit offline/read/`allowUnaudited`, dry-run would-be
results, `skipped: running`, a raw executor ignores the guard): 24 tests, 24 pass.

### Tests changed by the new behaviour

- `tests/event-core-failclosed.test.mjs`: offline writes with a stalled audit are now refused (and run once it recovers);
  the retried key is refused again instead of `skipped: refused`; done marker `refused`; the no-persistence wrapper
  refuses live writes and `allowUnaudited` runs them.
- `tests/event-core-dryrun-twostep.test.mjs`: would-be fields; the schema refuses `on` (the loader still refuses it with
  the blocker text); skipped answer shape.
- `tests/event-core-idempotency.test.mjs`, `tests/idempotency-crash.test.mjs`: skipped answer shape.
- `tests/event-core-livelock.test.mjs`: the frozen act now has `liveEpoch`.
- `tests/event-core-streamerbot-credential.test.mjs`: source check for the minimal env; two new env tests.

### Commands and output

```
$ node --test <reviewer scratch attack file>
before: tests 13, pass 7, fail 6 (A1, A2, A3, A4, A5, A5b)
after:  tests 13, pass 13, fail 0

$ node --test tests/event-core-livelock-attack-e4b.test.mjs
tests 24, pass 24, fail 0

$ node --test tests/event-core-livelock-matrix.test.mjs
matrix cases: 6384 (2 catalogues x 28 actions x 19 sources x 3 live states x 2 panic)
tests 9, pass 9, fail 0

$ npm run lint
lint: 2 finding(s) (user-path=2): both in docs/evidence/2026-10-28-p3-e4b-opus-review.md (lines 27 and 154, the
reviewer's scratch path); none in this change

$ npm test
before the fixes: tests 665, pass 665, fail 0
after the fixes:  tests 691, pass 691, fail 0, skipped 0, cancelled 0   (+24 attack file, +2 credential env tests)
```

### Not run, not changed

- Benches, soaks and budgets were not run or changed (they need the user's yes). Each dispatch now allocates one frozen
  guard object with two closures; the gate's request path is unchanged. Whether the `event-core-livelock` bench moves is
  UNVERIFIED until the bench is run.
- No `chatAllowed` was flipped; no exclusion, rule or baseline was changed. Nothing staged or committed.
