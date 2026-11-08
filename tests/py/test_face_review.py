# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for the face AI review fixes (D295 second-opinion security review): models loaded only from verified
bytes (size + SHA-256, external .data too), the link key and owner check, the mask-valid flag and mask seq, the
target generation (echo + temporal reset), the worker's stdin control channel, and the capped model download.

Synthetic data only: tiny ONNX graphs written byte by byte below (no model download), a plain memory buffer for the
link, fake HTTP responses. No camera, no network, no face image.

  .venv-gpu\\Scripts\\python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_face*.py" -v
"""

import ctypes
import hashlib
import io
import os
import struct
import sys
import tempfile
import threading
import unittest
import zipfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_FACE = os.path.abspath(os.path.join(_HERE, "..", "..", "services", "face"))
sys.path.insert(0, _FACE)

try:
    import cv2  # noqa: F401
    import numpy as np
    HAVE = True
except ImportError:  # system Python without numpy / OpenCV
    HAVE = False

try:
    import onnxruntime  # noqa: F401
    HAVE_ORT = HAVE
except ImportError:
    HAVE_ORT = False

import fetch_models as fm_fetch  # stdlib only

if HAVE:
    import face_link as fl
    import face_models as fm
    import face_worker as fw


# --- a minimal ONNX protobuf writer (Y = X + W), enough to prove the loaders take bytes -----------------------------

def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _vi(field, n):
    return _varint(field << 3) + _varint(n)


def _ld(field, b):
    b = b.encode() if isinstance(b, str) else b
    return _varint(field << 3 | 2) + _varint(len(b)) + b


def tiny_onnx(w=2.5, external=None):
    """ModelProto for Y = X + W (float[1]). external: the file name W lives in (4 bytes at offset 0); else inline."""
    shape = _ld(2, _ld(1, _vi(1, 1)))
    ttype = _ld(1, _vi(1, 1) + shape)

    def value(name):
        return _ld(1, name) + _ld(2, ttype)

    tensor = _vi(1, 1) + _vi(2, 1) + _ld(8, "W")
    if external:
        tensor += (_ld(13, _ld(1, "location") + _ld(2, external)) + _ld(13, _ld(1, "offset") + _ld(2, "0"))
                   + _ld(13, _ld(1, "length") + _ld(2, "4")) + _vi(14, 1))
    else:
        tensor += _ld(9, struct.pack("<f", w))
    node = _ld(1, "X") + _ld(1, "W") + _ld(2, "Y") + _ld(3, "add") + _ld(4, "Add")
    graph = _ld(1, node) + _ld(2, "g") + _ld(5, tensor) + _ld(11, value("X")) + _ld(12, value("Y"))
    return _vi(1, 8) + _ld(8, _ld(1, "") + _vi(2, 13)) + _ld(7, graph)


def entry(mid, files):
    """Manifest entry for files {name: bytes}; the first is the model, the rest its `extra` files."""
    names = list(files)
    sha = {n: hashlib.sha256(files[n]).hexdigest() for n in names}
    m = {"id": mid, "role": "face-landmarks", "file": names[0], "bytes": len(files[names[0]]), "sha256": sha[names[0]]}
    if len(names) > 1:
        m["extra"] = [{"file": n, "bytes": len(files[n]), "sha256": sha[n]} for n in names[1:]]
    return m


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class ModelIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, files):
        for n, b in files.items():
            with open(os.path.join(self.dir, n), "wb") as f:
                f.write(b)

    def test_verified_bytes_accepts_exact_and_rejects_changed_files(self):
        files = {"m.onnx": b"model-bytes", "m.data": b"weights" * 10}
        models = {"x": entry("x", files)}
        self.write(files)
        got = fm.verified_bytes("x", self.dir, models)
        self.assertEqual(got, files)
        self.write({"m.data": b"weightz" * 10})  # same size, other bytes: the external .data is checked too
        with self.assertRaises(fm.ModelIntegrityError):
            fm.verified_bytes("x", self.dir, models)
        self.write({"m.data": b"weights" * 10, "m.onnx": b"model-bytes!"})  # one byte longer
        with self.assertRaisesRegex(fm.ModelIntegrityError, "not 11 bytes"):
            fm.verified_bytes("x", self.dir, models)
        os.remove(os.path.join(self.dir, "m.onnx"))
        with self.assertRaises(FileNotFoundError):
            fm.verified_bytes("x", self.dir, models)

    @unittest.skipUnless(HAVE_ORT, "onnxruntime not installed")
    def test_session_runs_from_verified_bytes_with_external_data(self):
        files = {"t.onnx": tiny_onnx(external="t.data"), "t.data": struct.pack("<f", 2.5)}
        models = {"t": entry("t", files)}
        self.write(files)
        sess = fm.session("t", gpu=False, models_dir=self.dir, models=models)
        y = sess.run(None, {"X": np.array([1.0], np.float32)})[0]
        self.assertAlmostEqual(float(y[0]), 3.5)
        self.write({"t.data": struct.pack("<f", 9.0)})  # weights swapped after the manifest was made
        with self.assertRaises(fm.ModelIntegrityError):
            fm.session("t", gpu=False, models_dir=self.dir, models=models)

    def test_session_and_detector_never_load_a_tampered_file(self):
        files = {"y.onnx": tiny_onnx()}
        models = {"yunet": entry("yunet", files), "t": entry("t", files)}
        self.write(files)
        det = fm.yunet_detector(self.dir, models)  # the buffer overload of FaceDetectorYN.create builds from bytes
        self.assertIsNotNone(det)
        self.write({"y.onnx": tiny_onnx(w=7.5)})  # same size, other weights
        with self.assertRaises(fm.ModelIntegrityError):
            fm.yunet_detector(self.dir, models)
        if HAVE_ORT:
            with self.assertRaises(fm.ModelIntegrityError):
                fm.session("t", gpu=False, models_dir=self.dir, models=models)


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class LinkReviewTests(unittest.TestCase):
    KEY = bytes(range(32))

    def setUp(self):
        self.mem = (ctypes.c_ubyte * fl.TOTAL)()
        self.link = fl.Link(ctypes.addressof(self.mem), None, None)
        self.mv = memoryview(self.mem).cast("B")

    def put(self, fmt, off, v):
        struct.pack_into(fmt, self.mv, off, v)

    def get(self, fmt, off):
        return struct.unpack_from(fmt, self.mv, off)[0]

    def host_header(self, key=KEY, version=None):
        # version=None means fl.VERSION; a default of fl.VERSION would be evaluated when the class is built, which
        # fails on a system Python without numpy (fl is then not imported and the class is skipped).
        version = fl.VERSION if version is None else version
        self.put("<I", 0, fl.MAGIC)
        self.put("<I", 4, version)
        self.put("<I", 8, fl.TOTAL)
        self.mv[fl.KEY_OFF:fl.KEY_OFF + 32] = key

    def test_key_must_match(self):
        self.host_header()
        self.assertTrue(self.link.header_ok(self.KEY))
        self.assertFalse(self.link.header_ok(bytes(32)), "a wrong key is refused")
        self.host_header(version=1)
        self.assertFalse(self.link.header_ok(self.KEY), "the old unkeyed layout is refused")
        self.assertIsNone(fl.Link.open(1, None), "no key: never opens")
        self.assertIsNone(fl.Link.open(1, b"short"), "a short key: never opens")

    def test_open_refuses_a_squatted_mapping_with_another_key(self):
        """A real named mapping made by 'someone else' under a host name, with a different key: open() refuses it."""
        if os.name != "nt":
            self.skipTest("Windows file mappings")
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateFileMappingW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
                                         ctypes.c_uint32, ctypes.c_wchar_p]
        k.CreateFileMappingW.restype = ctypes.c_void_p
        k.MapViewOfFile.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_size_t]
        k.MapViewOfFile.restype = ctypes.c_void_p
        k.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        fake_pid = 0x7FFF0000 + (os.getpid() & 0xFFFF)  # no real host has this pid
        h = k.CreateFileMappingW(ctypes.c_void_p(-1), None, 0x04, 0, fl.TOTAL, fl.link_name(fake_pid))
        self.assertTrue(h)
        v = k.MapViewOfFile(h, 0x0006, 0, 0, fl.TOTAL)
        try:
            buf = (ctypes.c_ubyte * fl.TOTAL).from_address(v)
            struct.pack_into("<III", buf, 0, fl.MAGIC, fl.VERSION, fl.TOTAL)
            buf[fl.KEY_OFF:fl.KEY_OFF + 32] = list(bytes(32))
            self.assertIsNone(fl.Link.open(fake_pid, self.KEY), "squatted mapping with another key: refused")
            buf[fl.KEY_OFF:fl.KEY_OFF + 32] = list(self.KEY)
            link = fl.Link.open(fake_pid, self.KEY)  # same owner (this test), right key: opens
            self.assertIsNotNone(link)
            link.close()
        finally:
            k.UnmapViewOfFile(v)
            k.CloseHandle(h)

    def test_mask_valid_flag_and_mask_seq(self):
        mask = np.full((36, 64), 200, np.uint8)
        self.link.write_result(9, 1, mask, None, gen=4)
        self.assertEqual((self.get("<I", 240), self.get("<Q", 248), self.get("<I", 244)), (1, 1, 4))
        self.link.write_result(10, 2, None, None, gen=4)  # no mask: flagged invalid, mask seq unchanged
        self.assertEqual((self.get("<I", 240), self.get("<Q", 248)), (0, 1))
        self.assertEqual(self.get("<Q", 144), 2, "the result seq still advances")
        self.link.write_result(11, 3, mask, None, gen=4)
        self.assertEqual((self.get("<I", 240), self.get("<Q", 248)), (1, 2))
        self.assertEqual(self.get("<I", 128) % 2, 0)
        with self.assertRaises(ValueError):
            self.link.write_result(12, 4, None, np.zeros((400, 3), np.float32))  # never a partial landmark set

    def test_read_frame_returns_the_generation(self):
        self.put("<I", 20, 4)
        self.put("<I", 24, 2)
        self.put("<I", 28, 16)
        self.put("<Q", 32, 3)
        self.put("<I", 76, 7)
        got = self.link.read_frame(0)
        self.assertEqual((got.seq, got.gen, got.px.shape), (3, 7, (2, 4, 4)))

    def test_host_alive_rejects_future_heartbeats(self):
        self.put("<q", 64, fl.now_ms())
        self.assertTrue(self.link.host_alive())
        self.put("<q", 64, fl.now_ms() + 3_600_000)
        self.assertFalse(self.link.host_alive())
        self.put("<q", 64, -(1 << 62))
        self.assertFalse(self.link.host_alive())

    def test_parse_key(self):
        self.assertEqual(fl.parse_key("ab" * 32), bytes([0xAB]) * 32)
        for bad in ("AB" * 32, "ab" * 31, "zz" * 32, None, 5):
            self.assertIsNone(fl.parse_key(bad))


class _FakeLink:
    """Hands out queued frames; records results."""

    def __init__(self, frames, stop):
        self.frames, self.stop, self.results, self.closed = list(frames), stop, [], False

    def heartbeat(self):
        pass

    def host_alive(self):
        return True

    def want(self):
        return fl.WANT_MASK

    def smoothing(self):
        return 0.0

    def read_frame(self, last):
        if not self.frames:
            self.stop.set()
            return None
        return self.frames.pop(0)

    def write_result(self, seq, ts, mask, lm, box, score, feats, ms, status, gen):
        self.results.append((seq, gen))

    def close(self):
        self.closed = True


class _FakePipe:
    def __init__(self):
        self.resets = 0

    def reset_temporal(self):
        self.resets += 1

    def unload(self):
        pass

    def unload_idle(self):
        pass

    def run(self, px, want, smoothing):
        return {"mask": None, "landmarks": None, "box": None, "score": 0.0, "feats": None, "status": 0}


@unittest.skipUnless(HAVE, "numpy / OpenCV not installed (use .venv-gpu)")
class WorkerReviewTests(unittest.TestCase):
    def setUp(self):
        self._flag = fw.flag_on
        fw.flag_on = lambda d: True

    def tearDown(self):
        fw.flag_on = self._flag

    def args(self):
        return fw.argparse.Namespace(data_dir="", seg_model="selfie-landscape", cpu=True)

    def test_control_lines(self):
        c = fw.Control()
        self.assertFalse(c.feed("not json"))
        self.assertFalse(c.feed('{"hostPid": 5, "key": "short"}'))
        self.assertFalse(c.feed('{"hostPid": true, "key": "%s"}' % ("ab" * 32)))
        self.assertFalse(c.feed('{"hostPid": 0, "key": "%s"}' % ("ab" * 32)))
        self.assertEqual(c.target(), (0, None))
        self.assertTrue(c.feed('{"hostPid": 42, "key": "%s"}' % ("ab" * 32)))
        self.assertEqual(c.target(), (42, bytes([0xAB]) * 32))

    def test_watch_parent_reads_the_key_and_sees_eof(self):
        line = ('{"hostPid": 7, "key": "%s"}\n' % ("cd" * 32)).encode()
        ctl = fw.watch_parent(stdin=io.BytesIO(b"garbage\n" + line), env={"UJWALAM_PARENT_PIPE": "1"}, wait=2.0)
        self.assertTrue(ctl.gone.wait(2.0))
        self.assertEqual(ctl.target(), (7, bytes([0xCD]) * 32))
        off = fw.watch_parent(stdin=io.BytesIO(line), env={})
        self.assertEqual(off.target(), (0, None), "without the parent-pipe marker stdin is not read")
        self.assertFalse(off.gone.is_set())

    def test_generation_change_resets_temporal_state_and_is_echoed(self):
        stop = threading.Event()
        px = np.zeros((2, 2, 4), np.uint8)
        frames = [fl.Frame(1, 0, px, (2, 2), 5), fl.Frame(2, 0, px, (2, 2), 5), fl.Frame(3, 0, px, (2, 2), 6),
                  fl.Frame(4, 0, px, (2, 2), 6)]
        link = _FakeLink(frames, stop)
        pipe = _FakePipe()
        ctl = fw.Control()
        ctl.feed('{"hostPid": 9, "key": "%s"}' % ("11" * 32))
        opened = []

        def open_link(pid, key):
            opened.append((pid, key))
            return link

        fw.serve(self.args(), ctl, pipe=pipe, stop=stop.is_set, open_link=open_link)
        self.assertEqual(opened, [(9, bytes([0x11]) * 32)])
        self.assertEqual(link.results, [(1, 5), (2, 5), (3, 6), (4, 6)], "every result echoes its frame's generation")
        self.assertEqual(pipe.resets, 2, "reset at the first frame on the link and at the camera change")

    def test_host_restart_reopens_the_link(self):
        stop = threading.Event()
        px = np.zeros((2, 2, 4), np.uint8)
        ctl = fw.Control()
        ctl.feed('{"hostPid": 1, "key": "%s"}' % ("22" * 32))
        links = []

        class L(_FakeLink):
            def read_frame(self, last):
                if len(links) == 1:  # the launcher restarted the host: a new control line
                    ctl.feed('{"hostPid": 2, "key": "%s"}' % ("22" * 32))
                    return fl.Frame(1, 0, px, (2, 2), 1)
                stop.set()
                return None

        def open_link(pid, key):
            links.append(pid)
            return L([], stop)

        fw.serve(self.args(), ctl, pipe=_FakePipe(), stop=stop.is_set, open_link=open_link)
        self.assertEqual(links, [1, 2])


class _Resp(io.BytesIO):
    def __init__(self, data, length=None):
        super().__init__(data)
        self.headers = {} if length is None else {"Content-Length": str(length)}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class FetchCapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_download_stops_at_the_manifest_size_and_deletes_the_partial_file(self):
        dst = os.path.join(self.tmp.name, "m.onnx")
        reads = []

        class Endless(_Resp):
            def read(self, n=-1):
                reads.append(n)
                return b"x" * n

        with self.assertRaises(fm_fetch.TooLarge):
            fm_fetch.download("https://example.invalid/m", dst, 1000, "0" * 64, opener=lambda r, timeout: Endless(b""))
        self.assertFalse(os.path.exists(dst), "the partial file is deleted")
        self.assertLessEqual(sum(reads), 1001, "aborted as soon as one byte too many arrived")

    def test_announced_length_over_the_cap_is_not_downloaded(self):
        dst = os.path.join(self.tmp.name, "m.onnx")
        with self.assertRaises(fm_fetch.TooLarge):
            fm_fetch.download("https://example.invalid/m", dst, 10, "0" * 64,
                              opener=lambda r, timeout: _Resp(b"x" * 5, length=10 ** 9))
        self.assertFalse(os.path.exists(dst))

    def test_exact_download_passes(self):
        data = b"model" * 20
        dst = os.path.join(self.tmp.name, "m.onnx")
        fm_fetch.download("https://example.invalid/m", dst, len(data), hashlib.sha256(data).hexdigest(),
                          opener=lambda r, timeout: _Resp(data, length=len(data)))
        with open(dst, "rb") as f:
            self.assertEqual(f.read(), data)

    def test_archive_member_larger_than_the_manifest_is_refused(self):
        big = b"y" * 5000
        zbuf = io.BytesIO()
        with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("pkg/a.onnx", big)
        zbytes = zbuf.getvalue()
        m = {"id": "z", "file": "a.onnx", "bytes": 100, "sha256": "0" * 64,
             "archive": {"url": "https://example.invalid/z.zip", "bytes": len(zbytes),
                         "sha256": hashlib.sha256(zbytes).hexdigest(), "members": {"pkg/a.onnx": "a.onnx"}}}
        orig = fm_fetch.urllib.request.urlopen
        fm_fetch.urllib.request.urlopen = lambda r, timeout: _Resp(zbytes, length=len(zbytes))
        try:
            out = os.path.join(self.tmp.name, "models")
            with self.assertRaises(fm_fetch.TooLarge):
                fm_fetch.fetch(m, out, log=lambda s: None)
            self.assertFalse(os.path.exists(os.path.join(out, "a.onnx")))
        finally:
            fm_fetch.urllib.request.urlopen = orig

    def test_copy_capped(self):
        dst = os.path.join(self.tmp.name, "c")
        self.assertEqual(fm_fetch.copy_capped(io.BytesIO(b"abc"), dst, 3, "c"), 3)
        with self.assertRaises(fm_fetch.TooLarge):
            fm_fetch.copy_capped(io.BytesIO(b"abcd"), dst, 3, "c")
        self.assertFalse(os.path.exists(dst))


if __name__ == "__main__":
    unittest.main()
