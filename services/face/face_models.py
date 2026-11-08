# SPDX-License-Identifier: GPL-3.0-or-later
"""Face AI model runners (onnxruntime; DirectML on the GPU when the runtime has it, else CPU).

Models and their SHA-256 are in data/models/face-ai.json; services/face/fetch_models.py puts them in data/models/face/.

  Segmenter(id)      person matte for a BGR(A) frame -> float32 0..1 at the model's size (or the frame's for RVM)
  FaceTracker()      YuNet face box (OpenCV, CPU) + MediaPipe 468-point mesh (onnxruntime) on a rotated face crop;
                     after the first hit it tracks from the previous mesh and runs the detector only when the mesh
                     score drops (MediaPipe's own scheme)

No camera is opened here: callers pass frames (from the host's shared memory, a file or a synthetic picture).
"""

from __future__ import annotations

import math
import os
import time

import cv2
import numpy as np

import fetch_models

try:
    import onnxruntime as ort
except ImportError:  # pragma: no cover - the venv without onnxruntime cannot run models
    ort = None

_MAN = fetch_models.load_manifest()
MODELS = {m["id"]: m for m in _MAN["models"]}
MODELS_DIR = fetch_models.models_dir(_MAN)


def model_path(mid):
    return os.path.join(MODELS_DIR, MODELS[mid]["file"])


def providers(gpu=True):
    have = ort.get_available_providers() if ort else []
    if gpu and "DmlExecutionProvider" in have:
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


FALLBACKS = []  # (model id, reason) for every model that could not run on DirectML


def _options(threads, dml, optimize=True):
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    so.log_severity_level = 4
    # no busy-waiting worker threads: at 30 fps they would burn a core each between frames
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    so.add_session_config_entry("session.inter_op.allow_spinning", "0")
    if dml:  # DirectML wants these off (onnxruntime DirectML docs)
        so.enable_mem_pattern = False
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    if not optimize:
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    return so


def session(mid, gpu=True, threads=2):
    """An onnxruntime session for model `mid`: DirectML first (when asked and available), then DirectML without graph
    optimisations, then CPU. A model that cannot run on DirectML is noted in FALLBACKS."""
    p = model_path(mid)
    if not os.path.isfile(p):
        raise FileNotFoundError(f"{mid}: {p} missing (run services/face/fetch_models.py)")
    prov = providers(gpu)
    if prov[0] == "DmlExecutionProvider":
        err = None
        for optimize in (True, False):
            try:
                return ort.InferenceSession(p, sess_options=_options(threads, True, optimize), providers=prov)
            except Exception as e:  # noqa: BLE001 - DirectML refuses some graphs at init; CPU below
                err = e
        FALLBACKS.append((mid, str(err).splitlines()[0][-160:]))
    return ort.InferenceSession(p, sess_options=_options(threads, False), providers=["CPUExecutionProvider"])


def _rgb01(frame, w, h):
    """BGR(A) uint8 -> RGB float32 NCHW 0..1 at w x h."""
    if frame.ndim == 3 and frame.shape[2] == 4:
        frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
    img = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return np.ascontiguousarray(img.transpose(2, 0, 1)[None])


class Segmenter:
    """Person matte. ids: selfie-landscape (256x144), selfie-square (256x256), modnet-fp16 (512x288),
    rvm-mobilenetv3 (frame size, recurrent: keeps state between calls; reset() after a cut)."""

    SIZES = {"selfie-landscape": (256, 144), "selfie-square": (256, 256), "modnet-fp16": (512, 288)}

    def __init__(self, mid="selfie-landscape", gpu=True):
        if MODELS.get(mid, {}).get("role") != "segmentation":
            raise ValueError(f"not a segmentation model: {mid}")
        self.id = mid
        self.sess = session(mid, gpu)
        self.provider = self.sess.get_providers()[0]
        self.inp = self.sess.get_inputs()[0].name
        self.rec = None
        self.reset()

    def reset(self):
        self.rec = [np.zeros((1, 1, 1, 1), np.float32)] * 4

    def __call__(self, frame):
        if self.id == "rvm-mobilenetv3":
            h, w = frame.shape[:2]
            x = _rgb01(frame, w, h)
            ratio = np.array([min(1.0, 256.0 / max(w, h))], np.float32)
            out = self.sess.run(None, {"src": x, "r1i": self.rec[0], "r2i": self.rec[1], "r3i": self.rec[2],
                                       "r4i": self.rec[3], "downsample_ratio": ratio})
            self.rec = out[2:6]
            return out[1][0, 0]
        w, h = self.SIZES[self.id]
        x = _rgb01(frame, w, h)
        if self.id == "modnet-fp16":
            x = (x - 0.5) / 0.5
        return self.sess.run(None, {self.inp: x})[0][0, 0]


