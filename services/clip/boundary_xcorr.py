# SPDX-License-Identifier: GPL-2.0-or-later
"""Measure the real overlap between consecutive clips from their audio (P2a step A2b).

Python stdlib only (no numpy). Clip audio is decoded with ffmpeg to mono 16-bit PCM
and piped to this process; nothing is written next to the clips.

Method, per boundary A -> B (A = earlier clip, B = next clip):
  1. Decode all of A's audio and the first W seconds of B's audio (8 kHz mono s16le),
     with an aresample async fill so that sample index == clip timeline. Every clip has
     a ~0.10-0.15 s timestamp gap after its first AAC packet; the fill makes it silence,
     and that leading fill in B is left out of every comparison.
  2. Short-time log-energy envelope, 10 ms frames, mean-removed. A's frames are laid
     out backwards from A's audio end so that "n frames of overlap" is exact.
  3. For every candidate overlap n take the Pearson correlation of A's last n frames
     with B's first n frames (cross-correlation over overlaps 0.25 s .. W). Candidates:
     the 5 best by significance (Fisher z * sqrt(frames)) and the 5 best by r.
  4. Refine each candidate at sample level: Pearson r of the raw samples in 1-sample
     steps within +/- 15 ms over the first 0.25 s of the overlap; the best one is
     re-scored (+/- 2 samples) over the first <= 2 s. That r is the confidence. Silent (< -70 dBFS) or low-confidence (< 0.90) boundaries, or < 0.25 s
     of comparable audio, are rejected. A gap (no shared audio) can never be measured.

Overlap convention: overlap > 0 means B's first `overlap` seconds repeat A's last
`overlap` seconds of audio. B.start - A.start = A.audioDuration - overlap.

Usage (run isolated):
  python -I services/clip/boundary_xcorr.py --index <index.json> --corpus <clips folder>
      --out <boundaries.json> [--sessions ID,ID] [--sample-per-session N --sample-sessions ID,...]
      [--pairs FILE_A,FILE_B ...] [--workers N]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import random
import subprocess
import sys
from array import array
from datetime import datetime, timezone
from operator import mul

RATE = 8000
FRAME_SEC = 0.010
SILENCE_DBFS = -70.0       # compared region quieter than this (RMS) is treated as silent
# Thresholds set from a null test (pairs clip i -> clip i+2, which share no audio); see
# docs/evidence/2026-10-27-p2a-a2b-boundaries-cache.md.
MIN_CONFIDENCE = 0.90      # sample-level Pearson below this is rejected
MIN_COMPARE_SEC = 0.25     # at least this much audio must be compared
ASYNC_FILL = "aresample=async=1:min_hard_comp=0.01:first_pts=0"
VERSION = 1
METHOD_VERSION = 8         # bump when the measurement changes; cached results are then redone


# ---------------------------------------------------------------- decoding

def decode_pcm(path: str, rate: int = RATE, duration: float | None = None,
               ffmpeg: str = "ffmpeg") -> array:
    """Decode the first audio stream of `path` to mono s16 at `rate`, read from a pipe."""
    # aresample async fill: every clip's first AAC packet is followed by a ~0.10-0.15 s
    # timestamp gap. Filling it with silence keeps sample index == clip timeline, which is
    # the same timeline the concat demuxer (and build_cache.py) uses.
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-vn",
           "-af", ASYNC_FILL, "-ac", "1", "-ar", str(rate)]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-f", "s16le", "-acodec", "pcm_s16le", "-"]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.run(cmd, capture_output=True, timeout=300, creationflags=flags)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exit {proc.returncode}: {proc.stderr.decode(errors='replace')[:300]}")
    a = array("h")
    data = proc.stdout
    a.frombytes(data[: len(data) - (len(data) % 2)])
    if sys.byteorder != "little":
        a.byteswap()
    return a


# ---------------------------------------------------------------- signal helpers

def envelope(samples, rate: int = RATE, frame_sec: float = FRAME_SEC,
             from_end: bool = False) -> list[float]:
    """Log energy per frame, mean-removed. from_end lays frames out backwards from the
    last sample, so frame k (from the end) covers the k-th last frame_sec of audio."""
    n = int(round(rate * frame_sec))
    total = len(samples) // n
    out = []
    if from_end:
        end = len(samples)
        for k in range(total):
            seg = samples[end - (total - k) * n: end - (total - k - 1) * n]
            out.append(math.log10(sum(map(mul, seg, seg)) / n + 1.0))
    else:
        for k in range(total):
            seg = samples[k * n:(k + 1) * n]
            out.append(math.log10(sum(map(mul, seg, seg)) / n + 1.0))
    if out:
        m = sum(out) / len(out)
        out = [v - m for v in out]
    return out


def pearson(a, b) -> float:
    n = len(a)
    if n < 2 or n != len(b):
        return 0.0
    sa = sum(a)
    sb = sum(b)
    saa = sum(map(mul, a, a))
    sbb = sum(map(mul, b, b))
    sab = sum(map(mul, a, b))
    va = saa - sa * sa / n
    vb = sbb - sb * sb / n
    if va <= 0 or vb <= 0:
        return 0.0
    return (sab - sa * sb / n) / math.sqrt(va * vb)


def leading_fill(b, rate: int = RATE, search_sec: float = 0.30, min_run_sec: float = 0.025) -> int:
    """End index of the silence that the async fill inserted near B's start (a run of
    exact zeros starting in the first `search_sec`), or 0 if there is none."""
    limit = min(len(b), int(rate * search_sec))
    min_run = int(rate * min_run_sec)
    i = 0
    while i < limit:
        if b[i] == 0:
            j = i
            while j < len(b) and b[j] == 0:
                j += 1
            if j - i >= min_run:
                return j
            i = j
        else:
            i += 1
    return 0


def coarse_overlap(env_a_end: list[float], env_b: list[float], min_frames: int,
                   max_frames: int, skip_frames: int = 0) -> list[tuple[int, float]]:
    """Pearson r for every candidate overlap of n frames: A's last n frames vs B's first
    n frames, leaving out B's first skip_frames (and the matching A frames)."""
    max_frames = min(max_frames, len(env_a_end), len(env_b))
    out = []
    la = len(env_a_end)
    for n in range(skip_frames + min_frames, max_frames + 1):
        out.append((n, pearson(env_a_end[la - n + skip_frames:], env_b[skip_frames:n])))
    return out


