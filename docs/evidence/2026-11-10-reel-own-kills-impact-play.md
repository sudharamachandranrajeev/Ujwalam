# 2026-11-10 Match reels cut only own kills; spectate detector N3; impact-play reels (D326)

User feedback, 2026-11-10 (`docs/feedback/2026-11-10-triage.md`):

- F1 (high): a published match reel showed the loadout swap, the round intro and another player's gameplay after the
  streamer's death. Reels must show only the streamer's own kills.
- F4 (wish): "if there was an impact play by the streamer, create it as a separate reel with MVP animation, Impact
  play cam and up to the results page".

Status: everything below is **UNVERIFIED** (one recording, 2026-11-09 practice). N3 and the impact-play timing values
carry status unverified.

Names: no player, brand or channel name is in this file. Frames show real names; they stay in scratch folders under
`%TEMP%` (never committed).

## 1. Source and method

- Recording: the 2026-11-09 practice recording (H canvas 1920x1080, 3147.5 s; V canvas for the reels).
- Detector pass re-run with pack 0.8.0 (`clipper.py detect`, 1 fps, 4 threads, BelowNormal): 3133 OCR frames,
  993 hits, 331 with signal, 3792 s elapsed (another detector job ran at the same time).
- Single frames and contact sheets with ffmpeg (BelowNormal), read by eye.
- Kill-count truth: the KILLS number on the own card of the post-match summary screen
  (`docs/evidence/2026-11-10-lobby-mode-and-kill-dedup.md`): 4, 8, 3, 20, unknown, 44.
- Match numbering below is by start time. The reel the user flagged ("match 2" in the brief) is match 3 here
  (start 1145 s, end screen 1659 s, Search and Destroy, defeat).

## 2. Root cause of F1 (from frames)

`clip_montage.match_reels` built its pieces from every signalled M5/B1 kill-feed hit. `match_gate.segment` already
counted only the kill-feed family of the match (M5 in MP), so the counts were right but the pieces were not.

Match 3, B1 (BR feed) hits at 1242, 1411, 1456, 1485-1501 and 1607 s: every one is the MP "SELECT LOADOUT" /
"Change Loadout" panel. The BR-feed ROI reads the profile name inside the custom weapon name on that panel. The panel
shows before each round (round intro, weapon swap) and while the streamer is dead and spectating; at 1486 and 1491 s
the spectated teammate's name bar is on screen. Each such hit became a reel piece. The real own kills of match 3 are at
1638, 1653 and 1655 s (truth 3).

## 3. Fixes

- `segment()` records the counted kill times of each match (`ownKillTimes`) and of each round (`roundKillTimes`).
  `match_reels` cuts pieces only around those (older runs without them fall back to the hits).
- A medal adds a piece only when no counted kill lies in the `medalMatchSec` window before it.
- A rule may set `pieces: qualifying-rounds`; `snd-round-multikill` does. A Search and Destroy reel that qualifies only
  by a round multi-kill shows only the own kills of the qualifying rounds.
