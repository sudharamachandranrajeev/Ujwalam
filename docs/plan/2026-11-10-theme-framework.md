# 2026-11-10 — Theme framework: each theme a full design (N3, request R10)

Status: **research done, plan proposed, waiting for the user's approval.** Nothing is built yet.

User request (2026-11-10, R10): each theme must be a full design (layout, shapes, type, components, effects) based on
in-depth research of the reference images, not a colour swap.

Reference images: 4 files in the user's local theme reference folder (third-party, never copied into the repo, never
committed). Below they are called **A** to **D**. Descriptions here are my own reading of them.

## 1. Why today's themes look like colour swaps

The theme packs (D293, `data/themes/<id>.json`) already carry more than colours: type, radii, spacing, border width,
depth (shadow, glow, extrusion per element class), motion, background pattern and icon stroke. But every pack is
poured into **one shared stylesheet template** (`app/studio/src/theme.cpp`, `kQss`). That template fixes the shape of
every component:

- tabs are always filled pills; a selected tab is always an accent fill;
- the slider is always a 4 px groove with a round 14 px handle;
- every text field is the same outlined box; there is no sunken (inset) or underline field;
- every button is the same bordered box; there is no pill, bezel, double edge or metal rim;
- section headings are always small muted text; there is no rule, bracket frame or caps style;
- the painted switch (`switch_widget.cpp`) is the same in every theme;
- depth allows one shadow per element: a neumorphic look (light shadow top-left plus dark shadow bottom-right) or a
  sunken field cannot be drawn;
- layout spacing is mostly fixed numbers in code (about 97 `setSpacing` / `setContentsMargins` calls), so density
  barely changes between themes.

So a theme can change tokens, never the component language. That is the gap to close.

## 2. Reference research

### A. Light product style guide (maps to `daylight-blue`)

| Aspect | What the image shows |
|---|---|
| Palette | Cobalt blue primary, white surfaces on a light-grey background, near-black text, dark-grey secondary text, mid-grey borders. A separate "focus ring" token. |
| Density | Airy. Strict spacing scale 4, 8, 16, 24, 32, 48 px. |
| Radius | Named scale: none 0, small 4, medium 8, large 16, full 50 %. Controls use small (4). Cards use medium (8). |
| Elevation | 4 levels (flat, low, medium, high). Higher levels get a soft shadow tinted with the accent blue, not black. |
| Type | Neo-grotesque sans, clear scale: H1, H2, subtitle, body 1, body 2, caption, button. Sentence case everywhere. |
| Buttons | Three kinds. Primary: solid blue, lighter on hover, darker on press. Secondary: white with a 1 px blue outline, light-blue fill on hover. Text link: blue text, underline on hover. |
| Inputs | White fill, 1 px grey outline, 4 px corners, leading search icon. Error: red outline and red helper text under the field. Disabled: grey fill. |
| Selection | Chips: outlined pill (action), filled grey pill with a dropdown arrow (selected), grey pill with a close cross (input chip). |
| Tabs | Underline tabs: plain text; the selected tab is blue text with a 2 px blue underline; no fill. |
| Feedback | Alerts: tinted fill, 1 px darker outline, leading status icon (success green, info blue, warning amber, error red). |
| Cards | White, 8 px corners, low shadow. A selected card gets a blue edge glow. |
| Background | Off-white with faint layout column lines. |

### B. Dark copper metal style guide (maps to `copper-graphite`)

