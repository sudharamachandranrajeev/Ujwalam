# Device hot-plug: capture layers wait for a missing device (D329)

Date: 2026-11-10. Branch: `dev/hotplug`. Status: **tests pass; real hot-plug with the user's card UNVERIFIED.**

## The bug

Adding a capture-card layer after Ujwalam started failed with
`HTTP 502: host-error (layer capture-… cannot be built: device dev-…: no connected device matches)`.
Windows did not list the card at that moment, and the host only looked for devices once.

## What changed

| Part | Change |
| --- | --- |
| Host `device_watch.cpp` | `CM_Register_Notification` for 6 interface classes (capture, video, camera, audio, audio capture, audio render). No window. Debounce 700 ms quiet, at most 3 s, then one list-only pass. Runs only with `--allow-devices` or `--test-hooks`. |
| Host `devices.cpp` | `reconcile()`: the waiting/bound state machine (bind on match, lose when the bound device is gone, sticky while it is listed, nothing when video devices could not be listed). `waiting_message()`: the plain-English sentence. |
| Host `model.cpp` | A capture layer with no matching device (or two with the same name) is built **waiting** (empty device id, opens nothing) and listed in `plan.waiting`, not `plan.unavailable`. |
| Host `studio.cpp` | `devices_changed()`: bind with `obs_source_update` (that source only), lose by clearing its frame. `layers.list` rows carry `device {id, state, message, binds}`. `layers.addFromProject` returns `waiting {layer, device, message}`. `host.status.devices` {seq, listed, busy, waiting, connected, watcher}. |
| Host `methods.cpp` | Loss confirmed by a second listing 1 s later. `devices.testSet` (needs `--test-hooks`): a fake device list for tests. |
| UI server | `host.status.devices.seq` moved: SSE `devices` + `layers {source: 'devices'}`. Status snapshot `host.devices {seq, waiting}` (numbers only). Add-layer choices carry `connected`. `layer.add` passes back `waiting`. |
| Web page, Qt studio | Layer list shows "(waiting for device)" with the sentence as tooltip; the device picker shows "(not connected)"; an open Add layer window refreshes in place; a waiting add says "Layer added. Waiting for capture card …"; a host refusal is shown as its own sentence. |

Encoders, outputs, recording and the stream are never touched by a device event. No feature flag (reasons in D329).

## Tests

All runs headless (`UJWALAM_HEADLESS=1`), no real device opened (fake devices through `--test-hooks` and the host test
source type `ujw_test_capture`, which opens nothing and sends 64x36 frames while its fake device is "present").

```
node --test app/host/tests/host-device-hotplug.test.mjs
✔ no device is listed or opened: no device module, the watcher is registered, test source type only with --test-hooks
✔ resolve + waiting with fake lists (project.plan): none, two with the same name, other USB path by name, exact path
✔ load with the card unplugged: the project loads, the layer waits, its audio entry binds to it
hotplug run: 4.6 s, recording 4.6 s at 30.00 fps, 139 packets
✔ add while unplugged, plug in, unplug, re-plug on another port, same-name second card: the recording never stops
✔ devices.testSet needs --test-hooks; without --allow-devices nor --test-hooks there is no watcher
ℹ pass 5  ℹ fail 0
```

The recording test runs an NVENC file recording (640x360, 30 fps) through: add while unplugged (waiting) → plug in
(bound, frames arrive) → unplug (waiting, frame cleared) → re-plug on another USB path (bound by name) → a second card
with the same name (no change, sticky) → its card leaves and the project's own path returns (bound by device id). It
asserts one recording file throughout, ffprobe video span ≥ elapsed − 1.5 s, 27–33 fps, compositor frames ≥ 25/s,
≤ 3 lagged render frames, encoder frames ≥ 25/s, 0 dropped frames, and 3 binds.

```
node --test tests/studio-ui-device-hotplug.test.mjs tests/project-structure.test.mjs tests/studio-ui-preview-edit.test.mjs
✔ a device plug or unplug (devices.seq moved) reaches the pages as SSE devices + layers; the snapshot carries seq and the waiting count
✔ the add-layer picker marks each device connected or not; nothing when the host has not listed devices
✔ adding a capture layer while its card is unplugged succeeds and returns the plain waiting sentence
ℹ pass 20  ℹ fail 0
```

Also run: `app/host/tests/host-api.test.mjs` and `host-project.test.mjs` (role refusal lists include
`devices.testSet`), `tests/studio-qt-shell.test.mjs`, and the quick CI on each commit.

## UNVERIFIED

- Real `CM_Register_Notification` events with the user's capture card (plug, unplug, other USB port).
- How OBS's `dshow_input` reactivates a real card after `obs_source_update` with a new device id (tested only with the
  test source type).
- What the stream shows after a real unplug (the frame is cleared; the layer should be transparent).
- Microphone and audio-output globals have no waiting state yet (unchanged behaviour).

## Test steps for the user (real card)

1. Start Ujwalam with devices allowed (the normal desktop shortcut). Do not go live; a local recording is enough.
2. Unplug the capture card. Open the studio, **Add layer → Capture**. The card shows "(not connected)". Add it.
   Expected: "Layer added. Waiting for capture card …". The layer list shows "(waiting for device)".
3. Start a recording.
4. Plug the card in. Within about 1–3 s the layer shows the game picture and "(waiting for device)" goes away.
5. Unplug it. Within about 2–4 s the layer goes back to "(waiting for device)" and the picture disappears. The
   recording keeps running.
6. Plug it into a **different USB port**. The picture comes back by itself.
7. Stop the recording and play it back: one file, no gap or freeze apart from the card picture itself.
8. Tell us what you saw, especially if a step took longer than 5 s or anything else in the scene changed.
