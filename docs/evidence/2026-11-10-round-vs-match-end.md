# 2026-11-10 Round end vs match end, and the game mode of each match

User, 2026-11-10 (via the coordinator): W1 VICTORY/DEFEAT banners after every round of a round-based mode were
treated as match ends, so the 2026-11-09 practice recording split into 14 "matches" where there are about 7. Only a
match-end banner may close a match; round banners become round markers. Added requirement: "Ujwalam needs to identify
the match type itself": a mode per match from on-screen evidence, with a confidence and the evidence list, or
"unknown" with the reason. Never a guess.

Status: everything below is **UNVERIFIED** (one recording, 6 matches). The pack values carry status unverified.

Names: no player, brand or channel name is in this file. The frames show real names; they stay in a scratch folder
outside the repo (OCR output and JPEGs, never committed).

## 1. Source and method

- Recording: the 2026-11-09 practice recording (H canvas, 1920x1080, 3147.5 s), and its existing clip run (detector
  hits from pack 0.5.0, 23 signalled W1 hits).
- Frames: BtbN ffmpeg 8.1 decode, RapidOCR (the project venv), full frame, at BelowNormal priority with 4 threads:
  - every signalled W1 hit at t, t+3 s and t+7 s;
  - a sweep of the whole recording every 5 s (630 frames).
- Coordinates: fractions of the game area of the canvas (the alpha project layout: x 307.71, y 31.18, w 1738.3,
  h 977.84 px), as every pack ROI.

## 2. Round banner vs match banner

Two banner types show the same word:

| | Round-end banner | Match-end banner |
|---|---|---|
| Look | thin VICTORY/DEFEAT bar, team names, round score, three player cards | large emblem, final score, no round row |
| Word centre y | 0.342-0.344 | 0.423-0.425 |
| Word height | 0.061-0.065 (0.071 and 0.099 on the first, still animating frame at 896 s and 985 s) | 0.098-0.129 |
| Subtitle under the bar (x 0.449-0.550, y 0.420-0.445) | always (17/17; at 896 s and 985 s from the second frame) | never |
| Next screen | next round (the nearest post-match screen 62 s later) | IMPACT PLAY / FINAL KILLCAM / MVP / top 3 within 2-5 s |

Chosen signal: the word's vertical position (`W1.banner.kinds`: round y 0.31-0.38, match y 0.39-0.47). It is one
number already measured by the W1 box, and it separates all 23 hits. Fallback for hits without a kind (runs detected
before pack 0.6.0): a post-match screen (K1, M2, M1, S1 not marked outside its ROI) starting within `followSec` 30 s
of the banner end means a match end; none means a round end; a banner closer than 30 s to the recording end stays a
match end ("too soon to tell"). The fallback also separates all 23.

Subtitles seen (`W1.banner.subtitles`):

| Subtitle | Banners (s) | Mode hint |
|---|---|---|
| ENEMIES ELIMINATED | 23, 115, 187, 190, 282, 542, 829, 896, 985 | none |
| SQUAD ELIMINATED | 703, 754, 1360, 1405, 1451 | none |
| BOMB DEFUSED | 1602 | Search and Destroy |
| SCORE LIMIT REACHED | 2184 | none (half time) |
| All Zones Captured | 2952 | none |

SWITCHING SIDES replaces the word 3 s after the banners at 282, 829, 1602, 2184 and 2952 s.

## 3. Per-hit classification (23 signalled W1 hits)

