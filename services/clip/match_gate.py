# SPDX-License-Identifier: GPL-3.0-or-later
"""Match gate (D286 proposed): clips only from matches worth it.

User, 2026-11-08: "extract the total kills the streamer took at the end of the match from the end screens; if it is a
high amount, or the player is in the top 3 of the winning or losing team, the clips of that match are processed."

Stdlib only (g1_text), so the clipper can gate without the OCR venv. Four parts:

  read     S1 "Match stats" (game pack detector, role context): per OCR'd frame, the MP top-3 screen (per card: rank
           from the card position, score, whether it is the streamer's card by the profile-name rule nameMin) and
           the full MP scoreboard (own row kills; UNVERIFIED, no frame yet). Readings carry ranks, scores and an
           own flag only: never a name.
  count    KillCounter: own kill-feed lines (M5 / B1 with the profile name as killer) deduplicated across
           consecutive frames (one line stays on screen for several sampled frames). The victim text is used in
           memory only, as a key, and never written.
  segment  matches from end screens: end-screen hits (S1, W1, M1, M2, K1 per the pack) closer than endGapSec form
           one match end; a match runs from the previous match end (or the file start) to its end. The part after
           the last end screen is a match with no end seen (the recording stopped mid-match).
  gate     a match passes when its own rank on the top-3 screen is 1-3 (top3 on) or its own kills reach minKills
           (minKills not null). A match whose end was not seen, or whose end screens were not read, keeps its clips.
  reels    D315: reel_decide() applies the pack's match-reels.json rules (result, place, mode, own kills, kills per
           round); a match gets a reel when any rule passes. Unlike the gate, an unread signal never passes: the
           rule is inert. clip_montage.match_reels() cuts the reels of the qualifying matches.

Settings: <data>/settings.json clips.matchGate {"top3": bool, "minKills": int 1..200 | null}
(clip_common.match_gate_settings). Game-specific values (score pattern, kills headers, mode names, end-screen
detectors, end gap, kill-line hold) live in the pack: detectors.json S1 `stats`.
"""

from __future__ import annotations

import difflib
import json
import re
from collections import Counter

import g1_text as gt

RANK_ROI = re.compile(r"^rank([1-9])_card$")
MATCHES = "matches.json"
STATS = "match-stats.json"
TOOL_VERSION = 1


# ---------------------------------------------------------------- pack

def s1_detector(pack):
    """The pack's S1 detector, or None when the pack has none (then nothing is read and every match is kept)."""
    return next((d for d in pack.get("detectors", []) if d.get("id") == "S1"), None)


def stats_config(pack):
    """S1 `stats` with defaults for missing keys. Values are the pack's (status in the pack)."""
    d = s1_detector(pack) or {}
    st = dict(d.get("stats") or {})
    st.setdefault("scoreRegex", r"^SC[O0]RE(\d{1,5})$")
    st.setdefault("killsHeaders", [])
    st.setdefault("modeNames", [])
    st.setdefault("endScreenDetectors", ["S1", "W1"])
    st.setdefault("endGapSec", 90)
    st.setdefault("killLineHoldSec", 6)
    st.setdefault("victimMatchMin", 0.7)
    w1 = next((d for d in pack.get("detectors", []) if d.get("id") == "W1"), None) or {}
    st["banner"] = dict(w1.get("banner") or {})
    c1 = next((d for d in pack.get("detectors", []) if d.get("id") == "C1"), None) or {}
    st["modeCues"] = list(c1.get("cues") or [])
    return st


# ---------------------------------------------------------------- banner (round end vs match end)

def banner_kind(g, banner):
    """Kind of a VICTORY/DEFEAT banner from its word box g (game fractions) -> "round" | "match" | None.
    The pack's W1 `banner.kinds` give the centre-y range of the word per kind (round banners: thin bar high on the
    screen; match-end banners: large emblem lower down)."""
    if not g or not banner:
        return None
    cy = (g[1] + g[3]) / 2
    for k in banner.get("kinds") or []:
        if float(k["y0"]) <= cy <= float(k["y1"]):
            return k["kind"]
    return None


