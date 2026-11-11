# SPDX-License-Identifier: GPL-3.0-or-later
"""CL1 (D350): the reel length cap. Montages, match reels and impact-play reels are at most the user's maximum for their
type (60 s by default) and split into parts at piece boundaries; a single piece over the maximum is trimmed around its
peak and the trim is recorded; the setting is honoured (settings.json clips.reelLengths). Synthetic pieces only."""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import clip_names as names  # noqa: E402
import clip_publish as pub  # noqa: E402
import live_chain  # noqa: E402
import reel_length as rl  # noqa: E402

RANKING = cc.load_config("ranking")
CFG = cc.load_config("montage")


def piece(start, secs, kills=1):
    return {"start": float(start), "end": float(start + secs), "kills": kills}


def reel(*pieces, **kw):
    ps = list(pieces)
    return dict({"pieces": ps, "seconds": sum(p["end"] - p["start"] for p in ps), "score": 1.0, "labels": ["X"],
                 "kills": sum(p["kills"] for p in ps)}, **kw)


def kill(t):
    return {"t": float(t), "detector": "M5", "label": "MP kill feed", "signal": True, "role": "positive"}


class DefaultsTests(unittest.TestCase):
    def test_defaults_are_data(self):
        d = rl.load_defaults()
        self.assertEqual(d["limitMaxSec"], 60)
        self.assertEqual(d["order"], ["montage", "match-reel", "impact-play", "short", "live-clip"])
        for t in d["types"].values():
            self.assertEqual(t["maxSec"], 60)
        # the current minimums stay the defaults
        self.assertEqual(d["types"]["montage"]["minSec"], CFG["minSec"])
        self.assertEqual(d["types"]["short"]["minSec"], RANKING["clip"]["minSec"])
        self.assertEqual(d["types"]["live-clip"]["minSec"], cc.load_config("live-clips")["minClipSec"])

    def test_validation(self):
        self.assertEqual(rl.limits_problems({"montage": {"minSec": 10, "maxSec": 45}}), [])
        self.assertTrue(rl.limits_problems({"montage": {"minSec": 50, "maxSec": 40}}))  # min above max
        self.assertTrue(rl.limits_problems({"montage": {"minSec": 0, "maxSec": 61}}))  # above the 60 s bound
        self.assertTrue(rl.limits_problems({"montage": {"minSec": 0, "maxSec": 2}}))
        self.assertTrue(rl.limits_problems({"montage": {"minSec": -1, "maxSec": 30}}))
        self.assertTrue(rl.limits_problems({"nope": {"minSec": 1, "maxSec": 30}}))
        self.assertTrue(rl.limits_problems({"montage": {"minSec": 1}}))
        self.assertTrue(rl.limits_problems({"montage": {"minSec": "1", "maxSec": 30}}))
        self.assertTrue(rl.limits_problems({"montage": {"minSec": 10, "maxSec": 30.4}}))  # whole seconds only
        self.assertEqual(rl.limits_problems({"montage": {"minSec": 10.0, "maxSec": 30.0}}), [])

    def test_settings_are_read_and_bad_ones_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(rl.effective_limits(d)["montage"], {"minSec": 20.0, "maxSec": 60.0})
            with open(os.path.join(d, "settings.json"), "w", encoding="utf-8") as f:
                json.dump({"clips": {"reelLengths": {"montage": {"minSec": 10, "maxSec": 30},
                                                     "match-reel": {"minSec": 50, "maxSec": 40}}}}, f)
            lim = rl.effective_limits(d)
            self.assertEqual(lim["montage"], {"minSec": 10.0, "maxSec": 30.0})
            self.assertEqual(lim["match-reel"], {"minSec": 0.0, "maxSec": 60.0})  # invalid: the default


