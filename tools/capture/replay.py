# SPDX-License-Identifier: GPL-2.0-or-later
"""Replay finished capture segments into a folder as if record.py were writing them (P2b W1).

For demonstrating and testing the coverage tracker (services/clip/coverage.py watch) without the
capture card. Source segments are only read. Each one is copied to OUT/NAME-%03d.mp4 in chunks
spread over its own duration divided by --speed, so the newest file grows like a live recording
and the next file appears when the previous one is complete. OUT/NAME.state.json follows the
record.py contract ("recording" with this process's pid while copying, "stopped" at the end).

  python -I tools/capture/replay.py --src DIR_OR_FILE [...] --out DIR --name PREFIX [--speed 1]
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import record

CHUNKS = 20


def _now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def expand(srcs):
    out = []
    for s in srcs:
        if os.path.isdir(s):
            out += sorted(os.path.join(s, f) for f in os.listdir(s) if f.lower().endswith(".mp4"))
        else:
            out.append(s)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", nargs="+", required=True, help="segment files or folders (*.mp4, sorted)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--speed", type=float, default=1.0, help="1 = real time")
    a = ap.parse_args()
    files = expand(a.src)
    if not files:
        sys.exit("no source segments")
    os.makedirs(a.out, exist_ok=True)
    out = os.path.abspath(a.out)
    for f in files:
        if os.path.commonpath([os.path.abspath(f), out]) == out:
            sys.exit(f"refusing: source {f} is inside the output folder")
    if record.segments(record.pathlib.Path(out), a.name):
        sys.exit(f"refusing: {a.name}-*.mp4 already exists in {out}")
    st = {"state": "recording", "pid": os.getpid(), "ffmpegPid": None, "segmentS": None, "fps": None,
          "source": "replay", "vcodec": None, "audio": True, "started": _now(), "ended": None,
          "ffmpegExit": None, "stopRequested": False}
    record.write_state(out, a.name, st)
    for i, src in enumerate(files):
        dst = os.path.join(out, f"{a.name}-{i:03d}.mp4")
        dur = duration(src)
        size = os.path.getsize(src)
        step = max(1, -(-size // CHUNKS))
        pause = dur / a.speed / CHUNKS if a.speed > 0 else 0
        print(f"{_now()} {os.path.basename(dst)} <- {os.path.basename(src)} ({dur:.2f} s, {size} bytes)", flush=True)
        with open(src, "rb") as fi, open(dst, "wb") as fo:
            while True:
                buf = fi.read(step)
                if not buf:
                    break
                fo.write(buf)
                fo.flush()
                time.sleep(pause)
    st.update(state="stopped", ended=_now(), ffmpegExit=0)
    record.write_state(out, a.name, st)
    print(f"{_now()} replay done: {len(files)} segment(s)", flush=True)


if __name__ == "__main__":
    main()
