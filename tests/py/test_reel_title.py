# SPDX-License-Identifier: GPL-3.0-or-later
"""RP4 title card (services/clip/reel_title.py, D362): when the title starts, which reels get one, the config limits,
the filter graph, and a real render (ffmpeg cases skip without ffmpeg): the picture is the plain reel outside the
title window and a blurred, darker copy inside it; the length does not change.
Synthetic pictures, times and a placeholder brand only."""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import reel_title as rt  # noqa: E402

CFG = rt.load_config()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FRAME = {"width": 360, "height": 640}
SAFE = {"top": 20, "bottom": 60, "left": 12, "right": 24}


def piece(a, b, **kw):
    return dict({"start": float(a), "end": float(b), "kills": 1}, **kw)


class DataTests(unittest.TestCase):
    def test_flag_is_off_by_default(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags[rt.FLAG]["default"], False)
        self.assertEqual(CFG["flag"], rt.FLAG)

    def test_overlay_limits(self):
        self.assertLess(CFG["fadeInMs"], 600)
        self.assertLess(CFG["fadeOutMs"], 400)
        d = CFG["durationSec"]
        self.assertTrue(1.2 <= d["value"] <= 1.8 and d["min"] >= 1.2 and d["max"] <= 1.8)

    def test_bad_config_is_refused(self):
        for patch in ({"fadeInMs": 700}, {"fadeOutMs": 400}, {"durationSec": {"value": 2.5, "min": 1.2, "max": 1.8}},
                      {"fontFile": "Nope.ttf"}):
            d = tempfile.mkdtemp(prefix="rp4-")
            p = os.path.join(d, "t.json")
            cc.write_json_atomic(p, dict(CFG, **patch))
            with self.assertRaises(cc.ClipError, msg=str(patch)):
                rt.load_config(p)
            shutil.rmtree(d, ignore_errors=True)


class PlanTests(unittest.TestCase):
    def test_title_starts_after_the_teaser(self):
        ps = [piece(50, 53, teaser=True), piece(10, 20), piece(30, 40)]
        start, total = rt.timeline(ps, 0.0)
        self.assertEqual((start, total), (3.0, 23.0))
        start, total = rt.timeline(ps, 0.25)  # each cross-faded join overlaps by 0.25 s
        self.assertAlmostEqual(start, 2.75)
        self.assertAlmostEqual(total, 22.5)

    def test_without_a_teaser_it_opens_the_reel(self):
        self.assertEqual(rt.timeline([piece(1, 9), piece(20, 30)], 0.0)[0], 0.0)

    def test_record(self):
        rec = rt.plan([piece(50, 53, teaser=True), piece(10, 20)], 0.0, CFG, "Brand", FRAME, SAFE)
        self.assertEqual((rec["text"], rec["start"]), ("Brand", 3.0))
        self.assertAlmostEqual(rec["end"] - rec["start"], CFG["durationSec"]["value"])
        self.assertEqual(rec["safeWidth"], 360 - 12 - 24)

    def test_no_brand_no_title(self):
        ps = [piece(10, 20)]
        for b in (None, "", "   ", "<brand>", 5):
            self.assertIsNone(rt.plan(ps, 0.0, CFG, b, FRAME, SAFE), repr(b))

    def test_short_reel_has_no_title(self):
        self.assertIsNone(rt.plan([piece(10, 12)], 0.0, CFG, "Brand", FRAME, SAFE))

    def test_no_room_after_the_teaser_opens_the_reel(self):
        rec = rt.plan([piece(50, 56, teaser=True), piece(10, 12)], 0.0, CFG, "Brand", FRAME, SAFE)
        self.assertEqual(rec["start"], 0.0)

    def test_text_is_cleaned_and_cut(self):
        rec = rt.plan([piece(10, 20)], 0.0, CFG, "A\nB\x00 " + "x" * 60, FRAME, SAFE)
        self.assertNotRegex(rec["text"], r"[\x00-\x1f]")
        self.assertLessEqual(len(rec["text"]), CFG["maxChars"])

    def test_long_text_shrinks_to_the_safe_width(self):
        small = rt.plan([piece(10, 20)], 0.0, CFG, "X" * 24, FRAME, SAFE)["size"]
        big = rt.plan([piece(10, 20)], 0.0, CFG, "X", FRAME, SAFE)["size"]
        self.assertLess(small, big)
        self.assertLessEqual(small * 0.62 * 24, 360 - 12 - 24 + 1)