def banner_subtitle(boxes, banner):
    """The banner subtitle (e.g. "BOMB DEFUSED") in the pack's W1 banner.subtitleRoi -> canonical pack text or None.
    Only the pack's own texts are returned, never raw OCR text."""
    roi = (banner or {}).get("subtitleRoi")
    subs = [(gt.normalise(s["text"]), s["text"]) for s in (banner or {}).get("subtitles") or []]
    if not roi or not subs:
        return None
    best, label = 0.0, None
    for b in boxes:
        if not b.get("g") or not _inside(b["g"], roi):
            continue
        t = gt.normalise(b.get("text", ""))
        for n, text in subs:
            r = gt.partial_ratio(n, t) if t else 0.0
            if r >= 0.85 and r > best:
                best, label = r, text
    return label


def _centre(g):
    return (g[0] + g[2]) / 2, (g[1] + g[3]) / 2


def _inside(g, roi):
    cx, cy = _centre(g)
    return roi["x0"] <= cx <= roi["x1"] and roi["y0"] <= cy <= roi["y1"]


def _roi(det, rid):
    return next((r for r in det.get("rois", []) if r.get("id") == rid), None)


# ---------------------------------------------------------------- read (S1)

def parse_top3(boxes, det, names, name_min, cfg):
    """Top-3 reading from one frame's boxes ({text, score, g} in game fractions), or None when the frame is not a
    top-3 screen (fewer than two cards with a SCORE line). Rank comes from the card ROI (rank<N>_card); the own card
    is the card holding a box whose name score against the profile names is >= name_min (best card wins)."""
    cards = []
    for r in det.get("rois", []):
        m = RANK_ROI.match(r.get("id", ""))
        if m:
            cards.append((int(m.group(1)), r))
    if not cards:
        return None
    score_re = re.compile(cfg["scoreRegex"])
    per = {rank: {"rank": rank, "score": None, "own": False, "_name": 0.0} for rank, _ in cards}
    for b in boxes:
        g = b.get("g")
        if not g:
            continue
        card = next((rank for rank, r in cards if _inside(g, r)), None)
        if card is None:
            continue
        m = score_re.match(gt.normalise(b.get("text", "")))
        if m:
            per[card]["score"] = int(m.group(1))
            continue
        if names:
            ns = gt.name_score(b.get("text", ""), names)["score"]
            if ns >= name_min and ns > per[card]["_name"]:
                per[card]["_name"] = ns
    if sum(1 for c in per.values() if c["score"] is not None) < 2:
        return None
    own = max((c for c in per.values() if c["_name"] > 0), key=lambda c: c["_name"], default=None)
    out = []
    for rank in sorted(per):
        c = per[rank]
        out.append({"rank": rank, "score": c["score"], "own": own is not None and c is own})
    scores = [c["score"] for c in out if c["score"] is not None]
    return {"cards": out, "ownRank": own["rank"] if own else None, "ownScore": own["score"] if own else None,
            "orderOk": all(a >= b for a, b in zip(scores, scores[1:]))}


def parse_mode_label(boxes, det, cfg):
    """Game mode name (lower case, e.g. "hardpoint") from the S1 mode_label ROI, or None."""
    roi = _roi(det, "mode_label")
    if not roi:
        return None
    wanted = [(gt.normalise(n), n.lower()) if isinstance(n, str) else (gt.normalise(n["text"]), n["mode"].lower())
              for n in cfg.get("modeNames") or []]
    for b in boxes:
        if b.get("g") and _inside(b["g"], roi):
            t = gt.normalise(b.get("text", ""))
            for n, label in wanted:
                if n and t and gt.ratio(n, t) >= 0.9:
                    return label
    return None


