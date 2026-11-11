# 2026-11-11 LU3 service swap while live

Branch `lu/service-swap`. Plan row LU3 (D324), decision D337. Status: **mechanism done and tested with real service
processes; the loopback-stream run (0 dropped frames) is UNVERIFIED** (not run, see below). Behind the flag
`service-swap`, off by default.

## What it does

- The launcher owns a stable-port **front** for the event core and one for the studio UI server
  (`services/supervisor/front.mjs`). Clients only ever see the front ports. A swap holds new requests, waits for those
  in flight, opens a second event stream to the new backend (hand-off queue), lets the old stream end cleanly, sends
  the queued frames (skipping event ids not newer than the last one sent), then pipes live. The client keeps its
  connection.
- **Event core** (`services/event-core/api/swappable.mjs`, `cli.mjs --swap-control --standby --public-port`): the new
  core starts in standby (Streamer.bot connected, events buffered, no database). On the switch the old core hands off
  (Streamer.bot closed, bus and streams drained, audit closed). The new core activates (database opened, ids continue
  above the old core's last id, live lock state and panic carried over, buffer replayed through dedupe).
- **Studio UI server**: side by side; login sessions copied over IPC inside the switch; the stream is carried by the
  front and each new server starts it with the whole state the page listens to (status, flags, edits).
- **Workers**: stop-start slot with a health window and restore of the old version (`services/supervisor/slots.mjs`).
- **Refused**: the host (LU5) and the overlay server (child of the host).
- **State machine** (`services/supervisor/swap.mjs`): pure transition table plus a runner with step timeouts; results
  swapped / kept-old / restored-old / failed.
- **Launcher** (`services/studio-ui/launch.mjs`): with the flag on, the core and UI start behind fronts; a swap is asked
  only by the launcher's parent over IPC (`{ t: 'ujwalam-swap', id, service, root }`).

## Tests (run 2026-11-11, one file at a time where heavy)

Command:

```
node --test --test-timeout=120000 --test-concurrency=1 tests/service-swap-machine.test.mjs tests/service-swap-front.test.mjs tests/service-swap-event-core.test.mjs tests/service-swap-ui-worker.test.mjs tests/service-swap-launcher.test.mjs tests/service-swap-soak.test.mjs
```

Result: `tests 29, pass 29, fail 0` (73 s). The key lines:

```
✔ processes: 20 swaps under numbered chat, 0 lost, 0 duplicated, one client connection, RPC answered throughout, live lock kept
ℹ swaps 20, chat sent 6252, received 6252, rpc ok 715, held 20
✔ processes: a crashing new build is rolled back; the old core keeps serving with no event lost
✔ studio-ui: 20 swaps keep the login session, the API answers throughout, one event stream connection carries the state of each new server; a crashing build is rolled back
ℹ ui swaps 20, api calls 260, held 0
✔ worker (stop-start): 20 swaps; a crashing build restores the old version; planned stops are no crash
✔ launcher with the flag on: the event core and the UI server swap over IPC behind unchanged ports; the host is refused
```

What the event-core process test asserts: real `services/event-core/cli.mjs serve` processes, a mock Streamer.bot
sending a numbered chat message every 5 ms, one SSE client on the front port. After 20 swaps: every number 1..6252
received exactly once, event ids strictly increasing, one connection, 715 RPC calls through the front all answered
(none refused), live state still `live`, no forced stream cut, no unplanned exit. Rollback: a build that exits at
start (exit 3) and one that never becomes healthy (timeout) both give `kept-old` with no event lost; a good build
swaps afterwards.

Regression suites (changed files), all passing:

- `event-core-api*`, `event-core-model`, `event-core-streamerbot-cli`, `event-core-livelock`,
  `event-core-dedupe-persist`, `stream-recovery`, `studio-ui-server`, `studio-launch-d327`: 198 pass.
- `studio-ui-server`, `studio-ui-device-hotplug` (after the stream-open change): 43 pass.
- `stream-recovery`, `studio-ui-crash-recovery`, `studio-ui-core-url`, `flags`, `studio-ui-flags-feedback`,
  `event-core-streamerbot-cli` (after the launcher wiring): 54 pass.
- `live-soak`, `soak-system` (after the stack change): 18 pass.
- Pre-commit quick CI (build, lint, build-host, build-studio, validators, private scan): 9/9 on each commit.

## Loopback-stream soak: UNVERIFIED

`tools/soak/swap-soak.mjs` (`npm run soak:swap`) runs the live-soak stack (`startStack({ swap: true })`) on its
loopback RTMP listeners. It swaps the event core and the UI server between two staged versions 20 times, plus a
stand-in worker, while numbered chat flows. Then it rolls back a crashing build of each. It checks 0 dropped,
render-lagged and encode-skipped frames on the host, 0 dropped on every sink, every required stream live at every
sample, 0 lost or duplicated chat, and the same UI session throughout.

It was **not run** in this session: another heavy job was running (a long-running python process plus a studio
process). The brief allows the stream run only when no other heavy job is visible. Next step: run
`npm run soak:swap -- --wait` on an idle laptop and add its `swap-soak.json` result here. The 0-dropped-frames part of
LU3's "Done when" stays open until then. Reasoning (not evidence): a swap touches only Node processes on loopback
HTTP; the host's render and encode path does not wait on the event core or the UI server.

## Limits (D337)

- Pending Allow clicks and the undo history of the UI server are memory-only and not carried.
- An event without a platform message id that both cores saw in the overlap can appear twice.
- If the new core fails while activating (after the old one handed off), the old one is re-activated, but events the
  failed core buffered are lost (double failure).
- The Python workers are not wired to the worker slot in the launcher yet. The swap soak uses a stand-in worker.
- Host and overlay server: never swapped while live (LU5).
- A studio-window rearm that arrives during a UI swap waits until the swap ends (up to the swap's time limits).
- A hand-over that ignores its abort for longer than the grace (30 s) ends the swap as `failed` with nothing
  restored; the supervisor then needs a manual look.

## Codex review fixes (2026-11-11)

Codex reviewed the branch and found 1 P1 and 6 P2 problems. Each fix has a regression test that failed before the fix
(checked with the fix stashed) and passes after it.

- P1, `swap.mjs`: a step that timed out kept running. Each step now gets an AbortSignal. A timed-out step is aborted
  and awaited before the rollback or restore. A hand-over that ignores the abort past the grace ends the swap as
  `failed`, and nothing is restored on top of it. Tests: `service-swap-machine` (2), `service-swap-front` (1).
- P2, `event-core/api/server.mjs`: a core activated again refused event streams (`ending` stayed set). Fixed with
  `reopenStreams()`. Test: `service-swap-event-core`.
- P2, `supervisor/front.mjs`: the connect timeout of a handed-over stream was never cleared, so a quiet stream was cut
  after 5 s. Test: a stream quiet for 5.6 s survives.
- P2, `front.mjs`: streams were collected before in-flight requests drained. Test: a stream opened during the drain
  moves too.
- P2, `swappable.mjs`: a standby buffer overflow still let the swap succeed. The candidate now fails its check, is
  refused before the hand-off and can never activate. Test: overflow refusal (activate guard).
- P2, `sse.mjs`: the hand-off deadline ended at `res.end()`. It now lasts until finish, close or error. Test.
- P2 (security), `studio-ui/launch.mjs`: each new UI process got the original one-time login key, so a login URL
  already used worked again after a swap. Now only the first process gets the key. A replacement starts with key
  login off (`UJWALAM_UI_KEY_LOGIN=off`). Inside the front's switch it imports the key's state from the old process
  over IPC (`exportLogin`/`importLogin`: the key or null once used, its age, failures and lock). Malformed state keeps
  key login off. A studio-window rearm sent during a swap waits for the swap and goes to the process that serves after
  it (`uiSlot.control`). Tests: `service-swap-launcher` (the real launcher: unused key logs in once after a swap; a
  used key gets 401 after two more swaps; before the fix it got 302), `service-swap-ui-worker` (export/import cases;
  rearm during a swap; before the fix `control` did not exist).

Suites after the fixes, one at a time with `--test-timeout=60000`: machine 12, front 10, event-core 8 (20 swaps, 6486
events sent and received), event-core-api-sse 11, event-core-api 27, ui-worker 4, launcher 4, studio-ui-server 40,
studio-ui-alpha 37 (1 skipped, as before), studio-crash-capture 4, studio-tray 14, studio-ui-crash-recovery 5: all
pass. The full CI and the swap soak were not run (the soak stays UNVERIFIED, above).

## Also fixed

`services/event-core/cli.mjs` parsed `--lan` as an option that takes a value. The launcher's `--lan` then swallowed
the next argument (`--url <Streamer.bot>` or `--lan-address`), and `args.lan === true` was never true, so "Allow
remote connections" never switched on. `--lan` is now a switch (test in `tests/service-swap-event-core.test.mjs`).

## Files

Created: `services/supervisor/swap.mjs`, `services/supervisor/front.mjs`, `services/supervisor/slots.mjs`,
`services/event-core/api/swappable.mjs`, `tools/soak/swap-soak.mjs`, `tests/service-swap-machine.test.mjs`,
`tests/service-swap-front.test.mjs`, `tests/service-swap-event-core.test.mjs`, `tests/service-swap-ui-worker.test.mjs`,
`tests/service-swap-launcher.test.mjs`, `tests/service-swap-soak.test.mjs`, this file.
Changed: `services/event-core/{model,index,cli}.mjs`, `services/event-core/api/{sse,server,service}.mjs`,
`services/studio-ui/{server,cli,launch,stream-recovery}.mjs`, `tools/soak/stack.mjs`, `data/flags.json`,
`package.json`, `docs/plan/2026-10-29-v1-decisions.md` (D337).