| Hit (s) | Word | User | Word centre y | Subtitle | Classified | Follow-on check |
|---|---|---|---|---|---|---|
| 23 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round | round |
| 115 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round | round |
| 187 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round (same banner as 190) | round |
| 190 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round (same banner as 187) | round |
| 282 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round | round |
| 354 | VICTORY | match | 0.424 | none | match | match |
| 542 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round | round |
| 703 | DEFEAT | round | 0.343 | SQUAD ELIMINATED | round | round |
| 754 | DEFEAT | round | 0.343 | SQUAD ELIMINATED | round | round |
| 829 | VICTORY | round | 0.343 | ENEMIES ELIMINATED | round | round |
| 896 | VICTORY | round | 0.342 | ENEMIES ELIMINATED | round | round |
| 985 | VICTORY | ambiguous | 0.342 | ENEMIES ELIMINATED (t+3) | **round** | round |
| 1091 | VICTORY | match | 0.424 | none | match | match |
| 1360 | DEFEAT | round | 0.343 | SQUAD ELIMINATED | round | round |
| 1405 | DEFEAT | round | 0.343 | SQUAD ELIMINATED | round | round |
| 1451 | DEFEAT | round | 0.343 | SQUAD ELIMINATED | round | round |
| 1602 | DEFEAT | round | 0.343 | BOMB DEFUSED | round | round |
| 1659 | DEFEAT | match | 0.424 | none | match | match |
| 2184 | DEFEAT | ambiguous | 0.343 | SCORE LIMIT REACHED | **round (half time)** | round |
| 2395 | VICTORY | match | 0.425 | none | match | match |
| 2769 | VICTORY | match | 0.423 | none | match | match |
| 2952 | VICTORY | round | 0.344 | All Zones Captured | round | round |
| 3062 | VICTORY | match | 0.424 | none | match | match |

The two ambiguous hits, checked from frames at ±20 s:

- **985 s is a round end.** Round geometry, the round score row "3 VS 2", "Scorestreaks Refreshing", ENEMIES
  ELIMINATED from t+3 s. The match ends at 1091 s.
- **2184 s is a half-time round end, not a match end.** This differs from the instruction to treat SCORE LIMIT
  REACHED as a match end. Round geometry; SWITCHING SIDES at 2187 s; the HUD at 2191 s shows zones A/B/C and "FIRST HALF
  OF MATCH" then "SECOND HALF OF MATCH 04:59" from 2195 s; no post-match screen follows. The match ends at 2395 s on a
  match-end banner (150 vs 130), top 3 at 2425 s. A score limit that ends a match shows the match-end banner, so the
  rule "only match-end banners close a match" covers both cases without a subtitle rule. The pack note on SCORE LIMIT
  REACHED records this; no time-limit subtitle was seen in this recording.

## 4. Matches: old vs new

Old (pack 0.5.0, every banner an end): 14 segments. New: 7 segments, 6 with an end seen. Produced from the existing
`detector-hits.jsonl` without a re-detect (follow-on fallback).

| New | Span (s) | Result | Round banners (s) | Old segments merged |
|---|---|---|---|---|
| 1 | 0-397 | VICTORY | 23, 115, 187+190, 282 | 1, 2, 3 |
| 2 | 397-1145 | VICTORY | 542, 703, 754, 829, 896, 985 | 4, 5, 6 |
| 3 | 1145-1706 | DEFEAT | 1360, 1405, 1451, 1602 | 7, 8 |
| 4 | 1706-2444 | VICTORY | 2184 (half time) | 9, 10 |
| 5 | 2444-2819 | VICTORY | none | 11 |
| 6 | 2819-3112 | VICTORY | 2952 | 12, 13 |
| 7 | 3112-3148 | no end seen (recording ends) | none | 14 |

Rounds: each match lists `rounds` [{t, tEnd, result, source, subtitle}] and `roundKills` (own kill-feed kills per
round, the last round ending at the match end). Match 1: roundKills [1, 1, 0, 3, 3]; match 3: [0, 0, 0, 2, 4]. A banner
split into two hits by an OCR gap (187 s and 190 s) is one round (`sameBannerSec` 10; rounds are at least 45 s apart).

## 5. Why top 3 and mode were read in only 4 segments

1. Segmentation: 14 segments for 6 matches, so 8 segments had no post-match screen at all.
2. The top-3 screen writes "SEARCH & DESTROY"; modeNames had "SEARCH AND DESTROY" (ratio below 0.9), so both Search
   and Destroy top-3 screens (375 s, 1120 s) read no mode.
3. Ranked Team Deathmatch top-3 cards read "RATING n", not "SCORE n" (2795-2810 s), so no top-3 reading at all.
4. CONTROL was not in modeNames (top 3 at 3095-3105 s).
5. A DEFEAT in Search and Destroy (match 3) shows no top-3 screen: IMPACT PLAY, then the XP screen and the lobby.

