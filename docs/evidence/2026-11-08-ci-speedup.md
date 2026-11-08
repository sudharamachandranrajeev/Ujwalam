# 2026-11-08 Faster full CI (D276) and Qt shell by default (D277)

Status: test evidence. The full-CI wall time after the change is recorded below from the first full run.

## CI speed-up (D276)
Before (full CI on 4c46a87, 15/15 pass): 735 s. Largest steps: test-host 422 s, bench 97 s, test 85 s,
test-capture 72 s, test-py 19 s, test-ocr 10 s.

1. Host suite files run two at a time (`--test-concurrency=2` in `test:host`). Measured alone:
   `node --test --test-timeout=300000 --test-concurrency=2 "app/host/tests/*.test.mjs"`: 108 tests, 108 pass,
   215 s (was 422 s at concurrency 1). One run so far: a flaky host test under this load is watched in later runs
   and the concurrency goes back to 1 if it appears.
2. Side lanes in `tools/ci.mjs`: a step with `alongside: 'test-host'` runs while test-host runs (one after another
   in its lane); the next main step waits for the anchor and its lane. Beside test-host: test-py, test-ocr,
   validate-registry, validate-outputs, validate-games, private-scan, legacy-verify (CPU only). bench, test and
   test-capture (NVENC) still run alone. Summary time is wall time.

Test: `node --test tests/ci.test.mjs`: 22 pass (new: side lanes start beside the anchor, run in order, the next
main step waits, results in canonical order, a step whose anchor is not selected runs on the main lane).

## Qt shell by default (D277)
`shellChoice(args)`: no `--shell` -> `qt`, `--shell browser` -> web page, anything else -> exit 2.
The alpha zip (0.1.0-alpha.3) ships the studio self-contained in `studio/`: `ujwalam-studio.exe`, the Qt 6.8.3 kit
DLLs it imports (Core, Gui, Widgets, Network) and `platforms/qwindows.dll` + `platforms/qoffscreen.dll`.
First try used the OBS runtime's Qt (also 6.8.3.0, but OBS's own build): the exe hung at start in headless mode,
because that runtime has no `qoffscreen` plugin (Qt waits on a "no platform plugin" box). The OBS Qt is no longer
used for the studio. `studioShellPaths` picks the dev build, else `<root>/studio/ujwalam-studio.exe`.
Tests:
- `node --test tests/studio-ui-alpha.test.mjs tests/package-alpha.test.mjs`: 41 pass.
- Packaged exe from the unzipped `out/dist/ujwalam-0.1.0-alpha.3-win64.zip`, no Qt on PATH:
  `UJWALAM_STUDIO_TEST_EXE=<unzipped>/studio/ujwalam-studio.exe node --test tests/studio-qt-shell.test.mjs`:
  6 pass, 0 skipped (probe, panels, click actions against a UI server with the fake host).
- The real (non-headless) window from the installed build is UNVERIFIED until the user opens it.

## Files
- `tools/ci.mjs`, `package.json` (`test:host`), `tests/ci.test.mjs`
- `services/studio-ui/launch.mjs`, `tests/studio-ui-alpha.test.mjs`, `tests/studio-qt-shell.test.mjs` (`UJWALAM_STUDIO_TEST_EXE`)
- `data/release/alpha.json`, `data/release/CHANGELOG-alpha.md` (alpha.3)
- `tools/package/build-alpha.mjs`, `tools/package/manifest.mjs`, `tests/package-alpha.test.mjs`, `docs/how-to.md`
- `docs/plan/2026-10-29-v1-decisions.md` (D276, D277), this file
