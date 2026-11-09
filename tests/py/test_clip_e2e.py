# SPDX-License-Identifier: GPL-3.0-or-later
"""End-to-end regression of the post-recording clip pipeline (slow suite; needs ffmpeg and ffprobe on PATH).

One short generated session (lavfi, no corpus, no real chat): an H recording and its V sibling with three audio
tracks (the first carries a loudness spike), a marker row, a tiny fixture chat table and fixture detector hits (two
own kills and a VICTORY). It goes through clipper.py `run --montage --publish` with the run folder inside a
fixture app-data dir, then checks the outputs: convention names, one folder per day with finished videos only, all
audio tracks kept (ffprobe), the upload list, the montage clips and the run folder. Captions need a speech
backend (not offline here), so the captions seam is only checked as off.
Run: python -I -m unittest discover -s tests/py -t tests/py -p test_clip_e2e.py
"""

import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "clip"))
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_common as cc  # noqa: E402
import clip_names as names  # noqa: E402
import clipper  # noqa: E402

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
SECONDS = 14
TRACKS = 3
START_MS = int(datetime(2026, 11, 3, 7, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)


def _write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def _probe(path):
    r = cc.run_tool(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", path],
                    timeout=60)
    return json.loads(r.stdout)["streams"]


def _tone(hz, spike):
    return (f"aevalsrc='sin(2*PI*{hz}*t)*(0.02+0.01*sin(2*PI*0.7*t)+0.6*between(t,{spike},{spike + 1}))'"
            f":s=48000:d={SECONDS}")


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class ClipPipelineE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.TemporaryDirectory(prefix="ujw-e2e-")
        d = cls.td.name
        rec_dir = os.path.join(d, "recordings")
        os.makedirs(rec_dir)
        cls.rec = os.path.join(rec_dir, "rec-h-20261103-070000.mkv")
        argv = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "4",
                "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=30:duration={SECONDS}"]
        for hz, spike in ((440, 8), (660, 30), (880, 30)):
            argv += ["-f", "lavfi", "-i", _tone(hz, spike)]
        argv += ["-map", "0:v"]
        for i in range(1, TRACKS + 1):
            argv += ["-map", f"{i}:a"]
        argv += ["-c:v", "libopenh264", "-b:v", "800k", "-c:a", "aac", "-b:a", "96k", cls.rec]
        r = cc.run_tool(argv, timeout=300)
        if r.returncode != 0:
            raise unittest.SkipTest(f"cannot generate test media: {r.stderr[-200:]}")
        shutil.copyfile(cls.rec, cls.rec.replace("-h-", "-v-"))
        cls.markers = os.path.join(d, "markers.jsonl")
        _write(cls.markers, json.dumps({"v": 1, "at": "2026-11-03T07:00:07.000Z", "source": "hotkey",
                                        "recordMs": 7000, "streamMs": None}) + "\n")
        cls.data = os.path.join(d, "app-data")  # the fixture app data dir
        os.makedirs(cls.data)
        _write(os.path.join(cls.data, cc.LOCAL_FLAGS), json.dumps({"flags": {"clip-pipeline": True}}))
        chat = os.path.join(cls.data, "event-core.db")
        con = sqlite3.connect(chat)
        con.execute("CREATE TABLE chat_raw (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL,"
                    " platform TEXT NOT NULL, display_name TEXT, text TEXT)")
        con.executemany("INSERT INTO chat_raw VALUES (?,?,?,?,?)",
                        [(f"f{i}", START_MS + 7000 + i * 100, "twitch", None, "clip it" if i % 2 else "fixture row")
                         for i in range(12)])
        con.commit()
        con.close()
        cls.run_dir = os.path.join(cls.data, "clips", "runs", "rec-h-20261103-070000")
        cls.clips = os.path.join(d, "My Clips")
        os.makedirs(cls.run_dir)
        _write(os.path.join(cls.run_dir, "detector-hits.jsonl"), "".join(json.dumps(h) + "\n" for h in (
            {"t": 3.0, "detector": "M5", "signal": True}, {"t": 5.0, "detector": "M5", "signal": True},
            {"t": 9.0, "detector": "W1", "label": "VICTORY", "signal": True, "tEnd": 10.0})))
        cls.rc = clipper.main(["--data-dir", cls.data, "run", "--recording", cls.rec, "--markers", cls.markers,
                               "--chat-db", chat, "--record-start", "2026-11-03T07:00:00Z", "--out", cls.run_dir,
                               "--encoder", "libopenh264", "--montage", "--publish", cls.clips])

    @classmethod
    def tearDownClass(cls):
        cls.td.cleanup()

    def day_dir(self):
        days = os.listdir(self.clips)
        self.assertEqual(len(days), 1, days)  # one folder per day
        self.assertRegex(days[0], r"^2026-11-0[23]$")
        return os.path.join(self.clips, days[0])

    def test_run_ok_and_signals(self):
        self.assertEqual(self.rc, 0)
        cand = cc.load_json(os.path.join(self.run_dir, clipper.CANDIDATES))
        self.assertEqual(cand["signals"]["markers"]["matched"], 1)
        self.assertEqual(cand["signals"]["chat"]["rows"], 12)
        self.assertTrue(cand["signals"]["audio"]["available"])
        self.assertGreaterEqual(len(cand["candidates"]), 1)
        kinds = {r["kind"] for r in cand["candidates"][0]["reasons"]}
        self.assertTrue({"marker.hotkey", "audio.loudness"} <= kinds, kinds)

    def test_run_folder_is_in_app_data(self):
        for f in (clipper.CANDIDATES, clipper.RENDER, clipper.REPORT, "published.json"):
            self.assertTrue(os.path.isfile(os.path.join(self.run_dir, f)), f)
        self.assertTrue(os.path.isdir(os.path.join(self.run_dir, "montage")))
        self.assertTrue(os.path.normpath(self.run_dir).startswith(os.path.normpath(self.data) + os.sep))
        self.assertFalse(os.path.normpath(self.run_dir).startswith(os.path.normpath(self.clips)))

    def test_clips_folder_holds_only_finished_videos_one_folder_per_day(self):
        files = sorted(os.listdir(self.day_dir()))
        self.assertGreaterEqual(len(files), 2, files)
        for n in files:
            self.assertRegex(n, names.NAME_RE)
        kinds = {re.match(r"^[a-z0-9]+_([a-z-]+)_", n).group(1) for n in files}
        self.assertEqual(kinds, {"short", "won-reel"})
        for _dp, _dn, fn in os.walk(self.clips):  # nothing but mp4 anywhere under the clips folder
            for n in fn:
                self.assertTrue(n.endswith(".mp4"), n)

    def test_all_audio_tracks_kept(self):
        day = self.day_dir()
        for n in os.listdir(day):
            s = _probe(os.path.join(day, n))
            self.assertEqual(sum(1 for x in s if x["codec_type"] == "audio"), TRACKS, n)
            v = next(x for x in s if x["codec_type"] == "video")
            self.assertEqual((v["width"], v["height"]), (1080, 1920), n)
        for rep_path in (os.path.join(self.run_dir, clipper.REPORT), os.path.join(self.run_dir, "montage", clipper.REPORT)):
            rep = cc.load_json(rep_path)
            self.assertEqual(rep["failed"], 0)
            for r in rep["results"]:
                self.assertEqual((r["audio"]["tracks"], r["audio"]["sourceTracks"]), (TRACKS, TRACKS))
                self.assertTrue(r["decode"]["ok"])

    def test_upload_list_lists_the_published_files(self):
        up = cc.load_json(os.path.join(self.data, "clips", "uploads.json"))
        listed = sorted(os.path.basename(f["file"]) for f in up["files"])
        self.assertEqual(listed, sorted(os.listdir(self.day_dir())))
        for f in up["files"]:
            self.assertEqual(f["run"], "rec-h-20261103-070000")
            self.assertEqual(f["posted"], [])
        self.assertEqual({f["kind"] for f in up["files"]}, {"short", "won-reel"})

    def test_montage_path(self):
        m = os.path.join(self.run_dir, "montage")
        cand = cc.load_json(os.path.join(m, clipper.CANDIDATES))
        self.assertEqual([(c["id"], c["kind"]) for c in cand["candidates"]], [("W01", "won-match")])
        self.assertTrue(os.path.isfile(os.path.join(m, "clips", "W01", "montage-v.mp4")))

    def test_captions_seam_is_off_offline(self):
        rdoc = cc.load_json(os.path.join(self.run_dir, clipper.RENDER))
        self.assertEqual(rdoc["clips"][0]["captions"]["status"], "off")


if __name__ == "__main__":
    unittest.main()
