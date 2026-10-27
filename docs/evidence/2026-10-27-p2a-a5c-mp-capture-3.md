# P2a A5c — live capture 3: MP inventory (2 matches) + BR non-win match

Date: 2026-10-27. Scope: G1 inventory of two local live captures. Aggregates only: no player
names, no IGN, no frames. Private crops, stills, scans and per-event lists are in
`docs/evidence/private/g1-live-3/` (gitignored). Times are mm:ss on the joined timeline
(segment *i* starts at the sum of the earlier segments' video durations); see "Timing bug"
for the ±1 s caveat.

## Captures

| Capture | Segments | Total | Notes |
|---|---|---|---|
| MP `captures/mp2/mp2-000..016.mp4` | 17 | 1015.9 s | seg 0 = 62.0 s, seg 1–15 = 60.0 s, seg 16 = 53.9 s; 60 fps CFR |
| BR `captures/br2/br2-000..006.mp4` | 7 | 373.45 s | seg 0 = 62.0 s, seg 1–5 = 60.0 s, seg 6 = 11.45 s |

Read-only; not moved or committed. Game area in the 1920x1080 frame: x 176, y 0, w 1566, h 1080
(same as live 2, layout copied to a private `layout-live3.json`). Pack: `detectors.json` v0.2.1, unchanged.

## Commands

```
# per capture, one process at a time (.venv, RapidOCR on onnxruntime CPU)
python services/clip/g1_scan.py --threads 4 scan  --corpus <capture dir> --index <private index> --layout <private layout> --fps 1 --out <private>/scan --name <mp|br>-1fps
python services/clip/g1_scan.py --threads 4 analyse --scan <private>/scan/<mp|br>-1fps.jsonl --pack data/games/codm/detectors.json --profile data/profile.local.json --out <private>/analyse-<mp|br>
python services/clip/g1_scan.py --threads 4 crops --hits <private>/analyse-<mp|br>/hits-tfix.jsonl --corpus <capture dir> --layout <private layout> --pack data/games/codm/detectors.json --dets <list> --per-detector 6 --out <private>/crops-<mp|br>
python services/clip/g1_scan.py --threads 4 refmedals --hits <private>/analyse-mp/hits-tfix.jsonl --corpus <mp2 dir> --layout <private layout> --pack data/games/codm/detectors.json
```

Scan rows: MP 1032 (incl. one boundary duplicate per segment), BR 380 (350 OCR'd, rest diff-gated).
Aggregation, kill-feed dedupe and review grids: throwaway scripts in the session scratchpad.

## Resource use (user instruction 2026-10-27)

- Started with two scans in parallel, each onnxruntime on all 16 threads: CPU at 100 %.
  Both stopped (no truncated JSONL rows), then resumed one process at a time.
- New global `--threads N` (default 4): onnxruntime `intra_op_num_threads = N`,
  `inter_op_num_threads = 1`. ffmpeg decode `-threads 2`. The scan process lowers itself to
  BelowNormal; ffmpeg children start with `BELOW_NORMAL_PRIORITY_CLASS` (Windows) / `nice 10` elsewhere.
- Measured median OCR per full frame: 2934 ms with 2 × 16 threads in parallel;
  1392 ms (MP) and 1928 ms (BR) with 1 × 4 threads. The cap is faster per frame and leaves cores free.
- Crops: ~33 s for the MP sample (BR similar, not timed); refmedals not timed. One process at a
  time throughout. No GPU used.

## Timing bug found and fixed (blocked crops)

`decode_frames` picks the first frame of each 1/fps bucket with `floor(t*fps)`. In 13 of the 24
segments (MP 002–005, 010–015; BR 003–005) ffmpeg decodes the first frame at t = −0.0000002 s
(start-time rounding). That frame formed its own bucket −1, so every later scan frame was labelled
1 s late. Effect: crops and refmedals seeked 1 s late; short events (MP killcams last ~0.7 s)
were missing from 6/6 N1 crops. Fix: clamp t at 0 in a new `bucket_select(fps)`
(`floor(max(t,0)*fps)`). Test: `BucketSelectTests` (lavfi source shifted 1 tick negative:
old expression yields 4 frames for 3 s, new yields 3). Existing hits were corrected
(t − 1 s in the affected segments, private `hits-tfix.jsonl`) instead of rescanning; after the
correction 6/6 N1 crops show KILLCAM. Event counts below are unaffected; times quoted from
the scan in those segments may be up to 1 s late. Live-2 scans may carry the same offset — UNVERIFIED.

## MP — matches

| Match | Mode / map | Play | Result | End screens (time, name) |
|---|---|---|---|---|
| m0 (tail) | Hardpoint (earlier match) | before 00:00 | VICTORY 150–70 | Impact Play 00:01–00:07, IGN (positive); top-3 with MVP badge on the user 00:09–00:13; MVP post-match screen before capture start (UNVERIFIED) |
| m1 | Domination, Shipment | 01:30–05:57 | VICTORY 100–15 (05:56) | MVP 05:59–06:02, IGN (positive); Impact Play 06:03–06:14, IGN (positive); top-3 MVP badge on the user (score 5217) |
| m2 | Domination (ranked), Shoot House | 09:30–16:17 | DEFEAT 92–150 (16:15) | MVP 16:21–16:24, other player (no signal); Impact Play 16:25–16:34, same other player (no signal); top-3 MVP badge on that player |

Two full matches plus the tail of a third. Each match had an ad (~4 s) between the end screens
and the top-3 screen, then XP, a summary screen and the lobby.

### End-screen rule — contradiction

User rule: exactly one of MVP / Impact Play / FINAL KILLCAM appears at match end.
Observed: **both MVP and Impact Play appeared in m1 and in m2** (and Impact Play + MVP badge in
m0's tail). FINAL KILLCAM appeared nowhere (K1: 0 hits). The rule does not hold for Domination
in this capture. In m1 both screens named the user; in m2 both named the same other player, so
the decision (positive vs no signal) was consistent between the two screens. Needs the user's
view before G1 encodes "exactly one".

### Per match

| | m1 (VICTORY) | m2 (DEFEAT) |
|---|---|---|
| Kills (user as killer) | feed dedupe 18 events (over-split); scoreboard K=11 at 03:36 vs ~8–9 feed events by then (recall ~0.75–0.8 at 1 fps); total ~28–32 estimated from cards/medals — UNVERIFIED, no final scoreboard | 10 player kills + 1 K9 unit, adjudicated by eye; matches scoreboard K=4 (12:49), 5 (14:20), 8 (14:43). Auto dedupe gave 15–17 (over-split) |
| Deaths / killcams | 3 (killcams 02:00, 03:32, 04:56); feed agrees | ~22 (21 N1 killcam events + 1 one-frame killcam at ~11:18 missed by N1); feed-victim dedupe 24 (over-split) |
| Positive medals | 15 events: Double 5, Triple 3, Fury 2, Merciless 2, Super 1, Mega 1, Ultra 1 | 2: Double 1, Triple 1 |
| Reference medals | 38 events: UAV Assist 10, Keep it Fresh 9, Berserker 3, Bloodthirsty 3, Kingslayer 3, Minor Assist 3, Revenge 2, Saboteur 2, Headshot 1, Major Assist 1, Survivor 1 | 27: Revenge 7, Keep it Fresh 4, Kingslayer 4, Minor Assist 4, UAV Assist 4, Headshot 2, Berserker 1, Major Assist 1 |
| +N popups (text stack) | 81 boxes, 72 events | 44 boxes, 38 events |
| X1 multi-kill / streak cards with the user's name | ~10: On a 5 ×3, On a 10 ×2, 4X ×2, 5X, 6X, 7X | 0 |

- Mega Kill, Super Kill and Ultra Kill are now seen (pack lists them as listed_not_seen).
- Unlisted stack texts seen: Annihilator Kill, Kill Attacker, Kill Chain, Savior, Avenger,
  Partial Capture, Counter-UAV Assist, Clean Up, Normal Kill.
- Other players' X1 cards (e.g. On a 15 / On a 20) were correctly excluded by the name rule.

## BR — non-win match (br2)

| Item | Result |
|---|---|
| Mode / map | Battle Royale, Isolated, ranked, duo (lobby also lists a Resurgence playlist) |
| Timeline | lobby 00:00–00:13; warm-up; plane and drop ~02:00–02:55; landing and loot |
| User knocks / kills | 1 knock (B2 "KNOCKED DOWN" popup ~03:44) then 1 kill (B2 "ELIMINATED / 1 KILL(S)" 03:45–03:46); HUD skull 0→1; end card KILLS 1. Feed line with the IGN as killer visible 03:43–03:48 |
| B1 killer side | the real kill line has the IGN on the killer side (seen by eye). B1 hits with the IGN at 05:47–05:49 are misfires (Like toast "IGN \| MVP") |
| Downed / death | downed ~04:54 (N2 HELP ME 04:55, "… DOWNED YOU" banner, feed line with the IGN on the victim side); KILL CAM 05:00–05:04; then spectating the partner ("Awaiting dog tag pickup") |
| Revival | none. No "Waiting for Revival Flight"; the partner did not recover the dog tag before the end |
| B2 at 05:14–05:15 | top banner (calling card + ELIMINATED) while spectating: another player's elimination, no IGN → no signal (correct) |
| Placement | GAME OVER **#48/50** ~05:37, squad cards #48/50 05:43–05:50 — non-win, as intended |
| Multi-kill banners | none (X1: 0 hits) |
| End | user card with MVP badge (squad of 2, KILLS 1 vs 0); ranked XP +4145 at 05:51; summary 05:55–05:58 |

Scan modes: br 274 frames, mp 26, none 50. The BR KILL CAM frames classify as **mp**
(the KILLCAM cue is in the MP list).

## OCR accuracy (eye-checked crop samples, crop OCR profile)

Sample: `crops --per-detector 6`; each sampled frame gives one crop per detector ROI.

**MP: 56 crops**, 45 with the target text visible:

| Detector | Visible | Read exactly | Usable (fuzzy) | Notes |
|---|---|---|---|---|
| M1 MVP | 3 | 3 | 3 | 3 `postmatch_left` crops empty (hit came from the end-screen row) |
| M2 Impact Play | 6 | 5 | 6 | "KILLED BY" read "KICLEO BY" once; names right |
| M3 medals | 6 | 6 | 6 | 6 other crops show only the halftime banner or nothing |
| M4 +N | 5 | 5 | 5 | |
| M5 kill feed | 1 | 0 | 0 | IGN line garbled under a red highlight; 1 crop is a "connected" notice list |
| N1 killcam | 18 | 16 | 18 | 2 name char errors (lightning glyph read as "1", "a"→"?") |
| X1 cards | 6 | 5 | 6 | 1 faded card lost its streak text |
| **Total** | **45** | **40 (89 %)** | **44 (98 %)** | |

**BR: 48 crops**, 24 with target text visible:

| Detector | Visible | Read exactly | Usable | Notes |
|---|---|---|---|---|
| B1 feed | 4 | 2 | 2 | Arabic-script names unreadable (Latin models); 1 crop is the squad roster (misfire) |
| B2 counter | 3 | 1 | 3 | "ELIMINAED", "KNOCKED DOON" |
| M1 MVP (BR end) | 6 | 6 | 6 | KILLS 0 / KILLS 1 / MVP read every time |
| M3 | 4 | — | — | all misfires (map labels) |
| N1 killcam | 3 | 0 | 0 | BR KILL CAM text sits at the right edge of the MP-calibrated N1 ROIs ("KI", "Kille") |
| N2 | 2 | 1 | 2 | HELP ME exact; "DOWNED YO" partial |

## Detector misfires and gaps

- No mode gate: B1 fired 409 boxes on MP frames; M5 fired 889 boxes on BR frames.
- M1: Like toast ("… | MVP") at y 0.28–0.31 (MP 00:14–00:15, BR 05:47–05:49); summary screen
  shows MVP badges for both teams while the IGN is elsewhere on the frame (00:17, 06:34,
  16:44–16:45) — a frame-level name check would make m2 positive. Needs the badge↔name pairing rule.
- M3: "Nuclear Plant" map label matched the Nuclear medal (BR 02:26, 02:53); a loading-tip text
  also matched. UAV Assist reference crops (132) include Counter-UAV Assist lines (fuzzy partial).
- X1: "Killstreak Support" matched via KILLSTREAK; X1 `banner_br` crop on the MP halftime banner.
- N1: misses one-frame killcams at 1 fps (MP killcam ~0.7 s); "KILLCAM" text on the BR GAME OVER
  screen (05:37) is a misfire; BR KILL CAM is outside the N1 ROIs.
- Kill-feed dedupe over-splits (garbled single boxes, merged lines): auto counts are not usable
  as kill totals without an adjudication step or higher fps.

## Reference medals logged

`refmedals` (MP, corrected hits) → `data/datasets/codm-medals-reference/` (gitignored):
326 crops for session `live3-mp` (dataset now 718): UAV Assist 132, Keep it Fresh 60, Revenge 30,
Kingslayer 28, Berserker 18, Minor Assist 18, Bloodthirsty 12, Headshot 10, Saboteur 10,
Major Assist 6, Survivor 2. Counts are boxes × ROIs, not events. refmedals has no end-screen or
replay gate. BR has no reference medals (only misfires), so it was not logged.

## Code change

- `services/clip/g1_scan.py`: global `--threads` (default 4) → onnxruntime thread params;
  ffmpeg `-threads 2`; BelowNormal priority for self and ffmpeg children; `bucket_select(fps)`
  clamps t ≥ 0 (timing bug above).
- `tests/py/test_g1.py`: `ResourceTests` (3), `BucketSelectTests` (2).
- `detectors.json` unchanged.

## Tests

Run one at a time after the changes:

| Command | Result |
|---|---|
| `npm test` | 132 tests, 132 pass, 0 fail |
| `npm run test:py` | 85 tests OK (8 skipped: OCR tests need the venv) |
| `npm run test:ocr` | 37 tests OK |
| `node tools/git-hooks/private-scan.mjs scan-worktree` | exit 0, 268 files scanned, no findings |

## UNVERIFIED

- m0 MVP screen (before capture start).
- m1 total kills (~28–32; no final scoreboard captured).
- Whether the player who downed the user in BR is the one the user eliminated earlier
  (Arabic-script names look alike; OCR cannot read them).
- Whether live-2 scans carry the same 1 s offset.

## Still missing for G1

- FINAL KILLCAM, with and without the IGN (none in 3 live captures; Domination shows MVP and Impact Play instead).
- User decision on the end-screen rule: both MVP and Impact Play appear in Domination.
- A final MP scoreboard frame for kill ground truth.
- DMZ footage.
- Mode/screen gate (B1/M5/M3 by mode; Like toast and summary-screen exclusion; M1 badge↔name pairing).
- BR KILL CAM ROI (and classify cue "KILL CAM" → br).
- B1 knock vs kill from the feed icon; kill-feed colours.
- Higher fps (or event-triggered re-read) for M5 during kill chains and for 1-frame killcams.
- Medals still not seen: Relentless, Brutal, Nuclear, Ultimate Terminator.
- BR: a revival (N2 "Waiting for Revival Flight"), a BR multi-kill banner, and a BR win.
- Covered now: BR non-win placement (#48/50); Mega/Super/Ultra Kill seen.

## Files created or changed

- Created: `docs/evidence/2026-10-27-p2a-a5c-mp-capture-3.md`
- Changed: `services/clip/g1_scan.py`, `tests/py/test_g1.py`
- Local only (gitignored): `docs/evidence/private/g1-live-3/` (index, offsets, layout, windows,
  scans, analyse outputs, corrected hits, crops and review grids, stills, logs),
  `data/datasets/codm-medals-reference/` (+326 crops)
