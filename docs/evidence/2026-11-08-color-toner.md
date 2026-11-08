# 2026-11-08 Colour and toner layer effects (D258)

Status: test evidence (host render, headless, NVENC recording; import and schema tests) and a local import check on a
Meld session backup. Matching Meld's look: UNVERIFIED (the user gives no Meld reference renders; the effects are
adjustable in the project so they can be tuned by eye).

## Host render
`node --test app/host/tests/host-project.test.mjs`: 15 pass, including

```
✔ project v1 effects: host refuses malformed effects; plan and layers.list carry them
✔ project v1 color and toner effects render (D258)
```

Checked in the recorded frame (flat colour layers, so the result does not depend on how luma or gamma are read):
brightness +1 lifts a black card to white; saturation -1 turns a red card grey (channels within 24 of each other,
red below 200); a toner maps a white card to its highlights colour (red) and a black card to its shadows colour
(blue); toner amount 0 leaves a green card green; the background is untouched. The host refuses a brightness of 1.5,
a colour effect without hue, a tone that is not #RRGGBB and an amount of 2.

## Import and schema
`node --test tests/project-import-meld.test.mjs tests/project-schema.test.mjs`: all pass (schema 77). Real values
from the session backup: BrightnessContrast {121.51, 50} -> color {brightness 0.81, contrast 0.5}; HSV {hueAdjust
-0.12, satAdjust 0.18, valAdjust -0.2} -> color {hue -21.6, saturation 0.18, brightness -0.2}; CCToner (five hex
colours, weight 1) -> toner with lower-case colours, amount 1; out-of-range values are clamped; HSV colorize and
per-colour adjusts are reported; a toner with a colour that is not #RRGGBB is reported.

Meld session backup (local only, `legacy/`, never committed): the project validates; BrightnessContrast, HSV and
CCToner are no longer reported. Still reported: CornerPin 10, VenetianBlinds 6, FractalNoise 1.

## Files
app/host/data/effects/ujw_toner.effect (new), app/host/src/effects.cpp, app/host/src/effects.h,
app/host/CMakeLists.txt, app/host/src/model.h, app/host/src/model.cpp, services/project/validate.mjs,
data/schemas/project.schema.json, services/project/import-meld.mjs, tests/project-import-meld.test.mjs,
tests/project-schema.test.mjs, app/host/tests/host-project.test.mjs, docs/plan/2026-10-29-v1-decisions.md.
