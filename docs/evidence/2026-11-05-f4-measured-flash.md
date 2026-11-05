# v1 F4: measured flash enforcement (`fx test`)

Date: 2026-11-05. Status: built and tested. The detector is unit-tested on synthetic series and frames. `fx test` has rendered every guarded effect on the real host (libobs + obs-browser, headless, no preview windows) on H and V. The measured results are stored in `data/effects/flash-measurements.json`, and the effect guards load that file on the live path. This closes the open hook in `docs/evidence/2026-10-30-v1-effect-guards.md` ("Open hook", D82).

## Definition chosen (source)

From W3C WCAG 2.2, SC 2.3.1 "Three Flashes or Below Threshold". It uses the definitions of "general flash and red flash thresholds" and "relative luminance". The numbers are the same as in ITU-R BT.1702 and the Ofcom/Harding guidance.

- Relative luminance per pixel: linearise sRGB (c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4), then L = 0.2126 R + 0.7152 G + 0.0722 B. Areas are averaged in linear light.
- General transition: a change of 0.1 or more in L, where the darker state is below 0.80.
- Flash: a pair of opposing transitions. Limit: no more than 3 flashes in any 1 s window. So a window that holds 7 or more transitions fails (3.5 flashes/s). The reported rate is (transitions in the worst 1 s window) / 2.
- Red transition: a change of 20 or more in max(0, R - G - B) x 320 (linear channels), where one of the two states is saturated red (R/(R+G+B) >= 0.8). This is from the WCAG 2.2 understanding note. **UNVERIFIED:** the exact wording was not re-checked against the live W3C page in this session.
- Area: WCAG counts a flash only when it covers about a quarter of a 10 degree field, mapped to 341 x 256 px on a 1024 x 768 screen (one third of each side). Implementation: each frame is scaled (area filter) to 192 x 108 (H) or 108 x 192 (V). Each frame is then averaged over 25 overlapping one-third windows (stride one sixth) plus the whole frame. The worst window counts. **Approximation**, not a certified analyser such as Harding FPA:
  - It is conservative for mid-size flashes: one that covers half a window still counts.
  - It ignores very small flashes: 10 x 10 px of 192 x 108 does not count.
  - For V, the window is one third of the portrait frame. The 10 degree mapping for phone viewing is UNVERIFIED.
- Transitions are found with a zig-zag at the threshold. Noise smaller than the threshold never makes a turning point. A slow ramp is one transition.

The code is in `services/overlay-server/flash-detect.mjs` (pure, stdlib). The `DEFINITION` export carries the id `wcag2-2.3.1-general+red` and the source.

## fx test

`node tools/fx-test.mjs --effect <name> (--host [--query k=v] | --video <file> | --frames <dir> --fps n) [--canvas h|v] [--write] [--measurements <file>] [--json]`. The npm script is `npm run fx:test -- ...`.

Exit codes: 0 = pass, 1 = above the limit, 2 = usage or run error, 3 = the host render drew nothing (nothing is written).

Input modes:

- `--host`: renders the effect on the host.
  - The host comes from `app/host/lib/launch.mjs`. It starts with `--allow-browser` and the overlay child, with `UJWALAM_HEADLESS=1`, no preview and `windowsHide`.
  - Project: canvas h (plus v for a V test), a black background (the worst case for bright flashes, `data/effects/fx-test.json`), and the effect's overlay page as a browser layer at the guards canvas size.
  - It records with NVENC (640x360 or 360x640 at 30 fps), fires `effect.fire` once through the real guards, then analyses lead + duration + tail.
  - Page per effect: `data/effects/fx-test.json` `pages`.
  - If the drawn share stays below 0.2 % of pixels, the result is "no render".
- `--video`: any recording, decoded with ffmpeg. The frame rate comes from ffprobe (no resampling, so flicker is not aliased). `--start` and `--duration` select a part.
- `--frames`: a folder of png/jpg/bmp files, sorted by name, at `--fps`.

ffmpeg and ffprobe come from `FFMPEG`/`FFPROBE` or PATH. Here that was the winget BtbN FFmpeg 8.1 LGPL already installed; nothing was installed in this session. Every child process runs with `windowsHide`.

`--write` stores `{ flashesPerSecond, pass, limit, maxTransitionsInWindow, worstWindowStartSec, worstRegion, worstKind, generalPeak, redPeak, frames, fps, durationSec, regions, drawnPeak, method, input (file base name only, plus the page query), date, definition, tool, status }`. It writes into `data/effects/flash-measurements.json` per effect and canvas, using a temp file and then a rename.

## Runtime wiring

- `guards.mjs` adds three functions:
  - `validateFlashMeasurements`: fails closed. It lists every problem, and a record needs frames, fps, date and method as evidence.
  - `loadFlashMeasurements`: an absent file means nothing has been measured yet.
  - `saveFlashMeasurement`.
