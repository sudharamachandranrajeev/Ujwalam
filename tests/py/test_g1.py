# SPDX-License-Identifier: GPL-2.0-or-later
"""Unit tests for the G1 helpers: services/clip/g1_text.py and g1_geometry.py.

Synthetic data only: invented player names and layouts. Stdlib only, so they run
under the system Python: python -I -m unittest discover -s tests/py -t tests/py
OCR-dependent tests are in test_g1_ocr.py and skip without the OCR venv.
"""

import importlib.util
import os
import subprocess
import unittest

# No console window on Windows (D191): every subprocess call passes **NO_WINDOW.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_CLIP, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gt = _load("g1_text")
geo = _load("g1_geometry")
gp = _load("game_pack")
PACK_DIR = os.path.join(_HERE, "..", "..", "data", "games", "codm")

NAMES = ["Zorbo~QX", "Zorbo-QX", "Zorbo"]  # invented
MEDALS = ["Double Kill", "Triple Kill", "Fury Kill", "Merciless", "Revenge"]


class TextTests(unittest.TestCase):
    def test_normalise_drops_separators(self):
        self.assertEqual(gt.normalise("Zorbo~QX"), "ZORBOQX")
        self.assertEqual(gt.normalise("zorbo^qx "), "ZORBOQX")
        self.assertEqual(gt.normalise(None), "")

    def test_ratio_and_partial(self):
        self.assertEqual(gt.ratio("ABC", "ABC"), 1.0)
        self.assertAlmostEqual(gt.ratio("ABCD", "ABXD"), 0.75)
        self.assertEqual(gt.partial_ratio("ZORBO", "[TAG]ZORBOQX"), 1.0)
        self.assertEqual(gt.partial_ratio("", "X"), 0.0)

    def test_name_score_separator_glyphs(self):
        for t in ("Zorbo~QX", "Zorbo-QX", "Zorbo^QX", "ZorboQX"):
            s = gt.name_score(t, NAMES)
            self.assertEqual(s["score"], 1.0, t)
            self.assertTrue(s["exact"])

    def test_name_score_ocr_confusion(self):
        s = gt.name_score("Z0rb0-QX", NAMES)  # zeros for O
        self.assertGreaterEqual(s["score"], 0.99)
        self.assertFalse(s["exact"])

    def test_name_score_other_player(self):
        s = gt.name_score("Kestrel77", NAMES)
        self.assertLess(s["score"], 0.6)

    def test_name_score_returns_index_not_name(self):
        s = gt.name_score("xx Zorbo yy", NAMES)
        self.assertIn(s["index"], (0, 1, 2))
        self.assertNotIn("name", s)

    def test_medal_exact_fuzzy_ignore(self):
        self.assertEqual(gt.match_medal("Fury Kill", MEDALS)["medal"], "Fury Kill")
        self.assertTrue(gt.match_medal("FURY KILL", MEDALS)["exact"])
        m = gt.match_medal("Mercilss", MEDALS)
        self.assertEqual(m["medal"], "Merciless")
        self.assertFalse(m["exact"])
        ig = gt.match_medal("Normal Kill", MEDALS, ignore=["Normal Kill"])
        self.assertIsNone(ig["medal"])
        self.assertIsNone(gt.match_medal("Kill", MEDALS))
        self.assertIsNone(gt.match_medal("", MEDALS))

    def test_points(self):
        self.assertEqual(gt.parse_points("+125"), 125)
        self.assertEqual(gt.parse_points(" + 4 "), 4)  # OCR may split '+' and digits with a space
        self.assertIsNone(gt.parse_points("125"))
        self.assertIsNone(gt.parse_points("+12a"))

    def test_kill_count(self):
        self.assertEqual(gt.parse_kill_count("7 KILL(S)"), 7)
        self.assertEqual(gt.parse_kill_count("1 KILL"), 1)
        self.assertEqual(gt.parse_kill_count("12 kills"), 12)
        self.assertIsNone(gt.parse_kill_count("KILLS"))

    def test_group_lines_and_killfeed_side(self):
        boxes = [
            {"text": "Kestrel77", "x0": 300, "y0": 10, "x1": 400, "y1": 30},
            {"text": "Zorbo~QX", "x0": 10, "y0": 12, "x1": 120, "y1": 32},
            {"text": "Zorbo-QX", "x0": 300, "y0": 50, "x1": 400, "y1": 70},
            {"text": "Wombat", "x0": 10, "y0": 52, "x1": 100, "y1": 72},
        ]
        lines = gt.group_lines(boxes)
        self.assertEqual(len(lines), 2)
        self.assertEqual([b["text"] for b in lines[0]], ["Zorbo~QX", "Kestrel77"])
        self.assertEqual(gt.killfeed_side(lines[0], NAMES, 0.8)[0], "killer")
        self.assertEqual(gt.killfeed_side(lines[1], NAMES, 0.8)[0], "victim")
        self.assertIsNone(gt.killfeed_side([boxes[0]], NAMES, 0.8)[0])
        self.assertEqual(gt.killfeed_side([], NAMES, 0.8), (None, 0.0))

    def test_killfeed_side_merged_box(self):
        one = lambda t: [{"text": t, "x0": 0, "y0": 0, "x1": 10, "y1": 2}]
        self.assertEqual(gt.killfeed_side(one("Zorbo~QXKestrel77"), NAMES, 0.8)[0], "killer")
        self.assertEqual(gt.killfeed_side(one("Kestrel77 Zorbo-QX 3"), NAMES, 0.8)[0], "victim")
        self.assertIsNone(gt.killfeed_side(one("Zorbo-QX"), NAMES, 0.8)[0])  # name only: no side
        self.assertIsNone(gt.killfeed_side(one("Kestrel77 Wombat"), NAMES, 0.8)[0])


