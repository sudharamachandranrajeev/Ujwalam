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
   (a missed feed line) becomes a kill at t - medalLeadSec. A spec "DET:Label" takes one label of a detector (BR:
   B2 "ELIMINATED", the own HUD text). Actions (cfg.actionDetectors, e.g. a BR knock) get a piece but count no kill.
2. Groups: kills, actions and medals no more than chainGapSec apart (chainGapSecByMode for the hit's game mode, e.g.
   BR chains are slower), never across a streamer death (hard negative); a group needs a kill. A group
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


def _specs(items):
    """Detector specs of montage.json: "M5" (every label of the detector) or "B2:ELIMINATED" (one label, any case)."""
    out = set()
    for s in items or []:
        det, _, label = str(s).partition(":")
        out.add((det, label.strip().upper() or None))
    return out


def _is(h, specs):
    return (h["detector"], None) in specs or (h["detector"], str(h.get("label") or "").strip().upper()) in specs


def _events(hits, ranking, cfg):
    """Own kills (cfg.killDetectors), actions (cfg.actionDetectors: moments worth showing that are no kill, e.g. a BR
    knock) and medals (detector weight > 0), each with signal true, in time order: [{t, kind, mode, medal?}]."""
    approved = ranking.get("detectorWeightsStatus") == "approved"
    dw = ranking.get("detectorWeights") or {}
    kd, ad = _specs(cfg.get("killDetectors")), _specs(cfg.get("actionDetectors"))
    out = []
    for h in hits:
        t, mode = float(h["t"]), h.get("mode")
        if h.get("signal") is True and _is(h, kd):
            out.append({"t": t, "kind": "kill", "mode": mode})
        elif h.get("signal") is True and _is(h, ad):
            out.append({"t": t, "kind": "action", "mode": mode})
        w, _ = rank.detector_weight(h, dw, approved)
        if w > 0:
            out.append({"t": t, "kind": "medal", "mode": mode,
                        "medal": {"t": t, "w": w, "strength": 1.0, "kind": f"detector.{h['detector']}",
                                  "label": h.get("label") or h["detector"]}})
    return sorted(out, key=lambda e: e["t"])


def _kill_events(hits, ranking, cfg):
    evs = _events(hits, ranking, cfg)
    return [e["t"] for e in evs if e["kind"] == "kill"], [e["medal"] for e in evs if e["kind"] == "medal"]


def groups(hits, ranking, cfg, bounds=()):
    """([{kills: [t], actions: [t], medals: [...], score, streak}], deaths): every kill group in time order. Kills,
    actions and medals no more than the chain gap apart (chainGapSecByMode for the event's game mode, else
    chainGapSec) form one group, never across a death; a group with actions only (a knock nobody finished) is no kill
    group. bounds: times no group spans (match starts and end screens, _bounds). streak = the group's score reaches
    ranking.minScore."""
    evs = _events(hits, ranking, cfg)
    deaths = rank.death_spans(hits, ranking)
    gap0, lead, near = float(cfg["chainGapSec"]), float(cfg["medalLeadSec"]), float(cfg["medalMatchSec"])
    by_mode = cfg.get("chainGapSecByMode") or {}
    out, cur, last = [], None, None
    for e in evs:
        t = e["t"]
        gap = float(by_mode.get(e["mode"], gap0)) if e["mode"] else gap0
        crossed = last is not None and (any(last < ds <= t for ds, _ in deaths) or any(last < b <= t for b in bounds))
        if cur is None or t - last > gap or crossed:
            cur = {"kills": [], "actions": [], "medals": []}
            out.append(cur)
        if e["kind"] == "medal":
            cur["medals"].append(e["medal"])
        else:
            cur["kills" if e["kind"] == "kill" else "actions"].append(t)
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
    return [g for g in out if g["kills"]], deaths


def streaks(hits, ranking, cfg):
    """[{kills: [t], medals: [...], score}] in time order, qualifying streaks only (short clips and the live clipper
    use streaks only; the montage uses every group, plan_montages)."""
    gs, deaths = groups(hits, ranking, cfg)
    return [g for g in gs if g["streak"]], deaths


