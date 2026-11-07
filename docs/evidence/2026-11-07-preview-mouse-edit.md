# 2026-11-07 Preview mouse editing (P5, D230)

Result: **PASS** for the headless logic (hit test, drag maths, snapping, commit, edit log, flag switch, autosave).
**UNVERIFIED**: real mouse use on the user's screen (the window procedure, drawing of the selection box and handles,
capture). The feature ships behind flag `preview-edit` (default off), so it is "awaiting user test", not done.

Design: `docs/plan/2026-11-06-p5a-qt-shell-plan.md` "Editing on the preview". Code: `app/host/src/preview_edit.{h,cpp}`
(pure geometry + `pedit::Editor`), `app/host/src/preview.cpp` (window procedure, `draw_cb` overlay),
`Studio::preview_items`, RPCs in `app/host/src/methods.cpp`, UI server sync in `services/studio-ui/server.mjs`.

## What it does

- Click in a preview selects the topmost visible layer of that canvas (project v1 placements; rotation undone for the
  hit test; hidden layers skipped). A click on the letterbox clears the selection. One selection per canvas.
- Drag inside the selected box moves it; a corner handle (8 screen px) resizes it with the aspect ratio kept (Shift:
  free) while the opposite corner stays fixed (also for turned layers). Moves snap the box's edges and centre to the
  canvas edges and centre within 8 screen px; resizes of unturned layers snap the dragged corner (Alt: no snap).
  A 3 screen px drag threshold means a click never moves or snaps a layer.
- Selection outline + 4 corner handles are drawn in `draw_cb` after the canvas texture, in canvas coordinates sized
  by canvas px per screen px (2 px light line over a 4 px dark rim, constant on screen).
- Every mouse move applies through `Studio::layer_set_placement` (same function as RPC `layers.setPlacement`); the
  release records ONE edit `{seq, canvas, scene, layer, placement{x,y,width,height}}` (last 64 kept).
- Lost capture (or the window closing) mid-drag puts the layer back where the drag began; no edit.

## Notify / save path

The host has no push channel to the UI server, and the UI server already polls `host.status` every second. So:

- `host.status` gains `previewEditing` (bool) and `previewEditSeq` (int).
- When the seq moves, the UI server calls `preview.edits {since}` and records each edit with
  `projectSync.record('layers.setPlacement', {scene, canvas, layer, placement})`: the same autosave as an inspector
  edit (D223). The first poll only notes the seq (no replay over newer saves after a UI server restart); a lower seq
  (host restart) reads from 0.
- The status snapshot carries `host.previewEdit {seq, scene, canvas, layer}`, and an SSE `layers` event is sent; the
  web page and the Qt shell select that layer and reload the layer list + inspector.
- Only the UI server (already the host-token holder) calls these methods; no browser layer or page gets a token.

## Flag

`data/flags.json` `preview-edit`, default false. The host starts with editing off. The UI server compares
`previewEditing` with the flag on every poll and calls `preview.setEditing {enabled}` when they differ (a restarted
host is switched on again within a second); switching the flag from the control page also calls it at once. Off
clears every selection and makes the window procedure ignore the mouse (falls through to `DefWindowProc`).

## Live-lock finding

`layers.setPlacement` has no live gate: `methods.cpp` says the host does not gate (one gate, in the UI server), and the
UI server's `HOST_CALLS['layers.setPlacement']` has no `confirm`; only stream/record start/stop, flags on, bots and
project load ask for "yes" / "yes, on air". The inspector therefore edits while live without a phrase, and the mouse
path, which calls the same `layer_set_placement`, behaves the same: no bypass is created and no new gate is added.
This differs from the AGENTS.md wording "Studio writes need yes; while live, yes, on air" for layer edits; reported
to the main session as an open question (gate placement edits while live, for both paths, or keep them free).

## Commands and output

Build (no ujwalam-host.exe or ujwalam-studio.exe was running):

```
node app/host/tools/build.mjs
built C:\AI\Claude\Ujwalam\out\host\build\ujwalam-host.exe
node app/studio/tools/build.mjs
built C:\AI\Claude\Ujwalam\out\studio\build\ujwalam-studio.exe
```

Host, headless (`preview.editSim` with `--test-hooks` runs the window procedure's editor calls without a window):

```
UJWALAM_HEADLESS=1 node --test app/host/tests/host-preview-edit.test.mjs
✔ flag off by default: no selection, no edit; test-format project: nothing to select
✔ click selects the topmost visible layer (rotation respected, hidden skipped); empty canvas clears
✔ drag moves, snaps to the canvas edge (Alt: no snap), commits once through setPlacement
✔ corner drag resizes with the aspect kept (Shift: free); the opposite corner stays put
✔ lost capture puts the layer back; switching the flag off clears the selection and ignores the mouse
✔ bad input is refused
ℹ tests 6  ℹ pass 6  ℹ fail 0
```

Checked values (canvas 1280x720 in a 640x400 client: scale 0.5, letterbox 20 px): box (100,100,200x100) dragged +100,+50
-> (200,150) with one edit `{seq 1, canvas H, scene main, layer box}`; V placement unchanged; left edge to 10 px ->
snapped to 0, with Alt stays 10; bottom-right resize to x 300 -> 300x150 (2:1 kept), Shift -> 400x150; top-left
resize keeps right/bottom edges at 400/300; a layer turned 90 degrees is hit at (700,430) and missed at (780,350);
clicking it does not move it although its centre is 10 px from the snap line.

UI server (stub host of kind `host`, real flags and real project-sync on a temp copy of the sample project):

```
node --test tests/studio-ui-preview-edit.test.mjs
✔ flag off by default: the host stays off; on: switched on; a restarted host is switched on again; off again
✔ host-committed edits are saved into the project file (once each); edits from before the server started are not replayed
✔ the status snapshot names the newest host edit (Qt shell / page refresh their layer list from it)
ℹ tests 3  ℹ pass 3  ℹ fail 0
```

Regression runs:

```
UJWALAM_HEADLESS=1 node --test tests/studio-ui*.test.mjs tests/flags.test.mjs tests/studio-project-sync.test.mjs
ℹ tests 124  ℹ pass 124  ℹ fail 0
UJWALAM_HEADLESS=1 node --test app/host/tests/host-preview-edit.test.mjs app/host/tests/host-project.test.mjs app/host/tests/host-studio-launch.test.mjs
ℹ tests 23  ℹ pass 23  ℹ fail 0
UJWALAM_HEADLESS=1 node --test app/host/tests/host-api.test.mjs
ℹ tests 16  ℹ pass 16  ℹ fail 0
```

## Not checked / open

- UNVERIFIED: real mouse on the embedded preview and on a pop-out preview; the drawn box/handles; SetCapture on the
  no-activate child window keeping focus where it was (D191). Next: the user turns on `preview-edit` and tries it.
- A full-canvas layer on top (for example a transparent overlay page) is what a click hits first, as in OBS; layers
  below it can then only be selected from the layer list. A "click again to pick the layer below" or lock option is
  not built.
- No hover cursor change, no arrow keys (the preview never has focus), no crop/rotate handles, no undo.
- The drag holds the Studio lock briefly per mouse move on the preview UI thread; a long `project.load` makes the
  drag pause until it ends (no deadlock path: Studio never calls into the previews).
