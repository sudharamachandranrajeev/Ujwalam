# SPDX-License-Identifier: GPL-2.0-or-later
"""Unit tests for services/clip/session_index.py.

Synthetic filename lists and fake probe records only; no corpus access.
Run: python -I -m unittest discover -s tests/py -t tests/py
"""

import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, "..", "..", "services", "clip", "session_index.py")
_spec = importlib.util.spec_from_file_location("session_index", _MOD_PATH)
si = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(si)

BST = timezone(timedelta(hours=1))


def name_for(dt: datetime) -> str:
    h12 = dt.hour % 12 or 12
    ampm = "am" if dt.hour < 12 else "pm"
    return (f"MeldStudio_Clip_Clipping_Output_{dt:%Y-%m-%d}_at_"
            f"{h12}.{dt.minute:02d}.{dt.second:02d}{ampm}.mp4")


def fake_probe(duration=30.0, **over):
    p = {"duration": duration, "width": 1080, "height": 1920, "avgFps": 60.0,
         "videoCodec": "h264", "audioCodec": "aac", "sampleRate": 48000,
         "channels": 2, "audioTracks": 1, "size": 1000}
    p.update(over)
    return p


def listing(starts_durs, extra_names=()):
    files = []
    for start, dur in starts_durs:
        files.append({"name": name_for(start), "path": "x", "size": 1, "mtimeNs": 1,
                      "probe": fake_probe(dur)})
    for n in extra_names:
        files.append({"name": n, "path": "x", "size": 1, "mtimeNs": 1})
    return files


class ParseNameTests(unittest.TestCase):
    def p(self, t):
        return si.parse_clip_name(f"MeldStudio_Clip_Clipping_Output_2026-10-20_at_{t}.mp4")

    def test_am_pm(self):
        self.assertEqual(self.p("6.31.17pm"), datetime(2026, 10, 20, 18, 31, 17))
        self.assertEqual(self.p("9.05.00am"), datetime(2026, 10, 20, 9, 5, 0))
        self.assertEqual(self.p("11.59.59pm"), datetime(2026, 10, 20, 23, 59, 59))

    def test_12am_is_midnight(self):
        self.assertEqual(self.p("12.00.05am"), datetime(2026, 10, 20, 0, 0, 5))

    def test_12pm_is_noon(self):
        self.assertEqual(self.p("12.30.00pm"), datetime(2026, 10, 20, 12, 30, 0))

    def test_unparseable(self):
        self.assertIsNone(si.parse_clip_name("notes.txt"))
        self.assertIsNone(self.p("13.00.00pm"))  # hour out of 12-hour range
        self.assertIsNone(self.p("0.10.00am"))
        self.assertIsNone(si.parse_clip_name(
            "MeldStudio_Clip_Clipping_Output_2026-02-30_at_1.00.00pm.mp4"))  # bad date

    def test_utc_conversion(self):
        dt = datetime(2026, 10, 20, 0, 30, 0)
        self.assertEqual(si.iso_utc(dt, BST), "2026-10-19T23:30:00Z")
        self.assertEqual(si.iso_local(dt, BST), "2026-10-20T00:30:00+01:00")