Fixes (pack 0.6.0): modeNames entries `{text, mode}` (SEARCH & DESTROY, CONTROL; KILL CONFIRMED and FRONTLINE seen
only as mode-select tiles); `scoreRegex` takes SCORE or RATING; the mode-cue detector C1 for matches without a top-3
screen.

## 6. Game mode per match

Evidence sources (`match_gate.game_mode`), each allowing a set of modes:

- top-3 mode name (S1 `mode_label`);
- C1 mode cues inside their ROIs: "DESTROY TARGET (A) OR (B)" at round start (x 0.431-0.567, y 0.267-0.304) and the
  mid-match scoreboard headers PLANTS / DEFUSES (y 0.284-0.314), all Search and Destroy;
- round subtitles that name a mode (BOMB DEFUSED).

The match mode is the one mode every item allows. Confidence: high with a top-3 mode name, medium with 2 or more other
items, low with 1. Disagreement or no evidence gives no mode ("unknown") with the reason.

Result on 2026-11-09 (the 1-fps re-detect in §8 gives the same modes; this table shows every frame that decided or
supports each):

| Match | Mode | Confidence | Deciding evidence (s) | Also seen, not used by the pipeline (s) |
|---|---|---|---|---|
| 1 | Search and Destroy | high | top-3 name 375, 380; DESTROY TARGET 290 | lobby header 390, 395; "5 POINTS TO WIN", ROUND HUD |
| 2 | Search and Destroy | high | top-3 name 1120-1130; DESTROY TARGET 835 | loading "MISSION: SEARCH & DESTROY" 440; lobby header 1140 |
| 3 | Search and Destroy | medium | DESTROY TARGET 1250; PLANTS, DEFUSES 1445, 1475; BOMB DEFUSED 1602 (new detections only) | no top-3 screen (DEFEAT); lobby header 1695-1705 |
| 4 | Domination | high | top-3 name 2425, 2430 | loading screen 1935-1945; "FIRST HALF OF MATCH", "75 POINTS TO WIN"; lobby header 2440 |
| 5 | Team Deathmatch | high | top-3 name 2795-2810 (RATING cards) | "40 POINTS TO WIN"; lobby header 2815 |
| 6 | Control | high | top-3 name 3095-3105 | "CLASSIC - CONTROL" queue label 2825-2840; All Zones Captured 2952; "2 POINTS TO WIN" |
| 7 | unknown | none | "no mode evidence": the recording ends in the lobby | |

Not used, on purpose:

- Mode-select menu tiles and titles list several modes (1710-1840 s, 2445 s, 2560 s); no ROI covers them.
- The post-match lobby header (mode name x 0.508-0.636, y 0.020-0.057, after 5 of 6 match ends) is on the `summary`
  screen, where `screens.json` runs no detector. Reading it needs a screen-model change (user decision).
- "N POINTS TO WIN" (5, 75, 40, 2) depends on mode and ranked/classic; one sample per value, so no rule.

## 7. Runs and tests

- Re-segmentation of the existing run with the new code (no re-detect): the 7 segments in §4; modes: match 4
  Domination only (the old readings hold no SnD/Control/TDM name and no C1 rows).
- The current pack applied to the 5-s sweep OCR (S1 top-3 readings and C1 rows added to the existing hits): the modes
  in §6. C1 rows: 9 signalled (DESTROY TARGET 290, 835, 1250; PLANTS/DEFUSES 1445, 1475), 3 outside the ROIs (695,
  1600, 1605 s, not counted).
