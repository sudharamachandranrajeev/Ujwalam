# v1 first scene preset "Default H", 2026-10-30

Result: **PASS** for the preset, loader and tests (10 new tests; registry validator and tests pass with them). **Meld match: done locally against the real session file, geometry only below.** The side-by-side capture against the live Meld layout (spec "Done when", 1 percent) is **not done** (needs the host and a render; UNVERIFIED).

Spec: `docs/plan/2026-10-29-preset-h-default-layout.md` (moved from the inbox). Decisions D110 to D116 in `docs/plan/2026-10-29-v1-decisions.md`.

## What was built

- `registry/functions/scene-layout-preset.json` (core function, in-progress) and `registry/presets/scene-default-h.json` (preset, parity `none`).
- `services/project/scene-preset.mjs`: `loadScenePreset(project, preset, {profile, roles})` returns a deep copy of the project with one NEW scene; also `placeholderKeys`, `resolveString`.
- `data/profile.example.json`: additive keys `brand.wordmark`, `brand.character`, `handles.{twitch,youtube,kick}`, `links.discord` (angle-bracket placeholders). The local profile has none of these yet.
- `tests/project-scene-preset.test.mjs`, `tests/fixtures/project/profile.fixture.json` (placeholder values only).

## Commands and output

```
$ node --test tests/project-scene-preset.test.mjs tests/registry.test.mjs
tests 24, pass 24, fail 0, skipped 0
$ npm run validate:registry
OK: registry valid
$ node --test tests/registry.test.mjs tests/project-schema.test.mjs tests/project-store.test.mjs tests/project-import-meld.test.mjs tests/project-scene-preset.test.mjs tests/lint.test.mjs tests/private-scan.test.mjs
tests 165, pass 165, fail 0, skipped 0
$ node tools/git-hooks/private-scan.mjs scan-files <new and changed files>
private-scan: 6 content item(s) scanned, 0 skipped (exit 0)
$ npm run lint
lint: 2 finding(s) (eol=2): services/studio-ui/launch.mjs, ui/js/app.js (CRLF; files of another agent, not touched)
```

Tests cover: preset validates; load appends one scene and leaves scenes, devices, audio, outputs, canvases, activeScene, existing overlays and the input object byte-identical (empty project and the sample project); H-only pixel geometry; roles unbound/bound (no device created, wrong kind refused); cam-pop rule layer id equals the Facecam layer id; placeholders resolve from the fixture and query values are encoded; a missing key fails by key name with the project unchanged; two loads give distinct ids.

Real-session run (local, counts only): the importer on the user's Meld session file gave 10 scenes; loading the preset (filler profile, since the local profile lacks the new keys) gave 11 scenes, input unchanged, 5 overlay entries added, both device roles unbound (the real project has 4 cameras and no capture-card, because the importer files every video device as `camera`). No real names, paths or values were written to any committed file.

## Meld match (H scene, geometry only; region labels from the spec)

