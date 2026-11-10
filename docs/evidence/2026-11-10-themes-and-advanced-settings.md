# 2026-11-10 Themes, High performance mode, Settings > Advanced offset fix

Branch `ui/themes-advanced` (from `claude/alpha0-d1` at 3d24224). User request, 2026-11-10: Settings > Advanced
opened "into an offset state"; the theme UI looked dated; Settings should offer a theme choice plus a High
performance variant with lighter memory use. The user supplied four third-party reference images in a local folder
outside the repo. They are not copied into the repo and are described here in words only.

## 1. Settings > Advanced opened offset (fixed, a3834b2)

**Root cause.** Settings borrows the main window's feature-flag list (`flagList_`, a `QListWidget`) for its
Advanced page. That list was a direct child of the main window. The preview slots set `WA_NativeWindow`, and Qt then
gives native handles to the siblings along the ancestor chain, so the flag list became a native child window
(`winId` set, `WA_NativeWindow` on) once the main window was shown. When Settings reparented it into the dialog, it
stayed a separate native window. It was positioned outside the dialog's layout, fade-in and DPI scaling, so it could
appear offset from the page.

**Fix.** `flagList_` now lives in a hidden holder widget (`flagHome_`). The holder takes the native handle when
Qt hands them out, and the list stays an alien (non-native) widget. Settings borrows the list and gives it back to
the holder when the dialog closes.

**Proof (headless probe).** The probe reports `settings.flagList` {native, nativeAttr, geometry, insideBox, scroll}.
Before the fix, the Advanced page reported `native: true`. After the fix it reports `native: false`,
`nativeAttr: false`, inside its box, at full width, scroll 0,0, on the first and on a second open. Regression test:
`tests/studio-qt-shell.test.mjs` "Settings > Advanced (2026-11-10 offset bug)".

## 2. Themes

The default theme `violet-night` is unchanged. Four themes were added as data in `data/themes/*.json` (embedded at
build time, like the existing ones). The names are generic. Each is a token set, not code.

| id | Name | Reference style (described in words) | Main tokens |
|---|---|---|---|
| `daylight-blue` | Daylight Blue | clean light office UI, white cards on pale grey, strong royal-blue primary | bg #eef1f5, panel #ffffff, text #111827, muted #4b5563, accent #0b4fd6 (hover #0a3fab); radius 4/8/16; button padding 6x14; solid background; soft shadows on cards, primary buttons, round controls, toasts, menus and the task panel; no glow |
| `copper-graphite` | Copper Graphite | dark graphite panels with a warm copper glow on active parts | bg #18191c, accent #d08b67 (hover #f0b99c), text on accent #1b1210; gradients on window, accent, panels and buttons; copper glow on primary buttons, toasts and the task panel, and on round controls when active; captions in capitals; radius 4/8/12 |
| `sand-teal` | Sand and Teal | soft beige neumorphic surfaces with a deep teal accent | bg #ebe3d7, accent #0f5257; panel and button gradients; cards have an offset warm shadow plus a light top glow (soft raised look); round controls extruded; radius 8/12/20 |
| `teal-grid` | Teal Grid | dark teal blueprint with a faint grid, cyan edges and a coral warning colour | bg #0b252b, accent #3fdce6, text on accent #03262b, danger #ff8069; grid background at 6 % opacity, 24 px; cyan glow on primary buttons, toasts, menus, the task panel and active round controls; Bahnschrift font |

New optional schema fields (`data/themes/theme.schema.json`): `gradients.panel`, `gradients.control` and
`geometry.controlPadding` {y 2-12, x 4-24}. Themes without them look as before. The new themes set no depth effect on
plain buttons (`depth.button: {}`), so the number of effect widgets does not grow with button count.

**Contrast.** `tests/studio-themes.test.mjs` checks WCAG AA (4.5:1) for text and muted text on the background,
panel and field colours, text on accent, and now also on both ends of the panel and button gradients. All five
themes pass.

## 3. High performance mode

`ui.effects` now takes `full | reduced | performance` (`services/studio-ui/user-settings.mjs`). Settings >
Appearance has a "High performance" check box. It applies live and is saved in the user data folder. In High
performance, for any theme:

