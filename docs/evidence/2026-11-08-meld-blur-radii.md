# Meld blur and corner radii import (P5, D247)

Date: 2026-11-08. Status: import mapping tested; visual match with Meld UNVERIFIED.

## What changed

- `services/project/import-meld.mjs` `effectsFor`:
  - Enabled `GaussianBlur` with `blurriness > 0` becomes `{type: 'blur', strength}`.
    `strength = blurriness / |scaleX|`, clamped to 1..100, one decimal.
  - Non-zero `radii` become `{type: 'rounded', radius}`, added after the other effects.
    `radius = min(largest corner, min(width, height) / 2) / |scaleX|`, capped at 500, one decimal.
  - Corners that differ by more than 0.5 keep the largest, reported as "radii that differ per corner (largest kept)".
  - `showOriginalOnTop` on a blur is reported, not imported.
  - At most 3 Meld effects are imported, leaving room for the rounding; extra ones are reported.
- `toPlacement` no longer reports "rounded corners (radii)" as ignored.

## Why these units

- In Meld session files, `width`/`height` are the layer box in canvas pixels.
- `scaleX` is canvas pixels per source pixel. The importer's fill-mode crop for video devices already relies on
  this: `implicitWidth - width / scaleX` is the cropped source width.
- The same radius value (76.3) appears on boxes 614 to 1418 px wide, and one layer has 286.7 on a 387 x 373 box.
  A designer-set canvas-pixel radius, drawn clamped to half the box, fits both.
- The project's `blur.strength` (sigma = strength x 0.5 source px) and `rounded.radius` are source pixels after crop,
  hence the division by the scale.

## Open (UNVERIFIED)

- The H target layout image (`data/stream assets/Stream layout`, 831 px wide) shows a game-frame corner of roughly
  20 image px, about 46 canvas px. The mapping gives about 76 canvas px for that box (Meld radius 76.3). The image is a
  layout target, not a Meld capture, so it does not settle the unit.
- Meld's blur unit is not documented. A side-by-side render (Meld vs Ujwalam, same layer) is needed to confirm both.
- One project effect list is shared by H and V; the V copy's scale differs, so these layers are reported as
  "V effects that differ from H (H kept)".

## Evidence

Unit tests:

```
node --test tests/project-import-meld.test.mjs
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

New test: "blur and corner radii (D247)": 400 x 300 box at scale 0.5, radius 40, blurriness 31.25 gives
`[{blur 62.5}, {rounded 80}]`; radius 900 on uneven corners gives `rounded 300` plus the report; zeros import nothing.

Real sessions (re-imported from the user's three Meld session backups, then loaded into a headless host with devices
and browser layers off, every scene activated):

| Session | blur | rounded | chromaKey | Load | Scene activations |
| --- | --- | --- | --- | --- | --- |
| 27 Sep | 15 | 28 | 53 | ok | 18 ok, 0 fail |
| 28 Sep | 18 | 32 | 64 | ok | 20 ok, 0 fail |
| 29 Sep | 15 | 28 | 53 | ok | 20 ok, 0 fail |

Still reported and not imported: BrightnessContrast, CornerPin, DropShadow, GlowStyles, VenetianBlinds, CCToner, HSV,
FractalNoise.

## Files

- `services/project/import-meld.mjs`
- `tests/project-import-meld.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D247)
- `docs/plan/2026-11-03-handover.md`
- `docs/evidence/2026-11-08-meld-blur-radii.md`
