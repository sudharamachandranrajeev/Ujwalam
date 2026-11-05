# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 post-stream detector pass: game-pack detectors over a full H recording -> detector hits jsonl.

The hits file is the seam clip_signals.read_hits() reads, so hits become ranked-candidate signals. The detector
logic is not duplicated: frames are sampled, OCR'd and parsed with g1_scan (decode_frames, scan_frame,
find_events, classify_frame) and the pack is loaded with game_pack. This module only turns per-frame detector
events into hit rows and applies the pack's signal rules.

Weights (AGENTS.md: event weights are proposed from labels and approved by the user, never invented): each hit
carries the pack weight (`weight`, null for every CODM detector and positive medal until G3; 0 for reference
medals). The ranker counts a detector hit only when data/clip/ranking.json `detectorWeightsStatus` is "approved"
(clip_rank.detector_events). Until then every hit has weight 0: it is recorded here, listed in candidates.json and
attached as a reason to candidates opened by other signals, and it never opens or ranks a candidate.

Hit row (one per detector instance; consecutive frames of the same detector and label within mergeGapSec merge):
  {t, tEnd, frames, detector, label, role, signal, why[], clipReason, weight, detectorStatus, mode, ocrScore}
  label is a catalogue text, pattern text or a canonical form (e.g. "3X MULTI-KILL", "+254"); never raw OCR
  text, so no player name or IGN is ever written. `signal` true = the pack's rules for a positive clip reason hold
  (name where required, inside a pack ROI, not suppressed, not a reference medal); `why` lists the rules that
  failed otherwise.

Settings (sample rate, diff gate, name threshold, merge gap) come from data/clip/detector-pass.json per game
(status proposed). Resource limits (user, 2026-10-27): OCR on 4 onnxruntime threads (inter-op 1), ffmpeg decode
on 2 threads, process and children at below-normal priority, and one heavy clip job at a time (a lock file in the
temp folder). Needs the OCR venv (numpy, opencv-python-headless, rapidocr, onnxruntime). CPU only.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time

import g1_scan
import g1_text as gt
import game_pack
from clip_common import CLIP_DATA, ClipError, REPO_ROOT, load_json

TOOL_VERSION = 1
HITS = "detector-hits.jsonl"
SUMMARY = "detector-pass.json"
LOCK_NAME = "ujwalam-clip-heavy.lock"

_MULTI = re.compile(r"(\d+)\s*(X|\+)?\s*MU[LI]TI-?\s*KI[LI]{2}")
_STREAK = re.compile(r"ON\s*A\s*(\d+)\s*KI[LI]{2}\s*STREAK")


# ---------------------------------------------------------------- config

def load_settings(game=None, path=None):
    """(game id, settings dict, config doc) from data/clip/detector-pass.json."""
    doc = load_json(path or os.path.join(CLIP_DATA, "detector-pass.json"))
    gid = game or doc.get("defaultGame")
    games = doc.get("games") or {}
    if gid not in games:
        raise ClipError(f"detector-pass.json has no settings for game {gid!r}")
    s = dict(games[gid])
    for k in ("fps", "diffGate", "nameMin", "mergeGapSec", "roiSlack"):
        if not isinstance(s.get(k), (int, float)) or isinstance(s.get(k), bool) or s[k] < 0:
            raise ClipError(f"detector-pass.json games.{gid}.{k} must be a number >= 0")
    if s["fps"] <= 0 or s["fps"] > 10:
        raise ClipError("detector-pass.json fps must be in (0, 10]")
    return gid, s, doc


def pack_path(settings):
    p = settings.get("pack")
    if not p:
        raise ClipError("detector-pass.json: no pack folder for the game")
    return p if os.path.isabs(p) else os.path.join(REPO_ROOT, p)


def load_names(profile_path, key):
    """Profile names (games.<key>.ign + variants) from the gitignored profile. Missing profile -> no names, so
    name-required detectors never signal. Names stay in memory and are never written."""
    if not profile_path or not os.path.isfile(profile_path):
        return [], False
    try:
        names, _clan = g1_scan.load_names(profile_path, key)
    except (KeyError, TypeError, ValueError):
        return [], False
    return [n for n in names if isinstance(n, str) and n and not n.startswith("<")], True


# ---------------------------------------------------------------- per-frame rules

