# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 post-stream detector pass (services/clip/detector_pass.py) and its ranking rule, without OCR.

Synthetic OCR boxes (game-area fractions, invented player names) on the committed CODM pack, generated media for
the clipper plumbing. Nothing here measures detector accuracy: every CODM detector stays `unverified`.
The OCR case (real RapidOCR on generated frames) is tests/py/test_g1_detector_pass.py (npm run test:ocr).
Run: python -I -m unittest discover -s tests/py -t tests/py
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "clip"))
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_common as cc  # noqa: E402
import clip_rank as rank  # noqa: E402
import clip_signals as sig  # noqa: E402
import clipper  # noqa: E402
import detector_pass as dp  # noqa: E402
import game_pack  # noqa: E402

RANKING = cc.load_config("ranking")
GID, SETTINGS, CONFIG = dp.load_settings()
PACK = game_pack.load_pack(dp.pack_path(SETTINGS))
NAMES = ["Zorbo~QX"]  # invented
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def box(text, x0, y0, x1, y1, score=0.95):
    return {"text": text, "score": score, "g": [x0, y0, x1, y1]}


def hits_of(boxes, mode="mp"):
    return dp.frame_hits(boxes, PACK, NAMES, SETTINGS, mode)


class ConfigTests(unittest.TestCase):
    def test_settings_come_from_config(self):
        self.assertEqual(GID, "codm")
        self.assertEqual(CONFIG["status"], "proposed")
        self.assertEqual(SETTINGS["fps"], 1.0)
        self.assertTrue(os.path.isdir(dp.pack_path(SETTINGS)))

    def test_bad_settings_refused(self):
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "c.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump({"defaultGame": "codm", "games": {"codm": {**SETTINGS, "fps": 0}}}, f)
            with self.assertRaises(cc.ClipError):
                dp.load_settings(path=p)
            with self.assertRaises(cc.ClipError):
                dp.load_settings(game="nope", path=p)

    def test_detector_weights_approval_recorded(self):
        # Detector hits weigh 0 until the user approves weights; approved 2026-11-07 ('Streaks only').
        self.assertEqual(RANKING["detectorWeightsStatus"], "approved")
        self.assertIn("user 2026-11-07", RANKING["detectorWeightsApproved"])
        self.assertEqual(RANKING["detectorWeights"]["M3"], 0, "single medals and Double Kill make no clip")

    def test_pack_weights_still_null(self):
        for d in PACK["detectors"]:
            self.assertIsNone(d["weight"], d["id"])
            self.assertEqual(d["status"], "unverified", d["id"])
        for m in next(d for d in PACK["detectors"] if d["id"] == "M3")["medals"]:
            self.assertEqual(m["weight"], None if m["class"] == "positive" else 0, m["text"])


