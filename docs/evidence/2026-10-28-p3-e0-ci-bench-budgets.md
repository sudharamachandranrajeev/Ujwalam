# P3 E0: performance budgets, lint, CI script, benchmark harness (2026-10-28)

Result: **PASS.** Includes the follow-ups approved on 2026-10-28 (bench calibration, noisy-run handling, guarded lint markers, user-name ban, real rebuild test). Final `npm run lint`, `npm test` and `npm run ci` output is in the sections below.

Machine (from the bench run record): 12th Gen Intel Core i7-12650H, 16 logical cores, 31.6 GB RAM, Windows 11 Pro 10.0.26200, node v26.12.1, python 3.14.7, AC power.

## What was built

| Item | File |
|---|---|
| Budgets (16 rows, all UNVERIFIED) and the live path rule | `docs/architecture/performance-budgets.md` |
| Lint: 7 rules plus the marker guard, importable (`lint`, `lintReport`) | `tools/lint.mjs`, `npm run lint` |
| CI runner: 12 steps, `--only`, `--list` | `tools/ci.mjs`, `npm run ci` |
| Pre-commit: private scan first (same behaviour), then CI | `tools/git-hooks/pre-commit` |
| Bench harness, calibration, noisy-run handling, accept path, two real benches | `tools/bench/run.mjs`, `tools/bench/benches/*.mjs`, `npm run bench` |
| Per-commit record, never fails a commit | `tools/bench/record-commit.mjs`, `tools/git-hooks/post-commit` |
| Tests | `tests/lint.test.mjs`, `tests/ci.test.mjs`, `tests/bench.test.mjs` |
| `engines.node` `>=22.13` (UNVERIFIED) | `package.json` |
| Optional profile key `paths.windows_user` (placeholder) | `data/profile.example.json` |

## Lint

Scope: `git ls-files` plus untracked-not-ignored files, so `legacy/`, `out/`, `node_modules/` and `app/spike/build/` are never linted. Binary files per `.gitattributes` and any file with a NUL byte are skipped.

Line endings: `core.autocrlf` is `true` on this machine, but `.gitattributes` sets `eol=lf` for `*` and `eol=crlf` for `.cmd/.bat/.ps1`. With an explicit `eol` attribute git ignores `autocrlf`, so the working tree matches the attribute (`git ls-files --eol` showed `w/lf` for every text file). Lint checks the working-tree bytes against the attribute. With no `eol` attribute for a file, either ending passes and only mixed endings are flagged.

SPDX placement, derived from the files that already pass: header in the first 3 lines after an optional shebang, doctype or xml prolog. Extensionless hooks, `.txt` (except `CMakeLists.txt`), `.md`, `.json` are exempt.

### Allow markers (follow-up 3)

- A marker must name a known rule. A bare marker, an unknown rule id, or a rule that does not support markers (only `secret` and `user-path` do) is a finding of rule `lint-allow`.
- The `secret` marker is honoured only in test files (path under `tests/`). Elsewhere it is a `lint-allow` finding and the secret check still applies.
- Every marker found is listed on every run, pass or fail, as `lint-allow in use: path:line: rule`.

### User name ban (follow-up 4)

- The machine user name is never allowed in a path (`C:\Users\<name>`, doubled backslashes, forward slashes, `/Users/`, `/home/`, `/c/Users/`), case-insensitively, with or without a marker, and it is not in the placeholder list. The finding message never contains the name.
- Sources: `data/profile.local.json` key `paths.windows_user` (or a top-level `windowsUser`), the OS user from `os.userInfo()`, and injected names for tests.
- Outcome of the key check: `data/profile.local.json` has no field for a Windows user name (keys checked, values not printed; keys are `streamer`, `channels`, `games`, `paths.clips_corpus`, `private_terms`). I added an optional key `paths.windows_user` with the placeholder `<windows-user>` to `data/profile.example.json`. It sits under `paths` because `data/profile.schema.json` allows any string there; the top level is closed, so a new top-level key would have needed a schema edit. I did not edit `data/profile.local.json`. Until the user adds the key, the OS user name still protects the repo. The hooks already treat every string in the local profile as a private term, so setting the key also adds the name to the commit scan.
- Tests use an invented name and a temp profile; the real name is compared only in memory.

### Final lint output

```
$ npm run lint
lint-allow in use: tests/g0-schemas.test.mjs:273: user-path
lint: 0 finding(s), 1 allow marker(s), in 0.7s
```

(Exit code 0. The one marker is the one the user added to the g0 schema test fixture.)

## Benchmarks

### Calibration (follow-up 1)

`npm run bench -- --calibrate` runs each bench once as warm-up and then 10 times, computes the sample standard deviation per metric, and stores `minDelta = 3 x stddev` in `out/bench/calibration.json`. The harness reads that file; the `minDelta` in the bench module (30 ms and 80 ms) is the fallback when no calibration exists.

```
$ npm run bench -- --calibrate
bench: calibrated private-scan-worktree-wall.wall_ms: n=10 mean=847.872 stddev=8.285 minDelta=24.855 ms
bench: calibrated registry-validate-wall.wall_ms: n=10 mean=153.922 stddev=3.537 minDelta=10.610 ms
```

| bench.metric | n | mean (ms) | stddev (ms) | minDelta (ms) | fallback (ms) |
|---|---|---|---|---|---|
| private-scan-worktree-wall.wall_ms | 10 | 847.872 | 8.285 | 24.855 | 80 |
| registry-validate-wall.wall_ms | 10 | 153.922 | 3.537 | 10.610 | 30 |

