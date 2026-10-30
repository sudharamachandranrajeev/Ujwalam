# P3 E7: persistent dedupe, replay soak, latency, crash recovery

Date: 2026-10-28. Machine: 12th Gen Intel i7-12650H (16 logical cores), 31.6 GB RAM, Windows_NT 10.0.26200, Node v26.12.1.
All paths below use `<data-root>` for the local data root (`paths.data_root` in `data/profile.local.json`). Raw time series, per-event latency CSVs and run directories are in `<data-root>/soak/<run-id>/` and are not committed. This file holds counts and timings only: no chat text, user names, ids, VOD ids or export file names.

Everything here ran against a mock Streamer.bot on loopback. Nothing was sent to any platform. The real Streamer.bot error shape, and behaviour with a real stream, are UNVERIFIED.

## 1. What was built

| Item | Change |
|---|---|
| Lint fix | `secret` rule in `tools/lint.mjs` skips a value shaped like an environment-variable name (`^[A-Z][A-Z0-9_]{2,}$`). Positive and negative tests in `tests/lint.test.mjs`. `services/event-core/api/discovery.mjs` has plain string constants again. |
| Persistent dedupe | Audit DB migration v2 `dedupe-keys` (`dedupe_keys(key, seen_at)`, not part of the hash chain). Key = SHA-256 hex of `platform:platformMessageId`. Written by the audit worker in batches (third queue, off the hot path). Last 120 s of keys loaded at start-up (`core.ready`) and seeded into the in-memory dedupe. Rows older than 150 s are pruned by the writer, at most every 30 s of event time. |
| Replay harness | `tools/soak/replay.mjs` (replay and crash modes), `tools/soak/core-child.mjs` (core process under test), `tools/soak/system-probe.mjs` (power and system CPU load). |
| Mock cleanup | `tools/mock/mock-streamerbot.mjs`: `openMocks()` tracks open mocks; the CLI stops itself after `--ttl-s` (default 900 s, 0 = never) and on SIGINT/SIGTERM. `tools/stray-procs.mjs` lists mock and soak processes still running. `npm run ci` has a last step `stray-mocks` that fails and names the pid. Streamer.bot test files assert `openMocks() === 0` when they end. |

## 2. Input

- Export used: the longest Twitch VOD chat export of at least 2 h that holds a message (22 exports on this machine; only 73 comments in all of them).
- Export length 3.70 h (13 327 s). Messages: 18. First to last message: 10 114 s (2.81 h).
- Real chat rate: 18 / 222 min = 0.081 messages per minute over the whole export, 0.107 per minute first to last. In the first 2 h window: 17 messages (0.142 per minute).
- No export on this machine is both 2 h or longer and busy. The "loop one" fallback was not needed for the 2 h runs (17 messages fall inside 7 200 s, no wrap). The dense run does loop it (see section 6).
- **This real chat is very sparse. The 2 h soak proves stability at low load, not throughput.** A heavier soak needs a busier chat export or a labelled synthetic load (proposed in section 10, not run).

## 3. Exact commands

```
node tools/soak/replay.mjs --data-root <data-root> --speed 10 --sample-s 10 --run-id e7-10x-full
node tools/soak/replay.mjs --data-root <data-root> --speed 1 --duration-s 7200 --sample-s 10 --run-id e7-soak-2h-1x-b    # background, BelowNormal
node tools/soak/replay.mjs --data-root <data-root> --mode crash --kills 5 --seed 1 --sample-s 5 --run-id e7-crash-5
node tools/soak/replay.mjs --data-root <data-root> --mode crash --kills 5 --seed 1 --sample-s 5 --run-id e7-crash-5b     # repeat, same seed
node tools/soak/replay.mjs --data-root <data-root> --mode crash --kills 15 --seed 7 --jitter-max-ms 20 --run-id e7-crash-gapprobe-15
node tools/soak/replay.mjs --data-root <data-root> --speed 10 --max-gap-s 1 --duration-s 1200 --sample-s 10 --run-id e7-dense-10x-20m   # SYNTHETIC load
```

The flags of the 10x, first-soak and crash runs are reconstructed from the fields in each `result.json` (speed, duration, gap cap, looping, sample count); the shell history was not kept. Each run purges at the end with `node services/event-core/cli.mjs audit purge --all --confirm yes --data-dir <soak-data-dir>`. The replay process and the core child set BelowNormal priority themselves. Runs were one at a time, never alongside tests or CI.

