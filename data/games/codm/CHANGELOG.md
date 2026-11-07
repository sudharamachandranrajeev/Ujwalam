# CODM pack changelog

The pack version is `version` in `detectors.json`. It covers every file in this folder (`game.json`, `detectors.json`, `events.json`, `screens.json`, `capture-plan.json`). Validate with `npm run validate:games`.

## 0.4.0 — 2026-11-07 (W1 match result, D237)

Evidence: `docs/evidence/2026-11-07-match-result-detector.md`.

- New detector W1 (role context, no weight, status unverified): VICTORY / DEFEAT in the centre ROI x 0.40–0.60, y 0.35–0.50, OCR, mp. The label is the result word. Used by `clipper.py montage` for the won-match reel.
- New screen `match_result` (before `summary`).

## 0.3.0 — 2026-10-27 (P2b W0, pack split)

Evidence: `docs/evidence/2026-10-27-p2b-w0-pack-split.md`.

- Split the single `detectors.json` into the W0 pack format (`docs/plan/2026-10-27-game-training-workflow.md` §4):
  - `game.json` (new): id, name, modes, taggingOnlyModes, gameArea, nameMatch, ocr, moved out of `detectors.json` unchanged.
  - `detectors.json`: detectors, suppressionRules, endScreenRule. `game` is now the game id. Every ROI, pattern, status, note and null weight, window and cooldown is unchanged.
  - Each detector has a `screens` gate (screen ids from `screens.json`). The gate is data only: `g1_scan analyse` does not apply it yet.
  - M3 points at the `medals` catalogue in `events.json` (`catalogue`) instead of holding `medals` inline.
  - `events.json` (new): the medal catalogue, order kept.
  - `screens.json` (new): 14 screen types with cue texts, cue ROIs and status from the A5–A5c evidence only, and the M1 badge-to-name same-card pairing rule (`pairingRules`).
  - `capture-plan.json`: content unchanged; `$schema` added (`capture-plan.schema.json`).
- P2b W1 (2026-10-28, before 0.3.0 is committed; no detector, ROI or catalogue change, so no version bump): `capture-plan.json` file format 1 → 2. Every item has `match` (auto or manual, `when` criteria built only from existing detectors, ROIs, patterns, medals and screens). Auto only where the validator finds verified positions: the 4 medals and the BR multi-kill banner. Evidence: `docs/evidence/2026-10-27-p2b-w1-coverage-capture.md`. User decision 2026-10-28: no bump; 0.3.0 includes this change.
- X1 note (2026-10-28): X1 appears in BR as well as MP (A5b BR: 32 `banner_br` hits, 5 with the profile name). Corrects the P2a gate note "seen in MP only". Note text only; no ROI or pattern change.
- Mega Kill, Super Kill and Ultra Kill: `listed_not_seen` → `seen_g1` (seen live in A5c, `docs/evidence/2026-10-27-p2a-a5c-mp-capture-3.md`).
- M3 `referenceDataset.path`: `data/datasets/codm-medals-reference` → `data/games/codm/local/medals-reference` (gitignored `local/` folder).
- Schemas: `game.schema.json`, `events.schema.json`, `screens.schema.json`, `capture-plan.schema.json` (new); `detector-pack.schema.json` updated. Validator: `tools/game-validate.mjs`.

## 0.2.2 — 2026-10-27 (user decision, P2a gate)

Evidence: `docs/evidence/2026-10-27-p2a-gate.md` §3.

- `endScreenRule`. A match can show several end screens (Domination shows MVP and Impact Play). Each of M1, M2 and K1 is checked for the profile name separately. Any screen with the name gives one match-level positive, and all named screens are listed as reasons. None named gives no signal. No end screen is required.

## 0.2.1 — 2026-10-27 (A5b, live full-screen capture 2)

Evidence: `docs/evidence/2026-10-27-p2a-a5b-live-capture-2.md`.

- N1: labels and killer-name ROIs.
- M1: post-match screen.
- N2: revival line at the top.
- B1: `minTextHeight`.
- X1: the 5+ form.
- B2: N KILL(S) is the user count.

## 0.2.0 — 2026-10-27 (user decisions)

Evidence: `docs/evidence/2026-10-27-p2a-a5-g1-corpus-check.md` §12.

- M3 medal classes (positive / reference) and the reference-medal dataset.
- K1 FINAL KILLCAM (name required).
- `dmz` as a tag-only mode.

## 0.1.0 — 2026-10-27 (G0)

Evidence: `docs/evidence/2026-10-27-p2a-a4-g0-schemas.md`, `docs/evidence/2026-10-27-g1-live-reference.md`.

- First CODM pack. All ROIs, texts and colours UNVERIFIED until G1/G2 check them on footage. Weights, windows and cooldowns null (G3 proposes them from labelled data).
