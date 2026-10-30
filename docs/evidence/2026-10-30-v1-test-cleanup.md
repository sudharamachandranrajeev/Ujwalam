# v1 test cleanup: why test runs left processes behind, and the fix

Date: 2026-10-30. Agent A. Status: fixed and verified under `--test-concurrency=8`; the two load failures named in the task were investigated (results below).

## Root cause

A test file runs in its own node process. When a test throws, fails an assertion or hits its timeout before reaching its own cleanup, nothing killed what it had started:

1. `tools/soak/replay.mjs` `runReplay` and `runCrash` start a mock Streamer.bot (a listening server) and a core child process, then await many steps (`waitSubscribed`, `play`, `stopChild`). They had no `try/finally`. Any throw in between (for example "core child did not become ready", or the 20 s subscribe wait) left the child alive with its stdin and stdout pipes open, and the mock listening. Those handles keep the test file's process alive, so the runner never finishes. A test timeout only fails the test; it does not stop the process or its children.
2. `tests/event-core-streamerbot-cli.test.mjs` awaited `child.on('exit')` with no bound, so a child that never exits (starved or stuck) held the test, and the mock it used, forever.
3. `tests/idempotency-crash.test.mjs` and the others had no teardown that kills a still-running child.
4. Kills used `taskkill /PID` without `/T`, so descendants survived, and by bare name rather than the validated system path.

Why it showed under load: the core child runs at below-normal priority. With many test processes running at once it needed more than the 30 s start-up wait (reproduced: "core child did not become ready in 30 s" in `tests/soak-replay.test.mjs` and two tests in `tests/soak-system.test.mjs`, one of which then ran to its 120 s test timeout). The old code then threw and leaked the child and the mock; with no `--test-timeout` in the earlier runs, the stuck file never ended.

## Fix

- `tools/proc-registry.mjs` (new): `track(child)`, `waitExit(child, ms)` (kills the whole tree on timeout and always resolves), `stopTracked()` (kills every live registered child and waits), `killTree(pid)` (`taskkill /T /F` by the validated `systemTool` path on Windows, SIGKILL elsewhere), `openChildren()`, `childPids()`, and a last-resort process `exit` hook.
- `tools/mock/mock-streamerbot.mjs`: `closeAllMocks()` added.
- `tools/soak/replay.mjs`: children are registered; `main()` ends every run in a `finally` that stops registered children, closes all open mocks and removes its signal handlers; the ready timer is cleared when the child is ready or exits; start-up and subscribe waits are 120 s ceilings (env `UJWALAM_SOAK_READY_MS`) instead of 30 s and 20 s.
- Tests: `soak-system`, `soak-replay`, `event-core-streamerbot-cli`, `idempotency-crash` register every child, bound every wait for a child's exit, and run teardown in `after()` that kills what is left and then asserts the open mock and child counts are zero (and that teardown had nothing to clean). Soak test timeouts raised to 300 s (ceilings, not assertions). No assertion was loosened, skipped or removed.
- `tools/stray-procs.mjs` (CI `stray-mocks`): also reports the idempotency kill-test child and listen-CLI children that carry the test-only credential target. Real `serve` runs are never flagged. The check is machine-wide, so a test run by another person or agent at the same moment shows up as a stray.
- `tests/proc-registry.test.mjs` (new, 4 tests): a hung tree (parent plus grandchild) is killed after the timeout and the wait ends; a normal exit reports its code; `stopTracked` kills two trees; a replay run whose core child crashes at start-up leaves no mock and no child behind (this one failed before the `finally` existed because the mock stayed open).
- `tests/stray-procs.test.mjs`: one new test for the extra labels.

## The two named failures under suite load

- "end-to-end: replay a synthetic export ...": same cause as above (child start-up starved past 30 s). Fixed by the longer ceiling plus guaranteed teardown. Assertions unchanged.
- "connector: reconnect with a slow (500 ms) password read ...": it asserts the max event-loop delay of its own process stays under 100 ms. That is a measurement of the machine's scheduling as much as of the connector, so under heavy parallel load it can exceed the limit without a product bug. It did not fail in the load runs below. Not changed, because loosening the limit would weaken it. If it recurs, the right fix is a serial pass for timing-sensitive files (D87). Not a product bug found.

## Evidence

- Before: `node --test --test-concurrency=8 --test-timeout=300000 tests/*.test.mjs tests/outputs/*.test.mjs`: 879 tests, 3 failures in the soak files ("core child did not become ready in 30 s" twice, one 120 s test timeout) plus one unrelated label-server failure.
- Targeted: `node --test` on `soak-system`, `soak-replay`, `event-core-streamerbot-cli`, `idempotency-crash`, `stray-procs`: 25 of 25 pass; `tests/proc-registry.test.mjs`: 4 of 4 pass; stray scan after each: none from this work.
- After (three repeat runs of the same command): run 1: 880 tests, 877 pass, 3 fail; run 2: 890 tests, 889 pass, 1 fail. The soak end-to-end test passed under load (207 s, inside its 300 s ceiling) and no stray process was left after either run (`node tools/stray-procs.mjs`: none running).
- One soak test ("a duration run lasts the whole duration ...") failed once in run 1 with "core child exited early (code 1)". It did not recur in run 2 or in six parallel copies of `tests/soak-system.test.mjs`. The cause is UNVERIFIED: the child's stderr is never printed (it can carry paths), only its size, so the error text was not captured. The start error now also lists error names found in stderr (names only, for example EADDRINUSE), so the next occurrence identifies itself. The failure left no process behind.
- Failures in `tests/label-server.test.mjs` (a 502 on frame, a ffmpeg queue test, a frame/thumb test under load) are not part of this task and were not touched.
- `npm run lint`: two eol findings in files owned by another agent (`services/studio-ui/launch.mjs`, `ui/js/app.js`); none in files from this task.

## Files

Created: `tools/proc-registry.mjs`, `tests/proc-registry.test.mjs`, this document.
Changed: `tools/soak/replay.mjs`, `tools/mock/mock-streamerbot.mjs`, `tools/stray-procs.mjs`, `tests/soak-system.test.mjs`, `tests/soak-replay.test.mjs`, `tests/event-core-streamerbot-cli.test.mjs`, `tests/idempotency-crash.test.mjs`, `tests/stray-procs.test.mjs`, `docs/plan/2026-10-29-v1-decisions.md` (D84 to D87).