- no depth effects (shadow, glow, extrusion): the `QGraphicsEffect`s are removed (as in Reduced)
- no hover glow overlays: they are deleted, and none are added to new widgets
- no gradients: window, accent, panel and button fills become flat colours (the stylesheet is rebuilt)
- no background pattern or gradient: the backdrop is not painted
- no animation: `motion::systemAnimations()` returns false

Switching back to Full re-adds the effects and overlays.

**Measurements.** Method: `UJWALAM_STUDIO_PROBE_BENCH=1`, offscreen platform, main window shown at 1600x900, one
fresh studio process per run, 3 runs per theme and mode, medians reported. `paintMs` = mean time of 100 renders of
the main window with Qt's caches kept; `paintWorstMs` = the same with the caches dropped before each render. Memory
from `K32GetProcessMemoryInfo` after the renders, in MiB. Scratch script `bench.mjs` (kept outside the repo).

| Theme | Mode | Depth widgets | Hover overlays | paintMs | paintWorstMs | Private working set | Working set | Private bytes |
|---|---|---|---|---|---|---|---|---|
| violet-night | full | 17 | 33 | 7.91 | 8.03 | 27.7 | 52.2 | 29.3 |
| violet-night | reduced | 0 | 33 | 5.05 | 4.96 | 26.3 | 50.8 | 28.1 |
| violet-night | performance | 0 | 0 | 4.42 | 4.45 | 25.8 | 50.3 | 27.7 |
| daylight-blue | full | 17 | 33 | 7.89 | 8.04 | 28.1 | 52.6 | 29.7 |
| daylight-blue | reduced | 0 | 33 | 4.72 | 4.86 | 26.4 | 50.9 | 28.4 |
| daylight-blue | performance | 0 | 0 | 4.60 | 4.62 | 25.9 | 50.3 | 27.7 |
| copper-graphite | full | 17 | 33 | 9.86 | 9.18 | 27.7 | 52.2 | 29.3 |
| copper-graphite | reduced | 0 | 33 | 6.52 | 6.46 | 26.5 | 51.0 | 28.3 |
| copper-graphite | performance | 0 | 0 | 4.69 | 4.70 | 25.6 | 50.1 | 27.4 |
| sand-teal | full | 17 | 33 | 10.74 | 10.52 | 28.1 | 52.6 | 29.7 |
| sand-teal | reduced | 0 | 33 | 5.40 | 5.57 | 26.6 | 51.1 | 28.4 |
| sand-teal | performance | 0 | 0 | 4.53 | 4.67 | 25.7 | 50.2 | 27.5 |
| teal-grid | full | 17 | 33 | 14.47 | 15.98 | 27.1 | 51.7 | 28.8 |
| teal-grid | reduced | 0 | 33 | 11.06 | 11.12 | 25.9 | 50.5 | 27.9 |
| teal-grid | performance | 0 | 0 | 4.69 | 4.72 | 25.0 | 49.5 | 26.9 |

Times in ms per render, memory in MiB, n = 3 runs each (all runs returned a result).

Summary of what was measured, High performance against Full of the same theme:

- Paint time per main-window render: 4.4-4.7 ms against 7.9-14.5 ms (about 42-68 % less). The largest saving is on
  `teal-grid`, whose grid backdrop is the most expensive part (Reduced still costs 11.1 ms there, because Reduced keeps
  the backdrop and gradients).
- Private working set: 1.5-2.4 MiB less (25.0-25.9 MiB against 27.1-28.1 MiB). Working set and private bytes fall by
  about the same amount. This is small: the studio shell itself is light, and most of its memory is Qt itself.
- Depth effect widgets: 17 to 0. Hover glow overlays: 33 to 0.

These are offscreen software-raster numbers on the development laptop. They show the relative cost of the effects,
not the on-screen GPU cost. Only the numbers above were measured; no other saving is claimed.

## 4. Settings theme picker

Settings > Appearance is now scrollable and shows one card per theme, 4 per row. Each card has a small drawing of
the window in that theme and a row of 8 colour swatches (background, panel, field, text, muted, accent, danger, ok).
A click applies the theme live, and the choice is saved as `ui.theme` in `settings.json` in the user data folder.

