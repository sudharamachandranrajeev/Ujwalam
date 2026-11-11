# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 live clipping worker (D226): kill chains -> replay buffer saves, while streaming.

Started by the studio launcher when the feature flag 'live-clips' is on (it re-reads the flag about every 5 s and
idles while it is off, so the control page switches it live). Once per second it asks the host for the game layer's
picture (frames.grab: the shared capture source, never the composed canvas), runs the detector scan
(detector_pass.FrameScanner, ROI bands; OCR on the GPU through DirectML when the GPU runtime is present) and feeds
the hits to the kill-chain rules (live_chain.LiveChain). On a save it calls replay.save (H and V) and marker.add
(source 'clip') and appends one line to <data>/live-clips/<session>/saves.jsonl. After the stream,
`clipper.py live-review` turns those saves into stream-v clips.

Live path: this process holds only the host 'clips' token (frames.grab, replay.save, replay.status, marker.add,
host.status), from UJWALAM_HOST_CLIPS_TOKEN; the host discovery file from UJWALAM_HOST_DISCOVERY. It can never touch
outputs, scenes or layers. Every failure is logged and retried with back-off; nothing here can stop the stream. No OCR
text is written to saves.jsonl: it holds times, detector labels (medal names) and file paths only.

LL1 + LL3 (D340, learning_capture.py): the hits and OCR texts of each OCR'd frame with hits, and low-confidence reads
(with their frame) for the review in My clips, go to the local learning store <data>/learning-store/live-<session>/
(gitignored, scan-blocked, 5 GB cap). A writer thread behind a small queue does the writing; a full queue or a
failed write drops the item and logs it. No model and no GPU work is added.

  live_worker.py --layer <game layer id> [--data-dir DIR] [--game codm] [--once FILE.bmp]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:  # run isolated (python -I), like clipper.py
    sys.path.insert(0, _HERE)

import clip_common as cc  # noqa: E402
import detector_pass as dp  # noqa: E402
import g1_scan  # noqa: E402
import game_pack  # noqa: E402
import learning_capture as lcap  # noqa: E402
import reel_length as rl  # noqa: E402
from live_chain import LiveChain  # noqa: E402

FLAG = "live-clips"
FLAG_EVERY_SEC = 5.0
MAX_BACKOFF_SEC = 30.0
CLIPS_ENV = "UJWALAM_HOST_CLIPS_TOKEN"
DISCOVERY_ENV = "UJWALAM_HOST_DISCOVERY"


class HostLink:
    """JSON-RPC to the host on 127.0.0.1 (POST /rpc, Bearer clips token). Never logs the token or params."""

    def __init__(self, discovery_file, token, timeout=5.0):
        self.discovery_file, self.token, self.timeout, self.port, self.n = discovery_file, token, timeout, None, 0

    def call(self, method, params=None):
        if self.port is None:
            d = cc.load_json(self.discovery_file)
            port = d.get("port")
            if not isinstance(port, int) or not 0 < port < 65536:
                raise cc.ClipError("host discovery: bad port")
            self.port = port
        self.n += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/rpc", data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {self.token}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                doc = json.loads(r.read().decode("utf-8"))
        except OSError as e:
            self.port = None  # the host may have restarted on a new port
            raise cc.ClipError(f"host {method}: {type(e).__name__}") from None
        if "error" in doc:
            raise cc.ClipError(f"host {method}: {doc['error'].get('code')} {str(doc['error'].get('message'))[:120]}")
        return doc.get("result")


def read_bmp(path):
    """frames.grab file: 54-byte header, 32 bpp top-down BGRA rows -> BGR uint8 array."""
    import numpy as np
    with open(path, "rb") as f:
        head = f.read(54)
        if len(head) < 54 or head[:2] != b"BM":
            raise cc.ClipError("frame: not a BMP")
        w = int.from_bytes(head[18:22], "little", signed=True)
        hs = int.from_bytes(head[22:26], "little", signed=True)
        h = abs(hs)
        off = int.from_bytes(head[10:14], "little")
        bpp = int.from_bytes(head[28:30], "little")
        if bpp != 32 or not 0 < w <= 8192 or not 0 < h <= 8192:
            raise cc.ClipError("frame: unexpected format")
        f.seek(off)
        data = np.frombuffer(f.read(w * h * 4), np.uint8)
    if data.size != w * h * 4:
        raise cc.ClipError("frame: short file")
    img = data.reshape(h, w, 4)[:, :, :3]
    return (img if hs < 0 else img[::-1]).copy()  # positive height = bottom-up rows


