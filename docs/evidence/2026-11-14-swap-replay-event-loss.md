# 2026-11-14 Event loss in the event-core swap replay (LU3, D337)

Branch `fix/swap-event-loss`. Status: **defect found, fixed and tested in-process and with real core processes; the
original full-CI failure was not reproduced under machine load** (the mechanism and its threshold were reproduced
deterministically instead, see below). Still behind the flag `service-swap`, off by default.

## Symptom

One full `npm run ci` run (heavy parallel load, 68 s for the file instead of 31 s) failed in
`tests/service-swap-event-core.test.mjs` "processes: 20 swaps under numbered chat, 0 lost, 0 duplicated ...":

```
AssertionError: missing 440,441,442,443,444,445,446,447,448,449 dup  of 11364
actual: { missing: 55, dup: 0 }  expected: { missing: 0, dup: 0 }
```

## Root cause (a real defect, not the harness)

`activate()` in `services/event-core/api/swappable.mjs` replayed the whole standby buffer in one synchronous loop. Each
event stream (SSE, `api/sse.mjs`) writes until its socket stops taking data (about 30 frames), then queues the rest in a
bounded queue (`sseQueueMax` 256) and drops the oldest beyond it as a "slow client", although the reader keeps up.
Only the events that came after the old core stopped taking events are published by the replay (the others are
deduped). Under load the gap between the old core's stop and the new core's replay (old streams draining, audit close,
stdin/stdout round trip, new audit open and dedupe load) grows; past about 285 events (about 1.4 s at 200 events/s)
the overflow starts. The drop takes the oldest queued events right after the first ~30 written, so the missing events
form one contiguous block. 55 missing fits a replay of about 340 published events. The client is told only by an SSE
comment (`: dropped N events (slow client)`), which the test client (and presumably the studio) ignores: in effect
silent loss of chat or alerts during a live update.

## Repro (in-process, standby core, one real HTTP SSE reader, N buffered events, then activate)

Before the fix (aac1cb6^):

| N | received | announced |
|---|---|---|
| 250 | 250 | none |
| 300 | 285 | `: dropped 15 events (slow client)` |
| 600 | 285 | `: dropped 315 events (slow client)` |
| 2000 | 285 | `: dropped 1715 events (slow client)` |

After the fix: N = 300, 2000 and 20 000 all received in full, no drop announced.

## Fix

- aac1cb6: the replay publishes at most 64 events per step (`REPLAY_CHUNK`, at most half of `sseQueueMax`), yields
  (`setImmediate`) so bus queues drain and writes complete, and waits until the streams have room. Events that arrive
  meanwhile join the end of the buffer (order kept); ingest goes to the core only once the buffer is empty, in the same
  synchronous step. The supervisor (`services/supervisor/slots.mjs`) logs an old stream that did not end cleanly at its
  hand-off deadline (`handed.streams.clean < streams`, returned before but never checked) and a slow client.
- b0c46c2 (Codex review follow-up): per-stream stall detection, only stalled streams leave the pacing, and a
  replay deadline (`REPLAY_DEADLINE_MS` 3000; then unpaced steps for at most half that again, then the last few
  events with the switch; superseded by the background drain below). Activation answer: `slowClient`, `late`; `core.status` swap counts: `replaySlowClients`,
  `replayLate`. `api/sse.mjs` stats now carry the stream name.

## Codex second-opinion review of aac1cb6 and outcome

| # | Finding | Verdict | Outcome |
|---|---|---|---|
| 1 | P1: stall detection on the sum of `sent`; a stream that keeps sending hides a full one, so activation can hang while the front holds requests | Real (events the core publishes itself, outside the buffer, keep a reading stream sending) | Stall tracked per stream (name, own `sent`, own timer). Test failed before (activation did not finish within 6 s), passes after (~2.2 s). |
| 2 | P1: after one stall, pacing is off for every stream, so later steps overflow healthy streams | Real | Only stalled streams leave the room check. Test (slow but progressing reader next to a stuck one, 3000 events) failed before (`: dropped 1633 events`), passes after (all 3000, no drop). |
| 3 | P2: the replay drains a buffer that ingress keeps refilling; sustained ingress can keep activation from finishing | Real (when ingress outruns the slowest non-stalled stream) | Deadline 3000 ms, then bounded unpaced steps, then the last few events with the switch. Order kept, nothing twice; a stream that cannot keep up gets counted, announced drops. Test failed before (not finished within deadline + 3 s), passes after (6/6 runs). An intermediate version that flushed everything at the deadline in one burst was caught by this test: 20 bus-level drops (bus queue 10 000, announced only at the 15 s heartbeat); the final burst was then limited, and since the follow-up below nothing is published more than one step at a time. |

## Follow-up: bus drops at the hard stop (full CI after b0c46c2)

Full CI under load (896 s test step) failed in the Codex P2 test: `no bus drop for sse-1 (the last burst stays small)
5504 !== 0`. Cause: the replay's own publishing, not the test's ingress (ingress goes into the standby buffer until
the switch, so it cannot reach the bus directly). When the post-deadline phase hit its hard stop (half the deadline
again) with a large backlog, the rest of the buffer went out in one synchronous burst, above the bus queues (10 000 for
a stream subscriber, 1000 by default). Bus drops are folded into the stream's announcement only at the 15 s heartbeat,
so on a slow machine this was the original defect class again.

