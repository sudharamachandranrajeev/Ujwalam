# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 live clipping worker (services/clip/live_worker.py): BMP read, host RPC link, save path. No OCR runs here."""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import live_worker as lw  # noqa: E402

try:
    import numpy  # noqa: F401
    HAVE_NP = True
except ImportError:  # CI's plain Python has no OCR venv packages
    HAVE_NP = False


def write_bmp(path, w, h, bgra=(10, 20, 30, 255)):
    head = bytearray(54)
    head[0:2] = b"BM"
    head[2:6] = (54 + w * h * 4).to_bytes(4, "little")
    head[10:14] = (54).to_bytes(4, "little")
    head[14:18] = (40).to_bytes(4, "little")
    head[18:22] = w.to_bytes(4, "little", signed=True)
    head[22:26] = (-h).to_bytes(4, "little", signed=True)  # top-down
    head[26:28] = (1).to_bytes(2, "little")
    head[28:30] = (32).to_bytes(2, "little")
    with open(path, "wb") as f:
        f.write(bytes(head) + bytes(bgra) * (w * h))


class FakeHost(BaseHTTPRequestHandler):
    calls = []
    token = "t0k"

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n))
        FakeHost.calls.append((req["method"], req["params"], self.headers.get("Authorization")))
        if self.headers.get("Authorization") != f"Bearer {FakeHost.token}":
            doc = {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32001, "message": "unauthorized"}}
        elif req["method"] == "replay.save":
            doc = {"jsonrpc": "2.0", "id": req["id"], "result": {
                "saved": [{"canvas": "h", "path": "C:/r/h.mkv"}, {"canvas": "v", "path": "C:/r/v.mkv"}], "errors": []}}
        else:
            doc = {"jsonrpc": "2.0", "id": req["id"], "result": {"ok": True}}
        body = json.dumps(doc).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class LiveWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), FakeHost)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.disc = os.path.join(self.tmp.name, "host.json")
        with open(self.disc, "w", encoding="utf-8") as f:
            json.dump({"port": self.srv.server_address[1]}, f)
        FakeHost.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    @unittest.skipUnless(HAVE_NP, "needs numpy (OCR venv)")
    def test_read_bmp_top_down_bgra_to_bgr(self):
        p = os.path.join(self.tmp.name, "f.bmp")
        write_bmp(p, 4, 3)
        img = lw.read_bmp(p)
        self.assertEqual(img.shape, (3, 4, 3))
        self.assertEqual(img[2, 3].tolist(), [10, 20, 30])

    @unittest.skipUnless(HAVE_NP, "needs numpy (OCR venv)")
    def test_read_bmp_rejects_other_files(self):
        p = os.path.join(self.tmp.name, "x.bmp")
        with open(p, "wb") as f:
            f.write(b"not an image" * 10)
        with self.assertRaises(cc.ClipError):
            lw.read_bmp(p)

    def test_host_link_sends_bearer_and_maps_errors(self):
        ok = lw.HostLink(self.disc, FakeHost.token)
        self.assertEqual(ok.call("host.status"), {"ok": True})
        self.assertEqual(FakeHost.calls[-1][2], f"Bearer {FakeHost.token}")
        with self.assertRaises(cc.ClipError) as e:
            lw.HostLink(self.disc, "wrong").call("host.status")
        self.assertIn("-32001", str(e.exception))
        self.assertNotIn("wrong", str(e.exception), "token never in errors")

    def test_save_calls_replay_then_marker_and_writes_sidecar(self):
        w = lw.Worker.__new__(lw.Worker)
        now = [1000.0]
        w.host, w.clock, w.log = lw.HostLink(self.disc, FakeHost.token), lambda: now[0], lambda *a: None
        w.out, w.stats = os.path.join(self.tmp.name, "s"), {"saves": 0}
        row = w._save({"reason": "quiet", "score": 7, "labels": ["Triple Kill", "Fury Kill"],
                       "start": 960.0, "end": 990.0, "at": 1000.0})
        self.assertEqual([c[0] for c in FakeHost.calls], ["replay.save", "marker.add"])
        self.assertEqual(FakeHost.calls[1][1]["source"], "clip")
        self.assertEqual((row["startBack"], row["endBack"]), (40.0, 10.0))
        self.assertEqual([f["canvas"] for f in row["files"]], ["h", "v"])
        with open(os.path.join(w.out, "saves.jsonl"), encoding="utf-8") as f:
            self.assertEqual(json.loads(f.readline())["labels"], ["Triple Kill", "Fury Kill"])

    def test_missing_env_exits_64(self):
        env = {k: os.environ.pop(k) for k in (lw.CLIPS_ENV, lw.DISCOVERY_ENV) if k in os.environ}
        try:
            self.assertEqual(lw.main(["--layer", "x", "--data-dir", self.tmp.name]), 64)
        finally:
            os.environ.update(env)


if __name__ == "__main__":
    unittest.main()


class MergeSavesTests(unittest.TestCase):
    def test_overlapping_saves_merge_into_the_later_file(self):
        import clipper
        rows = [
            {"at": "2026-11-07T10:00:30Z", "startBack": 30, "endBack": 10, "score": 3, "labels": ["Triple Kill"],
             "reason": "quiet", "files": [{"canvas": "h", "path": "h1"}, {"canvas": "v", "path": "v1"}]},
            {"at": "2026-11-07T10:00:45Z", "startBack": 30, "endBack": 5, "score": 4, "labels": ["Fury Kill"],
             "reason": "death", "files": [{"canvas": "v", "path": "v2"}]},
            {"at": "2026-11-07T10:05:00Z", "startBack": 20, "endBack": 3, "score": 5, "labels": ["Frenzy Kill"],
             "reason": "quiet", "files": [{"canvas": "V", "path": "v3"}]},  # the host writes upper case
            {"at": "2026-11-07T10:06:00Z", "startBack": 20, "endBack": 3, "score": 5, "labels": [], "reason": "quiet",
             "files": [{"canvas": "v", "path": "missing"}]},
        ]
        clips = clipper.merge_saves(rows, {"v1": 60.0, "v2": 60.0, "v3": 60.0})
        self.assertEqual(len(clips), 2)
        a, b = clips
        self.assertEqual((a["file"], a["start"], a["end"], a["score"]), ("v2", 15.0, 55.0, 7))
        self.assertEqual(a["labels"], ["Triple Kill", "Fury Kill"])
        self.assertEqual((b["file"], b["start"], b["end"]), ("v3", 40.0, 57.0))
