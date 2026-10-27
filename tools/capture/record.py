# SPDX-License-Identifier: GPL-2.0-or-later
"""Crash-safe capture-card recorder for reference footage.

Records the capture device directly (not a program output) into 60 s
fragmented MP4 segments, so a stop, kill or crash loses at most the
fragment in flight. Stop cleanly by creating the STOP file in the output
folder; the recorder then sends 'q' to ffmpeg so the last segment is
finalised. `verify` checks every segment afterwards.

  python -I tools/capture/record.py record --out DIR --name PREFIX
  python -I tools/capture/record.py verify --out DIR --name PREFIX
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time

FPS = 60
SEGMENT_S = 60


def ffmpeg_cmd(video, audio, size, pattern, max_s):
    src = f"video={video}" + (f":audio={audio}" if audio else "")
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostats",
        "-f", "dshow", "-rtbufsize", "1024M", "-video_size", size,
        "-framerate", str(FPS), "-pixel_format", "nv12", "-i", src,
        "-t", str(max_s),
        "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19",
        "-b:v", "50M", "-maxrate", "80M",
        "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_S})", "-g", "120",
        "-c:a", "aac", "-b:a", "192k",
        "-f", "segment", "-segment_time", str(SEGMENT_S), "-reset_timestamps", "1",
        "-segment_format", "mp4",
        "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof",
        str(pattern),
    ]


def segments(out, name):
    return sorted(out.glob(f"{name}-*.mp4"))


def record(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stop = out / "STOP"
    stop.unlink(missing_ok=True)
    if segments(out, a.name):
        sys.exit(f"refusing: {a.name}-*.mp4 already exists in {out}")
    log = open(out / f"{a.name}.log", "w", encoding="utf-8")
    proc = subprocess.Popen(
        ffmpeg_cmd(a.video, a.audio, a.size, out / f"{a.name}-%03d.mp4", a.max_min * 60),
        stdin=subprocess.PIPE, stdout=log, stderr=log)
    print(f"recording pid={proc.pid}; stop: create {stop}", flush=True)
    last_total, last_change = -1, time.monotonic()
    while proc.poll() is None:
        time.sleep(1)
        total = sum(p.stat().st_size for p in segments(out, a.name))
        now = time.monotonic()
        if total != last_total:
            last_total, last_change = total, now
        elif now - last_change > 10:
            print(f"STALL: no bytes written for {now - last_change:.0f} s", flush=True)
        if stop.exists():
            print("stop requested; sending q", flush=True)
            try:
                proc.stdin.write(b"q")
                proc.stdin.flush()
            except OSError:
                pass
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.terminate()
            break
    stop.unlink(missing_ok=True)
    print(f"ffmpeg exit {proc.wait()}", flush=True)


def probe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_packets:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True)
    info = json.loads(r.stdout or "{}")
    frames = int(info.get("streams", [{}])[0].get("nb_read_packets", 0))
    dur = float(info.get("format", {}).get("duration", 0) or 0)
    return frames, dur, r.stderr.strip()


def verify(a):
    out = pathlib.Path(a.out)
    files = segments(out, a.name)
    if not files:
        sys.exit("no segments")
    total_frames, bad = 0, 0
    for p in files:
        frames, dur, err = probe(p)
        real = frames / FPS
        ok = frames > 0 and not err and abs(real - dur) <= 0.5
        bad += not ok
        total_frames += frames
        print(f"{p.name}: {frames} frames = {real:.2f} s, header {dur:.2f} s"
              f"{'' if ok else '  FAIL ' + (err[:120] or 'duration mismatch')}")
    print(f"{len(files)} segments, {total_frames / FPS:.1f} s total, {bad} failed")
    sys.exit(1 if bad else 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["record", "verify"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--video", default="Live Gamer Ultra 2.1-Video")
    ap.add_argument("--audio", default="HDMI/Line In (Live Gamer Ultra 2.1-Audio)")
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--max-min", type=int, default=60)
    a = ap.parse_args()
    record(a) if a.mode == "record" else verify(a)


if __name__ == "__main__":
    main()