- A reel whose kills all fall inside death or spectate spans is not made ("no own kill outside a death or spectating
  span").
- New detector N3 (pack 0.8.0, status unverified): MP banner YOU WILL RESPAWN NEXT ROUND, ROI `respawn_banner`
  x 0.36-0.64, y 0.64-0.72 of the game area, fuzzy partial match 0.85. It is a spectate detector (S1
  `spectateDetectors`: own-kill lines read in its spans never count) and a death detector (`ranking.json`
  `death.detectors` N1, N3: reel pieces end before it).

## 4. N3 evidence (2026-11-10 re-detect)

Frames read by eye with the banner on screen: 1442, 1450, 1540, 1590 s (match 3). Detector hits (9, all mode mp,
OCR score 0.9999):

| Match | N3 spans (s) |
|---|---|
| 1 | 55-114, 157-186, 230-281 |
| 2 | 747-753, 975-984 |
| 3 | 1440-1450, 1482-1484, 1502-1575, 1579-1598 |
| 4-6 | none (respawn modes) |

No own kill fell inside an N3 span in this recording (`spectateDropped` 0 for every match): the spectate-phase reads
were B1 loadout-panel hits, already outside the MP family. N3's job here is to cut the reel pieces.

## 5. Own kill counts (pack 0.8.0 re-detect)

| Match | Mode, result | Counted | Truth | Note |
|---|---|---|---|---|
| 1 | S&D, victory | 4 | 4 | kills 20, 225, 316, 352 s |
| 2 | S&D, victory | 11 | 8 | three duplicates: one line counted twice at 472/473, 581/585, 1033/1034 s |
| 3 | S&D, defeat | 3 | 3 | 1638, 1653, 1655 s |
| 4 | Domination, victory | 23 | 20 | |
| 5 | TDM, victory | 39 | unknown | |
| 6 | Control, victory | 41 | 44 | |

Match 2's over-count is not spectating: the victim names are in a non-Latin script and OCR reads one line as two
unrelated keys on consecutive frames.

Replay (not adopted): a cap on new kills per frame by the rise in own lines on screen, with lines younger than
5 s holding their slot. Replayed over the logged per-frame keys of this run: matches 1-6 gave 5, 8, 3, 20, 29, 34
over whole match spans (without the cap: 5, 11, 3, 23, 40, 41). It fixes matches 2 and 4 but drops the Control match
from 41 to 34 (truth 44): in dense fights the feed pushes lines out in under 5 s. Lives 3, 4 and 6 s did no better.
Kept out of the code; dedup stays an open item.

## 6. Impact-play reels (F4)

`match-reels.json` `impactPlay` (flag `impact-play-reels`, off by default): the first signalled M2 (IMPACT PLAY) hit
after the match's end screens starts the reel `startAfterBannerSec` (1.0 s) after the result banner when the banner
ends within `maxBannerLeadSec` (10 s) before it, else `fallbackLeadSec` (5 s) before it. The reel ends `endHoldSec`
(0.5 s) after the last signalled C2 results-page read within `resultsAfterSec` (30 s), capped at `maxSec` 90 s,
at least `minSec` 10 s. All agent values, proposed, unverified.

M2 hits in this run: 1100, 1665, 2402 s (signal false: another player's impact play, no own name) and 2776, 3070 s
(signal true, own). So matches 5 and 6 get an impact-play reel.

## 7. Re-rendered reels (not published)

`clipper.py montage` with the V recording, the flag `impact-play-reels` on in a scratch data dir, no `--publish`.
Output in a scratch folder under `%TEMP%` (not the clips folder). 19/19 videos PASS validation (6 match reels,
2 impact-play reels, 11 streak montages).

Each match reel ends with a 4.5-5.5 s piece on the result banner (0 kills). "Kills" counts the own kills a piece is
built around; a medal adds one when no counted kill lies just before it.

| Reel | Match | Rules | Kills | Pieces (s) |
|---|---|---|---|---|
| W01 | 1 S&D | won-top3, snd-won, snd-round-multikill | 4 | 17-21.5, 222-226.5, 313-317.5, 349-358 |
| W02 | 2 S&D | won-top3, snd-won, snd-round-multikill | 11 | 469-474.5, 536-540.5, 578-586.5, 591-595.5, 777-781.5, 872-876.5, 937-941.5, 1030-1035.5, banner 1090.5-1096 |
| W03 | 3 S&D | snd-round-multikill (round 5 only) | 3 | 1635-1639.5, 1650-1656.5, banner 1658.5-1663 |
| W04 | 4 Domination | won-top3, objective-kills | 21 | 14 kill pieces 1985-2387.5, banner 2394.5-2399 |
| W05 | 5 TDM | won-top3, tdm-kills | 41 | 7 kill pieces 2588-2767.5, banner 2768.5-2773 |
| W06 | 6 Control | won-top3, objective-kills | 45 | 6 kill pieces 2866-3057.5, banner 3061.5-3068 |
| I01 | 5 TDM | impact play | 0 | 2771-2818.5 (47.5 s) |
| I02 | 6 Control | impact play | 0 | 3066-3112.5 (46.5 s) |

Checks:

- No piece overlaps an N1 (killcam) or N3 (spectate) span.
- The flagged reel (W03, was "match 2" in the feedback) now holds only round 5: frames 1635, 1637.5, 1639.5, 1650,
  1653 and 1656 s are the streamer's own first-person play with own kill-feed lines. No loadout panel, no round intro,
  no spectating. At 1656 s an enemy's kill line on the streamer is already in the feed: the last piece ends about
  0.5 s into the streamer's death (before the killcam).
- B1 hits still overlap many pieces. They are own kill-feed lines also read by the BR ROI; pieces no longer anchor on
  them.
- I01: 2771.5 s is the tail of the VICTORY banner, 2785 s the impact-play camera with the IMPACT PLAY badge,
  2817.5 s the results page (VICTORY | TEAM DEATHMATCH). The reel starts about 1-2 s early, still on the banner.

## 8. Tests

`$env:UJWALAM_HEADLESS='1'; .venv\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_*.py"`:
479 tests, OK (6 skipped); 463 before this work. New file `tests/py/test_reel_own_kills_impact_play.py` (16 tests).

## 9. Open

- N3, the impact-play timings and the rule `pieces` value are unverified on more than one recording.
- Posting does not upload `impact-play` reels yet (`services/posting/index.mjs` `UPLOAD_KINDS`).
- Own-kill dedup for non-Latin victim names (match 2, +3) and the Domination over-count (+3).
- Impact-play start lands 1-2 s before the banner ends; a later start (or a banner-end detector) is a tuning item.
- A kill piece may end up to 1.5 s into a death that the killcam (N1) has not yet marked (W03, 1656 s).
