# 2026-11-06 — P5a inspector, Qt studio shell, embedded previews

Result: **PASS** for the web inspector (server side), the Qt shell skeleton (headless smoke) and the launcher
`--shell qt` spawn spec. **BLOCKED** for the host side (`layers.setPlacement`, `preview.open` with `parent`): the
host compiles, but the link waits for the practice recording studio to stop (LNK1168, the exe is in use). Embedded
previews and the visible shell window: **UNVERIFIED** (no runtime run yet).

Plan: `docs/plan/2026-11-06-p5a-qt-shell-plan.md`. Decisions: D219 (window rule), D220 (Qt shell design, Qt 6.8.3 via
aqtinstall into `_vendor`).

## Commands and output

```sh
npm run build:studio
```

```text
built C:\AI\Claude\Ujwalam\out\studio\build\ujwalam-studio.exe
```

```sh
node --test tests/studio-ui-server.test.mjs tests/studio-ui-alpha.test.mjs tests/studio-qt-shell.test.mjs
```

```text
ℹ tests 52
ℹ pass 52
ℹ fail 0
ℹ skipped 0
```

The Qt shell suite on its own (3 tests): headless login + `scenes.list` through the UI server against the fake host
("studio smoke: ok, N scene(s)"), the launch key works once only (second login exits 77), a non-loopback UI URL is
refused (exit 64).

```sh
npm run lint
```

```text
lint: 0 finding(s), 31 allow marker(s), in 12.4s
```

## What was checked

- UI server: `layers.setPlacement` is in the host-call allowlist with a nested `placement` schema (x, y, width,
  height, rotation, crop l/t/r/b, ranges enforced); bad placements get 400 before reaching the host. `preview.open`
  accepts `parent` only as a non-zero decimal handle string, with x/y/width/height in range.
- Fake host: `layers.setPlacement` merges a partial patch (web page inspector tests run against it).
- Launcher: `shellSpawnSpec` puts the Qt bin first on PATH, passes the UI URL and one-time key in the environment
  only, and strips every `UJWALAM_*TOKEN` / `*KEY` variable from the shell's environment.
- Qt shell: builds with Qt 6.8.3 MSVC2022 x64, /W4; logs in with the one-time key, CSRF on every POST; 127.0.0.1-only
  base URL.

## Not checked yet

- Host tests for `layers.setPlacement` (partial patch, refused patches leave the placement unchanged) in
  `app/host/tests/host-project.test.mjs`: written, BLOCKED on the relink.
- Embedded previews (cross-process child HWND inside the shell's H/V slots): UNVERIFIED, needs a runtime run of
  `npm run alpha -- --shell qt`.
- The visible shell window (layout, second-display placement, no focus steal, D219): UNVERIFIED.
- Layer edits are not yet saved to the project file (P5b autosave).
- Live use: awaiting live test.
