# 2026-11-08 Corner pin layer effect (D259)

Status: test evidence (host render, headless, NVENC recording; import and schema tests) and a local import check on a
Meld session backup. Matching Meld's look: UNVERIFIED (no Meld reference render; corners are adjustable in the
project).

## Host render
`node --test app/host/tests/host-project.test.mjs`: 16 pass, including
`✔ project v1 corner pin draws the layer into its quad (D259)`.

Checked in the recorded frame: a 400 x 400 red layer pinned to a trapezoid (top edge 0.25..0.75) is white (the
background) at both top corners of its box, red at the top middle and both bottom corners, white 10 px left of the
slanted edge at mid height and red 10 px right of it; a blue layer pinned onto the right half of its box is empty on
the left half and blue on the right half to its bottom corner. The host refuses a corner of 1.2 and a pin without
bottomLeftY.

## Import and schema
`node --test tests/project-import-meld.test.mjs tests/project-schema.test.mjs`: 109 pass. A real CornerPin
(topLeftX 0.01, topRightX 0.92) imports as `cornerPin` with the same corners; an untouched pin imports nothing;
corners outside 0..1 are clamped and reported.

Meld session backup (local only, `legacy/`, never committed): the project validates with 1 corner pin (the other
CornerPin entries are untouched pins or V copies that differ from H); CornerPin is no longer reported. Still
reported: VenetianBlinds 6, FractalNoise 1.

## Files
app/host/data/effects/ujw_corner_pin.effect (new), app/host/src/effects.cpp, app/host/src/effects.h,
app/host/CMakeLists.txt, app/host/src/model.h, app/host/src/model.cpp, services/project/validate.mjs,
data/schemas/project.schema.json, services/project/import-meld.mjs, tests/project-import-meld.test.mjs,
tests/project-schema.test.mjs, app/host/tests/host-project.test.mjs, docs/plan/2026-10-29-v1-decisions.md.