class FaceTracker:
    """Face box + 468-point mesh. __call__(frame) -> (landmarks px [468, 3] or None, score)."""

    CROP = 192

    def __init__(self, gpu=True, min_score=0.5):
        self.det = cv2.FaceDetectorYN.create(model_path("yunet"), "", (320, 320), 0.6, 0.3, 50)
        self.sess = session("facemesh-468", gpu)
        self.provider = self.sess.get_providers()[0]
        self.min_score = min_score
        self.prev = None  # last mesh, px
        self.det_size = None
        self.detector_runs = 0

    def reset(self):
        self.prev = None

    def detect(self, bgr):
        """YuNet on a <= 320 px wide copy. Returns (cx, cy, size, angle) of the biggest face in px, or None."""
        h, w = bgr.shape[:2]
        k = min(1.0, 320.0 / w)
        small = cv2.resize(bgr, (max(1, int(w * k)), max(1, int(h * k)))) if k < 1 else bgr
        if self.det_size != small.shape[:2]:
            self.det.setInputSize((small.shape[1], small.shape[0]))
            self.det_size = small.shape[:2]
        self.detector_runs += 1
        _, faces = self.det.detect(small)
        if faces is None or len(faces) == 0:
            return None
        f = max(faces, key=lambda r: r[2] * r[3]) / k
        x, y, bw, bh = f[:4]
        rex, rey, lex, ley = f[4], f[5], f[6], f[7]  # YuNet: right eye (image left) first
        ang = math.degrees(math.atan2(ley - rey, lex - rex))
        return (x + bw / 2, y + bh / 2, max(bw, bh) * 1.5, ang)

    @staticmethod
    def roi_from_mesh(lm):
        xy = lm[:, :2]
        lo, hi = xy.min(axis=0), xy.max(axis=0)
        r, l = lm[33, :2], lm[263, :2]
        ang = math.degrees(math.atan2(l[1] - r[1], l[0] - r[0]))
        return ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, max(hi - lo) * 1.5, ang)

    def mesh(self, bgr, roi):
        cx, cy, size, ang = roi
        s = self.CROP / max(size, 1.0)
        M = cv2.getRotationMatrix2D((cx, cy), ang, s)
        M[0, 2] += self.CROP / 2 - cx
        M[1, 2] += self.CROP / 2 - cy
        crop = cv2.warpAffine(bgr, M, (self.CROP, self.CROP), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        x = _rgb01(crop, self.CROP, self.CROP)
        score, lm = self.sess.run(None, {"image": x})
        lm = lm[0].astype(np.float64)
        if lm[:, :2].max() <= 2.0:  # normalised output: to crop px
            lm = lm * self.CROP
        Mi = cv2.invertAffineTransform(M)
        xy = lm[:, :2] @ Mi[:, :2].T + Mi[:, 2]
        z = lm[:, 2:3] / s
        return np.hstack([xy, z]), float(np.ravel(score)[0])

    def __call__(self, frame):
        bgr = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR) if frame.ndim == 3 and frame.shape[2] == 4 else frame
        if self.prev is not None:
            lm, sc = self.mesh(bgr, self.roi_from_mesh(self.prev))
            if sc >= self.min_score:
                self.prev = lm
                return lm, sc
        roi = self.detect(bgr)
        if roi is None:
            self.prev = None
            return None, 0.0
        lm, sc = self.mesh(bgr, roi)
        self.prev = lm if sc >= self.min_score else None
        return (lm, sc) if sc >= self.min_score else (None, sc)


def timed(fn, *a):
    t = time.perf_counter()
    r = fn(*a)
    return r, (time.perf_counter() - t) * 1000.0
