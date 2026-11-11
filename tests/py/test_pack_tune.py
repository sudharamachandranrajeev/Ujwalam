# SPDX-License-Identifier: GPL-3.0-or-later
"""LL4 (D342): services/clip/pack_tune.py. Synthetic learning stores built in temp folders (placeholder texts, no
images, no OCR, no GPU, no network); the pack is a temp copy of data/games/codm, so the repository pack never changes."""

import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "services", "clip"))

import pack_tune as pt  # noqa: E402

PACK = os.path.join(_REPO, "data", "games", "codm")


def read(path, mode="r"):
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


def load(path):
    return json.loads(read(path))
T0 = datetime(2026, 11, 1, 18, 0, tzinfo=timezone.utc)


def box(text, cy, score=0.97):
    return {"text": text, "score": score, "g": [0.42, round(cy - 0.03, 4), 0.58, round(cy + 0.03, 4)]}


class Store:
    """A synthetic learning store: sessions with review items, answers and evidence rows."""

    def __init__(self, data_dir):
        self.root = os.path.join(data_dir, "learning-store")
        self.n = 0

    def session(self, name, day):
        d = os.path.join(self.root, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "session.json"), "w", encoding="utf-8") as f:
            json.dump({"v": 1, "createdAt": (T0 + timedelta(days=day)).isoformat().replace("+00:00", "Z")}, f)
        return d

    def _append(self, d, name, row):
        with open(os.path.join(d, name), "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def answer(self, d, item, value, corrected=False, kind="unclassified-banner"):
        self._append(d, "labels.jsonl", {"v": 1, "at": "2026-11-01T20:00:00.000Z", "action": "confirmed",
                                         "source": "review", "session": os.path.basename(d),
                                         "ref": {"item": item, "kind": kind, "value": value, "corrected": corrected}})

    def banner(self, d, cy, answer, label="VICTORY"):
        self.n += 1
        item = f"live-{self.n:05d}"
        self._append(d, "review.jsonl", {"v": 1, "id": item, "kind": "unclassified-banner", "detector": "W1",
                                         "label": label, "ocrScore": 0.96, "threshold": None, "value": None,
                                         "choices": ["round", "match", "not a banner"],
                                         "texts": [box("PLAYER_A", 0.2), box(label, cy)]})
        self.answer(d, item, answer)

    def ocr(self, d, score, right):
        self.n += 1
        item = f"live-{self.n:05d}"
        self._append(d, "review.jsonl", {"v": 1, "id": item, "kind": "ocr-low", "detector": "M1", "label": "MEDAL_A",
                                         "ocrScore": score, "value": "MEDAL_A", "choices": ["MEDAL_A", "wrong read"],
                                         "texts": []})
        self.answer(d, item, "MEDAL_A" if right else "wrong read", kind="ocr-low")

    def evidence(self, d, cy, kind):
        self._append(d, "evidence.jsonl", {"v": 1, "t": 1.0, "mode": "mp", "texts": [box("DEFEAT", cy)],
                                           "hits": [{"detector": "W1", "label": "DEFEAT", "signal": True, "banner": kind}]})

    def clip(self, d, action):
        self._append(d, "labels.jsonl", {"v": 1, "at": "2026-11-01T20:00:00.000Z", "action": action,
                                         "source": "my-clips", "session": os.path.basename(d), "ref": {"file": "clip_01.mp4"}})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ll4-")
        self.data = os.path.join(self.tmp, "data")
        self.pack = os.path.join(self.tmp, "pack")
        shutil.copytree(PACK, self.pack, ignore=shutil.ignore_patterns("local"))
        os.makedirs(self.data)
        self.store = Store(self.data)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def flag(self, on=True):
        with open(os.path.join(self.data, "flags.local.json"), "w", encoding="utf-8") as f:
            json.dump({"flags": {"learning-train": on}}, f)

    def set_min_conf(self, v):
        p = os.path.join(self.pack, "game.json")
        g = load(p)
        g["ocr"]["minConfidence"] = v
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(g, indent=2, ensure_ascii=False) + "\n")

    def cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch.object(pt, "lower_own_priority"):
            code = pt.main(["--data-dir", self.data, "--pack-dir", self.pack, *args])
        return code, out.getvalue(), err.getvalue()

    def banner_sessions(self, train=3, held=2, held_answer="round", per=4):
        """Round banners read just above the round range (y 0.30-0.305, current 0.31-0.38), plus "not a banner" reads
        at y 0.25: training sessions first, then the held-out ones (newest)."""
        for i in range(train + held):
            d = self.store.session(f"live-2026110{i + 1}-180000", i)
            for j in range(per):
                self.store.banner(d, 0.300 + j * 0.001, held_answer if i >= train else "round")
            self.store.banner(d, 0.25, "not a banner", label="DEFEAT")
            self.store.evidence(d, 0.343, "round")
            self.store.evidence(d, 0.424, "match")
            self.store.clip(d, "kept")
            self.store.clip(d, "deleted")

    def candidates(self):
        d = os.path.join(self.pack, "local", "candidates")
        return sorted(n for n in os.listdir(d) if n != pt.LAST_RUN) if os.path.isdir(d) else []


