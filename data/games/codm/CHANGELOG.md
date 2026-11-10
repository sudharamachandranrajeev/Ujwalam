# CODM pack changelog

The pack version is `version` in `detectors.json`. It covers every file in this folder (`game.json`, `detectors.json`, `events.json`, `screens.json`, `capture-plan.json`, `match-reels.json`). Validate with `npm run validate:games`.

## 0.8.0 — 2026-11-10 (reels cut only own kills, spectate detector N3, impact-play reels, D326)

Evidence: `docs/evidence/2026-11-10-reel-own-kills-impact-play.md`.

- New detector N3 "Spectating until the next round" (role negative, no weight, nameRequired false, status unverified), screen `mp_gameplay`, mode mp, ROI `respawn_banner` (x 0.36-0.64, y 0.64-0.72 of the game area), pattern YOU WILL RESPAWN NEXT ROUND (fuzzy partial match 0.85, in `services/clip/g1_scan.py`).
- S1 `stats` gains `spectateDetectors` (["N3"]): own kills read while an N3 span is open are another player's kills and are not counted. `data/clip/ranking.json` `death.detectors` adds N3, so reel pieces are cut where spectating starts.
- Match reels (code): pieces are cut only around the counted own kills of the match (`ownKillTimes` from `segment()`), not every kill-feed hit; the BR-feed hits read from the MP loadout panel no longer make pieces. A rule may set `pieces` to `qualifying-rounds` (schema `match-reels.schema.json`); `snd-round-multikill` does, so a Search and Destroy reel that qualifies only by a round multi-kill shows that round's own kills.
- New `impactPlay` object in `match-reels.json` (schema `$defs/impactPlay`, checked by `tools/game-validate.mjs`): a separate `impact-play` reel from the streamer's own IMPACT PLAY (M2) through the results page (C2), behind the flag `impact-play-reels` (off by default). Its timing values are agent values, proposed and unverified.
- Detection changes: N3 rows are new. Runs detected with 0.7.0 still cut reels from counted kills, but read no spectate spans until re-detected.

## 0.7.0 — 2026-11-10 (summary-screen mode header, own kill count fixes)

Evidence: `docs/evidence/2026-11-10-lobby-mode-and-kill-dedup.md`.

- New detector C2 "Summary-screen mode header" (role context, no weight, nameRequired false, status unverified), screen `summary`, ROI `mode_header` (x 0.49-0.66, y 0.01-0.07 of the game area), cues SEARCH & DESTROY, DOMINATION, TEAM DEATHMATCH, CONTROL (read on 2026-11-09) and HARDPOINT (not yet seen in the header). New detector field `afterEndSec` (30 s, a margin): how long after a match's end screens a header still belongs to that match. `match_gate.game_mode()` takes the header as another evidence source ("summary header", confidence high like the top-3 mode name); disagreeing evidence still gives no mode, with the reason.
- Screen model: `summary` screens may now run detectors, but only name-free context detectors (role context, nameRequired false), checked by `tools/game-validate.mjs`; menu, overlay and signal_loss screens still run none.
- Own kill count (detector pass and match gate code, no pack value changed): ROI-band boxes held from an earlier frame by the roiEvery cadence are dropped under a band read this frame; a whole kill-feed line merged into one box with the profile name at its end is a death, not a kill; kill-feed rows are grouped against the row's first box; the victim key comes from the victim side only (count digits, a second own-name box and the own-name part of a merged box are skipped); a box that is a profile name variant on its own is no line; each kill records its feed (M5 or B1) and a match counts only the feed of its HUD family (M5 in MP, B1 in BR).
- Detection changes: C2 rows are new; match-stats.json `ownKills` gains `feeds`. `data/clip/detector-pass.json` `splitBySignal` adds C2, so a header read is dated to the summary screen, not to the top-3 screen before it. Runs detected with 0.6.0 segment as before (no header evidence, all kills counted) until re-detected.

## 0.6.0 — 2026-11-10 (round end vs match end, game mode per match)

Evidence: `docs/evidence/2026-11-10-round-vs-match-end.md`.

- W1 gains `banner` (schema `detector-pack.schema.json`, all status unverified): `kinds` tell a round-end banner (word centre y 0.31-0.38) from a match-end banner (y 0.39-0.47); `subtitleRoi` and `subtitles` read the line under a round banner (ENEMIES ELIMINATED, SQUAD ELIMINATED, BOMB DEFUSED pointing to Search and Destroy, SCORE LIMIT REACHED as a half-time round, ALL ZONES CAPTURED); `followers`/`followSec` 30 classify hits without a kind by the post-match screens that follow a match end; `sameBannerSec` 10 joins one banner split into two hits. Only match-end banners now close a match; round banners become the match's `rounds` and fill `roundKills`.
- New detector C1 "Game mode cues" (role context, no weight, status unverified), screens `mp_gameplay` and `mp_scoreboard`: ROIs `objective` (DESTROY TARGET) and `scoreboard_head` (PLANTS, DEFUSES), new detector field `cues` (text and the modes it points to). `services/clip/match_gate.py` `game_mode()` combines C1 cues, the top-3 mode name and round subtitles into one mode per match with a confidence and the evidence list, or none with the reason.
- S1 `modeNames` entries may be `{text, mode}`; added SEARCH & DESTROY (the on-screen spelling), CONTROL (top-3 screen), KILL CONFIRMED and FRONTLINE (mode-select tiles only). `scoreRegex`, `patterns` and `regex` also take RATING n (ranked TDM top-3 cards).
- Detection changes: W1 rows carry `banner` and `subtitle`; C1 rows are new. Runs detected with 0.5.0 still segment correctly through the follow-on fallback, but read no C1 cues, subtitles or RATING top-3 screens until re-detected.

## Unreleased — 2026-11-09 (match reel rules, D315)

Evidence: `docs/evidence/2026-11-09-match-reel-rules.md`.

- New file `match-reels.json` (rules version 1, schema `match-reels.schema.json`, checked by `tools/game-validate.mjs`): which matches get a won-match reel. Replaces the VICTORY-only selection of D237. Rules: won and top 3; defeated and top 2 (`maxPlace` 2, user D315a); more than 20 own kills in Hardpoint, Domination or Control; more than 7 own kills in TDM; Search and Destroy won, or at least 2 own kills in one round. A rule whose signal was not read is inert.
- No detector, ROI, pattern or threshold changed, so detection results are the same as 0.5.0; the pack version is not bumped.

## 0.5.0 — 2026-11-08 (S1 match stats, match gate, D286 proposed)

Evidence: `docs/evidence/2026-11-08-match-gate.md`.

- New detector S1 "Match stats" (role context, no weight, status unverified), screens `mp_top3` and `mp_scoreboard`. Top 3: ROIs `rank1_card` (centre), `rank2_card` (left), `rank3_card` (right) and `mode_label` (top left), status verified from 3 frames of one top-3 screen of the 2026-11-08 practice (game area of the H canvas, project layout). Rank comes from the card position (the rank digit is not read by OCR); the own card is the card with a profile name (nameMin). Scoreboard: ROI `scoreboard_rows`, status unverified (no final scoreboard frame yet).
- New optional detector field `stats` (schema `detector-pack.schema.json`): score pattern, kills headers, mode names, end-screen detectors, end gap, kill-line hold and victim match threshold for `services/clip/match_gate.py`. All unverified except where the notes say.
- Screens `mp_top3` and `mp_scoreboard` list S1; `mp_top3` cites the new evidence.
- `data/clip/detector-pass.json` `roiEvery` reads S1 every 5th sampled frame (as M1 and M2).

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
