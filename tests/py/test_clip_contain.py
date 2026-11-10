# SPDX-License-Identifier: GPL-3.0-or-later
"""Nothing runs on after Ujwalam closes (user 2026-11-09, D311 proposed): the clip job's children (ffmpeg) end with it.

Real processes, no window (CREATE_NO_WINDOW): a stand-in clip job (this Python) starts a sleeping child, then is
ended with a plain kill (TerminateProcess, what the launcher's old child.kill() did).
  - without contain_children(): the child runs on (the root cause of the stray processing after close);
  - with contain_children(): the child ends with the job (kill-on-close job object).
Also the parent pipe: end-of-file on stdin calls the "gone" action once; without the env marker nothing is watched.
Run: python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_contain.py"
"""

import io
import os
import subprocess
import sys
import threading
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "clip"))
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_common as cc  # noqa: E402

JOB = r"""
import os, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
import clip_common as cc
ok = cc.contain_children() if sys.argv[2] == "1" else False
c = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], **cc.NO_WINDOW)
print(f"{int(ok)} {c.pid}", flush=True)
time.sleep(60)
"""


def alive(pid):
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes
    k32 = ctypes.WinDLL("kernel32")
    h = k32.OpenProcess(0x1000 | 0x00100000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    if not h:
        return False
    try:
        return k32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT: still running
    finally:
        k32.CloseHandle(h)


def run_job(contain):
    p = subprocess.Popen([sys.executable, "-I", "-c", JOB, _CLIP, "1" if contain else "0"], stdout=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, text=True, **cc.NO_WINDOW)
    ok, child = p.stdout.readline().split()
    return p, int(ok), int(child)


def gone_within(pid, s=10.0):
    end = time.time() + s
    while time.time() < end:
        if not alive(pid):
            return True
        time.sleep(0.1)
    return False


@unittest.skipUnless(os.name == "nt", "Windows job objects")
class ContainChildren(unittest.TestCase):
    def test_without_the_job_a_plain_kill_leaves_the_child_running(self):
        p, ok, child = run_job(False)
        try:
            p.kill()
            p.wait(10)
            p.stdout.close()
            time.sleep(0.5)
            self.assertTrue(alive(child), "the child outlived the killed job: the stray")
        finally:
            subprocess.run([os.path.join(os.environ["SystemRoot"], "System32", "taskkill.exe"), "/F", "/PID", str(child)],
                           capture_output=True, **cc.NO_WINDOW)
        self.assertTrue(gone_within(child))

    def test_with_the_job_the_child_ends_with_the_killed_job(self):
        p, ok, child = run_job(True)
        self.assertEqual(ok, 1, "contain_children() put the job in place")
        self.assertTrue(alive(child))
        p.kill()
        p.wait(10)
        p.stdout.close()
        self.assertTrue(gone_within(child), "kill-on-close: the child ended with the job")


WATCHED_JOB = r"""
import os, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
import clip_common as cc
cc.end_tree_when_parent_gone(on_gone=lambda: os._exit(7))
time.sleep(0.3)  # the watcher is now blocked reading the parent pipe
r = subprocess.run([sys.executable, "-c", "print('child')"], capture_output=True, timeout=20,
                   creationflags=0x08000000)
print("started", r.stdout.decode().strip(), flush=True)
time.sleep(30)
"""


class ParentPipe(unittest.TestCase):
    def test_child_starts_while_the_watcher_reads_the_pipe(self):
        # 2026-11-10: live-review hung 38+ min at its first ffprobe: on Windows the watcher's blocking read on the
        # stdin pipe blocked subprocess from duplicating that handle for the child.
        env = dict(os.environ, **{cc.PARENT_PIPE_ENV: "1"})
        p = subprocess.Popen([sys.executable, "-I", "-c", WATCHED_JOB, _CLIP], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, env=env, creationflags=0x08000000)
        try:
            line = []
            t = threading.Thread(target=lambda: line.append(p.stdout.readline()), daemon=True)
            t.start()
            t.join(25)
            self.assertEqual(line and line[0].decode().strip(), "started child", "child started under the watcher")
            p.stdin.close()  # parent gone: the watcher still sees end-of-file through its own copy
            self.assertEqual(p.wait(15), 7)
        finally:
            if p.poll() is None:
                p.kill()
            p.stdout.close()

    def test_eof_on_stdin_calls_gone_once(self):
        hit = threading.Event()
        t = cc.end_tree_when_parent_gone(env={cc.PARENT_PIPE_ENV: "1"}, stdin=io.BytesIO(b"x" * 100), on_gone=hit.set)
        self.assertIsNotNone(t)
        t.join(5)
        self.assertTrue(hit.is_set())

    def test_without_the_marker_nothing_is_watched(self):
        self.assertIsNone(cc.end_tree_when_parent_gone(env={}, stdin=io.BytesIO(b""), on_gone=lambda: None))

    def test_end_own_tree_runs_taskkill_on_its_pid_hidden_then_exits(self):
        calls = []
        orig = os._exit
        try:
            os._exit = lambda code: calls.append(("exit", code))
            cc.end_own_tree(pid=4242, run=lambda args, **kw: calls.append((args, kw)))
        finally:
            os._exit = orig
        if os.name == "nt":
            self.assertTrue(calls[0][0][0].lower().endswith("taskkill.exe"))
            self.assertEqual(calls[0][0][1:], ["/T", "/F", "/PID", "4242"])
            self.assertIn("creationflags", calls[0][1])
        self.assertEqual(calls[-1], ("exit", 1))

    def test_end_own_tree_exits_even_when_taskkill_fails(self):
        # taskkill timing out (15 s) or failing to start raises: the job must still end itself, never run on unseen.
        exits = []
        orig = os._exit

        def boom(args, **kw):
            raise subprocess.TimeoutExpired(args, 15)
        try:
            os._exit = lambda code: exits.append(code)
            try:
                cc.end_own_tree(pid=4242, run=boom)
            except subprocess.TimeoutExpired:
                pass  # with the real os._exit the process is gone before this
        finally:
            os._exit = orig
        self.assertEqual(exits, [1])


if __name__ == "__main__":
    unittest.main()
