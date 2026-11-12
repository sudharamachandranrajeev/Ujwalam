# SPDX-License-Identifier: GPL-3.0-or-later
"""RP3 music beds (D363, D370, plan 2026-11-12-reel-polish-music-learning.md): a calm lofi bed at the start and the end
of a reel, synthesised on this PC.

Data: data/clip/music.json. Flag reel-music (off by default). Generator "procedural": plain Python (stdlib only; no
model, no download, own code), so the beds carry no licence limits. Each reel gets its own bed from a seed (its id and
source), always the same for the same reel. The bed is one WAV as long as the reel (silence between the start and the
end bed, fades and level already applied); clip_montage.render_argv(music=) mixes it under the studio mix (track 1)
with a sidechain duck keyed by that mix, so the game sound and speech always stay on top.

  plan(pieces, xd, title_rec, cfg, seed) -> record or None
  synth(rec, cfg, path)                  -> writes the WAV
  prepare(wd, rec, cfg)                  -> the dict render_argv(music=) takes
  cleanup(wd)
"""

from __future__ import annotations

import array
import hashlib
import math
import os
import random
import wave

from clip_common import CLIP_DATA, ClipError, flag_on, load_json
from reel_title import timeline

DEFAULTS_FILE = os.path.join(CLIP_DATA, "music.json")
FLAG = "reel-music"
WAV = "music.wav"
TWO_PI = 2.0 * math.pi


def load_config(path=None):
    cfg = load_json(path or DEFAULTS_FILE)
    if cfg.get("generator") != "procedural":
        raise ClipError("reel-music: only the procedural generator is built")
    if not (40 <= cfg["bpm"]["min"] <= cfg["bpm"]["max"] <= 140):
        raise ClipError("reel-music: bpm range out of bounds")
    if cfg["gainDb"] > -6:
        raise ClipError("reel-music: the bed must stay well under the game sound (gainDb <= -6)")
    for p in cfg["progressions"]:
        for _, q in p["chords"]:
            if q not in cfg["chordTypes"]:
                raise ClipError(f"reel-music: chord type {q} is not defined")
    return cfg


def on(data_dir):
    return flag_on(data_dir, FLAG)


def seed_for(*parts):
    """A stable seed from the reel's id and source (the same reel always gets the same bed)."""
    return int.from_bytes(hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()[:4], "big")


def plan(pieces, xd, title_rec, cfg, seed):
    """-> {seed, total, intro [a, b], outro [a, b] or None, bpm, key, progression} or None (no pieces, reel too short)."""
    if not pieces:
        return None
    _, total = timeline(pieces, xd)
    if total < float(cfg["minReelSec"]):
        return None
    intro_end = float(title_rec["end"]) if title_rec else float(cfg["introSec"])
    intro_end = min(intro_end, total / 2.0)
    outro_start = total - float(cfg["outroSec"])
    outro = [round(outro_start, 3), round(total, 3)] if outro_start >= intro_end + 1.0 else None
    rng = random.Random(seed)
    prog = rng.choice(cfg["progressions"])
    return {"seed": seed, "total": round(total, 3), "intro": [0.0, round(intro_end, 3)], "outro": outro,
            "bpm": rng.randint(int(cfg["bpm"]["min"]), int(cfg["bpm"]["max"])), "key": rng.choice(cfg["keys"]),
            "progression": prog["id"]}


