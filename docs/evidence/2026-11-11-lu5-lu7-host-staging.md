# 2026-11-11 LU5 and LU7 host staging, one-click live updates, versions on the control page

Branch `lu/host-staging` (on LU3). Plan rows LU5 and LU7 (D324), LU1 part hashes; decision D343, updated after the
Codex review (3 P1, 3 P2, all fixed below) and the Codex re-review (finding 2 completed; new A, B and C fixed). Status: **queue, maintenance lock, release integrity, startup trial, click
gate, flag-defaults test and control-page view done and tested with the fake host, staged fixture releases and real
service swaps, all in temp folders; the Qt studio status line, a loopback-stream run and a built alpha with part
hashes are UNVERIFIED** (see below). Behind the flag `service-swap` (reused, off by default; D343 says why).

## What it does

- **Update queue** (`services/supervisor/updates.mjs`, `createUpdates`): every update request goes through it. Before
  each apply it reads a fresh `outputs.status`. Busy = any stream or recording sink in starting, live, reconnecting,
  retrying or stopping; an unreadable status is busy; no host is not busy.
- **Host (LU5)**: a host update (or an overlay-server update, which follows the host) that arrives while busy is
  **staged** (`host-update.json` `pending`, and a waiting item). It is never applied while busy, not even on a click. At
  the first status with everything stopped (the user's Stop, D334 rule) the launcher applies it: maintenance lock,
  authority revoke, last status, confirmed stop of the old host, start of the new one from its checked copy, ready and
  project loaded, else the previous host again (`restored-old`). A planned restart is not a crash.
- **Maintenance lock (P1-1)**: every `stream.start` / `record.start` the UI server sends to the host takes a launcher
  lease first (`gateStarts` in `services/studio-ui/server.mjs`, `createStartGate` in updates.mjs, ops `lease` /
  `release` on the authority channel in `services/studio-ui/stream-recovery.mjs`). The launcher holds the gate BEFORE
  the last status check: new starts are refused at once (`HOST_UPDATING`), starts on their way are awaited (15 s, else
  the update goes back to waiting). Held until the replacement or the rollback is done. No launcher answer: refused.
  Re-review A: a grant that arrives after its request timed out is given back at once (request ids); a release with no
  answer is retried while the link is up. Active leases never expire on their own.
- **Integrity (P1-2)**: release.json must give version, `n` >= 1 and the LU1 hash of each part used (the host also
  `hostExeSha256`). The whole part is hashed (host: exe, OBS runtime, overlay child, projects; services: services, data,
  overlay), copied to `<dataDir>/live/releases/<kind>-<n>-<hash>` and hashed again; it runs only from the copy. The
  host copy is checked again right before it starts and at every start that uses it. `parts.mjs` moved to
  `services/supervisor/` (it ships; tools/package does not). Re-review 2: the copied files are read-only, and the host
  copy is hashed again after the old host has exited, right before the spawn (and right before each startup
  candidate's spawn). Re-review C: release.json is read once; the copy carries that snapshot, and the unchanged and
  freshness checks use the prepared entry. Full immutability against a writer with the user's rights is out of scope
  (D343).
- **Start trial (P1-3)**: `host-update.json` v2 keeps `pending`, `good` (last host that got ready and loaded the
  project) and `rejected`. The next start tries pending, then good, then the installed host. A try that does not get
  ready or does not load the project is stopped (exit confirmed), rejected for good, and the next one starts.
  Re-review B: only the candidate's own failure rejects it; an aborted replacement (the old host did not exit) keeps it
  pending and retries it at the next poll.
- **Order (P2-4)**: an update not newer than the running or a waiting release of its part is refused; a same-part
  waiting item is dropped before a newer one applies or queues.
- **Services while live (LU7, P2-5)**: a service update while busy waits for **one click** (control page "Apply now"
  or the studio). No typed phrase, no "are you sure" (D332). Nothing else applies it: not the poll, not the stop
  (reversed after the review). Not live: the request applies at once. Closing drops it (logged).
- **Confirmed exit (P2-6)**: `stopHostChild` (launch.mjs) returns true only after the exit event; a host still running
  after `host.shutdown` and the kill aborts the update with its state in the reason, and nothing else is started.
- **Who can trigger**: only the launcher's parent (IPC `ujwalam-swap`, LU6's installer) and the user's click (UI
  server, session + origin + CSRF, IPC `ujwalam-update`). The event core (chat, rules, LAN remote) and agents have no
  channel to it.
- **Visible (LU7)**: `<data>/live/updates.json` mirrors versions per part, waiting items and recent results. The UI
  server returns it in the status snapshot and at `GET /ui/api/updates`; `POST /ui/api/updates/apply` is the click. The
  control page shows an Updates section (parts and versions, waiting rows with "Apply now" or "Waiting for stop") and a
  pill "Updates waiting: N".
