# 2026-11-08 Qt shell panel probe (D271)

Status: runtime test evidence (headless) for the Qt shell's loads, status polling and flag-driven panels. Clicks
and typed confirmations in the shell are still UNVERIFIED at runtime; their server routes have their own suites.

## What runs
`UJWALAM_HEADLESS=1` + `UJWALAM_STUDIO_PROBE_MS=<ms>` (tests only): the shell logs in to a real studio UI server
(fake host, fake bots, flags set in the server's flag store), builds its window on the offscreen platform without
ever showing it, runs `start()` (the first loads and the 2 s status poll), and after the given time prints one line
`studio probe: {json}` with what the panels show, then exits 0. No window appears.

## Test
`node --test tests/studio-qt-shell.test.mjs`: 5 pass (3 existing smoke tests + 2 new):
```
✔ defaults: every flag listed and off, flag-gated panels hidden, scenes and layers loaded (5055ms)
✔ flags on: structure, transitions, bots, report and posts appear; bots listed with their buttons (5060ms)
```
Probe with scene-edit, transitions, bot-manager, report-button and posting on (flags array left out):
```
studio probe: {"addLayerChoices":0,"botButtons":4,"layers":3,"live":false,"mixer":3,
 "note":"Transitions need a loaded project file.","scenes":3,
 "shown":{"bots":true,"posts":true,"report":true,"structure":true,"transitions":true},
 "transitionVideos":0,"undoEnabled":false}
```
This covers, at runtime: the flags panel lists every flag in `data/flags.json` with its state (D264); the structure
and transitions boxes follow their flags and report a missing project file (D265); the bots box lists both bots with
Start and Stop (D266); the report and posts buttons follow their flags (D269, D270); scenes, layers and mixer load;
undo is disabled on an empty history (D263).

## Not covered
Clicking the buttons, the typed confirm dialog, the effect editor form, the feedback, import and posts windows.

## Files
- `app/studio/src/main.cpp`, `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `tests/studio-qt-shell.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D271), this file
