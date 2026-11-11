# SPDX-License-Identifier: GPL-3.0-or-later
"""CL1 reel length (D350, user 2026-11-11): every montage, match reel and impact-play reel is at most the maximum
length of its type (60 s by default); longer content is split into parts.

Data: data/clip/reel-length.json (defaults, upper bound limitMaxSec). The user's values are in
<data>/settings.json clips.reelLengths {type: {minSec, maxSec}} (Settings > Clips); services/studio-ui/user-settings.mjs
checks them the same way as limits_problems() here. A bad or missing value falls back to the default.

split_reel(reel, max_sec, min_sec) -> [reel]
  * a piece is a clip or segment (a cut around one kill or a run of close kills, or the result screen): a part
    boundary is always between two pieces, never inside one;
  * a piece longer than max_sec is trimmed to max_sec around its peak (reel["peaks"] when given and inside the
    piece, else the piece's midpoint) and the trim is recorded in the part's "trimmed" list;
  * pieces are packed in their order; each part is at most max_sec. When the last part is shorter than min_sec,
    pieces of the part before it move over while that part stays at least min_sec; if it is still short it is kept
    (no content is dropped) and says so in "belowMin";
  * a reel that fits comes back as it was (no "part"), apart from a recorded trim.
Parts carry part (1-based), parts, kills (of their pieces) and labels + "part N of M".
"""

from __future__ import annotations

import os

from clip_common import CLIP_DATA, SETTINGS_FILE, ClipError, load_json

DEFAULTS_FILE = os.path.join(CLIP_DATA, "reel-length.json")
MIN_MAX_SEC = 5  # a maximum below this is refused (a reel needs at least a few seconds)
EPS = 1e-6


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def load_defaults(path=None):
    """-> {"limitMaxSec": float, "types": {id: {minSec, maxSec, label, hint}}, "order": [id]}"""
    j = load_json(path or DEFAULTS_FILE)
    limit = float(j["limitMaxSec"])
    types, order = {}, []
    for t in j["types"]:
        lo, hi = float(t["minSec"]), float(t["maxSec"])
        if not (0 <= lo <= hi <= limit):
            raise ClipError(f"reel-length: bad default for {t.get('id')}")
        types[t["id"]] = {"minSec": lo, "maxSec": hi, "label": t.get("label", t["id"]), "hint": t.get("hint", "")}
        order.append(t["id"])
    return {"limitMaxSec": limit, "types": types, "order": order}


def limits_problems(patch, defaults=None):
    """Problems with a clips.reelLengths value {type: {minSec, maxSec}} (both numbers, per type); [] when fine."""
    d = defaults or load_defaults()
    if not isinstance(patch, dict):
        return ["clips.reelLengths must be an object"]
    out = []
    for k, v in patch.items():
        if k not in d["types"]:
            out.append(f"unknown reel type {k}")
        elif not isinstance(v, dict) or set(v) != {"minSec", "maxSec"}:
            out.append(f"clips.reelLengths.{k} needs minSec and maxSec")
        elif not _num(v["minSec"]) or not _num(v["maxSec"]):
            out.append(f"clips.reelLengths.{k} lengths must be numbers")
        elif int(v["minSec"]) != v["minSec"] or int(v["maxSec"]) != v["maxSec"]:
            out.append(f"{k}: lengths are whole seconds")
        elif v["minSec"] < 0:
            out.append(f"{k}: the minimum cannot be below 0 s")
        elif v["maxSec"] < MIN_MAX_SEC:
            out.append(f"{k}: the maximum cannot be below {MIN_MAX_SEC} s")
        elif v["maxSec"] > d["limitMaxSec"]:
            out.append(f"{k}: the maximum cannot be above {d['limitMaxSec']:g} s")
        elif v["minSec"] > v["maxSec"]:
            out.append(f"{k}: the minimum cannot be longer than the maximum")
    return out


def effective_limits(data_dir=None, defaults=None):
    """{type: {"minSec", "maxSec"}} for every type: the user's value from <data>/settings.json clips.reelLengths when
    it is valid, else the default."""
    d = defaults or load_defaults()
    out = {k: {"minSec": v["minSec"], "maxSec": v["maxSec"]} for k, v in d["types"].items()}
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    r = c.get("reelLengths") if isinstance(c, dict) else None
    if not isinstance(r, dict):
        return out
    for k, v in r.items():
        if k in out and not limits_problems({k: v}, d):
            out[k] = {"minSec": float(v["minSec"]), "maxSec": float(v["maxSec"])}
    return out


def _len(p):
    return p["end"] - p["start"]


