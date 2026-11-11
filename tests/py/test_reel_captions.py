# SPDX-License-Identifier: GPL-3.0-or-later
"""ED2 burned-in captions (services/clip/reel_captions.py, D353): confidence threshold as data, original script kept,
bundled OFL font only (and what it cannot draw is not burned), V safe zone, transcript stored and editable, recaption
renders the reel again with the edited text. Synthetic audio and video only; the speech to text is injected (real
model quality is UNVERIFIED and belongs to STT-ML). ffmpeg cases skip without ffmpeg."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_captions as caps  # noqa: E402
import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import clipper  # noqa: E402
import reel_captions as rcap  # noqa: E402
import reel_length as rl  # noqa: E402

CFG = rcap.load_config()
STYLE = rcap.load_style(CFG)
SAFE = caps.safe_area(cc.load_config("targets"))
FRAME = {"width": 1080, "height": 1920}
FONT = os.path.join(rcap.FONTS_DIR, STYLE["fontFile"])
CPS = rcap.font_codepoints(FONT)
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
ML = "നല്ല കളി"  # Malayalam words (synthetic, no real speech)
try:
    from fontTools.ttLib import TTFont  # noqa: PLC0415 (dev check only; not a runtime dependency)
except ImportError:
    TTFont = None


def seg(a, b, text, conf):
    return {"start": a, "end": b, "text": text, "confidence": conf}


class FontTests(unittest.TestCase):
    def test_only_bundled_ofl_fonts_and_no_microsoft_font(self):
        self.assertTrue(STYLE["fontFile"] in os.listdir(rcap.FONTS_DIR))
        for p in ("reel-captions-bold", "reel-captions-barlow"):
            st = rcap.load_style(dict(CFG, preset=p))
            self.assertNotIn(st["fontFamily"].lower(), ("arial", "corbel", "consolas", "segoe ui", "nirmala ui"))

    @unittest.skipUnless(TTFont, "fontTools not importable")
    def test_cmap_reader_matches_fonttools(self):
        for f in sorted(os.listdir(rcap.FONTS_DIR)):
            if f.endswith(".ttf"):
                p = os.path.join(rcap.FONTS_DIR, f)
                self.assertEqual(rcap.font_codepoints(p), set(TTFont(p).getBestCmap()), f)

    def test_no_bundled_font_covers_malayalam_today(self):
        # D353 finding: a Malayalam caption font would be a new font file (an install the user decides on)
        for f in sorted(os.listdir(rcap.FONTS_DIR)):
            if f.endswith(".ttf"):
                self.assertFalse(rcap.covers(os.path.join(rcap.FONTS_DIR, f), "Malayalam"), f)
                self.assertTrue(rcap.covers(os.path.join(rcap.FONTS_DIR, f), "Latin"), f)

    @unittest.skipUnless(TTFont, "fontTools not importable")
    def test_a_full_line_fits_the_safe_width(self):
        t = TTFont(FONT)
        cm, hm, upm = t.getBestCmap(), t["hmtx"], t["head"].unitsPerEm
        line = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[:STYLE["maxCharsPerLine"]]
        width = sum(hm[cm[ord(c)]][0] for c in line) * STYLE["sizePx"] / upm + 2 * STYLE["outlinePx"]
        self.assertLessEqual(width, FRAME["width"] - SAFE["left"] - SAFE["right"])
        height = STYLE["maxLines"] * STYLE["sizePx"] * 1.25 + 2 * STYLE["outlinePx"]
        self.assertLessEqual(height, FRAME["height"] - SAFE["top"] - SAFE["bottom"])


class TranscriptTests(unittest.TestCase):
    def test_threshold_and_script_marks(self):
        rows = rcap.mark([seg(0, 1, "nice shot bro", 0.9), seg(1, 2, "mumble", 0.2), seg(2, 3, "no conf", None),
                          seg(3, 4, ML + " clutch", 0.95), seg(4, 4.1, "ok", 0.99)], CFG, CPS, duration=10)
        self.assertEqual([r["show"] for r in rows], [True, False, False, True, False])
        self.assertIn("below", rows[1]["hidden"])
        self.assertIn("no confidence", rows[2]["hidden"])
        self.assertEqual(rows[3]["fontMissing"], ["Malayalam"])
        self.assertEqual(rows[3]["text"], ML + " clutch", "the original script is kept, never transliterated")

    def test_ass_has_only_shown_drawable_text_inside_the_safe_zone(self):
        tr = {"segments": rcap.mark([seg(0, 2, "what a triple kill that was", 0.9), seg(2, 3, "low", 0.1),
                                     seg(3, 5, ML, 0.9), seg(5, 6, "{\\b1}x", 0.9)], CFG, CPS)}
        text, n = rcap.to_ass(tr, FRAME, SAFE, STYLE, duration=6)
        self.assertNotIn("low", text.split("[Events]")[1])
        self.assertNotIn(ML, text)
        self.assertNotIn("{\\b1}", text, "speech text cannot inject ASS overrides")
        style = next(x for x in text.splitlines() if x.startswith("Style: Reel,"))
        f = style.split(",")
        self.assertEqual((f[1], f[2]), (STYLE["fontFamily"], str(STYLE["sizePx"])))
        self.assertEqual(f[-4:], [str(SAFE["left"]), str(SAFE["right"]), str(SAFE["bottom"]), "1"])
        self.assertEqual(f[18], "2", "bottom centre")
        cards = [x for x in text.splitlines() if x.startswith("Dialogue:")]
        self.assertEqual(n, len(cards))
        for c in cards[:2]:
            words = c.split(",,", 1)[1].replace("\\N", " ").split()
            self.assertLessEqual(len(words), STYLE["maxWordsPerCard"])

    def test_edited_transcript_is_used_as_is(self):
        tr = {"segments": rcap.mark([seg(0, 2, "wrong words", 0.9), seg(2, 3, "hidden one", 0.1)], CFG, CPS)}
        tr["segments"][0]["text"] = "right words"
        tr["segments"][1]["show"] = True  # the user shows a low-confidence line after fixing it
        text, n = rcap.to_ass(tr, FRAME, SAFE, STYLE)
        self.assertIn("right words", text)
        self.assertIn("hidden one", text)
        self.assertNotIn("wrong", text)
        tr["segments"][0]["text"] = ML  # an edit into Malayalam: refresh marks it, nothing undrawable is burned
        text, _ = rcap.to_ass(rcap.refresh_hidden(tr, STYLE), FRAME, SAFE, STYLE)
        self.assertNotIn(ML, text)

    def test_faster_whisper_confidence(self):
        self.assertAlmostEqual(caps.segment_confidence(0.0, 0.0), 1.0)
        self.assertAlmostEqual(caps.segment_confidence(-0.6931, 0.5), 0.25, places=3)
        self.assertIsNone(caps.segment_confidence(None, 0.1))

    def test_whisper_cpp_full_json_confidence(self):
        j = {"transcription": [{"offsets": {"from": 0, "to": 1000}, "text": " hi",
                                "tokens": [{"text": "[_BEG_]", "p": 0.1}, {"text": " hi", "p": 0.8}, {"text": "!", "p": 0.6}]},
                               {"offsets": {"from": 1000, "to": 2000}, "text": " no tokens"}]}
        rows = caps.parse_whisper_cpp_json(j)
        self.assertAlmostEqual(rows[0]["confidence"], 0.7)
        self.assertNotIn("confidence", rows[1])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ed2-")
        cls.src = os.path.join(cls.tmp, "v.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x202020:s=540x960:r=30:d=12",
                         "-f", "lavfi", "-i", "sine=f=300:d=12", "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src],
                        timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _frame(self, name, t):
        import subprocess  # noqa: PLC0415
        out = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{t:.2f}", "-i", os.path.join(self.tmp, name),
                              "-frames:v", "1", "-vf", "scale=270:480", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                             capture_output=True, timeout=120, **cc.child_kwargs(**cc.NO_WINDOW))
        self.assertEqual(out.returncode, 0)
        return out.stdout

    def test_transcript_on_the_reel_timeline_and_burned_inside_the_safe_zone(self):
        pieces = [{"start": 6.0, "end": 8.0, "kills": 0, "teaser": True}, {"start": 1.0, "end": 9.0, "kills": 1}]
        wd = os.path.join(self.tmp, "M01")
        os.makedirs(wd, exist_ok=True)
        seen = {}

        def fake(backend, wav, opts):
            seen["opts"] = opts
            seen["dur"] = cc.media_info("ffprobe", wav)["duration"]
            return [seg(0.2, 1.8, "TEASER LINE", 0.9), seg(3.0, 6.0, "LOW ONE", 0.1), seg(6.5, 9.5, ML, 0.9)], \
                {"backend": backend, "status": "ok", "language": "en"}

        tr, info = rcap.make_transcript("ffmpeg", self.src, pieces, CFG, STYLE, {"whisper_model": "m"}, wd, 10.0,
                                        transcribe=fake)
        self.assertAlmostEqual(seen["dur"], 10.0, delta=0.1, msg="the joined audio is the reel's own timeline")
        self.assertEqual(seen["opts"]["full_json"], True)
        self.assertIs(seen["opts"]["multilingual"], True)
        self.assertTrue(os.path.isfile(os.path.join(wd, rcap.TRANSCRIPT)))
        self.assertEqual(info["shown"], 1)
        ass, fdir, n = rcap.write_ass(tr, FRAME, SAFE, STYLE, wd, 10.0)
        self.assertEqual((ass, fdir, n), ("captions.ass", "fonts", 1))
        argv = mont.render_argv("ffmpeg", self.src, pieces, FRAME, ["-c:v", "libopenh264"], ["-c:a", "aac"], 80,
                                "cap.mp4", max_sec=10, captions=ass, fontsdir=fdir)
        r = cc.run_tool(argv, cwd=wd, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = mont.render_argv("ffmpeg", self.src, pieces, FRAME, ["-c:v", "libopenh264"], ["-c:a", "aac"], 80,
                                "plain.mp4", max_sec=10)
        self.assertEqual(cc.run_tool(argv, cwd=wd, timeout=600).returncode, 0)
        a = self._frame(os.path.join("M01", "cap.mp4"), 1.0)
        b = self._frame(os.path.join("M01", "plain.mp4"), 1.0)
        w, h = 270, 480
        sx = w / FRAME["width"]
        changed = [(i % w, i // w) for i in range(w * h) if abs(a[i] - b[i]) > 40]
        self.assertTrue(changed, "the caption is burned in")
        xs, ys = [c[0] for c in changed], [c[1] for c in changed]
        self.assertGreaterEqual(min(xs), int(SAFE["left"] * sx) - 1)
        self.assertLessEqual(max(xs), w - int(SAFE["right"] * sx) + 1)
        self.assertGreaterEqual(min(ys), int(SAFE["top"] * sx) - 1)
        self.assertLessEqual(max(ys), h - int(SAFE["bottom"] * sx) + 1)
        c = self._frame(os.path.join("M01", "cap.mp4"), 4.0)
        d = self._frame(os.path.join("M01", "plain.mp4"), 4.0)
        self.assertFalse(any(abs(c[i] - d[i]) > 40 for i in range(w * h)), "a low-confidence line is not burned")

    def test_recaption_renders_again_with_the_edited_transcript(self):
        out = os.path.join(self.tmp, "run")
        wd = os.path.join(out, "clips", "M01")
        os.makedirs(wd, exist_ok=True)
        data = os.path.join(self.tmp, "data")
        os.makedirs(data, exist_ok=True)
        with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-captions": True}}, f)
        pieces = [{"start": 1.0, "end": 7.0, "kills": 1}]
        shutil.copyfile(self.src, os.path.join(wd, "montage-v.mp4"))
        cc.write_json_atomic(os.path.join(out, "render.json"), {
            "tool": "clipper.montage", "frame": {"width": 540, "height": 960}, "vRecordingPath": self.src,
            "audioFadeMs": 80, "clips": [{"id": "M01", "start": 0.0, "end": 6.0, "pieces": pieces,
                                          "captions": {"status": "ok"},
                                          "files": [{"layout": "montage-v", "file": "montage-v.mp4", "geometry": "canvas"}]}]})
        cc.write_json_atomic(os.path.join(wd, rcap.TRANSCRIPT), {"version": 1, "edited": True, "segments": [
            {"start": 0.5, "end": 3.0, "text": "EDITED LINE", "confidence": 0.3, "show": True, "hidden": None}]})
        rc = clipper.main(["--data-dir", data, "recaption", "--out", out, "--id", "M01", "--encoder", "libopenh264"])
        self.assertEqual(rc, 0)
        row = cc.load_json(os.path.join(out, "render.json"))["clips"][0]
        self.assertEqual((row["captions"]["cards"], row["captions"]["burned"]), (1, True))
        self.assertIn("recaptionedAt", row["captions"])
        self.assertFalse(os.path.isdir(os.path.join(wd, "fonts")), "the font copy is removed after the render")
        dur = cc.media_info("ffprobe", os.path.join(wd, "montage-v.mp4"))["duration"]
        self.assertAlmostEqual(dur, 6.0, delta=0.15)
        # captions off: recaption refuses
        with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-captions": False}}, f)
        self.assertEqual(clipper.main(["--data-dir", data, "recaption", "--out", out, "--id", "M01"]), 1)

    def test_recaption_keeps_the_reel_length_after_the_maximum_is_lowered(self):
        out = os.path.join(self.tmp, "run-long")
        wd = os.path.join(out, "clips", "M01")
        os.makedirs(wd, exist_ok=True)
        data = os.path.join(self.tmp, "data-long")
        os.makedirs(data, exist_ok=True)
        with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-captions": True}}, f)
        pieces = [{"start": 1.0, "end": 11.0, "kills": 1} for _ in range(3)]  # a 30 s reel
        r = cc.run_tool(mont.render_argv("ffmpeg", self.src, pieces, {"width": 540, "height": 960},
                                         ["-c:v", "libopenh264"], ["-c:a", "aac"], 80, "montage-v.mp4"), cwd=wd, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        before = cc.media_info("ffprobe", os.path.join(wd, "montage-v.mp4"))["duration"]
        self.assertAlmostEqual(before, 30.0, delta=0.15)
        # the user lowers the montage maximum to 20 s after the reel was made
        with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"reelLengths": {"montage": {"minSec": 20, "maxSec": 20}}}}, f)
        self.assertEqual(rl.effective_limits(data)["montage"]["maxSec"], 20)
        cc.write_json_atomic(os.path.join(out, "render.json"), {
            "tool": "clipper.montage", "frame": {"width": 540, "height": 960}, "vRecordingPath": self.src,
            "audioFadeMs": 80, "clips": [{"id": "M01", "start": 0.0, "end": 30.0, "pieces": pieces,
                                          "captions": {"status": "ok"},
                                          "files": [{"layout": "montage-v", "file": "montage-v.mp4", "geometry": "canvas"}]}]})
        cc.write_json_atomic(os.path.join(wd, rcap.TRANSCRIPT), {"version": 1, "edited": True, "segments": [
            {"start": 25.0, "end": 28.0, "text": "LATE LINE", "confidence": 0.9, "show": True, "hidden": None}]})
        rc = clipper.main(["--data-dir", data, "recaption", "--out", out, "--id", "M01", "--encoder", "libopenh264"])
        self.assertEqual(rc, 0)
        after = cc.media_info("ffprobe", os.path.join(wd, "montage-v.mp4"))["duration"]
        self.assertAlmostEqual(after, before, delta=0.15, msg="no cut from the current maximum setting")


if __name__ == "__main__":
    unittest.main()