class SplitTests(unittest.TestCase):
    def test_a_reel_inside_the_maximum_is_untouched(self):
        r = reel(piece(0, 20), piece(100, 30))
        self.assertEqual(rl.split_reel(r, 60, 0), [r])

    def test_split_only_at_piece_boundaries(self):
        ps = [piece(100 * i, 25, 2) for i in range(5)]  # 125 s in five 25 s pieces
        parts = rl.split_reel(reel(*ps), 60, 0)
        self.assertEqual([p["part"] for p in parts], [1, 2, 3])
        self.assertTrue(all(p["parts"] == 3 for p in parts))
        self.assertTrue(all(p["seconds"] <= 60 for p in parts))
        flat = [q for p in parts for q in p["pieces"]]
        self.assertEqual(flat, ps)  # every piece whole, in order, none lost or cut
        self.assertEqual(sum(p["kills"] for p in parts), 10)
        self.assertEqual(parts[1]["labels"][-1], "part 2 of 3")

    def test_each_part_is_at_most_the_maximum_for_a_chosen_setting(self):
        ps = [piece(100 * i, 10) for i in range(9)]  # 90 s
        for mx in (20, 30, 45):
            parts = rl.split_reel(reel(*ps), mx, 0)
            self.assertTrue(all(p["seconds"] <= mx + 1e-6 for p in parts), mx)
            self.assertEqual(sum(len(p["pieces"]) for p in parts), 9)

    def test_a_short_last_part_borrows_from_the_one_before(self):
        ps = [piece(100 * i, 20) for i in range(3)] + [piece(400, 5)]  # 20 20 20 5: greedy gives 60 + 5
        parts = rl.split_reel(reel(*ps), 60, 20)
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(20 <= p["seconds"] <= 60 for p in parts), [p["seconds"] for p in parts])
        self.assertFalse(any(p.get("belowMin") for p in parts))

    def test_a_last_part_that_cannot_reach_the_minimum_is_kept_and_marked(self):
        parts = rl.split_reel(reel(piece(0, 58), piece(100, 5)), 60, 20)  # moving the 58 s piece leaves part 1 empty
        self.assertEqual([p["seconds"] for p in parts], [58, 5])
        self.assertTrue(parts[1]["belowMin"])

    def test_a_single_piece_over_the_maximum_is_trimmed_around_its_peak(self):
        (out,) = rl.split_reel(reel(piece(100, 100, 3), peaks=[170.0]), 60, 0)
        p = out["pieces"][0]
        self.assertEqual(p["end"] - p["start"], 60.0)
        self.assertEqual((p["start"], p["end"]), (140.0, 200.0))  # 170 +- 30 would pass 200: the window sits at the end
        t = out["trimmed"][0]
        self.assertEqual((t["from"], t["to"], t["peak"], t["droppedSec"]), ([100.0, 200.0], [140.0, 200.0], 170.0, 40.0))
        (mid,) = rl.split_reel(reel(piece(100, 100, 3), peaks=[150.0]), 60, 0)
        self.assertEqual((mid["pieces"][0]["start"], mid["pieces"][0]["end"]), (120.0, 180.0))

    def test_trim_without_a_peak_uses_the_middle(self):
        (out,) = rl.split_reel(reel(piece(0, 90)), 60, 0)
        self.assertEqual((out["pieces"][0]["start"], out["pieces"][0]["end"]), (15.0, 75.0))
        self.assertIsNone(out["trimmed"][0]["peak"])

    def test_trim_and_split_together_record_the_trim_in_its_part(self):
        parts = rl.split_reel(reel(piece(0, 30), piece(100, 90), piece(300, 20), peaks=[145.0]), 60, 0)
        self.assertTrue(all(p["seconds"] <= 60 for p in parts))
        with_trim = [p for p in parts if p.get("trimmed")]
        self.assertEqual(len(with_trim), 1)
        self.assertEqual(with_trim[0]["trimmed"][0]["piece"], 1)

    def test_ids_of_parts(self):
        out = rl.cap_reels([reel(piece(0, 30), piece(50, 40)), reel(piece(0, 10))], {"minSec": 0, "maxSec": 60}, "M")
        self.assertEqual([i for i, _ in out], ["M01p1", "M01p2", "M02"])


