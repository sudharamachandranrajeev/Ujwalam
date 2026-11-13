# Realism look: filmic LUT, base `luts`, realism scene (D381)

Date: 2026-11-13. Result: PASS for the data, the project change, the route and the package list. GPU cost, the look on
real footage and the studio menu click are UNVERIFIED (see below). Live feature: awaiting live test.

## What was built

- `tools/make-realism-lut.mjs` writes `data/luts/realism-filmic.cube` (33^3, Adobe .cube 1.0, LF, 970 KB): saturation
  tame on over-saturated colours (at most 18 % of chroma), gentle filmic S-curve with a 0.01 black lift, highlight
  shoulder above 0.75 (white at 0.97), cool shadows / warm highlights at most 1.2 %. Deterministic (+ - * / and
  `toFixed(6)` only); `--check` compares the committed file.
- New read-only file base `luts` = `<app root>/data/luts`: host (`app/host/src/model.cpp` resolve_file allowlist,
  `app/host/src/methods.cpp` load options), `data/schemas/project.schema.json`, `services/project/validate.mjs`,
  `app/host/lib/project.mjs`, `services/studio-ui/alpha.mjs` (`alphaBases` adds `luts` when the folder exists). The
  host keeps every resolved file inside the base folder (canonical path containment, unchanged).
- Package: `tools/package/manifest.mjs` ships `data/luts/*.cube` (REPO_GLOB_DIRS).
- Preset `registry/presets/fx-realism-grade.json` (layer-lut, `{base: "luts", rel: "realism-filmic.cube"}`, amount
  0.85); `fx-lut-look` lists it as similar.
- `realismScene` in `services/project/structure.mjs` and route op `scene.realism` on `/ui/api/project/structure`
  (flag `realism-look`, not while live): copies the scene as "<name> Realism" (id `<id>-realism`, then `Realism 2`, ...)
  and appends lut 0.85, sharpen 0.3, vignette 0.25 (size 0.55, softness 0.8, black) to every layer of the copy that
  shows the game capture (role-bound game device, else the only capture card), the blurred backdrop duplicates
  included. The source scene is never changed. Refused: `no-game-capture`, `too-many-effects` (6-effect limit),
  `realism-look-off`. A realism copy of a realism scene does not stack the grade twice.
- Studio (Qt): scene right-click menu "Make realism scene" next to "Duplicate scene", shown only while the flag is on;
  one click, no question (D332); plain-words messages for the new error codes.
- Flag `realism-look` in `data/flags.json`: default off, page Editing.

## Commands and output

```
node tools/make-realism-lut.mjs --check
```
```
realism LUT up to date
```

```
node --test tests/realism-look.test.mjs
```
```
✔ LUT: the committed data/luts/realism-filmic.cube is exactly what tools/make-realism-lut.mjs writes
✔ LUT: .cube format (33^3, red fastest, values 0..1) and the look stays gentle
✔ base luts: the project validator and the host lib take it; other names stay refused
✔ preset fx-realism-grade: the LUT effect the realism scene uses, on a shipped file
✔ realismScene: a named copy; every game layer of the copy gets the grade after its own effects; the source is untouched
✔ realismScene: no game capture, the effect limit and unknown scenes are refused; capture card fallback
✔ server: scene.realism needs flag realism-look (not scene-edit), refused while live, host first then the file
ℹ tests 7  ℹ pass 7  ℹ fail 0
```

```
node --test tests/realism-look.test.mjs tests/project-structure.test.mjs tests/package-alpha.test.mjs tests/project-schema.test.mjs
node --test --test-name-pattern="alpha bases" tests/studio-ui-alpha.test.mjs
node --test tests/flags.test.mjs tests/registry.test.mjs tests/registry-layer-effects.test.mjs
node --test --test-name-pattern="LU7" tests/live-updates.test.mjs
node --test tests/stream-day.test.mjs tests/studio-ui-flags-feedback.test.mjs tests/data-reload.test.mjs
npm run validate:registry
node tools/lint.mjs
node tools/ci.mjs --quick
```
```
tests 154, pass 151, fail 0, skipped 3 (the skips are the existing opt-in package E2E tests)
tests 3, pass 3, fail 0          (alpha bases incl. the new luts test)
tests 24, pass 24, fail 0
tests 3, pass 3, fail 0
tests 35, pass 35, fail 0
OK: registry valid
lint: 0 finding(s)
build PASS, lint PASS, build-host PASS, build-studio PASS, validate-registry PASS, validate-outputs PASS,
validate-games PASS, private-scan PASS, legacy-verify PASS; ci: 9/9 passed in 202.7s
```

## Not checked (UNVERIFIED)

- GPU cost of lut + sharpen + vignette on the game layers (H 2K, V 2K, backdrop duplicates) next to the three NVENC
  encodes: not measured. Per-pixel filters in OBS's own obs-filters; expected small, to be measured by the lead with the
  host running (bench / health dashboard, NVENC and GPU load before and after).
- That OBS's clut_filter loads this .cube (header lines LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX only) and the look on real
  game footage: no host or fx test was run, because the installed Ujwalam was running (GPU tests next to it reset the
  GPU, 2026-11-12).
- The studio menu item ("Make realism scene") in the running Qt window: built, not clicked; `tests/studio-qt-shell.test.mjs`
  (starts the studio exe) was not run. With the flag off the scene menu is unchanged, so that test's menu lists hold.
- The launcher end-to-end test in `tests/studio-ui-alpha.test.mjs` (its expected host bases now include `luts`) was not
  run: it starts the launcher, which may open a browser window when the studio shell is not built.
- Live use: awaiting live test. Not done until used on a real stream with no high-severity feedback.

## Files

Created: `tools/make-realism-lut.mjs`, `data/luts/realism-filmic.cube`, `registry/presets/fx-realism-grade.json`,
`tests/realism-look.test.mjs`, `docs/evidence/2026-11-13-realism-look.md`.
Changed: `app/host/src/model.cpp`, `app/host/src/model.h`, `app/host/src/methods.cpp`, `app/host/lib/project.mjs`,
`app/studio/src/main_window.cpp`, `app/studio/src/main_window.h`, `data/flags.json`, `data/schemas/project.schema.json`,
`docs/plan/2026-10-29-v1-decisions.md` (D381), `registry/presets/fx-lut-look.json`, `services/project/structure.mjs`,
`services/project/validate.mjs`, `services/studio-ui/alpha.mjs`, `services/studio-ui/server.mjs`,
`tools/package/manifest.mjs`, `tests/package-alpha.test.mjs`, `tests/studio-ui-alpha.test.mjs`.
