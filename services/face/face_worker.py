# SPDX-License-Identifier: GPL-3.0-or-later
"""Face AI worker (flag face-ai, off by default; docs/plan/2026-11-08-face-ai-design.md, D295 proposed).

Reads camera frames the host puts in the face link (shared memory, services/face/face_link.py), runs person
segmentation and/or the face tracker (only what the host's face effects want), and writes the mask and landmarks
back. The host composites them in its own shaders (personMask, autoFrame, faceSticker).

Live path rules:
  - this process opens no camera, no network and holds no host token; it only opens the host's face link by name
    and never creates it. The launcher gives it the host pid and the per-launch link key on its stdin pipe (one JSON
    line {"key": "<64 hex>", "hostPid": N}, again after every host restart); it never reads the discovery file (that
    file can hold host tokens). A mapping without the right key or owner is refused (face_link.py)
  - temporal state (mask smoothing, One Euro, the tracker's last mesh, the recurrent matte) is reset when the host's
    target generation changes (another camera); the generation is echoed in every result, so the host drops answers
    for the previous camera
  - flag face-ai is re-read every 5 s; while it is off the models are unloaded (VRAM freed) and nothing runs
  - every error is logged and retried with back-off; a crash or a hang only makes the host's face effects fall back
    (the last mask for a short hold, then the plain camera); stream and recording never wait for this process
  - models not wanted for 30 s are unloaded

  face_worker.py [--data-dir DIR] [--seg-model selfie-landscape] [--cpu]    (stdin: the launcher's control pipe)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
for p in (_HERE, os.path.join(os.path.dirname(_HERE), "clip")):
    if p not in sys.path:  # run isolated (python -I), like the clipper
        sys.path.insert(0, p)

import numpy as np  # noqa: E402

import face_link as fl  # noqa: E402
import face_post as fp  # noqa: E402

FLAG = "face-ai"
FLAG_EVERY_SEC = 5.0
STALE_RETRY_SEC = 1.0  # a stale host heartbeat: the link is retried this often (and the outage logged once)
UNLOAD_AFTER_SEC = 30.0


def log(msg):
    print(f"[face] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


def flag_on(data_dir):
    try:
        import clip_common as cc
        return cc.flag_on(data_dir, FLAG)
    except Exception as e:  # noqa: BLE001 - a broken flags file means off
        log(f"flag read failed ({e}); treated as off")
        return False


class Control:
    """What the launcher said on stdin: the host pid and the link key (the latest valid line wins). `gone` is set at
    end-of-file (the launcher is gone, D234)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pid, self.key = 0, None
        self.gone = threading.Event()

    def feed(self, line):
        """One control line. True when it was valid; a bad line is ignored and the old target kept."""
        try:
            j = json.loads(line)
            pid, key = j.get("hostPid"), fl.parse_key(j.get("key"))
        except (ValueError, AttributeError):
            return False
        if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid < 1 << 32 or key is None:
            return False
        with self.lock:
            self.pid, self.key = pid, key
        return True

    def target(self):
        with self.lock:
            return self.pid, self.key


class Pipeline:
    """Runs the wanted models on one frame. Models load on first use and unload after UNLOAD_AFTER_SEC unused."""

    def __init__(self, seg_model="selfie-landscape", gpu=True, clock=time.monotonic):
        self.seg_model, self.gpu, self.clock = seg_model, gpu, clock
        self.seg = self.tracker = None
        self.seg_used = self.trk_used = 0.0
        self.smoother = fp.MaskSmoother()
        self.euro = fp.OneEuro(min_cutoff=1.5, beta=0.05)

    def unload_idle(self):
        now = self.clock()
        if self.seg is not None and now - self.seg_used > UNLOAD_AFTER_SEC:
            self.seg = None
            self.smoother.reset()
            log("segmentation model unloaded (unused)")
        if self.tracker is not None and now - self.trk_used > UNLOAD_AFTER_SEC:
            self.tracker = None
            self.euro.reset()
            log("face tracker unloaded (unused)")

    def unload(self):
        self.seg = self.tracker = None
        self.reset_temporal()

    def reset_temporal(self):
        """Forget everything carried over from earlier frames (another camera, or a reopened link): mask EMA, One
        Euro, the tracker's previous mesh, the recurrent matte's state. Loaded models stay loaded."""
        self.smoother.reset()
        self.euro.reset()
        if self.tracker is not None:
            self.tracker.reset()
        if self.seg is not None:
            self.seg.reset()

    def run(self, bgra, want, smoothing):
        import face_models as fm
        out = {"mask": None, "landmarks": None, "box": None, "score": 0.0, "feats": None, "status": 0}
        h, w = bgra.shape[:2]
        if want & fl.WANT_MASK:
            if self.seg is None:
                self.seg = fm.Segmenter(self.seg_model, self.gpu)
                log(f"segmentation {self.seg_model} on {self.seg.provider}")
            self.seg_used = self.clock()
            alpha = self.seg(bgra)
            if alpha.shape != (h, w):
                alpha = fp.guided_upsample(alpha, bgra)
            self.smoother.smoothing = smoothing
            out["mask"] = fp.to_u8(self.smoother(alpha))
            out["status"] |= 1 if self.seg.provider == "DmlExecutionProvider" else 0
        if want & fl.WANT_LANDMARKS:
            if self.tracker is None:
                self.tracker = fm.FaceTracker(self.gpu)
                log(f"face tracker on {self.tracker.provider}")
            self.trk_used = self.clock()
            lm, score = self.tracker(bgra)
            out["score"] = score
            out["status"] |= 2 if self.tracker.provider == "DmlExecutionProvider" else 0
            if lm is None:
                self.euro.reset()
            else:
                lm = self.euro(lm, self.clock())
                out["feats"] = fp.face_features(lm)
                norm = np.column_stack([lm[:, 0] / w, lm[:, 1] / h, lm[:, 2] / w])
                cx, cy, size = fp.face_box(norm)
                x0, x1 = float(norm[:, 0].min()), float(norm[:, 0].max())
                out["landmarks"] = norm
                out["box"] = (x0, cy - size / 2, x1 - x0, size)
        return out


