# 2026-10-28 — Core build order and standing checks

User instruction, 2026-10-28. Newest wins over the baseline and earlier amendments where they differ.

## 1. Training track parked

P2b stops after W0, W1, J0, the A6 labelling page and the OCR timing study. Labelling (A6), W2–W5 and the P2 accuracy gate are parked: `docs/backlog/2026-10-28-training-track-parked.md`. The rest of the training methodology becomes the in-app "Train a game" feature, built later from `docs/plan/2026-10-27-game-training-workflow.md`. Its phase placement is open.

## 2. Core build order

1. P3 Event Core: multi-chat ingest, moderation, live-lock, audit.
2. P4 Project model, NativeAdapter, local API, Meld/OBS/recipe importers.
3. P5 Studio shell (Meld-style): scenes, layers, inspector, mixer, H/V canvases, undo, autosave (P5a and P5b as settled).
4. P6 Outputs: O1 (one encoder, N sinks, loopback first), then O2 (encoder graph), then O3 (bandwidth governor).
5. P7 onwards as planned: effects, rules engine, layers, themes, C1–C5.

Each phase plan is posted and waits for the user's approval. Then build, gate, and commit with the user's approval.

## 3. Standing checks (every phase)

- **Phase gate.** Each "Done when" gets PASS, FAIL or BLOCKED with evidence. Nothing is done without a test or runtime proof.
- **CI script.** It runs on every commit: build, lint, all tests, registry validator, output-config validator, private scan and name hook, legacy-verify.
- **Performance budgets.** Kept in `docs/architecture/performance-budgets.md` and defined in P3, before code. They cover compositor frame time, dropped frames, encoder load, CPU, GPU and RAM, UI responsiveness, event latency (chat → effect), and memory over 2 h.
- **Benchmark harness.** It records results per commit and flags any regression of more than 10 % against the last passing run.
- **Soak tests.** A 2 h stream plus recording, with effects and background jobs, runs before P6 closes. It runs again in each later phase that touches the live path.
- **Crash and recovery tests.** Kill the process mid-stream. Autosave and outputs must recover, and no project or recording may be corrupted.
- **Security review.** An independent review (a fresh agent, given the code only, not earlier conclusions) covers anything that opens a port, runs a subprocess, handles chat or takes a token. Fix-first findings block the phase.
- **Live path rule.** Nothing on the stream's critical path waits on network, disk scans, OCR or Jev.

All existing rules stay: names, private data and paths stay out of git. Everything is local only, except Jev for decisions.
