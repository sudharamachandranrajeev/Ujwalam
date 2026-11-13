# SPDX-License-Identifier: GPL-3.0-or-later
"""RP4 title card (D362, plan 2026-11-12-reel-polish-music-learning.md): the streamer title fades in and out over a
blurred, darkened copy of the reel.

Data: data/clip/title.json. Flag reel-title (off by default). The text is the streamer brand from
data/profile.local.json (reel_thumbnail.brand), local only; no brand, no title. Made locally by ffmpeg inside the reel's
own render (clip_montage.render_argv(title=...)), with a bundled font copied next to the run (no system font) and the
text passed through a text file with expansion off.

  plan(pieces, xd, cfg, brand, frame, safe) -> record (all numbers resolved, with the text) or None
  prepare(wd, rec, cfg)                      -> the dict render_argv takes (writes title.txt and the font copy)
  cleanup(wd)                                -> removes them
"""

from __future__ import annotations

import os
import re
import shutil

from clip_common import CLIP_DATA, ClipError, flag_on, load_json

DEFAULTS_FILE = os.path.join(CLIP_DATA, "title.json")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONTS_DIR = os.path.join(REPO, "data", "fonts")
FLAG = "reel-title"
FONT_SUBDIR = "title-fonts"
TEXT_FILE = "title.txt"
_BAD = re.compile(r"[\x00-\x1f\x7f]")


def load_config(path=None):
    cfg = load_json(path or DEFAULTS_FILE)
    if not os.path.isfile(os.path.join(FONTS_DIR, cfg["fontFile"])):
        raise ClipError(f"reel-title: font {cfg['fontFile']} is not in data/fonts")
    d = cfg["durationSec"]
    if not d["min"] <= d["value"] <= d["max"]:
        raise ClipError("reel-title: durationSec.value is outside its range")
    if cfg["fadeInMs"] >= 600 or cfg["fadeOutMs"] >= 400:
        raise ClipError("reel-title: the entrance must stay under 600 ms and the exit under 400 ms")
    if cfg["fadeInMs"] + cfg["fadeOutMs"] >= d["min"] * 1000:
        raise ClipError("reel-title: the fades do not fit in the shortest title")
    return cfg


def on(data_dir):
    return flag_on(data_dir, FLAG)


def _clean(s, n):
    s = re.sub(r"\s+", " ", _BAD.sub(" ", str(s))).strip()
    return s[:n].strip()


def timeline(pieces, xd):
    """-> (title start in reel time, reel length): the title starts where the leading teaser pieces end (0 without)."""
    ds = [float(p["end"]) - float(p["start"]) for p in pieces]
    k = 0
    while k < len(ds) and pieces[k].get("teaser"):
        k += 1
    if k >= len(ds):
        k = 0  # a reel made only of teaser pieces: title at the start
    return max(0.0, sum(ds[:k]) - k * xd), sum(ds) - (len(ds) - 1) * xd


def plan(pieces, xd, cfg, brand, frame, safe):
    """The title record, or None (no brand, or the reel is too short to hold the title)."""
    text = _clean(brand, int(cfg["maxChars"])) if isinstance(brand, str) and not brand.strip().startswith("<") else ""
    if not text or not pieces:
        return None
    start, total = timeline(pieces, xd)
    dur = float(cfg["durationSec"]["value"])
    if total < float(cfg["minReelSec"]):
        return None
    if start + dur > total - 0.5:  # no room after the teaser: open the reel with it instead
        start = 0.0
    if start + dur > total - 0.5:
        return None
    ow, oh = int(frame["width"]), int(frame["height"])
    safe_w = ow - int(safe.get("left", 0)) - int(safe.get("right", 0))
    size = round(float(cfg["sizeOfHeight"]) * oh)
    size = max(8, min(size, int(safe_w / max(1, len(text)) / float(cfg["glyphWidthOfSize"]))))
    return {"text": text, "start": round(start, 3), "end": round(start + dur, 3), "size": size,
            "border": max(1, round(size * float(cfg["borderOfSize"]))), "left": int(safe.get("left", 0)), "safeWidth": safe_w,
            "fadeInMs": int(cfg["fadeInMs"]), "fadeOutMs": int(cfg["fadeOutMs"])}


def prepare(wd, rec, cfg):
    """Writes wd/title.txt and wd/title-fonts/<font> -> the dict clip_montage.render_argv(title=) takes."""
    fd = os.path.join(wd, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    shutil.copyfile(os.path.join(FONTS_DIR, cfg["fontFile"]), os.path.join(fd, cfg["fontFile"]))
    with open(os.path.join(wd, TEXT_FILE), "w", encoding="utf-8", newline="") as f:
        f.write(rec["text"])
    return dict(rec, textFile=TEXT_FILE, fontFile=f"{FONT_SUBDIR}/{cfg['fontFile']}",
                colour="0x" + cfg["colour"].lstrip("#"), blur=cfg["blur"], darken=float(cfg["darken"]))


def cleanup(wd):
    shutil.rmtree(os.path.join(wd, FONT_SUBDIR), ignore_errors=True)
    try:
        os.remove(os.path.join(wd, TEXT_FILE))
    except OSError:
        pass