class GeometryTests(unittest.TestCase):
    FULL = {"frame": [1920, 1080], "game": [176, 0, 1566, 1080], "visible": [176, 0, 1742, 1080]}
    # invented vertical layout: game scaled 0.5 and shifted so its left 20 % is cut off
    VERT = {"frame": [1000, 1800], "game": [-200, 500, 1000, 500], "visible": [0, 500, 1000, 1000]}

    def test_roi_box_full(self):
        b = geo.roi_box({"x0": 0, "y0": 0, "x1": 1, "y1": 1}, self.FULL["game"])
        self.assertEqual(b, (176, 0, 1742, 1080))

    def test_visibility(self):
        inside = {"x0": 0.4, "y0": 0.1, "x1": 0.6, "y1": 0.2}
        left = {"x0": 0.0, "y0": 0.1, "x1": 0.4, "y1": 0.2}
        out = {"x0": 0.0, "y0": 0.1, "x1": 0.1, "y1": 0.2}
        self.assertEqual(geo.roi_visibility(inside, self.VERT), 1.0)
        self.assertAlmostEqual(geo.roi_visibility(left, self.VERT), 0.5)
        self.assertEqual(geo.roi_visibility(out, self.VERT), 0.0)
        self.assertIsNone(geo.roi_crop_px(out, self.VERT))
        self.assertEqual(geo.roi_crop_px(left, self.VERT), (0, 550, 200, 600))

    def test_visible_game_fraction(self):
        self.assertEqual(geo.visible_game_fraction(self.VERT), (0.2, 0.0, 1.0, 1.0))
        self.assertEqual(geo.visible_game_fraction(self.FULL), (0.0, 0.0, 1.0, 1.0))

    def test_game_from_landmarks_roundtrip(self):
        ref_game = (176, 0, 1566, 1080)
        a, b = (460, 1060), (935, 1050)
        s, ox, oy = 0.857, -300.0, 466.0  # invented transform of the reference canvas
        fa = (ox + s * a[0], oy + s * a[1])
        fb = (ox + s * b[0], oy + s * b[1])
        g = geo.game_from_landmarks(a, fa, b, fb, ref_game)
        self.assertAlmostEqual(g[0], ox + s * 176, places=6)
        self.assertAlmostEqual(g[1], oy, places=6)
        self.assertAlmostEqual(g[2], s * 1566, places=6)
        self.assertAlmostEqual(g[3], s * 1080, places=6)
        with self.assertRaises(ValueError):
            geo.game_from_landmarks(a, fa, (a[0], 0), fb, ref_game)
        self.assertEqual(geo.game_from_scale(s, fa, a, ref_game), g)

    def test_point_to_game(self):
        self.assertEqual(geo.point_to_game(176 + 783, 540, self.FULL["game"]), (0.5, 0.5))


class PackTests(unittest.TestCase):
    """The committed CODM pack stays usable by the G1 tools."""

    def test_pack_rois_are_ordered(self):
        pack = gp.load_pack(PACK_DIR)
        for d in pack["detectors"]:
            for r in d["rois"]:
                self.assertLess(r["x0"], r["x1"], (d["id"], r["id"]))
                self.assertLess(r["y0"], r["y1"], (d["id"], r["id"]))


