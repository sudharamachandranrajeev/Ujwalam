# SPDX-License-Identifier: GPL-3.0-or-later
"""ED1 payoff-first hook (D352, user 2026-11-11): every montage, match reel, impact-play reel and live clip opens on
its strongest moment within the first windowSec (3 s), then plays in order. Behind the flag reel-hook (off by default).

Data: data/clip/reel-hook.json (strategy per reel type, teaser lengths, lead, hook-score weights). The user's values
are in <data>/settings.json clips.reelHooks {type: {on, teaserSec}} (Settings > Clips); services/studio-ui/
user-settings.mjs checks them the same way as hooks_problems() here. A bad or missing value falls back to the default.

A reel here is the planner's shape: {pieces: [{start, end, kills}], seconds, peaks: [kill times], medals: [{t, w}]},
times in seconds of the source recording.

  strongest moment  each own kill time (peaks) inside a piece: strength = own kills in [t - windowSec, t] plus the
                    weight of the medals from t to t + windowSec (a Triple Kill medal follows its third kill). Highest
                    first; a tie goes to the earlier one in play order. A moment whose teaser would overlap a death
                    span is never used (a reel never opens on a death).
  already           the strongest moment already plays within windowSec: nothing changes.
  reorder           (montage) the piece holding it moves to the front, the others keep their order; when the moment
                    is still deeper than windowSec into that piece, a teaser is added if the reel stays within max_sec.
  teaser            (match reel, impact-play reel, live clip) a cut of teaserSec around the moment (from leadSec before
                    it, inside its own piece) is put in front; the reel then plays from its start. The caller makes
                    room first: the CL1 split runs with the maximum minus the teaser (room_for), so every part with its
                    teaser stays within the D350 maximum. A teaser piece carries "teaser": true and kills 0 (its kills
                    are counted once, in their own piece).
Each CL1 part is planned on its own pieces, so every part gets its own hook from its own content.

hook_score(...) -> {score 0..1, kill, multiKill, medal, motion}: is there an own kill (or a streak medal, which is
awarded for own kills), two or more own kills (or a streak medal), any medal inside the first windowSec of the finished reel, and is the picture moving there (motion,
measured on the rendered file by motion_ydif; None when not measured). Stored in the reel metadata for AN2.
"""

from __future__ import annotations

import os
import re
import subprocess

from clip_common import CLIP_DATA, SETTINGS_FILE, ClipError, flag_on, load_json, run_tool

DEFAULTS_FILE = os.path.join(CLIP_DATA, "reel-hook.json")
FLAG = "reel-hook"
EPS = 1e-6


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def load_defaults(path=None):
    """-> the parsed reel-hook.json with "byType" {id: type row}."""
    j = load_json(path or DEFAULTS_FILE)
    lo, hi = float(j["teaserSec"]["min"]), float(j["teaserSec"]["max"])
    by = {}
    for t in j["types"]:
        if t.get("strategy") not in ("reorder", "teaser"):
            raise ClipError(f"reel-hook: unknown strategy for {t.get('id')}")
        if not lo <= float(t["teaserSec"]) <= hi:
            raise ClipError(f"reel-hook: teaser length of {t.get('id')} outside {lo:g}-{hi:g} s")
        by[t["id"]] = t
    return dict(j, byType=by)


def hooks_problems(patch, defaults=None):
    """Problems with a clips.reelHooks value {type: {on, teaserSec}}; [] when fine."""
    d = defaults or load_defaults()
    if not isinstance(patch, dict):
        return ["clips.reelHooks must be an object"]
    lo, hi = d["teaserSec"]["min"], d["teaserSec"]["max"]
    out = []
    for k, v in patch.items():
        if k not in d["byType"]:
            out.append(f"unknown reel type {k}")
        elif not isinstance(v, dict) or set(v) != {"on", "teaserSec"}:
            out.append(f"clips.reelHooks.{k} needs on and teaserSec")
        elif not isinstance(v["on"], bool):
            out.append(f"clips.reelHooks.{k}.on must be true or false")
        elif not _num(v["teaserSec"]) or int(v["teaserSec"]) != v["teaserSec"]:
            out.append(f"{k}: the teaser length is whole seconds")
        elif not lo <= v["teaserSec"] <= hi:
            out.append(f"{k}: the teaser length must be {lo:g} to {hi:g} s")
    return out