class WeightRuleTests(unittest.TestCase):
    H = {"t": 50.0, "detector": "M3", "label": "Triple Kill", "signal": True, "role": "positive",
         "clipReason": True, "weight": None}

    def test_not_approved_is_zero_even_with_numbers(self):
        h = dict(self.H, weight=0.7)
        self.assertEqual(rank.detector_weight(h, {"M3": 0.9}, approved=False), (0.0, "weights not approved"))

    def test_approved_but_null_is_zero(self):
        self.assertEqual(rank.detector_weight(self.H, {}, approved=True), (0.0, "weight null"))

    def test_approved_number_counts(self):
        self.assertEqual(rank.detector_weight(dict(self.H, weight=0.7), {}, True), (0.7, None))
        self.assertEqual(rank.detector_weight(self.H, {"M3": 0.5}, True), (0.5, None))
        self.assertEqual(rank.detector_weight(self.H, {"M3": 0.5, "M3:Triple Kill": 0.8}, True), (0.8, None))

    def test_non_signals_stay_zero_when_approved(self):
        for h in (dict(self.H, signal=False, weight=1.0), dict(self.H, role="negative", weight=1.0),
                  dict(self.H, clipReason=False, weight=1.0)):
            self.assertEqual(rank.detector_weight(h, {"M3": 1.0}, True)[0], 0.0, h)

    def test_zero_weight_hits_attach_but_never_rank(self):
        w = RANKING["weights"]
        marker = rank.marker_events([{"t": 100.0, "source": "hotkey"}], w)
        base = rank.build_candidates([dict(e) for e in marker], 1000.0, RANKING)
        hits = [dict(self.H, t=95.0), dict(self.H, t=500.0, label="Fury Kill")]
        dev = rank.detector_events(hits, RANKING["detectorWeights"], approved=False)
        self.assertTrue(all(e["attachOnly"] and e["w"] == 0.0 for e in dev))
        c = rank.build_candidates([dict(e) for e in marker] + dev, 1000.0, RANKING)
        self.assertEqual(len(c), 1)  # the lone hit at 500 s opens no candidate
        self.assertEqual((c[0]["start"], c[0]["end"], c[0]["score"]), (base[0]["start"], base[0]["end"], base[0]["score"]))
        det = [r for r in c[0]["reasons"] if r["kind"] == "detector.M3"]
        self.assertEqual(len(det), 1)
        self.assertEqual(det[0]["weight"], 0.0)
        self.assertEqual(det[0]["detail"]["zeroBecause"], "weights not approved")
        self.assertEqual(dev[0].get("candidate"), "c01")
        self.assertIsNone(dev[1].get("candidate"))
        self.assertEqual(rank.build_candidates(dev, 1000.0, RANKING), [])

    def test_approved_weight_opens_and_scores(self):
        dev = rank.detector_events([dict(self.H, weight=0.5)], {}, approved=True)
        c = rank.build_candidates(dev, 1000.0, {**RANKING, "minScore": 0})
        self.assertEqual(len(c), 1)
        self.assertAlmostEqual(c[0]["score"], 0.5)
        self.assertEqual((c[0]["start"], c[0]["end"]), (35.0, 58.0))  # detector window 15 s before, 8 s after


class FrameRuleTests(unittest.TestCase):
    def test_positive_medal_in_banner(self):
        h = hits_of([box("TRIPLE KILL", 0.44, 0.22, 0.56, 0.27)])
        m3 = [x for x in h if x["detector"] == "M3"]
        self.assertEqual(len(m3), 1)
        self.assertEqual((m3[0]["label"], m3[0]["signal"], m3[0]["weight"]), ("Triple Kill", True, None))
        self.assertEqual(m3[0]["detectorStatus"], "unverified")

    def test_reference_medal_and_outside_roi(self):
        h = hits_of([box("HEADSHOT", 0.44, 0.22, 0.56, 0.27)])
        self.assertEqual([(x["signal"], x["why"], x["clipReason"]) for x in h if x["detector"] == "M3"],
                         [(False, ["reference_medal"], False)])
        h = hits_of([box("TRIPLE KILL", 0.05, 0.70, 0.20, 0.75)])
        self.assertEqual([x["why"] for x in h if x["detector"] == "M3"], [["outside_roi"]])

    def test_points_need_a_medal(self):
        h = hits_of([box("+254", 0.58, 0.40, 0.64, 0.44)])
        self.assertEqual([x["why"] for x in h if x["detector"] == "M4"], [["no_medal_in_stack"]])
        h = hits_of([box("+254", 0.58, 0.40, 0.64, 0.44), box("TRIPLE KILL", 0.66, 0.40, 0.80, 0.44)])
        m4 = [x for x in h if x["detector"] == "M4"]
        self.assertEqual((m4[0]["label"], m4[0]["signal"]), ("+254", True))

    def test_multikill_needs_name_on_the_card(self):
        card = box("3X MULTI-KILL", 0.38, 0.62, 0.52, 0.66)
        h = hits_of([card])
        self.assertEqual([(x["label"], x["why"]) for x in h if x["detector"] == "X1"],
                         [("3X MULTI-KILL", ["no_name_in_roi"])])
        h = hits_of([card, box("Zorbo~QX", 0.38, 0.58, 0.50, 0.61)])
        self.assertEqual([x["signal"] for x in h if x["detector"] == "X1"], [True])
        # name elsewhere on the frame (e.g. the BR squad list) does not count
        h = hits_of([card, box("ZorboQX", 0.02, 0.30, 0.10, 0.32)])
        self.assertEqual([x["signal"] for x in h if x["detector"] == "X1"], [False])
        h = hits_of([box("5+ MULTI-KILL", 0.45, 0.04, 0.55, 0.08)], mode="br")
        self.assertEqual([x["label"] for x in h if x["detector"] == "X1"], ["5+ MULTI-KILL"])

    def test_impact_play_suppresses_medals(self):
        h = hits_of([box("IMPACT PLAY", 0.45, 0.06, 0.55, 0.10), box("TRIPLE KILL", 0.44, 0.22, 0.56, 0.27)])
        m3 = [x for x in h if x["detector"] == "M3"]
        self.assertIn("suppressed_by_M2", m3[0]["why"])
        self.assertFalse(m3[0]["signal"])

    def test_negative_and_final_killcam(self):
        h = hits_of([box("KILLCAM", 0.04, 0.03, 0.13, 0.08)])
        n1 = [x for x in h if x["detector"] == "N1"]
        self.assertEqual((n1[0]["role"], n1[0]["signal"], n1[0]["clipReason"]), ("negative", False, False))
        h = hits_of([box("FINAL KILLCAM", 0.45, 0.06, 0.56, 0.09)])
        self.assertEqual([x["why"] for x in h if x["detector"] == "K1"], [["no_name_as_killer"]])
        h = hits_of([box("FINAL KILLCAM", 0.45, 0.06, 0.56, 0.09), box("Zorbo~QX", 0.45, 0.10, 0.55, 0.13)])
        self.assertEqual([x["signal"] for x in h if x["detector"] == "K1"], [True])

    def test_own_killfeed_line(self):
        h = hits_of([box("Zorbo~QX", 0.30, 0.88, 0.38, 0.91), box("Victim9", 0.45, 0.88, 0.52, 0.91)])
        m5 = [x for x in h if x["detector"] == "M5"]
        self.assertEqual([x["signal"] for x in m5], [True])
        h = hits_of([box("Other7", 0.30, 0.88, 0.38, 0.91), box("Zorbo~QX", 0.45, 0.88, 0.52, 0.91)])
        self.assertEqual([x["why"] for x in h if x["detector"] == "M5"], [["not_own_kill"]])

    def test_rows_never_carry_names_or_ocr_text(self):
        h = hits_of([box("3X MULTI-KILL Zorbo~QX", 0.38, 0.62, 0.52, 0.66), box("Zorbo~QX", 0.38, 0.58, 0.5, 0.61),
                     box("Zorbo~QX", 0.30, 0.88, 0.38, 0.91), box("Victim9", 0.45, 0.88, 0.52, 0.91)])
        self.assertTrue(h)
        blob = json.dumps(h).upper()
        for s in ("ZORBO", "VICTIM9"):
            self.assertNotIn(s, blob)
        self.assertEqual(set(h[0]), {"detector", "label", "role", "signal", "why", "clipReason", "weight",
                                     "detectorStatus", "mode", "ocrScore"})


