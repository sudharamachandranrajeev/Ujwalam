# 2026-11-13 — GPU reset recovery: host graphics watchdog and launcher liveness check (D374, flag `host-watchdog`)

Status: built and tested with a fake host and a real host on this PC. A real NVIDIA driver reset was NOT reproduced (UNVERIFIED, see the end).

## Why

On 2026-11-12 the host (libobs) failed twice and nothing recovered it:

- **19:03:** the host's graphics thread stopped producing frames for about 3 hours. The process kept running, so nothing noticed.
- **21:42, while live:** the NVIDIA driver reset (System log nvlddmkm event 153). The host crashed with 0xC0000005. Streams and replay buffers stayed down until a manual restart at 22:00.

The launcher (`services/studio-ui/launch.mjs`, `superviseHost`) restarted the host only when its process exited. A host that is alive but frozen was never restarted.

## What libobs already does (read from `C:/AI/Claude/_vendor/obs-32.1.2/src`, libobs-d3d11)

- `gs_device::RebuildDevice` rebuilds the D3D11 device. It runs only from `device_present`, when `IDXGISwapChain::Present` returns `DXGI_ERROR_DEVICE_REMOVED` or `DXGI_ERROR_DEVICE_RESET`. That needs a swap chain, so it only happens while a preview window is presenting. A headless host with no preview never calls it.
- The rebuild recreates textures, shaders, buffers and swap chains. It does not recreate encoders, so NVENC sessions are not rebuilt. If the rebuild fails, libobs calls `bcrash` and the process ends.
- `gs_register_loss_callbacks` / `gs_unregister_loss_callbacks` are exported (`device_loss_release` before the rebuild, `device_loss_rebuild` after). No plugin in the tree uses them.
- Conclusion: libobs can survive some device resets while a preview presents, but a live encode does not recover by itself. A restart of the whole host is the reliable recovery.

## What was added

### Host (report only; the host never restarts itself)

- `app/host/src/gfx_watch.h`, `gfx_watch.cpp`:
  - A tick callback (`obs_add_tick_callback`, graphics thread, start of every frame) stamps the time of the last video frame.
  - A checker thread ("ujw: graphics watchdog") reports a stall when no frame came for `stallMs`. It logs once per stall ("graphics stalled: no video frame for N ms ...") and once on recovery, never per frame.
  - Device-loss callbacks (`gs_register_loss_callbacks`) count losses and rebuilds, and log them.
  - The report is in `host.status.graphics` and in the new lock-free `host.alive` method: `watch`, `stallMs`, `lastFrameAgeMs`, `frames`, `stalled`, `stalledMs`, `stalls`, `longestStallMs`, `lastStallAt`, `deviceLosses`, `deviceRebuilds`, `lastDeviceLossAt`, `lastDeviceRebuildAt`.
  - `host.alive` takes no studio lock, so it answers while a project load holds the lock or the graphics thread is blocked. `host.status` takes the studio lock.
  - `graphics.testStall {ms}` (`--test-hooks` only) blocks the next frame tick, to simulate a stuck GPU in tests.
- Host config key `graphicsWatch: {stallMs, checkIntervalMs}` (`host_config.h/.cpp`). The launcher copies it from `data/live/host-watch.json`. Without the key the host does no stall check (`watch: false`); the device-loss counters still run.

### Launcher (`services/studio-ui/host-watch.mjs`, `launch.mjs superviseHost`)

- Every `checkMs` the launcher calls `host.alive` with a `rpcTimeoutMs` timeout. No checks run while a restart or project load is in progress, or when the host has already exited.
- The host is **stale** when either:
  - it gave no answer for `noAnswerMs` (counted from its last answer, or from its start), or
  - it answers, but `lastFrameAgeMs >= graphicsStallMs`.
- A host from before D374 (no `host.alive`, "method not found") counts as answering; only the no-answer rule applies to it.
- The first stale look of an incident is logged once, with the flag on or off:
  - `[studio] HOST NOT RESPONDING: it did not answer for 30 s; the host watchdog stops and restarts it`
  - Flag off: `... (flag host-watchdog is off: not restarting it; restart Ujwalam by hand)`, and nothing else happens.