def parse_scoreboard_kills(boxes, det, names, name_min, cfg):
    """Own kills from a full MP scoreboard frame, or None. UNVERIFIED: no scoreboard frame has been measured.
    The own row is the box with the best profile-name score (>= name_min) inside the scoreboard_rows ROI; the kills
    column is the header box (cfg killsHeaders, exact after normalise) nearest above that row; the value is the
    whole-number box on the own row whose centre is closest to the header's centre (within the header width or
    0.03, whichever is larger)."""
    roi = _roi(det, "scoreboard_rows")
    heads = {gt.normalise(h) for h in cfg.get("killsHeaders") or []}
    if not roi or not heads or not names:
        return None
    inside = [b for b in boxes if b.get("g") and _inside(b["g"], roi)]
    own, best = None, 0.0
    for b in inside:
        s = gt.name_score(b.get("text", ""), names)["score"]
        if s >= name_min and s > best:
            own, best = b, s
    if own is None:
        return None
    oy0, oy1 = own["g"][1], own["g"][3]
    ocy, oh = (oy0 + oy1) / 2, max(oy1 - oy0, 1e-6)
    header = None
    for b in inside:
        if gt.normalise(b.get("text", "")) in heads and b["g"][3] <= oy0 + 1e-6:
            if header is None or b["g"][3] > header["g"][3]:
                header = b
    if header is None:
        return None
    hcx = _centre(header["g"])[0]
    tol = max(header["g"][2] - header["g"][0], 0.03)
    value, dist = None, None
    for b in inside:
        t = (b.get("text") or "").strip()
        if not t.isdigit() or len(t) > 3:
            continue
        cx, cy = _centre(b["g"])
        if abs(cy - ocy) > 0.6 * oh or abs(cx - hcx) > tol:
            continue
        if dist is None or abs(cx - hcx) < dist:
            value, dist = int(t), abs(cx - hcx)
    return value


def frame_stats(boxes, pack, names, name_min, mode=None):
    """S1 for one OCR'd frame -> (hit rows, readings). Rows are detector-hit rows (no names; label "TOP 3" or
    "SCOREBOARD"; signal = the streamer's card or row was found). Readings: {kind: "top3"|"scoreboard", ...}."""
    det = s1_detector(pack)
    if det is None:
        return [], []
    cfg = stats_config(pack)
    rows, readings = [], []
    base = {"detector": "S1", "role": det.get("role", "context"), "clipReason": False, "weight": det.get("weight"),
            "detectorStatus": det.get("status", "unverified"), "mode": mode}
    top = parse_top3(boxes, det, names, name_min, cfg)
    if top is not None:
        gm = parse_mode_label(boxes, det, cfg)
        readings.append({"kind": "top3", **top, "gameMode": gm})
        own = top["ownRank"] is not None
        rows.append({**base, "label": "TOP 3", "signal": own, "why": [] if own else ["no_name_on_card"],
                     "ocrScore": 0.0})
    kills = parse_scoreboard_kills(boxes, det, names, name_min, cfg)
    if kills is not None:
        readings.append({"kind": "scoreboard", "ownKills": kills})
        rows.append({**base, "label": "SCOREBOARD", "signal": True, "why": [], "ocrScore": 0.0})
    return rows, readings


# ---------------------------------------------------------------- count (kill feed)

def victim_key(line_text):
    """In-memory key of an own kill-feed line: the folded text right of the killer (the victim side). The key is
    never written anywhere. line_text: the kill-feed event text (boxes joined with " | ")."""
    parts = [p for p in (line_text or "").split(" | ") if gt.normalise(p)]
    if len(parts) > 1:
        return gt.fold(parts[-1]) or None
    t = gt.fold(parts[0]) if parts else ""
    return t[-8:] or None  # one box holds the whole line: its tail is the victim side


KEY_OVERLAP_CHARS = 4    # a shared run of at least this many characters ...
KEY_OVERLAP_MIN = 0.75   # ... covering this share of the shorter key is the same victim (OCR cuts the line ends)
KEY_DUP_MIN = 0.85       # two keys this alike in one frame are one line read twice (one wrong character in 8+)


def _frame_keys(keys):
    """One frame's keys without repeats of the same line (None keys all kept: each is a line)."""
    out = []
    for k in keys:
        if k is not None and any(o is not None and (gt.ratio(k, o) >= KEY_DUP_MIN or k in o or o in k) for o in out):
            continue
        out.append(k)
    return out


def _overlap(a, b):
    """Longest common run of a and b as a share of the shorter key; 0 when the shorter key is under 4 characters."""
    short = min(len(a), len(b))
    if short < KEY_OVERLAP_CHARS:
        return 0.0
    m = difflib.SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b))
    return m.size / short if m.size >= KEY_OVERLAP_CHARS - 1 else 0.0


