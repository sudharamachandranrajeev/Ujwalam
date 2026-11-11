# 2026-11-11 LU6 live install: install while Ujwalam runs, handed to the update queue

Branch `lu/live-install` (on `claude/alpha0-d1` at 2f571b7, which holds LU3, LU4, LU5/LU7). Plan row LU6 (D324);
decision D349. Status: **live mode of the installer, hand-over channel, part plan and the end-to-end install during a
recording done and tested with the fake host, fake packages and real service swaps, all in temp folders. A run with
the real host on a loopback stream and with a built alpha zip is UNVERIFIED** (see below). Behind the flag
`service-swap` (off by default, D343). No Codex review yet.

## Done when (plan): "E2E: install alpha.N+1 during a loopback stream, every part except the host updated, stream unbroken"

PASS with the fake host, UNVERIFIED with the real host on a loopback stream. `tests/live-install-launcher.test.mjs`:
the real launcher runs with its data folder under a temp install root, the fake host recording (a live record sink).
The real `Install-Ujwalam.ps1` installs `0.1.0-alpha.2` from a fake package (the files the alpha package ships, a
stand-in host, release.json with `n`, `hostExeSha256` and LU1 part hashes, SHA256SUMS.txt). Asserted:

- the installer finds the running copy by path and says "live install"; current.txt names alpha.2 (side by side);
- installer output: event core and control page server "ready ... waits for one click", host "staged ... applied when
  every stream and recording has stopped";
- one Apply now click each (logged-in page, CSRF): event core `200 swapped`; control page server `202 started`, then
  "Control page server updated to 0.1.0-alpha.2";
- versions: event core and control page server alpha.2, host `dev`; only the host waits;
- the fake host was started once and its recording never stopped (no `stopped-by-user`, one `start`): no restart, no
  crash line, no "stopping Ujwalam";
- after the user's stop the host update is applied from the checked copy under `live/releases` (second start);
- the launcher exits 0; neither the launcher nor the installer prints a 64-hex value.

## What it does

- **Installer live mode** (`tools/package/Install-Ujwalam.ps1`): `Get-RunningUnder` lists programs whose path or
  command line lies under the install root (System.Management; never by name; itself left out; unreadable list: exit
  8, nothing installed). Live: the version folder is copied and checked as before; reinstalling the running version is
  refused even with -Force (exit 4); top-level files in use (`ujwalam-start.exe`, `Ujwalam.cmd`) are kept and named;
  unchanged ones are not touched; a running folder is never offered for removal. Then `Send-LiveInstall` hands over.
- **Channel** (`services/supervisor/install-channel.mjs`): named pipe with a random name and a token, written owner-only
  to `<data>\core\live\install-channel.json` (removed at the stop); one line in, one line out; wrong token, bad JSON,
  bad roots and a release without `n`/parts refused before anything is asked.
- **Plan** (`installPlan`): only parts that changed against the queue's new `runningParts()`; order event core, control
  page server, studio window (only when one runs), host.
- **Same checks as a parent request** (`localSwapAsker` in `services/studio-ui/launch.mjs`): each request goes through
  `serveSwaps` and the update queue unchanged (click while live, host at the stop).
- **Fix** (`services/studio-ui/server.mjs`, `ui/js/app.js`): Apply now for the control page server's own update is
  answered first (202 started) and then swapped. Before, it always ended `kept-old` after 10 s (the hand-over waits for
  the click's own request).

## Commands and results (2026-11-11, one file at a time, UJWALAM_HEADLESS=1)

| Command | Result |
|---|---|
| `node --test tests/live-install.test.mjs` | 9 pass, 0 fail |
| `node --test tests/live-install-launcher.test.mjs` | 1 pass, 0 fail (about 12 s) |
| `node --test tests/live-updates.test.mjs` | 27 pass, 0 fail |
| `node --test tests/live-updates-launcher.test.mjs` | 6 pass, 0 fail |
| `node --test tests/service-swap-launcher.test.mjs` | 4 pass, 0 fail |
| `node --test tests/service-swap-ui-worker.test.mjs` | 5 pass, 0 fail |
| `node --test tests/studio-swap-launcher.test.mjs` | 9 pass, 0 fail |
| `node --test tests/package-alpha.test.mjs` | 18 pass, 1 skipped (the opt-in full build), 0 fail |
| commit hook (quick CI) | 9/9 PASS |

`tests/live-install.test.mjs` covers: the plan (unknown hashes, unchanged parts, data-only change, studio not running,
part not in the release), the result texts, the channel (file, refusals, order, token never echoed, file removed at
close), the local asker through the real queue (waiting while live, refused studio and host, swap after the click,
running hashes after the swap), the server's 202 for its own update (answered even when the swap never finishes), the
installer with a stand-in running program (start exe in use kept, running version folder byte- and time-identical,
current/previous, no channel: "runs from the next start", reinstall of the running version refused with -Force, no
renamed folder), and a program under a similar folder name not counted as running.

## UNVERIFIED

- A loopback stream with the real libobs host during the install (the opt-in stream tests of LU3/LU4 cover service and
  studio swaps with NVENC to loopback; this run used the fake host's recording).
- A built alpha zip with LU1 part hashes installed live (the packager writes `parts`; no alpha has been built with it).
- The Qt studio window as the clicked surface (it does not show the updates card yet, D343) and a studio-window part
  handed over live (covered by LU4's swap path; here the studio window was not running).
- Never run against `%LOCALAPPDATA%\Ujwalam` or the installed app: temp folders only.

## Files

Created: `services/supervisor/install-channel.mjs`, `tests/live-install.test.mjs`,
`tests/live-install-launcher.test.mjs`, this file.
Changed: `tools/package/Install-Ujwalam.ps1`, `services/supervisor/updates.mjs` (`runningParts`),
`services/studio-ui/launch.mjs` (channel wiring, `localSwapAsker`), `services/studio-ui/server.mjs` (202 for its own
update), `ui/js/app.js`, `data/flags.json` (flag text), `docs/how-to.md` (install while running),
`docs/plan/2026-10-29-v1-decisions.md` (D349).
