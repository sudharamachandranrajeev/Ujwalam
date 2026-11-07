# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 detector pass with real RapidOCR on a generated H recording (services/clip/clipper.py detect).

Generated frames only (OpenCV Hershey text at pack ROI positions, an invented player name in a temp profile);
no corpus or real footage. Plumbing, not accuracy: it shows that sampled frames reach the pack's detectors and
that hits reach candidates.json with weight 0. Skipped without the OCR venv or ffmpeg.
Run: npm run test:ocr (or .venv\\Scripts\\python.exe -I -m unittest tests/py/test_g1_detector_pass.py)
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "clip"))
HAVE_OCR = all(importlib.util.find_spec(m) is not None for m in ("numpy", "cv2", "rapidocr"))
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

if HAVE_OCR:
    if _CLIP not in sys.path:
        sys.path.insert(0, _CLIP)
    import cv2
    import numpy as np
    import clip_common as cc
    import clipper
    import detector_pass as dp

W, H, FPS, SECONDS = 1280, 720, 10, 9
NAME = "Zorbo QX"  # invented


def _text(img, s, x_frac, y_frac, scale=1.4):
    (tw, th), _ = cv2.getTextSize(s, cv2.FONT_HERSHEY_SIMPLEX, scale, 3)
    x, y = int(x_frac * W - tw / 2), int(y_frac * H + th / 2)
    cv2.putText(img, s, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 3, cv2.LINE_AA)


def _frame(t):
    img = np.full((H, W, 3), (35, 45, 40), np.uint8)
    if 3.0 <= t < 6.0:
        _text(img, "TRIPLE KILL", 0.50, 0.25)  # M3 banner ROI (x 0.38-0.62, y 0.03-0.32)
    if 7.0 <= t < 8.0:
        _text(img, "KILLCAM", 0.09, 0.055, scale=1.0)  # N1 label_mp ROI (x 0.02-0.20, y 0.02-0.09)
    return img


@unittest.skipUnless(HAVE_OCR and HAVE_FFMPEG, "needs the OCR venv (numpy, cv2, rapidocr) and ffmpeg")
class DetectorPassOcrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.TemporaryDirectory()
        d = cls.td.name
        cls.rec = os.path.join(d, "rec-h-20261103-070000.mkv")
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "2", "-f", "rawvideo",
                              "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                              "-c:v", "libopenh264", "-b:v", "2M", cls.rec], stdin=subprocess.PIPE, **NO_WINDOW)
        for i in range(SECONDS * FPS):
            p.stdin.write(_frame(i / FPS).tobytes())
        p.stdin.close()
        if p.wait(timeout=300) != 0:
            raise unittest.SkipTest("cannot generate test media")
        cls.data = os.path.join(d, "data")
        os.makedirs(cls.data)
        with open(os.path.join(cls.data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True}}, f)
        cls.profile = os.path.join(d, "profile.json")
        with open(cls.profile, "w", encoding="utf-8") as f:
            json.dump({"games": {"codm": {"ign": NAME, "variants": []}}}, f)
        cls.out = os.path.join(d, "out")

    @classmethod
    def tearDownClass(cls):
        cls.td.cleanup()

    def test_detect_then_candidates(self):
        rc = clipper.main(["--data-dir", self.data, "detect", "--recording", self.rec, "--out", self.out,
                           "--profile", self.profile, "--threads", "2"])
        self.assertEqual(rc, 0)
        summ = cc.load_json(os.path.join(self.out, dp.SUMMARY))
        self.assertEqual(summ["config"]["fps"], 1.0)
        self.assertEqual(summ["frames"], SECONDS)
        self.assertEqual(summ["layout"]["source"], "full-frame")
        self.assertGreater(summ["diffGateSkips"], 0)  # unchanged frames are not OCR'd
        with open(os.path.join(self.out, dp.HITS), encoding="utf-8") as f:
            text = f.read()
        hits = [json.loads(x) for x in text.splitlines()]
        m3 = [h for h in hits if h["detector"] == "M3"]
        self.assertEqual(len(m3), 1, hits)
        self.assertEqual((m3[0]["label"], m3[0]["signal"], m3[0]["weight"]), ("Triple Kill", True, None))
        self.assertAlmostEqual(m3[0]["t"], 3.0, delta=0.11)
        # on screen 3-6 s: OCR at 3 s, 4 and 5 s are unchanged (diff-gated) and continue the hit
        self.assertEqual((m3[0]["frames"], m3[0]["tEnd"]), (3, 5.0))
        n1 = [h for h in hits if h["detector"] == "N1"]
        self.assertEqual([(h["role"], h["signal"]) for h in n1], [("negative", False)])
        self.assertNotIn("ZORBO", text.upper())

        rc = clipper.main(["--data-dir", self.data, "candidates", "--recording", self.rec, "--out", self.out,
                           "--record-start", "2026-11-03T07:00:00Z", "--no-audio"])
        self.assertEqual(rc, 0)
        doc = cc.load_json(os.path.join(self.out, clipper.CANDIDATES))
        # weights approved 2026-11-07 (Streaks only): the Triple Kill counts (3); the 6 s fixture with the death
        # (N1, hard negative) right after it leaves no clip of clip.minSec, so no candidate opens
        self.assertEqual(doc["candidates"], [])
        self.assertEqual(doc["signals"]["detectors"]["counted"], 1)
        self.assertTrue(doc["detectorHits"])
        self.assertEqual(sorted(h["weight"] for h in doc["detectorHits"]), [0.0] * (len(doc["detectorHits"]) - 1) + [3.0])


if __name__ == "__main__":
    unittest.main()