class KillCounter:
    """Own kills from per-frame own kill-feed lines. feed(t, keys) once per sampled frame with one key per own
    line on screen (None when the victim side is unreadable). A line seen again within hold_sec of its last sighting
    with a similar key is the same kill; anything else is a new kill. Similar: ratio >= key_min, or a shared run of
    characters covering KEY_OVERLAP_MIN of the shorter key (the 2026-11-08 practice read one victim as the full
    name, its last 8 characters, a middle part or a 4-character tail on consecutive frames). Two None keys match.
    Within one frame, a key that repeats an earlier key of that frame (ratio >= KEY_DUP_MIN or one inside the other)
    is the same line read twice and is dropped; the other keys pair one to one with the lines on screen, so two
    different victims at once (clan mates with the same tag too) stay two kills."""

    def __init__(self, hold_sec=6.0, key_min=0.7):
        self.hold, self.key_min = float(hold_sec), float(key_min)
        self.active = []  # [key, last_t]
        self.times = []
        self.frames = 0

    def _same(self, a, b):
        if a is None or b is None:
            return a is None and b is None
        return gt.ratio(a, b) >= self.key_min or _overlap(a, b) >= KEY_OVERLAP_MIN

    def feed(self, t, keys):
        self.active = [e for e in self.active if t - e[1] <= self.hold + 1e-6]
        if keys:
            self.frames += 1
        used, new = set(), 0
        for k in _frame_keys(keys):
            hit = next((i for i, e in enumerate(self.active) if i not in used and self._same(k, e[0])), None)
            if hit is None:
                self.active.append([k, t])
                used.add(len(self.active) - 1)
                self.times.append(round(float(t), 3))
                new += 1
            else:
                self.active[hit][1] = t
                used.add(hit)
        return new


def killfeed_instances(hits):
    """Fallback own-kill times when match-stats.json is missing (older runs): one per signalled M5/B1 hit
    instance. Undercounts kills that follow each other within the merge gap."""
    return [float(h["t"]) for h in hits if h.get("detector") in ("M5", "B1") and h.get("signal") is True]


# ---------------------------------------------------------------- segment

def read_hits(path):
    """detector-hits.jsonl rows as written (t, tEnd, detector, label, signal, why, mode); bad lines skipped."""
    out = []
    if not path:
        return out
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
                float(r["t"])
                str(r["detector"])
            except (ValueError, KeyError, TypeError):
                continue
            if isinstance(r, dict):
                out.append(r)
    return out


def _is_banner(h):
    return h.get("detector") == "W1" and h.get("signal") is True and h.get("label") in ("VICTORY", "DEFEAT")


def _follower(h, ids):
    return h.get("detector") in ids and not (h.get("detector") == "M1" and "outside_roi" in (h.get("why") or []))


def classify_banners(hits, cfg, duration=None):
    """Round end or match end for every signalled VICTORY/DEFEAT banner (W1). -> {id(hit): (kind, source)}.
    kind "round" | "match" | None (unknown: never closes a match; end_clusters joins only match ends).
    source "geometry": the detector pass read the banner kind from the word's position (hit field `banner`, pack
    W1 banner.kinds). Hits without that field (detected before it existed) fall back to "follow-on" (pack
    banner.followers / followSec): a match end is followed within followSec by a post-match screen (FINAL KILLCAM,
    IMPACT PLAY, MVP, top 3); a round banner is not. A banner too close to the end of the recording to tell stays
    None. Without a pack banner config every banner is a match end."""
    b = cfg.get("banner") or {}
    out = {}
    if not b:
        for h in hits:
            if _is_banner(h):
                out[id(h)] = ("match", "no banner config")
        return out
    ids = set(b.get("followers") or [])
    follow = float(b.get("followSec") or 0)
    starts = sorted(float(h["t"]) for h in hits if _follower(h, ids))
    last = max([float(h.get("tEnd", h["t"])) for h in hits] + [float(duration or 0)])
    for h in hits:
        if not _is_banner(h):
            continue
        if h.get("banner") in ("round", "match"):
            out[id(h)] = (h["banner"], "geometry")
            continue
        t1 = float(h.get("tEnd", h["t"]))
        if any(t1 <= s <= t1 + follow for s in starts):
            out[id(h)] = ("match", "follow-on")
        elif last - t1 > follow:
            out[id(h)] = ("round", "follow-on")
        else:
            out[id(h)] = (None, "follow-on: recording ends too soon after the banner")
    return out


