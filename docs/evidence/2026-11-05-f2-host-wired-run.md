# 2026-11-05 v1 F2: full studio launch with the real host, driven through the control page API

Status: PASS for the full `services/studio-ui/launch.mjs` launch (event core `--mock` + real libobs host + UI server)
driven over HTTP the way `ui/js/api.js` does it: scenes list + activate, layers setVisible + move, mixer volume + mute +
live meter (peakDb), status bar values, local recording start/stop through the typed confirmation. No stream, no
devices, no windows (UJWALAM_HEADLESS=1), no real platform.

Closes the UNVERIFIED item of `docs/evidence/2026-10-30-v1-ui-host-wired.md` ("full `npm run studio` launch with the
real host and event core together", "layer move and mixer volume against the real host").

## The project/exe mismatch

Not present any more. The 2026-10-30 failure was a host exe built before `test-card.project.json` gained `"format"`
(`project: unknown field "format"`, exit 3). Today:

- `out/host/build/ujwalam-host.exe` 2026-11-05 19:09 UTC; newest `app/host/src` file 19:06 UTC (exe is current).
- `out/host/build-c/ujwalam-host.exe` 2026-10-29 22:05 (older); the launcher's "newer of build / build-c" rule picks
  `out/host/build`. The launcher log shows `libobs host started (devices off)`, no `BLOCKED-ON-HOST`, no `NOT ready`.
- The test card project loads unchanged (3 scenes, H and V canvases).

No rebuild was needed. No code change for the mismatch itself.

## Change (narrowest layer): a headless login for scripted runs

The UI login key is one-time and goes only to the browser. Under UJWALAM_HEADLESS=1 the launcher opened nothing, so a
headless run could not log in to its own UI server, and the page API could not be driven by a test.

- `services/studio-ui/launch.mjs`: new `headlessLoginScript()`. Under UJWALAM_HEADLESS=1, `UJWALAM_BROWSER` is honoured
  only when it names this Node executable (a login script, spawned `windowsHide`, no window). Any other
  `UJWALAM_BROWSER` (a real browser) and the system default browser stay off when headless (D191 unchanged).
  Non-headless behaviour is unchanged.
- `app/host/tests/studio-login.mjs`: the scripted "browser". It does the same `GET /login?k=` and writes
  `{ port, cookie, status }` to a file in the test temp dir. Nothing is printed.

## Test

New `app/host/tests/host-studio-launch.test.mjs` (real host; runs with `npm run test:host`, like the other real-host
tests). It starts the launcher with `--mock --stop-on-stdin --outputs <record-only plan> --data-dir <temp>`,
UJWALAM_HOST_DATA = temp, no `--allow-devices`, no `--alpha`, no `--live`. The plan has one H rung (1280x720 NVENC,
`ownRung`) feeding one local `.mkv` sink, no stream sink.

```
UJWALAM_HEADLESS=1 node --test --test-concurrency=1 --test-timeout=200000 app/host/tests/host-studio-launch.test.mjs
✔ launcher reports the real libobs host started, devices off, no BLOCKED-ON-HOST (3126 ms)
# status {"kind":"host","available":true,"blockedOnHost":false,"live":false,"recording":false,"droppedFrames":0,"totalFrames":0,"fps":60.0000024000001,"cpuPct":2.62,"gpuPct":9,"outputsReady":{"stream":false,"record":true}}
✔ status bar values: fps, dropped/total frames, CPU and GPU, outputs ready for record only
# scenes.list {"scenes":[{"id":"card-h","canvas":"H","active":true,"layers":3},{"id":"plain-h","canvas":"H","active":false,"layers":1},{"id":"card-v","canvas":"V","active":true,"layers":2}]}
# scenes.activate plain-h {"canvas":"H","canvases":["H"],"active":"plain-h"}
✔ scenes list + activate (H)
✔ layers setVisible + move (card-h)
# mixer card-h/bars {"id":"card-h/bars","volume":1,"volumeDb":0,"muted":false,"active":true,"peakDb":-18.06,"magnitudeDb":-21.03}
✔ mixer volume + mute + live meter (peakDb)
# record.start {"verdict":"allow","result":{"sinks":[{"id":"rec-h","kind":"record","container":"mkv","state":"live",...}]}}
# status while recording {"live":false,"recording":true,"droppedFrames":0,"totalFrames":0,"fps":60.0000024000001,"cpuPct":2.63,"gpuPct":8,...}
# record.stop {"verdict":"allow","result":{"sinks":[{"id":"rec-h","state":"stopping","liveForMs":3762,"totalFrames":209,"droppedFrames":0,"bytes":1810820,...}]}}
# recording f2-rec-h-20261105-192738.mkv 1962304 bytes
✔ local recording start/stop through the typed confirmation (no stream)
ℹ tests 6  pass 6  fail 0   (duration 8.5 s)
```

(Output lines shortened: some fields left out; the recording path is in the gitignored test dir.)

What each step checks:

- Login: one-time key redirects 302 and sets the session cookie; `/ui/api/session` gives the CSRF value and
  `host.kind = "host"` (the real host backend, not the fake). Every POST carries Origin, `X-Ujwalam-Csrf`, JSON.
- Scenes: list is the 3 test-card scenes; `scenes.activate plain-h` on H makes it active and card-h inactive; back
  again; an unknown scene gives 502 `host-error`.
- Layers: `setVisible motion false/true` round-trips; `move motion index 1` gives `bg, motion, bars`; back to
  `bg, bars, motion`.
- Mixer: the 440 Hz tone (`card-h/bars`) meters (peakDb about -18 dBFS, above -60); `setVolume -12 dB` reads back
  `volumeDb -12`; `setMute true/false` round-trips; volume reset to 0 dB.
- Recording: `record.start` returns `verdict: confirm` with phrase `yes` (not live); typing `yes` starts it;
  `recording: true`, `live: false`; `record.stop` the same way; the `.mkv` exists. ffprobe on it:
  `h264 1280x720`, `aac`, duration 3.784 s.
- Shutdown (the `after` hook): closing stdin runs the launcher's clean stop (`host.shutdown`), launcher exit 0, host
  discovery file removed.

Also run (launch.mjs changed):

```
UJWALAM_HEADLESS=1 node --test --test-concurrency=1 tests/studio-ui-alpha.test.mjs tests/studio-ui-crash-recovery.test.mjs tests/studio-ui-server.test.mjs tests/studio-ui-live-test.test.mjs
ℹ tests 58  pass 58  fail 0
UJWALAM_HEADLESS=1 node --test tests/studio-ui-alpha.test.mjs   (after adding the headlessLoginScript unit test)
ℹ tests 20  pass 20  fail 0
node tools/lint.mjs
lint: 0 finding(s), 31 allow marker(s)
```

## Findings

- Status bar `droppedFrames` / `totalFrames` count stream sinks only (`Outputs::totals` in `app/host/src/outputs.cpp`).
  While only recording, both stay 0; the recording's own frames (209, 0 dropped) are in the sink status only. This is
  by design (dropped frames are a delivery measure); the UI shows `0` / `-`. Not changed. The test asserts it.
- Mixer field is `volumeDb` (the page uses it); there is no `db` field in `mixer.list`.
- The record.start/stop result shown to the page includes the recording's absolute local path. Local-only page; noted,
  not changed.

## Processes after the runs

```
tasklist | grep -i "ujwalam-host\|ffmpeg\|ffprobe"          -> nothing
node.exe command lines matching launch.mjs|event-core|studio-ui|studio-login -> 0
```

## Not verified

- The event core was started (`--mock`) and the UI talked to the host while it ran, but no event-core action
  (`/ui/api/core/request`) was driven in this run. UNVERIFIED here.
- Stream start/stop through the "yes, on air" confirmation against the real host (needs a loopback stream plan and
  ffprobe assertions first). Not exercised: no stream sink existed.
- Clicking in a real browser (this run used the page's HTTP API, not the page's DOM).
- Native previews (headless: none opened; covered on 2026-10-30).
- Anything with devices (`--allow-devices` not given).
- `npm run ci` not run (as asked). Whether CI runs `test:host` on this laptop is not checked here.

## Files

Created: `app/host/tests/host-studio-launch.test.mjs`, `app/host/tests/studio-login.mjs`,
`docs/evidence/2026-11-05-f2-host-wired-run.md`.
Changed: `services/studio-ui/launch.mjs` (`headlessLoginScript`, headless login exception),
`tests/studio-ui-alpha.test.mjs` (one unit test).
