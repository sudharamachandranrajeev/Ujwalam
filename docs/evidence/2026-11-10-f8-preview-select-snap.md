# 2026-11-10 F8 / F9 / F10 preview mouse editing: list selection, coalesced drags, snap setting (D335)

Branch `ui/layer-move-fix` (from `claude/alpha0-d1` at f55a43d). User bug report 2026-11-10 (alpha.21): "while a
layer is selected from the layers that layer needs to move. now some other layer is moving. hovering and resizing
needs to optimised. snapping to the edge of preview should an an option that user could turn on in settings as well."
Decision record: D335 in `docs/plan/2026-10-29-v1-decisions.md`.

Status: tests and headless simulation only (`preview.editSim`, Qt probe). Real-mouse feel, the drawn handle sizes at
125 / 150 % and use on a real stream are UNVERIFIED.

## What changed

- **F8, list selection drives the preview** (`app/host/src/preview_edit.*`, `methods.cpp`): new RPC
  `preview.select {canvas, layer|null}` sets the host's selection for that canvas. A press inside the selected layer
  grabs it even when another layer is on top (OBS order: selected layer first, then topmost). A press outside it
  selects the topmost there. Refused with CONFLICT while editing is off, live-locked or a drag is active; INVALID_PARAMS
  for a hidden, unknown or placement-less layer. `host.status` carries `previewSelection {seq, H, V}`; `seq` moves only
  when a preview click changes the selection, so the studio follows the preview without echoing back.
- **Studio** (`app/studio/src/main_window.*`): the layer list sends `preview.select` once per canvas/scene/layer key
  when the selection changes (nothing while editing is off). When `previewSelection.seq` moves, the list row follows
  with signals blocked (no echo). UI server allows `preview.select` (schema: canvas h|v, layer id) and passes the two
  new status fields through.
- **F9, drags coalesced** (`preview_edit.cpp`, `preview.cpp`): the drawn box follows every mouse move; libobs gets the
  newest rectangle at most once per 16 ms (first move past the threshold at once, then a 16 ms Win32 timer flushes the
  pending point). Release applies the final rectangle and records one edit. Escape / lost capture puts the start
  rectangle back. Handle hit sizes, the rotate offset, the drag threshold and the snap tolerance scale by window DPI
  (`GetDpiForWindow`); the drawn handles use the same factor.
- **F10, snap setting** (`services/studio-ui/user-settings.mjs`, `server.mjs`, Qt Settings): new page Settings > Preview,
  switch row "Snap to preview edges and other layers" with visible ON / OFF text and an explanation, default OFF,
  part of the Settings draft (Save changes / Discard / Cancel, D332). Stored as `settings.json` `ui.snap` (boolean,
  anything else 400). The UI server keeps the host's `preview.setSnap` equal to it, also after a host restart. Off:
  the layer lands exactly where it is dropped. On: D272 snapping (canvas edges, other layers' edges and centres), Alt
  turns it off for that drag. The host starts with snapping off.

## Commands and results (UJWALAM_HEADLESS=1, 2026-11-10)

| Command | Result |
|---|---|
| `npm run lint` | 0 findings |
| `npm run build:host` | built `out/host/build/ujwalam-host.exe` (only the existing C4996 deprecation warnings) |
| `npm run build:studio` | built `out/studio/build/ujwalam-studio.exe` |
| `node --test app/host/tests/host-preview-edit.test.mjs` | 17 / 17 pass (5 new: F8 select, F8 validation, F10 snap off/on, F9 coalescing, F9 DPI) |
| `node --test tests/studio-ui-preview-edit.test.mjs` | 6 / 6 pass, 3 runs in a row (2 new: snap follows `ui.snap`, `preview.select` passthrough) |
| `node --test tests/studio-qt-shell.test.mjs` | 66 / 66 pass (new: Settings > Preview snap draft/save, list selection sent once, host click followed without echo) |
| `node --test tests/user-settings-theme.test.mjs tests/user-settings-match-gate.test.mjs tests/studio-ui-server.test.mjs tests/guide.test.mjs` | 54 / 54 pass |

`npm run build` does not exist in this repo; build:host and build:studio were run instead. The full CI was not run
(brief: affected tests only).

## F9 timing (preview.editSim, 200 moves of one drag, real libobs placement calls)

| Mode | libobs applies | elapsed |
|---|---|---|
| apply on every move (`applyEveryMs: 0`, old behaviour) | 197 | 1.8 ms |
| coalesced, 16 ms | 2 | 0.5 ms |

Both end at the same final x (500). The simulated moves arrive within a few ms, so the coalesced run applies twice
(first move, release). In a real drag at about 60 Hz this is about one apply per frame instead of one per mouse
message (high-rate mice send 500 to 1000 per second). The time per apply on a busy scene is UNVERIFIED.

## DPI check (preview.editSim `dpi`)

Point 14 logical px outside the corner of the selected box: at 96 DPI it is plain canvas (`bg`, move); at 120 and
144 DPI it hits the corner handle (`resize`, cursor nwse), because the handle grows with the scale. A DPI below 96
is refused. The drawn handles at 125 / 150 % are UNVERIFIED (no windows in tests).

## UNVERIFIED

- Real mouse: selecting in the list and dragging under another layer, hover cursor and resize feel.
- Drawn handle size and spacing on a 125 % / 150 % display.
- Snap on/off with the real Settings dialog on the laptop.
- Use on a real stream (live feature rule).

## Not done

- A snap distance setting (the triage row mentions px). The tolerance stays the D272 fixed value (DPI scaled).
