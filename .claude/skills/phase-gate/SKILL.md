---
name: phase-gate
description: End-of-phase gate checklist for Ujwalam. Use when a phase (P#/O#) is finished and must be verified before the user approves the next one.
---

# Phase gate

Run at the end of every phase. Do not start the next phase.

1. For each "Done when" in the build plan (`docs/2026-10-26-build-plan.md` §7, or `docs/plan/` amendments): report PASS, FAIL or BLOCKED with evidence (exact command plus output).
2. For every ★ preset touched: first run `npm run legacy:verify`; if it fails, stop (the reference has changed). Then side-by-side behaviour capture against `legacy/` (timing, geometry, token colours, trigger response, guard behaviour; same test events on H and V). Compare behaviour, not pixels.
3. Run build, lint, tests and mock suites. Record counts.
4. List: placeholders, mocks, skipped tests, files created or changed, risks. Mark anything unverified as UNVERIFIED.
5. Fix current-phase failures and re-run the failing checks.
6. A design blocker becomes an ADR in `docs/adr/` and the phase stops.
7. Save evidence in `docs/evidence/` (see the `evidence` skill). A mock is not a feature.
8. Never commit before the user approves; commit only after the gate result is accepted.