class SessionTests(unittest.TestCase):
    def clips(self, starts_durs):
        return [{"file": name_for(s), "start": s, "duration": d} for s, d in starts_durs]

    def test_gap_over_120_splits(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        # clip 1 ends at t0+30; next starts 121 s later
        sessions = si.build_sessions(self.clips([
            (t0, 30.0), (t0 + timedelta(seconds=30 + 121), 30.0)]), BST)
        self.assertEqual(len(sessions), 2)
        self.assertEqual(sessions[0]["id"], "s-2026-10-20-2000")
        self.assertEqual(sessions[1]["clipCount"], 1)

    def test_gap_exactly_120_stays(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        sessions = si.build_sessions(self.clips([
            (t0, 30.0), (t0 + timedelta(seconds=30 + 120), 30.0)]), BST)
        self.assertEqual(len(sessions), 1)
        b = sessions[0]["boundaries"]
        self.assertEqual(b["gapCount"], 1)
        self.assertEqual(b["max"], 120.0)
        # the gap is skipped in the virtual concatenation
        self.assertEqual(sessions[0]["clips"][1]["sessionOffsetSec"], 30.0)
        self.assertEqual(sessions[0]["clips"][1]["wallOffsetSec"], 150.0)

    def test_overlap_trim(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        # 31.5 s clip, next starts 30 s later -> 1.5 s overlap; then 1 s gap
        sessions = si.build_sessions(self.clips([
            (t0, 31.5), (t0 + timedelta(seconds=30), 30.0),
            (t0 + timedelta(seconds=61), 29.0)]), BST)
        self.assertEqual(len(sessions), 1)
        c = sessions[0]["clips"]
        self.assertEqual(c[0]["trimInSec"], 0.0)
        self.assertEqual(c[0]["sessionOffsetSec"], 0.0)
        self.assertEqual(c[1]["gapBeforeSec"], -1.5)
        self.assertEqual(c[1]["trimInSec"], 1.5)
        self.assertEqual(c[1]["sessionOffsetSec"], 31.5)
        self.assertEqual(c[2]["gapBeforeSec"], 1.0)
        self.assertEqual(c[2]["trimInSec"], 0.0)
        self.assertEqual(c[2]["sessionOffsetSec"], 31.5 + 28.5)
        s = sessions[0]
        self.assertEqual(s["trimmedDurationSec"], 31.5 + 28.5 + 29.0)
        self.assertEqual(s["boundaries"]["overlapCount"], 1)
        self.assertEqual(s["boundaries"]["min"], -1.5)
        self.assertEqual(s["wallDurationSec"], 90.0)
        self.assertEqual(c[1]["startUtc"], "2026-10-20T19:00:30Z")

    def test_unsorted_input_is_sorted(self):
        t0 = datetime(2026, 10, 20, 11, 59, 45)
        s = si.build_sessions(self.clips([
            (t0 + timedelta(seconds=30), 30.0), (t0, 30.0)]), BST)
        self.assertEqual(s[0]["clips"][0]["startLocal"], "2026-10-20T11:59:45+01:00")


class IndexTests(unittest.TestCase):
    def test_unparseable_reported_not_crashing(self):
        t0 = datetime(2026, 10, 18, 21, 0, 0)
        files = listing([(t0, 30.0), (t0 + timedelta(seconds=30), 30.0)],
                        extra_names=["desktop.ini", "MeldStudio_Clip_Clipping_Output_bad.mp4"])
        idx = si.build_index(files, BST, 120.0, None, None)
        self.assertEqual(idx["summary"]["files"], 4)
        self.assertEqual(idx["summary"]["parsed"], 2)
        self.assertEqual(idx["summary"]["sessions"], 1)
        bad = [a for a in idx["corpusAnomalies"] if a["type"] == "unparseableName"]
        self.assertEqual({a["file"] for a in bad},
                         {"desktop.ini", "MeldStudio_Clip_Clipping_Output_bad.mp4"})
        md = si.render_markdown(idx)
        self.assertIn("unparseableName", md)

    def test_probe_failure_and_format_anomalies(self):
        t0 = datetime(2026, 10, 18, 21, 0, 0)
        files = listing([(t0 + timedelta(seconds=30 * i), 30.0) for i in range(5)])
        files[2]["probe"] = fake_probe(30.0, width=1920, height=1080)
        files[3]["probe"] = fake_probe(12.0)
        del files[4]["probe"]
        files[4]["probeError"] = "ffprobe exit 1: moov atom not found"
        idx = si.build_index(files, BST, 120.0, None, None)
        types = [a["type"] for a in idx["sessions"][0]["anomalies"]]
        self.assertIn("formatDiffers", types)
        self.assertIn("durationOutlier", types)
        self.assertEqual([a["type"] for a in idx["corpusAnomalies"]], ["probeFailed"])

    def test_name_time_end(self):
        # Short first clip saved at t0, next saved 30 s later with 30 s duration:
        # as start times there is a 15 s gap; as save (end) times the clips abut.
        t0 = datetime(2026, 10, 18, 21, 0, 0)
        files = listing([(t0, 15.0), (t0 + timedelta(seconds=30), 30.0)])
        as_start = si.build_index(files, BST, 120.0, None, None, "start")
        self.assertEqual(as_start["sessions"][0]["clips"][1]["gapBeforeSec"], 15.0)
        as_end = si.build_index(files, BST, 120.0, None, None, "end")
        s = as_end["sessions"][0]
        self.assertEqual(s["clips"][1]["gapBeforeSec"], 0.0)
        self.assertEqual(s["startLocal"], "2026-10-18T20:59:45+01:00")
        self.assertEqual(s["id"], "s-2026-10-18-2059")
        self.assertEqual(as_end["nameTime"], "end")
        with self.assertRaises(ValueError):
            si.build_index(files, BST, 120.0, None, None, "middle")

    def test_offset_window(self):
        late = datetime(2026, 10, 25, 1, 30, 0)
        files = listing([(late, 30.0)])
        idx = si.build_index(files, BST, 120.0, datetime(2026, 3, 29, 2, 0),
                             datetime(2026, 10, 25, 1, 0))
        self.assertEqual(idx["corpusAnomalies"][0]["type"], "outsideUtcOffsetWindow")


class CacheTests(unittest.TestCase):
    def test_incremental_reuse(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "probe-cache.json")
            calls = []

            def probe(p):
                calls.append(p)
                return fake_probe(30.0)

            files = [{"name": f"f{i}.mp4", "path": f"p{i}", "size": 100 + i, "mtimeNs": 5}
                     for i in range(3)]
            st = si.probe_all(files, si.ProbeCache(path), probe, workers=4)
            self.assertEqual(st, {"cacheHits": 0, "probed": 3, "probeFailed": 0})
            self.assertEqual(len(calls), 3)

            # Rerun: unchanged files come from cache; one changed mtime, one new file.
            calls.clear()
            files2 = [dict(f) for f in files]
            for f in files2:
                f.pop("probe", None)
            files2[1]["mtimeNs"] = 6
            files2.append({"name": "f9.mp4", "path": "p9", "size": 1, "mtimeNs": 1})
            st2 = si.probe_all(files2, si.ProbeCache(path), probe, workers=2)
            self.assertEqual(st2, {"cacheHits": 2, "probed": 2, "probeFailed": 0})
            self.assertEqual(sorted(calls), ["p1", "p9"])
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(len(json.load(fh)["entries"]), 4)

    def test_failures_not_cached(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "probe-cache.json")

            def bad(p):
                raise RuntimeError("boom")

            files = [{"name": "a.mp4", "path": "a", "size": 1, "mtimeNs": 1}]
            st = si.probe_all(files, si.ProbeCache(path), bad)
            self.assertEqual(st["probeFailed"], 1)
            self.assertEqual(files[0]["probeError"], "boom")
            self.assertIsNone(si.ProbeCache(path).get("a.mp4", 1, 1))

    def test_out_inside_corpus_refused(self):
        with tempfile.TemporaryDirectory() as d:
            rc = si.main(["--corpus", d, "--out", os.path.join(d, "idx")])
            self.assertEqual(rc, 2)
            self.assertFalse(os.path.exists(os.path.join(d, "idx")))


class MeasuredTrimTests(unittest.TestCase):
    def test_measured_trim_replaces_name_time_trim(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        clips = [{"file": name_for(t0 + timedelta(seconds=30 * i)), "start": t0 + timedelta(seconds=30 * i),
                  "duration": 31.0} for i in range(3)]
        measured = {(clips[0]["file"], clips[1]["file"]): 0.4321}
        s = si.build_sessions(clips, BST, 120.0, measured=measured)[0]
        c = s["clips"]
        self.assertIsNone(c[0]["trimMethod"])
        self.assertEqual((c[1]["trimInSec"], c[1]["trimMethod"]), (0.4321, "measured"))
        self.assertEqual((c[2]["trimInSec"], c[2]["trimMethod"]), (1.0, "name-time"))
        self.assertEqual(c[2]["sessionOffsetSec"], round(31.0 + 31.0 - 0.4321, 4))
        self.assertEqual(s["boundaries"]["measuredCount"], 1)

    def test_load_measured_uses_ok_only(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "b.json")
            with open(p, "w", encoding="utf-8") as fh:
                json.dump({"boundaries": [
                    {"a": "a.mp4", "b": "b.mp4", "status": "ok", "trimInSec": 0.5},
                    {"a": "b.mp4", "b": "c.mp4", "status": "rejected-silent", "trimInSec": 0.7},
                    {"a": "c.mp4", "b": "d.mp4", "status": "rejected-low-confidence"}]}, fh)
            self.assertEqual(si.load_measured(p), {("a.mp4", "b.mp4"): 0.5})

    def test_load_measured_drops_trims_inconsistent_with_name_times(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "b.json")
            with open(p, "w", encoding="utf-8") as fh:
                json.dump({"boundaries": [
                    {"a": "a.mp4", "b": "b.mp4", "status": "ok", "trimInSec": 0.5,
                     "residualEndHyp": 0.85, "residualStartHyp": 2.0},
                    {"a": "b.mp4", "b": "c.mp4", "status": "ok", "trimInSec": 2.7,
                     "residualEndHyp": 4.176, "residualStartHyp": 0.0}]}, fh)
            rejected = []
            self.assertEqual(si.load_measured(p, "end", rejected), {("a.mp4", "b.mp4"): 0.5})
            self.assertEqual(rejected, [("b.mp4", "c.mp4", 4.176)])
            self.assertEqual(si.load_measured(p, "start"), {("b.mp4", "c.mp4"): 2.7})


def _manual(first, last, sid="s-manual-1", note=None):
    e = {"id": sid, "source": "manual", "firstClip": first, "lastClip": last}
    if note is not None:
        e["note"] = note
    return e


class SessionsFileMergeTests(unittest.TestCase):
    """Manual entries are kept exactly as written; rule entries are regenerated."""

    def setUp(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        # 6 back-to-back clips, one session by the rule (name = end time)
        self.starts = [(t0 + timedelta(seconds=30 * i), 30.0) for i in range(6)]
        self.files = listing(self.starts)
        self.names = [f["name"] for f in self.files]

    def test_manual_entry_kept_and_rule_regenerated(self):
        manual = _manual(self.names[2], self.names[3], note="split by hand: stream restart")
        existing = {"version": 1, "defaults": {"gapThresholdSec": 120.0}, "sessions": [
            {"id": "s-stale", "source": "rule", "firstClip": self.names[0], "lastClip": self.names[5],
             "startLocal": "2026-10-20T19:59:30.000+01:00", "startUtc": "2026-10-20T18:59:30.000Z",
             "endLocal": "2026-10-20T20:02:30.000+01:00", "endUtc": "2026-10-20T19:02:30.000Z",
             "clipCount": 6},
            manual]}
        idx = si.build_index(self.files, BST, 120.0, None, None, "end", si.manual_entries(existing))
        doc = si.merge_sessions_file(existing, idx["sessions"], 120.0, "end")
        self.assertEqual(si.validate_sessions_doc(doc), [])
        srcs = [(e["source"], e["firstClip"], e["lastClip"]) for e in doc["sessions"]]
        self.assertEqual(srcs, [("rule", self.names[0], self.names[1]),
                                ("manual", self.names[2], self.names[3]),
                                ("rule", self.names[4], self.names[5])])
        self.assertNotIn("s-stale", [e["id"] for e in doc["sessions"]])  # rule entry regenerated
        kept = doc["sessions"][1]
        self.assertIs(kept, manual)  # same object, untouched
        self.assertEqual(json.dumps(kept), json.dumps(_manual(self.names[2], self.names[3],
                                                              note="split by hand: stream restart")))
        self.assertEqual(doc["sessions"][0]["clipCount"], 2)
        self.assertEqual(idx["sessions"][1]["source"], "manual")
        self.assertEqual(idx["sessions"][1]["id"], "s-manual-1")

    def test_manual_entry_with_unknown_clip_is_never_dropped(self):
        ghost = _manual("MeldStudio_Clip_Clipping_Output_2026-01-01_at_1.00.00pm.mp4",
                        "MeldStudio_Clip_Clipping_Output_2026-01-01_at_1.00.30pm.mp4", sid="s-ghost")
        existing = {"version": 1, "defaults": {"gapThresholdSec": 120.0}, "sessions": [ghost]}
        idx = si.build_index(self.files, BST, 120.0, None, None, "end", si.manual_entries(existing))
        self.assertEqual(len(idx["sessionWarnings"]), 1)
        doc = si.merge_sessions_file(existing, idx["sessions"], 120.0, "end")
        self.assertIn(ghost, doc["sessions"])
        self.assertEqual([e["source"] for e in doc["sessions"]], ["rule", "manual"])

    def test_manual_entry_can_join_across_a_rule_split(self):
        # a 200 s gap splits by rule; a manual entry joins both sides into one session
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        files = listing([(t0, 30.0), (t0 + timedelta(seconds=30), 30.0),
                         (t0 + timedelta(seconds=260), 30.0)])
        names = [f["name"] for f in files]
        self.assertEqual(si.build_index(files, BST, 120.0, None, None, "end")["summary"]["sessions"], 2)
        idx = si.build_index(files, BST, 120.0, None, None, "end", [_manual(names[0], names[2])])
        self.assertEqual(idx["summary"]["sessions"], 1)
        self.assertEqual(idx["sessions"][0]["clipCount"], 3)

    def test_validator_rejects_bad_entries(self):
        bad = {"version": 1, "defaults": {"gapThresholdSec": 120},
               "sessions": [{"id": "s-a", "source": "manual", "firstClip": "x.mp4"},
                            {"id": "s-b", "source": "rule", "firstClip": "x.mp4", "lastClip": "y.mp4"},
                            {"id": "s-c", "source": "auto", "firstClip": "x.mp4", "lastClip": "y.mp4"}]}
        errs = si.validate_sessions_doc(bad)
        self.assertTrue(any("s" in e and "lastClip" in e for e in errs))
        self.assertTrue(any("clipCount" in e for e in errs))
        self.assertTrue(any("source" in e for e in errs))


class SessionsFileCliTests(unittest.TestCase):
    """main() with --sessions-file and --gap-threshold, on a fake corpus whose probe
    results are pre-seeded in the probe cache (ffprobe is never called)."""

    def make(self, d, starts_durs):
        corpus = os.path.join(d, "corpus")
        out = os.path.join(d, "out")
        os.makedirs(corpus)
        os.makedirs(out)
        entries = {}
        for start, dur in starts_durs:
            n = name_for(start)
            p = os.path.join(corpus, n)
            with open(p, "wb") as fh:
                fh.write(b"x")
            st = os.stat(p)
            entries[n] = {"size": st.st_size, "mtimeNs": st.st_mtime_ns, "probe": fake_probe(dur)}
        with open(os.path.join(out, si.CACHE_FILE), "w", encoding="utf-8") as fh:
            json.dump({"version": si.SCHEMA_VERSION, "entries": entries}, fh)
        return corpus, out, os.path.join(d, "sessions.json")

    def run_main(self, corpus, out, sf, *extra):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = si.main(["--corpus", corpus, "--out", out, "--sessions-file", sf, *extra])
        return rc

    def load(self, p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)

    def test_threshold_default_flag_and_file(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        # names are end times: clip 1 ends t0, clip 2 ends t0+130 -> starts t0+100 -> gap 100 s
        with tempfile.TemporaryDirectory() as d:
            corpus, out, sf = self.make(d, [(t0, 30.0), (t0 + timedelta(seconds=130), 30.0)])
            self.assertEqual(self.run_main(corpus, out, sf), 0)
            doc = self.load(sf)
            self.assertEqual(doc["defaults"]["gapThresholdSec"], 120.0)  # built-in default stored
            self.assertEqual(len(doc["sessions"]), 1)
            self.assertEqual(self.load(os.path.join(out, si.INDEX_FILE))["nameTime"], "end")

            # flag overrides for this run only; the stored default is unchanged
            self.assertEqual(self.run_main(corpus, out, sf, "--gap-threshold", "60"), 0)
            doc = self.load(sf)
            self.assertEqual(len(doc["sessions"]), 2)
            self.assertEqual(doc["defaults"]["gapThresholdSec"], 120.0)
            self.assertEqual(doc["rule"]["gapThresholdSec"], 60.0)

            # editing the stored default changes the rule without a flag
            doc["defaults"]["gapThresholdSec"] = 90
            si.write_json_atomic(sf, doc)
            self.assertEqual(self.run_main(corpus, out, sf), 0)
            doc = self.load(sf)
            self.assertEqual(len(doc["sessions"]), 2)
            self.assertEqual(doc["defaults"]["gapThresholdSec"], 90)
            self.assertEqual(doc["rule"]["gapThresholdSec"], 90)

    def test_rerun_keeps_manual_entry_verbatim(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        with tempfile.TemporaryDirectory() as d:
            corpus, out, sf = self.make(d, [(t0 + timedelta(seconds=30 * i), 30.0) for i in range(4)])
            self.assertEqual(self.run_main(corpus, out, sf), 0)
            doc = self.load(sf)
            names = sorted(os.listdir(corpus))
            manual = {"note": "kept as written", "lastClip": names[1], "id": "s-hand",
                      "source": "manual", "firstClip": names[0]}  # unusual key order on purpose
            doc["sessions"].insert(0, manual)
            si.write_json_atomic(sf, doc)
            for _ in range(2):
                self.assertEqual(self.run_main(corpus, out, sf), 0)
            doc = self.load(sf)
            self.assertEqual(json.dumps(doc["sessions"][0]), json.dumps(manual))
            self.assertEqual([e["source"] for e in doc["sessions"]], ["manual", "rule"])
            self.assertEqual(doc["sessions"][1]["firstClip"], names[2])

    def test_invalid_file_is_not_overwritten(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        with tempfile.TemporaryDirectory() as d:
            corpus, out, sf = self.make(d, [(t0, 30.0)])
            bad = '{"version": 1, "defaults": {"gapThresholdSec": 120}, "sessions": [{"id": "s-x", "source": "manual"}]}'
            with open(sf, "w", encoding="utf-8") as fh:
                fh.write(bad)
            self.assertEqual(self.run_main(corpus, out, sf), 2)
            with open(sf, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), bad)

    def test_sessions_file_inside_corpus_refused(self):
        t0 = datetime(2026, 10, 20, 20, 0, 0)
        with tempfile.TemporaryDirectory() as d:
            corpus, out, _ = self.make(d, [(t0, 30.0)])
            sf = os.path.join(corpus, "sessions.json")
            self.assertEqual(self.run_main(corpus, out, sf), 2)
            self.assertFalse(os.path.exists(sf))


if __name__ == "__main__":
    unittest.main()
