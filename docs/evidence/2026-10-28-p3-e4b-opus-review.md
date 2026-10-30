# 2026-10-28 P3 E4b: independent review of live-lock, action gate, fail-closed audit and credential cache

Reviewer: independent Opus review, read-only. No repository file was changed except this one. Nothing was installed, staged or committed.

## Scope

- `services/event-core/livelock/{gate,catalogue,index,provenance,idempotency}.mjs`
- `data/actions/catalogue.json`, `data/actions/catalogue.schema.json`
- `services/event-core/api/{executor,methods,service}.mjs` (plus `server.mjs` for the handle wiring)
- `services/event-core/audit/index.mjs` (`recordDecision`, `recordActionStart`), `audit/writer.mjs`, `audit/sanitise.mjs`, and the purge in `audit/store.mjs`
- `services/event-core/streamerbot/{credential,connector}.mjs`
- `services/event-core/index.mjs` (how the gate, the idempotent executor and the audit are put together)

Method: I read the code, ran the existing tests, and wrote attack tests outside the repo. I did not rely on the conclusions in the E4/E4b evidence files.

## Existing tests

```
node --test --test-concurrency=2 tests/event-core-dryrun-twostep.test.mjs tests/event-core-livelock*.test.mjs \
  tests/event-core-failclosed.test.mjs tests/event-core-idempotency.test.mjs tests/event-core-api.test.mjs \
  tests/event-core-streamerbot-credential.test.mjs tests/event-core-audit-privacy.test.mjs
ℹ tests 146   ℹ pass 146   ℹ fail 0   ℹ skipped 0
```

## Attack tests

File (session scratchpad, not in the repo): `%TEMP%\claude\<session>\scratchpad\attack-e4b.test.mjs`. Ported into the repo as `tests/event-core-livelock-attack-e4b.test.mjs`.

Run: `node --test <that file>` from the repo root. Each test asserts the secure behaviour, so FAIL means the attack worked.

| Test | Attack | Result |
|---|---|---|
| A1 | Offline: confirm a keyed on-air write with `yes`. The stream goes live while the dispatch waits for its (non-strict) durable start, and the audit is stalled. | **FAIL**: runs while live with `act.liveState: 'offline'`, only one `yes`, no durable audit (`{"ok":true,"result":"ran"}`). |
| A2 | Live write confirmed; panic is engaged while it waits up to 250 ms for its audit commit. | **FAIL**: runs after panic. |
| A3 | Live write confirmed; the live epoch changes (offline, then live) while it waits for the commit. | **FAIL**: runs in an epoch that was never confirmed. |
| A4 | `createEventCore` with an executor and no audit; a live write. | **FAIL**: runs with nothing durable (fail open). |
| A5 | Client `idempotencyKey`; the first try is refused `audit-unavailable` (nothing ran); the audit recovers and the same request is retried. | **FAIL**: the retry is skipped (`{"ok":true,"result":{"skipped":"refused"}}`) and never runs. |
| A5b | Same key twice while offline. | **FAIL**: the skipped second dispatch is reported `ok: true`. |
| A6 | Two-step attacks: skip step 1, replay step 1, step 2 with the step-1 hash, step 2 from another source, chat/remote/system/rule as confirmer, chat-tainted ctx provenance, epoch change between steps, step-2 expiry at 30 s, forged hash for other params. | PASS |
| A7 | API: `source`, `provenance`, `actor`, `ruleId`, `tainted` on `actions.request`; `source`, `provenance`, `ctx` on `actions.confirm`. Role table for confirm and live.set. | PASS |
| A8 | Every catalogue id with every non-deny action opened to dry-run, sources chat/rule/api/ui, six tainted provenance shapes, offline and live. | PASS: no allow, no confirm, no dispatch, no panic. |
| A9 | An accessor on `id` in a catalogue passed straight to `createActionGate`, so validation and storage see different ids. | PASS |
| A10 | Dry-run row privacy when a rule copies chat text, name and platform user id into params, actor and ruleId; then purge all and verify. | PASS: none of them in the audit rows; one dry-run row; chain verifies; executor not called. |
| A11 | The same client key from the api and system roles, and with different params. | PASS: no collision. |
| A12 | 40 000 requests from four sources. | PASS: pending stays at 4 x 16 or fewer. |

## Findings

