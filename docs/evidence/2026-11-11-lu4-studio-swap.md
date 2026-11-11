# 2026-11-11 LU4 studio window swap while live

Branch `lu/studio-swap`. Plan row LU4 (D324), decision D346. Builds on LU3 (D337). Behind the flag `service-swap`,
off by default. Status: **"Done when" met in a headless loopback run** (20 swaps during a loopback stream, 0 dropped
frames, previews back within 3 s every time). A swap with a visible window on a real stream is UNVERIFIED (see below).

## What it does

- `studio` is a stop-start swappable service (`services/supervisor/swap.mjs`, `createStudioSlot` in
  `services/supervisor/slots.mjs`). The launcher (`services/studio-ui/launch.mjs`) runs the Qt studio behind that slot
  when the flag is on; a swap is asked by the launcher's parent over IPC: `{ t: 'ujwalam-swap', id, service: 'studio',
  root }`. root holds `studio/ujwalam-studio.exe` (a staged or installed version) or is the checkout (dev build).
- Steps: the old window gets `swap-close` on its control pipe and exits with 75 (`MainWindow::swapClose`: tray icon
  removed, no closeEvent, no quit lock); the launcher records that exit with `swap: true` and stops nothing. A new
  one-time key goes to the UI server (`rearm`). The new exe logs in, loads its state from the UI server and
  host.status, and embeds the H and V previews into its own slots. Health: `studio attach: ready` plus `studio attach:
  preview <c> embedded` for every preview the old window had, then 1 s up. Failure: the new one is stopped and the old
  version starts again (restored-old).
- The host keeps rendering, encoding and sending throughout; it drops the old embedded previews when their parent
  window is destroyed (existing WM_DESTROY path) and embeds new ones on `preview.open`.
- A normal close (exit 0) still stops everything (D280). One swap at a time over all services.
- Headless test mode: `UJWALAM_HEADLESS=1` + `UJWALAM_STUDIO_HIDDEN=1`. The window is laid out with
  `Qt::WA_DontShowOnScreen` and never reaches the screen. The headless host accepts an embedded preview only into a
  parent whose top-level window is hidden (`app/host/src/preview.cpp`), so the run itself proves no window was shown.

## Done when: 20 swaps during a loopback stream (run 2026-11-11)

Command: `npm run test:studio-swap` (UJWALAM_STUDIO_SWAP_STREAM=1; runs `tools/soak/studio-swap-soak.mjs --swaps 20`).
Before it, the busy check found no other heavy job (no installed Ujwalam, clip job or Meld Studio); only this
worktree's processes ran.

```
PASS studio: 20 swaps, every one swapped []
PASS studio: both previews back within 3000 ms of the old window's exit, every time {"max":1647,"min":1006,"mean":1168}
PASS host preview.list: H and V open after every swap []
PASS never two studio windows at once (no second tray icon or preview set) 1
PASS a studio build that crashes at start is rolled back (restored-old), previews back {"result":"restored-old","failed":["check-new: the studio exited (3221225477) before \"studio attach: ready\""],"previewsAfter":["v","h"],"hostOpen":["H","V"]}
PASS 0 dropped, 0 render-lagged, 0 encode-skipped frames on the host {"dropped":0,"lagged":0,"skipped":0}
PASS 0 dropped frames on every sink [youtube-h 0/4981, youtube-v 0/4977, twitch 0/4983, kick 0/4983]
PASS every required stream live at every sample {"notLiveSamples":0,"samples":165}
PASS no unplanned exit of the studio, the core, the UI server or the host {"studio":[],"core":null,"ui":null,"host":null}
PASS 21/21 checks
tests 2, pass 2, fail 0 (97 s)
```

Per swap (ms): swap total 2091-2759; new window logged in and ready 680-1112 after its start; previews back, measured
from the old window's exit to the new window's embed line: 1006-1647, mean 1168 (rounds 7-9 slowest, 1556-1647).
Host counters were sampled every 500 ms. Stream: H and V canvases, four loopback RTMP listeners (ffmpeg -listen),
NVENC, the alpha project, the headless host.

What the preview time measures: the old window's exit (its previews go with it) to the first "studio attach: preview
<c> embedded" line of the new window, which prints after the host answered `preview.open` for that slot. The host's
`preview.list` was checked after every swap (H and V open, display "embedded").

## Launcher wiring, rollback and normal close

`node --test --test-timeout=240000 --test-concurrency=1 tests/studio-swap-launcher.test.mjs`: tests 5, pass 5 (18 s).

- Pure: `studio` is stop-start, host and overlay server still refused; `studioRootPaths`/`swapEntryOk`; `serveSwaps`
  refuses a second swap while one runs and passes the studio timings back.
- The real launcher (flag on, fake host, hidden studio): 4 swaps between two staged builds, a build that crashes at
  start (access violation, 0xC0000005) gives `restored-old`, the restored window swaps again, a root without a studio
  exe is refused. studio-exits.jsonl: 7 exits with `swap: true` (6 clean exit 75, 1 crash), none outside a swap; the
  UI server kept running; no "stopping Ujwalam" or crash-reopen line.
- Normal close with the flag on: the hidden window takes the user's close (closeEvent) after 1.5 s; the launcher
  logs "studio window closed: stopping Ujwalam", exits 0, the UI server and the event core ports are closed, and the
  exit record has code 0 and no `swap`.

## Regression suites (one file at a time where heavy)

- `studio-qt-shell`: 70 pass.
- `service-swap-machine`, `service-swap-launcher`, `service-swap-ui-worker`, `studio-ui-quit-lock`: 26 pass.
- `studio-ui-alpha`, `studio-launch-d327`, `service-swap-front`: 51 pass, 1 skipped (pre-existing skip).
- `app/host/tests/host-api` (headless preview refusal kept for stand-alone previews): 16 pass.
- `node tools/lint.mjs`: 0 findings. Pre-commit quick CI 9/9.
- Builds: `npm run build:host`, `npm run build:studio`.

## UNVERIFIED and limits

- A swap with a visible window on the laptop's desktop, and on a real stream: not done (headless only; real streams
  need the user's go). The visible path differs only in `show()` without WA_DontShowOnScreen.
- Nothing calls the swap yet except tests: the live install (LU6) will ask for it.
- A window kept in the tray (D311) comes back as a normal window; open dialogs and unsaved field edits in the old
  window are lost.
- Global hotkeys belong to the host and are untouched by a swap; the studio has only window shortcuts. Tray: the old
  window removes its icon before it exits and the new one starts only after that exit (max 1 window at a time, checked).
