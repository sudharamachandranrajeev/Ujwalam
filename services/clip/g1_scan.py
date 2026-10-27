# SPDX-License-Identifier: GPL-2.0-or-later
"""G1 corpus check of the CODM game-event detectors (P2a step A5).

Read-only on the clips corpus: clips are only opened as ffmpeg inputs. Every output
path inside the corpus is refused. OCR output holds other players' names and the
streamer's IGN, so --out must be gitignored (docs/evidence/private/...) or outside
the repository; the tool refuses a tracked or un-ignored folder inside the repo.

Needs the OCR venv (numpy, opencv-python-headless, rapidocr, onnxruntime; lock:
services/clip/requirements-ocr.lock.txt). CPU only.

Subcommands
  frames     one PNG per sampled clip (layout check, visual mode check)
             --index --corpus --out [--sessions a,b] [--per-session N] [--at SEC] [--seed]
  calibrate  find the game area inside the vertical cutout from two HUD landmarks
             --frames GLOB --ref-frame PNG --ref-game x,y,w,h --out layout.json
  scan       full-visible-area OCR on sampled frames; one JSON line per frame
             clips:  --index --corpus --layout L --out DIR [--sessions] [--clips-per-session N]
                     [--fps F] [--seed] [--diff-gate D]
             images: --images GLOB --layout L --out DIR
  analyse    per-detector instances, ROI fit, name match, mode share from scan output
             --scan FILE.jsonl [...] --pack detectors.json --profile profile.json --out DIR
  refmedals  cut crops of reference-class medals (M3) into the reference dataset
             --hits hits.jsonl --layout L --pack [--corpus | --images-dir] [--dataset DIR] [--per-medal N]
  crops      cut ROI crops at the hit times, time per-crop OCR, compare with the proxy
             --hits hits.jsonl --corpus --layout L --pack --out DIR
             [--cache CACHE_ROOT --index INDEX] [--per-detector N]

Global option (before the subcommand): --threads N caps onnxruntime OCR threads (default 4,
inter-op 1). ffmpeg decodes with 2 threads; the tool and its ffmpeg children run at
below-normal priority on Windows.

Mode tagging: analyse takes --mode-tags FILE.json ({"<session>": "dmz", "<session>/<clip>": "dmz"}).
DMZ footage is tagged only: no detector runs on it and it stays out of MP/BR tuning and test sets.
FINAL KILLCAM (K1) is a signal only when the profile name is shown as the killer; both cases are logged.

Names are read from the profile (games.<key>.ign + variants) and are never written to
summary files; summaries carry only scores and the matched variant's index.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import g1_geometry as geo  # noqa: E402
import g1_text as gt  # noqa: E402

TOOL_VERSION = 1

# ---------------------------------------------------------------- safety


def _real(p):
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def refuse_inside(path, root, what):
    if root and (_real(path) + os.sep).startswith(_real(root) + os.sep):
        sys.exit(f"refusing to write inside the {what}: {path}")


def repo_root():
    return os.path.normpath(os.path.join(_HERE, "..", ".."))


def check_private_out(path, corpus=None):
    """--out must not be in the corpus, and inside the repo it must be gitignored."""
    refuse_inside(path, corpus, "corpus")
    root = repo_root()
    if (_real(path) + os.sep).startswith(_real(root) + os.sep):
        probe = os.path.join(path, "probe.txt")
        r = subprocess.run(["git", "-C", root, "check-ignore", "-q", probe], capture_output=True)
        if r.returncode != 0:
            sys.exit(f"refusing: {path} is inside the repository and not gitignored (OCR text holds names)")


def load_names(profile_path, key):
    with open(profile_path, encoding="utf-8") as f:
        p = json.load(f)
    g = p["games"][key]
    names = [g["ign"]] + list(g.get("variants") or [])
    return names, g.get("clan_tag")


# ---------------------------------------------------------------- resources

# Laptop budget (user instruction 2026-10-27): OCR capped at --threads onnxruntime threads
# (default 4, inter-op 1), ffmpeg decode at 2 threads, process and ffmpeg children at
# below-normal priority on Windows. Run one scan/analyse process at a time.
DEFAULT_THREADS = 4
FFMPEG_THREADS = 2


def thread_params(n):
    """RapidOCR params that cap onnxruntime at n intra-op threads and 1 inter-op thread."""
    return {"EngineConfig.onnxruntime.intra_op_num_threads": int(n),
            "EngineConfig.onnxruntime.inter_op_num_threads": 1}


def ffmpeg_base():
    return ["ffmpeg", "-v", "error", "-nostdin", "-threads", str(FFMPEG_THREADS)]


def child_kwargs():
    """Popen kwargs: below-normal priority for ffmpeg children on Windows."""
    if os.name == "nt":
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS}
    return {}


def lower_own_priority():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wintypes.HANDLE  # pseudo-handle; default c_int truncates it
        k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.SetPriorityClass(k.GetCurrentProcess(), subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        try:
            os.nice(10)
        except OSError:
            pass


# ---------------------------------------------------------------- media

def _need_cv():
    import cv2  # noqa: F401
    import numpy  # noqa: F401


def probe_size(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    w, h = out.stdout.strip().split(",")[:2]
    return int(w), int(h)


def bucket_select(fps):
    """ffmpeg select filter: first frame of each 1/fps bucket.

    t is clamped at 0: some MP4s decode their first frame at t = -0.0000002 (start-time
    rounding), which otherwise forms its own bucket -1 and shifts every later frame index
    by one, i.e. scan times 1 s late at 1 fps."""
    return (f"select='isnan(prev_selected_t)+gt(floor(max(t,0)*{fps}),"
            f"floor(max(prev_selected_t,0)*{fps}))'")


def decode_frames(path, fps, crop=None, start=None, dur=None, hwaccel=None, max_frames=None):
    """Yield (t_sec, bgr ndarray) from ffmpeg at `fps`, optionally cropped (x0,y0,x1,y1)."""
    import numpy as np
    w, h = probe_size(path)
    # First frame of each 1/fps bucket, so frame i is at clip time i/fps (within one source
    # frame). The fps filter is not used: with its default rounding, frame i shows the
    # source at about (i + 0.5)/fps, which put crops 1 s off the scanned frame at 0.5 fps.
    vf = [bucket_select(fps)]
    if crop:
        x0, y0, x1, y1 = crop
        vf.append(f"crop={x1 - x0}:{y1 - y0}:{x0}:{y0}")
        w, h = x1 - x0, y1 - y0
    cmd = ffmpeg_base()
    if hwaccel:
        cmd += ["-hwaccel", hwaccel]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    if max_frames is not None:
        cmd += ["-frames:v", str(max_frames)]
    cmd += ["-an", "-vf", ",".join(vf), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, **child_kwargs())
    n = w * h * 3
    i = 0
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            yield (start or 0.0) + i / fps, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        p.stdout.close()
        p.wait()


def grab_frame(path, t, hwaccel=None):
    """One full frame at clip time t (accurate seek)."""
    for _, fr in decode_frames(path, 60, start=t, dur=1 / 60 + 1e-3, hwaccel=hwaccel, max_frames=1):
        return fr
    return None


# ---------------------------------------------------------------- OCR

_ENGINE = None
OCR_PARAMS = {"Global.log_level": "error"}
# Crop profile: RapidOCR's default detector input rule (limit_type "min", 736) upscales a
# small ROI crop until its short side is 736 px, which makes crop OCR slow. For ROI crops
# the side limit is applied as a maximum instead, and the angle classifier is off (HUD
# text is never rotated). Measured in the G1 evidence (bench).
CROP_PROFILE = {"Det.limit_type": "max", "Det.limit_side_len": 960, "Global.use_cls": False}


def set_ocr_params(extra):
    global _ENGINE
    OCR_PARAMS.update(extra or {})
    _ENGINE = None


def engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr import RapidOCR
        _ENGINE = RapidOCR(params=dict(OCR_PARAMS))
    return _ENGINE


def ocr(img):
    """RapidOCR on a BGR image -> (boxes, ms). Box: text, score, x0, y0, x1, y1 (image px)."""
    t0 = time.perf_counter()
    r = engine()(img)
    ms = (time.perf_counter() - t0) * 1000
    boxes = []
    if r.boxes is not None and r.txts:
        for poly, txt, sc in zip(r.boxes, r.txts, r.scores):
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            boxes.append({"text": txt, "score": round(float(sc), 4),
                          "x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)})
    return boxes, round(ms, 1)


def yellow_fraction(img):
    """Share of pixels in the HUD yellow range (HSV hue 18-38 of 180, S>=110, V>=170)."""
    import cv2
    import numpy as np
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m = (hsv[..., 0] >= 18) & (hsv[..., 0] <= 38) & (hsv[..., 1] >= 110) & (hsv[..., 2] >= 170)
    return float(np.count_nonzero(m)) / m.size


# ---------------------------------------------------------------- layout

def load_layout(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def full_screen_layout(w, h, game):
    gx, gy, gw, gh = game
    return {"frame": [w, h], "game": [gx, gy, gw, gh], "visible": [gx, gy, gx + gw, gy + gh]}


# ---------------------------------------------------------------- sampling

def load_index(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pick_clips(index, sessions, per_session, seed):
    rng = random.Random(seed)
    out = []
    for s in index["sessions"]:
        if sessions and s["id"] not in sessions:
            continue
        clips = [c["file"] for c in s["clips"]]
        k = min(per_session, len(clips))
        # stratified: one random clip from each of k equal slices of the session
        for j in range(k):
            lo, hi = j * len(clips) // k, max(j * len(clips) // k + 1, (j + 1) * len(clips) // k)
            out.append((s["id"], clips[rng.randrange(lo, hi)]))
    return out


def cmd_frames(a):
    import cv2
    check_private_out(a.out, a.corpus)
    os.makedirs(a.out, exist_ok=True)
    idx = load_index(a.index)
    sessions = set(a.sessions.split(",")) if a.sessions else None
    picks = pick_clips(idx, sessions, a.per_session, a.seed)
    rows = []
    for sid, clip in picks:
        fr = grab_frame(os.path.join(a.corpus, clip), a.at)
        if fr is None:
            continue
        name = f"{sid}__{os.path.splitext(clip)[0][-20:].replace('.', '-')}.png"
        if a.scale != 1.0:
            fr = cv2.resize(fr, None, fx=a.scale, fy=a.scale, interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(a.out, name), fr)
        rows.append({"session": sid, "clip": clip, "t": a.at, "png": name})
    with open(os.path.join(a.out, "frames.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1)
    print(f"frames {len(rows)} -> {a.out}")


# ---------------------------------------------------------------- calibrate

# Landmarks in the 1920x1080 MP reference frame (g1-live), pixel boxes: the
# "MEDIUM" word of the "GRAPHIC QUALITY: MEDIUM" label (both modes) and the MP "HP" label.
DEFAULT_LANDMARKS = {"medium": [420, 1050, 506, 1075], "hp": [919, 1039, 953, 1060]}


def _border_rows(gray, lo, hi):
    import cv2
    import numpy as np
    gy = np.abs(cv2.Sobel(gray.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3))
    prof = gy[:, 120:960].mean(axis=1)
    return int(lo + np.argmax(prof[lo:hi]))


def cmd_calibrate(a):
    import cv2
    import numpy as np
    ref = cv2.imread(a.ref_frame, cv2.IMREAD_GRAYSCALE)
    ref_game = [float(v) for v in a.ref_game.split(",")]
    lms = json.loads(a.landmarks) if a.landmarks else DEFAULT_LANDMARKS
    tmpl = {k: ref[b[1]:b[3], b[0]:b[2]] for k, b in lms.items()}
    centre = {k: ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for k, b in lms.items()}
    scales = np.arange(a.scale_min, a.scale_max + 1e-9, a.scale_step)
    per = []
    for f in sorted(glob.glob(a.frames)):
        g = cv2.imread(f, cv2.IMREAD_GRAYSCALE)
        top = _border_rows(g, 380, 540)
        bot = _border_rows(g, 1300, 1480)
        band = g[bot - 90:bot + 10]
        best = None
        for s in scales:
            res = {}
            for k, t in tmpl.items():
                ts = cv2.resize(t, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
                m = cv2.matchTemplate(band, ts, cv2.TM_CCOEFF_NORMED)
                _, mx, _, loc = cv2.minMaxLoc(m)
                res[k] = (mx, (loc[0] + ts.shape[1] / 2, bot - 90 + loc[1] + ts.shape[0] / 2))
            score = sum(v[0] for v in res.values())
            if best is None or score > best[0]:
                best = (score, float(s), res)
        score, s, res = best
        row = {"frame": os.path.basename(f), "cutTop": top, "cutBottom": bot, "scale": round(s, 4),
               "scores": {k: round(v[0], 3) for k, v in res.items()},
               "points": {k: [round(v[1][0], 1), round(v[1][1], 1)] for k, v in res.items()}}
        if all(v[0] >= a.min_score for v in res.values()):
            ka, kb = list(lms)[:2]
            gbox = geo.game_from_landmarks(centre[ka], res[ka][1], centre[kb], res[kb][1], ref_game)
            row["game"] = [round(v, 2) for v in gbox]
        per.append(row)
    good = [r for r in per if "game" in r]
    out = {"tool": "g1_scan.calibrate", "toolVersion": TOOL_VERSION, "frames": len(per), "used": len(good),
           "perFrame": per}
    if good:
        med = [statistics.median(r["game"][i] for r in good) for i in range(4)]
        spread = [round(max(r["game"][i] for r in good) - min(r["game"][i] for r in good), 2) for i in range(4)]
        tops = [r["cutTop"] for r in per]
        bots = [r["cutBottom"] for r in per]
        w, h = (int(v) for v in a.frame_size.split("x"))
        # the cutout border is the most common edge row; content edges scatter around it
        top, bot = statistics.mode(tops), statistics.mode(bots)
        out["layout"] = {"frame": [w, h], "game": [round(v, 2) for v in med],
                         "visible": [0, top + a.inset, w, bot - a.inset]}
        out["spread"] = {"game": spread, "cutTopModeShare": round(tops.count(top) / len(tops), 3),
                         "cutBottomModeShare": round(bots.count(bot) / len(bots), 3)}
        out["usedSessions"] = sorted({r["frame"].split("__")[0] for r in good})
        out["visibleGame"] = geo.visible_game_fraction(out["layout"])
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(json.dumps({k: out.get(k) for k in ("frames", "used", "layout", "spread", "visibleGame")}))


# ---------------------------------------------------------------- scan

def _frame_record(boxes, layout, origin):
    gx, gy, gw, gh = layout["game"]
    ox, oy = origin
    out = []
    for b in boxes:
        out.append({"text": b["text"], "score": b["score"],
                    "g": [round((b["x0"] + ox - gx) / gw, 4), round((b["y0"] + oy - gy) / gh, 4),
                          round((b["x1"] + ox - gx) / gw, 4), round((b["y1"] + oy - gy) / gh, 4)]})
    return out


def _thumb(img, path, width=270):
    import cv2
    s = width / img.shape[1]
    cv2.imwrite(path, cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA))


def cmd_scan(a):
    import cv2
    import numpy as np
    check_private_out(a.out, a.corpus)
    os.makedirs(a.out, exist_ok=True)
    thumbs = os.path.join(a.out, "thumbs")
    os.makedirs(thumbs, exist_ok=True)
    layout = load_layout(a.layout) if a.layout else None
    if layout and "layout" in layout:
        layout = layout["layout"]
    outp = os.path.join(a.out, a.name + ".jsonl")
    done = set()
    if os.path.exists(outp) and not a.force:
        with open(outp, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                done.add((r.get("clip") or r.get("image"), r["t"]))
    fo = open(outp, "a", encoding="utf-8")
    n_ocr = n_skip = 0
    t_start = time.time()

    def handle(meta, t, img, origin):
        nonlocal n_ocr, n_skip, last
        small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), None, fx=0.25, fy=0.25,
                           interpolation=cv2.INTER_AREA).astype(np.int16)
        diff = None if last is None else float(np.abs(small - last).mean())
        rec = dict(meta, t=round(t, 3), diff=None if diff is None else round(diff, 2),
                   yellow=round(yellow_fraction(img), 5))
        if diff is not None and diff < a.diff_gate:
            rec["skipped"] = "diff-gate"
            n_skip += 1
        else:
            boxes, ms = ocr(img)
            rec["ocrMs"] = ms
            rec["boxes"] = _frame_record(boxes, layout, origin)
            last = small
            n_ocr += 1
        fo.write(json.dumps(rec, ensure_ascii=False) + "\n")

    if a.images:
        for f in sorted(glob.glob(a.images)):
            last = None
            if (os.path.basename(f), 0.0) in done:
                continue
            img = cv2.imread(f)
            lay = layout or full_screen_layout(img.shape[1], img.shape[0], [0, 0, img.shape[1], img.shape[0]])
            layout = lay
            v = [int(round(c)) for c in lay["visible"]]
            handle({"src": "image", "image": os.path.basename(f), "session": a.session_label}, 0.0,
                   img[v[1]:v[3], v[0]:v[2]], (v[0], v[1]))
            fo.flush()
    else:
        idx = load_index(a.index)
        sessions = set(a.sessions.split(",")) if a.sessions else None
        picks = pick_clips(idx, sessions, a.clips_per_session, a.seed)
        v = [int(round(c)) for c in layout["visible"]]
        v = [v[0] - v[0] % 2, v[1] - v[1] % 2, v[2] - v[2] % 2, v[3] - v[3] % 2]
        for i, (sid, clip) in enumerate(picks):
            last = None
            path = os.path.join(a.corpus, clip)
            mid = None
            for t, img in decode_frames(path, a.fps, crop=v, hwaccel=a.hwaccel):
                if (clip, round(t, 3)) in done:
                    continue
                handle({"src": "clip", "session": sid, "clip": clip}, t, img, (v[0], v[1]))
                if mid is None and t >= 14.0:
                    mid = img
            if mid is not None:
                _thumb(mid, os.path.join(thumbs, f"{sid}__{os.path.splitext(clip)[0][-20:].replace('.', '-')}.png"))
            fo.flush()
            el = time.time() - t_start
            print(f"[{i + 1}/{len(picks)}] {sid} ocr {n_ocr} skip {n_skip} {el:.0f}s", flush=True)
    fo.close()
    print(f"scan done: ocr {n_ocr}, diff-gate skips {n_skip}, {time.time() - t_start:.0f}s -> {outp}")


# ---------------------------------------------------------------- analyse

MODE_CUES = {
    "mp": ["POINTS TO WIN", "KILLS TO WIN", "NORMAL KILL", "WINNING", "LOSING", "ROUND", "FIRST BLOOD",
           "KILLCAM", "HARDPOINT", "DOMINATION", "SEARCH AND DESTROY", "TEAM DEATHMATCH", "FREE FOR ALL",
           "SCORESTREAK", "UAV ONLINE"],
    "br": ["KILL(S)", "SAFE ZONE", "ELIMINATED", "KNOCKED DOWN", "ARMOR", "REVIVAL", "AIRDROP", "ALIVE",
           "HELP ME", "DOWNED BY YOU", "ZONE", "SQUAD", "BACKPACK", "LOOT", "PARACHUTE", "REDEPLOY"],
}


# DMZ has no detectors and no auto-classification (no DMZ capture verified): it comes only from --mode-tags.
TAG_ONLY_MODES = ("dmz",)


def _cue_hits(texts, cues):
    n = 0
    for c in cues:
        cn = gt.normalise(c)
        if any(cn in t for t in texts):
            n += 1
    return n


def classify_frame(boxes):
    texts = [gt.normalise(b["text"]) for b in boxes]
    mp = _cue_hits(texts, MODE_CUES["mp"])
    br = _cue_hits(texts, MODE_CUES["br"])
    if mp > br:
        return "mp"
    if br > mp:
        return "br"
    return None


def _in_roi(g, roi, slack=0.0):
    cx, cy = (g[0] + g[2]) / 2, (g[1] + g[3]) / 2
    return (roi["x0"] - slack <= cx <= roi["x1"] + slack) and (roi["y0"] - slack <= cy <= roi["y1"] + slack)


def medal_classes(pack):
    """{medal text: class} from the M3 entry; entries without a class count as positive."""
    for d in pack["detectors"]:
        if d["id"] == "M3":
            return {m["text"]: m.get("class", "positive") for m in d.get("medals", [])}
    return {}


def find_events(boxes, pack, names, name_min):
    """All detector events in one frame's OCR boxes. Returns list of dicts (texts included)."""
    det = {d["id"]: d for d in pack["detectors"]}
    ev = []
    classes = medal_classes(pack)
    name_boxes = []
    for b in boxes:
        ns = gt.name_score(b["text"], names)
        b["_name"] = ns
        if ns["score"] >= name_min:
            name_boxes.append(b)
    has_name = bool(name_boxes)
    norm = [(b, gt.normalise(b["text"])) for b in boxes]
    for b, t in norm:
        if not t:
            continue
        if t == "MVP" or (len(t) <= 5 and gt.ratio("MVP", t) >= 0.67 and t.startswith("MV")):
            ev.append({"det": "M1", "box": b, "nameOnFrame": has_name})
        if gt.partial_ratio("IMPACTPLAY", t) >= 0.8:
            ev.append({"det": "M2", "box": b, "nameOnFrame": has_name})
        m = gt.match_medal(b["text"], [x["text"] for x in det["M3"]["medals"]], det["M3"].get("ignoreTexts", []))
        if m and m.get("medal"):  # ignored texts (Normal Kill) come back with medal None
            ev.append({"det": "M3", "box": b, "medal": m, "medalClass": classes.get(m["medal"], "positive")})
        p = gt.parse_points(b["text"])
        if p is not None:
            ev.append({"det": "M4", "box": b, "points": p})
        if re.search(r"\d+X?MU[LI]TI-?KI[LI]{2}", t) or "KILLSTREAK" in t:
            ev.append({"det": "X1", "box": b, "nameOnFrame": has_name})
        # the HUD renders these in capitals; lower-case "eliminated." is quick-chat text
        # "N KILL(S)" is not used: on the corpus it sat under another player's banner.
        raw = b["text"].strip()
        if raw == raw.upper() and (gt.partial_ratio("ELIMINATED", t) >= 0.8
                                   or gt.partial_ratio("KNOCKEDDOWN", t) >= 0.8):
            ev.append({"det": "B2", "box": b})
        if gt.partial_ratio("FINALKILLCAM", t) >= 0.85:
            # match-ending kill replay: never an N1 death. Signal only with the name as killer.
            ev.append(_k1_event(b, det, name_boxes))
        elif gt.partial_ratio("KILLCAM", t) >= 0.86:
            ev.append({"det": "N1", "box": b})
        if gt.partial_ratio("HELPME", t) >= 0.84 or gt.partial_ratio("WAITINGFORREVIVALFLIGHT", t) >= 0.8:
            ev.append({"det": "N2", "box": b})
    for b in name_boxes:
        ev.append({"det": "NAME", "box": b})
    # kill feeds: boxes whose centre lies in the (slightly widened) feed ROI, grouped into lines
    for kid in ("M5", "B1"):
        if kid not in det:
            continue
        roi = det[kid]["rois"][0]
        # minTextHeight drops smaller HUD text in the same band (BR squad list beside the feed)
        min_h = roi.get("minTextHeight", 0.0)
        cand = [dict(b, x0=b["g"][0], y0=b["g"][1], x1=b["g"][2], y1=b["g"][3])
                for b in boxes if _in_roi(b["g"], roi, slack=KILLFEED_SLACK) and gt.normalise(b["text"])
                and b["g"][3] - b["g"][1] >= min_h]
        for line in gt.group_lines(cand):
            side, sc = gt.killfeed_side(line, names, name_min)
            g = [min(b["x0"] for b in line), min(b["y0"] for b in line),
                 max(b["x1"] for b in line), max(b["y1"] for b in line)]
            lb = {"text": " | ".join(b["text"] for b in line), "score": min(b["score"] for b in line), "g": g,
                  "_name": {"score": round(sc, 4)}}
            ev.append({"det": kid, "box": lb, "side": side, "parts": len(line)})
    return ev