def serve(a, ctl, pipe=None, stop=lambda: False, open_link=None):
    """Main loop. ctl: Control (host pid + link key); open_link(pid, key) -> Link or None (tests pass a fake)."""
    pipe = pipe or Pipeline(a.seg_model, not a.cpu)
    open_link = open_link or fl.Link.open
    link = None
    link_target = None
    last_seq = 0
    last_gen = None
    on = False
    next_flag = 0.0
    backoff = 0.5
    last_beat = 0.0
    # 2026-11-12: a stale host heartbeat made this loop close and reopen the link about 2,700 times a second for three
    # hours, one log line each. Now an outage is logged once (with the heartbeat's age), the link is retried once a
    # second, and the return of the heartbeat is logged once.
    stale = False
    while not stop():
        now = time.monotonic()
        if now >= next_flag:
            was, on = on, flag_on(a.data_dir)
            next_flag = now + FLAG_EVERY_SEC
            if was != on:
                log(f"flag {FLAG} {'on' if on else 'off'}")
            if not on:
                if link:
                    link.close()
                    link = None
                pipe.unload()
        if not on:
            time.sleep(0.25)
            continue
        try:
            target = ctl.target()
            if link is not None and target != link_target:  # the launcher restarted the host
                link.close()
                link = None
            if link is None:
                pid, key = target
                link = open_link(pid, key) if pid and key else None
                if link is None:
                    time.sleep(1.0)
                    continue
                if not stale:
                    log(f"face link open (host pid {pid})")
                link_target = target
                last_seq = 0
                last_gen = None
            if now - last_beat >= 0.25:
                link.heartbeat()
                last_beat = now
            if not link.host_alive():
                if not stale:
                    age = getattr(link, "host_age_ms", lambda: None)()
                    log(f"host heartbeat stopped (last beat {age} ms ago); closing the face link, retrying every "
                        f"{STALE_RETRY_SEC:g} s")
                    stale = True
                link.close()
                link = None
                pipe.unload()
                time.sleep(STALE_RETRY_SEC)
                continue
            if stale:
                log(f"host heartbeat back; face link open (host pid {link_target[0]})")
                stale = False
            pipe.unload_idle()
            want = link.want()
            got = link.read_frame(last_seq) if want else None
            if got is None:
                time.sleep(0.004)
                continue
            last_seq = got.seq
            if got.gen != last_gen:  # another camera (or the first frame on this link): nothing carries over
                pipe.reset_temporal()
                last_gen = got.gen
            t0 = time.perf_counter()
            r = pipe.run(got.px, want, min(max(link.smoothing(), 0.0), 0.95))
            ms = (time.perf_counter() - t0) * 1000
            link.write_result(got.seq, got.ts, r["mask"], r["landmarks"], r["box"], r["score"], r["feats"], ms,
                              r["status"], got.gen)
            backoff = 0.5
        except Exception as e:  # noqa: BLE001 - never die on one bad frame; back off and reopen
            log(f"error: {type(e).__name__}: {e}; retry in {backoff:.1f} s")
            if link:
                link.close()
                link = None
            pipe.unload()
            time.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
    if link:
        link.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(os.path.dirname(_HERE)), "data"))
    ap.add_argument("--seg-model", default="selfie-landscape")
    ap.add_argument("--cpu", action="store_true")
    a = ap.parse_args(argv)
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL: never crowd the render or encoder
    log(f"started; acts only while flag {FLAG} is on")
    ctl = watch_parent()
    if not ctl.target()[0]:
        log("no link key from the launcher yet (stdin); no face link without it")
    serve(a, ctl, stop=ctl.gone.is_set)
    return 0


def watch_parent(stdin=None, env=None, wait=0.5):
    """Parent pipe (D234, services/common/parent-pipe.mjs) and control channel: with UJWALAM_PARENT_PIPE=1 the
    launcher holds our stdin as a pipe and writes one control line per host start; end-of-file means it is gone.
    Returns a Control (without the marker: gone is never set and no key ever arrives, so no link opens)."""
    ctl = Control()
    if (env if env is not None else os.environ).get("UJWALAM_PARENT_PIPE") != "1":
        return ctl
    src = stdin if stdin is not None else sys.stdin.buffer

    def run():
        try:
            for line in iter(lambda: src.readline(4096), b""):
                if line.strip() and not ctl.feed(line.decode("utf-8", "replace")):
                    log("ignored a bad control line from the launcher")
        except Exception:  # noqa: BLE001 - a broken pipe also means the parent is gone
            pass
        ctl.gone.set()

    t = threading.Thread(target=run, daemon=True, name="parent-pipe")
    t.start()
    t.join(wait)  # the first line normally arrives with the start; serve() keeps waiting for it anyway
    return ctl


if __name__ == "__main__":
    sys.exit(main())
