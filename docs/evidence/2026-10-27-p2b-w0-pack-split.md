# P2b W0 — game pack schemas, validator, CODM pack split

Date: 2026-10-27. Step W0 of `docs/plan/2026-10-27-p2b-plan.md` (pack format: `docs/plan/2026-10-27-game-training-workflow.md` §4). Design approved by the user before the work. Counts only: no player names, no IGN, no frames. Analyse outputs used for the reproduce check hold OCR text and stay outside the repo (session scratchpad) or in `docs/evidence/private/` (gitignored).

**Done when:** CODM pack validates; existing CODM results (A5–A5c) reproduce.

| Item | Result | Evidence |
|---|---|---|
| CODM pack validates | PASS | `npm run validate:games` → `OK: 1 game pack(s) valid: codm 0.3.0` (§5) |
| A5–A5c results reproduce | PASS | 7 analyse runs, 24,832 hits: 0.2.2 and 0.3.0 outputs byte-identical (§4) |

## 1. Pack layout (0.3.0)

```
data/games/
  game.schema.json  detector-pack.schema.json  events.schema.json  screens.schema.json  capture-plan.schema.json  detection.schema.json
  codm/
    game.json  detectors.json  events.json  screens.json  capture-plan.json  CHANGELOG.md
    local/                  (gitignored) medals-reference/ (moved from data/datasets/codm-medals-reference)
```

- `game.json` (new): id, name, modes, taggingOnlyModes, gameArea, nameMatch, ocr. Values moved from `detectors.json` unchanged.
- `detectors.json` 0.3.0: detectors, suppressionRules, endScreenRule; `game` is now the id string. Every ROI, pattern, status, note and null weight, window and cooldown is unchanged in value (checked by a script against `git show HEAD:data/games/codm/detectors.json`: the only differences are the new `screens` fields, M3 `catalogue` in place of `medals`, and the M3 `referenceDataset.path`).
- Per-detector `screens` gate (screen ids from `screens.json`): M1 postmatch_mvp, mp_scoreboard, mp_top3; M2 impact_play; M3 and M4 mp_gameplay, impact_play; M5 mp_gameplay; B1 br_gameplay; X1 mp_gameplay, br_gameplay; B2 br_gameplay; K1 final_killcam; N1 mp_gameplay, br_gameplay; N2 br_gameplay.
- `events.json` (new): catalogue `medals`, the 27 medals from M3 in the same order. Mega Kill, Super Kill and Ultra Kill: `listed_not_seen` → `seen_g1`, with `evidence: ["docs/evidence/2026-10-27-p2a-a5c-mp-capture-3.md"]` (A5c m1: one of each). Nuclear and Ultimate Terminator stay `listed_not_seen`; Relentless and Brutal stay `unverified`.
- `screens.json` (new): 14 screen types — mp_gameplay, br_gameplay, lobby, profile, like_toast, summary, postmatch_mvp, impact_play, final_killcam, mp_scoreboard, mp_top3, br_squad_cards, br_placement, no_signal. Each has kind, modes, cues (texts, optional ROI as game-area fractions, status, note), detectors, status, note, evidence. Every screen is `unverified` (no screen classifier exists yet). Cue status `verified` only where A5/A5b measured the text position: postmatch MVP (x 0.02–0.11, y 0.41–0.47), IMPACT PLAY header, the M1 endscreen band on the scoreboard, the top-3 badge row (y 0.84–0.87) and the BR squad-card badge row (y 0.78–0.80). Everything else is `unverified` with a note saying what was not measured. The gameplay cue texts are the HUD words of the existing frame classifier (`MODE_CUES` in `g1_scan.py`); a test keeps the two equal.
- Excluded screens (kinds menu, overlay, summary, signal_loss; the schema forces an empty detector list): lobby, profile, like_toast, summary, no_signal. br_squad_cards and br_placement are end screens with no detector (M1 is MP-only).
- DMZ: still tag-only. No detector lists it, and no screen that runs detectors lists it (lobby, profile, like_toast and no_signal have `modes: []`).
- `pairingRules` in `screens.json`: `mvp_badge_name_same_card` — detector M1, badge MVP, name on the same card (right of or below the badge), `frameLevelName: false`, screens postmatch_mvp, mp_scoreboard, mp_top3, status `unverified` (described in A5b/A5c, not implemented).
- `capture-plan.json`: content unchanged; `$schema` added and the "schema arrives at W0" sentence in `$comment` replaced by a pointer to the schema.
- `CHANGELOG.md` (new): 0.1.0 → 0.2.0 → 0.2.1 → 0.2.2 → 0.3.0 from the old `$comment`; the `$comment` in `detectors.json` now points to it.