| Aspect | What the image shows |
|---|---|
| Palette | Gunmetal greys with a vertical metal gradient; rose-gold / copper light as the accent; red-orange for errors; off-white text. |
| Surfaces | Four named states: base (flat), raised (bevel plus a copper rim light), inset (sunken well, dark inner shadow), pressed (inset with a glowing inner edge). |
| Elevation | 4 levels drawn as stacked metal plates with heavy soft shadows. |
| Borders | Tokens 1, 2, 3, 4 px, drawn as copper metal rims (a light-to-dark gradient line), not flat lines. |
| Radius | 4, 8, 12, full. Buttons, tabs and pagination are full pills or discs. |
| Type | Humanist sans. Caps and letter spacing on buttons, tabs, section titles and table headers. |
| Buttons | Pill, metal gradient fill, copper rim plus outer glow. Pressed: sunken with an inner glow and a spinner. Disabled: flat grey, no rim, no glow. |
| Inputs | Dark sunken well inside a copper-rimmed frame, label above. Error: red rim, red warning icon, red helper text. Focus: a glowing copper ring. |
| Selection | Embossed checkbox and radio; checked shows a glowing copper mark. Switch: pill track, metal knob, copper glow when on. |
| Slider | Thick sunken track, glowing copper fill, copper ball handle, value bubble above the handle ("75 %"). |
| Navigation | Tabs as a row of raised metal pills, the selected one filled copper and glowing. Breadcrumbs as dots on a line. Pagination as raised discs, the current one copper. Stepper as metal balls on a rail, the current step glowing. |
| Data | List rows as raised plates with a copper "NEW" pill on the right. Table header as a raised caps bar with sort icons. |
| Feedback | Toasts as dark plates with a coloured rim (green, amber, red). Progress: sunken track with a glowing copper fill and its label inside. |
| Icons | Outline, 1.5 px stroke, rose-gold, sizes 14 / 18 / 22. |
| Decoration | Smoke, cracks, molten drips, an astronaut illustration. These are illustration, not UI. |

### C. Warm sand neumorphic style guide (maps to `sand-teal`)

| Aspect | What the image shows |
|---|---|
| Palette | Cream / sand background; surfaces the same colour as the background; one deep teal for primary actions; dark slate text; taupe muted text; red only for errors. |
| Surfaces | Base and raised are soft plates lit from the top left (light shadow up-left, dark shadow down-right). Inset and pressed are sunken (inner shadows). |
| Elevation | 5 levels: flat, hover, raised, modal, popover. |
| Borders | Tokens 1, 2, 4 px, but most edges come from shadows, not lines. |
| Radius | 4, 8, 12, 16, 24. Cards 12–16; buttons full pill. |
| Density | Generous. Section spacing labelled 8 / 16 / 24 px. |
| Type | Clean grotesque sans. Bold caps with tracking for section headers; sentence case on components. |
| Buttons | Teal filled pill, white text, soft shadow. Pressed: darker with a spinner. Disabled: flat taupe pill, no shadow. |
| Inputs | Sunken field, 6–8 px corners, helper text below. Error: 1 px red outline. Focus: 2 px teal ring with a soft outer glow. |
| Selection | Teal filled square checkbox (4 px corners); teal radio dot. Switch: teal pill with the word ON or OFF inside the track. |
| Slider | Thin teal track, raised round knob, dark value bubble, tick labels 0–100 below. |
| Navigation | Tabs inside one raised container; the selected tab is underlined teal and bold. Breadcrumbs inside a raised pill with slashes. Pagination: plain numbers, the current one a teal rounded square. Stepper: outlined circles joined by lines, the current one filled teal, labels underneath. |
| Data | Raised cards; list rows inside one raised plate with avatars; teal pill badges; dark tooltip bubble; table header in a raised bar. |
| Feedback | Raised cream toasts with a check mark; a teal filled alert banner; a dashed-outline empty state; a skeleton loader. |
| Icons | Outline, 2 px stroke, deep teal, sizes 16 / 20 / 24. |

### D. Dark teal blueprint UI kit (maps to `teal-grid`)