- `createEffectGuards({ measurements })` applies the file through `reportMeasuredFlashes`. Effects that are not in the config are skipped. A measured rate above `flash.maxPerSecond` refuses the effect with `flash-limit` on that canvas. With no canvas given, it refuses when either canvas is over. `measuredFlashes()` lists what is applied.
- `createOverlayServer({ guards: true })` loads `data/effects/flash-measurements.json` by default. This covers the host overlay child (`app/host/overlay/child.mjs`). `flashMeasurements: <file | object | false>` overrides it.
- `tools/package/manifest.mjs` ships the file next to `guards.json`, so the Alpha zip enforces it too.

## Host measurements (2026-11-05, this laptop, RTX 4050, headless)

Each row is 1 play fired through `effect.fire` and analysed from the recording at 30 fps.

| Effect | Canvas | Page query | Frames | Drawn peak | Flashes/s (worst 1 s) | Result |
|---|---|---|---|---|---|---|
| gg | h | - | 192 | 3.72 % | 0 | PASS |
| gg | v | - | 192 | 3.00 % | 0 | PASS |
| storm | h | color=roar | 143 | 41.7 % | 1 (2 transitions, general, region r0_18) | PASS |
| storm | v | color=roar | 142 | 24.8 % | 0 | PASS |
| charge | h | - | 139 | 0.47 % | 0 | PASS |
| charge | v | - | 139 | 1.36 % | 0 | PASS |
| campop | h | - | 270 | 2.58 % | 0 | PASS |
| campop | v | - | 270 | 3.72 % | 0 | PASS |

Storm kinds on h, 1 play each, not stored:

| Kind | Drawn | Flashes/s |
|---|---|---|
| red | 100 % | 0 |
| blue | 16.2 % | 0 |
| bloodlust | 33.2 % | 0 |
| claw | 13.8 % | 0 |
| ghost | 60.5 % | 0 |
| roar | 38.6 % | 1 |
| horde | 12.0 % | 0 |
| party | 6.1 % | 0 |

Roar is the worst kind, so the stored storm record is roar. The legacy default `color=auto` picks a kind at random per play.

The red wash at the default `flash=0.22` is far below both thresholds (about 0.006 luminance).

Positive control on the host: storm with `flash=1&color=red` measured 1 flash/s (2 general transitions, whole frame). So the host path does see a real full-canvas flash.

Recordings are in `out/fx-test/` (gitignored). They are kept and not deleted.

## Tests

`UJWALAM_HEADLESS=1 node --test tests/flash-detect.test.mjs tests/fx-test.test.mjs tests/effect-guards.test.mjs tests/overlay-server.test.mjs`: 90 tests, 90 pass. 35 of them are new:

- `tests/flash-detect.test.mjs`:
  - luminance and the red state
  - zig-zag noise rejection; a ramp is one transition
  - 3 Hz passes at exactly 3/s, 4 Hz fails
  - 6 transitions pass, 7 fail
  - thresholds 0.09 vs 0.11
  - darker state at 0.80 vs 0.79
  - worst window timing; frame rate dependence
  - red flash below the general threshold; unsaturated red ignored
  - corner one-third flash caught, tiny flash ignored
  - bad input refused
- `tests/fx-test.test.mjs`:
  - file validation (canvas, rate, frames, fps, date, method)
  - absent file is empty
  - measured over the limit refuses on that canvas only and on "both"; at or under the limit changes nothing; unknown effect skipped
  - broken file fails closed
  - save/load round trip, and a refused write leaves the file unchanged
  - the overlay server applies the file
  - fx-test host project shape (h always present); every guards effect has a page
  - lavfi lossless videos: 5 Hz gives 5/s FAIL, 1.5 Hz gives 1.5/s PASS, the `--start`/`--duration` cut
  - png frames folder
  - CLI: exit 1, `--write` persists date, frames, fps and the base name only, and the guards then refuse; exit 0 on a pass; exit 2 on usage

`node tools/lint.mjs`: 0 findings.

## UNVERIFIED and open

- Red-flash wording (WCAG 2.2 note) not re-checked against the W3C page. The area rule is an approximation (above). It is not a certified PSE analyser.
- Each measurement is one play on a black background. Repeated plays are bounded by the declared offsets, cooldown and budget in the gate, not by this measurement.
- Storm and charge are chat-fired pages. `effect.fire` still drew them here, but the chat path itself was not rendered.
- Re-measuring an effect that the stored file already refuses: host mode fires through the live guards, so it will be refused. Use `--video` or `--frames` on a recording instead, or remove the entry after a fix. Not needed today: every stored entry passes.
- The 30 fps recording rate bounds the detectable flicker at 15 Hz. A 60 fps canvas could flicker faster. Record at the canvas rate for that.
