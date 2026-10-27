# 2026-10-27 — G1 prep: live CODM reference frames from the capture card

Reference capture for the game-event-detection amendment (`docs/plan/2026-10-27-game-event-detection.md`). This is preparation for G1, not G1 itself: G1 is the read-only check on the clips corpus, at P2. Every position below is UNVERIFIED until G1 confirms it on corpus footage.

## Capture

- Device: AVerMedia Live Gamer Ultra 2.1 (`Live Gamer Ultra 2.1-Video`, win-dshow). No device or Windows setting was changed.
- Formats (read only, `ffmpeg -list_options true -f dshow`): nv12 1920×1080 up to 240 fps, 2560×1440 up to 144 fps, 3840×2160 up to 60 fps. MJPEG and yuyv422 are also offered. This resolves the P1 note "card delivered 1280×720@60 by default": that was the device default, not the limit.
- Grab: `ffmpeg -f dshow -rtbufsize 512M -video_size 1920x1080 -framerate 60 -pixel_format nv12 -i "video=Live Gamer Ultra 2.1-Video" -t 180 -vf fps=0.5 g1-%03d.png`. Exit 0. 90 frames, 167.8 MB.
- Frames: `docs/evidence/private/g1-live/g1-001.png` … `g1-090.png`. **Local only** (they show the user's IGN and other players' names). Not in git.
- Game: Call of Duty: Mobile, Multiplayer, Free For All on Shipment. One full match was captured: loadout (frames 1–9), gameplay (10–56), end of match (57–79), lobby and the next match start (80–90).
- Active picture: the game is pillarboxed inside the 1920×1080 frame. `cropdetect` on frame 30 gives `crop=1566:1080:176:0`, so the game area is 1566×1080 at x = 176 (aspect about 1.45). The ROIs below are relative to this game area (0–1), so they don't depend on the canvas size.

## What appears on screen (Multiplayer)

ROIs are rough boxes read from 640×360 contact sheets: x0–x1, y0–y1 as fractions of the game area. UNVERIFIED.

| Detector | Seen? | Where | Notes |
|---|---|---|---|
| M3 medals (banner) | yes | top centre, x 0.40–0.60, y 0.03–0.28 | Badge icon with the kill count (2, 3, 4, 5), and a small text label under it. Text is small at 1080p. |
| M3 medals (text stack) | yes | right of centre, x 0.58–0.90, y 0.38–0.52 | Larger yellow text: medal names plus "Normal Kill" on every kill. Easier to OCR than the banner label. |
| M4 yellow "+N" | yes | same ROI as the text stack, left part | Seen: +125, +127, +252, +254, +256, and small +2 / +4. M3 and M4 can share one ROI and one OCR pass. |
| Multi-kill / killstreak card | yes | left of centre, x 0.33–0.52, y 0.55–0.68 | Shows "4X MULTI-KILL", "5X MULTI-KILL", "On a 5 killstreak", "On a 10 killstreak" with a player name. It also appears for other players, so the name match is needed. Not in the pack yet. |
| Kill feed | yes | bottom left, x 0.28–0.56, y 0.84–0.96 | Up to 3 lines, killer then weapon icon then victim. The user's lines are highlighted. MP also has a kill feed, so B1-style parsing can work in MP too. |
| M1 MVP + IGN | yes | after the match: "MVP" + IGN at left, x 0.03–0.33, y 0.40–0.63 | A full-screen post-match screen (frames 60–61), then an MVP badge on the player card on the "1st PLACE" end screen (74–79). |
| M2 Impact Play + IGN | yes | after the match: "IMPACT PLAY" header at top centre, x 0.42–0.58, y 0.06–0.11; "KILLED BY" panel with IGN at top left, x 0.07–0.31, y 0.10–0.19 | **It is a post-match replay** of the user's best sequence (frames 62–72, about 22 s), with a REC marker. It is not a live in-match banner. |
| Killcam | yes | full screen, "KILLCAM" top left | Shows the attacker's name. A negative signal (the user died). |
| "1st PLACE" | yes | end screen, top centre | Placement plus the per-player kills (KILLS 20 / 15 / 14). |

## Findings that change the amendment's assumptions

