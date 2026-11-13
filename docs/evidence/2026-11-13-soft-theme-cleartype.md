# Soft theme and ClearType text (D376) — evidence, 2026-11-13

Result: **PASS** (headless and hidden native probes, one real on-screen capture). The look at other display scales,
on a machine with ClearType off, and in daily use is UNVERIFIED (see the end).

Decision: D376 in `docs/plan/2026-10-29-v1-decisions.md`. Branch `ui/soft-theme`.

## 1. ClearType: diagnosis and fix

The complaint: text in the studio does not look like ClearType.

What was measured (share of text-edge pixels with a colour fringe, i.e. subpixel rendering; script in local scratch):

| Picture | Fringed share |
|---|---|
| Offscreen test platform (`QT_QPA_PLATFORM=offscreen`, every earlier screenshot) | 0.2 % (greyscale) |
| Hidden native window (`UJWALAM_STUDIO_HIDDEN=1`), Studio Light | 20.5 % |
| Real on-screen capture, Soft, Settings > Clips | 28.2 % |
| Real on-screen capture, Soft, Settings > Posting & growth | 29.1 % |

In-app self-check (`clearTypeCheck` in `theme.cpp`, probe field `theme.clearType`): text drawn into an RGB32 picture
with the application font; share of edge pixels whose R, G and B differ. Native Windows: 0.86–0.93 for every pack
(Soft 0.927). Offscreen: 0.

Findings:

1. **The studio already renders ClearType on screen.** Qt's DirectWrite engine follows the Windows setting
   (`FontSmoothingType` 2). The offscreen platform renders greyscale, so every screenshot made by the test probe showed
   greyscale text. Those pictures are no evidence of how text looks. A screenshot for text quality must come from the
   hidden native probe or from the real screen.
2. **What reads as "not ClearType" is the font and its hinting.** The existing packs use bundled web fonts (Inter,
   Barlow, Exo 2) with the default hinting. At 9–10 pt their stems fall between pixels, so the colour fringe smears over
   two or three pixels and the text looks soft. A zoomed crop of the same words in four engines and fonts shows it
   (local scratch `soft-ui/cleartype-engines.png` and `soft-ui/cleartype-compare.png`): Windows GDI ClearType Segoe UI
   (native reference), Qt DirectWrite Segoe UI, Qt GDI engine Segoe UI, and Inter as shipped today. Segoe UI, hinted for
   ClearType, puts each stem on one pixel column.
3. **Depth effects.** `QGraphicsEffect` depth (Violet Night 17 widgets, Sand Teal with components 77) draws a widget
   through an offscreen picture. Soft uses no `QGraphicsEffect` (probe `depthWidgets` 0); its surfaces are painted
   behind the widget, so text always lands on an opaque face.

Fix (Soft pack):

- Font: Segoe UI, an installed Windows system font, used at runtime only. No Microsoft font file is bundled
  (`data/fonts` unchanged; the test checks it).
- New `typography.hinting` (`default | full | vertical | none`); Soft uses `full`, applied as
  `QFont::PreferFullHinting` on the application font (probe `appliedHinting` 3; other packs 0).
- No `QGraphicsEffect` anywhere in Soft.

Other packs keep their fonts and hinting unchanged (base stylesheet hash equal, test below).

## 2. Soft theme, component by component

Pack `data/themes/soft.json`: warm light grey surfaces, ink text, amber `#a95400` accent, warm amber glow for what is
on. New `componentsAlways: true`: the pack uses its components block even with flag `theme-components` off (the flag
stays off by default; other packs unchanged). New `surface` block: face, edge, well, warm and glow colours, three shadow
layers plus the glow halo, radii and the room for the shadow.