scan = _load("g1_scan")
PACK = gp.load_pack(PACK_DIR)  # split pack (W0), merged by the loader
PLACEHOLDER_NAMES = ["Zorbo~QX", "Zorbo-QX"]  # invented


def _box(text, g, score=0.99):
    return {"text": text, "score": score, "g": g}


class DecisionTests(unittest.TestCase):
    """User decisions 2026-10-27: medal classes, FINAL KILLCAM name rule, dmz tagging."""

    def test_medal_classes_from_pack(self):
        cls = scan.medal_classes(PACK)
        for m in ["Double Kill", "Triple Kill", "Fury Kill", "Frenzy Kill", "Merciless", "Nuclear",
                  "Ultimate Terminator", "Ultra Kill", "Mega Kill", "Super Kill", "Ruthless", "Relentless", "Brutal"]:
            self.assertEqual(cls[m], "positive", m)
        for m in ["Survivor", "Kingslayer", "Long Shot", "Headshot", "Major Assist", "Minor Assist", "UAV Assist",
                  "Hardpoint Kill", "Trophy System Destroy"]:
            self.assertEqual(cls[m], "reference", m)

    def test_reference_medal_event_carries_class(self):
        evs = scan.find_events([_box("Major Assist", [0.45, 0.22, 0.55, 0.28])], PACK, PLACEHOLDER_NAMES, 0.8)
        m3 = [e for e in evs if e["det"] == "M3"]
        self.assertEqual([e["medalClass"] for e in m3], ["reference"])
        evs = scan.find_events([_box("Triple Kill", [0.45, 0.22, 0.55, 0.28])], PACK, PLACEHOLDER_NAMES, 0.8)
        self.assertEqual([e["medalClass"] for e in evs if e["det"] == "M3"], ["positive"])

    def test_final_killcam_signal_needs_name(self):
        label = _box("FINAL KILLCAM", [0.45, 0.056, 0.56, 0.092])
        k1 = lambda boxes: [e for e in scan.find_events(boxes, PACK, PLACEHOLDER_NAMES, 0.8) if e["det"] == "K1"]
        with_name = k1([label, _box("Zorbo~QX", [0.46, 0.1, 0.55, 0.13])])
        self.assertEqual(len(with_name), 1)
        self.assertTrue(with_name[0]["signal"] and with_name[0]["nameMatched"])
        without = k1([label, _box("Other~Person", [0.46, 0.1, 0.55, 0.13])])
        self.assertEqual(len(without), 1)  # logged for evidence
        self.assertFalse(without[0]["signal"])
        self.assertFalse(without[0]["nameMatched"])
        # name far from the label (e.g. kill feed) is not the killer name
        far = k1([label, _box("Zorbo~QX", [0.3, 0.9, 0.4, 0.93])])
        self.assertFalse(far[0]["signal"])

    def test_final_killcam_is_not_n1(self):
        evs = scan.find_events([_box("FINAL KILLCAM", [0.45, 0.056, 0.56, 0.092])], PACK, PLACEHOLDER_NAMES, 0.8)
        self.assertNotIn("N1", [e["det"] for e in evs])
        evs = scan.find_events([_box("KILLCAM", [0.04, 0.03, 0.13, 0.07])], PACK, PLACEHOLDER_NAMES, 0.8)
        self.assertIn("N1", [e["det"] for e in evs])
        self.assertNotIn("K1", [e["det"] for e in evs])

    def test_br_feed_ignores_small_squad_list_text(self):
        # live capture 2: the squad list (small text, the user's own name) shares the B1 band
        b1 = lambda boxes: [e for e in scan.find_events(boxes, PACK, PLACEHOLDER_NAMES, 0.8) if e["det"] == "B1"]
        squad = _box("Zorbo~QX", [0.025, 0.205, 0.08, 0.22])  # height 0.015
        self.assertEqual(b1([squad]), [])
        feed = [_box("Zorbo~QX", [0.01, 0.22, 0.09, 0.25]), _box("Other~Person", [0.15, 0.22, 0.25, 0.25])]
        lines = b1([squad] + feed)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["side"], "killer")
        self.assertNotIn("0.205", str(lines[0]["box"]["g"]))

    def test_dmz_classification_and_tags(self):
        # dmz is never auto-classified, even with DMZ/EXFIL text on screen
        self.assertEqual(scan.classify_frame([_box("DMZ", [0, 0, 0.1, 0.1]), _box("EXFIL", [0, 0, 0.1, 0.1])]), None)
        self.assertEqual(scan.classify_frame([_box("DMZ", [0, 0, 0.1, 0.1]), _box("SAFE ZONE", [0, 0, 0.1, 0.1])]), "br")
        tags = {"s-2026-01-01-0000": "dmz", "s-2026-01-02-0000/clip-a.mp4": "mp"}
        self.assertEqual(scan.tagged_mode(tags, "s-2026-01-01-0000", "any.mp4"), "dmz")
        self.assertEqual(scan.tagged_mode(tags, "s-2026-01-02-0000", "clip-a.mp4"), "mp")
        self.assertIsNone(scan.tagged_mode(tags, "s-2026-01-02-0000", "clip-b.mp4"))
        self.assertIsNone(scan.tagged_mode(None, "x", "y"))
        self.assertEqual(scan.clip_mode({"mp": 1, "br": 3, "dmz": 3, "none": 0}), "dmz")
        self.assertEqual(scan.clip_mode({"mp": 1, "br": 3, "dmz": 0, "none": 0}), "br")

    def test_pack_declares_dmz_tag_only(self):
        self.assertIn("dmz", PACK["modes"])
        self.assertEqual(PACK["taggingOnlyModes"], ["dmz"])
        for d in PACK["detectors"]:
            self.assertNotIn("dmz", d["modes"], d["id"])
        for s in PACK["screens"]:
            if s["detectors"]:
                self.assertNotIn("dmz", s["modes"], s["id"])

    def test_screens_gameplay_cues_match_the_frame_classifier(self):
        # W0: screens.json holds the classifier's HUD words as data; keep the two in step until
        # the W2 screen classifier reads them from the pack.
        cues = {s["id"]: s["cues"][0]["texts"] for s in PACK["screens"] if s["kind"] == "gameplay"}
        self.assertEqual(cues, {"mp_gameplay": scan.MODE_CUES["mp"], "br_gameplay": scan.MODE_CUES["br"]})

    def test_refmedals_default_dataset_comes_from_the_pack(self):
        path = scan.default_dataset(PACK)
        self.assertEqual(os.path.normpath(path),
                         os.path.normpath(os.path.join(scan.repo_root(), "data", "games", "codm", "local", "medals-reference")))
        self.assertIsNone(scan.default_dataset({"detectors": [{"id": "M1"}]}))


