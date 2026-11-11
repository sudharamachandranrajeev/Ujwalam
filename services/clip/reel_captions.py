# SPDX-License-Identifier: GPL-3.0-or-later
"""ED2 burned-in captions (D353, user 2026-11-11): what was said live, from the local speech to text, burned into
montages, match reels, impact-play reels and live clips. Behind the flag reel-captions (off by default).

Data: data/clip/reel-captions.json (backend, model, confidence threshold, preset id); the look is the registry preset
(registry/presets/<preset>.json, function reel-captions): font, size, colours, outline, words per card.

  transcript   the audio of the reel's pieces in play order (teaser included) is joined into one 16 kHz mono file
               and transcribed once, so segment times are already on the reel's own timeline. Stored next to the reel
               as transcript.json: {segments: [{start, end, text, confidence, show, hidden}]}.
  show         a segment is shown when its confidence is at least minConfidence (data) and it is long enough. A
               segment without a confidence is not shown. The user may edit text and show in transcript.json; a
               re-render (clipper.py recaption) uses the edited file as it is (the threshold is not applied again).
  script       the text is kept in the script the model wrote; nothing is transliterated or translated. A shown
               segment with a character the caption font has no glyph for (today: Malayalam, see D353) is not
               burned (hidden "font has no glyph for Malayalam") and stays in the transcript, so no empty boxes appear.
  font         only the bundled OFL fonts in data/fonts/ (never a Microsoft font). The preset's font file is copied
               into the reel's work folder (fonts/) and passed to libass as fontsdir, so no system font is used.
  safe zone    captions sit inside the intersection of every target's safe zone (data/clip/targets.json): bottom
               aligned at the bottom safe margin, left and right safe margins, at most maxLines lines per card;
               libass wraps any line that would still be wider than the safe width.
"""

from __future__ import annotations

import os
import shutil
import struct
import tempfile

import clip_captions as caps
from clip_common import CLIP_DATA, ClipError, flag_on, load_json, run_tool, write_json_atomic

DEFAULTS_FILE = os.path.join(CLIP_DATA, "reel-captions.json")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONTS_DIR = os.path.join(REPO, "data", "fonts")
PRESETS_DIR = os.path.join(REPO, "registry", "presets")
FLAG = "reel-captions"
TRANSCRIPT = "transcript.json"
ASS_NAME = "captions.ass"
FONT_SUBDIR = "fonts"
SCRIPTS = (("Malayalam", 0x0D00, 0x0D7F), ("Devanagari", 0x0900, 0x097F), ("Tamil", 0x0B80, 0x0BFF),
           ("Latin", 0x0000, 0x024F))


def load_config(path=None):
    return load_json(path or DEFAULTS_FILE)


def load_style(cfg, presets_dir=PRESETS_DIR):
    """The preset's params (registry/presets/<cfg.preset>.json); its function must be reel-captions."""
    p = load_json(os.path.join(presets_dir, cfg["preset"] + ".json"))
    if p.get("function") != "reel-captions":
        raise ClipError(f"reel-captions: preset {cfg['preset']} is not a reel-captions preset")
    st = dict(p["params"])
    if not os.path.isfile(os.path.join(FONTS_DIR, st["fontFile"])):
        raise ClipError(f"reel-captions: font {st['fontFile']} is not in data/fonts")
    return st


def on(data_dir, cfg=None):
    return flag_on(data_dir, (cfg or {}).get("flag") or FLAG)


def model_path(data_dir, cfg, given=None):
    """--whisper-model, else <event-core data>/../models/<model> when it exists, else None."""
    if given:
        return given
    if not data_dir:
        return None
    p = os.path.join(os.path.dirname(os.path.abspath(data_dir)), "models", cfg["model"])
    return p if os.path.isdir(p) else None


# ---------------------------------------------------------------- font coverage (stdlib TrueType cmap reader)