| Aspect | What the image shows |
|---|---|
| Palette | Deep teal blueprint background with a fine grid; slightly darker translucent panels; glowing cyan accent; brass / gold bezels; coral for warnings, pending and disabled; pale cyan text. |
| Layout | A thin outer frame with registration ticks. Each section sits in a thin cyan frame whose title is a small boxed label on the top-left edge. Dense, technical. |
| Tokens | Spacing 4, 8, 16, 24 (modular). Border 1–2 px ("refined edge"). Corners 4, 8, 12 ("soft corner"). Shadow named as glow low / mid / high and depth flat / raised / floating. |
| Type | Technical sans. Caps on tabs, chips, dropdown items and section labels; sentence case on button labels. |
| Buttons | Anatomy given in the image: brass bezel outside, teal glowing edge inside. Hover: more glow and a small lift. Active: pressed in, brightest glow. Disabled: muted coral, lower opacity. Secondary: coral-tinted outline. Tertiary: cyan text only. |
| Inputs | Dark translucent fill, 1 px teal edge, 4 px corners. Error: coral edge. Search input with a leading icon. |
| Selection | Toggle: pill with a brass bezel, a glowing cyan knob, the words ON and OFF inside. Chips: text in square brackets ("[ACTIVE]" glowing cyan, "[PENDING]" coral, "[DELETED]" grey). |
| Navigation | Tabs as a boxed segmented group, the selected one outlined in glowing cyan. Steppers as chevron segments ("1. CONFIG > 2. UPLOAD > 3. VERIFY") and as knobs on a line. Dropdown: the selected item outlined in cyan. |
| Data | Boxed table rows; status as an outlined chip; progress as a thin glowing cyan bar with the percentage at the right. |
| Feedback | Info notification with a cyan outline; warning with a coral tinted fill; an empty state with a glowing coral outline icon. |
| Icons | Outline line icons in cyan, slightly glowing. |

### What is not taken from the references

- Illustration (smoke, cracks, molten drips, characters, the empty-state astronaut) is dropped: it is not UI, cannot be
  drawn as data by Qt, and would cost GPU time while live.
- No text, names, logos or images are copied; only measurements and component behaviour.

## 3. Framework changes (proposal)

All additive. Packs without the new blocks keep today's look. Behind a new flag `theme-components` (off by default,
switchable on the control page), per the feature-flag rule.

### 3.1 New `components` block in the pack (enumerated variants, data only)

| Key | Variants | Used by |
|---|---|---|
| `button.shape` | `rounded`, `pill`, `sharp` | A rounded, B/C pill, D rounded, tactical sharp |
| `button.style` | `solid`, `soft`, `metal`, `bezel`, `neumorph` | A solid, B metal, C neumorph, D bezel |
| `button.secondary` | `outline`, `tinted`, `ghost` | A outline, D tinted (coral) |
| `button.caps` | boolean | B and D caps |
| `tabs` | `pill`, `underline`, `segmented`, `boxed` | A underline, B pill, C segmented + underline, D boxed |
| `input` | `outline`, `filled`, `inset`, `underline` | A outline, B and C inset, D filled |
| `focus` | `border`, `ring`, `glow` | A ring, B glow ring, C ring + glow, D glow |
| `switch` | `plain`, `labelled`, `bezel` | A plain, C labelled (ON/OFF), D bezel |
| `slider.track` | `thin`, `thick`, `inset` | A thin, B inset thick, C thin, D thin glow |
| `slider.handle` | `round`, `sphere`, `bar` | B sphere |
| `slider.valueBubble` | boolean | B, C, D |
| `sectionHeader` | `plain`, `rule`, `caps`, `bracket` | A rule, B caps, C caps, D bracket (boxed label on the frame edge) |
| `card` | `flat`, `raised`, `neumorph`, `framed` | A raised, B raised metal, C neumorph, D framed |
| `list` | `plain`, `plates` | B and C plates |
| `chip` | `pill`, `bracket` | D bracket |
| `density` | `compact`, `normal`, `airy` | A and C airy, D compact |

### 3.2 Depth and edges

- `depthClass.highlight`: a second, light shadow with its own offset, for neumorphic plates (C).
- `depthClass.inset`: inner shadow for sunken fields, wells and pressed states (B, C).
- `rim`: a gradient edge (`from`, `to`, `width`) for metal rims and brass bezels, plus an optional inner glow edge
  (`innerGlow`) for D's double edge.
- Named elevation levels 1–5 mapping to the existing element classes (flat, hover, raised, modal, popover).
- High performance mode keeps today's rule: flat fills, no glow, no second shadow, no gradient rims.

