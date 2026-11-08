# Layer and scene context menus, duplicate, rename, add (D292, proposed)

Date: 2026-11-08. Branch `ui/layer-menu` (from `claude/alpha0-d1` @d7dba5f). Everything below is UNVERIFIED on a real
host, a real display and a live stream: the tests use the fake host, a headless (offscreen) Qt window and no mouse.

## What was built

Server (`services/studio-ui/server.mjs`, `services/project/structure.mjs`):

- New structure ops `layer.duplicate`, `layer.rename`, `scene.duplicate`, `scene.rename`. Pure project changes, always checked with `validateProject`.
- Flag decision: `scene.add`, `layer.add` and the four new ops work **without** the `scene-edit` flag (they lose nothing). Still refused while live (fresh `host.status`, fail closed). `scene.remove`, `layer.remove` and `layer.move` (project-file move) stay behind `scene-edit`. `GET /ui/api/project/structure` no longer needs the flag for its choice lists (it now also returns `canvases`).
- `layer.duplicate`: new id `<id>-copy`, `-copy-2`, ... (cut to 64 characters), name `<name> copy`, `copy 2`, ... (unique in the scene), inserted directly above the source. Colour, text, image, media and browser (overlay) layers are deep copies (settings, placements for every canvas, visibility, effects). Applied to the host with `layers.addFromProject` and then `layers.orderFromProject`.
- Device layers: a `capture` layer cannot be opened twice (one device, one open source), so its copy is a `duplicate`-type layer that shows the same open source (the existing "add existing" mechanism the host already supports); a copy of a `duplicate` layer points at the same real layer. Devices, overlays and asset files are referenced, never cloned.
- `layer.rename` / `scene.rename`: trimmed, 1-80 characters. The host has no rename call, so the server saves the name into the project file and keeps a name overlay on `layers.list` / `scenes.list` replies until the host next loads the project. UNVERIFIED against the real host (the overlay is covered by a server test with a mock host).
- `scene.duplicate`: new id `<id>-copy`, name `<name> copy`, inserted right after the source; every layer copied with a new id and its own name, same rules as `layer.duplicate`; the host gets `scenes.create` per canvas and then `layers.addFromProject` per layer, bottom first.
- Undo: structure edits still clear the history (unchanged). Duplicate is not made undoable.
- Fake host (`services/studio-ui/backends.mjs`): `scenes.create`, `scenes.remove`, `layers.addFromProject`, `layers.orderFromProject`, `layers.remove`.

Qt (`app/studio/src/main_window.*`, new `add_dialogs.*`):

- Right-click menu on the layer list: Add layer..., Duplicate (Ctrl+D), Rename... (F2), Show/Hide, Move up, Move down, Move to top, Move to bottom, Copy look (Ctrl+Shift+C), Paste look (Ctrl+Shift+V), Look..., Delete... (Del, asks first, needs scene editing on). Right-click on empty space: Add layer only.
- Right-click menu on the scene list: Add scene..., Add layer... (to that scene), Rename... (F2), Duplicate scene, Delete... (Del, asks first, needs scene editing on, not for the start scene). Right-click on empty space: Add scene only.
- The keys are `QShortcut`s on the two lists (widget context): active only while the list has focus.
- Items needing the project file are greyed while live with the tip "Not while live"; Delete is greyed with "Turn on scene editing in Settings > Advanced" when the flag is off. Show/Hide and Move keep their old live confirm; Paste look goes through the Look panel's `layers.setEffects` send (so "yes, on air" while live).
- A **+** button above the scene list (Add scene) and the layer list (Add layer), greyed with "Not while live" while live.
- `AddLayerDialog` / `AddSceneDialog` (non-modal, never take focus from the main window on their own; opened only by the user): kinds the project cannot supply are greyed with the reason; colour is checked as `#RRGGBB` in the window; a layer added is selected.
- Look and feel of the new widgets (`add_dialogs.cpp`): focus ring, pressed and disabled states (local stylesheet from `theme.h` tokens; `theme.cpp` untouched), app-wide hover glow already covers buttons, a fade-in (140 ms) and a 96 to 100 percent grow on windows, a fade-out (110 ms) on close; menus fade in. All through `motion::run`, so they follow the motion setting (instant when off). Menus close without a fade (Qt closes popups itself).
- Lock: the project schema has `locked`, but the host ignores it (parsed only), so there is no Lock item. The preview has no layer selection in the Qt window (selection is in the host's native preview), so the menu is on the list only.
- Plain error words for the structure route's short codes (`plainStructureError`).

## Tests

(see the command block below for the counts)

- `tests/project-structure.test.mjs`: pure ops (ids, names, order, deep copy, schema valid, capture and duplicate copies, bad names, unknown ids, 64-character ids) and the server (flag off still works, add/duplicate/rename/scene.duplicate, remove and move need the flag, live refused, host order add then order, a host refusal saves nothing, rename overlay on host lists).
- `tests/studio-qt-shell.test.mjs`: headless probe. Real menus are built (not shown) and an item is triggered as a click would; dialogs are driven through their widgets. Covers menu items, keys, tips, duplicate (order, saved file, selection), rename, move to top/bottom, show/hide, copy and paste look, delete with No and Yes, scene duplicate and rename and delete, add buttons, Add layer (text, camera, colour check), Add scene, add items in both menus, and the live state.

## Commands and results

```
node app/studio/tools/build.mjs
    -> built out/studio/build/ujwalam-studio.exe (no warnings)
node --test --test-concurrency=2 tests/studio-qt-shell.test.mjs tests/studio-ui-server.test.mjs tests/project-structure.test.mjs
    -> tests 77, pass 77, fail 0
       (new in this branch: 5 tests in project-structure, 15 probe tests in studio-qt-shell)
node --test --test-concurrency=2 tests/studio-ui-*.test.mjs tests/project-*.test.mjs
    -> tests 321, pass 321, fail 0
node tools/lint.mjs
    -> lint: 0 finding(s)
```

## UNVERIFIED

- A real mouse right-click, the visual look of the menus and the fade (no screenshot taken; headless offscreen).
- The real host: `layers.addFromProject` of a `duplicate`-type layer from a capture layer is the same path "Add existing" already uses (D240), but a duplicate of a real camera was not tried.
- Real host name after `layer.rename` before a reload (the overlay is a server-side workaround).
- Key shortcuts through real key presses (tests check that they are registered on the lists).
