# 2026-11-11 SB4: a studio theme from a reference (D345)

Result: **PASS** on the drawn SB2 fixtures (colour mapping, variant choice, schema v2, T1 contrast, writer, CLI) and in
the headless studio (a generated pack loads with `theme-components` on with no stylesheet errors, and falls back to the
base look with it off).
Real references: every pack passes the contrast check and loads in the headless studio; whether each look matches its
reference is **UNVERIFIED** (no human check yet).

Branch `sb/restyle-theme` (from `claude/alpha0-d1` at 7051ab8, SB1–SB3 and T1 merged). Plan section C of
`docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` (D324), row SB4 ("Theme file from a reference passes
the WCAG checks"). Decision D345. Behind the flag `scene-builder` (off by default). Studio window only: no stream,
scene or output is touched.

## What was built

- `services/studio-ui/theme-contrast.mjs`: the T1 contrast pairs, `derived()` (mirror of theme.cpp) and the check,
  moved unchanged out of `tests/studio-theme-contrast.test.mjs`, which now imports them. One check for the shipped
  packs and the generated ones.
- `services/scene-builder/theme.mjs`: `themeFromRead(read, { name })` -> `{ pack, report }`. `mapColours` (palette
  roles to the 12 colour tokens, each with how / from / why), `chooseVariants` (style read to components, geometry,
  type, icon stroke, depth), `settleContrast` (pushes until every pair passes; each push reported), `writeThemePack`
  (user themes folder, temp file hard-linked into place, never over a file, never a built-in id or the built-in
  folder), `reportText` (the dry-run report).
- `services/scene-builder/colour.mjs`: `forceContrastAll` (the §4.6 lightness push against several grounds at once).
- `services/scene-builder/cli.mjs`: `theme <reference> [--name N] [--themes-dir DIR] [--apply] [--json]`; dry run by
  default; exit 2 with the flag off; exit 1 if the pack cannot pass the check or cannot be written.
- `tests/scene-builder-theme.test.mjs` (new), `data/flags.json` (flag text), `registry/functions/theme-from-media.json`
  (description; stays `planned`: the registry's `format` enum has no value for a studio theme pack, and the overlay
  side of 4.6 is not built).

## Tests

```
UJWALAM_HEADLESS=1 node --test --test-timeout=60000 tests/scene-builder-theme.test.mjs
UJWALAM_HEADLESS=1 node --test --test-timeout=60000 tests/studio-theme-contrast.test.mjs
UJWALAM_HEADLESS=1 node --test --test-timeout=60000 tests/scene-builder-reference.test.mjs
UJWALAM_HEADLESS=1 node --test --test-timeout=60000 tests/scene-builder-build.test.mjs
node tools/lint.mjs
```

```
scene-builder-theme       tests 17  pass 17  fail 0  skipped 0   (Qt probe ran: the shell was built in this worktree)
studio-theme-contrast     tests 6   pass 6   fail 0  skipped 0   (after the move to the shared module)
scene-builder-reference   tests 23  pass 23  fail 0  skipped 0
scene-builder-build       tests 20  pass 20  fail 0  skipped 0
lint: 0 finding(s)
```

What `scene-builder-theme` checks, on seven drawn fixtures (palette blocks, H and V layouts, glowing panels, light
panels with a drop shadow, square corners, small corners):

- Colour mapping: bg, panel and text equal the read roles on the palette fixture (`extracted`); the accent keeps the
  read accent's hue (within 6 degrees) when only its lightness moves; every `extracted` token is a read colour (a role
  or a cluster); every `derived` token names its source (background, surface, text, accent, cluster or a mix of them);
  danger and ok without a red or green in the picture say "convention".
- Variant choice: square corners -> sharp / boxed / filled / bracket / bracket / framed / bar and radius 0-0-2; round
  corners -> rounded with the studio radius = read radius / 2; glow -> focus glow, bezel, outline, primary glow in the
  read glow colour, no shadow drawn; drop shadow -> raised, solid, ring, card shadow below, no glow anywhere; plain ->
  flat, soft, border, no depth; a radius read below confidence 0.5 leaves the shape keys out (base look).
