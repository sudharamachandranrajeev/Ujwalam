# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 candidate ranking: per-second signals -> events -> merged, scored windows.

Signals (all seconds into the recording):
  markers       explicit clip requests (hotkey, api, chat, audio sources)
  chat intent   any second with a "clip it" style message
  chat velocity rolling message count over windowSec against the session median (approved P2 baseline 1)
  loudness      short-term loudness z-score against the session median/MAD (approved P2 baseline 2)
  detector hits from the post-stream detector pass (detector_pass.py); weight 0 until ranking.json
                detectorWeightsStatus is "approved" (detector_weight); a zero-weight hit only attaches as a reason

Each event opens a window [t - pre, t + post] (backdated, build plan 4.10). Overlapping windows merge into one
candidate while the union stays within clip.maxSec; a candidate more than half inside a better one is dropped. Score = sum over signal kinds of the strongest weight*strength of that kind, so agreement between
different signals counts and a burst of one kind does not. Weights and windows come from data/clip/ranking.json
(status 'proposed' until the user approves them).
"""

from __future__ import annotations

import statistics


def _median(xs):
    return statistics.median(xs) if xs else 0.0


def chat_events(counts, intents, cfg, weights):
    ev = []
    if counts is None:
        return ev
    for i, k in enumerate(intents or []):
        if k > 0:
            ev.append({"t": i + 0.5, "kind": "chat.intent", "w": weights.get("chat.intent", 0.0), "strength": 1.0,
                       "detail": {"messages": k}, "win": "chat"})
    win = max(1, int(cfg["windowSec"]))
    roll, s = [], 0
    for i, c in enumerate(counts):
        s += c
        if i >= win:
            s -= counts[i - win]
        roll.append(s)
    if not any(roll):
        return ev
    base = _median(roll)
    need = max(float(cfg["minMessages"]), base * float(cfg["ratio"]))
    peaks = [(i, r) for i, r in enumerate(roll) if r >= need]
    for i, r in _local_peaks(peaks, int(cfg.get("minGapSec", 30))):
        ev.append({"t": float(i), "kind": "chat.velocity", "w": weights.get("chat.velocity", 0.0),
                   "strength": min(1.0, r / (2.0 * need)) if need else 1.0,
                   "detail": {"window": r, "baseline": round(base, 2), "need": round(need, 2)}, "win": "chat"})
    return ev


def loudness_events(lufs, cfg, weights, min_gap):
    if not lufs:
        return [], None
    floor = float(cfg["floorLufs"])
    live = [x for x in lufs if x > floor]
    if len(live) < int(cfg.get("minVoicedSec", 10)):
        return [], {"median": None, "spread": None, "voicedSec": len(live)}
    med = _median(live)
    mad = _median([abs(x - med) for x in live]) * 1.4826
    spread = max(float(cfg["minSpread"]), mad)
    thr = float(cfg["zThreshold"])
    peaks = []
    for i, x in enumerate(lufs):
        if x <= floor:
            continue
        z = (x - med) / spread
        if z >= thr:
            peaks.append((i, z))
    ev = []
    for i, z in _local_peaks(peaks, min_gap):
        ev.append({"t": i + 0.5, "kind": "audio.loudness", "w": weights.get("audio.loudness", 0.0),
                   "strength": min(1.0, z / (2.0 * thr)),
                   "detail": {"lufs": round(lufs[i], 1), "median": round(med, 1), "z": round(z, 2)}, "win": "audio"})
    return ev, {"median": round(med, 2), "spread": round(spread, 2), "voicedSec": len(live)}


def _local_peaks(peaks, min_gap):
    """Greedy non-maximum suppression: strongest first, drop any within min_gap seconds of a kept one."""
    kept = []
    for i, v in sorted(peaks, key=lambda p: (-p[1], p[0])):
        if all(abs(i - j) >= min_gap for j, _ in kept):
            kept.append((i, v))
    return sorted(kept)


def marker_events(markers, weights):
    return [{"t": m["t"], "kind": f"marker.{m['source']}", "w": weights.get(f"marker.{m['source']}", 0.0),
             "strength": 1.0, "detail": {}, "win": "marker"} for m in markers]


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def detector_weight(h, det_weights, approved):
    """(weight, why) of one detector hit. Rule (AGENTS.md: weights are approved by the user, never invented):
    weight > 0 only when ranking.json detectorWeightsStatus is "approved" AND the hit is a positive clip reason
    (signal not false, role positive, clipReason not false) AND a number exists, from ranking.json detectorWeights
    ("<det>:<label>" first, then "<det>") or else the pack weight carried in the hit. Otherwise 0."""
    if not approved:
        return 0.0, "weights not approved"
    if h.get("signal") is False:
        return 0.0, "no signal"
    if h.get("role", "positive") != "positive" or h.get("clipReason") is False:
        return 0.0, "not a clip reason"
    for w in (det_weights.get(f"{h['detector']}:{h.get('label')}"), det_weights.get(h["detector"]), h.get("weight")):
        if _num(w):
            return max(0.0, float(w)), None
    return 0.0, "weight null"


def detector_events(hits, det_weights, approved=False):
    """Detector hits -> events. A zero-weight hit is attach-only: it never opens a window (so it cannot rank or
    create a candidate) and is listed as a reason on a candidate that covers its time."""
    out = []
    for h in hits:
        w, why = detector_weight(h, det_weights, approved)
        detail = {"label": h.get("label"), "weightApproved": why is None}
        if why:
            detail["zeroBecause"] = why
        if "signal" in h:
            detail["signal"] = h["signal"]
        out.append({"t": h["t"], "kind": f"detector.{h['detector']}", "w": w, "strength": 1.0, "detail": detail,
                    "win": "detector", "attachOnly": w <= 0.0})
    return out


def build_candidates(events, duration, cfg):
    """Events -> merged windows, scored and ranked. Returns at most cfg['top'] candidates."""
    wins = cfg["windows"]
    lo_len, hi_len = float(cfg["clip"]["minSec"]), float(cfg["clip"]["maxSec"])
    spans = []
    attach = [e for e in events if e.get("attachOnly")]
    for e in events:
        if e.get("attachOnly"):
            continue
        w = wins[e["win"]]
        a, b = max(0.0, e["t"] - float(w["preSec"])), min(duration, e["t"] + float(w["postSec"]))
        if b > a:
            spans.append([a, b, [e]])
    spans.sort(key=lambda s: s[0])
    merged = []
    for s in spans:
        # Merge only while the union stays within maxSec, so a chain of touching windows never swallows
        # several separate moments into one clip.
        if merged and s[0] <= merged[-1][1] and max(merged[-1][1], s[1]) - merged[-1][0] <= hi_len:
            merged[-1][1] = max(merged[-1][1], s[1])
            merged[-1][2].extend(s[2])
        else:
            merged.append(s)
    cands = []
    for a, b, evs in merged:
        best_kind = {}
        for e in evs:
            v = e["w"] * e["strength"]
            if v > best_kind.get(e["kind"], -1.0):
                best_kind[e["kind"]] = v
        score = sum(best_kind.values())
        anchor = max(evs, key=lambda e: (e["w"] * e["strength"], -e["t"]))
        a, b = _fit(a, b, anchor, duration, lo_len, hi_len, wins[anchor["win"]])
        reasons = [{"kind": e["kind"], "t": round(e["t"], 2), "weight": e["w"], "strength": round(e["strength"], 3),
                    **({"detail": e["detail"]} if e["detail"] else {})} for e in sorted(evs, key=lambda e: e["t"])]
        cands.append({"start": round(a, 2), "end": round(b, 2), "score": round(score, 4),
                      "anchor": round(anchor["t"], 2), "reasons": reasons})
    cands.sort(key=lambda c: (-c["score"], c["start"]))
    kept = []
    for c in cands:  # a candidate that is mostly inside a better one adds nothing
        if all(_overlap(c, k) <= 0.5 * (c["end"] - c["start"]) for k in kept):
            kept.append(c)
    cands = kept[: int(cfg.get("top", 10))]
    for i, c in enumerate(cands, 1):
        c["id"] = f"c{i:02d}"
        c["rank"] = i
    # Zero-weight (unapproved) detector hits: shown as reasons with weight 0 after scoring, so they never change a
    # score, an anchor, a window or the order.
    for e in sorted(attach, key=lambda e: e["t"]):
        for c in cands:
            if c["start"] <= e["t"] <= c["end"]:
                c["reasons"].append({"kind": e["kind"], "t": round(e["t"], 2), "weight": 0.0,
                                     "strength": round(e["strength"], 3), "detail": e["detail"]})
                e["candidate"] = c["id"]
                break
    for c in cands:
        c["reasons"].sort(key=lambda r: r["t"])
    return cands


def _overlap(x, y):
    return max(0.0, min(x["end"], y["end"]) - max(x["start"], y["start"]))


def _fit(a, b, anchor, duration, lo_len, hi_len, w):
    """Keeps a window within [minSec, maxSec] and inside the file. A long merged window is cut back around its
    strongest event with that event's own pre/post window; a short one grows at the end first, then the start."""
    if b - a > hi_len:
        a = max(0.0, anchor["t"] - float(w["preSec"]))
        b = min(duration, a + hi_len, anchor["t"] + float(w["postSec"]))
        if b - a > hi_len:
            a = b - hi_len
    if b - a < lo_len:
        b = min(duration, a + lo_len)
        if b - a < lo_len:
            a = max(0.0, b - lo_len)
    return a, b
