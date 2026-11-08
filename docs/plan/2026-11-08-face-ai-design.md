# Face AI: background removal, face tracking, face-driven avatar (design, 2026-11-08)

Status: built behind flag `face-ai` (off by default), decision D295 proposed. Measurements:
`docs/evidence/2026-11-08-face-ai.md`. Live use is the user's decision after reading those numbers.

The user's request: "add background removal for facecam and mocap features with facial tracking". Mocap, in the
user's words: the camera follows my face, effects on my face, and an avatar driven by my face from any reference
image ("map the features of the streamer's face, put those features on reference images"). Everything local, no LLM.

## 1. Where the model runs

| | (a) Python sidecar + shared memory (chosen) | (b) onnxruntime inside the C++ host |
|---|---|---|
| Crash | the worker dies; the host's face effects fall back (last mask held 500 ms, faded out over 300 ms, then the plain camera). Stream and recording go on | a crash in ORT or a GPU driver fault inside the host stops stream and recording |
| Stall | a slow model only makes results older; the render thread never waits | inference on the render/graphics thread, or a second thread with its own D3D/DirectML device inside the host process |
| VRAM control | the worker unloads every model when the flag is off or no face effect is shown for 30 s; killing it frees all of it | stays in the host process |
| Build / deps | no new native dependency in the host; Python + onnxruntime-directml already in `.venv-gpu` | ship onnxruntime.dll + DirectML.dll with the host, new CMake deps |
| Cost | one GPU readback of a <= 640x360 frame per analysed frame (staged with a D3D11 event query, mapped only once the copy is done: no stall) + one R8 texture upload of the mask | no readback when the model reads the texture directly (needs D3D11 interop: more code) |
| Latency | 50 ms end to end (host render of the analysed frame to the result back in the host), 29.4 results/s, +0.15 ms host frame time, +72 MB VRAM, next to a 1080p60 NVENC recording (evidence file) | lower by the readback (2 ticks) and IPC (sub-millisecond) |

The sidecar is enough: the models run in 2.5 to 17 ms (section 3), well inside a 33 ms analysis budget, and the IPC
adds no measurable cost on the render thread (evidence: host frame time with and without the worker). Option (b) is
not needed and was not built.

## 2. Frame flow, timing and threading

```
camera source (shared, own size)                                       app/host/src/face.cpp (graphics thread)
  -> tick: if a face filter used it in the last second, the worker's heartbeat is < 2 s old and something is wanted
     -> render the source into a texture that fits 640x360 (aspect kept), copy to 1 of 4 staging surfaces + event query
     -> map it once the query says the copy is done, copy into the frame slot (seqlock) with the target generation,
        remember (seq, generation, capture time, size) in a 32-frame ring; at most 30 per second
shared memory  Local\ujwalam-face-<host pid>  (owner-only DACL; host creates, fails closed if the name exists;
               layout v2 carries the per-launch link key: the worker opens it only with the right key and owner)
  header 4 KiB | frame BGRA 640x360 | mask u8 640x360 | 468 x 3 float landmarks
face worker (services/face/face_worker.py, below-normal priority, no token, no camera, no network code, allowlisted
             env; host pid + link key on its stdin from the launcher; models loaded only from SHA-256-verified bytes)
  -> poll 4 ms for a new frame seq; run what the host wants: 1 = mask (segmentation), 2 = landmarks (tracker)
  -> mask: model at 256x144 (selfie) -> guided upsample to the frame -> temporal EMA (personMask smoothing)
  -> landmarks: YuNet detect (only when tracking is lost) -> 192x192 face mesh, rotated ROI from the eyes -> One Euro
  -> write result (seqlock): mask, landmarks, face box, score, roll/yaw/pitch, blinks, mouth, brows, infer ms
host tick: copy a new result out (acquire seqlock, torn snapshots skipped); use it only for a frame in the ring,
newer than the last, of the current generation, and only when validate() passes (finite, bounded, exact landmark
count, mask size = frame size); upload the mask (R8 dynamic texture) only for a new valid mask; freshness = the
host's own capture time of that frame (review fixes: docs/evidence/2026-11-08-face-ai.md)
face filters (video_render, graphics thread)
  personMask  ujw_person_mask.effect: a = smoothstep(th - f/2, th + f/2, m) faded by staleness; remove / blur / replace
  autoFrame   ujw_face_frame.effect: crop (1/zoom of the layer) eased toward the face, deadzone, 1 s hold
  faceSticker sprite at the eyes / nose / forehead / mouth, width = scale x eye distance, turned with head roll
```

- One camera at a time (the first face filter that draws a source makes it the target; it is released after 1 s
  unused). A second camera with face effects shows plainly. UNVERIFIED need: the user has one facecam.
