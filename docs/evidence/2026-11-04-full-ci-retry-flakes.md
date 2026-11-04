# Full laptop CI, 2026-11-04 — two known flakes retried in isolation

Full `npm run ci` run: 13/15 passed in 753.7s. Two failures, both already documented
as load-sensitive in the 2026-11-03 handover ("Flaky under full-CI load ... Never run
two CI suites at once").

## 1. `tests/soak-system.test.mjs` (step `test`)

Full-CI failure:
```
test at tests\soak-system.test.mjs:32:1
a duration run lasts the whole duration even when its last message comes much earlier
Error: core child exited early (code 1); stderr bytes 726, error names Error
    at ChildProcess.<anonymous> (file:///C:/AI/Claude/Ujwalam/tools/soak/replay.mjs:160:91)
```

Retried alone: `node --test tests/soak-system.test.mjs` — PASS, exit 0.

## 2. `app/host/tests/host-a0-day2.test.mjs` (step `test-host`)

Full-CI failure:
```
test at app\host\tests\host-a0-day2.test.mjs:131:1
replay: binds to the configured rungs (no extra encoder), shares the encoder with a
recording, follows clear
AssertionError: NVENC sessions with the replays bound to rungs: 3 (fallback encoders
would add more) — 3 !== 2
```

Retried alone (after `npm run build:host`): `node --test app/host/tests/host-a0-day2.test.mjs`
— PASS, exit 0, 9/9 including the same replay-rung-binding test
("replay: binds to the configured rungs (no extra encoder), shares the encoder with
a recording, follows clear").

## Conclusion

Both are contention from running heavy GPU/NVENC and timing-sensitive suites in
parallel during the full-CI pass (test + test-host + bench back to back), not real
regressions. No code change. `node tools/stray-procs.mjs` showed no stray processes
before the retries. Treat as the known flake; proceeding with the push on this basis.