Method notes. Latency = `performance.now() - event.mono` inside the core process (starts when the event is stamped, so WebSocket parse and mapping before ingest are not counted). Bus-to-SSE latency is measured by an SSE client inside the same process on the real HTTP API. Event-loop delay uses `monitorEventLoopDelay` with a 5 ms resolution, so an idle loop reads about 5.5 ms. CPU is a percentage of one core. Memory growth: baseline = median of the first 3 samples at or after 600 s, end = median of the last 3; PASS if at most 5 % or 100 MB.

## 4. Results: real-chat runs

| Run | Wall | Events | Ingest-to-dispatch p50 / p95 / p99 / max (ms) | Bus-to-SSE p95 (ms) | RSS growth after 10 min warm-up | Peak RSS | CPU mean (one core) | Drops (audit, bus, SSE) | PB-12 (p95 <= 20 ms) | PB-15 |
|---|---|---|---|---|---|---|---|---|---|---|
| 10x, full export | 1 015 s | 18 | 0.61 / 4.07 / 4.07 / 4.07 | 4.46 | -0.8 % (-0.64 MB), 415 s after warm-up | 82.3 MB | 0.14 % | 0 / 0 / 0 | PASS | PASS |
| 2 h 1x soak (second run, valid) | 7 204 s | 17 | 0.72 / 4.32 / 4.32 / 4.32 | 4.72 | -12.6 % (-9.94 MB), 6 604 s | 82.1 MB | 0.14 % | 0 / 0 / 0 | PASS | PASS |

Notes. With 17 or 18 events the percentiles are the same few cold-path events; p95 equals max. Heap in the soak: baseline 10.50 MB, end 10.41 MB, peak 10.98 MB. Queues never exceeded 2 (audit), 1 (raw), 1 (dedupe). Audit `verify` ok and `integrity_check` ok at the end of both. Event-loop delay (5 ms resolution): 10x run p50 5.63, p99 8.85, max 31.7 ms; soak p50 5.61, p99 11.1, p999 24.5, **max 5 092 ms** (see "host stalls").

Host stalls. From about 4 650 s into the 2 h soak, event-loop delay spiked repeatedly (about 30 samples above 100 ms, largest 2.5 s and 5.1 s), and one 10 s sample took 24.5 s (sample gap 14.5 s) at about 19:12 UTC. The stalls hit the event loop, not the ingest path, so they do not move p95; they would move p99+ and max had there been more events. Cause: UNVERIFIED. No other E7 job was running (run time windows do not overlap, checked from file times), and the operating system log shows no sleep, resume, power-source or time-change event. It was not recorded whether power or system load was the cause (see section 5).

## 5. Power and system load: NOT RECORDED during these runs

The runs above (10x, both soaks, the three crash runs, the dense run) did **not** log AC/battery state or system-wide CPU load. This is stated plainly and is not backfilled. After the fact, the coordinator checked the machine: AC power (BatteryStatus 2, 100 %), AC sleep timeout 0 (never), CPU load 1 %. That is a single check made after the soaks ended, not data from inside the soak windows.

Consequence: no soak sample can be marked `noisy` (the E0 bench thresholds are more than 25 % system CPU before start, more than 50 % during, or battery). The measured-budget table in section 9 therefore carries that caveat.

Fix for next time (built in this step): `tools/soak/system-probe.mjs` reuses the bench probes (`powerState`, `cpuSnap`, `cpuPct` exported from `tools/bench/run.mjs`) and the bench thresholds (`NOISE`). `replay.mjs` starts it before a run (power plus a 1 s idle measurement) and samples every `--sample-s` seconds (power re-read every `--power-every-s`, default 300 s), then writes an end row. Rows go to `<run>/metrics/system.jsonl`: `{t, wall, kind, cpuPct, power, noisy, reasons}`. `result.system` holds the summary (`QUIET` or `NOISY`, power at start and end, CPU mean and max, noisy sample count and times). `--no-system-probe` switches it off, and then `result.system.status` reads `NOT RECORDED`. Tests: `tests/soak-system.test.mjs`.

## 6. SYNTHETIC stress run: 10x, gaps capped at 1 s, 20 min (not real-chat results)

Input label: **SYNTHETIC LOAD**. The 18 real messages are replayed in a loop (ids get a `~N` suffix so each pass is new to the dedupe) with every gap capped at 1 s and speed 10, so message timing and volume are not real. It was added to put real load (12 707 events) through the path, because the real export is too sparse to stress anything. It is a separate section and is **not** used in the measured-budget table.

