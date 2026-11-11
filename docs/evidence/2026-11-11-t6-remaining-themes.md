# T6 remaining themes (D348) — evidence, 2026-11-11

Result: **PASS** (headless). Flag `theme-components` stays off by default. The look on the user's screen at real DPI and a
live theme switch in a real session are UNVERIFIED (see the end).

Spec: `docs/plan/2026-11-10-theme-framework.md` §4 and §5 row T6. Decision: D348 in
`docs/plan/2026-10-29-v1-decisions.md`. Pattern: T2 to T5 (`docs/evidence/2026-11-11-t2-t5-reference-themes.md`). No
framework code, no new variant, no new font file. These five themes have no reference image; the component language is
the plan's own table (§4), written as data.

## Fonts

Only the three bundled SIL OFL 1.1 families (Inter, Barlow, Exo 2; sources and SHA-256 in
`docs/third-party-notices.md`). Nothing downloaded. The Windows families the packs used before (Segoe UI, Bahnschrift,
Trebuchet MS) are no longer the face; Segoe UI is only a fallback name. The probe checks that Qt resolves the bundled
family for the window font.

## Packs

| Pack | Font | Buttons | Tabs | Input | Focus | Switch | Slider | Header | Card | List | Chip | Density |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| studio-light | Inter | rounded solid, outline secondary | underline | outline | ring | plain | thin, round | rule | raised | plain | pill | normal |
| violet-night | Inter | rounded soft, ghost secondary | segmented | filled | glow | plain | thin, round, bubble | plain | raised | plain | pill | normal |
| neon-arcade | Exo 2 | sharp bezel caps, tinted secondary | boxed | underline | glow | bezel | thin, bar, bubble | bracket | framed | plain | pill | compact |
| retro-wave | Barlow | pill metal caps, outline secondary | pill | inset | glow | labelled | thick inset, sphere, bubble | caps | raised | plates | pill | normal |
| tactical | Barlow | sharp solid caps, outline secondary | segmented | filled | border | plain | thick, bar | rule (caps) | raised | plain | bracket | compact |

Type: caps flags and a type scale per pack (as in T2 to T5); Barlow 10.5 pt, Inter and Exo 2 10 pt.

Depth changes (data only):

- Plain buttons carry no depth effect in all five (`depth.button` is `{}`): the 2026-11-10 many-widgets rule. This removed
  neon-arcade's hover glow, retro-wave's hover glow, tactical's extrusion and studio-light's soft shadow.
  `tests/studio-themes.test.mjs` lists eight packs under the rule; sand-teal stays the one stated exception (D344).
- neon-arcade primary button: rim `accentHi` to `#0097a7`, 2 px, with an inner glow (cyan neon edge).
- retro-wave: card chrome rim (`#b8c4e0` to `#5c6a8a`, 1 px); primary button pressed inset.
- tactical: no glow on plain controls; the stencil look is the caps, the 2 px borders and the primary button bevel.

## Contrast

`services/studio-ui/theme-contrast.mjs` (shared check) passes for all nine packs in every state (normal, hover, pressed,
checked, focus, error): text 4.5:1, controls and focus 3:1, with each pack's variants and switch. One fix: tactical's
warning text `#ee6a50` on the field colour `#2d3224` was 4.28:1; danger is now `#f47a5e` (4.89:1). The known-gap list in
`tests/studio-theme-contrast.test.mjs` is now empty.

## Commands and results

All runs with `UJWALAM_HEADLESS=1`, one file at a time, in worktree `theme/t6-remaining`. The studio was built once
(`npm run build:studio`).

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| tests/studio-theme-contrast.test.mjs | 6 | 6 | 0 |
| tests/studio-themes.test.mjs | 10 | 10 | 0 |
| tests/user-settings-theme.test.mjs | 4 | 4 | 0 |
| tests/studio-qt-theme-reference-themes.test.mjs (probe, 5 new packs) | 26 | 26 | 0 |
| tests/studio-qt-theme-components.test.mjs | 13 | 13 | 0 |
| tests/studio-qt-themes.test.mjs | 21 | 21 | 0 |
| tests/studio-qt-theme-reload.test.mjs | 1 | 1 | 0 |
| tests/lint.test.mjs | 34 | 34 | 0 |

`node tools/lint.mjs`: 0 findings. Each commit passed the hook's quick CI (9/9). The reference-theme suite was run in two
parts (load and font tests: 11 of 11; specimen pictures of the five new packs: 15 of 15; the T2 to T5 pictures were not
redrawn, they are unchanged files). `tests/package-alpha.test.mjs` was not re-run (no packager change; it has one
failure that is on the base commit, see the T2 to T5 evidence).

## Specimen pictures

`docs/evidence/2026-11-11-t6-remaining-themes/<id>-<100|125|150>-specimen.png` (15 files): the whole specimen sheet
(Settings > Appearance > "Preview all components") headless at `QT_SCALE_FACTOR` 1, 1.25, 1.5. Generic labels only.

| Theme | 100 % | 125 % | 150 % |
|---|---|---|---|
| studio-light | 1045 x 674 | 1306 x 843 | 1568 x 1011 |
| violet-night | 1047 x 674 | 1309 x 843 | 1571 x 1011 |
| neon-arcade | 1073 x 674 | 1341 x 799 | 1610 x 959 |
| retro-wave | 1085 x 685 | 1356 x 856 | 1628 x 1028 |
| tactical | 1099 x 672 | 1374 x 840 | 1649 x 1008 |

```
UJWALAM_HEADLESS=1 UJWALAM_THEME_EVIDENCE=docs/evidence/2026-11-11-t6-remaining-themes node --test --test-name-pattern="specimen picture (studio-light|violet-night|neon-arcade|retro-wave|tactical)" tests/studio-qt-theme-reference-themes.test.mjs
```

## Not checked / UNVERIFIED

- UNVERIFIED: the look on the user's screen at real DPI; the pictures are offscreen renders. Semibold (600) selection is
  checked only by the picture and the resolved family name.
- UNVERIFIED: whether the packaged studio finds theme packs (`data/themes` is not in the package manifest; same as T2 to T5).
- The window backdrop (grid, scanlines, diagonal) paints only on shown windows; headless pictures do not show it.
- Barlow replaces Bahnschrift (tactical, neon was Bahnschrift SemiCondensed, now Exo 2) and Inter replaces Segoe UI: the
  feel of each pack changes with the face; it needs the user's eye.
- Plain-button cost of the pack depth rules while live: unchanged or lower than before (effects removed, none added).
- No live stream, no full CI, no soak.
