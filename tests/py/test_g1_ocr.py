# SPDX-License-Identifier: GPL-2.0-or-later
"""OCR-dependent G1 tests (services/clip/g1_scan.py).

Synthetic images only (text drawn with OpenCV's Hershey font; invented names).
Skipped when numpy, opencv or rapidocr are not importable, so the system-Python
run (npm run test:py) stays green. Run them in the OCR venv: npm run test:ocr
"""

import importlib.util
import shutil
import subprocess
import tempfile
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")


def _have(mod):
    return importlib.util.find_spec(mod) is not None


HAVE_OCR = all(_have(m) for m in ("numpy", "cv2", "rapidocr"))

if HAVE_OCR:
    sys.path.insert(0, _CLIP)
    import cv2  # noqa: E402
    import numpy as np  # noqa: E402
    import g1_scan  # noqa: E402


def _card(text, colour=(255, 255, 255), bg=(40, 40, 40), w=520, h=90, scale=1.6):
    img = np.full((h, w, 3), bg, np.uint8)
    cv2.putText(img, text, (14, int(h * 0.68)), cv2.FONT_HERSHEY_SIMPLEX, scale, colour, 3, cv2.LINE_AA)
    return img


@unittest.skipUnless(HAVE_OCR, "OCR venv not available (numpy, cv2, rapidocr)")
class OcrTests(unittest.TestCase):
    def test_reads_medal_and_points(self):
        boxes, ms = g1_scan.ocr(_card("TRIPLE KILL"))
        text = " ".join(b["text"] for b in boxes).upper()
        self.assertIn("TRIPLE", text)
        self.assertGreater(ms, 0)
        boxes, _ = g1_scan.ocr(_card("+254", w=240))
        self.assertTrue(any(g1_scan.gt.parse_points(b["text"]) == 254 for b in boxes), boxes)

    def test_find_events_on_synthetic_frame(self):
        pack = {"detectors": [{"id": "M3", "medals": [{"text": "Fury Kill"}], "ignoreTexts": ["Normal Kill"]}]}
        img = np.vstack([_card("FURY KILL"), _card("ZORBO-QX"), _card("KILLCAM")])
        boxes, _ = g1_scan.ocr(img)
        lay = g1_scan.full_screen_layout(img.shape[1], img.shape[0], [0, 0, img.shape[1], img.shape[0]])
        rec = g1_scan._frame_record(boxes, lay, (0, 0))
        evs = g1_scan.find_events(rec, pack, ["Zorbo~QX"], 0.8)
        kinds = {e["det"] for e in evs}
        self.assertIn("M3", kinds)
        self.assertIn("NAME", kinds)
        self.assertIn("N1", kinds)
        for e in evs:
            g = e["box"]["g"]
            self.assertTrue(0 <= g[0] < g[2] <= 1.01 and 0 <= g[1] < g[3] <= 1.01, g)

    def test_yellow_fraction(self):
        img = np.zeros((10, 10, 3), np.uint8)
        self.assertEqual(g1_scan.yellow_fraction(img), 0.0)
        img[:5] = (0, 220, 250)  # BGR yellow
        self.assertAlmostEqual(g1_scan.yellow_fraction(img), 0.5)

    def test_classify_frame(self):
        mk = lambda t: {"text": t, "g": [0, 0, 0.1, 0.1], "score": 1.0}
        self.assertEqual(g1_scan.classify_frame([mk("20POINTS TO WIN"), mk("Normal Kill")]), "mp")
        self.assertEqual(g1_scan.classify_frame([mk("ELIMINATED"), mk("7 KILL(S)")]), "br")
        self.assertIsNone(g1_scan.classify_frame([mk("hello")]))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_OCR, "OCR venv not available (numpy, cv2, rapidocr)")
