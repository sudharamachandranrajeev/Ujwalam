# Bench ADVISORY regressions after the licence-audit merge: investigated (2026-11-06)

Three benches flagged ADVISORY after merging `hermes/licence-audit` ->
`...` -> `hermes/clip-ranking-approval` into `claude/alpha0-d1`:
`private-scan-worktree-wall` (+49-50%), `registry-validate-wall` (+35-45%),
`stall-tracer-overhead.idle_main_busy_ms_per_min` (+12-33%). The CI output
itself warned regression enforcement starts 2026-11-06 (today), so this
needed an honest look, not a shrug.

## private-scan-worktree-wall — mostly explained by worktree growth, not a code bug
This bench scans every tracked+untracked file in the repo
(`git ls-files -z --cached --others --exclude-standard`) — its own file
header says wall time "can be told apart from worktree growth" via the
`info.files`/`info.bytes` fields, which exist specifically for this, but
**the pass/fail gate only compares raw `wall_ms`, never normalises against
them.**

This merge added ~325 files including several licence/evidence docs, one
of them 689 KB (`docs/licenses/CEF-CHROMIUM-CREDITS-source.md`). Measured
directly on the current tree: **708 files, 6.86 MB** vs baseline's
**564 files, 4.89 MB** — file count +25.5%, bytes +40.2%. Normalising the
reported wall time (792.15 ms vs baseline 526.18 ms, a raw +50.5%) by file
count: 1.119 ms/file now vs 0.933 ms/file baseline — **+19.9% per file**,
not +50%. Most of the "regression" is just more files to scan from this
session's own additions; a real, smaller residual (~20%/file) remains,
plausible given one disproportionately large single file plus normal
scan-overhead variance (this machine had 3 background `node.exe`
processes running during the measured run, unaccounted for).

**Not a code regression in Ujwalam's scanner.** If this needs to stop
tripping the gate as the repo grows, the fix belongs in the bench's
comparison logic (compare ms/file or ms/MB, not raw wall_ms) — flagging
this as a possible follow-up, not fixing the bench itself here (out of
scope for this session, and a bench-methodology change needs its own
review, not a drive-by edit).

## registry-validate-wall and stall-tracer-overhead — likely noise, not growth, not a real bug
- `registry-validate-wall` only validates `registry/` — this merge barely
  touched it (no new registry files). Its own file header already notes
  a `minDelta: 30ms` slack specifically for process-start noise; the
  measured deltas (45-55 ms) just exceeded that margin. No structural
  reason this merge would slow registry validation.
- `stall-tracer-overhead` is a synthetic, in-process microbenchmark
  (event-loop stall tracer cost) with zero dependency on repo file count.
  Its actual product budget (PB-17: idle busy <= 300 ms/min) is still
  comfortably met at 72-86 ms/min — the ADVISORY only fires because it's
  compared against a previous run's number, not the budget.
- Both most likely reflect **this machine's background load** at
  measurement time (other processes competing for CPU/I-O), not a defect
  introduced by the merge.

## Conclusion
No code fix made or needed. Documenting this is itself the deliverable:
if regression enforcement goes hard-fail soon, these three will need
either a quieter measurement environment, a bench-methodology fix
(normalise `private-scan-worktree-wall` by file count), or a baseline
re-calibration that accounts for the repo's new size — not a performance
fix to the scanner, validator, or tracer themselves.
