# T2–T5 reference themes (D344) — evidence, 2026-11-11

Result: **PASS** (headless). Flag `theme-components` stays off by default. The look on the user's screen at real DPI and
a live theme switch in a real session are UNVERIFIED (see the end).

Spec: `docs/plan/2026-11-10-theme-framework.md` §2 A–D, §3.1, §5 rows T2–T5, §6. Decision: D344 in
`docs/plan/2026-10-29-v1-decisions.md`. Framework: T1 (D336), `docs/evidence/2026-11-11-t1-theme-framework.md`. No
framework code was added; the four packs use only existing variants.

The reference images are third-party and local only; nothing from them is copied or committed. The tables below are my
own measurements and readings, mapped to pack values. "Ref" is what the image shows; "Pack" is the value in
`data/themes/<id>.json`.

## Fonts

| Family | Used by | Source, version, licence, SHA-256 |
|---|---|---|
| Inter | daylight-blue, sand-teal | `docs/third-party-notices.md` ("Bundled theme fonts"): rsms/inter release 4.1, OFL 1.1 |
| Barlow | copper-graphite | same section: google/fonts `ofl/barlow`, version 1.408, OFL 1.1 |
| Exo 2 | teal-grid | same section: NDISCOVER/Exo-2.0 commit `182060cd`, version 2.001, OFL 1.1 |

Regular, semibold and bold of each (400, 600, 700). Loaded at start by `loadBundledFonts()` (theme.cpp) with
`QFontDatabase::addApplicationFont` from `data/fonts`; the probe reports the loaded families (`bundledFamilies`) and the
family Qt resolves for the window font (`appliedFamily`), which equals the pack's family in all four packs.

## A. daylight-blue (reference: light product style guide)

| Ref measurement or behaviour | Pack value |
|---|---|
| Cobalt primary, white surfaces, light grey ground, near-black text, dark-grey secondary text | Colours unchanged from the shipped pack (already match; contrast passes) |
| Neo-grotesque sans, sentence case | `typography.family` Inter; all caps flags false |
| Type scale H1 > H2 > subtitle > body > caption > button (about 2.6 : 2 : 1.6 : 1.4 : 1 : 1.2 of caption) | `scale` h1 18, h2 12, subtitle 11, body 10, caption 8, button 10 (pt) |
| Spacing scale 4, 8, 16, 24, 32, 48 | `spacing` 4 / 8 / 16; `density` airy (x1.25) |
| Radius none, 4, 8, 16, full | `radius` small 4, medium 8, large 16 (controls 4, cards 8) |
| Elevation 4 levels, shadow tinted with the accent blue | `depth` card low (blur 10, y 2, `#1d3f9e` 10 %), menu medium (14, y 4, 16 %), toast and task panel high (24, y 8, 22 and 20 %), primary button shadow `#0b4fd6` 28 % |
| Selected card: blue edge glow | `depth.card.glow` accent, blur 12, 30 %, when `active` |
| Primary solid blue; secondary white with 1 px blue outline, light-blue fill on hover | `button.style` solid, `secondary` outline, `shape` rounded, `caps` false |
| Text link style | not a component in the studio: the plain secondary outline is the closest |
| Inputs: white fill, 1 px grey outline, 4 px corners, red error outline | `input` outline; the error rule is the T1 fragment (danger border) |
| Focus: separate focus-ring token | `focus` ring (2 px accent) |
| Underline tabs, selected blue with 2 px underline | `tabs` underline |
| Chips: outlined pill, grey filled pill | `chip` pill |
| Faint layout column lines on an off-white ground | `background` pattern `columns`, `#0b4fd6` 5 %, spacing 64 |
| Section titles with a rule under them | `sectionHeader` rule |
| Switch: plain track and knob | `switch` plain (paints onAccent on the ON side: fixes the base switch contrast gap) |
| Thin slider, round handle, no value bubble | `slider` thin / round / bubble false |
| Cards raised, rows plain | `card` raised, `list` plain |

## B. copper-graphite (reference: dark copper metal style guide)

