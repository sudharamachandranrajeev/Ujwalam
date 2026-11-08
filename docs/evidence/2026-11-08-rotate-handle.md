# 2026-11-08 Rotate handle on the preview (P5, D255)

Status: test evidence (host, headless). Real mouse use on a screen: UNVERIFIED (needs the laptop with a second display).

## What
Behind flag `preview-edit` (off by default). With a layer selected in the H or V preview, a diamond handle sits
24 screen px above the middle of its top edge. Dragging it turns the layer about its centre; Shift snaps to 15
degree steps. Only `rotation` changes; the edit (and its undo `before`) carries `{ rotation }` alone.

## Test
`node --test app/host/tests/host-preview-edit.test.mjs` against the built host (`npm run build:host`):

```
✔ rotate handle turns the layer about its centre (Shift: 15 degree steps); the edit is the rotation alone (D255)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

Checked: press on the handle starts mode `rotate`; a quarter turn gives `rotation: 90` with x, y, width, height
unchanged; the committed edit is `placement: { rotation: 90 }, before: { rotation: 0 }`; the handle follows the turned
box; Shift lands about 50 degrees on 45; Shift back upright gives 0.

## Files
- app/host/src/preview_edit.h, app/host/src/preview_edit.cpp (Mode::Rotate, rotate_handle, hit_rotate, patch_json)
- app/host/src/preview.cpp (draws the handle), app/host/src/main.cpp (Backend::apply takes the patch)
- app/host/tests/host-preview-edit.test.mjs, data/flags.json, docs/plan/2026-10-29-v1-decisions.md
