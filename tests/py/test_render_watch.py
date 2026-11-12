# SPDX-License-Identifier: GPL-3.0-or-later
"""Render stall watch (2026-11-12: an NVENC montage render hung for 30 min after a GPU driver reset and the whole
montage step was lost): clip_common.run_tool stops a child whose output stops growing; clipper._render_job tries a
failed, stalled or timed-out GPU render once more on the CPU encoder and never raises on a timeout. No ffmpeg needed:
the children are small Python scripts."""

import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clipper  # noqa: E402

PY = sys.executable


def script(body):
    return [PY, "-I", "-c", body]


class RunToolWatchTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-watch-")

    def test_a_child_that_stops_writing_is_stopped(self):
        body = ("import time\nf=open('out.part','wb')\nf.write(b'x'*10); f.flush()\ntime.sleep(60)")
        t0 = time.monotonic()
        r = cc.run_tool(script(body), cwd=self.dir, timeout=120, watch="out.part", stall_sec=1.5, poll_sec=0.2)
        self.assertLess(time.monotonic() - t0, 20)
        self.assertEqual(r.returncode, cc.STALLED_RC)
        self.assertIn("stalled", r.stderr)

    def test_a_child_that_keeps_writing_finishes(self):
        body = ("import time,sys\nf=open('out.part','wb')\n"
                "for i in range(8):\n f.write(b'x'*10); f.flush(); time.sleep(0.25)\n"
                "print('done'); sys.stderr.write('note')")
        r = cc.run_tool(script(body), cwd=self.dir, timeout=60, watch="out.part", stall_sec=1.0, poll_sec=0.1)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("done", r.stdout)
        self.assertIn("note", r.stderr)

    def test_no_output_at_all_counts_from_the_start(self):
        r = cc.run_tool(script("import time; time.sleep(60)"), cwd=self.dir, timeout=120, watch="out.part",
                        stall_sec=1.0, poll_sec=0.2)
        self.assertEqual(r.returncode, cc.STALLED_RC)

    def test_the_timeout_still_raises(self):
        body = ("import time\nf=open('out.part','wb')\nwhile True:\n f.write(b'x'); f.flush(); time.sleep(0.1)")
        with self.assertRaises(subprocess.TimeoutExpired):
            cc.run_tool(script(body), cwd=self.dir, timeout=1.0, watch="out.part", stall_sec=30, poll_sec=0.2)

    def test_without_watch_it_is_the_plain_call(self):
        r = cc.run_tool(script("print('hi')"), cwd=self.dir, timeout=30)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "hi"))


class RenderJobTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-job-")
        self.saved = clipper.rnd.run_tool
        self.calls = []

    def tearDown(self):
        clipper.rnd.run_tool = self.saved

    def fake(self, results):
        def run_tool(argv, **kw):
            self.calls.append((argv[0], kw.get("watch"), kw.get("stall_sec")))
            res = results.pop(0)
            if isinstance(res, Exception):
                raise res
            with open(os.path.join(self.dir, "a.mp4.part"), "wb") as f:
                f.write(b"partial")
            return subprocess.CompletedProcess(argv, res, "", "boom" if res else "")
        clipper.rnd.run_tool = run_tool

    def test_a_stalled_gpu_render_is_tried_once_on_the_cpu(self):
        self.fake([cc.STALLED_RC, 0])
        r, enc = clipper._render_job(lambda e: [e], "h264_nvenc", self.dir, "a.mp4.part", "montage X")
        self.assertEqual((r.returncode, enc), (0, clipper.CPU_ENCODER))
        self.assertEqual([c[0] for c in self.calls], ["h264_nvenc", clipper.CPU_ENCODER])
        self.assertEqual(self.calls[0][1:], ("a.mp4.part", clipper.RENDER_STALL_SEC))

    def test_a_timeout_never_raises_and_falls_back(self):
        self.fake([subprocess.TimeoutExpired(["x"], 1800), 0])
        r, enc = clipper._render_job(lambda e: [e], "h264_nvenc", self.dir, "a.mp4.part", "montage X")
        self.assertEqual((r.returncode, enc), (0, clipper.CPU_ENCODER))

    def test_a_cpu_render_is_not_retried(self):
        self.fake([1])
        r, enc = clipper._render_job(lambda e: [e], clipper.CPU_ENCODER, self.dir, "a.mp4.part", "render L01")
        self.assertEqual((r.returncode, enc, len(self.calls)), (1, clipper.CPU_ENCODER, 1))

    def test_both_failing_gives_the_failure(self):
        self.fake([1, cc.STALLED_RC])
        r, _ = clipper._render_job(lambda e: [e], "h264_nvenc", self.dir, "a.mp4.part", "render L01")
        self.assertEqual(r.returncode, cc.STALLED_RC)


if __name__ == "__main__":
    unittest.main()
