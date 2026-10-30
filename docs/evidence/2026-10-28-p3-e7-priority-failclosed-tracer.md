# P3 E7 follow-up: process priority, fail-closed on-air writes, stall tracer

Date: 2026-10-28. Host: Windows 11 10.0.26200, Node v26.12.1. Code and tests only: no soak, no bench was run for
this note. Raw chat text, names and ids do not appear here. All test text and names are invented.

| Item | Result |
|---|---|
| 1. Process priority | **Done.** `serve` sets itself to Normal and logs it; a failure is logged and not fatal. Tests PASS. |
| 2. Fail closed for live on-air writes | **Done.** No durable audit record within 250 ms: refused with `audit-unavailable`, never run. Tests PASS. |
| 3. Lost-action gap blocker | **Recorded** in the P3 plan and the E7 stalls/idempotency evidence (append only). |
| 4. Stall tracer on the live service | **Done.** On by default in `serve`; stalls over 200 ms only; async, rotated, no chat text. Tests PASS. Overhead UNVERIFIED. |
| 5. Dead `eslint-disable` comment | **Removed** (audit/writer.mjs, that marker only). |
| Gates | `npm run lint` PASS (0 findings), `npm test` 632/632 PASS. No soak, no bench, no `npm run ci`. |
| 9. Fail closed for EVERY write while live (follow-up) | **Done.** Class `write` joins `on-air-write`. Tests PASS. See section 9. |
| 10. Non-blocking Streamer.bot password read (follow-up) | **Done.** Async `spawn`, cached per connector, re-read after an auth failure. Max loop delay during reconnect 11–20 ms (limit 100 ms). Fixture recorder made async too. See section 10. |

---

## 1. Process priority

### Rule

- The live event core runs at **Normal** process priority, never BelowNormal.
- AI workers, benchmarks and background jobs stay **BelowNormal**. The live path never runs below background work.
- The Qt app with libobs (P4+) should outrank the core. That is a **later decision** (P4). No AboveNormal now.
- Worker threads (audit writer, stall watchdog) share the process priority. Node cannot set a per-thread priority.

### Code

- `services/event-core/priority.mjs` (new): `LIVE_PRIORITY` (Normal), `BACKGROUND_PRIORITY` (BelowNormal),
  `setLivePriority()`, `setBackgroundPriority(pid)`, `formatPriority(r)`. Calls never throw; they return
  `{ ok, target, before, after, error? }`.
- `cli.mjs serve`: sets Normal first, before anything starts, and logs one line:
  - `[serve] process priority normal (target normal, was below-normal)`
  - on failure: `[serve] warn: process priority NOT set to normal (EPERM); now unknown; continuing`
- Soak harness (simulating live): `tools/soak/core-child.mjs --live-priority` sets Normal like `serve`;
  `tools/soak/replay.mjs --live-priority` passes the flag and does not lower the child. Without the flag both stay
  BelowNormal (long test runs, resource rule). `summary.json` records `priority`.

### Children of the core

The core starts no background child processes in P3. It has two short child calls, both `spawnSync` on the core's
own path:

- `icacls` at start-up (data-dir ACL);
- the PowerShell credential read at Streamer.bot connect.

They inherit Normal. They are NOT lowered: the core blocks on them, so a BelowNormal child would extend the core's own
block (priority inversion). `setBackgroundPriority(pid)` is ready for the first real background child.

Update (section 10): the credential read is now an asynchronous `spawn`; the core no longer blocks on it. It still
inherits Normal and is still not lowered (a lowered child would delay the connect). `icacls` stays `spawnSync`
(start-up only).

---

## 2. Fail closed for on-air writes when the audit is slow

### Rule

An action is **strict** when it is class `on-air-write` and the live state is not `offline` (`unknown` counts as
live, as in the gate). A strict action needs a **durable audit record** before it executes. The record is:

- the `action_keys` `started` marker (synchronous=FULL), and
- a hash-chained audit row `{ type: 'action', subtype: 'start', verdict: 'start', reason: <class> }`, with
  `detail: { liveState, keyed, key: <first 16 hex> }`.

Both must commit within `startTimeoutMs` (250 ms, the existing limit). If not, or if the audit is failed or closed:

- the action is **refused**: dispatch returns `{ ok: false, error: 'audit-unavailable' }`, the executor is not called;
- the key is spent: its durable outcome is `error`, a retry with the same key returns `{ skipped: 'refused' }`; **superseded 2026-10-29** by E4b review finding 4: a refusal no longer spends the key (outcome `refused`, ignored by `seed()`), see `2026-10-28-p3-e4b-dryrun-two-step.md` §7;
- the refusal is visible:
  - a `system.refused` event `{ action, reason: 'audit-unavailable' }` on the bus and SSE (api and system roles);
  - an audit row for that event when the audit recovers (the normal audit observer);
  - a log line, rate limited to 1 per second:
    `[event-core] warn: action-refused reason=audit-unavailable action=<id> cause=<timeout|failed:CODE>`;
  - `stats().refusedNoAudit` counts refusals.

Unkeyed strict actions get a one-off random 64-hex key, so they too have a durable record before they run.

Not strict (current behaviour kept, fail-open on a slow audit): class `read`, class `write`, and `on-air-write` while
`offline`. **Superseded by section 9:** class `write` while not offline is now strict too.

How to read the audit: a `start` row followed by a `system.refused` row for the same action means it did NOT run.

### Code

- `livelock/idempotency.mjs`: `AUDIT_UNAVAILABLE`, `requiresDurableAudit(act)`, the `refused` key state, `onRefused`.
- `livelock/gate.mjs`: the dispatched act carries `liveState`.
- `audit/index.mjs`: `recordActionStart(key, atMs, info)` also queues the chained `start` row and resolves only when
  the row and the marker are both committed.
- `index.mjs` (core): `onAuditRefused` emits `system.refused` and the log line.
- `model.mjs` and `schema/event.schema.json`: new kind `system.refused` (E1 schema change).

### Decisions to confirm (UNVERIFIED as the intended scope)

- Class `write` while live stays fail-open. The brief names on-air writes only. If live `write` should also fail
  closed, it is one line in `requiresDurableAudit`. **Decided 2026-10-28 (user): every write fails closed while live;
  done in section 9.**
- The gate verdict in the audit stays `allow` or `confirmed`; the refusal is the separate `system.refused` row.
- Strict mode applies only when the core has an audit attached. `startService` always attaches one.

---

## 3. Lost-action gap: blocker before C2/C3

Appended (existing text kept) as "## Blockers before C2/C3" to:

- `docs/plan/2026-10-28-p3-plan.md`
- `docs/evidence/2026-10-28-p3-e7-stalls-idempotency.md` (plus a note that its fail-open row no longer holds for
  live on-air writes; it points here)

The gap must be closed, with a test, before any chat-triggered action is switched on in C2/C3. Item 2 does not close
it: a crash after the `started` marker and before execute still gives 0 runs (never 2).

---

## 4. Stall tracer on the live service

- `startService` (and so `serve`) starts the tracer by default, before the core: label `event-core`,
  threshold 200 ms, `stallsOnly` (no window or summary lines), file `<dataDir>/stalls.jsonl`.
- Writes: `node:fs/promises` only (`appendFile`, `rename`, `stat`). No synchronous fs call in the module (tested).
- Bounded size: `maxBytes` 1 MiB; at the limit the file rotates to `stalls.jsonl.1` (one rotated file). A line bigger
  than `maxBytes` is dropped. Disk use is at most about 2 MiB.
- Bounded memory: `maxBuffered` 1000 lines; the oldest are dropped first; `droppedLines` counts them.
- Records: timing, label and audit numbers only (`batches`, `failed`, `inflight`, `lastOp`, `lastWrite`, `queued`).
  No chat text, no names (tested with an invented marker line and display name).
- Off: `serve --no-stall-tracer`, or `startService({ stallTracer: false })`. An object overrides the defaults.
- The soak core child turns the service tracer off; it keeps its own tracer in `metrics/stalls.jsonl`.
- Watchdog worker thread kept (it sees stalls the interval cannot report until the loop resumes).

UNVERIFIED: tracer overhead on the live path (the separate bench measures it); behaviour on a real host stall.

---

## 5. Dead comment

`services/event-core/audit/writer.mjs`: removed `// eslint-disable-line no-unused-vars` from
`const { now: _now, ...cloneable } = storeOpts;`. No other change.

---

## 6. Tests

New test files:

- `tests/event-core-failclosed.test.mjs` (10 tests): rule; stalled and failing audit refuse (keyed and unkeyed); read,
  write and offline on-air writes still run; durable row and marker exist before execute (checked from the executor
  with a read-only DB handle); refusal on the bus, in the log and as an audit row after recovery, with the chain
  verified; closed audit and unknown live state; same key skipped as refused; log rate limit; SSE frames for api and
  system roles with nothing executed.
- `tests/stall-tracer-service.test.mjs` (5 tests): default on, stall lines only, no chat text; off writes no file;
  rotation and size bound; buffer bound; async-only writes.
- `tests/event-core-priority.test.mjs` (6 tests): rule values; Normal from BelowNormal (fake OS); failure reported
  not thrown; a real no-op OS call; `serve` logs Normal first and the tracer on; failure logged, service still
  starts, `--no-stall-tracer`.

Changed tests: `tests/event-core-model.test.mjs` (new kind, 15 kinds), `tests/event-core-livelock.test.mjs` (act
carries `liveState`).

```
node --test tests/event-core-failclosed.test.mjs tests/stall-tracer-service.test.mjs tests/event-core-priority.test.mjs
```
```
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

```
npm run lint
```
```
lint: 0 finding(s), 26 allow marker(s), in 1.9s
```

```
npm test
```
```
ℹ tests 632
ℹ pass 632
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

An earlier full run (631 tests) had 1 failure in `tests/bench.test.mjs` ("CLI: a noisy slow run is ADVISORY ...").
That file belongs to the parallel bench agent, which was editing it at the time; it was not touched here. The final
run above passes.

---

## 7. Proposed extras (not done)

- Make the Streamer.bot credential read async. Today it is `spawnSync` and blocks the event loop at connect.
  **Done in section 10.**
- Supervisor and Qt app priority (P4): decide whether the Qt/libobs process runs above Normal.
- Decide whether live class `write` should also fail closed (section 2). **Decided and done in section 9.**

---

## 8. Files created or changed

Created:

- `services/event-core/priority.mjs`
- `tests/event-core-failclosed.test.mjs`
- `tests/stall-tracer-service.test.mjs`
- `tests/event-core-priority.test.mjs`
- `docs/evidence/2026-10-28-p3-e7-priority-failclosed-tracer.md` (this file)

Changed:

- `services/event-core/audit/writer.mjs`
- `services/event-core/audit/index.mjs`
- `services/event-core/model.mjs`
- `services/event-core/schema/event.schema.json`
- `services/event-core/livelock/idempotency.mjs`
- `services/event-core/livelock/index.mjs`
- `services/event-core/livelock/gate.mjs`
- `services/event-core/index.mjs`
- `services/event-core/diag/stall-tracer.mjs`
- `services/event-core/api/service.mjs`
- `services/event-core/cli.mjs`
- `tools/soak/core-child.mjs`
- `tools/soak/replay.mjs`
- `tests/event-core-model.test.mjs`
- `tests/event-core-livelock.test.mjs`
- `docs/plan/2026-10-28-p3-plan.md` (append only)
- `docs/evidence/2026-10-28-p3-e7-stalls-idempotency.md` (append only)

---

## 9. Follow-up: fail closed for every write while live

User decision 2026-10-28. Code and tests only; no soak, no bench.

### Rule

An action is **strict** when its class is `write` **or** `on-air-write` and the live state is not `offline`
(`live`, `unknown` or absent; `unknown` counts as live). Everything in section 2 now applies to both classes: the
durable `started` marker plus the chained `action/start` row (its `reason` is the class, `write` or `on-air-write`)
within 250 ms, or the action is refused `audit-unavailable`, never run, and shown the same way (`system.refused` on the
bus and SSE, an audit row on recovery, the rate-limited log line, `stats().refusedNoAudit`).

Not strict: class `read` (any live state), and writes of either class while `offline`. Their behaviour is unchanged.

Panic (`panic.set`, `panic.clear`) does not go through the executor, so this rule does not touch it.

Side effect: an unkeyed write while live (or unknown) used to run synchronously. It now waits for its durable record
(a one-off key), so its `dispatch` is a promise, as live on-air writes already were.

### Code

- `services/event-core/livelock/idempotency.mjs`: `FAIL_CLOSED_CLASSES = ['write', 'on-air-write']`;
  `requiresDurableAudit(act)` uses it. Header comments updated. No other change.

