# 2026-10-27 — P2a A5: G1 corpus check of the CODM game-event detectors

Read-only check of the detector pack `data/games/codm/detectors.json` against the Meld clips corpus, with RapidOCR on CPU. The live full-screen reference frames from `2026-10-27-g1-live-reference.md` are used as a second test set and reported separately.

Privacy: OCR output holds the user's IGN and other players' names. All frames, crops, OCR dumps and contact sheets are in `docs/evidence/private/g1-corpus/` (gitignored). This document holds counts only. "IGN" means the profile name in `data/profile.local.json`; "variant n" is the n-th entry of its variant list. The corpus was only read (ffmpeg decode); no file in it was written, moved or deleted.

## 1. Install (user-approved)

- venv: `C:\Python314\python.exe -m venv C:\AI\Claude\Ujwalam\.venv` (Python 3.14.7; `.venv/` is gitignored, checked with `git check-ignore`).
- Packages: `rapidocr==3.10.0`, `onnxruntime==1.31.1` (CPU), `opencv-python-headless==5.0.0.93`, `numpy==2.5.4` and their dependencies. No onnxruntime-gpu, no paddlepaddle.
- Lockfile: `services/clip/requirements-ocr.lock.txt` — 21 packages, each with `--hash=sha256:`. Install with `.venv\Scripts\python.exe -m pip install --require-hashes -r services/clip/requirements-ocr.lock.txt`. A `pip install --dry-run --require-hashes` run parsed it without errors.
- onnxruntime providers: `AzureExecutionProvider`, `CPUExecutionProvider` (CPU only).
- Models: the wheel bundles them, so nothing is downloaded on first use. The SHA-256 values match the wheel `RECORD` and RapidOCR's `default_models.yaml`. All three are Apache-2.0 (RapidOCR `MODEL_LICENSES.md`, the PaddlePaddle Hugging Face model cards, and the PaddleOCR LICENSE).

