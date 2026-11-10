# Evidence: stream settings, outputs panel, transitions, integrations (D327 OS1–OS3, TR1, IN1)

Date: 2026-11-10. Branch: `ui/outputs-transitions-integrations`. Plan:
`docs/plan/2026-11-10-outputs-transitions-platform-connect.md` sections A–C.

Result: **PASS** for tests on mocks and loopback. Every item is behind a flag, off by default. Status: **awaiting live
test** (no real stream used; never tested against a real platform).

Flags: `stream-settings`, `outputs-panel`, `transitions`, `integrations` (all off by default).

## Commits

| Commit | What |
|---|---|
| ceb17e6 | stream setup model (`services/outputs/stream-setup.mjs`), `data/outputs/stream-options.json`, flags |
| 9236eb6 | LAN-only remote listener (`services/remote/lan-remote.mjs`) in the event core |
| 1b313f3 | UI server routes: stream setup and check, outputs panel and toggle, integrations, transitions |
| edfc8e9 | host: eased fades and force-complete transition per canvas |
| 9c09c58 | host test: live switch of one output on loopback keeps the others up |
| 62e799a | launcher: live plan from Settings > Stream; Streamer.bot port and LAN listener from Integrations |
| f34bd36 | Qt studio: Settings > Stream, Transitions, Integrations pages and the Outputs panel |

## What was built per id

- **OS1** Settings > Stream: canvas mode (main canvas / main + portrait), fps, resolution, quality, hardware encoder,
  bitrates, audio. Each value is checked against `data/platforms/*.json`; a value over a limit is shown in red with
  the limit, and Settings Save stays blocked on that page.
- **OS2** Outputs list: Add / Edit / Delete. The Edit window shows the Credential Manager key name
  (`Ujwalam/stream/<id>`) and a disabled **Connect** button (hook for the platform sign-in branch). Delete asks first
  and says the key is not touched.
- **OS3** Main-window Outputs panel: one switch per output, a + button (opens Settings > Stream), and a Virtual
  Camera row shown as "Not available in this build". Offline, a switch only saves. Live, a switch asks for
  "yes, on air" and then stops or starts only that sink.
- **TR1** Per canvas: type (cut / fade; a stinger stays on the main-window transition form), easing (data list, 20+ curves), duration, "Mirror main canvas
  transitions" for the portrait canvas, and "Force complete transition" (host RPC `transitions.forceComplete`).
- **IN1** Streamer.bot and Speaker.bot address, port, Test button and status. Streamer.bot stays read-only.
  "Allow remote connections": off by default; binds one private IPv4 address only (10/8, 172.16/12, 192.168/16),
  never 0.0.0.0, public, loopback, link-local, CGNAT or IPv6; same-subnet peers only; pairing token required, new on
  every start, passed by environment only and never stored; failed-auth rate limit; plain warning text.

## Commands and output

Node tests (headless, BelowNormal priority):

```
UJWALAM_HEADLESS=1 node --test tests/event-core-api.test.mjs tests/lan-remote.test.mjs tests/project-schema.test.mjs \
  tests/stream-setup.test.mjs tests/studio-launch-d327.test.mjs tests/studio-ui-stream-settings.test.mjs \
  tests/studio-ui-transitions.test.mjs
```

```
✔ private IPv4 only: 10/8, 172.16/12, 192.168/16; never 0.0.0.0, public, loopback, link-local, CGNAT, IPv6
✔ API server: refuses 0.0.0.0, public, loopback and IPv6 binds for the LAN listener; loopback API unchanged
✔ off by default: the service starts no LAN listener and writes no remote.json
✔ no private address on this machine: remote stays off (never a wider bind)
✔ LAN listener on a real private address: pairing token only, limited methods, no events, Host checked, other peers cut
✔ failed-auth rate limit: 3 on one connection closes it with 429; 20 per remote per minute then 429; valid tokens still pass
✔ livePlanFile: a setup over a platform limit stops the start with the problem
✔ coreServeArgs: --lan (and --lan-address) only when remote is given; never a token in argv
✔ Test button: TCP connect to 127.0.0.1:<port> through the mock; remote token only while the listener runs
✔ Force complete transition (TR1)
ℹ tests 169
ℹ pass 169
ℹ fail 0
```