class FlagAndGuards(Base):
    def test_flag_off_by_default_runs_nothing(self):
        flags = load(os.path.join(_REPO, "data", "flags.json"))["flags"]
        self.assertIs(next(f for f in flags if f["id"] == "learning-train")["default"], False)
        self.banner_sessions()
        for cmd in (["propose"], ["list"], ["approve", "--candidate", "20261111-120000-0.8.1"]):
            code, _, err = self.cli(*cmd)
            self.assertEqual(code, pt.EXIT_FLAG_OFF, cmd)
            self.assertIn("learning-train is off", err)
        self.assertFalse(os.path.exists(os.path.join(self.pack, "local")))

    def test_refuses_while_a_stream_is_watched(self):
        self.flag()
        self.banner_sessions()
        os.makedirs(os.path.join(self.data, "clips"))
        with open(os.path.join(self.data, "clips", "live-worker.json"), "w", encoding="utf-8") as f:
            json.dump({"on": True, "atMs": time.time() * 1000}, f)
        code, _, err = self.cli("propose")
        self.assertEqual(code, 1)
        self.assertIn("runs after it", err)
        self.assertEqual(self.candidates(), [])

    def test_no_model_or_gpu_module_is_imported(self):
        for m in ("cv2", "onnxruntime", "torch", "rapidocr_onnxruntime", "numpy"):
            self.assertNotIn(m, getattr(pt, "__dict__", {}))
        src = read(pt.__file__)
        for m in ("import cv2", "onnxruntime", "import torch", "rapidocr", "import numpy"):
            self.assertNotIn(m, src)


class Insufficient(Base):
    def test_empty_store_proposes_nothing_and_says_why(self):
        self.flag()
        code, out, _ = self.cli("propose")
        self.assertEqual(code, 0)
        res = json.loads(out)
        self.assertIsNone(res["candidate"])
        self.assertTrue(all(v["status"] == "insufficient" for v in res["values"]))
        self.assertEqual(self.candidates(), [])
        rep = load(os.path.join(self.pack, "local", "candidates", pt.LAST_RUN))
        self.assertEqual(rep["sessions"], 0)

    def test_two_sessions_are_not_enough(self):
        self.flag()
        self.banner_sessions(train=0, held=2)
        rep = pt.propose(self.data, self.pack, "codm")
        b = rep["values"][0]
        self.assertEqual(b["status"], "insufficient")
        self.assertIn("3 or more", b["reason"])
        self.assertIsNone(rep["candidate"])

    def test_too_few_labels_in_enough_sessions(self):
        self.flag()
        self.banner_sessions(train=3, held=2, per=1)  # 2 labels per session: 6 to train, 4 held out
        rep = pt.propose(self.data, self.pack, "codm")
        self.assertEqual(rep["values"][0]["status"], "insufficient")
        self.assertIn("at least", rep["values"][0]["reason"])
        self.assertIsNone(rep["candidate"])

    def test_ocr_threshold_null_means_no_reads_to_learn_from(self):
        self.banner_sessions()
        rep = pt.propose(self.data, self.pack, "codm")
        o = next(v for v in rep["values"] if v["value"].endswith("minConfidence"))
        self.assertEqual(o["status"], "insufficient")
        self.assertIn("not set", o["reason"])


