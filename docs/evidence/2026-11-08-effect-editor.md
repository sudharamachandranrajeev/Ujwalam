# 2026-11-08 Effect editor (D260)

Status: host and UI server test evidence. The Qt inspector panel builds (`node app/studio/tools/build.mjs`) but has
no runtime test: UNVERIFIED until the user opens it with flag `effect-editor` on.

## Host
`node --test app/host/tests/host-project.test.mjs`: 17 pass, including
`✔ layers.setEffects replaces the effects live, keeps place, order and visibility; refusals change nothing (D260)`.
A blur of strength 500, an unknown layer and a canvas field are refused and the effects stay as they were; an empty
list removes a corner pin (the whole box shows red, both top corners included); a toner replaces the other pin (the
whole box green); order, placement and visibility are unchanged; the background is untouched.

## UI server
`node --test tests/studio-ui-effects.test.mjs`: 2 pass. Flag off (default): 404 `effect-editor-off`, host not called,
status `effectEditing` false. Flag on: the whole list reaches the host without a canvas, is saved into the project
file, undo restores the empty list (effects removed from the file), redo applies it again. Refused before the host:
a string, a number in the list, an object without type, 7 effects, a list over 4 KB, a canvas field. While live:
"yes, on air" first, host not called before it, saved after it. Existing UI server suites (undo, server,
preview-edit, nudge, flags) still pass.

## Files
app/host/src/studio.cpp, app/host/src/studio.h, app/host/src/methods.cpp, services/studio-ui/server.mjs,
services/studio-ui/project-sync.mjs, services/studio-ui/edit-history.mjs, data/flags.json,
app/studio/src/main_window.cpp, app/studio/src/main_window.h, tests/studio-ui-effects.test.mjs (new),
app/host/tests/host-project.test.mjs, docs/plan/2026-10-29-v1-decisions.md.
