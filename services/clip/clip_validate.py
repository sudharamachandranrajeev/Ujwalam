# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 clip validation: ffprobe facts checked against the output frame and every target in data/clip/targets.json.

Checks per file: video codec, frame size, pixel format yuv420p, fps <= target max, audio present and its codec,
duration within DURATION_TOLERANCE_SEC of the candidate window and inside each target's min/max, file size under a
target's maxFileBytes when set, and (optional) a full decode with no errors. A target whose values are unverified
still checks; the report carries the flag.

Audio (2026-11-08): every file reports its audio track count and, per track, the integrated loudness (LUFS) and true
peak (dBTP) from ffmpeg ebur128. A file with fewer audio tracks than its source fails (a track was dropped). Loudness
is reported only, never judged: a near-silent or mic-only mix cannot be told from a quiet game reliably, so there is
no game-audio check; `quiet` marks a track below QUIET_LUFS for a human to listen to.
"""

from __future__ import annotations

import re

from clip_common import FFMPEG_THREADS, media_info, run_tool

DURATION_TOLERANCE_SEC = 0.6
QUIET_LUFS = -50.0
_SUMMARY_I = re.compile(r"Integrated loudness:\s*I:\s*(-?[0-9.]+|-inf)\s*LUFS", re.IGNORECASE)
_SUMMARY_PEAK = re.compile(r"True peak:\s*Peak:\s*(-?[0-9.]+|-inf)\s*dBFS", re.IGNORECASE)


def parse_loudness_summary(text):
    """(integrated LUFS, true peak dBTP) from the ebur128 summary ffmpeg prints at the end; None when absent or -inf."""
    def last(rx):
        ms = rx.findall(text)
        if not ms or ms[-1].lower() == "-inf":
            return None
        return round(float(ms[-1]), 1)
    return last(_SUMMARY_I), last(_SUMMARY_PEAK)


def audio_stats(ffmpeg, path, tracks):
    """[{track, lufs, peakDb, quiet}] per audio track (1-based track numbers)."""
    out = []
    for k in range(int(tracks or 0)):
        r = run_tool([ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-threads", str(FFMPEG_THREADS), "-vn", "-sn", "-dn",
                      "-i", path, "-map", f"0:a:{k}", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
                     timeout=600)
        lufs, peak = parse_loudness_summary(r.stderr) if r.returncode == 0 else (None, None)
        out.append({"track": k + 1, "lufs": lufs, "peakDb": peak, "quiet": lufs is None or lufs < QUIET_LUFS,
                    **({} if r.returncode == 0 else {"error": r.stderr.strip()[-200:]})})
    return out


def check_file(info, expected_dur, frame, targets, source_tracks=None):
    """Pure check of ffprobe facts. Returns {ok, issues, targets: {id: {ok, issues, unverified}}}. source_tracks: the
    audio track count of the source recording, when known (fewer tracks in the file = a track was dropped)."""
    base = []
    if info["vcodec"] != "h264":
        base.append(f"video codec {info['vcodec']} (want h264)")
    if (info["width"], info["height"]) != (int(frame["width"]), int(frame["height"])):
        base.append(f"frame {info['width']}x{info['height']} (want {frame['width']}x{frame['height']})")
    if info["pix_fmt"] != "yuv420p":
        base.append(f"pixel format {info['pix_fmt']} (want yuv420p)")
    if not info["has_audio"]:
        base.append("no audio stream")
    elif source_tracks and info.get("audio_tracks", 1) < int(source_tracks):
        base.append(f"{info.get('audio_tracks', 1)} audio track(s) (source has {source_tracks})")
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


def validate_file(ffmpeg, ffprobe, path, expected_dur, frame, targets, decode=True, source_tracks=None, loudness=True):
    info = media_info(ffprobe, path)
    res = check_file(info, expected_dur, frame, targets, source_tracks)
    res["facts"] = {k: info.get(k) for k in ("duration", "width", "height", "fps", "vcodec", "pix_fmt", "acodec", "size",
                                             "audio_tracks")}
    res["audio"] = {"tracks": info.get("audio_tracks", 0), "sourceTracks": source_tracks,
                    "loudness": audio_stats(ffmpeg, path, info.get("audio_tracks", 0)) if loudness else None}
    res["facts"]["duration"] = round(res["facts"]["duration"], 3)
    res["facts"]["fps"] = round(res["facts"]["fps"], 3)
    if decode:
        ok, errs = decode_check(ffmpeg, path)
        res["decode"] = {"ok": ok, "errors": errs}
        if not ok:
            res["ok"] = False
            res["issues"].append("decode errors")
    return res
