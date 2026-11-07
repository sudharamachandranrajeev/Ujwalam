# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 kill montages (user decisions 2026-11-07, data/clip/montage.json): Shorts of 30-45 s (always 20-60 s) built
from the own kills of streaks, with the dead time between kills cut out; pieces of different matches may be joined.

plan_montages(hits, ranking, cfg, duration) -> [montage], each {pieces: [{start, end, kills}], seconds, score,
labels}. Times are seconds into the recording the hits came from (the H recording; the V recording of the same
session has the same timeline).

1. Kills: own-kill kill-feed lines (cfg.killDetectors, signal true) plus streak medals (detector weight > 0 under
   the approved ranking, clip_rank.detector_weight). A medal with no own kill within medalMatchSec before it
   (a missed feed line) becomes a kill at t - medalLeadSec.
2. Streaks: kills and medals no more than chainGapSec apart, never across a streamer death (hard negative).
   A streak counts only when its score (medal weights, sumKinds summed) reaches ranking.minScore: "Streaks only".
3. Pieces: [kill - preSec, kill + postSec] per kill, cut before a death (ranking.death); pieces closer than
   joinGapSec merge.
4. Montages: streaks by score, best first, each added to the first montage it fits in (<= targetMaxSec);
   a montage below minSec is dropped. A single streak longer than maxSec is cut to its best maxSec window.
   Pieces inside a montage are in time order.
