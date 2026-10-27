# P2a A5b — live full-screen capture 2 (MP + BR + profile)

Date: 2026-10-27. Follow-up to `2026-10-27-p2a-a5-g1-corpus-check.md` (A5 / G1). Counts only; every image, crop and per-frame list stays in `docs/evidence/private/g1-live-2/` (gitignored). Player names, the IGN, the clan name and watermark ids are not written here.

## 1. Captures

Two local captures (read-only, not moved, not committed) in the capture folder outside the repo:

| File | Container duration | Usable video | Content |
|---|---|---|---|
| `2026-10-27-g1-live-mp.mkv` | 1560 s | **712.7 s** (ffprobe: last video packet; "File ended prematurely") | Hardpoint win, Impact Play, end screens; Domination win (side switch), Impact Play, end screens |
| `2026-10-27-g1-live-br.mkv` | 1800 s | **920.9 s** (same error) | BR Resurgence win (#1/10), ranked XP, then the Player Profile pages (13:00–15:15), lobby |

Both files stop early: the MP capture holds about 11.9 of the expected 26 minutes, the BR capture about 15.3 of 30. The recorder probably stopped writing before the container was closed (UNVERIFIED why).

Game area: 1920×1080 frame, game at x 176, w 1566, y 0, h 1080 (aspect 1.45). The LGPL ffmpeg build has no `cropdetect`; the box came from a luma bounding box (limit 24) over sampled frames. Layout file: `docs/evidence/private/g1-live-2/layout-live2.json`.

## 2. Commands

```
P=docs/evidence/private/g1-live-2
C=C:/AI/Claude/_data/Ujwalam/captures
PY=".venv/Scripts/python.exe -I"
$PY services/clip/g1_scan.py scan --index $P/index.json --corpus $C --sessions live2-mp --clips-per-session 1 --layout $P/layout-live2.json --out $P/scan --name mp-1fps --fps 1
$PY services/clip/g1_scan.py scan --index $P/index.json --corpus $C --sessions live2-br --clips-per-session 1 --layout $P/layout-live2.json --out $P/scan --name br-1fps --fps 1
$PY services/clip/g1_scan.py analyse --scan $P/scan/mp-1fps.jsonl --pack data/games/codm/detectors.json --profile data/profile.local.json --out $P/analyse-mp
$PY services/clip/g1_scan.py analyse --scan $P/scan/br-1fps.jsonl --pack data/games/codm/detectors.json --profile data/profile.local.json --out $P/analyse-br
$PY services/clip/g1_scan.py crops ... --out $P/crops-mp   (and crops-br; review grids rev-*.jpg)
$PY services/clip/g1_scan.py refmedals --hits $P/analyse-mp/hits.jsonl --corpus $C --layout $P/layout-live2.json --pack data/games/codm/detectors.json
$PY services/clip/g1_scan.py refmedals --hits $P/analyse-br/hits.jsonl --corpus $C --layout $P/layout-live2.json --pack data/games/codm/detectors.json
# after the 0.2.1 pack edits:
$PY services/clip/g1_scan.py analyse --scan $P/scan/br-1fps.jsonl ... --out $P/analyse-br-021   (and analyse-mp-021)
```

1 fps over the full game area, default diff gate and OCR profile. Dense checks (2 fps, crop profile, full resolution) were run on the MVP and killcam windows with scratch scripts.

| Capture | Frames OCR'd | Skipped by diff gate | Wall time | Median OCR/frame | Frame modes |
|---|---|---|---|---|---|
| MP | 693 | 20 | 3078 s | 3884 ms | mp 594, br 13, none 86 |
| BR | 791 | 130 | 3440 s | 4189 ms | br 595, mp 45 (profile pages), none 151 |

The two scans ran in parallel on the CPU, so the per-frame times are about double the single-run figure in A5 §6.

## 3. Results per detector

"Crops" = crops cut by `crops` from the ROI boxes, read with the crop OCR profile and checked by eye. The count is "read correctly / text visible in the crop". The corpus column repeats A5 §5 for comparison.

| Det / ROI | Events (live 2) | Live 2 crops: read correctly | Corpus (A5) | ROI change |
|---|---|---|---|---|
| N1 label_mp | 7 killcams, 11 frames, all real (checked by eye) | 10/10 "KILLCAM" | not in corpus | → verified (KILLCAM at x 0.04–0.13, y 0.03–0.08) |
| N1 label_br | 3 KILL CAMs (out of 4 deaths; death 3 had none) | 9/9 "KILL CAM" | not in corpus | → verified (x 0.46–0.54, y 0.02–0.05) |
| N1 killer name (new) | MP: user name right of VS in 11/11 killcam frames (user is the victim) | attacker name read in the header and in the KILLED BY card in all 11 frames | — | new ROIs killer_header, killer_card (MP), killer_br (BR) |
| M1 postmatch_left | 2 MVP screens (one per match) | 2/2 MVP + IGN; dense 2 fps: MVP 13/16 frames, IGN 16/16 | not in corpus | → verified |
| M1 endscreen_row | MP top-3 and scoreboard; BR squad cards | MP top 3: IGN 7/7, small "MVP" badge 1/7 with the crop profile (read by the full-frame pass). BR: 12 crops, badge visible in 4, read 0/4; 8 were profile/menu pages (false) | 8/10 real | note only (pairing, exclusions) |
| M2 header / killed_by | 2 Impact Play replays | 10/10 header; IGN 10/10 | 8/8, 8/8 | none |
| M3 banner | 116 boxes | 7/7 labels exact | 10/10 | none |
| M3 text_stack | 186 boxes | 7/8 lines (faded line missed) | 11/11 | none |
| M4 +N | 83 | +N 10/10; medal lines 17/19 (one big animated label garbled, one faded) | 8/8 in ROI | none |
| M5 MP kill feed | 1754 lines; IGN killer 198 / victim 24 | Latin names 27/28; IGN lines 2/2 on the correct side; Cyrillic 0/5; Japanese partial | 10/10 IGN side | note (colour, x extent) |
| B1 BR kill feed | 0.2.0: 3165 lines, IGN killer 617; 0.2.1: IGN killer 111 (br frames) | 12 crops: 10 with feed lines, names 31/33 (one IGN line missed, one name garbled); 2 false (squad list only, menu) | killer side not visible | minTextHeight 0.021 |
| B2 own counter | 41 boxes / 26 events | 11/12 (fuzzy: KNOCKED DOON, DORN, …); 1 missed | 4/5 | note only |
| X1 card_mp | 36 boxes | text 9/10, names 9/10, IGN cards 4/4 | 4/4 | patterns add 20, 25 |
| X1 banner_br | 38 boxes | text 11/12, names 12/12 (IGN 1/12) | 6/6 | regex accepts "5+ MULTI-KILL" |
| N2 help_me | 18 frames | 11/11 HELP ME | 1/1 | none |
| N2 revival (bottom) | 6 frames | read in scan (y 0.74) | 7/7 | note |
| N2 revival_top (new) | 9 frames during the kill cam | 1/1 | — | new ROI 0.40–0.60, 0.08–0.13 |
| K1 FINAL KILLCAM | **0** (no FINAL KILLCAM in either match) | — | 1 clip | none; no with/without-name records |

### What changed in the picture since A5

- **MP killcam layout** (full screen): header "attacker N VS N victim" at the top centre (attacker x 0.35–0.46, victim x 0.55–0.64, y 0.01–0.05); an attackers panel at x 0.01–0.26, y 0.36–0.45 (name, damage, hits); a KILLED BY card bottom left (label x 0.17–0.21, name x 0.25–0.38, y 0.86–0.90).
- **BR death sequence**: downed (HELP ME, top-centre notification "attacker [knock icon] You") → killed ("attacker [skull icon] You") → KILL CAM with "Killer:<name>" (x 0.38–0.51, y 0.84–0.87), "Weapon:<name>" left of it, SKIP button, "Waiting for Revival Flight." at the top → spectating (revival line at y 0.74) → redeploy.
- **BR own-event notification** at x 0.28–0.46, y 0.17–0.21 (inside the B1 band): also "[knock icon] victim" when the user knocks someone. 4 "You" notifications = 4 user deaths; after the 0.2.1 change, B1 victim-side IGN lines fall exactly in those 4 windows.
- **B1 icons**: a falling-figure icon marks a knock, a skull marks an elimination (seen on the feed and the notification). Icon detection is still not specified.
- **B2 "N KILL(S)"** under ELIMINATED (y up to 0.50) is the user's own kill count. The A5 note (another player's banner) was about a different text near the top.
- **M1 end screens**: the MP full scoreboard shows one MVP badge per team (own y 0.65, enemy y 0.84); BR squad cards show the badge under the MVP's avatar (a teammate in this match). A badge must be paired with the name on the same card. Profile/history pages and a lobby "Like" toast (y 0.28–0.31) also produce MVP-like hits.
- **Medals** spelled on full screen: Bloodthirsty (now `seen_g1`), Avenger, Hardpoint Owned, Counter-UAV Assist, Minor/Major/UAV Assist, Hardpoint Kill, Long Shot, Berserker, Keep it Fresh, Revenge, Saboteur, Triple Kill.
- **Killstreak values** seen: 5, 10, 20, 25 (with "!"). "5+ MULTI-KILL" is a BR form.
- **Kill feed colours**: MP own lines show a red/pink bar; BR lines of the user and squad mates show a purple bar. Neither is measured (UNVERIFIED). A5 recorded pale yellow (MP name) and orange (BR) on the corpus.