def end_clusters(hits, cfg, kinds=None):
    """End-screen sequences: hits of cfg endScreenDetectors (M1 only inside its ROI) closer than endGapSec join.
    Only banners classified as match ends join (classify_banners; kinds is its result, computed when None): round
    ends and banners of unknown kind (recording ends too soon after them) do not.
    -> [{t0, t1, results: Counter, hudModes: Counter, w1: [(t, tEnd, label, signalled)], banners: [(t, source)]}]
    sorted by time."""
    ids = set(cfg.get("endScreenDetectors") or [])
    gap = float(cfg.get("endGapSec") or 90)
    if kinds is None:
        kinds = classify_banners(hits, cfg)
    pts = []
    for h in hits:
        d = h.get("detector")
        if d not in ids:
            continue
        if d == "M1" and "outside_roi" in (h.get("why") or []):
            continue
        if _is_banner(h) and kinds.get(id(h), (None,))[0] != "match":
            continue  # round ends never close a match, and neither does a banner of unknown kind (never guess)
        t0 = float(h["t"])
        t1 = float(h.get("tEnd", t0))
        pts.append((t0, t1, h))
    pts.sort(key=lambda p: p[0])
    out = []
    for t0, t1, h in pts:
        if out and t0 - out[-1]["t1"] <= gap:
            c = out[-1]
            c["t1"] = max(c["t1"], t1)
        else:
            c = {"t0": t0, "t1": t1, "results": Counter(), "hudModes": Counter(), "w1": [], "banners": []}
            out.append(c)
        if h.get("detector") == "W1" and h.get("label") in ("VICTORY", "DEFEAT"):
            c["results"][h["label"]] += 2 if h.get("signal") else 1
            c["w1"].append((t0, t1, h["label"], h.get("signal") is True))
            if id(h) in kinds:
                c["banners"].append((t0, kinds[id(h)][1], h.get("subtitle")))
        if h.get("mode") in ("mp", "br"):
            c["hudModes"][h["mode"]] += 1
    return out


def _mode_of(counter):
    return counter.most_common(1)[0][0] if counter else None


