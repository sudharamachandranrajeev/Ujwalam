# Procedure: phase gate

Run at the end of every phase (P#/O#/Alpha build). Do not start the next phase. Tool-neutral; `.claude/skills/phase-gate` points here.

1. For each "Done when" in the build plan (`docs/2026-10-26-build-plan.md` §7, or `docs/plan/` amendments): report PASS, FAIL or BLOCKED with evidence (exact command plus output).
2. For every ★ preset touched: first run `npm run legacy:verify`; if it fails, stop (the reference has changed). Then side-by-side behaviour capture against `legacy/` (timing, geometry, token colours, trigger response, guard behaviour; same test events on H and V). Compare behaviour, not pixels.
3. Run build, lint, tests and mock suites (`npm run ci`). Record counts.
4. List: placeholders, mocks, skipped tests, files created or changed, risks. Mark anything unverified as UNVERIFIED.
5. Fix current-phase failures and re-run the failing checks.
6. A design blocker becomes an ADR in `docs/adr/` and the phase stops.
7. Save evidence in `docs/evidence/` (see `evidence.md`). A mock is not a feature.
8. Never commit before the user approves; commit only after the gate result is accepted. Exception: local `wip(...)` checkpoint commits after CI passes (v1 addendum §2).
9. High-stakes items (security review, live path, encoder graph) are marked done only by the strongest available model.