### Tests (`tests/event-core-failclosed.test.mjs`)

- rule: both write classes strict for `live`, `unknown`, absent; not strict `offline`; `read` never strict. **Superseded 2026-10-29** by E4b review finding 1: with an audit attached, every write is strict, offline included, and the live state is re-checked just before execute; see `2026-10-28-p3-e4b-dryrun-two-step.md` §7.
- wrapper: stalled and failing audit refuse a live `write` (keyed, unkeyed, unknown state); executor not called; key
  spent (`skipped: 'refused'`); start info carries `class: 'write'`.
- wrapper: reads while live and unknown, and writes of both classes while offline (keyed and unkeyed), still run with a
  stalled audit.
- core: a live `write` has its durable start row (`reason: 'write'`) and marker before it executes.
- core: stalled audit: live `scene.switch` and live `scene.create` both refused, two `system.refused` events, two audit
  rows after recovery, one log line (rate limit), `refusedNoAudit` 2; the read runs; both writes run once offline.
- api: a refused live `write` is visible over SSE on the api and system roles; nothing executes.

---

## 10. Follow-up: non-blocking Streamer.bot password read

### Before

`streamerbot/credential.mjs` read Credential Manager with `spawnSync('powershell.exe', ...)`: 300+ ms with the event
loop blocked, on every connect and every reconnect.

### Now

- `run()` uses `child_process.spawn` with `shell: false`. Same executable, same three fixed arguments
  (`-NoProfile -NonInteractive -EncodedCommand <fixed script>`), same environment (`UJW_CRED_OP`, `UJW_CRED_TARGET`;
  never the secret), 30 s timeout (kill on expiry). The secret goes in through stdin (`set`) and comes out through
  stdout (`get`) only. stderr is drained and dropped. Errors carry codes only (`credential-spawn-failed: <code>`,
  `credential-read-failed: win32 <n>`, ...), never output.
- `createCredentialStore()`: `get`, `set` and `delete` return promises. Same results and errors as before.
- `credential set|status|delete` CLI: same output and exit codes; it now awaits the store (`cli.mjs`).
- `credentialProvider(target, opts)` caches (decision below), shares one read between concurrent calls, and has
  `invalidate()` and `cached()` (true/false only).
- `connector.mjs`: on every auth failure (`fatal`) it calls `getPassword.invalidate?.()`. A throwing `getPassword` now
  stops with code `auth-password-read-failed` (before, it surfaced as `auth-no-answer`). After the read it checks that
  the socket is still current and not stopped before it authenticates.

### Caching decision

The secret is kept in memory for the provider's lifetime (one connector, so one `serve` run). A reconnect after a
network drop or a Streamer.bot restart does not start PowerShell again. Any auth failure invalidates the cache, so the
next `start()` reads the store again and picks up a changed password. `null` (not stored) and read errors are never
cached. The secret was already in this process's memory during each handshake. Caching keeps it there for the
connector's lifetime, in the same user's process. It is never logged or written. `cache: false` turns the cache off.

### Measurement

`maxLoopDelay()` in the test takes the larger of `perf_hooks.monitorEventLoopDelay` (10 ms resolution) and a 5 ms
interval gap probe, and keeps both on for 50 ms after the step. Reason: under the test runner on Windows the histogram
missed a 300 ms block (max 10.9 ms over 5 samples; cause UNVERIFIED) while the probe saw it (299 ms). A control test
proves the measurement catches a blocking read (a synchronous 300 ms busy wait in `getPassword`: measured >= 250 ms).

```
node --test --test-reporter=spec tests/event-core-failclosed.test.mjs tests/event-core-streamerbot-credential.test.mjs tests/event-core-streamerbot-anonymise.test.mjs tests/event-core-streamerbot.test.mjs
```
```
ℹ real read: 360 ms, max loop delay 20.3 ms, 33 timer ticks
ℹ fake 500 ms read: first connect max delay 15.5 ms, reconnect 11.8 ms, reads 1
ℹ real credential connect + reconnect: max loop delay 12.9 ms
ℹ tests 53
ℹ pass 53
ℹ fail 0
```

- real read: the real async PowerShell path, a test-only target with nothing stored (resolves `null`). 33 timer ticks
  fired during the 360 ms read.
