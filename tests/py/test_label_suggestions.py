# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for tools/label/suggestions.py (A6). Stdlib only. Small fixtures are built here; the corpus is never used."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

# No console window on Windows (D191): every subprocess call passes **NO_WINDOW.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "services", "clip"))
import game_pack

_spec = importlib.util.spec_from_file_location("suggestions", os.path.join(_REPO, "tools", "label", "suggestions.py"))
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)

SESSION = "s-test-0001"
MANIFEST = {
    "session": SESSION,
    "segments": [
        # session 0..30 = clip A 0.5..30.5 ; session 30..60 = clip B 2..32 (cache gap between the clips is not kept)
        {"clip": "a.mp4", "clipInSec": 0.5, "clipOutSec": 30.5, "sessionStartSec": 0.0, "durationSec": 30.0},
        {"clip": "b.mp4", "clipInSec": 2.0, "clipOutSec": 32.0, "sessionStartSec": 30.0, "durationSec": 30.0},
        {"clip": "c.mp4", "clipInSec": 0.0, "clipOutSec": 600.0, "sessionStartSec": 60.0, "durationSec": 600.0},
    ],
}
PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))


def hit(det, clip, t, **kw):
    r = {"det": det, "session": SESSION, "src": "clip", "clip": clip, "image": None, "t": t, "g": [0, 0, 1, 1],
         "text": "fake text", "score": 0.9, "frameMode": "mp", "name": {"score": 0.0}}
    r.update(kw)
    return r


def medal(name, score=1.0):
    return {"medal": name, "exact": True, "score": score}


class TimeMapTests(unittest.TestCase):
    def test_mapping_two_segments(self):
        idx = sg.segment_index(MANIFEST)
        self.assertAlmostEqual(sg.to_session_time(idx, "a.mp4", 10.5), 10.0)
        self.assertAlmostEqual(sg.to_session_time(idx, "b.mp4", 2.0), 30.0)
        self.assertAlmostEqual(sg.to_session_time(idx, "b.mp4", 12.0), 40.0)

    def test_outside_trim_and_unknown_clip(self):
        idx = sg.segment_index(MANIFEST)
        self.assertIsNone(sg.to_session_time(idx, "a.mp4", 0.2))   # before clipInSec
        self.assertIsNone(sg.to_session_time(idx, "b.mp4", 1.0))
        self.assertIsNone(sg.to_session_time(idx, "b.mp4", 33.0))  # after clipOutSec
        self.assertIsNone(sg.to_session_time(idx, "zzz.mp4", 5.0))