def effective_hooks(data_dir=None, defaults=None):
    """{type: {"on", "teaserSec"}}: the user's value when valid, else the default. The flag is checked by active()."""
    d = defaults or load_defaults()
    out = {k: {"on": bool(t["on"]), "teaserSec": float(t["teaserSec"])} for k, t in d["byType"].items()}
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    r = c.get("reelHooks") if isinstance(c, dict) else None
    if isinstance(r, dict):
        for k, v in r.items():
            if k in out and not hooks_problems({k: v}, d):
                out[k] = {"on": v["on"], "teaserSec": float(v["teaserSec"])}
    return out


def active(data_dir, defaults=None):
    """{type: {"on", "teaserSec"}} with on = flag reel-hook on AND the type's setting on."""
    d = defaults or load_defaults()
    hooks = effective_hooks(data_dir, d)
    if not flag_on(data_dir, d.get("flag") or FLAG):
        return {k: dict(v, on=False) for k, v in hooks.items()}
    return hooks


def room_for(strategy, teaser_sec):
    """Seconds to keep free for the teaser when the reel is split (CL1): the whole teaser for the teaser strategy, 0 for
    reorder (a reorder adds nothing; its fallback teaser is only added when it still fits)."""
    return float(teaser_sec) if strategy == "teaser" else 0.0


# ---------------------------------------------------------------- planning

def _len(p):
    return float(p["end"]) - float(p["start"])


def _overlaps(a, b, spans):
    return any(a < float(de) and float(ds) < b for ds, de in spans or [])


def _out_time(pieces, idx, t):
    return sum(_len(p) for p in pieces[:idx]) + (t - float(pieces[idx]["start"]))


def _moments(reel, window):
    """[(strength, play_index, t, piece_index)] for every own kill inside a piece; medals add their weight."""
    peaks = sorted(float(x) for x in reel.get("peaks") or [] if _num(x))
    medals = [m for m in reel.get("medals") or [] if isinstance(m, dict) and _num(m.get("t"))]
    out = []
    for i, p in enumerate(reel["pieces"]):
        if p.get("teaser"):
            continue
        a, b = float(p["start"]), float(p["end"])
        for t in peaks:
            if a <= t <= b:
                n = sum(1 for k in peaks if t - window - EPS <= k <= t + EPS)
                w = sum(float(m.get("w") or 1.0) for m in medals if t - EPS <= float(m["t"]) <= t + window + EPS)
                out.append((n + w, i, t))
    return out


def _teaser(piece, t, teaser_sec, lead):
    a, b = float(piece["start"]), float(piece["end"])
    L = min(float(teaser_sec), b - a)
    s = min(max(a, t - lead), b - L)
    return round(s, 3), round(s + L, 3)


def plan_hook(reel, strategy, teaser_sec, cfg, max_sec=None, deaths=None):
    """-> (reel with its hook applied, hook record). cfg: reel-hook.json. max_sec: the reel type's maximum (D350); a
    teaser is never added past it. deaths: [(start, end)] source spans (KILLCAM, spectating) to keep out of the open."""
    window, lead = float(cfg["windowSec"]), float(cfg["leadSec"])
    pieces = [dict(p) for p in reel["pieces"]]
    total = sum(_len(p) for p in pieces)
    rec = {"on": True, "strategy": strategy, "windowSec": window}
    moments = sorted(_moments(reel, window), key=lambda m: (-m[0], m[1], m[2]))
    best = None
    for strength, i, t in moments:
        s, e = _teaser(pieces[i], t, teaser_sec, lead)
        if _overlaps(s, e, deaths) or _overlaps(t - EPS, t + EPS, deaths):
            continue
        best = (strength, i, t)
        break
    if best is None:
        rec.update(used="none", reason="no own kill or medal moment outside a death span")
        return reel, rec
    strength, i, t = best
    rec.update(peak=round(t, 3), strength=round(strength, 3))
    at = _out_time(pieces, i, t)
    if at <= window + EPS and not _opens_on_death(pieces, window, deaths):
        rec.update(used="already", peakOut=round(at, 3))
        return reel, rec
    out = dict(reel)
    if strategy == "reorder":
        pieces = [pieces[i]] + pieces[:i] + pieces[i + 1:]
        at = t - float(pieces[0]["start"])
        if at <= window + EPS and not _opens_on_death(pieces, window, deaths):
            out.update(pieces=pieces)
            rec.update(used="reorder", peakOut=round(at, 3), movedPiece=i)
            return out, rec
        rec["movedPiece"] = i  # the moment is still too deep in its piece: try a teaser on top of the reorder
        i = 0
    s, e = _teaser(pieces[i], t, teaser_sec, lead)
    if max_sec is not None and total + (e - s) > float(max_sec) + EPS:
        if strategy == "reorder":
            out.update(pieces=pieces)
            rec.update(used="reorder", peakOut=round(at, 3), reason="no room for a teaser within the maximum")
            return out, rec
        rec.update(used="none", reason="no room for a teaser within the maximum")
        return reel, rec
    out.update(pieces=[{"start": s, "end": e, "kills": 0, "teaser": True}] + pieces,
               seconds=round(total + (e - s), 3))
    rec.update(used="teaser" if strategy == "teaser" else "reorder+teaser", teaser=[s, e],
               teaserSec=round(e - s, 3), peakOut=round(t - s, 3))
    return out, rec