def _pieces(kill_ts, deaths, ranking, cfg, actions=()):
    """[kill - preSec, kill + postSec] per kill and per action (an action adds no kill), cut before deaths, pieces
    closer than joinGapSec merged."""
    pre, post, join = float(cfg["preSec"]), float(cfg["postSec"]), float(cfg["joinGapSec"])
    raw = []
    for k, n in [(k, 1) for k in kill_ts] + [(x, 0) for x in actions]:
        r = rank._cut_deaths(max(0.0, k - pre), k + post, k, deaths, ranking)
        if r and r[1] > k:
            raw.append([r[0], r[1], n])
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


def groups_in(gs, w0, w1):
    """The kill groups with a kill or medal inside [w0, w1]."""
    return [g for g in gs if any(w0 <= t <= w1 for t in g["kills"] + [m["t"] for m in g["medals"]])]


def live_clip_pieces(sel, deaths, ranking, cfg, min_sec, lo=0.0, hi=None):
    """CL2 (triage F2, 2026-11-11 BR short): the pieces of a live clip from the kill groups `sel` in its live window
    (groups_in; the live window starts preSec before the first medal and missed the earlier kills of a BR chain).
    Every kill and action piece of those groups, also before the window; the dead time between them is cut. A total
    below min_sec grows the first piece earlier, then the last one later, never into a death and never outside
    [lo, hi] (the save file's span, or after the previous clip). [] when nothing is left."""
    raw = sorted((p for g in sel for p in _pieces(g["kills"], deaths, ranking, cfg, g["actions"])),
                 key=lambda p: p["start"])
    ps = []
    for p in raw:
        s, e = max(p["start"], lo), min(p["end"], hi) if hi is not None else p["end"]
        if e <= s:
            continue
        if ps and s <= ps[-1]["end"]:
            ps[-1] = dict(ps[-1], end=max(ps[-1]["end"], e), kills=ps[-1]["kills"] + p["kills"])
        else:
            ps.append({"start": s, "end": e, "kills": p["kills"]})
    if not ps:
        return []
    need = float(min_sec) - _length(ps)
    if need > 0:  # earlier first: the build-up before the first kill, not the running after the last
        r = rank._cut_deaths(max(lo, ps[0]["start"] - need), ps[0]["end"], ps[0]["start"], deaths, ranking)
        if r:
            need -= ps[0]["start"] - r[0]
            ps[0] = dict(ps[0], start=r[0])
    if need > 0:
        end = ps[-1]["end"] + need
        r = rank._cut_deaths(ps[-1]["start"], min(end, hi) if hi is not None else end, ps[-1]["end"], deaths, ranking)
        if r:
            ps[-1] = dict(ps[-1], end=max(ps[-1]["end"], r[1]))
    return [dict(p, start=round(p["start"], 3), end=round(p["end"], 3)) for p in ps]


def drop_end_screens(hits, matches):
    """Triage F1 (2026-11-11 montage): hits read on a match's end screens (from its endScreenAt to the match end:
    result banner, MVP and summary screens) are no kills. Kill-feed and medal reads there put the victory screens of
    several matches into one montage."""
    spans = [(float(m["endScreenAt"]), float(m["end"])) for m in matches or [] if m.get("endScreenAt") is not None]
    return [h for h in hits if not any(a <= float(h["t"]) < b for a, b in spans)] if spans else list(hits)


def _match_of(t, matches):
    return next((m for m in matches or [] if float(m["start"]) <= t < float(m["end"])), None)


def _bounds(matches):
    """Times a kill group never spans: each match's start and its end screen."""
    out = set()
    for m in matches or []:
        out.add(float(m["start"]))
        if m.get("endScreenAt") is not None:
            out.add(float(m["endScreenAt"]))
    return sorted(out)


def _play_span(t, matches, duration):
    """(start, stop) of the gameplay around t: its match's start to its end screen (else the match end)."""
    mt = _match_of(t, matches)
    if not mt:
        return 0.0, float(duration)
    stop = mt.get("endScreenAt")
    return float(mt["start"]), float(stop if stop is not None else mt["end"])


