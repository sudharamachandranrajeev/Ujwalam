# SPDX-License-Identifier: GPL-3.0-or-later
"""Face-driven avatar from any reference image, approach A prototype (offline; D295 proposed,
docs/plan/2026-11-08-face-ai-design.md). No model is trained or downloaded; no LLM; everything local.

  1. Reference mesh: the 468 face-mesh points on the reference image, either found by the face tracker (a photo-like
     reference) or fitted from a few manual anchors (eye corners, nose, mouth, chin ... for a drawing or any image)
     with a thin-plate spline from the driver's neutral mesh.
  2. Triangulation: Delaunay over the reference mesh plus fixed border points (the background stays put).
  3. Driving: the driver's expression = its mesh in its own eye frame (eye midpoint, eye axis, eye distance) minus the
     neutral mesh in the same frame; added to the reference mesh in the reference's eye frame; head roll is applied
     as a rotation about the reference's eye midpoint. Head turn (yaw) shows up in the expression delta.
  4. Piecewise-affine warp of the reference: every triangle of the reference mesh to the driven mesh. An open mouth
     is filled with a dark inner-mouth polygon (the reference has no teeth to show).

Offline render: render(...) writes an .mp4 (OpenCV) and returns the frames; synthetic_sequence(...) makes a
driving sequence (blink, mouth, brows, roll, yaw) from one neutral mesh. Live use is not wired; see the design doc.

  avatar.py --reference IMG [--anchors JSON] --neutral NPY|--neutral-image IMG --out OUT.mp4 [--strip PNG]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import face_post as fp  # noqa: E402

# MediaPipe face mesh (468) groups used by the synthetic driver and the mouth fill.
R_LID_UP = (246, 161, 160, 159, 158, 157, 173)
R_LID_LOW = (7, 163, 144, 145, 153, 154, 155)
L_LID_UP = (466, 388, 387, 386, 385, 384, 398)
L_LID_LOW = (249, 390, 373, 374, 380, 381, 382)
R_BROW = (70, 63, 105, 66, 107, 55, 65, 52, 53, 46)
L_BROW = (300, 293, 334, 296, 336, 285, 295, 282, 283, 276)
INNER_LIPS = (78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95)
# Anchors a user (or a drawing generator) gives for a non-photo reference: mesh index -> point on the reference.
ANCHOR_IDS = (33, 133, 263, 362, 159, 145, 386, 374, 1, 61, 291, 13, 14, 152, 10, 234, 454, 105, 334)


# ---------------------------------------------------------------------------------------------------- geometry


def eye_frame(pts):
    """(origin, rotation 2x2, unit) of a mesh: eye midpoint, eye axis as x, eye distance."""
    p = np.asarray(pts, np.float64)
    re = (p[fp.R_EYE_OUTER, :2] + p[fp.R_EYE_INNER, :2]) / 2
    le = (p[fp.L_EYE_OUTER, :2] + p[fp.L_EYE_INNER, :2]) / 2
    d = le - re
    unit = float(np.hypot(*d)) or 1e-6
    c, s = d / unit
    rot = np.array([[c, -s], [s, c]])  # face frame -> image
    return (re + le) / 2, rot, unit


def to_face(pts, frame):
    o, rot, unit = frame
    return (np.asarray(pts, np.float64)[:, :2] - o) @ rot / unit


def from_face(q, frame):
    o, rot, unit = frame
    return q * unit @ rot.T + o


def tps_fit(src, dst, reg=1e-6):
    """Thin-plate spline from src [N,2] to dst [N,2]. Returns a function mapping [M,2] points."""
    src = np.asarray(src, np.float64)
    dst = np.asarray(dst, np.float64)
    n = len(src)

    def U(r2):
        with np.errstate(divide="ignore", invalid="ignore"):
            v = r2 * np.log(r2)
        return np.nan_to_num(v)

    K = U(((src[:, None, :] - src[None, :, :]) ** 2).sum(-1)) + reg * np.eye(n)
    P = np.hstack([np.ones((n, 1)), src])
    A = np.zeros((n + 3, n + 3))
    A[:n, :n], A[:n, n:], A[n:, :n] = K, P, P.T
    b = np.zeros((n + 3, 2))
    b[:n] = dst
    coef = np.linalg.solve(A, b)

    def f(pts):
        pts = np.asarray(pts, np.float64)
        k = U(((pts[:, None, :] - src[None, :, :]) ** 2).sum(-1))
        return k @ coef[:n] + np.hstack([np.ones((len(pts), 1)), pts]) @ coef[n:]

    return f


def reference_from_anchors(neutral, anchors):
    """Reference mesh [468,2] from manual anchors {mesh index: (x, y)} via a TPS from the neutral driver mesh."""
    ids = sorted(int(k) for k in anchors)
    if len(ids) < 4:
        raise ValueError("need at least 4 anchors")
    src = np.asarray(neutral, np.float64)[ids, :2]
    dst = np.array([anchors[i] if i in anchors else anchors[str(i)] for i in ids], np.float64)
    return tps_fit(src, dst)(np.asarray(neutral, np.float64)[:, :2])


def border_points(w, h, n=4):
    xs = np.linspace(0, w - 1, n + 1)
    ys = np.linspace(0, h - 1, n + 1)
    pts = [(x, 0) for x in xs] + [(x, h - 1) for x in xs] + [(0, y) for y in ys[1:-1]] + [(w - 1, y) for y in ys[1:-1]]
    return np.array(pts, np.float64)


def triangulate(pts, w, h):
    """Delaunay triangles (index triples into pts) of points inside a w x h image."""
    sub = cv2.Subdiv2D((0, 0, int(w), int(h)))
    p = np.clip(np.asarray(pts, np.float64), [0, 0], [w - 1e-3, h - 1e-3])
    index = {}
    for i, (x, y) in enumerate(p):
        key = (round(float(x), 3), round(float(y), 3))
        if key in index:
            continue
        index[key] = i
        sub.insert((float(x), float(y)))
    tris = []
    for t in sub.getTriangleList():
        ids = []
        for j in range(3):
            key = (round(float(t[2 * j]), 3), round(float(t[2 * j + 1]), 3))
            if key not in index:
                break
            ids.append(index[key])
        if len(ids) == 3:
            tris.append(ids)
    return np.array(tris, np.int32)


def _area2(t):
    """Twice the signed area of triangle t [3, 2]."""
    return float((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]))


def warp_piecewise(img, src_pts, dst_pts, tris, out=None):
    """Warp img so that every triangle src_pts[tri] lands on dst_pts[tri] (piecewise affine). Pixels outside every
    destination triangle keep `out` (default: a copy of img)."""
    h, w = img.shape[:2]
    res = img.copy() if out is None else out
    src_pts = np.asarray(src_pts, np.float32)
    dst_pts = np.asarray(dst_pts, np.float32)
    for tri in tris:
        s, d = src_pts[tri], dst_pts[tri]
        x, y, bw, bh = cv2.boundingRect(d)
        x0, y0 = max(x, 0), max(y, 0)
        x1, y1 = min(x + bw, w), min(y + bh, h)
        if x1 <= x0 or y1 <= y0:
            continue
        if abs(_area2(d)) < 1e-6 or abs(_area2(s)) < 1e-6:
            continue
        m = cv2.getAffineTransform(s, d - np.float32([x0, y0]))
        patch = cv2.warpAffine(img, m, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
        mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillConvexPoly(mask, np.round(d - np.float32([x0, y0])).astype(np.int32), 255, lineType=cv2.LINE_8)
        roi = res[y0:y1, x0:x1]
        roi[mask > 0] = patch[mask > 0]
    return res


# ---------------------------------------------------------------------------------------------------- avatar


class Avatar:
    """A reference image and its mesh; drive(...) returns the warped image for one driver mesh."""

    def __init__(self, image, ref_mesh, neutral):
        self.image = image
        h, w = image.shape[:2]
        self.ref = np.asarray(ref_mesh, np.float64)[:, :2]
        self.border = border_points(w, h)
        self.src = np.vstack([self.ref, self.border])
        self.tris = triangulate(self.src, w, h)
        self.ref_frame = eye_frame(self.ref)
        self.neutral_frame = eye_frame(neutral)
        self.neutral_q = to_face(neutral, self.neutral_frame)
        self.neutral_roll = math.atan2(self.neutral_frame[1][1, 0], self.neutral_frame[1][0, 0])
        self.rest_gap = float(np.hypot(*(self.ref[fp.LIP_UP_IN] - self.ref[fp.LIP_LOW_IN])))

    def driven_mesh(self, cur):
        f = eye_frame(cur)
        delta = to_face(cur, f) - self.neutral_q  # expression and yaw, in eye distances
        q = to_face(self.ref, self.ref_frame) + delta
        roll = math.atan2(f[1][1, 0], f[1][0, 0]) - self.neutral_roll
        c, s = math.cos(roll), math.sin(roll)
        o, rot, unit = self.ref_frame
        rot2 = rot @ np.array([[c, -s], [s, c]])
        return from_face(q, (o, rot2, unit))

    def drive(self, cur):
        dst = np.vstack([self.driven_mesh(cur), self.border])
        out = warp_piecewise(self.image, self.src, dst, self.tris)
        lips = dst[list(INNER_LIPS)]
        gap = np.hypot(*(dst[fp.LIP_UP_IN] - dst[fp.LIP_LOW_IN]))
        if gap > self.rest_gap + 0.06 * self.ref_frame[2]:  # mouth open past rest: the reference shows no inside
            cv2.fillPoly(out, [np.round(lips).astype(np.int32)], (30, 20, 60), lineType=cv2.LINE_AA)
        return out


# ---------------------------------------------------------------------------------------------------- synthetic driver


def _rot_y(p, yaw_deg):
    """Turn a mesh (x, y, z px) about the vertical axis through its centre: x' = x cos + z sin."""
    a = math.radians(yaw_deg)
    c = p[:, :2].mean(axis=0)
    q = p.copy()
    x, z = p[:, 0] - c[0], p[:, 2] if p.shape[1] > 2 else np.zeros(len(p))
    q[:, 0] = c[0] + x * math.cos(a) + z * math.sin(a)
    return q


