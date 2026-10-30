# V1 UI full run: launcher, real host, event core, loopback outputs

Date: 2026-10-30. Agent B (UI). Test card only, no devices (`--allow-devices` not given), loopback outputs only. No real platform was contacted.

## What was run

`node services/studio-ui/launch.mjs --data-dir <scratch> --mock --outputs app/host/outputs/o1-loopback.json --stop-on-stdin`, which is what `npm run studio` runs plus three test hooks (D118). The launcher started the event core (mock Streamer.bot), the libobs host (`out/host/build-c/ujwalam-host.exe`, picked automatically as the newest build) and the studio UI server, then opened a headless Chrome at the one-time login URL (key not printed). A scratch script (not committed) drove that browser over the DevTools protocol with real mouse events and typed text. Four ffmpeg listeners on 127.0.0.1 stood in for the `youtube-h`, `youtube-v`, `twitch` and `kick` sinks of the O1 loopback plan.

## Result: 40 of 40 checks pass

| Area | Check | Result |
|---|---|---|
| Launch | Launcher printed the UI line; no token in its output; browser opened by the launcher at the UI URL | PASS |
| Launch | Page loaded real host scenes (3 scenes); no BLOCKED-ON-HOST banner; status "Event core: up", "Host: up" | PASS |
| Launch | Start stream and Record enabled once the host reported both outputs ready | PASS |
| Layers | Real click on Dn of the top layer: order of 3 layers changed as expected on the host | PASS |
| Layers | Real click on Hide, then Show | PASS |
| Scenes | Real click switched scene (3 scenes), then back | PASS |
| Mixer | Real click on the middle of the slider: host volume -30.0 dB | PASS |
| Mixer | Real click on Mute, then Unmute: host muted true, then false | PASS |
| Previews | Open preview H and V buttons: host answered without error | PASS |
| Stream | Start stream: dialog shows phrase "yes, on air"; typed "yes" refused, dialog stayed open, nothing ran; typed "yes, on air" closed it; UI shows LIVE | PASS |
| Record | Record start while live: same phrase rules; UI shows Recording | PASS |
| Status | While live: dropped 0 of 2985 frames, 60 fps (one run); counters present | PASS |
| Stop | Stop record, then stop stream, each through the dialog (wrong phrase refused first); UI back to Offline / Not recording | PASS |
| Loopback | ffprobe on each listener file: `youtube-h` h264 1920x1080 + aac; `youtube-v` h264 1080x1920 + aac; `twitch` h264 1920x1080 + aac; `kick` h264 1920x1080 + aac | PASS |
| Shutdown | Launcher exited with code 0 on stop; no running host, node or test-browser process left from the run | PASS |

The recording written by the host (`o1-rec-h-*.mkv`, under the gitignored `out/`) probes as h264 1920x1080 at 60 fps with an aac track, 7.7 s.

## Problems found and fixed during the run

1. First page load met the fake backend, because the launcher opened the browser before the host wrote its discovery file. Scene ids from the fake then failed on the real host (`host-error`). Fixed in two places (D117): the launcher waits for the discovery file, and the page reloads its lists when the backend flips.
2. The mixer list reorders after a layer move (host layer order). My first test clicked "channel 1" and hit a different source. The UI is right; tests find channels by name (D121).
3. The scripted browser's debug port can stay bound by an old Chrome; the script now closes its browser with `Browser.close`. The launcher does not close a browser it opened for a user.

## Contrast fix (item 3)

Token values only (D120). Ratios computed with the WCAG formula:

| Pair | Ratio |
|---|---|
| `#101a30` on `#4f8cff` (dim text on the active row) | 5.38:1 (was 1.24:1) |
| `#0b1220` on `#4f8cff` (selected H/V tab) | 5.82:1 |
| main text on surface | 13.90:1 |
| dim text on surface | 6.55:1 |

The screenshot below shows the selected "H" tab and the active scene row readable.

## Screenshots (page only, from the headless browser; no desktop in frame)

- `docs/evidence/img/2026-10-30-full-run-1-start.png`: first view, host and event core up.
- `docs/evidence/img/2026-10-30-full-run-2-clicks.png`: after layer, scene and mixer clicks.
- `docs/evidence/img/2026-10-30-full-run-3-live.png`: LIVE and Recording, counters, tab contrast.
- `docs/evidence/img/2026-10-30-full-run-4-stopped.png`: after both stops.

Native preview windows were opened by the buttons but are not captured here (they are separate OS windows and the earlier full-screen capture showed a person from the desktop; that file stays in the gitignored `docs/evidence/private/`).

## Not verified / limits

- Test card only. No device was opened and no real platform was contacted.
- The event-core confirm role is still the api token (left for later, as instructed).
- Process cleanup: after the run, the host and the browser appear in the process table for a while as exited processes (`HasExited` true, one thread). The check counts only processes that have not exited. They were seen for more than 3 minutes; cause not investigated, and a clean idle stop with no stream leaves nothing at all.
- Frame counts and fps come from one run on this laptop and are not a performance claim.
- The scratch driver is not in the repo, so this run is not repeatable from the repo alone.

## Files created or changed in this task

- `data/profile.example.json` (added `paths.meld_session` placeholder)
- `services/studio-ui/launch.mjs` (`--outputs`, `--stop-on-stdin`, browser override env, wait for the host discovery file)
- `ui/js/app.js` (reload on fake/real flip)
- `ui/css/tokens.css`, `ui/css/app.css` (contrast tokens and rules)
- `docs/plan/2026-10-29-v1-decisions.md` (D117 to D121)
- `docs/evidence/2026-10-30-v1-ui-full-run.md` (this file)
- `docs/evidence/img/2026-10-30-full-run-1-start.png`, `-2-clicks.png`, `-3-live.png`, `-4-stopped.png`