class KillCountTests(unittest.TestCase):
    def test_a_trim_recounts_the_kills_left_in_the_kept_part(self):
        # 90 s piece, kills at 10 s and 80 s, trimmed around the first: only that kill is left
        (out,) = rl.split_reel(reel(piece(0, 90, 2), peaks=[10.0, 80.0]), 60, 0)
        self.assertEqual((out["pieces"][0]["start"], out["pieces"][0]["end"]), (0.0, 60.0))
        self.assertEqual(out["pieces"][0]["kills"], 1)
        self.assertEqual(out["kills"], 1)
        self.assertEqual(out["trimmed"][0]["killsDropped"], 1)

    def test_part_counts_and_names_follow_the_kept_kills(self):
        r = reel(piece(0, 30, 1), piece(100, 90, 2), peaks=[10.0, 110.0, 180.0])
        parts = rl.split_reel(r, 60, 0)
        self.assertEqual(sum(p["kills"] for p in parts), 2)
        rdoc = {"tool": "clipper.montage", "recording": "practice-h-20261111-200000.mkv", "clips": [
            dict(p, id=f"M01p{p['part']}", start=0.0, end=p["seconds"], files=[{"layout": "montage-v", "file": "x.mp4"}])
            for p in parts]}
        labels = [row[4] for row in pub.name_rows(rdoc, "codm", {}, None, None)]
        self.assertEqual(labels, [f"kills-{p['kills']}-part-{p['part']}-of-{p['parts']}" for p in parts])

    def test_no_peaks_scales_and_says_so(self):
        (out,) = rl.split_reel(reel(piece(0, 120, 4)), 60, 0)
        self.assertEqual(out["kills"], 2)
        self.assertTrue(out["trimmed"][0]["killsEstimated"])

    def test_a_trimmed_match_reel_score_is_the_kept_kills(self):
        out = rl.split_reel(reel(piece(0, 90, 2), piece(100, 5, 0), peaks=[10.0, 80.0]), 60, 0)
        self.assertEqual([p["kills"] for p in out], [1, 0])  # clipper sets score = kills of each part after the cap


class RendererAddsNothingTests(unittest.TestCase):
    def test_planned_durations_and_ffmpeg_arguments(self):
        pieces = [piece(10, 20), piece(100, 25.5), piece(300, 14.5), {"start": 500.0, "end": 503.0, "kills": 0}]
        argv = mont.render_argv("ffmpeg", "src.mkv", pieces, {"width": 1080, "height": 1920}, ["-c:v", "libx264"],
                                ["-c:a", "aac"], 80, "out.mp4.part", audio_tracks=2, max_sec=60)
        ts = [float(argv[i + 1]) for i, a in enumerate(argv) if a == "-t"]
        self.assertEqual(ts[:-1], [20.0, 25.5, 14.5, 3.0])  # one input duration per piece, the pieces' own length
        self.assertEqual(sum(ts[:-1]), 63.0)
        self.assertEqual(ts[-1], 60.0)  # the output is cut at the type's maximum (fps rounding cannot pass it)
        graph = argv[argv.index("-filter_complex") + 1]
        for adds_time in ("xfade", "acrossfade", "tpad", "apad", "loop", "trim=", "setpts=PTS+", "adelay"):
            self.assertNotIn(adds_time, graph)
        self.assertEqual(graph.count("concat="), 1)

    def test_a_split_reel_stays_inside_the_maximum_in_every_part(self):
        # the planned seconds of a part is the sum of its pieces: the match-reel result piece is a piece, nothing is appended
        r = reel(*[piece(100 * i, 14.5, 1) for i in range(9)], piece(2000, 3.5, 0))
        for mx in (30, 45, 60):
            for p in rl.split_reel(r, mx, 0):
                self.assertLessEqual(sum(q["end"] - q["start"] for q in p["pieces"]), mx + 1e-6)
                self.assertAlmostEqual(p["seconds"], sum(q["end"] - q["start"] for q in p["pieces"]), places=3)


