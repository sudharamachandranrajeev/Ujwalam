# SPDX-License-Identifier: GPL-3.0-or-later
"""RP6 thumbnail start frame (D366, plan 2026-11-12-reel-polish-music-learning.md): one edited frame that opens a reel
and acts as its cover.

Data: data/clip/thumbnail.json (look, sizes, title templates). Behind the flag reel-thumbnail (off by default).
Made locally: one ffmpeg run grabs the frame of the reel's strongest moment, scales it into the reel's frame, lifts
the colour a little and draws the title lines with a bundled font (data/fonts; copied into the reel's folder, no system
font). The text is the reel's own facts: the strongest medal's name and the result as read from the game picture by
the detectors, the kill count, the mode, and the streamer brand from data/profile.local.json (local only). Never chat.

  moment(reel, cfg)                       -> source time of the picture, or None
  title_lines(reel, typ, cfg, brand)      -> [(line id, text)]
  png_argv(ffmpeg, src, t, frame, lines, cfg, safe, out_name) -> argv; run with cwd = the reel's folder
  make(ffmpeg, src, reel, typ, frame, safe, wd, cfg, brand) -> {"file", "at", "lines"} or {"error"}
clip_montage.render_argv(thumbnail="thumbnail.png") puts the PNG in front of the reel as its first frame.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess

from clip_common import CLIP_DATA, PROFILE_FILE, ClipError, flag_on, load_json, run_tool

DEFAULTS_FILE = os.path.join(CLIP_DATA, "thumbnail.json")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONTS_DIR = os.path.join(REPO, "data", "fonts")
FLAG = "reel-thumbnail"
PNG = "thumbnail.png"
FONT_SUBDIR = "fonts"
EPS = 1e-6
# letters, digits and a little punctuation; anything else (from a misread or a profile value) is dropped
_KEEP = re.compile(r"[^A-Z0-9 #!&'+\-.·]")


def load_config(path=None):
    cfg = load_json(path or DEFAULTS_FILE)
    if not os.path.isfile(os.path.join(FONTS_DIR, cfg["fontFile"])):
        raise ClipError(f"reel-thumbnail: font {cfg['fontFile']} is not in data/fonts")
    return cfg


def on(data_dir):
    return flag_on(data_dir, FLAG)


def brand(profile=PROFILE_FILE):
    """The streamer brand from the local profile, or None (missing file, missing value or a <placeholder>)."""
    try:
        v = (load_json(profile).get("streamer") or {}).get("brand")
    except (OSError, ClipError, AttributeError):
        return None
    return v.strip() if isinstance(v, str) and v.strip() and not v.strip().startswith("<") else None


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _body(reel):
    return [p for p in reel.get("pieces") or [] if not p.get("teaser")]


def _inside(t, pieces):
    """t moved inside the piece that holds it (a frame before its end), or None when no piece holds it."""
    for p in pieces:
        a, b = float(p["start"]), float(p["end"])
        if a - EPS <= t <= b + EPS:
            return round(min(max(t, a), max(a, b - 0.05)), 3)
    return None


def _best_medal(reel):
    ps = _body(reel)
    ms = [m for m in reel.get("medals") or [] if isinstance(m, dict) and _num(m.get("t")) and _inside(float(m["t"]), ps) is not None]
    # the heaviest medal; on a tie the later one (the higher streak of a chain comes later)
    return max(ms, key=lambda m: (float(m.get("w") or 1.0), float(m["t"]))) if ms else None


def moment(reel, cfg):
    """Source time of the picture: just after the strongest medal appears, else just after the densest run of kills
    (most kills within windowSec), else the reel's anchor, else the middle of its first piece."""
    mc, ps = cfg["moment"], _body(reel)
    if not ps:
        return None
    def after(t, lead):  # just after t, kept inside the piece that holds t
        p = next(p for p in ps if float(p["start"]) - EPS <= t <= float(p["end"]) + EPS)
        return _inside(min(t + lead, float(p["end"])), [p])

    m = _best_medal(reel)
    if m is not None:
        return after(float(m["t"]), float(mc["medalLeadSec"]))
    peaks = sorted(float(x) for x in reel.get("peaks") or [] if _num(x) and _inside(float(x), ps) is not None)
    if peaks:
        w = float(mc["windowSec"])
        k = max(peaks, key=lambda t: (sum(1 for x in peaks if t - w - EPS <= x <= t + EPS), t))
        return after(k, float(mc["killLeadSec"]))
    if _num(reel.get("anchor")) and _inside(float(reel["anchor"]), ps) is not None:
        return _inside(float(reel["anchor"]), ps)
    p = ps[0]
    return round((float(p["start"]) + float(p["end"])) / 2.0, 3)


def _clean(s, n):
    s = _KEEP.sub("", str(s).upper())
    return re.sub(r"\s+", " ", s).strip()[:n].strip()


def facts(reel):
    """{medal, killsText, result, mode}: only the known ones."""
    out = {}
    m = _best_medal(reel)
    if m and m.get("label"):
        out["medal"] = m["label"]
    story = reel.get("story") or {}
    kills = reel.get("kills")
    if not (isinstance(kills, int) and kills > 0):
        kills = len({round(float(x), 3) for x in reel.get("peaks") or [] if _num(x)})
    if kills > 0:
        out["killsText"] = f"{kills} KILL" + ("S" if kills > 1 else "")
    # resultText/mode: the reel's match from matches.json (the caller adds them); a story montage carries its own
    res = reel.get("resultText") or story.get("result")
    if isinstance(res, str) and res.strip():
        out["result"] = res
    mode = reel.get("mode") or story.get("mode")
    if isinstance(mode, str) and mode.strip():
        out["mode"] = mode
    return out


