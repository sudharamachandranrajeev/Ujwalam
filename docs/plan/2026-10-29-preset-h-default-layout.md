# Ujwalam: first scene preset, "Default H (current stream layout)"

Add as the first built-in horizontal scene preset for v1 (it fits under F1/F4). The reference screenshot is in `docs/evidence/private/2026-10-29-current-h-layout.png` (private: it shows my face and viewer names, so never commit it).

## Rules
- **Real values win.** These positions were measured from an 831×470 screenshot (about ±1 % accuracy). When my Meld session is imported (F1), match each region below to its Meld layer by name and geometry, and use Meld's exact values. Report any region with no matching Meld layer, or with a geometry difference over 2 %.
- **Positions are fractions of the canvas** (x, y = top-left; w, h = size). Pixels are given for a 1920×1080 canvas.
- **Brand values stay local.** The wordmark, handles, Discord link and counters are read from `data/profile.local.json` and the local brand assets. In the committed preset they are placeholders: `{brand.wordmark}`, `{handles.*}`, `{links.discord}`.
- **The preset is data** (`registry/presets/scene-default-h.json`), importable without changing any existing scene.

## Layers (back to front)

| z | Layer | Source / legacy overlay | x | y | w | h | px (x,y,w,h) | Notes |
|---|---|---|---|---|---|---|---|---|
| 0 | Background | Theme background (Blood Moon / atmos-back) | 0 | 0 | 1 | 1 | 0,0,1920,1080 | Dark stone backdrop visible behind the left column |
| 1 | **Game capture** | Capture card (Live Gamer Ultra 2.1) | 0.247 | 0.026 | 0.740 | 0.910 | 474,28,1420,983 | Rounded dark frame. **Check aspect:** the region is about 1.43:1; confirm the capture isn't stretched (crop vs scale) against the Meld session |
| 2 | **Facecam** | Insta360 Link 2C | 0.014 | 0.557 | 0.202 | 0.347 | 28,602,388,375 | Nearly square; rounded corners; red/pink border (Cam-Pop Frame idle state?) |
| 3 | **Event / chat list** | Chat List / Alert Box (legacy) | 0.012 | 0.202 | 0.174 | 0.330 | 23,218,335,356 | Stacked cards ("X just followed") with platform badges, red border |
| 4 | **Wordmark** | `{brand.wordmark}` (Malayalam wordmark image) | 0.006 | 0.106 | 0.204 | 0.096 | 12,115,392,104 | Brand asset, local only |
| 5 | **Goal bar** | HUD goal bar (legacy HUD) | 0.000 | 0.038 | 0.235 | 0.057 | 0,41,451,62 | Label "Goal" + progress count |
| 6 | **Twitch follower counter** | HUD counter text | 0.259 | 0.000 | 0.234 | 0.030 | 497,0,450,32 | Overlaps the top edge of the game |
| 7 | **Subscribe call to action** | YouTube subscribe pill ("Don't Miss Out!" + Subscribed button) | 0.536 | 0.021 | 0.168 | 0.074 | 1029,23,323,80 | Sits over the game |
| 8 | **YouTube subscriber counter** | HUD counter text | 0.764 | 0.000 | 0.193 | 0.026 | 1467,0,370,28 | Overlaps the top edge of the game |
| 9 | **Social ticker** | Social Ticker (legacy) | 0.000 | 0.953 | 1.000 | 0.047 | 0,1030,1920,50 | Repeating: Discord `{links.discord}`, Twitch, YouTube, Kick `{handles.*}` |
| 10 | **Character cutout** | Static/animated character (bottom right) | 0.927 | 0.777 | 0.073 | 0.223 | 1779,839,141,241 | Confirm whether this is the Chat Engage caricature or a static asset |
| 11 | Effects (full canvas) | Chat Storm, Chat Charge, GG Burst, Voice Callout | 0 | 0 | 1 | 1 | 0,0,1920,1080 | Transparent, idle between events |
| 12 | Atmos front | Atmos Frame (front) | 0 | 0 | 1 | 1 | 0,0,1920,1080 | If present in Meld session |
| 13 | Cam-pop | Cam-pop rule target = layer 2 | — | — | — | — | — | Grows from the facecam's geometry; restores it exactly |

## Issues spotted (report with the preset, don't change silently)
1. **Top-centre overlays over the game HUD.** The subscribe pill and follower counters sit over the top of the game. In a CODM match, the top centre holds the score and timer, so they'd likely be covered. Propose:
   - (a) a game-safe-zone check that warns when overlays cover HUD areas;
   - (b) an alternative position for the pill, for my choice.
2. **Character cutout over the bottom-right game area.** In the lobby it covers part of START; in a match it may cover the fire buttons. Same treatment as item 1.
3. **Game aspect.** Confirm crop vs stretch from the Meld session's transform. Don't change it without asking.
4. **Privacy.** Viewer names show in the event list. Any committed screenshot or test frame of this scene must blur that region and the facecam.

## Done when
- The preset loads as a new scene without touching existing scenes.
- A side-by-side capture against my current Meld layout shows matching positions (within 1 % after using the Meld values).
- The issues above are listed in the end-list with options.
