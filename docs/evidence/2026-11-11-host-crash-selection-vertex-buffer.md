# 2026-11-11 — Host crash: selection box left a destroyed vertex buffer loaded (D357)

Status: fix verified by tests; on a real stream UNVERIFIED (needs the next session with effects changed while a layer
is selected).

## Crash reports (local, not committed)

| Report | Code | Address | Stack (top, graphics thread) |
|---|---|---|---|
| crash-2026-11-11T21-01-47 | 0xC0000005 | d3d11.dll+0x179882 | libobs-d3d11 device_draw <- obs_source_video_render <- wrap_render (effects.cpp:112) <- render_target (effects.cpp:258) <- blur_render (effects.cpp:327) |
| crash-2026-11-10T16-35-05 | 0xC0000005 | d3d11.dll+0x179882 | same |

Host log, 2026-11-11: `preview.select` 21:01:37; six `device_draw ... This vertex shader requires a point buffer`
errors from 21:01:38; `layers.setEffects` (shadow on the capture-card layer) 21:01:47.390; crash 21:01:47.6.
The 2026-11-10 log has three of the same errors before its crash.

## Cause (libobs 32.1.2 source)

- `libobs/graphics/graphics.c` `gs_render_stop`: with `gs_render_start(true)` it saves the vertices into a new vertex
  buffer (`gs_render_save`), loads it, draws, then destroys it.
- `libobs-d3d11/d3d11-subsystem.cpp:2783` `gs_vertexbuffer_destroy` clears `device->lastVertexBuffer` only;
  `curVertexBuffer` keeps the freed pointer.
- `LoadVertexBufferData` (line 1760) rebuilds the input from `curVertexBuffer` whenever the shader changes; the freed
  object gives null buffers ("requires a point buffer", d3d11-vertexbuffer.cpp:31) or, once the memory is reused, an
  access violation in `Draw`.

## Fix

`app/host/src/preview.cpp` `solid_pass`: `gs_render_start(false)` (persistent immediate buffer, 512-vertex cap
counted per pass), then `gs_load_vertexbuffer(nullptr)`.

## Test

```
node --test --test-timeout=300000 app/host/tests/host-preview-edit.test.mjs app/host/tests/host-preview-headless.test.mjs
ℹ tests 21
ℹ pass 21
ℹ fail 0
✔ crash 2026-11-11: effects switched on and off while the selection box is drawn: no stale vertex buffer, host stays up
```

The same test against the build from before the fix also passed: the freed buffer's memory was not reused in that
run, so the crash is not reproduced on demand. The test proves the selection box is drawn (`selectionDraws` grows)
while the effects change, with no "point buffer" line and the host up.

## Integrity audit of the host (Codex, second model family, 2026-11-11)

Scope: effects.cpp/h, preview.cpp/h, preview_edit.cpp, overlay.cpp, frames.cpp, studio.cpp/h (sources inlined; Codex
cannot read the repo in its sandbox). Classes: libobs graphics misuse, lifetime/threading, other crash or recording
corruption.

- Graphics misuse: no further findings beyond the fixed selection-box buffer.
- P2 `Studio::layer_set_effects`: the replacement item was added visible and hidden by a second call, so one frame
  could show it at its default size over the old layer (in a recording too). Fixed: add + hide inside one
  `obs_scene_atomic_update`.
- P2 `Studio::scene_remove`: the scene a fade or stinger was leaving could be removed; `destroy_scene` emptied it while
  the transition still drew it. Fixed: refused (CONFLICT) while the routed transition holds the scene as source A or B.
  Test: host-transitions "the scene a running fade is leaving cannot be removed until the fade ends".
- P1 `Overlay::call`: blocking `WriteFile` to the overlay child's stdin with `m_` held; a child that stopped reading
  would hang the call, `stop()` and the supervisor. Fixed: the write happens only when it fits the pipe's free space
  (same check as the mic feed); otherwise UNAVAILABLE "overlay server is not reading its input".
- P2 shadow (effects.cpp `shadow_geom`): a large source shown very small asked for padded textures past the d3d11 limit;
  every texrender failed and the layer vanished. Fixed: padded size capped at 8192 px a side; a frame with no shadow
  texture draws the layer without its shadow. No dedicated test (UNVERIFIED at runtime).

Codex re-review of the fixes: all four FIXED, no new P1/P2.

```
node --test --test-concurrency=1 host-transitions host-project host-preview-edit   ℹ tests 44  pass 44  fail 0
node --test --test-concurrency=1 host-api host-browser host-stinger                ℹ tests 27  pass 27  fail 0
```
