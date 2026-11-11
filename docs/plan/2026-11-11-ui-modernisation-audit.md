# UI modernisation audit (2026-11-11)

User words: "the UI feels still dated, janky, does not look modern with fonts, arrangement, effects, navigation and all in all workflow. Check what's missing."

Scope: read-only audit of the Qt studio (the desktop window) and a code read. No code was changed.

## How the screens were captured

- Tool: the existing headless probe (`UJWALAM_HEADLESS=1`, offscreen, nothing shown), existing build in `out/studio/build`, a fake host and a temporary data folder. No real project, keys or data.
- Look: theme copper-graphite, `theme-components` on, motion on, every feature flag on (31 flags), scales 125 % and 150 % (`QT_SCALE_FACTOR`). The window is 1600x900 logical, so 2000x1125 px at 125 %. Windows display scaling of 125-150 % on the user's machine is UNVERIFIED; no evidence note records it.
- Pictures (private, gitignored): `docs/evidence/private/2026-11-11-ui-audit/`
  - `main-125.png`, `main-150.png` (main window; the first-run tour was still open on top, the probe could not close it, so the tour card is also reviewed here)
  - `page00..page10-{125,150}-settings.png` (Settings: 00 Clips, 01 Folders, 02 Stream, 03 Transitions, 04 Integrations, 05 Layer effects, 06 Appearance, 07 Preview, 08 Connections, 09 Help and tips, 10 Advanced = the flags panel). The matching `pageNN-*.png` files are the main window behind it.
  - `addlayer-*.png`, `addscene-*.png`: the add dialogs did not open (the fake host has no project: "Adding needs a loaded project file"), so these dialogs are NOT captured. Judged from code only (`add_dialogs.cpp`).
  - `layermenu-*`, `tour-*`, `posts-*-dialog1.png`, `review-*-dialog1.png`.
- Limits of the capture: previews are black placeholders (no live video in a probe); a live (on-air) state is not captured; the window is never shown, so motion, hover and resize jank could not be seen, only judged from code and from `docs/evidence/2026-11-08-themes/repaint-cost.json` (it has no copper-graphite row; other themes cost 9-12 ms per full-window paint at 1600x900 with 52 depth widgets, 5-7 ms in reduced mode; that is under one 60 Hz frame but with no headroom, and it is measured with caches dropped, not while resizing).

## Plain-English summary

The studio is tidy and consistent in colour, but it reads as "a themed form" and not as a modern creative app. Four things drive that feeling:

1. Things are cut off or broken: the right-hand column cuts its text off at the edge, the "Recording" button shows "ECORDIN", the layer list shows empty boxes where an eye icon should be, and the Stream settings page needs a sideways scroll.
2. Everything is a heavy bordered pill button in capital letters. Nothing tells you what matters. The main buttons (Start Stream, Record) are small round icons in a corner, while six big "Move up / Add scene / Remove layer" buttons take the left side.
3. The video previews, which should be the centre of the app, are two small black boxes with big empty frames around them. Everything else is about the same size and weight.
4. It is a fixed set of boxes: panels cannot be moved, hidden, or resized in a natural way, there is no quick-search command bar, and the settings are one long technical list (the flags page shows internal decision numbers and file paths).

None of that needs a rewrite. Most of it is fixable inside the current toolkit in days. The only things the toolkit truly cannot do are frosted-glass blur and smooth GPU-drawn animation of whole panels; the options are at the end.

## Top 10: what is missing (ranked by pain against effort)

