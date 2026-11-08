# 2026-11-08 Studio look (D285)

Reference: the user's video in `data/stream assets/Stream layout/` (local only, not committed): dark violet window,
rounded cards, purple accent, red record, stream info left, preview centre, chat right, controls and stats below.

## Done

- `app/studio/src/theme.h/.cpp`: Fusion style, palette and stylesheet; colours named once in `theme.h`.
- Top bar shortened: before, its minimum width forced the window to 3248 px (text clipped at 125 % on a 1366/1920 px
  screen). Now the window renders at 1600x900 with every panel shown.
- More menu: Import Meld session, Feedback notes, Posts (flag `posting`), Report a problem (flag `report-button`).
- Status bar: frame stats, host, event core.

## Evidence

```
node app/studio/tools/build.mjs                          -> built ujwalam-studio.exe
node --test tests/studio-qt-shell.test.mjs               -> pass 10, fail 0
  look (D285): UJWALAM_STUDIO_PROBE_SHOT png is 1600x900; Posts and Report shown in More with their flags on
```

Probe pictures (fake host, offscreen, Windows fonts) were checked by eye during the session: dark violet cards,
accent selection, styled flag check boxes, chips right, status bar bottom right. Not committed (binary churn).

## Not yet verified

- UNVERIFIED: the look on the real screen at 125 % (the user's laptop) and with the real host previews.
- Not done: the reference's bottom strip (scenes, mixer knobs, transitions, controls, stats) and a chat panel.