### 3.3 Type and background

- Typography adds `buttonCaps`, `tabCaps`, `headingCaps` and a type scale (H1, H2, subtitle, body, caption, button).
- Background adds a `blueprint` pattern (fine grid plus stronger major lines) and an optional outer frame with corner
  ticks (D); `columns` for A's faint layout columns.
- Fonts stay as installed Windows family names; nothing is bundled (D293). See question 2.

### 3.4 How it is drawn (one owner per concern)

- `theme.cpp`: the single stylesheet becomes a base plus **variant fragments** keyed by component and variant. The
  pack picks fragments; no theme has its own code.
- `depth.cpp` (`DepthEffect`): adds the highlight shadow, inner shadow and rim.
- Painted widgets read the variant through the theme API: `Switch`, the round transport buttons, `ValueSlider`
  (value bubble), section headers, task chips.
- Layout density: replace the fixed spacing numbers in the studio with `theme::spacing()` so `density` really changes
  the layout (about 97 call sites, mostly `main_window.cpp` and `stream_pages.cpp`).
- Live: a theme switch is already hot (D293 reload); this stays a studio-only repaint, never touching outputs.

### 3.5 Checks and evidence

- Schema extended; `packProblem` rejects unknown variants.
- Contrast test for every pack: text 4.5:1, controls and focus 3:1, in every state (normal, hover, disabled, error).
- A **theme specimen page** (Settings > Appearance > "Preview all components"): the same component set as the
  references (buttons in every state, inputs, tabs, chips, switch, slider, cards, list, toasts, progress, stepper).
  Headless screenshots per theme at 100, 125 and 150 % scale go to `docs/evidence/` (no reference image is committed).
- Flash rule untouched (themes do not animate the canvas).

## 4. The other 5 themes (no reference image)

Designed from their own topic text with the same framework, so each still differs in shape, not only colour:

| Theme | Proposed component language |
|---|---|
| `studio-light` | rounded solid buttons, underline tabs, outline inputs, rule headers, raised cards, normal density |
| `violet-night` | soft buttons, segmented tabs, filled inputs, plain headers, raised cards, glow focus |
| `neon-arcade` | sharp bezel buttons with neon edge, boxed tabs, underline inputs, bracket headers, compact |
| `retro-wave` | pill metal (chrome) buttons, pill tabs, inset inputs, caps headers, thick glowing slider |
| `tactical` | sharp solid buttons with caps, segmented square tabs, filled inputs, caps headers with rule, compact, no glow |

## 5. Build order and routing

| Step | Work | Model |
|---|---|---|
| T1 | Schema v2, variant fragments, DepthEffect (highlight, inset, rim), painted-widget variants, density through `theme::spacing`, specimen page, contrast test, flag `theme-components` | Opus (framework) |
| T2 | `daylight-blue` from A | Sonnet |
| T3 | `copper-graphite` from B | Sonnet |
| T4 | `sand-teal` from C | Sonnet |
| T5 | `teal-grid` from D | Sonnet |
| T6 | The other 5 themes | Sonnet |
| T7 | Codex review, specimen screenshots at 3 scales, evidence | Codex + main session |

Each step on its own branch with a Codex review before merge.

## 6. User answers (2026-11-10)

1. Scope: the 4 themes with reference images first (T2–T5), then the other 5 (T6).
2. Fonts: **bundle open-licence fonts.** Only SIL Open Font Licence 1.1 families, each with its `OFL.txt` and source
   recorded in `docs/third-party-notices.md`; loaded at start with `QFontDatabase::addApplicationFont` from the install,
   never installed into Windows. Microsoft fonts stay forbidden. The packager's font ban becomes an allowlist of these
   OFL files (rule change logged as a decision). Proposed families (checked against the references, UNVERIFIED until
   downloaded and licence-checked): Inter (A, C), Barlow (B, caps-friendly humanist), Exo 2 (D, technical). Fonts for
   T6 are chosen per theme in that step.
3. Illustration in B: dropped (not answered separately; default from section 2).
