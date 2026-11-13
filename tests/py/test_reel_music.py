# SPDX-License-Identifier: GPL-3.0-or-later
"""RP3 music beds (services/clip/reel_music.py, D363, D370): the plan (where the beds go), the procedural synthesis
(same seed = same bed, level, silence between the beds), the filter graph, and a real render (ffmpeg cases skip
without ffmpeg): the bed is heard where the reel is quiet, is ducked under loud game sound, and never changes the
length or the other audio tracks. Synthetic audio only."""

import array
import math
import os
import shutil
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import reel_music as rm  # noqa: E402

CFG = rm.load_config()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FRAME = {"width": 180, "height": 320}


def piece(a, b, **kw):
    return dict({"start": float(a), "end": float(b), "kills": 1}, **kw)


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        a = array.array("h")
        a.frombytes(w.readframes(w.getnframes()))
    return sr, ch, a


def rms_db(samples):
    if not samples:
        return -120.0
    r = math.sqrt(sum(float(v) * v for v in samples) / len(samples)) / 32768.0
    return 20 * math.log10(r) if r > 0 else -120.0


class DataTests(unittest.TestCase):
    def test_flag_is_off_by_default(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags[rm.FLAG]["default"], False)
        self.assertEqual(CFG["flag"], rm.FLAG)

    def test_bad_config_is_refused(self):
        for patch in ({"generator": "model"}, {"gainDb": -3}, {"bpm": {"min": 90, "max": 80}},
                      {"progressions": [{"id": "x", "chords": [[0, "dim9"]]}]}):
            d = tempfile.mkdtemp(prefix="rp3-")
            p = os.path.join(d, "m.json")
            cc.write_json_atomic(p, dict(CFG, **patch))
            with self.assertRaises(cc.ClipError, msg=str(patch)):
                rm.load_config(p)
            shutil.rmtree(d, ignore_errors=True)


class PlanTests(unittest.TestCase):
    def test_beds_follow_the_title_and_the_end(self):
        ps = [piece(50, 53, teaser=True), piece(10, 30)]
        rec = rm.plan(ps, 0.0, {"start": 3.0, "end": 4.6}, CFG, 7)
        self.assertEqual(rec["total"], 23.0)
        self.assertEqual(rec["intro"], [0.0, 4.6], "the start bed ends with the title")
        self.assertEqual(rec["outro"], [19.0, 23.0])
        self.assertTrue(CFG["bpm"]["min"] <= rec["bpm"] <= CFG["bpm"]["max"])

    def test_without_a_title(self):
        rec = rm.plan([piece(10, 30)], 0.0, None, CFG, 7)
        self.assertEqual(rec["intro"], [0.0, CFG["introSec"]])

    def test_short_reels(self):
        self.assertIsNone(rm.plan([piece(10, 15)], 0.0, None, CFG, 7), "under minReelSec: no music")
        rec = rm.plan([piece(10, 19)], 0.0, {"start": 3.0, "end": 4.6}, CFG, 7)
        self.assertEqual(rec["intro"], [0.0, 4.5], "the start bed never takes more than half the reel")
        self.assertIsNone(rec["outro"], "no room for an end bed after the start bed")

    def test_seed_is_stable_and_per_reel(self):
        self.assertEqual(rm.seed_for("M01", "a.mkv"), rm.seed_for("M01", "a.mkv"))
        self.assertNotEqual(rm.seed_for("M01", "a.mkv"), rm.seed_for("M02", "a.mkv"))


class SynthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rp3-")
        cls.rec = rm.plan([piece(10, 22)], 0.0, None, CFG, 11)
        cls.path = os.path.join(cls.tmp, "a.wav")
        rm.synth(cls.rec, CFG, cls.path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_layout_and_level(self):
        sr, ch, a = read_wav(self.path)
        self.assertEqual((sr, ch), (48000, 2))
        self.assertAlmostEqual(len(a) / 2 / sr, self.rec["total"], delta=0.01, msg="as long as the reel")
        def win(s, e):
            return a[int(s * sr) * 2:int(e * sr) * 2]
        self.assertGreater(rms_db(win(0.5, 2.0)), -45, "the start bed is there")
        self.assertEqual(max(abs(v) for v in win(3.2, 7.5)), 0, "silence between the beds")
        self.assertGreater(rms_db(win(9.0, 11.0)), -45, "the end bed is there")
        peak = max(abs(v) for v in a) / 32768.0
        self.assertLessEqual(20 * math.log10(peak), CFG["gainDb"] + 0.5, "never above the bed level")
        self.assertLess(max(abs(v) for v in a[-200:]), 400, "fades out to the end")

    def test_same_seed_same_bed_other_seed_other_bed(self):
        b = os.path.join(self.tmp, "b.wav")
        rm.synth(self.rec, CFG, b)
        with open(self.path, "rb") as f1, open(b, "rb") as f2:
            self.assertEqual(f1.read(), f2.read())
        c = os.path.join(self.tmp, "c.wav")
        rm.synth(dict(self.rec, seed=12), CFG, c)
        with open(self.path, "rb") as f1, open(c, "rb") as f3:
            self.assertNotEqual(f1.read(), f3.read())


class ArgvTests(unittest.TestCase):
    def graph(self, **kw):
        a = mont.render_argv("ffmpeg", "s.mp4", [piece(1, 4), piece(5, 9)], FRAME, [], [], 80, "o.mp4",
                             music={"file": "music.wav", "duck": CFG["duck"]}, **kw)
        return a, a[a.index("-filter_complex") + 1]

    def test_track_one_only_ducked(self):
        a, g = self.graph(audio_tracks=2)
        self.assertIn("music.wav", a)
        self.assertIn("[2:a]aresample=48000[mbed]", g)
        self.assertIn("[amus0]asplit=2[mgame][mkey]", g)
        self.assertIn("sidechaincompress=threshold=0.05:ratio=6", g)
        self.assertIn("amix=inputs=2:duration=first:normalize=0[aout0]", g)
        self.assertIn("[aout1]", g)
        self.assertNotIn("[amus1]", g)

    def test_with_the_start_frame_the_input_index_moves(self):
        _, g = self.graph(thumbnail="t.png")
        self.assertIn("[3:a]aresample=48000[mbed]", g)
        self.assertIn("normalize=0[ab0]", g)

    def test_picture_only_has_no_music(self):
        a, g = self.graph(audio_tracks=0)
        self.assertNotIn("music.wav", a)
        self.assertNotIn("mbed", g)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rp3-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        # 0-10 s silent, 10-20 s a loud tone (game sound)
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=gray:s=180x320:r=30:d=20",
                         "-f", "lavfi", "-i", "aevalsrc=if(gte(t\\,10)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=20",
                         "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src], timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, name, ps, rec):
        d = rm.prepare(self.tmp, rec, CFG) if rec else None
        argv = mont.render_argv("ffmpeg", self.src, ps, FRAME, ["-c:v", "libopenh264"], ["-c:a", "pcm_s16le"], 80,
                                name, music=d)
        argv[argv.index("-f", len(argv) - 4) + 1] = "mov"
        res = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        rm.cleanup(self.tmp)
        self.assertEqual(res.returncode, 0, res.stderr)

    def level(self, name, s, e):
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", name,
                         "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000", "pcm.raw", "-y"], cwd=self.tmp, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        a = array.array("h")
        with open(os.path.join(self.tmp, "pcm.raw"), "rb") as f:
            a.frombytes(f.read())
        return rms_db(a)

    def test_heard_on_quiet_ducked_on_loud_same_length(self):
        ps = [piece(0, 10)]
        rec = rm.plan(ps, 0.0, None, CFG, 3)
        self.render("plain.mov", ps, None)
        self.render("music.mov", ps, rec)
        a, b = (cc.media_info("ffprobe", os.path.join(self.tmp, n)) for n in ("plain.mov", "music.mov"))
        self.assertAlmostEqual(a["duration"], b["duration"], delta=0.05, msg="music never changes the length")
        self.assertLess(self.level("plain.mov", 0.5, 2.5), -60, "the source is silent at the start")
        self.assertGreater(self.level("music.mov", 0.5, 2.5), -45, "the bed is heard where the reel is quiet")
        self.assertLess(self.level("music.mov", 4.0, 5.5), -60, "nothing between the beds")
        # loud game sound: the ducked bed adds almost nothing on top of it
        ps2 = [piece(10, 20)]
        rec2 = rm.plan(ps2, 0.0, None, CFG, 3)
        self.render("plain2.mov", ps2, None)
        self.render("music2.mov", ps2, rec2)
        self.assertLess(abs(self.level("music2.mov", 0.5, 2.5) - self.level("plain2.mov", 0.5, 2.5)), 1.0,
                        "under loud game sound the bed stays under it")


if __name__ == "__main__":
    unittest.main()
