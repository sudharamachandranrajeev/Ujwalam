# CLI data dir follows the installed app (2026-11-09)

## Cause
The installed app (run-installed.mjs) keeps event-core data in `%LOCALAPPDATA%\Ujwalam\data\core` (or
`UJWALAM_DATA_ROOT\core`) and passes it to the launcher with `--data-dir`. CLIs run from the repo called
`resolveDataDir`, which reads only `--data-dir`, then `paths.event_core_data` in `data/profile.local.json`
(a developer folder). So a flag switched on in the installed app's Settings (`flags.local.json` in the installed
core dir) read as off in `node services/posting/cli.mjs`.

## Fix
`services/event-core/config.mjs`: new `installedDataDir(env)`, `resolveCliDataDir(opts)`, `dataDirNote(r)`.
Order for user-facing CLIs: 1 `--data-dir`, 2 the installed app's core dir (only when it holds `flags.local.json`,
`event-core.db` or `pseudo.key`), 3 `paths.event_core_data`. Read-only: nothing is created, moved or changed.
`resolveDataDir` is unchanged (libraries, services, tests keep it).
Wired into: `services/posting/cli.mjs` (package, auto, youtube), `services/event-core/cli.mjs` (listen fixtures),
`services/event-core/audit/cli.mjs`, `tools/collect-stream-feedback.mjs`. Each prints
`data dir (installed app|profile): <path>` when the dir did not come from `--data-dir`.
Not changed: `services/studio-ui/cli.mjs` / `launch.mjs` (dev launcher; the installed run passes `--data-dir`),
`services/clip/clip_common.py` (Python, same profile rule; UNVERIFIED follow-up), host overlay child.

## Tests
`tests/cli-data-dir.test.mjs` (3): installedDataDir detection; order option > installed > profile > error;
posting CLI sees a flag on in the installed dir, prints the dir, and `--data-dir` still wins (flag off there).
Existing posting, event-core, audit, feedback tests: no regressions. One failure, `overlay server: counters.json
serves the latest counts only while the flag is on`, also fails on the untouched base.
