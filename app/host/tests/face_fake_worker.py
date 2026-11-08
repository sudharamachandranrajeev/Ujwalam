# SPDX-License-Identifier: GPL-3.0-or-later
"""Fake face AI worker for app/host/tests/host-face.test.mjs: opens the host's face link like
services/face/face_worker.py (host pid + link key from one control line on stdin, as the launcher sends it), but
answers every frame with a fixed synthetic result instead of running a model:

  mask: the left half of the frame is "person" (255), the right half background (0)
  face: box (0.5, 0.5, 0.5, 0.5) (centre 0.75, 0.75); eyes at y 0.5, right eye centre x 0.425, left 0.575; every
        other landmark at (0.5, 0.5)

Modes (what the host must refuse or survive; review fixes, D295):
  normal    the result above
  nan       landmark 33 x = NaN              inf     box w = +Inf          huge    landmark 1 y = 1e30
  count     face found with 400 landmarks    feats   mouth = 7 (outside 0..1)
  unsent    answers a frame seq the host never sent (seq + 1000)
  oldgen    echoes a target generation other than the frame's
  future    a frame ts far in the future (the host must judge freshness by its own clock)
  nomask    a mask for the first 20 frames, then results with no mask (mask valid 0) while landmarks continue
  torn      publishes one good result, then keeps rewriting the result block under a lock that changes all the time
  badkey    uses a wrong link key (must not open the link at all)

  face_fake_worker.py SECONDS [MODE]     stdin: {"key": "<64 hex>", "hostPid": N}
Prints one JSON line at the end: {"frames": n, "src": [w, h], "frame": [w, h]} (or {"error": ...}).
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "services", "face"))

import numpy as np  # noqa: E402

import face_link as fl  # noqa: E402


def main():
    seconds = float(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else "normal"
    ctl = json.loads(sys.stdin.readline())
    pid, key = int(ctl["hostPid"]), fl.parse_key(ctl["key"])
    if mode == "badkey":
        key = bytes(b ^ 0xFF for b in key)
    end = time.monotonic() + seconds
    link = None
    while link is None and time.monotonic() < end:
        link = fl.Link.open(pid, key)
        if link is None:
            time.sleep(0.1)
    if link is None:
        print(json.dumps({"error": "no face link"}))
        return 0 if mode == "badkey" else 1
    lm = np.full((468, 3), 0.5, np.float32)
    lm[:, 2] = 0
    for i, x in ((33, 0.40), (133, 0.45), (263, 0.60), (362, 0.55)):
        lm[i, :2] = (x, 0.5)
    box = [0.5, 0.5, 0.5, 0.5]
    feats = {}
    if mode == "nan":
        lm[33, 0] = np.nan
    elif mode == "inf":
        box[2] = float("inf")
    elif mode == "huge":
        lm[1, 1] = 1e30
    elif mode == "feats":
        feats = {"mouth": 7.0}
    n, last, src, size = 0, 0, None, None
    while time.monotonic() < end:
        link.heartbeat()
        got = link.read_frame(last)
        if got is None:
            time.sleep(0.005)
            continue
        last = got.seq
        src = got.src
        h, w = got.px.shape[:2]
        size = (w, h)
        mask = np.zeros((h, w), np.uint8)
        mask[:, : w // 2] = 255
        seq, ts, gen = got.seq, got.ts, got.gen
        if mode == "unsent":
            seq += 1000
        elif mode == "oldgen":
            gen ^= 0x55
        elif mode == "future":
            ts += 10 * 365 * 86400 * 1000
        if mode == "nomask" and n >= 20:
            mask = None
        if mode == "count":  # face found with 400 points, published properly under the seqlock
            u = link.u32
            u[32] = int(u[32]) + 1
            link._put("<I", 240, 0)
            link._put("<I", 140, 1)
            link._put("<I", 180, 400)
            link._put("<I", 244, gen)
            link.result_seq += 1
            link._put("<Q", 152, seq)
            link._put("<q", 160, ts)
            link._put("<Q", 144, link.result_seq)
            u[32] = int(u[32]) + 1
        else:
            link.write_result(seq, ts, mask, lm, box, 1.0, feats, 0.1, 3, gen)
        n += 1
        if mode == "torn":
            # keep the lock moving (always even, so never "writing") while the payload changes under it: every host
            # snapshot sees a different lock before and after its copy
            u = link.u32
            while time.monotonic() < end:
                for _ in range(2000):
                    u[32] = int(u[32]) + 2
                    link._put("<Q", 144, link.result_seq + 1 + (int(u[32]) & 0xFF))
                link.heartbeat()
            break
    link.close()
    print(json.dumps({"frames": n, "src": list(src) if src else None, "frame": list(size) if size else None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
