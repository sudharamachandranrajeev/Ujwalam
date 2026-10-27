# OBS plugin compatibility matrix (Ujwalam headless libobs host)

Date: 2026-10-27. Host: `app/spike` (ujwalam-spike) on libobs 32.1.2 (Qt 6.8.3 runtime), Windows 11, RTX 4050 Laptop.
Evidence: `docs/evidence/2026-10-27-p1a-plugins.md`. Downloads and hashes: `C:\AI\Claude\_vendor\MANIFEST.md`.

## Tiers

- **A**: loads in the headless host, and its function was verified in a recording.
- **B**: works, but the host must do extra work (shutdown order, frontend shim or settings), or part of its function is unverified.
- **C**: does not load or crashes in this host/build. Do not ship it until fixed.

Every plugin is loaded from its own module path (`--plugin-root <root>`, which maps to `<root>/%module%/bin/64bit` and `<root>/%module%/data`). Nothing is installed into the OBS install dir or `%APPDATA%\obs-studio`.

## Matrix

| Plugin | Version | OBS 32 statement | obs-frontend-api import | Qt import | Loads headless | Function tested | Tier |
|---|---|---|---|---|---|---|---|
| obs-browser (bundled) | 32.1.2 | bundled | yes | yes | yes | Chat Charge overlay rendered and recorded on H and V | B |
| Move (move-transition) | 3.2.1 | indirect (3.2.0: "Requires OBS 31.1 or higher") | yes | no | yes | `move_transition` between two scenes animates in the recording | A |
| Source Clone | 0.2.3 | indirect (0.2.0: "Requires OBS 31.1.0 or higher") | yes | no | yes | `source-clone` of an H-canvas source rendered on the V canvas | A |
| Background Removal | 1.5.0 (prerelease) | yes ("OBS 32 or later is required from version 1.5.0") | yes | yes (Qt 6.11 symbols) | **no**: "module failed to open" | not testable | C |
| obs-websocket (bundled) | 5.7.3 | bundled | yes | yes | **crash** in `obs_module_load` (0xC0000005) | not testable | C (headless) |
| Advanced Scene Switcher | 1.37.0-beta (prerelease), obs32 zip | yes ("For OBS 32 and older use the windows-x64-obs32.zip") | yes | yes | **crash** while loading its sub-plugins (0xC0000409 fast-fail) | not testable | C (headless) |
| LocalVocal | — | no release states OBS 32 | — | — | not downloaded | — | skipped |

## Notes per plugin

- **obs-browser.** CEF works headless with no Qt app. The host must `obs_source_remove` every scene that holds a browser source before `obs_shutdown`. Otherwise the main canvas keeps the browsers alive, and libcef hits a breakpoint (0x80000003) on unload. Hardware acceleration is off: private data `BrowserHWAccel` is not set by the host. UNVERIFIED: the effect of enabling it.
- **Move and Source Clone.** Both import obs-frontend-api.dll. Headless, they log `Tried to call obs_frontend_add_event_callback with no callbacks!`, which is harmless; core functions work. Frontend-driven features are UNVERIFIED and expected not to work headless: hotkeys, the Move "audio move" frontend hooks, and the tools-menu entries.
- **Background Removal 1.5.0.** Built against a newer Qt than OBS 32.1.2 ships. It imports `qt_version_tag_6_11` and `QString::arg_impl` / `argToQString` overloads that are missing from the bundled Qt 6.8.3, so the Windows loader refuses the DLL. This is a build mismatch, not a host problem; the same failure is expected inside OBS 32.1.2 itself (UNVERIFIED). Recheck on a later BGR release, or use the 1.4.x line once its OBS 32 support is confirmed.
- **obs-websocket 5.7.3.** `obs_module_load` calls `obs_frontend_get_current_profile_path` and `obs_frontend_get_app_config`. With no frontend callbacks both return null, and the null config is dereferenced. To use it, Ujwalam must register frontend callbacks (`obs_frontend_set_callbacks_internal`) that supply at least the app config, the profile path, the main window (may be null) and a tools-menu stub. That is P15 work ("P15 obs-websocket"). Until then obs-websocket stays on the host's default disabled list.
- **Advanced Scene Switcher.** Loads its core and 23 bundled DLLs (OpenCV, libusb, openvr, ...), then fast-fails. It is a Qt-widgets-heavy plugin and expects the OBS frontend and a QApplication. Not a fit for a headless host without a full frontend shim. Out of scope for Ujwalam's own automation, which replaces it.

## Background Removal: options (decide at the camera-effects phase)

No install now. Options to choose from when camera background effects are built:

- **a) Wait** for an official Background Removal build linked against Qt 6.8 (the Qt shipped with OBS 32.1.2).
- **b) Build from source** (GPL, open source) against the pinned OBS 32.1.2 runtime and its Qt 6.8.3, using the vendored headers in `C:\AI\Claude\_vendor\obs-32.1.2\src`.
- **c) NVIDIA background filter** (`nv-filters`, bundled in OBS 32.1.2). Requires an RTX GPU and the NVIDIA Video Effects SDK; installing the SDK needs user approval at that time.

Hardware on this PC (read only, 2026-10-27): **NVIDIA GeForce RTX 4050 Laptop GPU** (6141 MiB, driver 621.01) plus Intel UHD Graphics (hybrid). It is an RTX card, so option c is available.

## Bundled modules that fail or warn in the headless host (not plugins under test)

- `aja.dll`, `decklink.dll`: "Failed to initialize module" (no hardware). Harmless.
- `nv-filters`: "Failed to get NVVideoEffects.dll version info size" (NVIDIA Video Effects SDK not installed). The NVIDIA background/greenscreen filters are unavailable.
- `frontend-tools`, `decklink-output-ui`, `aja-output-ui`, `obs-websocket`: disabled by the host on purpose (they need the OBS frontend).
- Network: `rtmp-services` and `win-capture` fetch update files from obsproject.com at startup. They write into the host's module-config dir. Consider disabling the updates for offline or privacy reasons (P2/P6 decision).