| # | What is missing | Pain | Effort | Fix type |
|---|---|---|---|---|
| 1 | Nothing is cut off: right column, "ECORDIN", Stream page sideways scroll, layer-list icons show as empty boxes | High: looks broken | 0.5-1 day | widget/layout + font |
| 2 | A clear "Go Live" and "Record" bar: big labelled buttons, live state in colour with time and bitrate | High | 1-2 days | widget/layout |
| 3 | Previews dominate: bigger, less frame, scene tabs or a strip under them; remove the duplicate edit buttons | High | 1-2 days | layout |
| 4 | Quieter buttons: flat/ghost by default, one filled primary per area, sentence case instead of ALL CAPS for buttons and nav | High | 1 day | theme data + small stylesheet |
| 5 | One real icon set (stroke icons for eye, lock, camera, trash, gear, folder, mic) in place of text glyphs and 9 hand-drawn icons | Medium-high | 1-2 days | widget/code + asset |
| 6 | Type scale and font: tighter, one weight ladder, tabular numbers for dB/kbps/timers, no letter-spacing on body text | Medium | 0.5 day | theme data |
| 7 | Command palette (Ctrl+K) and a short shortcut list: switch scene, add layer, go live, open any setting | Medium | 2-3 days | new widget |
| 8 | Dockable/hideable panels and saved layouts (a "Live" layout with big previews; an "Edit" layout) | Medium | 3-5 days | widget (QDockWidget) |
| 9 | Settings that read like Windows 11: left nav as plain list with an accent bar and icons, no card for each row, humane Advanced page (names and one-line help, no decision ids or file paths) | Medium | 2 days | widget + text |
| 10 | Web control page and the studio look like one product (the web page is blue and a different font; the studio is copper) | Low-medium | 1-2 days | theme data export |

## Findings by area

Screenshot names are in the private folder above. Fix types: T = theme data, W = widget or layout code, A = architecture limit.

### Type

| Finding | Evidence | Cause | Fix |
|---|---|---|---|
| Body text has extra letter spacing (0.3 pt) and captions 1.6 pt with caps; long sentences look loose and hard to scan | `page08-125-settings.png`, `page10-125-settings.png` | `data/themes/copper-graphite.json` typography (`letterSpacing`, `captionLetterSpacing`, `buttonCaps`, `tabCaps`, `headingCaps`); applied in `app/studio/src/theme.cpp:918` (`applyFont`) to the whole app font | T: letterSpacing 0 for body, small tracking only for captions; sentence case for buttons and nav |
| Everything is caps: buttons, nav, group titles, "MOVE UP / MOVE DOWN / SHOW / HIDE". Hierarchy comes only from size, which differs by 1-2 pt | `main-125.png` | caps flags in the pack; `theme.cpp:614` (`tb` buttons), `:837` | T |
| Base size 10.5 pt, caption 8.5 pt, button 9-10 pt: five near-equal sizes, small for a dense app at 125 % | all | `typography.scale` in the pack, `theme.cpp:831-837` | T: a clear ladder (e.g. 11 body, 9.5 caption, 13 section, 18 page) |
| Font Barlow is a condensed sports face; good for headings, tiring for paragraphs. Inter is already bundled (`data/fonts/Inter-*.ttf`) but only three weights, no variable font, no tabular numbers | `page08`, `page10` | `typography.family: Barlow` | T: Inter (or Segoe UI Variable) for body, Barlow for the title only; enable tabular figures on numeric labels (`QFont::setFeature`, Qt 6.7+) in `value_slider.cpp` and the status pills |
| Text glyphs used as icons: the layer list uses the characters for "visible/hidden" that the font lacks, so they draw as empty boxes (camera and game rows) | `main-125.png` | `app/studio/src/main_window.cpp:1565` | W: draw an eye icon via `icons.cpp` |
| Truncation: "RECORDING" shows as "ECORDIN" on the mixer track chips; right column text is cut mid-word ("...position, siz") | `main-125.png`, `main-150.png` | chip fixed width with caps and letter spacing in `buildMixer` (`main_window.cpp:1375`); right column scroll has horizontal bar off (`main_window.cpp:1139`) while its content is wider than 380 px | W: let chips size to text or elide with a tooltip; wrap labels in the right column |

### Layout

