# SPDX-License-Identifier: GPL-2.0-or-later
"""Crash-safe capture tests for tools/capture/record.py (P2b W1).

Command-line tests (fast, always run): the device ffmpeg command is unchanged, the lavfi test
source and the codec guard.

Recording tests (real ffmpeg recordings from the lavfi test pattern + sine tone, 5 s segments,
640x360 at 30 fps; about 1 min in total): gated behind UJWALAM_CAPTURE_TESTS=1, run with
`npm run test:capture`. They need ffmpeg and ffprobe on PATH. The encoder is h264_nvenc when a
one-frame NVENC encode works, else libopenh264; the choice is printed. No encoder session limit
is assumed.

  clean stop  STOP file -> 'q' -> every segment, the last included, passes verify
  kill tree   the recorder's Python process tree is killed hard mid-segment
  kill ffmpeg only ffmpeg is killed hard mid-segment; record.py restarts it into the next
              segment index (2026-10-28) and writes a gap record; then a clean STOP
For both kills: every closed segment passes verify (ffprobe duration, streams, full decode) and
at most one segment, the one in flight, is lost or truncated. The readable seconds of the
in-flight segment are printed (KILLTEST lines) for the evidence file.

Restart-limit tests (Windows, same gate): a dshow device name that does not exist makes every
ffmpeg exit at once with an error on stderr (a broken device). With the default limit (5
restarts per 10 min) the 6th crash stops the recorder: state "failed", exit 1, a FAILED line.
An injected limit and an injected window are checked the same way; the limiter itself is
unit-tested with a fake clock (always run).
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
RECORD = os.path.join(REPO, "tools", "capture", "record.py")

spec = importlib.util.spec_from_file_location("record", RECORD)
rec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rec)

RUN = os.environ.get("UJWALAM_CAPTURE_TESTS") == "1"
HAVE_FF = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
SEG_S, FPS, SIZE = 5, 30, "640x360"


class CommandTests(unittest.TestCase):
    def test_device_command_unchanged(self):
        # the A5c device command, literally
        old = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostats",
            "-f", "dshow", "-rtbufsize", "1024M", "-video_size", "1920x1080",
            "-framerate", "60", "-pixel_format", "nv12", "-i", "video=V:audio=A",
            "-t", "3600",
            "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19",
            "-b:v", "50M", "-maxrate", "80M",
            "-force_key_frames", "expr:gte(t,n_forced*60)", "-g", "120",
            "-c:a", "aac", "-b:a", "192k",
            "-f", "segment", "-segment_time", "60", "-reset_timestamps", "1",
            "-segment_format", "mp4",
            "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof",
            "out-%03d.mp4",
        ]
        self.assertEqual(rec.ffmpeg_cmd("V", "A", "1920x1080", "out-%03d.mp4", 3600), old)

    def test_lavfi_source_is_real_ffmpeg_input(self):
        cmd = rec.ffmpeg_cmd("", "x", "640x360", "o-%03d.mp4", 30, fps=30, segment_s=5,
                             source="lavfi", vcodec="libopenh264")
        s = " ".join(cmd)
        self.assertIn("-re -f lavfi -i testsrc2=size=640x360:rate=30", s)
        self.assertIn("sine=frequency=440", s)
        self.assertIn("-segment_time 5", s)
        self.assertIn("-g 60", s)
        self.assertNotIn("dshow", s)
        self.assertIn("movflags=+frag_keyframe+empty_moov+default_base_moof", s)


class RestartLimiterTests(unittest.TestCase):
    def test_defaults_are_five_per_ten_minutes(self):
        self.assertEqual((rec.RESTART_LIMIT, rec.RESTART_WINDOW_S), (5, 600))
        lim = rec.RestartLimiter()
        self.assertEqual((lim.limit, lim.window_s), (5, 600))

    def test_sixth_crash_in_the_window_stops(self):
        t = [0.0]
        lim = rec.RestartLimiter(clock=lambda: t[0])
        results = []
        for _ in range(6):
            results.append(lim.crash())
            t[0] += 60  # one crash a minute: all 6 inside 10 min
        self.assertEqual(results, [True] * 5 + [False])

    def test_old_crashes_leave_the_window(self):
        t = [0.0]
        lim = rec.RestartLimiter(limit=2, window_s=10, clock=lambda: t[0])
        self.assertTrue(lim.crash())
        t[0] = 5
        self.assertTrue(lim.crash())
        t[0] = 11  # the crash at 0 s is out of the window
        self.assertTrue(lim.crash())
        t[0] = 12
        self.assertFalse(lim.crash())  # 5, 11, 12: three in 10 s


class RestartCommandTests(unittest.TestCase):
    def test_restart_continues_the_numbering(self):
        first = rec.ffmpeg_cmd("V", "A", "1920x1080", "out-%03d.mp4", 3600)
        again = rec.ffmpeg_cmd("V", "A", "1920x1080", "out-%03d.mp4", 3500.5, start_number=7)
        self.assertNotIn("-segment_start_number", first)
        i = again.index("-segment_start_number")
        self.assertEqual(again[i + 1], "7")
        self.assertEqual(again[again.index("-t") + 1], "3500.5")
        rest = again[:i] + again[i + 2:]
        rest[rest.index("-t") + 1] = "3600"
        self.assertEqual(rest, first)  # otherwise the same device command

    def test_segments_sort_numerically(self):
        d = tempfile.mkdtemp(prefix="ujw-rec-")
        self.addCleanup(shutil.rmtree, d, True)
        for n in ("t-999.mp4", "t-1000.mp4", "t-001.mp4", "t-x.mp4"):
            open(os.path.join(d, n), "wb").close()
        self.assertEqual([p.name for p in rec.segments(rec.pathlib.Path(d), "t")],
                         ["t-001.mp4", "t-999.mp4", "t-1000.mp4"])


def _pick_vcodec():
    r = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
                        "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
    return "h264_nvenc" if r.returncode == 0 else "libopenh264"


def _alive(pid):
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True)
        return str(pid) in r.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _kill(pid, tree):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F"] + (["/T"] if tree else []) + ["/PID", str(pid)], capture_output=True)
    else:
        import signal
        if tree:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)


@unittest.skipUnless(RUN and HAVE_FF, "set UJWALAM_CAPTURE_TESTS=1 (npm run test:capture); needs ffmpeg")
class RecordingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vcodec = _pick_vcodec()
        print(f"\nKILLTEST encoder {cls.vcodec}", file=sys.stderr, flush=True)

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-rec-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def start(self):
        kw = {}
        if os.name == "nt":
            kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kw["start_new_session"] = True
        p = subprocess.Popen([sys.executable, "-I", RECORD, "record", "--out", self.dir, "--name", "t",
                              "--source", "lavfi", "--size", SIZE, "--fps", str(FPS), "--segment-s", str(SEG_S),
                              "--max-s", "90", "--vcodec", self.vcodec],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kw)
        self.addCleanup(p.stdout.close)
        self.addCleanup(lambda: p.poll() is None and _kill(p.pid, True))
        return p

    def wait_for(self, cond, timeout, what):
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            if cond():
                return
            time.sleep(0.1)
        self.fail(f"timeout waiting for {what}")

    def seg(self, i):
        return os.path.join(self.dir, f"t-{i:03d}.mp4")

    def state(self):
        return rec.read_state(self.dir, "t")

    def verify(self):
        r = subprocess.run([sys.executable, "-I", RECORD, "verify", "--out", self.dir, "--name", "t", "--json"],
                           capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])

    def run_to_mid_segment(self):
        """Start, wait until segment 2 has been written for ~2.5 s (10 s of closed segments)."""
        p = self.start()
        self.wait_for(lambda: self.state() is not None, 15, "state file")
        self.wait_for(lambda: os.path.exists(self.seg(2)), 40, "segment 2")
        time.sleep(2.5)
        return p, time.monotonic()

    def assert_kill_result(self, label, wall_s):
        code, v = self.verify()
        rows = v["rows"]
        self.assertTrue(v["interrupted"], v)
        closed = [r for r in rows if not r["inFlight"]]
        inflight = [r for r in rows if r["inFlight"]]
        self.assertEqual(len(inflight), 1)
        for r in closed:
            self.assertTrue(r["ok"], r)
            self.assertIn("video", r["streams"])
            self.assertIn("audio", r["streams"])
        self.assertEqual(code, 0, v)
        # recorded content vs wall time: at most one segment (the one in flight) may be missing
        recorded = sum(r["seconds"] for r in rows)
        closed_s = sum(r["seconds"] for r in closed)
        lost = wall_s - recorded
        self.assertGreaterEqual(len(closed), 2)
        self.assertLessEqual(lost, SEG_S + 2.0, (wall_s, recorded))
        f = inflight[0]
        self.assertLessEqual(f["decodedFrames"], f["frames"])
        print(f"KILLTEST {label}: segments {len(rows)} ({len(closed)} closed, all pass verify); in-flight "
              f"{f['file']} {f['seconds']:.2f} s of packets ({f['frames']}), {f['decodedSeconds']:.2f} s decodable "
              f"({f['decodedFrames']} frames), ok={f['ok']} "
              f"problems={f['problems']}; closed {closed_s:.2f} s; wall ~{wall_s:.1f} s, "
              f"unrecorded ~{max(lost, 0):.1f} s (encoder {self.vcodec})", file=sys.stderr, flush=True)

    def test_clean_stop_finalises_last_segment(self):
        p = self.start()
        self.wait_for(lambda: os.path.exists(self.seg(2)), 40, "segment 2")
        time.sleep(2.0)
        open(os.path.join(self.dir, "STOP"), "w").close()
        out, _ = p.communicate(timeout=40)
        self.assertEqual(p.returncode, 0, out)
        st = self.state()
        self.assertEqual(st["state"], "stopped")
        self.assertEqual(st["ffmpegExit"], 0)
        self.assertTrue(st["stopRequested"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "STOP")))
        code, v = self.verify()
        self.assertEqual(code, 0, v)
        self.assertFalse(v["interrupted"])
        self.assertGreaterEqual(v["segments"], 3)
        for r in v["rows"]:
            self.assertTrue(r["ok"], r)
            self.assertFalse(r["inFlight"])
        last = v["rows"][-1]
        self.assertGreater(last["seconds"], 0.5)
        self.assertEqual((st["restarts"], st["gaps"], v["gaps"]), (0, 0, []))
        print(f"KILLTEST clean-stop: segments {v['segments']}, all pass verify; last {last['file']} "
              f"{last['seconds']:.2f} s finalised (encoder {self.vcodec})", file=sys.stderr, flush=True)

    def test_kill_recorder_tree_hard(self):
        p, _ = self.run_to_mid_segment()
        st = self.state()
        started = time.monotonic()
        # wall time of recorded content ~ time since the first segment file appeared
        first = os.path.getctime(self.seg(0))
        _kill(p.pid, tree=True)
        wall = time.time() - first
        p.wait(timeout=20)
        self.wait_for(lambda: not _alive(st["ffmpegPid"]), 20, "ffmpeg gone")
        self.assertEqual(self.state()["state"], "recording")  # nobody updated it: a crash
        self.assertLess(time.monotonic() - started, 30)
        self.assert_kill_result("kill-tree", wall)

    def test_kill_ffmpeg_only_restarts_into_the_next_segment(self):
        p, _ = self.run_to_mid_segment()
        st = self.state()
        old_pid = st["ffmpegPid"]
        _kill(old_pid, tree=False)
        self.wait_for(lambda: (self.state() or {}).get("restarts") == 1, 20, "restart")
        self.assertNotEqual(self.state()["ffmpegPid"], old_pid)
        self.wait_for(lambda: len(rec.read_gaps(self.dir, "t")) == 1, 30, "gap record")
        self.wait_for(lambda: os.path.exists(self.seg(4)), 30, "segment 4 from the restarted ffmpeg")
        open(os.path.join(self.dir, "STOP"), "w").close()
        out, _ = p.communicate(timeout=40)
        self.assertEqual(p.returncode, 0, out)
        self.assertIn("CRASH:", out)
        self.assertIn("RESTART 1:", out)
        st = self.state()
        self.assertEqual((st["state"], st["ffmpegExit"], st["restarts"], st["gaps"]), ("stopped", 0, 1, 1), st)
        (g,) = rec.read_gaps(self.dir, "t")
        self.assertIn("unexpectedly", g["reason"])
        self.assertNotEqual(g["exitCode"], 0)
        self.assertIsInstance(g["stderrTail"], list)
        self.assertEqual((g["afterSegment"], g["beforeSegment"]), ("t-002.mp4", "t-003.mp4"))
        self.assertLess(g["startUtc"], g["endUtc"])
        self.assertLess(g["startS"], g["endS"])
        self.assertGreater(g["durationS"], 0)
        self.assertLess(g["durationS"], 15)
        self.assertEqual(g["startSource"], "last-segment-write")
        with open(os.path.join(self.dir, "t.log"), encoding="utf-8") as f:
            log = f.read()
        self.assertIn(f"(exit code {g['exitCode']})", log)
        self.assertIn("stderr line(s) of this run:", log)
        self.assertIn("  stderr: ", log)
        self.assertIn("RESTART 1: new ffmpeg from segment 003", log)
        code, v = self.verify()
        self.assertEqual(code, 0, v)
        self.assertEqual(v["numberingHoles"], [])
        self.assertFalse(v["interrupted"])
        names = [r["file"] for r in v["rows"]]
        self.assertEqual(names, [f"t-{i:03d}.mp4" for i in range(len(names))])  # continuous numbering
        cut = [r for r in v["rows"] if r["crashTruncated"]]
        self.assertEqual([r["file"] for r in cut], ["t-002.mp4"])
        for r in v["rows"]:
            if not r["crashTruncated"]:
                self.assertTrue(r["ok"], r)
        print(f"KILLTEST kill-ffmpeg-restart: segments {len(names)} ({names[0]}..{names[-1]}, no holes), "
              f"restarts 1; gap {g['durationS']:.2f} s ({g['startS']:.2f} s .. {g['endS']:.2f} s session time), "
              f"reason '{g['reason']}', exit code {g['exitCode']}, stderr tail {len(g['stderrTail'])} line(s); "
              f"crash segment {cut[0]['file']} {cut[0]['decodedSeconds']:.2f} s decodable; "
              f"all {len(names) - 1} other segments pass verify; encoder {self.vcodec}",
              file=sys.stderr, flush=True)


@unittest.skipUnless(RUN and HAVE_FF and os.name == "nt", "set UJWALAM_CAPTURE_TESTS=1; needs ffmpeg with dshow")
class RestartLimitTests(unittest.TestCase):
    """A broken device: every ffmpeg exits at once with an error on stderr."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-lim-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def run_broken(self, *extra, timeout=90):
        t0 = time.monotonic()
        args = list(extra)
        if "--max-s" not in args:
            args += ["--max-s", "120"]
        r = subprocess.run([sys.executable, "-I", RECORD, "record", "--out", self.dir, "--name", "b",
                            "--video", "ujwalam-test-no-such-device", "--audio", "", *args],
                           capture_output=True, text=True, timeout=timeout)
        with open(os.path.join(self.dir, "b.log"), encoding="utf-8") as f:
            log = f.read()
        return r, rec.read_state(self.dir, "b"), rec.read_gaps(self.dir, "b"), log, time.monotonic() - t0

    def assert_failed(self, r, st, gaps, log, crashes, restarts):
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("FAILED: restart limit reached", r.stdout)
        self.assertEqual(st["state"], "failed")
        self.assertIn("restart limit reached", st["failReason"])
        self.assertEqual(st["restarts"], restarts)
        self.assertEqual(log.count("] CRASH "), crashes)
        self.assertEqual(log.count("] RESTART "), restarts)
        self.assertIn("Could not find video device", log)  # ffmpeg's stderr kept in the log
        self.assertEqual(len(gaps), crashes)
        for g in gaps:
            self.assertIsNone(g["endUtc"])  # no segment ever came back
            self.assertEqual(g["startSource"], "wall-clock")
            self.assertNotEqual(g["exitCode"], 0)
            self.assertTrue(any("Could not find video device" in ln for ln in g["stderrTail"]), g)
        self.assertEqual(rec.segments(rec.pathlib.Path(self.dir), "b"), [])

    def test_default_limit_stops_at_the_sixth_crash(self):
        r, st, gaps, log, wall = self.run_broken()
        self.assertEqual((st["restartLimit"], st["restartWindowS"]), (5, 600))
        self.assert_failed(r, st, gaps, log, crashes=6, restarts=5)
        print(f"KILLTEST limit-default: 6 crashes, 5 restarts, state failed, exit 1 in {wall:.1f} s; "
              f"'{st['failReason']}'; stderr tail {len(gaps[0]['stderrTail'])} line(s), exit code "
              f"{gaps[0]['exitCode']}", file=sys.stderr, flush=True)

    def test_injected_limit(self):
        r, st, gaps, log, wall = self.run_broken("--restart-limit", "2")
        self.assert_failed(r, st, gaps, log, crashes=3, restarts=2)
        print(f"KILLTEST limit-injected: limit 2 -> 3 crashes, 2 restarts, exit 1 in {wall:.1f} s",
              file=sys.stderr, flush=True)

    def test_injected_window_lets_spaced_crashes_restart(self):
        # 1 restart per 0.5 s; restarts are >= RESTART_DELAY_S apart, so the limit never trips
        r, st, gaps, log, wall = self.run_broken("--restart-limit", "1", "--restart-window-s", "0.5",
                                                 "--max-s", "6")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(st["state"], "stopped")
        self.assertGreater(st["restarts"], 1)
        self.assertNotIn("FAILED", r.stdout)
        print(f"KILLTEST window-injected: window 0.5 s, limit 1 -> {st['restarts']} restarts, no stop "
              f"by the limit; ended at the max duration in {wall:.1f} s", file=sys.stderr, flush=True)


if __name__ == "__main__":
    unittest.main()
