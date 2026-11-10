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
  plus, on W1 rows when the pack has a W1 `banner` config, `banner` ("round" / "match" / null, from the word's
  vertical position on screen) and `subtitle` (the pack subtitle text read under the word, or null). Round and match banners
  never merge with each other.
  label is a catalogue text, pattern text or a canonical form (e.g. "3X MULTI-KILL", "+254"); never raw OCR
  text, so no player name or IGN is ever written. `signal` true = the pack's rules for a positive clip reason hold
  (name where required, inside a pack ROI, not suppressed, not a reference medal); `why` lists the rules that
  failed otherwise.

Settings (sample rate, diff gate, name threshold, merge gap, OCR regions) come from data/clip/detector-pass.json per
game (status proposed). ocrRegions "full" OCRs the whole frame; "rois" OCRs only bands built from the pack ROIs
(FrameScanner; docs/evidence/2026-11-07-roi-ocr-speed.md). FrameScanner.scan is also the per-frame call of the live
loop. Resource limits (user, 2026-10-27): OCR on 4 onnxruntime threads (inter-op 1), ffmpeg decode
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
import match_gate
from clip_common import CLIP_DATA, ClipError, REPO_ROOT, load_json, write_json_atomic

TOOL_VERSION = 1
HITS = "detector-hits.jsonl"
SUMMARY = "detector-pass.json"
LOCK_NAME = "ujwalam-clip-heavy.lock"

OCR_REGION_MODES = ("full", "rois")
# RapidOCR text-detector input rule for band crops: "max" with a side limit above any 1080p band never rescales a band
# (the default "min"/736 rule upscales a thin band; CROP_PROFILE's 960 would halve a full-width band); any downscale
# is explicit (roiDetScale). The angle classifier is off (HUD text is never rotated).
BAND_PROFILE = {"Det.limit_type": "max", "Det.limit_side_len": 4096, "Global.use_cls": False}

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
    sb = s.setdefault("splitBySignal", [])
    if not isinstance(sb, list) or not all(isinstance(x, str) and 0 < len(x) <= 32 for x in sb):
        raise ClipError(f"detector-pass.json games.{gid}.splitBySignal must be a list of detector ids")
    s.setdefault("ocrRegions", "full")
    if s["ocrRegions"] not in OCR_REGION_MODES:
        raise ClipError(f"detector-pass.json games.{gid}.ocrRegions must be one of {', '.join(OCR_REGION_MODES)}")
    if s["ocrRegions"] == "rois":
        pad = s.get("roiPad")
        if (not isinstance(pad, list) or len(pad) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 0.5 for v in pad)):
            raise ClipError(f"detector-pass.json games.{gid}.roiPad must be [x, y] game fractions in [0, 0.5]")
        ma = s.get("roiMergeArea")
        if not isinstance(ma, (int, float)) or isinstance(ma, bool) or not 0 <= ma <= 1:
            raise ClipError(f"detector-pass.json games.{gid}.roiMergeArea must be a number in [0, 1]")
        every = s.setdefault("roiEvery", {})
        if not isinstance(every, dict) or not all(
                isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 10
                for k, v in every.items()):
            raise ClipError(f"detector-pass.json games.{gid}.roiEvery must map detector ids to whole frames 1-10")
        ds = s.setdefault("roiDetScale", 1.0)
        if not isinstance(ds, (int, float)) or isinstance(ds, bool) or not 0.25 <= ds <= 1:
            raise ClipError(f"detector-pass.json games.{gid}.roiDetScale must be a number in [0.25, 1]")
        if not isinstance(s.setdefault("roiTextFilter", False), bool):
            raise ClipError(f"detector-pass.json games.{gid}.roiTextFilter must be true or false")
        probe = s.setdefault("modeProbeEvery", 0)
        if not isinstance(probe, int) or isinstance(probe, bool) or not 0 <= probe <= 60:
            raise ClipError(f"detector-pass.json games.{gid}.modeProbeEvery must be a whole number of frames 0-60")
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
    if d == "W1":
        return e["result"]
    if d == "C1":
        return e["cue"]
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


