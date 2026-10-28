# 2026-10-28 — Training track parked

User decision, 2026-10-28: pause the training and labelling track and build the core software first (P3, P4, P5, P6 as O1–O3, then P7 onwards). The rest of the training methodology becomes an in-app feature, "Train a game", built later from `docs/plan/2026-10-27-game-training-workflow.md`. There are no more manual training steps until then.

Gate at parking: `docs/evidence/2026-10-28-p2b-parked-gate.md`.

## 1. Done

| Item | What exists | Evidence |
|---|---|---|
| P2a (committed `8b4cd90`) | Corpus index (5,923 clips, 18 sessions), session boundaries, analysis cache, chat alignment, G0 schemas, G1 detector check | `docs/evidence/2026-10-27-p2a-gate.md` |
| W0 | Pack format: `game.json`, `detectors.json`, `events.json`, `screens.json`, `capture-plan.json`, CHANGELOG; schemas; `tools/game-validate.mjs`; `services/clip/game_pack.py`. CODM pack 0.3.0 | `docs/evidence/2026-10-27-p2b-w0-pack-split.md` |
| W1 | Coverage tracker `services/clip/coverage.py`; crash-safe `tools/capture/record.py` (fragmented segments, restart into the next segment with a gap marker, at most 5 restarts per 10 min); `tools/capture/replay.py` | `docs/evidence/2026-10-27-p2b-w1-coverage-capture.md` |
| J0 | TypeSafe AI Jev docs and terms check; Jev amendment | `docs/evidence/2026-10-27-p2b-j0-jev-terms.md`, `docs/plan/2026-10-27-jev-decisions.md` |
| A6 page | Labelling page `tools/label/` (`npm run label`), label schema, `data/label-tags.json`, `data/session-games.json`, labels rule in the pre-commit hook. Four review rounds, all fixed | `docs/evidence/2026-10-28-p2b-a6-labelling-page.md` |
| OCR timing study | Per-detector on-screen durations, proposed sample rates, diff-gate values, GPU OCR options (nothing installed) | `docs/evidence/2026-10-28-p2b-ocr-timing.md` |
| Proxies | Proxies for all three labelling sessions (18, 20 and 21 Oct) in the local analysis cache (8.2 GB, outside the repo) | parked gate §2 |

## 2. Open

| Item | State | Needs |
|---|---|---|
| A6 labelling (T5) | 0 of 3 sessions labelled. Tune on 20 Oct; hold out 18 and 21 Oct. Highlights blind; game events pre-filled | The §3 answers, then the pre-fill scans, then the user's labelling time (estimate 5–6.5 h in total, UNVERIFIED) |
| Pre-fill scans | Not run. About 11 h of OCR at A5 speed for all three sessions (an upper bound). The timing study's crop profile is cheaper | OCR decision 5 |
| J1 | Not started: DecisionProvider, JevProvider, LocalProvider, redaction, sent-log, keychain | Can move to P7 or P8 if a core phase needs decisions first |
| W2 | Not started: discovery, screen classifier, BR KILL CAM ROI, knock vs kill, M5 fps (estimate cost first), G2 per-detector report | Labels |
| G3 / J2 | Not started: fusion (end-screen rule, suppression), baselines, Jev vs LocalProvider | Labels, W2 |
| W3 | Not started: pack builder, evaluation report, v-next; dedicated capture for missing capture-plan items | W2, G3 |
| W4, W5 | Feedback loop (with P14); second-game proof (after P14) | Per the training workflow add-on |
| P2 accuracy gate | Not met: runs on 3 real CODM streams and beats the random, audio-only and chat-only baselines on held-out sessions (`docs/plan/2026-10-27-p2-clip-baselines.md`) | All of the above |

## 3. Open decisions (answer on resume; recommended default in brackets)

A6:
1. Keep `highlightsEditedAfterSuggestions` in the label file [keep].
2. Are 18, 20 and 21 Oct all CODM? (`data/session-games.json` says so) [yes].
3. Add `paths.analysis_cache` to `data/profile.local.json` [yes].
4. Pre-fill display defaults: replay −2/+10 s, merge 4 s, match group 120 s [yes, marked unverified].
5. OCR text in the pass 2 list [hidden by default, with a toggle].
6. Reason tags: keep multi-kill, killstreak, impact-play, mvp, killcam, clutch, funny-reaction, fail; reject quiet, lobby-menu [approve].

OCR:
1. Per-detector sample rates offline only; the live tracker stays at 1 fps and may lag [yes].
2. No GPU OCR install now; decide at P14 (GPU OCR while live conflicts with the VRAM rule) [yes].
3. Add a `sampleHz` field per ROI in W2 [yes].
4. Defer the remaining timing measurements to W2 [yes].
5. Pre-fill 21 Oct first, then 18 and 20 Oct, overnight, one at a time [yes].

Other:
- Should the label tool get a fifth review? [no: round 4 was verified locally; real use comes first].

## 4. How to resume

Run these one at a time. Heavy jobs run alone, at BelowNormal priority with about 4 threads.

1. Read this file, the parked gate and the P2b plan (`docs/plan/2026-10-27-p2b-plan.md`). Check whether "Train a game" has started in the app. If it has, resume through that feature instead of the steps below.
2. Run `npm test`, `npm run test:py`, `npm run test:ocr` and `npm run validate:games`. Check that the A5 reproduction from W0 still holds (`docs/evidence/2026-10-27-p2b-w0-pack-split.md`).
3. Ask the user the §3 decisions. Then ask whether more labelled data is needed now (the CLAUDE.md training-data rule).
4. Check that the analysis cache still holds the three proxies (`build_cache.py ... verify`). Rebuild a proxy only if it is missing; commands are in the A6 evidence §7.
5. Run the pre-fill scans (A6 evidence §7), one session at a time.
6. The user labels with `npm run label -- --cache <analysis-cache>`; the corpus path comes from the profile. Exports go to `data/labels/`. When committing, stage `data/label-tags.json` and `data/session-games.json` with the label files.
7. Continue with J1, W2, G3/J2, W3 and the P2 gate, as in the P2b plan.

## 5. Notes

- Local data root (outside the repo): `index/`, `cache/`, captures and chat. Paths come from `data/profile.local.json`; none is committed.
- Private crops and coverage state stay in `docs/evidence/private/` and `data/games/codm/local/` (both gitignored).
- Session scratch files from this track are not part of the resume. A leftover headless-Chrome profile (`rt\`, 11,429,220 bytes) is in the 2026-10-28 session scratchpad. Deleting it waits for the user's yes.