- Contrast: every fixture's pack is schema-v2 valid (Ajv, strict) with `failures(pack) = []`, worst text >= 4.5,
  worst control >= 3, and a full components block (14 keys with a radius read, 8 without). A read made to fail (grey
  text #9a9a9a on #808080, a dull accent) is pushed until it passes; text and accent are reported as moved.
- A red accent: danger is never the accent cluster itself (or a note says they are close).
- Writer and CLI: built-in ids, the built-in folder and an existing file are refused; no temp file is left; the file is
  never overwritten; flag off -> exit 2; a dry run writes nothing; `--apply` writes once; a second `--apply` and a
  built-in name exit 1; option misuse exits 1.
- Headless Qt probe (the pattern of `tests/studio-qt-theme-components.test.mjs`, `UJWALAM_THEMES_DIR` = temp folder):
  flag on -> id = the generated id, `custom: true`, listed, `componentsOn: true`, `focus: glow`, >= 9 components,
  fragments > 0, specimen page opens, no `Could not parse|Unknown property|stylesheet` on stderr; flag off -> the same
  pack, `components: {}`, `fragmentLength: 0`, no stylesheet errors.

## Real references (read only; nothing copied, generated packs kept in a scratch folder, never committed) — UNVERIFIED

Commands (scratch scripts calling the CLI; `--data-dir` = a temp folder with `scene-builder` on, `--themes-dir` = a
scratch folder; the user's `%APPDATA%` and `%LOCALAPPDATA%\Ujwalam` were not touched):

```
node services/scene-builder/cli.mjs theme "<theme reference>/<file>" --json --frames 8 --themes-dir <scratch> --data-dir <temp>
node services/scene-builder/cli.mjs theme "<stream assets>/Stream layout/<file>" --apply --name "Real N" --themes-dir <scratch> --data-dir <temp>
```

Every pack: exit 0, schema v2 valid (Ajv strict), T1 failures 0. Tokens: bg / text / accent / onAccent (`*` = derived).
"Pushes" are moves made after the mapping by the settle loop (moves made while mapping are in the colour's own line).

| # | Reference (base name) | Look | Pairs | Worst text / control | Pushes | bg / text / accent / onAccent | Components picked |
|---|---|---|---|---|---|---|---|
| 1 | Style guides AI design_ Standardize sizes across the system.jpg | light | 51 | 4.68 / 4.92 | 0 | #edede7 / #23221f / #2150b1 / #edede7* | bezel, outline, focus glow, flat, switch bezel, compact (no radius read) |
| 2 | Styleguides AI inspiration_ One spacing scale, endless consistency.jpg | dark | 51 | 4.55 / 6.51 | 0 | #393c40 / #e1cfc4 / #e1cfc4* / #393c40* | bezel, outline, focus glow, flat, switch bezel (radius below 0.5) |
| 3 | UI Design Templates_ Build Faster & Ship Products.jpg | light | 56 | 4.62 / 6.27 | 0 | #ece6d6 / #2a4643 / #2a4643* / #ece6d6* | rounded (radius 3), soft, tinted, border, underline tabs, compact |
| 4 | UI Design Templates_ Build Faster, Ship Smoother.jpg | dark | 51 | 4.53 / 3.20 | 2 (accentHi, text) | #1e3a45 / #b2d3cf* / #84a5b0* / #1e3a45* | bezel, outline, focus glow, flat, compact |
| 5 | Horizontal stream layout.png | dark | 44 | 4.54 / 3.04 | 4 (onAccent, danger, text, accentHi) | #72685b / #f2eed4* / #ffaab8* / #564c40* | soft, tinted, border, flat (no radius read) |
| 6 | vertical stream layout.png | dark | 44 | 4.56 / 4.56 | 2 (muted, danger) | #403b33 / #ebe0a8 / #d187ff* / #403b33* | soft, tinted, border, flat |
| 7 | OBS Studio concept with AI.mp4 (8 frames) | dark | 56 | 4.55 / 3.31 | 2 (muted, accentHi) | #21202e / #cccbd2 / #8c82c6* / #21202e* | rounded (radius 3), soft, tinted, border, underline tabs |

Headless studio, each pack applied to the scratch folder and opened with `UJWALAM_THEMES_DIR` (probe actions
`settings-open,settings-page:3,settings-specimen`):

```
real-1..7 flag on : exit 0, custom true, components 8 (packs 1, 2, 4, 5, 6) or 14 (packs 3, 7), fragments 999-1550, specimen open, stylesheet errors none
real-1..7 flag off: exit 0, custom true, components 0, fragments 0, stylesheet errors none
```

Observations (UNVERIFIED, for the human check):

- References 2 and 3 have no vivid accent: the accent is the text colour (2) or the most chromatic cluster (3), so
  primary buttons are text-coloured. Reference 2's danger (#ffb4a5) sits close to that warm accent; the report says so.
- Reference 5 has a mid-tone ground (#72685b): the text polarity makes it a dark pack, and muted ends almost equal to
  the text (#f2ecd6 vs #f2eed4) because nothing between them clears 4.5:1 on that ground.
- References 1, 2 and 4 read a glow (c 0.64-0.83) and get the glowing variants; none read a usable drop shadow, so no
  pack here has raised cards. The style guides are UI sheets: their radius reads were weak (0 or 4 corners).

## Not checked

- Whether each generated look matches its reference to a person's eye: UNVERIFIED.
- The real user folder: `%APPDATA%\Ujwalam Studio\themes` is where Qt's AppDataLocation puts `<app data>/themes` for
  the application name "Ujwalam Studio" with no organisation name (Qt documentation; theme.cpp `searchDirs`). Not
  exercised: tests and runs used `UJWALAM_THEMES_DIR` / `--themes-dir`. UNVERIFIED.
- Rendering on a real (non-offscreen) Windows display and at other scales.
- `build --theme-from-reference`: skipped (the build's `--theme` is an overlay brand theme id, a different system).
