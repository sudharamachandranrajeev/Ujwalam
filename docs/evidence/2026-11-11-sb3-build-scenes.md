# 2026-11-11 SB3: build new H and V scenes from a reference read (D341)

Result: **PASS** on the drawn SB2 fixtures (layout within tolerance on both canvases, existing-state hash unchanged after
dry run and apply, round trip through the importer to a temp project file).
Real references: dry runs only, against a temp copy of a fixture project, **UNVERIFIED** (see the last section).

Branch `sb/build-scenes` (from `claude/alpha0-d1` at 841f128, SB1–SB2 merged). Plan section C of
`docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` (D324), row SB3; build plan §4.7 ("Theme → scene
generator", "Isolated import"). Decision D341. Behind the flag `scene-builder` (off by default).

## What was built

- `services/scene-builder/build.mjs`: `buildPackage(read, project, { rules, bind, theme })` -> a scene package. The
  reference canvas (H for a wide reference, V for a tall one) takes the slot boxes; the other canvas is laid out by
  `data/scene-builder/build-rules.json` (status unverified): V inside the V safe zone (YouTube Shorts margins from
  `data/clip/targets.json`), game across the safe width and never cropped, camera + alerts above it, chat below; H a
  left column (camera, alerts, chat) beside the contained game. Graphics only on the reference canvas.
- `services/scene-builder/sources.mjs`: which project layer, device or overlay each role links to, with the reason;
  anything ambiguous is "missing" with a `--bind` hint. Never creates a device.
- `services/project/scene-package.mjs`: the importer. `planScenePackage` (dry run, pure) applies the package's
  scene-layout-presets through the existing preset loader as ONE new namespaced scene, `applyScenePackageFile` saves
  it atomically (dry run by default). `diffText` prints the diff.
- `services/project/scene-preset.mjs`: new preset layer type `link` (a duplicate of an existing project layer, bound
  by `opts.links`); `mergeCanvasScenes` moved here from `services/studio-ui/alpha.mjs` unchanged.
- `services/overlay-server/pages/ujwalam-panel/index.html`: token panel for graphics slots (`--glass`, `--steel`,
  `--radius-*`, `--ember-glow`; `?theme=` sets `data-theme`; one 300 ms fade, no flashes, no innerHTML).
- `services/scene-builder/cli.mjs`: `build <reference> --project FILE [--bind ROLE=ID]... [--theme ID] [--out PKG]
  [--apply] [--json]` and `import <PKG> --project FILE [--apply] [--json]`; exit 2 while the flag is off.
- `data/schemas/scene-package.schema.json`, `data/scene-builder/build-rules.json`.
- Registry: `theme-scene-generator` and `isolated-import` now `in-progress`; flag text updated.
- No studio-ui RPC: the studio server never takes a file path from the page (services/studio-ui/import.mjs), so there is
  no natural place yet; the CLI is the entry point.

## Tests (affected suites only, one at a time, `--test-timeout=60000`)

```
node --test --test-timeout=60000 tests/scene-builder-build.test.mjs      tests 16  pass 16  fail 0
node --test --test-timeout=60000 tests/scene-builder-reference.test.mjs  tests 23  pass 23  fail 0
node --test --test-timeout=60000 tests/project-scene-preset.test.mjs     tests 14  pass 14  fail 0
node --test --test-timeout=60000 tests/project-scene-preset-v.test.mjs   tests 13  pass 13  fail 0
node --test --test-timeout=60000 tests/studio-ui-alpha.test.mjs          tests 38  pass 37  fail 0  (1 skipped: no face worker script, pre-existing)
node --test --test-timeout=60000 tests/registry.test.mjs                 tests 14  pass 14  fail 0
node --test --test-timeout=60000 tests/flags.test.mjs                    tests 7   pass 7   fail 0
node tools/lint.mjs <every new or changed file>                          lint: 0 finding(s)
```

Commit hook quick checks: `ci: 9/9 passed` on every commit. The full CI and the soak were not run (other agents).

### What `tests/scene-builder-build.test.mjs` proves

Tolerance (D339, D341): every side within 0.03 of the canvas side. Fixtures: the SB2 drawn layouts (`layoutH`
960x540, `layoutV` 540x960), read in memory through `readFrames`, built against a project made like the alpha one
(capture card + camera, Default H + V in one scene, an alert-box layer).

1. Reference canvas, H and V: camera, chat, alerts and the graphics panel land on the drawn truth boxes within 0.03;
   the game is contained in its box (never cropped), centred, filling it on one axis; z order graphics < game <
   camera < alerts.
2. `fitBox`: contain keeps the source shape; cover crops a centred band up to `maxCrop` and falls back to contain.
3. V from an H reference: all four layers inside the V safe zone, no overlaps, the game keeps the existing layer's
   own crop only and its aspect; graphics listed as not carried.
4. H from a V reference: inside the canvas, no overlaps, column left of the game; a V reference that puts chat
   outside the safe zone is warned and kept as drawn.
5. Links: game and camera are duplicates of the existing capture layers on both canvases; no capture layer and no
   device added; chat and alerts reuse the existing overlay entries and their settings (`hold`, `types` kept;
   `x`, `y`, `canvas`, `theme` set); only the panel overlay entry is new.
6. Placeholders: a missing alerts source and a low-confidence chat slot (rules minConfidence 0.6 vs the read's 0.55)
   become transparent colour layers that keep the slot geometry, with the reason in the diff and the text.
7. Two cameras, none marked: the camera is a placeholder that asks for `--bind camera=`; `--bind` to a device gives
   an H capture layer on the existing device and a V duplicate of it (device opened once); an unknown bind id is a
   placeholder.
8. A package imported into a project without the bound layer: placeholder "not in this project", never re-guessed.
9. Dry run: the input object is byte-identical, `existingState.before == after`, changes and removes empty, the
   existing scenes equal, activeScene kept; scene "Built: <reference>" with origin `scene-package/<id>`; a second
   import gets "(2)".
10. Round trip: build -> package file (schema-valid) -> importer dry run (project file bytes unchanged) -> apply to a
    temp project file -> reload: validates, the existing state (file minus the new scene and new overlay entries)
    hashes the same as before, devices unchanged, saved placements equal the dry-run diff.
11. Refusals: a malformed package; a project that loads only from its .bak.
12. CLI: flag off -> exit 2, no output, file unchanged; `build` is a dry run (file unchanged), `--out` saves a
    schema-valid package and refuses an existing file, `import --json` dry run, `import --apply` adds the scene; bad
    arguments exit 1.
13. Panel page: no colour of its own in the CSS, no innerHTML or remote script, every duration under 600 ms.

## Real references (dry run only) — UNVERIFIED

The three references in the gitignored stream assets layout folder (two images, one video sampled at 4 frames) were
built with `cli.mjs build <file> --project <temp fixture project> --data-dir <temp dir with the flag on>`. Every run
exited 0, printed a dry-run diff with "existing state unchanged", and the temp project file's sha256 was the same
before and after. No result is recorded here: the inputs are private assets, and how good the scenes look needs the
user's check in the studio. The user's real project was not read or written.

Seen on those runs (no values): a wide camera slot (camera box much wider than 16:9) falls back to contain because
the cover crop would exceed 40 %, so the camera shows smaller than its slot; low-confidence graphics (0.35) become
placeholders; a tall reference's camera outside the V safe zone is warned.

## Not done / open

- UNVERIFIED: the V safe zone values (Shorts margins, agent knowledge) for a live V stream; the build-rules numbers;
  that the host shows a duplicate of a layer from another scene in a new scene exactly like the original (the model
  and the host's pass 1 accept it; not seen on a real host run); the panel page in the libobs browser source.
- The palette is not written into the scene as colours (tokens only); a theme from the reference is SB4.
- A running studio shows the new scene after the project is loaded again; no live reload yet (LU2).
- No studio UI or RPC (behind the flag later, SB5 edits).
