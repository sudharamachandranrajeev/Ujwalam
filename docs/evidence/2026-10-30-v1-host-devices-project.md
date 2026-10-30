# v1 day 2 (Agent C): device gating, list-only devices, project v1 load in the libobs host

Date: 2026-10-29 (day-2 task, file dated per the v1 plan). Scope: T1 + F1 support in `app/host`.
Status: PASS for everything that can run without opening a device. Device opening is not tested and waits for the
user's "devices ready" (UNVERIFIED, see the end of this file).

Paths are given relative to `<repo>`. No device name or id appears in this file: device evidence uses counts only.

## Commands and results

| Check | Command | Result |
|---|---|---|
| Build | `node app/host/tools/build.mjs` (with `UJWALAM_HOST_BUILD=out/host/build-c`, see Risks) | PASS: 14/14 steps, one existing warning (C4996 `obs_add_data_path` deprecated) |
| Host tests | `node --test --test-concurrency=1 app/host/tests/` | PASS: 22/22 (11 API, 7 new project/device, 4 output plan) on the final build; earlier runs before the last test was added: 21/21 once, 20/21 once (R3) |
| O1 loopback regression | `node app/host/tools/o1-loopback.mjs` | PASS: 55/55 checks (same as day 1) |
| Lint | `node tools/lint.mjs` | PASS: 0 findings |
| Private scan | `node tools/git-hooks/private-scan.mjs scan-files <17 changed files>` | PASS: 17 scanned, 0 hits |

The first full run had one failure (the day-1 record test: `project.load` after `record.stop` returned
"outputs are active") while the machine was under heavy load (the same run took 53 s for `devices.list`, normally
1.5 s). The two later full runs passed it. Recorded as risk R3 below.

Next (day 3, queued by the coordinator, not started): obs-browser (tier B) for browser layers with URLs from
`feedQuery(feedPort, scope)` in `services/overlay-server/index.mjs`, the overlay server under the supervisor, and
`effect.fire` through `bridge.publishEffect`. The `unavailable` reason "overlay layers need the overlay server" in
`model.cpp` is where overlay layers will be wired.

## 1. Device modules load only with `--allow-devices`

Mechanism (day 1, unchanged): `app/host/src/obs_runtime.cpp` `disabled_for()` disables `win-dshow` and `win-wasapi`
unless `--allow-devices` is set (and `obs-browser` unless `--allow-browser`). `app/host/lib/launch.mjs` never passes
either flag.

Proof (test `flag off: no device module is loaded and no device source type exists`):

- `host.info.deviceModules` = `{"win-dshow.dll": false, "win-wasapi.dll": false}` (new field;
  `GetModuleHandleW` inside the host).
- `host.info.sourceTypes` (new field; `obs_enum_input_types`) has no `dshow_input`, `wasapi_input_capture`,
  `wasapi_output_capture` or `wasapi_process_output_capture`; it does have `ffmpeg_source` and `color_source_v3`.
- Independent of the host's own report: `tasklist /m win-dshow.dll /fi "PID eq <pid>"` and the same for
  `win-wasapi.dll` find no match; the control `tasklist /m obs.dll` finds the host.

## 2. `devices.list` only lists

`devices.list` is available without the flag. It does not use libobs or a device module (`app/host/src/devices.cpp`):

- DirectShow video and audio capture categories: `ICreateDevEnum::CreateClassEnumerator`, then
  `IMoniker::BindToStorage(IPropertyBag)` for FriendlyName and DevicePath. `IMoniker::BindToObject` (which creates
  the capture filter) is never called.
- WASAPI capture and render endpoints: `IMMDeviceEnumerator::EnumAudioEndpoints`, `IMMDevice::GetId`,
  `IMMDevice::OpenPropertyStore(STGM_READ)`. `IMMDevice::Activate` (which creates an audio client) is never called.
- Runs on its own short thread in the COM multithreaded apartment.

Runtime proof (test `devices.list lists only: no device module, no privacy-store access record`):

- Windows records each app that opens a camera or microphone under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{webcam,microphone}\NonPackaged`
  (subkey = exe path with `\` as `#`). Read-only `reg query` before and after two `devices.list` calls (and around
  each `project.plan` call): no entry for the host exe before or after, and no `ujwalam-host` entry changed.
  Store sizes at the time: webcam 54 keys, microphone 103 keys.
- After listing, `deviceModules` are still both false and `tasklist` still finds no `win-dshow.dll`.
- Result: `opened: false`, `devicesEnabled: false`. Counts by kind: video 8, dshow-audio 6, audio-input 6,
  audio-output 5; category errors 0. The same count on a second call.

Limit of the proof: the privacy store is indirect evidence (it records access through the Windows capture stacks,
which is what opening a camera or microphone uses). Together with the code path (no `BindToObject`, no `Activate`)
it is strong enough that the method is not gated behind the flag. If main prefers, gating it is a one-line change in
`methods.cpp`.