- Re-detect of the full recording into a scratch folder at BelowNormal (48 min): see §8.
- Tests (targeted, `UJWALAM_HEADLESS=1`):
  - `tests/py/test_round_vs_match_end.py` (new, 21): banner kind and subtitle, detector-pass rows, merge, SnD rounds
    with geometry and with the fallback, duplicate banner, roundKills, the snd-round-multikill rule, SCORE LIMIT
    half time vs a score-limit match end, a zone mode, the 23 real hit times (6 matches, 17 round hits), a banner at
    the recording end, no banner config, C1 cue rows, game_mode agree/disagree/none, RATING cards, CONTROL and the
    SEARCH & DESTROY alias. OK.
  - `test_clip_match_gate` 37, `test_match_gate_scenarios` 11, `test_match_reel_rules` 22, `test_clip_montage` 20,
    `test_game_pack` 10, `test_clip_detector_pass` 37 (1 skipped), `test_g1*` 60 (project venv): OK.
  - `node --test tests/game-validate.test.mjs tests/g0-schemas.test.mjs`: 42 pass, 2 skipped. `node
    tools/game-validate.mjs`: OK, codm 0.6.0.
- Not run: the full `npm run ci` (the coordinator runs it).

## 8. Re-detect

Command: `clipper.py detect` with pack 0.6.0, the user's profile and the alpha project layout, 1 fps, out to a
scratch folder outside the repo and app data (the user's run folder is not touched), BelowNormal priority.
3133 OCR frames in 2864 s; 916 hits, 317 with signal.

- W1: 23 signalled hits at the same times as before. Banner kind from geometry on all 23 (17 round, 6 match), no
  fallback needed, matching §3. Subtitle read on 17 of 17 round banners, as in §2.
- C1: 27 rows, 25 signalled (PLANTS/DEFUSES at 123, 194, 288, 549, 711, 763, 904, 992, 1445, 1458, 1475 s; DESTROY
  TARGET at 290, 835, 1250 s), all inside the three Search and Destroy matches; 2 outside the ROIs (695, 1600 s).
  None in the Domination, TDM or Control matches.
- Segmentation and modes (`match_gate.segment` on the new hits):

| Match | Span (s) | Result | Mode | Confidence | Evidence items | Rank | Rounds | roundKills | Reel |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0-397 | VICTORY | Search and Destroy | high | top 3 375; PLANTS, DEFUSES 123; DESTROY TARGET 290 | 2 | 4 | [1, 1, 0, 3, 3] | yes |
| 2 | 397-1145 | VICTORY | Search and Destroy | high | top 3 1120; DEFUSES, PLANTS 549; DESTROY TARGET 835 | 2 | 6 | [4, 4, 1, 1, 1, 1, 1] | yes |
| 3 | 1145-1706 | DEFEAT | Search and Destroy | medium | DESTROY TARGET 1250; PLANTS, DEFUSES 1445; BOMB DEFUSED 1602 | none (no top 3 on defeat) | 4 | [0, 0, 0, 2, 4] | yes (snd-round-multikill) |
| 4 | 1706-2444 | VICTORY | Domination | high | top 3 2425 | 3 | 1 (half time) | [16, 28] | yes |
| 5 | 2444-2819 | VICTORY | Team Deathmatch | high | top 3 2795 (RATING cards) | 1 | 0 | none | yes |
| 6 | 2819-3112 | VICTORY | Control | high | top 3 3095 | 1 | 1 | [27, 22] | yes |
| 7 | 3112-3148 | no end seen | unknown | none | "no mode evidence" (recording ends in the lobby) | none | 0 | none | no |

Before (pack 0.5.0 hits re-segmented with the new code): match 3 had no mode and no reel; match 5 had no top 3 and
no mode. Own kills of match 5: 34 (was 32; the re-detect read the RATING top 3 and the same kill feed at 1 fps).

## 9. Unverified and open

- All banner, subtitle, cue and follow-on values: one recording, 6 matches, 4 modes. Hardpoint, Kill Confirmed,
  Frontline and Free for All matches are not seen; their banners may differ.
- A DEFEAT match end with a large banner is seen once (1659 s).
- The 44 and 49 own kills of matches 4 and 6 look high for one player (kill-feed deduplication; separate issue).
- C1 at `roiEvery` 1: setting it to 5 merged its band with the M3 band and delayed the M3 hit end in
  `test_g1_detector_pass`, so C1 is read on every sampled frame.
- The ranked TDM top 3 shows RATING, so `ownScore` holds a rating there.
