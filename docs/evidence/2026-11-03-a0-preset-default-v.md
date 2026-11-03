# A0 scene preset "Default V", 2026-11-03

Result: **PASS** for the preset, registry validation and tests (7 new tests). **Meld match: done locally against the real session file, geometry only.** A side-by-side render against live Meld is **not done** (needs host and preview; UNVERIFIED). Parity stays `pending`.

Method follows `docs/plan/2026-10-29-preset-h-default-layout.md` and D110 to D116: Meld values replace measured ones, crop not stretch, overlays use legacy overlay rel paths, sources with no legacy overlay become documented placeholders, differences over 2 percentage points are reported.

## Source scene (chosen, not ambiguous)

- Two local Meld files exist (counts only): the gitignored `session file/` copy (written 2026-10-26, 12 scenes) and the Meld package backup `session.bak.json` (written 2026-04-07, 10 scenes, the file Default H was built from).
- Both name the same current scene (an H scene whose linked V scene is "Mobile Live Full view"), and the legacy layer map documents the same pair as the stream layout. Only one V scene is linked to the current scene, so there was no ambiguity and no stop. The 2026-10-26 file is newer (V scene 30 layers incl. 4 group children, against 27 in April) and already uses the legacy overlays; it is the source here.
- Other V scenes in that file (placeholders, layer count): 11 more, e.g. 2 / 3 / 28 / 28 / 20 / 9 / 26 / 29 / 1 / 7 / 8 layers. Not used.
- Importer finding: the `session file/` copy has the shape `{ session: { version: 1, ... } }` (no top-level `version`), and `services/project/import-meld.mjs` refuses it ("unsupported Meld session version undefined"). It was wrapped into `{ version: 1, session }` in a scratch folder outside the repo for the run below. Proposed fix is in the decisions.

## Commands and output

```
$ node services/project/import-meld.mjs --in <scratch>/wrapped.json --out <scratch>/wrapped.project.json --report <scratch>/wrapped.report.json
import-meld: 12 scene(s), 154 layer placement(s) imported (13 H+V pairs), 199 skipped, 7 device(s), 47 audio source(s), 5 overlay(s)
$ node <scratch>/real.mjs        (H then V preset loaded into the imported real project, fixture profile)
input unchanged true scenes 12 -> 14 valid true overlays added by V 0 unbound game-capture+facecam
canvases h:1920x1080,v:1080x1920
$ node --test tests/project-scene-preset-v.test.mjs tests/project-scene-preset.test.mjs
tests 17, pass 17, fail 0, skipped 0
$ npm run validate:registry
OK: registry valid
$ node --test tests/registry.test.mjs tests/project-schema.test.mjs tests/project-store.test.mjs tests/project-import-meld.test.mjs tests/project-scene-preset.test.mjs tests/project-scene-preset-v.test.mjs tests/lint.test.mjs tests/private-scan.test.mjs
tests 172, pass 172, fail 0, skipped 0
$ npm run lint
lint: 0 finding(s), 27 allow marker(s), in 3.5s
$ node tools/git-hooks/private-scan.mjs scan-worktree
private-scan: 7 term(s) loaded (0 short, whole-token); ...
private-scan: 567 content item(s) scanned (0 UTF-16 decoded, 33 binary scanned as raw bytes); 0 skipped
```

Note: the worktree had no `legacy/`; the registry validator checks `legacySource` on disk, so a junction to the main repo's `legacy/` and a copy of the local profile were used for the run and removed afterwards. Without them the validator also reports the 64 existing "legacySource does not exist" errors, unrelated to this change.

New tests (`tests/project-scene-preset-v.test.mjs`): registry validates and V preset metadata; z 0..12 plus rule z13 and rects inside the canvas, game crop leaves 1248 source px; loads into `createProject()`'s v canvas with both roles bound, validates, V placements only, facecam hidden, crop kept; unbound roles become colour layers and browser pages are sized to the placement; placeholders resolve from the fixture and a missing profile fails by key; no path, URL or 32-hex id in the committed text; H and V load into one project in both orders, H scene untouched, ids unique, one overlay entry per page.

## What was built

- `registry/presets/scene-default-v.json` (preset, canvas v, status in-progress, parity pending, `similar` Default H, `legacySource` the legacy layer map).
- `registry/functions/scene-layout-preset.json`: `canvases` now `["H","V"]` (additive; the registry validator requires the preset canvas to be listed).
- `tests/project-scene-preset-v.test.mjs`.

## Meld vs preset (V scene, 1080x1920, percent of canvas x/y/w/h)

Placeholder names only. Difference = largest of x, y, w, h in percentage points, Meld box against the preset rect.