def frame_hits(boxes, pack, names, settings, mode=None, kill_keys=None):
    """Hit rows (single frame, no t) from one frame's OCR boxes (g1_scan scan format: text, score, g).
    kill_keys: optional list; one in-memory victim key (match_gate.victim_key) is appended per own kill-feed line
    that signals (M5 unless the mode is br, B1 unless it is mp), for the match gate's kill count. Keys are never
    part of a row."""
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
        if role == "negative":
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
        if (kill_keys is not None and not why and d in ("M5", "B1")
                and mode != ("br" if d == "M5" else "mp")):
            kill_keys.append(match_gate.victim_key(e["box"]["text"]))
        row = {"detector": d, "label": _label(e, dd), "role": role, "signal": not why, "why": why,
               "clipReason": clip_reason and role == "positive", "weight": weight,
               "detectorStatus": dd.get("status", "unverified"), "mode": mode,
               "ocrScore": round(float(e["box"].get("score", 0.0)), 4)}
        if d == "W1" and dd.get("banner"):
            # round-end vs match-end banner (match_gate.banner_kind) and its subtitle; pack texts only
            row["banner"] = match_gate.banner_kind(e["box"].get("g"), dd["banner"]) if not why else None
            row["subtitle"] = match_gate.banner_subtitle(boxes, dd["banner"]) if not why else None
        out.append(row)
    return out


def merge_hits(rows, gap, split_by_signal=()):
    """rows: [{t, detector, label, ...}] sorted by t. Consecutive frames of one (detector, label) no more than gap
    seconds apart become one instance (t = first frame, tEnd = last). signal = any frame signalled.
    split_by_signal: detectors that stay on screen most of a match (kill feeds, settings.splitBySignal). Their
    signalled and unsignalled frames merge separately, so an own-kill line is its own short instance; merging them
    together made one MP kill-feed instance of the whole recording (2026-11-07)."""
    open_, out = {}, []
    split = set(split_by_signal)
    for r in sorted(rows, key=lambda r: r["t"]):
        k = (r["detector"], r["label"], bool(r["signal"]) if r["detector"] in split else None, r.get("banner"))
        cur = open_.get(k)
        if cur and r["t"] - cur["tEnd"] <= gap + 1e-6:
            cur["tEnd"] = r["t"]
            cur["frames"] += 1
            cur["ocrScore"] = max(cur["ocrScore"], r["ocrScore"])
            if r.get("subtitle") and not cur.get("subtitle"):
                cur["subtitle"] = r["subtitle"]
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


# ---------------------------------------------------------------- OCR regions (bands)

def _area(r):
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def _overlap(a, b):
    return _area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def pack_modes(pack):
    """Game modes the pack's detectors declare (detector `modes`, ROI `mode`), sorted."""
    out = set()
    for d in pack["detectors"]:
        out.update(d.get("modes") or [])
        out.update(r["mode"] for r in d.get("rois", []) if r.get("mode"))
    return sorted(out)


def roi_rects(pack, settings, mode=None):
    """[(x0, y0, x1, y1, every, {detector ids})] in game-area fractions: every pack ROI widened by the slack the
    per-frame rules allow (killfeed slack for M5/B1, roiSlack otherwise; never less than the 0.02 the K1 name check
    uses) plus roiPad, so a text box whose centre is inside the ROI also lies inside the crop. `every` = OCR the rect
    on every Nth sampled frame (settings.roiEvery, default 1). mode (e.g. "mp") keeps only the ROIs of detectors
    that declare that mode (detector `modes`; ROI `mode`); None keeps all."""
    px, py = (float(v) for v in settings["roiPad"])
    slack = max(float(settings["roiSlack"]), 0.02)
    every = settings.get("roiEvery") or {}
    out = []
    for d in pack["detectors"]:
        if mode is not None and d.get("modes") and mode not in d["modes"]:
            continue
        s = g1_scan.KILLFEED_SLACK if d["id"] in ("M5", "B1") else slack
        for r in d.get("rois", []):
            if mode is not None and r.get("mode") and r["mode"] != mode:
                continue
            out.append((max(0.0, r["x0"] - s - px), max(0.0, r["y0"] - s - py),
                        min(1.0, r["x1"] + s + px), min(1.0, r["y1"] + s + py), int(every.get(d["id"], 1)), {d["id"]}))
    return out


