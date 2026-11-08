# Evidence: filter, camera and compositing layer effects (D291 proposed)

Date: 2026-11-08. Branch `fx/host`, rebased onto `claude/alpha0-d1` @5ce9db6. Host: libobs 32.1.2, RTX 4050 Laptop (6 GB).

## What was built

GPU passes in libobs effect files (`app/host/data/effects/`, embedded through `UJW_EFFECTS`), one shader compiled once per
process and shared by every layer of that kind (private source `ujw_pass`). Two effects reuse OBS filters. All are layer
effects in project v1 (`layers[].effects`), validated in three places (host `model.cpp`, `services/project/validate.mjs`,
`data/schemas/project.schema.json`) and editable live through `layers.setEffects`.

| Group | Type | Params | How |
|---|---|---|---|
| filter | `sharpen` | amount 0..1 | OBS `sharpness_filter_v2` |
| filter | `vignette` | amount, size, softness 0..1, color | `ujw_vignette.effect` |
| filter | `grain` | amount 0..1, size 1..10 px | `ujw_grain.effect`, seeded per layer, new noise every frame (zero mean) |
| filter | `pixelate` | size 2..200 source px | `ujw_pixelate.effect` |
| filter | `posterize` | levels 2..32 (integer) | `ujw_posterize.effect` |
| filter | `lut` | file (.cube or 512x512 .png), amount 0..1 | OBS `clut_filter` |
| filter | B&W, sepia | existing `toner` (D258) | presets only |
| camera | `mirror`, `flip` | none | `ujw_flip.effect` |
| camera | `circleMask` | feather 0..25, borderWidth 0..25 (% of shorter side), borderColor | `ujw_shape_mask.effect` |
| camera | `roundMask` | radius 0..50, feather, borderWidth, borderColor | `ujw_shape_mask.effect` |
| compositing | `opacity` | opacity 0..1 | `ujw_opacity.effect` |
| compositing | `blendAdd`, `blendSubtract`, `blendMultiply`, `blendScreen`, `blendLighten`, `blendDarken` | opacity 0..1; at most one per layer | `obs_sceneitem_set_blending_mode` + opacity |
| compositing | `gradientMask` | angle -360..360, start, end 0..1 | `ujw_gradient_mask.effect` |
| compositing | `imageMask` | file, channel luma/alpha, invert, feather 0..100 px | private source `ujw_image_mask` (mask blurred once at load) |

File effects: a missing file is a plan warning (`{layer, effect, reason}`), the layer loads without that effect;
`layers.setEffects` refuses it (-32004). Paths never leave the host; `layers.list` returns the file ref.

Not built: background blur/removal (`registry/functions/camera-background-effects.json` notes what it needs, stays
planned); overlay and difference blend modes (libobs scene items offer only normal, additive, subtract, screen, multiply,
lighten, darken; the others need a backdrop read).

Meld import (`services/project/import-meld.mjs`): negative scale now maps to `mirror` / `flip` (a 180 degree rotation
with both negative is folded). Not mapped (no obvious match): Meld Sharpen (amount 100 scale unknown), Tint, Gradient
(a fill, not a fade), `blendMode` (always 0 in the sessions seen).

Qt `fxTypes()` table: sharpen, vignette, grain, pixelate, posterize (filter); mirror, flip, circleMask, roundMask (camera);
opacity, six blends, gradientMask (compositing). `lut` and `imageMask` are left out: the editor has no file field yet.

## Commands and results

