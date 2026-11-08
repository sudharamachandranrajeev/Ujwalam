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

## Codex review (second opinion, read-only, medium effort; diff 6ca0501..835b567 on stdin)

| # | Finding | Result |
|---|---|---|
| 1 (high) | The live swap was not render-atomic: the renderer could see a duplicate, missing or misplaced layer between steps. | Fixed: new items are staged hidden and placed; per scene, one `obs_scene_atomic_update` puts the new item in the old one's place in the order, shows it and hides the old one; the hidden old items are removed after. |
| 2 (high) | A failure on the second canvas left the first one changed. | Fixed: every canvas is staged before any commit; a staging failure removes all staged items and wrappers; the commit has no failing step. |
| 3 (medium) | Singular or non-convex corner pins fell back to a different quad (e.g. the full rectangle). | Fixed: host (model.cpp), validator (`convexQuad`) and Meld import refuse or report corners that are not a convex quad (each turn the same way, cross product at least 1e-6). Tests: bow-tie and dented quad refused by host and validator; a bow-tie Meld pin is reported, not imported. |
| 4 (medium) | The shader's w test depended on the unnormalised inverse's scale. | Fixed: the inverse is scaled so its largest entry is 1; the shader tests only w <= 0. |
| 5 (medium) | Qt: a late Apply answer could clear newer unsent edits. | Fixed: the draft carries a revision and its scene/layer key; only a matching answer marks it sent. |

After the fixes: host project tests 17 pass, import/schema/effect-editor server tests 113 pass, host and Qt shell build.