| Finding | Evidence | Cause | Fix |
|---|---|---|---|
| The previews are small: about 600x600 px at 125 % inside large frames; the black area has a big empty margin and two rows of buttons under it | `main-125.png` | `buildCentre` (`main_window.cpp:1093`), preview minimum sizes `:1101`, splitter sizes `{620,200}` `:589` and `{260,780,380}` `:593` | W: shrink frames, move OWN WINDOW / TO FRONT into a hover overlay or the panel title bar, give the previews the free vertical space |
| Left column spends half its height on an empty layer list and a "Edit scenes and layers" box that repeats the "+" buttons in the panel titles (Add scene, Remove scene, Remove layer, Add layer twice, a "Copy of layer" picker) | `main-125.png` | `buildLeft` `main_window.cpp:859`, `structBox_` `:1017` | W: delete the duplicate row; keep the title-bar + and trash, put "Move up/down" and "Show/hide" in the list's row actions and right-click menu |
| Go Live, Record, Save clip and Mark moment are four small round buttons in the top-right corner of a card, labelled in tiny two-line caps | `main-125.png` | controls card in `buildRight` `:1130` | W: a top bar with one large "Go live" button and a record button with timer |
| Right column crams Inspector, Transitions and Bots (with long status sentences) in one scroll; the Inspector, the thing you use most, is at the same weight as Bots | `main-125.png` | `buildRight` | W: tabs (Inspector, Transitions, Bots), Bots moved to Settings > Integrations where it already exists |
| Empty states are a plain sentence ("Select a layer to edit its position...") or a black box ("Preview loading...") | `addlayer-125.png` | text labels | W: icon + one line + the next action as a button |
| Fixed 4 px grid is not visible: spacing comes from `theme::space` values 6/10/14 mixed with hard-coded margins | all | `theme.cpp` spacing tokens, `theme::margins` calls | T+W: 4/8/12/16 scale, remove ad-hoc margins gradually |
| Settings pages have wide empty bottom areas and short pages; Stream page is wider than its viewport (horizontal scrollbar, clipped canvas button text and output rows) | `page02-125-settings.png`, `page04-125-settings.png` | `streampages::StreamPage` wrapped in `scrolled()` (`main_window.cpp:4194`); canvas choice buttons have long single-line captions | W: wrap, or set minimum width smarter |
| Connections page: the status sentence is squeezed into a narrow column and wraps one word per line, while a three-button row is always the same width | `page08-125-settings.png` | `connections_page.cpp` row layout | W: status above or below the name; buttons right-aligned |
| Panels cannot be docked, floated or hidden; only splitters (3 of them) | `main-125.png` | `QSplitter` only (`main_window.cpp:579-594`), no `QDockWidget` anywhere in `app/studio/src` | W: dock widgets, saved layouts |

### Surfaces

| Finding | Evidence | Cause | Fix |
|---|---|---|---|
| Every control has its own border, gradient, shadow and rim: buttons, nav rows, input fields, cards, list rows. Too many edges; it reads as a heavy "skeuomorphic 2019" look, not flat Fluent | `page00-125-settings.png`, `main-125.png` | `depth` block in the pack (`card.shadow blur 24`, `highlight`, `rim`, `primaryButton.glow` always on, `roundControl.extrusion`) rendered by `depth.cpp` (`DepthEffect : QGraphicsEffect`, `:49`) | T: remove rims and extrusion, keep one soft card shadow and the glow only on the live/primary button |
| Settings nav rows are bordered 3D buttons; a modern nav is a flat list with one accent marker on the selected row | `page00-125-settings.png` | QSS for `QListWidget#settingsNav` in `theme.cpp` | T/W: flat item, left accent bar, icons |
| Spin boxes have tiny, unreadable arrow stubs; checkboxes are a different shape from the switches | `page00-125-settings.png`, `page04-125-settings.png` | Fusion style plus QSS up/down buttons | W: custom stepper, or hide arrows and use a slider/inline +/- |
| Radii: 4 / 8 / 12, cards use 12, pills fully round; mixed shapes (pill buttons, rectangular inputs, rounded cards, square checkboxes) | all | `geometry.radius` in the pack | T: one radius family (6 buttons and inputs, 10 cards) |
| No blur or translucency anywhere; the toast, menus, tour card and task panel are solid dark with a copper rim | `main-125.png` (tour card) | not possible in Widgets for child widgets (`QGraphicsBlurEffect` exists but is expensive; true window blur needs the Windows backdrop API) | A (see verdict) |
| Icon set: nine small hand-drawn icons (`icons.cpp`) and elsewhere text; stroke weight and size vary | `main-125.png` | `app/studio/src/icons.cpp` (153 lines, 9 call sites) | W+asset: one SVG stroke set (for example a permissively licensed open set, an install/licence question for the user) drawn through `QSvgRenderer` with theme colour |