class MergeTests(unittest.TestCase):
    def row(self, t, det="M3", label="Triple Kill", signal=True, why=()):
        return {"t": t, "detector": det, "label": label, "signal": signal, "why": list(why), "ocrScore": 0.9}

    def test_consecutive_frames_merge(self):
        rows = [self.row(10.0), self.row(11.0), self.row(12.0, signal=False, why=["outside_roi"]),
                self.row(20.0), self.row(11.0, label="Fury Kill")]
        out = dp.merge_hits(rows, 2.5)
        self.assertEqual([(r["t"], r["tEnd"], r["frames"], r["label"]) for r in out],
                         [(10.0, 12.0, 3, "Triple Kill"), (11.0, 11.0, 1, "Fury Kill"), (20.0, 20.0, 1, "Triple Kill")])
        self.assertTrue(out[0]["signal"])

    def test_split_by_signal_keeps_own_kill_feed_lines_short(self):
        rows = [self.row(float(t), signal=False, why=["not_own_kill"]) for t in range(0, 60)]
        rows[30] = self.row(30.0)
        rows[31] = self.row(31.0)
        out = dp.merge_hits(rows, 2.5, split_by_signal=[rows[0]["detector"]])
        sig = [(r["t"], r["tEnd"]) for r in out if r["signal"]]
        self.assertEqual(sig, [(30.0, 31.0)])
        self.assertEqual(len(dp.merge_hits(rows, 2.5)), 1, "without the split: one whole-span instance")

    def test_signal_upgrade_clears_why(self):
        out = dp.merge_hits([self.row(1.0, signal=False, why=["no_name_in_roi"]), self.row(2.0)], 2.5)
        self.assertEqual((out[0]["signal"], out[0]["why"]), (True, []))


