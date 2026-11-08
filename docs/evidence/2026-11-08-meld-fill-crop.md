# Meld import: fill crop for media and duplicate layers (D253)

Date: 2026-11-08. Status: tests pass; real sessions re-imported; not compared with a Meld render (UNVERIFIED, same
as the video device crop from 2026-11-05).

## Finding

The three real Meld sessions (`data/stream assets/Stream Session Backup/`, local) reported "fitmentMode other than 0"
112, 148 and 118 times. A tally by Meld source kind (fitmentMode, and whether implicit size x scale equals the box):

| Kind | Mode | Picture vs box | Per session |
|---|---|---|---|
| Duplicator | 2 | equal | 69-81 |
| Duplicator | 2 | larger (needs a crop) | 12-14 |
| Duplicator | 1 | equal | 6-7 |
| Media source | 2 | larger (needs a crop) | 2-4 |
| Video device | 2 | larger (already cropped since 2026-11-05) | 23-27 |
| Text | 2 | equal | 9-11 |
| Browser | 2 | equal / larger / smaller | 4-7 / 1-2 / 0-12 |
| Widget, Spark, Media, Duplicator, Game capture | 2 | no size (16x16 or none) | many |

Most reports needed nothing (the picture already equalled the box). The duplicates and media whose picture is larger
than the box were stretched instead of cropped.

## Change

- `services/project/import-meld.mjs`: the fill crop applies to `capture`, `image`, `media` and `duplicate` layers
  (`FILL_CROP_TYPES`). A picture equal to the box: no crop, no report. Other cases are reported by reason. Offsets are
  reported only when not 0.
- Host check: `app/host/src/studio.cpp` builds a duplicate from the target's shared source (`find_src(pi.source_layer)`),
  not from the target's effects wrapper, so its own crop is the only crop.

## Evidence

Real sessions (re-imported in memory, nothing written):

```
27092026 crops {"capture":20,"duplicate":9,"media":2}  without a known picture size 40, offset 21, does not cover 4, browser 1
28092026 crops {"capture":23,"duplicate":10,"media":4} without a known picture size 47, offset 25, does not cover 5, browser 14
29092026 crops {"capture":20,"duplicate":9,"media":2}  without a known picture size 40, offset 21, does not cover 4, browser 7
```

```
node --test tests/project-import-meld.test.mjs
ℹ pass 27
ℹ fail 0

node --test tests/project-*.test.mjs tests/studio-ui*.test.mjs
ℹ pass 266
ℹ fail 0
```

New test: "fill mode on media and duplicates crops too; a picture equal to the box needs nothing; the rest is
reported (D253)".

## Open

- Meld's offsetX/offsetY on filled layers (21-25 per session) is still ignored; its sign and unit are unknown.
- Browser layers in fill mode with a picture larger or smaller than the box are reported, not cropped.

## Files

- `services/project/import-meld.mjs`, `tests/project-import-meld.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D253), this file, handover