### Motion

| Finding | Evidence | Cause | Fix |
|---|---|---|---|
| Hover, press and focus are animated per widget with `QVariantAnimation`, 120/190/280 ms, outCubic. Timing is fine and close to Fluent | pack `motion` block, `motion.cpp:75-92, :196-206` | - | OK; keep |
| Hover is drawn by an overlay widget on every button plus a `QGraphicsEffect` for depth on about 50 widgets. Each effect re-renders its widget into a cache and any change repaints the card behind. Cost 9-12 ms per full-window paint in other themes, so any animation near 5+ widgets, or a resize, can exceed 16 ms | `docs/evidence/2026-11-08-themes/repaint-cost.json` (no copper-graphite entry; measure it) | `depth.cpp:316-323` (`setGraphicsEffect`), `DepthEffect` `:49`; `motion.cpp:120` hover overlays | W/T: measure copper-graphite; cut depth to the few widgets that need it; the "Reduce effects" switch already does this and halves cost |
| Resize jank is likely: the first-run picture needed two layout passes (probe comments in `main.cpp:232-243`), splitters re-lay out about 100+ widgets with stylesheet-based styling | `main.cpp:232-243` | QSS styling resolves per widget on polish and on every property change; `buildQss` is rebuilt for the whole app on theme change (`theme.cpp:1048, :1241`) | W: avoid dynamic property flips on hot paths; A for the rest |
| Panels, dialogs and the tour card appear instantly or fade with opacity only; no slide, no spring, no shared-element motion; the toast is the only "entrance" | `motion.cpp` | no page transition framework | W (small): fade/slide for the settings page change; A for "smooth" whole-panel motion |
| Focus ring: a copper outline on keyboard focus is present and clear (the Next button, the tab-focused button) | `posts-125-dialog1.png` | `focus: ring` in components | OK |

### Navigation

Click counts, measured from the code and screenshots (assuming a loaded project):

| Task | Clicks today | Typical modern app | Note |
|---|---|---|---|
| Go live | 1 (small round Start Stream at top right) | 1, large button | hard to see; no pre-flight summary before the click |
| Switch scene | double-click a row (tour text says so) | 1 click, or hotkey | not obvious; no scene hotkeys beyond list keys |
| Add a layer | 1 (+ in Layers title) opens a dialog with a kind list and a form (2-4 more clicks), or use the duplicate "Add layer..." button below | 1-2 | two entry points, one of them hidden below the fold |
| Edit a layer | select in list or click in preview; sliders in the right Inspector | same | preview editing exists (`preview-edit` on) but previews are small |
| Start a recording or a clip | 1 (round Record / Save clip) | 1 | fine; icon-only with tiny captions |
| Find a setting | Settings (1) then one of 11 pages; no search | search box or Ctrl+K | Advanced has 31 flags with no search or grouping |
| Open "My clips", "More", Help "?" | top-right text buttons of mixed style | one menu | "More" and "?" look unlike the rest |

Missing: a command palette, a settings search, a visible shortcuts list, scene hotkeys, an obvious scene "preview then take" flow (Meld and StreamYard both make the scene switch the main verb). Only a handful of shortcuts exist (`QShortcut` in `main_window.cpp:904-979, :1415-1425`: rename, delete, duplicate, copy/paste look, nudge, undo/redo).

Modal versus inline: Settings is a large modal window with Save/Cancel (consistent with the earlier "Save/Discard, not typed yes" decision); the add-layer dialog is modal. A side drawer for add and settings would keep the preview visible (needs docking, see Layout).

### Workflow