## 2. Schemas and validator

- New: `game.schema.json`, `events.schema.json`, `screens.schema.json`, `capture-plan.schema.json` (JSON Schema 2020-12, `additionalProperties: false`, compile under ajv `strict: true`).
- `detector-pack.schema.json` (same filename): top level is version, engineVersion, game (id), detectors, suppressionRules, endScreenRule; detector gains required `screens` and `catalogue` (M3 must have it); `medals` removed (now in `events.schema.json`); `referenceDataset.path` pattern `^data/games/<id>/local/<name>$`.
- `detection.schema.json` unchanged (packVersion is a semver pattern). Fixture `tests/fixtures/g0/detection.example.json` packVersion 0.2.2 → 0.3.0.
- `tools/game-validate.mjs` (`npm run validate:games`): schema-checks the five files of every `data/games/<id>/` folder, then cross-file references: game id = folder = `game` field of every file; detector ids in suppressionRules, endScreenRule, screens and capture plan exist; detector gates and screen detector lists match both ways; gated screens share a mode with the detector; M3 `catalogue` resolves in `events.json` and every catalogue is used; capture-plan medals exist in the detector's catalogue; capture-plan, detector and screen modes are in `game.json`; no tag-only mode in a detector or in a screen that runs detectors; endScreenRule detectors have nameRequired and gate only on end screens; suppressed detectors share a screen with the suppressing one; pairing-rule screens run its detector; referenceDataset sits under the pack's own `local/`; evidence files exist. Exit 1 on any error. It never reads `local/`.

## 3. Loader and tools

- `services/clip/game_pack.py` (stdlib): `load_pack(path)` takes the pack folder or its `detectors.json`, and returns the merged dict the G1 tools use (M3 gets the catalogue as `medals`; plus `screens` and `pairingRules`). A single-file `detectors.json` from before 0.3.0 is returned unchanged, so older pack versions can still be analysed. `reference_dataset(pack)`.
- `services/clip/g1_scan.py`: `analyse`, `crops`, `refmedals` load `--pack` through `game_pack.load_pack`. The analyse logic itself is unchanged; the screen gate is not applied (data only in W0).
- refmedals default dataset: the pack's `referenceDataset.path` (`default_dataset(pack)`), replacing the hardcoded `DEFAULT_DATASET` constant (deviation from "update DEFAULT_DATASET": it removes a game name from engine code; same resulting path for CODM). `--dataset` still overrides.

## 4. Reproduce check

Commands (repo root; `S` = session scratchpad, outside the repo; `P=docs/evidence/private`):

