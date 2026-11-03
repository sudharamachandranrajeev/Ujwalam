# 2026-11-03 - Timing tests wait on conditions: evidence

Why: the full CI run of 2026-11-03 (P16a commit) failed only in `test`, on timing, while Meld Studio and Discord held the machine at about 45 % CPU (bench reported "background CPU load before start 48.2 %"). Failures: `event-core-streamerbot-credential.test.mjs:291` (max loop delay 145.2 ms > 100 ms), `label-server.test.mjs:709` (`waitFor` timeout after 5 s); earlier runs: soak-replay timeouts and E8-15 listen (`lines.length >= 4`). No product code was wrong in these runs.

## Changes

| Test | Was | Now |
|---|---|---|
| `tests/event-core-streamerbot-cli.test.mjs` (all `listen` runs) | child ran a fixed `--duration 4`; events emitted after a Subscribe wait that silently gave up at 5 s; a slow start meant no events and no fixtures | `listenUntilDone`: waits for the Subscribe, every emit counted in `received=`, every alert fixture in `fixtures=` (100 ms reports), then sends `stop` over IPC; `--duration 50` is only a hang cap; a missed condition throws with the output tail |
| `services/event-core/cli.mjs listen` | stopped only on `--duration` or SIGINT (a Windows kill is TerminateProcess, so no SIGINT, no final report) | also stops cleanly on IPC `'stop'` or disconnect when spawned with an IPC channel; an already-aborted signal ends at once |
| `tools/soak/replay.mjs` replay drain | fixed `sleep(3000)` | `waitDrained`: connector `received` >= sent, audit queues and in-flight 0, delivery counters unchanged over two child samples; cap max(60 s, 6 samples); result carries `drain { drained, waitedMs }`; the test asserts `drained` |
| `tools/soak/replay.mjs` crash mode | fixed `sleep(2000)` after the resend, `sleep(400)` for the probe, `sleep(2000)` at the end | waits until the restarted core handled (published + deduped) every resent event (`row.resendHandled`), until SSE shows the probe, and `waitDrained` at the end; 30 s caps |
| `tools/soak/replay.mjs stopChild` | `Promise.race` with an uncleared 120 s `sleep` | timer cleared on exit (it kept every caller alive ~2 min: soak-replay test file 132 s -> 23 s) |
| `tools/soak/core-child.mjs` sample row | no connector count | adds `received` and `auditInflight` (used by the drain) |
| `tests/label-server.test.mjs` `waitFor` | 5 s cap, error `timeout` | 30 s cap (hang guard only), error names the condition |
| `tests/event-core-streamerbot-credential.test.mjs` loop delay | fixed 100 ms limit | `loopLimit(readMs) = max(100, readMs / 2)`: a blocking read stalls the loop for about the whole read, so it is still caught; scheduler noise on a loaded machine is not. The real-read tests measure the read (`took`, or step 1 of the reconnect test); the fake-read tests use their 500 ms read |

## Commands and results (laptop, 2026-11-03, Meld Studio and Discord running, about 43 % CPU)

```
node --test tests/event-core-streamerbot-cli.test.mjs
  tests 7, pass 7, fail 0, duration 6.4 s
node --test tests/soak-replay.test.mjs tests/soak-system.test.mjs
  tests 10, pass 10, fail 0, duration 23.2 s   (drain {"drained":true,"waitedMs":1404}, was a fixed 3 s; file was 132 s)
node --test tests/event-core-streamerbot-credential.test.mjs tests/label-server.test.mjs
  tests 77, pass 77, fail 0, duration 24.8 s
```

Not yet shown: a full `npm run ci` with these changes (next hourly run, D190).

## Files

Changed: `services/event-core/cli.mjs`, `tools/soak/replay.mjs`, `tools/soak/core-child.mjs`, `tests/event-core-streamerbot-cli.test.mjs`, `tests/soak-replay.test.mjs`, `tests/label-server.test.mjs`, `tests/event-core-streamerbot-credential.test.mjs`. Created: this file.
