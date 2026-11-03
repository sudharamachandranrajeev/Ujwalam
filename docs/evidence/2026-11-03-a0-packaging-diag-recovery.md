# Alpha 0 day 3: packaging, diagnostics bundle, crash recovery

Date: 2026-11-05 (plan day 3; runs made on the laptop on 2026-11-03 by its clock). Branch: an agent worktree off c43cd71, not committed.

Result: **PASS** for packaging, install, the installed mock run and the diagnostics bundle. **PASS (fake host)** for crash recovery; with the real host it is UNVERIFIED. Live use: awaiting live test.

## 1. Build the zip

```
node tools/package/build-alpha.mjs --force --host-exe <repo>/out/host/build/ujwalam-host.exe --runtime <vendor>/obs-32.1.2/runtime --profile <repo>/data/profile.local.json
```

```
[package] OBS runtime: 1053 files from 14 modules (coreaudio-encoder, image-source, obs-browser, obs-ffmpeg, obs-filters, obs-nvenc, obs-outputs, obs-qsv11, obs-text, obs-transitions, obs-x264, text-freetype2, win-dshow, win-wasapi); skipped 1105 files
[package] checks passed: allowlist, forbidden paths (fonts: Corbel, Consolas), import closure, private-term scan over 249 non-OBS files
[package] wrote out\dist\ujwalam-0.1.0-alpha.1-win64.zip (144.7 MiB, 1303 files, 314.5 MiB unpacked) sha256 f30b6301bc49378f4713bc12e8d02ba19c15e500a53c789e8da3a079e82df352
```

Zip contents (top folder `ujwalam-0.1.0-alpha.1-win64/`):

| Part | Files | Unpacked |
|---|---|---|
| Top level: Install-Ujwalam.ps1, Ujwalam.cmd, README.txt, CHANGELOG-alpha.md, SHA256SUMS.txt, release.json, package.json, LICENSE | 8 | 0.2 MiB |
| `bin/`: ujwalam-host.exe plus obs-ffmpeg-mux, obs-nvenc-test, obs-amf-test, obs-qsv-test | 5 | 2.4 MiB |
| `obs/bin/64bit` (libobs, FFmpeg, x264, Qt6Core/Gui/Widgets, libobs-d3d11, libobs-winrt, ...) | 19 | 68 MiB |
| `obs/obs-plugins/64bit` (14 modules, CEF for obs-browser, en-US locale only) | 25 | 239 MiB |
| `obs/data` (libobs effects, data of the 14 modules) | 1005 | 4.2 MiB |
| Node services, ui, registry, data, tools/diag, tools/mock, tools/package/run-installed.mjs and zip.mjs, app/host/lib, overlay and test-card project | 237 | 0.8 MiB |
| `notices/`: GPL-2.0.txt, SOURCE-OFFER.txt, THIRD-PARTY.txt, OBS-RUNTIME-FILES.txt | 4 | 0.1 MiB |

Skipped from the runtime (1105 files, 152.6 MB): 50 `.pdb`, 13 disabled modules and 697 data files of them, 267 frontend and scripting data files, 13 Qt plugin files, 54 CEF locales other than en-US, 2 virtual-camera files, and 9 not imported: `datachannel.dll`, `libcurl.dll`, `libobs-opengl.dll`, `lua51.dll`, `obs-scripting.dll`, `obs64.exe`, `Qt6Network.dll`, `Qt6Svg.dll`, `Qt6Xml.dll`. 88 system DLLs are imported but not shipped, among them the VC++ runtime and `d3dcompiler_47.dll`. Node.js is not bundled.

The first installed run found one gap. libobs loads `libobs-winrt.dll` by name, so the PE closure missed it, and the host logged `LoadLibrary failed for 'libobs-winrt'`. It is now a fixed root in `tools/package/manifest.mjs`. The rebuilt package's run (below) has no LoadLibrary failure.

## 2. Install into a temp LOCALAPPDATA