Host tests (real host build):

```
node --test app/host/tests/host-transitions.test.mjs     # 7/7 pass, incl. "D327 TR1: easing per canvas; unknown or
                                                         # non-fade easing refused; force complete ends a running fade"
node --test app/host/tests/host-output-toggle.test.mjs   # 1/1 pass
```

Loopback toggle test (OS3): real host via `launch.mjs --mock --outputs plan`, two loopback RTMP sinks (twitch,
kick) with ffmpeg listeners. Go live with "yes, on air"; a plain "yes" for the kick switch is refused; "yes, on air"
stops kick only; twitch keeps growing and stays connected; kick on again into a new listener; End all; ffprobe on
each file: h264 640x360, packets twitch 320, kick-1 78, kick-2 80 (all > 30). PASS.

Qt studio (headless probe, real UI server, fake host, mocked TCP):

```
node --test tests/studio-qt-d327.test.mjs    # 5/5 pass (76.6 s)
```

- Stream: 60000 kbps refused with the 50000 limit shown; nothing written; the Edit window opened.
- Stream: 12000 kbps saved; Settings closed.
- Transitions: H fade, in-out-cubic, 800 ms, mirror saved into the project; Force calls
  `transitions.forceComplete {canvas:'H'}`.
- Integrations: Test goes to the mocked TCP check; remote on saves `enabled: true, address: null`; no token in the file.
- Outputs panel: offline switch saves; live switch opens the "yes, on air" window and nothing stops before it is typed.

Full regression of `tests/studio-*.test.mjs` before the Qt commit: 320 pass, 1 skipped. Commit hook CI: 9/9 pass.

## Codex review fixes (commit 084efcd)

Two P1 live-path findings, both fixed with regression tests:

1. A live switch-on confirmed just before End all could restart that output after End all. Now it takes the stop
   generation (and the go-live authority generation with the launcher) before its live check, re-checks before the
   host call (not sent) and after it (that output is stopped again).
2. With stream-settings on and outputs-panel off, Start stream started every sink, disabled outputs too. Now the
   saved enabled outputs are honoured while either flag is on; none enabled refuses with "No output is switched on".

```
node --test tests/studio-ui-stream-settings.test.mjs     # 13/13 pass (3 race tests, 2 flag tests new)
node --test app/host/tests/host-output-toggle.test.mjs   # 2/2 pass
# twitch-2: 132 video packets; kick-4: 0 bytes after End all
node --test tests/studio-*.test.mjs (Qt tests excluded)  # 250 pass, 1 skipped, 0 fail
```

## Screenshots

Headless pictures in `%TEMP%\ujwalam-d327-shots\` only (never in the repo): `stream.png`, `stream-settings.png`,
`stream-dialog1.png`, `transitions.png`, `transitions-settings.png`, `integrations.png`, `integrations-settings.png`,
`outputs-panel.png`, `outputs-panel-live.png`, `outputs-panel-live-dialog1.png`.

## Not checked (UNVERIFIED)

- UNVERIFIED: real platforms (YouTube, Twitch, Kick); loopback only.
- UNVERIFIED: Virtual Camera; the host has no virtual camera method, so the row is disabled.
- UNVERIFIED: the eased curve shape on recorded frames (the host formula is tested; frame luminance was not measured).
- Canvas resolution on the Stream page is read-only; it comes from the project.
- Stream and integration changes apply at the next start, not live.
- The LAN listener test needs a private IPv4 address on the machine; it passed here.
- The Speaker.bot port is used only by Test and the pre-stream readiness check.
- Connect (platform sign-in) is a disabled placeholder; the work is on branch `pc/platform-sign-in`.
