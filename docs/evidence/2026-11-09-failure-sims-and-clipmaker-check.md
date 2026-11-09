# 2026-11-09 Failure simulations (audio watchdog, readiness) and the clip maker check

Branch `live/sim-tests`. Two parts:

1. Simulated failures for the audio watchdog (D297 proposed) and the pre-stream readiness check (D299 proposed), to
   close what `docs/evidence/2026-11-08-pre-stream-readiness.md` ("Not checked / UNVERIFIED") and
   `docs/evidence/2026-11-08-game-audio-loss.md` left open.
2. The installed Alpha has no Python (the zip ships none), so it cannot make clips until `-ClipMaker` names a folder
   with the clip maker and its venv (`docs/evidence/2026-11-08-clip-settings.md`, "Not yet verified"). It now says so
   in plain words at start-up, on the control page, in the Qt window and in the readiness check. Nothing is installed.

No device was opened (test card and the host's fake audio source only), nothing went live, no credential was read.

## 1. Audio watchdog with the shipped numbers (real host)

`app/host/tests/host-audio-health.test.mjs` already proved the mechanics with small, fast numbers (noDataMs 1000,
maxRecreates 2, maxParked 2/8). The new `app/host/tests/host-audio-failsim.test.mjs` runs a real host (libobs, test
card, `--test-hooks`, headless) with **exactly** what the alpha launcher writes: `loadAudioHealth()` from
`services/studio-ui/launch.mjs` over `data/audio/health.json` (noDataMs 5000, checkIntervalMs 1000, maxRecreates 3,
maxParked 12, shutdownGuardMs 20000). The test refuses to run if the file's numbers change, so this evidence cannot
silently go stale. Faults come only from the existing `--test-hooks` methods (`audio.testAdd`, `audio.testStall`,
`audio.testCreate`) and one new one (`audio.testHangDestroy`, below). Readiness is the real `runReadiness` with the
real `data/live/readiness.json` and the real host as its `host`; only the system probes (process list, disk, bots,
CI stamp, clip tools, credentials) are passing fakes.

| Simulation | Result |
| --- | --- |
| Shipped numbers reach the host | `audioHealth.watchdog` = `{noDataMs 5000, recreate true, maxRecreates 3, parked 0, maxParked 12, parkedFull false}`; log line `audio health: watchdog on (no data 5000 ms, check 1000 ms, max 3 restarts per source, 12 parked per run; shutdown guard 20000 ms)` |
| All sources sending | readiness audio `pass`, "5 audio source(s) working." |
| No data for noDataMs (3 sources stalled at once) | each reported `missing` no earlier than 5000 ms - 100 and no later than 5000 + 1000 + 2000 ms after the stall; warnings `Game/Mic/AUX1 audio missing`; readiness audio `fail`, names `Game (missing)`, `Mic (missing)`, `AUX1 (missing)` |
| Failed recovery: replacements that never send (`testCreate silent`) | per source exactly `missing, recreated, recreated, recreated, gave-up`, one restart per noDataMs (gave-up no earlier than 4 x noDataMs); `recreates` 3, state `missing`, `receiving` false; text "... audio missing: restarts did not help; check the device"; log "Game audio missing after 3 restarts; not trying again"; no 4th restart one cycle later; readiness still `fail` |
| Parked limit (maxParked 12) | 3 sources x 3 = 9 parked; a 4th source's 3 restarts fill it to 12 (`parkedFull` true) and its next attempt already gives up with "too many restarts in this run; restart Ujwalam after the stream" (the limit is checked before the per-source count); a 5th source that dies with a working create mode is **not** restarted (`missing, gave-up`, `recreates` 0, parked stays 12); log "12 replaced sources are parked (limit 12 for this run): not restarting any more" |
| Shutdown guard | a host with one test source whose destroy never returns (`audio.testHangDestroy`): `host.shutdown` -> the host ends by itself with **exit 9** (`kShutdownGuardExit`) no earlier than 20000 ms - 500; log `ujw_test_audio: destroy hangs on purpose` and `obs_shutdown did not return in 20000 ms (a source's destroy is stuck); ending the process with exit code 9`; no `obs_shutdown returned` |
| Normal shutdown with 12 parked sources | exit 0 |
| Hook refused | `audio.testHangDestroy` on a host without `--test-hooks`: FORBIDDEN (-32001); unknown source: -32602 |

```
node --test --test-timeout=300000 app/host/tests/host-audio-failsim.test.mjs
✔ shipped numbers reach the host; sources that send pass readiness (1028.9127ms)
✔ no data for noDataMs, then 3 restarts that never send, then gave-up; readiness fails and names the sources (27041.9716ms)
✔ parked limit: the 12th parked source fills it; the next missing source is not restarted (26882.3746ms)
✔ shutdown guard: a source destroy that never returns ends the host with exit 9 after shutdownGuardMs (21276.1408ms)
✔ audio.testHangDestroy is refused without --test-hooks and for an unknown source (1311.4453ms)
ℹ tests 5  pass 5  fail 0   duration_ms 137652
```

Regression check of the existing file after the C++ change:
`node --test --test-timeout=300000 app/host/tests/host-audio-health.test.mjs` -> tests 7, pass 7, fail 0 (59 s).

### New test seam: `audio.testHangDestroy` (live-path code, reviewed)

Needed because nothing else can make libobs's destruction thread hang on purpose, and the shutdown guard
(`obs_runtime.cpp shutdown()`) had never been exercised.

- Gate: the existing `--test-hooks` command-line switch (off unless passed; the alpha launcher never passes it). The
  RPC method throws FORBIDDEN without it, and the fake source type `ujw_test_audio` is registered only with
  `--test-hooks` (`main.cpp`), so on a normal host there is no source the hook could act on. No environment variable
  was added: the existing switch already is the documented test-only gate, and a second gate would only add a way to
  misconfigure it.
- Scope: `Studio::test_audio_hang_destroy` refuses any source that is not a `ujw_test_audio` (CONFLICT), so even with
  `--test-hooks` it cannot touch a real device source. It sets `hangDestroy` in that one source's settings;
  `fake_update` reads it into a per-instance atomic.
- Behaviour: `fake_destroy` first stops and joins the fake's own packet thread (as before), then, only for that
  instance, logs and blocks forever (`Sleep(INFINITE)` loop). libobs 32.1.2 defers source destroys to its destruction
  task thread (`obs-source.c:762`) and `obs_shutdown` waits for that queue (`obs.c:1381`), so the hang lands where the
  2026-11-08 WASAPI hang did, after the guard is armed. Only the guard's `TerminateProcess` ends it.
- A watchdog replacement does not inherit the hang: `fake_create` ignores the copied settings (as it already did for
  `stall`), and libobs does not call `update` on create.
- Files: `app/host/src/audio_health.{h,cpp}`, `studio.{h,cpp}`, `methods.cpp`. No change to any non-test path.

## 2. Readiness failure sims (unit, fakes)

Added to `tests/studio-ui-readiness.test.mjs` ("failure sims" block):

- **Disk, exact thresholds** from `data/live/readiness.json` (fail below 22 GB, warn below 44 GB, 11 GB/h): one byte
  under 22 GB fails, exactly 22 GB warns, one byte under 44 GB warns, exactly 44 GB passes, 0 bytes fails; the fail and
  warn messages (GB and hours) checked verbatim; the drive asked is the host's recordings folder, else the data folder;
  neither = warn "No recordings folder known to check."; a drive that cannot be read (ENOENT) = warn "The check could
  not run.", never a pass.
- **Unreadable audio state** while the host is up: `audio.status` answering `null`, `{}`, `{sources: "x"}`,
  `{sources: null}` or `42` -> `fail`, `unknown: true`, "Live audio state could not be read: the host's answer cannot
  be read"; a malformed `host.status.audioHealth` falls back to the method, both unreadable = fail; an empty list
  (no device audio) stays a warning.
- **State mapping** as the data file says: `missing` fails ("Not working: Game (missing)."), `starting` and `unknown`
  warn, `inactive` passes.
- Clip maker item carries the plain reason and the fix (part 3).

```
node --test tests/studio-ui-readiness.test.mjs   -> tests 32 (before part 3), pass 32, fail 0
```

### Bug found and fixed

`defaultAudioCheck` treated an answer without a `sources` list (null, `{}`, a string) as "The host reports no audio
sources." (**warn**), so unreadable audio state passed the gate while D297's second opinion says unreadable state
must fail. Found by the new sim (`actual: 'warn', expected: 'fail'`), fixed in `services/studio-ui/readiness.mjs`
(answer without a sources list -> `audioUnreadable`), comment in `data/live/readiness.json` updated. An empty list is
still a warning.

## 3. Clip maker check (no Python in the package)

- `services/studio-ui/record-clips.mjs clipTools` now returns `{ py, script, reason, fix, missing }`; `missing` is
  `root` | `python` | `script` | null. Python is checked first (the part a download cannot bring). Reasons:
  - no root: "the clip maker is not set up on this PC"
  - no Python: "the clip maker's Python is missing (the Ujwalam download does not include Python; looked in <dir>)"
  - no clipper: "the clip maker is missing in <dir> (no services\clip\clipper.py)"
  - fix (all three): "To make clips, point Ujwalam at a folder that has the clip maker and its Python:
    Install-Ujwalam.ps1 -SettingsOnly -ClipMaker <folder>" (`CLIP_MAKER_FIX`)
- `status.json` and the UI server's `clips` status carry `fix` and `missing` (strings capped, `missing` whitelisted).
- **Start-up check** (`tools/package/run-installed.mjs clipMakerNote`): an installed run prints one line, e.g.
  `[ujwalam] Clips can't be made on this PC yet: the clip maker's Python is missing (...). To make clips, ... -ClipMaker <folder>. Everything else works.`
  It uses the launcher's own rule (clipRoot from `ujwalam.json`, else the install dir). Failure of the check never
  stops the start.
- **Control page**: new pill `st-clips` (hidden unless clips cannot be made): "Clips: Python not found" or
  "Clips: not set up", reason and fix on hover. Display only.
- **Qt window**: the clips pill says "Clips: Python not found" when Python is the missing part (else "Clips: not set
  up" as before); the tooltip and the Settings warning add the fix. Probe output gains `clipsTip`.
- **Readiness**: the `clips` item (still a warning, never blocks) carries the reason and `fix`.

Tests:

```
node --test tests/record-clips.test.mjs tests/studio-ui-readiness.test.mjs tests/package-alpha.test.mjs
ℹ tests 61  pass 60  fail 0  skipped 1   (the skip is the full package build, UJWALAM_PACKAGE_E2E=1 only)
```

- `tests/package-alpha.test.mjs` "clip maker check": the repo part of the zip has no `.venv`, `python.exe`, `.py` or
  `services/clip/` file and the allowlist refuses a Python; a fake install with no `clipRoot` -> `missing: python`,
  the plain reason and the fix, and the start-up line; a `clipRoot` with Python but no clipper -> `missing: script`;
  with both -> ready, no line; `.venv-gpu` preferred over `.venv`.
- `tests/record-clips.test.mjs`: `clipTools` reasons, fix and `missing` for each case.
- `tests/studio-qt-shell.test.mjs` "clip maker without Python": a headless Qt window over the real UI server with a
  `status.json` of an installed copy shows "Clips: Python not found" and the reason and fix in the tooltip; with no
  root, "Clips: not set up".

## Not checked / UNVERIFIED

- The real game-audio failure (a WASAPI source on a dead RTWQ work queue) was not reproduced; the dead device and the
  stuck destroy are the host's fake source. Behaviour with a real dead device stays UNVERIFIED (as in D297).
- The shutdown guard was proven with the fake's hang on libobs's destruction thread, not with a stuck WASAPI `Stop`.
- The control page pill was not looked at in a browser (no DOM test exists for the status bar); the Qt pill and tooltip
  were checked through the headless probe only, not on a shown window.
- The start-up line was checked through `clipMakerNote` and a fake install tree, not by running an unzipped package
  (the full package build runs only with `UJWALAM_PACKAGE_E2E=1`).
- Readiness thresholds (22/44 GB, 11 GB/h) and the watchdog numbers are still agent defaults, not approved by the user.
- An audio state the readiness config does not list (neither ok, inactive, a fail state nor a warn state) still passes
  silently; the host only sends the five listed states today. Not changed here.

## Files

Created: `app/host/tests/host-audio-failsim.test.mjs`, this file.
Changed: `app/host/src/audio_health.h`, `app/host/src/audio_health.cpp`, `app/host/src/studio.h`,
`app/host/src/studio.cpp`, `app/host/src/methods.cpp`, `services/studio-ui/readiness.mjs`, `data/live/readiness.json`,
`services/studio-ui/record-clips.mjs`, `services/studio-ui/server.mjs`, `tools/package/run-installed.mjs`,
`ui/index.html`, `ui/js/app.js`, `app/studio/src/main_window.cpp`, `tests/studio-ui-readiness.test.mjs`,
`tests/record-clips.test.mjs`, `tests/package-alpha.test.mjs`, `tests/studio-qt-shell.test.mjs`.
