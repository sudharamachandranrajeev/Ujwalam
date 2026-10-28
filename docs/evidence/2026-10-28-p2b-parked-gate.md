# 2026-10-28 — P2b gate at parking (training track paused)

User decision, 2026-10-28: pause the training and labelling track, and build the core software (P3 onwards). Only the work already in progress was finished. This gate records the state at parking. It does not close P2. The P2 "Done when" (runs on 3 real CODM streams, beats the baselines) is **not met** and is PARKED. Resume steps: `docs/backlog/2026-10-28-training-track-parked.md`.

## 1. Steps

| Step | Done when | Result | Evidence |
|---|---|---|---|
| W0 | CODM pack validates; A5–A5c results reproduce | PASS | `2026-10-27-p2b-w0-pack-split.md`; `npm run validate:games` below |
| W1 | A capture session reports live coverage; killing the recorder loses ≤ 1 segment | PASS | `2026-10-27-p2b-w1-coverage-capture.md` §1–§8; the ffmpeg restart with a gap marker (at most 5 restarts per 10 min) is in §9 |
| J0 | Evidence file; amendment | PASS. The Master Customer Agreement and the subprocessor list were not read (UNVERIFIED) | `2026-10-27-p2b-j0-jev-terms.md`, `docs/plan/2026-10-27-jev-decisions.md` |
| A6 page | Labelling page built and tested | PASS (tests and a headless render). Interactive use in a real browser is UNVERIFIED | `2026-10-28-p2b-a6-labelling-page.md` (review rounds 1–4, all fixed) |
| A6 labels | Three label files in `data/labels/` that validate | PARKED: 0 of 3 labelled | — |
| OCR timing study | Per-detector on-screen durations and proposed sample rates | Done as a proposal. Nothing applied (no `sampleHz` field, no GPU install) | `2026-10-28-p2b-ocr-timing.md` |
| J1 | DecisionProvider, Jev and Local providers, redaction, keychain | PARKED, not started | — |
| W2 | Discovery, screen classifier, G2 per-detector report | PARKED, not started | — |
| G3 / J2 | Fusion and baselines; Jev vs LocalProvider | PARKED, not started | — |
| W3 | Pack builder, evaluation, v-next | PARKED, not started | — |
| P2 gate | 3 real CODM streams, beats the baselines | PARKED, not met | — |

## 2. In-flight work finished before parking

- Round 4 label-tool fixes (R1–R8), with regression tests and the private scan. All pass (see §4).
- Crash-safe capture restart (W1 §9) and the OCR timing study: both written up. Their decisions are open and parked (§5).
- The 21 Oct proxy (approved in the A6 plan) finished at 11:07:53Z: exit 0, 782.1 s wall (the estimate was 6.5–7.5 min, so it took about 2× longer), 710,882,656 bytes. `ffprobe`: h264 540×960 plus aac, 5,249.979 s. `--verify 12`: 12 points, video lag ≤ 33.3 ms (one frame at 30 fps), audio lag ≤ 5.25 ms, audio correlation r ≥ 0.936. All three labelling sessions now have proxies.
- Overnight pre-fill scans: never started. Decision 5 of the OCR study was still waiting for the user. There was nothing to cancel. Checked: no Ujwalam python, node or ffmpeg process is running (the python processes running are another project's `fakegame` and an unrelated gateway), and there is no scheduled task.

## 3. Mode of parking

- No code was changed for parking. The parked steps are documented, not stubbed: no placeholder modules were added.
- The remaining training methodology (T4 discover to T10 improve, W2–W5) becomes the in-app "Train a game" feature, built later from `docs/plan/2026-10-27-game-training-workflow.md`. There are no more manual training steps until then.

## 4. Checks

Run one at a time on 2026-10-28:

| Command | Result |
|---|---|
| `npm test` | 228 tests, 228 pass, 0 fail, 0 skipped |
| `npm run test:py` | 145 tests OK (16 skipped: OCR and capture tests, covered by the two runs below) |
| `npm run test:ocr` | 59 tests OK |
| `npm run test:capture` | 13 tests OK (70.6 s, real ffmpeg) |
| `npm run validate:registry` | OK: registry valid |
| `npm run validate:outputs` | exit 0 (egress 37140, 54140 and 70140 kbps for the three presets) |
| `npm run validate:games` | OK: 1 game pack(s) valid: codm 0.3.0 |
| `npm run legacy:verify` | OK: legacy matches legacy.manifest.sha256 |
| `node tools/git-hooks/private-scan.mjs scan-worktree` | exit 0, 305 files scanned, no findings |

- Build and lint: no native code changed in P2b, so the P1 build is unchanged. The repo has no lint script (P3 adds one with the CI script).
- ★ presets: none touched, so there is no side-by-side capture.

## 5. Open decisions (parked with the track)

- The six A6 questions and the five OCR decisions are listed in `docs/backlog/2026-10-28-training-track-parked.md` §3, with their recommended defaults. None is applied.
- Should the W1 capture-plan format change bump the pack to 0.3.1? The user decided "no bump" on 2026-10-28, and CHANGELOG records this.

## 6. Placeholders, mocks, skipped tests

- Placeholders: all detector weights, windows and cooldowns are still null. The K1 killer_name ROI is a guessed band. The pre-fill display defaults (−2/+10 s, merge 4 s, match group 120 s) are UNVERIFIED. `data/label-tags.json` has status `unverified`.
- Mocks: none.
- Skipped: 16 in `test:py`, as explained in §4.

## 7. Risks

- Pack drift. The CODM pack and the label schema are frozen at 0.3.0 while the core changes. The resume step reruns `validate:games` and the A5 reproduction before any labelling.
- P2 is not met. Later phases that use clip ranking (P14, C5) have no evaluated detector fusion until the track resumes.
- The analysis cache (about 8 GB of proxies, outside the repo) stays on disk. Nothing in git depends on it.
- The label page has not been used interactively, so its UX findings arrive only on resume.

## Files created or changed (this step)

- Created: `docs/evidence/2026-10-28-p2b-parked-gate.md`, `docs/backlog/2026-10-28-training-track-parked.md`, `docs/plan/2026-10-28-core-build-order-and-checks.md`
- Changed: `docs/plan/INDEX.md` (two rows), `docs/plan/2026-10-27-p2b-plan.md` (status line)
