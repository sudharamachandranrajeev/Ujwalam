# Host test time and the look-test toast flake (2026-11-09)

Branch `ci/host-time`. Machine: the dev laptop, one heavy job at a time. Host and studio were built into the worktree's own `out/`.

## 1. Why `npm run test:host` went from ~290 s to ~633 s

Cause: `stopHost` (app/host/lib/launch.mjs) raised its exit wait to 60 s, but the wait was a `Promise.race` against a
`setTimeout` that was never cleared. The host exits in about a second, so the race ended at once, yet the pending 60 s
timer kept the test process alive. Every host test file therefore ran on for the full bound after its last test passed
(20 s before the change, 60 s after). `host-parent-pipe` had the same pattern inline. The new failsim file added its
real 2 min of timed waits on top.

Fix (no coverage dropped, nothing weakened):
- `stopHost` clears its timer as soon as the host exits (event-driven; a real hang still ends at 60 s).
- `host-parent-pipe.test.mjs`: same clear on its own race.
- `host-audio-failsim.test.mjs`: the shutdown-guard case (a 20 s wait on its own host) moved unchanged into
  `host-audio-failsim-guard.test.mjs`, so `test:host` (two files at a time, D276) runs it beside the watchdog file's
  waits instead of after them.

## 2. Per-file times (each file run alone, seconds)

| file | before | after |
|---|---|---|
| host-a0-day2 | 62.3 | 24.1 |
| host-api | 65.8 | 6.1 |
| host-audio-failsim | 137.6 | 77.9 (with guard case); ~50 expected without it |
| host-audio-failsim-guard (new) | - | 21 |
| host-audio-health | 59.4 | 19.5 |
| host-browser | 88.4 | 29.7 |
| host-crash-report | 1.1 | 1.0 |
| host-face-bench, host-fx-bench, outputs-plan | 0.1 | 0.1-0.2 |
| host-face | 66.2 | 6.6 |
| host-live-keys | 77.9 | 26.2 |
| host-log | 61.2 | 1.4 |
| host-parent-pipe | 62.2 | 3 (61.0 before its own timer was cleared) |
| host-preview-edit | 61.2 | 1.5 |
| host-project | 110.4 | 50.5 |
| host-stinger | 74.4 | 14.7 |
| host-stream-recovery | 24.6 | 24.6 |
| host-structure | 61.1 | 1.4 |
| host-studio-launch | 8.4 | 8.5 |
| host-transitions | 65.7 | 5.9 |
| host-twitch-bandwidth-test | 67.9 | 17.6 |
| sum | ~1100 | ~400 |

Whole step after all three fixes: `npm run test:host` = 168 s (138 tests, 128 pass, 0 fail, 10 skipped as before; the
skip is the opt-in key-injection case), against ~633 s in full CI before and ~290 s before the failsim merge.
The remaining floor is real time: failsim's watchdog waits (5 s x 4 cycles, twice) and host-project/host-a0-day2/host-browser launches.

## 3. studio-qt-shell "look (D285)" toast count 0 vs 1

Timing assumption: the test finished task `clip-z` with a node `setTimeout` of 1200 ms started in `prepare`, i.e. before the
server and the shell even launched. The shell polls status every 2 s and a toast lives 4 s; the probe ran 4.5 s. On a loaded
machine the shell started late, so its first poll saw `clip-z` already done (no toast: a task never seen working, first poll)
or the toast appeared too late/early relative to the probe end. Passing alone only because startup was fast.

Fix: `probe` got `opts.onStatus(n, dataDir)`, called per status request the shell makes. `clip-z` starts as `running` and turns
`done` on the shell's 2nd status request, so the shell always sees it working and then finished; the toast (4 s) then starts at
poll 3 (about 4 s in) or earlier and the probe lasts 5.5 s. State follows the shell's own progress, not a wall clock.
The assertions are unchanged.

Result: tests/studio-qt-shell.test.mjs 47/47 pass (417 s, includes the look test).

## Files changed
- app/host/lib/launch.mjs
- app/host/tests/host-parent-pipe.test.mjs
- app/host/tests/host-audio-failsim.test.mjs
- app/host/tests/host-audio-failsim-guard.test.mjs (new)
- tests/studio-qt-shell.test.mjs
- docs/evidence/2026-11-09-host-test-time.md
