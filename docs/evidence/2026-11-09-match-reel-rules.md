# Match reel rules (D315, 2026-11-09)

Branch `clip/reel-rules`. Synthetic fixtures only (placeholders, no names). No devices, no corpus, no stream.

User, 2026-11-09: "for won if top3 go ahead. if defeat if it's top go ahead. if won or defeat if the kills are more
than 20 (in hardpoint, domination, control) - go ahead, if it's TDM kills above 7 go ahead, in search if it a win or
muliple kills within a round go ahead."

User, D315a (2026-11-09): a defeated match qualifies when placed top 2, not first only.

Status: rules and code tested on synthetic data. Every signal the rules read comes from detectors that are still unverified (table below). Not
yet run on a real recording.

## 1. Where the decision was made

- Before: `services/clip/clip_montage.py` `match_reels()` made a reel for every signalled W1 VICTORY with an own
  kill (D237). No place, mode or kill rule. The match gate (`match_gate.decide`, D286, `clips.matchGate` setting)
  only filters short clips; it never filtered reels.
- Now: rules are data in `data/games/codm/match-reels.json`; `match_gate.reel_decide()` evaluates them per match from
  `match_gate.segment()`; `match_reels()` cuts reels only for qualifying matches. `clipper.py montage` writes the
  per-match decision to `DIR/montage/match-reels.json` and prints one line per match.
- Unchanged: kill montages (M01..), short-clip streak-only selection, deaths as hard negatives, reel pieces
  (3 s before, 1.5 s after each own kill, cut before a death, result screen piece, no 60 s cap, V canvas), and the
  clip match gate.

## 2. Signal inventory

| Signal | Detected today? | Source | Evidence | Status |
|---|---|---|---|---|
| Match result (VICTORY / DEFEAT) | yes | W1, centre ROI; a signalled box of the majority word (`resultConfirmed`) | `2026-11-07-match-result-detector.md`: 1 practice recording, VICTORY 1 frame, DEFEAT 2 frames | unverified |
| Place | yes, only on the MP top-3 screen (#1-#3; outside the top 3 = "not on the cards", no exact place) | S1 rank cards | `2026-11-08-match-gate.md`: ROIs verified on 3 frames of one top-3 screen (VICTORY, Hardpoint, own #1); 6/6 frames in the real run | detector unverified; ROIs verified on one match. No DEFEAT top-3 screen seen: which team it shows is unknown |
| Game mode name | partly | S1 `mode_label` read on the top-3 screen against `stats.modeNames` | only HARDPOINT seen (same match) | unverified. CONTROL is not in `modeNames` (no frame), so Control is never read. No mode is read when the top-3 screen is missing |
| Own kill count | yes | kill feed (M5 / B1, `KillCounter`); scoreboard own-row kills when read | kill feed: 46 counted vs about 45 by hand on one practice match; scoreboard: no frame | unverified (both) |
| Rounds, kills per round (Search and Destroy) | no | none | none | missing |

Effect on the rules: a condition whose signal was not read makes its rule inert, and an inert rule never gives a
reel. So, until more footage is labelled:

- `snd-round-multikill` never fires (no round detector). Needed: labelled Search and Destroy recordings with the round
  start and round end screens (round number, round won/lost banner) and the own kills per round, about 3 matches.
- `objective-kills` never fires for Control (mode not read). Needed: a Control top-3 screen (mode label text) to add
  CONTROL to `stats.modeNames` with evidence.
- `tdm-kills`, `snd-won`, and Domination need one top-3 screen each to confirm the mode label reads; the code path is
  the same as Hardpoint.
- `defeat-top2` needs a DEFEAT top-3 screen to confirm it shows the own team's top 3.
- The kill rules depend on the kill-feed count (unverified, about 2% over the hand count on one match). A count near
  21 or 8 can fall on either side. Needed: the game's own end-of-match kill number (final MP scoreboard,
  capture-plan `mp_final_scoreboard`) for a few matches.

## 3. Rules (data)

`data/games/codm/match-reels.json` (schema `data/games/match-reels.schema.json`, validated by
`tools/game-validate.mjs`: schema, game id, unique rule ids, results are W1 patterns):

