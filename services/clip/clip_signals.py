# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 signal readers: host markers, event-core chat, audio loudness, detector hits (seam).

All times returned are seconds into the recording (t = 0 at the first frame of the file).

Markers: host jsonl (app/host/src/moments.h) rows {v:1, at: ISO UTC, source, recordMs|null, ...}. A marker belongs
  to this recording when at - recordMs is within MATCH_TOLERANCE_SEC of the recording's start. The note is never
  read: chat notes are untrusted text.
Chat: event-core.db chat_raw (received_at = wall ms). Opened read-only (sqlite URI mode=ro), so the event core
  keeps sole ownership. Text is matched against the intent pattern in memory and never stored or written.
Audio: ffmpeg ebur128 short-term loudness (S, 3 s window) every 100 ms on the first audio stream, video skipped.
  framelog=info: the per-block lines are logged at info level (the default 'verbose' is hidden at ffmpeg's
  default log level; checked on ffmpeg 8.1).
Detector hits (seam for a future full-frame CODM pass): jsonl rows {t, detector, label?}; read only when given.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from datetime import datetime, timezone

from clip_common import ClipError, FFMPEG_THREADS, run_tool

MATCH_TOLERANCE_SEC = 5.0
STAMP = re.compile(r"(\d{8}-\d{6})\.[A-Za-z0-9]+$")


# ---------------------------------------------------------------- time

def parse_iso(s):
    if not isinstance(s, str):
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        return None
    return d.astimezone(timezone.utc)


def recording_start(path, explicit=None):
    """UTC start of a host recording: --record-start (ISO with zone) or the local-time stamp the host puts in the
    file name (<base>-YYYYMMDD-HHMMSS.ext, local time, 1 s resolution)."""
    if explicit:
        d = parse_iso(explicit)
        if not d:
            raise ClipError("--record-start must be ISO 8601 with a zone, e.g. 2026-11-03T05:08:46Z")
        return d
    m = STAMP.search(os.path.basename(path))
    if not m:
        raise ClipError("the recording name has no YYYYMMDD-HHMMSS stamp; pass --record-start")
    local = datetime.strptime(m.group(1), "%Y%m%d-%H%M%S")
    return local.astimezone().astimezone(timezone.utc)  # naive = local time


# ---------------------------------------------------------------- markers

