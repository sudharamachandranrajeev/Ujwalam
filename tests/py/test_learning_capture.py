# SPDX-License-Identifier: GPL-3.0-or-later
"""LL1 + LL3 (D340): services/clip/learning_capture.py and its hooks in live_worker.py and clipper.py live-review.
Synthetic rows and placeholder texts only; temp folders; no OCR, no GPU, no network."""

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "services", "clip"))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import game_pack  # noqa: E402
import learning_capture as lc  # noqa: E402
import live_worker as lw  # noqa: E402
import match_gate as mg  # noqa: E402

PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))


def pack_with(min_conf):
    p = dict(PACK)
    p["ocr"] = dict(PACK["ocr"], minConfidence=min_conf)
    return p


def hit(det, label, signal=True, score=0.95, **kw):
    return {"detector": det, "label": label, "role": "positive", "signal": signal, "why": [] if signal else ["x"],
            "clipReason": True, "weight": None, "detectorStatus": "unverified", "mode": "mp", "ocrScore": score, **kw}


BOXES = [{"text": "PLACEHOLDER TEXT", "score": 0.91, "g": [0.1, 0.1, 0.2, 0.2]}]


def wait_idle(cap, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cap.q.unfinished_tasks == 0:
            return
        time.sleep(0.01)
    raise AssertionError("writer thread did not finish")


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


class ReviewReadsTests(unittest.TestCase):
    def test_thresholds_come_from_the_pack_only(self):
        self.assertIsNone(PACK["ocr"]["minConfidence"], "codm game.json ocr.minConfidence is null today")
        self.assertIsNone(lc.ocr_threshold(PACK))
        self.assertEqual(lc.ocr_threshold(pack_with(0.6)), 0.6)
        for bad in (0, 1.5, True, "0.5", None):
            self.assertIsNone(lc.ocr_threshold(pack_with(bad)))
        self.assertEqual(lc.banner_kinds(PACK), ["round", "match"])

    def test_unclassified_banner_and_ocr_low(self):
        kinds = lc.banner_kinds(PACK)
        rows = [hit("W1", "VICTORY", banner=None, subtitle=None), hit("W1", "DEFEAT", banner="round", subtitle=None),
                hit("M3", "PLACEHOLDER MEDAL", score=0.41), hit("M3", "OTHER MEDAL", signal=False, score=0.2)]
        got = lc.review_reads(rows, None, kinds)
        self.assertEqual([(g["kind"], g["label"]) for g in got], [("unclassified-banner", "VICTORY")])
        self.assertEqual(got[0]["choices"], ["round", "match", lc.NOT_A_BANNER])
        got = lc.review_reads(rows, 0.5, kinds)
        self.assertEqual([(g["kind"], g["label"]) for g in got],
                         [("unclassified-banner", "VICTORY"), ("ocr-low", "PLACEHOLDER MEDAL")])
        low = got[1]
        self.assertEqual((low["threshold"], low["value"], low["choices"]), (0.5, "PLACEHOLDER MEDAL", ["PLACEHOLDER MEDAL", lc.WRONG_READ]))

    def test_mode_choices_are_the_packs_modes(self):
        ch = lc.mode_choices(mg.stats_config(PACK))
        self.assertIn("search and destroy", ch)
        self.assertIn("hardpoint", ch)
        self.assertEqual(ch, sorted(set(ch)))

    def test_session_id_like_store_mjs(self):
        self.assertEqual(lc.session_id("live-20261111-120000"), "live-20261111-120000")
        self.assertEqual(lc.session_id("../x y"), "x_y")
        self.assertEqual(lc.session_id("..."), "")


class LiveCaptureTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.logs = []

    def tearDown(self):
        self.td.cleanup()

    def cap(self, pack=PACK, **kw):
        kw.setdefault("encode", lambda img: b"\xff\xd8JPEGFAKE\xff\xd9")
        c = lc.LiveCapture(self.td.name, "live-20261111-120000", pack, self.logs.append, **kw)
        self.addCleanup(c.close)
        return c

    def sdir(self):
        return os.path.join(self.td.name, lc.STORE_DIR, "live-20261111-120000")

    def test_evidence_and_review_items_are_written(self):
        c = self.cap(pack_with(0.5))
        banner = hit("W1", "VICTORY", banner=None, subtitle=None)
        c.frame(1.0, "IMG", [hit("M3", "PLACEHOLDER MEDAL")], BOXES, "mp", True)
        c.frame(2.0, "IMG", [hit("M3", "PLACEHOLDER MEDAL")], BOXES, "mp", False)  # unchanged frame: nothing new
        c.frame(3.0, "IMG", [banner], BOXES, "mp", True)
        c.frame(4.0, "IMG", [banner], BOXES, "mp", True)  # same banner still on screen: no second item
        c.frame(5.0, "IMG", [], [], "mp", True)
        c.frame(6.0, "IMG", [banner, hit("M3", "PLACEHOLDER MEDAL", score=0.3)], BOXES, None, True)
        c.frame(7.0, "IMG", [], [], None, True)  # no hits: no evidence row
        wait_idle(c)
        ev = read_jsonl(os.path.join(self.sdir(), lc.EVIDENCE))
        self.assertEqual([e["t"] for e in ev], [1.0, 3.0, 4.0, 6.0])
        self.assertEqual(ev[0]["texts"], BOXES)
        self.assertNotIn("t", ev[0]["hits"][0])
        items = read_jsonl(os.path.join(self.sdir(), lc.REVIEW))
        self.assertEqual([(i["id"], i["kind"], i["t"]) for i in items],
                         [("live-00001", "unclassified-banner", 3.0), ("live-00002", "unclassified-banner", 6.0),
                          ("live-00003", "ocr-low", 6.0)])
        self.assertEqual(items[0]["frame"], "frames/live-00001.jpg")
        self.assertTrue(os.path.isfile(os.path.join(self.sdir(), "frames", "live-00001.jpg")))
        frames = os.listdir(os.path.join(self.sdir(), "frames"))
        self.assertEqual(len(frames), 3, "frames only for review items")
        with open(os.path.join(self.sdir(), lc.SESSION_META), encoding="utf-8") as f:
            meta = json.load(f)
        self.assertEqual(meta["v"], 1)
        self.assertEqual(c.stats["dropped"], 0)

    def test_no_threshold_no_ocr_low_items(self):
        c = self.cap()
        c.frame(1.0, "IMG", [hit("M3", "PLACEHOLDER MEDAL", score=0.01)], BOXES, "mp", True)
        wait_idle(c)
        self.assertFalse(os.path.exists(os.path.join(self.sdir(), lc.REVIEW)))

    def test_a_busy_writer_drops_items_and_never_blocks(self):
        gate = threading.Event()

        def slow(img):
            gate.wait(5)
            return b"x"
        c = self.cap(max_queue=1, encode=slow)
        t0 = time.monotonic()
        for i in range(20):  # every frame a new banner appearance (a no-hit frame in between)
            c.frame(float(2 * i), "IMG", [hit("W1", "VICTORY", banner=None, subtitle=None)], BOXES, "mp", True)
            c.frame(float(2 * i + 1), "IMG", [], [], "mp", True)
        self.assertLess(time.monotonic() - t0, 1.0, "frame() never waits for the writer")
        gate.set()
        wait_idle(c)
        self.assertGreater(c.stats["dropped"], 0)
        self.assertTrue(any("writer busy" in x for x in self.logs))

    def test_a_failed_write_drops_the_item_and_logs(self):
        c = self.cap()
        os.makedirs(os.path.dirname(self.sdir()), exist_ok=True)
        with open(self.sdir(), "w", encoding="utf-8") as f:  # a file where the session folder should be
            f.write("x")
        c.frame(1.0, "IMG", [hit("W1", "VICTORY", banner=None, subtitle=None)], BOXES, "mp", True)
        wait_idle(c)
        self.assertEqual(c.stats["dropped"], 2)  # the evidence row and the item
        self.assertTrue(self.logs and self.logs[0].startswith("learning: dropped 1 item(s)"))

    def test_bad_input_never_raises(self):
        c = self.cap()
        c.frame(1.0, "IMG", [{"signal": True, "detector": "W1", "banner": None}], [{"score": "nan?"}], "mp", True)
        c.frame("not a time", "IMG", [hit("M3", "X")], BOXES, "mp", True)
        wait_idle(c)
        self.assertGreaterEqual(c.stats["dropped"], 1)

    def test_the_session_never_passes_the_cap(self):
        budget = 2000
        c = self.cap(budget=budget, encode=lambda img: b"j" * 600)
        for i in range(40):
            c.frame(float(2 * i), "IMG", [hit("W1", "VICTORY", banner=None, subtitle=None)], BOXES, "mp", True)
            c.frame(float(2 * i + 1), "IMG", [], [], "mp", True)
            wait_idle(c)
        used = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(self.sdir()) for f in fs)
        meta = os.path.getsize(os.path.join(self.sdir(), lc.SESSION_META))
        self.assertLessEqual(used - meta, budget)
        self.assertGreater(c.stats["dropped"], 0)
        self.assertTrue(any("cap" in x for x in self.logs))

    def test_ids_continue_in_an_existing_session_folder(self):
        c = self.cap()
        c.frame(1.0, "IMG", [hit("W1", "VICTORY", banner=None, subtitle=None)], BOXES, "mp", True)
        wait_idle(c)
        c.close()
        c2 = self.cap()
        c2.frame(1.0, "IMG", [hit("W1", "VICTORY", banner=None, subtitle=None)], BOXES, "mp", True)
        wait_idle(c2)
        ids = [i["id"] for i in read_jsonl(os.path.join(self.sdir(), lc.REVIEW))]
        self.assertEqual(ids, ["live-00001", "live-00002"])