| Model | Version | Bytes | SHA-256 | Source URL |
|---|---|---|---|---|
| PP-OCRv6_det_small.onnx (detection) | PP-OCRv6 small | 9,929,594 | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` | https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx |
| PP-OCRv6_rec_small.onnx (recognition, multilingual) | PP-OCRv6 small | 21,234,383 | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` | https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx |
| ch_ppocr_mobile_v2.0_cls_mobile.onnx (angle classifier) | PP-OCR v2.0 | 585,532 | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` | https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx |

Licences for RapidOCR, onnxruntime, OpenCV, numpy and the models are listed in `docs/third-party-notices.md`. `docs/licence-headers.md` now points to it.

## 2. Tools

`services/clip/` (run with `.venv\Scripts\python.exe -I`). Every path and name comes from arguments or the profile. Output is refused inside the corpus, and inside the repo unless the folder is gitignored.

- `g1_text.py` (stdlib): name normalisation (A–Z/0–9 only, so `~`, `-`, `^`, quotes and spaces don't matter), OCR-confusion folding, Levenshtein ratio and partial ratio, `name_score` (returns a score and a list index only, never the name), medal matching with an ignore list, `+N` parsing, line grouping, kill-feed side.
- `g1_geometry.py` (stdlib): ROI fractions to pixels, ROI visibility in the cutout, and the game area from two landmarks.
- `g1_scan.py` (venv): `frames`, `calibrate`, `scan`, `analyse`, `crops`, `bench`.

Main commands (run from the repo root; `P=docs/evidence/private/g1-corpus`):

```
.venv/Scripts/python.exe -I services/clip/g1_scan.py frames --index <index.json> --corpus "<corpus>" --out $P/frames --per-session 6
.venv/Scripts/python.exe -I services/clip/g1_scan.py calibrate --frames "$P/frames/*.png" --ref-frame docs/evidence/private/g1-live/g1-030.png --ref-game 176,0,1566,1080 --out $P/layout-calibrate.json
.venv/Scripts/python.exe -I services/clip/g1_scan.py scan --index <index.json> --corpus "<corpus>" --layout $P/layout-calibrate.json --out $P/scan --name corpus --clips-per-session 10 --fps 0.5
.venv/Scripts/python.exe -I services/clip/g1_scan.py scan --images "docs/evidence/private/g1-live/*.png" --layout $P/layout-live.json --out $P/scan --name live-mp --diff-gate 0
.venv/Scripts/python.exe -I services/clip/g1_scan.py analyse --scan $P/scan/corpus-t.jsonl --pack data/games/codm/detectors.json --profile data/profile.local.json --out $P/analyse-corpus
.venv/Scripts/python.exe -I services/clip/g1_scan.py crops --hits <hits.jsonl> --corpus "<corpus>" --layout $P/layout-calibrate.json --pack data/games/codm/detectors.json --per-detector 10 [--cache <analysis cache>] --out $P/crops-corpus-a
.venv/Scripts/python.exe -I services/clip/g1_scan.py bench --crops $P/crops-corpus-a --out $P/bench-corpus.json
```

**Timing bug found and fixed during the run.** ffmpeg's `fps=0.5` filter returns frame i from about (i + 0.5)/fps, so scan times were 1 s early compared with the accurate seek in `crops`. The first crop pass showed it (the IMPACT PLAY banner was missing in 2 of 8 crops). `decode_frames` now selects the first frame of each 1/fps bucket (`select=…` with `-fps_mode passthrough`). After the fix, frame i matches the seek at i/fps exactly (mean abs diff 0.0 on a corpus clip). A test now checks this (`DecodeTimingTests`). The corpus scan had started before the fix, so its clip times were shifted by +1.0 s (`corpus-t.jsonl`, each record marked `tShift`) before `analyse` and `crops` ran.

## 3. Vertical layout: where the game sits in the clips

The Meld clips are a 1080×1920 vertical cutout of the horizontal canvas. The layout is the same in every session checked.

- Calibration: two HUD landmarks were template-matched from the live reference (the "MEDIUM" label and the MP "HP" label) over a scale sweep from 0.80 to 0.92. 108 frames were sampled from 18 sessions, and 25 frames from 13 sessions passed both landmarks (score ≥ 0.6).
- Result: game area in the clip = x −149.04, y 466.63, w 1342.52, h 925.88 px (scale 0.857 of the 1566×1080 game; aspect 1.45, same as live). Spread across frames: 1.4–5.0 px. Cutout top edge at y 458 (mode, 80 % of frames).
- **Visible part of the game: x 0.111–0.9155, y 0.0–0.998** (fractions of the game area). The left 11 % and the right 8.5 % of the HUD are not in any corpus clip.
- `gameArea.status` in the pack is now `verified`: aspect 1.45 on both live and corpus.

## 4. Corpus sample and mode share

- Scan: 18 sessions × 10 clips (seeded, spread through each session) = 180 clips, 0.5 fps, the full cutout. 2,758 frames, 2,417 OCR'd and 341 (12 %) skipped by the diff gate (mean abs luma change < 1.5). Full-cutout OCR: median 1,476 ms per frame, p95 2,644 ms. 4,055 s wall time.
- **Mode share (visual, one frame at t = 15 s per clip, 180 clips):** MP 79, BR 32, **DMZ Recon 17**, lobby/menus/end screens 37, capture-card "No Signal" 15. Of the 128 gameplay clips: **MP 62 %, BR 25 %, DMZ 13 %**. DMZ Recon has no detectors or mode in the pack yet.
- The automatic per-clip mode (from OCR'd HUD words) agrees with the visual label on 77/79 MP and 28/32 BR clips. DMZ clips come out as BR (9), MP (2) or none (6), because the classifier has no DMZ class.
- 15/180 sampled frames show the capture card's "No Signal" screen, in 5 sessions. That is a signal loss during recording, not a detector issue, but the clipper should skip it.

## 5. Results per detector

"Visible" = fraction of the ROI inside the cutout. The corpus columns come from crops of the original clips, checked by eye against contact sheets (`sheets/ca-*.png`). The crop OCR uses the crop profile (§6). "Live" = the full-screen reference frames (90 MP, 150 BR; 1920×1080), reported separately.

| Det | ROI (game fractions) | Visible | Corpus hits (frames / clips / sessions) | Corpus crops checked: read correctly | IGN on corpus | Live full screen | ROI status |
|---|---|---|---|---|---|---|---|
| M1 MVP | postmatch_left 0.02–0.42, 0.39–0.60 | 0.77 | 0 in ROI | MVP post-match screen **not in sample** | — | 2/2 MVP read; IGN read right with the crop profile (garbled with default) | unverified |
| M1 MVP | endscreen_row 0.0–1.0, 0.58–0.93 | 0.80 | 29 / 10 / 8 | 10 hits: 8 real end-screen MVP badges (MP scoreboard, MP top 3, BR squad cards), 2 lobby "Like" toasts (false). Name beside the badge read in 6/8; 2 unclear (non-Latin names) | 3 of 8 MVP cards were the IGN | not captured on full screen yet | verified |
| M2 Impact Play | header 0.42–0.58, 0.04–0.12 | 1.0 | 31 / 7 / 5 | 8/8 "IMPACT PLAY" | — | 10/10 | verified |
| M2 | killed_by 0.07–0.31, 0.10–0.20 | 0.83 | (same events) | name read 8/8 | 7/8 IGN, 1 other player | IGN read (joined with the crop profile, split in two with default) | verified |
| M3 medals | banner 0.38–0.62, 0.03–0.32 | 1.0 | 144 / 53 / 18 | 10/10 label exact (Keep it Fresh ×5, Double Kill ×3, Survivor, Berserker) | — | 7/7 exact | verified |
| M3 | text_stack 0.56–0.90, 0.36–0.50 | 1.0 | (same) | medal names 11/11 visible lines; 4 crops had a faded, empty stack | — | normal medals read; overlapped/faded missed (Fury Kill only with crop profile) | verified |
| M4 +N | text_stack (shared) | 1.0 | 266 / 54 / 17 all; 68 in ROI | in-ROI hits: 8/8 values right (+13 … +108); 2 sampled hits were post-match XP screens (+6620, +5255). Stack crops: small glowing +2 / +8 missed 2/2, one "+" dropped ("106") | — | 9/10 values right | verified |
| M5 MP kill feed | 0.28–0.58, 0.84–0.96 | 1.0 | 2,067 frames with lines; IGN lines: killer 264, victim 177 | 10/10 IGN lines on the right side (3 killer, 7 victim); IGN text exact 8, fuzzy 2 | IGN drawn pale yellow | Latin names nearly all exact; 32 killer / 2 victim IGN lines | verified |
| B1 BR kill feed | 0.0–0.45, 0.17–0.29 | 0.75 | 695 BR-frame boxes | **killer side not in corpus** (killer names start at x 0.01). Victim names: Latin 12/13, non-Latin (CJK/Cyrillic/Arabic) 0/3 | not usable on corpus | killer IGN 42 lines; IGN read in 4/5 visible own lines; squad list (small text, includes IGN) sits just below the feed | verified (visible part) |
| X1 multi-kill / streak | card_mp 0.33–0.58, 0.55–0.68 (MP) | 1.0 | 50 / 35 / 16 (all X1) | 4/4 card text and player name | 0/4 (other players) | 10/10 text; 9/10 names | verified |
| X1 | banner_br 0.36–0.64, 0.0–0.12 (BR) | 1.0 | (same) | 6/6 text ("3X MULTI-KILL", "On a 20 killstreak!"); names 6/6 | 1/6 IGN | 1 hit | verified |
| B2 own BR kill | counter 0.62–0.92, 0.36–0.50 | 0.98 | 21 / 13 / 8 | ELIMINATED / SQUAD ELIMINATED read in 4/5 crops where it was visible (zoom-in animation; one occluded) | own HUD | ELIMINATED / KNOCKED DOWN at x 0.685–0.86, y 0.39–0.48 | verified |
| N1 killcam | label_mp 0.02–0.20, 0.02–0.09 | 0.49 | 0 | **not in corpus** (KILLCAM sits at x 0.037–0.126, mostly cut) | — | seen at top left | unverified |
| N1 | label_br 0.44–0.56, 0.0–0.07 | 1.0 | 0 | BR KILL CAM not in sample | — | seen at top centre | unverified |
| N2 down / redeploy | help_me 0.83–0.93, 0.68–0.76 | 0.85 | 21 / 3 / 3 (all N2) | 1/1 | — | seen | verified |
| N2 | revival 0.40–0.60, 0.72–0.79 | 1.0 | (same) | 7/7 "Waiting for Revival Flight." | — | seen | verified |

What "verified" means here: the ROI box was checked on corpus crops and contains the text. It does not mean the detector is done. Weights, windows and cooldowns stay `null`, and every detector stays `unverified`.

### IGN matching (corpus)

- 837 OCR boxes in 726 frames scored ≥ 0.8 against the profile names. 817 matched exactly after normalisation, 20 were fuzzy (≥ 0.9, e.g. one letter misread). 829 matched the IGN and 8 matched variant 2.
- The separator glyph comes out differently (tilde, hyphen, double quote), and kill-feed OCR often merges the IGN with the neighbouring name into one box. Normalisation and the merged-box side rule handle both (unit tests use invented names).
- A spot check of the distinct matched strings found no false positive. The IGN also appears in lobby toasts and room messages, so the name match has to be gated by ROI and mode, never by the whole frame.

### Medals seen

- Corpus spelling confirmed: Double Kill, Triple Kill, Fury Kill, Berserker, Revenge, Saboteur, **Keep it Fresh** (lower-case "it"; the pack text is updated and its status is now `seen_g1`).
- Seen but not in the pack list (the user decides): Survivor, Kingslayer, Ruthless, Long Shot, Headshot, Major Assist, Minor Assist, UAV Assist, Hardpoint Kill, Trophy System Destroy.
- Not seen in the corpus sample or live: Nuclear, Ultimate Terminator, Ultra Kill, Mega Kill, Super Kill.

### Other findings

- **FINAL KILLCAM** (MP, top centre, x 0.45–0.56, y 0.055–0.093) appears in 1 clip and 5 frames. It replays the match-ending kill, which can be the user's own, so it is not an N1 (death) event. Recorded in the N1 note; whether it becomes a positive detector is the user's call.
- The "N KILL(S)" text near the top of the BR HUD sits under a player banner (another player's), not the user's own counter. `analyse` no longer counts it as B2; B2 now needs upper-case ELIMINATED / KNOCKED DOWN (quick-chat "eliminated." stays excluded).
- `analyse` was emitting M3 events for ignored texts ("Normal Kill"). Fixed (`find_events`) and covered by a test.
- The M4 "+N" pattern outside the stack ROI (207 hits, mostly "+100" at the bottom centre in BR/DMZ and post-match XP) shows that the ROI gate is required.

## 6. Speed on CPU

i7-12650H (10 cores / 16 threads), onnxruntime CPU, one process. Measured after the corpus scan finished, with no other load (`bench`):

| Input | Profile | n | Median | p95 |
|---|---|---|---|---|
| Corpus ROI crops | RapidOCR default (det limit_type min 736, cls on) | 125 | 1,314 ms | 2,138 ms |
| Corpus ROI crops | **crop profile** (`Det.limit_type=max`, `Det.limit_side_len=960`, `Global.use_cls=False`) | 125 | **108 ms** | 289 ms |
| Live full-screen ROI crops | default | 81 | 1,294 ms | 1,750 ms |
| Live full-screen ROI crops | **crop profile** | 81 | **98 ms** | 300 ms |
| Full vertical cutout (discovery scan) | default | 2,417 | 1,476 ms | 2,644 ms |

The default detector upscales a small crop until its short side is 736 px, which costs about 12× in time. The crop profile gave the same text on 61/125 corpus crops and 42/81 live crops; where the two differed, the checked cases favoured the crop profile (MVP IGN, Fury Kill, the M2 IGN in one box). Corpus crop counts in §5 use the crop profile.

## 7. Resolution: 540×960 proxy vs original clips

On session `s-2026-10-18-1221` (the analysis cache holds its proxy), the same ROI was cropped from the original clip and from the 540×960 proxy at the mapped time, and OCR'd both as-is and with a 2× bicubic upscale. 43 crops had a proxy frame:

| Source | Medal texts read (score ≥ 0.9) | "+N" parsed | IGN boxes | Median ms |
|---|---|---|---|---|
| Original 1080×1920 | 13 | 2 | 8 | 78 |
| Proxy 540×960 | 8 | 0 | 7 | 26 |
| Proxy, 2× upscale | 9 | 0 | 6 | 62 |

**OCR needs the original resolution** (the 1080×1920 clip, where game text is 0.857× its live size). The proxy loses about 40 % of the medal reads and every "+N". Upscaling does not bring them back. The proxy remains fine for cheap gating (diff, mode), but crops for OCR must be decoded from the source clip.

## 8. Accuracy gate verdict

**PASS for the runtime (RapidOCR 3.10 + onnxruntime CPU on Python 3.14).** Where the text is on screen at original resolution, it is read: banners, headers, killstreak cards, the MP kill feed with IGN side, revival text, ELIMINATED. Every failure observed has another cause:

1. **Not in corpus (layout):** BR killer names (B1), MP KILLCAM (N1), the MP post-match MVP screen (partly). The HUD is outside the cutout, so live full-screen capture is needed (§9). No model can fix this.
2. **Resolution:** the proxy fails (§7); the originals pass.
3. **Animation timing:** fading text stacks, zoom-in ELIMINATED, small glowing "+2 / +8". Fix with denser sampling around a trigger (e.g. 4–6 fps inside the ROI for 2 s after the diff or yellow cue) and tolerant "+N" parsing. Not a model problem.
4. **Preprocessing:** the default detector limits are slow and sometimes worse on small crops. The crop profile fixes both.
5. **Model language coverage:** non-Latin player names (CJK, Cyrillic, Arabic) are poor. This only affects reading other players' names; the IGN is Latin.

No evidence points to the runtime or the ONNX conversion, so **no Python 3.12 / paddlepaddle environment is proposed.**

Prefilters measured:
- Yellow-pixel gate (HSV hue 18–38, S ≥ 110, V ≥ 170): **rejected**. The HUD always holds yellow. At a threshold that keeps 94 % of medal frames it still passes 93 % of the other frames (corpus; live is similar).
- Diff gate 1.5: skips 12 % of frames at 0.5 fps. Useful but small.
- Recommended pipeline for G2: mode gate (MP/BR/DMZ from HUD words, 77/79 MP and 28/32 BR right) → mode-specific ROI crops only (MP: M3 banner, text stack, M5 feed, X1 card; about 4 × 0.1 s) → denser sampling only around triggers. Decode ROIs from the original clips.

## 9. Data requests

1. **In-game profile screen** (1 screenshot, full screen, kept private). It shows how the IGN, its separator glyph and the clan tag (UNVERIFIED: see Decisions) are rendered, so the variant list and `clan_tag` matching can be set from fact. Worth doing: the corpus shows three OCR forms of the separator, and no clan tag was seen (UNVERIFIED that one exists).
2. **Live full-screen captures** (after the user says "devices ready"; 1920×1080 at 60 fps, recorded as a near-lossless mp4 or PNG at 2 fps, kept in `docs/evidence/private/`). These HUD parts are outside the vertical cutout, so the corpus cannot verify them.
   - **MP: 2 full matches (~25 min total) in a mode with killcams and an end screen** (TDM or Domination), including at least 2 deaths and the post-match sequence (MVP screen, Impact Play, scoreboard). Verifies N1 KILLCAM (top left), the M1 post-match MVP screen and IGN, and the M5 killer side across the full feed width.
   - **BR: 1 full match (~25 min) including a knock, a death, revival, KILL CAM and the placement screen.** Verifies B1 killer side, the knock vs kill icon, B2 KNOCKED DOWN vs ELIMINATED, N1 BR KILL CAM, and X1 banners on own multi-kills.
   - **DMZ Recon: 1 match (~15 min), only if DMZ should be detected.** It is 13 % of gameplay clips and has no detectors yet.
   - Size: PNG at 2 fps ≈ 1.9 MB/frame, so about 5.7 GB per 25 min. An mp4 at about 50 Mbps is about 9.4 GB per 25 min. A 1 fps PNG stream plus a short 60 fps mp4 around a few events would cover both OCR and animation timing.
3. **Decisions for the user:**
   - (a) Which of the medals seen but not listed (§5) join the M3 list.
   - (b) Whether FINAL KILLCAM becomes a positive detector.
   - (c) Whether DMZ Recon gets a mode.
   - (d) Whether the M4 small values (+2 / +8) matter. If they do, sample at 4–6 fps around triggers.
4. **More corpus is not needed for G1.** The 180-clip sample covers all 18 sessions. Rare medals (Nuclear, Ultimate Terminator, Ultra/Mega/Super Kill) will only come from new play.

## 10. Tests

- `npm test`: 122 pass, 0 fail. Includes `tests/g0-schemas.test.mjs`, updated so ROIs may be `verified` and the medal is spelled "Keep it Fresh"; the detection fixture ROI follows the new B1 box.
- `npm run test:py`: 72 tests OK, 7 skipped (the OCR tests skip under the system Python).
- `npm run test:ocr` (venv): 24 tests OK. Synthetic images and a lavfi test video only: OCR of medal and points cards, `find_events`, ignored medal text, the B2 capital rule, and decode timing vs seek.
- `node tools/git-hooks/private-scan.mjs scan-worktree`: `scanned 263 files`, exit 0.

## 11. Placeholders, risks

- Visual mode labels are one frame per clip (t = 15 s). A clip can change mode, and the labels are a human read of thumbnails.
- "Checked" counts are small (4–10 crops per ROI). The ROI status is `verified`; detector accuracy at scale is G2 work with labels.
- B1 own-kill detection on corpus clips depends on the orange line colour. It was seen but not measured.
- The corpus scan sampled 10 clips per session at 0.5 fps, so short events (medal banners ~1.5 s) are under-sampled. The hit counts are lower bounds.

## 12. Decisions (user, 2026-10-27)

Applied to the pack (`data/games/codm/detectors.json`, version 0.1.0 -> 0.2.0), schemas, `services/clip/g1_scan.py` and tests. These answer the §9 questions (a)-(c).

1. **Positive medals (M3):** Double Kill, Triple Kill, Fury Kill, Frenzy Kill, Merciless, Nuclear, Ultimate Terminator, Ultra Kill, Mega Kill, Super Kill, Ruthless, Relentless, Brutal. No duplicates. Relentless and Brutal: **UNVERIFIED** (not seen on footage). Weights stay null (G3).
   - **Interpretation to confirm:** Revenge, Bloodthirsty, Saboteur, Berserker and Keep it Fresh (added earlier) are not in the user's new positive list, so they were moved to reference-only. Say so if any should stay positive.
2. **Reference-only medals (weight 0, never a clip reason):** Survivor, Kingslayer, Long Shot, Headshot, Major Assist, Minor Assist, UAV Assist, Hardpoint Kill, Trophy System Destroy, plus the five moved above. Each medal carries `class` (positive or reference), `weight` and `clipReason` as pack data, so promoting one later is a data edit (schema: reference forces weight 0 and clipReason false; positive allows a number). They are detected and logged with crops by `g1_scan.py refmedals` into `data/datasets/codm-medals-reference/` (one subfolder per medal slug, `index.jsonl`; default path, `--dataset` overrides). The folder is gitignored (`data/datasets/`, checked with `git check-ignore`). `refmedals` refuses an un-ignored folder inside the repo.
3. **FINAL KILLCAM (MP, top centre) = detector K1, positive only with the streamer name as killer.** A match of the IGN or any profile variant inside the K1 ROIs gives `signal: true`; without it `signal: false` (no signal). `analyse` writes both cases to `hits.jsonl` (`nameMatched`, `signal`, `nameScore`) as tuning evidence. It is never N1. The `killer_name` ROI position is **UNVERIFIED** (wide band around the label until a capture shows it). Weight, window, cooldown: null.
4. **DMZ:** new mode value `dmz`, used only to tag footage (`taggingOnlyModes`). No detector lists it, and DMZ footage is excluded from MP/BR tuning and test sets. `analyse --mode-tags FILE.json` tags a session or a clip (`{"<session>": "dmz"}`); tagged DMZ frames run no detectors and are counted separately in the mode share. DMZ is **manual-only**: the guessed `DMZ`/`EXFIL` auto-cues were removed from `g1_scan.py` (no DMZ capture verified); dmz comes only from `--mode-tags`.
5. **Clan tag:** CODM shows none in game and it was removed from the local profile. Clan tag mentions in the docs are marked UNVERIFIED.

Not decided: whether the M4 small values (+2 / +8, §9 d) matter.

Tests after these changes: `npm test` 125 pass, 0 fail; `npm run test:py` 79 OK (8 skipped, OCR-only); `npm run test:ocr` 31 OK; `node tools/git-hooks/private-scan.mjs scan-worktree` scanned 263 files, exit 0. New tests use invented names only.
