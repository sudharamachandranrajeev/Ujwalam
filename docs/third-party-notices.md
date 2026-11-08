# Third-party notices

Third-party software and model files that Ujwalam uses or would ship. Each entry gives the licence and where it was checked. Publishing rules (what must never be distributed) are in `docs/licence-headers.md`.

The OCR packages below are not bundled: they live in the project-local, gitignored `.venv` (OCR worker, P2) and are pinned in `services/clip/requirements-ocr.lock.txt`. Before any distribution (P17), ship each licence text beside the component and re-check every entry. The Alpha 0 zip (D133) bundles a subset of the OBS runtime; see the next section.

## Alpha 0 package: OBS runtime subset (2026-11-05)

`tools/package/build-alpha.mjs` copies only the OBS runtime files that the host exe and the 14 loaded plugins import (PE import closure). The zip then lists every copied file with its reason in `notices/OBS-RUNTIME-FILES.txt`. Per-file licence mapping goes in `notices/THIRD-PARTY.txt`. The zip also carries the GPL-2.0 text (`notices/GPL-2.0.txt`, from the runtime's `data/obs-studio/license/gplv2.txt`) and a written source offer (`notices/SOURCE-OFFER.txt`). Node.js is not bundled: the user installs it.

| Component | Shipped files | Licence | Status |
|---|---|---|---|
| OBS Studio 32.1.2 (libobs, plugins, helper exes) | `obs.dll`, `libobs-*.dll`, `obs-frontend-api.dll`, 14 plugins, `obs-ffmpeg-mux.exe` and the encoder test exes | GPL-2.0-or-later | The runtime was built from the 32.1.2 tag: UNVERIFIED |
| OBS Studio 32.1.2 obs-nvenc, **modified** (2026-11-06) | `obs-nvenc.dll` (replaces the official file in the runtime; the original is kept in `<runtime>/../runtime-originals/`) | GPL-2.0-or-later | See "Modified OBS file" below |
| w32-pthreads | `w32-pthreads.dll` | LGPL-2.1-or-later (OBS fork of pthreads-win32) | UNVERIFIED |
| FFmpeg (OBS build) | `avcodec`, `avformat`, `avutil`, `avfilter`, `avdevice`, `swresample`, `swscale` | **GPL-3.0-or-later** (verified 2026-11-05: `avcodec-61.dll`'s own build-config string has `--enable-gpl --enable-version3`, no `--enable-nonfree`; see `docs/evidence/2026-11-05-licence-verification.md`) | Verified |
| x264 | `libx264-*.dll` | GPL-2.0-or-later | from obs-deps; build 164 confirmed |
| Qt 6 | `Qt6Core`, `Qt6Gui`, `Qt6Widgets` (obs-browser and obs-frontend-api import them; no Qt plugins ship) | LGPL-3.0-only, version **6.8.3 confirmed** (2026-11-05) | Relinking compliance note: `docs/notices-qt-relinking.md`. LGPL-3.0 + GPL-3.0 texts now checked in at `docs/licenses/`; `tools/package/build-alpha.mjs` still needs to copy them into the zip's `notices/` |
| CEF / Chromium (obs-browser) | `libcef.dll`, `chrome_elf.dll`, `*.pak`, `icudtl.dat`, `v8_context_snapshot.bin`, `libEGL`, `libGLESv2`, `locales/en-US.pak` only | BSD-3-Clause (CEF, verified verbatim) plus Chromium's bundled third-party licences (best-available source, 2026-11-05) | `docs/licenses/CEF-LICENSE.txt` + `CEF-CHROMIUM-CREDITS-source.md`; platform/version caveat and recommended exact-match steps: `docs/evidence/2026-11-05-cef-credits-sourcing.md` |
| zlib, curl, SRT, librist, libdatachannel, LuaJIT | as imported | Zlib; curl (MIT-style); MPL-2.0; BSD-2-Clause; MPL-2.0; MIT | from obs-deps; not re-checked |

Not shipped: Microsoft fonts, `legacy/`, any font file, `.pdb` symbols, disabled modules (obs-websocket, win-capture, rtmp-services, VST and others), Qt plugins, the frontend's data and scripting files, and CEF locales other than en-US. The Visual C++ runtime and `d3dcompiler_47.dll` are not bundled either: they are system prerequisites, and the installer checks the VC++ runtime.

### Modified OBS file: obs-nvenc.dll (2026-11-06)

`obs-nvenc.dll` is not the official OBS binary. It is built from OBS Studio 32.1.2 sources (tag `32.1.2`, commit
`fb4d98bf88fae5fc85cb11fc57f7c5e309282194`) with one upstream change applied: obs-studio commit
`bd96ff53ddfc0787dd7b17344252ff6f6afb31d5` "obs-nvenc: Fix resource destruction order" (2026-02-10, first released
in 32.2.0). Reason: the official 32.1.2 plugin crashes the host on encoder destroy
(`docs/adr/2026-11-05-obs-nvenc-destroy-order.md`, `docs/evidence/2026-11-05-host-shutdown-av.md`). Its version
resource says so in its "Comments" field. It is not signed by the OBS Project (the official file is).

- Licence: GPL-2.0-or-later, the same as the unmodified plugin (OBS Studio `COPYING`).
- Corresponding source: the OBS Studio 32.1.2 tag above, plus the diff `tools/obs-patch/patches/obs-nvenc-bd96ff53dd.diff`
  (byte-identical to the upstream commit's diff; checked by the build script), the build project
  `tools/obs-patch/obs-nvenc/CMakeLists.txt`, the NVIDIA headers `nv-codec-headers` tag `n12.2.72.0` (commit
  `c69278340ab1d5559c7d7bf0edf615dc33ddbba7`, MIT-style licence in its own header files), and the build script
  `tools/obs-patch/build-obs-nvenc.mjs`. Every input and the output SHA-256 are pinned in
  `tools/obs-patch/obs-nvenc.manifest.json`.
- The zip's `notices/SOURCE-OFFER.txt` names this modification and where its source is; the written offer there covers it.
- `tools/package/build-alpha.mjs` refuses to package a runtime whose `obs-nvenc.dll` is not the patched build.
- When the runtime moves to OBS 32.2 or later (the fix is upstream there), drop the patch and this entry.

Before a build goes to anyone other than the user: check each remaining
UNVERIFIED row, confirm the source offer (`docs/plan/2026-10-29-v1-decisions.md`,
D133). **Resolved 2026-11-05:** the LICENSE vs FFmpeg conflict (now
GPL-3.0-or-later project-wide) and CEF/Chromium credits (best-available
source checked in, platform/version caveat documented) — see
`docs/evidence/2026-11-05-licence-verification.md` and
`docs/evidence/2026-11-05-cef-credits-sourcing.md`.

## OCR worker (P2a A5, installed 2026-10-27)

| Component | Version | Licence | Checked against |
|---|---|---|---|
| RapidOCR (`rapidocr`) | 3.10.0 | Apache-2.0 | wheel metadata `License-Expression: Apache-2.0`; `rapidocr-3.10.0.dist-info/licenses/LICENSE` (Apache License 2.0, "Copyright (c) 2021 RapidOCR Authors") |
| ONNX Runtime (`onnxruntime`, CPU build) | 1.31.1 | MIT | wheel metadata `License: MIT License`; the package also carries `ThirdPartyNotices.txt`, which must ship with it |
| OpenCV (`opencv-python-headless`) | 5.0.0.93 | Apache-2.0 (OpenCV); the wheel also bundles FFmpeg (`opencv_videoio_ffmpeg500_64.dll`, LGPL) and other libraries | wheel metadata `License: Apache 2.0`; `LICENSE.txt` and `LICENSE-3RD-PARTY.txt` ("FFmpeg is redistributed within all opencv-python packages") |
| NumPy (`numpy`) | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | wheel metadata `License-Expression` |

Transitive packages pinned in the lockfile (pillow, shapely, pyclipper, omegaconf, PyYAML, protobuf, flatbuffers, requests and its dependencies, tqdm, colorlog, colorama, six, packaging): licences not reviewed yet. UNVERIFIED; review before distribution.

### OCR models (PaddleOCR, converted to ONNX by RapidOCR)

The three default models ship inside the `rapidocr==3.10.0` wheel (`rapidocr/models/`, listed in the wheel's `RECORD`). Nothing was downloaded at first use. Copyright in the weights: Baidu and/or the PaddleOCR rights holders; ONNX conversion and packaging: RapidOCR Authors.

| File | Upstream model | SHA-256 | Source URL (RapidOCR registry, `default_models.yaml`) | Licence |
|---|---|---|---|---|
| `PP-OCRv6_det_small.onnx` (9,929,594 B) | PP-OCRv6_small_det | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` | https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx | Apache-2.0 |
| `PP-OCRv6_rec_small.onnx` (21,234,383 B) | PP-OCRv6_small_rec | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` | https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx | Apache-2.0 |
| `ch_ppocr_mobile_v2.0_cls_mobile.onnx` (585,532 B) | ch_ppocr_mobile_v2.0_cls | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` | https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx | Apache-2.0 |

Licence evidence (checked 2026-10-27):
- `rapidocr-3.10.0.dist-info/licenses/MODEL_LICENSES.md`: all three artifacts are Apache-2.0, with the same SHA-256 values as above.
- Hugging Face model cards `PaddlePaddle/PP-OCRv6_small_det_onnx` and `PaddlePaddle/PP-OCRv6_small_rec_onnx`: licence field `apache-2.0`.
- PaddleOCR repository `LICENSE`: Apache License, Version 2.0.
- The legacy `ch_ppocr_mobile_v2.0_cls` model has no Hugging Face card; its licence rests on the PaddleOCR repository licence and RapidOCR's notice.

Redistribution (Apache-2.0 section 4): include the Apache-2.0 text, keep the attribution, and mark the files as converted. RapidOCR's suggested notice: "Converted from an official PaddleOCR model to the indicated inference format and packaged for use with RapidOCR. The upstream model weights are copyright Baidu and/or the applicable PaddleOCR rights holders and are licensed under the Apache License, Version 2.0." No upstream `NOTICE` file was identified for these models.

### Face AI models (flag face-ai, D295 proposed)

Manifest: `data/models/face-ai.json` (committed). Files: fetched by `services/face/fetch_models.py` into `data/models/face/` (gitignored, SHA-256 checked); none is committed or shipped yet. Runtime: `onnxruntime-directml` 1.24.4 (MIT) and OpenCV in the project's `.venv-gpu`. Checked 2026-11-08.

| id (default) | File (bytes) | SHA-256 | Source | Licence |
|---|---|---|---|---|
| selfie-landscape (yes) | `selfie_segmentation_landscape.onnx` (462,338) | `7a0adcfdb1715d3b0ff0f61486d8a181c33f4a208343a5abfccbc6540e872d24` | Hugging Face `onnx-community`, rev `2497d5bec26c626c7b3c4edc6e1fefc21b64f6c3` (MediaPipe selfie segmentation, converted) | Apache-2.0 |
| selfie-square | `selfie_segmentation.onnx` (462,352) | `3241ac4ad8aa35bdaf33946776db29f7c283a413aa0b0dacb9483594b4531aad` | Hugging Face `onnx-community`, rev `be49485c8e027524be38591817fc5cd31bd9d00e` | Apache-2.0 |
| modnet-fp16 | `modnet_fp16.onnx` (12,984,781) | `25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6` | Hugging Face `Xenova/modnet`, rev `fa2fa546052fba4c08921230a26cc69a333fca12` | Apache-2.0 (repo); weights licence UNVERIFIED |
| rvm-mobilenetv3 | `rvm_mobilenetv3_fp32.onnx` (14,975,696) | `88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828` | GitHub `PeterL1n/RobustVideoMatting` release v1.0.0 | GPL-3.0 (compatible with this project; bench only) |
| yunet (yes) | `face_detection_yunet_2023mar.onnx` (232,589) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | Hugging Face `opencv/face_detection_yunet`, rev `3cc26e7f1014a5ee5d74a42acee58bafc9d0a310` | MIT (repo `LICENSE` SHA-256 `c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958`) |
| facemesh-468 (yes) | `face_landmark_detector.onnx` (312,873) + `face_landmark_detector.data` (2,396,848, SHA-256 `7b4be428f66b16768aecb31954848ec9512eb444f13eaf6fc4690acc981d9732`) | `ebd4d22b162cfb3f8113fa48908859a4413c45a82a9ae0bd8a1e5a56f1fb9c5f` | Qualcomm AI Hub `mediapipe_face-onnx-float.zip` v0.66.0 (2,605,273 B, SHA-256 `f6d60fdf53ccf6fa2ce1f3b103fcc468b6860b4e707223a0a6d6733b35e0c630`); MediaPipe face mesh via MediaPipePyTorch | Apache-2.0 |

Redistribution: not done yet. Before any model ships (installer, P17): include the Apache-2.0 / MIT texts and attribution; a GPL-3.0 model (RVM) only with this GPL-3.0 project's source offer. Test image used locally only (never committed): NASA astronaut photo (public domain) from scikit-image v0.24.0, SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`.