| Metric | Value |
|---|---|
| Wall / events | 1 204 s / 12 707 (635 per minute, about 7 800 times the real export rate) |
| Ingest-to-dispatch p50 / p95 / p99 / max | 0.45 / 1.06 / 17.6 / 45.3 ms |
| Bus-to-SSE p50 / p95 / p99 / max | 0.61 / 1.56 / 48.8 / 12 390 ms (the max is a host stall, below) |
| Event-loop delay (5 ms resolution) | p50 5.45, p99 10.9, p999 22.2, max 6 669 ms |
| CPU mean / max (one core) | 0.88 % / 2.19 % |
| RSS after warm-up | 98.2 to 99.6 MB (+1.44 %, +1.41 MB, over 604 s): PASS |
| Heap used | 16.65 to 15.51 MB (-6.9 %); peak 18.4 MB; peak RSS 100.4 MB |
| Audit queue max | audit 4, raw 2, dedupe 2 |
| Drops | audit 0, raw 0, dedupe 0, lost 0, write errors 0, SSE 0, bus 0 |
| Action gate | 25 668 requests: 12 707 reached the executor probe; 8 471 refused `chat-not-allowed`; 4 236 refused `chat-forbidden`; 254 confirmations created |
| Audit chain | verify ok, 25 912 rows, integrity ok |
| PB-12 | PASS (p95 1.06 ms) |
| PB-15 | PASS (+1.44 %). Only 604 s are past the 10 min warm-up; this is a short window. |

Host stall: one stall at about 340 to 351 s into the run (event-loop delay 5.85 s in one sample, harness timer lag 12.3 s). 141 of 12 707 events were above 10 ms. Excluding the 30 s around the stall, p50 / p95 / p99 / max = 0.44 / 0.98 / 2.06 / 21.4 ms. Cause UNVERIFIED (not recorded; I was running read-only diagnostics at that time, which may or may not matter).

## 7. Crash and recovery

Method. The core child runs against the mock; at a seeded random message number the harness takes the following steps.

1. It requests 3 confirmations (`scene.create`) through the API and records `api.json` (port and tokens).
2. It sends the last message, waits a short jitter, then runs `taskkill /F /PID <pid>`.
3. It reads the database read-only before restart.
4. It restarts the child and resends the last 200 envelopes, then sends one fresh probe message.

The check list is below. Duplicate execution is counted per message-id hash from the executor log (appended synchronously, so a kill cannot lose a line).

Kill points for seed 1 (message number): 147, 197, 278, 386, 494. Speed 10, gap cap 1 s.

### Run `e7-crash-5` (the 5-kill run)

| Kill | At msg | Jitter before kill | Audit after kill / after restart | Executed in last 120 s | Executed but key not persisted (gap) | Max age of gap key | Persisted but not executed | Resent / seeded keys / deduped by core | Duplicate dispatches (unexplained) | Pending confirms refused `unknown-confirm` | `api.json` replaced, tokens new, old token 401, new token 200 | SSE after restart | Pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 147 | 18 ms | ok / ok | 147 | 0 | 0 | 0 | 147 / 147 / 147 | 0 (0) | 3 of 3 | yes | 1 | yes |
| 2 | 197 | 106 ms | ok / ok | 198 | 0 | 0 | 0 | 197 / 198 / 197 | 0 (0) | 3 of 3 | yes | 1 | yes |
| 3 | 278 | 113 ms | ok / ok | 280 | 0 | 0 | 0 | 200 / 280 / 200 | 0 (0) | 3 of 3 | yes | 1 | yes |
| 4 | 386 | 4 ms | ok / ok | 389 | 1 | 4 ms | 0 | 200 / 388 / 199 | 1 (0) | 3 of 3 | yes | 2 | yes |
| 5 | 494 | 7 ms | ok / ok | 498 | 0 | 0 | 0 | 200 / 498 / 200 | 0 (0) | 3 of 3 | yes | 1 | yes |

"Audit ok" = `PRAGMA integrity_check` ok and the hash chain verifies (`audit verify`), both before and after the restart. Wall 74 s. Final: 619 executed keys, 1 key executed twice (kill 4, inside the measured gap, so explained). Final purge removed 619 raw chat rows. The kill 4 duplicate is the only duplicate dispatch in the five kills: the message was executed, its key was still in the audit queue or the last uncommitted batch when the process died, and the resend ran it again. No other duplicates.

### Repeat of the same seed: `e7-crash-5b`

