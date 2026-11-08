# 2026-11-08 Shadow and glow layer effects (D257)

Status: test evidence (host render, headless, NVENC recording) and a local import check on the user's real Meld
session. Matching Meld's look: UNVERIFIED (needs a Meld reference render of the same layer).

## Host render
`node --test --test-name-pattern="effects|shadow" app/host/tests/host-project.test.mjs`:

```
✔ project v1 effects: host refuses malformed effects; plan and layers.list carry them
✔ project v1 effects render: blurred duplicate, sharp original, rounded corners after crop
✔ project v1 shadow and glow render past the box; the picture keeps its place and size (D257)
✔ frames.grab: the layer source at native size, never the composed canvas or its effects (BMP, top-down BGRA)
✔ project v1 effects audio: an item with effects keeps its source audio in the mix, at the same level
```

Checked in the recorded frame: a 200 x 200 card with a hard shadow (size 0, distance 40, angle 135) keeps its
corners at 200 and 400 (blue at 205 and 395); the shadow is black right of and below the card and absent left of and
above it, and ends at 428; a glow (size 30, spread 0.8, cyan) is cyan 5 px outside the card and absent 50 px out.
The blur and rounded-corner render tests still pass after the blur code moved into shared helpers.

## Import
`node --test tests/project-import-meld.test.mjs`: 28 pass. DropShadow {angle 55, distance 24.4, size 26.08,
opacity 50} imports as `shadow` {opacity 0.5, size 26.08, distance 24.4, angle 55}; GlowStyles edgeStyle 0 as `glow`
(choke -> spread); edgeStyle 1 is reported; order blur, rounded, shadow, glow.

Real session (local only, file in the gitignored stream assets folder): 17 shadow and 19 glow effects imported, the
project validates; still reported: BrightnessContrast 16, CCToner 9, CornerPin 8, VenetianBlinds 6, HSV 1,
FractalNoise 1, GlowStyles edgeStyle 2 1.

## Validation
`node --test tests/project-schema.test.mjs`: 73 pass (seven effects, shadow distance above 200, glow without
spread, glow with an angle are refused); the host refuses the same in host-project.test.mjs.

## Files
- app/host/data/effects/ujw_shadow.effect (new), app/host/src/effects.{h,cpp}, app/host/CMakeLists.txt
- app/host/src/model.{h,cpp}, app/host/src/studio.cpp (bounds grow by the outset)
- services/project/validate.mjs, data/schemas/project.schema.json, services/project/import-meld.mjs
- app/host/tests/host-project.test.mjs, tests/project-schema.test.mjs, tests/project-import-meld.test.mjs
