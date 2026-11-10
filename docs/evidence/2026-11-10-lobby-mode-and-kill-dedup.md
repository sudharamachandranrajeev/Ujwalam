# 2026-11-10 Mode from the summary-screen header, and own kill counting

User, 2026-11-10 (via the coordinator):

1. Read the game mode from the post-match header on the `summary` screen. It shows the mode after 5 of 6 matches of
   the 2026-11-09 practice. Make the smallest screen-model change, and use the header as one more evidence source for
   the match's game mode (approved).
2. Own kill counts looked too high: 44 in the Domination match and 49 in the Control match. Find the cause from
   frames, fix it, and give the true count per match.

Status: everything below is **UNVERIFIED** (one recording). Pack 0.7.0 values carry status unverified.

Names: no player, brand or channel name is in this file. The frames show real names. They stay in scratch folders
outside the repo (OCR output and JPEGs, never committed). Victim names below are replaced by placeholders.

## 1. Source and method

- Recording: the 2026-11-09 practice recording (H canvas, 1920x1080, 3147.5 s).
- Game area of the canvas (alpha project layout): x 307.71, y 31.18, w 1738.3, h 977.84 px. All coordinates below
  are fractions of it, as every pack ROI.
- Detector hits from pack 0.6.0 (the round-vs-match-end re-detect, `docs/evidence/2026-11-10-round-vs-match-end.md`).
- A full-frame OCR sweep every 5 s (630 frames) from the same work, for the header and the summary-screen cards.
- Kill-feed truth:
  - The post-match summary screen shows a KILLS number on each player's card. The own card is the card with the
    profile name. Read from the 5-s sweep, and from frames at 3111-3113.5 s for the Control match.
  - Match 1 also by eye from 1-fps kill-feed crops.
  - The Control match also by eye from 2-s contact sheets of the kill-feed crops (2819-3111 s).
- Kill-count replays: the real `FrameScanner` (ROI bands, roiEvery cadence, diff gate) over three spans (0-397,
  1940-2444, 2819-3112 s). Its boxes are kept per frame, and `frame_hits` plus `KillCounter` are replayed over them
  with the code under test.
- Tools: BtbN ffmpeg 8.1 decode, RapidOCR (project venv), BelowNormal priority, 4 threads, one heavy job at a time.

## 2. The summary-screen header (C2)

The summary screen opens after the top-3 screen. Its header reads `VICTORY | <MODE>` (or DEFEAT), with the map name
under it. The mode name sits at x 0.51-0.64, y 0.02-0.06 (SEARCH & DESTROY at 390 s: [0.510, 0.022, 0.636, 0.055]).
The same screen holds the player cards with KILLS numbers.

Header reads in the 5-s sweep:

| Match | Span (s) | Header read at (s) | Text |
|---|---|---|---|
| 1 | 0-397 | 390, 395 | SEARCH & DESTROY |
| 2 | 397-1145 | 1140, 1145 | SEARCH & DESTROY |
| 3 | 1145-1706 | 1695, 1700, 1705 | SEARCH & DESTROY |
| 4 | 1706-2444 | 2440 | DOMINATION |
| 5 | 2444-2819 | 2815 | TEAM DEATHMATCH |
| 6 | 2819-3112 | none in the sweep | (the screen showed for about 3 s, 3110-3113; CONTROL seen by eye at 3112) |

Every header falls inside its own match's end-screen span (0 s after the last end-screen hit). Mode names elsewhere
(mode-select tiles in the lobby, the top-3 mode label) sit outside the ROI.

Pack change (0.7.0):

- `screens.json` `summary`: cue texts and ROI, `detectors: ["C2"]`.
- `screens.schema.json`: the "no detectors" rule now covers menu, overlay and signal_loss only.
- `tools/game-validate.mjs`: a `summary` screen runs only name-free context detectors (role context, nameRequired
  false). Anything else is an error.