## 3. `project.load` from Agent A's model (project v1)

Validation: `app/host/lib/project.mjs` runs `services/project/validate.mjs` first and refuses an invalid document
(`ProjectRefused` with the validator's errors); the host never sees it. `loadFileIntoHost` uses
`services/project/store.mjs` `loadProject` (migrate + validate). `--project` on the host command line now takes the
host test format only; a v1 document there exits 3 (test). The host re-checks what it uses (`app/host/src/model.cpp`)
and refuses a malformed document with -32602 on its own (test: bad canvas id; relative `bases` path).

Mapping (`app/host/src/model.h`):

| Project v1 | libobs |
|---|---|
| canvas `h`, `v` | H = main canvas (`obs_reset_video`), V = `obs_canvas_create` (no own audio mix; the main mix is the one audio encoder) |
| one scene | one libobs scene per project canvas, same scene id on H and V |
| one layer | one source, created once; one scene item per placement canvas; no placement on a canvas = not shown there |
| `duplicate` (D60) | another scene item on the target layer's source; no new source |
| placement `{x, y, width, height}` | bounds STRETCH to width x height, centre alignment at the rectangle centre (so rotation turns about the centre; UNVERIFIED against Meld) |
| placement `rotation`, `crop` | `obs_sceneitem_set_rot`, crop in source pixels (UNVERIFIED against Meld) |
| placement `opacity` other than 1, `masterVolumeDb` | not applied; listed in `warnings` |
| `color` | `color_source_v3`, colour `#RRGGBB[AA]` to ABGR, size = largest placement |
| `image`, `media` | `image_source`, `ffmpeg_source` (local file, `loop` default false, no hardware decode); `{base, rel}` resolved against `bases`, must stay inside the base |
| `text` | `text_gdiplus_v3` (font face, size, colour) |
| `capture` | `dshow_input`; device matched by `match.directShowId` first, then `match.deviceId` (DevicePath, endpoint id or win-dshow id), then device instance (UNVERIFIED), then a unique `match.name`. Forbidden without `--allow-devices` |
| `browser` | forbidden without `--allow-browser`; `overlay` layers unavailable (no overlay server wired yet); `url` only http://127.0.0.1 or localhost |
| `audio.sources` | volume (dB), mute, tracks (bit n = `audio.tracks[n]`) on the bound source; monitoring only with `--allow-devices` (it opens an output device); a source with audio and no entry gets no tracks |
| microphone / audio-output device | `wasapi_input_capture` / `wasapi_output_capture` on output channels 1+; forbidden without the flag |

Layers that cannot be built are listed in `unavailable` (`code` `forbidden` or `unavailable`, with the reason and,
for devices, `matchedBy`). `project.load` refuses (-32001 if any is forbidden, else -32004) unless
`skipUnavailable: true`, which builds the rest. `project.plan` is the same mapping as a dry run: it creates nothing.

Tests (`app/host/tests/host-project.test.mjs`):

- Sample fixture (`tests/fixtures/project/sample.project.json`, placeholder device ids): plan lists `layer-game`,
  `layer-cam` forbidden, `layer-chat` not buildable, both device audio entries not buildable; the four other layers
  buildable. Without `skipUnavailable` the load is refused (-32001); with it: 2 scenes on H and V, 4 sources,
  5 items, the logo image (generated 64x64 PNG) has width 64, `layer-intro` hidden. `layers.list` without `canvas`
  on a scene that is on both canvases is refused; `layers.setVisible` without `canvas` acts on both.
- Device matching with real listed ids, never printed: `deviceId` = DevicePath gives `matchedBy: "deviceId"`;
  `directShowId` = win-dshow id gives `"directShowId"`; an unknown id gives `matchedBy: null` and the reason
  "...; also device dev-none: ..."; a microphone endpoint id gives `"deviceId"`. All forbidden (flag off); privacy
  store unchanged; device modules still unmapped.
- Render check (H 1280x720, V 720x1280, both at 60 fps; NVENC rungs 640x360 and 360x640 at 30 fps, file sinks, 2 s):
  frame at 0.8 s read with ffmpeg, RGB within 48 per channel.

  | Point (rung pixels) | Expected | Result |
  |---|---|---|
  | H (100, 100): box centre | green | PASS |
  | H (500, 237): duplicate item centre | green | PASS |
  | H (20, 20), (200, 100), (500, 180): background | red | PASS |
  | V (250, 500): box centre (V placement) | green | PASS |
  | V (100, 100), (250, 400), (250, 237): background, no H-only duplicate | red | PASS |

  Same run: 4 sources for 9 items (one source shown by H, V and a duplicate); one mixer entry for the media source
  (`audioSource: aud-clip`, volume -6 dB, mixers 2 = track t2).
- Host shutdown after each run: libobs `leaks=2`, the same count as every day-1 run (baseline, not new).

## 4. R2: scaled-encoder start failure leaks a view (recorded, not fixed)

Root cause in libobs 32.1.2 (`libobs/obs-encoder.c`, vendored source), not in the host:

1. `obs_encoder_initialize_internal` calls `maybe_set_up_gpu_rescale` before the encoder's `create()`. That creates
   an encoder-only video mix (refs 1) and sets `encoder->media` to the mix's video.
2. When `create()` fails, `context.data` stays NULL. `obs_encoder_shutdown` clears the mix
   (`maybe_clear_encoder_core_video_mix`) only when `context.data` is set, and `obs_encoder_destroy` never clears it.
3. The mix keeps rendering every frame until `obs_free_video`, which warns "Number of remaining views". A retry reuses
   the leaked mix (its refs grow), so the leak does not grow per retry.

Not small to fix in the host: it needs a libobs change. Mitigation stays as in D24: the session probe does not scale
on the GPU. Candidate for an upstream issue (not filed; filing is the user's call).

## 5. API contract changes (for Agent B)

- `project.get` now returns `{format, dirty, project}`. `format` is `"project-v1"` or `"ujwalam-host-test"`.
  Project v1: `project` is the document as loaded (services/project owns the model of record; host edits are live
  only and set `dirty`). Test format: the live state, which loads back with `project.load`.
- `project.load {project, bases?, skipUnavailable?}`. `bases`: `{data, media, overlays, profile}` to absolute
  directories. Result adds `built {scenes, sources, items, audio}`, `unavailable`, `warnings` for v1.
- New `project.plan {project, bases?}`: dry run, same shape as the build plan, plus `devicesListed` and `flags`.
- New `devices.list {}`: `{devices: [{kind, name, path, obsId}], errors, opened: false, devicesEnabled}`. Device names
  and ids are personal data on this machine: the UI shows them locally and must not log or export them.
- `scenes.remove`, `scenes.activate`, `layers.*` take an optional `canvas`. Without it they act on every canvas
  that has the scene; `layers.list` and `layers.add` need it when the scene is on both canvases.
  `scenes.activate` returns `canvases` (and the day-1 `canvas`, the first one).
- `layers.list` items: v1 layers carry `placement`, `source` (owning layer id) and `duplicateOf`; test-format layers
  carry `settings` and `transform` as before.
- `mixer.list` entries are per source (a source shown by several items is listed once) and add `audioSource`;
  ids are `<scene>/<layer>` or `audio:<id>` for device audio.
- `host.info` adds `deviceModules` and `sourceTypes`.
- Host test format files need `"format": "ujwalam-host-test"` (`app/host/projects/test-card.project.json` updated).
- Request body limit raised from 64 KiB to 1 MiB (project documents). Auth is still checked before any body is read.

## UNVERIFIED

- Everything with `--allow-devices`: opening a capture device, `dshow_input` settings (`res_type`, `resolution`,
  `frame_interval` from `device.format`), WASAPI sources, monitoring. Waits for "devices ready".
- `win-dshow` module load itself: its `obs_module_load` registers DirectShow encoders (`EnumEncoders`), which may
  create encoder filters. This is why no flag-on run was made, even for listing.
- Device-instance matching (DevicePath without the interface class segment) and what Meld's `directShowId` holds.
- Placement semantics against Meld (centre rotation, crop in source pixels, stretch to the rectangle).
- `text_gdiplus_v3` with the project's font names (GDI+ falls back to a default face if the name is missing).

## Risks

- R3: under heavy machine load, `project.load` right after `record.stop` can be refused because the outputs are not
  idle within the 3 s wait (`Outputs::release_for_reload`). Seen once in 3 runs. Callers should retry on -32009.
- Another agent's host was running from `out/host/build` during this work, so the exe there could not be replaced.
  The day-2 build is in `out/host/build-c` (`UJWALAM_HOST_BUILD` and `UJWALAM_HOST_EXE` select it). Rebuild
  `out/host/build` when that host stops. The day-1 exe refuses the updated test card (`format` field is unknown to it).
- Media layers use software decode (`hw_decode` false) to keep NVDEC free; revisit with real footage.

## Files

Created: `app/host/src/devices.h`, `app/host/src/devices.cpp`, `app/host/src/model.h`, `app/host/src/model.cpp`,
`app/host/src/checks.h`, `app/host/lib/project.mjs`, `app/host/tests/host-project.test.mjs`, this file.
Changed: `app/host/src/studio.h`, `app/host/src/studio.cpp` (rewritten), `app/host/src/methods.cpp`,
`app/host/src/main.cpp`, `app/host/src/rpc_server.h`, `app/host/CMakeLists.txt`, `app/host/lib/config.mjs`,
`app/host/tools/launch.mjs`, `app/host/tests/host-api.test.mjs`, `app/host/projects/test-card.project.json`,
`docs/plan/2026-10-29-v1-decisions.md` (D30 to D37 appended).
Moved aside (not deleted): `out/_to_delete/studio.cpp.day1`, `out/_to_delete/studio.h.day1`.
