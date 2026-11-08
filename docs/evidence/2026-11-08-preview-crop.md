# 2026-11-08 Crop on the preview (P5, D256)

Status: test evidence (host, headless). Real mouse use on a screen: UNVERIFIED (needs the laptop with a second display).

## What
Behind flag `preview-edit` (off by default). Alt + drag on an edge of the selected layer crops that side. The box
edge follows the cut and the source is cut by the same share, so the picture keeps its scale and the opposite edge
stays put. The crop is saved in source px; the edit carries x, y, width, height and the whole crop, so undo restores both.

## Test
`node --test app/host/tests/host-preview-edit.test.mjs` against the built host (`npm run build:host`):

```
✔ Alt + edge drag crops that side: the box edge follows, the scale stays, the opposite edge stays put (D256)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

Checked: Alt + press on the left edge starts mode `crop`; a 40 canvas px drag gives `crop.left = round(40 x source
px per canvas px)`, the right edge, top and height unchanged; the edit's `before.crop` is all 0; dragging back out
past the source edge stops at crop 0 with the full box; the same press without Alt is a move.

## Files
- app/host/src/preview_edit.h, app/host/src/preview_edit.cpp (Mode::Crop, hit_edge, crop in drag and patch_json)
- app/host/src/studio.cpp (preview_items: crop and source size)
- app/host/tests/host-preview-edit.test.mjs, data/flags.json, docs/plan/2026-10-29-v1-decisions.md