### B1 fix (tool + data)

On full screen the squad list (small text, height 0.01–0.02 of the game area, always containing the user's name) shares the B1 band at y 0.20–0.22. Every frame produced a false "killer" IGN line. Feed text is 0.025–0.04 high. Measured on the BR capture: squad-list IGN boxes max 0.0222, p95 0.0185 (603 boxes); other IGN boxes in the band min 0.0222.

- `detector-pack.schema.json`: optional `minTextHeight` (fraction) on a ROI.
- `g1_scan.find_events`: kill-feed candidates shorter than the feed ROI's `minTextHeight` are dropped.
- Pack: B1 killfeed `minTextHeight` 0.021.
- Effect (BR capture, br frames): IGN killer lines 617 → 111; victim lines 21 → 16, all inside the 4 death windows. Two single-box lines (559 s, 560 s) where OCR missed the killer name lost their side. MP capture: M5 unchanged.
- Test: `tests/py/test_g1.py::DecisionTests::test_br_feed_ignores_small_squad_list_text` (invented names).

The threshold is measured on this one capture only. Corpus (vertical) clips are not re-checked with it (UNVERIFIED there).

## 4. Profile page and clan

- The BR capture ends on the Player Profile: basic page, game card, MP/BR/DMZ/Zombies stats, achievements and medals pages, match history and match details. Best still: `docs/evidence/private/g1-live-2/profile.png` (t ≈ 781 s); game card: `profile-gamecard.png` (t ≈ 855 s).
- **IGN rendering**: the profile shows the IGN itself (profile entry 0). The separator is the tilde, drawn raised like a superscript. The crop OCR profile reads the whole IGN exactly (score 1.0, glyph "~"); the default profile splits it into two boxes, the first matching variant 2. On the MVP screen OCR once read the raised tilde as "™". Name matching ignores separators, so all three forms match.
- **Clan**: yes, a clan exists. A clan line (emblem + clan name) sits under the IGN on the profile page and on the game card. The name is stored only in `data/profile.local.json` → `games.codm.clan_tag` (gitignored). A search of both scans found it only on the profile pages (4 boxes, 12–15 min); it is not shown next to the IGN in the match HUD, kill feeds, killcams or end screens.
- The profile also shows a UID and a personal status line; both stay private.

## 5. Reference medals dataset

`refmedals` wrote 392 crops to `data/datasets/codm-medals-reference/` (gitignored, checked with `git check-ignore`): 380 from MP (Berserker 28, Bloodthirsty 16, Hardpoint Kill 26, Headshot 4, Keep it Fresh 66, Kingslayer 30, Long Shot 16, Major Assist 6, Minor Assist 8, Revenge 20, Saboteur 10, Survivor 20, UAV Assist 130), 12 from BR (Berserker 2, Bloodthirsty 4, Headshot 6). The 12 BR crops come from the profile medal pages (865–915 s), not the live HUD; `refmedals` has no mode or screen gate. Each index record has session and time, so these can be filtered.

## 6. K1 (FINAL KILLCAM)

Neither match ended on a FINAL KILLCAM. No K1 records with or without the name. The K1 ROIs stay `unverified`.

## 7. Pack 0.2.0 → 0.2.1 (`data/games/codm/detectors.json`)

- N1: label_mp, label_br → verified (measured extents in notes); new ROIs killer_header (mp, 0.33–0.48, 0.0–0.06), killer_card (mp, 0.24–0.40, 0.85–0.90), killer_br (br, 0.36–0.54, 0.83–0.88), all verified.
- N2: new revival_top (0.40–0.60, 0.08–0.13, verified); revival label and note.
- M1: postmatch_left → verified; endscreen_row and detector notes (badge pairing, both teams, BR cards, profile/lobby exclusion).
- M3: Bloodthirsty `spelling_unverified` → `seen_g1`; note.
- M5, B1: notes (colours UNVERIFIED, x extent to 0.62, squad list, icons, notification). B1 killfeed `minTextHeight` 0.021.
- X1: regex `^(\d+X|\d+\+) ?MULTI-KILL$`; patterns add "On a 20 killstreak", "On a 25 killstreak"; banner_br label; note.
- B2: note (N KILL(S) is the user's count; SQUAD/ASSIST ELIMINATED; positions).
- `tests/fixtures/g0/detection.example.json` packVersion → 0.2.1 (the g0 test ties them).

No weights, windows or cooldowns changed (all still `null`). Every detector stays `unverified`.

## 8. Tests

```
npm test                                         125 pass, 0 fail
npm run test:py                                  80 run, OK (skipped 8)
npm run test:ocr                                 32 run, OK
node tools/git-hooks/private-scan.mjs scan-worktree   scanned 263 files, exit 0
```

## 9. UNVERIFIED

- Why both capture files end early (712.7 s / 920.9 s of 1560 s / 1800 s).
- Kill feed own-line colours (MP red/pink, BR purple); not measured.
- B1 `minTextHeight` 0.021 on the vertical corpus clips.
- K1 ROIs (label and killer name): no FINAL KILLCAM seen.
- Killstreak values other than 5, 10, 20, 25.
- B1 knock-vs-kill split: icons seen, no detector for them.
- M1 badge-to-card pairing rule: described, not implemented.
- Medals Relentless, Brutal, Nuclear, Ultimate Terminator, Ultra Kill, Mega Kill, Super Kill: still not seen.

## 10. Still missing

- The rest of the MP capture (about 14 minutes lost to the truncated file).
- A FINAL KILLCAM, ideally one with the user as the killer and one without (K1).
- A BR match that does not end in a win (placement screen for #2–#N, ELIMINATED / squad-wiped screen).
- DMZ footage (tag-only mode; no detectors).
- A mode or screen gate for M1/M3/refmedals so profile, history and lobby pages are excluded.
- Icon detection for B1 knock vs elimination.
- Colour measurement for own kill-feed lines (MP and BR).

## 11. Files created or changed

- Created: `docs/evidence/2026-10-27-p2a-a5b-live-capture-2.md` (this file).
- Changed: `data/games/codm/detectors.json` (0.2.1), `data/games/detector-pack.schema.json` (`minTextHeight`), `services/clip/g1_scan.py` (kill-feed min text height), `tests/py/test_g1.py` (new test), `tests/fixtures/g0/detection.example.json` (packVersion).
- Local only (gitignored): `data/profile.local.json` (`games.codm.clan_tag` set), `data/datasets/codm-medals-reference/` (392 crops + index), `docs/evidence/private/g1-live-2/` (sheets, profile stills, scans, analyses, crops, review grids).