def use_gpu():
    """DirectML OCR when the GPU runtime (.venv-gpu, onnxruntime-directml) is the one loaded; else CPU."""
    try:
        import onnxruntime
        return "DmlExecutionProvider" in onnxruntime.get_available_providers()
    except ImportError:
        return False


class Worker:
    def __init__(self, a, host, clock=time.monotonic, log=cc.eprint):
        self.a, self.host, self.clock, self.log = a, host, clock, log
        _, st, _ = dp.load_settings(a.game)
        pack = game_pack.load_pack(dp.pack_path(st))
        names, have = dp.load_names(a.profile or cc.PROFILE_FILE, pack["nameMatch"]["profileKey"])
        if not have:
            log("live-clips: no profile names; own-kill rules cannot match (medals still count)")
        self.st, self.pack, self.names = st, pack, names
        self.ranking = cc.load_config("ranking", a.ranking)
        self.live = cc.load_config("live-clips", a.live_config)
        lim = rl.effective_limits(a.data_dir)["live-clip"]  # CL1 (D350): the user's live clip length (Settings > Clips)
        buffer = float(self.live["replaySec"]) - float(self.live["forceMarginSec"])
        self.live = dict(self.live, minClipSec=min(lim["minSec"], buffer))  # never more than the replay buffer holds
        self.chain = LiveChain(self.ranking, self.live, max_clip=lim["maxSec"])
        self.scanner = None
        self.layout = None
        self.gpu = use_gpu()
        self.session = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.out = os.path.join(a.data_dir, "live-clips", self.session)
        self.stats = {"frames": 0, "saves": 0, "errors": 0}
        self.capture = None  # LL1 + LL3 (D340): start_capture(); None in --once checks and in tests

    def start_capture(self):
        """Evidence and review items of this session into the local learning store (<data>/learning-store/
        live-<session>/). A store that cannot be opened only turns capture off; clipping goes on."""
        try:
            self.capture = lcap.LiveCapture(self.a.data_dir, f"live-{self.session}", self.pack, self.log)
        except (OSError, ValueError) as e:
            self.capture = None
            self.log(f"live-clips: learning capture off ({type(e).__name__})")
        return self.capture

    def _scanner_for(self, img):
        h, w = img.shape[:2]
        if self.scanner is None or self.layout["visible"][2:] != [w, h]:
            self.layout = g1_scan.full_screen_layout(w, h, [0, 0, w, h])
            self.scanner = dp.FrameScanner(self.pack, self.names, self.st, self.layout, threads=self.a.threads)
            if self.gpu:
                g1_scan.set_ocr_params({"EngineConfig.onnxruntime.use_dml": True})
            self.log(f"live-clips: scanner {w}x{h}, ocr {'gpu (DirectML)' if self.gpu else 'cpu'}")
        return self.scanner

    def tick(self, img=None):
        """One sample: grab (unless img is given), scan, chain; returns the save row or None."""
        t = self.clock()
        if img is None:
            r = self.host.call("frames.grab", {"layer": self.a.layer})
            img = read_bmp(r["path"])
        scanner = self._scanner_for(img)
        rows = scanner.scan(t, img)
        self.stats["frames"] += 1
        if self.capture is not None:  # queued for the writer thread; never waits, never raises
            self.capture.frame(t, img, rows, scanner.boxes, scanner.mode, scanner.fresh)
        act = self.chain.step(t, rows)
        return self._save(act) if act else None

    def _save(self, act):
        now = self.clock()
        saved = self.host.call("replay.save", {})
        row = {"v": 1, "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
               "reason": act["reason"], "score": act["score"], "labels": act["labels"],
               # seconds before the moment the replay files end (the save call): the clip inside each file
               "startBack": round(now - act["start"], 2), "endBack": round(max(0.0, now - act["end"]), 2),
               # ED1 (D352): the strongest medal, for the payoff-first hook of the live clip
               "anchorBack": round(max(0.0, now - act["anchor"]), 2) if act.get("anchor") is not None else None,
               "files": [{"canvas": s.get("canvas"), "path": s.get("path")} for s in (saved or {}).get("saved", [])],
               "errors": [e.get("canvas") for e in (saved or {}).get("errors", [])]}
        try:
            self.host.call("marker.add", {"source": "clip", "note": f"kill chain {act['score']:g}"})
        except cc.ClipError as e:
            self.log(f"live-clips: marker failed: {e}")
        os.makedirs(self.out, exist_ok=True)
        with open(os.path.join(self.out, "saves.jsonl"), "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(row) + "\n")
        self.stats["saves"] += 1
        self.log(f"live-clips: saved ({act['reason']}, score {act['score']:g}, {len(row['files'])} file(s))")
        return row


PARENT_PIPE_ENV = "UJWALAM_PARENT_PIPE"


def watch_parent(stdin=None, env=None):
    """Parent pipe (D234, services/common/parent-pipe.mjs): with UJWALAM_PARENT_PIPE=1 the launcher holds our stdin
    as a pipe; end-of-file means the launcher is gone (even after a hard kill). Returns an Event set at that point
    (never set without the env marker)."""
    gone = threading.Event()
    if (env if env is not None else os.environ).get(PARENT_PIPE_ENV) != "1":
        return gone
    src = stdin if stdin is not None else sys.stdin.buffer

    def read():
        try:
            while src.read(64):
                pass
        except (OSError, ValueError):
            pass
        gone.set()

    threading.Thread(target=read, name="parent-pipe", daemon=True).start()
    return gone


def main(argv=None):
    p = argparse.ArgumentParser(prog="live_worker")
    p.add_argument("--layer", required=True)
    p.add_argument("--data-dir")
    p.add_argument("--game")
    p.add_argument("--profile")
    p.add_argument("--ranking")
    p.add_argument("--live-config")
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--once", help="scan this BMP once (no host) and print the hit rows; for checks")
    a = p.parse_args(argv)
    a.data_dir = cc.resolve_data_dir(a.data_dir)
    cc.lower_own_priority()
    if a.once:
        w = Worker(a, host=None)
        img = read_bmp(a.once)
        print(json.dumps({"rows": len(w._scanner_for(img).scan(0.0, img)), "gpu": w.gpu}))
        return 0
    token, disc = os.environ.pop(CLIPS_ENV, None), os.environ.get(DISCOVERY_ENV)
    if not token or not disc:
        cc.eprint(f"live-clips: {CLIPS_ENV} and {DISCOVERY_ENV} are required")
        return 64
    w = Worker(a, HostLink(disc, token))
    w.start_capture()
    gone = watch_parent()
    period = 1.0 / float(w.live["fps"])
    backoff, next_flag, on = 1.0, 0.0, False
    while not gone.is_set():  # a save in progress finishes first
        start = time.monotonic()
        if start >= next_flag:
            was, on = on, cc.flag_on(a.data_dir, FLAG) or cc.worker_wanted(a.data_dir)
            next_flag = start + FLAG_EVERY_SEC
            if was != on:
                cc.eprint(f"live-clips: {'on' if on else 'off'}")
        if not on:
            gone.wait(FLAG_EVERY_SEC)
            continue
        try:
            w.tick()
            backoff = 1.0
        except cc.ClipError as e:
            w.stats["errors"] += 1
            cc.eprint(f"live-clips: {e}; retry in {backoff:g} s")
            gone.wait(backoff)
            backoff = min(MAX_BACKOFF_SEC, backoff * 2)
            continue
        gone.wait(max(0.0, period - (time.monotonic() - start)))
    if w.capture is not None:
        w.capture.close()
    cc.eprint("live-clips: launcher gone; stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