Repro: four BelowNormal busy node processes on this 16-thread laptop did not trigger it (test 3 passed 5/5). A short
deadline seam (`replayDeadlineMs: 50`) with a 120 000-event backlog makes the hard stop certain. Before the fix:
`bus sse-1 dropped 108336`, `swap-last-id dropped 18336`, the client still waiting after 10 s.

Fix: nothing is ever published more than one step (64) at a time. At the deadline the activation answers
(`late: true, pending: N`) and the rest of the buffer drains in the background in steps, ingest still buffering behind
it (order kept), until it is empty; then ingest goes to the core. `handoff()` and `stop()` wait for that drain (ingest
has stopped by then, so it is finite). `replayDrained()` exposes it for tests. New tests: the large-backlog case (0 bus
drops for every subscriber, every event delivered or announced, in order) and a hand-off right after a late
activation (all 50 000 published first, stream ended cleanly).

## Follow-up 2: a reading stream dropped 6 in the background drain (full CI after cd9a99a)

Full CI (900 s test step) failed in the large-backlog test after 10 s: `got 106426, drops 6`, bus published 106 496 of
120 000, `sse-1 dropped 6, stalled false`. Two separate things:

- (a) Throughput, not loss: the background drain was still running when the test's 10 s wall-clock budget ran out.
  The tests now wait on `replayDrained()` and then on the delivery of the known, finite set with no wall-clock budget
  (bounded by the test runner's timeout), and the backlog is 15 000 (still 1.5 x the stream's bus queue, so the old
  hard-stop burst would drop). No production timeout changed.
- (b) Real defect: cd9a99a's background drain published its steps without the room check, so a stream that reads,
  only slower than the drain publishes (here in the same process as the core under CI load), overran its queue (256)
  and lost the oldest as a "slow client". A second, smaller gap: the paced part can end at its deadline while a
  stream is still full (`roomFor` returns at the deadline), and the drain's first step went out unchecked; that was
  the remaining 6 drops after pacing was added.

Repro: the large-backlog test with a reader that reads one chunk per 10 ms all the way (slow, never stalled) and the
assertion that nothing drops. On cd9a99a: `{ got: 1899, drops: 13101, slow: 0 }` (N 15 000; 28 101 of 30 000 at
N 30 000). With pacing but the drain publishing before its room check: `{ got: 29994, drops: 6 }`.

Fix (`swappable.mjs`): the background drain checks room before every step (same per-stream room check and stall rule
as the paced part, no deadline), and stops waiting only when `handoff()` or `stop()` needs it finished
(`drainUnpaced`) or when the buffer reaches half its cap (slow streams then take the counted, announced drop instead of
the buffer overflowing). A stall now also needs at least 10 looks without progress (`REPLAY_STALL_POLLS`), so a
process descheduled for a second under load is not mistaken for a stalled reader. Slow clients found in the
background are counted in `replaySlowClients` too.

## Tests (run 2026-11-14, one heavy job at a time)

- `node --test tests/service-swap-event-core.test.mjs`: **13/13 pass** (57 s). 20-swap test: `swaps 20, chat sent
  5152, received 5152, rpc ok 628, held 20`. The five new tests (large replay to a reader, non-reading stream,
  Codex 1, 2, 3) each fail on the code before their fix (checked with `git stash` of the source files).
- Swap launcher, UI/worker swap, live updates, event-core API/SSE and bus suites: **108/108 pass**.
- `npm run lint`: 0 findings. Pre-commit hook quick checks: pass.
- After the bus-drop follow-up, with four BelowNormal busy node processes running: the whole file 5 times, **15/15
  pass each run** (73-75 s; 20-swap test e.g. `chat sent 5893, received 5893`, 0 lost, 0 duplicated). The
  large-backlog test failed before this fix (bus drops above). Swap/SSE/bus suites again **108/108**, lint 0 findings.
- After follow-up 2, with eight BelowNormal busy node processes running: the whole file 5 times, **15/15 pass each
  run** (78-91 s; 20-swap test `chat sent 5917 / 6945 / 7909 / 6835 / 6795`, all received, 0 lost, 0 duplicated). Then,
  still under that load, the file concurrently with the swap/SSE/bus suites (`--test-concurrency=4`, as CI runs them):
  **123/123 pass** (20-swap test `chat sent 8774, received 8774`). The new late-drain test fails on cd9a99a (drops above)
  and passes 3/3 alone in about 8 s. Lint 0 findings.
- Full `npm run ci`: not run in this session (asked not to).

## Remaining risk

- The same SSE queue drop can in principle hit outside swaps: a starved core that processes more than ~285 messages
  before its socket writes complete. UNVERIFIED; not changed here (the drop policy in `sse.mjs` is on the live path).
- Events lost when an old stream is cut at its 5 s hand-off deadline are logged, not recovered.
- Standby buffer overflow during the replay (20 000 events) is counted and reported, not recovered.
- Activation now takes a little longer (about 450 ms for 2000 events to one reader), bounded at 3 s plus the audit
  open, inside the supervisor's 15 s activate wait and the 10 s RPC timeout. After a late activation the rest of the
  replay drains in the background; events arriving then wait behind it (latency, not loss). If ingress outruns even the
  unpaced drain for long, the standby buffer cap (20 000) is reached and the overflow is counted in `core.status`, not
  announced to streams.
- Bus-level drops (a synchronous burst above a subscriber's bus queue) are still announced to a stream only at the
  15 s heartbeat; nothing in the replay produces such a burst now, but the announcement delay itself is unchanged.
