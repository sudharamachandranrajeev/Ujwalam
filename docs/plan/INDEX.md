# Plan index

Baseline: `docs/2026-10-26-build-plan.md` (§1–12). Amendments below change it; newest wins where they differ. New plans arrive in `docs/inbox/` and move here once applied (deferred ones go to `docs/backlog/`).

| Date | Amendment | What it changes | Phases |
|---|---|---|---|
| 2026-10-26 | [open-question-answers](2026-10-26-open-question-answers.md) | Answers to open planning questions: rename, P2 clips corpus, P1 plugins, MELD MULTI | P1, P2 |
| 2026-10-26 | [output-graph](2026-10-26-output-graph.md) | Compositor → encoder pool → delivery pool; platform capability registry; replaces P6 with O-phases | O0–O3 (replaces P6) |
| 2026-10-27 | [game-event-detection](2026-10-27-game-event-detection.md) | Game profiles and CODM detectors as clip signals; G0–G6 | P2, P5 (G4), P14 (G5) |
| 2026-10-27 | [p2-clip-baselines](2026-10-27-p2-clip-baselines.md) | P2 "Done when": chat-only, audio-loudness and random baselines on held-out sessions | P2 |
| 2026-10-27 | [game-training-workflow](2026-10-27-game-training-workflow.md) | Generic "Train a game" workflow T0–T10, pack format, W0–W5 | W0–W1 at P2b start (after the P2a gate commit); W2–W3 in P2b; W4 with P14; W5 after P14 (ask for second-game footage) |
| 2026-10-27 | [p2b-plan](2026-10-27-p2b-plan.md) | P2b steps W0–W3, J0–J2, A6 labelling; end screens not exclusive; Jev exception | P2b |
| 2026-10-27 | [jev-decisions](2026-10-27-jev-decisions.md) | TypeSafe AI Jev as the only paid API, for decisions: DecisionProvider, redaction, keychain, spend log, local fallback | P2b (J0–J2), P7, P8 |
| 2026-10-28 | [core-build-order-and-checks](2026-10-28-core-build-order-and-checks.md) | Training track parked ([backlog](../backlog/2026-10-28-training-track-parked.md)); the rest of training becomes in-app "Train a game" (placement open); core order P3 → P4 → P5 → P6 (O1 → O2 → O3) → P7+; standing checks: CI script, performance budgets, benchmark regression > 10 %, soak, crash recovery, independent security review, live path rule | P2b (parked), P3 onwards |