The session file is from April 2026 (the importer evidence notes the user's current state is newer). Difference = largest of x, y, w, h in percentage points of the 1920x1080 canvas (spec value vs Meld box). Values are percent of the canvas, x/y/w/h.

| z | Region | Spec | Meld | Max diff (pp) | Used |
|---|---|---|---|---|---|
| 0 | Background | 0/0/100/100 | -2.4/0.1/107.6/107.6 (hidden layer, overscan) | 7.6 | spec |
| 1 | Game capture | 24.7/2.6/74.0/91.0 | 24.4/2.9/73.8/90.5 | 0.5 | Meld |
| 2 | Facecam | 1.4/55.7/20.2/34.7 | 1.4/56.5/20.2/34.5 | 0.8 | Meld |
| 3 | Event / chat list | 1.2/20.2/17.4/33.0 | 1.0/20.3/17.8/33.6 | 0.6 | Meld |
| 4 | Wordmark | 0.6/10.6/20.4/9.6 | -0.5/0.0/21.2/27.4 | **17.8** | spec |
| 5 | Goal bar | 0.0/3.8/23.5/5.7 | 0.4/0.9/22.8/9.3 | **3.6** | spec |
| 6 | Twitch follower counter | 25.9/0.0/23.4/3.0 | 20.9/-1.0/30.4/27.8 | **24.8** | spec |
| 7 | Subscribe call to action | 53.6/2.1/16.8/7.4 | 52.9/2.3/17.9/8.1 | 1.1 | Meld |
| 8 | YouTube subscriber counter | 76.4/0.0/19.3/2.6 | 73.1/-1.6/23.9/27.8 | **25.2** | spec |
| 9 | Social ticker | 0.0/95.3/100.0/4.7 | -0.7/91.9/101.1/27.8 | **23.1** | spec |
| 10 | Character cutout | 92.7/77.7/7.3/22.3 | no confident match | - | spec |
| 11 | Effects (full canvas) | 0/0/100/100 | a full-canvas widget with a different name only (0.5) | 0.5 | spec |
| 12 | Atmos front | 0/0/100/100 | no matching layer | - | spec, hidden |
| 13 | Cam-pop | rule target | no Meld equivalent | - | rule on Facecam layer |

Regions with no Meld match: **Character cutout** (the only candidate is a wide duplicate layer at the bottom right whose box extends past the canvas; identity not confirmed), **Atmos front**, **Cam-pop** (a rule, not a layer), **Effects** (geometry only). **Background** matches a layer that is hidden in Meld and overscans the canvas.

Differences over 2 percentage points: Background, Wordmark, Goal bar, Twitch follower counter, YouTube subscriber counter, Social ticker. In all of them the Meld layer is a Meld-hosted widget or an animated media file whose box (300 px tall for the three widgets) is much larger than the visible content the spec measured. Per D114 the spec value is kept for these; the user can choose Meld's box per layer (`geometry` field in the preset).

Meld layers in the scene that the spec has no region for (counted, not named): 1 third-party alert overlay (full canvas), 1 activity widget on the right, 3 duplicate layers acting as frame, blur or glow behind the game and facecam, and about a dozen hidden layers.

## Game aspect finding (spec issue 3): crop, not stretch

From the Meld game-capture layer (a video device, 1920x1080 source, keep-aspect true, fit mode 2):

- scaleX = 0.90541, scaleY = 0.90541 (equal): uniform scale.
- Scaled source = 1738.4 px wide, 977.8 px tall.
- Layer box = 1417.8 x 977.8 px. The height equals the scaled height; the width is 320.6 px narrower than the scaled source, so **Meld clips 320.6 px (354 source px, 18.4 percent of the source width) off the sides**. Visible source region 1566 x 1080, aspect 1.45:1, which is the spec's 1.43:1 region.
- Offset X = 1.19 (unit not known, near centre): the crop is about centred. UNVERIFIED which side loses more.
- Result: not stretched. Corner radius 76.3 px (not carried into the preset).
- The facecam is the same kind of crop (uniform scale 0.345, 798 source px clipped) plus a flip that the project placement cannot express.

Nothing was changed. The preset reproduces Meld's crop (177 source px per side) because a project placement stretches the source into its box: without a crop the capture would be stretched to 1.45:1. The host reads `placement.crop` in source pixels, UNVERIFIED against Meld.

## Placeholders, gaps, risks

- The local profile lacks the new keys; a real load fails by key name until they are filled (D113).
- Facecam flip is not representable; game and facecam crops are centred guesses (UNVERIFIED).
- Subscribe call to action is a transparent placeholder (no legacy overlay draws the pill).
- Twitch and YouTube counters both point at blood-moon-hud, which draws both counters in one part; a per-platform page option is needed.
- HUD, ticker and chat-list pages lay themselves out for the full canvas; their behaviour inside smaller browser boxes is UNVERIFIED.
- The ticker's brand values are passed in the URL query, but the legacy page reads its handles from the brand config, not the URL.
- Background and Atmos front are two atmos-frame configurations; which parts make the stone backdrop is UNVERIFIED.
- Layout issues 1 to 4 of the spec are tracked in the end-list (L12 to L15); not changed here.
- No render or side-by-side was made; no screenshot was made or committed.