- **LU1**: `services/supervisor/parts.mjs` maps each packaged file to a part; `build-alpha.mjs` writes `parts` into
  `release.json`.
- **Fixes found on the way**: `services/supervisor` was missing from the package (`tools/package/manifest.mjs`), so an
  LU3 build failed its import check; `updates.json` writes retry a refused rename on Windows (the UI server may hold the
  file open for a read); the swap reply kept the request's `id` (the queue item id is now `item`).

## Tests (run 2026-11-11, one file at a time, `--test-timeout=60000`)

After the Codex re-review fixes (commit `ec07ca2`):

| Suite | Result |
|---|---|
| `tests/live-updates.test.mjs` | tests 24, pass 24, fail 0 |
| `tests/live-updates-launcher.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/stream-recovery.test.mjs` | tests 17, pass 17, fail 0 |
| `tests/service-swap-launcher.test.mjs` | tests 4, pass 4, fail 0 |
| `tests/service-swap-ui-worker.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/studio-ui-crash-recovery.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/studio-ui-server.test.mjs` | tests 40, pass 40, fail 0 |
| `tests/record-live.test.mjs` | tests 12, pass 12, fail 0 |
| `tests/studio-ui-quit-lock.test.mjs` | tests 5, pass 5, fail 0 |

Commit hook quick checks: `ci: 9/9 passed`. Lint: `lint: 0 finding(s)`.

Re-review tests:

- 2: `Codex re-review 2: the copy is read-only, and a copy changed after the queue check (while the old host shuts
  down) is hashed again before the spawn: not started, rejected, the previous host comes back`
  (`tests/live-updates-launcher.test.mjs`; the fake host changes the copy inside its `host.shutdown`, hook
  `UJWALAM_FAKE_HOST_TAMPER_ON_SHUTDOWN`), and the P1-2 test now asserts a write to the copy fails (EPERM).
- A: `Codex re-review A: a lease grant that arrives after its request timed out is given back; a lost release is sent
  again; hold() then succeeds`.
- B: `Codex re-review B: an aborted replacement (the old host did not exit) keeps the candidate pending and retries it;
  only its own failure rejects it`.
- C: `Codex re-review C: one release.json snapshot: the copy carries it, and the freshness and unchanged checks use the
  prepared entry`.

After the first Codex review fixes:

| Suite | Result |
|---|---|
| `tests/live-updates.test.mjs` (new) | tests 21, pass 21, fail 0 |
| `tests/live-updates-launcher.test.mjs` (new, real launcher + fake host) | tests 4, pass 4, fail 0 |
| `tests/service-swap-launcher.test.mjs` (real event core and UI server swaps, now from a checked release copy) | tests 4, pass 4, fail 0 |
| `tests/service-swap-ui-worker.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/studio-ui-crash-recovery.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/stream-recovery.test.mjs` | tests 17, pass 17, fail 0 |
| `tests/studio-ui-server.test.mjs` | tests 40, pass 40, fail 0 |
| `tests/record-live.test.mjs` | tests 12, pass 12, fail 0 |
| `tests/studio-ui-quit-lock.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/studio-ui-readiness.test.mjs` | tests 39, pass 39, fail 0 |
| `tests/studio-ui-stream-settings.test.mjs` | tests 16, pass 16, fail 0 |
| `tests/studio-ui-connect.test.mjs` | tests 14, pass 14, fail 0 |
| `tests/live-guard.test.mjs` | tests 14, pass 14, fail 0 |
| `tests/flags.test.mjs` | tests 7, pass 7, fail 0 |
| `tests/studio-ui-layer-remove.test.mjs` | tests 3, pass 3, fail 0 |
| `tests/studio-ui-nudge.test.mjs` | tests 3, pass 3, fail 0 |
| `tests/package-alpha.test.mjs` | tests 18, pass 17, fail 0, skipped 1 (existing skip) |

Command form: `node --test --test-timeout=60000 tests/<suite>.test.mjs`. Lint: `node tools/lint.mjs` -> `lint: 0
finding(s)`.

One test per review finding (in `tests/live-updates.test.mjs` unless named):

- P1-1: `P1-1 maintenance lock: hold refuses new starts at once, waits for starts on their way, and ends after the
  replacement` (gate unit: in-flight wait, timeout, owner gone) and `P1-1 maintenance lock: the UI server sends no stream
  or recording start while the launcher holds the gate (IPC lease)` (serveAuthority + authorityClient + gateStarts over
  a fake IPC pair: starts refused and never sent while held, stops and reads pass, silent launcher refuses).
