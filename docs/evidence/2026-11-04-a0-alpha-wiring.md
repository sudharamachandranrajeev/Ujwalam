# A0 day 2: alpha launcher wiring (host config, system token, --live, feedback folder)

Date: 2026-11-04 (runs made 2026-11-03, local).
Result: PASS for the fake-host suite and for one real-host run without devices and without platforms.
**Awaiting live test**: nothing here ran on a real stream. The live check is `docs/tests/2026-11-04-A0-D2.md`.

Closes the "Alpha launcher wiring: not done" item of `docs/evidence/2026-11-04-a0-replay-hotkeys-panic.md`.

## What changed

| Item | Where |
| --- | --- |
| Host config `<dataDir>/host-config.json`: `hotkeys.enabled: true`, `replay: {seconds: 30, autoStart: true}`, `feedbackDir`, `eventCore.systemFile = <dataDir>/system.json`. It is written at every alpha start, atomic and owner-only (`writeSecretFileAtomic`, fails closed), and passed as `--host-config`. | `services/studio-ui/launch.mjs` (`alphaHostConfig`, `writeHostConfig`, `hostLaunchSpec`) |
| Event-core system token to the host by environment only (`UJWALAM_EVENT_CORE_SYSTEM_TOKEN`). It is the same token the launcher already gives the event core, which publishes only the pipe name in `system.json`. The host reads it, removes it from its environment and logs `panic: event-core notification configured`. | `launch.mjs` |
| `--live` (alpha only): plan `data/outputs/alpha-live.json` through `planFile(..., {allowLive: true})`, and the host gets `--allow-live`. Without `--live`, nothing changes (no plan). An `--outputs` plan with real targets is refused with a message. `--live` together with `--outputs` is refused. | `launch.mjs` |
| Start-up block: `outputs.status` per sink (`keyPresent`, `urlPresent`, state; never a key or URL), `hotkeys.status`, `replay.status`. | `launch.mjs` (`alphaStatus`) |
| `--feedback-dir DIR` (default `<repo>/feedback`) goes to the host config and to the UI server (`cli.mjs serve --feedback-dir`), so the form reads the folder the hotkey writes. | `launch.mjs`, `cli.mjs` |
| `--hotkey-panic` / `--hotkey-feedback` / `--hotkey-marker COMBO\|off` override a default combo. Added because Ctrl+Alt+M was already held on this desktop (see run 1). | `launch.mjs` (`hotkeyOverrides`) |
| The feedback form reads host-shaped moments: `at` (falls back from `timestamp`), `scenes` per canvas (falls back from `scene`), and same-second folders `<HHMMSS>-2 .. -99` (id regex `^\d{4}-\d{2}-\d{2}/\d{6}(?:-[1-9]\d?)?$`). Before this, the host's moments showed no time and no scene, and a second capture in the same second was not listed. | `services/studio-ui/feedback.mjs` |
| `UJWALAM_ALPHA_FEEDBACK_PROBE=1` (tests and evidence only; refused without `--no-open`): one `feedback.capture` after start (waits `UJWALAM_ALPHA_FEEDBACK_PROBE_WAIT_MS`, default 5000, so the replay holds some seconds). It waits for the replay saves, logs in to its own UI server with the unused one-time key, and prints whether `/ui/api/feedback` lists the moment. | `launch.mjs` (`feedbackProbe`) |
| Fake host: records the host config, the outputs params, and the system token's shape (never its value). Answers `outputs.status`, `hotkeys.status`, `replay.status`, `feedback.capture` (writes a host-shaped moment) and `feedback.status`. | `tests/fixtures/studio-ui/fake-host.mjs` |

## Commands and output

### Fake host and unit tests

```
node --test --test-timeout=300000 tests/studio-ui-alpha.test.mjs tests/studio-ui-flags-feedback.test.mjs tests/studio-ui-server.test.mjs
```

```
✔ launch spec: studio mode keeps the test card and adds nothing
✔ launch spec: alpha mode wires previews, browser layers, overlay child and the event feed; token by env only
✔ host config: day-2 keys only (hotkeys on, replay 30 s autostart, feedback folder, event-core system file); written owner-only
✔ hotkey overrides: --hotkey-<name> COMBO or off; anything else refused
✔ launcher flags: --live is alpha only and excludes --outputs; the probe needs --no-open (nothing is started)
✔ launcher --alpha with a fake host: flags, tokens by env, host config, feedback probe, project built then kept, devices only on rebuild, --live plan
  ✔ path traversal impossible: only ^\d{4}-\d{2}-\d{2}/\d{6}(-[1-9]\d?)?$ ids
  ✔ host-shaped moments (app/host/src/moments.cpp): "at", "scenes" per canvas, same-second folder <HHMMSS>-2
ℹ tests 58
ℹ pass 58
ℹ fail 0
```

The end-to-end fake-host test checks these points:

- **Run 1:**
  - `--host-config <dataDir>/host-config.json` with the four keys.
  - The system token arrives by environment, is 64 hex, is not on argv, and differs from the api token.
  - No `--allow-live` and no `--outputs`.
  - The terminal shows `outputs: real targets off; 0 sink(s)`, hotkeys `registered` and replay `on, 30 s`.
  - The probe line shows the moment `listed by the UI server (1 moment(s), HTTP 200)`, with both replay file names, the scene and the time.
  - No 64-hex value appears in the launcher output.
- **Run 4 (`--live`):**
  - `--allow-live`, and `--outputs <hostData>/outputs-params.json` with sinks youtube-h, youtube-v, twitch, kick and record. No target has a `key` field.
  - The sink lines show `keyPresent no` / `urlPresent no` (the fake reads no keychain).
  - No `rtmp://` or `rtmps://` appears in the output.

