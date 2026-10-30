# P3 E7 follow-up: event-loop stalls and idempotent actions

Date: 2026-10-28. Host: i7-12650H, 16 logical cores, 31.6 GB, Windows 11 10.0.26200, Node v26.12.1. The host
clock is GMT with offset 0 on this date, so all times are UTC. Raw chat text, names and ids do not appear here.
`<data-root>` is the soak data folder; its real path is not committed.

| Part | Result |
|---|---|
| A. Stalls: cause found in event-core code | **No.** The traced 20-min dense run did NOT reproduce the stall (max 32 ms). The 2 h soak was NOT run, per the stop rule. |
| A. Stalls: evidence on the earlier stalls | Host-wide, outside the event core (correlation only, UNVERIFIED as a cause) |
| B. Idempotent actions | **PASS**: unit tests, restart tests and real kill tests. One residual window is documented (0 runs, never 2). |
| Gates | `npm run lint` PASS, `npm test` 582/582 PASS, `npm run ci` 12/13 (bench FAIL, reported, not fixed) |

---

## A. Event-loop stalls

### A1. What E7 saw (before)

```
node <scratch>/stallsum.mjs <data-root>/soak e7-soak-2h-1x e7-soak-2h-1x-b e7-dense-10x-20m e7s-dense-10x-20m-traced
```
```
{"id":"e7-soak-2h-1x","samples":647,"from":"15:53:48","to":"17:41:21","over100":0,"over1000":0,"top3":["17:16:39=68ms","16:44:59=55ms","16:02:38=47ms"],"sampleGapsOver12s":[],"heapMaxMB":10.93}
{"id":"e7-soak-2h-1x-b","samples":720,"from":"17:43:30","to":"19:43:23","over100":31,"over1000":4,"firstOver100":"19:00:50","lastOver100":"19:43:16","top3":["19:13:06=5092ms","19:12:32=2548ms","19:25:36=2019ms"],"sampleGapsOver12s":["19:12:52+14.5s"],"heapMaxMB":10.98,"auditBatchesPerSampleDuringOver100":[11,16]}
{"id":"e7-dense-10x-20m","samples":121,"from":"19:49:21","to":"20:09:14","over100":4,"over1000":1,"firstOver100":"19:52:21","lastOver100":"19:55:02","top3":["19:55:02=5851ms","19:54:51=207ms","19:52:21=111ms"],"heapMaxMB":18.38}
{"id":"e7s-dense-10x-20m-traced","samples":121,"from":"20:47:32","to":"21:07:25","over100":0,"over1000":0,"top3":["20:52:22=32ms","21:07:12=28ms","20:58:02=28ms"],"heapMaxMB":18.39}
```

`<scratch>/stallsum.mjs` is a read-only script that reads `metrics/timeseries.jsonl` (the 10 s loop-delay samples).
`auditBatches` is the cumulative batch counter.

- The first 2 h soak and soak-b ran **the same code**. The first soak had 0 samples over 100 ms. Soak-b was clean
  for 77 min, then stalled from 19:00:50 to 19:43:16.
- During soak-b's 31 stall samples the cumulative audit batch counter only moved from 11 to 16. So at most 5
  database transactions ran in 43 minutes. Heap stayed at about 11 MB. Database writes and GC cannot account for 5 s.
- Dense run: `result.json` shows `eldMsAll.max` 6669 ms and harness `lagMs.max` 12 301 ms. **The harness (a separate
  process) stalled at the same time as the core.** That points at the host, not at event-core code.
- The power state and system CPU were not recorded for these three runs: there was no system probe yet. UNVERIFIED.

### A2. Cheap checks (main-thread costs)