class FakeScanner:
    def __init__(self, rows, fresh=True):
        self.rows, self.fresh, self.boxes, self.mode = rows, fresh, BOXES, "mp"

    def scan(self, t, img):
        return [dict(r, t=t) for r in self.rows]


class WorkerHookTests(unittest.TestCase):
    """The live worker hands each frame to the capture; the capture never changes what the clipper does."""

    def worker(self, rows, capture):
        w = lw.Worker.__new__(lw.Worker)
        w.a = SimpleNamespace(layer="g")
        w.clock = lambda: 10.0
        w.stats = {"frames": 0, "saves": 0, "errors": 0}
        w.scanner = FakeScanner(rows)
        w._scanner_for = lambda img: w.scanner
        w.chain = SimpleNamespace(step=lambda t, r: None)
        w.capture = capture
        return w

    def test_tick_feeds_the_capture(self):
        seen = []
        cap = SimpleNamespace(frame=lambda *a: seen.append(a))
        w = self.worker([hit("M3", "PLACEHOLDER MEDAL")], cap)
        self.assertIsNone(w.tick(img="IMG"))
        self.assertEqual(len(seen), 1)
        t, img, rows, boxes, mode, fresh = seen[0]
        self.assertEqual((t, img, mode, fresh, boxes), (10.0, "IMG", "mp", True, BOXES))
        self.assertEqual(rows[0]["detector"], "M3")

    def test_start_capture_writes_under_the_session(self):
        with tempfile.TemporaryDirectory() as td:
            w = self.worker([], None)
            w.a = SimpleNamespace(layer="g", data_dir=td)
            w.session, w.pack, w.log = "20261111-120000", PACK, lambda *a: None
            cap = w.start_capture()
            self.assertIsNotNone(cap)
            self.assertTrue(cap.writer.dir.endswith(os.path.join("learning-store", "live-20261111-120000")))
            cap.close()

    def test_a_store_that_cannot_open_turns_capture_off(self):
        logs = []
        w = self.worker([], None)
        w.a = SimpleNamespace(layer="g", data_dir=None)
        w.session, w.pack, w.log = "20261111-120000", PACK, logs.append
        self.assertIsNone(w.start_capture())
        self.assertIn("learning capture off", logs[0])