def merge_bands(rects, merge_area):
    """Greedy merge of rects with the same cadence: two rects become their bounding box when that box is no more
    than merge_area (game-area fraction) larger than the area they cover together, or when one contains the other.
    Detector cost grows with crop area and every OCR call has a fixed cost, so merge_area trades the two. Overlap
    left between bands is resolved per box (band_boxes)."""
    bands = [(r[0], r[1], r[2], r[3], r[4], set(r[5])) for r in rects]
    while True:
        best = None
        for i in range(len(bands)):
            for j in range(i + 1, len(bands)):
                a, b = bands[i], bands[j]
                if a[4] != b[4]:
                    continue
                u = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                cost = _area(u) - (_area(a) + _area(b) - _overlap(a, b))
                if cost <= merge_area + 1e-9 and (best is None or cost < best[0]):
                    best = (cost, i, j, u)
        if best is None:
            break
        _, i, j, u = best
        a, b = bands[i], bands[j]
        bands[i] = (*u, a[4], a[5] | b[5])
        del bands[j]
    return sorted(bands, key=lambda b: (b[1], b[0]))


def band_pixels(bands, layout, origin, size):
    """Bands in game fractions -> pixel crops (x0, y0, x1, y1) of the sampled image (the layout's visible area,
    whose top-left is `origin` in frame px). Clipped to the image; empty bands dropped."""
    gx, gy, gw, gh = layout["game"]
    ox, oy = origin
    w, h = size
    out = []
    for b in bands:
        x0 = max(0, int(gx + b[0] * gw - ox))
        y0 = max(0, int(gy + b[1] * gh - oy))
        x1 = min(w, int(round(gx + b[2] * gw - ox + 0.4999)))
        y1 = min(h, int(round(gy + b[3] * gh - oy + 0.4999)))
        if x1 - x0 >= 8 and y1 - y0 >= 8:
            out.append({"px": (x0, y0, x1, y1), "every": b[4], "detectors": sorted(b[5])})
    return out


def no_power_throttling():
    """Opt this process out of Windows execution-speed power throttling (EcoQoS). Measured 2026-11-07: with the
    terminal in the background Windows throttled the OCR process and one full-frame OCR took 7.1-8.2 s instead of
    1.4 s (docs/evidence/2026-11-07-roi-ocr-speed.md). Priority stays below normal and the thread caps stay; this
    only stops the efficiency-mode clock/core downgrade. Returns True when applied (False elsewhere)."""
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes

    class _State(ctypes.Structure):
        _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]
    k = ctypes.windll.kernel32
    k.GetCurrentProcess.restype = wintypes.HANDLE
    k.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    st = _State(1, 1, 0)  # PROCESS_POWER_THROTTLING_CURRENT_VERSION, EXECUTION_SPEED controlled, state off
    process_power_throttling = 4  # PROCESS_INFORMATION_CLASS
    return bool(k.SetProcessInformation(k.GetCurrentProcess(), process_power_throttling, ctypes.byref(st),
                                        ctypes.sizeof(st)))


def ocr_crops(crops, det_scale=1.0, keep=None):
    """Two-stage RapidOCR over band crops -> per-crop box lists (g1_scan.ocr format, crop px).

    Text detection runs per crop, on a copy scaled by det_scale when below 1 (detector cost grows with pixel count);
    recognition then runs once, batched over the text lines of all crops, each line cut from the full-resolution
    crop (as RapidOCR cuts them). keep: optional per-crop callable (centre x, y in crop px) -> bool; a text line
    whose centre fails it is not recognised. Recognition score filter as RapidOCR (Global.text_score). Uses the pinned
    rapidocr 3.10 detector/recogniser objects of g1_scan.engine()."""
    import cv2
    import numpy as np
    from rapidocr.ch_ppocr_rec import TextRecInput
    from rapidocr.utils.process_img import get_rotate_crop_image
    eng = g1_scan.engine()
    det, rec = eng._load_det_model(), eng._load_rec_model()
    lines, owner, quads = [], [], []
    for k, c in enumerate(crops):
        c = np.ascontiguousarray(c)
        src = c if det_scale >= 1 else cv2.resize(c, None, fx=det_scale, fy=det_scale, interpolation=cv2.INTER_AREA)
        r = det(src)
        if r.boxes is None or not len(r.boxes):
            continue
        h, w = c.shape[:2]
        for q in r.boxes:
            q = np.asarray(q, np.float32) / min(det_scale, 1.0)
            q[:, 0] = np.clip(q[:, 0], 0, w - 1)
            q[:, 1] = np.clip(q[:, 1], 0, h - 1)
            if keep is not None and not keep[k]((float(q[:, 0].min() + q[:, 0].max()) / 2,
                                                 float(q[:, 1].min() + q[:, 1].max()) / 2)):
                continue  # no rule reads a box centred here: not recognised
            lines.append(get_rotate_crop_image(c, q.copy()))
            owner.append(k)
            quads.append(q)
    out = [[] for _ in crops]
    if not lines:
        return out
    rr = rec(TextRecInput(img=lines))
    min_score = float(eng.text_score)
    for k, q, txt, sc in zip(owner, quads, rr.txts or (), rr.scores or ()):
        if not txt.strip() or sc < min_score:
            continue
        out[k].append({"text": txt, "score": round(float(sc), 4), "x0": float(q[:, 0].min()),
                       "y0": float(q[:, 1].min()), "x1": float(q[:, 0].max()), "y1": float(q[:, 1].max())})
    return out