- fake 500 ms read: connect, then a reconnect after `mock.kill()`. The reconnect used the cache (1 read in total). Also
  run with `cache: false` (2 reads), max < 100 ms.
- real credential: a test-only credential (created and deleted by the test), connect plus a reconnect.

Limit: 100 ms. All PASS. One host, one run each; values vary run to run (11–20 ms seen).

### Sync I/O scan of `services/event-core/**`

Searched for `*Sync` calls, `DatabaseSync` and `Atomics.wait`.

Fixed (on the live path):

| Where | What | Fix |
|---|---|---|
| `streamerbot/credential.mjs` | `spawnSync` PowerShell on every connect and reconnect | async `spawn` + cache (above) |
| `streamerbot/anonymise.mjs` `record()` | `mkdirSync`, `readdirSync`, `existsSync`, `writeFileSync` on every alert event, called from the connector's message handler (`serve` without `--mock`) | `node:fs/promises`; one write at a time in arrival order; at most 200 queued (more are dropped); no disk call once a kind is at its cap. The connector counts `fixtures` when the write resolves, notes `fixture-write-failed` on reject. Test: no `*Sync` in the module. |

Start-up or shutdown only (left as they are):

| Where | What | When |
|---|---|---|
| `config.mjs` | `existsSync`, `readFileSync` (profile, key), `mkdirSync`, `writeFileSync` (new key), `chmodSync`, `spawnSync('icacls')` | `resolveDataDir`, `loadKey`, `ensureSecureDir`, `protectPath`: before the API listens |
| `api/discovery.mjs` | `openSync`, `writeSync`, `fsyncSync`, `closeSync`, `renameSync` with `Atomics.wait` 10 ms retries, `unlinkSync` | `publishApiFile` once at start; `remove()` at stop |
| `audit/lock.mjs` | `mkdirSync`, `DatabaseSync` (exclusive lock) | `acquireLock` at audit start; release at close |
| `audit/store.mjs` | `DatabaseSync`, `existsSync`, `realpathSync`, `mkdirSync`, `renameSync`, `rmSync` | opened in the audit worker thread, not the main thread; `backupAudit` is CLI only |
| `livelock/catalogue.mjs` | `readFileSync` | `loadCatalogue` in `createEventCore` |
| `moderation/blocklist.mjs`, `moderation/platforms.mjs` | `readFileSync`, `existsSync`, `readdirSync` | moderation set-up at core start |
| `audit/cli.mjs`, `cli.mjs` | `existsSync` and store calls | CLI commands, not the service |

Not changed, noted: log lines go through `console.log` (`out`). Whether stdout writes are synchronous on Windows depends
on what stdout is (file, pipe or terminal): UNVERIFIED here. Refusal log lines are rate limited to 1 per second.

---

## 11. Gates after sections 9 and 10

```
npm run lint
```
```
docs/evidence/2026-10-28-p3-e7-bench-isolation-dodges.md:236: user-path: path contains this machine's user name (never allowed, not even with a marker)
docs/evidence/2026-10-28-p3-e7-bench-isolation-dodges.md:246: user-path: path contains this machine's user name (never allowed, not even with a marker)
lint: 2 finding(s) (user-path=2), 26 allow marker(s), in 1.6s
```

Both findings were in a file the parallel bench/docs agent owns. It was not touched here. No finding was in a file
changed here. Re-run after this file was written (the parallel agent had fixed its file by then):

```
lint: 0 finding(s), 26 allow marker(s), in 1.7s
```

```
npm test
```
```
ℹ tests 665
ℹ pass 665
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

### Files created or changed (sections 9 to 11)

Changed:

- `services/event-core/livelock/idempotency.mjs`
- `services/event-core/streamerbot/credential.mjs`
- `services/event-core/streamerbot/connector.mjs`
- `services/event-core/streamerbot/anonymise.mjs`
- `services/event-core/cli.mjs`
- `tests/event-core-failclosed.test.mjs` (the parallel agent also edits this file, for two-step confirmation)
- `tests/event-core-streamerbot-credential.test.mjs`
- `tests/event-core-streamerbot-anonymise.test.mjs`
- `docs/evidence/2026-10-28-p3-e7-priority-failclosed-tracer.md` (this file)

Created: none.
