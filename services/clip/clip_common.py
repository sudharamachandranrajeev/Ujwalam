# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for the F6 post-stream clip pipeline (docs/plan/2026-11-03-f6-clip-pipeline-plan.md).

Stdlib only. Covers:
  - the feature flag gate (same rules as services/flags/index.mjs: an id missing from data/flags.json is off;
    <dataDir>/flags.local.json overrides the committed default; only booleans count),
  - data-dir resolution (--data-dir, else paths.event_core_data in data/profile.local.json),
  - ffmpeg / ffprobe lookup (explicit path, else PATH; never downloaded),
  - laptop budget: children at below-normal priority on Windows, ffmpeg threads capped,
  - output safety: never inside the clips corpus; inside the repository only when gitignored.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time

# No console window on Windows (D191): every subprocess call passes **NO_WINDOW.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

PARENT_PIPE_ENV = "UJWALAM_PARENT_PIPE"
_JOB = None  # the kill-on-close job of contain_children(); held (never closed) for the life of this process


def contain_children():
    """Windows (user 2026-11-09, D310 proposed): puts this process in a new job object that kills every member when
    its last handle closes. Children started from now on (ffmpeg) are members too, so however this process ends
    (finished, crashed, or killed by the launcher: a plain kill ends only this process) none of them runs on unseen.
    Returns True when the job is in place; False elsewhere or when Windows refused (the parent pipe still applies)."""
    global _JOB
    if os.name != "nt":
        return False
    if _JOB is not None:
        return True
    import ctypes
    from ctypes import wintypes

    class BASIC(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

    class EXTENDED(ctypes.Structure):
        _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return False
    info = EXTENDED()
    info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) or \
            not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):  # 9: JobObjectExtendedLimitInformation
        k32.CloseHandle(job)
        return False
    _JOB = job
    return True