| Ref measurement or behaviour | Pack value |
|---|---|
| Gunmetal greys, rose-gold / copper accent, red-orange errors, off-white text | Colours unchanged from the shipped pack (already match; contrast passes) |
| Humanist sans, caps with tracking on buttons, tabs, section titles, table headers | `typography.family` Barlow, `buttonCaps`, `tabCaps`, `headingCaps`, `captionCaps` true, `letterSpacing` 0.3, `captionLetterSpacing` 1.6; base 10.5 pt (Barlow is smaller than Segoe UI at the same size) |
| Type scale | `scale` h1 16, h2 12, subtitle 10, body 10.5, caption 8.5, button 10 |
| Spacing 6 / 10 px; density medium | `spacing` 6 / 10 / 14; `density` normal |
| Radius 4, 8, 12, full; pills and discs | `radius` 4 / 8 / 12; `button.shape` pill, `tabs` pill |
| Borders 1 to 4 px drawn as copper metal rims (light to dark) | `rim` gradients: card `#b9826a` to `#4a3b36` 1 px; primary button accentHi to `#8a5436` 2 px; toast accent to `#5a3b2b`; task panel as card |
| Raised: bevel plus copper rim light; elevation 4 levels with heavy soft shadows | card shadow blur 24, y 8, 55 %; card `highlight` 1 px light edge (accentHi 14 %) |
| Primary button: metal gradient, copper rim plus outer glow; pressed sunken with inner glow | `button.style` metal; primary `rim` with `innerGlow` accent 40 %, `glow` accent always, `inset` (pressed) blur 8, y 2, 50 % |
| Plain buttons | stay without a depth effect (the 2026-11-10 many-widgets rule); metal gradient from the stylesheet |
| Inputs: dark sunken well in a rimmed frame; focus a glowing copper ring | `input` inset, `focus` glow |
| Switch: pill track, metal knob, copper glow when on | `switch` bezel |
| Slider: thick sunken track, glowing copper fill, ball handle, value bubble | `slider` track inset, handle sphere, `valueBubble` true |
| List rows as raised plates | `list` plates |
| Tabs as raised metal pills, selected copper | `tabs` pill |
| Pills for status | `chip` pill |
| Smoke, cracks, drips, astronaut | dropped (not UI; §6.3) |

## C. sand-teal (reference: warm sand neumorphic style guide)

| Ref measurement or behaviour | Pack value |
|---|---|
| Cream ground, surfaces the same colour as the ground, one deep teal, slate text, taupe muted, red errors | Colours unchanged from the shipped pack (already match; contrast passes) |
| Clean grotesque, bold caps with tracking on section headers, sentence case on components | Inter; `headingCaps` and `captionCaps` true, `buttonCaps` and `tabCaps` false, `headingWeight` 700 |
| Type scale | `scale` h1 16, h2 12, subtitle 10, body 10, caption 8, button 10 |
| Radius 4, 8, 12, 16, 24; inputs 6 to 8, cards 12 to 16, buttons full pill | `radius` 6 / 12 / 16; `button.shape` pill |
| Generous density (8 / 16 / 24) | `density` airy (x1.25) |
| Raised plates lit from the top left: light shadow up-left, dark down-right | `depth.highlight` white 80 to 85 % at (-3 to -6, -3 to -6), `shadow` `#9c8a70` 45 % at (+3 to +6, +3 to +6) on card, button, primary button, round control, toast, menu and task panel |
| Inset and pressed are sunken | `depth.inset` (pressed) on button and primary button; `input` inset (fields) |
| Button: teal filled pill, white text, soft shadow; pressed darker; disabled flat taupe | `button.style` neumorph, primary teal; disabled colour from the base |
| Focus: 2 px teal ring with soft glow | `focus` ring |
| Switch: teal pill with ON or OFF inside the track | `switch` labelled |
| Slider: thin teal track, raised round knob, dark value bubble | `slider` thin / round / `valueBubble` true |
| Tabs in one raised container, selected teal and bold | `tabs` segmented (approximation: the selected segment is a teal fill, not an underline; an underline-in-container variant does not exist, no new variant added) |
| Raised cards, list rows in one raised plate | `card` neumorph, `list` plates |
| Teal pill badges | `chip` pill |
| Elevation 5 levels (flat, hover, raised, modal, popover) | one step each on button (hover lift from motion), card (raised), toast and task panel (modal), menu (popover); T1 has no numbered levels |

## D. teal-grid (reference: dark teal blueprint UI kit)

| Ref measurement or behaviour | Pack value |
|---|---|
| Deep teal ground, glowing cyan accent, brass bezels, coral warnings, pale cyan text | Colours unchanged from the shipped pack (already match; contrast passes); brass as hex in the rim (`#e0c27a` to `#7a5a20`) |
| Technical sans; caps on tabs, chips, dropdown items, section labels; sentence case on buttons | Exo 2; `tabCaps`, `headingCaps`, `captionCaps` true, `buttonCaps` false, `letterSpacing` 0.3, `captionLetterSpacing` 1.6 |
| Type scale | `scale` h1 15, h2 12, subtitle 9.5, body 10, caption 8.5, button 10 |
| Spacing 4, 8, 16, 24 modular; dense | `spacing` 4 / 8 / 16; `density` compact (x0.75) |
| Border 1 to 2 px "refined edge"; corners 4, 8, 12 | `borderWidth` 1; `radius` 4 / 8 / 12 |
| Button anatomy: brass bezel outside, teal glowing edge inside | primary `rim` brass gradient 2 px with `innerGlow` accent 50 % and `glow` accent always; `button.style` bezel (2 px border) |
| Hover: more glow, small lift; active: pressed in | motion `hoverLift` and `pressSink` from the shipped pack |
| Secondary: coral-tinted outline | `secondary` tinted (approximation: the tint is the teal accent; coral needs a danger-tinted variant that does not exist) |
| Inputs: dark translucent fill, 1 px teal edge, 4 px corners; error coral edge | `input` filled (the §3.1 table; the reference draws a full edge, which the base `outline` look would match) |
| Focus: glowing | `focus` glow |
| Toggle: pill with brass bezel, glowing knob, ON and OFF inside | `switch` bezel |
| Chips: text in square brackets | `chip` bracket |
| Tabs as a boxed segmented group, selected outlined in glowing cyan | `tabs` boxed |
| Sections in a thin cyan frame with a boxed title label on the top-left edge | `sectionHeader` bracket, `card` framed |
| Thin outer frame with registration ticks; fine grid on the ground | `background.pattern` blueprint (`#5fd9e3` 7 %, spacing 24), `frame` ticks true, opacity 0.35 |
| Thin glowing progress bar with percentage | `slider` thin, `valueBubble` true; progress bar base look |
| Plain buttons | no depth effect (the 2026-11-10 rule) |

