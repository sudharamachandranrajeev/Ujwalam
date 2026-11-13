# 2026-11-13 — QML studio Q1 (bridge) and Q2 (main window), flag `studio-qml` (off)

Plan: `docs/plan/2026-11-11-qml-studio-plan.md` (D355, changed by D360). Branch `ui/qml`.

## What was built

- Q1 bridge (D360): `QmlApi` (same UI server routes through `ApiClient`), `QmlTheme` (theme packs through `theme.h`),
  icon image provider, `PreviewView` (host preview in a native child window of the QML window).
- Q2 main window (`app/studio/qml/`): on-air bar (LIVE + timer, bitrate, REC + timer, dropped frames, load, Go live and
  Record with labels), scenes, layers with eye buttons, mixer with full names, add/delete scene and layer windows,
  confirm and close dialogs, status line. Same rules as the widget studio, kept in `Store.qml`.
- `UJWALAM_STUDIO_QML=1` (set by the launcher when the flag is on) opens it; the widget studio stays the default.

## Codex review (2026-11-13, codex-cli, medium effort) and fixes

| Sev | Finding | Fix |
|---|---|---|
| P1 | Go live / Record had no in-flight guard: a quick second click could stop what the first started | `Store.actionBusy`: buttons off from the click until the action answered and the following status poll came back; a failed status poll turns both off |
| P2 | Hidden mode did not keep `Popup.Window` dialogs and tooltips off screen | `popupType: studioHidden ? Popup.Item : Popup.Window` on every dialog and the shared tooltip |
| P2 | A display scale change kept the old preview pixel size | `ItemDevicePixelRatioHasChanged` re-sends `preview.open` |
| P2 | An older `layers.list` answer could replace a newer scene/canvas list | generation counter; answers for another scene or canvas are dropped |

Also: a QML probe always runs on the offscreen platform (the native hidden platform of D376 would have shown it).

## Tests

- `node --test tests/studio-qml-shell.test.mjs tests/studio-onair-summary.test.mjs tests/studio-swap-stream.test.mjs tests/normal-windows.test.mjs`
  (UJWALAM_HEADLESS=1): pass 11, fail 0, skipped 1 (the 20-swap stream test, opt-in).
- Real host, loopback stream, QML window hidden: `node tools/soak/studio-swap-soak.mjs --qml --swaps 5`:
  **21/21 checks PASS**. Previews H and V embedded; 5 swaps, previews back after 881–977 ms (limit 3000); crashing
  build rolled back; 0 dropped / render-lagged / encode-skipped frames; every sink 0 dropped; all four streams live at
  every sample (50).

## UNVERIFIED

- Real-screen screenshot at the user's DPI (Q2 "done when"): needs the user's screen.
- Double-click guard has no automated test (probe actions are 700 ms apart); covered by review only.
- Q3–Q6 not started.