def end_own_tree(pid=None, run=None):
    """Ends this process and every process it started (ffmpeg, workers). Windows: taskkill /T /F from System32, no
    console window (D191); elsewhere SIGKILL to the process. Never returns when it works."""
    pid = os.getpid() if pid is None else pid
    if os.name == "nt":
        root = os.environ.get("SystemRoot", "")
        exe = os.path.join(root, "System32", "taskkill.exe") if root else ""
        if exe and os.path.isfile(exe):
            (run or subprocess.run)([exe, "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=15, **NO_WINDOW)
    os._exit(1)


def end_tree_when_parent_gone(env=None, stdin=None, on_gone=None):
    """Parent pipe (D234; user 2026-11-09, D310 proposed): with UJWALAM_PARENT_PIPE=1 the launcher holds our stdin as
    a pipe. End-of-file means Ujwalam is gone (closed, crashed or hard-killed); the clip job then ends itself and its
    ffmpeg children, so nothing runs on unseen. Returns the watcher thread, or None without the env marker."""
    import threading
    if (env if env is not None else os.environ).get(PARENT_PIPE_ENV) != "1":
        return None
    src = stdin if stdin is not None else sys.stdin.buffer
    gone = on_gone or end_own_tree

    def read():
        try:
            while src.read(64):
                pass
        except (OSError, ValueError):
            pass
        gone()

    t = threading.Thread(target=read, name="parent-pipe", daemon=True)
    t.start()
    return t

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
FLAGS_FILE = os.path.join(REPO_ROOT, "data", "flags.json")
CLIP_DATA = os.path.join(REPO_ROOT, "data", "clip")
PROFILE_FILE = os.path.join(REPO_ROOT, "data", "profile.local.json")
FLAG_ID = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
FLAG = "clip-pipeline"
LOCAL_FLAGS = "flags.local.json"

# Laptop budget (user instruction 2026-10-27): about 4 threads, below-normal priority, one heavy job at a time.
FFMPEG_THREADS = 4

EXIT_FLAG_OFF = 3


class ClipError(Exception):
    """A user-facing failure (bad input, missing tool). The CLI prints the message and exits 1."""


# ---------------------------------------------------------------- json

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ClipError(f"missing file: {os.path.basename(path)}") from None
    except ValueError:
        raise ClipError(f"not valid JSON: {os.path.basename(path)}") from None


def write_json_atomic(path, obj):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def load_config(name, path=None):
    """Loads data/clip/<name>.json (or an explicit path)."""
    return load_json(path or os.path.join(CLIP_DATA, f"{name}.json"))


# ---------------------------------------------------------------- flags

def flag_definitions(defs_file=FLAGS_FILE):
    j = load_json(defs_file)
    if not isinstance(j, dict) or not isinstance(j.get("flags"), list):
        raise ClipError("flags: bad definitions file")
    out = {}
    for f in j["flags"]:
        if not isinstance(f, dict) or not isinstance(f.get("id"), str) or not FLAG_ID.match(f["id"]):
            raise ClipError("flags: bad id")
        if not isinstance(f.get("default"), bool):
            raise ClipError(f"flags: bad entry {f['id']}")
        out[f["id"]] = f["default"]
    return out


SETTINGS_FILE = "settings.json"
CLIP_MODES = ("ask", "after", "while", "off")
WORKER_FILE = os.path.join("clips", "live-worker.json")
WORKER_FRESH_SEC = 30.0


def clip_settings(data_dir):
    """The user's clip choices from <data>/settings.json (D284): {"recording": mode, "live": mode}; "ask" when unset."""
    out = {"recording": "ask", "live": "ask"}
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    if isinstance(c, dict):
        for k in out:
            if c.get(k) in CLIP_MODES:
                out[k] = c[k]
    return out


MATCH_GATE_DEFAULTS = {"top3": True, "minKills": None}
MIN_KILLS_RANGE = (1, 200)


def match_gate_settings(data_dir):
    """The match gate (D286 proposed) from <data>/settings.json clips.matchGate: {"top3": bool, "minKills": int 1..200
    or None}. Missing or invalid values fall back to the defaults (top3 on, kills rule off), as user-settings.mjs."""
    out = dict(MATCH_GATE_DEFAULTS)
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    g = c.get("matchGate") if isinstance(c, dict) else None
    if not isinstance(g, dict):
        return out
    if isinstance(g.get("top3"), bool):
        out["top3"] = g["top3"]
    k = g.get("minKills")
    if k is None or (isinstance(k, int) and not isinstance(k, bool) and MIN_KILLS_RANGE[0] <= k <= MIN_KILLS_RANGE[1]):
        out["minKills"] = k
    return out


PROGRESS_PREFIX = "ujwalam-progress "
PROGRESS_STAGES = ("detect", "candidates", "render", "validate", "review", "gate")


def progress_line(stage, done, total, note=""):
    """One progress line for the UI (contract shared with the studio): on stderr,
    ujwalam-progress {"stage":"<stage>","done":<int>,"total":<int>,"note":"<short plain text, no names>"}"""
    if stage not in PROGRESS_STAGES:
        raise ValueError(f"unknown progress stage {stage}")
    note = " ".join(str(note or "").split())[:120]
    line = PROGRESS_PREFIX + json.dumps({"stage": stage, "done": int(done), "total": int(total), "note": note},
                                        separators=(",", ":"), ensure_ascii=True)
    print(line, file=sys.stderr, flush=True)
    return line


def clips_allowed(data_dir):
    """The clipper may run when the developer flag is on or the user chose any clip mode other than off (D284)."""
    return flag_on(data_dir, FLAG) or any(v != "off" for v in clip_settings(data_dir).values())


def worker_wanted(data_dir, now=None):
    """True while the launcher asks the live clipper to watch (the user chose "while recording" or "while live" and
    that is happening now): <data>/clips/live-worker.json {"on": true, "atMs": ...}, ignored when older than 30 s."""
    try:
        j = load_json(os.path.join(data_dir, WORKER_FILE))
    except (OSError, ClipError):
        return False
    if not isinstance(j, dict) or j.get("on") is not True or not isinstance(j.get("atMs"), (int, float)):
        return False
    now = time.time() if now is None else now
    return abs(now - j["atMs"] / 1000.0) <= WORKER_FRESH_SEC


def flag_on(data_dir, flag_id=FLAG, defs_file=FLAGS_FILE):
    """True when the flag is on: the local override if it is a boolean, else the committed default."""
    defs = flag_definitions(defs_file)
    if flag_id not in defs:
        return False
    if data_dir:
        try:
            j = load_json(os.path.join(data_dir, LOCAL_FLAGS))
        except (OSError, ClipError):
            j = None
        v = j.get("flags", {}).get(flag_id) if isinstance(j, dict) and isinstance(j.get("flags"), dict) else None
        if isinstance(v, bool):
            return v
    return defs[flag_id]


def resolve_data_dir(arg=None, profile=PROFILE_FILE):
    """--data-dir, else paths.event_core_data from the local profile (the studio and event core share it)."""
    if arg:
        return os.path.abspath(arg)
    try:
        v = load_json(profile).get("paths", {}).get("event_core_data")
    except (OSError, ClipError, AttributeError):
        v = None
    if isinstance(v, str) and v and not (v.startswith("<") and v.endswith(">")):
        return os.path.abspath(os.path.join(REPO_ROOT, v))
    return None


def corpus_dir(profile=PROFILE_FILE):
    try:
        v = load_json(profile).get("paths", {}).get("clips_corpus")
    except (OSError, ClipError, AttributeError):
        return None
    if isinstance(v, str) and v and not (v.startswith("<") and v.endswith(">")):
        return v
    return None


# ---------------------------------------------------------------- safety

def _real(p):
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def is_inside(path, root):
    return bool(root) and (_real(path) + os.sep).startswith(_real(root) + os.sep)


def check_out_dir(path, corpus=None):
    """The output folder must not be inside the clips corpus; inside the repository it must be gitignored
    (clips are media and captions hold speech)."""
    if is_inside(path, corpus) or (corpus and _real(path) == _real(corpus)):
        raise ClipError("refusing to write inside the clips corpus")
    if is_inside(path, REPO_ROOT) or _real(path) == _real(REPO_ROOT):
        probe = os.path.join(path, "probe.mp4.txt")
        r = subprocess.run(["git", "-C", REPO_ROOT, "check-ignore", "-q", probe], capture_output=True, **NO_WINDOW)
        if r.returncode != 0:
            raise ClipError("refusing: the output folder is inside the repository and not gitignored")


# ---------------------------------------------------------------- tools

def find_tool(name, explicit=None):
    """Explicit path, else PATH. Returns an absolute path or raises ClipError. Never downloads."""
    if explicit:
        if os.path.isfile(explicit):
            return os.path.abspath(explicit)
        raise ClipError(f"{name} not found at the given path")
    p = shutil.which(name)
    if not p:
        raise ClipError(f"{name} not found on PATH (pass --{name})")
    return p


def child_kwargs(creationflags=0):
    """subprocess kwargs: below-normal priority on Windows."""
    if os.name == "nt":
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS | creationflags}
    return {}


def lower_own_priority():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.SetPriorityClass(k.GetCurrentProcess(), subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        try:
            os.nice(10)
        except OSError:
            pass


def run_tool(argv, cwd=None, timeout=None):
    """Runs a child at below-normal priority; returns CompletedProcess (text, utf-8, errors replaced)."""
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, stdin=subprocess.DEVNULL, **child_kwargs(**NO_WINDOW))


def host_running(name="ujwalam-host.exe"):
    """True when a ujwalam-host process runs (a live stream or soak may own the GPU). Windows only."""
    if os.name != "nt":
        return False
    try:
        r = run_tool(["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH", "/FO", "CSV"], timeout=20)
    except (OSError, subprocess.SubprocessError):
        return True  # unknown: assume busy, stay on the CPU
    return name.lower() in r.stdout.lower()


def probe(ffprobe, path):
    """ffprobe JSON (format + streams). Raises ClipError on failure."""
    r = run_tool([ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], timeout=120)
    if r.returncode != 0:
        raise ClipError(f"ffprobe failed on {os.path.basename(path)}: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout)


def media_info(ffprobe, path):
    j = probe(ffprobe, path)
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    dur = float(j.get("format", {}).get("duration") or 0.0)
    fps = 0.0
    if v:
        num, _, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1").partition("/")
        try:
            fps = float(num) / float(den or 1) if float(den or 1) else 0.0
        except ValueError:
            fps = 0.0
    return {
        "duration": dur,
        "width": int(v["width"]) if v else 0,
        "height": int(v["height"]) if v else 0,
        "fps": fps,
        "vcodec": v.get("codec_name") if v else None,
        "pix_fmt": v.get("pix_fmt") if v else None,
        "acodec": a.get("codec_name") if a else None,
        "has_audio": a is not None,
        "audio_tracks": sum(1 for s in j.get("streams", []) if s.get("codec_type") == "audio"),
        "size": int(j.get("format", {}).get("size") or 0),
    }


def eprint(*a):
    print(*a, file=sys.stderr)