1. **The Impact Play replay repeats the medals.** The replay shows the same medal banners and text stack again (frames 63–71: Saboteur, Double Kill, Revenge, Triple Kill, Fury Kill, Merciless, Frenzy Kill, Berserker). Detectors must ignore medals while the Impact Play / REC overlay is on screen. Otherwise every medal in the impact sequence counts twice. The replay itself is useful: it marks the match's best sequence, which can be matched back to the live timeline.
2. **MVP is a post-match screen,** as M1 expects (a match-level boost). It came about 5 s after "1st PLACE".
3. **Medals seen from the user's list (5 of 10):** Double Kill, Triple Kill, Fury Kill, Frenzy Kill, Merciless. **Not seen in this match:** Nuclear, Ultimate Terminator, Ultra Kill, Mega Kill, Super Kill.
4. **Medals seen that are not on the list:** Revenge, Bloodthirsty, Saboteur, Berserker, Keep It Fresh (UNVERIFIED spelling), First Blood (another player), and "Normal Kill" on every kill. Whether to add any of these is the user's decision. The medal list is data, so adding them is a pack edit.
5. **The IGN renders with different separator glyphs** (hyphen, tilde, caret-like) on different screens. This confirms the need for IGN variants and fuzzy matching.
6. **The watermark at the bottom right has two lines.** The first line stayed the same across both matches in this capture. The second line changed between matches. So the second line is likely per-match, and the first line may be a per-account or per-device id (UNVERIFIED).
7. **Pillarboxing.** On this phone the game area is about 1.45:1, not 16:9. ROIs must be relative to the detected game area, not to the canvas.

## Battle Royale capture (second run, same day)

- Grab: same command with `-t 300`. Exit 0. 150 frames, 350.1 MB, in `docs/evidence/private/g1-live-br/br-001.png` … `br-150.png`. **Local only.**
- Game area: `cropdetect` on frame 48 gives `crop=1566:1080:176:0`, the same as MP.
- Covered: mid-match squad BR, kills 0 to 7, the user knocked down and redeployed (frames 133–150). The match end and the placement screen were not captured.
- Two frames were checked at full resolution (frames 48 and 67, cropped in the session scratchpad, not kept).

| Detector | Seen? | Where (game-area fractions, UNVERIFIED) | Notes |
|---|---|---|---|
| B1 kill feed | yes | **top left**, x 0.00–0.40, y 0.17–0.33 (not bottom left as in MP) | Each line reads: killer, weapon icon, **knock or kill icon**, victim, a count. The icon tells a knock from an elimination. The user's lines have an orange background; other lines are grey or purple. Text is large and readable at 1080p. |
| Own-kill counter text | yes | right of centre, x 0.70–0.86, y 0.40–0.47 | Yellow "ELIMINATED / N KILL(S)" and "KNOCKED DOWN". It is the user's own HUD, so no name match is needed, and it carries the running kill count. Likely the most reliable BR signal. |
| Own-event banner | yes | top centre, x 0.30–0.69, y 0.00–0.13 | The user's calling card with the IGN and a status: "DOWNED BY YOU", "nX MULTI-KILL". Shown in frames 10, 21, 67, 68, 82, 111, 133, 134. |
| Kill count in the status bar | yes | top left, the first small icons | Players alive and the user's kill count. Small; OCR UNVERIFIED. |
| Downed / redeploy | yes | full screen | Red vignette, "HELP ME", then "Waiting for Revival Flight". A negative signal or an end-of-life marker. |

Findings for BR:

8. **The BR kill feed is at the top left,** not at the bottom left as in MP. Detector ROIs must be per mode.
9. **The "ELIMINATED / N KILL(S)" text belongs to the user's HUD,** so it needs no name match. It counts knocks and eliminations separately. B1 can use it as the primary signal, with the kill feed as confirmation and as the knock/kill split.
10. **The top banner says "nX MULTI-KILL" in BR too.** The multi-kill card detector covers both modes.

## Not covered

- BR match end and placement screen (not reached during the capture).
- Medals not seen (see 3).
- Vertical composite readability: G1 checks it on the corpus.
- Frame-accurate timing: 1 frame every 2 s is enough for positions, not for durations or backdate windows.