class SeamTests(unittest.TestCase):
    def test_read_hits_keeps_rule_fields(self):
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "h.jsonl")
            with open(p, "w", encoding="utf-8") as f:
                f.write(json.dumps({"t": 5, "detector": "M3", "label": "Triple Kill", "signal": True,
                                    "role": "positive", "clipReason": True, "weight": None, "tEnd": 6}) + "\n")
                f.write(json.dumps({"t": 6, "detector": "N1", "role": "bogus", "signal": "yes", "weight": "1"}) + "\n")
            hits, st = sig.read_hits(p, 100.0)
        self.assertEqual(hits[0], {"t": 5.0, "detector": "M3", "label": "Triple Kill", "signal": True,
                                   "clipReason": True, "role": "positive", "weight": None, "tEnd": 6.0})
        self.assertEqual(hits[1], {"t": 6.0, "detector": "N1", "label": None})
        self.assertEqual(st, {"hits": 2, "bad": 0})


class LockTests(unittest.TestCase):
    def test_one_heavy_job(self):
        with tempfile.TemporaryDirectory() as td:
            with dp.HeavyJobLock(td):
                with self.assertRaises(cc.ClipError):
                    with dp.HeavyJobLock(td):
                        pass
            self.assertFalse(os.path.exists(os.path.join(td, dp.LOCK_NAME)))

    def test_stale_lock_taken(self):
        with tempfile.TemporaryDirectory() as td:
            with open(os.path.join(td, dp.LOCK_NAME), "w", encoding="utf-8") as f:
                json.dump({"pid": 999999999}, f)
            with dp.HeavyJobLock(td) as lk:
                self.assertTrue(lk.held)


ROI_SETTINGS = {**SETTINGS, "ocrRegions": "rois", "roiPad": [0.04, 0.02], "roiMergeArea": 0.02,
                "roiEvery": {"M1": 3, "M2": 3}, "modeProbeEvery": 10}
try:
    import cv2
    import numpy as np
    HAVE_CV = True
except ImportError:
    HAVE_CV = False