def _iou(a, b):
    ra, rb = (a["x0"], a["y0"], a["x1"], a["y1"]), (b["x0"], b["y0"], b["x1"], b["y1"])
    ov = _overlap(ra, rb)
    u = _area(ra) + _area(rb) - ov
    return ov / u if u > 0 else 0.0


def band_boxes(per_band, bands, size, edge=2):
    """OCR boxes per band (band px) -> one list in image px, the coordinate space of a full-frame OCR.
    Overlapping bands can read one text twice: a box cut by an inner band edge is dropped when another band holds
    it whole, and of two boxes with IoU >= 0.5 the higher score is kept."""
    w, h = size
    cand = []
    for boxes, band in zip(per_band, bands):
        bx0, by0, bx1, by1 = band["px"]
        for b in boxes:
            g = dict(b, x0=b["x0"] + bx0, y0=b["y0"] + by0, x1=b["x1"] + bx0, y1=b["y1"] + by0)
            cut = ((g["x0"] <= bx0 + edge and bx0 > 0) or (g["y0"] <= by0 + edge and by0 > 0)
                   or (g["x1"] >= bx1 - edge and bx1 < w) or (g["y1"] >= by1 - edge and by1 < h))
            if cut and any(o is not band and o["px"][0] <= g["x0"] - edge and o["px"][1] <= g["y0"] - edge
                           and o["px"][2] >= g["x1"] + edge and o["px"][3] >= g["y1"] + edge for o in bands):
                continue
            cand.append(g)
    kept = []
    for g in sorted(cand, key=lambda b: -b["score"]):
        if all(_iou(g, k) < 0.5 for k in kept):
            kept.append(g)
    return sorted(kept, key=lambda b: (b["y0"], b["x0"]))