| Rule | When | Status |
|---|---|---|
| `won-top3` | result VICTORY, maxPlace 3 | approved |
| `defeat-top2` | result DEFEAT, maxPlace 2 | approved (D315a) |
| `objective-kills` | modes hardpoint / domination / control, killsAbove 20 | approved |
| `tdm-kills` | mode team deathmatch, killsAbove 7 | approved |
| `snd-won` | mode search and destroy, result VICTORY | approved |
| `snd-round-multikill` | mode search and destroy, roundKillsAtLeast 2 | approved, inert (no signal) |

A match qualifies when any rule passes. Each rule: any failing condition = fail; else any unread signal = inert;
else pass. A match with no end screen seen never qualifies. A qualifying match with no own kill gets no reel
(`noReel` in the report).

## 4. Report per run

`clipper.py montage` writes `DIR/montage/match-reels.json`: rules, inputs, and per match the segmentation fields
plus `reel` = `{qualifies, reason, rules: [{id, outcome, why}], noReel?}`, and `reels` (W id, match, passing rules,
kills). `render.json` gets `matchReels {file, matches, qualified, reels}`. Console, for example:

```
montage: match 1 0-10 s: REEL (won-top3 (VICTORY; placed #1))
montage: match 2 10-12 s: no reel (no end screen seen (the recording stopped mid-match))
```

## 5. Tests

Commands (worktree, `.venv` python, BelowNormal priority):

```
python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py"   -> Ran 169 tests, OK
python -I -m unittest discover -s tests/py -t tests/py -p "test_match_*.py"  -> Ran 33 tests, OK
python -I -m unittest discover -s tests/py -t tests/py                       -> Ran 406 tests, OK (skipped=6)
node --test tests/game-validate.test.mjs                                     -> 19 pass, 0 fail
node tools/game-validate.mjs                                                 -> OK: 1 game pack(s) valid: codm 0.5.0
node tools/ci.mjs --quick                                                    -> ci: 9/9 passed
```

The `test_match_*.py` and `test_clip_montage.py` runs were repeated after D315a (defeat top 2): 33 and 20 tests, OK.

- `tests/py/test_match_reel_rules.py` (new, 22 tests): pack rules as data; won top 3 (#1-#3 pass, off the cards
  fails, top-3 not read inert, unsignalled W1 inert); defeat #1 and #2 pass, #3 fails (D315a boundary); objective kills 20 fail / 21 pass in
  Hardpoint, Domination and Control, won and defeated; other modes fail; mode or kills not read = inert (40 kills with
  no mode gives no reel); TDM 7 fail / 8 pass; Search and Destroy won passes, lost with no round data is inert, round
  kills 1/1/1 fail and 0/2/1 pass (set by hand: no detector fills `roundKills`); no end screen; end seen with nothing
  read = all inert; kill rule without a result word; reels follow the decision; qualifying match with no kill.
- `tests/py/test_match_gate_scenarios.py`: reel scenarios updated to D315 (VICTORY #2 and DEFEAT #1 get reels via `won-top3` and `defeat-top2`;
  VICTORY off the cards and the unread match do not; reasons recorded). Gate scenarios unchanged.
- `tests/py/test_clip_montage.py` MatchReelTests: same pieces as before, now through the rules; new case: VICTORY
  without a top-3 reading gives no reel.
- `tests/py/test_clip_pipeline.py`, `tests/py/test_clip_e2e.py`: fixtures add a placeholder `match-stats.json`
  (own card #1); the pipeline test checks `match-reels.json` and `render.json` `matchReels`.
- `tests/game-validate.test.mjs`: bad result word, duplicate rule id, negative threshold, unknown condition, wrong game.

## 6. Behaviour change to note

A VICTORY whose top-3 screen was not read no longer gets a reel (before: every VICTORY with a kill). On the
2026-11-07 practice recording (W01, 7 kills) no S1 reading exists, because S1 came on 2026-11-08: a re-run of
`detect` there is needed before W01 would be made again. UNVERIFIED on a real recording.
