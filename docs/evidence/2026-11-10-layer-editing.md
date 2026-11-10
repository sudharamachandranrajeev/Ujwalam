# 2026-11-10 — Layer editing: delete, move/resize/crop on the preview, drag reorder, shared slider (D330)

User feedback (2026-11-10): layer delete, resize and crop, and press-and-drag reordering in a scene were missing; the
sliders could only be dragged, not clicked to a value or typed into. Decision: D330 in
`docs/plan/2026-10-29-v1-decisions.md`. Branch `ui/layer-editing`.

Status: test evidence only (headless). Real mouse use on a shown window is UNVERIFIED until the user tries it.

## Audit (what already existed)

| Item | Before | After (D330) |
|---|---|---|
| Delete layer | menu item and Del key, behind flag `scene-edit` (off) | no flag; trash button in the Layers header; still asks; refused while live |
| Move / resize on the preview | host editor (`app/host/src/preview_edit.*`): select, move, corner resize (aspect kept, Shift free), rotate, snapping, behind flag `preview-edit` (off) | flag on by default; edge handles stretch one side; hover cursors |
| Crop | Alt + edge drag on the preview (D256); four boxes in the inspector behind a "Crop" toggle; `placements.<canvas>.crop` in the project | boxes always shown; no schema change or migration needed |
| Reorder | Move up/down buttons and menu: host-only `layers.move` (not saved) | press-and-drag in the layer list; buttons, menu and drag save through structure `layer.move` (`target` + `place`); live: host-only move with "yes, on air" as before |
| Sliders | plain `QSlider` + spin box (Look), mixer volume sent only on release | shared `ValueSlider`: click jumps, typed value + Enter, arrows/PageUp/PageDown/Home/End, wheel only with focus |

## Design choice: where the preview interaction lives

Hit-testing and dragging run in the host process, in the native preview window's window procedure
(`pedit::Editor`). During a drag the host applies the placement directly (`Studio::layer_set_placement`) on every mouse
move, so the picture follows the mouse at render rate with no RPC round trip or throttling. On release the editor
records one edit; the studio reads it (`preview.edits`) and project-sync saves it. The live-lock check
(`Backend::locked`) is in the same place: while any output is live a press selects nothing.

## Tests

Host (`app/host/tests/host-preview-edit.test.mjs`, 12/12 pass): new test "edge handle stretches that side alone":
hover cursors per handle, right edge changes width only, bottom edge height only, left edge snaps to 0, minimum 1 px,
4 recorded edits; the Alt+edge crop test still passes (a plain edge press is now a resize).

Server and project (`tests/project-structure.test.mjs` 15/15, `tests/flags.test.mjs`,
`tests/studio-ui-preview-edit.test.mjs`, `tests/studio-ui-flags-feedback.test.mjs`): `moveLayer` to a target above or
below with its errors; `layer.remove` and `layer.move` accepted with the scene-edit flag off; both refused while live
(`live-locked`); `scene.remove` still needs the flag; `preview-edit` on by default and named in D330.

Studio Qt, headless (`tests/studio-qt-shell.test.mjs`, `UJWALAM_HEADLESS=1`, offscreen; new and changed tests):
- press-and-drag in the layer list: two drags save the order `chat, cam, game` (bottom first) in the project file and
  call `layers.orderFromProject` twice; without a project file the drag uses the live-only `layers.move`;
- trash button: "No" keeps the layer, "Yes" removes it from host and project with the flag off; while live it is
  greyed with "Not while live" and nothing is sent;
- menu Delete works with the flag off and still asks; Move to top/bottom save into the project;
- Look slider: a click on the track jumps far along it, typed 12 + Enter sets 12, Right steps to 13; each reaches
  `layers.setEffects`;
- volume slider: a wheel without focus sends nothing; a click at a quarter sends -45 dB once on release; typed -6
  sends -6; two wheel notches with focus send -12 (3 steps a notch, the Windows default).

## Runs (2026-11-10)

- `node --test tests/studio-qt-shell.test.mjs tests/project-structure.test.mjs tests/flags.test.mjs tests/studio-ui-preview-edit.test.mjs`:
  83 tests, 81 pass, 2 fail. The 2 failures were the D292 add-button tests, whose exact `addButtons` object did not
  yet list the new trash button. After the fix, `--test-name-pattern="D292"`: 14/14 pass. The D330 tests:
  `--test-name-pattern="D330"`: 8/8 pass.
- `node app/host/tools/build.mjs` + `node --test app/host/tests/host-preview-edit.test.mjs`: 12/12 pass.
- `node app/studio/tools/build.mjs`: builds with no warnings (/W4).

## Headless pictures (not committed, %TEMP% only)

- `%TEMP%\ujw-d330-layers-inspector.png` — trash button next to +, inspector with the
  crop boxes shown, mixer strips with the shared slider and dB box.
- `%TEMP%\ujw-d330-look-slider.png` — Rounded corners on, radius typed as 24.

## Not done / UNVERIFIED

- Real mouse use on a shown window (drag feel, cursors, hold-to-pick-up delay): UNVERIFIED.
- Alt + corner crop is not implemented; crop is by Alt + edge or the inspector boxes.
- The web control page (`ui/js/app.js`) still hides layer remove behind the scene-edit flag.
- A delete cannot be undone (structure edits clear the history, D240); the confirm is the guard.