class FrameScanner:
    """Per-frame detector scan, shared by the post-stream pass (run_pass) and the live loop.

    scan(t, img) takes one sampled BGR frame of the layout's visible area (g1_scan.visible_box) and returns the
    single-frame hit rows (frame_hits format plus t). State kept between calls: the last known mode, the last
    OCR'd frame (whole-frame diff gate, settings.ocrRegions "full") or per band (band diff gate and cadence,
    "rois"). The constructor configures the shared OCR engine (thread caps; band profile in "rois" mode), so one
    process runs one scanner at a time."""

    def __init__(self, pack, names, settings, layout, threads=g1_scan.DEFAULT_THREADS):
        self.pack, self.names, self.settings, self.layout = pack, names, settings, layout
        self.regions = settings.get("ocrRegions", "full")
        self.gate = float(settings["diffGate"])
        v = g1_scan.visible_box(layout)
        self.origin = (v[0], v[1])
        self.size = (v[2] - v[0], v[3] - v[1])
        params = g1_scan.thread_params(threads)
        self.band_sets, self.band_state = {}, {}
        self.probe = int(settings.get("modeProbeEvery") or 0)
        self.det_scale = float(settings.get("roiDetScale", 1.0))
        self.text_filter = bool(settings.get("roiTextFilter"))
        if self.regions == "rois":
            params.update(BAND_PROFILE)
            ma = float(settings["roiMergeArea"])
            modes = [None] + (pack_modes(pack) if self.probe else [])
            for m in modes:
                self.band_sets[m] = band_pixels(merge_bands(roi_rects(pack, settings, m), ma), layout, self.origin,
                                                self.size)
                # the ROIs (with rule slack, without pad) a text centre must fall in to be read at all
                rules = roi_rects(pack, dict(settings, roiPad=[0, 0]), m)
                for b in self.band_sets[m]:
                    b["rules"] = [r[:4] for r in rules if r[5] & set(b["detectors"])]
            self.bands = self.band_sets[None]
        else:
            self.bands = []
            for k in BAND_PROFILE:  # full frame keeps RapidOCR's own detector rule and angle classifier
                g1_scan.OCR_PARAMS.pop(k, None)
        g1_scan.set_ocr_params(params)
        self.unthrottled = no_power_throttling()
        self.mode, self.last, self.prev, self.n = None, None, [], 0
        # match gate (match_gate.py): S1 readings with t, own kill-feed lines deduplicated into kills
        mcfg = match_gate.stats_config(pack)
        self.kills = match_gate.KillCounter(mcfg["killLineHoldSec"], mcfg["victimMatchMin"])
        self.readings, self.prev_keys = [], []
        self.stats = {"frames": 0, "ocrFrames": 0, "diffGateSkips": 0, "ocrCalls": 0, "bandOcr": 0, "bandSkips": 0,
                      "bandHeld": 0, "ocrSeconds": 0.0}

    def active_bands(self):
        """Bands for this frame: all pack ROIs while the mode is unknown, on every modeProbeEvery-th frame (so a mode
        change is seen) and when mode gating is off (modeProbeEvery 0); otherwise only the current mode's ROIs."""
        if not self.probe or self.mode not in self.band_sets or self.n % self.probe == 0:
            return self.band_sets[None]
        return self.band_sets[self.mode]

    def _keeper(self, band):
        """Text filter of one band (roiTextFilter): True when a centre (band px) lies in one of the band's rule ROIs."""
        gx, gy, gw, gh = self.layout["game"]
        ox = band["px"][0] + self.origin[0] - gx
        oy = band["px"][1] + self.origin[1] - gy
        rules = band["rules"]

        def keep(c):
            fx, fy = (c[0] + ox) / gw, (c[1] + oy) / gh
            return any(r[0] <= fx <= r[2] and r[1] <= fy <= r[3] for r in rules)
        return keep

    def _scan_rois(self, img):
        import cv2
        import numpy as np
        bands = self.active_bands()
        per_band = [None] * len(bands)
        todo = []  # (index, key, small) of bands OCR'd this frame
        for i, band in enumerate(bands):
            x0, y0, x1, y1 = band["px"]
            key = (band["px"], band["every"])
            last, held, seen = self.band_state.get(key, (None, [], None))
            if self.n % band["every"] and seen is not None and self.n - seen < band["every"]:
                self.stats["bandHeld"] += 1  # not this frame's turn: its last boxes still hold
                per_band[i] = held
                continue
            small = cv2.resize(cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY), None, fx=0.25, fy=0.25,
                               interpolation=cv2.INTER_AREA).astype(np.int16)
            if last is not None and last.shape == small.shape and float(np.abs(small - last).mean()) < self.gate:
                self.stats["bandSkips"] += 1  # unchanged band: its last boxes still hold
                per_band[i] = held
                continue
            todo.append((i, key, small))
        if todo:
            crops = [img[bands[i]["px"][1]:bands[i]["px"][3], bands[i]["px"][0]:bands[i]["px"][2]] for i, _, _ in todo]
            t0 = time.perf_counter()
            keep = [self._keeper(bands[i]) for i, _, _ in todo] if self.text_filter else None
            got_all = ocr_crops(crops, self.det_scale, keep)
            self.stats["ocrSeconds"] += time.perf_counter() - t0
            self.stats["ocrCalls"] += 1
            for (i, key, small), got in zip(todo, got_all):
                self.stats["bandOcr"] += 1
                self.band_state[key] = (small, got, self.n)
                per_band[i] = got
        return band_boxes(per_band, bands, self.size), len(todo)

    def scan(self, t, img):
        self.stats["frames"] += 1
        if self.regions == "rois":
            boxes, ran = self._scan_rois(img)
            self.n += 1
            if not ran:
                return self._unchanged(t)
            recboxes = g1_scan._frame_record(boxes, self.layout, self.origin)
        else:
            t0 = time.perf_counter()
            rec, self.last = g1_scan.scan_frame({"src": "recording"}, t, img, self.origin, self.layout, self.last,
                                                self.gate)
            if "skipped" in rec:
                return self._unchanged(t)
            self.stats["ocrSeconds"] += time.perf_counter() - t0
            recboxes = rec["boxes"]
        self.stats["ocrFrames"] += 1
        self.mode = g1_scan.classify_frame(recboxes) or self.mode  # keep the last known mode through cue-less frames
        keys = []
        self.prev = frame_hits(recboxes, self.pack, self.names, self.settings, self.mode, kill_keys=keys)
        srows, readings = match_gate.frame_stats(recboxes, self.pack, self.names, float(self.settings["nameMin"]),
                                                 self.mode)
        self.prev += srows
        self.readings += [{"t": round(float(t), 3), **r} for r in readings]
        self.prev_keys = keys
        self.kills.feed(t, keys)
        return [dict(h, t=t) for h in self.prev]

    def _unchanged(self, t):
        # unchanged frame: whatever was on screen at the last OCR'd frame still is, so its hits continue (and its
        # own kill-feed lines stay the same kills)
        self.stats["diffGateSkips"] += 1
        self.kills.feed(t, self.prev_keys)
        return [dict(h, t=t) for h in self.prev]

    def match_stats(self):
        """match-stats.json content: S1 readings and own-kill times (no names, no OCR text)."""
        return {"readings": self.readings,
                "ownKills": {"times": list(self.kills.times), "framesWithOwnLines": self.kills.frames,
                             "holdSec": self.kills.hold}}


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