def scan_overlap(a, b, center: int, window: int, compare: int,
                 skip: int = 0, min_compare: int = 2) -> list[tuple[int, float]]:
    """Pearson r for overlaps m in [center - window, center + window]. For overlap m it
    compares A[len-m+skip : +K] with B[skip : skip+K], K = min(m - skip, compare)."""
    out = []
    la = len(a)
    for m in range(max(skip + min_compare, center - window), center + window + 1):
        if m > la or m > len(b):
            break
        k = min(m - skip, compare)
        out.append((m, pearson(a[la - m + skip: la - m + skip + k], b[skip: skip + k])))
    return out


def refine_overlap(a, b, center: int, window: int, compare: int,
                   skip: int = 0, min_compare: int = 2) -> tuple[int, float]:
    """Best (m, r) of scan_overlap."""
    return max(scan_overlap(a, b, center, window, compare, skip, min_compare),
               key=lambda t: t[1], default=(center, -2.0))


def rms_dbfs(samples) -> float:
    if not samples:
        return -120.0
    ms = sum(map(mul, samples, samples)) / len(samples)
    return 10 * math.log10(ms / (32768.0 ** 2) + 1e-12)


def measure_pcm(a, b, rate: int = RATE, max_overlap_sec: float = 8.0,
                min_overlap_sec: float = MIN_COMPARE_SEC, refine_ms: float = 15.0,
                compare_sec: float = 2.0, top_k: int = 5) -> dict:
    """Measure the overlap between the end of `a` and the start of `b` (PCM arrays)."""
    frame = int(round(rate * FRAME_SEC))
    skip = leading_fill(b, rate)
    skip_f = -(-skip // frame)  # ceil
    env_a = envelope(a, rate, from_end=True)
    env_b = envelope(b, rate)
    min_f = max(2, int(round(min_overlap_sec / FRAME_SEC)))
    max_f = int(round(max_overlap_sec / FRAME_SEC))
    curve = coarse_overlap(env_a, env_b, min_f, max_f, skip_f)
    if not curve:
        return {"status": "no-data", "headFillSec": round(skip / rate, 4)}
    # Rank candidates by significance (Fisher z * sqrt(compared frames - 3)) so that short
    # windows with a high r by chance do not beat a long, well-matched window.
    def z(item):
        n, r = item
        cnt = n - skip_f
        return math.atanh(max(-0.999999, min(0.999999, r))) * math.sqrt(max(cnt - 3, 1))
    # Candidates: the top_k by significance plus the top_k by raw r (distinct by > 5 frames).
    cands: list[tuple[int, float]] = []
    for key in (z, lambda t: t[1]):
        added = 0
        for n, r in sorted(curve, key=key, reverse=True):
            if all(abs(n - c) > 5 for c, _ in cands):
                cands.append((n, r))
                added += 1
            if added >= top_k:
                break
    # Sample-level refinement around each candidate, 1-sample steps within +/- refine_ms
    # over the first <= 0.25 s of the overlap; the best r wins. (Tried and dropped:
    # first-differenced audio -- the clips are not bit-identical in the high band, so true
    # matches fell to r ~0.75; a 4-sample block-sum pre-search -- a steady tone made a
    # wrong block-level peak win.)
    best = None
    win = int(rate * refine_ms / 1000)
    min_cmp = int(rate * min_overlap_sec)
    skip_s = skip_f * frame
    for n, r in cands:
        m2, r2 = refine_overlap(a, b, n * frame, win, min_cmp, skip_s, min_cmp)
        if best is None or r2 > best[2]:
            best = (n, r, r2, m2)
    n_best, r_env, _, m0 = best
    # Final value: same search over the first <= compare_sec of the overlap.
    m, r_samp = refine_overlap(a, b, m0, 2, int(rate * compare_sec), skip_s, min_cmp)
    # best envelope r at least 0.1 s away from the chosen overlap, for prominence
    others = [r for n, r in curve if abs(n - n_best) > 10]
    r_second = max(others) if others else None
    cmp_start = skip_f * frame
    region = b[cmp_start: cmp_start + min(m - cmp_start, int(rate * compare_sec))]
    level = rms_dbfs(region)
    res = {
        "overlapSec": round(m / rate, 4),
        "coarseOverlapSec": round(n_best * FRAME_SEC, 3),
        "envPeakR": round(r_env, 4),
        "envSecondR": None if r_second is None else round(r_second, 4),
        "confidence": round(r_samp, 4),
        "comparedSec": round(min(m - cmp_start, int(rate * compare_sec)) / rate, 4),
        "comparedRmsDbfs": round(level, 1),
        "headFillSec": round(skip / rate, 4),
        "aAudioSec": round(len(a) / rate, 4),
    }
    if level < SILENCE_DBFS:
        res["status"] = "rejected-silent"
    elif r_samp < MIN_CONFIDENCE:
        res["status"] = "rejected-low-confidence"
    else:
        res["status"] = "ok"
    return res


# ---------------------------------------------------------------- boundaries from the index

def boundary_records(index: dict) -> list[dict]:
    """All consecutive clip pairs per session, with name-time predictions."""
    from datetime import datetime as _dt
    out = []
    for s in index["sessions"]:
        clips = s["clips"]
        for i in range(1, len(clips)):
            a, b = clips[i - 1], clips[i]
            out.append({"session": s["id"], "i": i, "a": a["file"], "b": b["file"],
                        "aDur": a["duration"], "bDur": b["duration"],
                        "gapBeforeSec": b["gapBeforeSec"]})
    return out


def name_delta(a_file: str, b_file: str, parse) -> float:
    return (parse(b_file) - parse(a_file)).total_seconds()


def measure_boundary(rec: dict, corpus: str, ffmpeg: str, parse, window: float = 8.0) -> dict:
    dn = name_delta(rec["a"], rec["b"], parse)
    pred_end = rec["bDur"] - dn     # overlap predicted if the name is the END time
    pred_start = rec["aDur"] - dn   # overlap predicted if the name is the START time
    # search window: at least `window`, enough for the larger positive prediction
    w = max(window, min(max(pred_end, pred_start) + 3.0, rec["aDur"], rec["bDur"]))
    w = min(w, rec["aDur"], rec["bDur"])
    out = dict(rec)
    out.update({"nameDeltaSec": dn, "predOverlapEndHyp": round(pred_end, 3),
                "predOverlapStartHyp": round(pred_start, 3), "windowSec": round(w, 3)})
    try:
        a = decode_pcm(os.path.join(corpus, rec["a"]), ffmpeg=ffmpeg)
        b = decode_pcm(os.path.join(corpus, rec["b"]), duration=w, ffmpeg=ffmpeg)
        out.update(measure_pcm(a, b, max_overlap_sec=w))
        if "overlapSec" in out:
            # B's in-point on the concat timeline: A's segment ends at its format duration.
            out["trimInSec"] = round(out["overlapSec"] + rec["aDur"] - out["aAudioSec"], 4)
            # Start-to-start offset and the name-time predictions it is compared with.
            out["startToStartSec"] = round(rec["aDur"] - out["trimInSec"], 4)
            out["residualEndHyp"] = round(out["trimInSec"] - pred_end, 3)
            out["residualStartHyp"] = round(out["trimInSec"] - pred_start, 3)
    except Exception as exc:  # reported per boundary
        out["status"] = "error"
        out["error"] = str(exc)[:300]
    return out


def best_window(values: list[float], width: float) -> tuple[int, float]:
    """Largest number of values inside any window [lo, lo + width]; returns (count, lo)."""
    v = sorted(values)
    best = (0, v[0] if v else 0.0)
    j = 0
    for i in range(len(v)):
        while v[i] - v[j] > width:
            j += 1
        if i - j + 1 > best[0]:
            best = (i - j + 1, v[j])
    return best


def verdict(records: list[dict], tolerance: float = 0.10, discriminating_sec: float = 1.5,
            width: float = 1.10) -> dict:
    """Test the two name-time hypotheses on the boundaries measured with status ok.

    For each measured boundary: residual = nameDelta - predicted nameDelta, where
    name = end predicts B.duration - trim and name = start predicts A.duration - trim.
    File names have 1 s resolution, so under the right hypothesis every residual is
    inside (-1, +1) s; `tolerance` adds room for measurement error and save-latency
    jitter. A hypothesis "fits" when >= 95 % of the residuals (all boundaries, and the
    discriminating subset) satisfy |residual| <= 1 + tolerance. Boundaries with
    |A.duration - B.duration| >= discriminating_sec are reported separately, because
    only there do the two predictions differ by more than the name resolution.
    The largest count inside any `width`-wide window is reported as a second measure.
    """
    ok = [m for m in records if m.get("status") == "ok"]
    out = {"measured": len(ok), "toleranceSec": tolerance, "windowSec": width,
           "discriminatingSec": discriminating_sec}
    limit = 1.0 + tolerance
    for label, sub in (("all", ok),
                       ("discriminating", [m for m in ok
                                           if abs(m["aDur"] - m["bDur"]) >= discriminating_sec])):
        res = {"n": len(sub)}
        for hyp, key in (("end", "residualEndHyp"), ("start", "residualStartHyp")):
            vals = [m[key] for m in sub]
            if not vals:
                continue
            inside = sum(1 for v in vals if abs(v) <= limit)
            cnt, lo = best_window(vals, width)
            res[hyp] = {"min": round(min(vals), 3), "max": round(max(vals), 3),
                        "withinLimit": inside, "fraction": round(inside / len(vals), 3),
                        "inBestWindow": cnt, "windowFrom": round(lo, 3)}
        out[label] = res

    def call(h):
        d = out["discriminating"].get(h)
        a = out["all"].get(h)
        if not d or out["discriminating"]["n"] < 5:
            return "inconclusive"
        return "fits" if d["fraction"] >= 0.95 and a["fraction"] >= 0.95 else "does not fit"
    out["verdictEnd"] = call("end")
    out["verdictStart"] = call("start")
    return out


def _load_session_index():
    import importlib.util
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session_index.py")
    spec = importlib.util.spec_from_file_location("session_index", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Measure clip boundary overlaps from audio (read-only).")
    ap.add_argument("--index", required=True, help="index.json from session_index.py")
    ap.add_argument("--corpus", required=True, help="clips folder (read only)")
    ap.add_argument("--out", required=True, help="boundaries JSON to write (merged with an existing one)")
    ap.add_argument("--sessions", default="", help="comma-separated session ids: measure every boundary")
    ap.add_argument("--sample-sessions", default="", help="comma-separated session ids to sample from")
    ap.add_argument("--sample-per-session", type=int, default=0)
    ap.add_argument("--seed", type=int, default=20261027)
    ap.add_argument("--pairs", nargs="*", default=[], help="FILE_A,FILE_B pairs to measure")
    ap.add_argument("--short-first", action="store_true",
                    help="also measure the boundary after every short (< 25 s) first clip")
    ap.add_argument("--window", type=float, default=8.0, help="seconds of audio compared (default 8)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--force", action="store_true", help="re-measure pairs already in --out")
    ap.add_argument("--null-pairs", type=int, default=0,
                    help="also measure N null pairs (clip i -> clip i+2, no shared audio) and "
                         "report how many pass the acceptance rule (false positives)")
    args = ap.parse_args(argv)

    si = _load_session_index()
    if si._is_inside(args.out, args.corpus):
        print("refusing: output is inside the corpus folder", file=sys.stderr)
        return 2
    with open(args.index, encoding="utf-8") as fh:
        index = json.load(fh)
    recs = boundary_records(index)
    by_pair = {(r["a"], r["b"]): r for r in recs}

    chosen: dict[tuple, str] = {}
    full = {x for x in args.sessions.split(",") if x}
    for r in recs:
        if r["session"] in full:
            chosen.setdefault((r["a"], r["b"]), "session-all")
    if args.short_first:
        for s in index["sessions"]:
            c = s["clips"]
            if len(c) > 1 and c[0]["duration"] < 25.0:
                chosen.setdefault((c[0]["file"], c[1]["file"]), "short-first")
    for p in args.pairs:
        a, b = p.split(",", 1)
        if (a, b) not in by_pair:
            print(f"pair not consecutive in index: {p}", file=sys.stderr)
            return 2
        chosen.setdefault((a, b), "special")
    rng = random.Random(args.seed)
    for sid in [x for x in args.sample_sessions.split(",") if x]:
        pool = [r for r in recs if r["session"] == sid]
        if not pool:
            print(f"unknown session {sid}", file=sys.stderr)
            return 2
        for r in rng.sample(pool, min(args.sample_per_session, len(pool))):
            chosen.setdefault((r["a"], r["b"]), "random-sample")

    existing = {}
    prev_null = None
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as fh:
            prev = json.load(fh)
        prev_null = prev.get("nullTest")
        same_method = prev.get("method", {}).get("version") == METHOD_VERSION
        for m in prev.get("boundaries", []):
            if same_method:
                existing[(m["a"], m["b"])] = m
        if not same_method:
            prev_null = None
            print("method changed since the last run: re-measuring everything", file=sys.stderr)
    todo = [k for k in chosen if args.force or k not in existing]
    print(f"chosen {len(chosen)}, already measured {len(chosen) - len(todo)}, measuring {len(todo)}",
          file=sys.stderr, flush=True)

    parse = si.parse_clip_name
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(8, args.workers))) as pool:
        futs = {pool.submit(measure_boundary, by_pair[k], args.corpus, args.ffmpeg, parse, args.window): k
                for k in todo}
        for fut in concurrent.futures.as_completed(futs):
            k = futs[fut]
            m = fut.result()
            m["reason"] = chosen[k]
            existing[k] = m
            done += 1
            if done % 25 == 0:
                print(f"measured {done}/{len(todo)}", file=sys.stderr, flush=True)
    for k, why in chosen.items():
        existing[k].setdefault("reason", why)

    null_test = prev_null
    if args.null_pairs > 0:
        nrng = random.Random(args.seed + 1)
        pool = []
        for s in index["sessions"]:
            c = s["clips"]
            for i in range(len(c) - 2):
                pool.append({"session": s["id"], "i": i, "a": c[i]["file"], "b": c[i + 2]["file"],
                             "aDur": c[i]["duration"], "bDur": c[i + 2]["duration"],
                             "gapBeforeSec": None})
        picks = nrng.sample(pool, min(args.null_pairs, len(pool)))
        print(f"null test: measuring {len(picks)} pairs", file=sys.stderr, flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(8, args.workers))) as pool_ex:
            nres = list(pool_ex.map(
                lambda r: measure_boundary(r, args.corpus, args.ffmpeg, parse, args.window), picks))
        conf = sorted((m.get("confidence") or 0.0 for m in nres), reverse=True)
        null_test = {"pairs": len(nres), "accepted": sum(1 for m in nres if m.get("status") == "ok"),
                     "sessions": len({m["session"] for m in nres}),
                     "topConfidences": [round(c, 4) for c in conf[:10]],
                     "status": {}}
        for m in nres:
            null_test["status"][m["status"]] = null_test["status"].get(m["status"], 0) + 1

    ordered = sorted(existing.values(), key=lambda m: (m["session"], m["i"]))
    out = {"version": VERSION, "method": {
        "version": METHOD_VERSION, "rate": RATE, "minCompareSec": MIN_COMPARE_SEC, "frameSec": FRAME_SEC, "silenceDbfs": SILENCE_DBFS,
        "minConfidence": MIN_CONFIDENCE, "windowSec": args.window,
        "indexNameTime": index.get("nameTime")},
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "verdict": verdict(ordered),
        "nullTest": null_test,
        "boundaries": ordered}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + ".tmp"
    st = {}
    for m in ordered:
        st[m["status"]] = st.get(m["status"], 0) + 1
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    os.replace(tmp, args.out)
    print(json.dumps({"total": len(ordered), "status": st, "verdict": out["verdict"]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