class ResourceTests(unittest.TestCase):
    """Laptop budget (user instruction 2026-10-27): OCR threads capped, ffmpeg 2 threads, low priority."""

    def test_thread_params_cap_onnxruntime(self):
        p = scan.thread_params(4)
        self.assertEqual(p["EngineConfig.onnxruntime.intra_op_num_threads"], 4)
        self.assertEqual(p["EngineConfig.onnxruntime.inter_op_num_threads"], 1)
        self.assertEqual(scan.DEFAULT_THREADS, 4)

    def test_ffmpeg_decode_threads(self):
        cmd = scan.ffmpeg_base()
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertEqual(cmd[cmd.index("-threads") + 1], "2")

    def test_children_below_normal_on_windows(self):
        kw = scan.child_kwargs()
        if os.name == "nt":
            import subprocess
            self.assertEqual(kw["creationflags"], subprocess.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            self.assertEqual(kw, {})


class BucketSelectTests(unittest.TestCase):
    """Frame i of a 1 fps scan must be clip time i s, also when the first frame decodes
    at t = -0.0000002 (seen on 2026-10-27 live captures; scan times were 1 s late)."""

    def _count(self, shift_ticks):
        import shutil
        import subprocess
        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg not on PATH")
        # 3 s at 10 fps, tb 1/5000000, every pts moved back by shift_ticks.
        vf = f"settb=1/5000000,setpts=PTS-{shift_ticks},{scan.bucket_select(1)},showinfo"
        out = subprocess.run(["ffmpeg", "-v", "info", "-nostdin", "-f", "lavfi", "-i",
                              "testsrc=size=32x24:rate=10:duration=3", "-vf", vf,
                              "-fps_mode", "passthrough", "-f", "null", "-"],
                             capture_output=True, text=True, check=True, **NO_WINDOW)
        return [ln for ln in out.stderr.splitlines() if "pts_time:" in ln]

    def test_one_frame_per_second_from_zero(self):
        self.assertEqual(len(self._count(0)), 3)

    def test_tiny_negative_first_pts_adds_no_bucket(self):
        frames = self._count(1)  # first frame at -0.0000002 s
        self.assertEqual(len(frames), 3)
        self.assertIn("pts_time:-", frames[0])  # that frame is bucket 0, not its own


if __name__ == "__main__":
    unittest.main()
