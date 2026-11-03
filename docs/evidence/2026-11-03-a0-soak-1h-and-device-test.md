# Alpha 0: 1-hour soak of the installed build, and device test (2026-11-03)

## 1. One-hour soak (installed 0.1.0-alpha.1, mock outputs, overlays on)

- Run: the installed `Ujwalam.cmd` launcher in alpha mode with mock outputs and overlays from the local overlay root. The launcher was stopped through stdin after 60 min and exited with code 0.
- Sampler: a scratch PowerShell sampler (not committed) that read every Ujwalam process once a minute: working set, private bytes, CPU seconds, handles. Numbers were formatted with InvariantCulture (an earlier run's CSV was garbled by thousands separators and was discarded).
- 1526 samples over 61 minutes.

| Minute | Processes | Private MB (all) | Handles (all) | Host CPU-s | Host WS MB | Host private MB |
|---|---|---|---|---|---|---|
| 0 | 25 | 1514 | 9831 | 9.3 | 645 | 1025 |
| 10 | 25 | 1540 | 10154 | 169.2 | 647 | 1040 |
| 20 | 25 | 1547 | 10154 | 347.4 | 647 | 1042 |
| 30 | 25 | 1551 | 10154 | 512.3 | 647 | 1042 |
| 40 | 25 | 1554 | 10154 | 670.3 | 498 | 1042 |
| 50 | 25 | 1554 | 10158 | 837.2 | 292 | 1042 |
| 60 | 25 | 1552 | 10165 | 1007.9 | 260 | 1042 |

Findings:
- Host private memory is flat at 1042 MB from minute 20 to minute 60. No leak trend.
- Total handles are flat (+11 in 50 min). The process count stays at 25 (no restarts, no orphans).
- Host CPU is about 16.6 CPU-s per minute (about 28 % of one core) with mock outputs.
- The drop in host working set (647 to 260 MB) is the OS trimming pages. Private bytes do not change.
- The overlay feed check at 10 s passed: 1 overlay page connected, 1 event frame delivered, 2 effects.

Limits: mock outputs only (no real encode to a platform). Another user app took about 1 core during the run.

## 2. Device test (real devices, no outputs)

- User said "devices ready". The run used the dev launcher directly (`node services/studio-ui/launch.mjs --alpha` with devices on and stop on stdin). Through `npm` in PowerShell the flags were dropped, so that attempt was stopped and is not counted.
- Roles resolved to the user's devices: game capture (capture card), facecam (USB webcam), mic (USB mic). Device names are kept out of this file.
- 24 sources built, 2 audio sources, 0 sources not built. Hotkeys registered. Replay buffer running on H and V.
- Exit code 0. No `ujwalam-host` process was left behind.

Side effect: Windows recorded a camera/microphone consent entry for the dev host exe (an OS-owned registry entry, not written by Ujwalam). A host test assumed no such entry existed. It was changed to check that `devices.list` without `--allow-devices` adds or changes no entry (D178).

Status: soak PASS (mock), device test PASS. A real-platform test is still pending (guarded 15-minute test, after the user says "yes, on air").
