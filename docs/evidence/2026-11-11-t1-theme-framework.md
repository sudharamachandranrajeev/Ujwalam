# T1 theme framework (D336) — evidence, 2026-11-11

Result: **PASS** (headless). Flag `theme-components` is off by default; the on-screen look at real DPI and a live
flag switch in a real session are UNVERIFIED (see the end).

Spec: `docs/plan/2026-11-10-theme-framework.md` §3, §5 row T1, §6 answers. Decision: D336 in
`docs/plan/2026-10-29-v1-decisions.md`.

## What was built

- Schema v2 (`data/themes/theme.schema.json`): `components` block with enumerated variants only; caps flags and a
  type scale; `blueprint` and `columns` patterns; a `frame` with corner ticks; depth `highlight`, `inset`, `rim`
  (with `innerGlow`).
- `app/studio/src/theme.cpp`: `componentsProblem` (packProblem refuses unknown keys and variants), `componentQss`
  (variant fragments appended after the base stylesheet), derived colours, density factor, caps, probe fields
  `componentsOn`, `components`, `density`, `caps`, `pattern`, `frame`, `baseStyleHash`, `fragmentLength`; probe
  action `components:on|off`.
- `depth.cpp`: highlight (back), inset and rim with inner glow (front); High performance draws no depth effect.
- Painted widgets through the theme API: Switch variants, ValueSlider value bubble, task chips (bracket).
  Transport buttons and section headers through the fragments (`QPushButton#round`, `QGroupBox::title`,
  `QLabel#heading`).
- Density through `theme::space()` / `theme::margins()` at 73 fixed spacing call sites (factors 0.75 / 1 / 1.25).
- Caps by font capitalisation (`interaction.cpp` applyCaps); blueprint, columns and frame in the window backdrop.
- Specimen page `app/studio/src/specimen.cpp`: Settings > Appearance > "Preview all components" (only with the flag
  on), nine sections: BUTTONS, TRANSPORT, INPUTS, TABS AND SELECTION, SLIDERS AND PROGRESS, CHIPS, CARDS AND LISTS,
  FEEDBACK, HEADINGS AND TEXT.
- Flag `theme-components` in `data/flags.json`, off by default; the studio follows it live (`loadFlags`).

## Commands and results

All runs with `UJWALAM_HEADLESS=1`, one suite at a time, in the worktree `theme/t1-framework`.

```
npm run build:studio
```
```
built ...\out\studio\build\ujwalam-studio.exe
```

Commit hook quick CI on each commit (build, lint, build-host, build-studio, validate-*, private-scan, legacy-verify):

```
ci: 9/9 passed
```

```
node --test tests/studio-theme-contrast.test.mjs
```
```
✔ every variant in the schema has a contrast table (and only those)
✔ every pack, every state: text >= 4.5:1, controls and focus >= 3:1 (base look plus the variants it picks)
✔ base Switch gap: the ON side fails in the base look, every switch variant passes on every pack
✔ the check sees the variants: a pack whose variant breaks contrast fails it
✔ derived colours match theme.cpp for a sample (mix rounding)
✔ schema v2: a full components block validates; unknown variants and keys are refused
ℹ pass 6  ℹ fail 0
```

```
node --test tests/studio-qt-theme-components.test.mjs
```
```
✔ flag off (the default): no components, no fragments, no specimen button
✔ violet-night (no components block): the same base stylesheet with the flag on and off
✔ copper-graphite (no components block): the same base stylesheet with the flag on and off
✔ a pack using every variant: parts reported, no stylesheet errors, the specimen shows every section
✔ unknown variants or keys are refused: the pack is not listed and cannot be used
✔ the flag switches live (control page): components appear and the specimen button works
✔ the components probe action turns the parts off and on again
✔ High performance: a pack using every variant is drawn flat (no gradients, no depth effects)
✔ specimen picture at 100 % (copper-graphite)
✔ specimen picture at 125 % (copper-graphite)
✔ specimen picture at 150 % (copper-graphite)
ℹ tests 11  ℹ pass 11  ℹ fail 0
```

Other affected suites:

| Suite | Pass | Fail |
|---|---|---|
| tests/studio-themes.test.mjs | 10 | 0 |
| tests/flags.test.mjs | 7 | 0 |
| tests/g0-schemas.test.mjs | 25 | 0 |
| tests/data-reload.test.mjs | 13 | 0 |
| tests/guide.test.mjs | 14 | 0 |
| tests/studio-qt-themes.test.mjs | 21 | 0 |
| tests/studio-qt-theme-reload.test.mjs | 1 | 0 |
| tests/studio-qt-shell.test.mjs | 70 | 0 |

## Parity (packs without the new block)

The probe hashes the base stylesheet as applied (`baseStyleHash`, SHA-256, first 16 hex). For violet-night and
copper-graphite the hash is equal with the flag on and off, density stays 1, caps stay off, and the depth effect
count is equal. With the flag on, only two rules are added (`fragmentLength` < 400 characters): the error state of
fields and the value bubble; no studio widget outside the specimen uses either. With the flag off the fragment is
empty (`fragmentLength` 0) and a v2 pack shows its v1 parts (blueprint as grid, no frame).

## Contrast

Scope: every pack, states normal, hover, pressed, checked or selected, focus, error; text 4.5:1, control parts and
focus indicators 3:1; disabled text exempt (WCAG 1.4.3); decorative borders of filled controls not checked. Known
base gaps (unchanged looks, listed exactly in the test):

- tactical: warning text `#ee6a50` on the field colour `#2d3224` = 4.28:1.
- base Switch (flag off, or no switch variant): knob and ON in the text colour on the accent track, below 3:1 in most
  packs. Each switch variant (plain, labelled, bezel) paints onAccent there and passes on all nine packs.

## Specimen pictures

Copper Graphite (no components block, flag on), the whole specimen sheet rendered headless with
`QT_SCALE_FACTOR` 1, 1.25 and 1.5. The test checks each picture is the sheet's logical size times the scale (within
2 px):

```
UJWALAM_HEADLESS=1 UJWALAM_THEME_EVIDENCE=docs/evidence/2026-11-11-t1-theme-framework node --test --test-name-pattern="specimen picture" tests/studio-qt-theme-components.test.mjs
```

| Scale | File | Pixels |
|---|---|---|
| 100 % | `2026-11-11-t1-theme-framework/specimen-copper-graphite-100-specimen.png` | 1068 x 688 |
| 125 % | `2026-11-11-t1-theme-framework/specimen-copper-graphite-125-specimen.png` | 1335 x 860 |
| 150 % | `2026-11-11-t1-theme-framework/specimen-copper-graphite-150-specimen.png` | 1602 x 1032 |

The pictures contain only generic sample labels (no names, ids or reference images). The pack has no components
block, so these show the base look the framework keeps.

## Codex review fixes (2026-11-11)

Two P2 findings, each with a probe test that failed on a build without the fix (the fix lines reverted, rebuilt) and
passes with it:

```
UJWALAM_HEADLESS=1 node --test --test-name-pattern="no components block keeps|refused an edit" tests/studio-qt-theme-components.test.mjs
```

Without the fixes:
```
✖ flag on, a pack with v2 type, frame and depth fields but no components block keeps its v1 look
  (caps reported heading: true, tab: true)
✖ flag off after live reload refused an edit: the accepted pack is parsed again, all v2 parts go
  AssertionError [ERR_ASSERTION]: the component stylesheet is gone
ℹ pass 0  ℹ fail 2
```

With the fixes (whole suite): `ℹ tests 13  ℹ pass 13  ℹ fail 0`. Also passing after the fixes:
studio-qt-themes 21/21, studio-qt-theme-reload 1/1. The probe gained `depthV2Classes` (depth classes using
highlight, inset or rim): 0 for a pack without a components block, >= 2 for the all-variants pack.

## Not checked / UNVERIFIED

- UNVERIFIED: the look on the user's screen at real DPI (only headless offscreen renders).
- UNVERIFIED: switching the flag on the control page during a real session (tested through the studio's own flag
  action against the UI server in the headless probe).
- The window backdrop (blueprint, columns, frame) is painted only on shown windows; headless probe pictures without
  `UJWALAM_STUDIO_PROBE_SHOW=1` do not show it.
- Elevation levels 1-5 and the per-theme designs and fonts are not part of T1 (T2-T6).
- No live stream, no full CI, no soak (per the task brief).
