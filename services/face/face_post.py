# SPDX-License-Identifier: GPL-3.0-or-later
"""Face AI post-processing: pure numpy / OpenCV maths, no model and no I/O (docs/plan/2026-11-08-face-ai-design.md).

  - mask upscaling (fast guided filter, edges follow the camera picture) and temporal smoothing
  - the personMask threshold / feather curve (the host shader ujw_person_mask.effect computes the same)
  - One Euro filter for landmark jitter
  - autoFrame crop maths (zoom, deadzone, ease); the host (app/host/src/effects.cpp, face_frame) is a C++ twin of
    autoframe_target / ease_rect and must keep the same results
  - face features from 468 MediaPipe face-mesh landmarks: head roll / yaw / pitch, blinks, mouth, brows
  - faceSticker anchors (eyes, nose, forehead, mouth) with scale and rotation

All coordinates are normalised to the analysed frame (0..1, y down) unless a name says px.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

# MediaPipe face mesh (468) indices used here. "Left"/"right" are the subject's own sides (image right = subject left).
R_EYE_OUTER, R_EYE_INNER, R_EYE_UP, R_EYE_LOW = 33, 133, 159, 145
L_EYE_OUTER, L_EYE_INNER, L_EYE_UP, L_EYE_LOW = 263, 362, 386, 374
NOSE_TIP, FOREHEAD, CHIN = 1, 10, 152
MOUTH_L, MOUTH_R, LIP_UP_IN, LIP_LOW_IN = 291, 61, 13, 14
R_BROW, L_BROW = 105, 334


# ---------------------------------------------------------------------------------------------------- masks


def guided_upsample(alpha, guide, radius=4, eps=1e-3):
    """Upscale a low-resolution matte `alpha` (float 0..1) to the size of `guide` (uint8 gray or BGR(A)) with a fast
    guided filter (He, Sun 2015): the edges follow the picture instead of the model's coarse grid. Returns float32
    0..1 at the guide's size."""
    if guide.ndim == 3:
        guide = cv2.cvtColor(guide, cv2.COLOR_BGRA2GRAY if guide.shape[2] == 4 else cv2.COLOR_BGR2GRAY)
    h, w = guide.shape[:2]
    I = guide.astype(np.float32) / 255.0
    p = cv2.resize(alpha.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    k = (2 * radius + 1, 2 * radius + 1)
    mean_I = cv2.boxFilter(I, -1, k)
    mean_p = cv2.boxFilter(p, -1, k)
    cov_Ip = cv2.boxFilter(I * p, -1, k) - mean_I * mean_p
    var_I = cv2.boxFilter(I * I, -1, k) - mean_I * mean_I
    a = cov_Ip / (var_I + eps)
    b = mean_p - a * mean_I
    q = cv2.boxFilter(a, -1, k) * I + cv2.boxFilter(b, -1, k)
    return np.clip(q, 0.0, 1.0)


class MaskSmoother:
    """Exponential moving average over masks: out = s * previous + (1 - s) * new, s = smoothing 0..0.95. A new size
    or reset() starts again from the next mask. Lower flicker, slower edges on fast motion."""

    def __init__(self, smoothing=0.0):
        self.smoothing = smoothing
        self.prev = None

    def reset(self):
        self.prev = None

    def __call__(self, mask):
        s = float(min(max(self.smoothing, 0.0), 0.95))
        m = mask.astype(np.float32)
        if self.prev is None or self.prev.shape != m.shape or s <= 0:
            self.prev = m
        else:
            self.prev = s * self.prev + (1.0 - s) * m
        return self.prev


def mask_curve(m, threshold=0.5, feather=0.1):
    """The personMask alpha for matte values m: smoothstep(threshold - feather / 2, threshold + feather / 2, m).
    feather 0 is a hard cut (kept at least 1e-3 wide). Same as ujw_person_mask.effect."""
    f = max(float(feather), 1e-3)
    lo, hi = threshold - f / 2.0, threshold + f / 2.0
    t = np.clip((np.asarray(m, np.float32) - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def to_u8(mask):
    return np.clip(np.rint(np.asarray(mask, np.float32) * 255.0), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------------------------------- One Euro


class OneEuro:
    """One Euro filter (Casiez, Roussel, Vogel 2012) on arrays of any shape: little jitter when still, little lag when
    moving. min_cutoff in Hz, beta = speed coefficient, d_cutoff for the derivative."""

    def __init__(self, min_cutoff=1.5, beta=0.3, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = None
        self.dx = None
        self.t = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def reset(self):
        self.x = self.dx = self.t = None

    def __call__(self, x, t):
        x = np.asarray(x, np.float64)
        if self.x is None or self.x.shape != x.shape or t <= self.t:
            self.x, self.dx, self.t = x.copy(), np.zeros_like(x), t
            return self.x.copy()
        dt = t - self.t
        self.t = t
        dx = (x - self.x) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        self.dx = a_d * dx + (1 - a_d) * self.dx
        cutoff = self.min_cutoff + self.beta * np.abs(self.dx)
        a = 1.0 / (1.0 + (1.0 / (2.0 * math.pi * cutoff)) / dt)
        self.x = a * x + (1 - a) * self.x
        return self.x.copy()


# ---------------------------------------------------------------------------------------------------- autoFrame


def autoframe_target(face, zoom, deadzone, aspect, prev_center=None):
    """Crop rectangle (x, y, w, h, normalised to the frame) that keeps the face centred.

    face: (cx, cy, size) of the face, normalised (size = face box height share of the frame). zoom 1..4: the crop's
    height is 1 / zoom of the frame (zoom 1 = whole frame). aspect: the crop keeps the frame's own aspect, so
    `aspect` = frame w / h only scales x. deadzone 0..0.5: the crop centre moves only when the face leaves a box of
    that share of the crop around the previous centre (no hunting on small head moves). The crop never leaves the
    frame. No face: None (the caller eases back to the whole frame)."""
    del aspect  # same aspect as the frame: normalised w == h
    if face is None:
        return None
    z = min(max(float(zoom), 1.0), 4.0)
    w = h = 1.0 / z
    cx, cy = float(face[0]), float(face[1])
    if prev_center is not None and deadzone > 0:
        px, py = prev_center
        dzx, dzy = deadzone * w, deadzone * h
        nx = px if abs(cx - px) <= dzx else cx - math.copysign(dzx, cx - px)
        ny = py if abs(cy - py) <= dzy else cy - math.copysign(dzy, cy - py)
        cx, cy = nx, ny
    x = min(max(cx - w / 2.0, 0.0), 1.0 - w)
    y = min(max(cy - h / 2.0, 0.0), 1.0 - h)
    return (x, y, w, h)


def ease_rect(cur, target, dt, tau):
    """Exponential ease of rectangle cur toward target: k = 1 - exp(-dt / tau); tau <= 0 jumps."""
    if tau <= 0:
        return tuple(target)
    k = 1.0 - math.exp(-max(dt, 0.0) / tau)
    return tuple(c + (t - c) * k for c, t in zip(cur, target))


FULL_FRAME = (0.0, 0.0, 1.0, 1.0)


class AutoFrame:
    """autoFrame state machine as the host runs it: target from the face (with deadzone), eased with
    tau = smoothing seconds; no face for `hold` seconds eases back to the whole frame."""

    def __init__(self, zoom=1.6, smoothing=0.5, deadzone=0.1, hold=1.0):
        self.zoom, self.smoothing, self.deadzone, self.hold = zoom, smoothing, deadzone, hold
        self.rect = FULL_FRAME
        self.center = None
        self.last_face_t = None

    def step(self, face, t, dt):
        if face is not None:
            self.last_face_t = t
            tgt = autoframe_target(face, self.zoom, self.deadzone, 1.0, self.center)
            self.center = (tgt[0] + tgt[2] / 2.0, tgt[1] + tgt[3] / 2.0)
        elif self.last_face_t is None or t - self.last_face_t > self.hold:
            tgt, self.center = FULL_FRAME, None
        else:
            tgt = self.rect
        self.rect = ease_rect(self.rect, tgt, dt, self.smoothing)
        return self.rect


# ---------------------------------------------------------------------------------------------------- face features


def face_box(lm):
    """(cx, cy, size) of landmarks lm [N, 2+] (normalised): centre of the box and its height."""
    xy = np.asarray(lm)[:, :2]
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    return (float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), float(hi[1] - lo[1]))


def _d(a, b):
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


def face_features(lm_px):
    """Head pose and expression from 468 landmarks in PIXELS (x, y[, z]); pixel units keep the frame's aspect.

    Returns dict: roll (degrees, + = head tilted to the image's clockwise), yaw (-1..1, + = nose toward image right),
    pitch (-1..1, + = nose down), blinkL / blinkR (0 open .. 1 closed), mouth (0 closed .. 1 wide open),
    brows (0 rest .. 1 raised), eyeDist (px). Ratios are tuned for the MediaPipe mesh; UNVERIFIED on real footage."""
    p = np.asarray(lm_px, np.float64)
    re = (p[R_EYE_OUTER, :2] + p[R_EYE_INNER, :2]) / 2
    le = (p[L_EYE_OUTER, :2] + p[L_EYE_INNER, :2]) / 2
    eye = _d(re, le) or 1e-6
    roll = math.degrees(math.atan2(le[1] - re[1], le[0] - re[0]))
    mid = (re + le) / 2
    # nose offset from the eye midpoint, in the face's own frame (roll removed)
    c, s = math.cos(math.radians(-roll)), math.sin(math.radians(-roll))
    v = p[NOSE_TIP, :2] - mid
    vx, vy = c * v[0] - s * v[1], s * v[0] + c * v[1]
    yaw = float(np.clip(vx / (0.5 * eye), -1, 1))
    pitch = float(np.clip((vy / eye - 0.55) / 0.35, -1, 1))  # ~0.55 eye distances below the eyes at rest

    def ear(up, low, a, b):  # eye openness: lid gap / eye width
        return _d(p[up], p[low]) / (_d(p[a], p[b]) or 1e-6)

    def blink(r):
        return float(np.clip((0.28 - r) / (0.28 - 0.08), 0, 1))  # open ~0.28, closed ~0.08

    mouth = _d(p[LIP_UP_IN], p[LIP_LOW_IN]) / (_d(p[MOUTH_L], p[MOUTH_R]) or 1e-6)
    brow = ((_d(p[R_BROW], re) + _d(p[L_BROW], le)) / 2) / eye
    return {
        "roll": roll,
        "yaw": yaw,
        "pitch": pitch,
        "blinkR": blink(ear(R_EYE_UP, R_EYE_LOW, R_EYE_OUTER, R_EYE_INNER)),
        "blinkL": blink(ear(L_EYE_UP, L_EYE_LOW, L_EYE_OUTER, L_EYE_INNER)),
        "mouth": float(np.clip(mouth / 0.6, 0, 1)),
        "brows": float(np.clip((brow - 0.38) / 0.15, 0, 1)),
        "eyeDist": eye,
    }


ANCHORS = ("eyes", "nose", "forehead", "mouth")


def sticker_transform(lm_px, anchor="eyes", scale=1.0, offset=(0.0, 0.0)):
    """Where a faceSticker goes: (cx, cy, width, angle_degrees) in pixels. width = scale x the distance between the
    eye centres; offset (dx, dy) is in eye distances in the face's own frame (dy + = down the face). The sticker
    turns with the head (roll)."""
    p = np.asarray(lm_px, np.float64)
    re = (p[R_EYE_OUTER, :2] + p[R_EYE_INNER, :2]) / 2
    le = (p[L_EYE_OUTER, :2] + p[L_EYE_INNER, :2]) / 2
    eye = _d(re, le)
    roll = math.degrees(math.atan2(le[1] - re[1], le[0] - re[0]))
    if anchor == "eyes":
        a = (re + le) / 2
    elif anchor == "nose":
        a = p[NOSE_TIP, :2]
    elif anchor == "forehead":
        a = p[FOREHEAD, :2]
    elif anchor == "mouth":
        a = (p[LIP_UP_IN, :2] + p[LIP_LOW_IN, :2]) / 2
    else:
        raise ValueError(f"anchor must be one of {ANCHORS}")
    c, s = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    dx, dy = offset[0] * eye, offset[1] * eye
    return (float(a[0] + c * dx - s * dy), float(a[1] + s * dx + c * dy), float(scale * eye), roll)
