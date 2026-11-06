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

## Crash reporter (added 2026-11-05, not committed yet)

Next step 1 above is built, with one change from the proposal: **no minidump** (decision 2026-11-05, privacy:
process memory holds stream keys and tokens). The host now writes a text report instead.

Files: `app/host/src/crash.h` (design, privacy rules, limits), `app/host/src/crash.cpp`, installed in
`app/host/src/main.cpp` right after the host log is opened; `dbghelp` added to `app/host/CMakeLists.txt`.

What it does:

- Hooks: `SetUnhandledExceptionFilter` (last chance only; no vectored handler, so first-chance exceptions that a
  driver or plugin handles itself never produce a report), `SIGABRT`, `_set_purecall_handler`,
  `_set_invalid_parameter_handler`. The filter is put back on top once more after libobs, the plugins and the project
  are loaded (`crash::reassert`, a warning in the host log if a module had replaced it).
- Report: `<data dir>/logs/crash-<UTC time>-p<pid>.txt`. Kind, exception code and name, flags, faulting address as
  module+offset, for an access violation read/write/execute and the target (exact only in the null page), fast-fail
  code, thread id (main or not), the faulting thread's stack unwound with `RtlVirtualUnwind` as module+offset, then
  the same frames with dbghelp symbols (function, source file base name, line; PDBs next to the exe and in the OBS
  runtime's `bin/64bit` and `obs-plugins/64bit`; never a symbol server), host version, time, host log file name.
  One line also goes to stderr, which the launcher writes into its host log.
- Privacy: no register values, no memory contents, no strings read from process memory, no folder paths (base names
  only). An address that is not code in a loaded module or in the null page is printed as `<withheld>` with its
  memory state and type only, since its value could be made of data bytes.
- Safety: buffers, file name prefix, dbghelp and a dedicated reporter thread are set up at install. The crashing
  thread copies the exception record and context into a static slot, wakes the reporter and waits at most 20 s. The
  report is written with `WriteFile` (no CRT stdio); the header and the module+offset stack use no heap and are
  flushed before the dbghelp section. Each section runs under its own `__try`. One report per process; a second
  crashing thread waits for the first report.
- File limit: at most 10 `crash-*.txt`. With 10 present, no file is written (the stderr line still is, and the host
  log warns at start). Nothing is ever deleted.
- Exit codes are unchanged. The filter chains to the previous (CRT) filter and returns `EXCEPTION_CONTINUE_SEARCH`;
  the SIGABRT and pure call handlers return into the CRT; the invalid parameter handler ends with the same
  `__fastfail(FAST_FAIL_INVALID_ARG)` as the CRT default.
- Host log ring: not flushed. The log file already flushes every line (`log.cpp`), and reading the ring needs the
  log mutex, which the crashing thread may hold.
- Diagnostics bundle (`tools/diag/bundle.mjs`): the newest 5 `crash-*.txt` from the host data dir's `logs/` and the
  data dir's `logs/` go in as `crash/<name>`, through the same redactor as every other file.

Test trigger: `--test-crash <av|abort|cxx|purecall|invalid-parameter|stack-overflow>`, only with `--test-hooks`
(the existing test-only flag), fires right after install and **before libobs starts**: no GPU, no NVENC, no outputs.

Exit codes without a reporter, measured with a probe exe built by the same toolchain (`cl /O2 /MD /EHsc`, scratchpad,
not in the repo): `abort()`, `_purecall()`, `_invalid_parameter_noinfo()` and an uncaught throw all end with
0xC0000409, also with a SIGABRT handler installed. The host with the reporter ends with the same codes (test below).

```
node app/host/tools/build.mjs            (BelowNormal; MeldStudio was running, CPU-only build)
built C:\AI\Claude\Ujwalam\out\host\build\ujwalam-host.exe

node --test --test-concurrency=1 app/host/tests/host-crash-report.test.mjs
✔ crash report: av -> one text report, exit code 0xc0000005, no secret or path in it
✔ crash report: stack-overflow -> one text report, exit code 0xc00000fd, no secret or path in it
✔ crash report: abort -> one text report, exit code 0xc0000409, no secret or path in it
✔ crash report: cxx -> one text report, exit code 0xc0000409, no secret or path in it
✔ crash report: purecall -> one text report, exit code 0xc0000409, no secret or path in it
✔ crash report: invalid-parameter -> one text report, exit code 0xc0000409, no secret or path in it
✔ crash report: with 10 reports present, no new file is written and none is deleted; exit code unchanged
✔ crash report: --test-crash needs --test-hooks; an unknown kind is refused (exit 64, no report)
ℹ pass 8  ℹ fail 0

node --test tests/diag-bundle.test.mjs    pass 4, fail 0 (crash reports included, newest 5, redacted)
node --test tests/report-button.test.mjs  pass 15, fail 0
node tools/lint.mjs                       0 finding(s)
```

Sample report (the `av` trigger, on a second thread):

```
ujwalam-host crash report (text only: no memory dump, no register values, no memory contents)
version: 0.1.0
time: 2026-11-05T22:26:00.888Z
thread: 24316 (not the main thread)
kind: unhandled exception
code: 0xc0000005 (access violation)
address: ujwalam-host.exe+0x146c40
access: write at 0x0 (null page)
stack (faulting thread, module+offset, 5 frames):
  #00 ujwalam-host.exe+0x146c40
  ...
stack (symbols from PDBs; source file names only):
  #00 ujwalam-host!crash::`anonymous namespace'::test_av+0x0 (crash.cpp:551)
  #01 ujwalam-host!std::thread::_Invoke<std::tuple<void (__cdecl*)(void)>,0>+0xb (thread:60)
  #03 KERNEL32!BaseThreadInitThunk+0x17 [no PDB: nearest export, may be wrong]
end of report
```

Not run: the GPU host tests and the full `npm run ci` (MeldStudio was running; no NVENC work). Not tested: a real
crash after libobs has loaded, so symbols for `obs.dll` and the plugins come from `SymRefreshModuleList` at crash
time and are UNVERIFIED in this path (their PDBs are in the runtime).

Residual risks:

1. **Fail-fast paths skip every handler**: `/GS` cookie failures, CFG, and heap corruption that the heap reports
   with fail-fast (0xC0000409 / 0xC0000374). Hypothesis 1 above (a write at `array[-1]`) may end this way, and then
   no report is written. The launcher's `host-crashes.jsonl` still has the exit code. Whether WER LocalDumps fires
   for fail-fast despite `SEM_NOGPFAULTERRORBOX` is UNVERIFIED (and a dump would conflict with the privacy decision).
2. A module that calls `SetUnhandledExceptionFilter` after `reassert` (for example, if CEF were to start a crash
   handler when the first browser source is created) silently replaces ours. UNVERIFIED for OBS 32.1.2's CEF.
3. libobs `bcrash` goes through `def_crash_handler`, which prints to stderr and calls `exit(0)`: the supervisor sees a
   clean exit and there is no report. A `base_set_crash_handler` hook would be a separate change.
4. A crash while the loader lock is held can block `GetModuleFileNameW` or dbghelp: the header is on disk, the rest
   may be missing, and the process ends after the 20 s wait. During that wait the other host threads keep running.
5. An uncaught C++ exception is reported by code only (no type, no `what()`), by design.
6. One report per process; more crashes at once are not reported separately.

## Loop B with the crash reporter (2026-11-05 22:33 to 2026-11-06 00:40)

This section replaces the "Status" line at the top: **the crash was reproduced and captured. Root cause found: an
upstream obs-nvenc bug in OBS 32.1.2, fixed upstream in 32.2.0. No fix applied yet.**

MeldStudio was closed during all runs (checked before every loop run and every 25 stress cycles). Another process was
using NVENC during the runs (encoder about 21 % before the start, `nvml before 2` in the host's NVENC probe; the
process was not identified, it was not MeldStudio). All runs headless, BelowNormal, one GPU job at a time. Host binary
built 2026-11-05 22:27, newer than every host source file, so not rebuilt.

| run | what | result |
|---|---|---|
| loop B | `host-a0-day2.test.mjs`, 32 runs in sequence (scratchpad `loop2.mjs`) | 31 PASS, 1 FAIL (run 9: exit 3221225477, crash report written) |
| stress B | one host, 1000 cycles: configure (replays bind to h1/v1), record start/stop, clear (scratchpad `stress2.mjs`) | 1000/1000, exit 0, no crash report |
| suite | all 11 files in `app/host/tests`, `--test-concurrency=1` | 73 pass, 0 fail |

Crash reports found after all runs: one, `out/host/tests/a0d2-mVPI7G/logs/crash-2026-11-05T22-41-50-421Z-p49736.txt`.
No `host-crashes.jsonl` (the host tests start the host directly, not through the studio launcher that writes that log).
No stray host, node, ffmpeg or python processes from these runs afterwards.

Host log of the failed run: the same window as the first failure. `replay H detached`, then
`Output 'ujw:replay:V': stopping` and the frame counts, then nothing.

The report (complete, as written by the host):

```
thread: 40648 (not the main thread)
kind: unhandled exception
code: 0xc0000005 (access violation)
flags: continuable
address: nvEncodeAPI64.dll+0x261f0
access: read at <withheld> (reserved private)
stack (symbols from PDBs; source file names only):
  #00 nvEncodeAPI64!? (no symbol)
  #01 obs-nvenc!nvenc_destroy+0xff
  #02 obs!obs_encoder_shutdown+0x3c (obs-encoder.c:708)
  #03 obs!remove_connection+0x252 (obs-encoder.c:405)
  #04 obs!stop_video_encoders+0x17a (obs-output.c:2820)
  #05 obs!end_data_capture_thread+0x66 (obs-output.c:2851)
  #06 w32-pthreads!ptw32_threadStart+0x171
```

The reporter worked on a real crash after libobs had loaded: obs.dll and obs-nvenc.dll symbols resolved from their
PDBs (this was UNVERIFIED above).

### Analysis

- `dumpbin /disasm` of the shipped `obs-nvenc.dll` (32.1.2): `nvenc_destroy+0xff` (RVA 0x899f) is the return
  address of the `nvEncUnregisterResource` call inside the inlined `d3d11_free_textures` loop
  (`nvenc-d3d11.c:158`). In 32.1.2, `nvenc_destroy` (`nvenc.c:1018`) calls `nvEncDestroyEncoder(enc->session)`
  first and only then `d3d11_free_textures`, which unregisters every texture against that destroyed session. The
  driver reads freed session memory; usually it is still mapped, rarely it is not, and then the read faults.
- Upstream fixed this in commit `bd96ff53dd` "obs-nvenc: Fix resource destruction order" (2026-02-10): textures and
  surfaces are freed before `nvEncDestroyEncoder`. GitHub compare: not in tag 32.1.2, contained in 32.2.0-beta1.
- **Hypothesis 1 (the `encoder_packet_times` race) is refuted for this crash.** The faulting thread is
  `end_data_capture_thread`, and `remove_connection` has already run `stop_gpu_encode` before
  `obs_encoder_shutdown`. That race may still exist in libobs, but it did not cause this crash. **Hypothesis 2 (NVENC
  teardown) is confirmed**, with the bug in obs-nvenc, not in the driver. **Hypothesis 3 (host code) is refuted**:
  no host frame is on the stack.
- The first failure (20:45, no report) stopped at the same log line in the same call, so it is very likely the same
  bug (UNVERIFIED: no stack for that one).
- Why stress B did not hit it in 1000 cycles (about 2000 NVENC destroys) while the day-2 test hit it twice in about
  116 runs: UNVERIFIED. The day-2 test creates and destroys more encoders per run (probe encoders, fallback rungs,
  shared rungs), and the fault needs the freed session memory to be unmapped, which depends on what else the driver
  allocates and frees at that moment.
- This path runs on every NVENC encoder destroy: sink stop on the last user of a rung, rung change, replay detach,
  shutdown. Including while live.

### Proposed fix (not implemented)

There is no host-side fix: host code cannot change the order inside `nvenc_destroy`. ADR draft:
`docs/adr/2026-11-05-obs-nvenc-destroy-order.md`. It proposes rebuilding only `obs-nvenc.dll` from 32.1.2 sources
with `bd96ff53dd` cherry-picked (the narrowest fix that removes the cause; the official `obs.dll` stays unchanged),
then moving the runtime to 32.2.x or later as the follow-up. It needs review and the user's yes.

After the fix: the same loop (30+ runs) and stress (1000+ cycles), zero crash reports expected. At about 1 failure in
50 runs, one clean 32-run loop is not proof by itself; record the counts.