def _units(gs, deaths, ranking, cfg, duration, matches=None):
    """One unit per kill group: its pieces (inside its match's gameplay: never before the match start or into its end
    screen), peaks, medals, score, match."""
    units = []
    for g in gs:
        mt = _match_of(g["kills"][0], matches)
        a, b = _play_span(g["kills"][0], matches, duration)
        ps = []
        for p in _pieces(g["kills"], deaths, ranking, cfg, g["actions"]):
            p = dict(p, start=round(max(p["start"], a), 3), end=round(min(p["end"], b), 3))
            if p["end"] <= duration and p["end"] > p["start"]:
                ps.append(p)
        if ps:
            units.append({"pieces": ps, "peaks": [float(k) for k in g["kills"]],
                          "medals": [{"t": float(md["t"]), "w": float(md["w"]), "label": md.get("label")} for md in g["medals"]],
                          "score": g["score"] if g["streak"] else 0.0, "streak": g["streak"],
                          "kills": sum(p["kills"] for p in ps), "start": ps[0]["start"], "seconds": _length(ps),
                          "labels": [m["label"] for m in g["medals"]] if g["streak"] else [],
                          "match": mt.get("index") if mt else None, "mode": mt.get("mode") if mt else None, "span": (a, b)})
    return units


def _unit_order(u):
    # streaks first, best score first; then single-kill groups, most kills first; ties by time
    return (0, -u["score"], u["start"]) if u["streak"] else (1, -u["kills"], u["start"])


def _new_montage():
    return {"units": [], "seconds": 0.0}


def plan_montages(hits, ranking, cfg, duration, matches=None):
    """matches (match_gate.segment): hits on their end screens are dropped and pieces end before them (triage F1)."""
    gs, deaths = groups(drop_end_screens(hits, matches), ranking, cfg, _bounds(matches))
    cap = float(cfg["maxSec"])  # CL1 (D350): the user's maximum for kill montages (reel_length.py); longer ones split
    hi, lo, tmin = min(float(cfg["targetMaxSec"]), cap), min(float(cfg["minSec"]), cap), min(float(cfg["targetMinSec"]), cap)
    units = _units(gs, deaths, ranking, cfg, duration, matches)
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


def _strength(u, t, window):
    # as reel_hook._moments: own kills in [t - window, t] plus the medal weight in [t, t + window]
    return (sum(1 for k in u["peaks"] if t - window <= k <= t)
            + sum(m["w"] for m in u["medals"] if t <= m["t"] <= t + window))


def _result_piece(mt, cfg, duration):
    t = next((float(x) for x in (mt.get("resultAt"), mt.get("endScreenAt"), mt["end"]) if x is not None))
    end = float(mt.get("resultEnd") or t) + float(cfg["resultHoldSec"])
    end = min(end, float(mt["end"]), float(duration))
    s = max(0.0, float(mt["start"]), t - float(cfg["resultLeadSec"]))
    return {"start": round(s, 3), "end": round(end, 3), "kills": 0, "result": True} if end > s else None