class PlannerTests(unittest.TestCase):
    def test_a_long_streak_is_kept_whole_and_split_not_cut(self):
        hits = [kill(100 + 10 * i) for i in range(12)]  # 12 kills 10 s apart: 12 pieces of 4.5 s
        plans = mont.plan_montages(hits, RANKING, dict(CFG, minSec=20, maxSec=30), 5000)
        self.assertEqual(sum(m["kills"] for m in plans), 12)  # nothing dropped
        parts = [p for _, p in rl.cap_reels(plans, {"minSec": 20, "maxSec": 30}, "M")]
        self.assertTrue(all(p["seconds"] <= 30 + 1e-6 for p in parts))
        self.assertEqual(sum(p["kills"] for p in parts), 12)

    def test_the_montage_setting_is_honoured(self):
        hits = [kill(100 + 30 * i) for i in range(10)]  # ten single kills, 45 s
        for mx in (60, 30):
            plans = mont.plan_montages(hits, RANKING, dict(CFG, minSec=10, maxSec=mx), 5000)
            self.assertTrue(plans)
            self.assertTrue(all(m["seconds"] <= mx + 1e-6 for m in plans), (mx, [m["seconds"] for m in plans]))
            self.assertEqual(sum(m["kills"] for m in plans), 10)

    def test_match_reel_peaks_are_the_kills_and_the_result_ends_the_last_part(self):
        matches = [{"index": 1, "start": 0.0, "end": 2000.0, "resultAt": 900.0, "endScreenAt": 900.0,
                    "ownKillTimes": [100 + 20 * i for i in range(30)], "result": "VICTORY",
                    "reel": {"qualifies": True, "reason": "x", "rules": [{"id": "won-top3", "outcome": "pass"}]}}]
        reels = mont.match_reels([], RANKING, CFG, matches, 2000.0)
        self.assertEqual(len(reels), 1)
        self.assertGreater(reels[0]["seconds"], 60)  # 30 kills x 4.5 s + the result screen
        self.assertEqual(len(reels[0]["peaks"]), 30)
        parts = rl.split_reel(reels[0], 60, 0)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(p["seconds"] <= 60 + 1e-6 for p in parts))
        self.assertEqual(sum(p["kills"] for p in parts), reels[0]["kills"])
        self.assertEqual(parts[-1]["pieces"][-1]["kills"], 0)


class NamingTests(unittest.TestCase):
    def test_part_names(self):
        self.assertEqual(names.label_for("montage", kills=12, part=2, parts=3), "kills-12-part-2-of-3")
        self.assertEqual(names.label_for("won-reel", ["VICTORY"], 7, part=1, parts=2), "victory-kills-7-part-1-of-2")
        self.assertEqual(names.label_for("montage", kills=12), "kills-12")
        self.assertEqual(names.label_for("montage", kills=12, part=1, parts=1), "kills-12")
        n = names.clip_name("codm", "won-reel", datetime(2026, 11, 11, 20, 0, 0),
                            names.label_for("won-reel", ["DEFEAT"], 11, part=10, parts=12), 1, "v")
        self.assertTrue(names.NAME_RE.match(n), n)
        self.assertIn("part-10-of-12", n)

    def test_publish_names_every_part_as_its_own_reel(self):
        rdoc = {"tool": "clipper.montage", "recording": "practice-h-20261111-200000.mkv", "clips": [
            {"id": "M01p1", "start": 0.0, "end": 55.0, "part": 1, "parts": 2, "labels": ["part 1 of 2"],
             "pieces": [piece(100, 55, 6)], "files": [{"layout": "montage-v", "file": "montage-v.mp4"}]},
            {"id": "M01p2", "start": 0.0, "end": 30.0, "part": 2, "parts": 2, "labels": ["part 2 of 2"],
             "pieces": [piece(400, 30, 3)], "files": [{"layout": "montage-v", "file": "montage-v.mp4"}]}]}
        rows = pub.name_rows(rdoc, "codm", {}, None, None)
        self.assertEqual([r[4] for r in rows], ["kills-6-part-1-of-2", "kills-3-part-2-of-2"])
        self.assertTrue(all(r[2] == "montage" for r in rows))


class LiveClipTests(unittest.TestCase):
    LIVE = cc.load_config("live-clips")

    def _run(self, chain):
        hit = {"detector": "M3", "label": "Triple Kill", "signal": True, "role": "positive"}
        chain.step(10.0, [hit])
        act = None
        for t in range(11, 40):
            act = chain.step(float(t), []) or act
        return act

    def test_max_clip_cuts_a_longer_window_around_the_medal(self):
        act = self._run(live_chain.LiveChain(RANKING, self.LIVE, max_clip=12))
        self.assertIsNotNone(act)
        self.assertLessEqual(act["end"] - act["start"], 12.02)
        self.assertIn("trimmedFrom", act)
        free = self._run(live_chain.LiveChain(RANKING, self.LIVE))
        self.assertGreater(free["end"] - free["start"], 12)
        self.assertNotIn("trimmedFrom", free)


if __name__ == "__main__":
    unittest.main()