def pose(neutral, blink=0.0, mouth=0.0, brows=0.0, roll=0.0, yaw=0.0):
    """A synthetic driver mesh: neutral with eyes closed by `blink` 0..1, jaw opened by `mouth` 0..1 (in eye distances
    x 0.45), brows raised by `brows` 0..1 (x 0.15 eye distances), head rolled `roll` degrees and turned `yaw`
    degrees. Pure geometry; no face picture is involved."""
    p = np.asarray(neutral, np.float64).copy()
    if p.shape[1] < 3:
        p = np.hstack([p, np.zeros((len(p), 1))])
    fr = eye_frame(p)
    q = to_face(p, fr)
    for up, low in ((R_LID_UP, R_LID_LOW), (L_LID_UP, L_LID_LOW)):
        for u, lo in zip(up, low):
            q[u, 1] += (q[lo, 1] - q[u, 1]) * 0.95 * blink
    mid_y = (q[fp.LIP_UP_IN, 1] + q[fp.LIP_LOW_IN, 1]) / 2
    below = q[:, 1] > mid_y
    q[below, 1] += 0.45 * mouth
    for b in R_BROW + L_BROW:
        q[b, 1] -= 0.15 * brows
    xy = from_face(q, fr)
    out = p.copy()
    out[:, :2] = xy
    if yaw:
        out = _rot_y(out, yaw)
    if roll:
        o = fr[0]
        a = math.radians(roll)
        c, s = math.cos(a), math.sin(a)
        d = out[:, :2] - o
        out[:, 0] = o[0] + d[:, 0] * c - d[:, 1] * s
        out[:, 1] = o[1] + d[:, 0] * s + d[:, 1] * c
    return out