| Finding | Evidence | Cause | Fix |
|---|---|---|---|
| Live state is three small grey pills ("Offline", "Not recording", "Clips: ready") at the top; on air they would change text and colour, but nothing like a red on-air bar with a timer, bitrate, dropped frames or per-platform health is visible in the main window | `main-125.png` | pills in the top bar; text set at `main_window.cpp:2205` | W: a live strip: red dot + time + bitrate + dropped % + per-output chips |
| Status bar shows engineering text ("BLOCKED-ON-HOST (fake)", "Event core: down") and a one-line note in a different style, left-aligned and tiny | `main-125.png` | status bar widgets in `MainWindow` | W/T: a quiet connection dot; errors become a dismissible banner/toast with a next action |
| Errors and notices: a task bar with notifications, toasts and an alert bar exist (good structure: `taskbar.cpp`, `alertBar_`), but the wording is technical ("Adding needs a loaded project file", "Transitions need a loaded project file") | `addlayer-125.png` | text strings | text fix |
| Onboarding tour: 15 steps, spotlight with copper ring, "Don't show this again", Skip, Back, Next. The structure is good; the card covers the area it explains (the layers list) and 15 steps is long | `main-125.png` | `guide.cpp`, `coach.cpp` | W: place card beside the target, cut to about 6 steps |
| Settings > Advanced shows each feature flag as a switch with a paragraph that contains decision numbers (D224, D331), file paths and internal names | `page10-125-settings.png` | descriptions come straight from `data/flags.json` | text: add a plain `title` and a one-line `summary` per flag; keep the long text behind "Details" |
| Posts window shows raw file paths and unstyled sections with no headings | `posts-125-dialog1.png` | window content built without the section/card styles | W: use the same cards as Settings |
| Appearance page is good: theme cards with a miniature preview, tick, palette swatches (best-looking page) | `page06-125-settings.png` | - | keep; use this card style elsewhere |

### Consistency: Qt studio against the web control page

| Finding | Cause | Fix |
|---|---|---|
| The web page uses a blue accent (`#4f8cff`), a different surface scale and a different font stack; the studio uses copper-graphite and Barlow | `ui/css/tokens.css` vs `data/themes/copper-graphite.json` | T: generate `tokens.css` from the active theme pack at build or on request so both follow the user's theme |
| Names differ (studio "Controls" card, web page naming) and radii and button styles differ | `ui/css/app.css` | T/W |

## Quick wins (one to two days)

All inside the current toolkit; none needs a new dependency except the optional icon set.

1. Fix the cut-off text: let the track chips size to their text (or use "Rec"), make right-column labels wrap, wrap or scroll the Stream page properly (`main_window.cpp:1139`, `:1375`, `streampages`).
2. Replace the visibility text glyphs with a drawn eye icon (`main_window.cpp:1565`, `icons.cpp`).
3. Delete the duplicate "Edit scenes and layers" box (`main_window.cpp:1017`), keep row actions and the right-click menu.
4. Theme data pass on copper-graphite: letter spacing 0 for body, sentence case for buttons and nav, drop the `rim` and `roundControl.extrusion`, keep the glow only on the primary and live controls, one radius family, a clearer type ladder.
5. Switch the body face to Inter (already bundled), keep Barlow for headings; turn on tabular figures for numbers.
6. Make the settings nav flat with an accent bar and icons.
7. Rewrite the Advanced page labels (plain name and one line per flag), and the "needs a loaded project file" messages.
8. Move OWN WINDOW / TO FRONT into the preview panel title; give previews the saved space (splitter default `{620,200}` becomes about `{700,160}`).
9. Add a settings search box and `Ctrl+,` to open Settings; add scene hotkeys (1-9).
10. Measure the copper-graphite repaint cost with the existing `UJWALAM_STUDIO_PROBE_BENCH` and record it next to the other themes.

## Deeper redesign (several days to weeks)

