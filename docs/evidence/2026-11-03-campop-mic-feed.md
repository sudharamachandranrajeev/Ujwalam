# Cam-pop mic feed: host meter into the voice-spike rule (2026-11-03)

Result: **PASS** for the wiring (tests and host build). **UNVERIFIED** for the trigger level: see "Not verified".
Live status: awaiting live test. It has not been used on a real stream yet.

## What was built

- **Mic source setting (data).** `data/effects/guards.json` `rules.campop.voice.audioSource` = `{ id: "aud-mic", source, levelNote, status: "unverified", checked: "2026-11-03" }`.
  `aud-mic` is the mic's project audio source id in the Alpha project (`services/studio-ui/alpha.mjs`: `aud-mic` is the
  mic device, `aud-game` is the game capture layer). The engine code has no device name in it. `null` or absent turns the feed off.
- **Validator.** `validateGuardConfig` (`services/overlay-server/guards.mjs`) now checks `rules.campop.voice`:
  `enabled` must be a boolean, `spikeLevel` must be in (0, 1], `holdMs` must be in 0..60000, and `audioSource` must be null or an object with
  a project id (`^[a-z][a-z0-9_-]{0,63}$`), a status of unverified or verified, a source, and a YYYY-MM-DD checked date.
- **Child** (`app/host/overlay/child.mjs`). The ready line carries `micSource` (the id while the voice trigger is enabled, else
  null). The new op is `{"op":"mic","level":x}`. It has no id and gets no reply. It calls `server.rule.onMicLevel(x)` only for a finite number in
  0..1. Anything else is ignored, with at most one stderr warning per 10 s. The `stats` reply also carries `campop` (the rule counters).
- **Host** (`app/host/src/overlay.{h,cpp}`, `studio.{h,cpp}`, `main.cpp`). A mic pump thread in `Overlay` runs every 50 ms.
  While the child is running and has named a source, it calls `Studio::audio_peak_db(id)`. That call uses a try-lock, scans the
  device globals and the layer sources, and returns the latest `Meter::peak`. The pump converts the peak with `pow(10, dB/20)`,
  clamps it to 0..1 (non-finite gives 0), and writes the line. The write is made only when the stdin pipe has room for the line plus a
  1024-byte reserve for effect and stats calls. The room is read with `NtQueryInformationFile(FilePipeLocalInformation).WriteQuotaAvailable`,
  the same query libuv uses. So the pump never blocks in `WriteFile` on a hung child. A dead, restarting or busy child drops the sample.
  `overlay.status` gains `mic: { source, found, sent, skipped }`. `main.cpp` sets the provider after the studio is created. It clears
  the provider before `studio->teardown()`, and the clear waits for any in-flight read.
- The libobs audio thread still only stores the meter atomics. The RPC thread is not involved.

A scratch probe (not committed) confirmed that the pipe quota is readable on an anonymous `CreatePipe` write end. The buffer is 4096 bytes. After a
100-byte write the quota was 3996. Filled to 4000 bytes, it was 96.

## Commands and output

```
node --test tests/effect-guards.test.mjs tests/overlay-child-mic.test.mjs
ℹ tests 36   ℹ pass 36   ℹ fail 0
  ✔ ready names the mic source from guards.json (rules.campop.voice.audioSource)
  ✔ bad mic levels are ignored: no reply, no rule call, at most one stderr warning
  ✔ a valid level reaches the rule: held at or above spikeLevel for holdMs it triggers once
  ✔ the child keeps answering after mic lines (stdin channel intact)
  ✔ (effect-guards) mic source: a project audio source id with source, status and checked date; null turns the feed off
```

The related Node test files are bot-clash-check, effect-guards, idempotency-crash, label-server, overlay-child-mic, overlay-server,
project-scene-preset, stray-procs, studio-ui-alpha, studio-ui-live-test and test-broadcast:

```
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 <those 11 files>
ℹ tests 193   ℹ pass 193   ℹ fail 0
```

Host build (OBS 32.1.2 runtime and source from the vendored dir, set by the env vars of `app/host/lib/config.mjs`):

```
node app/host/tools/build.mjs
[21/21] Linking CXX executable ujwalam-host.exe      (exit 0; only warning: the existing C4996 obs_add_data_path)
```

Host browser tests, headless. They use no devices: a media layer with a 0.5-amplitude 440 Hz tone stands in for the mic and gets the configured id:

```
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 --test-concurrency=1 app/host/tests/host-browser.test.mjs
# mic feed: 20.0 lines/s, skipped 0
✔ cam-pop mic feed: the named audio source reaches the rule as op mic (about 20 lines/s), loud tone triggers
ℹ tests 6   ℹ pass 6   ℹ fail 0
```

The test ran after the child-restart test, so the child reported `micSource` again after a restart and the feed resumed.

Full host suite:

```
UJWALAM_HEADLESS=1 npm run test:host
# mic feed: 20.5 lines/s, skipped 0
ℹ tests 57   ℹ pass 57   ℹ fail 0   ℹ skipped 0   (249 s)
```

Lint:

```
node tools/lint.mjs
lint: 0 finding(s), 30 allow marker(s), in 3.7s
```

## Not verified

- **UNVERIFIED: the level scale.** The libobs volmeter peak is post-fader and post-filter. It includes the source volume and
  any filters, and reads -inf while muted. Legacy read the raw WASAPI device peak (`IAudioMeterInformation::GetPeakValue`,
  `legacy/tools/mic-level.ps1`). On that scale legacy measured a noise floor of 0.0061, a speech average of 0.045 and a loudest
  value of 0.182. So `spikeLevel` 0.12 may not mean the same loudness here. Before trusting `spikeLevel`, a live measurement with the real FIFINE
  mic is needed: speak at normal and loud levels and read `mixer.list` `peakDb` for `audio:aud-mic`. No corrected
  number is proposed here.
- Sampling: each 50 ms tick sends the latest meter peak, not the maximum since the last tick, which matches the legacy 50 ms poll of
  an instantaneous peak. UNVERIFIED whether this misses short peaks that legacy would catch.
- `aud-mic` is checked only against the Alpha project builder. A project from another source, such as a Meld import, may use another id.
  Then `found` stays false and the voice trigger does not fire. `overlay.status.mic` shows this.
- The pop is still admitted only while flag `chat-effects` is on (D204). The tests count the trigger, not an on-screen pop.
