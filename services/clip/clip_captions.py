# SPDX-License-Identifier: GPL-2.0-or-later
"""F6 captions: transcriber seam (local only) and an ASS writer for burn-in.

Backends (--captions):
  none            no transcription; the clip renders without captions and the report says so (default until a
                  local Whisper is installed).
  whisper-cli     a whisper.cpp command line binary (--whisper-bin, --whisper-model). Runs
                  <bin> -m <model> -f <clip.wav> -oj -of <base> -t 4 and reads <base>.json
                  (transcription[].offsets.from/to in ms, text). UNVERIFIED: no binary or model on the laptop yet.
  faster-whisper  the faster_whisper package, if importable in this interpreter (not installed). UNVERIFIED.
No network and no paid API: every backend runs on local files.

Segments are [{start, end, text}] in seconds from the clip start. The ASS file uses the 1080x1920 frame and keeps
captions inside the intersection of every target's safe zone (data/clip/targets.json).
"""

from __future__ import annotations

import json
import os
import re

from clip_common import ClipError, FFMPEG_THREADS, run_tool

BACKENDS = ("none", "whisper-cli", "faster-whisper")
MAX_CHARS_PER_LINE = 26
MAX_LINES = 2


# ---------------------------------------------------------------- transcription

def extract_wav(ffmpeg, src, start, dur, out_wav):
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", str(FFMPEG_THREADS), "-ss", f"{start:.3f}",
            "-t", f"{dur:.3f}", "-i", src, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            out_wav]
    r = run_tool(argv, timeout=600)
    if r.returncode != 0:
        raise ClipError(f"audio extract failed: {r.stderr.strip()[-200:]}")


def parse_whisper_cpp_json(j):
    out = []
    for seg in j.get("transcription", []) if isinstance(j, dict) else []:
        try:
            a = float(seg["offsets"]["from"]) / 1000.0
            b = float(seg["offsets"]["to"]) / 1000.0
            text = str(seg.get("text", "")).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if text and b > a:
            out.append({"start": a, "end": b, "text": text})
    return out


def transcribe(backend, wav, opts):
    """Returns (segments, info). info.status is 'ok', 'off' or 'unavailable' (with a reason)."""
    if backend == "none":
        return [], {"backend": "none", "status": "off"}
    if backend == "whisper-cli":
        binp, model = opts.get("whisper_bin"), opts.get("whisper_model")
        if not binp or not os.path.isfile(binp) or not model or not os.path.isfile(model):
            return [], {"backend": backend, "status": "unavailable", "reason": "whisper-cli binary or model missing"}
        base = os.path.splitext(wav)[0]
        argv = [binp, "-m", model, "-f", wav, "-oj", "-of", base, "-t", "4"]
        if opts.get("language"):
            argv += ["-l", opts["language"]]
        r = run_tool(argv, timeout=1800)
        if r.returncode != 0 or not os.path.isfile(base + ".json"):
            return [], {"backend": backend, "status": "unavailable", "reason": f"whisper-cli exit {r.returncode}"}
        with open(base + ".json", encoding="utf-8", errors="replace") as f:
            segs = parse_whisper_cpp_json(json.load(f))
        return segs, {"backend": backend, "status": "ok", "segments": len(segs)}
    if backend == "faster-whisper":
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415 (optional, not installed)
        except ImportError:
            return [], {"backend": backend, "status": "unavailable", "reason": "faster_whisper not installed"}
        model = opts.get("whisper_model")
        if not model:
            return [], {"backend": backend, "status": "unavailable", "reason": "no --whisper-model (local path)"}
        m = WhisperModel(model, device=opts.get("device", "cpu"), compute_type=opts.get("compute_type", "int8"),
                         cpu_threads=4, local_files_only=True)
        segs, _ = m.transcribe(wav, language=opts.get("language"))
        out = [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()} for s in segs if s.text.strip()]
        return out, {"backend": backend, "status": "ok", "segments": len(out)}
    raise ClipError(f"unknown captions backend {backend}")


# ---------------------------------------------------------------- ASS

def safe_area(targets):
    """Intersection of every target's safe zone (largest margin on each side)."""
    m = {"top": 0, "bottom": 0, "left": 0, "right": 0}
    for t in targets.get("targets", []):
        for k in m:
            m[k] = max(m[k], int(t.get("safe", {}).get(k, 0)))
    return m


def wrap(text, width=MAX_CHARS_PER_LINE, max_lines=MAX_LINES):
    """Greedy word wrap; text beyond max_lines becomes further chunks (each chunk is one caption card)."""
    words = re.sub(r"\s+", " ", text).strip().split(" ")
    lines, cur = [], ""
    for w in words:
        if not w:
            continue
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        lines.append(cur)
    return [lines[i:i + max_lines] for i in range(0, len(lines), max_lines)] or []


def ass_escape(text):
    # Captions are speech-to-text output: neutralise ASS override blocks and hard breaks.
    return text.replace("\\", "⧵").replace("{", "(").replace("}", ")").replace("\n", " ")


def _ts(sec):
    sec = max(0.0, sec)
    cs = int(round(sec * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def to_ass(segments, frame, safe, font="Arial", size=64, duration=None):
    """ASS script (1080x1920 PlayRes). Bottom-centre style; MarginV = bottom safe margin; L/R margins = safe sides."""
    w, h = int(frame["width"]), int(frame["height"])
    head = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {w}",
        f"PlayResY: {h}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Cap,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,2,2,"
        f"{safe['left']},{safe['right']},{safe['bottom']},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    ev = []
    for s in segments:
        a, b = float(s["start"]), float(s["end"])
        if duration is not None:
            b = min(b, duration)
        if b <= a:
            continue
        chunks = wrap(ass_escape(s["text"]))
        if not chunks:
            continue
        step = (b - a) / len(chunks)
        for i, ch in enumerate(chunks):
            body = "\\N".join(ch)
            ev.append(f"Dialogue: 0,{_ts(a + i * step)},{_ts(a + (i + 1) * step)},Cap,,0,0,0,,{body}")
    return "\n".join(head + ev) + "\n"