class ArgvTests(unittest.TestCase):
    def argv(self, **kw):
        ps = [piece(1, 4, teaser=True), piece(5, 9), piece(10, 12)]
        rec = rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE)
        d = dict(rec, textFile="title.txt", fontFile="title-fonts/f.ttf", colour="0xFFFFFF", blur=CFG["blur"], darken=0.55)
        return mont.render_argv("ffmpeg", "s.mp4", ps, FRAME, [], [], 80, "o.mp4", title=d, **kw)

    def graph(self, argv):
        return argv[argv.index("-filter_complex") + 1]

    def test_title_graph(self):
        g = self.graph(self.argv())
        self.assertIn("[vjoin]split=2[tmain][ttit]", g)
        self.assertIn("gblur=sigma=18:steps=2", g)
        self.assertIn("textfile=title.txt:expansion=none", g)
        self.assertIn("fade=t=in:", g)
        self.assertIn("alpha=1", g)
        self.assertIn("overlay=eof_action=pass:enable='between(t,3.000,4.600)'[vout]", g)

    def test_no_title_no_change(self):
        ps = [piece(1, 4), piece(5, 9)]
        a = mont.render_argv("ffmpeg", "s.mp4", ps, FRAME, [], [], 80, "o.mp4")
        self.assertNotIn("vjoin", self.graph(a))

    def test_with_captions_and_thumbnail(self):
        g = self.graph(self.argv(captions="c.ass", thumbnail="t.png"))
        self.assertIn("overlay=eof_action=pass:enable='between(t,3.000,4.600)'[vcat]", g)
        self.assertIn("[vcat]subtitles=c.ass[vcap]", g)
        self.assertIn("concat=n=2:v=1:a=0[vout]", g)


class WiringTests(unittest.TestCase):
    def test_clipper_title_helper(self):
        import clipper  # noqa: PLC0415
        d = tempfile.mkdtemp(prefix="rp4-")
        try:
            ps = [piece(1, 4, teaser=True), piece(5, 9)]
            self.assertEqual(clipper._title(d, ps, 0.0, FRAME, {"title": None, "safe": SAFE}), (None, None), "flag off")
            self.assertEqual(clipper._title(d, ps, 0.0, FRAME, {"title": CFG, "tbrand": None, "safe": SAFE}), (None, None),
                             "no brand")
            ttl, rec = clipper._title(d, ps, 0.0, FRAME, {"title": CFG, "tbrand": "Brand", "safe": SAFE})
            self.assertEqual((rec["start"], ttl["textFile"]), (3.0, rt.TEXT_FILE))
            with open(os.path.join(d, rt.TEXT_FILE), encoding="utf-8") as f:
                self.assertEqual(f.read(), "Brand")
            self.assertTrue(os.path.isfile(os.path.join(d, ttl["fontFile"])))
            rt.cleanup(d)
            self.assertEqual(os.listdir(d), [], "the text file and the font copy are removed after the render")
        finally:
            shutil.rmtree(d, ignore_errors=True)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rp4-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        # a white picture with a black bar in the middle (so a blur changes it), and a tone
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=white:s=360x640:r=30:d=12",
                         "-f", "lavfi", "-i", "sine=f=440:d=12", "-vf", "drawbox=x=0:y=300:w=360:h=40:color=black:t=fill",
                         "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src], timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, name, title):
        ps = [piece(1, 4, teaser=True), piece(5, 9)]
        d = rt.prepare(self.tmp, title, CFG) if title else None
        argv = mont.render_argv("ffmpeg", self.src, ps, FRAME, ["-c:v", "libopenh264"], ["-c:a", "aac"], 80, name, title=d)
        res = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        rt.cleanup(self.tmp)
        self.assertEqual(res.returncode, 0, res.stderr)

    def luma_at(self, name, t):
        p = os.path.join(self.tmp, "y.txt")
        if os.path.exists(p):
            os.remove(p)
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", name, "-frames:v", "1", "-vf",
                         "crop=360:100:0:270,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=y.txt", "-f", "null", "-"],
                        cwd=self.tmp, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(p, encoding="utf-8") as f:
            return float([x for x in f.read().split() if x.startswith("lavfi.signalstats.YAVG=")][0].split("=")[1])

    def test_blurred_darker_copy_inside_the_window_only(self):
        rec = rt.plan([piece(1, 4, teaser=True), piece(5, 9)], 0.0, CFG, "Brand", FRAME, SAFE)
        self.assertEqual(rec["start"], 3.0)
        self.render("plain.mp4", None)
        self.render("titled.mp4", rec)
        a, b = (cc.media_info("ffprobe", os.path.join(self.tmp, n)) for n in ("plain.mp4", "titled.mp4"))
        self.assertAlmostEqual(a["duration"], b["duration"], delta=0.05, msg="a title never changes the length")
        for t in (1.0, 2.5, 5.5):  # before and after the window: the same picture
            self.assertAlmostEqual(self.luma_at("titled.mp4", t), self.luma_at("plain.mp4", t), delta=3, msg=t)
        mid = 3.0 + 0.45 + 0.3  # after the fade-in, before the fade-out
        self.assertLess(self.luma_at("titled.mp4", mid), self.luma_at("plain.mp4", mid) - 25, "darker inside the window")

    def test_fade_in_is_smooth(self):
        rec = rt.plan([piece(1, 4, teaser=True), piece(5, 9)], 0.0, CFG, "Brand", FRAME, SAFE)
        self.render("titled.mp4", rec)
        ys = [self.luma_at("titled.mp4", 3.0 + k * 0.1) for k in range(0, 5)]
        self.assertTrue(all(x >= y - 1 for x, y in zip(ys, ys[1:])), ys)  # luma only falls while the layer fades in
        self.assertLess(ys[0] - ys[1], 60, "no jump at the start of the fade")


if __name__ == "__main__":
    unittest.main()