## Tests run

- `node --test tests/studio-qt-themes.test.mjs` (new: High performance drops effects, overlays and gradients;
  live switch between themes and back to Full; the Settings switch saves `ui.effects` and applies at the next start)
- `node --test tests/studio-themes.test.mjs tests/user-settings-theme.test.mjs`
- `node --test tests/studio-qt-shell.test.mjs` (Settings and flag tests, including the new offset test)

Results, 2026-11-10, `UJWALAM_HEADLESS=1`: themes + theme settings 33/33 pass; studio shell 50/50 pass. The full
`npm run ci` was not run by this task.

## Screenshots

Headless screenshots of the main window, Settings > Appearance, Settings > Advanced, the task panel and the Posts
dialog for a light theme (`daylight-blue`, `sand-teal`) and a dark theme (`copper-graphite`, `teal-grid`) were
taken and looked at. They are kept outside the repo (agent scratch folder), not committed.

What they showed: text, muted text, status words (Running, Waiting, Failed), Stop buttons, progress bars, flag
check boxes and the Save/Cancel buttons were readable in all four themes. No control was cut off. The Advanced flag
list sat inside its box, and the `teal-grid` grid shows faintly behind the Settings page. The Posts dialog uses the
theme's colours but keeps its older plain layout (unchanged by this task).

## Review fixes (second-opinion review, 2026-11-10)

1. **Settings deleted without closing.** The flag list went back to its holder only on `QDialog::finished`. A dialog
   deleted directly would have deleted the list with it, leaving `flagList_` dangling. Now the dialog's first child
   object (`OnDelete`) gives the list back before the dialog's other children are deleted. `flagList_` and
   `flagHome_` are `QPointer`s, so at app quit (the holder already gone) nothing dangles. Tests: probe action
   `settings-destroy` then reopen (failed before the fix, passes now); the app exits 0 with Settings > Advanced open.
2. **High performance off left "Reduce effects" ticked.** The user's Reduce choice is now remembered when High
   performance goes on and restored when it goes off. Test: on then off saves nothing (was "reduced"); with Reduce
   on first, on then off saves "reduced".
3. **Quick toggle lost the hover overlays.** Overlays dropped by High performance are deleted later; a switch back
   to Full in the same event-loop turn saw them as present and made no new ones. Dropped overlays are now renamed,
   hidden and unhooked at once. Test: probe action `effects:performance+full` (both in one turn); the overlay count
   is back to a fresh start's count (within 10 %). The test failed before the fix and passes now.

## UNVERIFIED

- The offset fix on the real screen: the offscreen grab paints the same before and after, so the proof is the
  native-handle state, not a picture. The user must open Settings > Advanced on the laptop.
- Real DPI scaling (125 % / 150 %) and the second display.
- How the four themes look to the user. They follow the references in style only; the user's visual judgement is
  needed.
- On-screen (GPU) memory and paint cost of each mode; the numbers above are offscreen.

## Files

- `app/studio/src/main_window.cpp`, `main_window.h` (flag list holder, probe fields and actions)
- `app/studio/src/theme.cpp`, `theme.h` (panel and button gradients, padding, performance mode)
- `app/studio/src/motion.cpp`, `motion.h` (no animation and no hover overlays in performance)
- `app/studio/src/interaction.cpp` (no backdrop paint in performance)
- `app/studio/src/appearance.cpp`, `appearance.h` (theme cards with swatches, High performance switch, scroll)
- `app/studio/src/depth.cpp`, `depth.h` (paint measure with or without caches)
- `app/studio/src/main.cpp` (bench: window size, memory; dialog screenshots)
- `data/themes/daylight-blue.json`, `copper-graphite.json`, `sand-teal.json`, `teal-grid.json` (new)
- `data/themes/theme.schema.json`
- `services/studio-ui/user-settings.mjs`
- `tests/studio-qt-shell.test.mjs`, `tests/studio-qt-themes.test.mjs`, `tests/studio-themes.test.mjs`,
  `tests/user-settings-theme.test.mjs`
- `docs/evidence/2026-11-10-themes-and-advanced-settings.md` (this file)
