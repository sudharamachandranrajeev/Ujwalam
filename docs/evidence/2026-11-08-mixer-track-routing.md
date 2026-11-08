# 2026-11-08 Mixer track routing (D273)

Status: test evidence for the host call, the UI server gate and save, and the Qt shell's buttons (headless probe).
Clicking a track button in the studio window is UNVERIFIED at runtime; what a stream sounds like after a change is
UNVERIFIED on a real stream.

## What changed
- Host `mixer.setTracks {id, tracks: [project track id]}`: sets the source's libobs audio mixers (bit n = track n of
  `audio.tracks`; every output encodes track 1). Project v1 sources with an `audio.sources` entry only; an unknown
  track, a repeated track or a non-list is refused and changes nothing. A CUE that is on follows the routing
  (monitor-and-output on a track, monitor-only on none). Answers `{id, audioSource, mixers, tracks}`.
  `mixer.list` now also returns `tracks` (the project's tracks) and each source's `tracks`.
- UI server: `mixer.setTracks` in the page's host call list behind flag `mixer-routing` (off by default),
  `liveConfirm` (instant offline, "yes, on air" while live). The accepted change is saved into
  `audio.sources[].tracks` of the project file, keyed by the `audioSource` the host answered (a mixer id names a
  scene/layer or a device, not the project entry). New validator type `ids` (distinct ids, at most 6).
- Qt shell: with the flag on, each mixer strip with a project audio entry has one checkable button per track;
  a sound on no track stays listed so it can be put back. The browser page has no routing control (native UI first).

## Tests
- `node --test app/host/tests/host-project.test.mjs`: 18 pass. Routing in the render test: `mixer.list` tracks
  `[t1, t2]`; route to `[t1, t2]` gives mixers 3; `[]` gives 0; `['t9']`, `['t1','t1']` and `'t1'` refused with
  mixers unchanged; back to `[t2]` gives 2 (as loaded).
- `node --test app/host/tests/host-api.test.mjs`: 16 pass (`mixer.setTracks` forbidden for the clips role).
- `node --test tests/studio-ui-mixer-routing.test.mjs`: 2 pass. Off: 404 `mixer-routing-off`, host not called. On:
  sent as given, saved under `aud-game` (other sources untouched), an empty list saved, a host refusal is 502 and not
  saved. Bad lists (string, repeated, number, bad id, 7 ids, no id) are 400 before the host. Live: `yes, on air`
  first, then applied and saved.
- `node --test tests/studio-project-sync.test.mjs`: 5 pass (`applyEdit` for `mixer.setTracks`).
- `node --test tests/studio-qt-shell.test.mjs`: 5 pass. Probe: `trackButtons` 0 with the flag off, 6 with it on
  (2 tracks on each of the fake host's 3 strips).

## Review follow-up (independent review of b448c64 and bd599ae, same day)
- No bugs found in thread safety, NaN handling, JSON types or input checks.
- Preview snapping "any edge or centre to any target" is intended (D272 says so).
- Fixed: the host's answer now carries `monitoring` too. With a CUE on, the host flips monitor-only and
  monitor-and-output with the routing (libobs: monitor-only is never in the output mix), and the project file now
  records that, so a restart loads what was heard. Tests: host answer `monitoring: 'off'` for a source without CUE;
  `aud-game` (sample: monitor-only) saved as monitor-and-output after routing; unknown values not written.
- Fixed: the Qt shell takes one routing change at a time (a second click before the answer would have built on
  the old list and dropped the first change), reloads the mixer after a typed confirm, and says when a change was
  live only (not saved to the project file).

## To check by hand
Flag `mixer-routing` on (type `yes`). In the studio window's mixer, each sound shows "Tracks:" and a button per
track. Untick track 1 on a sound: it leaves the stream and recording mix; the project file's `audio.sources` entry
has the new `tracks`. Tick it again to put it back.

## Files
- `app/host/src/studio.h`, `app/host/src/studio.cpp`, `app/host/src/methods.cpp`
- `app/host/tests/host-project.test.mjs`, `app/host/tests/host-api.test.mjs`
- `services/studio-ui/server.mjs`, `services/studio-ui/project-sync.mjs`, `services/studio-ui/backends.mjs`
- `app/studio/src/main_window.h`, `app/studio/src/main_window.cpp`
- `data/flags.json` (`mixer-routing`; `preview-edit` text mentions D272)
- `tests/studio-ui-mixer-routing.test.mjs` (new), `tests/studio-project-sync.test.mjs`, `tests/studio-qt-shell.test.mjs`
- `docs/plan/2026-10-29-v1-decisions.md` (D273), this file
