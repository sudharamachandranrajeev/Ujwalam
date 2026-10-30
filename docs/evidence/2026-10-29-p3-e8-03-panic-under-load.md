# E8-03 panic under load: root cause, and a panic path a connection flood cannot block (2026-10-29)

**Result: PASS** for the changes the user decided on 2026-10-29 (see "Decision and change" and "Proof"). The first
investigation pass ended BLOCKED: there was no server defect, and no real panic caller to add a retry to. The
measurements below are from that pass and are kept as evidence.

Test: `tests/event-core-api.test.mjs`, "E8-03: panic gets through while more than maxPending half-open connections
are held and reopened". Under CPU load it failed with `["ECONNREFUSED",200,200,200,200,200,200,200,200,200]`.

## Decision and change (user, 2026-10-29)

The user chose option 1, staged:

- The E8-03 test now runs the attacker in a child process.
- A bounded caller retry (5 tries, 50 to 400 ms) is used once the real panic sender exists.
- Panic must not depend only on the shared TCP port, so it gets a path that a connection flood cannot block.

What was built:

1. **E8-03 test.** The attacker (`FLOOD_SRC`) runs in a child process: the same 256 churning half-open sockets,
   the same 10 single-shot panics 50 ms apart, the same strict all-200 assertion, and no retry. The panics start
   200 ms after the flood is over the pending cap (`pendingEvicted > 0`, waited for with a 20 s bound). The old
   code started them 200 ms after the sockets were opened, which under load could fall inside the attacker's own
   start-up overfill. The in-process version stays as measured evidence (steps 3 and 4 below), not as a TCP test.
2. **In-process panic entry**, `services/event-core/api/panic.mjs` `panicNow(core, { reason })`. It calls the
   gate's `panic` with source `system`, with no I/O and no await. The file header holds the call contract for the
   host and supervisor (Agent C):
   - The hotkey acts in the host process first, without any IPC.
   - Then the host sends `actions.panic` over the system pipe, using the bounded retry.
   - Panic is idempotent, so a retry is safe. Clearing panic is not available on the pipe.
   - The HTTP port must never be the only panic path.
3. **System pipe**, `services/event-core/api/pipe.mjs`. A separate local listener for the system role only:
   - Name and squatting: `\\.\pipe\ujwalam-core-system-<32 hex>`, random per launch. A second listener on the
     same name fails with `EADDRINUSE` (tested).
   - DACL: an owner-only protected DACL, set by Windows PowerShell 5.1 (`powershell.exe` resolved from
     `%SystemRoot%`, fixed `-EncodedCommand`, pipe name passed by environment). It is read back and must equal
     `D:P(A;;0x1f019f;;;<current user SID>)`. Otherwise listen fails with `PIPE_ACL_FAILED` and nothing listens
     (fail closed). Connections that arrive before the DACL is verified are closed without being read.
   - Auth: the system token only; the api token is refused.
   - Methods: `actions.panic` and `core.status` only.
   - Protocol: newline-delimited JSON (an auth line, then JSON-RPC 2.0 lines).
   - Limits: pre-auth 1 s, at most 16 pending connections (the oldest is evicted), 8 authenticated, idle 60 s,
     8 KiB per line.
   - Started by `startService` on Windows (`systemPipe: false` turns it off). If it fails, the service runs without
     it and audits `system-pipe-start` with verdict `error`.
4. **Discovery**: `<dataDir>/system.json` = `{ pipe, pid, startedAt }`. It is written atomically with the
   owner-only ACL, like `api.json`, and removed on stop. The pipe name is never written to `api.json`, which
   api-role clients read. Browsers can read neither file and cannot open a named pipe.
5. **Retry helper**, `services/event-core/api/client.mjs`:
   - `withRetry`: 5 tries, waits of 50, 100, 200 and 400 ms, only on `ECONNREFUSED` or `ECONNRESET`.
   - `pipeRequest`: a single shot. `panicViaPipe`: `pipeRequest` wrapped in `withRetry`.
   - `readSystemFile`: reads `system.json`.
   - No real sender uses the retry yet; that is the staged part.