class BuildTests(unittest.TestCase):
    def build(self, rows, **params):
        return sg.build(rows, MANIFEST, PACK, SESSION, params)

    def test_basic_and_counts(self):
        doc = self.build([
            hit("M3", "a.mp4", 10.5, medal=medal("Double Kill"), medalClass="positive"),
            hit("NAME", "a.mp4", 11.0),
            hit("M5", "a.mp4", 12.0, side=None),
            hit("M5", "a.mp4", 13.0, side="killer"),
            hit("M3", "b.mp4", 1.0, medal=medal("Triple Kill")),            # outside trim
            hit("M3", "a.mp4", 5.5, medal=medal("Triple Kill"), session="s-other"),
        ])
        st = doc["stats"]
        self.assertEqual((st["hitsIn"], st["hitsOtherSession"], st["hitsDroppedByType"], st["hitsOutsideTrim"], st["hitsMapped"]),
                         (6, 1, 2, 1, 2))
        self.assertEqual([s["detectorId"] for s in doc["suggestions"]], ["M3", "M5"])
        m3 = doc["suggestions"][0]
        self.assertEqual((m3["id"], m3["timeSec"], m3["medal"]), ("sg-0001", 10.0, "Double Kill"))
        self.assertEqual(doc["suggestions"][1]["side"], "killer")
        self.assertEqual(doc["paramsStatus"], "unverified")

    def test_merge_repeat_sightings(self):
        doc = self.build([
            hit("M3", "a.mp4", 10.5, medal=medal("Double Kill"), score=0.7),
            hit("M3", "a.mp4", 12.5, medal=medal("Double Kill"), score=0.95, text="best"),
            hit("M3", "a.mp4", 25.5, medal=medal("Double Kill")),           # far later: new suggestion
            hit("M3", "a.mp4", 12.5, medal=medal("Triple Kill")),           # other medal: own suggestion
        ])
        s = doc["suggestions"]
        self.assertEqual(len(s), 3)
        first = [x for x in s if x["medal"] == "Double Kill"][0]
        self.assertEqual((first["samples"], first["endTimeSec"], first["confidence"], first["ocrText"]), (2, 12.0, 0.95, "best"))

    def test_suppression_keeps_but_marks(self):
        doc = self.build([
            hit("M2", "a.mp4", 10.5, nameOnFrame=True),
            hit("M3", "a.mp4", 14.5, medal=medal("Double Kill")),    # 4 s after: inside the replay window
            hit("M4", "a.mp4", 15.5, points=100),                    # M4 also suppressed by the rule
            hit("M3", "a.mp4", 29.5, medal=medal("Triple Kill")),    # 19 s after: outside
            hit("M5", "a.mp4", 14.5, side="killer"),                 # not in the rule
        ])
        by = {(s["detectorId"], s.get("medal")): s for s in doc["suggestions"]}
        self.assertEqual(by[("M3", "Double Kill")]["suppressed"]["rule"], "suppress_medals_in_replay")
        self.assertEqual(by[("M3", "Double Kill")]["suppressed"]["by"], by[("M2", None)]["id"])
        self.assertIn("suppressed", by[("M4", None)])
        self.assertNotIn("suppressed", by[("M3", "Triple Kill")])
        self.assertNotIn("suppressed", by[("M5", None)])
        self.assertEqual(doc["stats"]["suppressed"], 2)
        self.assertEqual(len(doc["suggestions"]), 5)

    def test_replay_window_is_a_parameter(self):
        rows = [hit("M2", "a.mp4", 10.5), hit("M3", "a.mp4", 29.5, medal=medal("Double Kill"))]
        self.assertEqual(self.build(rows)["stats"]["suppressed"], 0)
        self.assertEqual(self.build(rows, replayAfterSec=30.0)["stats"]["suppressed"], 1)

    def test_end_screen_rule_counts_once_per_match(self):
        doc = self.build([
            hit("M1", "c.mp4", 10.0, nameOnFrame=True),              # session 70
            hit("M2", "c.mp4", 40.0, nameOnFrame=True),              # session 100: same match group, also named
            hit("K1", "c.mp4", 60.0, signal=False, nameMatched=False),   # session 120: not named
            hit("M1", "c.mp4", 400.0, nameOnFrame=False),            # session 460: new group, no name
            hit("K1", "c.mp4", 560.0, signal=True, nameMatched=True),    # session 620: new group, named
        ])
        es = [(s["detectorId"], s["endScreen"]["group"], s["endScreen"]["named"], s["endScreen"]["counts"])
              for s in doc["suggestions"] if "endScreen" in s]
        self.assertEqual(es, [("M1", 1, True, True), ("M2", 1, True, False), ("K1", 1, False, False),
                              ("M1", 2, False, False), ("K1", 3, True, True)])
        self.assertEqual(doc["stats"]["endScreens"], 5)

    def test_ocr_text_is_a_declared_local_field(self):
        doc = self.build([hit("M3", "a.mp4", 10.5, medal=medal("Double Kill"), text="SomeName")])
        self.assertIn("ocrText", doc["suggestions"][0])
        self.assertEqual(doc["localOnlyFields"], ["ocrText"])
        self.assertNotIn("name", doc["suggestions"][0])


LOCAL = os.path.join(_REPO, "data", "games", "codm", "local")
# A corpus folder that is not used by anything (the guard only compares real paths).
CORPUS = os.path.join(tempfile.gettempdir(), "label-test-corpus-unused")