def synthetic_sequence(neutral, fps=30, seconds=6.0):
    """[(t, mesh, params)] for a 6 s demo: blink, talk, brows, head roll and turn (sine curves)."""
    seq = []
    n = int(fps * seconds)
    for i in range(n):
        t = i / fps
        prm = {
            "blink": max(0.0, math.sin(t * 2 * math.pi / 3.0) ** 31) if t % 3.0 < 1.5 else 0.0,
            "mouth": max(0.0, math.sin(t * 2 * math.pi * 1.5)) * (1.0 if 1.0 < t < 3.5 else 0.0),
            "brows": max(0.0, math.sin((t - 3.5) * math.pi / 1.0)) if 3.5 < t < 4.5 else 0.0,
            "roll": 12.0 * math.sin(t * 2 * math.pi / 4.0),
            "yaw": 20.0 * math.sin(t * 2 * math.pi / 6.0) if t > 4.0 else 0.0,
        }
        seq.append((t, pose(neutral, **prm), prm))
    return seq


# ---------------------------------------------------------------------------------------------------- cartoon reference


def cartoon_reference(w=512, h=512):
    """A generated cartoon face (licence-clear: drawn here) and its anchors {mesh index: (x, y)}."""
    img = np.full((h, w, 3), (235, 225, 205), np.uint8)
    cx, cy = w / 2, h * 0.52
    fw, fh = w * 0.30, h * 0.38
    cv2.ellipse(img, (int(cx), int(cy)), (int(fw), int(fh)), 0, 0, 360, (150, 190, 240), -1, cv2.LINE_AA)
    cv2.ellipse(img, (int(cx), int(cy - fh * 0.75)), (int(fw * 1.05), int(fh * 0.45)), 0, 180, 360, (40, 60, 90), -1, cv2.LINE_AA)
    ey, ex, er = cy - fh * 0.15, fw * 0.42, fw * 0.17
    for sx in (-1, 1):
        c = (int(cx + sx * ex), int(ey))
        cv2.ellipse(img, c, (int(er * 1.3), int(er)), 0, 0, 360, (255, 255, 255), -1, cv2.LINE_AA)
        cv2.circle(img, c, int(er * 0.55), (90, 60, 20), -1, cv2.LINE_AA)
        cv2.circle(img, c, int(er * 0.25), (0, 0, 0), -1, cv2.LINE_AA)
        cv2.ellipse(img, (c[0], int(ey - er * 1.9)), (int(er * 1.4), int(er * 0.35)), 0, 0, 360, (40, 50, 70), -1, cv2.LINE_AA)
    ny = cy + fh * 0.18
    cv2.ellipse(img, (int(cx), int(ny)), (int(fw * 0.09), int(fw * 0.07)), 0, 0, 360, (110, 150, 220), -1, cv2.LINE_AA)
    my, mw = cy + fh * 0.45, fw * 0.38
    cv2.ellipse(img, (int(cx), int(my)), (int(mw), int(fh * 0.06)), 0, 0, 360, (60, 60, 200), -1, cv2.LINE_AA)
    cv2.line(img, (int(cx - mw), int(my)), (int(cx + mw), int(my)), (40, 30, 120), 2, cv2.LINE_AA)
    # anchors; image left = subject right (R_* indices)
    a = {
        33: (cx - ex - er * 1.3, ey), 133: (cx - ex + er * 1.3, ey), 263: (cx + ex + er * 1.3, ey), 362: (cx + ex - er * 1.3, ey),
        159: (cx - ex, ey - er), 145: (cx - ex, ey + er), 386: (cx + ex, ey - er), 374: (cx + ex, ey + er),
        1: (cx, ny), 61: (cx - mw, my), 291: (cx + mw, my), 13: (cx, my - 1), 14: (cx, my + 1),
        152: (cx, cy + fh), 10: (cx, cy - fh * 0.6), 234: (cx - fw, cy), 454: (cx + fw, cy),
        105: (cx - ex, ey - er * 1.9), 334: (cx + ex, ey - er * 1.9),
    }
    return img, {k: (float(x), float(y)) for k, (x, y) in a.items()}


