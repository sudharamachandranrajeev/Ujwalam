# 2026-11-08 Preview snapping to other layers (D272)

Status: test evidence (headless host, `preview.editSim`) for the snap geometry. The guide line drawn on the preview is
UNVERIFIED on screen (tests show no window).

## What changed
- `app/host/src/preview_edit.cpp`: at the press, the editor takes the other visible layers' bounding boxes
  (`guides()`: left, right, centre x; top, bottom, centre y; a turned layer uses the box around its turned corners).
  A move snaps the dragged box's edges or centre to the nearest target within 8 screen px; an unrotated corner
  resize snaps the dragged corner. Targets: canvas edges and centre first (a tie goes to the canvas), then the
  guides. Alt: no snap (unchanged). `drag()` reports the guide line it used; the selection keeps it while the drag
  runs and clears it on release or cancel.
- `app/host/src/preview.cpp`: `draw_guides()` draws that line across the canvas (1 screen px pink on a 3 px dark rim).
- `preview.editSim` step results carry `snap: {x, y}` (null on an axis with no snap) while a drag holds a snap.

## Test
`node --test app/host/tests/host-preview-edit.test.mjs`: 9 pass (8 existing unchanged + 1 new):
```
✔ moves and resizes snap to other layers' edges and centres too (Alt: no snap); the guide shows while dragging (D272)
ℹ pass 9
ℹ fail 0
```
The new test (layer `turned` covers x 650..750):
- Corner resize of `box` (300,500 200x100) to x 695 with Shift: right edge snaps to 700 (turned's centre),
  `snap = {x: 700, y: null}` while dragging, no `snap` after release.
- Move by +457 (left edge 757): snaps to 750 (turned's right edge, edge to edge), `snap.x = 750`.
- The same move with Alt: stays at 757.
The existing canvas-snap, resize, rotate, crop and cancel tests pass unchanged.

## To check by hand
Flag `preview-edit` on, drag a layer next to another on the H preview: it clicks into line with the other layer's
edges and centre and a pink line shows while it holds; Alt drag moves freely.

## Files
- `app/host/src/preview_edit.h`, `app/host/src/preview_edit.cpp`, `app/host/src/preview.cpp`
- `app/host/tests/host-preview-edit.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D272), this file