class OutputGuardTests(unittest.TestCase):
    def test_refuses_inside_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            sess = os.path.join(tmp, "cache", SESSION)
            os.makedirs(sess)
            manifest = os.path.join(sess, "manifest.json")
            with self.assertRaises(SystemExit):
                sg.check_out(os.path.join(tmp, "cache", "x", "out.json"), manifest, "codm", corpus=CORPUS)

    def test_refuses_tracked_repo_path_and_accepts_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "cache", SESSION, "manifest.json")
            with self.assertRaises(SystemExit):
                sg.check_out(os.path.join(_REPO, "docs", "suggestions.json"), manifest, "codm", corpus=CORPUS)
            sg.check_out(os.path.join(LOCAL, "labels-suggestions", "x.json"), manifest, "codm", corpus=CORPUS)

    def test_out_must_be_inside_the_game_local_folder(self):
        # Review finding 10: --out accepted the corpus or any folder outside the repository.
        with tempfile.TemporaryDirectory() as tmp:
            manifest = os.path.join(tmp, "cache", SESSION, "manifest.json")
            refused = [
                os.path.join(tmp, "elsewhere", "x.json"),                                   # outside the repo
                os.path.join(tmp, "corpus", "x.json"),                                      # a corpus-like folder
                os.path.join(_REPO, "data", "games", "othergame", "local", "x.json"),       # another game's local
                os.path.join(LOCAL, "..", "x.json"),                                        # escapes with ..
                os.path.join(_REPO, "data", "games", "codm", "localx", "x.json"),           # prefix, not a child
                LOCAL,                                                                      # the folder itself
                os.path.join(_REPO, "data", "labels", "x.json"),                            # tracked labels folder
            ]
            for p in refused:
                with self.subTest(p=p), self.assertRaises(SystemExit):
                    sg.check_out(p, manifest, "codm", corpus=CORPUS)
            with self.assertRaises(SystemExit):
                sg.check_out(os.path.join(LOCAL, "x.json"), manifest, "../codm", corpus=CORPUS)
            sg.check_out(os.path.join(LOCAL, "labels-suggestions", "s-x.json"), manifest, "codm", corpus=CORPUS)

    def test_corpus_is_read_only_in_both_directions(self):
        # S3 (2026-10-28): the corpus is compared by real path like the cache, both directions, and must be known.
        os.makedirs(LOCAL, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory(dir=LOCAL, prefix=".test-s3-") as outdir:
            manifest = os.path.join(tmp, "cache", SESSION, "manifest.json")
            out = os.path.join(outdir, "s.json")
            sg.check_out(out, manifest, "codm", corpus=os.path.join(tmp, "corpus"))
            for corpus in (None, ""):
                with self.subTest(corpus=corpus), self.assertRaises(SystemExit):
                    sg.check_out(out, manifest, "codm", corpus=corpus)
            # the output inside the corpus (a corpus that sits inside the game's local folder)
            with self.assertRaises(SystemExit):
                sg.check_out(os.path.join(outdir, "corp", "x.json"), manifest, "codm", corpus=os.path.join(outdir, "corp"))
            # the corpus inside, or equal to, the output folder
            for corpus in (outdir, os.path.join(outdir, "sub")):
                with self.subTest(corpus=corpus), self.assertRaises(SystemExit):
                    sg.check_out(out, manifest, "codm", corpus=corpus)
            # the cache inside the output folder
            with self.assertRaises(SystemExit):
                sg.check_out(out, os.path.join(outdir, "cache", SESSION, "manifest.json"), "codm", corpus=os.path.join(tmp, "corpus"))
            # a junction inside the local folder that points into the corpus
            corpus = os.path.join(tmp, "corpus")
            os.makedirs(corpus)
            link = os.path.join(outdir, "link")
            made = subprocess.run(["cmd", "/c", "mklink", "/J", link, corpus], capture_output=True, **NO_WINDOW).returncode == 0 \
                if os.name == "nt" else (os.symlink(corpus, link) or True)
            if made:
                with self.assertRaises(SystemExit):
                    sg.check_out(os.path.join(link, "x.json"), manifest, "codm", corpus=corpus)
                os.rmdir(link) if os.name == "nt" else os.unlink(link)
            self.assertEqual(os.listdir(corpus), [])

    def test_corpus_from_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "p.json")
            for doc, want in (({"paths": {"clips_corpus": "D:/clips"}}, "D:/clips"), ({"paths": {"clips_corpus": "<clips-corpus>"}}, None),
                              ({"paths": {}}, None), ({}, None), ([], None)):
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(doc, f)
                self.assertEqual(sg.corpus_from_profile(p), want, doc)
            self.assertIsNone(sg.corpus_from_profile(os.path.join(tmp, "missing.json")))

    def test_write_is_atomic(self):
        # Review finding 12: a failed write must leave the old file whole and no temp file behind.
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "s.json")
            sg.write_atomic(out, {"a": 1})
            with self.assertRaises(TypeError):
                sg.write_atomic(out, {"a": object()})   # not JSON-serialisable, fails half-way
            with open(out, encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"a": 1})
            self.assertEqual(os.listdir(tmp), ["s.json"])
            sg.write_atomic(out, {"a": 2})
            with open(out, encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"a": 2})

    def test_cli_writes_file_in_local_and_refuses_elsewhere(self):
        os.makedirs(LOCAL, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory(dir=LOCAL, prefix=".test-suggestions-") as outdir:
            manifest = os.path.join(tmp, "cache", SESSION, "manifest.json")
            os.makedirs(os.path.dirname(manifest))
            with open(manifest, "w", encoding="utf-8") as f:
                json.dump(MANIFEST, f)
            hits = os.path.join(tmp, "hits.jsonl")
            with open(hits, "w", encoding="utf-8") as f:
                f.write(json.dumps(hit("M3", "a.mp4", 10.5, medal=medal("Double Kill"))) + "\n")

            def run(out, extra=()):
                return subprocess.run([sys.executable, "-I", os.path.join(_REPO, "tools", "label", "suggestions.py"),
                                       "--session", SESSION, "--hits", hits, "--manifest", manifest,
                                       "--pack", os.path.join(_REPO, "data", "games", "codm"), "--out", out,
                                       "--corpus", os.path.join(tmp, "corpus")] + list(extra),
                                      capture_output=True, text=True, **NO_WINDOW)

            out = os.path.join(outdir, SESSION + ".json")
            r = run(out)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, encoding="utf-8") as f:
                self.assertEqual(json.load(f)["suggestions"][0]["timeSec"], 10.0)
            self.assertEqual(os.listdir(outdir), [SESSION + ".json"])   # no temp file left
            bad = os.path.join(tmp, "out", SESSION + ".json")
            r = run(bad)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(bad))
            # S3: the corpus given on the command line is refused as an output folder, and an unknown
            # corpus (a profile without paths.clips_corpus) fails closed
            corp = os.path.join(outdir, "corp")
            r = run(os.path.join(corp, SESSION + ".json"), ["--corpus", corp])
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("corpus", r.stderr)
            self.assertFalse(os.path.exists(corp))
            prof = os.path.join(tmp, "profile.json")
            with open(prof, "w", encoding="utf-8") as f:
                json.dump({"paths": {}}, f)
            r = subprocess.run([sys.executable, "-I", os.path.join(_REPO, "tools", "label", "suggestions.py"),
                                "--session", SESSION, "--hits", hits, "--manifest", manifest,
                                "--pack", os.path.join(_REPO, "data", "games", "codm"), "--out", out, "--profile", prof],
                               capture_output=True, text=True, **NO_WINDOW)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("corpus folder unknown", r.stderr)


if __name__ == "__main__":
    unittest.main()
