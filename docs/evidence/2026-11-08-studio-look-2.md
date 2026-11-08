# 2026-11-08 Studio look 2: Look panel, settings sections, round controls (D290)

Request (user, 2026-11-08): in-app settings for rounded corners and other layer effects; a cleaner, modern UI after the
reference image. Status: tested headless with the fake host; the live path and the real host are UNVERIFIED (below).

## What changed
- **Look panel** (inspector, any layer with a placement, no flag): cards grouped by the `group` field of `fxTypes()`
  (Shape: rounded corners first, blinds, corner pin; Filters; Camera; Blend; Shadow & glow). Each card has an on/off
  switch and its sliders / colour pickers. Built from the table (`lookTypes()` in `main_window.cpp`), so entries added to
  `fxTypes()` appear with no further code; an unknown group is listed under its own name. Types the panel does not know
  and second copies of a type stay in the list untouched.
- **Sending**: offline, 250 ms after the last change the whole list goes through `layers.setEffects` (same route as the
  Advanced list: render-atomic in the host, saved into the project, undoable, autosave). One send at a time; a change made
  while one is on its way goes out right after it. **Live**: no automatic sends; an Apply button sends once and the server
  asks for "yes, on air" (existing confirm flow).
- **Flag `effect-editor`**: kept, but it now only shows the plain "Advanced effects" list under the Look panel. The
  server no longer gates `layers.setEffects` on it (it was the only thing stopping the Look panel). Description in
  `data/flags.json` updated. The live guard (`liveConfirm`) is unchanged.
- **Settings** is a window with sections: Clips (modes, match filter), Folders, Layer effects, Advanced. Layer effects has
  "Show layer effects from the scene (rounded corners, shadows, video buttons)": sets flag `layer-effects` through
  `/ui/api/flags/set` (typed "yes" confirm as before). Advanced has Animations (Follow Windows / Always on / Off) and the
  feature flags list, which is no longer on the main window (the hidden list widget is lent to the dialog while open).
- **Animations**: `settings.json` `ui.motion` = `system` | `on` | `off`, accepted by `services/studio-ui/user-settings.mjs`
  (separate delimited block), read at start and on save by `motion::setMode`. `UJWALAM_REDUCE_MOTION` still overrides.
- **Look of the window**: slim top toolbar (icon + label buttons, Qt-drawn icons in `icons.cpp`, no icon pack or font),
  scene list as cards (bold name, small upper-case caption, accent bar on the active one), upper-case muted captions,
  larger radii and padding, inspector as a compact grid (X Y Width Height in one row, crop boxes on request), controls
  (Start stream / Record / Save clip / Mark moment) as round buttons with captions and tooltips in a Controls card at the
  top of the right column; stats cards moved into the scrolling right column. Round mixer knobs were not done (strips
  only got larger radii): UNVERIFIED whether they are wanted.
- Fake host (`services/studio-ui/backends.mjs`) now stores `layers.setEffects` (listed by `layers.list`).

## Tests (run in this worktree)
- `node --test --test-concurrency=2 tests/studio-qt-shell.test.mjs`: 19 pass (6 new: Look panel switch and slider reach
  `layers.setEffects` with `{scene, layer, effects:[{type:'rounded',radius:40}]}`; switching off removes the effect and
  the Advanced list follows the flag; controls and flag list placement; Settings sections and the layer-effects item;
  layer-effects on needs the typed "yes" and turns the flag on, animations Off is written to `settings.json`; motion
  setting read at start and overridden by the environment). The 1600x900 shot test still passes.
- `tests/studio-ui-server.test.mjs tests/studio-tasks.test.mjs tests/record-clips.test.mjs tests/studio-ui-alpha.test.mjs
  tests/studio-ui-effects.test.mjs tests/studio-ui-flags-feedback.test.mjs`: 94 pass (new: `ui.motion` read, write and
  refusal in `record-clips.test.mjs`; `studio-ui-effects.test.mjs` now asserts no flag is needed).
- `node tools/lint.mjs`: 0 findings.

## Pictures (fake host data only, offscreen render of the hidden window, 1600x900)
- Before: the D287 shot (`final-panel.png` in the session scratchpad, not committed).
- After: `docs/evidence/2026-11-08-studio-look-2/main.png` (Look panel with rounded corners on),
  `settings-advanced.png`, `settings-layer-effects.png`.

## UNVERIFIED
- The Apply button and the "yes, on air" prompt in the Look panel while really live (server side is tested in
  `studio-ui-effects.test.mjs`; the Qt live state is not probed).
- Effects on the real host (fake host only here); the other agent's new effect types appear only after their merge.
- Motion on a real display; the layer-effects flag takes effect when the scenes are next built (flag text).
- How the new layout looks on the user's screen at 125% / 150% beyond the 1600x900 render.

## Files
`app/studio/src/{icons,look_panel}.{h,cpp}` (new), `main_window.{h,cpp}`, `main.cpp`, `motion.{h,cpp}`, `theme.cpp`,
`app/studio/CMakeLists.txt`, `services/studio-ui/{server,backends,user-settings}.mjs`, `data/flags.json`,
`tests/{studio-qt-shell,studio-ui-effects,record-clips}.test.mjs`, this file and its pictures.
