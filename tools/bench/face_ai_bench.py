# SPDX-License-Identifier: GPL-3.0-or-later
"""Face AI model bench (docs/plan/2026-11-08-face-ai-design.md, measurement table in docs/evidence/2026-11-08-face-ai.md).

Each model runs in its own child process (so VRAM is measured from a clean start): load time, GPU memory added (NVML
device "used" before vs after load + 20 warm-up frames: whole-device numbers, so other GPU users add noise), and
per-frame time over a paced 30 fps run on SYNTHETIC frames (moving shapes; speed does not depend on content). Input:
the camera frame at 1280x720 or 1920x1080 is first scaled to the 640x360 analysis frame the host sends (that scale
is timed too, as "prep"). CPU % = this process's CPU time / wall time (100 % = one core). No camera is opened.

  python -I tools/bench/face_ai_bench.py [--models a,b] [--sizes 1280x720,1920x1080] [--seconds 10] [--cpu] [--json out]

Run below-normal priority on purpose: it must not crowd a recording (resource-limits rule).
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FACE = os.path.join(REPO, "services", "face")
CASES = ["selfie-landscape", "selfie-square", "modnet-fp16", "rvm-mobilenetv3", "facetracker"]


class Nvml:
    """Minimal NVML through ctypes (nvml.dll ships with the NVIDIA driver). Device-wide numbers only."""

    class Mem(ctypes.Structure):
        _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]

    class Util(ctypes.Structure):
        _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]

    def __init__(self):
        self.ok = False
        try:
            self.lib = ctypes.WinDLL(os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvml.dll"))
            if self.lib.nvmlInit_v2() != 0:
                return
            self.h = ctypes.c_void_p()
            self.ok = self.lib.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(self.h)) == 0
        except OSError:
            self.ok = False

    def used_mb(self):
        if not self.ok:
            return None
        m = self.Mem()
        return m.used / 2**20 if self.lib.nvmlDeviceGetMemoryInfo(self.h, ctypes.byref(m)) == 0 else None

    def util(self):
        """(gpu %, encoder %) or (None, None)."""
        if not self.ok:
            return None, None
        u = self.Util()
        e, p = ctypes.c_uint(), ctypes.c_uint()
        g = u.gpu if self.lib.nvmlDeviceGetUtilizationRates(self.h, ctypes.byref(u)) == 0 else None
        enc = e.value if self.lib.nvmlDeviceGetEncoderUtilization(self.h, ctypes.byref(e), ctypes.byref(p)) == 0 else None
        return g, enc


def below_normal():
    if os.name == "nt":
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS


TEST_FACE = os.path.join(REPO, "data", "models", "face", "test", "astronaut.png")  # gitignored; public-domain NASA photo
_face = {}


def synthetic(w, h, i):
    """A camera-like frame. With the local test portrait present, the portrait slides left and right (so the face
    tracker runs its mesh path); else moving shapes (the tracker then only runs its detector)."""
    import cv2
    import numpy as np
    img = np.full((h, w, 3), (60, 70, 80), np.uint8)
    cx, cy = int(w * (0.5 + 0.1 * np.sin(i / 15))), int(h * 0.45)
    if os.path.isfile(TEST_FACE):
        if h not in _face:
            _face[h] = cv2.resize(cv2.imread(TEST_FACE), (h, h))
        f = _face[h]
        x0 = min(max(cx - h // 2, 0), w - h)
        img[:, x0:x0 + h] = f
        return img
    cv2.ellipse(img, (cx, cy), (w // 10, h // 6), 0, 0, 360, (150, 170, 210), -1)
    cv2.rectangle(img, (cx - w // 6, cy + h // 6), (cx + w // 6, h), (40, 40, 160), -1)
    return img


def child(case, w, h, seconds, gpu):
    sys.path.insert(0, FACE)
    import cv2
    import numpy as np
    import face_models as fm

    below_normal()
    cv2.setNumThreads(2)
    nv = Nvml()
    m0 = nv.used_mb()
    t0 = time.perf_counter()
    runner = fm.FaceTracker(gpu=gpu) if case == "facetracker" else fm.Segmenter(case, gpu=gpu)
    load_ms = (time.perf_counter() - t0) * 1000
    cam = synthetic(w, h, 0)
    for i in range(20):
        runner(cv2.resize(cam, (640, 360), interpolation=cv2.INTER_AREA))
    m1 = nv.used_mb()
    prep, infer, gpu_u, enc_u = [], [], [], []
    n = int(seconds * 30)
    c0, w0 = time.process_time(), time.perf_counter()
    nxt = w0
    for i in range(n):
        cam = synthetic(w, h, i)  # not timed: stands in for the camera
        a = time.perf_counter()
        small = cv2.resize(cam, (640, 360), interpolation=cv2.INTER_AREA)
        b = time.perf_counter()
        runner(small)
        c = time.perf_counter()
        prep.append((b - a) * 1000)
        infer.append((c - b) * 1000)
        if i % 10 == 0:
            g, e = nv.util()
            gpu_u.append(g)
            enc_u.append(e)
        nxt += 1 / 30
        time.sleep(max(0.0, nxt - time.perf_counter()))
    wall = time.perf_counter() - w0
    cpu_s = time.process_time() - c0
    synth = 0.0  # the synthetic frame drawing is counted in CPU time; measured below and subtracted
    s0 = time.process_time()
    for i in range(30):
        synthetic(w, h, i)
    synth = (time.process_time() - s0) / 30 * n

    def pct(a, q):
        a = sorted(a)
        return a[min(len(a) - 1, int(q * len(a)))]

    clean = [x for x in gpu_u if x is not None]
    enc = [x for x in enc_u if x is not None]
    prov = getattr(runner, "provider", "?")
    return {
        "model": case, "input": f"{w}x{h}", "provider": prov, "fallbacks": fm.FALLBACKS,
        "loadMs": round(load_ms, 1),
        "vramMb": None if m0 is None or m1 is None else round(m1 - m0, 1),
        "prepMs": round(sum(prep) / n, 2), "inferMs": round(sum(infer) / n, 2), "inferP95Ms": round(pct(infer, 0.95), 2),
        "cpuPct": round(100 * max(0.0, cpu_s - synth) / wall, 1),
        "gpuPct": round(sum(clean) / len(clean), 1) if clean else None,
        "encPct": round(sum(enc) / len(enc), 1) if enc else None,
        "frames": n,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(CASES))
    ap.add_argument("--sizes", default="1280x720,1920x1080")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--cpu", action="store_true", help="CPU only (no DirectML)")
    ap.add_argument("--json", default="")
    ap.add_argument("--child", default="")
    a = ap.parse_args(argv)
    if a.child:
        case, size = a.child.split("@")
        w, h = map(int, size.split("x"))
        print(json.dumps(child(case, w, h, a.seconds, not a.cpu)))
        return 0
    rows = []
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW (D191)
    for case in a.models.split(","):
        for size in a.sizes.split(","):
            cmd = [sys.executable, "-I", os.path.abspath(__file__), "--child", f"{case}@{size}", "--seconds", str(a.seconds)]
            if a.cpu:
                cmd.append("--cpu")
            r = subprocess.run(cmd, capture_output=True, text=True, creationflags=flags, timeout=600)
            line = (r.stdout.strip().splitlines() or [""])[-1]
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                row = {"model": case, "input": size, "error": (r.stderr.strip().splitlines() or ["?"])[-1][-200:]}
            rows.append(row)
            print(json.dumps(row), flush=True)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