class Banner(Base):
    def test_proposal_only_when_it_beats_the_current_pack_held_out(self):
        self.flag()
        self.banner_sessions()
        code, out, _ = self.cli("propose")
        self.assertEqual(code, 0)
        res = json.loads(out)
        self.assertIsNotNone(res["candidate"])
        (name,) = self.candidates()
        c = load(os.path.join(self.pack, "local", "candidates", name))
        self.assertEqual((c["status"], c["state"], c["baseVersion"], c["version"]), ("unverified", "proposed", "0.8.0", "0.8.1"))
        (v,) = c["values"]
        self.assertEqual(v["score"]["metric"], "held-out accuracy")
        self.assertGreater(v["score"]["proposed"], v["score"]["current"])
        self.assertEqual(v["evidence"]["heldOutSessions"], 2)
        self.assertEqual(v["evidence"]["trainSessions"], 3)
        self.assertEqual(v["evidence"]["heldOutDates"], ["2026-11-04", "2026-11-05"])
        self.assertEqual(v["evidence"]["heldOutEvidenceChanged"], 0)
        (ch,) = c["changes"]
        self.assertEqual(ch["to"], [{"kind": "round", "y0": 0.3, "y1": 0.38}, {"kind": "match", "y0": 0.39, "y1": 0.47}])
        self.assertIn("No detector, pattern, event name, weight or window changed", c["changelogDraft"])
        # Proposals never apply themselves: the pack is unchanged until approve.
        for f in ("game.json", "detectors.json", "CHANGELOG.md"):
            self.assertEqual(read(os.path.join(self.pack, f), "rb"), read(os.path.join(PACK, f), "rb"))
        # label counts are reported (kept / deleted clips are counted, not turned into pack values)
        rep = load(os.path.join(self.pack, "local", "candidates", pt.LAST_RUN))
        self.assertEqual((rep["labelCounts"]["kept"], rep["labelCounts"]["deleted"]), (5, 5))

    def test_no_proposal_when_held_out_disagrees(self):
        self.flag()
        self.banner_sessions(held_answer="not a banner")
        rep = pt.propose(self.data, self.pack, "codm")
        b = rep["values"][0]
        self.assertEqual(b["status"], "not-better")
        self.assertLess(b["score"]["proposed"], b["score"]["current"])
        self.assertIsNone(rep["candidate"])
        self.assertEqual(self.candidates(), [])

    def test_range_never_widened_over_a_read_confirmed_as_something_else(self):
        train = [(0.30, "round"), (0.305, None)]
        kinds = [{"kind": "round", "y0": 0.31, "y1": 0.38}, {"kind": "match", "y0": 0.39, "y1": 0.47}]
        prop, why = pt.tune_banner(train, kinds)
        self.assertIsNone(prop)
        self.assertIn("no change", why)
        prop, why = pt.tune_banner([(0.389, "round"), (0.386, "match")], kinds)  # each blocks the other
        self.assertIsNone(prop)
        self.assertIn("no change", why)
        prop, why = pt.tune_banner([(0.3891, "round")], kinds)  # rounded outward to 0.39, it would meet the match range
        self.assertIsNone(prop)
        self.assertIn("overlap", why)

    def test_approve_writes_the_candidate_bumps_the_version_and_adds_the_changelog(self):
        self.flag()
        self.banner_sessions()
        cid = pt.propose(self.data, self.pack, "codm")["candidate"]["id"]
        code, out, _ = self.cli("list")
        self.assertEqual(json.loads(out)[0]["id"], cid)
        code, out, err = self.cli("approve", "--candidate", cid)
        self.assertEqual(code, 0, err)
        det = load(os.path.join(self.pack, "detectors.json"))
        self.assertEqual(det["version"], "0.8.1")
        w1 = next(d for d in det["detectors"] if d["id"] == "W1")
        rnd = w1["banner"]["kinds"][0]
        self.assertEqual((rnd["y0"], rnd["y1"], rnd["status"]), (0.3, 0.38, "unverified"))
        self.assertIn("LL4 (D342", rnd["note"])
        cl = read(os.path.join(self.pack, "CHANGELOG.md"))
        self.assertLess(cl.index("## 0.8.1"), cl.index("## 0.8.0"))
        # weights, windows and event names are untouched
        orig = load(os.path.join(PACK, "detectors.json"))
        for a, b in zip(orig["detectors"], det["detectors"]):
            self.assertEqual((a["id"], a.get("weight"), a.get("window"), a.get("patterns")), (b["id"], b.get("weight"), b.get("window"), b.get("patterns")))
        self.assertEqual(read(os.path.join(self.pack, "events.json"), "rb"), read(os.path.join(PACK, "events.json"), "rb"))
        # a second approve is refused (no longer proposed)
        code, _, err = self.cli("approve", "--candidate", cid)
        self.assertEqual(code, 1)
        self.assertIn("approved", err)

    def test_stale_candidate_is_refused(self):
        self.flag()
        self.banner_sessions()
        cid = pt.propose(self.data, self.pack, "codm")["candidate"]["id"]
        self.set_min_conf(0.5)
        code, _, err = self.cli("approve", "--candidate", cid)
        self.assertEqual(code, 1)
        self.assertIn("pack changed", err)
        self.assertEqual(load(os.path.join(self.pack, "detectors.json"))["version"], "0.8.0")