def read_markers(paths, rec_start, duration, tolerance=MATCH_TOLERANCE_SEC):
    """Returns ([{t, source}], stats). Rows that do not belong to this recording are counted, not returned."""
    out, stats = [], {"rows": 0, "matched": 0, "noRecord": 0, "otherRecording": 0, "outOfRange": 0, "bad": 0}
    for p in paths or []:
        with open(p, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                stats["rows"] += 1
                try:
                    r = json.loads(line)
                except ValueError:
                    stats["bad"] += 1
                    continue
                at = parse_iso(r.get("at")) if isinstance(r, dict) else None
                src = r.get("source") if isinstance(r, dict) else None
                if not at or src not in ("hotkey", "chat", "audio", "api"):
                    stats["bad"] += 1
                    continue
                rec_ms = r.get("recordMs")
                if not isinstance(rec_ms, (int, float)) or isinstance(rec_ms, bool) or rec_ms < 0:
                    stats["noRecord"] += 1
                    continue
                derived = at.timestamp() - rec_ms / 1000.0
                if abs(derived - rec_start.timestamp()) > tolerance:
                    stats["otherRecording"] += 1
                    continue
                t = rec_ms / 1000.0
                if t > duration:
                    stats["outOfRange"] += 1
                    continue
                out.append({"t": round(t, 3), "source": src})
                stats["matched"] += 1
    out.sort(key=lambda m: m["t"])
    return out, stats


# ---------------------------------------------------------------- chat

def read_chat(db_path, rec_start, duration, intent_pattern):
    """Per-second message counts and intent counts for [0, duration). Returns (counts, intents, stats).
    Only received_at and (in memory) text are read; nothing from a row is kept except the two counts."""
    n = max(1, int(math.ceil(duration)))
    counts, intents = [0] * n, [0] * n
    stats = {"rows": 0, "platforms": {}}
    if not db_path:
        return counts, intents, None
    if not os.path.isfile(db_path):
        raise ClipError("chat database not found")
    rx = re.compile(intent_pattern, re.IGNORECASE)
    start_ms = int(rec_start.timestamp() * 1000)
    end_ms = start_ms + int(duration * 1000)
    uri = "file:" + os.path.abspath(db_path).replace("\\", "/") + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        cur = con.execute("SELECT received_at, platform, text FROM chat_raw WHERE received_at >= ? AND received_at < ?"
                          " ORDER BY received_at", (start_ms, end_ms))
        for received_at, platform, text in cur:
            i = int((received_at - start_ms) // 1000)
            if not 0 <= i < n:
                continue
            counts[i] += 1
            stats["rows"] += 1
            key = platform if isinstance(platform, str) and len(platform) <= 16 else "other"
            stats["platforms"][key] = stats["platforms"].get(key, 0) + 1
            if isinstance(text, str) and rx.search(text):
                intents[i] += 1
    except sqlite3.Error as e:
        raise ClipError(f"chat database: {e.__class__.__name__}") from None
    finally:
        con.close()
    stats["intents"] = sum(intents)
    return counts, intents, stats


# ---------------------------------------------------------------- audio

_EBUR = re.compile(r"\bt:\s*([0-9.]+)\s+.*?\bS:\s*(-?[0-9.]+|-inf|nan)", re.IGNORECASE)


def parse_ebur128(text, duration, floor):
    """Per-second max short-term loudness (LUFS) from ebur128 framelog lines; silence/-inf becomes floor."""
    n = max(1, int(math.ceil(duration)))
    out = [floor] * n
    seen = 0
    for m in _EBUR.finditer(text):
        t = float(m.group(1))
        try:
            s = float(m.group(2))
        except ValueError:
            continue
        if not math.isfinite(s):
            continue
        # ebur128 reports at the end of each 100 ms block; attribute the block to the second it covers.
        i = int(max(0.0, t - 0.05))
        if 0 <= i < n:
            out[i] = max(out[i], max(s, floor))
            seen += 1
    return out, seen


def audio_loudness(ffmpeg, path, duration, floor):
    """Runs ffmpeg ebur128 on the first audio stream (CPU, video not decoded). Returns (per-second LUFS, stats)."""
    argv = [ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-threads", str(FFMPEG_THREADS), "-vn", "-sn", "-dn",
            "-i", path, "-map", "0:a:0", "-af", "ebur128=framelog=info", "-f", "null", "-"]
    r = run_tool(argv, timeout=max(600, int(duration) * 2))
    if r.returncode != 0:
        if "matches no streams" in r.stderr or "Stream map" in r.stderr:
            return None, {"available": False, "reason": "no audio stream"}
        raise ClipError(f"ffmpeg ebur128 failed: {r.stderr.strip()[-200:]}")
    lufs, seen = parse_ebur128(r.stderr, duration, floor)
    return lufs, {"available": seen > 0, "blocks": seen}


# ---------------------------------------------------------------- detector hits (seam)

def read_hits(path, duration):
    """Detector hits jsonl {t, detector, label?}. Seam for a full-frame CODM pass (not built; detectors unverified)."""
    if not path:
        return [], None
    out, bad = [], 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                t = float(r["t"])
                det = str(r["detector"])[:32]
            except (ValueError, KeyError, TypeError):
                bad += 1
                continue
            if 0 <= t <= duration:
                label = r.get("label")
                out.append({"t": t, "detector": det, "label": str(label)[:64] if isinstance(label, str) else None})
    return out, {"hits": len(out), "bad": bad}