```
node app/host/tools/build.mjs                      -> built out/host/build/ujwalam-host.exe
node app/studio/tools/build.mjs                    -> built out/studio/build/ujwalam-studio.exe
node --test --test-timeout=300000 app/host/tests/host-project.test.mjs
  -> tests 21, pass 21, fail 0
     "project v1 filter, camera and compositing effects render (D291)": one cell per effect on a 1280x720 recording,
       pixel checks: mirror/flip swap halves; circle corner clear, ring green inside the edge; rounded corner cut;
       opacity 0.5 grey; multiply yellow over #808080 ~ (128,128,0); screen blue over #808080 ~ (128,128,255);
       gradient start side shown, end side clear; vignette centre clear, corner black; posterize #606060 -> black;
       pixelate 40 px cells -> white/black/white; sharpen keeps a flat red; grain mean ~128 with sd > 2;
       .cube inverter turns red cyan; image mask (and inverted) shows/hides each half; stacked chain; layers.list round-trip
     "D291 file effects": missing lut -> plan warning; setEffects with a missing imageMask file -> -32004; blend+flip set live
     "D291 grain ... 3 flashes/s": grain flash check: peak 0 flashes/s over 179 frames (full canvas, amount 1, size 4,
       analysed with tools/fx-test.mjs analyseVideo, services/overlay-server/flash-detect.mjs definition)
     plus 11 new malformed-effect cases refused by both validator and host (-32602)
node --test tests/project-schema.test.mjs          -> pass 101, fail 0
node --test tests/project-import-meld.test.mjs     -> pass 31, fail 0
node --test tests/registry-layer-effects.test.mjs  -> pass 1, fail 0 (17 presets + 11 function defaults are valid effects)
node --test tests/studio-qt-shell.test.mjs         -> pass 19, fail 0 (Look panel groups now include compositing)
node --test tests/studio-ui-effects.test.mjs       -> pass 2, fail 0
node --test tests/fx-test.test.mjs                 -> pass 15, fail 0
node tools/registry-validate.mjs                   -> OK: registry valid
node tools/lint.mjs                                -> lint: 0 finding(s), 31 allow marker(s)
```

## Render cost

`UJWALAM_FX_BENCH=1 node --test --test-timeout=600000 app/host/tests/host-fx-bench.test.mjs`: six full-canvas
1920x1080 image layers, all with the same effect, 1080p60 canvas, no output; 2 s warm-up, 16 samples over 4 s.

| effect | frame ms | +ms vs none | +ms per layer | GPU % |
|---|---|---|---|---|
| none | 0.156 | 0.000 | 0.000 | 19 |
| blur 20 (existing, reference) | 0.244 | 0.088 | 0.015 | 28 |
| sharpen | 0.182 | 0.026 | 0.004 | 34 |
| vignette | 0.180 | 0.025 | 0.004 | 26 |
| grain | 0.201 | 0.046 | 0.008 | 29 |
| pixelate | 0.190 | 0.034 | 0.006 | 30 |
| posterize | 0.184 | 0.029 | 0.005 | 28 |
| lut (.cube) | 0.189 | 0.033 | 0.006 | 27 |
| mirror | 0.188 | 0.033 | 0.005 | 26 |
| circleMask + ring | 0.175 | 0.019 | 0.003 | 29 |
| roundMask | 0.211 | 0.055 | 0.009 | 29 |
| opacity | 0.225 | 0.069 | 0.011 | 30 |
| blendMultiply | 0.197 | 0.041 | 0.007 | 30 |
| gradientMask | 0.200 | 0.044 | 0.007 | 26 |
| imageMask | 0.186 | 0.031 | 0.005 | 27 |

Reading: every effect adds well under 0.1 ms of render-thread time for six 1080p layers (budget 16.7 ms at 60 fps).
GPU load rises from 19 % to 26..34 % with six full-canvas passes; the spread between effects is within run-to-run noise.

## UNVERIFIED

- Frame ms is `obs_get_average_frame_time_ns` (render thread, CPU side); GPU work is asynchronous, so it is not GPU time.
  GPU % is NVML whole-GPU load including other processes. No GPU timer queries were taken.
- Meld negative-scale semantics (which axis is "flip") checked against the importer's fixtures only, not a Meld render.
- Looks against Meld's own filters (sharpen strength, vignette curve, grain look): no reference renders (user gives none).
- 512x512 PNG LUT layout follows OBS `clut_filter`; only the .cube path was rendered in a test.
- Shaders work on the straight-alpha, non-sRGB path like the existing D257/D258 passes; colour accuracy of vignette/ring
  colours under sRGB canvases not measured beyond the 48-level test tolerance.
- Grain flash check covers amount 1 at size 4 on mid grey only.
- Not used on a real stream yet: functions and presets are `in-progress`, not done.

## Follow-ups (not built)

- Editor file field (and choice field) so `lut` and `imageMask` can be added from the Qt editor / Look panel.
- `placement.opacity` is still not applied by the host; it could reuse the opacity pass.
- Background blur/removal: segmentation model, VRAM reserve while live (see the registry note).
