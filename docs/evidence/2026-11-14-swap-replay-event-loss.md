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
- Codex review follow-up (this commit): per-stream stall detection, only stalled streams leave the pacing, and a
  replay deadline (`REPLAY_DEADLINE_MS` 3000; then unpaced steps for at most half that again, then the last few
  events with the switch). Activation answer: `slowClient`, `late`; `core.status` swap counts: `replaySlowClients`,
  `replayLate`. `api/sse.mjs` stats now carry the stream name.

## Codex second-opinion review of aac1cb6 and outcome

| # | Finding | Verdict | Outcome |
|---|---|---|---|
| 1 | P1: stall detection on the sum of `sent`; a stream that keeps sending hides a full one, so activation can hang while the front holds requests | Real (events the core publishes itself, outside the buffer, keep a reading stream sending) | Stall tracked per stream (name, own `sent`, own timer). Test failed before (activation did not finish within 6 s), passes after (~2.2 s). |
| 2 | P1: after one stall, pacing is off for every stream, so later steps overflow healthy streams | Real | Only stalled streams leave the room check. Test (slow but progressing reader next to a stuck one, 3000 events) failed before (`: dropped 1633 events`), passes after (all 3000, no drop). |
| 3 | P2: the replay drains a buffer that ingress keeps refilling; sustained ingress can keep activation from finishing | Real (when ingress outruns the slowest non-stalled stream) | Deadline 3000 ms, then bounded unpaced steps, then the last few events with the switch. Order kept, nothing twice; a stream that cannot keep up gets counted, announced drops. Test failed before (not finished within deadline + 3 s), passes after (6/6 runs). An intermediate version that flushed everything at the deadline in one burst was caught by this test: 20 bus-level drops (bus queue 10 000, announced only at the 15 s heartbeat); the final burst is now at most one step. |

## Tests (run 2026-11-14, one heavy job at a time)

- `node --test tests/service-swap-event-core.test.mjs`: **13/13 pass** (57 s). 20-swap test: `swaps 20, chat sent
  5152, received 5152, rpc ok 628, held 20`. The five new tests (large replay to a reader, non-reading stream,
  Codex 1, 2, 3) each fail on the code before their fix (checked with `git stash` of the source files).
- Swap launcher, UI/worker swap, live updates, event-core API/SSE and bus suites: **108/108 pass**.
- `npm run lint`: 0 findings. Pre-commit hook quick checks: pass.
- Full `npm run ci`: not run in this session (asked not to).

## Remaining risk

- The same SSE queue drop can in principle hit outside swaps: a starved core that processes more than ~285 messages
  before its socket writes complete. UNVERIFIED; not changed here (the drop policy in `sse.mjs` is on the live path).
- Events lost when an old stream is cut at its 5 s hand-off deadline are logged, not recovered.
- Standby buffer overflow during the replay (20 000 events) is counted and reported, not recovered.
- Activation now takes a little longer (about 450 ms for 2000 events to one reader), bounded at 1.5 x 3 s, inside the
  supervisor's 15 s activate wait and the 10 s RPC timeout.
