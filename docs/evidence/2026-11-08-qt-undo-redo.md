# 2026-11-08 Qt shell undo/redo (D263)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user presses Undo, Redo,
Ctrl+Z or Ctrl+Y in the studio window.

## Build
`node app/studio/tools/build.mjs`: `[5/5] Linking CXX executable ujwalam-studio.exe`, no warnings from
`src/main_window.cpp`.

## Behaviour (server side already tested)
The buttons and shortcuts post to `/ui/api/edits/undo` and `/ui/api/edits/redo`, the routes covered by the existing UI
server undo suite and `tests/studio-ui-effects.test.mjs` (undo/redo of effects). The shell adds no undo logic
of its own: it shows the reply (`Undone: <method> <layer>` or the refusal code), reloads the layer list and the
history state. Buttons are disabled while live (the server refuses undo then, D238), while a call is in flight and
when `GET /ui/api/edits` reports an empty stack; tooltips show `nextUndo` / `nextRedo`.

## To check by hand
1. Turn on any edit flag, move a layer in the inspector, press Ctrl+Z: the layer returns, the note says `Undone: ...`.
2. Ctrl+Y: the move comes back.
3. With focus in a number field, Ctrl+Z undoes the typing in that field only.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D263), this file