Measured for the DACL step (scratch `pipeacl2.mjs`, `<user-sid>` replaces the real SID):
```
before: D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user-sid>)
after: D:P(A;;0x1f019f;;;<user-sid>)
before: D:P(A;;0x1f019f;;;<user-sid>)      <- a second, fresh connection: the new DACL covers every instance
```
libuv's default DACL lets Everyone (WD) and Anonymous (AN) read. The test "system pipe: owner-only DACL ..."
asserts this default (`(A;;FR;;;WD)`) on an unprotected pipe, and the owner-only DACL on the protected one.

## Summary of the measurements

1. **The Windows accept queue is capped at about 232 connections, whatever `backlog` is set to.** That is about 200
   in the OS queue (Windows client SKU cap) plus 32 AcceptEx sockets that libuv posts in advance. `backlog: 511`
   (node's default) gives 232; `backlog: 2048` gives 236; `backlog: 128` gives 160 (128 + 32).
2. **The cap cannot be raised from Node.** The Windows `SOMAXCONN_HINT` form (a negative backlog) aborts the
   process inside libuv: `Assertion failed: backlog > 0, file src\win\tcp.c, line 626`.
3. **libuv drains the queue 32 connections per event-loop turn.** The samples show pending going 0, 32, 64, 128.
4. **The test's own burst overfills the queue.** 256 simultaneous connects against a 232 queue give exactly
   24 `ECONNREFUSED` to the attacker in every round, alone or under load.
5. **In the test, the attacker runs in the server's process and event loop.** Under CPU load one loop turn takes
   100-320 ms (p50). That loop also runs the attacker's 256 client sockets. Draining the first burst
   (pending reaching 128) then takes 0.55-1.77 s. A panic SYN sent during that window finds the queue full and gets
   `ECONNREFUSED`. In the 6 failing rounds, every refusal came before pending reached 128. In the 2 passing rounds,
   pending reached 128 before the first panic. Every later panic in every round returned 200, even with
   0.6-1.1 s event-loop stalls. So the failure is the start-up transient of the test's own loop, not ongoing
   starvation.
6. **With the attacker in a separate process (the real threat model), the server keeps up.** Alone: 120/120
   single-shot panics returned 200 (256, 1024 and 4096 churning half-open sockets). Under the full suite at
   concurrency 8: 240/240 returned 200. The attacker never saw a refusal. Pending stayed at 128, with up to
   8,702 evictions per run.
7. **Nothing on the server side changes the in-process result.** The queue size is fixed by the OS, the drain rate
   by libuv (32 per turn), and the turn length by the attacker's own work in the shared loop. The server's
   per-connection work (pending-set insert, eviction, two timers) does not limit throughput: the separate-process
   attacker at 4096 sockets cannot outpace it.
8. **No real panic caller exists.** `grep` over `services/`, `tools/` and `app/` finds `actions.panic` only in the
   method table (`services/event-core/api/methods.mjs:103`) and in tests. `services/studio-ui/backends.mjs`
   (`createCoreClient`) holds only the api token and has no panic method or route. The supervisor in `app/host/`
   is out of scope for this task and has no panic call either.

## Commands and output

All scratch scripts are in the session scratchpad (not committed). Machine: Windows 11 Pro 10.0.26200, 16 logical
CPUs, Node 26.12.1. During every run below, other work also ran on the machine: sibling agents' `app/host/tests`
and studio-ui processes, plus an `npm test` started 2026-10-28 23:31 that is still running. "Alone" means only
this file was run by this task; the machine was not quiet.

### 1. Effective accept-queue size (`backlog.mjs`)

The server blocks its event loop for 4 s so that no accept callback runs. A forked child opens N connects and
counts results.

```
node backlog.mjs 511 600
node backlog.mjs 128 600
node backlog.mjs 2048 600
```
```
{"backlog":511,"N":600,"ok":232,"refused":368,"other":{},"maxConnectMs":121}
{"backlog":128,"N":600,"ok":160,"refused":440,"other":{},"maxConnectMs":93}
{"backlog":2048,"N":600,"ok":236,"refused":364,"other":{},"maxConnectMs":102}
```

### 2. SOMAXCONN_HINT (negative backlog)

```
node -e "const net=require('net');const s=net.createServer();s.listen({host:'127.0.0.1',port:0,backlog:-4096},()=>{})"
```
```
Assertion failed: backlog > 0, file src\win\tcp.c, line 626
```

### 3. Instrumented copy of the test, alone (`flood.mjs`)

Same rig (`tests/event-core-api-helpers.mjs`), the same 256 sockets with a partial header block, reopened 1 ms
after close, and the same 10 panics starting at 200 ms. Added: a 10 ms sampler (server pending, attacker
connecting, attacker refusals) and `monitorEventLoopDelay`. `tPending128` is when the server first held 128
pending. Results are `ms:status`.

```
node flood.mjs 2
```
```
{"round":0,"bad":0,"results":"217:200 349:200 475:200 ...","opened":3019,"errs":{"ECONNREFUSED":24},"evicted":2803,"tPending128":100,"elDelayMs":{"p50":15.2,"p99":23.5,"max":40.5}}
{"round":1,"bad":0,"results":"226:200 382:200 507:200 ...","opened":2667,"errs":{"ECONNREFUSED":24},"evicted":2452,"tPending128":120,"elDelayMs":{"p50":17.5,"p99":32.5,"max":35.1}}
```
Early samples (pending/connecting/sockets/refused) from an earlier round show the 32-per-turn drain and the
overfill of 24: `0/256/256/0 32/33/256/0 128/0/256/24 ...`, `0/256/256/0 64/0/232/24 128/0/256/24 ...`.

### 4. Instrumented copy of the test, under load

```
node --test --test-concurrency=8 tests/*.test.mjs   # background
node flood.mjs 8
```
```
{"round":0,"bad":0,"results":"235:200 407:200 ...","tPending128":156,"elDelayMs":{"p50":21.5,"p99":40.9,"max":45.6}}
{"round":1,"bad":0,"results":"219:200 388:200 ...","tPending128":141,"elDelayMs":{"p50":35.7,"p99":602.9,"max":607.6}}
{"round":2,"bad":1,"results":"1227:ECONNREFUSED 1590:200 2757:200 ...","tPending128":1681,"elDelayMs":{"p50":240.1,"p99":578.8,"max":578.8}}
{"round":3,"bad":1,"results":"1207:ECONNREFUSED 1458:200 2833:200 ...","tPending128":1667,"elDelayMs":{"p50":217.7,"p99":733,"max":733}}
{"round":4,"bad":1,"results":"350:ECONNREFUSED 542:200 1300:200 ...","tPending128":555,"elDelayMs":{"p50":103.5,"p99":739.8,"max":1084.2}}
{"round":5,"bad":1,"results":"1054:ECONNREFUSED 1419:200 3206:200 ...","tPending128":1463,"elDelayMs":{"p50":323.2,"p99":986.2,"max":986.2}}
{"round":6,"bad":1,"results":"1305:ECONNREFUSED 1720:200 3749:200 ...","tPending128":1773,"elDelayMs":{"p50":203,"p99":470.3,"max":595.1}}
{"round":7,"bad":1,"results":"699:ECONNREFUSED 930:200 1765:200 ...","tPending128":972,"elDelayMs":{"p50":128.3,"p99":238.6,"max":247.3}}
totalBad 6
```
Every round had `"errs":{"ECONNREFUSED":24}` on the attacker side. In every bad round the refused panic was the
first one, and its time was earlier than `tPending128`.

### 5. Attacker in a separate process (`xproc.mjs`)

The server is the real rig in one process. The attacker is a forked process with N half-open sockets, each
reopened on close. 40 single-shot panics, 25 ms apart, start after 500 ms.

Alone:
```
node xproc.mjs 256 ; node xproc.mjs 1024 ; node xproc.mjs 4096
```
```
{"N":256,"panic":{"200":40},"ms":1103,"attacker":{"opened":4124,"refused":0},"server":{"pendingEvicted":3996,"pendingTimedOut":0,"pending":128}}
{"N":1024,"panic":{"200":40},"ms":1098,"attacker":{"opened":5244,"refused":0},"server":{"pendingEvicted":5116,"pendingTimedOut":0,"pending":128}}
{"N":4096,"panic":{"200":40},"ms":1093,"attacker":{"opened":8830,"refused":0},"server":{"pendingEvicted":8702,"pendingTimedOut":0,"pending":128}}
```
Under `node --test --test-concurrency=8 tests/*.test.mjs` (started 3 s before):
```
{"N":256,"panic":{"200":40},"ms":1136,"attacker":{"opened":2786,"refused":0},...}
{"N":1024,"panic":{"200":40},"ms":1144,"attacker":{"opened":3581,"refused":0},...}
{"N":256,"panic":{"200":40},"ms":1133,"attacker":{"opened":2466,"refused":0},...}
{"N":1024,"panic":{"200":40},"ms":1140,"attacker":{"opened":3965,"refused":0},...}
{"N":4096,"panic":{"200":40},"ms":1163,"attacker":{"opened":6783,"refused":0},...}
{"N":256,"panic":{"200":40},"ms":1155,"attacker":{"opened":2461,"refused":0},...}
```

### 6. The real test, unchanged code

Alone, 5 runs:
```
node --test --test-timeout=300000 tests/event-core-api.test.mjs   # x5
```
```
✔ E8-03: panic gets through ... (4516.6894ms)
✖ E8-03: panic gets through ... (6783.5114ms)   AssertionError [ERR_ASSERTION]: ["ECONNREFUSED",200,200,200,200,200,200,200,200,200]
✔ E8-03: panic gets through ... (2673.2098ms)
✔ E8-03: panic gets through ... (5377.4795ms)
✔ E8-03: panic gets through ... (4999.8768ms)
```
4 of 5 passed. The test ran 2.7-6.8 s here, against about 1.3 s for the same scenario on a lighter machine in
step 3, so the machine was loaded even for these "alone" runs.

Under the full suite (`node --test --test-concurrency=8 tests/*.test.mjs`), 2 runs: E8-03 failed in both.
```
✖ E8-03: panic gets through while more than maxPending half-open connections are held and reopened (18543.2918ms)
✖ E8-03: panic gets through while more than maxPending half-open connections are held and reopened (15332.8241ms)
```
In both suite runs, two other tests also failed under load. They are outside E8-03 and were not investigated:
`connector: reconnect with a slow (500 ms) password read keeps max loop delay < 100 ms` and `end-to-end: replay a
synthetic export ... (120008 ms)`. The second suite run then hung in `tests/soak-replay.test.mjs` and
`tests/soak-system.test.mjs` for more than 17 minutes, because it ran without `--test-timeout`. Its processes were
stopped. This may be the same concurrent hang noted in D10 (UNVERIFIED).

## Why the test, not the server, is wrong (for the user to confirm)

The property in the review is: an unauthenticated local process must not be able to starve `actions.panic`. The
test checks a stronger and different claim: the first single-shot TCP connect, 200 ms after a 256-socket burst,
is accepted. It checks this with the attacker running in the server's own event loop. Under CPU load, that
measures how fast the test's shared loop drains the attacker's own burst. Windows caps the queue at about 232,
and the attacker's burst alone overfills it by 24. A real attacker in another process cannot slow the server's
loop that way. Steps 5 and 6 show the server holding at 4096 sockets with no refusals, alone and under load.

Residual that stays true: a local flood can make one TCP connect to any Windows listener fail while the queue is
full. Only a caller-side retry or a path that does not use the socket (review item 4, P4) closes that fully.

## Options offered in the first pass (the user chose option 1 plus the pipe and hotkey path; see the top)

- **A. Bounded retry in the real panic caller, with the test using that caller.** Needs a decision on who sends
  panic. The supervisor is in `app/host/` (out of this task's scope). The studio-ui `createCoreClient` has no panic
  method, and adding one plus a route is new feature work. Retry only on `ECONNREFUSED` / `ECONNRESET`, for
  example 5 attempts with 50, 100, 200, 400 ms back-off. Panic is idempotent: a repeat returns `already-panic`.
- **B. Move the attacker into a child process in the test.** Same 256 sockets, same 10 panics, same assertion.
  This models the real threat and measured 0 refusals in 360 calls. It changes the test, so it needs a yes.
- **C. Both A and B.** Plus the out-of-band panic path from review item 4 when the P4 host work starts.

## Proof (after the change)

Test file alone, 5 runs:
```
node --test --test-timeout=300000 tests/event-core-api.test.mjs   # x5
```
```
run 1: ℹ pass 27 ℹ fail 0   tcp-strict 993 ms   pipe+hotkey child-process 1846 ms   pipe+hotkey in-process 2928 ms
run 2: ℹ pass 27 ℹ fail 0   tcp-strict 958 ms   pipe+hotkey child-process 2066 ms   pipe+hotkey in-process 7996 ms
run 3: ℹ pass 27 ℹ fail 0   tcp-strict 1045 ms  pipe+hotkey child-process 2363 ms   pipe+hotkey in-process 7747 ms
run 4: ℹ pass 27 ℹ fail 0   tcp-strict 827 ms   pipe+hotkey child-process 2484 ms   pipe+hotkey in-process 4880 ms
run 5: ℹ pass 27 ℹ fail 0   tcp-strict 825 ms   pipe+hotkey child-process 3243 ms   pipe+hotkey in-process 3483 ms
```
135/135 passed. That includes 5 x 10 strict TCP panics with the child attacker, 5 x 2 x 10 single-shot pipe panics and
5 x 2 x 10 in-process panics during the flood. The pipe panics with the in-process flood are slower (the shared loop
is busy) but never refused.

Full suite once, at concurrency 8:
```
node --test --test-concurrency=8 --test-timeout=300000 "tests/*.test.mjs" "tests/outputs/*.test.mjs"
```
```
✔ service: system pipe for the supervisor, named only in system.json (owner-only), never in api.json; gone after stop (5045.818ms)
✔ E8-03: panic gets through while more than maxPending half-open connections are held and reopened (3908.0938ms)
✔ E8-03: panic via the system pipe and the in-process hotkey entry succeeds during a 256-socket TCP flood (child-process attacker) (4075.3059ms)
✔ E8-03: panic via the system pipe and the in-process hotkey entry succeeds during a 256-socket TCP flood (in-process attacker) (12546.891ms)
✔ system pipe: owner-only DACL (the default one lets Everyone read), fail closed, system token only, two methods, limits (2536.0286ms)
✔ in-process panic entry: engages through the gate as system, idempotent, never throws, no core actions -> refused (36.1286ms)
✔ retry helper: 5 tries, 50/100/200/400 ms, only ECONNREFUSED and ECONNRESET; real refused connect; a missing pipe is not retried (929.2427ms)
ℹ tests 879
ℹ pass 877
ℹ fail 2
✖ connector: reconnect with a slow (500 ms) password read keeps max loop delay < 100 ms; cache skips re-reads (1187.5951ms)
    AssertionError [ERR_ASSERTION]: first connect: max loop delay 115.5 ms
✖ a duration run lasts the whole duration even when its last message comes much earlier (46318.8769ms)
    Error: core child did not become ready in 30 s
```
Neither of the 2 failures is an E8-03 test:

- **Connector loop-delay test.** It failed the same way in both loaded suite runs before the change (step 6).
  It does not touch the API.
- **Soak test.** It starts the real service in a child process (`tools/soak/core-child.mjs`), and that service now
  starts the system pipe too. Alone it passes (`node --test tests/soak-system.test.mjs`: 6/6 pass, the duration
  test in 107 s). Before the change, the same soak files hung for more than 17 min in a loaded suite run (step 6).
  Measured cost of the pipe on start-up: `startService` 433 / 461 ms without it, 700 / 787 ms with it (+270-330 ms,
  quiet machine; scratch `svcstart.mjs`). Whether the pipe's PowerShell start-up under load pushed this run past
  the 30 s readiness timeout is UNVERIFIED.

`npm run lint`: 2 findings, both `eol` (CRLF): `services/studio-ui/launch.mjs` and `ui/js/app.js`. Both files were
changed by other work during this session and are not part of this change. Before those edits, lint reported
0 findings. The files changed here have no findings.

## Checked / not checked

- Checked: queue size, the libuv drain batch, the negative-backlog route, the timeline of the refusals against
  server drain, the separate-process attacker alone and under load, and the real test alone and under the suite.
- Not checked: per-iteration profiling of the shared loop (not needed for the conclusion), behaviour on Windows
  Server SKUs (their queue cap differs; UNVERIFIED), and Linux/macOS.
- After the change, checked: the pipe DACL read back from a fresh connection (owner-only), the default DACL (Everyone
  read), fail closed, name squatting, api and wrong tokens refused, the method allow-list, params validation, the
  pre-auth, line-size and pending-cap limits, idempotent panic, `system.json` (owner-only ACL, not in `api.json`,
  removed on stop) and the retry helper (fake and real refused connects).
- Not checked: a pipe flood by another user. Only read access was possible before the DACL change; after it, no
  access at all. Testing it needs a second account (UNVERIFIED). Also not checked: the host side of the call
  contract (Agent C, `app/host/`, not in scope), and POSIX sockets (the code path exists, UNVERIFIED).
