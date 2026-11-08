# 2026-11-08 Qt shell probe actions (D275)

Status: runtime test evidence (headless) that clicks on the Qt shell's own widgets reach the UI server and the host.
Typed confirm dialogs: runtime evidence since D279 (actions `flag-on`, `type`, `cancel`; see below). The "yes, on air"
phrase while live is covered by the server tests, not by a shell probe.

## What runs
With `UJWALAM_STUDIO_PROBE_MS` (D271), `UJWALAM_STUDIO_PROBE_ACTIONS=<a>,<b>,...` runs one action every 700 ms from
2.5 s (after the first loads and a status poll), up to 20. Each action clicks the real widget, so its own handler
runs as for a user:
- `flag-off:<id>`: unticks the flag in the flags panel (itemChanged -> `POST /ui/api/flags/set` off, instant).
- `mute:<strip>`: the Mute button of that mixer strip (`mixer.setMute`).
- `track:<strip>:<n>`: the n-th track button of that strip (`mixer.setTracks`, D273).
- `undo`: the Undo button, only when enabled.
- `flag-on:<id>` (D279): ticks the flag; the server answers with a typed confirm and the shell opens its dialog.
- `type:<text>` (D279): types the text (percent-encoded: `yes%2C on air`) into the open confirm dialog and presses
  OK; `cancel` presses Cancel. `done` false when no confirm dialog is open.
The probe line gains `actions: [{action, done}]` (`done` false: no such widget or disabled). Tests only; no window
is ever shown.

## Test
`node --test tests/studio-qt-shell.test.mjs`: 6 pass (5 + 1 new):
```
✔ probe actions click the real widgets: Mute, a track button, a flag off; undo with no history does nothing (D275)
```
Flags `mixer-routing` and `scene-edit` on, actions `mute:0,track:0:1,flag-off:scene-edit,undo`:
- actions done `[true, true, true, false]` (undo: empty history, button disabled);
- the fake host's Camera row is muted and on tracks `[t1, t2]` (was `[t1]`);
- the flag store has `scene-edit` off and the structure box is hidden.

## Typed confirms (D279)
`node --test tests/studio-qt-shell.test.mjs`: 7 pass. Actions
`flag-on:transitions,type:nope,type:yes,flag-on:bot-manager,cancel,type:yes`: done
`[true, true, true, true, true, false]`. The wrong phrase brings the dialog back, `yes` turns `transitions` on (box
shown), Cancel leaves `bot-manager` off (the last `type` finds no dialog).

## Files
- `app/studio/src/main.cpp`, `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `tests/studio-qt-shell.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D275), this file