- New detector C2 "Summary-screen mode header": ROI `mode_header` x 0.49-0.66, y 0.01-0.07; cues SEARCH & DESTROY,
  DOMINATION, TEAM DEATHMATCH, CONTROL (seen; CONTROL only in the re-detect) and HARDPOINT (not seen in the header
  yet); `afterEndSec` 30 (margin,
  not measured).
- `match_gate.game_mode()`: header reads from this match's first end-screen hit up to `afterEndSec` after its last
  one are evidence items with source "summary header". They give high confidence like the top-3 mode name.
  Disagreeing evidence still gives no mode, with the reason.

Result with the sweep header rows added to the 0.6.0 hits (`match_gate.segment`):

| Match | Result | Mode | Confidence | Evidence |
|---|---|---|---|---|
| 1 | VICTORY | search and destroy | high | top-3 375 s; summary header 390 s; cues PLANTS/DEFUSES 123 s, DESTROY TARGET 290 s |
| 2 | VICTORY | search and destroy | high | top-3 1120 s; summary header 1140 s; cues 549 s, 835 s |
| 3 | DEFEAT | search and destroy | high (was medium) | summary header 1695 s; cues 1250 s, 1445 s; round subtitle BOMB DEFUSED 1602 s |
| 4 | VICTORY | domination | high | top-3 2425 s; summary header 2440 s |
| 5 | VICTORY | team deathmatch | high | top-3 2795 s; summary header 2815 s |
| 6 | VICTORY | control | high | top-3 3095 s (no header in the sweep) |
| 7 | none | unknown | - | no mode evidence (recording ends in the lobby) |

Full re-detect with pack 0.7.0 (section 4 has the command and timing): 47 C2 rows, 6 signalled, one per match end,
each inside its own match's end-screen span. All six matches get mode confidence high:

| Match | C2 hit (s) | Text | Mode evidence |
|---|---|---|---|
| 1 | 388 | SEARCH & DESTROY | top-3 375; header 388; cues 123, 290 |
| 2 | 1138 | SEARCH & DESTROY | top-3 1120; header 1138; cues 549, 835 |
| 3 | 1694 | SEARCH & DESTROY | header 1694; cues 1250, 1445; subtitle BOMB DEFUSED 1602 |
| 4 | 2437 | DOMINATION | top-3 2425; header 2437 |
| 5 | 2795 (read on the summary screen about 2812-2818) | TEAM DEATHMATCH | top-3 2795; header |
| 6 | 3095 (read on the summary screen about 3110-3112) | CONTROL | top-3 3095; header |

The CONTROL cue is now seen in the header (match 6). The other 41 C2 rows are mode names outside the ROI (lobby
mode-select tiles, top-3 labels at x 0.18-0.28) and are unsignalled.

Hit times of matches 5 and 6: the top-3 screen shows the same mode name (outside the ROI) right before the summary
screen. The hit merge joined both screens into one hit dated to the top-3 frame, with the signal of the summary
frames. Match assignment is not affected (both are inside the end-screen span). Fixed for later runs:
`data/clip/detector-pass.json` `splitBySignal` now holds C2, so signalled header frames are their own hit (test
`test_header_hit_dated_to_the_summary_screen`). Not re-detected again for this.

## 3. Own kill counts: what was wrong

Frame truth (own KILLS on the summary-screen card, unless noted):

| Match | Mode | Truth | Source |
|---|---|---|---|
| 1 | Search and Destroy | 4 | card at 390 s; by eye 19, 224, 315, 351 s |
| 2 | Search and Destroy | 8 | card at 1140 s |
| 3 | Search and Destroy | 3 | card at 1695 s |
| 4 | Domination | 20 | card at 2440 s |
| 5 | Team Deathmatch (ranked) | not read | the cards show RATING, not KILLS |
| 6 | Control | 44 | card at 3112 s (frame at 3111-3113 s; the 5-s sweep missed the screen) |

The 0.6.0 counts were 8, 13, 6, 44, 34 and 49. Five causes, all in the detector pass, found by replaying the real
scanner over the three spans and looking at each counted kill:

1. **Stale band boxes.** The pass OCRs ROI bands; each band has its own cadence (roiEvery). The band of M1, M2 and
   S1 (every 5th frame) also covers the kill feed. Between its reads, its old boxes were kept and merged with the
   current kill-feed band. So the feed of up to 4 s ago sat next to the current one, one row off. Example, 2144 s:
   a line read on row 1 while it was really on row 2. The victim key of a row then changed from frame to frame, and
   every change counted as a new kill.
2. **Merged death lines read as kills.** Band OCR often returns a whole line as one box ("<killer><victim>") and
   sometimes the victim again as a second box. With the own name at the end of that first box, the line was scored
   as "own name on the left", so own deaths counted as own kills.
3. **Victim key from the wrong box.** The key was the right-most box, or the last 8 characters of a one-box line.
   Wrong keys came from:
   - a stray count digit read as the right-most box ('2', '4');
   - a second own-name box from the row below;
   - the own-name tail inside a merged box ('NAMETAIL' + a short victim).
   Each wrong key looked like a new victim. Example: one kill at 352/353 s in match 1 was counted twice.
4. **BR feed read on MP frames.** The frame mode sticks after one mode cue. A BR cue read on an MP loadout screen or
   end card switched the mode to br until the next MP cue. The BR feed (B1) then read name tags and calling cards as
   own kills (match 1 at 28 and 192 s; 2188 s; 2852 s).