KILLFEED_SLACK = 0.03


def _k1_event(label_box, det, name_boxes):
    """FINAL KILLCAM: signal true only when a profile-name box sits in the K1 ROIs (killer name).

    Both outcomes are returned as events so they get logged (evidence for tuning)."""
    rois = det["K1"]["rois"] if "K1" in det else []
    best = None
    for nb in name_boxes:
        if any(_in_roi(nb["g"], r, slack=0.02) for r in rois) or nb is label_box:
            sc = nb["_name"]["score"]
            if best is None or sc > best["_name"]["score"]:
                best = nb
    return {"det": "K1", "box": label_box, "nameMatched": best is not None, "signal": best is not None,
            "nameScore": best["_name"]["score"] if best is not None else None}


def clip_mode(c):
    """Clip-level mode from per-frame mode counts."""
    if c.get("dmz", 0) and c["dmz"] >= max(c["mp"], c["br"]):
        return "dmz"
    return "mp" if c["mp"] > c["br"] else "br" if c["br"] > c["mp"] else "none"


def tagged_mode(tags, session, key):
    """Manual mode tag for a clip (session/clip first, then session); None when untagged."""
    if not tags:
        return None
    return tags.get(f"{session}/{key}") or tags.get(session)


def cmd_analyse(a):
    with open(a.pack, encoding="utf-8") as f:
        pack = json.load(f)
    tags = None
    if a.mode_tags:
        with open(a.mode_tags, encoding="utf-8") as f:
            tags = json.load(f)
        bad = {v for v in tags.values() if v not in ("mp", "br", "dmz")}
        if bad:
            sys.exit(f"--mode-tags: unknown mode(s) {sorted(bad)}")
    names, _clan = load_names(a.profile, pack["nameMatch"]["profileKey"])
    check_private_out(a.out)
    os.makedirs(a.out, exist_ok=True)
    det = {d["id"]: d for d in pack["detectors"]}
    frames = []
    for path in a.scan:
        with open(path, encoding="utf-8") as f:
            frames += [json.loads(line) for line in f]
    hits = open(os.path.join(a.out, "hits.jsonl"), "w", encoding="utf-8")
    per_det = {}
    loc = {}
    clip_modes = {}
    frame_modes = {"mp": 0, "br": 0, "dmz": 0, None: 0}
    ocr_ms = []
    yellow = {"withMedalText": [], "withoutMedalText": []}
    sessions_seen = set()
    for fr in frames:
        if "boxes" not in fr:
            continue
        ocr_ms.append(fr["ocrMs"])
        key = fr.get("clip") or fr.get("image")
        sessions_seen.add(fr.get("session"))
        mode = tagged_mode(tags, fr.get("session"), key) or classify_frame(fr["boxes"])
        frame_modes[mode] += 1
        cm = clip_modes.setdefault((fr.get("session"), key), {"mp": 0, "br": 0, "dmz": 0, "none": 0})
        cm[mode or "none"] += 1
        if mode in TAG_ONLY_MODES:
            continue  # tag-only mode: no detectors, excluded from tuning and test sets
        evs = find_events(fr["boxes"], pack, names, a.name_min)
        has_medal = any(e["det"] in ("M3", "M4") for e in evs)
        yellow["withMedalText" if has_medal else "withoutMedalText"].append(fr["yellow"])
        for e in evs:
            b = e["box"]
            d = e["det"]
            s = per_det.setdefault(d, {"boxes": 0, "frames": set(), "clips": set(), "sessions": set(),
                                        "ocrScore": [], "modes": {"mp": 0, "br": 0, "dmz": 0, "none": 0}})
            s["boxes"] += 1
            s["frames"].add((key, fr["t"]))
            s["clips"].add(key)
            s["sessions"].add(fr.get("session"))
            s["ocrScore"].append(b["score"])
            s["modes"][mode or "none"] += 1
            for k in ("side", "nameOnFrame"):
                if k in e:
                    c = s.setdefault(k, {})
                    c[str(e[k])] = c.get(str(e[k]), 0) + 1
            loc.setdefault(d, []).append(b["g"])
            row = {"det": d, "session": fr.get("session"), "src": fr["src"], "clip": fr.get("clip"),
                   "image": fr.get("image"), "t": fr["t"], "g": b["g"], "text": b["text"],
                   "score": b["score"], "frameMode": mode, "name": b.get("_name")}
            for k in ("medal", "medalClass", "points", "nameOnFrame", "side", "parts", "nameMatched", "signal", "nameScore"):
                if k in e:
                    row[k] = e[k]
            hits.write(json.dumps(row, ensure_ascii=False) + "\n")
    hits.close()

    def roi_fit(d, boxes):
        rois = det[d]["rois"] if d in det else []
        res = []
        for r in rois:
            inside = sum(1 for g in boxes if _in_roi(g, r))
            res.append({"roi": r["id"], "mode": r.get("mode"), "centresInside": inside})
        return res

    def extent(boxes):
        if not boxes:
            return None
        q = lambda i, p: round(sorted(g[i] for g in boxes)[min(len(boxes) - 1, int(p * (len(boxes) - 1)))], 3)
        return {"x0": {"min": round(min(g[0] for g in boxes), 3), "p05": q(0, 0.05)},
                "y0": {"min": round(min(g[1] for g in boxes), 3), "p05": q(1, 0.05)},
                "x1": {"max": round(max(g[2] for g in boxes), 3), "p95": q(2, 0.95)},
                "y1": {"max": round(max(g[3] for g in boxes), 3), "p95": q(3, 0.95)}}

    summary = {"tool": "g1_scan.analyse", "toolVersion": TOOL_VERSION, "framesOcr": len(ocr_ms),
               "framesTotal": len(frames), "sessions": sorted(s for s in sessions_seen if s),
               "ocrMsPerFrame": {"median": statistics.median(ocr_ms) if ocr_ms else None,
                                 "p95": sorted(ocr_ms)[int(0.95 * (len(ocr_ms) - 1))] if ocr_ms else None},
               "nameMin": a.name_min, "detectors": {}}
    for d, s in sorted(per_det.items()):
        boxes = loc[d]
        summary["detectors"][d] = {
            "boxes": s["boxes"], "frames": len(s["frames"]), "clips": len(s["clips"]),
            "sessions": len(s["sessions"]), "modes": s["modes"],
            "ocrScoreMedian": round(statistics.median(s["ocrScore"]), 4),
            "side": s.get("side"), "nameOnFrame": s.get("nameOnFrame"),
            "extent": extent(boxes), "roiFit": roi_fit(d, boxes)}
    # clip-level mode
    cm_count = {"mp": 0, "br": 0, "dmz": 0, "none": 0}
    per_session = {}
    for (sid, _k), c in clip_modes.items():
        m = clip_mode(c)
        cm_count[m] += 1
        ps = per_session.setdefault(sid, {"mp": 0, "br": 0, "dmz": 0, "none": 0})
        ps[m] += 1
    summary["modeShare"] = {"frames": {k or "none": v for k, v in frame_modes.items()}, "clips": cm_count,
                            "perSession": per_session}
    ys = yellow
    summary["yellowGate"] = {k: {"n": len(v), "median": round(statistics.median(v), 5) if v else None}
                             for k, v in ys.items()}
    for thr in (0.0005, 0.001, 0.002, 0.004):
        w = ys["withMedalText"]
        wo = ys["withoutMedalText"]
        summary["yellowGate"][f"thr{thr}"] = {
            "recallOnMedalFrames": round(sum(1 for v in w if v >= thr) / len(w), 3) if w else None,
            "passRateOtherFrames": round(sum(1 for v in wo if v >= thr) / len(wo), 3) if wo else None}
    with open(os.path.join(a.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    with open(os.path.join(a.out, "clip-modes.json"), "w", encoding="utf-8") as f:
        json.dump([{"session": k[0], "clip": k[1], **v} for k, v in clip_modes.items()], f, indent=1)
    print(json.dumps({k: summary[k] for k in ("framesOcr", "framesTotal", "modeShare")})[:2000])
    for d, s in summary["detectors"].items():
        print(d, s["boxes"], s["frames"], s["clips"], s["sessions"], s["modes"], ascii(s["roiFit"]))


# ---------------------------------------------------------------- crops

def _cache_time(manifest, clip, t):
    for seg in manifest["segments"]:
        if seg["clip"] == clip and seg["clipInSec"] - 1e-6 <= t <= seg["clipOutSec"] + 1e-6:
            return seg["sessionStartSec"] + (t - seg["clipInSec"])
    return None


def cmd_crops(a):
    import cv2
    with open(a.pack, encoding="utf-8") as f:
        pack = json.load(f)
    check_private_out(a.out, a.corpus)
    os.makedirs(a.out, exist_ok=True)
    det = {d["id"]: d for d in pack["detectors"]}
    layout = load_layout(a.layout)
    layout = layout.get("layout", layout)
    if a.profile_ocr == "crop":
        set_ocr_params(CROP_PROFILE)
    rows = [json.loads(line) for line in open(a.hits, encoding="utf-8")]
    rows = [r for r in rows if r["src"] == a.src and r["det"] in det]
    if a.dets:
        keep = set(a.dets.split(","))
        rows = [r for r in rows if r["det"] in keep]
    rng = random.Random(a.seed)
    byd = {}
    for r in rows:
        byd.setdefault(r["det"], {}).setdefault((r.get("clip") or r.get("image"), r["t"]), r)
    manifests = {}
    out_rows = []
    for d, events in sorted(byd.items()):
        keys = sorted(events)
        rng.shuffle(keys)
        for key in keys[:a.per_detector]:
            r = events[key]
            if a.src == "clip":
                frame = grab_frame(os.path.join(a.corpus, r["clip"]), r["t"])
            else:
                frame = cv2.imread(os.path.join(a.images_dir, r["image"]))
            if frame is None:
                continue
            lay = layout
            for roi in det[d]["rois"]:
                if roi.get("mode") and r.get("frameMode") and roi["mode"] != r["frameMode"]:
                    continue
                box = geo.roi_crop_px(roi, lay)
                if box is None:
                    continue
                crop = frame[box[1]:box[3], box[0]:box[2]]
                tag = f"{d}-{roi['id']}-{len(out_rows):04d}"
                cv2.imwrite(os.path.join(a.out, tag + ".png"), crop)
                ocr(crop)  # warm-up per size is not needed; time the second call
                boxes, ms = ocr(crop)
                rec = {"tag": tag, "det": d, "roi": roi["id"], "session": r.get("session"),
                       "clip": r.get("clip"), "image": r.get("image"), "t": r["t"],
                       "cropPx": box, "cropSize": [box[2] - box[0], box[3] - box[1]],
                       "fullFrameText": r["text"], "cropTexts": [b["text"] for b in boxes],
                       "cropScores": [b["score"] for b in boxes], "cropMs": ms}
                # proxy comparison (cached sessions only)
                if a.cache and a.src == "clip":
                    mpath = os.path.join(a.cache, r["session"], "manifest.json")
                    if os.path.exists(mpath):
                        if r["session"] not in manifests:
                            manifests[r["session"]] = json.load(open(mpath, encoding="utf-8"))
                        ct = _cache_time(manifests[r["session"]], r["clip"], r["t"])
                        if ct is not None:
                            pf = grab_frame(os.path.join(a.cache, r["session"], "proxy-540x960-30p.mp4"), ct)
                            if pf is not None:
                                sx = pf.shape[1] / lay["frame"][0]
                                pb = [int(round(c * sx)) for c in box]
                                pc = pf[pb[1]:pb[3], pb[0]:pb[2]]
                                cv2.imwrite(os.path.join(a.out, tag + "-proxy.png"), pc)
                                pboxes, pms = ocr(pc)
                                up = cv2.resize(pc, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
                                uboxes, ums = ocr(up)
                                rec.update({"cacheTime": round(ct, 3), "proxyTexts": [b["text"] for b in pboxes],
                                            "proxyMs": pms, "proxyUp2Texts": [b["text"] for b in uboxes],
                                            "proxyUp2Ms": ums})
                out_rows.append(rec)
                print(tag, ascii(rec["cropTexts"]), ascii(rec.get("proxyTexts")), flush=True)
    with open(os.path.join(a.out, "crops.jsonl"), "w", encoding="utf-8") as f:
        for r in out_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"crops {len(out_rows)} -> {a.out}")


# ---------------------------------------------------------------- reference medals

DEFAULT_DATASET = os.path.join("data", "datasets", "codm-medals-reference")
DATASET_INDEX = "index.jsonl"


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _dataset_keys(index_path):
    keys = set()
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                keys.add((r["medal"], r["session"], r.get("clip") or r.get("image"), r["timeSec"], r["roiId"]))
    return keys


def log_reference_medals(rows, get_frame, pack, layout, dataset, per_medal=0, now=None):
    """Cut crops of reference-class M3 medals into `dataset` (per-medal subfolder + index.jsonl).

    rows: hits.jsonl rows (det M3 with a "medal" match); get_frame(row) -> BGR image or None.
    Reference-class medals have weight 0 and are never clip reasons; this only builds the dataset.
    Skips (medal, session, source, time, roi) records already in the index. Returns the number
    of crops written. The dataset holds crops that can show player names: it must be gitignored."""
    import cv2
    check_private_out(dataset)
    classes = medal_classes(pack)
    m3 = next(d for d in pack["detectors"] if d["id"] == "M3")
    os.makedirs(dataset, exist_ok=True)
    index_path = os.path.join(dataset, DATASET_INDEX)
    seen = _dataset_keys(index_path)
    counts = {}
    written = 0
    stamp = now or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cache = {}
    with open(index_path, "a", encoding="utf-8") as idx:
        for r in rows:
            medal = (r.get("medal") or {}).get("medal")
            if r.get("det") != "M3" or not medal or classes.get(medal, "positive") != "reference":
                continue
            if per_medal and counts.get(medal, 0) >= per_medal:
                continue
            src = r.get("clip") or r.get("image")
            fkey = (src, r["t"])
            if fkey not in cache:
                cache = {fkey: get_frame(r)}
            frame = cache[fkey]
            if frame is None:
                continue
            for roi in m3["rois"]:
                key = (medal, r.get("session"), src, r["t"], roi["id"])
                if key in seen:
                    continue
                box = geo.roi_crop_px(roi, layout)
                if box is None:
                    continue
                folder = os.path.join(dataset, slug(medal))
                os.makedirs(folder, exist_ok=True)
                name = f"{r.get('session') or 'img'}-{r['t']:010.3f}-{roi['id']}.png"
                cv2.imwrite(os.path.join(folder, name), frame[box[1]:box[3], box[0]:box[2]])
                rec = {"version": 1, "medal": medal, "class": "reference", "packVersion": pack.get("version"),
                       "session": r.get("session"), "clip": r.get("clip"), "image": r.get("image"),
                       "timeSec": r["t"], "roiId": roi["id"], "crop": slug(medal) + "/" + name,
                       "ocrText": r["text"], "ocrScore": r["score"], "createdAt": stamp}
                idx.write(json.dumps(rec, ensure_ascii=False) + "\n")
                seen.add(key)
                written += 1
            counts[medal] = counts.get(medal, 0) + 1
    return written


def cmd_refmedals(a):
    import cv2
    with open(a.pack, encoding="utf-8") as f:
        pack = json.load(f)
    layout = load_layout(a.layout)
    layout = layout.get("layout", layout)
    refuse_inside(a.dataset, a.corpus, "corpus")
    rows = [json.loads(line) for line in open(a.hits, encoding="utf-8")]
    rows = [r for r in rows if r["src"] == a.src]

    def get_frame(r):
        if a.src == "clip":
            return grab_frame(os.path.join(a.corpus, r["clip"]), r["t"])
        return cv2.imread(os.path.join(a.images_dir, r["image"]))

    n = log_reference_medals(rows, get_frame, pack, layout, a.dataset, a.per_medal)
    print(f"refmedals {n} crops -> {a.dataset}")


# ---------------------------------------------------------------- bench

def cmd_bench(a):
    """OCR every crop image in a folder with the default and the crop profile; time both."""
    import cv2
    files = sorted(f for f in glob.glob(os.path.join(a.crops, a.pattern)) if not f.endswith("-proxy.png"))
    imgs = [(os.path.basename(f), cv2.imread(f)) for f in files]
    res = {}
    for prof_name, prof in (("default", {}), ("crop", CROP_PROFILE)):
        OCR_PARAMS.clear()
        OCR_PARAMS.update({"Global.log_level": "error"})
        OCR_PARAMS.update(thread_params(a.threads))
        set_ocr_params(prof)
        ocr(imgs[0][1])  # warm-up
        rows = []
        for name, img in imgs:
            boxes, ms = ocr(img)
            rows.append({"crop": name, "size": [img.shape[1], img.shape[0]], "ms": ms,
                         "texts": [b["text"] for b in boxes]})
        ms = [r["ms"] for r in rows]
        res[prof_name] = {"params": prof, "n": len(rows), "msMedian": round(statistics.median(ms), 1),
                          "msP95": round(sorted(ms)[int(0.95 * (len(ms) - 1))], 1), "rows": rows}
    same = sum(1 for x, y in zip(res["default"]["rows"], res["crop"]["rows"]) if x["texts"] == y["texts"])
    res["sameTextsBothProfiles"] = same
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: (v if k == "sameTextsBothProfiles" else {kk: vv for kk, vv in v.items() if kk != "rows"})
                      for k, v in res.items()}))


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--threads", type=int, default=DEFAULT_THREADS,
                    help="onnxruntime intra-op threads for OCR (inter-op 1); default 4")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("frames")
    p.add_argument("--index", required=True)
    p.add_argument("--corpus", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--sessions")
    p.add_argument("--per-session", type=int, default=6)
    p.add_argument("--at", type=float, default=15.0)
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=20261027)
    p.set_defaults(fn=cmd_frames)

    p = sub.add_parser("calibrate")
    p.add_argument("--frames", required=True)
    p.add_argument("--ref-frame", required=True)
    p.add_argument("--ref-game", required=True, help="x,y,w,h of the game area in the reference frame")
    p.add_argument("--landmarks", help="JSON {name: [x0,y0,x1,y1]} in reference pixels (2 landmarks)")
    p.add_argument("--frame-size", default="1080x1920")
    p.add_argument("--scale-min", type=float, default=0.80)
    p.add_argument("--scale-max", type=float, default=0.92)
    p.add_argument("--scale-step", type=float, default=0.0025)
    p.add_argument("--min-score", type=float, default=0.6)
    p.add_argument("--inset", type=int, default=2, help="pixels trimmed off the cutout border")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_calibrate)

    p = sub.add_parser("scan")
    p.add_argument("--index")
    p.add_argument("--corpus")
    p.add_argument("--images")
    p.add_argument("--session-label", default="live-ref")
    p.add_argument("--layout")
    p.add_argument("--out", required=True)
    p.add_argument("--name", default="scan")
    p.add_argument("--sessions")
    p.add_argument("--clips-per-session", type=int, default=10)
    p.add_argument("--fps", type=float, default=0.5)
    p.add_argument("--seed", type=int, default=20261027)
    p.add_argument("--diff-gate", type=float, default=1.5, help="skip OCR when the mean abs luma change "
                   "against the last OCR'd frame (1/4 scale) is below this")
    p.add_argument("--hwaccel")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("analyse")
    p.add_argument("--scan", nargs="+", required=True)
    p.add_argument("--pack", required=True)
    p.add_argument("--profile", required=True)
    p.add_argument("--name-min", type=float, default=0.8)
    p.add_argument("--mode-tags", help="JSON {session or session/clip: mp|br|dmz}; overrides the HUD classifier")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_analyse)

    p = sub.add_parser("crops")
    p.add_argument("--hits", required=True)
    p.add_argument("--src", default="clip", choices=["clip", "image"])
    p.add_argument("--corpus")
    p.add_argument("--images-dir")
    p.add_argument("--layout", required=True)
    p.add_argument("--pack", required=True)
    p.add_argument("--cache")
    p.add_argument("--dets")
    p.add_argument("--per-detector", type=int, default=12)
    p.add_argument("--profile-ocr", default="crop", choices=["crop", "default"])
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_crops)

    p = sub.add_parser("refmedals")
    p.add_argument("--hits", required=True)
    p.add_argument("--src", default="clip", choices=["clip", "image"])
    p.add_argument("--corpus")
    p.add_argument("--images-dir")
    p.add_argument("--layout", required=True)
    p.add_argument("--pack", required=True)
    p.add_argument("--dataset", default=os.path.join(repo_root(), DEFAULT_DATASET),
                   help="reference dataset folder (default data/datasets/codm-medals-reference, gitignored)")
    p.add_argument("--per-medal", type=int, default=0, help="max hits per medal (0 = all)")
    p.set_defaults(fn=cmd_refmedals)

    p = sub.add_parser("bench")
    p.add_argument("--crops", required=True, help="folder of crop PNGs")
    p.add_argument("--pattern", default="*.png")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_bench)

    a = ap.parse_args(argv)
    if a.cmd == "scan" and not a.images and not (a.index and a.corpus and a.layout):
        ap.error("scan needs --images, or --index, --corpus and --layout")
    if a.threads < 1:
        ap.error("--threads must be >= 1")
    set_ocr_params(thread_params(a.threads))
    lower_own_priority()
    a.fn(a)


if __name__ == "__main__":
    main()
