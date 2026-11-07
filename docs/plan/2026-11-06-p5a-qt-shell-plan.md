# 2026-11-06 — P5a Qt studio shell plan

User choices (2026-11-06): build the Meld-like native studio app in Qt now (P5); Qt 6.8.3 MSVC2022 x64 developer kit
via aqtinstall into `C:\AI\Claude\_vendor\qt-6.8.3` (same version as the Qt DLLs the OBS 32.1.2 runtime ships, so one
set of Qt DLLs serves both); web control page gets the inspector in parallel.

## Design

- **Backend unchanged.** libobs stays in `ujwalam-host` (JSON-RPC). The Qt shell is a UI only. D1/D40 rollback path:
  "replace the web UI with Qt later; the libobs host and its API stay the same".
- **One policy point.** The shell is a native client of the studio UI server (`services/studio-ui/server.mjs`), the
  same API the web page uses: `/login?k=<one-time key>` gives the session cookie, `GET /ui/api/session` the CSRF
  value, then `/ui/api/host`, `/ui/api/confirm`, `/ui/api/status`, flags, feedback. The typed confirmations
  ("yes", "yes, on air"), the host-call allowlist and the schemas stay in the server. The shell never holds the host
  token or the event-core tokens (D40 unchanged).
- **Launch.** `npm run alpha -- --shell qt` (later the default): the launcher starts `ujwalam-studio.exe` instead of a
  browser and gives it the UI URL and the one-time launch key in its environment (`UJWALAM_UI_URL`,
  `UJWALAM_UI_LAUNCH_KEY`), never on argv. The shell reads them once and removes them from its environment.
- **Previews.** Phase 1: the shell's centre shows H and V slots with Open/Bring-to-front (host native windows, as
  today). Phase 2: host `preview.open` gets an optional parent window handle; the host creates the preview as a child
  window of the shell's slot (cross-process child HWND, no activation), so the previews sit inside the studio window.
- **Layout (Meld-like).** Left: scenes, then layers (visibility, order, select). Centre: H and V previews. Right:
  inspector (position, size, rotation, crop), audio mixer (live meters, volume, mute). Top bar: Stream / Record
  buttons and status pills (live, recording, dropped frames, fps, CPU/GPU, host and event core). Flags and feedback
  in a dock.
- **Windows rule (D219, decided 2026-11-06).** The shell window and its embedded previews open on the second display
  when there is one, without activation; with one display they show on it (the user opened the app). Stand-alone host
  preview windows keep D191 (second display only).
- **Build.** `npm run build:studio` (`app/studio/tools/build.mjs`): CMake + Ninja with VS Build Tools vcvars (as the
  host build), `QT_DIR` from `app/studio/studio.local.json` or `UJWALAM_QT_DIR`. Output `out/studio/build` (gitignored).
- **Licence.** Qt is LGPL-3.0, dynamically linked (the existing "open before distributing" item for Qt covers it).

## Editing on the preview (user request 2026-11-06: "design like a normal software")

- **One window.** H and V previews live inside the studio window (embedded child windows). Stand-alone host preview
  windows stay only as an optional pop-out for a second display.
- **Coordinates.** Layer placement is stored in canvas pixels (1920x1080 H, 1080x1920 V). The preview shows the
  canvas scaled to fit its slot; a mouse point maps back with `canvas = (mouse - offset) * canvasW / shownW`. Resizing
  the studio window changes only the scale, never a layer.
- **Who handles the mouse.** The host draws the preview, so clicks land in the host's child window. The host does the
  hit test, draws the selection box and handles in the same GPU pass, and moves the layer live while dragging (no
  round trip per mouse move). On release it reports the final placement as one event.
- **One edit path.** Drag, inspector typing and arrow-key nudges all end in `layers.setPlacement`. The UI server
  then autosaves (project-sync.mjs) and, later, records the undo step. The inspector refreshes from the same event.
- **Gestures (OBS/Meld conventions).** Drag inside the box: move. Corner handle: resize, aspect kept (Shift: free).
  Alt + edge handle: crop. Top handle: rotate. Arrows: 1 px, Shift + arrows: 10 px. Snap to canvas edges, centre and
  the V safe area. Order inside libobs: crop, then scale, then rotate around the centre.
- **Layer order.** The project keeps one layer order shared by H and V (one layer list, as in Meld); a move applies
  to both canvases and is saved. Placement and visibility stay per canvas.

## Steps

1. Skeleton: CMake project, API client (login, CSRF, JSON calls), main window with the Meld layout, scenes / layers /
   mixer / status wired, Stream / Record with the typed confirmation dialog. Build + a smoke test against the fake host
   (`--fake-host`).
2. Inspector in the shell (same `layers.setPlacement` call as the web page).
3. Launcher `--shell qt`.
4. Embedded previews (host `preview.open` parent handle; host test).
5. P5b: autosave of layer edits to the project file, undo, transitions with audio routing.

Done for each step = test or runtime evidence in `docs/evidence/`.