All five kills pass every check. One gap event again, at kill 5 this time (jitter 7 ms, key age 9 ms; kill 4 had none). Run-to-run timing is not deterministic, so which kill lands in the gap moves. Kill call to child exit took 112 to 166 ms (`taskkill` start-up included). Purge removed 619 rows; scan 0.

### Gap probe: `e7-crash-gapprobe-15` (15 kills, jitter at most 20 ms, seed 7)

All 15 kills pass every check (audit ok after kill and restart, confirms refused 3 of 3, `api.json` replaced, tokens new, old token 401, new token 200, SSE after restart). Gap events: 1 of 15 (kill 8, jitter 3 ms, key age 6 ms, 1 duplicate dispatch, explained by the gap). Persisted but not executed: 0 in all 15. 1 330 executed keys, purge removed 1 330 rows, scan 0.

### Dedupe gap (measured)

| Quantity | Value |
|---|---|
| Kills measured | 25 (5 + 5 + 15), all with a jitter of at most 250 ms between the last emit and the kill |
| Kills with a gap event | 3 (one event each) |
| Oldest gap key | 9 ms before the kill (others 4 ms and 6 ms) |
| Stated maximum | the audit batch timer (100 ms) plus one write. The harness fails a kill if the age exceeds 250 ms. None did. |
| Persisted but not executed (a lost action) | 0 in 25 kills |

Design consequence, stated plainly: the dedupe key is persisted before the action is dispatched, so a kill between the two could drop an action (at-most-once). That window was not seen (0 in 25 kills). The opposite window (action dispatched, key not yet persisted) is the measured gap and produces one extra dispatch on a resend.

## 8. Purge proof

| Run | Command | Output | Raw chat rows before / after | DB size before / after | Text scan before / after |
|---|---|---|---|---|---|
| 10x full | `node services/event-core/cli.mjs audit purge --all --confirm yes --data-dir <soak-data-dir>` | `audit purge: removed 18 raw chat rows (all)` | 18 / 0 | see run dir | body hits 4 / 0 |
| 2 h soak | same | `audit purge: removed 17 raw chat rows (all)`; `audit verify: OK rows=40 integrity=ok` | 17 / 0 | 57 344 / 57 344 bytes (shm 32 768, wal 0, lock 0) | body hits 4, name hits 1 / 0 and 0 |
| `e7-crash-5` | same | `removed 619 raw chat rows (all)`; `audit verify: OK rows=1299 integrity=ok` | 619 / 0 | 761 856 / 663 552 bytes | 0 after |
| `e7-crash-5b` | same | `removed 619 raw chat rows (all)`; `audit verify: OK rows=1299 integrity=ok` | 619 / 0 | 761 856 / 663 552 bytes | 0 after |
| gap probe 15 | same | `removed 1330 raw chat rows (all)` | 1 330 / 0 | n/a | 0 after |
| Dense (synthetic) | same | `audit purge: removed 12707 raw chat rows (all)`; `audit verify: OK rows=25915 integrity=ok` | 12 707 / 0 | 12 664 832 / 10 973 184 bytes (shm 32 768, wal 0) | body hits 4, name hits 1 / 0 and 0 |

The scan counts replayed message bodies (6 characters or more) and display names (5 characters or more) found in the database files and in the other files of the run directory (7 files). It reports counts only. It is a weak check (short texts are not scanned); the authoritative proof is `chat_raw` = 0 with the chain still verifying. The purge ran on the dense run's data dir (901 rows was an intermediate count; the final was 12 707 and went to 0).

## 9. Budget comparison and proposed replacements (NOT applied)

PB-12 (event core internal p95 at most 20 ms): PASS on every run, real (4.07 and 4.32 ms) and synthetic (1.06 ms). PB-15 (memory growth at most 5 % or 100 MB over 2 h after warm-up): PASS on the 2 h soak (-12.6 %, -9.94 MB); the 10x run (415 s past warm-up) and the dense run (604 s) are shorter than 2 h.

Proposal only. No baseline, budget or `docs/architecture/performance-budgets.md` value was changed. The user decides.

| Budget | Current | Measured, real-chat runs | Measured + 20 % | Recommendation |
|---|---|---|---|---|
| PB-12 p95 ingest-to-dispatch | 20 ms | 4.32 ms (2 h soak, the larger of the two real runs) | 5.18 ms | Do not adopt yet: 17 events, cold start, p95 is the max. Keep 20 ms until a busier real export exists. |
| PB-15 memory growth, 2 h after warm-up | 5 % or 100 MB | -12.6 % / -9.94 MB (RSS fell) | not computable (negative growth) | Keep as is. |
| Dedupe gap bound (new) | none | 9 ms oldest gap key (25 kills) | 10.8 ms | Keep the 250 ms test bound; a tighter value needs more kills and the power log. |

