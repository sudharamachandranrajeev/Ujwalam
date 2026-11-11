# SPDX-License-Identifier: GPL-3.0-or-later
"""ED1 payoff-first hook (services/clip/reel_hook.py, D352): strongest moment first (reorder or teaser), the D350
maximum kept with the teaser, never a death in the open, each CL1 part its own hook, the hook-quality score, the
settings checks, and the montage render with a teaser (ffmpeg cases skip without ffmpeg). Synthetic times only."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import clipper  # noqa: E402
import reel_hook as rh  # noqa: E402
import reel_length as rl  # noqa: E402

CFG = rh.load_defaults()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def piece(a, b, kills=1):
    return {"start": float(a), "end": float(b), "kills": kills}


def match_reel():
    """A match reel: one kill at 103, a triple kill 203/206/209 with its medal at 209.5, the result screen."""
    return {"pieces": [piece(100, 104.5), piece(200, 210.5, 3), piece(300, 306, 0)], "seconds": 21.0,
            "peaks": [103.0, 203.0, 206.0, 209.0], "medals": [{"t": 209.5, "w": 1.0, "label": "Triple Kill"}]}


def ex_for(hooks):
    return {"hooks": hooks, "hcfg": CFG}


class DataTests(unittest.TestCase):
    def test_strategy_per_type_and_why(self):
        self.assertEqual({k: v["strategy"] for k, v in CFG["byType"].items()},
                         {"montage": "reorder", "match-reel": "teaser", "impact-play": "teaser", "live-clip": "teaser"})
        for t in CFG["byType"].values():
            self.assertTrue(t["why"])
        self.assertEqual((CFG["teaserSec"]["min"], CFG["teaserSec"]["max"], CFG["windowSec"]), (1, 3, 3))
        self.assertEqual(CFG["flag"], "reel-hook")

    def test_flag_is_off_by_default(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags["reel-hook"]["default"], False)
        self.assertIs(flags["reel-captions"]["default"], False)

    def test_settings_checks(self):
        self.assertEqual(rh.hooks_problems({"montage": {"on": False, "teaserSec": 3}}), [])
        self.assertTrue(rh.hooks_problems({"montage": {"on": True, "teaserSec": 4}}))
        self.assertTrue(rh.hooks_problems({"montage": {"on": True, "teaserSec": 1.5}}))
        self.assertTrue(rh.hooks_problems({"montage": {"on": "yes", "teaserSec": 2}}))
        self.assertTrue(rh.hooks_problems({"short": {"on": True, "teaserSec": 2}}))  # short clips have no hook
        self.assertTrue(rh.hooks_problems({"montage": {"on": True}}))

    def test_active_needs_the_flag_and_the_setting(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(any(v["on"] for v in rh.active(d).values()), "flag off: no hook")
            with open(os.path.join(d, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                json.dump({"flags": {"reel-hook": True}}, f)
            self.assertTrue(all(v["on"] for v in rh.active(d).values()))
            with open(os.path.join(d, cc.SETTINGS_FILE), "w", encoding="utf-8") as f:
                json.dump({"clips": {"reelHooks": {"match-reel": {"on": False, "teaserSec": 2},
                                                   "montage": {"on": True, "teaserSec": 9}}}}, f)
            a = rh.active(d)
            self.assertFalse(a["match-reel"]["on"])
            self.assertEqual(a["montage"], {"on": True, "teaserSec": 2.0}, "a bad value falls back to the default")


class PlanTests(unittest.TestCase):
    def test_teaser_opens_on_the_multi_kill_then_the_reel_from_its_start(self):
        out, rec = rh.plan_hook(match_reel(), "teaser", 2, CFG, max_sec=60)
        self.assertEqual(rec["used"], "teaser")
        self.assertEqual(rec["peak"], 209.0, "the third kill of the triple, with its medal, is the strongest")
        self.assertEqual(out["pieces"][0], {"start": 208.5, "end": 210.5, "kills": 0, "teaser": True})
        self.assertEqual(out["pieces"][1:], match_reel()["pieces"], "then the reel from its start, in order")
        self.assertAlmostEqual(rec["peakOut"], 0.5)
        self.assertAlmostEqual(out["seconds"], 23.0)

    def test_already_open_on_the_peak_changes_nothing(self):
        r = {"pieces": [piece(200, 210.5, 3), piece(300, 304.5)], "seconds": 15.0, "peaks": [201.0, 202.0, 203.0, 303.0]}
        out, rec = rh.plan_hook(r, "teaser", 2, CFG, max_sec=60)
        self.assertEqual(rec["used"], "already")
        self.assertIs(out, r)

    def test_reorder_moves_the_best_piece_first(self):
        # montage: a single kill, then a short double-kill piece whose second kill is 2.5 s in
        r = {"pieces": [piece(100, 104.5), piece(500, 504, 2)], "seconds": 8.5, "peaks": [103.0, 501.5, 502.5]}
        out, rec = rh.plan_hook(r, "reorder", 2, CFG, max_sec=60)
        self.assertEqual(rec["used"], "reorder")
        self.assertEqual([p["start"] for p in out["pieces"]], [500.0, 100.0])
        self.assertEqual(len(out["pieces"]), 2, "no footage repeated")

    def test_reorder_adds_a_teaser_when_the_peak_is_deep_in_its_piece(self):
        r = {"pieces": [piece(100, 104.5), piece(200, 210.5, 3)], "seconds": 15.0,
             "peaks": [103.0, 203.0, 206.0, 209.0], "medals": [{"t": 209.5, "w": 1.0}]}
        out, rec = rh.plan_hook(r, "reorder", 2, CFG, max_sec=60)
        self.assertEqual(rec["used"], "reorder+teaser")
        self.assertTrue(out["pieces"][0]["teaser"])
        self.assertEqual(out["pieces"][1]["start"], 200.0)

    def test_no_room_no_teaser(self):
        r = match_reel()
        out, rec = rh.plan_hook(r, "teaser", 2, CFG, max_sec=22)
        self.assertEqual(rec["used"], "none")
        self.assertIs(out, r)
        r = {"pieces": [piece(100, 104.5), piece(200, 210.5, 3)], "seconds": 15.0, "peaks": [103.0, 203.0, 206.0, 209.0]}
        out, rec = rh.plan_hook(r, "reorder", 2, CFG, max_sec=16)
        self.assertEqual(rec["used"], "reorder")
        self.assertIn("no room", rec["reason"])

    def test_never_opens_on_a_death(self):
        # a death span over the multi-kill moment: the next strongest moment is used
        out, rec = rh.plan_hook(match_reel(), "teaser", 2, CFG, max_sec=60, deaths=[(208.0, 214.0)])
        self.assertNotEqual(rec["peak"], 209.0)
        s, e = rec.get("teaser") or (None, None)
        if s is not None:
            self.assertFalse(s < 214.0 and 208.0 < e)
        out, rec = rh.plan_hook(match_reel(), "teaser", 2, CFG, max_sec=60, deaths=[(0, 1000)])
        self.assertEqual(rec["used"], "none")

    def test_each_part_gets_its_own_hook_and_stays_within_the_maximum(self):
        # 6 kill pieces of 12 s (one kill each) and a triple in the last one: 84 s > 60 s, split in two parts
        r = {"pieces": [piece(100 * i, 100 * i + 12) for i in range(1, 7)], "seconds": 72.0,
             "peaks": [100.0 * i + 6 for i in range(1, 7)] + [604.0, 605.0]}
        r["pieces"][-1]["kills"] = 3
        lim = {"minSec": 0, "maxSec": 60}
        ex = ex_for({"match-reel": {"on": True, "teaserSec": 2.0}})
        jobs = clipper._hook_jobs([r], "match-reel", "W", lim, ex)
        self.assertGreater(len(jobs), 1)
        for cid, p in jobs:
            self.assertLessEqual(sum(x["end"] - x["start"] for x in p["pieces"]), 60.0 + 1e-6, cid)
            t = p["pieces"][0]
            if t.get("teaser"):
                own = [x for x in p["pieces"][1:] if x["start"] <= t["start"] and t["end"] <= x["end"]]
                self.assertTrue(own, f"{cid}: the teaser comes from the part's own pieces")
        self.assertEqual(jobs[-1][1]["hook"]["peak"], 606.0, "the last part opens on its own triple")

    def test_hook_off_keeps_the_cl1_split_unchanged(self):
        r = match_reel()
        jobs = clipper._hook_jobs([r], "match-reel", "W", {"minSec": 0, "maxSec": 60},
                                  ex_for({"match-reel": {"on": False, "teaserSec": 2.0}}))
        self.assertEqual(jobs[0][1]["pieces"], r["pieces"])
        self.assertEqual(jobs[0][1]["hook"], {"on": False})

    def test_parts_keep_their_own_peaks_and_medals(self):
        r = {"pieces": [piece(0, 40), piece(100, 140)], "peaks": [10.0, 120.0], "medals": [{"t": 121.0, "w": 1.0}]}
        parts = rl.split_reel(r, 60, 0)
        self.assertEqual([p["peaks"] for p in parts], [[10.0], [120.0]])
        self.assertEqual([len(p["medals"]) for p in parts], [0, 1])


class ScoreTests(unittest.TestCase):
    def test_score_parts(self):
        out, _ = rh.plan_hook(match_reel(), "teaser", 2, CFG, max_sec=60)
        sc = rh.hook_score(out["pieces"], match_reel()["peaks"], match_reel()["medals"], CFG, motion=10.0)
        self.assertEqual((sc["kill"], sc["multiKill"], sc["medal"], sc["motion"]), (True, True, True, True))
        self.assertEqual(sc["score"], 1.0)
        plain = rh.hook_score(match_reel()["pieces"], match_reel()["peaks"], match_reel()["medals"], CFG)
        self.assertEqual((plain["kill"], plain["multiKill"], plain["medal"], plain["motion"]), (True, False, False, None))
        self.assertLess(plain["score"], sc["score"])

    def test_impact_play_medal_is_not_a_kill(self):
        ps = [piece(10, 30, 0)]
        sc = rh.hook_score(ps, [], [{"t": 11.0, "w": 1.0, "kill": False}], CFG)
        self.assertEqual((sc["kill"], sc["medal"]), (False, True))

    def test_the_whole_opening_is_checked_for_a_death_not_only_the_teaser(self):
        # a clear 2 s teaser, but the reel body starts inside a death: its first second would land in the first 3 s
        out, rec = rh.plan_hook(match_reel(), "teaser", 2, CFG, max_sec=60, deaths=[(99.0, 100.5)])
        self.assertEqual(rec["used"], "none")
        self.assertIn("clear of a death", rec["reason"])
        self.assertEqual(out, match_reel(), "the reel is left as it was")
        # a death later than the window's end in the body does not block the teaser
        out, rec = rh.plan_hook(match_reel(), "teaser", 2, CFG, max_sec=60, deaths=[(101.5, 102.0)])
        self.assertEqual(rec["used"], "teaser")
        self.assertFalse(rh._opens_on_death(out["pieces"], CFG["windowSec"], [(101.5, 102.0)]))
        # reorder: the best piece opens on a death, the next candidate whose opening is clear is used
        reel = {"pieces": [piece(100, 104.5), piece(200, 203.5, 2), piece(300, 303, 1)],
                "peaks": [103.0, 201.0, 203.0, 302.0], "medals": []}
        out, rec = rh.plan_hook(reel, "reorder", 2, CFG, max_sec=60, deaths=[(199.0, 200.4)])
        self.assertNotEqual(rec.get("peak"), 203.0)
        self.assertFalse(rh._opens_on_death(out["pieces"], CFG["windowSec"], [(199.0, 200.4)]))

    def test_live_clip_hook(self):
        ex = {"hooks": {"live-clip": {"on": True, "teaserSec": 2.0}}, "hcfg": CFG}
        c = {"start": 10.0, "end": 70.0, "anchor": 55.0, "labels": ["Triple Kill"]}
        m = clipper._live_hook(c, ex, {"minSec": 20, "maxSec": 60})
        self.assertEqual(m["hook"]["used"], "teaser")
        self.assertLessEqual(m["seconds"], 60.0 + 1e-6, "clip cut to the maximum minus the teaser first")
        self.assertTrue(m["pieces"][0]["teaser"])
        off = clipper._live_hook(c, {"hooks": {"live-clip": {"on": False, "teaserSec": 2.0}}, "hcfg": CFG},
                                 {"minSec": 20, "maxSec": 60})
        self.assertEqual(off["hook"], {"on": False})
        self.assertEqual(len(off["pieces"]), 1)

    def test_live_saves_carry_the_anchor(self):
        rows = [{"at": "2026-11-11T10:00:30.000Z", "startBack": 25.0, "endBack": 2.0, "anchorBack": 8.0, "score": 3,
                 "labels": ["Triple Kill"], "reason": "quiet", "files": [{"canvas": "v", "path": "x.mp4"}]}]
        (c,) = clipper.merge_saves(rows, {"x.mp4": 60.0})
        self.assertAlmostEqual(c["anchor"], 52.0)
        rows[0].pop("anchorBack")
        (c,) = clipper.merge_saves(rows, {"x.mp4": 60.0})
        self.assertNotIn("anchor", c)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ed1-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        # 20 s: 0-10 s a still grey picture, 10-20 s a busy moving picture (game of life); a tone on the audio
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=gray:s=360x640:r=30:d=10",
                         "-f", "lavfi", "-i", "life=s=360x640:r=30:mold=10:ratio=0.5,trim=duration=10,format=yuv420p", "-f", "lavfi", "-i", "sine=f=440:d=20",
                         "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
                         "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src], timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_teaser_render_length_and_motion(self):
        reel = {"pieces": [piece(1, 9), piece(12, 18, 1)], "seconds": 14.0, "peaks": [15.0]}
        out, rec = rh.plan_hook(reel, "teaser", 2, CFG, max_sec=16)
        self.assertEqual(rec["used"], "teaser")
        argv = mont.render_argv("ffmpeg", self.src, out["pieces"], {"width": 360, "height": 640},
                                ["-c:v", "libopenh264"], ["-c:a", "aac"], 80, "hook.mp4", max_sec=16)
        r = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        info = cc.media_info("ffprobe", os.path.join(self.tmp, "hook.mp4"))
        self.assertLessEqual(info["duration"], 16.0 + 0.05, "teaser included, within the maximum")
        self.assertAlmostEqual(info["duration"], 16.0, delta=0.15)
        moving = rh.motion_ydif("ffmpeg", "hook.mp4", 2, cwd=self.tmp)
        r2 = cc.run_tool(mont.render_argv("ffmpeg", self.src, reel["pieces"], {"width": 360, "height": 640},
                                          ["-c:v", "libopenh264"], ["-c:a", "aac"], 80, "plain.mp4"), cwd=self.tmp, timeout=600)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        still = rh.motion_ydif("ffmpeg", "plain.mp4", 2, cwd=self.tmp)
        self.assertGreater(moving, CFG["score"]["motion"]["minYdif"], "the teaser opens on the moving part")
        self.assertLess(still, CFG["score"]["motion"]["minYdif"], "the plain reel opens on the still part")

    def test_a_save_without_audio_renders_its_teaser_picture_only(self):
        mute = os.path.join(self.tmp, "mute.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", self.src, "-an", "-c:v", "copy", mute], timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        sinfo = cc.media_info("ffprobe", mute)
        self.assertFalse(sinfo["has_audio"])
        ex = {"hooks": {"live-clip": {"on": True, "teaserSec": 2.0}}, "hcfg": CFG}
        m = clipper._live_hook({"start": 4.0, "end": 18.0, "anchor": 15.0, "labels": ["Triple Kill"]}, ex,
                               {"minSec": 5, "maxSec": 60})
        self.assertEqual(m["hook"]["used"], "teaser")
        wd = os.path.join(self.tmp, "mute-wd")
        os.makedirs(wd, exist_ok=True)
        name = clipper._render_pieces("ffmpeg", mute, m["pieces"], {"width": 360, "height": 640}, "libopenh264", wd,
                                      "stream-v", sinfo, 80, 60)
        info = cc.media_info("ffprobe", os.path.join(wd, name))
        self.assertFalse(info["has_audio"], "picture only")
        self.assertAlmostEqual(info["duration"], m["seconds"], delta=0.15, msg="the teaser is in the rendered file")


if __name__ == "__main__":
    unittest.main()
