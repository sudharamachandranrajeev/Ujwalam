# No console windows, no focus stealing (D191)

Date: 2026-11-03. Trigger: the user saw terminal windows "popping off here and there" while the project ran, taking focus.

## Causes found

| Cause | Fix |
|---|---|
| 125 child-process calls (Node `spawn`/`spawnSync`/`exec*`/`execFile*`, Python `subprocess.*`) in 62 files did not ask for a hidden window. A console program started from a parent without a console gets a new console window | `windowsHide: true` / `CREATE_NO_WINDOW` on every call; new lint rule `hidden-window` (tools/lint.mjs) |
| Host launched with `windowsHide: false` (app/host/lib/launch.mjs) | `windowsHide: true`; previews are the host's own windows and unaffected |
| Preview windows: `SW_SHOWNORMAL` + `SetForegroundWindow`, placed by Windows (main display) | `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`, `SW_SHOWNOACTIVATE`, `MA_NOACTIVATE`, raise with `SWP_NOACTIVATE`; laptop panel when it is not the main display, else first non-main display; refused with one display |
| Tests could open previews and the browser | `--headless` / `UJWALAM_HEADLESS=1`, set by `tools/ci.mjs` for every step; host refuses `preview.open`, launcher passes no `--preview` and opens no browser |
| A failed write in `tests/event-core-api-files.test.mjs` left its reader worker running: the test process lived 24 min and blocked the full CI | worker terminated in `finally` |

Only allowed visible child window: explorer for "Open folder", written `windowsHide: false // GUI window: <reason>` (the rule checks the reason is present).

## Outside the project (not fixed here)

- The 03:00 nightly backup scheduled task runs while the user is logged on and shows a console. Changing it needs the user's yes.
- Windows Terminal is the default terminal on this laptop. The agent's own shell tool calls created short-lived Windows Terminal windows that were foreground at the start of each call (hwnds 8327036 and 15008036, class `CASCADIA_HOSTING_WINDOW_CLASS`, gone seconds later; the user's terminal 2099100 stayed). Hidden-window requests may not be honoured when Windows Terminal is the default terminal (UNVERIFIED). Setting the default terminal to "Windows Console Host" is a user setting; not changed.

## Evidence

Commands run in the repo root with `UJWALAM_HEADLESS=1` (full CI was stopped after the hang above; a new full run is pending):

| Check | Result |
|---|---|
| `node app/host/tools/build.mjs` | built, 10 s |
| `node tools/lint.mjs` | 0 findings, 7.7 s |
| `node --test tests/lint.test.mjs tests/studio-ui-alpha.test.mjs tests/event-core-api-files.test.mjs tests/event-core-streamerbot-cli.test.mjs tests/ci.test.mjs tests/studio-ui-crash-recovery.test.mjs tests/studio-ui-live-test.test.mjs` | all pass after one fix (a spec test now passes `headless: false`), 44 s |
| `node --test app/host/tests/host-api.test.mjs` | 12/12, includes "headless: preview.open refuses with CONFLICT and no window exists" |
| `python -I -m unittest discover -s tests/py -t tests/py` | 177 run, OK (16 skipped) |
| `.venv` OCR set `test_g1*.py` | 59 run, OK |

Runtime check, real host, not headless, two displays (main: external, laptop panel at x=-1920):

```
open {"canvas":"H","open":true,"width":958,"height":532,"x":-1904,"y":16,"display":"laptop display \\.\DISPLAY1"}
open {"canvas":"V","open":true,"width":538,"height":952,"x":-572,"y":16,"display":"laptop display \\.\DISPLAY1"}
foreground before/after open and after raise: a Windows Terminal window each time, never a preview
stop 0
```

Both previews opened on the laptop panel, visible, and never became the foreground window. The foreground hwnd differed between samples only because of the transient terminal windows described above.

## Not done

- Previews are not click-through: they are operator windows (move, resize, close). Layered + transparent styles on a D3D swapchain window are untested.
- One-display refusal is code-reviewed only (this laptop has two displays).