| Check | Command | Output (decisive lines) |
|---|---|---|
| (a) SQLite on main thread | read `services/event-core/audit/index.mjs`, `writer.mjs` | All audit writes run in a `worker_threads` worker. The main thread holds only the idle lock DB. |
| (a) commit cost, WAL, FULL | `node <scratch>/micro.mjs` | `sqlite commit synchronous=FULL p50 0.35 p99 0.69 max 1.7 ms; NORMAL p50 0.02 ms` |
| (a) sync appends | same | `appendFileSync p50 0.096 p99 0.204 max 0.56 ms` (same on the data root and OS temp) |
| (a)+(b) worst case in-process | `node <scratch>/burst.mjs` | 95 700 events at about 7 975/s, with concurrent verify (83 ms in worker), purge all + VACUUM (115 ms), dedupe-load (86 ms) and retention purge (62 ms): `loop delay max 21.8 ms`, `tracer max late 16.2 ms, 0 stalls > 50 ms`, `GC 91 runs, max 3.4 ms`, `0 drops` |
| (b) GC in the traced run | `result.json` `childStalls.gc` | `{"n":698,"totalMs":132.2,"maxMs":2.1}` |
| (c) Defender (read only) | `Get-MpComputerStatus`, `Get-MpPreference` | `RealTimeProtectionEnabled True`, `ScanScheduleTime 02:00`, `ScanOnlyIfIdleEnabled True`, `ScanAvgCPULoadFactor 50`, exclusions `N/A: Must be an administrator to view exclusions`. Nothing was changed and no exclusion was added. |
| (d) power plan | `powercfg /getactivescheme`, `Win32_Battery` | custom "Ultimate" scheme, `BatteryStatus=2 Charge=100` (AC), AC sleep 0 (never) |
| (d) harness probe | `tools/bench/run.mjs` `powerState` (spawnSync) timed 3 times | `401 / 331 / 318 ms` per call. This stalls **the harness only**, once per 5 min. It is fixed in `tools/soak/system-probe.mjs` (async `execFile`). |
| (d) timers | read `api/sse.mjs`, `audit/index.mjs` | 15 s heartbeat, 30 s dedupe prune, purge timer: all asynchronous and in the worker, none synchronous on the main thread. The stall times (19:00:50, 19:12:32, 19:13:06, 19:25:36, 19:55:02) do not line up with any of these periods. |