```
git show HEAD:data/games/codm/detectors.json > $S/w0/detectors-0.2.2.json      # sha256 acc04134…218ce, same as the HEAD file
# baseline with HEAD code (g1_scan.py not yet edited), pack 0.2.2:
sh $S/w0/run-analyse.sh $S/w0/detectors-0.2.2.json $S/w0/base-022
# after the edits, pack folder 0.3.0:
sh $S/w0/run-analyse.sh data/games/codm $S/w0/new-030
# run-analyse.sh runs, one process at a time (BelowNormal, no OCR):
#   .venv/Scripts/python.exe -I services/clip/g1_scan.py analyse --scan <scan> --pack <pack> --profile data/profile.local.json --out <root>/<run>
#   a5-corpus  $P/g1-corpus/scan/corpus-t.jsonl     a5-live-mp $P/g1-corpus/scan/live-mp.jsonl   a5-live-br $P/g1-corpus/scan/live-br.jsonl
#   a5b-mp     $P/g1-live-2/scan/mp-1fps.jsonl      a5b-br     $P/g1-live-2/scan/br-1fps.jsonl
#   a5c-mp     $P/g1-live-3/scan/mp-1fps.jsonl      a5c-br     $P/g1-live-3/scan/br-1fps.jsonl
python -I $S/w0/diff_runs.py $S/w0/base-022 $S/w0/new-030      # compares hits (packVersion ignored; hits carry none) and bytes of every output
```

No new OCR runs; existing scans only. Wall time: baseline 11 min, 0.3.0 12 min.

| Run | Hits 0.2.2 | Hits 0.3.0 | Only 0.2.2 | Only 0.3.0 | hits.jsonl | summary.json | clip-modes.json |
|---|---|---|---|---|---|---|---|
| a5-corpus | 10,279 | 10,279 | 0 | 0 | identical | identical | identical |
| a5-live-mp | 450 | 450 | 0 | 0 | identical | identical | identical |
| a5-live-br | 909 | 909 | 0 | 0 | identical | identical | identical |
| a5b-mp | 2,889 | 2,889 | 0 | 0 | identical | identical | identical |
| a5b-br | 4,617 | 4,617 | 0 | 0 | identical | identical | identical |
| a5c-mp | 4,277 | 4,277 | 0 | 0 | identical | identical | identical |
| a5c-br | 1,411 | 1,411 | 0 | 0 | identical | identical | identical |
| **Total** | **24,832** | **24,832** | **0** | **0** | | | |

The screens gate changed no hit (it is not applied). Two more checks on a5-live-mp with the new code: `--pack $S/w0/detectors-0.2.2.json` (single-file pack) and `--pack data/games/codm/detectors.json` (file path instead of folder) both give byte-identical outputs to the baseline.

Comparison with the original A5–A5c outputs in `docs/evidence/private/` (context only, not the W0 test): a5b-br (`analyse-br-021`), a5c-mp and a5c-br are byte-identical to the reruns. The A5 corpus and live-reference outputs differ (11,718 / 603 / 1,314 rows then vs 10,279 / 450 / 909 now): they were made with the 0.1.0-era code and pack, before the A5 fixes (ignored medal texts, B2 capitals, K1, minTextHeight). a5b-mp (`analyse-mp-021`, 18:46) has 13 fewer B1 rows than both reruns; the same 13 rows appear with 0.2.2 and 0.3.0, so the difference predates W0. Cause UNVERIFIED (that output was probably written by an intermediate A5b code state).

## 5. Tests and checks

Run one at a time after all changes:

| Command | Result |
|---|---|
| `npm test` | 149 tests, 149 pass, 0 fail, 0 skipped (was 135; +14 in `tests/game-validate.test.mjs`) |
| `npm run test:py` | 97 tests OK (8 skipped: OCR tests need the venv) (was 85; +10 `test_game_pack.py`, +2 `test_g1.py`) |
| `npm run test:ocr` | 39 tests OK (was 37; +2 in `test_g1.py`) |
| `npm run validate:games` | `OK: 1 game pack(s) valid: codm 0.3.0`, exit 0 |
| `node tools/git-hooks/private-scan.mjs scan-worktree` | exit 0, no findings |

