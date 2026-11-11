# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 kill montages (user decisions 2026-11-07 and 2026-11-08, data/clip/montage.json): Shorts of 30-45 s (always
20-60 s) built from ALL own kills, streaks first, with the dead time between kills cut out; pieces of different
matches may be joined. (2026-11-07 the montage took streak kills only; the user changed that 2026-11-08: "combine
kills and make a montage. priority given to streaks of course." Short clips stay streak-only.)

plan_montages(hits, ranking, cfg, duration) -> [montage], each {pieces: [{start, end, kills}], seconds, score,
labels, kills, streakKills, singleKills, streaks}. Times are seconds into the recording the hits came from (the H
recording; the V recording of the same session has the same timeline).

1. Kills: own-kill kill-feed lines (cfg.killDetectors, signal true) plus streak medals (detector weight > 0 under
   the approved ranking, clip_rank.detector_weight). A medal with no own kill within medalMatchSec before it
   (a missed feed line) becomes a kill at t - medalLeadSec.
2. Groups: kills and medals no more than chainGapSec apart, never across a streamer death (hard negative). A group
   whose score (medal weights, sumKinds summed) reaches ranking.minScore is a streak ("Triple Kill and up");
   every other group is a run of single kills (no medal, or a medal below minScore).
3. Pieces: [kill - preSec, kill + postSec] per kill, cut before a death (ranking.death); pieces closer than
   joinGapSec merge. A group longer than maxSec stays whole (CL1, D350: nothing is dropped); the montage that holds
   it is split into parts by reel_length.split_reel.
4. Order (selection and playback): streaks by score, best first; then the single-kill groups, most kills first,
   then by time. Each group goes into the first montage it fits in (<= targetMaxSec; an empty montage takes a group
   up to maxSec), so montage 1 holds the best streaks topped up with single kills, and more kills than fit make
   more montages instead of being dropped. Montages still short of targetMinSec join each other inside maxSec; the
   groups of a montage left below minSec are spread over the others while they stay inside maxSec, else dropped.
   Inside a montage the groups play in that order (best streak first); the pieces of one group in time order.
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


def groups(hits, ranking, cfg):
    """([{kills: [t], medals: [...], score, streak}], deaths): every kill group in time order. streak = the group's
    score reaches ranking.minScore."""
    kills, medals = _kill_events(hits, ranking, cfg)
    deaths = rank.death_spans(hits, ranking)
    gap, lead, near = float(cfg["chainGapSec"]), float(cfg["medalLeadSec"]), float(cfg["medalMatchSec"])
    evs = sorted([(t, "kill", None) for t in kills] + [(m["t"], "medal", m) for m in medals], key=lambda e: e[0])
    out, cur, last = [], None, None
    for t, kind, m in evs:
        crossed = last is not None and any(last < ds <= t for ds, _ in deaths)
        if cur is None or t - last > gap or crossed:
            cur = {"kills": [], "medals": []}
            out.append(cur)
        (cur["kills"] if kind == "kill" else cur["medals"]).append(t if kind == "kill" else m)
        last = t
    sum_kinds = set(ranking.get("sumKinds") or [])
    min_score = float(ranking.get("minScore") or 0)
    for g in out:
        for m in g["medals"]:  # a medal with no own-kill line before it (missed feed line) is its own kill
            if not any(m["t"] - near <= k <= m["t"] for k in g["kills"]):
                g["kills"].append(m["t"] - lead)
        g["kills"].sort()
        g["score"] = rank._score(g["medals"], sum_kinds) if g["medals"] else 0.0
        g["streak"] = bool(g["medals"]) and g["score"] >= min_score
    return out, deaths


def streaks(hits, ranking, cfg):
    """[{kills: [t], medals: [...], score}] in time order, qualifying streaks only (short clips and the live clipper
    use streaks only; the montage uses every group, plan_montages)."""
    gs, deaths = groups(hits, ranking, cfg)
    return [g for g in gs if g["streak"]], deaths


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


def _unit_order(u):
    # streaks first, best score first; then single-kill groups, most kills first; ties by time
    return (0, -u["score"], u["start"]) if u["streak"] else (1, -u["kills"], u["start"])


def _new_montage():
    return {"units": [], "seconds": 0.0}


def plan_montages(hits, ranking, cfg, duration):
    gs, deaths = groups(hits, ranking, cfg)
    cap = float(cfg["maxSec"])  # CL1 (D350): the user's maximum for kill montages (reel_length.py); longer ones split
    hi, lo, tmin = min(float(cfg["targetMaxSec"]), cap), min(float(cfg["minSec"]), cap), min(float(cfg["targetMinSec"]), cap)
    units = []
    for g in gs:
        ps = [p for p in _pieces(g["kills"], deaths, ranking, cfg) if p["end"] <= duration]
        if ps:
            units.append({"pieces": ps, "peaks": [float(k) for k in g["kills"]],
                          "medals": [{"t": float(md["t"]), "w": float(md["w"]), "label": md.get("label")} for md in g["medals"]],
                          "score": g["score"] if g["streak"] else 0.0, "streak": g["streak"],
                          "kills": sum(p["kills"] for p in ps), "start": ps[0]["start"], "seconds": _length(ps),
                          "labels": [m["label"] for m in g["medals"]] if g["streak"] else []})
    units.sort(key=_unit_order)
    montages = []
    for u in units:
        home = next((m for m in montages if m["seconds"] + u["seconds"] <= hi), None)
        if home is None:
            home = _new_montage()
            montages.append(home)
        home["units"].append(u)
        home["seconds"] += u["seconds"]
    # montages still short of the target join each other while they stay inside maxSec (the user's 20-60 s bound)
    short = sorted((m for m in montages if m["seconds"] < tmin), key=lambda m: m["seconds"])
    while len(short) > 1 and short[0]["seconds"] + short[1]["seconds"] <= cap:
        a, b = short.pop(0), short.pop(0)
        a["units"] += b["units"]
        a["seconds"] += b["seconds"]
        montages.remove(b)
        if a["seconds"] < tmin:
            short.insert(0, a)
            short.sort(key=lambda m: m["seconds"])
    # a montage still below minSec: its groups top up the others inside maxSec rather than being dropped
    for m in [m for m in montages if m["seconds"] < lo]:
        montages.remove(m)
        for u in m["units"]:
            home = next((x for x in montages if x["seconds"] + u["seconds"] <= cap), None)
            if home is not None:
                home["units"].append(u)
                home["seconds"] += u["seconds"]
    out = []
    for m in montages:
        m["units"].sort(key=_unit_order)
        pieces = [p for u in m["units"] for p in u["pieces"]]
        sk = sum(u["kills"] for u in m["units"] if u["streak"])
        nk = sum(u["kills"] for u in m["units"])
        out.append({"pieces": pieces, "seconds": round(_length(pieces), 3),
                    "peaks": sorted(k for u in m["units"] for k in u["peaks"]),
                    "medals": sorted((md for u in m["units"] for md in u["medals"]), key=lambda x: x["t"]),
                    "score": round(sum(u["score"] for u in m["units"]), 3),
                    "labels": [lb for u in m["units"] for lb in u["labels"]],
                    "kills": nk, "streakKills": sk, "singleKills": nk - sk,
                    "streaks": sum(1 for u in m["units"] if u["streak"])})
    return sorted(out, key=lambda m: (-m["score"], -m["kills"]))


def render_argv(ffmpeg, src, pieces, frame, encoder_args, audio_args, fade_ms, out_name, threads=4, audio_tracks=1, max_sec=None,
                captions=None, fontsdir=None):
    """One ffmpeg run: each piece is its own input (-ss/-t, exact because it is re-encoded), scaled into the frame,
    audio faded in and out by fade_ms (no pop at a hard cut), then concatenated. Every audio track of the source
    (audio_tracks) is kept as its own track, in source order (track 1 = the studio mix); none is dropped or remixed.
    captions (ED2, D353): a bare ASS file name in the working folder, burned over the joined picture with libass;
    fontsdir: a bare folder name next to it holding the caption font (no system font, no path escaping)."""
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
        for k in range(audio_tracks):
            parts.append(f"[{i}:a:{k}]aresample=48000,asetpts=PTS-STARTPTS,afade=t=in:d={fd:.3f},"
                         f"afade=t=out:st={max(0.0, d - fd):.3f}:d={fd:.3f}[a{i}_{k}]")
    ins = "".join(f"[v{i}]" + "".join(f"[a{i}_{k}]" for k in range(audio_tracks)) for i in range(len(pieces)))
    outs = ("[vcat]" if captions else "[vout]") + "".join(f"[aout{k}]" for k in range(audio_tracks))
    parts.append(ins + f"concat=n={len(pieces)}:v=1:a={audio_tracks}{outs}")
    if captions:
        parts.append(f"[vcat]subtitles={captions}" + (f":fontsdir={fontsdir}" if fontsdir else "") + "[vout]")
    maps = ["-map", "[vout]"] + [x for k in range(audio_tracks) for x in ("-map", f"[aout{k}]")]
    # CL1 (D350): nothing here adds time (no transition, pad, crossfade or hold: a hard concat, fades inside the pieces);
    # the fps filter can round a piece by up to one frame, so the output is also cut at the type's maximum.
    cap = ["-t", f"{float(max_sec):.3f}"] if max_sec else []
    argv += ["-filter_complex", ";".join(parts), *maps, *encoder_args, *audio_args, *cap,
             "-movflags", "+faststart", "-f", "mp4", out_name]
    return argv


def _round_edges(mt):
    """Round boundaries of a match as match_gate.segment counts roundKills: start, each round banner's end, the
    first end-screen hit."""
    end = mt.get("endScreenAt")
    end = float(end if end is not None else mt["end"])
    return [float(mt["start"])] + [float(r["tEnd"]) for r in mt.get("rounds") or []] + [end]


def match_reels(hits, ranking, cfg, matches, duration=None):
    """Match highlights (D237 pieces, D315 selection): for each match of `matches` (match_gate.segment) whose
    `reel` decision (match_gate.reel_decide) qualifies, every own kill of that match (the kill rule of step 1, streak
    or not), each [kill - preSec, kill + postSec] cut before a death, plus the result screen; no 60 s cap. Kills
    count from the match start to its result screen (the signalled W1 box, else the first end-screen hit). A
    qualifying match with no own kill gives no reel (m["reel"]["noReel"] says so). Pieces end at `duration` (the
    shorter of the H and V recordings) when it is given. D326: the kills are the match's counted own kills
    (m["ownKillTimes"], or only the rounds in m["reel"]["pieceRounds"], each piece clipped to its round), plus streak
    medals with no counted kill of the match before them; the death detectors of ranking.json (KILLCAM, spectating)
    cut every piece."""
    hit_kills, medals = _kill_events(hits, ranking, cfg)
    near, lead = float(cfg["medalMatchSec"]), float(cfg["medalLeadSec"])
    deaths = rank.death_spans(hits, ranking)
    out = []
    for mt in matches:
        dec = mt.get("reel") or {}
        if not dec.get("qualifies"):
            continue
        t = mt.get("resultAt")
        t = float(t if t is not None else mt.get("endScreenAt", mt["end"]))
        start = float(mt["start"])
        # D326: the match's counted own kills (match_gate.segment: the feed of the match's HUD family, nothing read
        # while spectating), not every signalled kill-feed hit: on the 2026-11-09 practice the BR feed read the
        # own name in a weapon's custom name on the MP loadout panel (pre-round and while dead), and those pieces
        # showed loadout swaps, round intros and a spectated teammate. Runs without counted times use the hits.
        own = mt.get("ownKillTimes")
        kills = [float(k) for k in own] if isinstance(own, list) else list(hit_kills)
        # a medal with no own-kill line before it is its own kill (as in streaks); matched against every counted kill
        # of the match, before any round selection (Codex review: a medal right after a qualifying round's end
        # matched only that round's kills and made a piece inside it)
        extra = [m["t"] for m in medals if not any(m["t"] - near <= k <= m["t"] for k in kills)]
        rounds = dec.get("pieceRounds")
        result_start = t - float(cfg["resultLeadSec"])
        if isinstance(rounds, list) and isinstance(mt.get("roundKillTimes"), list):
            # only the qualifying rounds; each piece stays inside its round (a kill near a round's end shows neither
            # the next round's intro nor the previous round). A medal's fallback kill belongs to the medal's round.
            edges, rkt = _round_edges(mt), mt["roundKillTimes"]
            ps, found = [], False
            for i in sorted(set(rounds)):
                if i >= len(rkt) or i + 1 >= len(edges):
                    continue
                a, b = edges[i], edges[i + 1]
                ks = sorted([float(k) for k in rkt[i]] + [m - lead for m in extra if a <= m < b])
                found = found or bool(ks)
                for p in _pieces(ks, deaths, ranking, cfg):
                    s, e = max(p["start"], a), min(p["end"], b)
                    if e > s:
                        ps.append(dict(p, start=round(s, 3), end=round(e, 3)))
            if len(edges) - 2 not in rounds:  # the result piece shows none of a last round that does not qualify
                result_start = max(result_start, edges[-1])
            if not found:
                dec["noReel"] = "no own kill in the match"
                continue
        else:
            ks = sorted(k for k in kills + [m - lead for m in extra] if start < k <= t)
            if not ks:
                dec["noReel"] = "no own kill in the match"
                continue
            ps = _pieces(ks, deaths, ranking, cfg)
        if duration is not None:
            ps = [dict(p, end=min(p["end"], float(duration))) for p in ps]
        end = float(mt.get("resultEnd") or t) + float(cfg["resultHoldSec"])
        if duration is not None:
            end = min(end, float(duration))
        ps.append({"start": round(result_start, 3), "end": round(end, 3), "kills": 0})
        ps.sort(key=lambda p: p["start"])
        merged = []
        for p in ps:  # the result piece may overlap the last kill piece
            if merged and p["start"] <= merged[-1]["end"]:
                merged[-1] = dict(merged[-1], end=max(merged[-1]["end"], p["end"]),
                                  kills=merged[-1]["kills"] + p["kills"])
            else:
                merged.append(dict(p))
        n = sum(p["kills"] for p in merged)  # kills whose piece survived the death cuts
        if not n:
            dec["noReel"] = "no own kill outside a death or spectating span"
            continue
        rules = [r["id"] for r in dec.get("rules", []) if r.get("outcome") == "pass"]
        out.append({"pieces": merged, "seconds": round(_length(merged), 3), "score": float(n),
                    "labels": [mt.get("result") or "MATCH", f"{n} kill(s)"], "matchStart": start, "result": t,
                    "peaks": sorted(set(round(k, 3) for k in kills)),
                    "medals": [{"t": m["t"], "w": m["w"], "label": m.get("label")} for m in medals if start < m["t"] <= end],
                    "match": mt.get("index"), "rules": rules, "kills": n,
                    "pieceRounds": dec.get("pieceRounds")})
    return out


def impact_play_reels(hits, matches, spec, duration=None, sample_sec=1.0, min_sec=None):
    """Impact-play reels (D326, user feedback F4 2026-11-10: "if there was an impact play by the streamer, create it as
    a separate reel with MVP animation, Impact play cam and up to the results page"). spec: match-reels.json
    `impactPlay` (game pack data). For each match whose end was seen and whose end screens hold a signalled
    spec.detector hit (the IMPACT PLAY screen with the profile name on its card, M2 in CODM), one piece: from
    the end of the match-end result banner's span (the MVP animation follows it) when that banner ends no
    more than maxBannerLeadSec before the impact play, else fallbackLeadSec before the impact play; to endHoldSec
    after the last signalled spec.resultsDetector hit (the results page, C2 in CODM) read from the match's first
    end-screen hit to resultsAfterSec after its last, else after the match's last end-screen hit. The result banner's
    span ends one detector sample (sample_sec, 1/fps of the detector pass) after its last read frame: the frames
    sampled at the banner's last read still show it (2026-11-09 practice: read to 2770 s, on screen at 2771.5 s, MVP
    animation at 2772.5 s); the reel starts there, not at a fixed offset (coordinator, 2026-11-10). At most maxSec
    long; a piece shorter than minSec is no reel (min_sec overrides the spec's minSec: CL1 reel-length settings; the
    maximum length is applied afterwards by reel_length.split_reel, which trims around the impact play). Pieces end at `duration` when it is given. m["impactPlay"] records
    the decision. -> [reel] shaped like match_reels (kills 0)."""
    if not spec:
        return []
    det, res = spec["detector"], spec.get("resultsDetector")
    after, max_lead = float(sample_sec), float(spec["maxBannerLeadSec"])
    fallback, hold = float(spec["fallbackLeadSec"]), float(spec["endHoldSec"])
    res_after, max_sec = float(spec["resultsAfterSec"]), float(spec["maxSec"])
    min_sec = float(spec["minSec"] if min_sec is None else min_sec)
    out = []
    for mt in matches:
        if not mt.get("endSeen") or mt.get("endScreenAt") is None:
            continue
        a0, a1 = float(mt["endScreenAt"]), float(mt["end"])
        own = sorted((h for h in hits if h.get("detector") == det and h.get("signal") is True
                      and a0 <= float(h["t"]) <= a1), key=lambda h: float(h["t"]))
        if not own:
            continue
        ip = float(own[0]["t"])
        banner = mt.get("resultEnd")
        if banner is not None and ip - max_lead <= float(banner) <= ip:
            s, how = float(banner) + after, "at the end of the result banner's span"
        else:
            s, how = ip - fallback, "before the impact play (no result banner just before it)"
        ends = [float(h.get("tEnd", h["t"])) for h in hits if res and h.get("detector") == res
                and h.get("signal") is True and a0 <= float(h["t"]) <= a1 + res_after]
        e = (max(ends) if ends else max(a1, float(own[-1].get("tEnd", own[-1]["t"])))) + hold
        s = max(0.0, s)
        e = min(e, s + max_sec)
        if duration is not None:
            e = min(e, float(duration))
        if e - s < min_sec:
            mt["impactPlay"] = {"at": round(ip, 3), "noReel": f"piece {e - s:.1f} s is shorter than {min_sec:g} s"}
            continue
        mt["impactPlay"] = {"at": round(ip, 3), "start": round(s, 3), "end": round(e, 3), "startRule": how,
                            "resultsPage": bool(ends)}
        out.append({"pieces": [{"start": round(s, 3), "end": round(e, 3), "kills": 0}], "seconds": round(e - s, 3),
                    "score": 0.0, "labels": [mt.get("result") or "MATCH", "IMPACT PLAY"],
                    "matchStart": float(mt["start"]), "result": ip, "match": mt.get("index"),
                    "rules": [spec.get("id") or "impact-play"], "kills": 0, "peaks": [round(ip, 3)],
                    "medals": [{"t": round(ip, 3), "w": 1.0, "label": "IMPACT PLAY", "kill": False}]})
    return out