### Real host, no devices, no platforms

Pre-run check (both runs): no `ujwalam-host` process, NVENC sessions 0.

```
Get-Process ujwalam-host        (nothing)
nvidia-smi --query-gpu=encoder.stats.sessionCount --format=csv,noheader
0
```

Run with the main checkout's host build (commit 55ca293), the worktree's code, and isolated data and feedback folders under `out/e1-alpha/`. The anonymised fixture profile was used. A small driver closed stdin after the probe line. The command it ran:

```
npm run alpha -- --mock --no-open --stop-on-stdin --data-dir out/e1-alpha/core --feedback-dir out/e1-alpha/feedback --profile tests/fixtures/project/profile.fixture.json [--hotkey-marker Ctrl+Alt+Shift+M]
  env: UJWALAM_HOST_EXE=<main checkout>/out/host/build/ujwalam-host.exe, UJWALAM_OBS_RUNTIME=<vendored OBS 32.1.2 runtime>,
       UJWALAM_HOST_DATA=out/e1-alpha/host, UJWALAM_ALPHA_FEEDBACK_PROBE=1, UJWALAM_ALPHA_STATS_MS=3000
```

Run 1 (default combos; probe without its wait, before it was added):

```
[studio] host config: <wt>\out\e1-alpha\core\host-config.json (hotkeys on, replay 30 s autostart, feedback folder <wt>\out\e1-alpha\feedback)
[studio] libobs host started (devices off), previews H and V
[studio] outputs: real targets off; 0 sink(s) (no plan; real targets need --live)
[studio] hotkeys: on; panic Ctrl+Alt+P registered; feedback Ctrl+Alt+F registered; marker Ctrl+Alt+M NOT registered (already registered (another program or binding holds it))
[studio] replay buffer: on, 30 s; H running (fallback rung); V running (fallback rung)
[studio] feedback probe: moment 2026-11-03/033420 listed by the UI server (1 moment(s), HTTP 200); replay files: replay-H.mkv, replay-V.mkv; scene: H: scene-75339fa6, V: scene-75339fa6; at: 2026-11-03T03:34:20.733Z
DRIVER: launcher exit 0 after 8 s
```

The capture came 0.1 s after the project load restarted the replay, so the clips held 0.17 s (H) and 0.12 s (V). The 5 s probe wait was added for this reason.

Run 2 (`--hotkey-marker Ctrl+Alt+Shift+M`, probe waits 5 s):

```
[studio] outputs: real targets off; 0 sink(s) (no plan; real targets need --live)
[studio] hotkeys: on; panic Ctrl+Alt+P registered; feedback Ctrl+Alt+F registered; marker Ctrl+Alt+Shift+M registered
[studio] replay buffer: on, 30 s; H running (fallback rung); V running (fallback rung)
[studio] feedback probe: moment 2026-11-03/033616 listed by the UI server (1 moment(s), HTTP 200); replay files: replay-H.mkv, replay-V.mkv; scene: H: scene-00048f75, V: scene-00048f75; at: 2026-11-03T03:36:16.643Z
DRIVER: launcher exit 0 after 11 s
```

Checks after run 2:

```
ffprobe replay-H.mkv  ->  h264 1920x1080, aac, duration 5.217 s
ffprobe replay-V.mkv  ->  h264 1080x1920, aac, duration 5.167 s
icacls out/e1-alpha/core/host-config.json  ->  <current user>:(F)   (only entry)
host log: 64-hex runs 0; "panic: event-core notification configured"; "exit 0"
feedback log.txt: 32-hex runs 0
after the run: no ujwalam-host process, NVENC sessions 0
```

`moment.json` (1.8 KB, under the form's 64 KB limit) has `trigger: "api"`, `scenes`, `stats`, `replay.state: "done"` with two file names, and `voiceNote.done: false`.

### Full suite and lint

```
npm run lint
lint: 0 finding(s), 27 allow marker(s), in 2.3s

npm test
ℹ tests 945
ℹ pass 937
ℹ fail 4
ℹ skipped 4
```

The 4 failures (`registry.test.mjs` x3, `project-scene-preset-v.test.mjs` x1) all say `legacySource "legacy/..." does not exist on disk`. The worktree has no `legacy/` folder (private and gitignored). They are not caused by this change.

## Not checked / UNVERIFIED

- **Real stream:** awaiting live test (`docs/tests/2026-11-04-A0-D2.md`). `--live` was run only against the fake host. No real host has run with `--allow-live` from the launcher, and no key was read.
- **Real key press (WM_HOTKEY):** UNVERIFIED (D152). Registration on the real desktop was shown. The capture ran through `feedback.capture`, not through a key press.
- **Ctrl+Alt+M:** another program on this desktop holds it (run 1). Which program is unknown. Ctrl+Alt+Shift+M registered.
- **Panic over the system pipe from the launcher session:** the host reports it as configured (token and system file present). `panic.now` was not called in these runs, because it engages event-core panic. The pipe path itself is covered by `app/host/tests/host-a0-day2.test.mjs`.
- **`system.json` after stop:** the launcher kills the event core rather than shutting it down cleanly, so `system.json` remains after the session (with a dead pid). The host's panic client refuses a pipe whose server is not the pid in that file, so a stale file is safe. This is behaviour from before this change.
- **Overlays:** the worktree has no `legacy/` overlay root, so the browser layers and the overlay feed were off in the real runs.
- **The feedback form in a browser:** the list was read through the UI server API (`/ui/api/feedback`), not from the rendered page.