- P1-2: `P1-2 integrity: ...` (missing exe hash / part hash / n refused; an OBS DLL or overlay child outside the hash
  refused; services without release.json or with changed files refused; the offered folder changed after the check
  does not matter; the copy changed before the restart is rejected and never started).
- P1-3: `P1-3 startup records: ...` (pending then good; a rejected release never comes back) and, with the real
  launcher, `P1-3: a broken host staged at close is rejected at the next start, the installed host starts, and it is
  never tried again` (`tests/live-updates-launcher.test.mjs`).
- P2-4: `P2-4 stale and superseded: ...` (A waiting, B applied at once after the stop, A never runs; not-newer
  refused for the host and services).
- P2-5: `LU7: a service update while live waits for ONE click ...; nothing applies it on its own, not even the stop`
  and the launcher test 1 (the event-core item still waits after the stop and is dropped at the close).
- P2-6: `P2-6 confirmed exit: stopHostChild reports a host that does not exit; it returns true only after the exit`.

Other proof in `tests/live-updates-launcher.test.mjs`: the fake host records; a host update from a staged fixture
release is staged; 1.5 s of polls do not touch the host; after the user's Stop the host restarts from the checked copy,
after the `stopped-by-user` record; host and overlay server show the new version; no crash lines; no token-shaped
value in the log. Close with a staged update -> tried and accepted at the next start. A broken update while running is
rolled back and recorded as rejected.

## Merge with LU4 (studio window swap, D346)

`git merge claude/alpha0-d1` (LU4 merged as 937175c). A `studio` swap request now goes through the update queue as
the part `studio-window` (checked copy, LU4's studio slot and entry check, one at a time; D343). The worktree's studio
was rebuilt (`node app/studio/tools/build.mjs`, the merge brought LU4's C++ changes). Runs after the merge, one file at
a time, `--test-timeout=60000`:

| Suite | Result |
|---|---|
| `tests/live-updates.test.mjs` | tests 26, pass 26, fail 0 (2 new: studio update waits for one click, runs from its copy, never during a host replacement; serveSwaps routes studio through the queue, one at a time, timings kept) |
| `tests/live-updates-launcher.test.mjs` | tests 5, pass 5, fail 0 |
| `tests/studio-swap-launcher.test.mjs` | tests 9, pass 9, fail 0 (staged builds now carry release.json; a dev build and a stale n are refused; the control page shows the studio version) |
| `tests/service-swap-launcher.test.mjs` | tests 4, pass 4, fail 0 |
| `tests/studio-ui-quit-lock.test.mjs` | tests 5, pass 5, fail 0 |

Lint: `lint: 0 finding(s)`. Not run: `tests/studio-swap-stream.test.mjs` (heavy, real host and loopback stream).

## UNVERIFIED

- The Qt studio window does not show the update status yet (needs C++; not built in this task). The control page does.
- No loopback-stream run of a host update at the stop (only the fake host).
- The restart-abort path when an old host does not exit is tested on `stopHostChild` alone and on the queue (keep and
  retry, re-review B), not end to end through `restartPlanned` (a real unkillable host was not simulated).
- The startup re-hash right before each candidate's spawn has no own launcher test (the startup records check the
  same hash a moment earlier; the planned-replacement re-hash is tested end to end).
- Read-only copies stop accidents only: a process with the user's rights can clear the flag and change a file in the
  milliseconds between the last hash and the spawn (out of scope, D343).
- The maintenance lock is tested on the gate, the IPC lease and the UI server wrapper; no end-to-end race (a Start
  click landing inside a real host restart) was run.
- LU1 part hashes are not yet in a built alpha zip (`build-alpha` not run; unit-tested only), so a real host release
  (exe + OBS runtime) has not gone through the copy and the start trial.
- Worker services (clip worker, live-AI) are still refused by the launcher (slots exist, not wired).
- Nothing here was used on a real stream.

## Files

- New: `services/supervisor/updates.mjs`, `services/supervisor/parts.mjs` (moved from `tools/package/parts.mjs`),
  `tests/live-updates.test.mjs`, `tests/live-updates-launcher.test.mjs`, this file.
- Changed: `services/studio-ui/launch.mjs`, `services/studio-ui/server.mjs`, `services/studio-ui/stream-recovery.mjs`,
  `ui/index.html`, `ui/js/api.js`, `ui/js/app.js`, `tools/package/build-alpha.mjs`, `tools/package/manifest.mjs`,
  `data/flags.json`, `tests/fixtures/studio-ui/fake-host.mjs`, `tests/service-swap-launcher.test.mjs`,
  `docs/plan/2026-10-29-v1-decisions.md` (D343).