```
Expand-Archive <zip> -DestinationPath %TEMP%\ujw-a0-e2e\unzip
$env:LOCALAPPDATA = "%TEMP%\ujw-a0-e2e\lad"
powershell -NoProfile -ExecutionPolicy Bypass -File ...\Install-Ujwalam.ps1 -StartMenuDir %TEMP%\ujw-a0-e2e\start -DesktopDir %TEMP%\ujw-a0-e2e\desk
```

```
[install] Node.js 26.12.1 (needs 22.13.0): ok
[install] Visual C++ x64 runtime 14.51.36247 (needs 14.44.0): ok
[install] verifying SHA256SUMS.txt ...
[install] checksums ok
[install] installed: current 0.1.0-alpha.1
[install] shortcut: ...\start\Ujwalam (alpha).lnk
[install] shortcut: ...\desk\Ujwalam (alpha).lnk
install exit 0
```

Reinstalling the same version without `-Force` stops with exit 4 ("already installed ... use -Force"). With `-Force` it exits 0, and the old folder is kept as `0.1.0-alpha.1.replaced-<stamp>` and reported as removable by hand. `data\profile.local.json` survives the reinstall.

First run without a profile stops before anything starts (exit 2):

```
[ujwalam] no profile at %LOCALAPPDATA%\Ujwalam\data\profile.local.json. Copy ...\0.1.0-alpha.1\data\profile.example.json there
[ujwalam] and fill in your values (it stays on this PC), or name another file with --profile. Nothing was started.
```

## 3. Run the installed launcher (mock, no devices, no platforms)

`Get-Process ujwalam-host` showed none before the run. The run used `profile.example.json` copied into the data dir.

```
%LOCALAPPDATA%\Ujwalam\Ujwalam.cmd --mock --no-open --stop-on-stdin     (stdin closed 20 s after the UI line)
%LOCALAPPDATA%\Ujwalam\Ujwalam.cmd diag
```

```
[ujwalam] 0.1.0-alpha.1 from %LOCALAPPDATA%\Ujwalam\0.1.0-alpha.1; data %LOCALAPPDATA%\Ujwalam\data; overlays off (no overlay folder); profile found
[serve] api on 127.0.0.1:52427 (mock Streamer.bot); api.json written (acl); data dir acl; no token printed; sending to platforms is off
[studio] libobs host started (devices off), previews H and V
[studio] alpha project loaded into the host: {"scenes":1,"sources":7,"items":7,"audio":0,"overlayLayers":0,"relay":null}; not built: 19
[studio] outputs: real targets off; 0 sink(s) (no plan; real targets need --live)
[studio] hotkeys: on; panic Ctrl+Alt+P registered; feedback Ctrl+Alt+F registered; marker Ctrl+Alt+Shift+M registered
[studio] replay buffer: on, 30 s; H running (fallback rung); V running (fallback rung)
[studio] UI at http://127.0.0.1:52441/ (the login key is one-time and not printed). Ctrl-C stops everything.
[driver] launcher exit 0 after 24.4 s
[diag] wrote %LOCALAPPDATA%\Ujwalam\data\diag\ujwalam-diag-<stamp>.zip (8 files, 11496 bytes; redacted: home dir, profile terms, keys, tokens, URLs, chat fields)
```

The 19 layers not built are browser layers (no `--allow-browser`) and profile-base images (no overlay folder). Both are expected for this run.

Host log from the installed run:
- `Loading up D3D11 on adapter NVIDIA GeForce RTX 4050 Laptop GPU (0)`
- `[obs-nvenc] NVENC version: 12.2 (compiled) / 13.1 (driver)`
- 11 modules loaded. win-dshow and win-wasapi stayed off without `--allow-devices`; obs-browser without `--allow-browser`.
- `replay H: 30 s on fallback rung replay-H (obs_nvenc_h264_tex, 12000 kbps, 1920x1080)`
- `replay V: ... (obs_nvenc_h264_tex, 8000 kbps, 1080x1920)`
- `obs_shutdown returned; leaks=2`
- 0 `LoadLibrary failed` lines.

The host log also shows `windows graphics preference for this exe: {..., "set": false}`. The installed exe path has no Windows GPU preference, though libobs still picked the NVIDIA adapter (adapter 0).

