# SPDX-License-Identifier: GPL-3.0-or-later
"""Analysis cache for labelled clip sessions (P2a step A2b).

Builds, per session, from the original clips (read only):
  - concat.ffconcat   ffmpeg concat-demuxer list with per-clip `inpoint` trims
  - audio-16k-mono.flac   16 kHz mono FLAC of the trimmed virtual concatenation
  - proxy-540x960-30p.mp4 540x960 30 fps H.264 (~1 Mbps) + AAC 64 kbps, for labelling
  - manifest.json     maps cache time (audio and proxy share one timeline) back to
                      (clip file, offset in clip) and to wall-clock time
  - build-state.json  what each output was built from, for idempotent reruns

The cache is fully rebuildable from the originals plus index.json (session_index.py,
optionally with --boundaries). Nothing is written in the corpus folder; an output path
inside it is refused.

Usage (Python stdlib only; run isolated):
  python -I services/clip/build_cache.py --index <index.json> --corpus <clips folder>
      --cache <cache folder> --session <id> [--session <id> ...]
      [--force] [--video-encoder auto|h264_nvenc|libx264] [--decode cpu|cuda]
      [--only audio,proxy] [--verify N] [--dry-run]

Trims: each clip after the first starts at its index `trimInSec` (measured from audio
where available, else from the name times). The concat demuxer's `inpoint` positions the
clip; `-segment_time_metadata 1` plus (a)select=concatdec_select drop the packets the
demuxer has to read before an in-point, and an aresample async fill keeps the audio
sample count equal to the timeline. Gaps between clips are not kept (virtual
concatenation); the manifest records each segment's wall-clock start.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

TOOL_VERSION = 1
LIST_FILE = "concat.ffconcat"
AUDIO_FILE = "audio-16k-mono.flac"
PROXY_FILE = "proxy-540x960-30p.mp4"
MANIFEST_FILE = "manifest.json"
STATE_FILE = "build-state.json"
ASYNC_FILL = "aresample=async=1:min_hard_comp=0.01:first_pts=0"

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _is_inside(child: str, parent: str) -> bool:
    child = os.path.normcase(os.path.realpath(child))
    parent = os.path.normcase(os.path.realpath(parent))
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


# ---------------------------------------------------------------- concat list + manifest

def ffconcat_quote(path: str) -> str:
    """Quote a path for an ffconcat `file` line (forward slashes, ' escaped)."""
    p = path.replace("\\", "/")
    return "'" + p.replace("'", "'\\''") + "'"


def concat_list(session: dict, corpus: str) -> str:
    """ffconcat text for a session: one `file` per clip, `inpoint` where trimmed."""
    lines = ["ffconcat version 1.0"]
    for c in session["clips"]:
        lines.append("file " + ffconcat_quote(os.path.join(corpus, c["file"])))
        trim = float(c.get("trimInSec") or 0.0)
        if trim > 0:
            lines.append(f"inpoint {trim:.4f}")
    return "\n".join(lines) + "\n"


def build_manifest(session: dict, index: dict) -> dict:
    """Segment table mapping cache time to (clip, offset) and wall-clock time.

    Segment k covers cache time [sessionStartSec, sessionStartSec + durationSec); a cache
    time t inside it is clip time clipInSec + (t - sessionStartSec) in `clip`.
    """
    segs = []
    t = 0.0
    for c in session["clips"]:
        trim = float(c.get("trimInSec") or 0.0)
        dur = float(c["duration"]) - trim
        start = datetime.fromisoformat(c["startUtc"].replace("Z", "+00:00"))
        segs.append({
            "clip": c["file"],
            "clipInSec": round(trim, 4),
            "clipOutSec": round(float(c["duration"]), 4),
            "sessionStartSec": round(t, 4),
            "durationSec": round(dur, 4),
            "trimMethod": c.get("trimMethod"),
            "wallStartUtc": (start + timedelta(seconds=trim)).isoformat(timespec="milliseconds")
                                                              .replace("+00:00", "Z"),
        })
        t += dur
    return {
        "version": TOOL_VERSION,
        "session": session["id"],
        "source": session.get("source", "rule"),
        "nameTime": index.get("nameTime"),
        "timezoneAssumption": index.get("timezoneAssumption"),
        "clipCount": session["clipCount"],
        "expectedDurationSec": round(t, 4),
        "indexTrimmedDurationSec": session["trimmedDurationSec"],
        "trimMethods": {
            "measured": sum(1 for c in session["clips"] if c.get("trimMethod") == "measured"),
            "name-time": sum(1 for c in session["clips"] if c.get("trimMethod") == "name-time"),
        },
        "timeline": "audio-16k-mono.flac and proxy-540x960-30p.mp4 share one timeline starting at 0. "
                    "Cache time t in segment k maps to clip time clipInSec + (t - sessionStartSec). "
                    "Gaps between clips are not in the cache; use wallStartUtc for wall-clock time.",
        "segments": segs,
    }


def locate(manifest: dict, t: float) -> tuple[str, float, dict]:
    """Cache time -> (clip file, offset in clip, segment)."""
    segs = manifest["segments"]
    lo, hi = 0, len(segs) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if segs[mid]["sessionStartSec"] <= t:
            lo = mid
        else:
            hi = mid - 1
    s = segs[lo]
    return s["clip"], s["clipInSec"] + (t - s["sessionStartSec"]), s


# ---------------------------------------------------------------- ffmpeg commands

def has_encoder(ffmpeg: str, name: str) -> bool:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    p = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True,
                       creationflags=flags, stdin=subprocess.DEVNULL)
    return any(line.split()[1:2] == [name] for line in p.stdout.splitlines() if line.strip())