- With the flag on, once per incident:
  1. A crash-log entry `hung` (reason, streams that were live) goes to `logs/host-crashes.jsonl`. A task-bar entry ("The video engine froze; restarting it") is written.
  2. The host's process tree is killed (`taskkill /T /F`). It is never asked to `host.shutdown`: a clean exit code 0 would end the session.
  3. If it has not exited after `killWaitMs`, a warning and a `hung-kill-failed` entry are logged, and the task shows "could not be restarted".
  4. The existing crash path then runs unchanged:
     - The restart policy: backoff 2, 5 and 10 s, at most 3 restarts in 5 minutes, then it stops. There is no restart storm.
     - The project is reloaded, and the recording is restarted in a new file.
     - The streams that were live are started again only under the stream-recovery rules (D303: flag `stream-recovery`, this launcher's go-live authority, `data/live/recovery.json` limits). The watchdog never starts a stream itself. A stream that was not live is never started.
  5. The task-bar entry ends in "done" with what came back ("Recording restarted: yes, in a new file; streams restarted: YouTube H, Twitch"), or in "failed" when the policy gave up.
- A host that crashes (exits) while the flag is on also gets one task-bar entry per incident.
- **Driver reset report:** once per incident, the launcher reads the Windows System log (nvlddmkm / Display events 14, 153, 4101 in the last `driverLookbackMs`, async PowerShell, hidden window). A hit is logged, written to the crash log as `gpu-reset`, and added to the task: "Cause: the graphics driver reset at 21:42".

### Thresholds (all in `data/live/host-watch.json`, status `proposed`, each with a source note)

| key | value | meaning |
|---|---|---|
| `host.stallMs` | 5000 | host reports and logs a graphics stall after 5 s without a frame |
| `host.checkIntervalMs` | 1000 | host checker period |
| `checkMs` | 5000 | launcher liveness look period |
| `rpcTimeoutMs` | 10000 | one `host.alive` call times out |
| `noAnswerMs` | 30000 | no answer this long = stale |
| `graphicsStallMs` | 30000 | no video frame this long = stale |
| `killWaitMs` | 15000 | wait for the killed host to exit |
| `driverLookbackMs` | 600000 | how far back the System log is read |

Worst case: about 35 s to detect, up to 15 s to kill, 2 s backoff, then the start. That fits inside stream recovery's `maxGapMs` of 90 s, so the live streams can still be restored. `UJWALAM_HOST_WATCH_CONFIG` names another file (tests only).

### Flag

`host-watchdog` in `data/flags.json`: off by default, page "stream", label "Host watchdog". The flag is re-read at every look, so it switches live.

### Review fixes (Codex review of the first commit, 2026-11-13)

1. **Monotonic clock.** The launcher's liveness check measures every elapsed time with `performance.now()` (`createHostWatch` default `now`). A wall-clock jump (time sync, a user change) can no longer make a healthy host look silent. Wall-clock time is used only for timestamps (crash log, task, driver-log window).
2. **Window starts after the restore.** No checks run while a restart or update is in progress (`busy`). The observation window is now reset when the restore FINISHES (end of `onExit`, in a `finally`; end of `restartPlanned`), not when the new host starts. A slow project reload or stream restart no longer counts toward `noAnswerMs`. The `finally` also clears `busy` if the last status or snapshot step throws, so the watchdog is not left switched off.
3. **`host.alive` lock-free in the host.** The checker thread is the only writer of the stall state. It publishes stalled, since, count, longest and the stall, loss and rebuild times (FILETIME) to atomics before it logs, and holds no lock while logging. `status()` (`host.status` / `host.alive`) reads only atomics.
4. **Task-bar write retried.** `writeTaskFile` renames a temp file over the task file. On Windows that rename fails while a reader has the file open, so an incident's final state could be lost. That happened once in a test run: the task stayed "running". `tell()` now retries up to 10 times, 200 ms apart. An older state's retry never overwrites a newer one. The cause is inferred from the code: the failed write was not observed directly.
5. **One consistent snapshot (Codex re-review).** Separate atomic loads could mix two stall generations, for example a recovery published between reading "stalled" and "since", and give a wrong stalled time.
   - The report is now published through a single-writer seqlock (`gfx_watch.h` `Published`). The writer makes the generation odd, stores the fields, then makes it even with release ordering.
   - A reader retries while the generation is odd or has changed: spin, then yield, bounded. The fields are relaxed atomics, so a torn attempt is retried and is never a data race. `host.alive` stays lock-free.
   - `graphics.testSnapshot {writes, reads}` (`--test-hooks` only) stresses the same class. A writer thread publishes snapshots whose fields all derive from one counter, against reads in the RPC thread.
   - Three runs of 2,000,000 writes against 2,000,000 reads: 0 torn, 0 out of retries. The reader saw a new write 37,065 to 75,371 times per run while the writer ran, so the two threads did overlap.
6. **An unvalidated snapshot is never reported (Codex, third review).** If the reads run out of retries, `status()` leaves out the stall fields (`stalled`, `stalledMs`, `stalls`, `longestStallMs`, `lastStallAt`) and sets `"snapshot": "busy"`. Otherwise it sets `"snapshot": "ok"`. `lastFrameAgeMs` is one atomic and is always reported; it is the only value the launcher decides on. `graphics.testSnapshotBusy {busy}` (`--test-hooks` only) forces that branch in `host-gfx-watch.test.mjs`.
7. **Decision renumbered.** D373 was taken on master by RP5 self-learning, so this decision is D374.

## Tests

| command | result |
|---|---|
| `node --test tests/host-watch.test.mjs` | 14 / 14 pass (after the review fixes) |
| `node --test tests/host-watch.test.mjs tests/studio-ui-alpha.test.mjs tests/stream-recovery.test.mjs tests/studio-ui-crash-recovery.test.mjs` | 74 tests: 73 pass, 1 skipped (face worker, no `.venv-gpu` in the worktree) |
| `node --test app/host/tests/host-gfx-watch.test.mjs app/host/tests/host-api.test.mjs` (real host, installed app not running) | 19 / 19 pass |
| after the seqlock: `node --test app/host/tests/host-gfx-watch.test.mjs app/host/tests/host-api.test.mjs app/host/tests/host-structure.test.mjs tests/host-watch.test.mjs` | 38 / 38 pass; after fix 6: 39 / 39 pass |
| `npm run test:host` (installed app not running) | 173 tests: 162 pass, 0 fail, 11 skipped (opt-in benches; face tests need `.venv-gpu`, absent in this worktree). The first run had a failure in `host-live-plan-record.test.mjs` (EPIPE on a loopback stream write) and one other failing assertion. A full rerun with no other load passed. Treated as load flakiness, not this change: that test does not use the watchdog. After the review fixes: 173 tests, 162 pass, 0 fail, 11 skipped, first run. |
| `node tools/lint.mjs` | 0 findings |

`tests/host-watch.test.mjs` covers:

- **Config:** the shipped file loads, and bad files are refused.
- **Flag and host config:** the flag exists and is off by default; `graphicsWatch` is copied into the host config.
- **Stale decision (fake clock):** no answer; graphics stalled; one incident per freeze; a healthy answer ends the incident; a reset for a new host; an old host without frame data.
- **Watch loop:**
  - Flag off: one log line and no action.
  - Flag switched on during an incident: it acts once.
  - Another check that runs mid-restart, or a probe still in flight, is not doubled.
  - An answer from a replaced host is dropped.
  - "Method not found" counts as an answer.
- **Driver reset lookup:** a fake PowerShell, a failure, a non-Windows system, and the "reset at HH:MM" text.
- **Task-bar entries:** they pass `cleanTask`.
- **End to end with the fake host (`tests/fixtures/studio-ui/fake-host.mjs`, `UJWALAM_FAKE_HOST_HANG_*`):**
  1. RPC freeze while live (watchdog and stream recovery on): one log line, kill, one restart, `record.start` in the new host, `stream.start` of exactly the sinks that were live, crash-log `hung` / `restart` / `restarted`, and one task in state "done".
  2. Graphics freeze with stream recovery off: restart and recording, no `stream.start`, the "NOT running" line.
  3. Flag off: one log line, no kill, no restart, no task.
  4. Slow restore (review fix 2): the restore's `stream.start` takes 2.5 s, longer than `noAnswerMs` (2 s), and the new host's first `host.alive` is lost (`UJWALAM_FAKE_HOST_ALIVE_DROP_RUNS`). Result: one restart only. Measured from the host's start, this would have been about 3 s of "silence" and a second, false restart.
- **Monotonic clock (review fix 1):** `Date.now` is mocked one hour ahead after a healthy answer, then one probe fails. The result is still "ok".

`app/host/tests/host-gfx-watch.test.mjs` (real libobs host, headless, test card) covers:

- Frames are counted.
- `graphics.testStall` is reported as stalled, and logged once over several checks.
- `host.alive` answers within 1 s while the graphics thread is blocked.
- The recovery is reported and logged.
- Parameter checks; FORBIDDEN without `--test-hooks`; `watch: false` without the config key.

The test skips itself while the installed Ujwalam runs (`tools/ci.mjs installedUjwalamProcesses()`).

## UNVERIFIED

- **A real driver reset.** It cannot be forced in a test, so these are unverified:
  - What libobs does on the reset.
  - Whether the host freezes, crashes or carries on.
  - Whether the device-loss callbacks fire.
  - Whether the System log lookup finds the event at the time it is needed.

  How to check later:
  - With the flag on and a test stream (only after the user says "start stream test"), force a TDR with the Windows `dxcap -forcetdr` tool (part of the Graphics Tools optional feature; installing it needs the user's yes).
  - Or wait for the next natural reset.
  - Then read `logs/host-crashes.jsonl` (`hung` / `gpu-reset` / `restarted` entries), the host log ("graphics device lost", "graphics stalled") and the task-bar entry.
- **The 21:42 crash path with the flag on in the real app.** Whether the 0xC0000005 exit then restores the streams within `maxGapMs` is unverified. The fake-host tests prove the sequence; a real stream does not yet.
- **The thresholds** (30 s / 30 s / 15 s) are reasoned, not measured. Status is `proposed`. Tune them after the first real incident.
- **Gaps that remain:**
  - A device loss alone does not trigger a restart; it is only reported. A host that keeps producing frames after a loss is left running.
  - No checks run while a restart or project load is in progress, so a project load that hangs is not caught by this watchdog.
  - The kill of a host that does not die after `killWaitMs` is logged, but not retried.
