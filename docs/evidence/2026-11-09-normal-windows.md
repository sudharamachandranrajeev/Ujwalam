# Normal windows (D316, 2026-11-09)

Branch ui/normal-windows (worktree `.claude/worktrees/normal-windows`, from claude/alpha0-d1 at 98e1e89).

D316 (user): the second-display / no-focus window rule is dropped. Kept unchanged: no console window for any child
process (`windowsHide`, `CREATE_NO_WINDOW`, the `hidden-window` lint, `ujwalam-start.exe`) and headless tests
(`UJWALAM_HEADLESS=1`: no window ever appears).

## What changed

| Part | Before | Now |
|---|---|---|
| Studio window (app/studio/src/main.cpp) | moved to the second screen when there was one; `WA_ShowWithoutActivating` | shown where Windows places it (main display), then `raise()` + `activateWindow()` like any app the user starts. No saved placement exists yet, so there is nothing to restore. |
| Studio window back from the tray (main_window.cpp `leaveTray`) | shown without activation | shown, raised and activated (the user asked for it); headless still shows nothing |
| Stand-alone host preview (app/host/src/preview.cpp) | refused with one display ("no preview: one display"); second display only; `WS_EX_NOACTIVATE \| WS_EX_TOOLWINDOW`; `SW_SHOWNOACTIVATE`; clicks never activate | opens with any number of displays, on the main display; normal window (taskbar entry), `SW_SHOWNORMAL` + `SetForegroundWindow`; a click activates it; a given x/y is kept when it lies on any display, else clamped into the main display's work area; `preview.focus` restores and brings it to the front |
| Embedded preview (studio slot) | `WS_CHILD`, `WS_EX_NOACTIVATE`, clicks leave activation alone | unchanged; `preview.focus` on it only reorders it among its siblings |
| Headless | refuses every preview with CONFLICT | unchanged (checked before the embedded path) |
| Host log line (app/host/src/main.cpp) | `previews: on (second display only, never take focus)` | `previews: on (normal windows, main display)` |
| Launcher (services/studio-ui/launch.mjs) | comment and fallback text "second display" | comment cites D316; fallback text "main display" |
| Tray task list (tray.cpp) | tool window without activation (D191) | code unchanged (it works); comment says it is kept as a design choice, D316 dropped the hard rule |
| Comments | D191 / D219 cited for focus and placement in preview.h, main_window.h, coach.h, hints.h | cite D316; console-window D191 comments untouched |

## Tests (all with UJWALAM_HEADLESS=1; no window appeared)

| Command | Result |
|---|---|
| `node app/host/tools/build.mjs` | built `out/host/build/ujwalam-host.exe` |
| `node app/studio/tools/build.mjs` | built `out/studio/build/ujwalam-studio.exe` |
| `npm run test:host` | tests 143, pass 133, fail 0, skipped 10 (face tests need `.venv-gpu`, not linked in the worktree; two benches need their env flag). Includes `headless: preview.open refuses with CONFLICT and no window exists`. |
| `node --test tests/studio-qt-shell.test.mjs tests/studio-tray.test.mjs tests/normal-windows.test.mjs tests/studio-ui-alpha.test.mjs` | tests 103, pass 102, fail 0, skipped 1 (face worker: no `.venv-gpu`) |
| `node tools/ci.mjs --quick` | 9/9 passed (build, lint incl. hidden-window, build-host, build-studio, validators, private-scan, legacy-verify) |

New test: `tests/normal-windows.test.mjs` (5 source checks): no one-display refusal or second-display pick in
preview.cpp; a stand-alone preview has no NOACTIVATE / TOOLWINDOW / SHOWNOACTIVATE and shows with SW_SHOWNORMAL;
headless refusal comes before the embedded path and embedded previews stay `WS_CHILD | WS_CLIPSIBLINGS` with
`MA_NOACTIVATE`; the host log line and launcher text name the main display; the studio window has no second-screen
move, no `WA_ShowWithoutActivating` outside the headless offscreen probe, and is raised and activated (also when it
comes back from the tray). No existing test asserted the old second-display behaviour, so none needed changing.

## UNVERIFIED

- Real on-screen behaviour: the studio window opening activated on the main display, a stand-alone preview opening
  on a one-display laptop, taking focus on a click, and `preview.focus` bringing it to the front. No window was
  opened during this work (tests are headless). Needs a manual start of Ujwalam on the laptop.
- `SetForegroundWindow` from the host (a background process) may be refused by Windows' foreground lock; the window
  is then shown and raised but may flash in the taskbar instead of taking focus.

## Files changed

- app/host/src/preview.cpp
- app/host/src/preview.h
- app/host/src/main.cpp
- app/studio/src/main.cpp
- app/studio/src/main_window.cpp
- app/studio/src/main_window.h
- app/studio/src/tray.cpp (comment only)
- app/studio/src/coach.h (comment only)
- app/studio/src/hints.h (comment only)
- services/studio-ui/launch.mjs
- tests/normal-windows.test.mjs (new)
- docs/evidence/2026-11-09-normal-windows.md (new)

Worktree setup: junctions for legacy, node_modules, .venv, app/spike/build to the main checkout; copied
app/host/host.local.json, app/studio/studio.local.json, data/profile.local.json (all gitignored).