# ---------------------------------------------------------------------------------------------------- render


def render(avatar, seq, out_path=None, fps=30):
    frames = []
    writer = None
    for _t, mesh, _prm in seq:
        f = avatar.drive(mesh)
        frames.append(f)
        if out_path:
            if writer is None:
                h, w = f.shape[:2]
                writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
                if not writer.isOpened():
                    raise RuntimeError(f"cannot write {out_path}")
            writer.write(f)
    if writer is not None:
        writer.release()
    return frames


def peak_frames(seq):
    """Frame indices that show each motion at its strongest: neutral, blink, mouth, brows, roll, yaw."""
    idx = [0]
    for k in ("blink", "mouth", "brows", "roll", "yaw"):
        idx.append(int(np.argmax([abs(p[k]) for _t, _m, p in seq])))
    return idx


def strip(frames, labels, idx, height=256):
    tiles = []
    for i in idx:
        f = frames[i]
        s = height / f.shape[0]
        t = cv2.resize(f, (int(f.shape[1] * s), height), interpolation=cv2.INTER_AREA)
        cv2.putText(t, labels[i], (6, height - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1, cv2.LINE_AA)
        tiles.append(t)
    return np.hstack(tiles)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--reference", default="", help="reference image; default: the generated cartoon")
    ap.add_argument("--anchors", default="", help="JSON {mesh index: [x, y]} for the reference; default: face tracker")
    ap.add_argument("--neutral", default="", help=".npy neutral driver mesh [468, 3] px")
    ap.add_argument("--neutral-image", default="", help="image to take the neutral mesh from (face tracker)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--strip", default="")
    ap.add_argument("--seconds", type=float, default=6.0)
    a = ap.parse_args(argv)
    tracker = None

    def track(img):
        nonlocal tracker
        if tracker is None:
            import face_models as fm
            tracker = fm.FaceTracker(gpu=False)
        tracker.reset()
        lm, score = tracker(img)
        if lm is None:
            raise SystemExit(f"no face found (score {score:.2f})")
        return lm

    if a.neutral:
        neutral = np.load(a.neutral)
    elif a.neutral_image:
        neutral = track(cv2.imread(a.neutral_image, cv2.IMREAD_COLOR))
    else:
        raise SystemExit("give --neutral or --neutral-image")
    if a.reference:
        ref_img = cv2.imread(a.reference, cv2.IMREAD_COLOR)
        if a.anchors:
            with open(a.anchors, encoding="utf-8") as f:
                anchors = {int(k): tuple(v) for k, v in json.load(f).items()}
            ref_mesh = reference_from_anchors(neutral, anchors)
        else:
            ref_mesh = track(ref_img)
    else:
        ref_img, anchors = cartoon_reference()
        ref_mesh = reference_from_anchors(neutral, anchors)
    av = Avatar(ref_img, ref_mesh, neutral)
    seq = synthetic_sequence(neutral, seconds=a.seconds)
    import time
    t0 = time.perf_counter()
    frames = render(av, seq, a.out)
    ms = (time.perf_counter() - t0) * 1000 / max(1, len(frames))
    print(json.dumps({"frames": len(frames), "triangles": int(len(av.tris)), "msPerFrame": round(ms, 2),
                      "size": list(ref_img.shape[:2])}))
    if a.strip:
        labels = [" ".join(f"{k[:2]}{v:+.0f}" if k in ("roll", "yaw") else f"{k[:2]}{v:.1f}" for k, v in p.items()) for _t, _m, p in seq]
        cv2.imwrite(a.strip, strip(frames, labels, peak_frames(seq)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