## Commands and results

All runs with `UJWALAM_HEADLESS=1`, one suite at a time, in the worktree `theme/t2-t5-reference-themes`.

```
npm run build:studio
```
```
built ...\out\studio\build\ujwalam-studio.exe
```

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| tests/studio-theme-contrast.test.mjs | 6 | 6 | 0 |
| tests/studio-qt-theme-reference-themes.test.mjs (new) | 17 | 17 | 0 |
| tests/studio-qt-theme-components.test.mjs | 13 | 13 | 0 |
| tests/studio-themes.test.mjs | 10 | 10 | 0 |
| tests/studio-qt-themes.test.mjs | 21 | 21 | 0 |
| tests/studio-qt-theme-reload.test.mjs | 1 | 1 | 0 |
| tests/lint.test.mjs | 34 | 34 | 0 |
| tests/package-alpha.test.mjs | 18 | 17 | 1 (see below) |

`node tools/lint.mjs`: no findings. Each commit passed the hook's quick CI (9/9).

- The new test covers, per pack: flag on, the components block reported equal to the file, density factor, the v2 depth
  classes, the family reported by the pack and resolved by Qt, no stylesheet errors, the specimen opening with all nine
  sections; and the specimen picture at 100, 125 and 150 % (size within 2 px of the logical size times the scale).
- Packs without a components block still look as before: `studio-qt-theme-components` ("no components block: the same
  base stylesheet with the flag on and off") now runs on violet-night and retro-wave (copper-graphite has a block).
  violet-night, neon-arcade, studio-light, tactical and retro-wave are unchanged files.
- `tests/package-alpha.test.mjs`: the one failure, "repo file set ... every relative import resolves inside the
  package", is not from this branch: `services/studio-ui/launch.mjs` imports `services/supervisor/{front,slots,swap}.mjs`
  (service swap, D337), which `REPO_DIRS` does not ship. It fails the same on the base commit. The new font tests in
  that file pass.

## Contrast

`tests/studio-theme-contrast.test.mjs` passes for all four packs in every state (normal, hover, pressed, checked or
selected, focus, error): text 4.5:1, controls and focus 3:1, including each pack's variants and its switch variant. The
known base gaps in the test file did not change (only Tactical's warning text, not touched here). The base-switch gap
for these four packs is fixed by their switch variant (plain, bezel, labelled, bezel).

## Specimen pictures

`docs/evidence/2026-11-11-t2-t5-reference-themes/<id>-<100|125|150>-specimen.png` (12 files): the whole specimen sheet
(Settings > Appearance > "Preview all components") rendered headless with `QT_SCALE_FACTOR` 1, 1.25 and 1.5. Generic
sample labels only; no reference image or crop. Pixel sizes:

| Theme | 100 % | 125 % | 150 % |
|---|---|---|---|
| daylight-blue | 1091 x 717 | 1364 x 896 | 1637 x 1076 |
| copper-graphite | 1103 x 689 | 1379 x 861 | 1655 x 1034 |
| sand-teal | 1134 x 722 | 1418 x 903 | 1701 x 1083 |
| teal-grid | 1069 x 674 | 1336 x 810 | 1604 x 972 |

```
UJWALAM_HEADLESS=1 UJWALAM_THEME_EVIDENCE=docs/evidence/2026-11-11-t2-t5-reference-themes node --test --test-name-pattern="specimen picture" tests/studio-qt-theme-reference-themes.test.mjs
```

## Not checked / UNVERIFIED

- UNVERIFIED: the look on the user's screen at real DPI; the headless pictures are offscreen renders. Weight selection of
  semibold (600) per family is checked only through the picture and the resolved family name.
- UNVERIFIED: whether the installed (packaged) studio finds theme packs: `data/themes` is not in the package manifest, so
  the packaged fonts are loaded but the packs are not shipped by this branch.
- The window backdrop (blueprint grid, columns, frame ticks) paints only on shown windows; the headless pictures do not
  show it (same as T1).
- Sand Teal plain buttons carry a depth effect (89 depth widgets against 27 in the headless probe); the performance cost
  on the laptop while live is UNVERIFIED. High performance drops it.
- Approximations noted in the tables (sand-teal tabs, teal-grid coral secondary and filled inputs) need the user's eye.
- No live stream, no full CI, no soak (per the task brief).
