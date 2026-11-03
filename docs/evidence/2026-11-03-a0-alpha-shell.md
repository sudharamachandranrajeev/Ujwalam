# A0 day 1: alpha app shell (`npm run alpha`), 2026-11-03

Result: **PASS without devices** (mock Streamer.bot, fixture profile). The run with devices is **awaiting the user's "devices ready"** and test card `docs/tests/2026-11-03-A0-D1.md`. It has not been run against real hardware.

## What was built

- `npm run alpha` (`services/studio-ui/launch.mjs --alpha`) starts the event core, the libobs host and the 127.0.0.1 control page. The host gets `--preview h,v`, `--allow-browser`, `--overlay-root`, `--overlay-script`, `--node` and `--overlay-events-url`. The event-core token goes to the host by environment only, never in argv.
- `<dataDir>/projects/alpha.project.json` is built on the first run, from Default H and, when it exists, Default V. After that it is loaded unchanged. `--rebuild-alpha` builds first, then moves the old file to `projects/_old/alpha-<stamp>.project.json`.
- Device roles (`--allow-devices` only): `devices.list` is matched against `params.match` in the registry device presets. An optional override comes from `devices.roles` in `profile.local.json` (path or name). No match, several matches, or a device already taken leaves the role unbound, with a reason.
- Host logs go to `<dataDir>/logs/host-<stamp>.log`, and the newest 10 are kept. An in-memory ring holds the last 1000 lines. RPC `log.tail {lines: 1..1000}` reads it. Hex runs of 32 or more characters are redacted.
- RPC `overlay.stats` returns the bridge counters (counts only). About 10 s after start, the launcher prints them as one line.
- Fix: the overlay child's event stream used `fetch`. The event core refuses requests with `Sec-Fetch-*` headers (D62), so the stream was lost and retried forever. It now uses `node:http`.

## Real run (libobs host, no devices, `--mock`, fixture profile)

```
node <scratchpad>/alpha-run.mjs <worktree> <scratchpad>/alpha-data3 15000 --profile tests/fixtures/project/profile.fixture.json
  (runs: node services/studio-ui/launch.mjs --alpha --mock --no-open --stop-on-stdin --data-dir <dir> --profile <fixture>)
```

```
[serve] api on 127.0.0.1:58198 (mock Streamer.bot); api.json written (acl); data dir acl; no token printed; sending to platforms is off
[studio] host log: <scratchpad>\alpha-data3\logs\host-2026-11-03T02-03-38-139Z.log
[studio] libobs host started (devices off), previews H and V
[studio] alpha project built: alpha.project.json
[studio] WARNING: scene-default-v.json not found (registry/presets); the project has the H scene only and the V canvas stays empty
[studio] devices off: game capture and facecam are placeholders (run with --allow-devices --rebuild-alpha after "devices ready")
[studio] alpha project loaded into the host: {"scenes":1,"sources":11,"items":11,"audio":0,"overlayLayers":8,"relay":"display"}; not built: 2
[studio]   not built: lyr-5f8a62a9: unavailable: file not found
[studio]   not built: lyr-673c9164: unavailable: file not found
[studio] overlay server: running; event feed: on; child has the event token: yes; browser layers allowed
[studio] UI at http://127.0.0.1:58210/ (the login key is one-time and not printed). Ctrl-C stops everything.
[studio] overlay feed after 10 s: 3 overlay page(s) connected, 20 chat and 6 event frame(s) delivered, 2 effect(s)
[driver] launcher exit 0 after 19250 ms
```

The two layers that were not built are the brand wordmark and character images. The fixture profile names files that do not exist. This is expected.

Host log (decisive lines):

```
info: [host] overlay: ready (static 127.0.0.1:58201, feed 127.0.0.1:58202)
info: [host] preview opened: H 960x540
info: [host] preview opened: V 540x960
info: [host] overlay relay created (scope display)
info: [host] project loaded (project v1):2 canvases, 1 scenes, 11 sources, 11 items, 0 audio, 2 not built
info: [host] rpc overlay.stats role=api ok 1.0ms
info: [host] exit 0
```

Checks on that log: 194 lines. Hex runs of 32 or more characters: 0 (`grep -Ec '[0-9a-fA-F]{32,}'`). "event stream: lost": 0.

## Tests

```
node --test --test-concurrency=1 tests/studio-ui-alpha.test.mjs tests/overlay-server.test.mjs
  tests 35, pass 35, fail 0
node --test --test-concurrency=1 "app/host/tests/*.test.mjs"
  tests 32, pass 31, fail 1   (see below)
$env:PSModulePath = $null; node --test --test-concurrency=1 app/host/tests/host-api.test.mjs
  tests 11, pass 11, fail 0
npm run lint
  lint: 0 finding(s), 27 allow marker(s)
npm run validate:registry
  OK
npm test
  tests 904, pass 901, fail 2, skipped 1
```

The one host failure is the test "discovery: env token is not written, pid matches, owner-only DACL". It started from PowerShell 7, and the Windows PowerShell child it spawns inherited PowerShell 7's `PSModulePath`. As a result, `Get-Acl` could not load: "The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded". With `PSModulePath` cleared, `host-api.test.mjs` passes 11/11. The host suite includes the new `overlay.stats` assertions in `host-browser` and `host-project`, and `host-log.test.mjs` (3/3).

The 2 `npm test` failures are timing checks in `tests/event-core-streamerbot-credential.test.mjs`: "real async read keeps the event loop free" and "reconnect with a slow (500 ms) password read keeps max loop delay < 100 ms". Run alone, that file passes 15/15. These tests are outside this change. They are load-sensitive under the full suite and are reported, not changed.

`tests/studio-ui-alpha.test.mjs` covers:

- role matching on an anonymised `devices.list` fixture: preset match, override by path or name, ambiguous, missing, taken, placeholder ignored;
- the profile schema;
- the alpha build with and without V;
- a missing placeholder key;
- never-modify and rebuild;
- the profile and overlay bases;
- the launch spec in studio and alpha modes;
- host-log rotation;
- an end-to-end launcher run with a fake host (`tests/fixtures/studio-ui/fake-host.mjs`): flags, tokens by environment and never in argv, build then load unchanged, devices listed only on rebuild, and the overlay feed line.

## Not checked / UNVERIFIED

- Real devices: not opened (needs "devices ready"). The device-name substrings in `params.match` are UNVERIFIED against a real `devices.list`.
- Whether the capture card's audio comes through its video source (`aud-game` layer audio): UNVERIFIED.
- Default V: `registry/presets/scene-default-v.json` does not exist yet (another agent). V is empty with a warning.
- What the preview windows show, and where they sit on screen: not inspected by eye. Only the host log lines were checked.
- Real Streamer.bot: not contacted (`--mock` only).
- No live stream use: "awaiting live test".