- The link analyses the shared source at its own size, so the mask fits every layer that shows that source (each
  layer's placement crop is mapped in the shader). Face effects should come first in a layer's effect list.
- Heartbeats both ways: the worker closes the link when the host heartbeat is older than 3 s; the host stops sending
  frames when the worker heartbeat is older than 2 s.

## 3. Models (all ONNX, all local, manifest `data/models/face-ai.json`, notices in `docs/third-party-notices.md`)

| Model | Use | Licence | Size | Default |
|---|---|---|---|---|
| MediaPipe selfie segmentation (landscape 256x144) | person mask | Apache-2.0 | 0.46 MB | yes |
| MediaPipe selfie segmentation (square 256x256) | person mask | Apache-2.0 | 0.46 MB | |
| MODNet fp16 (512x288) | finer matte (hair) | Apache-2.0 (weights UNVERIFIED) | 13.0 MB | |
| RVM MobileNetV3 (recurrent) | video matte, temporally stable | GPL-3.0 | 15.0 MB | |
| YuNet 2023mar | face detection | MIT | 0.23 MB | yes |
| MediaPipe face mesh 468 | landmarks | Apache-2.0 | 2.7 MB | yes |

Speed (DirectML on the RTX 4050 Laptop, 720p input, while a 1080p60 NVENC recording runs; detail in the evidence
file): selfie-landscape 5.2 ms, selfie-square 7.2 ms, MODNet 16.6 ms, RVM 12.4 ms; face tracker (YuNet + mesh, CPU
because DirectML refuses the mesh graph) 2.5 ms. Default pair: selfie-landscape + face tracker. All are under 5 MB except MODNet and RVM, but
none is committed: the user approved downloads, and the OCR pattern (manifest + fetch + SHA check) keeps the repo
free of binaries.

Not used: MediaPipe face mesh v2 (478 points with irises) and the 52-blendshape model ship only as TFLite inside
`.task` bundles; converting needs `tf2onnx` (an install: ask the user). The avatar and the features use geometric
ratios of the 468 mesh instead (UNVERIFIED on real footage).

## 4. Failure behaviour

| Event | Result |
|---|---|
| flag off | worker idles (re-reads the flag every 5 s), no model loaded, host sends no frame (no worker heartbeat) |
| worker not started / crashed | launcher restarts it at most 5 times (10 s apart); meanwhile every face effect draws the plain layer |
| worker slow (> 500 ms behind) | mask fades out over 300 ms; landmarks count as "no face" (autoFrame holds 1 s then eases out; sticker hides) |
| model load / inference error | worker logs, unloads, backs off (0.5 s doubling to 30 s), reopens |
| DirectML refuses a model | per-model fallback: DML, DML without graph optimisation, then CPU |
| host gone | worker closes the link when the host heartbeat stops; reopens for the next host pid |
| shared memory name taken by another process | host refuses the link (fail closed); face effects draw plainly |

## 5. Avatar from a reference image

Approach A (built as an offline prototype, `services/face/avatar.py`): reference mesh from the face tracker (photo-like
reference) or from about 19 manual anchors through a thin-plate spline (drawing or any image); Delaunay over the mesh
plus border points; driver expression = driver mesh in its own eye frame minus its neutral mesh, added to the
reference mesh; head roll applied as a rotation; piecewise-affine warp; dark mouth fill when the mouth opens. Renders a
recorded or synthetic landmark sequence to video. Known limits: no inside of the mouth or eyes beyond the fill, eye
whites and hair edges tear on large roll/yaw, ~60 to 75 ms per 512x512 frame in Python (a GPU mesh draw in the host
would be needed for live use).

Approach B (LivePortrait-class neural reenactment): paper evaluation only, nothing downloaded. Recalled from public
sources, UNVERIFIED (not checked today): code MIT; the pipeline uses InsightFace detection/landmark models whose
licence is non-commercial (would need replacing with YuNet + our mesh); weights several hundred MB; about 13 ms per
frame on an RTX 4090 in the paper, so likely 40 to 80 ms and 2 to 3 GB VRAM on the 6 GB laptop next to NVENC and game
capture. Not suitable for live use on this laptop; possible for offline clips. A download needs the user's yes.

## 6. Rules kept

Flag `face-ai` off by default; presets are data (registry functions + presets); no camera was opened (synthetic and
recorded frames only); no face image is committed (the evidence strip shows a generated cartoon); the worker gets no
host token; child processes are hidden (`windowsHide`, `CREATE_NO_WINDOW`).

## 7. Follow-ups (not done)

- Qt effect table: a choice field for personMask mode and a file field for its replace image and for faceSticker.
- Camera test with the real facecam (steps in the evidence file; needs the user).
- Live use decision (VRAM and frame time next to NVENC + game capture).
- Avatar as a live layer (GPU mesh warp in the host), blendshapes via tf2onnx (install), LivePortrait download.