class Ocr(Base):
    def ocr_sessions(self, held_flip=False):
        for i in range(5):
            d = self.store.session(f"live-2026110{i + 1}-180000", i)
            for s in (0.40, 0.45, 0.50, 0.55, 0.65, 0.70, 0.75, 0.80):
                right = s >= 0.6
                self.store.ocr(d, s, (not right) if (held_flip and i >= 3) else right)

    def test_lower_threshold_proposed_when_it_beats_held_out(self):
        self.set_min_conf(0.9)
        self.ocr_sessions()
        rep = pt.propose(self.data, self.pack, "codm")
        o = next(v for v in rep["values"] if v["value"].endswith("minConfidence"))
        self.assertEqual(o["status"], "beats")
        self.assertTrue(0.55 < o["proposed"] <= 0.65)
        self.assertEqual(o["score"]["proposed"], 1.0)
        self.assertEqual(o["score"]["current"], 0.5)
        c = load(os.path.join(self.pack, "local", "candidates", rep["candidate"]["id"] + ".json"))
        self.assertEqual([x["path"] for x in c["changes"]], ["ocr.minConfidence"])

    def test_no_threshold_when_held_out_disagrees(self):
        self.set_min_conf(0.9)
        self.ocr_sessions(held_flip=True)
        rep = pt.propose(self.data, self.pack, "codm")
        o = next(v for v in rep["values"] if v["value"].endswith("minConfidence"))
        self.assertEqual(o["status"], "not-better")
        self.assertIsNone(rep["candidate"])


if __name__ == "__main__":
    unittest.main()


