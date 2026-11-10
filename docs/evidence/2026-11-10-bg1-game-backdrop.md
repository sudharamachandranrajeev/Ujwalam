# BG1: blurred game backdrop replaces the background layer (D331)

Date: 2026-11-10. Branch: `scene/game-backdrop`. Status: **tests pass; the look on a real game capture is UNVERIFIED.**

User request: "replace the current background layer in Ujwalam with a blurred copy of the game capture. it needs to
fill in the whole screen behind all layers".

## What changed

| Part | Change |
| --- | --- |
| `registry/presets/scene-default-h.json` 0.5.0 -> 0.6.0 | Browser `background` (atmos-frame) removed. New bottom layer `game-backdrop`: `duplicate` of `game`, blur strength 71, full canvas, no crop (16:9 source on a 16:9 canvas). No flag. |
| `registry/presets/scene-default-v.json` 0.4.0 -> 0.5.0 | Browser `background` removed. `game-backdrop` moved from z 0.5 to z 0 (bottom), `flag: layer-effects` removed. Blur 40 and crop 656 left/right kept. |
| `services/project/scene-upgrades.mjs` (new) | Scene upgrade `bg1` for saved projects (see below). |
| `services/studio-ui/alpha.mjs` | `upgradeAlphaFile`, `upgradePresets`; `prepareAlphaProject({ upgrade })` runs the upgrade on an existing project (`action: 'upgraded'`). |
| `services/studio-ui/launch.mjs` | Passes the upgrade (current registry presets) at start; logs each change, the backup name, or why it was not applied. |
| `data/flags.json` | `layer-effects` description: the backdrop no longer needs it. |
| `app/host/tests/host-fx-bench.test.mjs` | New opt-in case: the alpha scene's H + V backdrops, before/after. |
| Decision | D331 in `docs/plan/2026-10-29-v1-decisions.md` (exception to "new features behind a flag", at the user's request). |

The game layer's rounded corners keep `effectsFlag: layer-effects` (unchanged). The atmos-frame overlay stays in the
repo; the hidden H `atmos-front` layer still uses it.

### Blur strength

The host blur takes sigma = strength / 2 in **source** pixels. V: strength 40 = sigma 20 source px; the V backdrop
shows 608 source px across 1080 canvas px (scale 1.776), so about 35.5 canvas px. H: the backdrop shows 1920 source px
across 1920 canvas px (scale 1), so strength 71 = sigma 35.5 canvas px, the same on-screen blur. Proposed,
UNVERIFIED on a real capture. Tunable per layer in the studio's Look panel (Blur, "Strength (source px)" 1-100, no
flag) and live through `layers.setEffects` (D260).

## Existing projects (scene upgrade bg1)

How a saved project met a preset change before: `prepareAlphaProject` used an existing
`<dataDir>/projects/alpha.project.json` unchanged; only `--rebuild-alpha` (or the no-devices rebuild, D282) rebuilt it
from the presets, which drops the user's own edits. This holds for the installed app's data dir and the repo's dev data
dir alike (both go through `alphaProject` in `launch.mjs`).

Now, at studio start, before the project goes to the host:

1. The project is loaded (migrate + validate). A file that does not load, or loads only from its `.bak`, is left alone.
2. `upgradeScenes` (bg1): in every scene, for each preset `scene-default-h` / `scene-default-v`, it looks for the layer
   with origin `preset` `<preset>/background`. None: nothing to do (new builds, second starts, or a user who removed
   it). Found: the backdrop takes the background's place in the stack:
   - V (backdrop already in the project, hidden, no effects, from the flag-off build): the same layer is shown, moved
     to the background's place, pointed at the real game capture layer, and given the preset's blur only when it has
     no blur of its own (a user who had layer-effects on keeps their blur).
   - H: a new `duplicate` layer, origin `scene-default-h/game-backdrop`, full canvas, preset blur.
   - The backdrop always points at the capture layer (never a duplicate of a duplicate: the alpha build turns the V
     game into a duplicate of the H game). A placeholder game (no device) gives a transparent placeholder backdrop.
   - The background is removed; if another layer or an audio source refers to it, it is hidden instead.
   - Every other layer, its order, placement and effects, devices and audio are not touched.
3. When something changed: the file is first copied to `projects/_old/alpha-<stamp>.before-bg1.project.json` (the
   folder `--rebuild-alpha` already uses; never deleted), then the upgraded project is saved (atomic save, which also
   writes `.bak`).
4. A failed upgrade never blocks the start: the project loads as it is and the log says why.