def _fill(templates, f):
    for tpl in templates:
        names = re.findall(r"\{(\w+)\}", tpl)
        if all(n in f for n in names):
            return tpl.format(**{n: f[n] for n in names})
    return None


def title_lines(reel, typ, cfg, brand_text=None):
    """[(line id, text)] for the reel type, each cleaned and cut to its maxChars; empty lines left out."""
    t = cfg["text"].get(typ) or cfg["text"]["live-clip"]
    f = facts(reel)
    sizes = {x["id"]: x for x in cfg["lines"]}
    main = _fill(t["main"], f)
    sub = _fill(t.get("sub") or [], f)
    if isinstance(brand_text, str) and brand_text.strip().startswith("<"):
        brand_text = None  # a <placeholder> from the profile template
    out = []
    for lid, s in (("main", main), ("sub", sub), ("brand", brand_text)):
        s = _clean(s, int(sizes[lid]["maxChars"])) if s else ""
        if s and not any(s == x for _, x in out):
            out.append((lid, s))
    return out


def _hex(c):
    return "0x" + c.lstrip("#")


def png_argv(ffmpeg, src, t, frame, lines, cfg, safe, out_name, text_files):
    """One ffmpeg run: the frame at source time t, scaled and padded into the reel's frame like the reel itself,
    the colour lifted, an optional vignette, then each title line centred in the safe area from the top.
    text_files: bare names of UTF-8 files (one per line, written by make()) in the working folder; drawtext reads
    them with expansion off, so no text is ever parsed as a filter option."""
    ow, oh = int(frame["width"]), int(frame["height"])
    pic = cfg["picture"]
    vf = [f"scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos", f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2",
          "setsar=1", f"hue=s={float(pic['saturation']):g}:b={float(pic['brightness']):g}"]
    if pic.get("sharpen"):
        vf.append(f"unsharp=5:5:{float(pic['sharpen']):g}:5:5:0")
    if pic.get("vignette"):
        vf.append("vignette=PI/5")
    sizes = {x["id"]: x for x in cfg["lines"]}
    safe_w = ow - int(safe.get("left", 0)) - int(safe.get("right", 0))
    y = int(safe.get("top", 0)) + round(float(cfg["topOfHeight"]) * oh)
    font = f"{FONT_SUBDIR}/{cfg['fontFile']}"
    for (lid, text), tf in zip(lines, text_files):
        s = sizes[lid]
        size = round(float(s["sizeOfHeight"]) * oh)
        # fit the line into the safe width (glyph width as a share of the size, a bold face measured once)
        size = max(8, min(size, int(safe_w / max(1, len(text)) / float(cfg["glyphWidthOfSize"]))))
        bw = max(1, round(size * float(s["borderOfSize"])))
        x = f"{int(safe.get('left', 0))}+({safe_w}-text_w)/2"
        vf.append(f"drawtext=fontfile={font}:textfile={tf}:expansion=none:fontsize={size}:fontcolor={_hex(s['colour'])}:"
                  f"borderw={bw}:bordercolor=0x000000@0.85:shadowx=0:shadowy={max(1, bw // 2)}:shadowcolor=0x000000@0.5:"
                  f"x={x}:y={y}")
        y += size + round(float(cfg["gapOfHeight"]) * oh)
    return [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", "2", "-ss", f"{float(t):.3f}", "-i", src,
            "-frames:v", "1", "-vf", ",".join(vf), "-update", "1", out_name]


def make(ffmpeg, src, reel, typ, frame, safe, wd, cfg, brand_text=None, timeout=120):
    """Writes wd/thumbnail.png. -> {"file", "at", "lines"} or {"error"}; a failure never stops the reel."""
    try:
        return _make(ffmpeg, src, reel, typ, frame, safe, wd, cfg, brand_text, timeout)
    except (OSError, subprocess.SubprocessError, ClipError, ValueError) as e:
        for n in [PNG + ".part.png"] + [x for x in _listdir(wd) if x.startswith("thumb-") and x.endswith(".txt")]:
            try:
                os.remove(os.path.join(wd, n))
            except OSError:
                pass
        return {"error": f"{type(e).__name__}: {e}"[-300:]}


def _listdir(d):
    try:
        return os.listdir(d)
    except OSError:
        return []


def _make(ffmpeg, src, reel, typ, frame, safe, wd, cfg, brand_text, timeout):
    t = moment(reel, cfg)
    if t is None:
        return {"error": "the reel has no piece"}
    lines = title_lines(reel, typ, cfg, brand_text)
    fd = os.path.join(wd, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    shutil.copyfile(os.path.join(FONTS_DIR, cfg["fontFile"]), os.path.join(fd, cfg["fontFile"]))
    names = []
    for i, (_, text) in enumerate(lines):
        n = f"thumb-{i}.txt"
        with open(os.path.join(wd, n), "w", encoding="utf-8", newline="") as f:
            f.write(text)
        names.append(n)
    try:
        r = run_tool(png_argv(ffmpeg, src, t, frame, lines, cfg, safe, PNG + ".part.png", names), cwd=wd, timeout=timeout)
    finally:
        for n in names:
            try:
                os.remove(os.path.join(wd, n))
            except OSError:
                pass
    part = os.path.join(wd, PNG + ".part.png")
    if r.returncode != 0 or not os.path.isfile(part):
        try:
            os.remove(part)
        except OSError:
            pass
        return {"error": (r.stderr or "no picture").strip()[-300:]}
    os.replace(part, os.path.join(wd, PNG))
    return {"file": PNG, "at": t, "lines": [{"id": lid, "text": s} for lid, s in lines]}
