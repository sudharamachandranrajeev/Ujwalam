# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for services/face (face AI, D295 proposed): mask post-processing, smoothing, One Euro, autoFrame crop
maths, sticker transform, the face link layout (on a plain memory buffer, no host), and the avatar mesh warp on
synthetic triangles. Synthetic data only: no model, no camera, no face image.

Needs numpy and OpenCV (the .venv-gpu has them); skipped without them:
  .venv-gpu\\Scripts\\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_face*.py" -v
"""

import ctypes
import math
import os
import struct
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_FACE = os.path.join(_HERE, "..", "..", "services", "face")
sys.path.insert(0, os.path.abspath(_FACE))

try:
    import cv2  # noqa: F401
    import numpy as np
    HAVE = True
except ImportError:  # system Python without numpy / OpenCV
    HAVE = False

if HAVE:
    import avatar as av
    import face_link as fl
    import face_post as fp


def synthetic_mesh(cx=320.0, cy=180.0, eye=60.0):
    """A 468-point 'mesh' that is only geometry: points on a grid, with the indices face_post reads put where a
    face's eyes, nose, mouth and brows would be (eye distance `eye` px)."""
    rng = np.random.default_rng(7)
    p = np.zeros((468, 3))
    p[:, 0] = cx + rng.uniform(-1.2, 1.2, 468) * eye
    p[:, 1] = cy + rng.uniform(-1.0, 1.6, 468) * eye
    half = eye / 2
    put = {
        fp.R_EYE_OUTER: (cx - half - 15, cy), fp.R_EYE_INNER: (cx - half + 15, cy),
        fp.L_EYE_OUTER: (cx + half + 15, cy), fp.L_EYE_INNER: (cx + half - 15, cy),
        fp.R_EYE_UP: (cx - half, cy - 4.5), fp.R_EYE_LOW: (cx - half, cy + 4.5),
        fp.L_EYE_UP: (cx + half, cy - 4.5), fp.L_EYE_LOW: (cx + half, cy + 4.5),
        fp.NOSE_TIP: (cx, cy + 0.55 * eye), fp.FOREHEAD: (cx, cy - 0.8 * eye), fp.CHIN: (cx, cy + 1.6 * eye),
        fp.MOUTH_R: (cx - 25, cy + eye), fp.MOUTH_L: (cx + 25, cy + eye),
        fp.LIP_UP_IN: (cx, cy + eye - 1), fp.LIP_LOW_IN: (cx, cy + eye + 1),
        fp.R_BROW: (cx - half, cy - 0.45 * eye), fp.L_BROW: (cx + half, cy - 0.45 * eye),
    }
    for i, (x, y) in put.items():
        p[i, :2] = (x, y)
    return p


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class MaskTests(unittest.TestCase):
    def test_mask_curve_matches_smoothstep(self):
        m = np.array([0.0, 0.45, 0.5, 0.55, 1.0], np.float32)
        a = fp.mask_curve(m, 0.5, 0.1)
        self.assertAlmostEqual(float(a[0]), 0.0)
        self.assertAlmostEqual(float(a[1]), 0.0, places=5)
        self.assertAlmostEqual(float(a[2]), 0.5, places=5)
        self.assertAlmostEqual(float(a[3]), 1.0, places=5)
        self.assertAlmostEqual(float(a[4]), 1.0)
        hard = fp.mask_curve(np.array([0.49, 0.51]), 0.5, 0.0)  # feather 0: a (1e-3 wide) hard cut
        self.assertEqual([round(float(x)) for x in hard], [0, 1])

    def test_guided_upsample_follows_the_guide_edge(self):
        guide = np.zeros((72, 128), np.uint8)
        guide[:, 64:] = 255  # sharp edge at x = 64
        low = np.zeros((9, 16), np.float32)
        low[:, 8:] = 1.0  # same edge, 8x coarser
        up = fp.guided_upsample(low, guide, radius=4, eps=1e-4)
        self.assertEqual(up.shape, (72, 128))
        self.assertLess(float(up[36, 56]), 0.1)
        self.assertGreater(float(up[36, 72]), 0.9)

    def test_smoother_ema_and_reset(self):
        s = fp.MaskSmoother(0.5)
        a = s(np.zeros((2, 2)))
        b = s(np.ones((2, 2)))
        self.assertAlmostEqual(float(a.max()), 0.0)
        self.assertAlmostEqual(float(b[0, 0]), 0.5)
        self.assertAlmostEqual(float(s(np.ones((3, 3)))[0, 0]), 1.0)  # new size starts again
        s.smoothing = 5.0  # clamped to 0.95
        c = s(np.zeros((3, 3)))
        self.assertAlmostEqual(float(c[0, 0]), 0.95, places=5)
        self.assertEqual(fp.to_u8(np.array([0.0, 0.5, 1.2])).tolist(), [0, 128, 255])

    def test_one_euro_still_and_moving(self):
        f = fp.OneEuro(min_cutoff=1.0, beta=0.0)
        rng = np.random.default_rng(1)
        outs = [f(np.array([10.0 + rng.normal(0, 1)]), i / 30)[0] for i in range(120)]
        self.assertLess(float(np.std(outs[30:])), 0.6)  # jitter (sd 1) reduced
        g = fp.OneEuro(min_cutoff=1.0, beta=1.0)
        last = 0.0
        for i in range(60):
            last = g(np.array([i * 1.0]), i / 30)[0]
        self.assertGreater(last, 50.0)  # follows a steady move with little lag


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class AutoFrameTests(unittest.TestCase):
    def test_target_centres_and_clamps(self):
        x, y, w, h = fp.autoframe_target((0.5, 0.5, 0.2), 2.0, 0.0, 16 / 9)
        self.assertEqual((w, h), (0.5, 0.5))
        self.assertAlmostEqual(x, 0.25)
        self.assertAlmostEqual(y, 0.25)
        x, y, w, h = fp.autoframe_target((0.02, 0.98, 0.2), 2.0, 0.0, 1.0)  # near a corner: crop stays inside
        self.assertEqual((x, y), (0.0, 0.5))
        self.assertIsNone(fp.autoframe_target(None, 2.0, 0.1, 1.0))
        self.assertEqual(fp.autoframe_target((0.3, 0.3, 0.1), 0.5, 0, 1)[2], 1.0)  # zoom clamped to 1

    def test_deadzone_holds_small_moves(self):
        prev = (0.5, 0.5)
        x, _y, w, _h = fp.autoframe_target((0.52, 0.5, 0.2), 2.0, 0.1, 1.0, prev)  # inside 0.1 x 0.5 = 0.05
        self.assertAlmostEqual(x + w / 2, 0.5)
        x, _y, w, _h = fp.autoframe_target((0.6, 0.5, 0.2), 2.0, 0.1, 1.0, prev)  # outside: follows to the edge
        self.assertAlmostEqual(x + w / 2, 0.55)

    def test_ease_and_hold(self):
        r = fp.ease_rect((0, 0, 1, 1), (0.25, 0.25, 0.5, 0.5), 0.5, 0.5)
        k = 1 - math.exp(-1)
        self.assertAlmostEqual(r[0], 0.25 * k)
        self.assertEqual(fp.ease_rect((0, 0, 1, 1), (0.1, 0.1, 0.5, 0.5), 0.1, 0), (0.1, 0.1, 0.5, 0.5))
        a = fp.AutoFrame(zoom=2.0, smoothing=0.0, deadzone=0.0, hold=1.0)
        self.assertEqual(a.step((0.5, 0.5, 0.2), 0.0, 1 / 30), (0.25, 0.25, 0.5, 0.5))
        self.assertEqual(a.step(None, 0.5, 1 / 30), (0.25, 0.25, 0.5, 0.5))  # held
        self.assertEqual(a.step(None, 1.6, 1 / 30), fp.FULL_FRAME)  # gone > 1 s: whole frame


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class FeatureTests(unittest.TestCase):
    def test_sticker_anchor_scale_roll(self):
        p = synthetic_mesh()
        cx, cy, w, roll = fp.sticker_transform(p, "eyes", 2.0)
        self.assertAlmostEqual(cx, 320.0)
        self.assertAlmostEqual(cy, 180.0)
        self.assertAlmostEqual(w, 120.0)
        self.assertAlmostEqual(roll, 0.0)
        cx, cy, _w, _r = fp.sticker_transform(p, "nose", 1.0, (0.0, 0.5))
        self.assertAlmostEqual(cy, 180.0 + 0.55 * 60 + 30)
        # rotate the whole mesh 30 degrees about the eye midpoint: roll follows, the offset turns with it
        a = math.radians(30)
        q = p.copy()
        d = p[:, :2] - (320, 180)
        q[:, 0] = 320 + d[:, 0] * math.cos(a) - d[:, 1] * math.sin(a)
        q[:, 1] = 180 + d[:, 0] * math.sin(a) + d[:, 1] * math.cos(a)
        cx, cy, _w, roll = fp.sticker_transform(q, "eyes", 1.0, (1.0, 0.0))
        self.assertAlmostEqual(roll, 30.0, places=5)
        self.assertAlmostEqual(cx, 320 + 60 * math.cos(a), places=5)
        self.assertAlmostEqual(cy, 180 + 60 * math.sin(a), places=5)
        with self.assertRaises(ValueError):
            fp.sticker_transform(p, "ear")

    def test_features_neutral_and_blink(self):
        p = synthetic_mesh()
        f = fp.face_features(p)
        self.assertAlmostEqual(f["roll"], 0.0)
        self.assertAlmostEqual(f["yaw"], 0.0)
        self.assertAlmostEqual(f["pitch"], 0.0, places=5)
        self.assertAlmostEqual(f["eyeDist"], 60.0)
        self.assertEqual(f["blinkR"], 0.0)  # lid gap 9 / width 30 = 0.3: open
        q = p.copy()
        q[fp.R_EYE_UP, 1] = q[fp.R_EYE_LOW, 1] = 180  # closed
        self.assertEqual(fp.face_features(q)["blinkR"], 1.0)
        q = p.copy()
        q[fp.NOSE_TIP, 0] += 30  # nose toward image right by half an eye distance
        self.assertAlmostEqual(fp.face_features(q)["yaw"], 1.0)
        box = fp.face_box(np.array([[0.2, 0.3], [0.4, 0.7]]))
        self.assertEqual(tuple(round(v, 6) for v in box), (0.3, 0.5, 0.4))


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class LinkLayoutTests(unittest.TestCase):
    """The worker side of the face link on a plain buffer (the host's mapping is not needed): the header offsets
    mirror app/host/src/face.h."""

    def setUp(self):
        self.mem = (ctypes.c_ubyte * fl.TOTAL)()
        self.link = fl.Link(ctypes.addressof(self.mem), None, None)
        self.mv = memoryview(self.mem).cast("B")

    def put(self, fmt, off, v):
        struct.pack_into(fmt, self.mv, off, v)

    def get(self, fmt, off):
        return struct.unpack_from(fmt, self.mv, off)[0]

    def test_layout_constants(self):
        self.assertEqual(fl.FRAME_OFF, 4096)
        self.assertEqual(fl.MASK_OFF, 4096 + 640 * 360 * 4)
        self.assertEqual(fl.LMK_OFF, fl.MASK_OFF + 640 * 360)
        self.assertEqual(fl.TOTAL % 4096, 0)
        self.assertGreaterEqual(fl.TOTAL, fl.LMK_OFF + 468 * 12)
        self.assertEqual(fl.link_name(1234), "Local\\ujwalam-face-1234")

    def test_read_frame_seqlock(self):
        w, h = 8, 4
        self.put("<I", 20, w)
        self.put("<I", 24, h)
        self.put("<I", 28, w * 4)
        self.put("<q", 40, 111)
        self.put("<I", 48, 1920)
        self.put("<I", 52, 1080)
        px = np.frombuffer(self.mem, np.uint8, w * h * 4, fl.FRAME_OFF)
        px[:] = np.arange(w * h * 4) % 251
        self.assertIsNone(self.link.read_frame(0))  # seq 0: nothing yet
        self.put("<Q", 32, 5)
        self.put("<I", 16, 3)  # odd lock: host writing
        self.assertIsNone(self.link.read_frame(0, tries=2))
        self.put("<I", 16, 4)
        seq, ts, got, src = self.link.read_frame(0)
        self.assertEqual((seq, ts, src), (5, 111, (1920, 1080)))
        self.assertEqual(got.shape, (h, w, 4))
        self.assertEqual(int(got[1, 2, 3]), int((1 * w * 4 + 2 * 4 + 3) % 251))
        self.assertIsNone(self.link.read_frame(5))  # same frame again: nothing new
        self.put("<I", 28, w * 4 + 4)  # a stride the worker does not accept
        self.assertIsNone(self.link.read_frame(0))

    def test_write_result(self):
        mask = np.full((36, 64), 200, np.uint8)
        lm = np.random.default_rng(3).random((468, 3)).astype(np.float32)
        feats = {"roll": 5.0, "yaw": -0.25, "pitch": 0.5, "blinkR": 1.0, "blinkL": 0.0, "mouth": 0.75, "brows": 0.25}
        self.link.write_result(9, 12345, mask, lm, (0.1, 0.2, 0.3, 0.4), 0.9, feats, 3.5, 3)
        self.assertEqual(self.get("<I", 128) % 2, 0)  # lock even again
        self.assertEqual((self.get("<I", 132), self.get("<I", 136)), (64, 36))
        self.assertEqual(self.get("<I", 140), 1)
        self.assertEqual(self.get("<Q", 144), 1)
        self.assertEqual((self.get("<Q", 152), self.get("<q", 160)), (9, 12345))
        self.assertEqual(self.get("<I", 180), 468)
        self.assertAlmostEqual(self.get("<f", 184), 3.5)
        self.assertAlmostEqual(self.get("<f", 200), 0.4, places=6)
        self.assertAlmostEqual(self.get("<f", 204), 0.9, places=6)
        self.assertAlmostEqual(self.get("<f", 208), 5.0)
        self.assertAlmostEqual(self.get("<f", 228), 0.75)
        self.assertEqual(self.get("<I", 236), 3)
        self.assertEqual(int(np.frombuffer(self.mem, np.uint8, 64 * 36, fl.MASK_OFF).min()), 200)
        got = np.frombuffer(self.mem, np.float32, 468 * 3, fl.LMK_OFF).reshape(468, 3)
        self.assertTrue(np.array_equal(got, lm))
        self.link.write_result(10, 1, None, None)  # no face: found 0, count 0, mask size kept
        self.assertEqual((self.get("<I", 140), self.get("<I", 180), self.get("<Q", 144)), (0, 0, 2))
        with self.assertRaises(ValueError):
            self.link.write_result(11, 1, np.zeros((400, 700), np.uint8))


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class AvatarTests(unittest.TestCase):
    def test_affine_warp_of_one_triangle(self):
        img = np.zeros((100, 100, 3), np.uint8)
        img[20:40, 20:40] = (0, 0, 255)  # red square inside the source triangle
        src = np.array([[10, 10], [90, 10], [10, 90]], np.float64)
        dst = src + (5, 7)  # pure translation
        out = av.warp_piecewise(img, src, dst, np.array([[0, 1, 2]]), out=np.zeros_like(img))
        self.assertEqual(out[30 + 7, 30 + 5].tolist(), [0, 0, 255])
        self.assertEqual(out[22 + 7, 50].tolist(), [0, 0, 0])
        ys, xs = np.nonzero(out[:, :, 2] > 128)
        self.assertEqual((int(xs.min()), int(ys.min())), (25, 27))

    def test_triangulation_covers_the_square(self):
        pts = np.array([[0, 0], [99, 0], [0, 99], [99, 99], [50, 50]], np.float64)
        tris = av.triangulate(pts, 100, 100)
        self.assertEqual(len(tris), 4)
        area = sum(abs(av._area2(pts[t])) / 2 for t in tris)
        self.assertAlmostEqual(area, 99 * 99, places=3)

    def test_identity_drive_keeps_the_image(self):
        mesh = synthetic_mesh(cx=128, cy=110, eye=50)
        img = np.random.default_rng(0).integers(0, 255, (256, 256, 3), np.uint8)
        a = av.Avatar(img, mesh, mesh)
        np.testing.assert_allclose(a.driven_mesh(mesh), mesh[:, :2], atol=1e-6)
        out = a.drive(mesh)
        self.assertLess(float(np.abs(out.astype(int) - img.astype(int)).mean()), 1.0)

    def test_roll_and_tps(self):
        mesh = synthetic_mesh(cx=128, cy=110, eye=50)
        a = av.Avatar(np.zeros((256, 256, 3), np.uint8), mesh, mesh)
        rolled = av.pose(mesh, roll=20.0)
        got = a.driven_mesh(rolled)
        np.testing.assert_allclose(got, rolled[:, :2], atol=1e-6)  # same reference = driver: follows exactly
        opened = av.pose(mesh, mouth=1.0)
        self.assertGreater(opened[fp.LIP_LOW_IN, 1] - mesh[fp.LIP_LOW_IN, 1], 20)  # 0.45 x 50 px
        self.assertAlmostEqual(opened[fp.LIP_UP_IN, 1], mesh[fp.LIP_UP_IN, 1])
        anchors = {i: tuple(mesh[i, :2] * 2) for i in av.ANCHOR_IDS}  # reference twice as big
        ref = av.reference_from_anchors(mesh, anchors)
        np.testing.assert_allclose(ref, mesh[:, :2] * 2, atol=1e-4)  # a TPS reproduces a pure scale


if __name__ == "__main__":
    unittest.main()