The diagnostics zip has versions.json, gpu.txt, host-info.json, host-status.json, outputs.json, host logs and manifest.json. A local check for the Windows user name and `Users\` found 0 hits in every entry. Home paths read `%USERPROFILE%`, and versions.json shows `"key": "<redacted>"`. gpu.txt: `NVIDIA GeForce RTX 4050 Laptop GPU, 621.01, 6141 MiB, ... encoder.stats.sessionCount 0`.

## 4. Tests

```
node --test --test-timeout=300000 tests/package-alpha.test.mjs           -> tests 10, pass 9, skipped 1 (full build: UJWALAM_PACKAGE_E2E=1)
node --test tests/diag-bundle.test.mjs                                   -> tests 3, pass 3
node --test --test-timeout=300000 tests/studio-ui-crash-recovery.test.mjs -> tests 5, pass 5
node --test --test-timeout=300000 tests/studio-ui-alpha.test.mjs          -> tests 16, pass 16
npm test                                                                  -> tests 963, pass 954, fail 4, skipped 5
npm run lint                                                              -> 0 finding(s)
node tools/git-hooks/private-scan.mjs --profile <profile> scan-worktree   -> 625 items scanned, 0 hits
```

The 4 `npm test` failures are environmental. They are the registry validations (`real registry passes`, `base fixture passes`, `registry (function + preset) validates`, `V preset ...`). They fail because the worktree has no gitignored `legacy/`, so every `legacySource` reads "does not exist on disk". They are not caused by this change; re-run them in the main checkout.

What the tests cover:
- Packaging:
  - zip round trip and CRC
  - unsafe names refused (`..`, `.`, absolute, drive letters, backslashes, empty segments, duplicates)
  - PE reader
  - repo file set has no tests, docs, Python or local files; every relative import resolves
  - allowlist and forbidden samples: legacy/, `*.local.*`, Corbel and Consolas, any font, docs/evidence/private, feedback/, out/, user data, secrets
  - fonts parsed from docs/licence-headers.md
  - release info, changelog excerpt, Node version check and installed spec
  - no profile means nothing starts
  - CRLF and SPDX headers; the PS 5.1 parse
- Installer end to end on a fake package, with Windows PowerShell 5.1:
  - install and shortcuts; the root `Ujwalam.cmd` follows current.txt
  - reinstall gives exit 4; a changed file or an extra file gives exit 7
  - a second version records the previous one; `-Rollback` swaps them; nothing is deleted
- Diagnostics: random secrets and a fake home `D:\Profiles\diag<random>`.
  - Gone: home path in all spellings, user name, profile terms with separator variants, rtmp/rtmps URLs, query strings, Bearer and token fields, `live_`/`sk_`/dashed keys, hex and base64 blobs, chat `text`/`message`/`displayName`, marker notes and scenes.
  - Outputs keep presence flags only. The newest 50 markers and the newest 3 logs are kept.
- Crash recovery (fake host):
  - 2 crashes give 2 restarts, with a project reload, recording restarted in a new file and a `marker.add` (source api) each time
  - the 4th exit within 5 min gives up: exit 3, `gave-up` in the crash log, and a diag zip
  - the launcher's own stop is not a crash; a host exit with code 0 ends the session without a restart

## Not checked / UNVERIFIED

- Real-host crash restart. Force-killing `ujwalam-host.exe` during the installed run was refused by the session's permission guard, because a kill by image name could hit another host. Only the fake host proves the restart path.
- Recording resumes in a new mkv with the real host. The mock run has no record sink without `--live`, and `record.start` making a new stamped file was proven in day 1/2 evidence, not here.
- obs-browser and CEF from the package (`--allow-browser`), and devices (`--allow-devices`), were not run from the install.
- The vendored runtime matching the OBS 32.1.2 tag; FFmpeg GPL or LGPL; Qt modules' licence; CEF credits; the source offer text.
- The GPU preference for the installed exe path (see section 3). `leaks=2` at shutdown was not compared with a dev-tree run.
- nvidia-smi encoder fields on other drivers.