Calibration ran on AC power with a quiet machine (it refuses otherwise). It was run once; UNVERIFIED: stability across days or loads. `out/bench/` is gitignored, so calibration is per machine.

### Noisy runs (follow-up 2)

Each run records `noise` (power state, system CPU % before start from a 1 s `os.cpus()` delta, and the system average over the whole run). A run is `noisy: true`, with reasons, when:

| condition | threshold (proposed) |
|---|---|
| power state | on battery |
| system CPU load before start | above 25 % |
| system CPU load averaged over the run | above 50 % (higher because the bench itself uses some CPU) |

A noisy run is written to `out/bench/runs/` but never becomes the baseline (`last-pass.json` untouched, also when no baseline exists), never flags a regression (the would-be regressions are printed as warnings, exit 0), cannot be accepted (`--accept` exits 2), and `--calibrate` refuses to run. Power state `unknown` (no powershell, or a non-Windows host) is not treated as noisy.

### Baseline runs

```
$ npm run bench        (first run, before calibration existed)
bench: private-scan-worktree-wall.wall_ms = 842.42 ms
bench: registry-validate-wall.wall_ms = 154.32 ms
bench: first run, baseline set
bench: PASS
$ npm run bench        (second run)
bench: private-scan-worktree-wall.wall_ms = 837.40 ms
bench: registry-validate-wall.wall_ms = 151.47 ms
bench: PASS
```

The injected-slowdown proof is in `tests/bench.test.mjs` (fixture 40 ms to 60 ms: flagged, exit 1, baseline unchanged; 42 ms passes; higher-is-better drop of 30 % flagged, 5 % not).

## Real rebuild proof (follow-up 5)

`tests/ci.test.mjs` touches the mtime of `app/spike/src/scenes.cpp` (no content change), runs the build step, and checks that exactly that file was recompiled, then that a second build does nothing. Only gitignored build outputs change. It is skipped if `app/spike/build` is not configured. A manual run of the same sequence:

```
--- build 1 (scenes.cpp touched)
[1/2] Building CXX object CMakeFiles\ujwalam-spike.dir\src\scenes.cpp.obj
[2/2] Linking CXX executable ujwalam-spike.exe
--- build 2
ninja: no work to do.
```

(The build runs inside `vcvars64.bat`; it prints a harmless "'vswhere.exe' is not recognized" line from the batch file. It does not affect the result.)

## Tests

```
$ npm test
ℹ tests 282
ℹ pass 282
ℹ fail 0
ℹ skipped 0
```

New in E0: lint 23, ci 11, bench 20 (54 in total). Before E0 the suite had 228.

## Full CI

## Verified

- Lint rules and marker guard: tests per rule, including the secret marker inside and outside `tests/`, bare, unknown and unsupported markers, the marker list, the user-name ban in every path form, profile and injected sources (`tests/lint.test.mjs`).
- CI: step order and names, `--only`, `--list`, failure propagation, missing build dir, missing `.venv`, real incremental rebuild (`tests/ci.test.mjs`).
- Bench: median, first run, 10 % regression on both directions, calibration maths and use, noisy runs for each of battery, CPU before, CPU during (no baseline, no flag, accept refused, calibration refused), CLI exit codes, record-commit, post-commit helper and `sh` hook exit 0 (`tests/bench.test.mjs`).
- Real runs of lint, tests, calibration, benches, rebuild and full CI.

## UNVERIFIED

- The hooks were not run by a real `git commit` (no commit allowed). The post-commit hook was run through `sh` against a temp folder. Full CI takes about 2 minutes, so each commit will be slow.
- Noise probes with real data: the real power probe and CPU sampling ran only in quiet conditions. The noisy paths are tested with injected probes. UNVERIFIED: the real battery detection (`Win32_Battery` status 1) on this laptop while unplugged.
- Whether the thresholds (25 % before, 50 % during) are right for this machine under typical background load.
- Calibration stability over days.
- `engines.node >=22.13` as the first version with unflagged `node:sqlite`: UNVERIFIED, tested only on 26.12.1.
- The budget measurement tools named in the budgets table are intended counters; none is measured yet.

## Files created or changed

Created:

- `docs/architecture/performance-budgets.md`
- `docs/evidence/2026-10-28-p3-e0-ci-bench-budgets.md`
- `tools/lint.mjs`
- `tools/ci.mjs`
- `tools/bench/run.mjs`
- `tools/bench/record-commit.mjs`
- `tools/bench/benches/registry-validate.mjs`
- `tools/bench/benches/private-scan.mjs`
- `tools/git-hooks/post-commit`
- `tests/lint.test.mjs`
- `tests/ci.test.mjs`
- `tests/bench.test.mjs`

Changed:

- `package.json` (scripts `lint`, `ci`, `bench`; `engines.node` `>=22.13`)
- `tools/git-hooks/pre-commit` (private scan, then `node tools/ci.mjs`)
- `data/profile.example.json` (optional `paths.windows_user`, placeholder)

Untouched by request: `tests/g0-schemas.test.mjs` (the user's marker edit), `legacy/`, `data/profile.local.json`.

## Final CI run

```
$ npm run ci
build              PASS  1.4s
lint               PASS  1.0s
test               PASS  29.0s
test-py            PASS  3.9s
test-ocr           PASS  11.0s
test-capture       PASS  71.9s
validate-registry  PASS  0.4s
validate-outputs   PASS  0.3s
validate-games     PASS  0.4s
private-scan       PASS  0.9s
legacy-verify      PASS  0.4s
bench              PASS  7.7s

ci: 12/12 passed in 128.4s
```