"""

from __future__ import annotations

import clip_rank as rank


def _kill_events(hits, ranking, cfg):
    approved = ranking.get("detectorWeightsStatus") == "approved"
    dw = ranking.get("detectorWeights") or {}
    kd = set(cfg.get("killDetectors") or [])
    kills, medals = [], []
    for h in hits:
        if h["detector"] in kd and h.get("signal") is True:
            kills.append(float(h["t"]))
        w, _ = rank.detector_weight(h, dw, approved)
        if w > 0:
            medals.append({"t": float(h["t"]), "w": w, "strength": 1.0, "kind": f"detector.{h['detector']}",
                           "label": h.get("label") or h["detector"]})
    return sorted(kills), sorted(medals, key=lambda m: m["t"])


def streaks(hits, ranking, cfg):
    """[{kills: [t], medals: [...], score}] in time order, qualifying ones only."""
    kills, medals = _kill_events(hits, ranking, cfg)
    deaths = rank.death_spans(hits, ranking)
    gap, lead, near = float(cfg["chainGapSec"]), float(cfg["medalLeadSec"]), float(cfg["medalMatchSec"])
    evs = sorted([(t, "kill", None) for t in kills] + [(m["t"], "medal", m) for m in medals], key=lambda e: e[0])
    groups, cur, last = [], None, None
    for t, kind, m in evs:
        crossed = last is not None and any(last < ds <= t for ds, _ in deaths)
        if cur is None or t - last > gap or crossed:
            cur = {"kills": [], "medals": []}
            groups.append(cur)
        (cur["kills"] if kind == "kill" else cur["medals"]).append(t if kind == "kill" else m)
        last = t
    sum_kinds = set(ranking.get("sumKinds") or [])
    min_score = float(ranking.get("minScore") or 0)
    out = []
    for g in groups:
        if not g["medals"]:
            continue
        for m in g["medals"]:  # a medal with no own-kill line before it (missed feed line) is its own kill
            if not any(m["t"] - near <= k <= m["t"] for k in g["kills"]):
                g["kills"].append(m["t"] - lead)
        g["kills"].sort()
        g["score"] = rank._score(g["medals"], sum_kinds)
        if g["score"] >= min_score:
            out.append(g)
    return out, deaths


def _pieces(kill_ts, deaths, ranking, cfg):
    pre, post, join = float(cfg["preSec"]), float(cfg["postSec"]), float(cfg["joinGapSec"])
    raw = []
    for k in kill_ts:
        r = rank._cut_deaths(max(0.0, k - pre), k + post, k, deaths, ranking)
        if r and r[1] > k:
            raw.append([r[0], r[1], 1])
    out = []
    for a, b, n in sorted(raw):
        if out and a - out[-1][1] <= join:
            out[-1][1] = max(out[-1][1], b)
            out[-1][2] += n
        else:
            out.append([a, b, n])
    return [{"start": round(a, 3), "end": round(b, 3), "kills": n} for a, b, n in out]


def _length(pieces):
    return sum(p["end"] - p["start"] for p in pieces)


def _cap(pieces, max_sec):
    """Best (most kills) contiguous run of pieces that fits max_sec; the last piece is trimmed if needed."""
    best, best_k = [], -1
    for i in range(len(pieces)):
        run, total = [], 0.0
        for p in pieces[i:]:
            d = p["end"] - p["start"]
            if total + d > max_sec:
                if max_sec - total >= 2.0:
                    run.append(dict(p, end=round(p["start"] + max_sec - total, 3)))
                break
            run.append(p)
            total += d
        k = sum(p["kills"] for p in run)
        if k > best_k:
            best, best_k = run, k
    return best


def plan_montages(hits, ranking, cfg, duration):
    sts, deaths = streaks(hits, ranking, cfg)
    units = []
    for s in sts:
        ps = [p for p in _pieces(s["kills"], deaths, ranking, cfg) if p["end"] <= duration]
        if _length(ps) > float(cfg["maxSec"]):
            ps = _cap(ps, float(cfg["maxSec"]))
        if ps:
            units.append({"pieces": ps, "score": s["score"], "labels": [m["label"] for m in s["medals"]]})
    hi, lo = float(cfg["targetMaxSec"]), float(cfg["minSec"])
    montages = []
    for u in sorted(units, key=lambda u: (-u["score"], u["pieces"][0]["start"])):
        d = _length(u["pieces"])
        home = next((m for m in montages if _length(m["pieces"]) + d <= hi), None)
        if home is None:
            home = {"pieces": [], "score": 0.0, "labels": []}
            montages.append(home)
        home["pieces"] += u["pieces"]
        home["score"] += u["score"]
        home["labels"] += u["labels"]
    # montages still short of the target join each other while they stay inside maxSec (the user's 20-60 s bound)
    cap, tmin = float(cfg["maxSec"]), float(cfg["targetMinSec"])
    short = sorted((m for m in montages if _length(m["pieces"]) < tmin), key=lambda m: _length(m["pieces"]))
    while len(short) > 1 and _length(short[0]["pieces"]) + _length(short[1]["pieces"]) <= cap:
        a, b = short.pop(0), short.pop(0)
        a["pieces"] += b["pieces"]
        a["score"] += b["score"]
        a["labels"] += b["labels"]
        montages.remove(b)
        if _length(a["pieces"]) < tmin:
            short.insert(0, a)
            short.sort(key=lambda m: _length(m["pieces"]))
    out = []
    for m in montages:
        m["pieces"].sort(key=lambda p: p["start"])
        m["seconds"] = round(_length(m["pieces"]), 3)
        if m["seconds"] >= lo:
            out.append(m)
    return sorted(out, key=lambda m: -m["score"])


def render_argv(ffmpeg, src, pieces, frame, encoder_args, audio_args, fade_ms, out_name, threads=4):
    """One ffmpeg run: each piece is its own input (-ss/-t, exact because it is re-encoded), scaled into the frame,
    audio faded in and out by fade_ms (no pop at a hard cut), then concatenated."""
    ow, oh = int(frame["width"]), int(frame["height"])
    fd = fade_ms / 1000.0
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", str(threads), "-filter_threads", "2"]
    for p in pieces:
        argv += ["-ss", f"{p['start']:.3f}", "-t", f"{p['end'] - p['start']:.3f}", "-i", src]
    parts = []
    for i, p in enumerate(pieces):
        d = p["end"] - p["start"]
        parts.append(f"[{i}:v]scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos,"
                     f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p,setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[{i}:a:0]aresample=48000,asetpts=PTS-STARTPTS,afade=t=in:d={fd:.3f},"
                     f"afade=t=out:st={max(0.0, d - fd):.3f}:d={fd:.3f}[a{i}]")
    parts.append("".join(f"[v{i}][a{i}]" for i in range(len(pieces))) + f"concat=n={len(pieces)}:v=1:a=1[vout][aout]")
    argv += ["-filter_complex", ";".join(parts), "-map", "[vout]", "-map", "[aout]", *encoder_args, *audio_args,
             "-movflags", "+faststart", "-f", "mp4", out_name]
    return argv


def match_reels(hits, ranking, cfg):
    """Won-match highlights (user decision 2026-11-07, D237): for each VICTORY (detector W1, signal true), every own
    kill of that match (the kill rule of step 1, streak or not), each [kill - preSec, kill + postSec] cut before a
    death, plus the VICTORY screen itself; no 60 s cap. The match runs from the previous match result (W1, either
    word) or the start of the recording. A won match with no own kill gives no reel."""
    results = sorted((h for h in hits if h["detector"] == "W1" and h.get("signal") is True), key=lambda h: h["t"])
    kills, medals = _kill_events(hits, ranking, cfg)
    near, lead = float(cfg["medalMatchSec"]), float(cfg["medalLeadSec"])
    for m in medals:  # a medal with no own-kill line before it is its own kill (as in streaks)
        if not any(m["t"] - near <= k <= m["t"] for k in kills):
            kills.append(m["t"] - lead)
    kills.sort()
    deaths = rank.death_spans(hits, ranking)
    out, start = [], 0.0
    for r in results:
        t = float(r["t"])
        if r.get("label") == "VICTORY":
            ks = [k for k in kills if start < k <= t]
            if ks:
                ps = _pieces(ks, deaths, ranking, cfg)
                end = float(r.get("tEnd") or t) + float(cfg["resultHoldSec"])
                ps.append({"start": round(t - float(cfg["resultLeadSec"]), 3), "end": round(end, 3), "kills": 0})
                ps.sort(key=lambda p: p["start"])
                merged = []
                for p in ps:  # the result piece may overlap the last kill piece
                    if merged and p["start"] <= merged[-1]["end"]:
                        merged[-1] = dict(merged[-1], end=max(merged[-1]["end"], p["end"]),
                                          kills=merged[-1]["kills"] + p["kills"])
                    else:
                        merged.append(dict(p))
                out.append({"pieces": merged, "seconds": round(_length(merged), 3), "score": float(len(ks)),
                            "labels": ["VICTORY", f"{len(ks)} kill(s)"], "matchStart": start, "result": t})
        start = float(r.get("tEnd") or t)
    return out
