# SPDX-License-Identifier: GPL-3.0-or-later
"""Kill montages on the "while" clip path (D322 proposed; user 2026-11-10: "checked the normal clips. but did not
receive the montage clips"): `clipper.py live-review --recording H --v-recording V --montage --publish` makes the short
clips from the live saves, then the kill montages and match reels of the stream's recording into DIR/montage, and
publishes both. A montage that cannot be made keeps the shorts and the exit code; render.json `montage` says why.

Generated media only (lavfi, 12 s), fixture detector hits (two own kills and a VICTORY, as test_clip_pipeline's montage
case), placeholder data. The end-to-end cases need ffmpeg and ffprobe on PATH and are skipped without them; they write
only to a temp folder outside the repository."""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "clip"))
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_common as cc  # noqa: E402
import clipper  # noqa: E402

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
START = "2026-11-03T07:00:00Z"
HITS = ({"t": 3.0, "detector": "M5", "signal": True}, {"t": 5.0, "detector": "M5", "signal": True},
        {"t": 9.0, "detector": "W1", "label": "VICTORY", "signal": True, "tEnd": 10.0, "banner": "match"})


def _write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def _run_folder(out, rec):
    """DIR as `detect` leaves it for this recording: hits, the pass summary, the end-screen readings."""
    os.makedirs(out, exist_ok=True)
    _write(os.path.join(out, "detector-hits.jsonl"), "".join(json.dumps(h) + "\n" for h in HITS))
    _write(os.path.join(out, "detector-pass.json"), json.dumps({"recording": os.path.basename(rec), "game": "codm",
                                                                "duration": 12.0}))
    _write(os.path.join(out, "match-stats.json"), json.dumps({
        "recording": os.path.basename(rec), "ownKills": {"times": [3.0, 5.0]},
        "readings": [{"t": 9.5, "kind": "top3", "ownRank": 1, "ownScore": 1000, "gameMode": "hardpoint", "cards": []}]}))


