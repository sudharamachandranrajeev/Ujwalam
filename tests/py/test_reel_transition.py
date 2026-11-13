# SPDX-License-Identifier: GPL-3.0-or-later
"""RP1 reel transitions (services/clip/reel_transition.py, clip_montage.render_argv transition=): the settings checks,
the flag (off by default), the crossfade length rules, the xfade/acrossfade chain, and a real render (ffmpeg cases skip
without ffmpeg): the reel is shorter by the overlap at each join and the picture changes smoothly across a join instead
of in one frame. Synthetic pictures and times only."""

import json
import os
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import reel_transition as rt  # noqa: E402

D = rt.load_defaults()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FADE = {"kind": "fade", "xfade": "fade", "ms": 250}


def piece(a, b, kills=1):
    return {"start": float(a), "end": float(b), "kills": kills}


def write(d, name, obj):
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        json.dump(obj, f)


class DataTests(unittest.TestCase):
    def test_kinds_and_default(self):
        self.assertEqual(sorted(D["byId"]), ["cut", "fade"])
        self.assertEqual(D["default"], "fade")
        self.assertIsNone(D["byId"]["cut"]["xfade"])
        self.assertEqual(D["byId"]["fade"]["ms"], {"min": 150, "max": 500, "default": 250})

    def test_flag_is_off_by_default(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags[rt.FLAG]["default"], False)

    def test_settings_checks(self):
        self.assertEqual(rt.transition_problems({"kind": "fade", "ms": 300}, D), [])
        self.assertEqual(rt.transition_problems({"kind": "cut", "ms": 0}, D), [])
        self.assertTrue(rt.transition_problems({"kind": "fade", "ms": 100}, D))
        self.assertTrue(rt.transition_problems({"kind": "fade", "ms": 600}, D))
        self.assertTrue(rt.transition_problems({"kind": "fade", "ms": True}, D))
        self.assertTrue(rt.transition_problems({"kind": "wipe", "ms": 250}, D))
        self.assertTrue(rt.transition_problems({"kind": "fade"}, D))
        self.assertTrue(rt.transition_problems({"kind": [], "ms": 250}, D), "a bad stored kind is a problem, not a crash")
        self.assertTrue(rt.transition_problems("fade", D))

    def test_active_needs_the_flag_then_follows_the_setting(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(rt.active(d, D), "flag off: hard cut")
            write(d, cc.LOCAL_FLAGS, {"flags": {rt.FLAG: True}})
            self.assertEqual(rt.active(d, D), FADE, "flag on, no setting: the default cross fade")
            write(d, cc.SETTINGS_FILE, {"clips": {"reelTransition": {"kind": "fade", "ms": 400}}})
            self.assertEqual(rt.active(d, D), {"kind": "fade", "xfade": "fade", "ms": 400})
            write(d, cc.SETTINGS_FILE, {"clips": {"reelTransition": {"kind": "cut", "ms": 0}}})
            self.assertIsNone(rt.active(d, D), "the user chose Cut")
            write(d, cc.SETTINGS_FILE, {"clips": {"reelTransition": {"kind": "fade", "ms": 9000}}})
            self.assertEqual(rt.active(d, D), FADE, "a bad value falls back to the default")


class ArgvTests(unittest.TestCase):
    FRAME = {"width": 360, "height": 640}

    def argv(self, pieces, transition, captions=None, tracks=1):
        a = mont.render_argv("ffmpeg", "src.mp4", pieces, self.FRAME, ["-c:v", "x"], ["-c:a", "aac"], 80, "o.mp4",
                             audio_tracks=tracks, captions=captions, transition=transition)
        return a[a.index("-filter_complex") + 1]

    def test_crossfade_length(self):
        self.assertEqual(mont.crossfade_sec([piece(0, 5), piece(10, 15)], FADE), 0.25)
        self.assertEqual(mont.crossfade_sec([piece(0, 5), piece(10, 10.3)], FADE), 0.15, "half the shortest piece")
        self.assertEqual(mont.crossfade_sec([piece(0, 5)], FADE), 0.0, "one piece has no join")
        self.assertEqual(mont.crossfade_sec([piece(0, 5), piece(10, 15)], None), 0.0)

    def test_no_transition_is_the_hard_concat_of_before(self):
        fc = self.argv([piece(0, 5), piece(10, 15)], None)
        self.assertIn("concat=n=2:v=1:a=1[vout][aout0]", fc)
        self.assertNotIn("xfade", fc)
        self.assertEqual(fc.count("afade=t=in"), 2)

    def test_xfade_chain_offsets_and_audio_per_track(self):
        fc = self.argv([piece(0, 5), piece(10, 14), piece(20, 23)], FADE, tracks=2)
        self.assertNotIn("concat=", fc)
        # offsets: the first join at 5 - 0.25, the second at (5 + 4) - 2 * 0.25
        self.assertIn("[v0][v1]xfade=transition=fade:duration=0.250:offset=4.750[vx1]", fc)
        self.assertIn("[vx1][v2]xfade=transition=fade:duration=0.250:offset=8.500[vout]", fc)
        for k in (0, 1):
            self.assertIn(f"[a0_{k}][a1_{k}]acrossfade=d=0.250:c1=tri:c2=tri[ax1_{k}]", fc)
            self.assertIn(f"[ax1_{k}][a2_{k}]acrossfade=d=0.250:c1=tri:c2=tri[aout{k}]", fc)
        # the sound fades in only at the reel's start and out only at its end (the joins are crossfades)
        self.assertEqual(fc.count("afade=t=in"), 2)
        self.assertEqual(fc.count("afade=t=out"), 2)

    def test_picture_only_and_captions(self):
        fc = self.argv([piece(0, 5), piece(10, 15)], FADE, tracks=0)
        self.assertNotIn("acrossfade", fc)
        self.assertIn("xfade=transition=fade:duration=0.250:offset=4.750[vout]", fc)
        fc = self.argv([piece(0, 5), piece(10, 15)], FADE, captions="c.ass")
        self.assertIn("offset=4.750[vcat]", fc)
        self.assertIn("[vcat]subtitles=c.ass[vout]", fc)


def yavg(path, cwd):
    """[(time, average luma)] of every frame."""
    r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-vf",
                     "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=yavg.txt", "-f", "null", "-"],
                    cwd=cwd, timeout=300)
    assert r.returncode == 0, r.stderr
    with open(os.path.join(cwd, "yavg.txt"), encoding="utf-8") as f:
        text = f.read()
    ts = [float(x) for x in re.findall(r"pts_time:([0-9.]+)", text)]
    ys = [float(x) for x in re.findall(r"YAVG=([0-9.]+)", text)]
    return list(zip(ts, ys))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rp1-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        # 10 s: 0-5 s black, 5-10 s white; a tone on the audio
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=5",
                         "-f", "lavfi", "-i", "color=c=white:s=360x640:r=30:d=5", "-f", "lavfi", "-i", "sine=f=440:d=10",
                         "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
                         "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src], timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, name, transition):
        pieces = [piece(1, 4), piece(6, 9)]
        argv = mont.render_argv("ffmpeg", self.src, pieces, {"width": 360, "height": 640}, ["-c:v", "libopenh264"],
                                ["-c:a", "aac"], 80, name, transition=transition)
        r = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        return cc.media_info("ffprobe", os.path.join(self.tmp, name)), yavg(name, self.tmp)

    def test_cross_fade_is_shorter_by_the_overlap_and_changes_smoothly(self):
        cut, cy = self.render("cut.mp4", None)
        fade, fy = self.render("fade.mp4", FADE)
        self.assertAlmostEqual(cut["duration"], 6.0, delta=0.1)
        self.assertAlmostEqual(fade["duration"], 5.75, delta=0.1, msg="one join overlaps by 0.25 s")
        self.assertTrue(fade["has_audio"])
        step = lambda ys: max(abs(b[1] - a[1]) for a, b in zip(ys, ys[1:]))  # noqa: E731
        self.assertGreater(step(cy), 150, "the cut jumps from black to white in one frame")
        self.assertLess(step(fy), 40, "the cross fade spreads the change over the overlap")
        mid = [y for t, y in fy if 2.80 <= t <= 2.95]
        self.assertTrue(mid and all(40 < y < 210 for y in mid), "half way through the join the picture is grey")


if __name__ == "__main__":
    unittest.main()