def _in_any_roi(g, det, slack, mode=None):
    rois = [r for r in det.get("rois", []) if not r.get("mode") or mode is None or r.get("mode") == mode]
    return any(g1_scan._in_roi(g, r, slack=slack) for r in rois)


def _label(e, det):
    d = e["det"]
    raw = gt.normalise(e["box"]["text"])
    if d == "M3":
        return e["medal"]["medal"]
    if d == "M4":
        return f"+{e['points']}"
    if d == "X1":
        up = e["box"]["text"].upper()  # raw upper case: normalise() drops the "+" of "5+ MULTI-KILL"
        m = _MULTI.search(up)
        if m:
            return f"{m.group(1)}{'+' if m.group(2) == '+' else 'X'} MULTI-KILL"
        m = _STREAK.search(up)
        if m:
            return f"On a {m.group(1)} killstreak"
        return "MULTI-KILL"
    pats = det.get("patterns") or []
    if pats:
        best = max(pats, key=lambda p: gt.partial_ratio(gt.normalise(p), raw))
        return best
    return det.get("name", d)


def frame_hits(boxes, pack, names, settings, mode=None):
    """Hit rows (single frame, no t) from one frame's OCR boxes (g1_scan scan format: text, score, g)."""
    det = {d["id"]: d for d in pack["detectors"]}
    name_min = float(settings["nameMin"])
    slack = float(settings["roiSlack"])
    evs = g1_scan.find_events([dict(b) for b in boxes], pack, names, name_min)
    name_boxes = [e["box"] for e in evs if e["det"] == "NAME"]
    on_frame = {e["det"] for e in evs}
    suppressed = set()
    for rule in pack.get("suppressionRules", []):
        if rule.get("while") in on_frame:
            suppressed.update(rule.get("suppress", []))
    has_medal = any(e["det"] == "M3" and e.get("medalClass") is not None for e in evs)
    out = []
    for e in evs:
        d = e["det"]
        if d == "NAME" or d not in det:
            continue
        dd = det[d]
        why = []
        role = dd.get("role", "positive")
        weight = dd.get("weight")
        clip_reason = True
        if role != "positive":
            why.append("negative_role")
        if not _in_any_roi(e["box"]["g"], dd, slack if d not in ("M5", "B1") else g1_scan.KILLFEED_SLACK, mode):
            why.append("outside_roi")
        if d in suppressed:
            why.append("suppressed_by_" + next(r["while"] for r in pack["suppressionRules"] if d in r["suppress"]))
        if d == "M3":
            medal = next((m for m in dd.get("medals", []) if m["text"] == e["medal"]["medal"]), {})
            weight = medal.get("weight")
            clip_reason = bool(medal.get("clipReason", e.get("medalClass") == "positive"))
            if e.get("medalClass") != "positive" or not clip_reason:
                why.append("reference_medal")
        elif d == "M4" and not has_medal:
            why.append("no_medal_in_stack")  # G1: +N counts only with a medal or kill text in the same stack
        elif d == "K1":
            if not e.get("signal"):
                why.append("no_name_as_killer")
        elif d in ("M5", "B1"):
            if e.get("side") != "killer":
                why.append("not_own_kill")
        elif dd.get("nameRequired"):
            # the name must sit on the detector's own card/banner ROI (X1 in BR: the squad list always shows it)
            if not any(_in_any_roi(nb["g"], dd, slack, mode) for nb in name_boxes):
                why.append("no_name_in_roi")
        out.append({"detector": d, "label": _label(e, dd), "role": role, "signal": not why, "why": why,
                    "clipReason": clip_reason and role == "positive", "weight": weight,
                    "detectorStatus": dd.get("status", "unverified"), "mode": mode,
                    "ocrScore": round(float(e["box"].get("score", 0.0)), 4)})
    return out


def merge_hits(rows, gap):
    """rows: [{t, detector, label, ...}] sorted by t. Consecutive frames of one (detector, label) no more than gap
    seconds apart become one instance (t = first frame, tEnd = last). signal = any frame signalled."""
    open_, out = {}, []
    for r in sorted(rows, key=lambda r: r["t"]):
        k = (r["detector"], r["label"])
        cur = open_.get(k)
        if cur and r["t"] - cur["tEnd"] <= gap + 1e-6:
            cur["tEnd"] = r["t"]
            cur["frames"] += 1
            cur["ocrScore"] = max(cur["ocrScore"], r["ocrScore"])
            if r["signal"] and not cur["signal"]:
                cur["signal"], cur["why"] = True, []
            elif not cur["signal"]:
                cur["why"] = sorted(set(cur["why"]) & set(r["why"])) or cur["why"]
            continue
        cur = dict(r, tEnd=r["t"], frames=1)
        open_[k] = cur
        out.append(cur)
    for r in out:
        r["t"], r["tEnd"] = round(r["t"], 3), round(r["tEnd"], 3)
    return sorted(out, key=lambda r: (r["t"], r["detector"]))


