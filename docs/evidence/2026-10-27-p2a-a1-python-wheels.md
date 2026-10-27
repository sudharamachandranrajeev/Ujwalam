# 2026-10-27 — P2a A1: Windows wheel check for Python 3.14.7

Read only. Nothing was installed or downloaded. Source: the PyPI JSON API (`https://pypi.org/pypi/<package>/json`), latest release of each package, checked on 2026-10-27. Interpreter: `C:\Python314\python.exe`, Python 3.14.7.

The check accepts a wheel when it is a standard `cp314-cp314-win_amd64` build, a stable-ABI `abi3` build for Windows, or a pure `py3-none-any` wheel. Free-threaded `cp314t` builds do not count.

| Package | Version | Windows wheel for 3.14 | Use |
|---|---|---|---|
| onnxruntime | 1.31.1 | yes, `cp314-cp314-win_amd64` | ONNX inference (CPU) |
| onnxruntime-gpu | 1.31.1 | yes, `cp314-cp314-win_amd64` | ONNX inference (CUDA) |
| onnxruntime-directml | 1.24.4 | yes, `cp314-cp314-win_amd64` | ONNX inference (DirectML fallback, D1) |
| faster-whisper | 1.2.1 | yes, pure | Speech to text |
| ctranslate2 | 4.8.4 | yes, `cp314-cp314-win_amd64` | faster-whisper backend |
| av | 19.0.2 | yes, `cp312-abi3` | faster-whisper audio decode |
| tokenizers | 0.23.3 | yes, `cp310-abi3` | faster-whisper |
| pywhispercpp | 1.5.1 | yes, `cp314-cp314-win_amd64` | whisper.cpp bindings (alternative) |
| paddleocr | 3.7.0 | yes, pure | OCR front end |
| **paddlepaddle** | 3.3.1 | **no** (cp39–cp313 only) | PaddleOCR's runtime |
| **paddlepaddle-gpu** | 2.6.2 | **no** (cp38–cp312 only) | PaddleOCR's runtime (GPU) |
| rapidocr | 3.10.0 | yes, pure (`<4,>=3.8`) | PaddleOCR models run through ONNX Runtime |
| opencv-python-headless | 5.0.0.93 | yes, `cp37-abi3` | Frame and ROI processing |
| numpy | 2.5.4 | yes, `cp314-cp314-win_amd64` | |

Not checked: wheels on Paddle's own package index (not PyPI). UNVERIFIED.

## Result

- **Speech to text:** works on 3.14 (faster-whisper + ctranslate2, or pywhispercpp).
- **ONNX:** works on 3.14 (CPU, CUDA and DirectML builds).
- **OCR:** PaddleOCR's own runtime (paddlepaddle) has no 3.14 Windows wheel. There are two ways round it:
  - **a) RapidOCR on 3.14:** it runs the PaddleOCR detection and recognition models as ONNX through onnxruntime. It needs no paddlepaddle and fits the ONNX-first stack.
  - **b) A project-local 3.12 venv** for paddlepaddle.
## Decision (user, 2026-10-27)

OCR: **a) RapidOCR on Python 3.14**, under these conditions:

- Pin the version in the lockfile. Record the model files used (name, version, SHA-256) in `docs/evidence`.
- Confirm the licences of RapidOCR and of the models, and note them in the licence notices. PyPI metadata (2026-10-27) declares rapidocr `Apache-2.0` and onnxruntime `MIT License`. The model licences are checked against their sources at install (UNVERIFIED until then).
- Accuracy gate at P2: test on real crops from the clips corpus (medal banners, MVP/Impact Play text, kill feed, the user's IGN), with accuracy reported per detector.
- If accuracy is too low and the cause is the runtime rather than the models, propose option b (a project-local 3.12 env for paddlepaddle) with evidence. Do not set it up without approval.
- No paddlepaddle install now. RapidOCR itself is installed only when the work needs it, after a short confirmation.

## Notes

- CUDA runtime libraries (cuBLAS, cuDNN) for onnxruntime-gpu and ctranslate2 are not checked here. They are checked when the models are set up, with the user's approval.
