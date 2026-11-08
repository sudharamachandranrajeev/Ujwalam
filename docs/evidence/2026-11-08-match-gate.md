# 2026-11-08 Match gate (S1 match stats, own kills, matches, D286 proposed)

User, 2026-11-08: "extract the total kills the streamer took at the end of the match from the end screens; if it is a
high amount, or the player is in the top 3 of the winning or losing team, the clips of that match are processed."

Status: the top-3 reading is **verified on one practice match** (one VICTORY, Hardpoint, the streamer at #1). The
scoreboard kill count is **UNVERIFIED** (no frame). The kill-feed kill count is **UNVERIFIED** (one match, counted
against a hand reference, not against the game's own number). The gate rules and settings are tested. No minKills
value is set.

Names: every player name in this file is a placeholder (OWN_NAME, PLAYER_A ...). The source frames show real names
and a face; they stay in the private scratchpad and are not copied into the repo.

## 1. What was built

- `services/clip/match_gate.py` (new, stdlib + `g1_text`):
  - S1 reading: the top-3 screen (per card: rank from the card position, score, whether it is the own card by the
    profile-name rule `nameMin`), the game mode label, and the scoreboard own-row kills (UNVERIFIED layout rule).
  - `KillCounter`: own kill-feed lines (M5 in MP, B1 in BR, the profile name as killer) deduplicated across frames.
    The victim text is an in-memory key only and is never written.
  - `segment`: matches from end-screen clusters (S1, W1, M1, M2, K1; gap 90 s). The part after the last end screen is
    a match with no end seen.
  - `decide` / `gate_candidates` / `gate_saves`: a match passes on top 3 (`top3`) or kills >= `minKills`. A match
    whose end was not seen, or whose top-3 screen or kills were not read, keeps its clips.
- `services/clip/detector_pass.py`: the scanner reads S1 and counts own kills; `match-stats.json` next to the hits
  (ranks, scores, own flags, mode, own-kill times; no names); progress lines in `detect`.
- `services/clip/clipper.py`: new step `gate` (in `run` between `candidates` and `render`) writes `matches.json` and
  moves skipped candidates to `candidates.json` `gatedOut`; `live-review --matches FILE` drops saves in skipped
  matches; progress lines in every stage.
- `services/clip/clip_common.py`: `match_gate_settings(data_dir)` and `progress_line(stage, done, total, note)`.
- `services/studio-ui/user-settings.mjs`: `clips.matchGate` read, check and merge (top3 boolean; minKills null or a
  whole number 1-200; default `{top3: true, minKills: null}`).
- Pack 0.4.0 -> 0.5.0: detector S1, field `stats`, screens `mp_top3` / `mp_scoreboard`, `roiEvery` S1 5
  (`data/games/codm/CHANGELOG.md`).

## 2. S1 top-3 ROIs (verified, 3 frames of one top-3 screen)

Source: 3 private frames of the top-3 screen of the 2026-11-08 practice recording (1280x720 composite; game area by
the project layout: [205.14, 20.79, 1158.87, 651.89]). OCR: RapidOCR through `g1_scan`. Fractions of the game area.

| Item | Read on | Box (x0-x1, y0-y1) | ROI in the pack |
|---|---|---|---|
| Centre card SCORE 4053 (rank 1) | 3/3 | 0.441-0.525, 0.746-0.784 | `rank1_card` 0.38-0.60, 0.73-0.96 |
| MVP badge (centre card) | 3/3 | 0.399-0.428, 0.839-0.870 | in `rank1_card` |
| Centre card name boxes | 3/3 | 0.402-0.590, 0.876-0.910 | in `rank1_card` |
| Left card SCORE 4011 (rank 2) | 3/3 | 0.201-0.283, 0.784-0.823 | `rank2_card` 0.14-0.37, 0.76-0.96 |
| Left card name boxes | 3/3 | 0.163-0.351, 0.915-0.948 | in `rank2_card` |
| Right card SCORE 3064 (rank 3) | 3/3 | 0.682-0.769, 0.783-0.824 | `rank3_card` 0.62-0.85, 0.76-0.96 |
| Right card name boxes | 3/3 | 0.647-0.834, 0.915-0.947 | in `rank3_card` |
| Mode label HARDPOINT | 3/3 | 0.179-0.247, 0.042-0.079 | `mode_label` 0.16-0.30, 0.03-0.11 |

- The rank digits (stylised) are not read by OCR, so the rank comes from the card position. The three scores were in
  rank order on all 3 frames (`orderOk`).
- The own name was on the centre card; OCR read it with a stray quote on 2 of 3 frames and still matched (`nameMin`).
- The other end screens of the match: VICTORY centre screen (1 frame), the post-match MVP screen of another player
  (2 frames), Impact Play (7 frames). None of them carries the own rank.

## 3. Real run (detect, candidates, gate) on the practice recording

Command (private paths shortened; the data dir is an empty scratch folder, so the gate runs on its defaults):

```
python -I services/clip/clipper.py --data-dir <scratch> detect --recording <practice-h-20261108-132438.mkv> \
  --out <scratch>/run1 --profile data/profile.local.json --project <alpha.project.json> --threads 4
python -I services/clip/clipper.py --data-dir <scratch> candidates --recording <...mkv> --out <scratch>/run1 --no-audio
python -I services/clip/clipper.py --data-dir <scratch> gate --recording <...mkv> --out <scratch>/run1
```

Output (stdout):

```
detect: 220 hit(s), 58 with signal, from 472 OCR frames at 1.0 fps in 540.75 s; detectors unverified, weights not approved
candidates: 2 from 220 events (markers 0, chat off, audio off, detectors 220); ranking proposed
gate: 2 match(es) (2 with an end screen), 2 kept; candidates 2 kept, 0 skipped (top3 on, minKills None)
gate: match 1 0-2 s: KEPT (match end seen but top-3 screen not read: clips kept)
gate: match 2 2-475 s: KEPT (in the top 3 (#1))
```

`matches.json` (no names):

| Match | Time | End seen | Result | Mode | Own rank | Own score | Top-3 read | Own kills (source) | Passed |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0-2 s | yes | VICTORY | br (HUD guess) | - | - | no | 0 (killfeed) | kept (not read) |
| 2 | 2-475 s | yes | VICTORY | hardpoint | 1 | 4053 | yes (6 frames, 470-475 s) | 56 (killfeed, first rule) | yes, top 3 |

- Match 1 is the end of an earlier match: the recording starts on its end screen (the earlier full-frame run also hit
  W1/M1 at t = 2 s). It has no clips; it is kept by the "not read" rule. The HUD mode guess "br" for it is wrong and
  harmless (no top-3 reading names the mode there).
- Top-3 reading: 6 of 6 frames with the screen gave own rank 1, own score 4053, mode hardpoint, scores in order.
  This matches section 2.
- Progress lines: 200 lines on stderr in `detect` (476 frames in 540.75 s; a line goes out after the first frame that ends
  2 s or more after the last line, so about every 2.7 s here, as one frame takes about 1.1 s; plus the last one), e.g. `ujwalam-progress {"stage":"detect","done":476,"total":476,"note":"reading the game screen"}`;
  `candidates` 0/1 and 1/1; `gate` 0/2, 1/2, 2/2 with "match 1: kept".

## 4. Own kill count from the kill feed (UNVERIFIED)

The first rule (same kill when the victim keys have ratio >= 0.7 within 6 s) counted **56** kills in match 2. A
private per-frame log of the victim keys (115 frames with own lines, 142 line sightings, 0 unreadable; the log stays
in the scratchpad) showed why: OCR reads one victim as the full name, its last 8 characters, a middle part, or a
4-character tail on consecutive frames, and sometimes reads one line twice in the same frame.

Fixes in `KillCounter`: keys that share a run of at least 4 characters covering 75% of the shorter key are the same
victim; within one frame, a key with ratio >= 0.85 to another key (or inside it) is the same line read twice. Two
different victims at once stay two kills.

Replay of the same key log (no OCR change):

| Rule | hold 6 s | hold 8 s | hold 10 s |
|---|---|---|---|
| first rule | 56 | 56 | 54 |
| new rule | **46** | 46 | 45 |

Hand reference count from the same log (distinct victim windows; a kill-feed line stays about 5 s): **about 45**
(43 sure, 3 unsure: a short word that may not be a name, a victim seen again 7 s later, and one victim on screen for
13 s that may be two kills). The game's own kill count for this match was not captured, so the count stays
UNVERIFIED. This was a practice match; the opponents' names look like bots, which fits a high count with score 4053.

## 5. Proposed minKills (not set)

`minKills` stays `null` (kills rule off). Proposal: **30**, UNVERIFIED. Basis: the only measured match (a practice
match, #1 on the top 3, score 4053) had about 45 own kills; 30 is two thirds of that. One match, against bots, is no
basis for a real value. Re-check on at least 5 real MP matches, including losses and a match outside the top 3,
before the user turns it on.

## 6. Tests

- `python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_*.py"`: all pass (new file
  `tests/py/test_clip_match_gate.py`, 37 tests: top-3 parsing, own card on each position, OCR noise in the name, not
  on the top 3, order check, mode label, scoreboard rule, kill counter, frame_hits kill keys, segmentation, gate
  rules, candidates and saves, settings, progress-line contract, `clipper.py gate` end to end).
- `node --test tests/record-clips.test.mjs tests/user-settings-match-gate.test.mjs`: 12 pass.
- `node tools/game-validate.mjs`: passes with this file present.

## 7. Open (UNVERIFIED)

- Scoreboard: ROI `scoreboard_rows` (0-1, 0.50-0.93), the K / KILLS header rule and the own-row reading are not
  checked on any frame.
- Top 3 on a DEFEAT, on other modes, and when the streamer is not on the top 3.
- Kill-feed count against the game's own number.
- Matches with no top-3 screen (modes without one) keep their clips unless `minKills` is on and the kills are read.
- `montage` is not gated (it has its own won-match rule, D237).
