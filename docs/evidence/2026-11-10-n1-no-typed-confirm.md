# 2026-11-10 N1 no typed confirmation, N2 Settings > Advanced switches (D332)

Branch `ui/no-typed-confirm` (from `claude/alpha0-d1` at 8245b16). User decision, 2026-11-10: "No text type
anywhere." "No misclick guard, end stream means end stream." "All clicks will be made by user's decision."
Decision record: D332 in `docs/plan/2026-10-29-v1-decisions.md`.

Status: tests and headless probes only. Not yet used on a real stream (UNVERIFIED live).

## What changed

- **Live-lock gate** (`services/event-core/livelock/gate.mjs`, `index.mjs`, `api/methods.mjs`): a write from ui or
  api runs at once (audit reason `ui-direct`). A write from rule, remote or system gets one pending confirmation with
  no phrase, which only a ui or api click can confirm. The two-step flow is gone; `panic.clear` is a direct click.
- **Control page server** (`services/studio-ui/server.mjs` and routes): stream, recording, output toggles, End all,
  bots, flags, connections, project load and YouTube upload act on the click through one path (`runAction`). That
  path keeps the closing lock, the stop-wins epoch with stop-again, the go-live authority revoke, credential-write
  serialisation and the readiness override log. A failed readiness check returns `verdict: 'readiness-failed'` with
  the problems and a pending entry for one "Go live anyway" click (`{ pendingId }` only). Readiness and audio warnings
  come back in the answer's `warning` text and do not stop the start. `OVERRIDE_PHRASE` and `UPLOAD_PHRASE` are gone.
- **Control page** (`ui/`): no phrase inputs. The one confirm window is used only for "Go live anyway" and for a
  rule/remote/system approval ("Allow").
- **Qt studio** (`app/studio/src/`): no typed phrase and no "are you sure" (close while live, Stop all from the tray,
  delete scene / layer / output, bots, connections, YouTube upload). Settings keeps a draft across all pages, flags
  included; Cancel, Escape or X with edits asks Save changes / Discard / Cancel (keeps edits, not an action guard).
- **N2 Settings > Advanced**: one row per flag, a switch showing ON / OFF in words, the flag name, the description
  from `data/flags.json` (word-wrapped, always visible), in a scroll area, built fresh inside the dialog. Clips and
  Layer effects are switch rows too.
- **Docs**: AGENTS.md rule replaced and the Live stream testing parenthetical removed; D332; help panel text.

## Protections kept (proved by the adapted tests)

| Protection | Test file(s) |
|---|---|
| Chat can never write or confirm; taint forces the confirmation path and a tainted click cannot confirm | event-core-livelock, -matrix, -attack-e4b, -review |
| Rule, remote and system writes wait for one ui/api click | event-core-livelock-matrix, -dryrun-twostep, -api |
| Replay (single-use ids), expiry, action hash, live-epoch re-check refused | event-core-livelock-attack-e4b, -review, -dryrun-twostep, studio-ui-server |
| Panic blocks writes | event-core-livelock, -failclosed |
| Closing lock refuses starts after a quit grant | studio-ui-quit-lock |
| End all / Stop beats a start on its way to the host (stop-again) | studio-ui-stream-settings, stream-recovery |
| Failed readiness never starts without the "Go live anyway" click; override logged (ids only) | studio-ui-readiness |
| Credential writes and starts never overlap | studio-ui-connect |

## Commands and results

All with `UJWALAM_HEADLESS=1`, one file at a time (`node --test --test-timeout=90000 <file>`).

Run 2026-11-10 after the merge of `claude/alpha0-d1` (BG1, alpha.22) into this branch:

- Qt studio: `tests/studio-qt-shell.test.mjs`, `tests/studio-qt-d327.test.mjs`, `tests/studio-qt-themes.test.mjs`
  (`--test-timeout=120000`): 88 tests, 87 pass, 1 fail. The failure: after Save switched flag `transitions` on, the
  main window's Transitions panel stayed hidden until a later flag reload (`setFlag` only polled status). Fixed: a
  successful flag change reloads the flag list at once (`MainWindow::setFlag`). Re-run of the Settings tests: 11/11.
- Studio UI server: `studio-ui-readiness`, `studio-ui-server`, `stream-recovery`, `studio-ui-quit-lock`: 91/91, with
  the new stop-wins test below.
- Host (real ujwalam-host.exe): `host-output-toggle`, `host-stream-recovery`, `host-studio-launch` (concurrency 1):
  9/9.

Codex review (second model family, medium effort, diff only, no commands): one finding, P1, fixed.
- A Start waiting on the go-live readiness check could still go live after a later Stop / End all: the stop
  generation was read only after the readiness and audio checks. Fix (`services/studio-ui/server.mjs`): the generation
  (stopEpoch, and the launcher's authority generation) is taken when the Start click arrives and carried into
  `runAction`; a "Go live anyway" click on a pending entry takes a fresh one. Test `stop wins (Codex review of D332)`
  in `tests/studio-ui-readiness.test.mjs`: Start, Stop while the readiness check is held, release: refused
  `stopped-meanwhile`, no `stream.start` reaches the host. It fails on the code before the fix (0/1) and passes after.

## Grep: no typed-phrase UI left

```
grep -rn "QInputDialog\|confirm-input\|post-yt-confirm\|OVERRIDE_PHRASE\|UPLOAD_PHRASE\|yes, on air\|yes, upload\|go live anyway\|typed phrase\|Type yes" \
  app/studio/src ui services/studio-ui services/event-core app/host/src app/host/lib
```

Remaining hits, none of them a typed confirmation:
- `QInputDialog` in `main_window.cpp` and `connections_page.cpp`: name entry (Add scene, Rename layer / scene), the
  Report a problem text, and the YouTube stream picker. The user types a name or report, not a confirmation.
- Comments that say "no typed phrase" (`server.mjs`, `gate.mjs`, `ui/js/app.js`, `main_window.cpp`).
- `services/event-core/audit/cli.mjs`: "Type yes to continue" in the terminal-only raw-chat purge CLI. Developer tool,
  not app UI; left as is (see D332 "Not changed").

## UNVERIFIED

- Host tests `app/host/tests/host-output-toggle`, `host-stream-recovery`, `host-studio-launch` were adapted
  (syntax-checked with `node --check`) but not run: they need the built host, the OBS runtime and ffmpeg.
- No real stream yet.