def plan_story_montages(hits, ranking, cfg, duration, matches, avoid=()):
    """RP2 (D361, user 2026-11-12): montages that tell a story, behind the flag montage-story.

    Part 1, before the title: a fast cut of the strongest kill moments (cfg.story.hookCuts cuts of hookLeadSec before
    and hookTailSec after the kill), from this montage's own kills or kills no montage uses, never one already in
    another montage's opening. Part 2, after the title (titleAt): one match in time order, its kills with the dead time
    cut; when it has too few, the best kills of other matches top it up after it (in time order). The story match's
    result screen ends the montage only when nothing from another match follows and the match qualifies for a reel
    (won or top 3) and the montage holds the match's last kills (a match told over several montages shows its result
    once, at the end); no other result screen ever plays. avoid: [(start, end)] recording spans used by other videos of the
    session (the live clips); a kill group inside one is used only when the montage cannot be made without it. Each
    kill group is used by one montage only."""
    st = cfg["story"]
    gs, deaths = groups(drop_end_screens(hits, matches), ranking, cfg, _bounds(matches))
    pool = sorted(_units(gs, deaths, ranking, cfg, duration, matches), key=lambda u: u["start"])
    for u in pool:
        u["elsewhere"] = any(p["start"] < b and a < p["end"] for p in u["pieces"] for a, b in avoid)
    cap = float(cfg["maxSec"])
    hi, lo, tmin = min(float(cfg["targetMaxSec"]), cap), min(float(cfg["minSec"]), cap), min(float(cfg["targetMinSec"]), cap)
    hook_room = float(st["hookMaxSec"])
    by_index = {m.get("index"): m for m in matches or []}
    plans, unused_units = [], []
    while pool:
        by = {}
        for u in pool:
            by.setdefault(u["match"], []).append(u)
        free = {k: sum(u["seconds"] for u in us if not u["elsewhere"]) for k, us in by.items()}
        mid = min(by, key=lambda k: (-free[k], -sum(u["seconds"] for u in by[k]), str(k)))
        room, want = hi - hook_room, tmin - hook_room
        mine = by[mid]
        cand = [u for u in mine if not u["elsewhere"]]
        if _length([p for u in cand for p in u["pieces"]]) < want:
            cand = mine
        body, total = [], 0.0
        for u in cand:  # time order
            if not body or total + u["seconds"] <= room:
                body.append(u)
                total += u["seconds"]
        tops = []
        if total < want:
            for u in sorted((u for u in pool if u["match"] != mid), key=lambda u: (u["elsewhere"], _unit_order(u))):
                if total >= want:
                    break
                if total + u["seconds"] <= room:
                    tops.append(u)
                    total += u["seconds"]
            tops.sort(key=lambda u: u["start"])
        for u in body + tops:
            pool.remove(u)
        mt = by_index.get(mid)
        result = None
        # the result screen once per match: on the montage that holds the match's last kills (its story's end)
        if not tops and mt and (mt.get("reel") or {}).get("qualifies") and not any(u["match"] == mid for u in pool):
            r = _result_piece(mt, cfg, duration)
            if r:  # never before the last kill piece (it may overlap it)
                r = dict(r, start=max(r["start"], body[-1]["pieces"][-1]["end"]))
            if r and r["end"] > r["start"] and total + hook_room + (r["end"] - r["start"]) <= cap:
                result = r
        if total + (result["end"] - result["start"] if result else 0.0) < lo - hook_room:
            unused_units += body + tops  # too short even with the opening: these kills stay for other videos
            break
        plans.append({"match": mid, "body": body, "tops": tops, "result": result})
    unused_units += pool
    # part 1: the openings, best montage first; a moment opens one montage only
    window = float(st["windowSec"])
    lead, tail, n_cuts = float(st["hookLeadSec"]), float(st["hookTailSec"]), int(st["hookCuts"])
    spare = [(u, t) for u in unused_units for t in u["peaks"]]
    taken = set()
    out = []
    for pl in sorted(plans, key=lambda p: -sum(u["score"] for u in p["body"] + p["tops"])):
        own = [(u, t) for u in pl["body"] + pl["tops"] for t in u["peaks"]]
        moments = sorted(own + [x for x in spare if x[1] not in taken], key=lambda x: (-_strength(x[0], x[1], window), x[1]))
        hook = []
        for u, t in moments:
            if len(hook) == n_cuts:
                break
            if any(abs(t - h["at"]) < lead + tail for h in hook):
                continue
            a, b = u["span"]  # inside the moment's own match gameplay: never a result screen
            r = rank._cut_deaths(max(0.0, a, t - lead), min(t + tail, b, float(duration)), t, deaths, ranking)
            if r and r[1] > t:
                hook.append({"start": round(r[0], 3), "end": round(r[1], 3), "kills": 0, "hook": True, "teaser": True, "at": t})
        taken.update(h["at"] for h in hook)
        units = pl["body"] + pl["tops"]
        hook_sec = round(_length(hook), 3)
        pieces = [{k: v for k, v in h.items() if k != "at"} for h in hook] + [p for u in units for p in u["pieces"]]
        if pl["result"]:
            pieces.append(pl["result"])
        sk = sum(u["kills"] for u in units if u["streak"])
        nk = sum(u["kills"] for u in units)
        mt = by_index.get(pl["match"]) or {}
        out.append({"pieces": pieces, "seconds": round(_length(pieces), 3),
                    "peaks": sorted(k for u in units for k in u["peaks"]),
                    "medals": sorted((md for u in units for md in u["medals"]), key=lambda x: x["t"]),
                    "score": round(sum(u["score"] for u in units), 3),
                    "labels": [lb for u in units for lb in u["labels"]],
                    "kills": nk, "streakKills": sk, "singleKills": nk - sk,
                    "streaks": sum(1 for u in units if u["streak"]),
                    "story": {"match": pl["match"], "mode": mt.get("mode"), "result": mt.get("result") if pl["result"] else None,
                              "topUps": sorted({u["match"] for u in pl["tops"]}, key=str), "hookSec": hook_sec,
                              "titleAt": hook_sec, "hookMoments": [h["at"] for h in hook],
                              "usedElsewhere": sum(1 for u in units if u["elsewhere"])}})
    return sorted(out, key=lambda m: (-m["score"], -m["kills"]))


