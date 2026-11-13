# SPDX-License-Identifier: GPL-3.0-or-later
"""RP6 thumbnail start frame (services/clip/reel_thumbnail.py, D366): the moment picked for the picture, the title
from the reel's facts, the flag (on by default, D368), the filter graph, and a real render (ffmpeg cases skip without
ffmpeg): the reel's first frame is the PNG, the reel is one frame longer, the text sits inside the safe area.
Synthetic pictures, times and a placeholder brand only."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import reel_thumbnail as th  # noqa: E402

CFG = th.load_config()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FRAME = {"width": 360, "height": 640}
SAFE = {"top": 20, "bottom": 60, "left": 12, "right": 24}


def piece(a, b, kills=1, **kw):
    return dict({"start": float(a), "end": float(b), "kills": kills}, **kw)


def reel(**kw):
    return dict({"pieces": [piece(10, 20, 2), piece(40, 50, 1)], "peaks": [12.0, 14.0, 45.0],
                 "medals": [{"t": 14.3, "w": 1.0, "label": "Double Kill"}], "kills": 3}, **kw)


class DataTests(unittest.TestCase):
    def test_flag_is_on_by_default_d368(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags[th.FLAG]["default"], True)

    def test_config(self):
        self.assertEqual(CFG["flag"], th.FLAG)
        self.assertEqual([x["id"] for x in CFG["lines"]], ["main", "sub", "brand"])
        self.assertEqual(sorted(k for k in CFG["text"] if not k.startswith("$")),
                         ["impact-play", "live-clip", "match-reel", "montage"])


class MomentTests(unittest.TestCase):
    def test_after_the_strongest_medal(self):
        r = reel(medals=[{"t": 14.3, "w": 1.0, "label": "Double Kill"}, {"t": 45.5, "w": 2.0, "label": "Triple Kill"}])
        self.assertEqual(th.moment(r, CFG), 45.9, "the heavier medal, medalLeadSec after it")

    def test_kept_inside_the_piece(self):
        r = reel(medals=[{"t": 19.9, "w": 1.0, "label": "Double Kill"}])
        self.assertEqual(th.moment(r, CFG), 19.95, "never past the piece's last frame, never into the next piece")

    def test_densest_kills_without_a_medal(self):
        self.assertEqual(th.moment(reel(medals=[]), CFG), 14.3, "two kills within the window beat the lone one")

    def test_teaser_pieces_and_outside_moments_are_ignored(self):
        r = reel(pieces=[piece(44, 46, 0, teaser=True), piece(10, 20, 2)], peaks=[12.0, 45.0], medals=[])
        self.assertEqual(th.moment(r, CFG), 12.3)

    def test_fallbacks(self):
        self.assertEqual(th.moment({"pieces": [piece(4, 18)], "anchor": 9.0}, CFG), 9.0)
        self.assertEqual(th.moment({"pieces": [piece(4, 18)]}, CFG), 11.0)
        self.assertIsNone(th.moment({"pieces": []}, CFG))


class TitleTests(unittest.TestCase):
    def test_montage(self):
        self.assertEqual(th.title_lines(reel(mode="mp"), "montage", CFG, "<brand>"),
                         [("main", "DOUBLE KILL"), ("sub", "3 KILLS · MP")], "a <placeholder> brand is not drawn")
        self.assertEqual(th.title_lines(reel(medals=[]), "montage", CFG, "Brand Name"),
                         [("main", "3 KILLS"), ("brand", "BRAND NAME")], "a sub equal to the main is left out")

    def test_match_reel_and_impact_play(self):
        self.assertEqual(th.title_lines(reel(resultText="Victory", mode="br"), "match-reel", CFG),
                         [("main", "VICTORY"), ("sub", "3 KILLS · BR")])
        self.assertEqual(th.title_lines({"pieces": [piece(1, 9, 0)], "kills": 0, "resultText": "#1"}, "impact-play", CFG),
                         [("main", "IMPACT PLAY"), ("sub", "#1")])

    def test_story_montage_uses_its_own_facts(self):
        r = reel(story={"result": "DEFEAT", "mode": "mp"})
        self.assertEqual(th.title_lines(r, "match-reel", CFG)[0], ("main", "DEFEAT"))

    def test_text_is_cleaned_and_cut(self):
        r = reel(medals=[{"t": 14.3, "w": 1.0, "label": "Ultra:kill{x}%  ;'quoted' and much too long"}])
        main = th.title_lines(r, "montage", CFG)[0][1]
        self.assertEqual(main, "ULTRAKILLX 'QUOTED")
        self.assertLessEqual(len(main), CFG["lines"][0]["maxChars"])

    def test_brand_from_profile(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "p.json")
            for v, want in (("<brand>", None), ("  ", None), ("Name", "Name")):
                with open(p, "w", encoding="utf-8") as f:
                    json.dump({"streamer": {"brand": v}}, f)
                self.assertEqual(th.brand(p), want)
            self.assertIsNone(th.brand(os.path.join(d, "missing.json")))


class FailureTests(unittest.TestCase):
    def test_a_failure_is_a_record_not_a_crash(self):
        with tempfile.TemporaryDirectory() as d:
            rec = th.make(os.path.join(d, "no-ffmpeg.exe"), "s.mp4", reel(), "montage", FRAME, SAFE, d, CFG)
            self.assertIn("error", rec)
            self.assertFalse([n for n in os.listdir(d) if n.startswith("thumb")], "nothing left behind")
            self.assertIn("error", th.make("ffmpeg", "s.mp4", {"pieces": []}, "montage", FRAME, SAFE, d, CFG))


class ArgvTests(unittest.TestCase):
    def test_png_graph(self):
        a = th.png_argv("ffmpeg", "s.mp4", 12.3, FRAME, [("main", "DOUBLE KILL"), ("sub", "3 KILLS")], CFG, SAFE,
                        "t.png", ["thumb-0.txt", "thumb-1.txt"])
        self.assertEqual(a[a.index("-ss") + 1], "12.300")
        vf = a[a.index("-vf") + 1]
        self.assertIn("textfile=thumb-0.txt:expansion=none", vf)
        self.assertIn(f"fontfile=fonts/{CFG['fontFile']}", vf)
        self.assertNotIn("DOUBLE", vf, "text only through the files")
        self.assertIn("x=12+(324-text_w)/2", vf, "centred in the safe width")
        self.assertIn(f"y={20 + round(0.06 * 640)}", vf, "from the top of the safe area")

    def test_render_argv_puts_the_frame_first_and_delays_the_sound(self):
        a = mont.render_argv("ffmpeg", "s.mp4", [piece(0, 5), piece(10, 15)], FRAME, ["-c:v", "x"], ["-c:a", "aac"],
                             80, "o.mp4", audio_tracks=2, captions="c.ass", thumbnail="thumbnail.png")
        self.assertEqual(a[a.index("thumbnail.png") - 7:a.index("thumbnail.png") + 1],
                         ["-loop", "1", "-framerate", "60", "-t", "0.016667", "-i", "thumbnail.png"])
        fc = a[a.index("-filter_complex") + 1]
        self.assertIn("[vcat]subtitles=c.ass[vcap]", fc, "captions on the reel, not on the start frame")
        self.assertIn("[vth][vcap]concat=n=2:v=1:a=0[vout]", fc)
        self.assertIn("[2:v]scale=", fc)
        for k in (0, 1):
            self.assertIn(f"[ab{k}]adelay=delays=800S:all=1[aout{k}]", fc)
        fc = mont.render_argv("ffmpeg", "s.mp4", [piece(0, 5)], FRAME, [], [], 80, "o.mp4", audio_tracks=0,
                              thumbnail="thumbnail.png")
        fc = fc[fc.index("-filter_complex") + 1]
        self.assertIn("[vth][vcat]concat=n=2:v=1:a=0[vout]", fc)
        self.assertNotIn("adelay", fc)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rp6-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        # 0-5 s black, 5-10 s white, a tone: the start frame (taken at 6.3 s, white) differs from the reel's start
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=5",
                         "-f", "lavfi", "-i", "color=c=white:s=360x640:r=30:d=5", "-f", "lavfi", "-i", "sine=f=440:d=10",
                         "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
                         "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src], timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def luma(self, name, n):
        """Average luma of the first n frames of a video or picture."""
        if os.path.exists(os.path.join(self.tmp, "y.txt")):
            os.remove(os.path.join(self.tmp, "y.txt"))
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-i", name, "-frames:v", str(n), "-vf",
                         "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=y.txt", "-f", "null", "-"],
                        cwd=self.tmp, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(self.tmp, "y.txt"), encoding="utf-8") as f:
            return [float(x.split("=")[1]) for x in f.read().split() if x.startswith("lavfi.signalstats.YAVG=")]

    def test_first_frame_is_the_png_and_one_frame_longer(self):
        r = {"pieces": [piece(1, 4, 0), piece(6, 8, 1)], "peaks": [6.0], "medals": [], "kills": 1}
        rec = th.make("ffmpeg", self.src, r, "live-clip", FRAME, SAFE, self.tmp, CFG, "Brand")
        self.assertNotIn("error", rec)
        self.assertEqual(rec["at"], 6.3)
        self.assertEqual([x["text"] for x in rec["lines"]], ["1 KILL", "BRAND"])
        self.assertFalse([n for n in os.listdir(self.tmp) if n.startswith("thumb-")], "the text files are removed")
        for name, thumb in (("plain.mp4", None), ("thumb.mp4", rec["file"])):
            argv = mont.render_argv("ffmpeg", self.src, r["pieces"], FRAME, ["-c:v", "libopenh264"], ["-c:a", "aac"], 80,
                                    name, thumbnail=thumb)
            res = cc.run_tool(argv, cwd=self.tmp, timeout=600)
            self.assertEqual(res.returncode, 0, res.stderr)
        plain = cc.media_info("ffprobe", os.path.join(self.tmp, "plain.mp4"))
        thumb = cc.media_info("ffprobe", os.path.join(self.tmp, "thumb.mp4"))
        self.assertAlmostEqual(thumb["duration"] - plain["duration"], 1 / 60, delta=0.01)
        png = self.luma(rec["file"], 1)[0]
        first, second = self.luma("thumb.mp4", 2)[:2]  # the filter may see one frame more than -frames:v writes
        self.assertGreater(png, 150, "the start frame is the white moment (the title adds dark borders)")
        self.assertAlmostEqual(first, png, delta=6, msg="frame 0 of the reel is the PNG")
        self.assertLess(second, 30, "frame 1 is the reel's black start")

    def test_text_inside_the_safe_area(self):
        # the title drawn on black: every lit pixel row/column lies inside the safe area
        r = {"pieces": [piece(1, 4, 0)], "medals": [{"t": 2.0, "w": 1.0, "label": "Triple Kill"}], "kills": 3}
        cfg = dict(CFG, picture=dict(CFG["picture"], vignette=False, brightness=0, saturation=1, sharpen=0))
        rec = th.make("ffmpeg", self.src, r, "montage", FRAME, SAFE, self.tmp, cfg, "A Long Brand Name Here")
        self.assertNotIn("error", rec)
        res = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-i", rec["file"], "-vf",
                           "format=gray", "-f", "rawvideo", "gray.raw", "-y"], cwd=self.tmp, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(os.path.join(self.tmp, "gray.raw"), "rb") as f:
            px = f.read()
        w, h = FRAME["width"], FRAME["height"]
        lit = [(i % w, i // w) for i, v in enumerate(px) if v > 60]
        self.assertTrue(lit, "the title is drawn")
        xs, ys = [p[0] for p in lit], [p[1] for p in lit]
        self.assertGreaterEqual(min(xs), SAFE["left"])
        self.assertLessEqual(max(xs), w - SAFE["right"])
        self.assertGreaterEqual(min(ys), SAFE["top"])
        self.assertLessEqual(max(ys), h - SAFE["bottom"])


if __name__ == "__main__":
    unittest.main()