# ---------------------------------------------------------------- one heavy job

def _pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


class HeavyJobLock:
    """One heavy clip job at a time across processes (user limit 2026-10-27). A stale lock (dead pid) is taken."""

    def __init__(self, folder=None):
        self.path = os.path.join(folder or tempfile.gettempdir(), LOCK_NAME)
        self.held = False

    def __enter__(self):
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    with open(self.path, encoding="utf-8") as f:
                        pid = json.load(f).get("pid")
                except (OSError, ValueError, AttributeError):
                    pid = None
                if _pid_alive(pid):
                    raise ClipError(f"another heavy clip job is running (pid {pid}); one at a time") from None
                try:
                    os.remove(self.path)
                except OSError:
                    pass
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"pid": os.getpid(), "job": "detector-pass", "at": time.time()}, f)
            self.held = True
            return self
        raise ClipError("could not take the heavy-job lock")

    def __exit__(self, *exc):
        if self.held:
            try:
                os.remove(self.path)
            except OSError:
                pass
            self.held = False
        return False


# ---------------------------------------------------------------- pass

def layout_for(recording, layout_path=None):
    """g1_scan layout: an explicit file (game area inside the H canvas) or the full frame (default; UNVERIFIED for
    the H canvas until the user's scene layout is checked)."""
    if layout_path:
        lay = g1_scan.load_layout(layout_path)
        return (lay["layout"] if "layout" in lay else lay), "file"
    w, h = g1_scan.probe_size(recording)
    return g1_scan.full_screen_layout(w, h, [0, 0, w, h]), "full-frame"


def run_pass(recording, out_dir, settings, pack, names, layout, threads=g1_scan.DEFAULT_THREADS, duration=None,
             progress=print):
    """Samples the recording at settings.fps, OCRs changed frames, writes out_dir/detector-hits.jsonl.
    Returns the summary dict (counts only; no text)."""
    g1_scan.set_ocr_params(g1_scan.thread_params(threads))
    v = g1_scan.visible_box(layout)
    origin = (v[0], v[1])
    rows, last, mode, prev = [], None, None, []
    n_ocr = n_skip = n_frames = 0
    t0 = time.monotonic()
    for t, img in g1_scan.decode_frames(recording, float(settings["fps"]), crop=v):
        n_frames += 1
        rec, last = g1_scan.scan_frame({"src": "recording"}, t, img, origin, layout, last, float(settings["diffGate"]))
        if "skipped" in rec:
            n_skip += 1
            # unchanged frame: whatever was on screen at the last OCR'd frame still is, so its hits continue
            rows.extend(dict(h, t=t) for h in prev)
            continue
        n_ocr += 1
        mode = g1_scan.classify_frame(rec["boxes"]) or mode  # keep the last known mode through cue-less frames
        prev = frame_hits(rec["boxes"], pack, names, settings, mode)
        rows.extend(dict(h, t=t) for h in prev)
        if progress and n_frames % 300 == 0:
            progress(f"detect: {t:.0f} s, ocr {n_ocr}, skipped {n_skip}, {time.monotonic() - t0:.0f} s elapsed")
    hits = merge_hits(rows, float(settings["mergeGapSec"]))
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, HITS + f".{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        for h in hits:
            f.write(json.dumps(h, ensure_ascii=False) + "\n")
    os.replace(tmp, os.path.join(out_dir, HITS))
    per = {}
    for h in hits:
        p = per.setdefault(h["detector"], {"hits": 0, "signal": 0})
        p["hits"] += 1
        p["signal"] += 1 if h["signal"] else 0
    return {"frames": n_frames, "ocrFrames": n_ocr, "diffGateSkips": n_skip, "hits": len(hits),
            "signalHits": sum(1 for h in hits if h["signal"]), "perDetector": per,
            "seconds": round(time.monotonic() - t0, 2)}