def segment(hits, stats, duration, cfg):
    """Matches of a recording. stats: match-stats.json doc (or None). Each match: start, end, endSeen, result,
    mode, ownRank, ownScore, top3Seen, ownKills, killsSource; for the reel rules (D315) also endScreenAt (first
    end-screen hit), resultConfirmed (a signalled W1 box of that result), resultAt/resultEnd (that box's time),
    gameMode with modeConfidence, modeEvidence and modeReason (game_mode(): top-3 mode name, mode cues, round
    subtitles; None when the evidence does not decide one mode) and roundKills (own kills per round, from the
    round-end banners: see below). Round ends (classify_banners) never close a match: they are listed in `rounds`
    [{t, tEnd, result, source, subtitle}] of the match they fall in; endBanner tells how the closing banner was
    told apart ({source, subtitle} or None). roundKills: with at least one round end, own kills per round, a round
    running from the previous round end (or the match start) to its banner, the last one to the match-end banner;
    otherwise None. No names."""
    kinds = classify_banners(hits, cfg, duration)
    clusters = end_clusters(hits, cfg, kinds)
    round_hits = []  # one per round banner: hits of the same result closer than banner.sameBannerSec are one banner
    same = float((cfg.get("banner") or {}).get("sameBannerSec") or 0)
    for h in sorted((h for h in hits if kinds.get(id(h), (None,))[0] == "round"), key=lambda h: float(h["t"])):
        p = round_hits[-1] if round_hits else None
        if p and p["label"] == h["label"] and float(h["t"]) - float(p.get("tEnd", p["t"])) <= same:
            round_hits[-1] = dict(p, tEnd=max(float(p.get("tEnd", p["t"])), float(h.get("tEnd", h["t"]))),
                                  subtitle=p.get("subtitle") or h.get("subtitle"))
            kinds[id(round_hits[-1])] = kinds[id(p)]
            continue
        round_hits.append(h)
    readings = (stats or {}).get("readings") or []
    if stats and isinstance((stats.get("ownKills") or {}).get("times"), list):
        kill_times, kill_src = [float(t) for t in stats["ownKills"]["times"]], "killfeed"
    else:
        kill_times = killfeed_instances(hits)
        kill_src = "killfeed" if any(h.get("detector") in ("M5", "B1") for h in hits) else None
    spans = []
    prev = 0.0
    for c in clusters:
        spans.append((prev, c, True))
        prev = c["t1"]
    if duration - prev > 1.0 or not clusters:
        spans.append((prev, None, False))
    out = []
    for i, (start, c, seen) in enumerate(spans, 1):
        end = c["t1"] if c else float(duration)
        play_end = c["t0"] if c else float(duration)
        m = {"index": i, "start": round(start, 2), "end": round(end, 2), "endSeen": seen, "result": None,
             "mode": None, "ownRank": None, "ownScore": None, "top3Seen": False, "ownKills": None, "killsSource": None,
             "endScreenAt": round(c["t0"], 2) if c else None, "resultConfirmed": False, "resultAt": None,
             "resultEnd": None, "gameMode": None, "roundKills": None, "rounds": [], "endBanner": None,
             "modeConfidence": None, "modeEvidence": [], "modeReason": None}
        m["rounds"] = [{"t": round(float(h["t"]), 2), "tEnd": round(float(h.get("tEnd", h["t"])), 2),
                        "result": h["label"], "source": kinds[id(h)][1], "subtitle": h.get("subtitle")}
                       for h in round_hits if start <= float(h["t"]) < play_end]
        if c and c["banners"]:
            m["endBanner"] = {"source": c["banners"][0][1], "subtitle": c["banners"][0][2]}
        hud = Counter(h["mode"] for h in hits if h.get("mode") in ("mp", "br") and start <= float(h["t"]) <= end)
        if c:
            if c["results"]:
                m["result"] = c["results"].most_common(1)[0][0]
                sure = [w for w in c["w1"] if w[2] == m["result"] and w[3]]
                if sure:
                    m["resultConfirmed"] = True
                    m["resultAt"] = round(min(w[0] for w in sure), 3)
                    m["resultEnd"] = round(max(w[1] for w in sure), 3)
            win = [r for r in readings if c["t0"] - 1 <= float(r.get("t", -1)) <= c["t1"] + 1]
            tops = [r for r in win if r.get("kind") == "top3"]
            if tops:
                m["top3Seen"] = True
                ranks = Counter(r["ownRank"] for r in tops if r.get("ownRank") is not None)
                if ranks:
                    m["ownRank"] = ranks.most_common(1)[0][0]
                    scores = Counter(r["ownScore"] for r in tops if r.get("ownRank") == m["ownRank"]
                                     and r.get("ownScore") is not None)
                    m["ownScore"] = scores.most_common(1)[0][0] if scores else None
        boards = [r for r in readings if r.get("kind") == "scoreboard" and start <= float(r.get("t", -1)) <= end
                  and isinstance(r.get("ownKills"), int)]
        if boards:
            m["ownKills"], m["killsSource"] = max(r["ownKills"] for r in boards), "scoreboard"
        elif kill_src:
            m["ownKills"] = sum(1 for t in kill_times if start <= t < play_end)
            m["killsSource"] = kill_src
        if m["rounds"] and kill_src:
            edges = [start] + [r["tEnd"] for r in m["rounds"]] + [play_end]
            m["roundKills"] = [sum(1 for t in kill_times if a <= t < b) for a, b in zip(edges, edges[1:])]
        if not c:
            tops = []
        in_match = [h for h in hits if start <= float(h["t"]) <= end]
        gm = game_mode(tops, in_match, m["rounds"], m["endBanner"], cfg)
        m["gameMode"], m["modeConfidence"], m["modeEvidence"], m["modeReason"] = gm
        m["mode"] = m["gameMode"] or _mode_of(hud + (c["hudModes"] if c else Counter()))
        out.append(m)
    return out


def _cue_modes(cfg):
    """{cue text: [modes]} of the pack's mode cues (C1 `cues`) and banner subtitles that name modes."""
    out = {}
    for q in cfg.get("modeCues") or []:
        out[q["text"]] = [x.lower() for x in q.get("modes") or []]
    for s in (cfg.get("banner") or {}).get("subtitles") or []:
        if s.get("modes"):
            out.setdefault(s["text"], [x.lower() for x in s["modes"]])
    return out


