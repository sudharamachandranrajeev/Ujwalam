# SPDX-License-Identifier: GPL-3.0-or-later
"""Match gate on the "while" clip path (D304 proposed): `clipper.py live-review --recording` finds the matches of the
stream's own recording (detector hits already in the run folder here, so no OCR runs) and drops the live saves that
fall inside a skipped match. Placeholder data only (hits and stats from test_clip_match_gate.SegmentTests: match 1
0-346 s kept (#2 on the top 3), match 2 346-748 s skipped (not on the top 3), match 3 748-900 s no end seen, kept)."""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import clipper  # noqa: E402
import test_clip_match_gate as tmg  # noqa: E402

START = "2026-11-08T13:24:38Z"


def at(sec):
    """ISO UTC with milliseconds and a Z, `sec` seconds after START (the live saves' format)."""
    from datetime import datetime, timedelta, timezone
    t = datetime(2026, 11, 8, 13, 24, 38, tzinfo=timezone.utc) + timedelta(seconds=sec)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LiveReviewGateTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        root = self.td.name
        self.out = os.path.join(root, "out")
        self.data = os.path.join(root, "data")
        self.saves = os.path.join(root, "saves")
        for d in (self.out, self.data, self.saves):
            os.makedirs(d)
        self.rec = os.path.join(root, "stream-h-20261108-132438.mkv")
        with open(self.rec, "wb") as f:
            f.write(b"\0")  # exists; never decoded here (the hits below belong to it)
        seg = tmg.SegmentTests()
        with open(os.path.join(self.out, "detector-hits.jsonl"), "w", encoding="utf-8") as f:
            for h in seg.hits():
                f.write(json.dumps(h) + "\n")
        self.w("detector-pass.json", {"recording": os.path.basename(self.rec), "game": "codm", "duration": 900.0})
        self.w("match-stats.json", {"recording": os.path.basename(self.rec), **seg.stats()})
        # moments (at - (startBack + endBack) / 2): 25 s (match 1), 355 s (match 2), 815 s (match 3)
        rows = [{"v": 1, "at": at(30), "reason": "streak", "score": 3, "labels": ["TRIPLE KILL"], "startBack": 10, "endBack": 0, "files": []},
                {"v": 1, "at": at(360), "reason": "streak", "score": 3, "labels": ["TRIPLE KILL"], "startBack": 10, "endBack": 0, "files": []},
                {"v": 1, "at": at(820), "reason": "streak", "score": 4, "labels": ["FURY KILL"], "startBack": 10, "endBack": 0, "files": []}]
        with open(os.path.join(self.saves, "saves.jsonl"), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")

    def tearDown(self):
        self.td.cleanup()

    def w(self, name, obj):
        with open(os.path.join(self.out, name), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def r(self, name):
        with open(os.path.join(self.out, name), encoding="utf-8") as f:
            return json.load(f)

    def args(self, *extra):
        a = clipper.build_parser().parse_args(["--data-dir", self.data, "live-review", "--saves", self.saves, "--out", self.out,
                                               "--record-start", START, *extra])
        a.out = os.path.abspath(a.out)
        return a

    def test_matches_of_the_streams_recording(self):
        a = self.args("--recording", self.rec)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            path, why = clipper._live_matches(a)
        self.assertIsNone(why)
        m = self.r("matches.json")
        self.assertEqual(path, os.path.join(self.out, "matches.json"))
        self.assertEqual(m["tool"], "clipper.live-review")
        self.assertEqual([x["passed"] for x in m["matches"]], [True, False, True])
        self.assertEqual(m["matches"][0]["startUtc"], "2026-11-08T13:24:38.000Z")
        self.assertEqual(m["matches"][1]["endUtc"], at(748))
        self.assertEqual(m["recordStartUtc"], START)
        for p in ("OWN_NAME", "PLAYER_A"):
            self.assertNotIn(p, json.dumps(m).upper())

    def test_gate_off_in_settings_runs_nothing(self):
        with open(os.path.join(self.data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"matchGate": {"top3": False, "minKills": None}}}, f)
        path, why = clipper._live_matches(self.args("--recording", self.rec))
        self.assertIsNone(path)
        self.assertIn("match gate off", why)
        self.assertFalse(os.path.exists(os.path.join(self.out, "matches.json")))

    def test_missing_recording_keeps_every_save(self):
        path, why = clipper._live_matches(self.args("--recording", os.path.join(self.td.name, "gone-20261108-132438.mkv")))
        self.assertIsNone(path)
        self.assertIn("not found", why)

    def test_parser_accepts_detect_options(self):
        a = self.args("--recording", self.rec, "--threads", "2", "--game", "codm")
        self.assertEqual((a.threads, a.game, a.recording), (2, "codm", os.path.abspath(self.rec)))
        self.assertIsNone(self.args().recording)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg and ffprobe on PATH")
    def test_live_review_drops_saves_in_skipped_matches(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(clipper.cmd_live_review(self.args("--recording", self.rec, "--encoder", "libopenh264")), 0)
        g = self.r("render.json")["matchGate"]
        self.assertTrue(g["applied"])
        self.assertEqual((g["matches"], g["keptSaves"]), (3, 2))
        self.assertEqual([(d["at"], d["match"]) for d in g["droppedSaves"]], [(at(360), 2)])
        self.assertIn("match gate kept 2 save(s), skipped 1", out.getvalue())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg and ffprobe on PATH")
    def test_without_recording_every_save_is_kept(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(clipper.cmd_live_review(self.args("--encoder", "libopenh264")), 0)
        g = self.r("render.json")["matchGate"]
        self.assertFalse(g["applied"])
        self.assertIn("no recording", g["reason"])
        self.assertFalse(os.path.exists(os.path.join(self.out, "matches.json")))


if __name__ == "__main__":
    unittest.main()