Why not a `PROJECT_VERSION` migration: the document version describes the project format, which did not change; the
upgrade needs the registry presets (blur, crop, rect), which `migrate.mjs` does not have; and a version bump would
reach every project consumer including the host's validator. The trigger (the retired layer) makes the upgrade
one-time without adding a field to the strict project schema.

## Live

The upgrade runs only at studio start, before `project.load`, so outputs and a running stream are never touched (no
output restart). A studio that is already running (also while live) keeps its current scene; the backdrop arrives at
the next start. The preset files are not one of the LU2 (D324) hot-reloaded data files; this change does not add
them. On air the backdrop's blur can still be tuned live (Look panel, "yes, on air").

## Tests

All headless (`UJWALAM_HEADLESS=1`), temp data dirs only.

```
node --test tests/project-scene-upgrades.test.mjs        (new, 8 tests)
✔ bg1: old project -> blurred backdrop at the bottom of H and V; browser backgrounds gone; other layers untouched
✔ bg1: the user's moved and added layers stay; the backdrop takes the background's place
✔ bg1: a V backdrop the user already blurred (layer-effects on) keeps its own effects
✔ bg1: unbound game capture -> transparent placeholder backdrop
✔ bg1: a background another layer still uses is hidden, not removed
✔ bg1: a project without the retired background (new build, or the user removed it) is not changed
✔ bg1 on load: backup in projects/_old first, upgraded file saved, second load does nothing
✔ bg1 on load: a failed upgrade never blocks the start; the file is left as it is

node --test tests/project-*.test.mjs tests/studio-ui-alpha.test.mjs tests/hud-zones.test.mjs \
  tests/test-broadcast.test.mjs tests/studio-ui-flags-feedback.test.mjs tests/flags.test.mjs tests/registry*.test.mjs
ℹ tests 304  ℹ pass 303  ℹ fail 0  ℹ skipped 1

node --test app/host/tests/host-project.test.mjs   (real host: duplicate item, blurred duplicate render, setEffects)
ℹ tests 21  ℹ pass 21  ℹ fail 0

npm run validate:registry   OK: registry valid
npm run lint                0 finding(s)
npm run build:host          built out/host/build/ujwalam-host.exe (no host source change)
```

Preset tests now check: the bottom layer is the duplicate of `game` with blur in H (71, no crop) and V (40, crop
656/656), shown with layer-effects off and on, no flag, no browser background, unbound game -> placeholder; the alpha
build puts one backdrop per canvas at the bottom, both pointing at the H game capture.

## Cost (fx bench)

`UJWALAM_FX_BENCH=1 node --test --test-timeout=600000 app/host/tests/host-fx-bench.test.mjs`, laptop RTX 4050, no
output or encoder running. A 1920x1080 still stands in for the game capture: H framed game, V framed game as a
duplicate of it (as the alpha build does); "after" adds the two full-canvas blurred duplicates (H 71, V 40 crop 656).

| run | frame ms | GPU % |
|---|---|---|
| game only (before) | 0.208 | 19 |
| game + backdrops (after) | 0.226 | 32 |
| game only (before) | 0.177 | 20 |
| game + backdrops (after) | 0.230 | 31 |

Reference row from the same run: six full-canvas 1080p layers with blur 20 = 0.227 ms, GPU 33 % (none: 0.158 ms, 17 %).

Reading: render-thread time per frame rises by about 0.02-0.05 ms of a 16.7 ms frame. NVML GPU load rises by about 12
points at idle clocks (the GPU clocks down when idle, so the same work shows as a larger share; with NVENC running
the share is smaller). The host blur already works on a downscaled copy: it halves the texture until sigma <= 6.5
texels (H sigma 35.5: 3 halvings, 240x135; V sigma 20: 2 halvings, 480x270 of the source), then two separable passes
of at most 20 taps and a bilinear upscale. So no extra half/quarter-resolution step was added. The bench measures CPU
render-thread time and NVML load, not GPU ms per frame (no GPU timer query in the host); GPU ms per frame and the cost
while NVENC encodes H + V are UNVERIFIED, to be read on the next live soak (`npm run soak`) or test stream.

## UNVERIFIED

- The look of both backdrops on a real game capture (blur strength 71 H / 40 V, the V 608x1080 centre crop).
- GPU ms per frame and headroom with NVENC encoding both canvases.
- The upgrade on the user's own installed project (tested on projects built from the old presets in temp dirs only;
  the user's `%LOCALAPPDATA%` data was not touched).