def game_mode(tops, hits, rounds, end_banner, cfg):
    """Game mode of one match from on-screen evidence -> (mode | None, confidence | None, evidence, reason).
    Evidence items {source, at, text, modes}: the mode name on the top-3 screen (S1 mode_label), mode cues seen
    during the match (C1 hits: HUD and scoreboard texts that only some modes show) and round-banner subtitles that
    name modes. Each item allows a set of modes; the match mode is the one mode every item allows. No item: None
    ("no mode evidence"); items that allow no common mode or more than one: None with the reason (never a guess).
    Confidence: "high" with the top-3 mode name, else "medium" with two or more items, else "low"."""
    cues = _cue_modes(cfg)
    ev = []
    for r in tops:
        if r.get("gameMode"):
            ev.append({"source": "top-3 screen", "at": round(float(r["t"]), 2), "text": r["gameMode"],
                       "modes": [r["gameMode"]]})
    seen = set()
    for h in hits:
        if h.get("detector") == "C1" and h.get("signal") is True and h.get("label") in cues:
            ev.append({"source": "mode cue", "at": round(float(h["t"]), 2), "text": h["label"],
                       "modes": cues[h["label"]]})
    for r in list(rounds) + ([end_banner] if end_banner else []):
        s = r.get("subtitle")
        if s in cues:
            ev.append({"source": "round subtitle", "at": r.get("t"), "text": s, "modes": cues[s]})
    # one item per (source, text): repeats of the same screen or cue add no independent evidence
    uniq = []
    for e in ev:
        k = (e["source"], e["text"])
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    if not uniq:
        return None, None, [], "no mode evidence"
    allowed = set(uniq[0]["modes"])
    for e in uniq[1:]:
        allowed &= set(e["modes"])
    if len(allowed) != 1:
        named = sorted({x for e in uniq for x in e["modes"]})
        why = "evidence disagrees" if not allowed else "evidence fits more than one mode"
        return None, None, uniq, f"{why} ({', '.join(named)})"
    mode = allowed.pop()
    conf = "high" if any(e["source"] == "top-3 screen" for e in uniq) else "medium" if len(uniq) >= 2 else "low"
    return mode, conf, uniq, f"{len(uniq)} evidence item(s) agree"


# ---------------------------------------------------------------- gate

def decide(m, gate):
    """(passed, reason) for one match under gate {"top3": bool, "minKills": int|None}. Plain words, no names."""
    top3, min_kills = bool(gate.get("top3")), gate.get("minKills")
    if not m["endSeen"]:
        return True, "no end screen seen (the recording stopped mid-match): clips kept"
    if not top3 and min_kills is None:
        return True, "match gate off: clips kept"
    if top3 and m.get("ownRank") in (1, 2, 3):
        return True, f"in the top 3 (#{m['ownRank']})"
    k = m.get("ownKills")
    if min_kills is not None and k is not None and k >= min_kills:
        return True, f"{k} kills (at least {min_kills}, from the {m.get('killsSource')})"
    unread = []
    if top3 and not m.get("top3Seen"):
        unread.append("top-3 screen not read")
    if min_kills is not None and k is None:
        unread.append("kills not read")
    if unread:
        return True, f"match end seen but {' and '.join(unread)}: clips kept"
    why = ["not in the top 3"] if top3 else []
    if min_kills is not None:
        why.append(f"{k} kills (fewer than {min_kills})")
    return False, "; ".join(why)


# ---------------------------------------------------------------- reel rules (D315)

def reel_rules(pack):
    """The pack's match reel rules (match-reels.json `rules`), or [] when the pack has none (then no reel)."""
    return list(((pack or {}).get("matchReels") or {}).get("rules") or [])


def _cond(m, key, want):
    """One condition of a reel rule on match m -> ("pass"|"fail"|"inert", plain words). Inert = signal not read."""
    if key == "modes":
        gm = m.get("gameMode")
        if not gm:
            return "inert", "game mode not read"
        return ("pass", f"mode {gm}") if gm in want else ("fail", f"mode {gm}")
    if key == "result":
        r = m.get("result")
        if not r or not m.get("resultConfirmed"):
            return "inert", "result not read"
        return ("pass", r) if r == want else ("fail", r)
    if key == "maxPlace":
        if not m.get("top3Seen"):
            return "inert", "top-3 screen not read"
        rank = m.get("ownRank")
        if rank is None:
            return "fail", "not on the top-3 cards"
        return ("pass", f"placed #{rank}") if rank <= want else ("fail", f"placed #{rank}")
    if key == "killsAbove":
        k = m.get("ownKills")
        if k is None:
            return "inert", "kills not read"
        src = m.get("killsSource") or "unknown source"
        return ("pass" if k > want else "fail"), f"{k} kills ({src}; needs more than {want})"
    if key == "roundKillsAtLeast":
        rk = m.get("roundKills")
        if not isinstance(rk, list) or not rk:
            return "inert", "kills per round not detected"
        best = max(rk)
        return ("pass" if best >= want else "fail"), f"best round {best} kills (needs {want})"
    return "inert", f"unknown condition {key}"