### A3. Host activity at the stall times (read only)

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; Id=7045,7040; StartTime='2026-10-28T18:55'; EndTime='2026-10-28T20:05'}
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1000,1001,2000,2014,1150; StartTime=...; EndTime=...}
Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,86,125,2004; StartTime=...; EndTime=...}
Get-Process | Where-Object StartTime -in 18:55..20:05 | Group-Object ProcessName   # names and start times only
```
```
Id 7040: count 8, first 19:37:47, last 20:03:31
19:54:36 7045 service=GHAXM            (a hypervisor driver installed)
19:40:58 7045 service=KslD
Defender: 19:30:32 Id=1150 | 19:40:54 Id=2014 (platform update) | 19:41:09 Id=1000 (scan start) | 19:43:08 Id=1001 (scan end) | 19:51:14 Id=2000 x2
Kernel-Power / thermal / resource exhaustion (41, 86, 125, 2004): 0
claude x3 started 19:00:43,19:22:17,19:54:54     node x4 started 19:00:46,19:00:47,19:22:19,19:22:20
crosvm x11 started 19:54:43 .. 19:54:45          bstrace 19:54:41, adbproxy 19:54:43, crashpad_handler 19:54:37
DefenderSessionHelper 19:41:05
```

| Stall | Nearest host activity |
|---|---|
| soak-b onset 19:00:50 | an agent CLI session started at 19:00:43 (claude, node, MCP server, PowerShell) |
| soak-b 19:22 to 19:25 (2.0 s) | a second agent session started at 19:22:17 |
| soak-b 19:40 to 19:43 | Defender platform update at 19:40:54, then a quick scan from 19:41:09 to 19:43:08 |
| dense 19:54:51 to 19:55:02 (5.9 s; harness 12.3 s) | hypervisor driver installed at 19:54:36, then 11 `crosvm` (VM) processes started at 19:54:43 to 19:54:45 |

The same queries for the traced run window (20:45 to 21:10) give `7045/7040: 1` and `Defender: 0`, and that run was
clean. **Verdict:** every stall cluster lines up with a host event, and in the dense case the harness stalled too.
This is correlation, not a measured cause. The cause is UNVERIFIED: no tracer was running during those stalls.

### A4. The tracer

`services/event-core/diag/stall-tracer.mjs` (new). It uses a 25 ms interval drift detector. A stall over 200 ms writes
one JSONL row with these fields:
- wall and monotonic start and end
- CPU used during the gap, and page faults, fs reads and fs writes in the gap
- the last mark before the gap and the marks during it (current op)
- active handle counts
- caller context (audit queue and in-flight counts, the last DB batch and how long ago it ran, the last DB op, the
  maximum synchronous write)
- GC entries that overlap the gap (PerformanceObserver)
- a watchdog worker that measures its own lateness

Each stall gets one class:
- `gc`: GC covers at least half the gap.
- `main-thread-busy`: CPU covers at least half the gap.
- `process-not-scheduled`: the watchdog thread was late too.
- `blocked-off-cpu`: none of the above.

Window rows are written every 60 s and a summary row at stop. All writes use `fs.promises.appendFile`, so there is no
synchronous disk write on the main thread. The tracer runs in the soak core child (`metrics/stalls.jsonl`) and in the
harness (`metrics/harness-stalls.jsonl`). Tests are in `tests/stall-tracer.test.mjs`:
- A 400 ms busy loop is classed `main-thread-busy`.
- A 400 ms `Atomics.wait` is classed `blocked-off-cpu` with the watchdog not late.
- An idle loop gives 0 stalls.

### A5. The approved traced run (the only run)

Before the run: AC power, sleep never, system CPU 5.5 to 6 % (`Win32_Battery`, `powercfg`, `Get-Counter`). The run is
SYNTHETIC: the same configuration and the same 12 707 events as `e7-dense-10x-20m`. The child ran at BelowNormal
priority.

```
node tools/soak/replay.mjs --data-root "<data-root>" --speed 10 --max-gap-s 1 --duration-s 1200 --sample-s 10 --run-id e7s-dense-10x-20m-traced
```
```
start 2026-10-28T20:47:20Z   exit 0   end 2026-10-28T21:07:27Z
childStalls:   {"thresholdMs":200,"tickMs":25,"ticks":47257,"stalls":0,"maxLateMs":26.5,"buckets":{"over50":0,"over100":0,"over200":0,"over1000":0,"over5000":0},"gc":{"n":698,"totalMs":132.2,"maxMs":2.1},"watchdog":"on"}
harnessStalls: {"ticks":47162,"stalls":0,"maxLateMs":28.7,"buckets":{"over50":0,...},"gc":{"n":120,"totalMs":51.3,"maxMs":5.1}}
eldMsAll:      {"n":220780,"p50":5.36,"p99":7.61,"p999":15.85,"max":32.13,"resolutionMs":5}
harness lagMs: {"p50":0.17,"p95":1.94,"max":16.57}
ingestToDispatchMs: {"n":12707,"p50":0.415,"p95":0.605,"p99":1.018,"max":12.87}   pb12 p95 <= 20 ms: PASS
syncWriteMsMax: 12.521   (soak child's own exec-log/sample appendFileSync, not the live path)
system:  {"samples":122,"powerStart":"ac","powerEnd":"ac","powerStates":["ac"],"cpuBeforePct":4.6,"cpuPctMean":4.9,"cpuPctMax":10.7,"noisySamples":0,"status":"QUIET"}
memory:  PASS (rss growth 1.77 MB / 1.65 %, heap growth -0.48 MB)
drops:   all 0; auditVerify ok rows=25912
```

| Run | Max loop delay | Harness max lag | Power / load |
|---|---|---|---|
| e7-soak-2h-1x (before) | 68 ms | 3.7 ms | NOT RECORDED (no probe), UNVERIFIED |
| e7-soak-2h-1x-b (before) | 5092 ms (sample max), 14.5 s sample gap | 3.8 ms (17 emits only) | NOT RECORDED, UNVERIFIED |
| e7-dense-10x-20m (before) | 6669 ms (histogram max), 5851 ms (sample max) | 12 301 ms | NOT RECORDED, UNVERIFIED |
| **e7s-dense-10x-20m-traced (after tracer, no fix)** | **32.1 ms** (eld), tracer 26.5 ms, 0 stalls over 50 ms | 16.6 ms (tracer 28.7 ms) | **AC throughout, QUIET** (CPU mean 4.9 %, max 10.7 %) |

**Decision (stop rule):** the stall did not reproduce, so there is no clear cause and no root-cause fix. The 2 h
confirmation soak was **not** run. Nothing was tuned and no threshold was raised. "No stall over 100 ms on the live
path" held for this 20-min run only. It is NOT shown for 2 h or under host activity like that in A3.

Purge after the run. The replay runs this itself; the output is from `result.json` `purge`:
```
node services/event-core/cli.mjs audit purge --all --confirm yes --data-dir <soak-data-dir>
audit purge: removed 12707 raw chat rows (all)            exit 0
audit verify: OK rows=25915 integrity=ok                  exit 0
before: chatRaw 12707, scan bodyHits 4 nameHits 1   after: chatRaw 0, scan bodyHits 0 nameHits 0; other run files scanned 10: 0 hits
```

---

## B. Idempotent actions after a crash

### B1. Design

- **Where:** the executor. `services/event-core/livelock/idempotency.mjs` wraps the executor that
  `createEventCore` gives the gate, so it covers every source (chat, rules, UI, API, schedule) and every executor
  (the service executor and the soak stub).
- **Key:** `act.idempotencyKey` = SHA-256 hex of canonical JSON `{ v: 1, origin, id, source, actor, params }`.
  `livelock/gate.mjs` computes it with `idempotencyKeyFor`. The first matching origin wins:
  1. `ck:<source>:<client key>`: a caller key, from `actions.request` param `idempotencyKey`, 8 to 128 characters of
     `[A-Za-z0-9._:~-]`. A bad key is refused `bad-idempotency-key`.
  2. `pm:<dedupe hash>`: the nearest provenance event that came from a platform. Its key is the SHA-256 of
     `platform:platformMessageId`, the same value the persistent dedupe stores. **Why the platform message id:** it is
     the only id that is the same on the original delivery and on a Streamer.bot resend after a restart. The internal
     event id is new for every ingest, so a resend would get a new key. The core keeps a bounded map (4096) from event
     id to dedupe hash, filled when the dedupe first sees the event.
  3. `ev:<event id>`: the nearest event id for events without a platform id (system events). This is stable within
     one process only, and such events are not resent.
  4. No key (UI or API without a client key and without provenance): the action runs as before. A write from these
     sources already needs a single-use confirmation, and confirmations die with the process.
- **API decision:** the key is client-supplied. **The JSON-RPC request id is not used.** It is per connection, often a
  counter that restarts with the client, and absent for notifications, so it would collide across clients and
  restarts. The key is scoped by source.
- **Caveat:** params are part of the key. A rule that puts the internal event id in params gets a new key on a
  resend. Rules must build params from event content, not from `event.id`.
- **Flow for a keyed action:**
  1. A known key (completed, running, or ambiguous from before a restart) is skipped: `{ skipped: 'completed' | 'running' | 'ambiguous' }`.
  2. The key is claimed in memory.
  3. A durable `started` row is queued and sent to the worker immediately (`setImmediate`, not the 100 ms batch
     timer). The action waits **asynchronously** for the commit (synchronous=FULL), at most 250 ms. The loop is never
     blocked.
  4. The action runs.
  5. A `completed` row is queued at normal batch timing.
- **Fail open:** when the start marker times out or the audit fails, the action still runs. This is counted
  (`startUnconfirmed`, `startFailed`).
- **Persistence:** the new `action_keys` table (migration v3, `WITHOUT ROWID`, index on `started_at`) is written by
  the existing audit worker in the same transaction as the other rows. It holds hashes only.
- **Start-up:** before `core.ready` resolves, the last hour of keys is loaded:
  - completed rows mean skip;
  - started but not completed rows are `ambiguous`, also skipped, never re-run. They are counted in
    `stats().idempotency.load.ambiguous` and audited as one `system/action-ambiguous` row with the count.
- **Retention:** 1 h. The worker prunes rows older than `ACTION_KEEP_MS` (3 600 000) at most once a minute. In memory
  the limit is 1 h and at most 50 000 keys, oldest out first. A resend older than 1 h runs again.
- **Cost (scratch measurement, 2000 events at about 500/s, real audit worker, temp dir):**
  ```
  node <scratch>/idemlat.mjs 2000 keyed     -> {"p50":"0.601","p95":"0.936","p99":"2.276","max":"7.632","eldMaxMs":"6.9","startDurable":2000,"startUnconfirmed":0}
  node <scratch>/idemlat.mjs 2000 unkeyed   -> {"p50":"0.052","p95":"0.111","p99":"0.202","max":"1.466","eldMaxMs":"9.5"}
  ```
  Ingest to execute rises by about 0.55 ms at p50 and 0.8 ms at p95. That is inside PB12 (p95 ≤ 20 ms). The loop
  delay did not change.

### B2. Crash windows (measured in B4)

| Kill point | Durable state | Resend after restart | Runs |
|---|---|---|---|
| before the `started` commit | nothing | runs | **1** |
| after the `started` commit, before execute | started only | skipped (ambiguous) | **0: residual window, the action is lost** |
| after execute, before `completed` is queued | started only | skipped (ambiguous) | **1** |
| after `completed` is queued | started (+ completed if committed) | skipped | **1** |
| start marker late (> 250 ms) or audit failing | maybe none | runs again | **up to 2** (fail open, counted) |

**Residual window, stated precisely:** from the worker's COMMIT of the `started` row, through the ack `postMessage`
and the main-thread promise callbacks, to the call of `executor.execute`. Without the test hook this is only message
passing and microtasks (no I/O, no timers). A kill inside it loses the action (0 runs). It never duplicates.

Options to close it (proposed, not built):
1. The target takes the key (the studio app, P4/P6) and dedupes on its side, giving exactly once end to end.
2. Re-run ambiguous keys only for actions marked safe to repeat in the catalogue (`idempotentTarget: true`).
3. Show ambiguous keys in the dashboard for a manual re-run.

The fail-open row is a choice: a slow disk must not hold up an effect on the live path.

### B3. Unit, restart and API tests

```
node --test --test-reporter=spec tests/idempotency-crash.test.mjs tests/event-core-idempotency.test.mjs
```
```
✔ wrapper: a completed key is skipped, unkeyed actions always run, a bad key counts as unkeyed
✔ wrapper: a key in flight is skipped (running); a throwing action still completes its key
✔ wrapper: with persistence the start marker is awaited before the action runs, then done is queued
✔ wrapper: fail open when the start marker is late or fails (counted), never blocks
✔ wrapper: seed marks completed and ambiguous keys; retention and the key cap are bounded
✔ key: platform origin is stable across processes; action, params, source and actor change it
✔ gate: a malformed client key is refused; the act carries idempotencyKey only when there is an origin
✔ restart: a completed action is not run again when the same platform message is resent
✔ restart: a started-but-not-completed key is ambiguous, skipped, counted and audited
✔ audit: action keys persist with started_at/completed_at and only hash keys are accepted
✔ store: action keys older than the retention (1 h) are pruned by the writer
✔ api: actions.request with an idempotencyKey runs once per key; a bad key is invalid params
✔ kill at before-start: restart and resend -> ran 1 time(s), never twice
✔ kill at after-start: restart and resend -> ran 0 time(s), never twice
✔ kill at after-execute: restart and resend -> ran 1 time(s), never twice
✔ kill at after-done: restart and resend -> ran 1 time(s), never twice
✔ no kill: clean run, restart, resend -> ran once, the resend is skipped as completed
ℹ tests 17   ℹ pass 17   ℹ fail 0
```

The restart tests use a 1 ms dedupe window on purpose, so the dedupe misses the resend and only the idempotency layer
stands between the resend and a second run.

### B4. Kill test

The test is `tests/idempotency-crash.test.mjs` and its child is `tools/idem-crash-child.mjs`. Each case runs these
steps:

1. A real child process runs the full core with the audit worker on a temp database.
2. One invented message goes through dedupe, the bus, a rule stub, the gate, the idempotent executor and the executor.
3. The test-only `phaseHook` (never set by the service) pauses the child at the chosen phase and prints `PHASE <name>`.
4. The parent runs `taskkill /F /PID <pid>` and asserts a non-zero exit.
5. The parent restarts the child on the same database and resends the same `platformMessageId`.
6. It counts the executor's lines. The executor writes them with `appendFileSync`, so a kill cannot lose a run.
7. It restarts and resends a second time.

Results are in B3: 1 / 0 / 1 / 1 runs, never 2. The second resend runs nothing more.

### B5. Migration

`audit/schema.mjs` adds v3 `action-keys`. `tests/event-core-audit.test.mjs` checks:
- a fresh database migrates `{from:0,to:3}`;
- a database written at v2 (made with `migrate(db, MIGRATIONS.slice(0,2))`) moves `{from:2,to:3}` with its
  `dedupe_keys` rows kept;
- the injected forward-only test is now v4.

Old code opening a v3 database refuses it with `SCHEMA_TOO_NEW`. This is the existing rule.

---

## C. Gates

```
npm run lint   -> lint: 0 finding(s), 1 allow marker(s), in 1.5s
npm test       -> ℹ tests 582  ℹ pass 582  ℹ fail 0  ℹ skipped 0  (141.7 s)
npm run ci     -> ci: 12/13 passed in 247.8s   ci: FAILED: bench
```
The bench failure is reported, not fixed, and the baseline is unchanged:
```
bench: REGRESSION private-scan-worktree-wall.wall_ms: 875.06 -> 1032.24 ms (18.0 % worse, limit 10 %)
node tools/bench/run.mjs --only private-scan-worktree-wall
bench: REGRESSION private-scan-worktree-wall.wall_ms: 875.06 -> 1036.75 ms (18.5 % worse, limit 10 %)
```
This failure is **not** the known audit-bench ordering failure. In this run the audit metrics passed
(`ingest_p95 0.01 ms`, `block_p95 0.15 ms`, `171 672 rows/s`). The private-scan wall time regresses when run alone too.
The cause is UNVERIFIED. The likely cause is worktree growth: 107 untracked files, which include the P3 files and
this task's 5 new files.

## D. Not checked / UNVERIFIED

- The cause of the E7 stalls. A3 shows correlation only. Nothing traced the stalls when they happened.
- "No stall > 100 ms" over 2 h, and under host load such as an agent session start, a Defender scan or a VM start.
- Power and CPU state for the three earlier runs (no probe then).
- The tracer's classes on a real host-wide freeze. Only the synthetic busy and blocked cases are tested.
- The residual window's real length without the hook. It was not measured in isolation; it is reasoned from the code
  path above.
- The bench private-scan regression cause.

## E. Proposed next steps (not run; each needs the user's yes)

1. **Controlled reproduction.** Repeat the traced dense run, and at a noted time start one host event: an agent CLI
   session, a Defender quick scan, or the Android emulator (`crosvm`). Capture a WPR trace at the same time (`wpr
   -start CPU -start DiskIO`, built into Windows, no install). The tracer class (`process-not-scheduled` versus
   `blocked-off-cpu`) and the trace would show the cause.
2. **Keep the tracer in the service.** Run it while live and send its summary to the health dashboard. The cost is
   one 25 ms timer and one watchdog thread.
3. **Live priority.** Long test runs use BelowNormal, as the resource rule asks. The live event core should run at
   Normal priority so that a Normal-priority burst on the host cannot starve it. This needs a decision.
4. **Close the idempotency residual window** with option 1 or 2 in B2.
5. **Bench:** decide whether the private-scan baseline is re-accepted after the worktree is committed
   (`npm run bench -- --accept "<reason>"`, user only).

## Files created or changed

Created:
- `services/event-core/diag/stall-tracer.mjs`
- `services/event-core/livelock/idempotency.mjs`
- `tools/idem-crash-child.mjs`
- `tests/stall-tracer.test.mjs`
- `tests/event-core-idempotency.test.mjs`
- `tests/idempotency-crash.test.mjs`
- `docs/evidence/2026-10-28-p3-e7-stalls-idempotency.md`

Changed:
- `services/event-core/index.mjs`
- `services/event-core/dedupe.mjs`
- `services/event-core/livelock/gate.mjs`
- `services/event-core/livelock/index.mjs`
- `services/event-core/api/methods.mjs`
- `services/event-core/audit/index.mjs`
- `services/event-core/audit/schema.mjs`
- `services/event-core/audit/store.mjs`
- `services/event-core/audit/worker.mjs`
- `services/event-core/audit/writer.mjs`
- `tools/soak/core-child.mjs`
- `tools/soak/replay.mjs`
- `tools/soak/system-probe.mjs`
- `tests/event-core-audit.test.mjs`

## Stall-tracer test failure under load

Date: 2026-10-28. During `npm run ci` under heavy background load (suite 169 s instead of 29 s),
`tests/stall-tracer.test.mjs:38` failed with `TypeError: Cannot read properties of null (reading 'label')`.

**Cause: a timing assumption in the test, not a tracer bug.** The tracer starts a stall gap at the time the
next tick was due (`lastMono + tickMs`). The test did `await sleep(150); t.mark('busy:start'); busy(400)`.
The sleep timer and the 25 ms interval can expire in the same libuv timers pass. If the sleep callback runs
first, or the tick is already overdue, `busy:start` is made at or after the gap start. The tracer then puts it
in `marks.during` (as `during[0]`, `atMs` 0 to 1.5) and sets `marks.lastBefore` to `null`, because no mark was
made earlier. That record is correct and complete: `lastBefore: null` is the documented value for "no mark
before the gap", and no code reads `marks` (only humans read `stalls.jsonl`). The test read
`b.marks.lastBefore.label` without a check. Load is not needed: the race also happens on an idle machine.

**Fix (test only).** Before each injected stall the test now waits, with a bounded timeout (2 s, clear error
message), until the tracer has just ticked (`afterTick`: polls `t.summary().ticks` on `setImmediate`). The
next mark is then microseconds after a tick, so it is before the gap start. The assertions are unchanged; one
`assert.ok(b.marks.lastBefore, ...)` was added before the `.label` read, so a regression fails with the marks
in the message, not with a TypeError. The tracer is unchanged.

**Repro.** Load = a scratch Node process with 4 spinning worker threads at BelowNormal priority (16 logical
CPUs). Probe = a scratch copy of the busy half of the test that counts where `busy:start` lands.

```
for i in $(seq 1 15); do node --test tests/stall-tracer.test.mjs > run.txt 2>&1 || grep -m1 Error run.txt; done
```

| Run | Before fix | After fix |
|---|---|---|
| test file 15x, idle | 1/15 fail (`TypeError ... reading 'label'`) | 0/15 fail |
| test file 15x / 20x, 4-thread load | 1/15 fail (same error) | 0/20 fail |
| probe 20x, idle, no sync | 3/20 mark inside gap | - |
| probe 20x, load, no sync | 2/20 mark inside gap | - |
| probe 5x, 30 ms lateness simulated before the mark | 5/5 mark inside gap | - |
| probe 40x, idle, with `afterTick` | - | 40/40 mark before gap |

Probe output (before fix, idle): `in gap: {"lastBefore":null,"during":[{"label":"busy:start","atMs":1.5},{"label":"busy:end","atMs":401.5}]}`.

After the fix: `npm run lint` 0 findings; `npm test` 587 tests, 587 pass, 0 fail.

Residual risk (UNVERIFIED): the main thread can still be descheduled for more than 25 ms in the microseconds
between the tick and the mark. Not seen in 75 synced runs. Other assertions in the same test that depend on the
host are not changed: `w.watchdog.late === false` and `w.cls === 'blocked-off-cpu'` can fail if the whole
process is not scheduled during the 400 ms wait; that is the tracer reporting the host correctly.

Changed:
- `tests/stall-tracer.test.mjs`
- `docs/evidence/2026-10-28-p3-e7-stalls-idempotency.md`

## Blockers before C2/C3

Added 2026-10-28 by user decision. Existing text above is unchanged.

1. **Lost-action gap. BLOCKER.** The residual window in B2 (kill after the durable `started` commit, before
   `executor.execute`: the resend is skipped as ambiguous and the action runs 0 times) is accepted in P3 only because
   chat actions are dry-run in P3. It must be closed, with a test, before any chat-triggered action is switched on in
   C2/C3. The same entry is in `docs/plan/2026-10-28-p3-plan.md` under "Blockers before C2/C3".

The fail-open row in B2 ("start marker late or audit failing: runs, up to 2") no longer holds for on-air writes while
live: those now fail closed. See `docs/evidence/2026-10-28-p3-e7-priority-failclosed-tracer.md`.