GAME_LAYER_ORIGIN = "scene-default-h/game"  # same lookup as services/studio-ui/launch.mjs liveClipsSpec


def project_layout(project, rec_w, rec_h, canvas="h"):
    """g1_scan layout of the game inside a Ujwalam canvas recording (D235): the game capture layer's placement on
    that canvas (x, y, width, height in canvas px; crop in source px; source size from its device's format),
    scaled to the recording size. Only the visible game area is scanned, so overlays around it (tickers, chat,
    banners that may show the streamer's name) never reach a detector ROI. Raises ValueError when the layer, its
    placement or the source size is missing, or the layer is rotated."""
    cv = next((c for c in project.get("canvases") or [] if c.get("id") == canvas), None)
    if not cv:
        raise ValueError(f"project has no canvas {canvas}")
    layer = next((l for s in project.get("scenes") or [] for l in s.get("layers") or []
                  if l.get("type") == "capture" and (l.get("origin") or {}).get("id") == GAME_LAYER_ORIGIN), None)
    if not layer:
        raise ValueError(f"project has no game capture layer ({GAME_LAYER_ORIGIN})")
    p = (layer.get("placements") or {}).get(canvas)
    if not p or not p.get("width") or not p.get("height"):
        raise ValueError(f"the game layer has no {canvas} placement")
    if float(p.get("rotation") or 0) % 360:
        raise ValueError("the game layer is rotated; give --layout")
    dev = next((d for d in project.get("devices") or [] if d.get("id") == (layer.get("source") or {}).get("device")), None)
    fmt = (dev or {}).get("format") or {}
    sw, sh = float(fmt.get("width") or 0), float(fmt.get("height") or 0)
    if sw <= 0 or sh <= 0:
        raise ValueError("the game device has no format size; give --layout")
    cr = p.get("crop") or {}
    cl, ct, crr, cb = (float(cr.get(k) or 0) for k in ("left", "top", "right", "bottom"))
    sx, sy = float(p["width"]) / (sw - cl - crr), float(p["height"]) / (sh - ct - cb)
    kx, ky = rec_w / float(cv["width"]), rec_h / float(cv["height"])
    x, y, w, h = float(p["x"]), float(p["y"]), float(p["width"]), float(p["height"])
    game = [(x - cl * sx) * kx, (y - ct * sy) * ky, sw * sx * kx, sh * sy * ky]
    vis = [max(0.0, x * kx), max(0.0, y * ky), min(rec_w, (x + w) * kx), min(rec_h, (y + h) * ky)]
    return {"frame": [rec_w, rec_h], "game": [round(v, 2) for v in game], "visible": [round(v, 2) for v in vis]}