def audio_cmd(ffmpeg: str, list_path: str, out: str) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-stats",
            "-f", "concat", "-safe", "0", "-segment_time_metadata", "1", "-i", list_path,
            "-map", "0:a:0", "-vn",
            "-af", "aselect=concatdec_select," + ASYNC_FILL,
            "-ac", "1", "-ar", "16000", "-c:a", "flac", "-compression_level", "5",
            "-f", "flac", out]


def proxy_cmd(ffmpeg: str, list_path: str, out: str, encoder: str, decode: str) -> list[str]:
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-stats"]
    if decode == "cuda":
        cmd += ["-hwaccel", "cuda"]
    cmd += ["-f", "concat", "-safe", "0", "-segment_time_metadata", "1", "-i", list_path,
            "-map", "0:v:0", "-map", "0:a:0",
            "-vf", "select=concatdec_select,scale=540:960:flags=bicubic,fps=30,format=yuv420p",
            "-af", "aselect=concatdec_select," + ASYNC_FILL]
    if encoder == "h264_nvenc":
        cmd += ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-b:v", "1M",
                "-maxrate", "1500k", "-bufsize", "2M"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "1M",
                "-maxrate", "1500k", "-bufsize", "2M"]
    cmd += ["-g", "60", "-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", "-f", "mp4", out]
    return cmd


def output_key(list_text: str, cmd: list[str], out_tmp: str) -> str:
    stable = [x for x in cmd if x != out_tmp]
    h = hashlib.sha256()
    h.update(str(TOOL_VERSION).encode())
    h.update(list_text.encode("utf-8"))
    h.update(json.dumps(stable).encode("utf-8"))
    return h.hexdigest()


def run_ffmpeg(cmd: list[str], log_path: str) -> int:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with open(log_path, "w", encoding="utf-8") as log:
        log.write(" ".join(cmd) + "\n")
        log.flush()
        p = subprocess.run(cmd, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                           creationflags=flags)
    return p.returncode


def ffprobe_streams(ffprobe: str, path: str) -> dict:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    p = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                        "format=duration,size:stream=index,codec_type,codec_name,start_time,duration,"
                        "width,height,avg_frame_rate,sample_rate,channels,nb_frames,bit_rate",
                        "-of", "json", path], capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, creationflags=flags)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[:300])
    return json.loads(p.stdout)