| # | Class | Where | Finding |
|---|---|---|---|
| 1 | **fix-first** | `livelock/idempotency.mjs:170`, `:191-192`; `livelock/gate.mjs:200-206` | Fail-closed is decided once, from the live state at dispatch, and never checked again after the wait (A1). |
| 2 | should-fix | `livelock/idempotency.mjs:191-192`; `livelock/gate.mjs:196-217` | A confirmed action waiting up to 250 ms for its durable start is not cancelled by panic or by a live-epoch change (A2, A3). |
| 3 | should-fix | `index.mjs:98`, `:103`; `livelock/idempotency.mjs:170` | With no audit attached, live writes run with nothing durable (A4). |
| 4 | should-fix | `livelock/idempotency.mjs:154-158`, `:185` | A fail-closed refusal spends the idempotency key, so the legitimate retry can never run within the retention window (A5). |
| 5 | should-fix | `livelock/gate.mjs:295`; `livelock/catalogue.mjs` header | The dry-run row says `wouldDecision: 'allow'` for writes and on-air writes. |
| 6 | should-fix | `data/actions/catalogue.json` (every entry `chatAllowed: false`); `livelock/gate.mjs:319` | Dry-run is unreachable with the committed catalogue, and P3 has no runtime caller that sends chat to the gate. |
| 7 | should-fix (design, record it) | `api/methods.mjs:82-102`; `livelock/gate.mjs:61` | The same API token can request and give both confirmations. |
| 8 | nit | `livelock/gate.mjs:207-216`; `api/methods.mjs:62-66` | Skipped dispatches (`completed`, `running`, `ambiguous`, `refused`) come back as `{ ok: true }` (A5b). |
| 9 | nit | `data/actions/catalogue.schema.json:22` | The schema accepts `chatMode: "on"`; only the loader refuses it. |
| 10 | nit | `streamerbot/credential.mjs:134-156`, `connector.mjs:114` | Credential cache: acceptable. Notes below. |
| 11 | nit | `audit/index.mjs` `recordDecision` | A dry-run row's `event_id` joins to `chat_raw.event_id` until the raw row is purged. |

### 1. fix-first: the fail-closed rule is decided from a stale live state

Scenario (A1): offline, an API client asks for `scene.switch` with an `idempotencyKey`. Offline means one confirmation, `yes`. On confirm, `dispatch()` gives the wrapper `act.liveState = 'offline'`, so `strict` is false (idempotency.mjs:170). Because the action has a key and persistence is attached, the wrapper still waits up to `startTimeoutMs` for the non-strict start marker (`startDurable(key, null).then(go)`, :192), and on timeout it runs anyway (fail open, :191). If the stream goes live during that wait and the audit is stalled or slow, the write runs while live with no durable record and only the offline `yes`. That breaks requirement 3 (a live write that cannot be durably audited is refused, never run unaudited) and the intent of requirement 2 (an on-air write while live needs two confirmations). The test reproduces it deterministically: `ran: [{ id: 'scene.switch', liveState: 'offline' }]` while `gate.state().liveState === 'live'`.

Practical impact in P3 is small: no studio handlers exist yet (`api/executor.mjs` throws `no-handler`), and it needs a key plus a stream start inside a 250 ms window. But it is a deterministic hole in a stated invariant, and studio handlers arrive in P4 and P6.

Fix: give the wrapper a live getter from the gate (for example `opts.liveNow()`) and evaluate `requiresDurableAudit` again on the current state just before `inner.execute`. If the action is strict now and the start was not `ok`, refuse. A simpler, stricter option: treat every write with persistence attached as strict whatever the state. Then an offline write also waits up to 250 ms and is refused when the audit is down. Offline writes have no live-path cost, so this costs little.

### 2. should-fix: no re-check after the durable-start wait

Scenario (A2, A3): a live write is confirmed correctly. While it waits, up to 250 ms, for its `action/start` row to commit, panic is engaged, or the live epoch changes (stream stops and restarts). It still runs. Panic clears pending confirmations but not dispatches already in flight. For API-sourced writes this matches today's panic rule (panic only refuses tainted and rule requests). For an untainted rule-sourced write (a hotkey or schedule rule) that was confirmed just before panic, it does not.

Fix: as part of finding 1, have the gate attach `{ epoch, panicAtDispatch }` to the act and pass a `stillValid(act)` callback that the wrapper calls after the wait. Refuse with a distinct reason (`live-state-changed` / `panic`) when the epoch differs or when panic is on and the source is rule. Audit it like other refusals.

### 3. should-fix: no audit attached means fail open

`createEventCore({ actions: { executor } })` without `audit` gives the idempotent wrapper `persist: null`, so `strict` is always false and live writes run with nothing durable (A4). `createActionGate` used on its own with a raw executor has no fail-closed rule at all. The service always attaches an audit (`api/service.mjs:62`), so production is not affected today. But requirement 3 is written as an invariant, and the library default goes against it.