1. A top "live bar": big Go live, record with timer, live health (bitrate, dropped frames, per-output state), on-air colour change of the whole header.
2. Dockable panels with saved layouts ("Live", "Edit", "Clips") using `QDockWidget`; previews as the large central area.
3. Command palette (Ctrl+K) over scenes, layers, actions and settings; shortcut map and editable hotkeys.
4. Add-layer as a visual gallery (icons and a live thumbnail) in a side drawer instead of a modal.
5. Inspector rebuilt as grouped, collapsible sections with scrubbable number fields (the existing `ValueSlider` is a good base), and a simple "preview then take" scene transition flow.
6. One icon set and one component library: all cards, rows, empty states and dialogs built from the same few themed widgets; retire per-page hand layouts (Posts, Review, Connections).
7. Shared design tokens: the theme pack drives both the Qt studio and the web control page.
8. Trimmed first-run tour (about 6 steps) plus contextual hints.

## Architecture verdict

Qt Widgets with a global stylesheet and `QGraphicsEffect` is a workable base for the colours, type, spacing, layout, docking, icons and the flat modern look. Everything in the quick-win list, and most of the deeper list, can be done in it. The reason it feels dated is mostly the theme data (heavy borders, caps, loose spacing) and a few layout mistakes, not the toolkit.

It does limit three things:

- **Blur / Mica / acrylic and translucent panels.** Child widgets cannot blur what is behind them cheaply. Only the top-level window can get a Windows 11 backdrop (a call to the Windows window-attribute API, small work, about 1 day, only visible if panels are made translucent, which fights the opaque preview area). A fake blur with `QGraphicsBlurEffect` costs a lot per frame on this GPU-shared laptop. Verdict: skip blur; use flat layered surfaces, as DaVinci Resolve does.
- **Smooth, GPU-composited animation of whole panels** (slide and spring, shared-element transitions, animated lists). Widgets repaint on the CPU through the stylesheet engine, each depth effect re-renders into a cache, and the measured cost is 9-12 ms per full paint, so animating many widgets, or resizing, drops frames. Small hover and press fades (what exists) are fine.
- **Custom, fully designed controls** at scale: each needs hand-painted code (as `depth.cpp`, `motion.cpp` and `value_slider.cpp` already do), which is slow to build and to keep consistent across 5 000+ lines of window code.

Options:

| Option | What it buys | Cost | Risk |
|---|---|---|---|
| A. Stay on Widgets, do quick wins plus deeper list items 1-3 and 5-7 | Most of the "modern" feel | 1-3 weeks | Low; no new runtime |
| B. A. plus a Windows backdrop on the main window only | Subtle Win11 feel | about 1 more day | Low-medium; must be tested under the offscreen probe and with the native preview windows |
| C. Move the shell to QML / Qt Quick (GPU scene graph) in stages: header, scene and layer lists, inspector first; keep native preview windows | Smooth animation, blur shaders, resolution-independent vector UI, real design-tool feel | 6-10 weeks, new dependency (Qt Quick modules not linked today; `CMakeLists.txt` uses Widgets and Network only), a second test approach for the probe, and the installer and Defender work repeat | Medium-high; GPU contention with the encoder on a 6 GB laptop GPU; native preview windows must be embedded carefully |
| D. Use the web page as the main UI (it already exists) | Fast iteration, CSS look | Weeks; embedded browser dependency and the local-API rules would need review | Medium; the user chose a native shell |

Recommendation: A, then B only if it still looks flat after A. Do not start C until A is done and a measured frame-time problem remains. This is a decision for the user (new dependency and large cost), not something to start on our own.

## Notes and unverified items

- Windows scaling of the user's display, 125-150 %: UNVERIFIED. The 150 % pictures show the same layout as 125 %, which is the expected result for Qt's scaling.
- The add-layer and add-scene dialogs, a live (on-air) main window, and the second tour steps were not captured (no project in the fake host; the probe cannot start a stream in a test). Their findings come from code and should be checked in a run with a real test project.
- Repaint cost for copper-graphite is not in the stored evidence.
- Hover and resize jank is judged from code and numbers, not seen.
- References (OBS 30+, Streamlabs Desktop, Twitch Studio, StreamYard, Meld Studio layout, DaVinci Resolve, CapCut desktop, Windows 11 Fluent) were applied from general knowledge of their well-known layouts, not by re-installing or re-capturing them.

Files created: this document; pictures in `docs/evidence/private/2026-11-11-ui-audit/` (gitignored). No code changed.
