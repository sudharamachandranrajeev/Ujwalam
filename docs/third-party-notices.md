# Third-party notices

Third-party software and model files that Ujwalam uses or would ship. Each entry gives the licence and where it was checked. Publishing rules (what must never be distributed) are in `docs/licence-headers.md`.

Nothing here is bundled yet: these packages live in the project-local, gitignored `.venv` (OCR worker, P2) and are pinned in `services/clip/requirements-ocr.lock.txt`. Before any distribution (P17), ship each licence text beside the component and re-check every entry.

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
