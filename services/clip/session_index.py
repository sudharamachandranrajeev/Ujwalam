# SPDX-License-Identifier: GPL-3.0-or-later
"""Session index for a folder of Meld Studio automatic clips (P2a step A2).

Reads a flat folder of back-to-back clip MP4s, probes each file with ffprobe,
groups the clips into sessions and writes index.json and sessions.md to the
output folder. The corpus folder is only listed and probed; nothing in it is
opened for writing, moved, renamed or re-encoded.

Usage (Python stdlib only; run isolated):
  python -I services/clip/session_index.py --corpus <clips folder> --out <output folder>

Options:
  --workers N            ffprobe threads, 1-4 (default 4)
  --gap-threshold SEC    a gap larger than this starts a new session (default:
                         defaults.gapThresholdSec in --sessions-file, else 120)
  --utc-offset +HH:MM    offset applied to the filename's local wall-clock time (default +01:00, BST)
  --offset-valid-from    first local time the offset is valid for (default 2026-03-29T02:00)
  --offset-valid-until   local time the offset stops being valid (default 2026-10-25T01:00)
  --ffprobe PATH         ffprobe executable (default "ffprobe" on PATH)
  --name-time start|end  filename time is the clip's save/end time (default end; approved
                         working assumption, UNVERIFIED) or its start
  --sessions-file PATH   sessions.json: manual entries (source "manual") are read, applied
                         and kept exactly as written; rule entries are regenerated
  --boundaries PATH      boundaries.json from boundary_xcorr.py; measured trims are used
                         where present ("measured"), name-time trims elsewhere ("name-time")

The probe cache (probe-cache.json in the output folder) is keyed by
filename + size + mtime, so a rerun only probes new or changed files.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import statistics
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone

SCHEMA_VERSION = 1
CACHE_FILE = "probe-cache.json"
INDEX_FILE = "index.json"
SESSIONS_MD = "sessions.md"

NAME_RE = re.compile(
    r"^MeldStudio_Clip_Clipping_Output_"
    r"(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})_at_"
    r"(?P<h>\d{1,2})\.(?P<mi>\d{2})\.(?P<s>\d{2})(?P<ampm>am|pm)\.mp4$",
    re.IGNORECASE,
)

DURATION_OUTLIER_SEC = 3.0  # |duration - corpus median| above this is reported


# ---------------------------------------------------------------- parsing

def parse_offset(text: str) -> timezone:
    m = re.fullmatch(r"([+-])(\d{2}):(\d{2})", text.strip())
    if not m:
        raise ValueError(f"bad UTC offset {text!r}; expected +HH:MM")
    sign = 1 if m.group(1) == "+" else -1
    delta = timedelta(hours=int(m.group(2)), minutes=int(m.group(3)))
    return timezone(sign * delta)


def parse_clip_name(name: str) -> datetime | None:
    """Return the naive local wall-clock start time encoded in the name, or None."""
    m = NAME_RE.match(name)
    if not m:
        return None
    hour12 = int(m.group("h"))
    minute = int(m.group("mi"))
    second = int(m.group("s"))
    if not 1 <= hour12 <= 12:
        return None
    ampm = m.group("ampm").lower()
    hour24 = hour12 % 12 + (12 if ampm == "pm" else 0)  # 12am -> 0, 12pm -> 12
    try:
        return datetime(int(m.group("y")), int(m.group("mo")), int(m.group("d")),
                        hour24, minute, second)
    except ValueError:
        return None


def iso_local(dt: datetime, tz: timezone) -> str:
    return dt.replace(tzinfo=tz).isoformat()


def iso_utc(dt: datetime, tz: timezone) -> str:
    return dt.replace(tzinfo=tz).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------- probing

def _fps(text: str | None) -> float | None:
    if not text or text in ("0/0",):
        return None
    if "/" in text:
        num, den = text.split("/", 1)
        try:
            n, d = float(num), float(den)
        except ValueError:
            return None
        return round(n / d, 3) if d else None
    try:
        return float(text)
    except ValueError:
        return None


def ffprobe_file(path: str, ffprobe: str = "ffprobe") -> dict:
    """Probe one file read-only. Returns a probe record; raises RuntimeError on failure."""
    cmd = [
        ffprobe, "-v", "error",
        "-show_entries",
        "format=duration,size:stream=index,codec_type,codec_name,width,height,"
        "avg_frame_rate,sample_rate,channels",
        "-of", "json", path,
    ]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                          creationflags=flags)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe exit {proc.returncode}: {proc.stderr.strip()[:300]}")
    data = json.loads(proc.stdout or "{}")
    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    a0 = audio[0] if audio else {}
    try:
        duration = float(fmt["duration"])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("ffprobe returned no duration")
    return {
        "duration": duration,
        "width": video.get("width"),
        "height": video.get("height"),
        "avgFps": _fps(video.get("avg_frame_rate")),
        "videoCodec": video.get("codec_name"),
        "audioCodec": a0.get("codec_name"),
        "sampleRate": int(a0["sample_rate"]) if a0.get("sample_rate") else None,
        "channels": a0.get("channels"),
        "audioTracks": len(audio),
        "size": int(fmt["size"]) if fmt.get("size") else None,
    }


class ProbeCache:
    """ffprobe results keyed by filename; valid while size and mtime_ns match."""

    def __init__(self, path: str):
        self.path = path
        self.entries: dict[str, dict] = {}
        self._lock = threading.Lock()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if data.get("version") == SCHEMA_VERSION:
                self.entries = data.get("entries", {})

    def get(self, name: str, size: int, mtime_ns: int) -> dict | None:
        e = self.entries.get(name)
        if e and e.get("size") == size and e.get("mtimeNs") == mtime_ns:
            return e.get("probe")
        return None

    def put(self, name: str, size: int, mtime_ns: int, probe: dict) -> None:
        with self._lock:
            self.entries[name] = {"size": size, "mtimeNs": mtime_ns, "probe": probe}

    def save(self) -> None:
        with self._lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": SCHEMA_VERSION, "entries": self.entries}, fh)
            os.replace(tmp, self.path)


def probe_all(files: list[dict], cache: ProbeCache, probe_fn, workers: int = 4,
              save_every: int = 250, log=None) -> dict:
    """Fill files[i]['probe'] (or ['probeError']). Returns hit/miss counts.

    files: dicts with name, path, size, mtimeNs. probe_fn(path) -> probe record.
    """
    workers = max(1, min(4, workers))
    todo = []
    hits = 0
    for f in files:
        p = cache.get(f["name"], f["size"], f["mtimeNs"])
        if p is not None:
            f["probe"] = p
            hits += 1
        else:
            todo.append(f)
    done = 0
    failed = 0
    if todo:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(probe_fn, f["path"]): f for f in todo}
            for fut in concurrent.futures.as_completed(futs):
                f = futs[fut]
                try:
                    p = fut.result()
                    f["probe"] = p
                    cache.put(f["name"], f["size"], f["mtimeNs"], p)
                except Exception as exc:  # recorded as an anomaly; not cached so it is retried
                    f["probeError"] = str(exc)
                    failed += 1
                done += 1
                if done % save_every == 0:
                    cache.save()
                    if log:
                        log(f"probed {done}/{len(todo)}")
    cache.save()
    return {"cacheHits": hits, "probed": len(todo) - failed, "probeFailed": failed}


# ---------------------------------------------------------------- sessions

def format_key(p: dict) -> tuple:
    # avg_frame_rate varies in the last digits per clip (e.g. 60.002), so compare nominal fps.
    fps = p.get("avgFps")
    fps = round(fps) if isinstance(fps, (int, float)) else fps
    return (p.get("width"), p.get("height"), fps, p.get("videoCodec"),
            p.get("audioCodec"), p.get("sampleRate"), p.get("channels"),
            p.get("audioTracks"))


def format_label(k: tuple) -> str:
    w, h, fps, vc, ac, sr, ch, tracks = k
    return f"{w}x{h} {fps}fps {vc} / {ac} {sr}Hz {ch}ch x{tracks}"


def group_clips(ordered: list[dict], gap_threshold: float,
                 manual: list[dict] | None = None) -> tuple[list[tuple[list[dict], dict | None]], list[str]]:
    """Split time-ordered clips into groups.

    Clips from a manual entry's firstClip to lastClip (inclusive, in time order) form
    that entry's group. All other clips are grouped by the rule: a gap strictly greater
    than gap_threshold between the previous clip's end and the next clip's start begins
    a new group; a manual group also ends a rule group. Returns ([(clips, entry|None)],
    warnings). Manual entries that cannot be applied are reported, never dropped here.
    """
    pos = {c["file"]: i for i, c in enumerate(ordered)}
    claimed: list[dict | None] = [None] * len(ordered)
    warnings: list[str] = []
    for e in manual or []:
        i0, i1 = pos.get(e.get("firstClip")), pos.get(e.get("lastClip"))
        if i0 is None or i1 is None:
            warnings.append(f"manual session {e.get('id')}: firstClip/lastClip not in corpus; not applied")
            continue
        if i1 < i0:
            warnings.append(f"manual session {e.get('id')}: lastClip is before firstClip; not applied")
            continue
        if any(claimed[k] is not None for k in range(i0, i1 + 1)):
            warnings.append(f"manual session {e.get('id')}: overlaps another manual session; not applied")
            continue
        for k in range(i0, i1 + 1):
            claimed[k] = e

    groups: list[tuple[list[dict], dict | None]] = []
    prev = None
    for i, c in enumerate(ordered):
        e = claimed[i]
        if e is not None:
            if groups and groups[-1][1] is e:
                groups[-1][0].append(c)
            else:
                groups.append(([c], e))
        else:
            same = False
            if prev is not None and groups and groups[-1][1] is None:
                prev_end = prev["start"] + timedelta(seconds=prev["duration"])
                same = (c["start"] - prev_end).total_seconds() <= gap_threshold
            if same:
                groups[-1][0].append(c)
            else:
                groups.append(([c], None))
        prev = c
    return groups, warnings


def build_sessions(clips: list[dict], tz: timezone, gap_threshold: float = 120.0,
                   manual: list[dict] | None = None, measured: dict | None = None,
                   warnings: list[str] | None = None) -> list[dict]:
    """Group clips into sessions.

    clips: dicts with 'file', 'start' (naive local datetime), 'duration' (s).
    A gap strictly greater than gap_threshold between the previous clip's end
    (start + duration) and the next clip's start begins a new session, except where a
    manual entry (see group_clips) says otherwise.
    measured: {(fileA, fileB): trimInSec} from the audio boundary measurement. Where a
    boundary is measured, its trim is used ("measured"); elsewhere the trim comes from
    the name times ("name-time").
    """
    ordered = sorted(clips, key=lambda c: (c["start"], c["file"]))
    groups, warn = group_clips(ordered, gap_threshold, manual)
    if warnings is not None:
        warnings.extend(warn)
    measured = measured or {}

    sessions = []
    used_ids: set[str] = {e["id"] for _, e in groups if e is not None}
    for g, entry in groups:
        s0 = g[0]["start"]
        if entry is not None:
            sid = entry["id"]
        else:
            sid = "s-" + s0.strftime("%Y-%m-%d-%H%M")
            base, n = sid, 2
            while sid in used_ids:
                sid = f"{base}-{n}"
                n += 1
            used_ids.add(sid)

        out_clips = []
        boundaries = []
        offset = 0.0
        end = s0
        prev = None
        n_measured = 0
        for c in g:
            gap_before = None
            trim = 0.0
            method = None
            if prev is not None:
                prev_end = prev["start"] + timedelta(seconds=prev["duration"])
                gap_before = round((c["start"] - prev_end).total_seconds(), 3)
                boundaries.append(gap_before)
                m = measured.get((prev["file"], c["file"]))
                if m is not None:
                    trim = min(max(m, 0.0), c["duration"])
                    method = "measured"
                    n_measured += 1
                else:
                    if gap_before < 0:
                        trim = min(-gap_before, c["duration"])
                    method = "name-time"
            used = c["duration"] - trim
            out_clips.append({
                "file": c["file"],
                "startLocal": iso_local(c["start"], tz),
                "startUtc": iso_utc(c["start"], tz),
                "duration": round(c["duration"], 3),
                "gapBeforeSec": gap_before,
                "trimInSec": round(trim, 4),
                "trimMethod": method,
                "sessionOffsetSec": round(offset, 4),
                "wallOffsetSec": round((c["start"] - s0).total_seconds() + trim, 3),
            })
            offset += used
            c_end = c["start"] + timedelta(seconds=c["duration"])
            if c_end > end:
                end = c_end
            prev = c

        overlaps = [b for b in boundaries if b < 0]
        gaps = [b for b in boundaries if b > 0]
        sessions.append({
            "id": sid,
            "source": "manual" if entry is not None else "rule",
            "startLocal": iso_local(s0, tz),
            "startUtc": iso_utc(s0, tz),
            "endLocal": iso_local(end, tz),
            "endUtc": iso_utc(end, tz),
            "wallDurationSec": round((end - s0).total_seconds(), 3),
            "clipCount": len(g),
            "mediaDurationSec": round(sum(c["duration"] for c in g), 3),
            "trimmedDurationSec": round(offset, 4),
            "boundaries": {
                "count": len(boundaries),
                "measuredCount": n_measured,
                "overlapCount": len(overlaps),
                "gapCount": len(gaps),
                "exactCount": len(boundaries) - len(overlaps) - len(gaps),
                "min": min(boundaries) if boundaries else None,
                "max": max(boundaries) if boundaries else None,
                "overlapSecTotal": round(-sum(overlaps), 3),
                "gapSecTotal": round(sum(gaps), 3),
            },
            "anomalies": [],
            "clips": out_clips,
        })
    return sessions


# ---------------------------------------------------------------- whole run

def list_corpus(corpus: str) -> list[dict]:
    files = []
    with os.scandir(corpus) as it:
        for e in it:
            if not e.is_file(follow_symlinks=False):
                continue
            st = e.stat(follow_symlinks=False)
            files.append({"name": e.name, "path": e.path, "size": st.st_size,
                          "mtimeNs": st.st_mtime_ns})
    files.sort(key=lambda f: f["name"])
    return files


def build_index(files: list[dict], tz: timezone, gap_threshold: float,
                valid_from: datetime | None, valid_until: datetime | None,
                name_time: str = "end", manual: list[dict] | None = None,
                measured: dict | None = None) -> dict:
    """files: listing records with 'probe' or 'probeError' filled. Pure; no I/O.

    name_time: "end" (default; fits the A2b audio measurement) treats the
    filename time as the moment the clip was saved, so start = name time - duration;
    "start" treats it as the clip start.
    manual: manual session entries from sessions.json (see group_clips).
    measured: {(fileA, fileB): trimInSec} from boundary_xcorr.py.
    """
    if name_time not in ("start", "end"):
        raise ValueError("name_time must be 'start' or 'end'")
    corpus_anoms: list[dict] = []
    clips = []
    for f in files:
        start = parse_clip_name(f["name"])
        name_dt = start
        if start is None:
            corpus_anoms.append({"type": "unparseableName", "file": f["name"]})
            continue
        if (valid_from and start < valid_from) or (valid_until and start >= valid_until):
            corpus_anoms.append({"type": "outsideUtcOffsetWindow", "file": f["name"],
                                 "detail": "local time outside the window where the UTC offset assumption holds"})
        if "probe" not in f:
            corpus_anoms.append({"type": "probeFailed", "file": f["name"],
                                 "detail": f.get("probeError", "not probed")})
            continue
        dur = f["probe"]["duration"]
        if name_time == "end":
            start = name_dt - timedelta(seconds=dur)
        clips.append({"file": f["name"], "start": start, "nameTime": name_dt, "duration": dur,
                      "probe": f["probe"], "mtimeNs": f.get("mtimeNs")})

    # Majority format and duration median over all probed clips.
    fmt_counts: dict[tuple, int] = {}
    for c in clips:
        k = format_key(c["probe"])
        fmt_counts[k] = fmt_counts.get(k, 0) + 1
    majority = max(fmt_counts, key=fmt_counts.get) if fmt_counts else None
    durations = [c["duration"] for c in clips]
    median = statistics.median(durations) if durations else None

    # Duplicate start times.
    seen: dict[datetime, str] = {}
    dup = []
    for c in sorted(clips, key=lambda c: (c["start"], c["file"])):
        if c["start"] in seen:
            dup.append((seen[c["start"]], c["file"]))
        else:
            seen[c["start"]] = c["file"]

    session_warnings: list[str] = []
    sessions = build_sessions(clips, tz, gap_threshold, manual, measured, session_warnings)
    by_file = {c["file"]: c for c in clips}
    for s in sessions:
        last = s["clips"][-1]["file"]
        for oc in s["clips"]:
            c = by_file[oc["file"]]
            k = format_key(c["probe"])
            if k != majority:
                s["anomalies"].append({"type": "formatDiffers", "file": oc["file"],
                                       "detail": format_label(k)})
            if median is not None and abs(c["duration"] - median) > DURATION_OUTLIER_SEC:
                s["anomalies"].append({"type": "durationOutlier", "file": oc["file"],
                                       "detail": f"{c['duration']:.3f}s (median {median:.3f}s)"
                                                 + ("; last clip of session" if oc["file"] == last else "")})
            if oc["trimInSec"] >= c["duration"]:
                s["anomalies"].append({"type": "fullyOverlapped", "file": oc["file"],
                                       "detail": "overlap covers the whole clip"})
        for a, b in dup:
            if a in by_file and any(x["file"] == a for x in s["clips"]):
                s["anomalies"].append({"type": "duplicateStartTime", "file": b,
                                       "detail": f"same start as {a}"})

    # Diagnostic: file mtime minus filename time. About 0 suggests the name is the save
    # (end) time; about +duration suggests it is the start time.
    mt_minus_name = []
    for c in clips:
        if c.get("mtimeNs") is None:
            continue
        name_utc = c["nameTime"].replace(tzinfo=tz).timestamp()
        mt_minus_name.append(c["mtimeNs"] / 1e9 - name_utc)
    mt_stats = None
    if mt_minus_name:
        mt_minus_name.sort()
        mt_stats = {
            "min": round(mt_minus_name[0], 3),
            "median": round(statistics.median(mt_minus_name), 3),
            "max": round(mt_minus_name[-1], 3),
        }

    total_trim = sum(s["trimmedDurationSec"] for s in sessions)
    total_wall = sum(s["wallDurationSec"] for s in sessions)
    off = tz.utcoffset(None)
    sign = "+" if off >= timedelta(0) else "-"
    off_abs = abs(off)
    off_txt = f"{sign}{off_abs.seconds // 3600:02d}:{(off_abs.seconds % 3600) // 60:02d}"
    return {
        "version": SCHEMA_VERSION,
        "timezoneAssumption": (
            f"Filename timestamps are local wall-clock time at UTC{off_txt}"
            + (f", valid for local times {valid_from.isoformat()} to {valid_until.isoformat()}"
               if valid_from and valid_until else "")
            + f". Filename time is taken as the clip {name_time}"
            + (" (start = name time - duration)" if name_time == "end" else "")
            + " (UNVERIFIED; see summary.mtimeMinusNameSec)."
        ),
        "utcOffset": off_txt,
        "nameTime": name_time,
        "gapThresholdSec": gap_threshold,
        "durationOutlierSec": DURATION_OUTLIER_SEC,
        "summary": {
            "files": len(files),
            "parsed": len(files) - sum(1 for a in corpus_anoms if a["type"] == "unparseableName"),
            "probed": len(clips),
            "sessions": len(sessions),
            "clipsInSessions": sum(s["clipCount"] for s in sessions),
            "totalTrimmedSec": round(total_trim, 3),
            "boundaries": sum(s["boundaries"]["count"] for s in sessions),
            "boundariesMeasured": sum(s["boundaries"]["measuredCount"] for s in sessions),
            "totalWallSec": round(total_wall, 3),
            "totalMediaSec": round(sum(durations), 3),
            "totalBytes": sum(f["size"] for f in files),
            "durationMedianSec": median,
            "durationMinSec": min(durations) if durations else None,
            "durationMaxSec": max(durations) if durations else None,
            "majorityFormat": format_label(majority) if majority else None,
            "formats": {format_label(k): n for k, n in fmt_counts.items()},
            "mtimeMinusNameSec": mt_stats,
        },
        "corpusAnomalies": corpus_anoms,
        "sessionWarnings": session_warnings,
        "sessions": sessions,
    }


# ---------------------------------------------------------------- sessions.json

SESSIONS_FILE_VERSION = 1
DEFAULT_GAP_THRESHOLD = 120.0
RULE_KEYS = ("id", "source", "firstClip", "lastClip", "startLocal", "startUtc",
             "endLocal", "endUtc", "clipCount")
MANUAL_REQUIRED = ("id", "source", "firstClip", "lastClip")
ENTRY_KEYS = set(RULE_KEYS) | {"note"}
TOP_KEYS = {"$schema", "version", "about", "defaults", "rule", "sessions"}
SESSIONS_ABOUT = (
    "Session boundaries for the clip corpus. Entries with source 'rule' are regenerated by "
    "services/clip/session_index.py --sessions-file; entries with source 'manual' are kept "
    "exactly as written and win over the rule. File names and times only."
)


def _ms(iso: str) -> str:
    """ISO time rounded down to milliseconds; keeps a trailing Z."""
    z = iso.endswith("Z")
    t = datetime.fromisoformat(iso[:-1] + "+00:00" if z else iso).isoformat(timespec="milliseconds")
    return t.replace("+00:00", "Z") if z else t


def validate_sessions_doc(doc) -> list[str]:
    """Structural check that mirrors data/sessions.schema.json (stdlib only)."""
    errs: list[str] = []
    if not isinstance(doc, dict):
        return ["top level must be an object"]
    for k in doc:
        if k not in TOP_KEYS:
            errs.append(f"unknown top-level key {k!r}")
    if doc.get("version") != SESSIONS_FILE_VERSION:
        errs.append(f"version must be {SESSIONS_FILE_VERSION}")
    d = doc.get("defaults")
    if not isinstance(d, dict) or not isinstance(d.get("gapThresholdSec"), (int, float)) \
            or isinstance(d.get("gapThresholdSec"), bool) or d.get("gapThresholdSec") <= 0:
        errs.append("defaults.gapThresholdSec must be a number > 0")
    ss = doc.get("sessions")
    if not isinstance(ss, list):
        return errs + ["sessions must be an array"]
    ids = set()
    for i, e in enumerate(ss):
        where = f"sessions[{i}]"
        if not isinstance(e, dict):
            errs.append(f"{where} must be an object")
            continue
        src = e.get("source")
        if src not in ("rule", "manual"):
            errs.append(f"{where}.source must be 'rule' or 'manual'")
            continue
        for k in (RULE_KEYS if src == "rule" else MANUAL_REQUIRED):
            if k not in e:
                errs.append(f"{where} ({src}) is missing {k!r}")
        for k in e:
            if k not in ENTRY_KEYS:
                errs.append(f"{where} has unknown key {k!r}")
        if not isinstance(e.get("id"), str) or not re.fullmatch(r"s-[0-9A-Za-z-]+", e.get("id", "")):
            errs.append(f"{where}.id must match s-[0-9A-Za-z-]+")
        elif e["id"] in ids:
            errs.append(f"{where}.id {e['id']!r} is duplicated")
        else:
            ids.add(e["id"])
        for k in ("firstClip", "lastClip"):
            if k in e and not (isinstance(e[k], str) and e[k].lower().endswith(".mp4")):
                errs.append(f"{where}.{k} must be a .mp4 file name")
        if "clipCount" in e and (not isinstance(e["clipCount"], int) or isinstance(e["clipCount"], bool)
                                 or e["clipCount"] < 1):
            errs.append(f"{where}.clipCount must be an integer >= 1")
        if "note" in e and not isinstance(e["note"], str):
            errs.append(f"{where}.note must be a string")
    return errs


def load_sessions_file(path: str) -> dict | None:
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def file_gap_threshold(doc: dict | None) -> float:
    try:
        return float(doc["defaults"]["gapThresholdSec"])
    except (TypeError, KeyError, ValueError):
        return DEFAULT_GAP_THRESHOLD


def manual_entries(doc: dict | None) -> list[dict]:
    if not doc:
        return []
    return [e for e in doc.get("sessions", []) if isinstance(e, dict) and e.get("source") == "manual"]


def rule_entry(s: dict) -> dict:
    return {
        "id": s["id"],
        "source": "rule",
        "firstClip": s["clips"][0]["file"],
        "lastClip": s["clips"][-1]["file"],
        "startLocal": _ms(s["startLocal"]),
        "startUtc": _ms(s["startUtc"]),
        "endLocal": _ms(s["endLocal"]),
        "endUtc": _ms(s["endUtc"]),
        "clipCount": s["clipCount"],
    }


def merge_sessions_file(existing: dict | None, sessions: list[dict], gap_used: float,
                        name_time: str) -> dict:
    """Manual entries are kept exactly as written (also those that could not be applied);
    rule entries are regenerated from `sessions` (the output of build_sessions)."""
    defaults = dict((existing or {}).get("defaults") or {})
    defaults.setdefault("gapThresholdSec", DEFAULT_GAP_THRESHOLD)
    manual = manual_entries(existing)
    by_id = {e["id"]: e for e in manual if isinstance(e.get("id"), str)}
    out, kept = [], set()
    for s in sessions:
        if s.get("source") == "manual" and s["id"] in by_id:
            out.append(by_id[s["id"]])
            kept.add(id(by_id[s["id"]]))
        else:
            out.append(rule_entry(s))
    for e in manual:  # never drop a manual entry, even one that matched no clips
        if id(e) not in kept:
            out.append(e)
    return {
        "$schema": "./sessions.schema.json",
        "version": SESSIONS_FILE_VERSION,
        "about": (existing or {}).get("about", SESSIONS_ABOUT),
        "defaults": defaults,
        "rule": {"gapThresholdSec": gap_used, "nameTime": name_time},
        "sessions": out,
    }


def write_json_atomic(path: str, doc: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


# A measured trim is used only if it agrees with the file-name times: the residual
# (name delta minus the delta the measurement predicts under the --name-time
# hypothesis) must fall in this range. Names have 1 s resolution, so a true match lies
# in about (-0.2, 1.0) s; the A2b corpus measurement found 641 of 645 matches in
# -0.23 .. 0.92 s. The rest were matches of repeated game audio, not the true overlap.
NAME_RESIDUAL_RANGE = (-0.30, 1.00)


def load_measured(path: str | None, name_time: str = "end",
                  rejected: list | None = None) -> dict:
    """{(fileA, fileB): trimInSec} for boundaries measured with status 'ok' whose
    residual under `name_time` is inside NAME_RESIDUAL_RANGE. Boundaries that fail that
    check are appended to `rejected` as (fileA, fileB, residual) and keep the
    name-time trim."""
    if not path:
        return {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    key = "residualEndHyp" if name_time == "end" else "residualStartHyp"
    lo, hi = NAME_RESIDUAL_RANGE
    out = {}
    for m in data.get("boundaries", []):
        if m.get("status") != "ok" or "trimInSec" not in m:
            continue
        res = m.get(key)
        if res is not None and not lo <= res <= hi:
            if rejected is not None:
                rejected.append((m["a"], m["b"], res))
            continue
        out[(m["a"], m["b"])] = float(m["trimInSec"])
    return out


def _hms(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 3600}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"


def render_markdown(index: dict) -> str:
    s = index["summary"]
    lines = [
        "# Clip corpus session index",
        "",
        f"Timezone: {index['timezoneAssumption']}",
        "",
        f"Files {s['files']}, parsed {s['parsed']}, probed {s['probed']}, sessions {s['sessions']}. "
        f"Trimmed media {_hms(s['totalTrimmedSec'])} ({s['totalTrimmedSec'] / 3600:.2f} h); "
        f"wall {_hms(s['totalWallSec'])}; untrimmed media {_hms(s['totalMediaSec'])}.",
        "",
        "Gap/overlap columns: seconds between the previous clip's end and the next clip's start "
        "(negative = overlap). Counts are overlaps / gaps / exact.",
        "",
        "| Session | Source | Start (local) | End (local) | Wall | Clips | Trimmed media | Overlap/gap/exact | Min | Max | Measured trims | Anomalies |",
        "|---|---|---|---|---|---:|---|---|---:|---:|---:|---:|",
    ]
    for x in index["sessions"]:
        b = x["boundaries"]
        lines.append(
            f"| {x['id']} | {x.get('source', 'rule')} | {x['startLocal'][:19].replace('T', ' ')} "
            f"| {x['endLocal'][:19].replace('T', ' ')} "
            f"| {_hms(x['wallDurationSec'])} | {x['clipCount']} | {_hms(x['trimmedDurationSec'])} "
            f"| {b['overlapCount']}/{b['gapCount']}/{b['exactCount']} "
            f"| {'' if b['min'] is None else f'{b['min']:.3f}'} | {'' if b['max'] is None else f'{b['max']:.3f}'} "
            f"| {b.get('measuredCount', 0)}/{b['count']} | {len(x['anomalies'])} |"
        )
    lines += ["", "## Anomalies", ""]
    any_anom = False
    for a in index["corpusAnomalies"]:
        any_anom = True
        lines.append(f"- corpus: {a['type']} `{a['file']}` {a.get('detail', '')}".rstrip())
    for x in index["sessions"]:
        for a in x["anomalies"]:
            any_anom = True
            lines.append(f"- {x['id']}: {a['type']} `{a['file']}` {a.get('detail', '')}".rstrip())
    for w in index.get("sessionWarnings", []):
        any_anom = True
        lines.append(f"- warning: {w}")
    if not any_anom:
        lines.append("None.")
    lines.append("")
    return "\n".join(lines)


def _is_inside(child: str, parent: str) -> bool:
    child = os.path.normcase(os.path.realpath(child))
    parent = os.path.normcase(os.path.realpath(parent))
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build a session index of a clip corpus (read-only).")
    ap.add_argument("--corpus", required=True, help="clips folder (read only)")
    ap.add_argument("--out", required=True, help="output folder (created if missing)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--gap-threshold", type=float, default=None,
                    help="a gap larger than this (s) starts a new session; default: "
                         "defaults.gapThresholdSec in --sessions-file, else 120")
    ap.add_argument("--utc-offset", default="+01:00")
    ap.add_argument("--offset-valid-from", default="2026-03-29T02:00")
    ap.add_argument("--offset-valid-until", default="2026-10-25T01:00")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--name-time", choices=("start", "end"), default="end",
                    help="whether the filename time is the clip start or its save (end) time "
                         "(default end: fits the A2b audio cross-correlation measurement)")
    ap.add_argument("--sessions-file", default=None,
                    help="sessions.json to read manual entries from and write merged entries to")
    ap.add_argument("--boundaries", default=None,
                    help="boundaries.json from boundary_xcorr.py; measured trims replace name-time trims")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.corpus):
        print(f"corpus folder not found: {args.corpus}", file=sys.stderr)
        return 2
    if _is_inside(args.out, args.corpus):
        print("refusing: output folder is inside the corpus folder", file=sys.stderr)
        return 2
    if args.sessions_file and _is_inside(args.sessions_file, args.corpus):
        print("refusing: sessions file is inside the corpus folder", file=sys.stderr)
        return 2
    existing = load_sessions_file(args.sessions_file)
    if existing is not None:
        errs = validate_sessions_doc(existing)
        if errs:
            print("sessions file is invalid; not changed:\n  " + "\n  ".join(errs), file=sys.stderr)
            return 2
    gap_threshold = args.gap_threshold if args.gap_threshold is not None else file_gap_threshold(existing)
    if gap_threshold <= 0:
        print("--gap-threshold must be > 0", file=sys.stderr)
        return 2
    inconsistent = []
    measured = load_measured(args.boundaries, args.name_time, inconsistent)
    tz = parse_offset(args.utc_offset)
    vf = datetime.fromisoformat(args.offset_valid_from) if args.offset_valid_from else None
    vu = datetime.fromisoformat(args.offset_valid_until) if args.offset_valid_until else None

    os.makedirs(args.out, exist_ok=True)
    files = list_corpus(args.corpus)
    cache = ProbeCache(os.path.join(args.out, CACHE_FILE))
    log = lambda m: print(m, file=sys.stderr, flush=True)
    stats = probe_all(files, cache, lambda p: ffprobe_file(p, args.ffprobe),
                      workers=args.workers, log=log)
    index = build_index(files, tz, gap_threshold, vf, vu, args.name_time,
                        manual_entries(existing), measured)
    index["generatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    index["probeRun"] = stats
    if args.boundaries:
        index["boundariesFile"] = os.path.abspath(args.boundaries)
        index["measuredTrimsNotUsed"] = [
            {"a": a, "b": b, "residualSec": round(r, 3),
             "reason": f"residual outside {list(NAME_RESIDUAL_RANGE)} s; name-time trim kept"}
            for a, b, r in inconsistent]

    tmp = os.path.join(args.out, INDEX_FILE + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    os.replace(tmp, os.path.join(args.out, INDEX_FILE))
    with open(os.path.join(args.out, SESSIONS_MD), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(render_markdown(index))

    if args.sessions_file:
        doc = merge_sessions_file(existing, index["sessions"], gap_threshold, args.name_time)
        errs = validate_sessions_doc(doc)
        if errs:
            print("merged sessions file failed validation; not written:\n  " + "\n  ".join(errs),
                  file=sys.stderr)
            return 1
        write_json_atomic(args.sessions_file, doc)
    for w in index["sessionWarnings"]:
        print("warning: " + w, file=sys.stderr)

    s = index["summary"]
    print(json.dumps({"probeRun": stats, "files": s["files"], "parsed": s["parsed"],
                      "probed": s["probed"], "sessions": s["sessions"],
                      "nameTime": args.name_time, "gapThresholdSec": gap_threshold,
                      "boundaries": s["boundaries"], "boundariesMeasured": s["boundariesMeasured"],
                      "totalTrimmedHours": round(s["totalTrimmedSec"] / 3600, 3),
                      "corpusAnomalies": len(index["corpusAnomalies"]),
                      "sessionAnomalies": sum(len(x["anomalies"]) for x in index["sessions"])},
                     indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
