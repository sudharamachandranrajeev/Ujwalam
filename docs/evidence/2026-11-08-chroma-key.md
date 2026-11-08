# 2026-11-08 Chroma key layer effect; Meld ChromaKey import; effects keep audio (P5, D246)

Status: tests pass (native host renders and records, schema/validator, Meld import); checked on the user's three real green-screen CTA videos (local, gitignored); not yet used on a real stream.

## Why

The target layout's subscribe pill, "subscribe and support" and confetti call-to-action are green-screen videos that Meld shows through a ChromaKey effect. The importer dropped every layer effect, so an imported session showed them as green boxes. Real sessions carry 53-64 keyed layers each.

## Checks

- `node --test app/host/tests/host-project.test.mjs`: 13/13.
  - Malformed chromaKey refused by validator and host (bad colour, similarity 0, smoothness 1001, missing field).
  - Render: a green card under the key shows the red background; a blue card under the same key stays blue.
  - Audio: a looping 440 Hz clip shown only through a keyed item records at the same level as the plain clip: `effects audio: plain -21.1 dBFS, through effects -21.1 dBFS`. With the passthrough disabled the test fails.
- Real videos (probe, H canvas 1280x720 over magenta; share of pixels after keying):

  | video | key (OBS similarity/smoothness) | green left | background shows |
  |---|---|---|---|
  | subscribe pill (WebM VP9) | 300/1 | 0.0 % | 91.4 % |
  | subscribe and support (MP4) | 440/103 | 0.0 % | 82.1 % |
  | confetti call-to-action (MP4) | 430/1 | 0.0 % | 72.1 % |

  A first mapping (similarity = threshold x 1000, smoothness = feather x 1000) left "subscribe and support" as a half-transparent green-magenta blend (0 % clean background): its green is dark (~#208040) and Meld uses threshold 0.03 with feather 0.41. The fitted mapping is similarity = (threshold + feather) x 1000, smoothness = feather x 250. It was fitted on these three files only and is UNVERIFIED for other footage.
- `node --test tests/project-import-meld.test.mjs`: enabled ChromaKey imports (`#00FF00`, 0.03, 0.41 -> `#00ff00`, 440, 103); disabled effects are skipped; other effect types are counted in `report.ignored` (`effect GaussianBlur`, ...); a V copy with different effects is reported (H kept).
- Real sessions re-imported and loaded in the headless host: all scene activations pass (18, 20, 20).
- Project, studio-ui and flags suites: 261/261. `npm run lint`: 0 findings.

## Design

- Project effect `chromaKey {color #RRGGBB, similarity 1..1000, smoothness 1..1000}`; host: OBS `chroma_key_filter_v2` on the item's effects wrapper.
- The effects wrapper is now a composite source whose audio is the target's own mix (as an OBS scene mixes its items). An item with effects sounds like one without. Before this, a keyed video layer with sound (the user's mode title animations) would have been silent. The host's plan warning about this is removed.

## Limits

- Other Meld effects (GaussianBlur, DropShadow, GlowStyles, BrightnessContrast, CornerPin, rounded corners) are still not imported; GaussianBlur and corner radii map onto existing effects and are the next step.
- Two items of one audio source in a scene mix its audio twice, with or without effects (libobs scene behaviour, unchanged).