def _total(items):
    return sum(_len(p) for _, p in items)


def _trim(piece, max_sec, peak=None):
    """The window of max_sec inside the piece around peak (midpoint when peak is None or outside the piece)."""
    a, b = float(piece["start"]), float(piece["end"])
    mid = peak if peak is not None and a <= peak <= b else (a + b) / 2.0
    s = min(max(mid - max_sec / 2.0, a), b - max_sec)
    return round(s, 3), round(s + max_sec, 3)


def _kills_kept(piece, s, e, peaks, rec):
    """Kills left in a trimmed piece: the peaks (kill times) inside the kept interval. Without any peak in the piece the
    count is scaled by the kept share (at least 1 while some remain) and the record says it is an estimate."""
    n = int(piece.get("kills") or 0)
    if n <= 0:
        return 0
    inside = [x for x in peaks if piece["start"] <= x <= piece["end"]]
    if inside:
        kept = sum(1 for x in inside if s <= x <= e)
        rec["killsDropped"] = len(inside) - kept
        return kept
    kept = max(1, round(n * (e - s) / (piece["end"] - piece["start"])))
    rec["killsEstimated"] = True
    rec["killsDropped"] = n - kept
    return kept


def _part(reel, items, n, m, trimmed, below_min):
    pieces = [p for _, p in items]
    idx = {i for i, _ in items}
    out = {k: v for k, v in reel.items() if k not in ("streakKills", "singleKills", "streaks", "peaks")}
    out.update({"pieces": pieces, "seconds": round(_total(items), 3),
                "kills": sum(int(p.get("kills") or 0) for p in pieces), "part": n, "parts": m,
                "labels": list(reel.get("labels") or []) + [f"part {n} of {m}"]})
    mine = [t for t in trimmed if t["piece"] in idx]
    if mine:
        out["trimmed"] = mine
    if below_min:
        out["belowMin"] = True
    return out


def split_reel(reel, max_sec, min_sec=0.0):
    max_sec, min_sec = float(max_sec), float(min_sec)
    if max_sec <= 0:
        raise ValueError("max_sec must be above 0")
    peaks = [float(x) for x in reel.get("peaks") or [] if _num(x)]
    items, trimmed = [], []
    for i, p in enumerate(reel["pieces"]):
        if _len(p) > max_sec + EPS:
            inside = [x for x in peaks if p["start"] <= x <= p["end"]]
            s, e = _trim(p, max_sec, inside[0] if inside else None)
            trimmed.append({"piece": i, "from": [round(p["start"], 3), round(p["end"], 3)], "to": [s, e],
                            "peak": round(inside[0], 3) if inside else None,
                            "droppedSec": round(_len(p) - max_sec, 3)})
            p = dict(p, start=s, end=e, kills=_kills_kept(p, s, e, peaks, trimmed[-1]))
        items.append((i, dict(p)))
    groups, cur = [], []
    for it in items:
        if cur and _total(cur) + _len(it[1]) > max_sec + EPS:
            groups.append(cur)
            cur = []
        cur.append(it)
    if cur:
        groups.append(cur)
    if len(groups) > 1:  # a short last part takes pieces from the end of the part before it
        while _total(groups[-1]) < min_sec - EPS and len(groups[-2]) > 1:
            mv = groups[-2][-1]
            if _total(groups[-2]) - _len(mv[1]) < min_sec - EPS or _total(groups[-1]) + _len(mv[1]) > max_sec + EPS:
                break
            groups[-1].insert(0, groups[-2].pop())
    if len(groups) <= 1:
        if not trimmed:
            return [reel]
        out = {k: v for k, v in reel.items() if k not in ("peaks", "streakKills", "singleKills")}
        out.update({"pieces": [p for _, p in items], "seconds": round(_total(items), 3), "trimmed": trimmed,
                    "kills": sum(int(p.get("kills") or 0) for _, p in items)})
        return [out]
    m = len(groups)
    return [_part(reel, g, n, m, trimmed, n == m and _total(g) < min_sec - EPS) for n, g in enumerate(groups, 1)]


def cap_reels(reels, limits, prefix):
    """Applies limits {"minSec", "maxSec"} to every reel. -> [(id, reel)]: ids '<prefix>NN' (unsplit) or
    '<prefix>NNpK' (part K of a split reel)."""
    out = []
    for i, r in enumerate(reels, 1):
        for p in split_reel(r, limits["maxSec"], limits["minSec"]):
            out.append((f"{prefix}{i:02d}" + (f"p{p['part']}" if p.get("part") else ""), p))
    return out
