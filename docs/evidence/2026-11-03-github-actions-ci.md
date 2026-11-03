# GitHub Actions CI (D202), 2026-11-03

Plan item: `docs/plan/2026-11-01-ujwalam-alpha-live-testing-and-continuity.md` Part C section 4. Decision: D202.

## What was added

- `.github/workflows/ci.yml`: `windows-latest`; pushes to `claude/**` and pull requests to `master`; `permissions: contents: read`; concurrency group per ref with cancel-in-progress; `timeout-minutes: 30`; `actions/checkout@v4`, `actions/setup-node@v4` (node `22.x`); `npm ci`; `npm run ci` with `UJWALAM_CI_ENV=cloud` and `UJWALAM_HEADLESS=1`. No secrets, no artifact upload.
- `tools/ci.mjs`: `isCloud(env)` (`UJWALAM_CI_ENV=cloud` or `GITHUB_ACTIONS=true`), `LAPTOP_ONLY`, `planSteps`, `notRunLine`, `summaryLines` (pure, exported). In cloud mode the stamp block is never reached (`full` is false), and the summary says the run is not stampable.
- `tests/ci.test.mjs`: 6 new tests.

## What runs in the cloud

`lint`, `test`, `validate-outputs`, `validate-games`, `stray-mocks` (Node only, inputs are tracked files).

## NOT RUN in the cloud (`LAPTOP_ONLY`)

| Step | Reason |
|---|---|
| build | needs MSVC and the libobs spike build dir (`app/spike/build`) and OBS source tree |
| build-host | needs OBS runtime and source paths from `app/host/host.local.json` (vendored OBS, not in the repo) |
| test-host | starts the libobs host with NVENC; no GPU or OBS runtime |
| test-py | needs OCR venv packages (numpy, opencv, rapidocr, onnxruntime) |
| test-ocr | needs `.venv` |
| test-capture | needs a capture device and `.venv` |
| validate-registry | presets name `legacySource` files that must exist under `legacy/` (gitignored) |
| private-scan | needs `data/profile.local.json`; fails closed without it |
| legacy-verify | needs `legacy/` |
| bench | timings on a shared runner are meaningless; baselines are laptop-only |

Each is printed as `NOT RUN (laptop only: <reason>)`, counted apart, and never PASS. Exit status depends only on steps that ran.

## Cloud gaps (tests that FAIL, not skip, without laptop-only inputs)

Found by running a sample of the `test` step's files in this worktree, which has no `legacy/`, no `data/profile.local.json` and no `out/`:

- `tests/registry.test.mjs`: "real registry passes" and "base fixture passes" fail (`legacySource ... does not exist on disk`). The `test` step will therefore FAIL in the cloud until these are fixed (separate task; not changed here).
- Not every file of the `test` step was run; others may also fail. UNVERIFIED until the workflow runs on GitHub.

Sample run: 12 files (registry, effect-guards, g0-schemas, overlay-server, package-alpha, event-core-moderation x3, legacy-verify, report-button, lint, outputs/schema): 229 tests, 223 pass, 2 fail, 4 skipped.

## Laptop behaviour unchanged

Env unset: `planSteps(STEPS, false).run === STEPS` (same array, same order), `summaryLines` output identical to the old two lines, stamp block unchanged (`full = !cloud && steps === STEPS`). The existing step-list test and the stamp tests pass unchanged; no test was changed to skip.

```
UJWALAM_HEADLESS=1 node --test --test-timeout=300000 tests/ci.test.mjs
ℹ tests 20  ℹ pass 19  ℹ fail 0  ℹ skipped 1
```

The one skip existed before ("build step recompiles a touched source": `app/spike/build is not configured`, this worktree has no build dir).

Cloud dry run (no heavy steps):

```
UJWALAM_CI_ENV=cloud node tools/ci.mjs --only build,private-scan,legacy-verify,validate-outputs,validate-games
build              NOT RUN (laptop only: ...)
private-scan       NOT RUN (laptop only: ...)
legacy-verify      NOT RUN (laptop only: ...)
validate-outputs   PASS
validate-games     PASS
ci: 2/2 passed
ci: cloud mode: 3 step(s) NOT RUN (laptop only): build, private-scan, legacy-verify
ci: cloud run is not stampable (only a full laptop pass may stamp a push, D190)
```

## UNVERIFIED

- The workflow has never run on GitHub.
- Action versions are major tags (`@v4`), not commit SHAs: SHA pinning is UNVERIFIED (no network lookup was possible); pin before relying on it for supply-chain safety.
- `windows-latest` Node `22.x` against the repo's tested 26.12.1: UNVERIFIED.
- Windows minutes on a private repo count at 2x against the account's included minutes. This change enables no paid usage.
- The private repo and its first push (user approval, full-history scan) do not exist yet; the workflow does nothing until then.

## Files

Created: `.github/workflows/ci.yml`, `docs/evidence/2026-11-03-github-actions-ci.md`. Changed: `tools/ci.mjs`, `tests/ci.test.mjs`, `docs/plan/2026-10-29-v1-decisions.md` (D202).

## Main-session review (2026-11-03)

Merged into `claude/alpha0-d1`. The trigger is `workflow_dispatch` only until the cloud `test` step passes: two `tests/registry.test.mjs` cases fail without `legacy/`, other test files are unchecked. Push/PR triggers are switched on after one green manual run, so pushes do not spend runner minutes on a known red job.
