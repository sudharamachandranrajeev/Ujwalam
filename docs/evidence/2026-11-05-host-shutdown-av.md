# Host access violation in host-a0-day2 (2026-11-05)

Status: **root cause UNVERIFIED. No fix applied. Not reproduced in 13 + 515 attempts.**

## Symptom

One full `npm run ci` run failed in the test-host step:
`app/host/tests/host-a0-day2.test.mjs:61`, assertion "host exits 0", got 3221225477 (0xC0000005, access violation).
The previous full CI on the same host code passed 15/15.

## Where the crash happened (from the host log of the failed run)

Failed run data dir: `out/host/tests/a0d2-LckB3i` (log `logs/host-2026-11-05T20-45-00.log`, 471 lines).

- The host did **not** crash at shutdown. It crashed at 20:45:16.086Z, about 25 s before the `after()` hook ran.
  The `after()` hook only saw the exit code of a process that was already dead.
- The host writes every log line with `fflush` (`app/host/src/log.cpp`), so the log tail is the real last point.
- The last call was `outputs.clear` in the test "replay: binds to the configured rungs ... follows clear".
  The `rpc outputs.clear` line never appears.
- Last lines:
  ```
  20:45:15.804Z debug: output 'ujw:replay:H' destroyed
  20:45:15.804Z info: [host] replay H detached
  20:45:16.086Z info: Output 'ujw:replay:V': stopping
  20:45:16.086Z info: Output 'ujw:replay:V': Total frames output: 388
  20:45:16.086Z info: Output 'ujw:replay:V': Total drawn frames: 404
  ```
- In a good run (`a0d2-hjC9GP`), the next line about 140 ms later is `output 'ujw:replay:V' destroyed`.
  When normalised (timestamps, numbers, paths), the good log and the failed log are the same line for line up to
  this point.

So the crash happened in this window: libobs had stopped data capture for the V replay buffer (bound to the
shared rung encoder `ujw:enc:v1`), and the host thread was in `Outputs::replay_detach_locked`
(`app/host/src/replay.cpp`), polling `obs_output_active` before `obs_output_release`.

## What runs in that window (OBS 32.1.2 source)

- `replay_buffer_data` (obs-ffmpeg-mux.c) reaches `stop_ts` on an encoder packet callback, which is the GPU encode
  thread or the audio thread. It calls `obs_output_end_data_capture`, which runs `log_frame_info` (the last log
  line) and starts `end_data_capture_thread`.
- `end_data_capture_thread` runs `obs_encoder_stop(v1)`. That is the last user of v1, so it runs
  `remove_connection`, then `stop_gpu_encode` (the V canvas mix has no other GPU encoder, so the GPU encode thread
  is joined and freed), then `obs_encoder_shutdown` (NVENC destroy). The same happens next for the shared AAC
  encoder.
- Host threads: at that moment no other host thread touches libobs. The RPC call is in progress, and the
  supervisor, moments, panic and hotkeys threads are all idle.

## Hypotheses, ranked (none proven)

1. **A libobs data race on `encoder->encoder_packet_times`** (obs-encoder.c, the same in upstream master as of
   2026-11-05). `obs_encoder_stop` runs `encoder->encoder_packet_times.num = 0` with no lock. At the same time the
   GPU encode thread runs `da_push_back_new` (obs-video-gpu-encode.c:172) and `da_erase` (obs-encoder.c:1367) on
   the same array, also with no lock. If the store lands inside those few instructions, `darray_end` writes
   32 bytes at `array[-1]` (heap corruption), or `memmove` gets a size that has wrapped below zero (an immediate
   access violation). The window is open on every `obs_encoder_stop` while the encoder is still encoding. That
   includes stopping one sink while another sink keeps using the same rung, for example Twitch and Kick on one
   rung. The window is very short, which matches a failure rate of about 1 in 84 runs.
2. A race in NVENC teardown or the NVIDIA driver, in `obs_encoder_shutdown` after the GPU encode thread is
   joined.
3. Something in host code. No candidate found: the signal handlers are disconnected before `obs_output_stop`,
   save waits hold their own output reference, and `release_graph` releases the outputs before the encoders.

The "security: scoped markers host role" commit (47bdde7) is **not involved**. The markers token is hashed into
`markers_digest_` in the `rpc::Server` constructor, before `main.cpp` zeroes it. The crash is in the
output/replay path, not in the RPC path or at shutdown.

## Reproduction attempts

All attempts were headless (`UJWALAM_HEADLESS=1`) at BelowNormal priority, one GPU job at a time. The host was
built with a temporary diagnostic: a vectored exception handler that writes a symbolised stack to
`<data>/logs/crash-diag.txt`, using the dbghelp PDBs of obs.dll, the plugins and ujwalam-host. Patch kept outside
the repo, now reverted, and the host rebuilt clean.

| attempt | what | result |
|---|---|---|
| loop A | `host-a0-day2.test.mjs`, sequential | 13/13 PASS (stopped at run 13, see below) |
| stress1 | one host, 150 cycles: configure (replays bind to h1/v1), record start/stop on h1+v1, clear (last stop on h1/v1) | 150/150, exit 0, no AV |
| stress2 | same, 500 cycles, with synthetic CPU load (4 threads, low priority; reported separately) | 365 cycles, then an RPC timeout: NVENC init took 15 s with the GPU at 47 % render lag. No AV, exit 0 |
| stress3 | same, no synthetic load | timed out at cycle 0 (GPU busy); exit 0 |

History in `out/host/tests`: 84 day-2 runs, and only one ended without `[host] exit` (this one). The other
unclean logs are 66 intentional kills (`live-keys-crash`), plus `browser-ahxeuV` (2026-11-04), whose log ends at
`obs_shutdown begin`. That is a separate thing and was not examined.

**Testing stopped**: MeldStudio started at 21:49:51 and holds an NVENC session (GPU at 46-50 %, 3.1 GB VRAM). No
more NVENC loops were run while it was open, so that the user's session gets no GPU contention.

## Why the host collects no dump today

The host is started by Node. libuv sets `SEM_NOGPFAULTERRORBOX`, and child processes inherit it. So WER logs no
Application Error event and writes no LocalDumps file for `ujwalam-host.exe`. There is none for 20:45. The host
itself has no crash handler.

## Next steps (proposed, not done)

1. Add a permanent host crash reporter: `SetUnhandledExceptionFilter`, which writes a minidump plus a symbolised
   stack to `<data>/logs/`. Without it, the next one-in-84 failure is lost again.
2. With Meld closed, loop again: the test file 30+ times and the stress harness for 1000+ cycles, with the
   reporter on.
3. If the stack is in `gpu_encode_thread` / `send_off_encoder_packet` / `darray_*` (hypothesis 1), the narrowest
   correct fix is in libobs: lock `encoder_packet_times`, for example under `init_mutex` / `gpu_encoder_mutex`, or
   clear it only after `remove_connection`. That means a patched obs.dll instead of the official 32.1.2 binary.
   That is a design decision (vendor patch plus rebuild), so it needs an ADR, and it should also be reported
   upstream. A host-side workaround cannot lock libobs-internal state, so it would only paper over the race.

Scripts used (scratchpad, not in the repo): `loop.mjs`, `stress.mjs`, `load.mjs`, `diag-veh.patch`.