class SkipTests(unittest.TestCase):
    """No media: the montage is skipped (never an error) when an input is missing."""

    def test_no_v_recording_skips(self):
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "stream-h-20261103-070000.mkv")
            _write(rec, "x")
            a = clipper.build_parser().parse_args(["live-review", "--saves", d, "--out", os.path.join(d, "o"),
                                                   "--recording", rec, "--montage"])
            self.assertEqual(clipper._live_montage(a), {"status": "skipped",
                                                        "reason": "no V recording of the stream (--v-recording)"})

    def test_no_recording_skips(self):
        with tempfile.TemporaryDirectory() as d:
            a = clipper.build_parser().parse_args(["live-review", "--saves", d, "--out", os.path.join(d, "o"), "--montage"])
            self.assertEqual(clipper._live_montage(a)["status"], "skipped")

    def test_detect_not_run_twice(self):
        """When live-review's match gate already ran a detector pass that failed, --montage does not run another."""
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "stream-h-20261103-070000.mkv")
            _write(rec, "x")
            _write(rec.replace("-h-", "-v-"), "x")
            a = clipper.build_parser().parse_args(["live-review", "--saves", d, "--out", os.path.join(d, "o"),
                                                   "--recording", rec, "--montage"])
            a.detect_ran = True
            calls = []
            orig = clipper.cmd_detect
            clipper.cmd_detect = lambda x: calls.append(x)
            try:
                st = clipper._live_montage(a)
            finally:
                clipper.cmd_detect = orig
            self.assertEqual(calls, [])
            self.assertEqual(st, {"status": "failed", "reason": "no detector hits for the stream's recording"})


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class LiveMontageEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.TemporaryDirectory()
        d = cls.td.name
        rec_dir = os.path.join(d, "recordings")
        os.makedirs(rec_dir)
        cls.rec = os.path.join(rec_dir, "stream-h-20261103-070000.mkv")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "4",
                         "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12",
                         "-f", "lavfi", "-i", "aevalsrc='sin(2*PI*440*t)*0.1':s=48000:d=12",
                         "-c:v", "libopenh264", "-b:v", "800k", "-c:a", "aac", "-b:a", "96k", cls.rec], timeout=300)
        if r.returncode != 0:
            raise unittest.SkipTest(f"cannot generate test media: {r.stderr[-200:]}")
        cls.vrec = cls.rec.replace("-h-", "-v-")
        shutil.copyfile(cls.rec, cls.vrec)
        cls.v_silent = os.path.join(rec_dir, "silent-v-20261103-070000.mkv")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", cls.rec, "-an", "-c", "copy", cls.v_silent],
                        timeout=120)
        if r.returncode != 0:
            raise unittest.SkipTest(f"cannot generate test media: {r.stderr[-200:]}")
        cls.data = os.path.join(d, "data")
        os.makedirs(cls.data)
        _write(os.path.join(cls.data, cc.LOCAL_FLAGS), json.dumps({"flags": {"clip-pipeline": True}}))
        # the match gate off: the saves are kept without a detector pass (the gate has its own tests)
        _write(os.path.join(cls.data, "settings.json"), json.dumps({"clips": {"matchGate": {"top3": False, "minKills": None}}}))

    @classmethod
    def tearDownClass(cls):
        cls.td.cleanup()

    def setUp(self):
        self.case = tempfile.mkdtemp(dir=self.td.name)
        self.saves = os.path.join(self.case, "saves")
        os.makedirs(self.saves)
        save = os.path.join(self.saves, "save-1.mkv")  # not host-named: --drop-used-saves leaves it
        shutil.copyfile(self.vrec, save)
        _write(os.path.join(self.saves, "saves.jsonl"), json.dumps({
            "v": 1, "at": "2026-11-03T07:00:12.000Z", "reason": "streak", "score": 3, "labels": ["TRIPLE KILL"],
            "startBack": 8, "endBack": 1, "files": [{"canvas": "v", "path": save}]}) + "\n")
        self.out = os.path.join(self.case, "run")
        _run_folder(self.out, self.rec)
        self.clips = os.path.join(self.case, "user clips")

    def live_review(self, *extra):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            rc = clipper.main(["--data-dir", self.data, "live-review", "--saves", self.saves, "--out", self.out,
                               "--recording", self.rec, "--record-start", START, "--encoder", "libopenh264",
                               "--publish", self.clips, "--drop-used-saves", "--montage", *extra])
        return rc, buf.getvalue()

    def published(self):
        return sorted(n for _r, _d, fs in os.walk(self.clips) for n in fs)

    def test_live_review_makes_and_publishes_the_montage(self):
        rc, log = self.live_review("--v-recording", self.vrec)
        self.assertEqual(rc, 0, log)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "montage", "clips", "W01", "montage-v.mp4")), log)
        st = cc.load_json(os.path.join(self.out, clipper.RENDER))["montage"]
        self.assertEqual((st["status"], st["videos"]), ("made", 1), st)
        rep = cc.load_json(os.path.join(self.out, "montage", clipper.REPORT))
        self.assertEqual([(r["id"], r["ok"]) for r in rep["results"]], [("W01", True)])
        names = self.published()
        self.assertEqual(sum(1 for n in names if "_short_" in n), 1, names)
        self.assertEqual(sum(1 for n in names if "_won-reel_" in n), 1, names)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "montage", "published.json")))
        self.assertRegex(log, r'ujwalam-progress \{"stage": ?"montage"', "progress line for the montage stage")
        self.assertTrue(os.path.isfile(self.rec) and os.path.isfile(self.vrec), "the recordings are never deleted")

    def test_montage_failure_keeps_the_shorts(self):
        rc, log = self.live_review("--v-recording", self.v_silent)
        self.assertEqual(rc, 0, "a montage failure never changes the exit code (D322 proposed)")
        st = cc.load_json(os.path.join(self.out, clipper.RENDER))["montage"]
        self.assertEqual(st["status"], "failed")
        self.assertIn("no audio", st["reason"])
        self.assertIn("montage: NOT MADE", log)
        names = self.published()
        self.assertEqual(sum(1 for n in names if "_short_" in n), 1, names)
        self.assertFalse(any("_won-reel_" in n or "_montage_" in n for n in names), names)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "published.json")), "the shorts' publish record stays")

    def test_without_montage_flag_nothing_extra(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            rc = clipper.main(["--data-dir", self.data, "live-review", "--saves", self.saves, "--out", self.out,
                               "--recording", self.rec, "--record-start", START, "--encoder", "libopenh264"])
        self.assertEqual(rc, 0, buf.getvalue())
        self.assertNotIn("montage", cc.load_json(os.path.join(self.out, clipper.RENDER)))
        self.assertFalse(os.path.exists(os.path.join(self.out, "montage")))


if __name__ == "__main__":
    unittest.main()
