# 2026-11-08 Qt shell add-layer window (D274)

Status: build evidence. The window is user-opened only; clicking through it is UNVERIFIED at runtime (the headless
probe cannot open dialogs). The server route it calls has its own suite (D240).

## What changed
- `app/studio/src/main_window.cpp`: "Add layer..." in the "Edit scenes and layers" box (flag `scene-edit`) opens a
  Meld-style window: the layer kinds on the left (copy of layer, colour, text, capture device, overlay, image, video)
  with a one-line note on what each is; on the right a searchable list of what that kind can be made from (project
  layers, devices, overlays, stream-assets images and videos from `GET /ui/api/project/structure`), or a text field
  (text) / `#RRGGBB` field with a colour picker (colour). Add or a double-click sends the same
  `POST /ui/api/project/structure` `layer.add` as the add-layer row; the window closes after sending. Refused while
  live, like the row.
- The row and the window share one kind table (`kLayerKinds`), one choice list (`addChoices`) and one request
  builder (`layerAddBody`); the row's behaviour is unchanged.

## Build and tests
- `node app/studio/tools/build.mjs`: `built ...\ujwalam-studio.exe`, no errors or warnings.
- `node --test tests/studio-qt-shell.test.mjs`: 5 pass (row and panels unchanged after the refactor).
- `node tools/lint.mjs`: 0 findings.

## To check by hand
Flags `scene-edit` on. "Add layer..." opens the window. Pick Image, type part of a file name in Search: the list
narrows. Double-click a file: the layer appears in the scene and the window closes. Pick Colour, Pick colour...,
Add: a colour layer is added.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D274), this file