class OcrRegionTests(unittest.TestCase):
    """ocrRegions "rois": pack ROIs -> merged bands -> band crops; boxes come back in the full-frame space."""

    def test_settings_validation(self):
        def load(**over):
            with tempfile.TemporaryDirectory() as td:
                p = os.path.join(td, "c.json")
                with open(p, "w", encoding="utf-8") as f:
                    json.dump({"defaultGame": "codm", "games": {"codm": {**ROI_SETTINGS, **over}}}, f)
                return dp.load_settings(path=p)[1]
        self.assertEqual(load()["ocrRegions"], "rois")
        full = {k: v for k, v in SETTINGS.items() if k not in ("ocrRegions", "roiPad", "roiMergeArea", "roiEvery",
                                                                "modeProbeEvery", "roiDetScale", "roiTextFilter")}
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "c.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump({"defaultGame": "codm", "games": {"codm": full}}, f)
            self.assertEqual(dp.load_settings(path=p)[1]["ocrRegions"], "full")  # older files keep full frame
        for bad in ({"ocrRegions": "half"}, {"roiPad": [0.1]}, {"roiPad": [0.1, -1]}, {"roiPad": "0.1"},
                    {"roiMergeArea": 2}, {"roiMergeArea": True}, {"roiEvery": {"M1": 0}}, {"roiEvery": {"M1": 1.5}},
                    {"roiEvery": []}, {"modeProbeEvery": -1}, {"modeProbeEvery": 2.5}, {"roiDetScale": 0.1},
                    {"roiDetScale": 1.5}, {"roiTextFilter": "yes"}):
            with self.assertRaises(cc.ClipError, msg=str(bad)):
                load(**bad)

    def test_merge_bands(self):
        a = (0.0, 0.0, 0.2, 0.1, 1, {"A"})
        b = (0.2, 0.0, 0.4, 0.1, 1, {"B"})  # touching: the union adds no area
        far = (0.8, 0.8, 0.9, 0.9, 1, {"C"})
        inner = (0.82, 0.82, 0.85, 0.85, 1, {"D"})
        slow = (0.0, 0.1, 0.4, 0.2, 3, {"E"})  # other cadence: never merged
        bands = dp.merge_bands([a, b, far, inner, slow], 0.02)
        self.assertEqual(sorted((tuple(round(v, 3) for v in x[:4]), x[4], sorted(x[5])) for x in bands),
                         [((0.0, 0.0, 0.4, 0.1), 1, ["A", "B"]), ((0.0, 0.1, 0.4, 0.2), 3, ["E"]),
                          ((0.8, 0.8, 0.9, 0.9), 1, ["C", "D"])])
        self.assertEqual(len(dp.merge_bands([a, (0.3, 0.3, 0.5, 0.4, 1, {"F"})], 0.02)), 2)  # gap costs 0.07

    def test_every_roi_lies_in_a_band(self):
        rects = dp.roi_rects(PACK, ROI_SETTINGS)
        bands = dp.merge_bands(rects, ROI_SETTINGS["roiMergeArea"])
        for d in PACK["detectors"]:
            for r in d.get("rois", []):
                self.assertTrue(any(b[0] <= r["x0"] and b[1] <= r["y0"] and b[2] >= r["x1"] and b[3] >= r["y1"]
                                    and d["id"] in b[5] for b in bands), (d["id"], r))

    def test_mode_band_sets(self):
        self.assertEqual(dp.pack_modes(PACK), ["br", "mp"])
        mp = {i for r in dp.roi_rects(PACK, ROI_SETTINGS, "mp") for i in r[5]}
        br = {i for r in dp.roi_rects(PACK, ROI_SETTINGS, "br") for i in r[5]}
        self.assertIn("M3", mp)
        self.assertNotIn("B1", mp)
        self.assertIn("B1", br)
        self.assertNotIn("M3", br)
        self.assertIn("X1", mp & br)  # both modes, one ROI each
        x1 = [r[:4] for r in dp.roi_rects(PACK, ROI_SETTINGS, "br") if r[5] == {"X1"}]
        self.assertEqual(len(x1), 1)
        self.assertLess(x1[0][1], 0.05)  # the BR banner ROI (top), not the MP one

    def test_band_boxes_back_to_game_fractions(self):
        # H canvas 1920x1080 with the game area at (100, 50, 1600x900); the sampled image is the visible area
        import g1_scan
        layout = {"frame": [1920, 1080], "game": [100, 50, 1600, 900], "visible": [100, 50, 1700, 950]}
        v = g1_scan.visible_box(layout)
        origin, size = (v[0], v[1]), (v[2] - v[0], v[3] - v[1])
        bands = dp.band_pixels([(0.25, 0.0, 0.75, 0.4, 1, {"M3"})], layout, origin, size)
        self.assertEqual(bands[0]["px"], (400, 0, 1200, 360))
        # a box at band-local px (240, 198)-(560, 243) = image px (640, 198)-(960, 243)
        boxes = dp.band_boxes([[{"text": "TRIPLE KILL", "score": 0.9, "x0": 240, "y0": 198, "x1": 560, "y1": 243}]],
                              bands, size)
        rec = g1_scan._frame_record(boxes, layout, origin)
        self.assertEqual(rec[0]["g"], [0.4, 0.22, 0.6, 0.27])
        self.assertEqual([h["label"] for h in dp.frame_hits(rec, PACK, NAMES, SETTINGS, "mp")
                          if h["detector"] == "M3" and h["signal"]], ["Triple Kill"])

    def test_overlapping_bands_read_once(self):
        size = (1000, 500)
        bands = [{"px": (0, 0, 600, 200)}, {"px": (400, 0, 1000, 200)}]
        same = {"text": "FURY KILL", "x0": 450, "y0": 50, "x1": 550, "y1": 80}
        cut = {"text": "ULTRA K", "x0": 520, "y0": 100, "x1": 598, "y1": 130}  # cut by band 0's right edge
        whole = {"text": "ULTRA KILL", "x0": 120, "y0": 100, "x1": 260, "y1": 130}  # band 1 local px
        out = dp.band_boxes([[dict(same, score=0.8), dict(cut, score=0.99)],
                             [dict(same, x0=50, x1=150, score=0.9), dict(whole, score=0.9)]], bands, size)
        self.assertEqual(sorted((b["text"], b["score"], b["x0"]) for b in out),
                         [("FURY KILL", 0.9, 450), ("ULTRA KILL", 0.9, 520)])

    def test_text_filter_keeps_rule_rois_only(self):
        import g1_scan
        layout = g1_scan.full_screen_layout(1920, 1080, [0, 0, 1920, 1080])
        real_set = g1_scan.set_ocr_params
        g1_scan.set_ocr_params = lambda extra: None
        try:
            sc = dp.FrameScanner(PACK, NAMES, {**ROI_SETTINGS, "roiTextFilter": True}, layout, threads=1)
        finally:
            g1_scan.set_ocr_params = real_set
        band = next(b for b in sc.band_sets["mp"] if "M3" in b["detectors"] and b["px"][1] == 0)
        keep = sc._keeper(band)
        x0, y0 = band["px"][:2]
        self.assertTrue(keep((960 - x0, 265 - y0)))  # medal banner centre (0.5, 0.245)
        w, h = band["px"][2] - x0, band["px"][3] - y0
        grid = [(x, y) for x in range(0, w, 8) for y in range(0, h, 8)]
        outside = [p for p in grid if not any(r[0] <= (p[0] + x0) / 1920 <= r[2] and r[1] <= (p[1] + y0) / 1080 <= r[3]
                                              for r in band["rules"])]
        self.assertTrue(outside)  # the pad around the rule ROIs
        self.assertFalse(any(keep(p) for p in outside))
        self.assertTrue(all(keep(p) for p in grid if p not in outside))

    @unittest.skipUnless(HAVE_CV, "needs numpy and opencv")
    def test_scanner_rois_with_stub_ocr(self):
        import g1_scan
        layout = g1_scan.full_screen_layout(1920, 1080, [0, 0, 1920, 1080])
        real_ocr, real_set = dp.ocr_crops, g1_scan.set_ocr_params
        calls = []

        def stub(crops, det_scale=1.0, keep=None):  # "reads" the medal text where its white block sits in a crop
            calls.append(len(crops))
            out = []
            for c in crops:
                n, _lab, st, _c = cv2.connectedComponentsWithStats((c[..., 0] == 255).astype(np.uint8))
                out.append([{"text": "TRIPLE KILL", "score": 0.95, "x0": float(x), "y0": float(y),
                             "x1": float(x + w), "y1": float(y + h)} for x, y, w, h, _a in st[1:n]])
            return out
        dp.ocr_crops, g1_scan.set_ocr_params = stub, lambda extra: None
        try:
            sc = dp.FrameScanner(PACK, NAMES, ROI_SETTINGS, layout, threads=1)
            img = np.zeros((1080, 1920, 3), np.uint8)
            img[238:292, 845:1075] = 255  # the M3 banner text block, game fractions (0.44, 0.22)-(0.56, 0.27)
            h1 = sc.scan(0.0, img)
            h2 = sc.scan(1.0, img)  # unchanged: every band diff-gated, the hits continue
        finally:
            dp.ocr_crops, g1_scan.set_ocr_params = real_ocr, real_set
        self.assertEqual(calls, [len(sc.band_sets[None])])  # mode unknown: all bands, in one batched call
        self.assertEqual(sc.stats["ocrCalls"], 1)
        self.assertEqual([(h["detector"], h["label"], h["signal"], h["t"]) for h in h1 if h["detector"] == "M3"],
                         [("M3", "Triple Kill", True, 0.0)])
        self.assertEqual([(h["label"], h["t"]) for h in h2 if h["detector"] == "M3"], [("Triple Kill", 1.0)])
        self.assertEqual(sc.stats["diffGateSkips"], 1)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class CandidatesWithHitsTests(unittest.TestCase):
    """clipper candidates picks up DIR/detector-hits.jsonl from `detect`; hits are listed, weigh 0, rank nothing."""

    def test_hits_listed_and_zero(self):
        with tempfile.TemporaryDirectory() as td:
            rec = os.path.join(td, "rec-h-20261103-070000.mkv")
            r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "4", "-f", "lavfi", "-i",
                             "testsrc2=size=320x180:rate=30:duration=40", "-c:v", "libopenh264", "-b:v", "300k", rec],
                            timeout=300)
            if r.returncode != 0:
                self.skipTest(f"cannot generate media: {r.stderr[-200:]}")
            data = os.path.join(td, "data")
            os.makedirs(data)
            with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                json.dump({"flags": {"clip-pipeline": True}}, f)
            markers = os.path.join(td, "m.jsonl")
            with open(markers, "w", encoding="utf-8") as f:
                f.write(json.dumps({"v": 1, "at": "2026-11-03T07:00:20.000Z", "source": "hotkey",
                                    "recordMs": 20000}) + "\n")
            out = os.path.join(td, "out")
            os.makedirs(out)
            with open(os.path.join(out, dp.HITS), "w", encoding="utf-8") as f:
                for t, lab in ((15.0, "Triple Kill"), (38.0, "Fury Kill")):
                    f.write(json.dumps({"t": t, "detector": "M3", "label": lab, "signal": True, "role": "positive",
                                        "clipReason": True, "weight": None}) + "\n")
            with open(os.path.join(out, dp.SUMMARY), "w", encoding="utf-8") as f:
                json.dump({"recording": os.path.basename(rec)}, f)
            ranking = os.path.join(td, "ranking.json")  # the rule under test: weights not approved
            with open(ranking, "w", encoding="utf-8") as f:
                json.dump({**RANKING, "detectorWeightsStatus": "proposed", "detectorWeights": {}}, f)
            rc = clipper.main(["--data-dir", data, "--ranking", ranking, "candidates", "--recording", rec,
                               "--markers", markers, "--record-start", "2026-11-03T07:00:00Z", "--out", out])
            self.assertEqual(rc, 0)
            doc = cc.load_json(os.path.join(out, clipper.CANDIDATES))
        self.assertEqual(len(doc["candidates"]), 1)
        self.assertEqual(doc["candidates"][0]["score"], 1.0)  # the hotkey alone
        self.assertEqual(doc["signals"]["detectors"]["counted"], 0)
        self.assertEqual(doc["signals"]["detectors"]["attached"], 1)
        self.assertEqual(doc["signals"]["detectors"]["weightsStatus"], "proposed")
        self.assertEqual([(h["label"], h["weight"], h["candidate"]) for h in doc["detectorHits"]],
                         [("Triple Kill", 0.0, "c01"), ("Fury Kill", 0.0, None)])