def font_codepoints(path):
    """Set of code points the font maps (cmap format 4 and 12 subtables). Raises ClipError on an unreadable font."""
    with open(path, "rb") as f:
        data = f.read()
    try:
        num = struct.unpack(">H", data[4:6])[0]
        cmap = None
        for i in range(num):
            tag, _, off, _ = struct.unpack(">4sIII", data[12 + 16 * i:28 + 16 * i])
            if tag == b"cmap":
                cmap = off
        if cmap is None:
            raise ClipError(f"{os.path.basename(path)}: no cmap table")
        n = struct.unpack(">H", data[cmap + 2:cmap + 4])[0]
        out = set()
        for i in range(n):
            _, _, sub = struct.unpack(">HHI", data[cmap + 4 + 8 * i:cmap + 12 + 8 * i])
            o = cmap + sub
            fmt = struct.unpack(">H", data[o:o + 2])[0]
            if fmt == 4:
                segx2 = struct.unpack(">H", data[o + 6:o + 8])[0]
                seg = segx2 // 2
                ends = struct.unpack(f">{seg}H", data[o + 14:o + 14 + segx2])
                starts = struct.unpack(f">{seg}H", data[o + 16 + segx2:o + 16 + 2 * segx2])
                deltas = struct.unpack(f">{seg}h", data[o + 16 + 2 * segx2:o + 16 + 3 * segx2])
                ro_at = o + 16 + 3 * segx2
                ros = struct.unpack(f">{seg}H", data[ro_at:ro_at + segx2])
                for k in range(seg):
                    for c in range(starts[k], ends[k] + 1):
                        if c == 0xFFFF:
                            continue
                        if ros[k] == 0:
                            g = (c + deltas[k]) & 0xFFFF
                        else:
                            gi = ro_at + 2 * k + ros[k] + 2 * (c - starts[k])
                            g = struct.unpack(">H", data[gi:gi + 2])[0]
                            g = (g + deltas[k]) & 0xFFFF if g else 0
                        if g:
                            out.add(c)
            elif fmt == 12:
                ng = struct.unpack(">I", data[o + 12:o + 16])[0]
                for k in range(ng):
                    a, b, g0 = struct.unpack(">III", data[o + 16 + 12 * k:o + 28 + 12 * k])
                    out.update(c for c in range(a, b + 1) if g0 + (c - a))
    except struct.error as e:
        raise ClipError(f"{os.path.basename(path)}: bad font file ({e})") from e
    return out


def script_of(cp):
    for name, a, b in SCRIPTS:
        if a <= cp <= b:
            return name
    return "other"


def missing_scripts(text, codepoints):
    """Scripts (names) of the characters in text that the font has no glyph for; [] when every character renders."""
    out = []
    for ch in text:
        cp = ord(ch)
        if ch.isspace() or cp in codepoints:
            continue
        s = script_of(cp)
        if s not in out:
            out.append(s)
    return out


def covers(font_file, script):
    """True when the font maps every letter of the named script's block that is assigned (spot check: the first 16)."""
    cps = font_codepoints(font_file)
    for name, a, b in SCRIPTS:
        if name == script:
            want = [c for c in range(a, b + 1) if chr(c).isalpha()][:16]
            return bool(want) and all(c in cps for c in want)
    return False


# ---------------------------------------------------------------- transcript

