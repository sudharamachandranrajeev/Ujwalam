# LU2 data hot-reload (2026-11-10): PASS for the kinds below (theme pack: headless probe PASS)

Plan: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` (LU2, D324). Decisions: D328.

## What reloads while the app runs (also while live)

Each data file is read through one data source (`services/common/data-reload.mjs`): a change on disk is seen by a
directory watch (200 ms debounce, safe for editors and installers that save to a temp file and rename) with a 2 s
poll as a fallback, and by a stat check on read. A new version is parsed and schema-checked first. Valid: it applies at
once, without a restart. Invalid (bad JSON, a half-written file, a value out of range): the last good version stays in
use, the reason goes to the log (warn level) and to the studio task area as a task file `<dataDir>/tasks/data-<kind>.json`
("<Label> not applied: the file has a problem", with the reason in plain words). The fixed file clears the notice.
A file that is still being written (younger than 300 ms) is retried, not reported.

| Data kind | File | Owner (process) | Applies to |
|---|---|---|---|
| flags-local | `<dataDir>/flags.local.json` | studio UI server, overlay child | feature flags on/off (a broken file no longer resets every flag to its default) |
| flags-definitions | `data/flags.json` | studio UI server, overlay child | flag list and descriptions |
| posting-rules | `<dataDir>/posting/auto-post-rules.json` (or the shipped template) | studio UI server, auto-post chain | auto-post rules; with no good version at all it still fails closed |
| studio-tasks | `data/studio/tasks.json` | studio UI server | task panel stall threshold |
| guide-tour, guide-hints | `data/guide/tour.json`, `hints.json` | studio UI server | guide and hints |
| effect-guards | `data/effects/guards.json` | overlay child (overlay server guards) | effect budget, cooldowns, pools, regions, queue; plays in progress keep running |
| flash-measurements | `data/effects/flash-measurements.json` | overlay child | measured flash rates for the flash guard |
| theme pack | the pack in use in `data/themes/` (or `UJWALAM_THEMES_DIR`) | Qt studio | colours, type, geometry; broken pack keeps the last good look, warning in the studio log, notice in the task bar |

`GET /ui/api/data` lists each source of the UI server (kind, base name, ok, version, rejected reason); the overlay child
reports its sources in `overlay.stats` (`data`, plus a `guards` summary).

Not in scope: game packs (`data/games`) and the clip worker (another agent is changing them). Scene presets in
`registry/presets` are read when the alpha project is built at launch; there is no running consumer to reload them
into, so they are not live (open, LU3).

## Tests

```
UJWALAM_HEADLESS=1 node --test tests/data-reload.test.mjs tests/stream-day.test.mjs tests/live-soak.test.mjs
```

```
ℹ tests 24
ℹ pass 24
ℹ fail 0
ℹ skipped 0
```

`tests/data-reload.test.mjs` (10 tests): data source valid / invalid / fixed; a young file is not reported; a missing
file falls back; a rename-write is seen by the watch; the notifier task file; flags owner; posting rules owner; guards
`setConfig` and the overlay server `reloadGuards`; the UI server's `/ui/api/data`, tasks config and guide reload with a
notice; a staged overlay child (real process) applies a guards change, keeps the old one on a broken file, writes the
notice and logs no error-level line.

Related suites run after the change (flags, studio tasks, posting, effect guards, overlay, studio UI, guide, live
markers): 476 tests, 475 pass, 1 skipped, 0 fail.

## Under a running loopback stream

The live-soak gate (`npm run soak`, LU8, `docs/evidence/2026-11-10-lu8-live-soak-gate.md`) changes each kind above
except the theme while all four loopback streams and the recording run: valid change, broken file (half the file),
fixed file, each through a temp-file rename. Short run `2026-11-10-live-soak-short-1128`: all 8 kinds applied within
12-320 ms of the write (a full valid, broken, fixed cycle took 0.3-1.3 s), every broken file kept the last good version with its notice, every fix cleared it; no sink dropped a frame.
Render-lag numbers of that run are explained in the LU8 evidence (load outside the stack).

## Qt studio theme pack

`tests/studio-qt-theme-reload.test.mjs` runs the built studio headless (probe mode) against a temp theme folder:
valid accent change, half-written file, fixed file. Studio built into a separate build folder
(`UJWALAM_STUDIO_BUILD`, 4 build threads, BelowNormal):

```
✔ valid change applies live; broken file keeps the last good look and is reported; a fix applies again (9333 ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

Probe result: accent `#778899` (the fixed file), reloads 2, rejects 1, last reject names the JSON error; the studio log
has `warn: theme: lu-reload.json not applied, the last good look stays: ...`. (A GUI-subsystem Qt app sends warnings to
the debugger, not stderr, so the test reads the studio log file.)

## UNVERIFIED

- Theme reload seen in the visible studio window while a stream runs (the test is headless; the soak gate does not
  run the Qt studio).
- Real stream use: none yet (awaiting a live test).