# ---------------------------------------------------------------- verification

def _decode(ffmpeg: str, path: str, start: float, dur: float, rate: int = 8000) -> list[int]:
    """Mono s16 PCM of [start, start+dur) on the file's timeline (async-filled)."""
    from array import array
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    # Input seek (accurate by default when decoding) so long cache files are not decoded
    # from the start.
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-ss", f"{start:.4f}", "-i", path,
           "-map", "0:a:0", "-vn", "-t", f"{dur:.4f}", "-af", ASYNC_FILL,
           "-ac", "1", "-ar", str(rate), "-f", "s16le", "-acodec", "pcm_s16le", "-"]
    p = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, creationflags=flags)
    a = array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 2 * 2])
    return list(a)


def _luma(ffmpeg: str, path: str, start: float, dur: float) -> list[float]:
    """Mean luma per frame at 30 fps for [start, start+dur) (frame timestamps honoured)."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-ss", f"{start:.4f}", "-i", path,
           "-map", "0:v:0", "-an", "-t", f"{dur:.4f}",
           "-vf", "fps=30,scale=16:16,format=gray", "-f", "rawvideo", "-"]
    p = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, creationflags=flags)
    d = p.stdout
    return [sum(d[i:i + 256]) / 256.0 for i in range(0, len(d) - 255, 256)]


def _best_lag(ref: list, sig: list, max_lag: int, pearson) -> tuple[int, float]:
    """Lag L (in samples) maximising r(ref[i], sig[i + L]); compares the overlap."""
    best = (0, -2.0)
    n = min(len(ref), len(sig))
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            a, b = ref[:n - lag], sig[lag:n]
        else:
            a, b = ref[-lag:n], sig[:n + lag]
        r = pearson(a, b)
        if r > best[1]:
            best = (lag, r)
    return best


def verify_session(sdir: str, manifest: dict, corpus: str, ffmpeg: str, points: int,
                   seed: int = 1) -> dict:
    """Spot-check cache time -> clip mapping. At each point, the cache audio (FLAC and
    proxy) and the proxy video are cross-correlated with the original clip at the mapped
    offset. A lag of 0 means the mapping is exact; video lag - audio lag is A/V sync."""
    bx = _load("boundary_xcorr")
    rng = random.Random(seed)
    segs = [s for s in manifest["segments"] if s["durationSec"] > 8.0]
    picks = sorted(rng.sample(segs, min(points, len(segs))), key=lambda s: s["sessionStartSec"])
    out = []
    for s in picks:
        off = rng.uniform(1.0, s["durationSec"] - 6.0)
        t = s["sessionStartSec"] + off
        clip, clip_t, _ = locate(manifest, t)
        src = os.path.join(corpus, clip)
        win = 4.0
        ref = _decode(ffmpeg, src, clip_t, win)
        row = {"cacheSec": round(t, 3), "clip": clip, "clipSec": round(clip_t, 3)}
        for label, f in (("flac", AUDIO_FILE), ("proxyAudio", PROXY_FILE)):
            path = os.path.join(sdir, f)
            if os.path.exists(path):
                sig = _decode(ffmpeg, path, t, win)
                lag, r = _best_lag(ref, sig, 400, bx.pearson)  # +/- 50 ms at 8 kHz
                row[label + "LagMs"] = round(lag / 8.0, 3)
                row[label + "R"] = round(r, 4)
        ppath = os.path.join(sdir, PROXY_FILE)
        if os.path.exists(ppath):
            lr = _luma(ffmpeg, src, clip_t, 6.0)
            lp = _luma(ffmpeg, ppath, t, 6.0)
            dr = [lr[i] - lr[i - 1] for i in range(1, len(lr))]
            dp = [lp[i] - lp[i - 1] for i in range(1, len(lp))]
            lag, r = _best_lag(dr, dp, 6, bx.pearson)  # +/- 200 ms at 30 fps
            row["videoLagMs"] = round(lag * 1000 / 30.0, 1)
            row["videoR"] = round(r, 4)
            if "proxyAudioLagMs" in row:
                row["proxyAvOffsetMs"] = round(row["videoLagMs"] - row["proxyAudioLagMs"], 1)
        out.append(row)
    return {"points": out}


# ---------------------------------------------------------------- main

def build_session(session: dict, index: dict, args, encoder: str) -> dict:
    sdir = os.path.join(args.cache, session["id"])
    os.makedirs(sdir, exist_ok=True)
    list_text = concat_list(session, args.corpus)
    list_path = os.path.join(sdir, LIST_FILE)
    if not (os.path.exists(list_path) and open(list_path, encoding="utf-8").read() == list_text):
        with open(list_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(list_text)
    manifest = build_manifest(session, index)

    state_path = os.path.join(sdir, STATE_FILE)
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as fh:
            state = json.load(fh)
    report = {"session": session["id"], "outputs": {}}
    jobs = []
    if "audio" in args.only:
        tmp = os.path.join(sdir, "audio.partial.flac")
        jobs.append(("audio", AUDIO_FILE, tmp, audio_cmd(args.ffmpeg, list_path, tmp)))
    if "proxy" in args.only:
        tmp = os.path.join(sdir, "proxy.partial.mp4")
        jobs.append(("proxy", PROXY_FILE, tmp,
                     proxy_cmd(args.ffmpeg, list_path, tmp, encoder, args.decode)))
    for name, fname, tmp, cmd in jobs:
        final = os.path.join(sdir, fname)
        key = output_key(list_text, cmd, tmp)
        st = state.get(name, {})
        up_to_date = (os.path.exists(final) and st.get("key") == key
                      and st.get("bytes") == os.path.getsize(final))
        if up_to_date and not args.force:
            report["outputs"][name] = {"status": "up-to-date", "bytes": st["bytes"]}
            print(f"{session['id']}: {fname} up to date", file=sys.stderr)
            continue
        print(f"{session['id']}: building {fname}: " + " ".join(cmd), file=sys.stderr, flush=True)
        if args.dry_run:
            report["outputs"][name] = {"status": "dry-run"}
            continue
        t0 = time.time()
        rc = run_ffmpeg(cmd, os.path.join(sdir, name + ".log"))
        if rc != 0 or not os.path.exists(tmp):
            report["outputs"][name] = {"status": "failed", "exit": rc}
            print(f"{session['id']}: {fname} FAILED (exit {rc}); see {name}.log", file=sys.stderr)
            continue
        os.replace(tmp, final)
        state[name] = {"key": key, "bytes": os.path.getsize(final),
                       "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds")
                                          .replace("+00:00", "Z"),
                       "elapsedSec": round(time.time() - t0, 1), "command": cmd}
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=1)
        report["outputs"][name] = {"status": "built", "bytes": state[name]["bytes"],
                                   "elapsedSec": state[name]["elapsedSec"]}

    # ffprobe the outputs and compare durations with the index.
    checks = {}
    exp = manifest["expectedDurationSec"]
    for name, fname in (("audio", AUDIO_FILE), ("proxy", PROXY_FILE)):
        path = os.path.join(sdir, fname)
        if not os.path.exists(path) or args.dry_run:
            continue
        pr = ffprobe_streams(args.ffprobe, path)
        streams = []
        for s in pr.get("streams", []):
            d = s.get("duration")
            if d is None and pr.get("format", {}).get("duration"):
                d = pr["format"]["duration"]
            streams.append({"type": s.get("codec_type"), "codec": s.get("codec_name"),
                            "startSec": float(s["start_time"]) if s.get("start_time") else None,
                            "durationSec": float(d) if d else None,
                            "diffVsIndexSec": round(float(d) - exp, 4) if d else None,
                            **({"width": s.get("width"), "height": s.get("height"),
                                "fps": s.get("avg_frame_rate")} if s.get("codec_type") == "video" else
                               {"sampleRate": s.get("sample_rate"), "channels": s.get("channels")})})
        checks[name] = {"bytes": int(pr["format"]["size"]), "formatDurationSec": float(pr["format"]["duration"]),
                        "streams": streams}
    manifest["outputs"] = checks
    manifest_path = os.path.join(sdir, MANIFEST_FILE)
    old = {}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, encoding="utf-8") as fh:
                old = json.load(fh)
        except (OSError, ValueError):
            old = {}
    if args.dry_run and old.get("outputs"):
        # A dry run probes nothing: keep the output checks of the last real build.
        manifest["outputs"] = old["outputs"]
    if args.verify > 0 and not args.dry_run:
        manifest["verify"] = verify_session(sdir, manifest, args.corpus, args.ffmpeg, args.verify)
    elif (old and report["outputs"]
          and all(o["status"] in ("up-to-date", "dry-run") for o in report["outputs"].values())):
        # Nothing was rebuilt: keep the spot-check from the build that made these outputs.
        if "verify" in old:
            manifest["verify"] = old["verify"]
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=1)
    report["expectedDurationSec"] = exp
    report["checks"] = checks
    if "verify" in manifest:
        report["verify"] = manifest["verify"]
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build the per-session analysis cache (corpus is read only).")
    ap.add_argument("--index", required=True, help="index.json from session_index.py")
    ap.add_argument("--corpus", required=True, help="clips folder (read only)")
    ap.add_argument("--cache", required=True, help="cache folder (must be outside the corpus)")
    ap.add_argument("--session", action="append", required=True, help="session id (repeatable)")
    ap.add_argument("--only", default="audio,proxy", help="comma list of outputs: audio,proxy")
    ap.add_argument("--video-encoder", choices=("auto", "h264_nvenc", "libx264"), default="auto")
    ap.add_argument("--decode", choices=("cpu", "cuda"), default="cpu",
                    help="decoder for the proxy's video input (default cpu)")
    ap.add_argument("--force", action="store_true", help="rebuild even if up to date")
    ap.add_argument("--dry-run", action="store_true", help="write list + manifest, print commands, encode nothing")
    ap.add_argument("--verify", type=int, default=0, help="spot-check N random points per session")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    args = ap.parse_args(argv)
    args.only = {x.strip() for x in args.only.split(",") if x.strip()}

    if not os.path.isdir(args.corpus):
        print(f"corpus folder not found: {args.corpus}", file=sys.stderr)
        return 2
    if _is_inside(args.cache, args.corpus):
        print("refusing: cache folder is inside the corpus folder", file=sys.stderr)
        return 2
    with open(args.index, encoding="utf-8") as fh:
        index = json.load(fh)
    by_id = {s["id"]: s for s in index["sessions"]}
    missing = [s for s in args.session if s not in by_id]
    if missing:
        print(f"unknown session id(s): {', '.join(missing)}", file=sys.stderr)
        return 2
    for sid in args.session:
        absent = [c["file"] for c in by_id[sid]["clips"]
                  if not os.path.isfile(os.path.join(args.corpus, c["file"]))]
        if absent:
            print(f"{sid}: {len(absent)} clip(s) missing from the corpus, e.g. {absent[0]}", file=sys.stderr)
            return 2

    encoder = args.video_encoder
    if encoder == "auto":
        encoder = "h264_nvenc" if has_encoder(args.ffmpeg, "h264_nvenc") else "libx264"
    os.makedirs(args.cache, exist_ok=True)
    reports = []
    for sid in args.session:
        reports.append(build_session(by_id[sid], index, args, encoder))
    print(json.dumps({"encoder": encoder, "sessions": reports}, indent=1))
    failed = any(o.get("status") == "failed" for r in reports for o in r["outputs"].values())
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
