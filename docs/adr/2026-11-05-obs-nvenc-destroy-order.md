# 2026-11-05 — obs-nvenc session destroyed before its registered textures (host access violation)

Status: proposed
Phase: Alpha 0 (host, encoder graph; high stakes: Opus + Codex review before acceptance)

## Context

- A rare access violation (0xC0000005) ends the host while a replay buffer on a shared NVENC rung stops
  (`outputs.clear`). Seen once in 84 `host-a0-day2` runs before the crash reporter existed, and captured once more on
  2026-11-05 with the text crash reporter (run 9 of loop B). Evidence: `docs/evidence/2026-11-05-host-shutdown-av.md`.
- Captured stack (thread `end_data_capture_thread`, not the GPU encode thread):
  `nvEncodeAPI64.dll+0x261f0` (read of reserved memory) <- `obs-nvenc!nvenc_destroy+0xff` <-
  `obs!obs_encoder_shutdown` (obs-encoder.c:708) <- `obs!remove_connection` (:405) <- `obs!stop_video_encoders`
  (obs-output.c:2820) <- `obs!end_data_capture_thread` (:2851).
- Disassembly of the shipped `obs-nvenc.dll` (32.1.2): the return address `+0x899f` follows the call to
  `nvEncUnregisterResource` inside the inlined `d3d11_free_textures` loop. That loop runs **after**
  `nvEncDestroyEncoder(enc->session)` (nvenc.c:1033 in 32.1.2). The driver is handed a destroyed session handle; it
  usually survives this (freed memory still readable), and rarely the memory is gone, so it faults.
- This is an upstream bug, fixed in obs-studio commit `bd96ff53dd` "obs-nvenc: Fix resource destruction order"
  (2026-02-10): textures and CUDA surfaces are freed before `nvEncDestroyEncoder`. GitHub compare: the commit is not
  in tag 32.1.2 and is contained in 32.2.0-beta1, so 32.2.0 and later have it (32.2.2 and 33.0.1 exist as of
  2026-11-05). Whether 32.2.x / 33.x introduce other changes the host depends on is UNVERIFIED.
- The earlier leading hypothesis (a race on `encoder_packet_times` with the GPU encode thread) is not what this
  capture shows: by the time `obs_encoder_shutdown` runs, `remove_connection` has already called `stop_gpu_encode`.
  That race may still exist, but it did not cause this crash.
- Host code cannot change the order inside `nvenc_destroy`. Every NVENC encoder destroy (rung change, sink stop,
  replay detach, shutdown) goes through this path, including while live.

## Options

1. **Move the OBS runtime to a release with the fix (32.2.2 or 33.0.x).** Cost: new runtime download and SHA-256 pin,
   rebuild against new headers/import libs, re-run every host, O2 loopback and live-keys test, re-check D36 and other
   32.1.2-specific notes (services.json URL, encoder behaviour). Risk: unrelated behaviour changes in libobs; larger
   change than the bug needs. Needs the user's yes (download/install).
2. **Rebuild only `obs-nvenc.dll` from 32.1.2 sources with `bd96ff53dd` cherry-picked**, keep the official 32.1.2
   `obs.dll` and other plugins. Cost: a vendor patch, a plugin build (CMake against the 32.1.2 libobs), its PDB,
   licence/notice update (GPLv2 source offer for the modified plugin), a checksum pin, and a build step in
   `tools/package/build-alpha.mjs`. Risk: small (an 11-line upstream reorder); the plugin ABI must match 32.1.2
   exactly. A one-file patch is easy to drop when moving to option 1 later.
3. **Host-side mitigation without patching**: avoid destroying NVENC encoders while the process lives (keep rungs
   alive, only detach outputs), and let process exit clean up. Cost: encoder sessions stay held (6 GB laptop, NVENC
   session limits probed at runtime), rung changes still need a destroy. Risk: only narrows the window; the crash
   still happens on any real rung change or at shutdown. Papers over the bug.
4. **Do nothing; rely on the crash policy (D163)**: the launcher restarts the host, recording restarts in a new file.
   Risk: streams are not auto-restarted, so a crash on a sink stop while live drops every live output. Not acceptable
   for the live path.

## Decision

Proposed: option 2 now (narrowest fix that removes the root cause, same official libobs), and option 1 as the
planned follow-up when the runtime is next moved. Not implemented; needs review (Opus sign-off + Codex second
opinion, high-stakes encoder graph) and the user's yes for the vendor build.

## Consequences

- Add a vendor patch (`bd96ff53dd`) and a reproducible `obs-nvenc.dll` build; record the SHA-256 of the patched DLL
  and PDB; update third-party notices for the modified GPL plugin.
- Re-check after the change: the day-2 loop (30+ runs) and the stress harness (1000+ cycles) with the crash
  reporter on; zero `crash-*.txt` expected. The failure rate is about 1 in 40-80 runs, so one clean 30-run loop is not
  proof by itself; record counts.
- When the runtime moves to 32.2+ (option 1), drop the patch.
