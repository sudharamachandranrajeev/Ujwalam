# 2026-11-08 Qt shell structure edits and transitions (D265)

Status: build evidence only. The Qt shell has no runtime test: UNVERIFIED until the user adds or removes a scene or
layer, or sets a transition, in the studio window.

## Build
`node app/studio/tools/build.mjs`: `built ...\ujwalam-studio.exe`, no errors or warnings.

## Behaviour (server side already tested)
Routes used, all from the browser page and covered by its UI server suites: `GET/POST /ui/api/project/structure`
(D240; ops scene.add, scene.remove, layer.add, layer.remove) and `GET /ui/api/project/transitions`,
`POST /ui/api/project/transition` (D242). The shell sends only the keys each op allows; an image or video layer and a
stinger can only name a file the server listed. The server stays the gate: flag off gives 404, live gives 409
`live-locked`, an unknown asset gives 409 `unknown-asset`, and the reply text is shown in the status note. A structure
edit clears the undo history on the server; the shell reloads its scenes, choices and undo buttons after each edit.

The boxes appear within one status poll (2 s) of the flag turning on (the D264 flags panel), and are disabled while
live.

## To check by hand (not live)
1. Flags panel: tick `scene-edit` (type `yes`). Add scene "Test": it appears in the scene list.
2. Add layer, kind Colour, `#00ff00`: a green layer appears in the active scene on H and V.
3. Select it, Remove layer, Yes: it goes. Remove scene "Test", Yes: it goes.
4. Tick `transitions`. Canvas H, fade, 300 ms, Apply transition: switching scenes fades within a few seconds.

## Files
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `docs/plan/2026-10-29-v1-decisions.md` (D265), this file