Synthetic dense run, for information only (not part of the proposal): p95 1.06 ms (+20 % = 1.27 ms), RSS growth +1.44 %.

Caveat on every row: no power or load was recorded, so none of these windows could be marked noisy (section 5). Host stalls were seen in the 2 h soak and the dense run; they affect max and p99 only.

## 10. Questions answered

- **Why did the 2 h soak run twice?** The first run (`e7-soak-2h-1x`) ended at 6 463 s of a planned 7 200 s. Cause: a bug in the replay loop. `play()` stops at the first message whose scheduled time is past the duration; the 18th message lies after 7 200 s, so the loop ended right after the 17th message (at about 6 463 s) and the run then moved straight to shutdown, because nothing waited out the rest of the duration. Evidence: `childExit` 0, 647 samples at 10 s (6 470 s, continuous with no gap), 17 messages sent, `durationS` 7 200, `wallSeconds` 6 463; the operating system System log (Kernel-Power, Power-Troubleshooter, Kernel-General time change, Kernel-Boot) has no sleep, resume, power-source or time-change event between 15:53 and 17:41; the stop time is consistent with the 17th message time. Fix in `tools/soak/replay.mjs`: after the last message the run sleeps until the duration has passed. Regression test: `tests/soak-system.test.mjs`, "a duration run lasts the whole duration even when its last message comes much earlier". The first run's data is kept but not used.
- **Why only about 40 audit rows in the soak DBs?** Chat is very sparse: 17 messages in 2 h (0.14 per minute) plus system events (connect, subscribe) and gate decisions. 17 chat events produce 34 gate requests, of which only the refusals and confirmations are audited. See section 2.
- **What is the dense run?** Section 6: SYNTHETIC LOAD built from the 18 real messages, timing compressed (gap cap 1 s, speed 10), looped about 700 times. Added to put real volume through the path (635 events per minute against 0.14). It is not real-chat behaviour and is not used for budgets.
- **Stray mock, pid 24044 (`tools/mock/mock-streamerbot.mjs --port 18094 --every 150`, started 13:15):** not used by E7. It came from the E2 evidence command (`docs/evidence/2026-10-28-p3-e2-streamerbot-ingest.md`, listen CLI example run with `&`) and was left running. A search for port 18094 finds only that evidence file; the soak and tests use random ports. I stopped it after the dense run finished (a plain process stop; a mock holds no data). `node tools/stray-procs.mjs` reports 0 strays afterwards.

## 11. Check-dodge search (report only; nothing here was changed except the one E6 item)

Search of the repository excluding `legacy/` and `node_modules/` for strings built from parts, odd encodings, comments about avoiding a check, skipped or weakened tests. Hits:

| Location | What | Check it dodges |
|---|---|---|
| `tools/lint.mjs:29-30` | `lint-allow` marker regex built as `'lint-allow' + ':'`; comment "Built from parts so this file contains no marker of its own." | lint allow-marker rule (self-match) |
| `tests/lint.test.mjs:3` (comment), `:116-126` (secret samples joined from parts: PEM header, AWS, `sk-`, Slack, Twitch, Bearer, assign), `:137` (marker text), `:149` (one secret value joined), `:166`, `:173-187`, `:209-226` (user-path samples and a profile-name sample joined from parts) | test inputs assembled so the lint test file passes its own lint (secret, user-path, marker, private-scan) | lint `secret`, `user-path`, marker rules; private scan terms |
| `tests/event-core-streamerbot.test.mjs:325`, `:340` | `['send','Enabled'].join('')`, `['allow','MockSend'].join('')` so the source-scan test does not match itself | the test's own source scan |
| `services/event-core/api/discovery.mjs` (E6) | environment-variable names had been split to pass the `secret` rule. **Fixed in E7**: rule fixed, plain constants restored. | lint `secret` |

Not dodges, listed for completeness: platform-conditional `skip:` on Windows ACL, credential and ffmpeg tests; `// eslint-disable-line no-unused-vars` in `services/event-core/model.mjs:100`, `anonymise.mjs:58`, `audit/writer.mjs:47` (the repo has no eslint, so these are dead comments); Python `# noqa` import-order markers. In my own step 0 test I had also joined an environment-variable name (`tests/lint.test.mjs:146`); I made it a plain string, which the fixed rule allows. No tests were found weakened (no `.only`, no `todo`, no relaxed tolerances).

