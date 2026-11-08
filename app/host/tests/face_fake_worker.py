# SPDX-License-Identifier: GPL-3.0-or-later
"""Fake face AI worker for app/host/tests/host-face.test.mjs: opens the host's face link like
services/face/face_worker.py, but answers every frame with a fixed synthetic result instead of running a model:

  mask: the left half of the frame is "person" (255), the right half background (0)
  face: box (0.5, 0.5, 0.5, 0.5) (centre 0.75, 0.75); eyes at y 0.5, right eye centre x 0.425, left 0.575; every
        other landmark at (0.5, 0.5)

  face_fake_worker.py HOST_PID SECONDS
Prints one JSON line at the end: {"frames": n, "src": [w, h], "frame": [w, h]}.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "services", "face"))

import numpy as np  # noqa: E402

import face_link as fl  # noqa: E402


def main():
    pid, seconds = int(sys.argv[1]), float(sys.argv[2])
    end = time.monotonic() + seconds
    link = None
    while link is None and time.monotonic() < end:
        link = fl.Link.open(pid)
        if link is None:
            time.sleep(0.1)
    if link is None:
        print(json.dumps({"error": "no face link"}))
        return 1
    lm = np.full((468, 3), 0.5, np.float32)
    lm[:, 2] = 0
    for i, x in ((33, 0.40), (133, 0.45), (263, 0.60), (362, 0.55)):
        lm[i, :2] = (x, 0.5)
    n, last, src, size = 0, 0, None, None
    while time.monotonic() < end:
        link.heartbeat()
        got = link.read_frame(last)
        if got is None:
            time.sleep(0.005)
            continue
        seq, ts, px, src = got
        last = seq
        h, w = px.shape[:2]
        size = (w, h)
        mask = np.zeros((h, w), np.uint8)
        mask[:, : w // 2] = 255
        link.write_result(seq, ts, mask, lm, (0.5, 0.5, 0.5, 0.5), 1.0, {}, 0.1, 3)
        n += 1
    link.close()
    print(json.dumps({"frames": n, "src": list(src) if src else None, "frame": list(size) if size else None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