class UnknownModeTests(unittest.TestCase):
    def test_live_review_queues_matches_without_a_mode(self):
        import test_clip_live_review_gate as tlr
        import clipper
        g = tlr.LiveReviewGateTests("test_parser_accepts_detect_options")
        g.setUp()
        self.addCleanup(g.tearDown)
        stats = g.r("match-stats.json")  # match 2's top-3 screen shows no mode name: its mode stays unknown
        for r in stats["readings"]:
            if r.get("t") == 740:
                r["gameMode"] = None
        g.w("match-stats.json", stats)
        a = g.args("--recording", g.rec)
        frames = []
        orig = clipper.run_tool

        def fake_run(argv, cwd=None, timeout=None):  # no ffmpeg here: write the "frame" the command asks for
            frames.append(argv)
            with open(argv[-1], "wb") as f:
                f.write(b"\xff\xd8FAKE\xff\xd9")
            return SimpleNamespace(returncode=0)
        clipper.run_tool = fake_run
        clipper.find_tool = lambda name, explicit=None: "ffmpeg"
        try:
            with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
                clipper._live_matches(a)
                clipper._live_matches(a)  # a second run adds no duplicate
        finally:
            clipper.run_tool = orig
            import clip_common
            clipper.find_tool = clip_common.find_tool
        m = g.r("matches.json")["matches"]
        want = [i for i, x in enumerate(m, 1) if x["endSeen"] and not x["gameMode"]]
        self.assertTrue(want, "the fixture has matches with an end screen and no game mode")
        sdir = os.path.join(g.data, lc.STORE_DIR, "live-saves")
        items = read_jsonl(os.path.join(sdir, lc.REVIEW))
        self.assertEqual([i["match"] for i in items], want)
        self.assertEqual({i["kind"] for i in items}, {"unknown-mode"})
        self.assertIn("hardpoint", items[0]["choices"])
        self.assertEqual(items[0]["frame"], f"frames/mode-{want[0]:03d}.jpg")
        self.assertEqual(len(frames), len(want))
        self.assertIn("queued for review", out.getvalue())

    def test_failure_is_logged_never_raised(self):
        logs = []
        with tempfile.TemporaryDirectory() as td:
            n = lc.queue_unknown_modes(td, "", [{"endSeen": True, "gameMode": None}], mg.stats_config(PACK), log=logs.append)
        self.assertEqual(n, 0)
        self.assertIn("not written", logs[0])


if __name__ == "__main__":
    unittest.main()
