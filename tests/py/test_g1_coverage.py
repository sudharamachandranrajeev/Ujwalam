# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests for the W1 capture coverage tracker (services/clip/coverage.py).

Stdlib parts (run under the system Python, npm run test:py, and in the OCR venv, npm run
test:ocr): capture-plan matching on synthetic OCR boxes through the real CODM pack and plan,
the state file (status, mark, candidates), and when a record.py segment counts as final.
OCR parts (npm run test:ocr only): an end-to-end `watch` and `files` run on short videos made
from synthetic frames (text drawn with OpenCV; invented names), OCR'd by RapidOCR.
No real footage, names or labels.
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")
PACK = os.path.normpath(os.path.join(_HERE, "..", "..", "data", "games", "codm"))
sys.path.insert(0, _CLIP)
import coverage as cov  # noqa: E402
import game_pack  # noqa: E402

NAMES = ["Zorbo~QX", "Zorbo-QX", "Zorbo"]  # invented


def _have(mod):
    return importlib.util.find_spec(mod) is not None


HAVE_OCR = all(_have(m) for m in ("numpy", "cv2", "rapidocr"))


def box(text, x0, y0, x1, y1, score=0.95):
    return {"text": text, "score": score, "g": [x0, y0, x1, y1]}


MP_HUD = box("POINTS TO WIN", 0.02, 0.60, 0.20, 0.63)
BR_HUD = box("SAFE ZONE", 0.02, 0.60, 0.15, 0.63)


class MatcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pack = game_pack.load_pack(PACK)
        cls.plan = cov.load_plan(PACK)
        cls.m = cov.Matcher(cls.pack, cls.plan, NAMES, 0.8)

    def items(self, boxes):
        mode, hits = self.m.frame([dict(b) for b in boxes])
        return mode, sorted(h[0]["id"] for h in hits)

    def test_rare_medal_in_banner_on_mp_frame(self):
        mode, ids = self.items([MP_HUD, box("Relentless", 0.44, 0.15, 0.56, 0.19)])
        self.assertEqual(mode, "mp")
        self.assertEqual(ids, ["medal_relentless"])
        _m, ids = self.items([MP_HUD, box("Ultimate Terminator", 0.60, 0.40, 0.80, 0.43)])  # text stack
        self.assertEqual(ids, ["medal_ultimate_terminator"])

    def test_medal_text_outside_rois_or_on_br_frame_is_not_coverage(self):
        # A5c misfires: a map label in the text-stack band on a BR frame; a kill line low on the screen
        self.assertEqual(self.items([BR_HUD, box("Nuclear Plant", 0.63, 0.38, 0.71, 0.40)])[1], [])
        self.assertEqual(self.items([MP_HUD, box("NUCLEAR KILL", 0.45, 0.64, 0.53, 0.66)])[1], [])
        self.assertEqual(self.items([box("Brutal", 0.44, 0.15, 0.56, 0.19)])[1], [])  # unclassified frame

    def test_br_multikill_banner_needs_name_in_banner(self):
        banner = box("3X MULTI-KILL", 0.52, 0.08, 0.61, 0.11)
        self.assertEqual(self.items([BR_HUD, banner, box("Zorbo~QX", 0.40, 0.08, 0.50, 0.11)])[1],
                         ["br_multikill_banner"])
        self.assertEqual(self.items([BR_HUD, banner, box("Someone Else", 0.40, 0.08, 0.50, 0.11)])[1], [])
        # the name elsewhere on the frame (squad list) does not count
        self.assertEqual(self.items([BR_HUD, banner, box("Zorbo~QX", 0.02, 0.20, 0.10, 0.22)])[1], [])
        # same banner on an MP frame: not this item
        self.assertEqual(self.items([MP_HUD, banner, box("Zorbo~QX", 0.40, 0.08, 0.50, 0.11)])[1], [])

    def test_final_killcam_is_a_candidate_either_way(self):
        label = box("FINAL KILLCAM", 0.46, 0.06, 0.55, 0.09)
        _m, ids = self.items([label, box("Zorbo~QX", 0.40, 0.12, 0.50, 0.15)])
        self.assertEqual(ids, ["final_killcam_ign"])
        _m, ids = self.items([label, box("Someone Else", 0.40, 0.12, 0.50, 0.15)])
        self.assertEqual(ids, ["final_killcam_other"])
        for iid in ("final_killcam_ign", "final_killcam_other"):
            self.assertEqual(next(i for i in self.plan["items"] if i["id"] == iid)["match"]["confirm"], "manual")

    def test_revival_waiting_line_only(self):
        _m, ids = self.items([BR_HUD, box("Waiting for Revival Flight.", 0.42, 0.09, 0.58, 0.12)])
        self.assertEqual(ids, ["br_revival"])
        self.assertEqual(self.items([BR_HUD, box("HELP ME", 0.85, 0.70, 0.91, 0.74)])[1], [])

    def test_scoreboard_candidates_on_mp_frames_in_the_band(self):
        self.assertEqual(self.items([MP_HUD, box("MVP", 0.10, 0.64, 0.14, 0.66)])[1], ["mp_final_scoreboard"])
        self.assertEqual(self.items([BR_HUD, box("MVP", 0.10, 0.78, 0.14, 0.80)])[1], [])  # BR squad cards
        self.assertEqual(self.items([MP_HUD, box("MVP", 0.10, 0.30, 0.14, 0.33)])[1], [])  # Like toast band

    def test_br_win_has_no_criteria(self):
        bw = next(i for i in self.plan["items"] if i["id"] == "br_win")
        self.assertEqual(bw["match"]["confirm"], "manual")
        self.assertNotIn("when", bw["match"])


class StateTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-cov-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.state = os.path.join(self.dir, "coverage.json")
        self.plan = cov.load_plan(PACK)

    def run_main(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cov.main(list(args))
        return buf.getvalue()

    def status(self):
        return json.loads(self.run_main("status", "--pack", PACK, "--state", self.state, "--json"))

    def test_status_without_state_lists_everything_missing(self):
        s = self.status()
        self.assertEqual(s["missing"], [i["id"] for i in self.plan["items"]])
        self.assertFalse(os.path.exists(self.state))

    def test_mark_and_clear(self):
        out = self.run_main("mark", "--pack", PACK, "--state", self.state, "br_win", "--segment",
                            os.path.join(self.dir, "x-003.mp4"), "--t", "41.5", "--note", "placement #1")
        self.assertIn("marked: br_win", out)
        self.assertNotIn("br_win", out.split("still missing:")[1])
        s = self.status()
        row = next(r for r in s["items"] if r["id"] == "br_win")
        self.assertEqual((row["status"], row["by"], row["evidence"]), ("captured", "mark", "x-003.mp4@41.5"))
        self.run_main("mark", "--pack", PACK, "--state", self.state, "br_win", "--clear")
        self.assertIn("br_win", self.status()["missing"])
        with self.assertRaises(SystemExit):
            self.run_main("mark", "--pack", PACK, "--state", self.state, "no_such_item")

    def test_tracker_captures_auto_once_and_counts_candidates(self):
        class A:
            name_min = 0.8
            state = self.state
            layout = None
        pack = game_pack.load_pack(PACK)
        lines = []
        tr = cov.Tracker(A(), pack, self.plan, NAMES, out=lines.append)
        seg = os.path.join(self.dir, "rec-000.mp4")
        pend = tr._pending()
        medal = [MP_HUD, box("Brutal", 0.44, 0.15, 0.56, 0.19)]
        wait = [BR_HUD, box("Waiting for Revival Flight", 0.42, 0.09, 0.58, 0.12)]
        for t in (3.0, 4.0):
            tr.on_frame([dict(b) for b in medal], seg, t, None, None, None, pend)
        # 8 matching frames: 10-12 s are one screen (one kept candidate); 50..210 s are 40 s apart
        for t in (10, 11, 12, 50, 90, 130, 170, 210):
            tr.on_frame([dict(b) for b in wait], seg, float(t), None, None, None, pend)
        st = tr.commit(seg, pend, {"framesOcr": 9})
        self.assertEqual(lines[0], "captured: medal_brutal at rec-000.mp4@3.0")
        self.assertEqual(sum(1 for x in lines if x.startswith("captured:")), 1)
        self.assertEqual(sum(1 for x in lines if x.startswith("candidate: br_revival")), 1)  # once per segment
        e = st["items"]["medal_brutal"]
        self.assertEqual((e["status"], e["evidence"]["t"], e["evidence"]["by"]), ("captured", 3.0, "tracker"))
        r = st["items"]["br_revival"]
        self.assertEqual((r["status"], r["candidateCount"], len(r["candidates"])), ("missing", 8, cov.MAX_CANDIDATES))
        self.assertEqual([c["t"] for c in r["candidates"]], [10.0, 50.0, 90.0, 130.0, 170.0])
        self.assertFalse(tr._keep_candidate("br_revival", seg, 400.0))  # MAX_CANDIDATES reached
        self.assertIn(os.path.abspath(seg), st["processed"])
        # the user confirms candidate 2; the tracker then stops adding candidates for it
        self.run_main("mark", "--pack", PACK, "--state", self.state, "br_revival", "--candidate", "2")
        with open(self.state, encoding="utf-8") as f:
            s = json.load(f)
        self.assertEqual(s["items"]["br_revival"]["evidence"]["t"], 50.0)
        self.assertEqual(s["items"]["br_revival"]["status"], "captured")
        self.assertIn("still missing: final_killcam_ign", cov.missing_line(s, self.plan))
        self.assertNotIn("br_revival", cov.missing_line(s, self.plan))

    def test_state_inside_repo_must_be_gitignored(self):
        bad = os.path.join(_HERE, "coverage-test-not-ignored", "coverage.json")
        with self.assertRaises(SystemExit):
            self.run_main("mark", "--pack", PACK, "--state", bad, "br_win")
        self.assertFalse(os.path.exists(os.path.dirname(bad)))


class FinalSegmentTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-watch-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        for i in range(3):
            open(os.path.join(self.dir, f"rec-{i:03d}.mp4"), "wb").close()

    def state(self, **kw):
        st = {"state": "recording", "pid": os.getpid(), "ffmpegPid": None}
        st.update(kw)
        with open(os.path.join(self.dir, "rec.state.json"), "w", encoding="utf-8") as f:
            json.dump(st, f)

    def finals(self):
        f, segs, ended, why = cov.final_segments(self.dir, "rec")
        return [os.path.basename(x) for x in f], ended, why

    def test_newest_segment_waits_while_recording(self):
        self.assertEqual(self.finals()[:2], (["rec-000.mp4", "rec-001.mp4"], False))  # no state yet
        self.state()
        self.assertEqual(self.finals()[:2], (["rec-000.mp4", "rec-001.mp4"], False))

    def test_stop_file_waits_for_recorder_to_finish(self):
        self.state()
        open(os.path.join(self.dir, "STOP"), "w").close()
        f, ended, why = self.finals()
        self.assertEqual((len(f), ended, why), (2, False, "stopping"))
        self.state(state="stopped", ffmpegExit=0)
        self.assertEqual(self.finals()[1], True)

    def test_clean_stop_failure_and_kill_finalise_the_last_segment(self):
        for kw in ({"state": "stopped"}, {"state": "ffmpeg_failed"}, {"pid": 0, "ffmpegPid": 0},
                   {"state": "failed", "failReason": "restart limit reached"}):
            self.state(**kw)
            f, ended, _why = self.finals()
            self.assertEqual((len(f), ended), (3, True), kw)

    def test_restart_continues_numbering_and_finalises_the_crashed_segment(self):
        # record.py restarting after a crash: its own pid is alive, the old ffmpeg is gone
        self.state(state="restarting", ffmpegPid=0, segmentStart=3)
        f, ended, _why = self.finals()
        self.assertEqual((f, ended), (["rec-000.mp4", "rec-001.mp4"], False))  # rec-002 may still be newest
        open(os.path.join(self.dir, "rec-003.mp4"), "wb").close()  # the restarted ffmpeg's first segment
        f, ended, _why = self.finals()
        self.assertEqual((f, ended), (["rec-000.mp4", "rec-001.mp4", "rec-002.mp4"], False))

    def test_segment_order_is_numeric(self):
        for i in (999, 1000):
            open(os.path.join(self.dir, f"rec-{i:03d}.mp4"), "wb").close()
        open(os.path.join(self.dir, "rec-x.mp4"), "wb").close()  # not a segment
        names = [os.path.basename(p) for p in cov.segment_files(self.dir, "rec")]
        self.assertEqual(names[-2:], ["rec-999.mp4", "rec-1000.mp4"])
        self.assertNotIn("rec-x.mp4", names)

    def test_gaps_file_is_read_and_printed(self):
        self.assertEqual(cov.read_gaps(self.dir, "rec"), [])
        g = {"gap": 1, "reason": "ffmpeg exited 1 unexpectedly", "exitCode": 1, "startUtc": "2026-10-28T10:00:00.000Z",
             "endUtc": "2026-10-28T10:00:02.500Z", "startS": 12.0, "endS": 14.5, "durationS": 2.5,
             "afterSegment": "rec-002.mp4", "beforeSegment": "rec-003.mp4"}
        with open(os.path.join(self.dir, "rec.gaps.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps(g) + "\n" + '{"gap": 2, "rea')  # a torn last line is skipped
        self.assertEqual(cov.read_gaps(self.dir, "rec"), [g])
        line = cov.gap_line(g)
        self.assertIn("2.5 s", line)
        self.assertIn("after rec-002.mp4, before rec-003.mp4", line)

    def test_stop_without_state_file_settles_on_mtime(self):
        open(os.path.join(self.dir, "STOP"), "w").close()
        self.assertFalse(self.finals()[1])
        old = time.time() - cov.STOP_SETTLE_S - 1
        os.utime(os.path.join(self.dir, "rec-002.mp4"), (old, old))
        self.assertEqual(self.finals()[:2], (["rec-000.mp4", "rec-001.mp4", "rec-002.mp4"], True))


@unittest.skipUnless(HAVE_OCR and shutil.which("ffmpeg"), "OCR venv and ffmpeg needed (npm run test:ocr)")
class EndToEndOcrTests(unittest.TestCase):
    """Real decode + OCR + matching on short synthetic videos (no footage)."""

    @classmethod
    def setUpClass(cls):
        import cv2
        import numpy as np
        cls.dir = tempfile.mkdtemp(prefix="ujw-cov-e2e-")
        cls.rec = os.path.join(cls.dir, "rec")
        os.makedirs(cls.rec)
        w, h = 1280, 720

        def frame(lines):
            img = np.full((h, w, 3), (30, 30, 30), np.uint8)
            for text, x, y, scale in lines:
                cv2.putText(img, text, (int(x * w), int(y * h)), cv2.FONT_HERSHEY_SIMPLEX, scale,
                            (255, 255, 255), 3, cv2.LINE_AA)
            return img

        hud = ("POINTS TO WIN", 0.03, 0.62, 1.2)
        segs = [[hud, ("Relentless", 0.43, 0.18, 1.6)],  # medal in the M3 banner ROI on an MP frame
                [hud, ("UAV ONLINE", 0.03, 0.80, 1.2)]]   # nothing from the plan
        for i, lines in enumerate(segs):
            png = os.path.join(cls.dir, f"f{i}.png")
            cv2.imwrite(png, frame(lines))
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", "10", "-i", png, "-t", "3",
                            "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p",
                            os.path.join(cls.rec, f"rec-{i:03d}.mp4")], check=True)
        cls.profile = os.path.join(cls.dir, "profile.json")
        with open(cls.profile, "w", encoding="utf-8") as f:
            json.dump({"games": {"codm": {"ign": "Zorbo~QX", "variants": ["Zorbo-QX"], "clan_tag": None}}}, f)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def run_main(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cov.main(list(args))
        return buf.getvalue()

    def check_state(self, state, out, seg):
        self.assertIn(f"captured: medal_relentless at {seg}@", out)
        with open(state, encoding="utf-8") as f:
            s = json.load(f)
        e = s["items"]["medal_relentless"]
        self.assertEqual(e["status"], "captured")
        self.assertEqual(e["evidence"]["segmentName"], seg)
        self.assertTrue(os.path.isfile(e["evidence"]["crop"]))
        self.assertTrue(os.path.isfile(e["evidence"]["frame"]))
        self.assertEqual(len(s["processed"]), 2)
        others = [k for k, v in s["items"].items() if v["status"] == "captured" and k != "medal_relentless"]
        self.assertEqual(others, [])
        scans = os.listdir(os.path.join(os.path.dirname(state), "coverage-scans"))
        self.assertEqual(len(scans), 1)

    def test_watch_processes_final_segments_and_exits_when_recorder_stopped(self):
        state = os.path.join(self.dir, "w", "coverage.json")
        with open(os.path.join(self.rec, "rec.state.json"), "w", encoding="utf-8") as f:
            json.dump({"state": "stopped", "pid": 0, "ffmpegPid": 0, "ffmpegExit": 0}, f)
        try:
            out = self.run_main("--threads", "2", "watch", "--pack", PACK, "--state", state, "--profile",
                                self.profile, "--dir", self.rec, "--name", "rec", "--poll", "0.2")
        finally:
            os.unlink(os.path.join(self.rec, "rec.state.json"))
        self.check_state(state, out, "rec-000.mp4")
        self.assertIn("recorder ended (recorder stopped); all 2 segment(s) processed", out)
        self.assertIn("still missing: final_killcam_ign", out)

    def test_files_on_existing_recordings(self):
        state = os.path.join(self.dir, "f", "coverage.json")
        out = self.run_main("--threads", "2", "files", "--pack", PACK, "--state", state, "--profile",
                            self.profile, self.rec)
        self.check_state(state, out, "rec-000.mp4")
        again = self.run_main("--threads", "2", "files", "--pack", PACK, "--state", state, "--profile",
                              self.profile, self.rec)
        self.assertIn("skip rec-000.mp4: already processed", again)


if __name__ == "__main__":
    unittest.main()
