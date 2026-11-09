# Flaky tests under full-CI load (2026-11-09)

Branch ci/flaky. Load tool: four busy worker threads (a node script, about 4 cores) plus 4 copies of the test file run
at once. The full CI was not run (rule: one heavy job).

| Test | Timing assumption found | Fix | Repeat result |
|---|---|---|---|
| tests/posting-youtube-cli.test.mjs "unknown subcommand is a usage error" | Not load: the first `cli(['youtube','bogus'])` had no `--data-dir`, so it read the real event-core data dir and expected the posting flag to be off. If the user had switched the flag on (control page) at that moment, it returned 2 instead of 3. | Pass `--data-dir <empty temp dir>` in that call. | 5/5 pass. Cause deterministic by state, matches "failed once". |
| app/host/tests/host-browser.test.mjs (after hook: host shutdown) | `stopHost` waited 20 s for exit; host with the CEF overlay child can take longer under load, then reports `code: null` and the hook asserts exit 0. Other host tests already passed 40 s. | `stopHost` default 20 s -> 60 s (wait ends at exit, so healthy cost is zero; a hang still fails at 60 s). Same bound in host-parent-pipe's exit wait (20 -> 60 s). | host-parent-pipe + host-browser: 9/9 pass; host-browser alone under the 4-thread burner: 2/2 pass (a third run was still going at commit time). Failure itself not reproduced. |
| tests/proc-registry.test.mjs | Child registration wait (already raised 20 -> 50 s in D261) and run length (60 s) are the load assumptions; the test is poll-based already. No further change. | none | 12/12 pass (4 concurrent x 3 rounds, under burner). Not reproduced. |
| tests/soak-system.test.mjs ("core child exited 1 before READY") | Not found. The child exit is a crash, not a timeout (READY wait is 120 s); the report now names the crash location, so the next occurrence will show the cause. | none | 12/12 pass (4 concurrent x 3 rounds, under burner). Not reproduced; cause UNVERIFIED. |
| bench stall-tracer `ingest_p95_on_ms` | A 0.15 ms p95 against 0.015 ms needs hundreds of consecutive slow samples, i.e. a chunk-long stall of the whole process (D229 moved the bench before the test suites; noise gate marks CPU > 15 % advisory). | none | 8 bench runs, 4 at a time under the burner: ingest p95 0.017 to 0.031 ms, never above 0.04. Not reproduced under pure CPU contention, so the CI value likely came from something else (disk or antivirus stall, GPU job tail); UNVERIFIED. |
| host-face | Already fixed by polling (pattern). | none | n/a |

## Files changed
- tests/posting-youtube-cli.test.mjs
- app/host/lib/launch.mjs (stopHost default timeout)
- app/host/tests/host-parent-pipe.test.mjs (exit wait)
- docs/evidence/2026-11-09-flaky-tests.md

Worktree setup: junctions for node_modules, .venv, legacy, out, app/spike/build to the main checkout; copied
data/profile.local.json, app/host/host.local.json, app/studio/studio.local.json (all gitignored).