5. **Row creep in line grouping.** A box was compared with the last box added to a line, so one line could creep
   down through two or three feed rows. Fixed (compare with the line's first box). It did not change the counts in
   these spans.

## 4. Fixes

- `detector_pass.band_boxes`: a box from a band held only by cadence is dropped when a band read this frame (or
  unchanged by the diff gate) holds it whole.
- `g1_text.killfeed_side`: a first box that holds the whole line with the name at its end is the victim side. A box
  that is a profile name variant on its own is no line.
- `g1_text.victim_text` (new): the victim side of an own line. It is the right-most box that can be a name (at least 3
  characters, not digits only, not the profile name). Otherwise it is the text after the name in a merged box.
  `frame_hits` keys on it.
- `g1_text.group_lines`: rows are compared with the line's first box.
- `KillCounter` records the feed (M5 or B1) of each counted kill. `match-stats.json` `ownKills.feeds` is new.
  `match_gate.segment` counts only the feed of the match's HUD family (M5 in MP, B1 in BR). Older runs without
  `feeds` count every kill, as before.

Replays over the three spans (in-match own kills, end screens excluded):

| Match | 0.6.0 pass (whole match) | Replay, all fixes (in-match play) | Truth |
|---|---|---|---|
| 1 | 8 | 4 (20, 225, 316, 352 s) | 4 |
| 4 Domination | 44 | 23 | 20 |
| 6 Control | 49 | 43 | 44 |

Fix 2 alone took Domination from 45 to 33 in the replay; fix 1 then took it to 24, and fix 4 to 23. In Control,
fix 3 removed 4 kills keyed on count digits or a second own-name box (2916-2919 s: 5 kills for 3 lines). Fix 4
removed 2 BR-feed kills from match 1, 1 from Domination and 1 from Control (the other one was on the summary screen).

### Full re-detect (pack 0.7.0)

The fixes change the detector pass (band boxes, victim keys, feed per kill), so the whole recording was detected
again:

- Command: `python -I services/clip/clipper.py --data-dir <scratch>/data detect --recording <practice mkv>
  --out <scratch>/run --profile data/profile.local.json --project <alpha.project.json> --threads 4`. The scratch
  folder is outside the repo and app data. BelowNormal priority.
- Result: 3133 OCR frames at 1 fps in 3007.8 s (about 50 min); 983 hits, 331 with signal. `match-stats.json` has
  133 own kills (123 M5, 10 B1); the 0.6.0 run had 160.
- CPU: the coordinator measured about 6 cores in use (61 s CPU per 10 s) with `--threads 4`. The onnxruntime pool
  is 4 threads, so the rest is most likely the ffmpeg decode (2 threads) and the main thread. UNVERIFIED.

Own kills per match (`match_gate.segment` on the new hits and stats):

| Match | Mode | 0.6.0 | 0.7.0 | B1 dropped by the family filter | Truth |
|---|---|---|---|---|---|
| 1 | Search and Destroy | 8 | 4 | 2 | 4 |
| 2 | Search and Destroy | 13 | 11 | 1 | 8 |
| 3 | Search and Destroy | 6 | 3 | 1 | 3 |
| 4 | Domination | 44 | 23 | 1 | 20 |
| 5 | Team Deathmatch | 34 | 39 | 0 | not read |
| 6 | Control | 49 | 41 | 1 | 44 |

Matches 1, 3 and 4 match the truth or come close. Match 6 counts 3 fewer than the truth: the replay of the same span
gave 43, so the difference is OCR variance between runs (lines not read on any frame). Match 2 counts 3 more and
match 5 went up: neither was examined frame by frame in this work (UNVERIFIED).

## 5. Tests

- `tests/py/test_lobby_mode_and_kill_dedup.py` (new, synthetic boxes and hit sequences, placeholder names):
  - C2 in the pack and the summary screen; header rows from pack text inside the ROI only.
  - The header alone decides with high confidence; a header that disagrees with C1 cues gives no mode; a header that
    agrees with the top-3 name; repeats are one item.
  - segment: the header belongs to the match that just ended; a late header counts for no match; no header on the
    open tail.
  - Merged death line, merged kill line, no key for a merged death line.
  - group_lines does not creep down the rows.
  - Stale band boxes dropped under a current band (and kept without the flag).
  - victim_text skips count digits and the own name; a two-box read and a merged-box read of one line are one kill;
    a name variant box alone is no line.
  - KillCounter sequences: one line held for 5 s, dense kills, the same victim after the hold, feeds per kill.
  - segment counts only the feed of the match's family; runs without feeds count all.
- `tests/game-validate.test.mjs`: summary screens with a lobby-only detector, M1, C2 with nameRequired true, or C2
  with role positive are errors.

- C2 hits are dated to the summary screen (`splitBySignal`).

Run (2026-11-10, `UJWALAM_HEADLESS=1`, project venv):

- `python -m unittest` on test_clip_detector_pass, test_clip_match_gate, test_clip_montage, test_clip_settings,
  test_g1_coverage, test_g1_detector_pass, test_g1_ocr, test_g1, test_game_pack, test_lobby_mode_and_kill_dedup,
  test_match_gate_scenarios, test_match_reel_rules, test_round_vs_match_end: `Ran 243 tests ... OK`.
- `node --test tests/game-validate.test.mjs tests/g0-schemas.test.mjs`: 45 tests, 43 pass, 0 fail, 2 skipped.
- `node tools/game-validate.mjs`: `OK: 1 game pack(s) valid: codm 0.7.0`.

## 6. Unverified and open

- One recording. C2 ROI, cues and `afterEndSec` are status unverified. HARDPOINT was not seen in the header. The
  Control summary screen showed for about 3 s only.
- Match 2 (11 for 8) and match 5 (39, up from 34, no truth) were not examined frame by frame.
- Domination still counts 23 against 20. Two of the extra kills come from a weapon name shown in the kill feed
  (a named weapon skin) read as the victim on one frame and the real victim on the next. Not fixed: weapon names are
  not in the pack.
- Team Deathmatch (ranked) has no frame truth: its summary cards show RATING, not KILLS.
- A clan tag shown before the own name would put the name at the end of a merged box ("tail = victim"). The own name
  shows without a tag in this recording.
- The family filter needs the match's HUD mode (mp or br) from the hit rows. A match with no HUD rows counts every
  feed.