Fix: when no audit is attached, refuse writes while not offline with `audit-unavailable`, unless an explicit test option such as `actions.allowUnaudited: true` is set. Document it in the createEventCore header.

### 4. should-fix: a fail-closed refusal spends the client's key

Scenario (A5): an API client sends a live write with `idempotencyKey: K`. The audit queue is full, so the write is refused `audit-unavailable` and nothing runs. `refuse()` marks K `refused` and queues a `done` marker with outcome `error` (idempotency.mjs:154-158). Once the audit recovers, the client retries with the same K (the right thing for an at-least-once client) and gets `{ skipped: 'refused' }` for the whole retention window (1 h). After a restart the persisted `done` row seeds K as `completed`. The legitimate action can then only run under a new key, which defeats the client's idempotency.

No attacker can choose another source's key, because the key hash includes the source (A11). This is self-poisoning, not cross-principal. The cause is still the design: a refusal is "did not run", which is safe to retry.

Fix: on refusal, delete K from memory and persist a distinct outcome (`refused`) that `seed()` skips, so K is forgotten. Keep the `action/start` row and the `system.refused` row as the audit trail. If the late `start` commit lands, `seed()` must not turn it into `ambiguous` when a `refused` done row exists.

### 5. should-fix: the dry-run "would-be result" is wrong for writes

`dryRun()` always records `wouldDecision: 'allow'` (gate.mjs:295), including for `effect.fire` or `scene.switch` while live. Under the current rules, a chat-tainted on-air write while live would need two confirmations that chat can never give. So the honest would-be result is "confirmation required (never satisfiable from chat)", not "allow". The row as written suggests that `chatMode: on` would run on-air writes with no confirmation. Requirement 2 forbids that, and no ADR decides it.

Fix: record the decision the non-chat rules would give (`allow` for read, `confirm` with step count for write and on-air-write, plus `liveState`). Before `on` is ever unblocked, record in an ADR how chat-on interacts with the confirmation rule.

### 6. should-fix: dry-run is inert in P3

The gate checks `chatAllowed !== true` before `chatMode` (gate.mjs:319). Every committed entry has `chatAllowed: false`, so a chat-tainted request for any action gets `chat-not-allowed` and never produces a dry-run row. Also, no P3 runtime code calls the gate with chat provenance: there is no rule engine yet, and the Streamer.bot connector only ingests. So the dry-run feature is exercised only in tests that open entries themselves. The E4b evidence discloses this as open question 1. I list it so the gate does not record requirement 1 as delivered at runtime. The refusal rows do still record action, rule, pseudo id and verdict.

Fix: the user decides whether non-deny entries get `chatAllowed: true` with `chatMode: dry-run` in P3. Either way, the phase gate should mark requirement 1 as "mechanism done, no runtime trigger until rules exist".

### 7. should-fix (design): the API role is both requester and confirmer

`actions.request` and `actions.confirm` are both open to the `api` role, and the confirm answer carries the exact phrase. So one API client can request, confirm `yes` and confirm `yes, on air` in under 1 ms. The two steps only protect against mistakes made through a UI. They do not protect against a compromised or buggy API client, or anything else holding the API token, which `api.json` publishes to the data directory. In P3 there is no UI and no studio handler, so this is acceptable for now. It must not carry into P4/P5.

Fix: record it as a known limitation. When the UI lands, move confirmation to a separate `ui` role and token that the requester does not hold, or have the Qt app (not the requester) collect the phrase.

### 8. nit: skipped dispatches are reported as success

`dispatch()` wraps whatever the wrapper returns in `{ ok: true, result }`, so `{ skipped: 'completed' | 'running' | 'ambiguous' | 'refused' }` reaches the API as `ok: true` (A5b). A client cannot tell "ran now" from "did not run this time" without knowing the shape.

Fix: have the gate map a `skipped` result to `{ ok: false, skipped: <state> }`, or add a top-level `skipped` field in `methods.mjs outcome()`.

### 9. nit: the schema accepts chatMode "on"

`catalogue.schema.json` lists `on` in the enum. `buildCatalogue` refuses it and only ever stores `off` or `dry-run` (catalogue.mjs:98), and the gate refuses anything but `dry-run` (gate.mjs:320), so no code path executes chat. But any tool or editor that validates with the schema alone will pass a catalogue the service then refuses to load.

Fix: drop `on` from the enum until the blocker is closed, or add a `not` clause with the blocker text in the description.

### 10. nit: credential cache assessment