New tests: validator on the committed packs and on a temp copy (pass); broken cross-references fail — unknown screen in a gate, gate and screen lists out of step, unknown detector in a screen, gate on a screen of another mode, unknown detectors in suppression and end-screen rules, end-screen detector without nameRequired, unknown catalogue, unused catalogue, duplicate medal, capture-plan unknown detector, unknown medal, detector not in the item mode, tag-only item mode, tag-only mode on a screen that runs detectors, detector in dmz, unknown tag-only mode, game id mismatch, dataset under another game, pairing-rule screen that does not run M1, `frameLevelName: true`, detector on the summary screen, missing pack file, missing evidence file, CLI exit 0/1. G0 schema tests now validate all five files, check the Mega/Super/Ultra Kill status and evidence, reject inline `medals`, a missing gate and the old dataset path. Loader tests: folder and file path give the same pack, merged shape, catalogue order and no aliasing, single-file pack unchanged, broken copies raise. `test_g1.py` loads the pack through the loader, checks that screens with detectors exclude dmz, that gameplay cues equal `MODE_CUES`, and the pack-derived refmedals dataset path. All names in tests are invented.

## 6. Reference dataset move

```
git check-ignore -v data/games/codm/local/medals-reference/probe.txt   # .gitignore:56:data/games/*/local/ (after adding the rule, before the move)
find + sha256sum before → mv data/datasets/codm-medals-reference data/games/codm/local/medals-reference → find + sha256sum -c after
```

Before: 649 files, 91,237,836 bytes, 14 folders. After: 649 files, 91,237,836 bytes, 14 folders; name+size lists identical; all 649 SHA-256 match. `data/datasets/` stays in `.gitignore` and on disk, now empty (not deleted).

Observation: `index.jsonl` has 718 records but the folder holds 648 crops (+ the index). Some crop file names probably repeat (same session label, time and ROI across runs) and were overwritten. UNVERIFIED; not changed in W0.

## 7. UNVERIFIED, placeholders, risks

- Every screen type is `unverified`; the gate is data only. The W2 screen classifier has to apply it, and only then can it change hits.
- Gate choices that are judgements on the evidence, for the user to confirm: impact_play allows M2, M3, M4 (M3/M4 then suppressed) but not M5 or X1 (whether the replay repeats them is not measured); br_squad_cards runs no detector because M1 is MP-only (A5c read MVP and KILLS 6/6 there); mp_scoreboard may also appear mid-match (A5c read scoreboards during play; MVP badges there not recorded).
- Cue positions with no measurement (lobby, profile, summary, no_signal, GAME OVER, KILLS, the Like toast x extent, the REC marker) are left out or full width, with a note.
- `MODE_CUES` lives in both `g1_scan.py` and `screens.json` until the classifier reads the pack; a test keeps them equal.
- Mode enums (`mp`, `br`, `dmz`) are still fixed in the schemas (as before). A second game (W5) needs them opened up; noted, not changed.
- Placeholders: all weights, windows and cooldowns are still null; K1 killer_name ROI is still a guessed band.
- Mocks: none. Skipped tests: the 8 OCR tests under the system Python (they pass under `npm run test:ocr`).

## Files created or changed

- Created: `data/games/game.schema.json`, `data/games/events.schema.json`, `data/games/screens.schema.json`, `data/games/capture-plan.schema.json`, `data/games/codm/game.json`, `data/games/codm/events.json`, `data/games/codm/screens.json`, `data/games/codm/CHANGELOG.md`, `tools/game-validate.mjs`, `services/clip/game_pack.py`, `tests/game-validate.test.mjs`, `tests/py/test_game_pack.py`, `docs/evidence/2026-10-27-p2b-w0-pack-split.md`
- Changed: `data/games/codm/detectors.json` (0.2.2 → 0.3.0), `data/games/codm/capture-plan.json` (`$schema`, `$comment`), `data/games/detector-pack.schema.json`, `services/clip/g1_scan.py`, `tests/g0-schemas.test.mjs`, `tests/py/test_g1.py`, `tests/fixtures/g0/detection.example.json`, `package.json` (`validate:games`), `.gitignore` (`data/games/*/local/`)
- Moved (local only, gitignored): `data/datasets/codm-medals-reference/` → `data/games/codm/local/medals-reference/`
- Local only (outside the repo, session scratchpad): 0.2.2 pack copy, baseline and 0.3.0 analyse outputs, run and diff scripts
