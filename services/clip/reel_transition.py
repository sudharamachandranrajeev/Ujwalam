# SPDX-License-Identifier: GPL-3.0-or-later
"""RP1 reel transitions (plan 2026-11-12-reel-polish-music-learning.md): the join between the pieces of a reel.

Data: data/clip/transitions.json (kinds, each an ffmpeg xfade name or none, with the length range). The user's choice
is <data>/settings.json clips.reelTransition {kind, ms} (Settings > Clips); services/studio-ui/user-settings.mjs checks
it the same way as transition_problems() here. Behind the flag reel-transitions (off by default): off, or a bad value,
gives the hard cut of before.

active(data_dir) -> {"kind", "xfade", "ms"} for clip_montage.render_argv(transition=...), or None for a hard cut.
"""

from __future__ import annotations

import os

from clip_common import CLIP_DATA, SETTINGS_FILE, ClipError, flag_on, load_json

DEFAULTS_FILE = os.path.join(CLIP_DATA, "transitions.json")
FLAG = "reel-transitions"


def load_defaults(path=None):
    """-> transitions.json with "byId" {id: kind row}."""
    d = load_json(path or DEFAULTS_FILE)
    d["byId"] = {k["id"]: k for k in d["kinds"]}
    if d["default"] not in d["byId"]:
        raise ClipError("transitions.json: the default kind is not listed")
    return d


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def transition_problems(v, d=None):
    """Problems with a clips.reelTransition value {kind, ms}; [] when fine."""
    d = d or load_defaults()
    if not isinstance(v, dict) or sorted(v) != ["kind", "ms"]:
        return ["clips.reelTransition needs kind and ms"]
    k = d["byId"].get(v["kind"]) if isinstance(v["kind"], str) else None
    if not k:
        return [f"clips.reelTransition.kind must be one of {', '.join(d['byId'])}"]
    r = k.get("ms")
    if r and (not _num(v["ms"]) or not r["min"] <= v["ms"] <= r["max"]):
        return [f"clips.reelTransition.ms must be {r['min']}-{r['max']}"]
    return []


def effective(data_dir=None, d=None):
    """{"kind", "ms"}: the user's valid choice, else the default kind at its default length."""
    d = d or load_defaults()
    k = d["byId"][d["default"]]
    out = {"kind": k["id"], "ms": (k.get("ms") or {}).get("default", 0)}
    if data_dir:
        try:
            j = load_json(os.path.join(data_dir, SETTINGS_FILE))
        except (OSError, ClipError):
            return out
        c = j.get("clips") if isinstance(j, dict) else None
        v = c.get("reelTransition") if isinstance(c, dict) else None
        if v is not None and not transition_problems(v, d):
            out = {"kind": v["kind"], "ms": v["ms"]}
    return out


def active(data_dir=None, d=None):
    """The transition to render with, or None (flag off or a hard cut)."""
    d = d or load_defaults()
    if not flag_on(data_dir, FLAG):
        return None
    e = effective(data_dir, d)
    x = d["byId"][e["kind"]].get("xfade")
    return {"kind": e["kind"], "xfade": x, "ms": e["ms"]} if x else None