class ProjectLayoutTests(unittest.TestCase):
    """D235: a canvas recording is scanned only inside the game layer, never over the overlays around it."""
    PROJECT = {
        "canvases": [{"id": "h", "width": 1920, "height": 1080}],
        "devices": [{"id": "dev-g", "format": {"width": 1920, "height": 1080, "fps": 60}}],
        "scenes": [{"id": "s", "layers": [
            {"id": "cam", "type": "capture", "origin": {"id": "scene-default-h/facecam"}, "source": {"device": "dev-g"},
             "placements": {"h": {"x": 0, "y": 0, "width": 10, "height": 10}}},
            {"id": "game", "type": "capture", "origin": {"importer": "preset", "id": "scene-default-h/game"},
             "source": {"device": "dev-g"},
             "placements": {"h": {"visible": True, "x": 467.96, "y": 31.18, "width": 1417.8, "height": 977.84,
                                  "crop": {"left": 177, "right": 177}}}}]}],
    }

    def test_cropped_game_layer(self):
        lay = dp.project_layout(self.PROJECT, 1920, 1080)
        self.assertEqual(lay["visible"], [467.96, 31.18, 1885.76, 1009.02])
        g = lay["game"]  # the whole game frame, wider than what is shown (177 source px cut on each side)
        self.assertAlmostEqual(g[0], 467.96 - 177 * 1417.8 / 1566, places=1)
        self.assertAlmostEqual(g[2], 1920 * 1417.8 / 1566, places=1)
        self.assertAlmostEqual(g[3], 977.84, places=1)

    def test_scaled_recording(self):
        a = dp.project_layout(self.PROJECT, 1920, 1080)
        b = dp.project_layout(self.PROJECT, 1280, 720)
        for i in range(4):
            self.assertAlmostEqual(b["visible"][i], a["visible"][i] * 2 / 3, places=1)

    def test_refusals(self):
        import copy
        p = copy.deepcopy(self.PROJECT)
        p["scenes"][0]["layers"][1]["placements"]["h"]["rotation"] = 90
        with self.assertRaises(ValueError):
            dp.project_layout(p, 1920, 1080)
        p = copy.deepcopy(self.PROJECT)
        p["devices"][0]["format"] = {}
        with self.assertRaises(ValueError):
            dp.project_layout(p, 1920, 1080)
        p = copy.deepcopy(self.PROJECT)
        p["scenes"][0]["layers"].pop(1)
        with self.assertRaises(ValueError):
            dp.project_layout(p, 1920, 1080)


if __name__ == "__main__":
    unittest.main()