| z | Layer key | Meld | Preset | Max diff (pp) | Geometry | Source |
|---|---|---|---|---|---|---|
| 0 | background | blurred enlarged duplicate of the game capture (not representable) | 0/0/100/100 | n/a | spec | atmos-frame, canvas option UNVERIFIED |
| 1 | game | -1.5/23.9/101.6/48.7 | 0/23.9/100/48.7 | 1.6 | meld-clamped | capture role `game-capture`, crop 336+336 |
| 2 | facecam (hidden) | 41.8/1.0/48.2/23.2, rot 180.65 | same | 0 | meld | capture role `facecam`, crop top/bottom 21 |
| 3 | subscribe-cta | 1.5/0.8/43.9/6.3 | same | 0 | meld | transparent placeholder (looping video) |
| 4 | wordmark | 62.5/73.6/37.5/15.4 | same | 0 | meld | `{brand.wordmark}`, target not resolved |
| 5 | youtube-subscribers | 56.3/72.4/46.0/16.9 | 56.3/72.4/43.7/16.9 | **2.3** | meld-clamped | blood-moon-hud counters (page option gap) |
| 6 | twitch-followers | -3.5/72.3/54.0/15.6 | 0/72.3/50.5/15.6 | **3.5** | meld-clamped | blood-moon-hud counters (page option gap) |
| 7 | support-cta | 1.4/78.8/48.7/15.4 | same | 0 | meld | transparent placeholder (looping video) |
| 8 | social-ticker | -133.8/93.2/284.3/23.3 | 0/93.2/100/6.8 | **184.3** | meld-clamped | social-ticker, handles from the profile |
| 9 | effects | 0/0/100/100 | same | 0 | meld | chat-charge `canvas=vertical` |
| 10 | voice-callout | 0/0/100/100 | same | 0 | meld | voice-callout `streamerbot=1` |
| 11 | chat-engage | 0/0/100/100 | same | 0 | meld | chat-engage |
| 12 | chat-storm | 0/0/100/100 | same | 0 | meld | chat-storm `canvas=vertical`, same 8-colour list |
| 13 | rule campop | cam-pop-frame browser layer, full canvas, bound to the hidden camera duplicate | rule on facecam | n/a | rule | as Default H |

Mismatches over 2 pp (all from clamping a box that runs past the canvas, none are measurement differences): YouTube counter 2.3 (right edge 4.3 pp past the canvas), Twitch counter 3.5 (left edge 3.5 pp past), social ticker 184 (a 284 percent wide strip, mostly outside the canvas; which part shows in Meld is UNVERIFIED). The game box differs 1.6 pp (within the rule). Counter and ticker boxes are Meld containers (D114); the visible content is likely smaller.

Meld V layers deliberately not in the preset (counted, with reason): 4 hidden layers; a Meld-hosted widget (confetti, full canvas); 2 media layers (a wide overlay strip with a mirrored negative scale, and a rotated confetti clip); a group "Random Overlays" holding 2 browser pages (comic-pop, a Meld-hosted gg-drop); 2 Spark elements (chat-spotlight and a pets element, hosted outside `overlays/`); a text layer (hidden); the blurred game duplicate. The legacy overlays used by Meld are all present (chat-storm, chat-engage, voice-callout, chat-charge, cam-pop-frame as the rule).

Not in V, in H: events/chat list, goal bar, character cutout, atmos front (no matching V layers in the Meld scene).

## UNVERIFIED

- Everything in a render: geometry, stacking order direction (index 0 taken as top, as the importer does), crops (centred guess; Meld's offset unit unknown), rotation.
- Which Meld duplicate is the wordmark, the Twitch counter and the YouTube counter (names only; duplicate targets not resolved by the importer).
- `canvas=vertical` option on atmos-frame for the background (the legacy page has vertical styles, the URL option was not read).
- That the 2026-10-26 session file is the live Meld state (the running app holds the live session).

## Proposed end-list lines (layout issues, for the user)

1. The game crop removes 336 source px per side (35 percent of the 1920 width). On a mobile game those edges hold the on-screen controls and buttons; the 1248x1080 visible region is almost square, shown at 1080x935. Meld does the same (scale 0.866 with a clipped box). Confirm the crop or give the visible region.
2. Four full-canvas effect pages (Chat Charge, Chat Storm, Chat Engage, Voice Callout) sit above the game region. Effects cover the game HUD, minimap and joysticks while they play. Shared effect budget and claimed region need setting before a live test.
3. The counters (72 to 89 percent y) and the support call to action (79 to 94 percent y, left half) overlap, and the wordmark (right half) overlaps the YouTube counter and the ticker strip. Resolve in the editor.
4. Facecam is hidden in the Meld V scene and Meld rotates it 180.65 degrees; the project placement cannot rotate. Needed before showing a camera on V.
5. Subscribe pill, support animation, comic-pop, gg-drop, chat-spotlight and the pets element have no legacy overlay in `overlays/`; they stay placeholders or are left out until they become overlays or `duplicate` and spark types exist.
6. A background of the blurred game duplicate needs a `duplicate` layer type in the preset loader (the project model has it).

## Files created or changed

- Created: `registry/presets/scene-default-v.json`, `tests/project-scene-preset-v.test.mjs`, this file.
- Changed: `registry/functions/scene-layout-preset.json` (`canvases` H and V).
- Not committed. Scratch outputs (imported project, report, scripts) are outside the repo.