Painted in `app/studio/src/soft.cpp` (attached at Polish from `interaction.cpp`; an event filter paints before the
widget's own paint):

- **Cards** (`QGroupBox`, `QFrame#card`): raised plate, radius 28. Light halo up-left, wide soft shadow, tight contact
  shadow. Face is a vertical gradient with a 1 px light top edge fading into a darker bottom edge. Title 11 pt inside the
  plate.
- **Small cards** (`#strip`, `#statCard`, `#lookCard`): the same at two thirds of the room.
- **Rows with a switch** (plate kind): a plain row that holds a `Switch` becomes its own plate. When the switch is on,
  a warm glow spreads from the knob onto the plate and a little past its edge (radial, glow colours from the pack).
- **Buttons** (`QPushButton`, variant `raised`): pills. Primary = amber face; checked = warm face with an inner glow;
  hover warms the bottom edge; press sinks the face into a well. Hover and press fade in the theme's fast time
  (≤ 150 ms; at once with motion off). The focus ring shows for keyboard focus only.
- **Round controls** (`#round`): raised round face; the live (danger, active) state is red.
- **Switch** (variant `knob`, `switch_widget.cpp`): sunken well that warms as it turns on, raised knob with a glow,
  ON text in glow ink, OFF text muted.
- **Through the stylesheet** (`softQss` in `theme.cpp`), same colours: fields as sunken wells with an amber 2 px focus
  ring; combo and spin arrows as generated chevron images; lists, tables and text areas as faces with radius 16 and a
  warm selection; table headers transparent; Settings navigation with a warm selected pill; segmented tabs; menus,
  tooltips, check boxes, sliders (amber fill), progress bars, scroll bars, toasts and the task panel.
- **Effects modes:** Reduced = no shadows or glow; High performance = flat faces, no gradient in the stylesheet, no
  shadow pictures.
- **Appearance:** Soft is listed first, Violet Night second. The default theme stays Violet Night (new looks are off by
  default; nothing changes until the user picks Soft).
- **Contrast:** new variants in `services/studio-ui/theme-contrast.mjs` (text on face, hover, pressed and warm faces,
  wells, switch ON/OFF, card muted text); `failures(soft.json)` is empty. A soft variant without a surface block fails.

The Posting & growth page (with the Auto-post row) picks up the look through the shared components; `main_window.cpp`
is not changed.

## 3. Performance

Shadows are built once per kind, radius, tone and device pixel ratio (three-pass box blur on Alpha8) and drawn as a
9-slice picture. Bench: `UJWALAM_STUDIO_PROBE_BENCH=1`, hidden native window, 1600x900. Settings is on Clips; 100
repaints warm and 20 repaints with the cache dropped before each.

| Theme | Main window paint (ms) | Settings repaint (ms) | Settings, cold cache (ms) | Notes |
|---|---|---|---|---|
| Violet Night | 8.49 | 2.91 | 3.27 | 17 depth effects |
| Sand Teal + components | 13.99 | 3.68 | 4.12 | 77 depth effects |
| Studio Light | 7.91 | 3.09 | 3.37 | |
| Soft | 5.97 | 3.16 | 5.06 | 188 painted widgets, 4 cached pictures, 0 depth effects |

Private memory about 81 MiB for every theme. Offscreen numbers are similar (Soft 4.96 / 2.97 / 4.79). A warm Settings
repaint in Soft costs about the same as Violet Night. The cold number is the one-time cost after a theme or effects
switch.

## 4. Screenshots (local scratch, not committed)

Folder `soft-ui/` in the session scratchpad. Iterations: `v1/` (first build), `v2/` (combo and spin fixes), `v3/`
(shadow 9-slice fix, mixer strips, real on-screen capture `v3/clips-screen.png`, side-by-side with the reference
`v3/side-by-side.png`), `v4/` (shadow and glow tuning: `main.png`, `clips.png`, `clips-screen.png`, `posting.png`,
`appearance.png`, `states-zoom.png` for hover and press, `toggles-zoom.png`). ClearType crops:
`cleartype-engines.png`, `cleartype-compare.png`. Not committed: they show local data and are made from the user's
screen.

## 5. Tests

- `node --test tests/studio-qt-soft-theme.test.mjs` (new; 8 tests):
  - pack validates against the schema (Ajv 2020) and passes the contrast rules;
  - without its surface block the contrast check fails it;
  - typography Segoe UI, hinting full, no Microsoft font file bundled;
  - Soft loads with the flag off: `componentsAlways`, `surfaceOn`, painters attached, shadow cache small,
    `depthWidgets` 0, variants, `appliedHinting` 3, `appliedFamily` Segoe UI, first in the list, no stylesheet errors;
  - the default stays Violet Night; switching away from Soft removes painters, hinting and every soft rule (base
    stylesheet hash and fragment length equal to a fresh Violet Night);
  - effects modes (performance: flat, no gradients, no shadow pictures; back to full);
  - offscreen text is greyscale (`fringed` 0);
  - hidden native: ClearType share > 0.4 for Soft and Violet Night (skipped when Windows ClearType is off).
- Results on this laptop (Windows ClearType on, BelowNormal priority):
  - `studio-qt-soft-theme` 8/8, the native ClearType test included (not skipped).
  - With `studio-qt-themes`: 30 tests; 29 passed on the first run. The one failure was the new test's schema import
    (draft 2020-12 needs `ajv/dist/2020.js`); fixed and re-run 3/3.
  - `studio-qt-soft-theme`, `studio-qt-theme-components`, `studio-qt-theme-reference-themes`,
    `studio-qt-theme-reload`, `studio-ui-alpha`: 98 tests, 97 pass, 0 fail, 1 skipped (a face-worker test in
    `studio-ui-alpha` that needs the local `.venv-gpu`, absent in this worktree).
  - `studio-qt-growth` under `UJWALAM_THEME=soft` with the hidden native probe: 5/5.
  - `studio-theme-contrast`, `studio-themes`, `scene-builder-theme`: 35/35.
- `npm run lint`: 0 findings.
- Not run (brief): full `npm run ci`, GPU tests.

## 6. UNVERIFIED

- Display scales other than this laptop's (125 %, 150 %, 175 %): shadow room and the round control size.
- A machine with ClearType off (the native test skips; greyscale fallback not looked at).
- Hover and press fades seen only as single frames (`states-zoom.png`), not as motion on screen.
- Toasts, menus, tooltips and the task panel in Soft: styled, not screenshotted.
- Daily use while live (no stream run with Soft).