## 12. Verification

| Check | Result |
|---|---|
| `npm run lint` | 0 findings, 1 allow marker (pre-existing, `tests/g0-schemas.test.mjs:273`) |
| `npm test` | 562 tests, 562 pass, 0 fail, 0 skipped (150 s) |
| `npm run ci` | 12 of 13 steps pass. FAIL: `bench`. See below. |

New tests in E7: `tests/event-core-dedupe-persist.test.mjs` (6), `tests/soak-replay.test.mjs` (4), `tests/soak-system.test.mjs` (4), `tests/stray-procs.test.mjs` (3), plus the lint test (1) and changes to two audit migration tests.

Bench failure (baseline not touched, not accepted). Seven metrics flagged: `event-core-audit.ingest_p95_ms` 0.01 to 0.04 ms, `block_p95_ms` 0.13 to 0.89 ms, `rows_per_s` 190 077 to 157 553, `event-core-bus.p50_ms` 0.01 to 0.03, `p95_ms` 0.01 to 0.05, `event-core-livelock.p50_ms` (0.00, +179 %), `private-scan-worktree-wall` 875 to 1 205 ms (+38 %). Reproduced on three runs. Findings:
- The failure only shows when the benches run together in the harness. `event-core-bus` alone and `event-core-audit,event-core-bus` give 0.01 / 0.02 to 0.03 ms (at baseline). `event-core-api,event-core-bus` is also at baseline. `event-core-api,event-core-audit,event-core-bus` reproduces the slowdown (audit ingest 0.04, block 0.98, bus p50 0.03). So the order api, then audit, then bus degrades the later benches.
- The bus bench has no audit attached, so the persistent dedupe only adds a SHA-256 per event there (measured 1.0 microsecond per call, 1.3 microseconds per `isDuplicate` call). That does not explain 20 microseconds.
- Cause: UNVERIFIED (candidates: heap and GC state left by the api bench; not caused by the dedupe hash by measurement). The private-scan figure is likely more files to scan since the baseline (new tests and tools).
- The run was not flagged noisy by the harness (AC power, low load).
Decision needed from the user; not investigated further because it would mean changing bench ordering or the baseline.

## 13. UNVERIFIED and open items

- Cause of the host stalls (section 4, section 6). Power and load were not logged.
- AC/battery state during the soak windows.
- The error shape of a real Streamer.bot authentication failure; real Streamer.bot behaviour in general (mock only).
- Real chat is sparse (73 comments in all 22 exports), so latency percentiles from real-chat runs rest on 17 to 18 events; throughput is only shown by the synthetic run.
- The purge text scan is weak by design (section 8).
- Bench interference (section 12).
- Event-loop delay figures include the 5 ms timer resolution.

## 14. Proposed next steps (not run)

1. A busier real chat export (or a labelled synthetic load of 50 to 500 messages per minute) for a 2 h soak, with the new power and load log, on AC power.
2. A decision on the bench order interference (section 12).
3. Repeat the 5-kill and 15-kill crash runs with `--kill-with terminate` (added, unused) to compare the gap without the `taskkill` start-up cost.

## Files created or changed

Created:
- `tools/soak/replay.mjs`, `tools/soak/core-child.mjs`, `tools/soak/system-probe.mjs`
- `tools/stray-procs.mjs`
- `tests/event-core-dedupe-persist.test.mjs`, `tests/soak-replay.test.mjs`, `tests/soak-system.test.mjs`, `tests/stray-procs.test.mjs`
- `docs/evidence/2026-10-28-p3-e7-soak-latency-recovery.md`

Changed:
- `tools/lint.mjs`, `tests/lint.test.mjs`, `services/event-core/api/discovery.mjs`
- `services/event-core/audit/schema.mjs`, `store.mjs`, `writer.mjs`, `worker.mjs`, `index.mjs`
- `services/event-core/dedupe.mjs`, `services/event-core/index.mjs`, `services/event-core/api/service.mjs`
- `tests/event-core-audit.test.mjs`
- `tools/mock/mock-streamerbot.mjs`, `tools/bench/run.mjs` (three probe functions exported), `tools/ci.mjs` (`stray-mocks` step), `tests/ci.test.mjs`
- `tests/event-core-streamerbot.test.mjs`, `tests/event-core-streamerbot-cli.test.mjs`, `tests/event-core-streamerbot-credential.test.mjs` (mock-closed assertion)

Outside the repo: `<data-root>/soak/<run-id>/` for each run.