def crossfade_sec(pieces, transition):
    """RP1: the overlap of each join in seconds, or 0.0 for a hard cut. transition: {"xfade": ffmpeg kind, "ms"} or
    None/cut. Never more than half the shortest piece (xfade needs the overlap inside both pieces)."""
    if not transition or not transition.get("xfade") or len(pieces) < 2:
        return 0.0
    shortest = min(p["end"] - p["start"] for p in pieces)
    return round(min(float(transition["ms"]) / 1000.0, shortest / 2.0), 3)


def render_argv(ffmpeg, src, pieces, frame, encoder_args, audio_args, fade_ms, out_name, threads=4, audio_tracks=1, max_sec=None,
                captions=None, fontsdir=None, transition=None, thumbnail=None, title=None):
    """One ffmpeg run: each piece is its own input (-ss/-t, exact because it is re-encoded), scaled into the frame,
    audio faded in and out by fade_ms (no pop at a hard cut), then concatenated. Every audio track of the source
    (audio_tracks) is kept as its own track, in source order (track 1 = the studio mix); none is dropped or remixed.
    captions (ED2, D353): a bare ASS file name in the working folder, burned over the joined picture with libass;
    fontsdir: a bare folder name next to it holding the caption font (no system font, no path escaping).
    audio_tracks=0: a source without audio renders picture only (no audio filters, maps or audio encoder).
    transition (RP1): {"xfade", "ms"} cross-fades each join (see crossfade_sec); None = hard cut.
    thumbnail (RP6): a bare PNG name in the working folder shown as the reel's first frame (one frame, 1/60 s); the
    sound starts one frame later.
    title (RP4): reel_title.prepare() dict; for title.start..end the joined picture is replaced by a blurred, darkened
    copy of itself carrying the title text, faded in and out (the sound is not touched)."""
    ow, oh = int(frame["width"]), int(frame["height"])
    fd = fade_ms / 1000.0
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", str(threads), "-filter_threads", "2"]
    for p in pieces:
        argv += ["-ss", f"{p['start']:.3f}", "-t", f"{p['end'] - p['start']:.3f}", "-i", src]
    parts = []
    xd = crossfade_sec(pieces, transition)
    for i, p in enumerate(pieces):
        d = p["end"] - p["start"]
        parts.append(f"[{i}:v]scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos,"
                     f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p,setpts=PTS-STARTPTS[v{i}]")
        # hard cut: every piece fades in and out (no pop); crossfade: only the reel's own start and end (the joins
        # are the acrossfade)
        af = ["aresample=48000", "asetpts=PTS-STARTPTS"]
        if not xd or i == 0:
            af.append(f"afade=t=in:d={fd:.3f}")
        if not xd or i == len(pieces) - 1:
            af.append(f"afade=t=out:st={max(0.0, d - fd):.3f}:d={fd:.3f}")
        for k in range(audio_tracks):
            parts.append(f"[{i}:a:{k}]{','.join(af)}[a{i}_{k}]")
    vlast = "[vcat]" if captions or thumbnail else "[vout]"
    vfinal = vlast
    if title:
        vlast = "[vjoin]"
    alast = "ab" if thumbnail else "aout"  # RP6: the sound is delayed by the thumbnail frame
    if xd:  # RP1: each join overlaps the pieces by xd seconds (picture xfade, audio acrossfade per track)
        n, acc = len(pieces), 0.0
        for i in range(1, n):
            acc += pieces[i - 1]["end"] - pieces[i - 1]["start"]
            vin = "[v0]" if i == 1 else f"[vx{i - 1}]"
            vout = vlast if i == n - 1 else f"[vx{i}]"
            parts.append(f"{vin}[v{i}]xfade=transition={transition['xfade']}:duration={xd:.3f}:offset={acc - i * xd:.3f}{vout}")
            for k in range(audio_tracks):
                ain = f"[a0_{k}]" if i == 1 else f"[ax{i - 1}_{k}]"
                aout = f"[{alast}{k}]" if i == n - 1 else f"[ax{i}_{k}]"
                parts.append(f"{ain}[a{i}_{k}]acrossfade=d={xd:.3f}:c1=tri:c2=tri{aout}")
    else:
        ins = "".join(f"[v{i}]" + "".join(f"[a{i}_{k}]" for k in range(audio_tracks)) for i in range(len(pieces)))
        outs = vlast + "".join(f"[{alast}{k}]" for k in range(audio_tracks))
        parts.append(ins + f"concat=n={len(pieces)}:v=1:a={audio_tracks}{outs}")
    if title:  # RP4: blurred, darkened copy of the reel with the title, faded in/out, over the reel for its window
        s, e = float(title["start"]), float(title["end"])
        fi, fo = title["fadeInMs"] / 1000.0, title["fadeOutMs"] / 1000.0
        b = title["blur"]
        parts.append("[vjoin]split=2[tmain][ttit]")
        parts.append(f"[ttit]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS+{s:.3f}/TB,"
                     f"gblur=sigma={float(b['sigma']):g}:steps={int(b['steps'])},"
                     f"lutyuv=y=val*{title['darken']:g},"
                     f"drawtext=fontfile={title['fontFile']}:textfile={title['textFile']}:expansion=none:"
                     f"fontsize={title['size']}:fontcolor={title['colour']}:borderw={title['border']}:bordercolor=0x000000@0.85:"
                     f"x={title['left']}+({title['safeWidth']}-text_w)/2:y=(h-text_h)/2,"
                     f"format=yuva420p,fade=t=in:st={s:.3f}:d={fi:.3f}:alpha=1,fade=t=out:st={e - fo:.3f}:d={fo:.3f}:alpha=1[tov]")
        parts.append(f"[tmain][tov]overlay=eof_action=pass:enable='between(t,{s:.3f},{e:.3f})'{vfinal}")
    if captions:
        parts.append(f"[vcat]subtitles={captions}" + (f":fontsdir={fontsdir}" if fontsdir else "")
                     + ("[vcap]" if thumbnail else "[vout]"))
    if thumbnail:  # RP6 (D366): one still frame in front of the reel (after the captions, so none lands on it)
        ti = len(pieces)
        argv += ["-loop", "1", "-framerate", "60", "-t", f"{1 / 60:.6f}", "-i", thumbnail]
        parts.append(f"[{ti}:v]scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos,"
                     f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p,trim=end_frame=1,"
                     f"setpts=PTS-STARTPTS[vth]")
        parts.append(f"[vth]{'[vcap]' if captions else '[vcat]'}concat=n=2:v=1:a=0[vout]")
        for k in range(audio_tracks):  # 800 samples at 48 kHz = one frame at 60 fps
            parts.append(f"[ab{k}]adelay=delays=800S:all=1[aout{k}]")
    maps = ["-map", "[vout]"] + [x for k in range(audio_tracks) for x in ("-map", f"[aout{k}]")]
    # CL1 (D350): nothing here adds time (no pad or hold; a crossfade only shortens: each join overlaps by xd); the fps
    # filter can round a piece by up to one frame, so the output is also cut at the type's maximum.
    cap = ["-t", f"{float(max_sec):.3f}"] if max_sec else []
    argv += ["-filter_complex", ";".join(parts), *maps, *encoder_args, *(audio_args if audio_tracks else ["-an"]), *cap,
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
