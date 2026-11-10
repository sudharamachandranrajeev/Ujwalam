# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 output names (user 2026-11-08: "use a folder and file name convention accordingly"; the clips folder is where
the user finds uploads the app could not post, so it holds finished videos only).

Clips folder (Settings > Clips folder):
  <clips>/<YYYY-MM-DD>/<game>_<kind>_<YYYYMMDD-HHMMSS>_<label>_<nn>_<canvas>.mp4
    YYYY-MM-DD       local date of the recording (or stream) the clip came from
    game             game id of the detector pass (e.g. codm); "game" when unknown
    kind             short | montage | won-reel
    YYYYMMDD-HHMMSS  local wall time of the clip's first moment (short: its start; montage, won-reel: its earliest piece)
    label            short: the best medal, e.g. triple-kill; montage: kills-12; won-reel: victory-kills-7 / defeat-kills-11 (match-kills-N if no result)
    nn               01, 02, ... per kind within one recording
    canvas           v = cut of the V canvas recording (the vertical stream design); v-<layout> = a vertical layout
                     made from the H recording (full-crop, game-facecam, blurred-fill); h = horizontal
  Nothing else goes there: analysis files, logs, render/report JSON and working files stay in the app data folder
  (<data>/clips/runs/<run>/), and so does the upload list (<data>/clips/uploads.json).

Recordings folder (Settings > Recordings folder): full recordings only, <profile>-<h|v>-<YYYYMMDD-HHMMSS>.mkv. The
host makes that name (app/host outputs.cpp: <sink name base>-<stamp>.<ext>; the base comes from the outputs plan,
e.g. data/outputs/alpha-practice.json "practice-h.mkv"). Replay buffer saves are host-named too
(<recordings>/replay/replay-<H|V>-<stamp>.mkv, app/host methods.cpp); the live clipper's saves are intermediates and
are deleted once edited into clips; a replay saved by hand stays where the host put it.
"""

from __future__ import annotations

import re
from datetime import datetime

KINDS = ("short", "montage", "won-reel")
_SLUG = re.compile(r"[^a-z0-9]+")
NAME_RE = re.compile(r"^(?P<game>[a-z0-9-]+)_(?P<kind>short|montage|won-reel)_(?P<stamp>\d{8}-\d{6})_(?P<label>[a-z0-9-]+)_"
                     r"(?P<nn>\d{2,3})_(?P<canvas>v|h|v-[a-z0-9-]+)\.mp4$")


def slug(text, limit=32):
    s = _SLUG.sub("-", str(text or "").lower()).strip("-")
    return (s[:limit].rstrip("-")) or "clip"


def canvas_suffix(layout):
    """layout: a layouts.json entry (or {'id', 'input', 'kind'}); a montage passes {'input': 'v'}."""
    if layout.get("canvas") == "h":
        return "h"
    if layout.get("input") == "v" or layout.get("kind") == "canvas":
        return "v"
    return "v-" + slug(layout.get("id"), 20)


def best_label(labels, det_weights=None):
    """The label of the strongest medal (weights 'M3:<label>' or '<detector>' from ranking.json), else the first."""
    labels = [x for x in (labels or []) if x]
    if not labels:
        return None
    w = det_weights or {}

    def weight(lb):
        return max((float(v) for k, v in w.items() if k.split(":", 1)[-1].lower() == str(lb).lower()), default=0.0)
    return max(labels, key=lambda lb: (weight(lb), -labels.index(lb)))


def label_for(kind, labels=None, kills=None, det_weights=None):
    if kind == "montage":
        return f"kills-{int(kills or 0)}"
    if kind == "won-reel":  # match reel (D315: wins and qualifying defeats); the result is in the clip's labels
        res = next((str(x).lower() for x in (labels or []) if str(x).upper() in ("VICTORY", "DEFEAT")), "match")
        return f"{res}-kills-{int(kills or 0)}"
    return slug(best_label(labels, det_weights) or "highlight")


def stamp(when):
    return when.strftime("%Y%m%d-%H%M%S")


def day_folder(when):
    return when.strftime("%Y-%m-%d")


def clip_name(game, kind, when, label, nn, canvas):
    if kind not in KINDS:
        raise ValueError(f"unknown clip kind {kind}")
    return f"{slug(game or 'game', 16)}_{kind}_{stamp(when)}_{slug(label)}_{int(nn):02d}_{canvas}.mp4"


def free_name(exists, make, nn):
    """make(nn) -> name; the first name from nn up for which exists(name) is false (never overwrite a file)."""
    for n in range(int(nn), 1000):
        name = make(n)
        if not exists(name):
            return name, n
    raise ValueError("too many files with the same name")


def local_time(ts):
    """Naive local datetime from a POSIX timestamp."""
    return datetime.fromtimestamp(ts)