def pieces_wav_argv(ffmpeg, src, pieces, out_wav):
    """One ffmpeg run: the first audio track of each piece in play order, joined, 16 kHz mono PCM."""
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", "4"]
    for p in pieces:
        argv += ["-ss", f"{float(p['start']):.3f}", "-t", f"{float(p['end']) - float(p['start']):.3f}", "-i", src]
    graph = (";".join(f"[{i}:a:0]aresample=16000,asetpts=PTS-STARTPTS[a{i}]" for i in range(len(pieces))) + ";"
             + "".join(f"[a{i}]" for i in range(len(pieces))) + f"concat=n={len(pieces)}:v=0:a=1,aformat=channel_layouts=mono[aout]")
    return argv + ["-filter_complex", graph, "-map", "[aout]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out_wav]


def mark(segments, cfg, codepoints, duration=None):
    """Transcript rows with show/hidden set by the threshold, the minimum length and the font's glyphs."""
    lo, min_len = float(cfg["minConfidence"]), float(cfg.get("minSegmentSec", 0.0))
    out = []
    for s in segments:
        a, b = round(float(s["start"]), 3), round(float(s["end"]), 3)
        if duration is not None:
            b = min(b, round(float(duration), 3))
        if b <= a:
            continue
        conf = s.get("confidence")
        row = {"start": a, "end": b, "text": str(s.get("text", "")).strip(), "confidence": conf}
        hidden = None
        if conf is None:
            hidden = "no confidence from the speech to text"
        elif conf < lo:
            hidden = f"confidence {conf:.2f} below {lo:g}"
        elif b - a < min_len:
            hidden = f"shorter than {min_len:g} s"
        row["show"] = hidden is None
        row["hidden"] = hidden
        miss = missing_scripts(row["text"], codepoints)
        if miss:
            row["fontMissing"] = miss
        out.append(row)
    return out


def make_transcript(ffmpeg, src, pieces, cfg, style, opts, workdir, duration=None, transcribe=None):
    """Transcribes the reel's pieces -> (transcript dict or None, info). Writes workdir/transcript.json when there is
    any segment. transcribe: injected for tests (backend, wav, opts) -> (segments, info)."""
    transcribe = transcribe or caps.transcribe
    with tempfile.TemporaryDirectory(dir=workdir) as td:
        wav = os.path.join(td, "reel.wav")
        r = run_tool(pieces_wav_argv(ffmpeg, src, pieces, wav), timeout=900)
        if r.returncode != 0 or not os.path.isfile(wav):
            return None, {"backend": cfg["backend"], "status": "unavailable", "reason": "audio extract failed"}
        segs, info = transcribe(cfg["backend"], wav, dict(opts, multilingual=bool(cfg.get("multilingual")),
                                                          full_json=True, language=cfg.get("language")))
    if info.get("status") != "ok":
        return None, info
    cps = font_codepoints(os.path.join(FONTS_DIR, style["fontFile"]))
    rows = mark(segs, cfg, cps, duration)
    doc = {"version": 1, "backend": cfg["backend"], "model": os.path.basename(str(opts.get("whisper_model") or "")),
           "language": info.get("language"), "minConfidence": cfg["minConfidence"], "font": style["fontFamily"],
           "edited": False, "note": "Edit text or show, then run clipper.py recaption to render the reel again.",
           "segments": rows}
    write_json_atomic(os.path.join(workdir, TRANSCRIPT), doc)
    return doc, dict(info, shown=sum(1 for x in rows if x["show"] and not x.get("fontMissing")), segments=len(rows))


# ---------------------------------------------------------------- ASS

def _ass_colour(hex_rgb, alpha=0):
    h = hex_rgb.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def cards(text, max_words, max_chars, max_lines):
    """Text -> caption cards (each a list of lines): at most max_words words per card, lines of at most max_chars
    (a longer single word stays whole; libass wraps it inside the safe margins), at most max_lines lines."""
    words = [w for w in text.split() if w]
    out = []
    for i in range(0, len(words), max(1, int(max_words))):
        lines = caps.wrap(" ".join(words[i:i + int(max_words)]), int(max_chars), int(max_lines))
        out += lines
    return out


def to_ass(transcript, frame, safe, style, duration=None):
    """ASS script of the shown segments that the font can draw. -> (text, cards burned)."""
    w, h = int(frame["width"]), int(frame["height"])
    bold = -1 if style.get("bold") else 0
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Reel,{style['fontFamily']},{int(style['sizePx'])},{_ass_colour(style['textColour'])},"
        f"{_ass_colour(style['textColour'])},{_ass_colour(style['outlineColour'])},{_ass_colour(style['outlineColour'], 0x64)},"
        f"{bold},0,0,0,100,100,0,0,1,{int(style['outlinePx'])},{int(style['shadowPx'])},2,"
        f"{int(safe['left'])},{int(safe['right'])},{int(safe['bottom']) + int(style.get('liftPx', 0))},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    ev, n = [], 0
    for s in transcript.get("segments") or []:
        if not s.get("show") or s.get("fontMissing"):
            continue
        a, b = float(s["start"]), float(s["end"])
        if duration is not None:
            b = min(b, float(duration))
        cs = cards(caps.ass_escape(str(s.get("text", ""))), style["maxWordsPerCard"], style["maxCharsPerLine"],
                   style["maxLines"])
        if b <= a or not cs:
            continue
        weights = [max(1, sum(len(x) for x in c)) for c in cs]
        t = a
        for c, wt in zip(cs, weights):
            d = (b - a) * wt / sum(weights)
            ev.append(f"Dialogue: 0,{caps._ts(t)},{caps._ts(t + d)},Reel,,0,0,0,," +"\\N".join(c))
            t += d
            n += 1
    return "\n".join(head + ev) + "\n", n


def refresh_hidden(transcript, style):
    """Re-checks every segment's text against the font (after an edit the text may have changed)."""
    cps = font_codepoints(os.path.join(FONTS_DIR, style["fontFile"]))
    for s in transcript.get("segments") or []:
        miss = missing_scripts(str(s.get("text", "")), cps)
        if miss:
            s["fontMissing"] = miss
        else:
            s.pop("fontMissing", None)
    return transcript


def write_ass(transcript, frame, safe, style, workdir, duration=None):
    """Writes captions.ass and copies the preset's font into workdir/fonts. -> (ass name, fonts dir name, cards) or
    (None, None, 0) when no card is left to burn."""
    text, n = to_ass(refresh_hidden(transcript, style), frame, safe, style, duration)
    if not n:
        return None, None, 0
    with open(os.path.join(workdir, ASS_NAME), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    fd = os.path.join(workdir, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    shutil.copyfile(os.path.join(FONTS_DIR, style["fontFile"]), os.path.join(fd, style["fontFile"]))
    return ASS_NAME, FONT_SUBDIR, n


def summary(transcript, cards_burned):
    segs = transcript.get("segments") or [] if transcript else []
    return {"segments": len(segs), "shown": sum(1 for s in segs if s.get("show") and not s.get("fontMissing")),
            "lowConfidence": sum(1 for s in segs if not s.get("show")),
            "fontMissing": sorted({x for s in segs for x in s.get("fontMissing") or []}), "cards": cards_burned}
