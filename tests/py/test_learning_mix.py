# SPDX-License-Identifier: GPL-3.0-or-later
"""RP5 / AN2 self-learning, planner side (services/clip/learning_mix.py, D373, flag self-learning): the mix is read only
with the flag on and a learned mix in use (cold start and undo-to-start = today's plan, unchanged); per-reel picks are
seeded and follow the shares; a feature that is off is never turned on; the montage length band stays inside the user's
limits; publish records the choices a reel was made with. Placeholder ids and files only."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_publish as pub  # noqa: E402
import learning_mix as lm  # noqa: E402

CFG = lm.load_config()
EX = {"transition": {"kind": "fade", "xfade": "fade", "ms": 250}, "title": {"version": "x"}, "music": {"version": "y"},
      "cap_on": False}


def defaults():
    return {d["id"]: dict(d["defaults"]) for d in CFG["dimensions"]}


def write(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))


class LoadMixTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ujw-lmix-")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _flag(self, on):
        write(os.path.join(self.d, "flags.local.json"), {"flags": {"self-learning": on}})

    def _mix(self, applied=True, shares=None):
        write(os.path.join(self.d, lm.MIX_FILE), {"version": 1, "applied": applied, "shares": shares or defaults(),
                                                  "changedAt": "2026-11-13T12:00:00.000Z"})

    def test_flag_off_by_default_gives_none(self):
        self._mix()
        self.assertIsNone(lm.load_mix(self.d))
        self._flag(False)
        self.assertIsNone(lm.load_mix(self.d))

    def test_cold_start_or_bad_file_gives_none(self):
        self._flag(True)
        self.assertIsNone(lm.load_mix(self.d), "no file yet")
        self._mix(applied=False)
        self.assertIsNone(lm.load_mix(self.d), "applied false = cold start / undone to the start")
        bad = defaults()
        bad["music"] = {"on": 0.7, "off": 0.7}
        self._mix(shares=bad)
        self.assertIsNone(lm.load_mix(self.d), "shares that do not add up")
        write(os.path.join(self.d, lm.MIX_FILE), "{not json")
        self.assertIsNone(lm.load_mix(self.d))

    def test_flag_on_and_applied_gives_the_mix(self):
        self._flag(True)
        self._mix()
        m = lm.load_mix(self.d)
        self.assertEqual(m["changedAt"], "2026-11-13T12:00:00.000Z")
        self.assertAlmostEqual(m["shares"]["title"]["on"], 0.9)


class PlannerTests(unittest.TestCase):
    MIX = {"shares": defaults(), "changedAt": "2026-11-13T12:00:00.000Z"}

    def test_no_mix_leaves_the_plan_exactly_as_before(self):
        self.assertIs(lm.reel_choices(EX, None, "M01", "rec-v.mkv"), EX)
        cfg = {"targetMinSec": 30.0, "targetMaxSec": 45.0}
        self.assertIs(lm.length_target(cfg, {"minSec": 20, "maxSec": 60}, None, "rec-v.mkv"), cfg)

    def test_picks_are_seeded_and_follow_the_shares(self):
        a = lm.reel_choices(EX, self.MIX, "M01", "rec-v.mkv")
        b = lm.reel_choices(EX, self.MIX, "M01", "rec-v.mkv")
        self.assertEqual(a["learning"], b["learning"])
        offs = sum(1 for i in range(2000) if lm.reel_choices(EX, self.MIX, f"M{i}", "rec-v.mkv")["title"] is None)
        self.assertTrue(140 <= offs <= 260, offs)  # about 10 % of 2000 off
        self.assertIsNot(a, EX)
        self.assertEqual(EX["title"], {"version": "x"}, "the run's extras are never changed in place")

    def test_a_feature_that_is_off_is_never_turned_on(self):
        sh = defaults()
        sh["transition"] = {"cut": 0.1, "fade": 0.9}
        sh["title"] = {"off": 0.1, "on": 0.9}
        mix = {"shares": sh, "changedAt": "x"}
        ex_off = dict(EX, transition=None, title=None, music=None)
        for i in range(200):
            r = lm.reel_choices(ex_off, mix, f"M{i}", "rec-v.mkv")
            self.assertIsNone(r["transition"])
            self.assertIsNone(r["title"])
            self.assertIsNone(r["music"])

    def test_length_band_stays_inside_the_user_limits(self):
        sh = defaults()
        sh["lengthBand"] = {"short": 0.1, "mid": 0.1, "long": 0.8}
        mix = {"shares": sh, "changedAt": "x"}
        seen = set()
        for i in range(50):
            c = lm.length_target({"targetMinSec": 30.0, "targetMaxSec": 45.0}, {"minSec": 20, "maxSec": 50}, mix, f"r{i}.mkv")
            seen.add(c.get("learningBand"))
            self.assertGreaterEqual(c["targetMinSec"], 20)
            self.assertLessEqual(c["targetMaxSec"], 50)
        self.assertIn("long", seen)

    def test_choices_record(self):
        self.assertEqual(lm.choices_record({"transition": {"kind": "fade", "joinSec": 0.25}, "title": {"x": 1}, "music": None}),
                         {"transition": "fade", "title": "on", "music": "off"})
        self.assertEqual(lm.choices_record({}, "2026-11-13T12:00:00.000Z"),
                         {"transition": "cut", "title": "off", "music": "off", "mixAt": "2026-11-13T12:00:00.000Z"})


class PublishChoicesTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ujw-lmixpub-")
        self.data = os.path.join(self.d, "data")
        self.work = os.path.join(self.data, "clips", "runs", "practice-h-20261108-185525", "montage")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_a_montage_row_carries_its_choices(self):
        rdoc = {"tool": "clipper.montage", "recording": "practice-h-20261108-185525.mkv", "clips": [
            {"id": "M01", "start": 0.0, "end": 38.0, "pieces": [{"start": 100.0, "end": 120.0, "kills": 2}],
             "transition": {"kind": "fade", "joinSec": 0.25}, "title": None, "music": {"seed": 1},
             "learning": {"mixAt": "2026-11-13T12:00:00.000Z", "picks": {"title": "off"}},
             "files": [{"layout": "montage-v", "file": "montage-v.mp4"}]}]}
        write(os.path.join(self.work, "render.json"), rdoc)
        write(os.path.join(self.work, "report.json"), {"results": [{"id": "M01", "file": "montage-v.mp4", "ok": True}]})
        write(os.path.join(self.work, "clips", "M01", "montage-v.mp4"), "video")
        pub.publish(self.work, os.path.join(self.d, "clips"), self.data, "codm", {"montage-v": {"input": "v"}}, {},
                    run_name="practice-h-20261108-185525")
        with open(os.path.join(self.data, "clips", "uploads.json"), encoding="utf-8") as f:
            up = json.load(f)
        self.assertEqual(up["files"][0]["choices"], {"transition": "fade", "title": "off", "music": "on",
                                                     "mixAt": "2026-11-13T12:00:00.000Z"})


if __name__ == "__main__":
    unittest.main()
