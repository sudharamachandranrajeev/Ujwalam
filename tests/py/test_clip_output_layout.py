# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 output layout (user 2026-11-08, D298 proposed): naming convention, publish to the clips folder (finished videos
only), the upload list in app data, used replay saves deleted, tidy dry run, validate audio facts."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_names as names  # noqa: E402
import clip_publish as pub  # noqa: E402
import clip_validate as val  # noqa: E402

WHEN = datetime(2026, 11, 8, 18, 58, 9)
LAYOUTS = {"stream-v": {"id": "stream-v", "kind": "canvas", "input": "v"}, "full-crop": {"id": "full-crop", "kind": "crop"}}
WEIGHTS = {"M3:Triple Kill": 3, "M3:Fury Kill": 4, "X1": 5}


def write(p, data=b"x"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb" if isinstance(data, bytes) else "w", **({} if isinstance(data, bytes) else {"encoding": "utf-8"})) as f:
        f.write(data)


def read_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


class NameTests(unittest.TestCase):
    def test_convention(self):
        n = names.clip_name("codm", "montage", WHEN, names.label_for("montage", kills=12), 1, "v")
        self.assertEqual(n, "codm_montage_20261108-185809_kills-12_01_v.mp4")
        self.assertRegex(n, names.NAME_RE)
        self.assertEqual(names.day_folder(WHEN), "2026-11-08")

    def test_short_label_is_the_strongest_medal(self):
        self.assertEqual(names.label_for("short", ["Triple Kill", "Fury Kill", "On a 5 killstreak"], det_weights=WEIGHTS),
                         "fury-kill")
        self.assertEqual(names.label_for("short", [], det_weights=WEIGHTS), "highlight")
        self.assertEqual(names.label_for("won-reel", ["VICTORY", "7 kill(s)"], kills=7), "victory-kills-7")
        self.assertEqual(names.label_for("won-reel", ["DEFEAT", "11 kill(s)"], kills=11), "defeat-kills-11")
        self.assertEqual(names.label_for("won-reel", kills=7), "match-kills-7", "result not read: never claims a win")

    def test_canvas_suffix(self):
        self.assertEqual(names.canvas_suffix(LAYOUTS["stream-v"]), "v")
        self.assertEqual(names.canvas_suffix(LAYOUTS["full-crop"]), "v-full-crop")
        self.assertEqual(names.canvas_suffix({"canvas": "h"}), "h")

    def test_free_name_never_overwrites(self):
        taken = {"a_01.mp4", "a_02.mp4"}
        self.assertEqual(names.free_name(lambda n: n in taken, lambda i: f"a_{i:02d}.mp4", 1), ("a_03.mp4", 3))

    def test_bad_kind(self):
        with self.assertRaises(ValueError):
            names.clip_name("codm", "reel", WHEN, "x", 1, "v")


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ujw-pub-")
        self.data = os.path.join(self.d, "data")
        self.work = os.path.join(self.data, "clips", "runs", "practice-h-20261108-185525")
        self.clips = os.path.join(self.d, "My Clips")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _run(self, report_ok=(True, False)):
        rdoc = {"tool": "clipper", "recording": "practice-h-20261108-185525.mkv", "clips": [
            {"id": "c01", "start": 120.0, "end": 140.0, "labels": ["Triple Kill"],
             "files": [{"layout": "stream-v", "file": "stream-v.mp4"}]},
            {"id": "c02", "start": 300.0, "end": 320.0, "files": [{"layout": "stream-v", "file": "stream-v.mp4"}]}]}
        write(os.path.join(self.work, "render.json"), json.dumps(rdoc))
        write(os.path.join(self.work, "report.json"), json.dumps({"results": [
            {"id": "c01", "file": "stream-v.mp4", "ok": report_ok[0]}, {"id": "c02", "file": "stream-v.mp4", "ok": report_ok[1]}]}))
        for c in ("c01", "c02"):
            write(os.path.join(self.work, "clips", c, "stream-v.mp4"), b"video")
        write(os.path.join(self.work, "candidates.json"), "{}")

    def test_only_passing_videos_reach_the_clips_folder_by_the_convention(self):
        self._run()
        rows = pub.publish(self.work, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)
        self.assertEqual(len(rows), 1)
        day = os.path.join(self.clips, "2026-11-08")
        self.assertEqual(os.listdir(self.clips), ["2026-11-08"], "no run folders, no analysis files")
        self.assertEqual(os.listdir(day), ["codm_short_20261108-185725_triple-kill_01_v.mp4"])
        self.assertTrue(os.path.isfile(os.path.join(self.work, "clips", "c01", "stream-v.mp4")), "run folder keeps its copy")
        up = read_json(os.path.join(self.data, "clips", "uploads.json"))
        self.assertEqual([x["kind"] for x in up["files"]], ["short"])
        self.assertEqual(up["files"][0]["posted"], [])
        self.assertTrue(os.path.isfile(os.path.join(self.work, pub.PUBLISHED)))

    def test_publish_again_adds_nothing_and_never_overwrites(self):
        self._run((True, True))
        pub.publish(self.work, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)
        self.assertEqual(pub.publish(self.work, self.clips, self.data, "codm", LAYOUTS, WEIGHTS), [], "already published")
        day = os.path.join(self.clips, "2026-11-08")
        self.assertEqual(len(os.listdir(day)), 2)
        os.remove(os.path.join(self.work, pub.PUBLISHED))  # a fresh run of the same recording: names never collide
        pub.publish(self.work, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)
        files = os.listdir(day)
        self.assertEqual(len(files), 4)
        self.assertIn("codm_short_20261108-185725_triple-kill_02_v.mp4", files)
        up = read_json(os.path.join(self.data, "clips", "uploads.json"))
        self.assertEqual(len(up["files"]), 4)

    def test_montage_kind_label_and_time(self):
        mont = os.path.join(self.work, "montage")
        rdoc = {"tool": "clipper.montage", "recording": "practice-h-20261108-185525.mkv", "clips": [
            {"id": "M01", "start": 0.0, "end": 36.0, "pieces": [{"start": 400.0, "end": 404.5, "kills": 2},
                                                                {"start": 100.0, "end": 104.5, "kills": 1}],
             "files": [{"layout": "montage-v", "file": "montage-v.mp4"}]},
            {"id": "W01", "start": 0.0, "end": 50.0, "labels": ["VICTORY", "1 kill(s)"],
             "pieces": [{"start": 10.0, "end": 14.5, "kills": 1}],
             "files": [{"layout": "montage-v", "file": "montage-v.mp4"}]}]}
        write(os.path.join(mont, "render.json"), json.dumps(rdoc))
        write(os.path.join(mont, "report.json"), json.dumps({"results": [
            {"id": "M01", "file": "montage-v.mp4", "ok": True}, {"id": "W01", "file": "montage-v.mp4", "ok": True}]}))
        for c in ("M01", "W01"):
            write(os.path.join(mont, "clips", c, "montage-v.mp4"))
        pub.publish(mont, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)
        self.assertEqual(sorted(os.listdir(os.path.join(self.clips, "2026-11-08"))),
                         ["codm_montage_20261108-185705_kills-3_01_v.mp4", "codm_won-reel_20261108-185535_victory-kills-1_01_v.mp4"])

    def test_live_clip_uses_its_wall_time(self):
        ts = WHEN.timestamp()
        rdoc = {"tool": "clipper", "recording": "live-saves", "clips": [
            {"id": "L01", "start": 30.0, "end": 50.0, "wallStart": ts, "labels": ["Triple Kill"], "source": "replay-V-20261108-185835.mkv",
             "files": [{"layout": "stream-v", "file": "stream-v.mp4"}]}]}
        rows = pub.name_rows(rdoc, "codm", LAYOUTS, WEIGHTS)
        self.assertEqual(rows[0][3], WHEN)

    def test_publish_needs_a_report(self):
        self._run()
        os.remove(os.path.join(self.work, "report.json"))
        with self.assertRaises(Exception):
            pub.publish(self.work, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)


class SavesAndTidyTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ujw-tidy-")
        self.rec = os.path.join(self.d, "Recordings")
        self.clips = os.path.join(self.d, "Clips")
        self.data = os.path.join(self.d, "data")
        for n in ("practice-h-20261108-185525.mkv", "practice-v-20261108-185525.mkv", "notes.txt"):
            write(os.path.join(self.rec, n))
        self.used = [os.path.join(self.rec, "replay", f"replay-{c}-20261108-185835.mkv") for c in "HV"]
        self.pending = [os.path.join(self.rec, "replay", f"replay-{c}-20261108-190822.mkv") for c in "HV"]
        self.manual = os.path.join(self.rec, "replay", "replay-H-20261108-191627.mkv")
        for p in self.used + self.pending + [self.manual]:
            write(p)
        saves = [{"at": "2026-11-08T18:58:36.365Z", "startBack": 27.23, "endBack": 3.69, "labels": ["Triple Kill"],
                  "files": [{"canvas": c, "path": p} for c, p in zip("HV", self.used)]},
                 {"at": "2026-11-08T19:08:22.777Z", "startBack": 30.0, "endBack": 10.0,
                  "files": [{"canvas": c, "path": p} for c, p in zip("HV", self.pending)]}]
        write(os.path.join(self.data, "live-clips", "s1", "saves.jsonl"), "\n".join(json.dumps(x) for x in saves) + "\n")
        run = os.path.join(self.clips, "practice-h-20261108-185525")
        write(os.path.join(run, "render.json"), json.dumps({"tool": "clipper", "recording": "live-saves", "clips": [
            {"id": "L01", "start": 32.22, "end": 55.76, "source": "replay-V-20261108-185835.mkv", "labels": ["Triple Kill"],
             "files": [{"layout": "stream-v", "file": "stream-v.mp4"}]}]}))
        write(os.path.join(run, "clips", "L01", "stream-v.mp4"), b"video")
        write(os.path.join(run, "detector-hits.jsonl"), "")
        self.run_dir = run

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_drop_used_saves_touches_host_replay_names_only(self):
        other = os.path.join(self.rec, "practice-h-20261108-185525.mkv")
        gone = pub.drop_used_saves(self.used + [other])
        self.assertEqual(sorted(gone), sorted(self.used))
        self.assertTrue(os.path.isfile(other))

    def test_tidy_dry_run_changes_nothing_and_lists_every_action(self):
        before = sorted(os.path.join(b, f) for b, _d, fs in os.walk(self.d) for f in fs)
        plan = pub.tidy_plan(self.rec, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)
        after = sorted(os.path.join(b, f) for b, _d, fs in os.walk(self.d) for f in fs)
        self.assertEqual(before, after, "the plan is read-only")
        by = {os.path.basename(a["src"]): a for a in plan}
        self.assertEqual(by["stream-v.mp4"]["action"], "rename")
        # the save's wall time in local time (any time zone): date folder and stamp agree
        self.assertEqual(os.path.dirname(os.path.dirname(by["stream-v.mp4"]["dst"])), self.clips)
        day = os.path.basename(os.path.dirname(by["stream-v.mp4"]["dst"]))
        self.assertRegex(day, r"^2026-11-0[89]$")
        self.assertRegex(os.path.basename(by["stream-v.mp4"]["dst"]),
                         "^codm_short_" + day.replace("-", "") + r"-\d{6}_triple-kill_01_v\.mp4$")
        self.assertEqual(by["detector-hits.jsonl"]["action"], "move")
        self.assertTrue(by["render.json"]["dst"].startswith(os.path.join(self.data, "clips", "runs")))
        for p in self.used:
            self.assertEqual(by[os.path.basename(p)]["action"], "delete")
        for p in self.pending + [self.manual]:
            self.assertEqual(by[os.path.basename(p)]["action"], "keep")
        self.assertEqual(by["practice-h-20261108-185525.mkv"]["action"], "keep")
        self.assertEqual(by["notes.txt"]["action"], "leave")

    def test_tidy_apply(self):
        plan = pub.tidy_plan(self.rec, self.clips, self.data, "codm", LAYOUTS, WEIGHTS)
        r = pub.apply_plan(plan, self.clips)
        self.assertEqual(r["skipped"], [])
        left = os.listdir(self.clips)
        self.assertEqual(len(left), 1, "run folder emptied and removed")
        self.assertRegex(left[0], r"^2026-11-0[89]$")
        for p in self.used:
            self.assertFalse(os.path.exists(p))
        for p in self.pending + [self.manual]:
            self.assertTrue(os.path.exists(p))
        self.assertTrue(os.path.isfile(os.path.join(self.data, "clips", "runs", "practice-h-20261108-185525", "render.json")))


class ValidateAudioTests(unittest.TestCase):
    INFO = {"duration": 20.0, "width": 1080, "height": 1920, "fps": 60.0, "vcodec": "h264", "pix_fmt": "yuv420p",
            "acodec": "aac", "has_audio": True, "size": 1000, "audio_tracks": 1}

    def test_dropped_track_fails(self):
        r = val.check_file(self.INFO, 20.0, {"width": 1080, "height": 1920}, {"targets": []}, source_tracks=2)
        self.assertFalse(r["ok"])
        self.assertIn("1 audio track(s) (source has 2)", r["issues"])
        self.assertTrue(val.check_file({**self.INFO, "audio_tracks": 2}, 20.0, {"width": 1080, "height": 1920},
                                       {"targets": []}, source_tracks=2)["ok"])

    def test_loudness_summary(self):
        text = ("[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -19.4 LUFS\n"
                "    Threshold: -29.6 LUFS\n\n  True peak:\n    Peak:       -1.3 dBFS\n")
        self.assertEqual(val.parse_loudness_summary(text), (-19.4, -1.3))
        self.assertEqual(val.parse_loudness_summary("Integrated loudness:\n I: -inf LUFS"), (None, None))


if __name__ == "__main__":
    unittest.main()
