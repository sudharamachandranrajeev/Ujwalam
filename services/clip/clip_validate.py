# SPDX-License-Identifier: GPL-2.0-or-later
"""F6 clip validation: ffprobe facts checked against the output frame and every target in data/clip/targets.json.

Checks per file: video codec, frame size, pixel format yuv420p, fps <= target max, audio present and its codec,
duration within DURATION_TOLERANCE_SEC of the candidate window and inside each target's min/max, file size under a
target's maxFileBytes when set, and (optional) a full decode with no errors. A target whose values are unverified
still checks; the report carries the flag.
"""

from __future__ import annotations

from clip_common import FFMPEG_THREADS, media_info, run_tool

DURATION_TOLERANCE_SEC = 0.6


def check_file(info, expected_dur, frame, targets):
    """Pure check of ffprobe facts. Returns {ok, issues, targets: {id: {ok, issues, unverified}}}."""
    base = []
    if info["vcodec"] != "h264":
        base.append(f"video codec {info['vcodec']} (want h264)")
    if (info["width"], info["height"]) != (int(frame["width"]), int(frame["height"])):
        base.append(f"frame {info['width']}x{info['height']} (want {frame['width']}x{frame['height']})")
    if info["pix_fmt"] != "yuv420p":
        base.append(f"pixel format {info['pix_fmt']} (want yuv420p)")
    if not info["has_audio"]:
        base.append("no audio stream")
    if expected_dur is not None and abs(info["duration"] - expected_dur) > DURATION_TOLERANCE_SEC:
        base.append(f"duration {info['duration']:.2f}s (want {expected_dur:.2f}s)")
    per = {}
    for t in targets.get("targets", []):
        iss = []
        if info["vcodec"] not in t["videoCodecs"]:
            iss.append(f"video codec {info['vcodec']}")
        if info["has_audio"] and info["acodec"] not in t["audioCodecs"]:
            iss.append(f"audio codec {info['acodec']}")
        if info["fps"] > float(t["maxFps"]) + 0.01:
            iss.append(f"fps {info['fps']:.2f} > {t['maxFps']}")
        if info["duration"] < float(t["minDurationSec"]):
            iss.append(f"duration {info['duration']:.2f}s < {t['minDurationSec']}s")
        if info["duration"] > float(t["maxDurationSec"]):
            iss.append(f"duration {info['duration']:.2f}s > {t['maxDurationSec']}s")
        if t.get("maxFileBytes") and info["size"] > int(t["maxFileBytes"]):
            iss.append(f"size {info['size']} > {t['maxFileBytes']}")
        per[t["id"]] = {"ok": not iss and not base, "issues": iss, "unverified": bool(t.get("unverified"))}
    return {"ok": not base and all(v["ok"] for v in per.values()), "issues": base, "targets": per}


def decode_check(ffmpeg, path):
    r = run_tool([ffmpeg, "-v", "error", "-nostdin", "-threads", str(FFMPEG_THREADS), "-i", path, "-f", "null", "-"],
                 timeout=1800)
    errs = [ln for ln in r.stderr.splitlines() if ln.strip()]
    return r.returncode == 0 and not errs, errs[:5]


def validate_file(ffmpeg, ffprobe, path, expected_dur, frame, targets, decode=True):
    info = media_info(ffprobe, path)
    res = check_file(info, expected_dur, frame, targets)
    res["facts"] = {k: info[k] for k in ("duration", "width", "height", "fps", "vcodec", "pix_fmt", "acodec", "size")}
    res["facts"]["duration"] = round(res["facts"]["duration"], 3)
    res["facts"]["fps"] = round(res["facts"]["fps"], 3)
    if decode:
        ok, errs = decode_check(ffmpeg, path)
        res["decode"] = {"ok": ok, "errors": errs}
        if not ok:
            res["ok"] = False
            res["issues"].append("decode errors")
    return res
