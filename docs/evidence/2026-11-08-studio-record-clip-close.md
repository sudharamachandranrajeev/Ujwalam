# 2026-11-08 Studio window: embedded previews, one close, record and clip (D280–D282)

User reports (installed alpha.4, 2026-11-08):

1. "closing ujwalam is closing previews. one close universal needed. and previews is not showing as an app at all."
2. "trying to live stream or record and clipping. app doesn't have the option to do so."

## Causes

- Previews: the Qt shell's preview slots asked the UI server for canvas `H`/`V`; the server's enum is `h|v`, so every
  embed was refused with "HTTP 400: bad field canvas" and the host opened its stand-alone preview windows instead.
- Close: closing the studio window only ended the window; the launcher, host and stand-alone previews kept running.
- Record and stream: the installed shortcut started `--alpha` with no `--live` and no `--outputs`, so the host had
  0 sinks and `outputsReady` was false: Start stream and Record stayed disabled. There was no clip button.
- Devices: the shortcut started with devices off (installed host log: "devices off"; `win-dshow` and `win-wasapi`
  disabled), and the installed `alpha.project.json` was built without devices (`origin.id: no-devices`), so even a
  recording would have held only placeholders.

## Changes

| ID | Change |
| --- | --- |
| D280 | Preview slots ask for `h`/`v`; on a refused embed they show the reason and retry every 2 s; after a host restart (uptime drops) they embed again. With the Qt shell, the launcher starts the host without `--preview` and skips the post-load `preview.open` (no stand-alone windows). Closing the studio window (exit 0) stops the launcher, host and services; while live it first asks for the typed "yes, on air". |
| D281 | An alpha start with neither `--live` nor `--outputs` uses `data/outputs/alpha-practice.json` (H + V `.mkv`, no stream target), so Record works; the plan ships in the zip. The UI server allows `replay.save` (Save clip: the replay buffer's last 60 s of H and V) and `marker.add {source: api}` (Mark moment), neither needs a confirm. The Qt shell has Save clip and Mark moment buttons; Start stream says why it is off. The installer adds an "Ujwalam (alpha, LIVE)" shortcut. |
| D282 | User choice 2026-11-08: both shortcuts open the devices (`--allow-devices`; LIVE adds `--live`). A start with devices rebuilds an alpha project that was built without devices; the old file is kept in `projects/_old/`. Going live still needs Start stream and the typed "yes, on air". |

## Evidence

Tests (2026-11-08, laptop):

```
node --test --test-concurrency=2 tests/studio-ui-alpha.test.mjs tests/package-alpha.test.mjs tests/studio-qt-shell.test.mjs tests/studio-ui-server.test.mjs tests/studio-ui-live-test.test.mjs
ℹ pass 82
ℹ fail 0
node --test tests/studio-qt-shell.test.mjs     ℹ pass 8   (new: Save clip and Mark moment reach the host, no confirm)
node --test tests/studio-ui-alpha.test.mjs     ℹ pass 30  (record plan by default; devices rebuild with _old kept)
node --test tests/package-alpha.test.mjs       ℹ pass 11  (both shortcuts; arguments read back from the .lnk files)
```

Runtime, real libobs host, dev tree, headless, temporary data folder:

```
node services/studio-ui/launch.mjs --alpha --no-open --stop-on-stdin --data-dir <tmp>/core --feedback-dir <tmp>/fb
[studio] record plan: data\outputs\alpha-practice.json (Record saves H and V .mkv; streaming needs the LIVE start: Ujwalam.cmd --live)
[studio] outputs: real targets off; 2 sink(s)
[studio] replay buffer: on, 60 s; H running (rung rec-h); V running (rung rec-v)
host log:
[host] nvenc probe h264: 2 of 2 started (nvml before 2, during 4)
[host] outputs configured: 2 rungs, 2 sinks, audio 160 kbps
[host] replay H: 60 s on shared rung rec-h (obs_nvenc_h264_tex, 17000 kbps, 1920x1080)
[host] replay V: 60 s on shared rung rec-v (obs_nvenc_h264_tex, 7500 kbps, 1080x1920)
exit 0
```

Runtime, embedded previews and one close (D280, laptop, dev tree): host log "preview embedded: H 534x711 in the
studio window"; closing the studio window ended the launcher, host and previews with exit 0.

## Not yet verified

- A real recording with devices, Save clip during it, and a real stream from the installed build: UNVERIFIED until
  the user runs alpha.5 (a live test needs "start stream test").
- Qt text clipping at 125 % display scale (cut-off button and group titles): open.
