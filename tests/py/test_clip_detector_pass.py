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

    def test_detector_weights_not_approved(self):
        # The rule this pass depends on: detector hits weigh 0 until the user approves weights.
        self.assertEqual(RANKING["detectorWeightsStatus"], "proposed")
        self.assertEqual(RANKING["detectorWeights"], {})

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
        c = rank.build_candidates(dev, 1000.0, RANKING)
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
                                   "clipReason": True, "role": "positive", "weight": None})
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
            rc = clipper.main(["--data-dir", data, "candidates", "--recording", rec, "--markers", markers,
                               "--record-start", "2026-11-03T07:00:00Z", "--out", out])
            self.assertEqual(rc, 0)
            doc = cc.load_json(os.path.join(out, clipper.CANDIDATES))
        self.assertEqual(len(doc["candidates"]), 1)
        self.assertEqual(doc["candidates"][0]["score"], 1.0)  # the hotkey alone
        self.assertEqual(doc["signals"]["detectors"]["counted"], 0)
        self.assertEqual(doc["signals"]["detectors"]["attached"], 1)
        self.assertEqual(doc["signals"]["detectors"]["weightsStatus"], "proposed")
        self.assertEqual([(h["label"], h["weight"], h["candidate"]) for h in doc["detectorHits"]],
                         [("Triple Kill", 0.0, "c01"), ("Fury Kill", 0.0, None)])


if __name__ == "__main__":
    unittest.main()