class FindEventsTests(unittest.TestCase):
    def test_ignored_medal_text_is_not_an_event(self):
        pack = {"detectors": [{"id": "M3", "medals": [{"text": "Fury Kill"}], "ignoreTexts": ["Normal Kill"]}]}
        box = {"text": "Normal Kill", "score": 0.99, "g": [0.6, 0.4, 0.7, 0.45]}
        self.assertEqual([e for e in g1_scan.find_events([box], pack, ["Zorbo~QX"], 0.8) if e["det"] == "M3"], [])

    def test_b2_needs_capitals_and_ignores_kill_count(self):
        pack = {"detectors": [{"id": "M3", "medals": [{"text": "Fury Kill"}], "ignoreTexts": []}]}
        mk = lambda t: {"text": t, "score": 0.99, "g": [0.7, 0.4, 0.8, 0.45]}
        dets = lambda t: [e["det"] for e in g1_scan.find_events([mk(t)], pack, ["Zorbo~QX"], 0.8)]
        self.assertIn("B2", dets("ELIMINATED"))
        self.assertIn("B2", dets("SQUAD ELIMPATED"))  # OCR slip on SQUAD ELIMINATED
        self.assertIn("B2", dets("KNOCKED DOWN"))
        self.assertNotIn("B2", dets("eliminated."))  # quick-chat text
        self.assertNotIn("B2", dets("9 KILL(S)"))


@unittest.skipUnless(HAVE_OCR, "OCR venv not available (numpy, cv2, rapidocr)")
class ReferenceMedalTests(unittest.TestCase):
    def test_reference_medals_logged_by_medal_positive_skipped(self):
        import json
        pack = {"version": "0.2.0", "detectors": [{"id": "M3", "medals": [
            {"text": "Survivor", "class": "reference"}, {"text": "Triple Kill", "class": "positive"}],
            "rois": [{"id": "banner", "x0": 0.0, "y0": 0.0, "x1": 0.5, "y1": 0.5, "status": "verified"}]}]}
        layout = g1_scan.full_screen_layout(200, 100, [0, 0, 200, 100])
        frame = np.full((100, 200, 3), 90, np.uint8)
        row = lambda m, t: {"det": "M3", "session": "s-2026-01-01-0000", "image": "f.png", "t": t, "text": m,
                            "score": 0.99, "medal": {"medal": m}}
        rows = [row("Survivor", 1.0), row("Survivor", 1.0), row("Triple Kill", 2.0), row("Survivor", 3.0)]
        tmp = tempfile.mkdtemp()
        try:
            ds = os.path.join(tmp, "ds")
            n = g1_scan.log_reference_medals(rows, lambda r: frame, pack, layout, ds, now="2026-10-27T00:00:00Z")
            self.assertEqual(n, 2)  # duplicate hit and the positive medal are skipped
            with open(os.path.join(ds, "index.jsonl"), encoding="utf-8") as f:
                recs = [json.loads(line) for line in f]
            self.assertEqual({r["medal"] for r in recs}, {"Survivor"})
            self.assertTrue(all(r["class"] == "reference" for r in recs))
            for r in recs:
                self.assertTrue(os.path.exists(os.path.join(ds, *r["crop"].split("/"))))
            self.assertEqual(os.listdir(ds).count("triple-kill"), 0)
            # re-run is idempotent
            self.assertEqual(g1_scan.log_reference_medals(rows, lambda r: frame, pack, layout, ds), 0)
            # per-medal cap
            ds2 = os.path.join(tmp, "ds2")
            self.assertEqual(g1_scan.log_reference_medals(rows, lambda r: frame, pack, layout, ds2, per_medal=1), 1)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(HAVE_OCR and shutil.which("ffmpeg"), "needs numpy, cv2 and ffmpeg")
class DecodeTimingTests(unittest.TestCase):
    """Frame i of a sampled decode must show the source at i/fps (the seek in grab_frame)."""

    def test_sampled_frames_match_seek(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                            "testsrc2=size=160x90:rate=60:duration=7", "-pix_fmt", "yuv420p", path], check=True)
            frames = list(g1_scan.decode_frames(path, 0.5))
            self.assertEqual([t for t, _ in frames], [0.0, 2.0, 4.0, 6.0])
            for t, img in frames[1:]:
                ref = g1_scan.grab_frame(path, t)
                diff = float(np.abs(img.astype(np.int16) - ref.astype(np.int16)).mean())
                self.assertLess(diff, 1.0, t)
                off = g1_scan.grab_frame(path, t - 1.0)  # the old fps-filter offset was 1 s
                self.assertGreater(float(np.abs(img.astype(np.int16) - off.astype(np.int16)).mean()), 1.0, t)
