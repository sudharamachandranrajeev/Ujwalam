# 2026-11-11 LU5 and LU7 host staging, one-click live updates, versions on the control page

Branch `lu/host-staging` (on LU3). Plan rows LU5 and LU7 (D324), LU1 part hashes; decision D343. Status: **queue,
host staging, click gate, flag-defaults test and control-page view done and tested with the fake host and staged
fixture releases in temp folders; the Qt studio status line, a loopback-stream run and a built alpha with part hashes
are UNVERIFIED** (see below). Behind the flag `service-swap` (reused, off by default; D343 says why).

## What it does

- **Update queue** (`services/supervisor/updates.mjs`, `createUpdates`): every update request goes through it. Before
  each apply it reads a fresh `outputs.status`. Busy = any stream or recording sink in starting, live, reconnecting,
  retrying or stopping; an unreadable status is busy; no host is not busy.
- **Host (LU5)**: a host update (or an overlay-server update, which follows the host) that arrives while busy is
  **staged**: `<data>/live/host-update.json` state `staged`, and a waiting item. It is never applied while busy, not even
  on a click. The queue polls; at the first status with everything stopped (the user's Stop, D334 rule) the launcher
  revokes the go-live authority, checks a fresh status once more (a stream started in between sends the update back to
  waiting), stops the old host (`host.shutdown`, then the tree), starts the new one from the release layout
  (`bin/ujwalam-host.exe`, `obs/`, `app/host/overlay/child.mjs`), waits for it to be ready and loads the project. A host
  that does not get ready is rolled back to the previous host (`restored-old`). A planned restart is not a crash.
- **Close with a staged host update**: the update stays in `host-update.json`; the close log says so; the next start
  uses that release while its `n` is newer than the installed one (a dev checkout counts as 0). Waiting service updates
  are dropped at the close and logged.
- **Services while live (LU7)**: a service update while busy waits for **one click** (control page "Apply now" or the
  studio). No typed phrase, no "are you sure" (D332). When nothing is live it applies at once; at the stop the queue
  applies waiting services itself.
- **Who can trigger**: only the launcher's parent (IPC `ujwalam-swap`, LU6's installer) and the user's click (UI
  server, session + origin + CSRF, IPC `ujwalam-update`). The event core (chat, rules, LAN remote) and agents have no
  channel to it.
- **Visible (LU7)**: `<data>/live/updates.json` mirrors versions per part, waiting items and recent results. The UI
  server returns it in the status snapshot and at `GET /ui/api/updates`; `POST /ui/api/updates/apply` is the click. The
  control page shows an Updates section (parts and versions, waiting rows with "Apply now" or "Waiting for stop") and a
  pill "Updates waiting: N".
- **LU1**: `tools/package/parts.mjs` maps each packaged file to a part (host, studio-window, services, overlay, data);
  `build-alpha.mjs` writes `parts` hashes into `release.json`; a host update with an unchanged host part is `unchanged`.
- **Fixes found on the way**: `services/supervisor` was missing from the package (`tools/package/manifest.mjs`), so an
  LU3 build failed its import check; `updates.json` writes retry a refused rename on Windows (the UI server may hold the
  file open for a read); the swap reply kept the request's `id` (the queue item id is now `item`).

## Tests (run 2026-11-11, one file at a time, `--test-timeout=60000`)

| Suite | Result |
|---|---|
| `tests/live-updates.test.mjs` (new) | tests 15, pass 15, fail 0 |
| `tests/live-updates-launcher.test.mjs` (new, real launcher + fake host) | tests 3, pass 3, fail 0 (3 runs in a row) |
| `tests/service-swap-launcher.test.mjs` | tests 4, pass 4, fail 0 |
| `tests/service-swap-ui-worker.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/studio-ui-crash-recovery.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/stream-recovery.test.mjs` | tests 17, pass 17, fail 0 |
| `tests/studio-ui-server.test.mjs` | tests 40, pass 40, fail 0 |
| `tests/flags.test.mjs` | tests 7, pass 7, fail 0 |
| `tests/studio-ui-layer-remove.test.mjs` | tests 3, pass 3, fail 0 |
| `tests/studio-ui-nudge.test.mjs` | tests 3, pass 3, fail 0 |
| `tests/package-alpha.test.mjs` | tests 18, pass 15, fail 0, skipped 3 (existing skips) |

Command form: `node --test --test-timeout=60000 tests/<suite>.test.mjs`. Lint: `node tools/lint.mjs` -> `lint: 0
finding(s)`.

`tests/live-updates.test.mjs` covers:

- busy rule (each sink state; unreadable status is busy)
- hostEntry: package layout, release.json hash, stand-in script only for a stand-in host
- host update while live: staged, not applied while busy (not even on a click), applied after the stop
- overlay server alone = host update; not busy applies at once; a newer host update replaces the waiting one
- refusals: bad hash, no host, unchanged host part, unknown service, flag off, closing
- click gate: a service update while live waits for one click; not busy applies at once
- close keeps a staged host update for the next start; waiting services dropped; next start uses it until installed
- a failed host apply keeps the previous applied release for the next start
- readUpdatesStatus: this session only, plain fields
- IPC round trip UI server -> launcher; bad requests refused
- server: versions and waiting items in the status; one click POST applies; GET cannot; no session cannot
- page (vm): parts list, waiting rows, "Apply now" click calls the API once, pill, note
- LU1: every packaged file has a part; changed parts detected
- **flag defaults**: every flag added since 2026-11-10 is off by default, and every flag has a since date
- a stream started between the check and the restart sends the host update back to waiting

`tests/live-updates-launcher.test.mjs` (the Done-when proof for LU5):

- the fake host records ("live"); a host update from a staged fixture release arrives over IPC -> `staged`; an
  event-core update -> `waiting` (click); 1.5 s of queue polls do not touch the host; the user's Stop (the fake host
  stops the recording) -> the host restarts from `<release>/bin`, after the `stopped-by-user` record; host and overlay
  server show the new version; no crash lines; no token-shaped value in the log
- close with a staged host update -> logged as waiting for the next start; the next launch starts from the staged release
- a broken host release is rolled back to the previous host; nothing kept for the next start

## UNVERIFIED

- The Qt studio window does not show the update status yet (needs C++; not built in this task). The control page does.
- No loopback-stream run of a host update at the stop (only the fake host).
- LU1 part hashes are not yet in a built alpha zip (`build-alpha` not run; unit-tested only).
- Worker services (clip worker, live-AI) are still refused by the launcher (slots exist, not wired).
- Nothing here was used on a real stream.

## Files

- New: `services/supervisor/updates.mjs`, `tools/package/parts.mjs`, `tests/live-updates.test.mjs`,
  `tests/live-updates-launcher.test.mjs`, this file.
- Changed: `services/studio-ui/launch.mjs`, `services/studio-ui/server.mjs`, `ui/index.html`, `ui/js/api.js`,
  `ui/js/app.js`, `tools/package/build-alpha.mjs`, `tools/package/manifest.mjs`, `data/flags.json`,
  `tests/fixtures/studio-ui/fake-host.mjs`, `docs/plan/2026-10-29-v1-decisions.md` (D343).