- The secret goes in through stdin and out through stdout only. The target name goes through an env var. Fixed arguments, `shell: false`, stderr dropped. Errors carry Win32 codes only. Nothing in `connector.mjs` logs or throws the password, and `computeAuth` output is the only thing sent. Verified in code; the existing tests also cover CLI status output.
- The cache holds one JS string for the provider's lifetime, which is the service lifetime. It cannot be zeroed, and it would show up in a heap snapshot or a full crash dump of the event-core process. Nothing in the service turns on the inspector or heap snapshots. That is the same exposure the per-handshake read already had, made longer. Acceptable for a same-user local process. Record it in the risk list.
- `fatal()` invalidates on every auth failure path (`auth-failed`, `auth-no-answer`, `auth-closed`, bad hello, no password, read failure). The generation counter stops an in-flight read from re-filling the cache after `invalidate()`. Correct.
- `stop()` does not invalidate, so `stop()` then `start()` reuses the cached value. That is fine: a changed password is caught by the next auth failure.
- The spawned PowerShell inherits the full `process.env`, which may include the API tokens when they come from the environment. The child is a fixed local script, so the risk is low. Passing a minimal env (SystemRoot, PATH, TEMP and the two UJW_ variables) would remove it.
- Not new, and not caused by the cache: whatever process answers on the configured URL picks the salt and challenge, so it can collect a response for offline guessing. Refusing to authenticate to non-loopback URLs unless explicitly configured would narrow this.
- `spawn` itself creates the process synchronously on the main thread. The existing test measured 13 to 18 ms of loop delay, once per connector lifetime with the cache on. That is within the live-path rule.

### 11. nit: dry-run rows can be joined to raw chat until the purge

The dry-run row's `event_id` is the internal id of the chat event, which is also the `chat_raw.event_id` key. Inside the 30-day window, a reader of both tables can join a dry-run row to the viewer's text and display name. The row itself holds no text, name or platform id (A10). This is by design, for review. Note it in the privacy section of the E5 evidence.

## Requirement check

| Req | Verdict | Notes |
|---|---|---|
| 1. Chat dry-run only; `on` refused; no widening; no PII; survives purge | PASS (mechanism) | `on` cannot be stored (normalised to off/dry-run) and the gate refuses anything but dry-run. Deny categories are checked at load and again on every tainted request (A8). Rows carry no text, name or platform id, and survive purge-all with the chain intact (A10). Findings 5 and 6 cover the would-be result and runtime reachability. |
| 2. Two-step on-air confirmation | PASS at the gate | Single use, hash bound to action, params, epoch and the step-1 hash, 30 s per step, no skip, no replay, no rebinding, same confirmer for step 2, epoch change invalidates, chat and tainted provenance refused without consuming the step (A6). Gaps after both steps: findings 1 and 2. Design limit: finding 7. |
| 3. Live write without a durable audit refused and shown | **FAIL** | Strict path verified (the existing tests and the code). Holes: finding 1 (offline-decided write runs live), finding 3 (no audit attached). |
| 4. Nothing on the live path waits on network, disk scans or blocking I/O | PASS | Gate `request`/`confirm` are synchronous with no I/O. Audit recorders only queue. The fail-closed wait is asynchronous. The catalogue is read from disk only at start-up. Credential reads are asynchronous and cached. |
| 5. Credentials never on a command line, in logs or in errors | PASS | Finding 10 covers the cache, which is acceptable. |

Other items checked with no finding: source spoofing through API params (A7); API handles bound per role (`server.mjs:60`); chat cannot engage or clear panic; chat cannot spend an executor key, because dry-run makes no claim (A10: `executed: 0`); dry-run duplicate keys include the actor and the platform message hash, so one viewer cannot suppress another's row; the key hash includes the source, so no cross-role collision (A11); `pending`, `used`, `dryKeys`, idempotency keys, origins and the pseudo cache are all bounded (A12); `canonicalJson` refuses getters, Proxies and `__proto__`/`constructor` keys; the purge deletes only `chat_raw`, so the hash chain cannot break.

## Verdict

**Not ready to close as-is. One fix-first item.** The gate itself is solid: confirmation ordering, replay, rebinding, provenance taint, source binding and the chat dry-run lock all held under attack. The weak point is the layer between an accepted confirmation and the executor call. Fail-closed is decided from the live state at dispatch, and nothing is checked again after the up-to-250 ms durable-start wait. Fix finding 1 (with finding 2 in the same change), add A1 to A3 as repo tests, and decide findings 3 to 7 (they can be scheduled, but should be recorded in the phase gate risks).

## Files created or changed

- Created: `docs/evidence/2026-10-28-p3-e4b-opus-review.md` (this file)
- Scratch, outside the repo: `%TEMP%\claude\<session>\scratchpad\attack-e4b.test.mjs`