class CodexReview(Base):
    """Codex review of D342: live guard on approve, a recoverable approve, base hashes of the parsed bytes, live checks
    between the steps of propose."""

    def live(self, on=True):
        os.makedirs(os.path.join(self.data, "clips"), exist_ok=True)
        with open(os.path.join(self.data, "clips", "live-worker.json"), "w", encoding="utf-8") as f:
            json.dump({"on": on, "atMs": time.time() * 1000}, f)

    def pack_bytes(self):
        return {f: read(os.path.join(self.pack, f), "rb") for f in ("game.json", "detectors.json", "CHANGELOG.md")}

    def test_approve_refuses_while_a_stream_is_watched(self):
        self.flag()
        self.banner_sessions()
        cid = pt.propose(self.data, self.pack, "codm")["candidate"]["id"]
        before = self.pack_bytes()
        self.live()
        code, _, err = self.cli("approve", "--candidate", cid)
        self.assertEqual(code, 1)
        self.assertIn("runs after it", err)
        self.assertEqual(self.pack_bytes(), before)
        self.live(False)
        self.assertEqual(self.cli("approve", "--candidate", cid)[0], 0)

    def test_crash_between_renames_is_finished_by_the_retry(self):
        self.flag()
        self.banner_sessions()
        cid = pt.propose(self.data, self.pack, "codm")["candidate"]["id"]
        real = os.replace
        calls = []

        def crash(src, dst):
            calls.append(dst)
            if os.path.basename(dst) == f"{cid}.json":  # the pack is written, the candidate not yet marked
                raise OSError("power cut")
            return real(src, dst)

        with mock.patch.object(pt.os, "replace", side_effect=crash):
            with self.assertRaises(OSError):
                pt.approve(self.pack, cid)
        code, out, err = self.cli("approve", "--candidate", cid)
        self.assertEqual(code, 0, err)
        det = load(os.path.join(self.pack, "detectors.json"))
        self.assertEqual(det["version"], "0.8.1")
        self.assertEqual(det["detectors"][[d["id"] for d in det["detectors"]].index("W1")]["banner"]["kinds"][0]["y0"], 0.3)
        cl = read(os.path.join(self.pack, "CHANGELOG.md"))
        self.assertEqual(cl.count("## 0.8.1"), 1)
        self.assertIn("## 0.8.0", cl)
        c = load(os.path.join(self.pack, "local", "candidates", f"{cid}.json"))
        self.assertEqual(c["state"], "approved")
        leftovers = [n for r, _, fs in os.walk(self.pack) for n in fs if n.endswith((".ll4-new", ".journal.json"))]
        self.assertEqual(leftovers, [])

    def test_crash_before_the_journal_changes_nothing(self):
        self.flag()
        self.banner_sessions()
        cid = pt.propose(self.data, self.pack, "codm")["candidate"]["id"]
        before = self.pack_bytes()
        real = pt._write_new
        n = []

        def fail(path, data):
            n.append(path)
            if len(n) == 3:  # the changelog's temp file
                raise OSError("disk full")
            return real(path, data)

        with mock.patch.object(pt, "_write_new", side_effect=fail):
            with self.assertRaises(OSError):
                pt.approve(self.pack, cid)
        self.assertEqual(self.pack_bytes(), before, "nothing renamed, the changelog never truncated")
        self.assertEqual(self.cli("approve", "--candidate", cid)[0], 0)
        self.assertEqual(read(os.path.join(self.pack, "CHANGELOG.md")).count("## 0.8.1"), 1)
        self.assertEqual([n for r, _, fs in os.walk(self.pack) for n in fs if n.endswith(".ll4-new")], [])

    def test_base_hashes_are_of_the_bytes_read_at_the_start(self):
        self.flag()
        self.banner_sessions()
        orig = read(os.path.join(self.pack, "game.json"), "rb")
        real = pt.read_session
        changed = []

        def edit_then_read(*a, **k):
            if not changed:
                changed.append(1)
                self.set_min_conf(0.5)  # the pack changes while the store is read
            return real(*a, **k)

        with mock.patch.object(pt, "read_session", side_effect=edit_then_read):
            cid = pt.propose(self.data, self.pack, "codm")["candidate"]["id"]
        c = load(os.path.join(self.pack, "local", "candidates", f"{cid}.json"))
        import hashlib
        self.assertEqual(c["baseHashes"]["game.json"], hashlib.sha256(orig).hexdigest())
        code, _, err = self.cli("approve", "--candidate", cid)
        self.assertEqual(code, 1)
        self.assertIn("pack changed", err)

    def test_propose_stops_without_writing_when_a_stream_starts(self):
        self.flag()
        self.banner_sessions()
        states = iter([False, True])
        with mock.patch.object(pt, "worker_wanted", side_effect=lambda *_: next(states, True)):
            code, _, err = self.cli("propose")
        self.assertEqual(code, 1)
        self.assertIn("stream", err)
        self.assertEqual(self.candidates(), [])
        self.assertFalse(os.path.exists(os.path.join(self.pack, "local", "candidates", pt.LAST_RUN)))
