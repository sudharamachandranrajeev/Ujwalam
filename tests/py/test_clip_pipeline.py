# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit and plumbing tests for the F6 post-stream clipper (services/clip/clipper.py and clip_*.py).

Plumbing only: generated inputs (lavfi media, fixture marker rows, a fixture chat table), never corpus files,
real chat or labels. Nothing here measures clip quality. The end-to-end case needs ffmpeg and ffprobe on PATH
and is skipped without them; it writes only to a temp folder outside the repository.
Run: python -I -m unittest discover -s tests/py -t tests/py
"""

import json
import os
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

import clip_captions as caps  # noqa: E402
import clip_common as cc  # noqa: E402
import clip_rank as rank  # noqa: E402
import clip_render as rnd  # noqa: E402
import clip_signals as sig  # noqa: E402
import clip_validate as val  # noqa: E402
import clipper  # noqa: E402

RANKING = cc.load_config("ranking")
TARGETS = cc.load_config("targets")
LAYOUTS = cc.load_config("layouts")
UTC0 = datetime(2026, 11, 3, 7, 0, 0, tzinfo=timezone.utc)
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


class FlagTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = self.td.name
        self.defs = os.path.join(self.d, "flags.json")
        _write(self.defs, json.dumps({"flags": [
            {"id": "clip-pipeline", "description": "x", "default": False, "since": "2026-11-04"},
            {"id": "on-default", "description": "x", "default": True, "since": "2026-11-04"}]}))

    def tearDown(self):
        self.td.cleanup()

    def test_default_off_without_local_file(self):
        self.assertFalse(cc.flag_on(self.d, "clip-pipeline", self.defs))
        self.assertTrue(cc.flag_on(self.d, "on-default", self.defs))
        self.assertFalse(cc.flag_on(None, "clip-pipeline", self.defs))

    def test_local_override_and_rules(self):
        _write(os.path.join(self.d, cc.LOCAL_FLAGS), json.dumps({"flags": {"clip-pipeline": True, "on-default": "no",
                                                                           "unknown": True}}))
        self.assertTrue(cc.flag_on(self.d, "clip-pipeline", self.defs))
        self.assertTrue(cc.flag_on(self.d, "on-default", self.defs))  # non-boolean ignored
        self.assertFalse(cc.flag_on(self.d, "unknown", self.defs))   # not defined: off

    def test_bad_local_file_falls_back(self):
        _write(os.path.join(self.d, cc.LOCAL_FLAGS), "{not json")
        self.assertFalse(cc.flag_on(self.d, "clip-pipeline", self.defs))

    def test_committed_default_is_off(self):
        self.assertFalse(cc.flag_definitions()["clip-pipeline"])


class SafetyTests(unittest.TestCase):
    def test_out_dir_rules(self):
        with self.assertRaises(cc.ClipError):
            cc.check_out_dir(os.path.join(cc.REPO_ROOT, "services", "clip", "x"))
        cc.check_out_dir(os.path.join(cc.REPO_ROOT, "out", "clips-test"))  # gitignored
        with tempfile.TemporaryDirectory() as td:
            cc.check_out_dir(os.path.join(td, "o"))
            with self.assertRaises(cc.ClipError):
                cc.check_out_dir(os.path.join(td, "o"), corpus=td)


class SignalTests(unittest.TestCase):
    def test_recording_start(self):
        self.assertEqual(sig.recording_start("x.mkv", "2026-11-03T07:00:00Z"), UTC0)
        with self.assertRaises(cc.ClipError):
            sig.recording_start("x.mkv", "2026-11-03T07:00:00")  # no zone
        with self.assertRaises(cc.ClipError):
            sig.recording_start("nostamp.mkv")
        got = sig.recording_start(os.path.join("d", "rec-h-20261103-070000.mkv"))
        want = datetime(2026, 11, 3, 7, 0, 0).astimezone().astimezone(timezone.utc)
        self.assertEqual(got, want)

    def test_markers_match_this_recording_only(self):
        rows = [
            {"v": 1, "at": "2026-11-03T07:00:20.000Z", "source": "hotkey", "recordMs": 20000, "note": "private"},
            {"v": 1, "at": "2026-11-03T07:00:41.500Z", "source": "chat", "recordMs": 40000},  # 1.5 s start lag: ok
            {"v": 1, "at": "2026-11-03T06:00:05.000Z", "source": "hotkey", "recordMs": 5000},
            {"v": 1, "at": "2026-11-03T07:00:30.000Z", "source": "api", "recordMs": None},
            {"v": 1, "at": "2026-11-03T07:10:00.000Z", "source": "hotkey", "recordMs": 600000},
            {"v": 1, "at": "2026-11-03T07:00:30.000Z", "source": "weird", "recordMs": 1},
        ]
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "m.jsonl")
            _write(p, "\n".join(json.dumps(r) for r in rows) + "\nnot json\n")
            out, st = sig.read_markers([p], UTC0, 120.0)
        self.assertEqual(out, [{"t": 20.0, "source": "hotkey"}, {"t": 40.0, "source": "chat"}])
        self.assertEqual(st, {"rows": 7, "matched": 2, "noRecord": 1, "otherRecording": 1, "outOfRange": 1, "bad": 2})
        self.assertNotIn("private", json.dumps(out))

    def test_chat_counts_read_only(self):
        start_ms = int(UTC0.timestamp() * 1000)
        with tempfile.TemporaryDirectory() as td:
            db = os.path.join(td, "event-core.db")
            con = sqlite3.connect(db)
            con.execute("CREATE TABLE chat_raw (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL,"
                        " platform TEXT NOT NULL, display_name TEXT, text TEXT)")
            rows = [("a", start_ms + 1500, "twitch", None, "fixture row"),
                    ("b", start_ms + 1900, "youtube", None, "clip it"),
                    ("c", start_ms + 9000, "twitch", None, None),
                    ("d", start_ms - 5000, "twitch", None, "clip it"),        # before the recording
                    ("e", start_ms + 30000, "twitch", None, "clip that")]     # after the end
            con.executemany("INSERT INTO chat_raw VALUES (?,?,?,?,?)", rows)
            con.commit()
            con.close()
            counts, intents, st = sig.read_chat(db, UTC0, 10.0, RANKING["chat"]["intentPattern"])
            con = sqlite3.connect(db)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM chat_raw").fetchone()[0], 5)
            con.close()
        self.assertEqual(counts, [0, 2, 0, 0, 0, 0, 0, 0, 0, 1])
        self.assertEqual(intents, [0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
        self.assertEqual(st["rows"], 3)
        self.assertNotIn("fixture", json.dumps(st))

    def test_intent_pattern(self):
        import re
        rx = re.compile(RANKING["chat"]["intentPattern"], re.IGNORECASE)
        for s in ("clip it", "CLIP THAT!!", "lol clip this", "!clip", "ok !clip now"):
            self.assertTrue(rx.search(s), s)
        for s in ("eclipse it", "clipping", "clip", "paperclip it"):
            self.assertFalse(rx.search(s), s)

    def test_parse_ebur128(self):
        text = ("[Parsed_ebur128_0 @ 0] t: 0.1  TARGET:-23 LUFS    M:-120.7 S:-inf     I: -70.0 LUFS\n"
                "[Parsed_ebur128_0 @ 0] t: 0.999979  TARGET:-23 LUFS    M: -30.0 S: -31.5     I: -31.0 LUFS\n"
                "[Parsed_ebur128_0 @ 0] t: 1.099979  TARGET:-23 LUFS    M: -12.0 S: -20.0     I: -30.0 LUFS\n"
                "[Parsed_ebur128_0 @ 0] t: 1.499979  TARGET:-23 LUFS    M: -12.0 S: -18.0     I: -30.0 LUFS\n"
                "  Summary:\n    I:         -30.0 LUFS\n")
        lufs, seen = sig.parse_ebur128(text, 3.0, -70.0)
        self.assertEqual(seen, 3)
        self.assertEqual(lufs, [-31.5, -18.0, -70.0])

    def test_hits_seam(self):
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "h.jsonl")
            _write(p, '{"t": 5, "detector": "M3", "label": "Double Kill"}\n{"t": 500, "detector": "M3"}\n{"x":1}\n')
            hits, st = sig.read_hits(p, 100.0)
        self.assertEqual(hits, [{"t": 5.0, "detector": "M3", "label": "Double Kill"}])
        self.assertEqual(st, {"hits": 1, "bad": 1})


class RankTests(unittest.TestCase):
    def test_loudness_events(self):
        lufs = [-40.0] * 100
        lufs[50] = -15.0
        lufs[52] = -16.0   # suppressed: within minGapSec of the stronger peak
        lufs[90] = -20.0
        lufs[5] = -70.0    # silence ignored
        ev, base = rank.loudness_events(lufs, RANKING["audio"], RANKING["weights"], 30)
        self.assertEqual([e["t"] for e in ev], [50.5, 90.5])
        self.assertEqual(base["median"], -40.0)
        self.assertEqual(base["spread"], 1.0)
        self.assertEqual(ev[0]["strength"], 1.0)

    def test_loudness_needs_voiced_audio(self):
        ev, base = rank.loudness_events([-70.0] * 50, RANKING["audio"], RANKING["weights"], 30)
        self.assertEqual(ev, [])
        self.assertEqual(base["voicedSec"], 0)

    def test_chat_events(self):
        counts = [0] * 120
        intents = [0] * 120
        for i in range(60, 66):
            counts[i] = 2
        intents[100] = 1
        counts[100] = 1
        cfg = {**RANKING["chat"], "minGapSec": 30}
        ev = rank.chat_events(counts, intents, cfg, RANKING["weights"])
        kinds = sorted((e["kind"], e["t"]) for e in ev)
        self.assertIn(("chat.intent", 100.5), kinds)
        vel = [e for e in ev if e["kind"] == "chat.velocity"]
        self.assertEqual(len(vel), 1)
        self.assertTrue(65 <= vel[0]["t"] <= 80)
        self.assertEqual(rank.chat_events(None, None, cfg, RANKING["weights"]), [])

    def test_candidates_merge_backdate_and_rank(self):
        w = RANKING["weights"]
        ev = rank.marker_events([{"t": 100.0, "source": "hotkey"}], w)
        ev += [{"t": 105.0, "kind": "audio.loudness", "w": w["audio.loudness"], "strength": 0.5, "detail": {},
                "win": "audio"},
               {"t": 300.0, "kind": "audio.loudness", "w": w["audio.loudness"], "strength": 1.0, "detail": {},
                "win": "audio"},
               {"t": 400.0, "kind": "audio.loudness", "w": w["audio.loudness"], "strength": 0.2, "detail": {},
                "win": "audio"}]
        c = rank.build_candidates(ev, 1000.0, {**RANKING, "top": 2, "minScore": 0})
        self.assertEqual([x["id"] for x in c], ["c01", "c02"])
        self.assertEqual((c[0]["start"], c[0]["end"]), (70.0, 115.0))  # marker 30 s back, audio 10 s after
        self.assertAlmostEqual(c[0]["score"], 1.0 + 0.4 * 0.5)
        self.assertEqual(c[1]["anchor"], 300.0)
        self.assertEqual(len(c), 2)

    def test_chain_does_not_exceed_max(self):
        w = RANKING["weights"]
        ev = [{"t": float(t), "kind": "audio.loudness", "w": w["audio.loudness"], "strength": 1.0, "detail": {},
               "win": "audio"} for t in (30, 55, 80, 105, 130)]
        c = rank.build_candidates(ev, 1000.0, {**RANKING, "minScore": 0})
        for x in c:
            self.assertLessEqual(x["end"] - x["start"], RANKING["clip"]["maxSec"] + 1e-6)
            self.assertGreaterEqual(x["end"] - x["start"], RANKING["clip"]["minSec"] - 1e-6)
        self.assertGreaterEqual(len(c), 2)

    def test_short_window_grows_and_stays_in_file(self):
        ev = rank.marker_events([{"t": 2.0, "source": "hotkey"}], RANKING["weights"])
        c = rank.build_candidates(ev, 8.0, RANKING)
        self.assertEqual((c[0]["start"], c[0]["end"]), (0.0, 8.0))

    def test_kill_chain_sums_and_streaks_only(self):
        hits = [{"t": t, "detector": "M3", "label": l, "signal": True, "role": "positive"}
                for t, l in ((100.0, "Double Kill"), (103.0, "Triple Kill"), (106.0, "Fury Kill"), (400.0, "Double Kill"))]
        ev = rank.detector_events(hits, RANKING["detectorWeights"], RANKING["detectorWeightsStatus"] == "approved")
        c = rank.build_candidates(ev, 1000.0, RANKING)
        self.assertEqual(len(c), 1, "a lone Double Kill makes no clip")
        self.assertAlmostEqual(c[0]["score"], 3 + 4)
        self.assertLessEqual(c[0]["start"], 100.0)

    def test_death_ends_clip_before_killcam(self):
        hits = [{"t": 100.0, "detector": "M3", "label": "Triple Kill", "signal": True},
                {"t": 104.0, "tEnd": 109.0, "detector": "N1", "label": "KILLCAM", "role": "negative"},
                {"t": 80.0, "tEnd": 84.0, "detector": "N1", "label": "KILLCAM", "role": "negative"}]
        ev = rank.detector_events(hits, RANKING["detectorWeights"], True)
        cfg = {**RANKING, "clip": {"minSec": 10, "maxSec": 60}}
        c = rank.build_candidates(ev, 1000.0, cfg, rank.death_spans(hits, cfg))
        self.assertEqual((c[0]["start"], c[0]["end"]), (85.0, 102.0))
        short = rank.build_candidates(ev, 1000.0, {**cfg, "clip": {"minSec": 20, "maxSec": 60}},
                                      rank.death_spans(hits, cfg))
        self.assertEqual(short, [], "too short after the cut: dropped")

    def test_marker_clip_kept_below_min_score(self):
        ev = rank.marker_events([{"t": 50.0, "source": "hotkey"}], RANKING["weights"])
        self.assertEqual(len(rank.build_candidates(ev, 1000.0, RANKING)), 1)

    def test_detector_weight_null_is_zero(self):
        ev = rank.detector_events([{"t": 10.0, "detector": "M3", "label": "x"}], {})
        self.assertEqual(ev[0]["w"], 0.0)
        self.assertFalse(ev[0]["detail"]["weightApproved"])

    def test_ranking_status_is_proposed(self):
        self.assertEqual(RANKING["status"], "proposed")
        # User approved the values as proposals only (2026-11-03): status stays "proposed" until tuned.
        self.assertIn("proposals only", RANKING["approvedBy"])


class CaptionTests(unittest.TestCase):
    def test_safe_area_is_intersection(self):
        s = caps.safe_area(TARGETS)
        for t in TARGETS["targets"]:
            for k, v in t["safe"].items():
                self.assertGreaterEqual(s[k], v)

    def test_wrap_and_escape(self):
        chunks = caps.wrap("one two three four five six seven eight nine ten eleven twelve thirteen")
        self.assertTrue(all(len(c) <= caps.MAX_LINES for c in chunks))
        self.assertTrue(all(len(line) <= caps.MAX_CHARS_PER_LINE for c in chunks for line in c))
        self.assertNotIn("{", caps.ass_escape(r"{\an8}hi"))
        self.assertNotIn("\\", caps.ass_escape(r"{\an8}hi"))

    def test_to_ass(self):
        safe = {"top": 1, "bottom": 400, "left": 60, "right": 140}
        out = caps.to_ass([{"start": 0.5, "end": 2.0, "text": "caption plumbing test"},
                           {"start": 3.0, "end": 2.0, "text": "dropped"},
                           {"start": 9.0, "end": 20.0, "text": "clamped"}], LAYOUTS["output"], safe, duration=10.0)
        self.assertIn("PlayResX: 1080", out)
        self.assertIn(",60,140,400,1", out)
        self.assertIn("Dialogue: 0,0:00:00.50,0:00:02.00,Cap,,0,0,0,,caption plumbing test", out)
        self.assertIn("0:00:09.00,0:00:10.00", out)
        self.assertNotIn("dropped", out)

    def test_whisper_cpp_json(self):
        segs = caps.parse_whisper_cpp_json({"transcription": [
            {"offsets": {"from": 0, "to": 1500}, "text": " hello "},
            {"offsets": {"from": 2000, "to": 1000}, "text": "bad"},
            {"text": "no offsets"}]})
        self.assertEqual(segs, [{"start": 0.0, "end": 1.5, "text": "hello"}])

    def test_backends_without_install(self):
        self.assertEqual(caps.transcribe("none", "x.wav", {})[1]["status"], "off")
        self.assertEqual(caps.transcribe("whisper-cli", "x.wav", {})[1]["status"], "unavailable")
        info = caps.transcribe("faster-whisper", "x.wav", {})[1]
        self.assertEqual(info["status"], "unavailable")
        with self.assertRaises(cc.ClipError):
            caps.transcribe("cloud", "x.wav", {})


class RenderTests(unittest.TestCase):
    def lay(self, i):
        return next(x for x in LAYOUTS["layouts"] if x["id"] == i)

    def test_crop_graphs(self):
        g = rnd.layout_graph(self.lay("full-crop"), 1920, 1080, 1080, 1920)
        self.assertIn("crop=606:1080:656:0", g)
        g = rnd.layout_graph(self.lay("full-crop"), 1080, 1920, 1080, 1920)
        self.assertIn("crop=1080:1920:0:0", g)
        g = rnd.layout_graph({"kind": "crop", "centerX": 0.0}, 1920, 1080, 1080, 1920)
        self.assertIn("crop=606:1080:0:0", g)

    def test_stack_and_fill_graphs(self):
        g = rnd.layout_graph(self.lay("game-facecam"), 1920, 1080, 1080, 1920)
        # Rects copied from the Default H preset's Facecam and Game layers (data/clip/layouts.json).
        self.assertIn("crop=386:372:26:610", g)
        self.assertIn("crop=1416:976:466:30", g)
        self.assertIn("vstack=inputs=2", g)
        self.assertNotIn("boxblur", rnd.layout_graph(self.lay("blurred-fill"), 1920, 1080, 1080, 1920))
        with self.assertRaises(cc.ClipError):
            rnd.layout_graph({"kind": "stack", "facecam": [0.9, 0, 0.5, 0.5], "game": [0, 0, 1, 1]}, 1920, 1080,
                             1080, 1920)
        with self.assertRaises(cc.ClipError):
            rnd.layout_graph({"kind": "spin"}, 1920, 1080, 1080, 1920)

    def test_argv(self):
        g = rnd.layout_graph(self.lay("full-crop"), 1920, 1080, 1080, 1920)
        a = rnd.render_argv("ffmpeg", "src.mkv", 10.0, 20.0, g, "libopenh264", "o.mp4.part", False, "captions.ass")
        fc = a[a.index("-filter_complex") + 1]
        self.assertTrue(fc.endswith("format=yuv420p,subtitles=captions.ass[vout]"))
        self.assertIn("anullsrc=r=48000:cl=stereo", a)
        self.assertEqual(a[a.index("-ss") + 1], "10.000")
        self.assertEqual(a[a.index("-threads") + 1], "4")
        with self.assertRaises(cc.ClipError):
            rnd.pick_encoder("x264")


class ValidateTests(unittest.TestCase):
    INFO = {"duration": 20.0, "width": 1080, "height": 1920, "fps": 60.0, "vcodec": "h264", "pix_fmt": "yuv420p",
            "acodec": "aac", "has_audio": True, "size": 1000}

    def test_pass(self):
        r = val.check_file(dict(self.INFO), 20.2, LAYOUTS["output"], TARGETS)
        self.assertTrue(r["ok"], r)
        self.assertEqual(set(r["targets"]), {t["id"] for t in TARGETS["targets"]})

    def test_failures(self):
        r = val.check_file({**self.INFO, "width": 1920, "height": 1080, "has_audio": False}, 20.0,
                           LAYOUTS["output"], TARGETS)
        self.assertFalse(r["ok"])
        self.assertEqual(len(r["issues"]), 2)
        r = val.check_file({**self.INFO, "duration": 200.0}, 200.0, LAYOUTS["output"], TARGETS)
        self.assertFalse(r["targets"]["youtube-shorts"]["ok"])
        self.assertTrue(r["targets"]["tiktok"]["ok"])
        r = val.check_file({**self.INFO, "fps": 120.0}, 20.0, LAYOUTS["output"], TARGETS)
        self.assertFalse(r["ok"])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class EndToEndTests(unittest.TestCase):
    """Generated 12 s 640x360 source with a tone burst; one hotkey marker; CPU encoder (libopenh264)."""

    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.TemporaryDirectory()
        d = cls.td.name
        cls.rec = os.path.join(d, "rec-h-20261103-070000.mkv")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "4",
                         "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12",
                         "-f", "lavfi", "-i",
                         "aevalsrc='sin(2*PI*440*t)*(0.02+0.01*sin(2*PI*0.7*t)+0.6*between(t,8,9))':s=48000:d=12",
                         "-c:v", "libopenh264", "-b:v", "800k", "-c:a", "aac", "-b:a", "96k", cls.rec], timeout=300)
        if r.returncode != 0:
            raise unittest.SkipTest(f"cannot generate test media: {r.stderr[-200:]}")
        cls.markers = os.path.join(d, "markers.jsonl")
        _write(cls.markers, json.dumps({"v": 1, "at": "2026-11-03T07:00:06.000Z", "source": "hotkey",
                                        "recordMs": 6000, "streamMs": None}) + "\n")
        cls.data_on = os.path.join(d, "data-on")
        os.makedirs(cls.data_on)
        _write(os.path.join(cls.data_on, cc.LOCAL_FLAGS), json.dumps({"flags": {"clip-pipeline": True}}))
        cls.data_off = os.path.join(d, "data-off")
        os.makedirs(cls.data_off)
        # D284: with no settings file the user is asked (allowed); clips refused only when every choice is off
        _write(os.path.join(cls.data_off, "settings.json"), json.dumps({"clips": {"recording": "off", "live": "off"}}))

    @classmethod
    def tearDownClass(cls):
        cls.td.cleanup()

    def args(self, data_dir, out, *extra):
        return ["--data-dir", data_dir, "run", "--recording", self.rec, "--markers", self.markers,
                "--record-start", "2026-11-03T07:00:00Z", "--out", out, "--encoder", "libopenh264", *extra]

    def test_flag_off_refuses(self):
        out = os.path.join(self.td.name, "out-off")
        self.assertEqual(clipper.main(self.args(self.data_off, out)), cc.EXIT_FLAG_OFF)
        self.assertFalse(os.path.exists(out))

    def test_run_end_to_end(self):
        out = os.path.join(self.td.name, "out")
        clips = os.path.join(self.td.name, "user clips")
        self.assertEqual(clipper.main(self.args(self.data_on, out, "--layouts", "full-crop,game-facecam,blurred-fill",
                                                "--publish", clips)), 0)
        # D298: the clips folder gets the finished videos only, named by the convention; the upload list is app data
        days = os.listdir(clips)  # the local date of the recording (the test may run in any time zone)
        self.assertEqual(len(days), 1)
        self.assertRegex(days[0], r"^2026-11-0[23]$")
        day = os.path.join(clips, days[0])
        got = sorted(os.listdir(day))
        self.assertEqual(len(got), 3)
        for n in got:
            self.assertRegex(n, r"^codm_short_2026110[23]-\d{6}_[a-z0-9-]+_01_v-(full-crop|game-facecam|blurred-fill)\.mp4$")
        up = cc.load_json(os.path.join(self.data_on, "clips", "uploads.json"))
        self.assertEqual(len(up["files"]), 3)
        cand = cc.load_json(os.path.join(out, clipper.CANDIDATES))
        self.assertEqual(cand["signals"]["markers"]["matched"], 1)
        self.assertTrue(cand["signals"]["audio"]["available"])
        self.assertEqual(cand["ranking"]["status"], "proposed")
        self.assertEqual(len(cand["candidates"]), 1)
        kinds = {r["kind"] for r in cand["candidates"][0]["reasons"]}
        self.assertEqual(kinds, {"marker.hotkey", "audio.loudness"})
        rep = cc.load_json(os.path.join(out, clipper.REPORT))
        self.assertEqual((rep["files"], rep["failed"]), (3, 0))
        self.assertEqual({r["layout"] for r in rep["results"]}, {"full-crop", "game-facecam", "blurred-fill"})
        for r in rep["results"]:
            self.assertTrue(r["decode"]["ok"])
            self.assertEqual((r["facts"]["width"], r["facts"]["height"]), (1080, 1920))
            self.assertEqual((r["audio"]["tracks"], r["audio"]["sourceTracks"]), (1, 1), "audio track kept")
            self.assertIsNotNone(r["audio"]["loudness"][0]["lufs"], "loudness reported per track")

    def test_default_layout_cuts_the_v_recording(self):
        out = os.path.join(self.td.name, "out-v")
        self.assertNotEqual(clipper.main(self.args(self.data_on, out)), 0,
                            "no V sibling: refused, never a silent H render")
        vrec = self.rec.replace("-h-", "-v-")
        shutil.copyfile(self.rec, vrec)
        try:
            self.assertEqual(clipper.v_recording(self.rec), vrec)
            self.assertEqual(clipper.main(self.args(self.data_on, out)), 0)
            rep = cc.load_json(os.path.join(out, clipper.REPORT))
            self.assertEqual([r["layout"] for r in rep["results"]], ["stream-v"])
            self.assertTrue(rep["results"][0]["decode"]["ok"])
        finally:
            os.remove(vrec)
        for r in rep["results"]:
            self.assertTrue(r["decode"]["ok"])
            self.assertEqual((r["facts"]["width"], r["facts"]["height"]), (1080, 1920))

    def test_montage_writes_a_posting_run_folder(self):
        """Won-match reel from fixture hits (two own kills, one VICTORY): rendered from the V recording, validated,
        and candidates.json written so the montage folder packages for posting."""
        d = os.path.join(self.td.name, "out-montage")
        os.makedirs(d)
        _write(os.path.join(d, "detector-hits.jsonl"), "".join(json.dumps(h) + "\n" for h in (
            {"t": 3.0, "detector": "M5", "signal": True}, {"t": 5.0, "detector": "M5", "signal": True},
            {"t": 9.0, "detector": "W1", "label": "VICTORY", "signal": True, "tEnd": 10.0})))
        vrec = self.rec.replace("-h-", "-v-")
        shutil.copyfile(self.rec, vrec)
        try:
            base = ["--data-dir", self.data_on]
            self.assertEqual(clipper.main(base + ["montage", "--recording", self.rec, "--out", d,
                                                  "--record-start", "2026-11-03T07:00:00Z", "--encoder", "libopenh264"]), 0)
        finally:
            os.remove(vrec)
        out = os.path.join(d, "montage")
        self.assertEqual(clipper.main(["--data-dir", self.data_on, "validate", "--out", out]), 0)
        cand = cc.load_json(os.path.join(out, clipper.CANDIDATES))
        self.assertEqual(cand["recordStartUtc"], "2026-11-03T07:00:00Z")
        c = cand["candidates"]
        self.assertEqual([(x["id"], x["kind"], x["rank"]) for x in c], [("W01", "won-match", 1)])
        p = c[0]["pieces"]
        self.assertEqual(p[0], {"start": 0.0, "end": 6.5, "kills": 2})
        self.assertEqual((p[1]["start"], p[1]["kills"]), (8.5, 0))
        self.assertAlmostEqual(p[1]["end"], 12.0, delta=0.05, msg="the VICTORY hold stops at the recording end")
        self.assertEqual((c[0]["start"], c[0]["anchor"]), (0.0, 3.0))
        self.assertAlmostEqual(c[0]["end"], 10.0, delta=0.05)
        rep = cc.load_json(os.path.join(out, clipper.REPORT))
        self.assertEqual([(r["id"], r["layout"], r["ok"]) for r in rep["results"]], [("W01", "montage-v", True)])

    def test_caption_burn_in(self):
        """Burns a fixture ASS through the libass subtitles filter and validates the file."""
        wd = os.path.join(self.td.name, "burn")
        os.makedirs(wd)
        safe = caps.safe_area(TARGETS)
        _write(os.path.join(wd, "captions.ass"),
               caps.to_ass([{"start": 0.2, "end": 3.0, "text": "caption plumbing test"}], LAYOUTS["output"], safe))
        info = cc.media_info("ffprobe", self.rec)
        cand = {"id": "c01", "start": 1.0, "end": 5.0}
        lay = next(x for x in LAYOUTS["layouts"] if x["id"] == "full-crop")
        name = rnd.render_variant("ffmpeg", self.rec, info, cand, lay, LAYOUTS["output"], "libopenh264", wd,
                                  "captions.ass")
        res = val.validate_file("ffmpeg", "ffprobe", os.path.join(wd, name), 4.0, LAYOUTS["output"], TARGETS)
        self.assertTrue(res["ok"], res)


if __name__ == "__main__":
    unittest.main()