def _opens_on_death(pieces, window, deaths):
    """True when any of the first `window` seconds of play comes from inside a death span."""
    left = window
    for p in pieces:
        if left <= 0:
            break
        a = float(p["start"])
        b = min(float(p["end"]), a + left)
        if _overlaps(a, b, deaths):
            return True
        left -= b - a
    return False


# ---------------------------------------------------------------- score

def _events_out(pieces, times):
    """Source times -> play times (a time inside several pieces, e.g. a teaser and its own piece, is listed for each)."""
    out, off = [], 0.0
    for p in pieces:
        a, b = float(p["start"]), float(p["end"])
        out += [off + (x - a) for x in times if a - EPS <= x <= b + EPS]
        off += b - a
    return out


def hook_score(pieces, peaks, medals, cfg, motion=None):
    """Hook quality of a finished reel (pieces in play order). motion: the measured YDIF mean (None = not measured)."""
    sc = cfg["score"]
    window = float(cfg["windowSec"])
    w = sc["weights"]
    kills = sorted(x for x in _events_out(pieces, [float(k) for k in peaks or [] if _num(k)]) if x <= window + EPS)
    ms = [m for m in medals or [] if isinstance(m, dict) and _num(m.get("t"))]
    meds = [x for x in _events_out(pieces, [float(m["t"]) for m in ms]) if x <= window + EPS]
    # a streak medal is awarded for own kills (kill and multi-kill); a medal marked "kill": false (IMPACT PLAY) is not
    streak = [x for x in _events_out(pieces, [float(m["t"]) for m in ms if m.get("kill", True)]) if x <= window + EPS]
    parts = {"kill": bool(kills) or bool(streak), "multiKill": len(kills) >= int(sc["multiKillMin"]) or bool(streak),
             "medal": bool(meds),
             "motion": None if motion is None else bool(motion >= float(sc["motion"]["minYdif"]))}
    score = sum(float(w[k]) for k, v in parts.items() if v)
    out = dict(parts, score=round(score / sum(float(x) for x in w.values()), 3), windowSec=window,
               killsInWindow=len(kills), weightsStatus=sc.get("status", "proposed"))
    if motion is not None:
        out["ydif"] = round(float(motion), 3)
    return out


YDIF_RE = re.compile(r"lavfi\.signalstats\.YDIF=([0-9.]+)")


def motion_ydif(ffmpeg, path, window, cwd=None):
    """Mean YDIF (luma change between frames, 0-255) over the first `window` seconds of a video; None on failure."""
    argv = [ffmpeg, "-v", "info", "-nostdin", "-hide_banner", "-t", f"{float(window):.3f}", "-i", path, "-an",
            "-vf", "scale=270:-2,signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF", "-f", "null", "-"]
    try:
        r = run_tool(argv, cwd=cwd, timeout=300)
    except (OSError, subprocess.SubprocessError):
        return None
    vals = [float(x) for x in YDIF_RE.findall(r.stderr or "")]
    if r.returncode != 0 or len(vals) < 2:
        return None
    return sum(vals[1:]) / (len(vals) - 1)  # the first frame has no previous frame (YDIF 0)


def reel_medals(units_or_groups):
    """[{t, w, label}] of medal dicts from montage groups (clip_montage.groups shape)."""
    return [{"t": float(m["t"]), "w": float(m.get("w") or 1.0), "label": m.get("label")}
            for g in units_or_groups for m in g.get("medals") or []]
