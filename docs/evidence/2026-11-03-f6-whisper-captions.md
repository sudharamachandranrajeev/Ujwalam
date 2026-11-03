# F6 captions: faster-whisper on CPU — install and plumbing evidence (2026-11-03)

Status: plumbing PASS. Caption quality on real speech (Malayalam, Manglish, English) **UNVERIFIED**.

## Approval

User, 2026-11-03: "Install faster-whisper into the project .venv with the small multilingual model ... mark caption quality as unverified until you've checked it on real speech. Also run it on CPU during the soak so it doesn't touch the GPU hold."

## Install

- Target: project `.venv` (Python 3.14.7, Windows x64). Nothing installed system-wide.
- Lock: `services/clip/requirements-whisper.lock.txt`, 24 packages with SHA-256 hashes.
  `python -m pip install --require-hashes --dry-run -r services/clip/requirements-whisper.lock.txt` → rc 0. `pip check` → no broken requirements.
- Key versions: faster-whisper 1.2.1, ctranslate2 4.8.5, av 18.0.0, tokenizers 0.23.3, huggingface_hub 2.4.0, onnxruntime 1.31.1 (Silero VAD).
- `av` is pinned to 18.0.0. With av 19, faster-whisper 1.2.1 fails on load: `TypeError: open() got an unexpected keyword argument 'metadata_errors'`.

## Model

faster-whisper `small` (CTranslate2 conversion of OpenAI Whisper small, multilingual). It is stored outside the repo in `<models-dir>/faster-whisper-small` and passed with `--whisper-model`. It loads with `local_files_only=True`, so there is no network access at run time.

| File | Bytes | SHA-256 |
|---|---|---|
| config.json | 2370 | b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828 |
| model.bin | 483546902 | 3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671 |
| tokenizer.json | 2203239 | fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab |
| vocabulary.txt | 459861 | 34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913 |

## Licences

- faster-whisper: MIT. CTranslate2: MIT. Whisper weights (OpenAI): MIT.
- PyAV: BSD-3-Clause. Its wheel bundles LGPL FFmpeg libraries.
- tokenizers, huggingface_hub: Apache-2.0. onnxruntime: MIT.
- All of these are installed into the local venv only and are not redistributed. If the clip worker is ever shipped in the zip, add the notices to the licence bundle first (open item, see handover).

## Plumbing run

- Backend `faster-whisper`, `device=cpu`, `compute_type=int8`, `cpu_threads=4` (the defaults in `services/clip/clip_captions.py`). The GPU is not touched (D100 hold).
- Input: a synthetic TTS English sample, "Clip it. That was a clean triple kill on the last round."
- Output: exact transcript, detected language en with probability 1.0, 5.1 s wall time.
- `npm run test:py`: 177 tests run, OK (16 skipped, all of them device-, ffmpeg- or model-dependent).

## Not verified

- Accuracy on real stream speech: Malayalam, Manglish code-switching, game noise, and music. To check after the first real stream, with the user reviewing captions.
- Speed on a full-length stream on CPU while other jobs run.