def layout_for(recording, layout_path=None, project_path=None):
    """g1_scan layout: an explicit file (game area inside the H canvas), the game layer of a Ujwalam project
    (canvas recordings, D235), or the full frame (default; for clean game footage only)."""
    if layout_path:
        lay = g1_scan.load_layout(layout_path)
        return (lay["layout"] if "layout" in lay else lay), "file"
    w, h = g1_scan.probe_size(recording)
    if project_path:
        with open(project_path, encoding="utf-8") as f:
            return project_layout(json.load(f), w, h), "project"
    return g1_scan.full_screen_layout(w, h, [0, 0, w, h]), "full-frame"


PROGRESS_EVERY_SEC = 2.0


def run_pass(recording, out_dir, settings, pack, names, layout, threads=g1_scan.DEFAULT_THREADS, duration=None,
             progress=print, start=None, progress_line=None, total_frames=None):
    """Samples the recording at settings.fps, OCRs changed frames, writes out_dir/detector-hits.jsonl and
    out_dir/match-stats.json (match gate readings and own-kill times). Returns the summary dict (counts only; no
    text). start/duration (seconds) limit the pass to a segment; hit times stay recording times.
    progress_line(done, total): called at most every PROGRESS_EVERY_SEC with frames done of total_frames, and once
    at the end."""
    scanner = FrameScanner(pack, names, settings, layout, threads)
    v = g1_scan.visible_box(layout)
    rows = []
    t0 = time.monotonic()
    last_line = t0
    for t, img in g1_scan.decode_frames(recording, float(settings["fps"]), crop=v, start=start, dur=duration):
        rows.extend(scanner.scan(t, img))
        st = scanner.stats
        if progress and st["frames"] % 300 == 0:
            progress(f"detect: {t:.0f} s, ocr {st['ocrFrames']}, skipped {st['diffGateSkips']}, "
                     f"{time.monotonic() - t0:.0f} s elapsed")
        if progress_line and time.monotonic() - last_line >= PROGRESS_EVERY_SEC:
            last_line = time.monotonic()
            progress_line(st["frames"], max(total_frames or 0, st["frames"]))
    if progress_line:
        progress_line(scanner.stats["frames"], scanner.stats["frames"])
    hits = merge_hits(rows, float(settings["mergeGapSec"]), settings.get("splitBySignal") or ())
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, HITS + f".{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        for h in hits:
            f.write(json.dumps(h, ensure_ascii=False) + "\n")
    os.replace(tmp, os.path.join(out_dir, HITS))
    ms = scanner.match_stats()
    write_json_atomic(os.path.join(out_dir, match_gate.STATS), {
        "tool": "detector_pass", "toolVersion": TOOL_VERSION, "recording": os.path.basename(recording),
        "packVersion": pack.get("version"), **ms})
    per = {}
    for h in hits:
        p = per.setdefault(h["detector"], {"hits": 0, "signal": 0})
        p["hits"] += 1
        p["signal"] += 1 if h["signal"] else 0
    st = scanner.stats
    out = {"frames": st["frames"], "ocrFrames": st["ocrFrames"], "diffGateSkips": st["diffGateSkips"],
           "hits": len(hits), "signalHits": sum(1 for h in hits if h["signal"]), "perDetector": per,
           "seconds": round(time.monotonic() - t0, 2), "ocrRegions": scanner.regions,
           "powerThrottlingOff": scanner.unthrottled,
           "matchStats": {"top3Frames": sum(1 for r in ms["readings"] if r["kind"] == "top3"),
                          "scoreboardFrames": sum(1 for r in ms["readings"] if r["kind"] == "scoreboard"),
                          "ownKills": len(ms["ownKills"]["times"])},
           "ocrSeconds": round(st["ocrSeconds"], 2)}
    if scanner.regions == "rois":
        out.update(bands={m or "all": [{"px": list(b["px"]), "every": b["every"], "detectors": b["detectors"]}
                                      for b in bs] for m, bs in scanner.band_sets.items()},
                   bandOcr=st["bandOcr"], bandSkips=st["bandSkips"], bandHeld=st["bandHeld"])
    return out