def _hz(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _add(buf, start, samples):
    n = len(buf)
    for i, v in enumerate(samples):
        j = start + i
        if j >= n:
            break
        if j >= 0:
            buf[j] += v


def _segment(seconds, rec, cfg, rng):
    """One bed segment (mono floats), bar-aligned from its own start."""
    sr = int(cfg["sampleRate"])
    n = int(seconds * sr)
    buf = [0.0] * n
    vo = cfg["voices"]
    beat = 60.0 / rec["bpm"]
    bar = 4 * beat
    prog = next(p for p in cfg["progressions"] if p["id"] == rec["progression"])
    key = int(rec["key"])
    bars = int(seconds / bar) + 1
    for b in range(bars):
        t0 = b * bar
        root, q = prog["chords"][b % len(prog["chords"])]
        # electric-piano chord: sine + a soft 2nd harmonic, quick attack, slow decay, a little tremolo
        notes = [key + root + iv for iv in cfg["chordTypes"][q]]
        length = int(min(bar, seconds - t0) * sr)
        for k, m in enumerate(notes):
            f = _hz(m) * (1.0 + rng.uniform(-0.0015, 0.0015))
            off = int((t0 + k * 0.012) * sr)  # a soft strum
            amp = vo["keys"] / len(notes)
            _add(buf, off, [amp * min(1.0, i / (0.015 * sr)) * math.exp(-i / (1.6 * sr))
                            * (1.0 + 0.08 * math.sin(TWO_PI * 4.5 * i / sr))
                            * (math.sin(TWO_PI * f * i / sr) + 0.25 * math.sin(TWO_PI * 2 * f * i / sr))
                            for i in range(max(0, length - k * int(0.012 * sr)))])
        # bass: the chord root two octaves down, on beats 1 and 3
        fb = _hz(key + root - 24)
        for bt in (0, 2):
            s = t0 + bt * beat
            if s >= seconds:
                continue
            ln = int(1.5 * beat * sr)
            _add(buf, int(s * sr), [vo["bass"] * min(1.0, i / (0.01 * sr)) * math.exp(-i / (0.9 * sr))
                                    * math.sin(TWO_PI * fb * i / sr) for i in range(ln)])
        # drums: kick on 1 and 3 (and sometimes the "and" of 3), snare on 2 and 4, swung eighth hats
        kicks = [0, 2] + ([2.5] if rng.random() < 0.4 else [])
        for bt in kicks:
            s = t0 + bt * beat
            if s < seconds:
                ln = int(0.28 * sr)
                ph, out = 0.0, []
                for i in range(ln):
                    f = 45.0 + 75.0 * math.exp(-i / (0.03 * sr))
                    ph += TWO_PI * f / sr
                    out.append(vo["kick"] * math.exp(-i / (0.09 * sr)) * math.sin(ph))
                _add(buf, int(s * sr), out)
        for bt in (1, 3):
            s = t0 + bt * beat
            if s < seconds:
                prev, out = 0.0, []
                for i in range(int(0.18 * sr)):
                    x = rng.uniform(-1.0, 1.0)
                    hp = x - prev  # a crude high-pass: brighter noise
                    prev = x
                    out.append(vo["snare"] * math.exp(-i / (0.045 * sr)) * hp)
                _add(buf, int(s * sr), out)
        for e in range(8):
            s = t0 + (e // 2) * beat + (cfg["swing"] * beat if e % 2 else 0.0)
            if s < seconds:
                prev, out = 0.0, []
                for i in range(int(0.05 * sr)):
                    x = rng.uniform(-1.0, 1.0)
                    out.append(vo["hat"] * (0.6 if e % 2 else 1.0) * math.exp(-i / (0.012 * sr)) * (x - prev))
                    prev = x
                _add(buf, int(s * sr), out)
    # vinyl crackle: sparse clicks
    for _ in range(int(seconds * 9)):
        j = rng.randrange(n) if n else 0
        if n:
            buf[j] += vo["crackle"] * rng.choice((-1.0, 1.0))
    # warm one-pole low-pass
    a = 1.0 - math.exp(-TWO_PI * float(cfg["lowpassHz"]) / sr)
    y = 0.0
    for i in range(n):
        y += a * (buf[i] - y)
        buf[i] = y
    return buf


def _fade(seg, sr, fin_ms, fout_ms):
    n = len(seg)
    fi, fo = int(fin_ms / 1000.0 * sr), int(fout_ms / 1000.0 * sr)
    for i in range(min(fi, n)):
        seg[i] *= i / fi
    for i in range(min(fo, n)):
        seg[n - 1 - i] *= i / fo
    return seg


def _normalise(seg, gain_db):
    peak = max((abs(v) for v in seg), default=0.0)
    g = (10.0 ** (gain_db / 20.0)) / peak if peak > 0 else 0.0
    return [v * g for v in seg]


def synth(rec, cfg, path):
    """Writes the bed as a 16-bit stereo WAV as long as the reel (silence between the beds)."""
    sr = int(cfg["sampleRate"])
    total = int(rec["total"] * sr)
    out = [0.0] * total
    rng = random.Random(rec["seed"])
    a, b = rec["intro"]
    if b > a:
        seg = _fade(_segment(b - a, rec, cfg, rng), sr, cfg["introFadeInMs"], cfg["introFadeOutMs"])
        _add(out, int(a * sr), _normalise(seg, float(cfg["gainDb"])))
    if rec.get("outro"):
        a, b = rec["outro"]
        seg = _fade(_segment(b - a, rec, cfg, rng), sr, cfg["outroFadeInMs"], cfg["outroFadeOutMs"])
        _add(out, int(a * sr), _normalise(seg, float(cfg["gainDb"])))
    pcm = array.array("h", (max(-32767, min(32767, int(v * 32767))) for v in out for _ in (0, 1)))
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def prepare(wd, rec, cfg):
    """Writes wd/music.wav -> the dict clip_montage.render_argv(music=) takes."""
    synth(rec, cfg, os.path.join(wd, WAV))
    return {"file": WAV, "duck": cfg["duck"]}


def cleanup(wd):
    for n in (WAV, WAV + ".part"):
        try:
            os.remove(os.path.join(wd, n))
        except OSError:
            pass
