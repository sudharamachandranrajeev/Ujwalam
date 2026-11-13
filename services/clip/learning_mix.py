# SPDX-License-Identifier: GPL-3.0-or-later
"""RP5 / AN2 self-learning, the planner side (D364, D373; flag self-learning, off by default).

The mix is learned and written by services/learning/mix.mjs (<data>/learning/mix.json, the only writer); this module
only reads it. Settings and limits: data/clip/learning-mix.json.

load_mix(data_dir) -> {"shares", "changedAt"} or None. None (flag off, no file, a bad file, or applied false = cold
    start or undone to the start) means: plan exactly as before.
reel_choices(ex, mix, cid, source) -> ex   per reel: transition, title card and music bed drawn from the shares with a
    seeded draw (same reel, same mix -> same choice). A choice is only ever switched OFF for a reel: a feature whose
    own flag or setting is off stays off (the learning never turns a feature on). With mix None, ex comes back as is.
length_target(cfg, lim, mix, source) -> cfg   one length band per run sets the montage target length, inside the user's
    min and max. With mix None, cfg comes back as is.
choices_record(row) -> {"transition", "title", "music"}   what a rendered reel actually used (for uploads.json).
"""

from __future__ import annotations

import hashlib
import os
import random

from clip_common import CLIP_DATA, ClipError, flag_on, load_json

FLAG = "self-learning"
CONFIG_FILE = os.path.join(CLIP_DATA, "learning-mix.json")
MIX_FILE = os.path.join("learning", "mix.json")


def load_config(path=None):
    d = load_json(path or CONFIG_FILE)
    d["byId"] = {x["id"]: x for x in d["dimensions"]}
    return d


def _valid(shares, cfg):
    try:
        for dim in cfg["dimensions"]:
            s = shares[dim["id"]]
            vals = [float(s[a]) for a in dim["arms"]]
            if any(v < 0 for v in vals) or abs(sum(vals) - 1.0) > 1e-3:
                return False
        return True
    except (KeyError, TypeError, ValueError):
        return False


def load_mix(data_dir, cfg=None):
    """The learned mix in use, or None (today's behaviour)."""
    if not data_dir or not flag_on(data_dir, FLAG):
        return None
    try:
        cfg = cfg or load_config()
        j = load_json(os.path.join(data_dir, MIX_FILE))
    except (OSError, ClipError, KeyError, TypeError):
        return None
    if not isinstance(j, dict) or j.get("version") != 1 or j.get("applied") is not True or not _valid(j.get("shares"), cfg):
        return None
    return {"shares": j["shares"], "changedAt": j.get("changedAt")}


def _rng(*parts):
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()
    return random.Random(int.from_bytes(h[:8], "little"))


def _pick(rng, shares, arms):
    x = rng.random()
    acc = 0.0
    for a in arms:
        acc += float(shares[a])
        if x < acc:
            return a
    return arms[-1]


def reel_choices(ex, mix, cid, source, cfg=None):
    """A copy of the run's extras with this reel's transition/title/music, or ex itself when there is no mix."""
    if not mix:
        return ex
    cfg = cfg or load_config()
    sh = mix["shares"]
    rng = _rng("reel", cid, os.path.basename(str(source)), mix.get("changedAt"))
    out = dict(ex)
    picks = {}
    for dim, key, off_arm in (("transition", "transition", "cut"), ("title", "title", "off"), ("music", "music", "off")):
        arm = _pick(rng, sh[dim], cfg["byId"][dim]["arms"])  # drawn always, so one dimension never shifts another's draw
        picks[dim] = arm
        if arm == off_arm:
            out[key] = None
    out["learning"] = {"mixAt": mix.get("changedAt"), "picks": picks}
    return out


def length_target(cfg_m, lim, mix, source, cfg=None):
    """The montage settings with this run's target length band (inside lim minSec..maxSec), or cfg_m as is."""
    if not mix:
        return cfg_m
    cfg = cfg or load_config()
    dim = cfg["byId"]["lengthBand"]
    arm = _pick(_rng("length", os.path.basename(str(source)), mix.get("changedAt")), mix["shares"]["lengthBand"], dim["arms"])
    b = dim["bands"][arm]
    lo = max(float(b["minSec"]), float(lim["minSec"]))
    hi = float(lim["maxSec"]) if b.get("maxSec") is None else min(float(b["maxSec"]), float(lim["maxSec"]))
    if hi <= lo:
        return cfg_m
    return dict(cfg_m, targetMinSec=lo, targetMaxSec=hi, learningBand=arm)


def choices_record(row, mix_at=None):
    """What a rendered reel row of render.json used: {"transition": cut|<kind>, "title": on|off, "music": on|off}."""
    tr = row.get("transition")
    out = {"transition": (tr.get("kind") or "fade") if isinstance(tr, dict) else "cut",
           "title": "on" if row.get("title") else "off",
           "music": "on" if row.get("music") else "off"}
    if mix_at:
        out["mixAt"] = mix_at
    return out