def reel_rule(m, rule):
    """One rule on one match -> {id, outcome: pass|fail|inert, why}. Any failing condition fails the rule; else any
    unread signal makes it inert (never a reel on a guess); else it passes."""
    parts = [_cond(m, k, v) for k, v in (rule.get("when") or {}).items()]
    fails = [w for o, w in parts if o == "fail"]
    inert = [w for o, w in parts if o == "inert"]
    if fails:
        outcome, why = "fail", fails
    elif inert or not parts:
        outcome, why = "inert", inert or ["no condition"]
    else:
        outcome, why = "pass", [w for _, w in parts]
    return {"id": rule.get("id"), "outcome": outcome, "why": "; ".join(why)}


def reel_decide(m, rules):
    """Reel decision for one match (D315): it qualifies when any rule passes. -> {qualifies, reason, rules: [...]}.
    A match with no end screen seen never qualifies (its result and place are unknown)."""
    if not m.get("endSeen"):
        return {"qualifies": False, "reason": "no end screen seen (the recording stopped mid-match)", "rules": []}
    if not rules:
        return {"qualifies": False, "reason": "the game pack has no match reel rules", "rules": []}
    ev = [reel_rule(m, r) for r in rules]
    passed = [e for e in ev if e["outcome"] == "pass"]
    if passed:
        reason = "; ".join(f"{e['id']} ({e['why']})" for e in passed)
    else:
        reason = "no rule passed: " + "; ".join(f"{e['id']} {e['outcome']} ({e['why']})" for e in ev)
    return {"qualifies": bool(passed), "reason": reason, "rules": ev}


def match_of(t, matches):
    """The match whose [start, end] holds t (the first one when t sits on a boundary), else None."""
    return next((m for m in matches if m["start"] <= t <= m["end"]), None)


def gate_saves(rows, matches, gate, parse_iso):
    """Live clipper saves (saves.jsonl rows) against the matches of the same session's recording (matches.json from
    `run`, with startUtc/endUtc). A save's moment is the middle of its clip window (at - (startBack + endBack) / 2).
    A save outside every match, or without a readable time, is kept. Decisions use the current gate.
    -> (kept rows, dropped [{at, match, reason}])."""
    spans = []
    for m in matches:
        a, b = parse_iso(m.get("startUtc")), parse_iso(m.get("endUtc"))
        if a and b:
            passed, reason = decide(m, gate)
            spans.append((a.timestamp(), b.timestamp(), m.get("index"), passed, reason))
    kept, dropped = [], []
    for r in rows:
        at = parse_iso(r.get("at"))
        try:
            t = at.timestamp() - (float(r.get("startBack", 0)) + float(r.get("endBack", 0))) / 2 if at else None
        except (TypeError, ValueError):
            t = None
        span = next((s for s in spans if t is not None and s[0] <= t <= s[1]), None)
        if span is None or span[3]:
            kept.append(r)
        else:
            dropped.append({"at": r.get("at"), "match": span[2], "reason": span[4]})
    return kept, dropped


def gate_candidates(cands, matches, gate):
    """Splits candidates by their match's decision (anchor time, else start). -> (kept, dropped). Each candidate gets
    `match` (index or None); a dropped one also gets `gateReason`. Matches get passed, reason and candidate ids."""
    for m in matches:
        m["passed"], m["reason"] = decide(m, gate)
        m["candidates"], m["dropped"] = [], []
    kept, dropped = [], []
    for c in cands:
        t = float(c.get("anchor", c.get("start", 0.0)))
        m = match_of(t, matches)
        c = dict(c, match=m["index"] if m else None)
        if m is None or m["passed"]:
            kept.append(c)
            if m:
                m["candidates"].append(c.get("id"))
        else:
            dropped.append(dict(c, gateReason=m["reason"]))
            m["dropped"].append(c.get("id"))
    return kept, dropped
