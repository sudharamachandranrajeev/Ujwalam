# SPDX-License-Identifier: GPL-3.0-or-later
"""Chat and engage-log alignment to clip sessions (P2a step A3).

Reads three optional signal sources, puts every event on UTC wall-clock time, and
maps it onto the session timelines in index.json (from session_index.py, clip
name time = clip END):

  --twitch-dir   TwitchDownloaderCLI chat JSON files (*.json). Event time =
                 video.created_at + comment.content_offset_seconds (1 s resolution).
                 The comment's own created_at is used only for the clock check.
  --youtube-dir  yt-dlp live-chat replay files (*.live_chat.json) with the matching
                 *.info.json (channel_id, release_timestamp, duration, width/height).
                 Event time = item timestampUsec. release_timestamp +
                 videoOffsetTimeMsec is used only for the clock check.
  --engage-dir   legacy engage server logs (chat-YYYY-MM-DD.jsonl). Only the fields
                 t, kind, platform, action, reason and outputs are read.

Message text, author names and author ids are never written. The only author fact
kept is a role: owner, moderator (badge), bot-self (engage self-echo/bot), or viewer.

Outputs (in --out, which must be outside the repository):
  events.jsonl   one row per event: source, platform, utc, type, role, session,
                 wallOffsetSec, clip, clipTimeSec, cacheTimeSec (no text, no authors)
  summary.json   per-session aggregates, per-VOD overlap, clock checks

Usage (stdlib only; run isolated):
  python -I services/clip/chat_align.py --index <index.json> --out <folder>
      [--twitch-dir DIR] [--youtube-dir DIR] [--engage-dir DIR] [--match-window SEC]
      [--max-clock-offset SEC]
"""

from __future__ import annotations

import argparse
import bisect
import glob
import json
import os
import statistics
import sys
from datetime import datetime, timezone

TOOL_VERSION = 1
EVENTS_FILE = "events.jsonl"
SUMMARY_FILE = "summary.json"

# Engage drop reasons that are not a distinct viewer message.
ENGAGE_NOT_VIEWER = {"self-echo": "bot-self", "bot": "bot-self", "duplicate": "duplicate"}
YT_CHAT_RENDERERS = {
    "liveChatTextMessageRenderer": "text",
    "liveChatPaidMessageRenderer": "paid",
    "liveChatPaidStickerRenderer": "sticker",
    "liveChatMembershipItemRenderer": "membership",
}

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


# ---------------------------------------------------------------- time helpers

def parse_utc(text: str) -> float:
    """ISO-8601 UTC ('...Z' or with offset) to epoch seconds."""
    t = text.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        raise ValueError(f"timestamp without zone: {text!r}")
    return dt.timestamp()


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stats(values: list[float]) -> dict | None:
    if not values:
        return None
    v = sorted(values)
    return {
        "n": len(v),
        "min": round(v[0], 3),
        "median": round(statistics.median(v), 3),
        "max": round(v[-1], 3),
    }


# ---------------------------------------------------------------- sessions

class Session:
    def __init__(self, rec: dict):
        self.id = rec["id"]
        self.start = parse_utc(rec["startUtc"])
        self.end = parse_utc(rec["endUtc"])
        self.clip_count = rec.get("clipCount", len(rec.get("clips", [])))
        # Trimmed, non-overlapping clip ranges: [start + trimIn, start + duration).
        self.ranges: list[tuple[float, float, str, float, float]] = []
        for c in rec.get("clips", []):
            cs = parse_utc(c["startUtc"])
            trim = float(c.get("trimInSec") or 0.0)
            dur = float(c["duration"])
            if dur <= trim:
                continue
            self.ranges.append((cs + trim, cs + dur, c["file"], cs, float(c.get("sessionOffsetSec") or 0.0)))
        self.ranges.sort()
        self._starts = [r[0] for r in self.ranges]

    @property
    def span_sec(self) -> float:
        return self.end - self.start

    @property
    def covered_sec(self) -> float:
        return sum(r[1] - r[0] for r in self.ranges)

    def contains(self, ts: float) -> bool:
        return self.start <= ts <= self.end

    def locate(self, ts: float) -> dict | None:
        """The clip whose trimmed range holds ts, with clip time and cache time."""
        i = bisect.bisect_right(self._starts, ts) - 1
        if i < 0:
            return None
        r0, r1, name, cs, cache0 = self.ranges[i]
        if ts >= r1:
            return None
        return {
            "clip": name,
            "clipTimeSec": round(ts - cs, 3),
            "cacheTimeSec": round(cache0 + (ts - r0), 3),
        }


def load_sessions(index_path: str) -> list[Session]:
    with open(index_path, encoding="utf-8") as f:
        idx = json.load(f)
    if idx.get("nameTime") not in (None, "end"):
        print(f"warning: index nameTime is {idx.get('nameTime')!r}, not 'end'", file=sys.stderr)
    return sorted((Session(s) for s in idx["sessions"]), key=lambda s: s.start)


def find_session(sessions: list[Session], ts: float) -> Session | None:
    for s in sessions:
        if s.contains(ts):
            return s
    return None


# ---------------------------------------------------------------- sources

def load_twitch(folder: str) -> tuple[list[dict], list[dict], list[float]]:
    """Returns (events, vods, server-minus-offset deltas)."""
    events, vods, deltas = [], [], []
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        video = d.get("video") or {}
        if "created_at" not in video:
            continue
        v0 = parse_utc(video["created_at"])
        streamer_id = str((d.get("streamer") or {}).get("id", ""))
        length = float(video.get("length") or 0)
        vods.append({"source": "twitch", "id": str(video.get("id", "")), "start": v0,
                     "end": v0 + length, "orientation": "H"})
        for c in d.get("comments") or []:
            off = c.get("content_offset_seconds")
            if off is None:
                continue
            ts = v0 + float(off)
            author = str((c.get("commenter") or {}).get("_id", ""))
            role = "owner" if streamer_id and author == streamer_id else "viewer"
            server = None
            if c.get("created_at"):
                server = parse_utc(c["created_at"])
                deltas.append(server - ts)
            events.append({"source": "twitch", "platform": "twitch", "utc": ts, "type": "chat",
                           "role": role, "serverUtc": server})
    return events, vods, deltas


def _yt_badges(renderer: dict) -> set[str]:
    out = set()
    for b in renderer.get("authorBadges") or []:
        icon = ((b.get("liveChatAuthorBadgeRenderer") or {}).get("icon") or {}).get("iconType")
        if icon:
            out.add(icon)
    return out


def load_youtube(folder: str) -> tuple[list[dict], list[dict], list[float]]:
    events, vods, deltas = [], [], []
    for path in sorted(glob.glob(os.path.join(folder, "*.live_chat.json"))):
        info_path = path[: -len(".live_chat.json")] + ".info.json"
        info = {}
        if os.path.exists(info_path):
            with open(info_path, encoding="utf-8") as f:
                info = json.load(f)
        owner_id = info.get("channel_id")
        v0 = info.get("release_timestamp") or info.get("timestamp")
        w, h = info.get("width"), info.get("height")
        orient = "V" if (w and h and h > w) else ("H" if (w and h) else "?")
        if v0 is not None:
            vods.append({"source": "youtube", "id": info.get("id", os.path.basename(path)),
                         "start": float(v0), "end": float(v0) + float(info.get("duration") or 0),
                         "orientation": orient})
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                replay = o.get("replayChatItemAction") or {}
                voff = replay.get("videoOffsetTimeMsec")
                for a in replay.get("actions") or []:
                    item = (a.get("addChatItemAction") or {}).get("item") or {}
                    for rname, r in item.items():
                        kind = YT_CHAT_RENDERERS.get(rname)
                        if kind is None or "timestampUsec" not in r:
                            continue
                        ts = int(r["timestampUsec"]) / 1e6
                        badges = _yt_badges(r)
                        if (owner_id and r.get("authorExternalChannelId") == owner_id) or "OWNER" in badges:
                            role = "owner"
                        elif "MODERATOR" in badges:
                            role = "moderator"
                        else:
                            role = "viewer"
                        if v0 is not None and voff is not None:
                            deltas.append(ts - (float(v0) + int(voff) / 1000.0))
                        events.append({"source": "youtube", "platform": "youtube", "utc": ts,
                                       "type": kind, "role": role, "orientation": orient})
    return events, vods, deltas


def load_engage(folder: str) -> list[dict]:
    events = []
    for path in sorted(glob.glob(os.path.join(folder, "chat-*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind, t = o.get("kind"), o.get("t")
                if not t or kind not in ("message", "sent"):
                    continue
                ts = parse_utc(t)
                if kind == "message":
                    reason = o.get("reason")
                    role = ENGAGE_NOT_VIEWER.get(reason, "viewer") if isinstance(reason, str) else "viewer"
                    events.append({"source": "engage", "platform": o.get("platform") or "?", "utc": ts,
                                   "type": "message", "role": role,
                                   "action": o.get("action") if o.get("action") in ("reply", "drop") else "?"})
                else:
                    outs = o.get("outputs") if isinstance(o.get("outputs"), list) else []
                    events.append({"source": "engage", "platform": "-", "utc": ts, "type": "sent",
                                   "role": "bot-self", "toChat": "chat" in outs, "toOverlay": "overlay" in outs})
    return events


# ---------------------------------------------------------------- clock checks

def match_unique(a_items: list, b_items: list, lo: float, hi: float, key=lambda x: x) -> list[tuple]:
    """Pairs (a, b) with key(a) - key(b) in [lo, hi] where each is the other's only candidate."""
    a_sorted = sorted(a_items, key=key)
    b_sorted = sorted(b_items, key=key)
    a_keys = [key(x) for x in a_sorted]
    b_keys = [key(x) for x in b_sorted]
    out = []
    for a, ak in zip(a_sorted, a_keys):
        i0, i1 = bisect.bisect_left(b_keys, ak - hi), bisect.bisect_right(b_keys, ak - lo)
        if i1 - i0 != 1:
            continue
        b, bk = b_sorted[i0], b_keys[i0]
        j0, j1 = bisect.bisect_left(a_keys, bk + lo), bisect.bisect_right(a_keys, bk + hi)
        if j1 - j0 != 1:
            continue
        out.append((a, b))
    return out


def clock_checks(events: list[dict], window: float, max_offset: float) -> dict:
    """Engage (PC clock) against platform server clocks.

    inbound  = engage receive time - platform post time       = latency_in + offset
    outbound = bot reply post time - engage receive time of the message it answers
             = processing + latency_out - offset  (>= -offset)
    so offset (PC - platform) lies in [-min(outbound), min(inbound)].

    The engage "sent" record is written after the Streamer.bot call returns, so it
    can follow the post; it is not used as a bound. Outbound uses the receive time of
    engage messages whose action is "reply", which always precedes the reply post.
    Bot posts are owner/moderator posts not matched as a user's own inbound message.
    Deltas outside [-max_offset, window] are not physical under |offset| <= max_offset
    and are ignored.
    """
    res = {}
    eng_msg = [e for e in events if e["source"] == "engage" and e["type"] == "message" and e["role"] != "duplicate"]
    k = lambda x: x[0]
    for plat in ("twitch", "youtube"):
        if plat == "twitch":
            raw = [(e["serverUtc"], e) for e in events if e["source"] == "twitch" and e.get("serverUtc") is not None]
        else:
            raw = [(e["utc"], e) for e in events if e["source"] == "youtube"]
        # Bot-class posts (owner / moderator badge). The bot posts one reply into each
        # live broadcast (H and V), so bot posts within 2 s of each other are one reply.
        bot_class = sorted((p for p in raw if p[1]["role"] in ("owner", "moderator")), key=k)
        merged: list[tuple] = []
        for p in bot_class:
            if merged and p[0] - merged[-1][0] <= 2.0 and p[1].get("orientation") != merged[-1][1].get("orientation"):
                continue
            merged.append(p)
        viewer_posts = [p for p in raw if p[1]["role"] == "viewer"]
        recv_bot = [(e["utc"], e) for e in eng_msg if e["platform"] == plat and e["role"] == "bot-self"]
        recv_view = [(e["utc"], e) for e in eng_msg if e["platform"] == plat and e["role"] == "viewer"]
        # A user typing on an account shared with the bot is an engage "viewer" but an
        # owner post, so on Twitch engage viewers are matched against every post.
        view_targets = raw if plat == "twitch" else viewer_posts
        pairs_bot = match_unique(recv_bot, merged, -max_offset, window, key=k)
        pairs_view = match_unique(recv_view, view_targets, -max_offset, window, key=k)
        inbound_bot = [a[0] - b[0] for a, b in pairs_bot]
        inbound_view = [a[0] - b[0] for a, b in pairs_view]
        inbound = inbound_bot + inbound_view
        own = {id(b[1]) for a, b in pairs_view}
        bot_posts = [p for p in merged if id(p[1]) not in own]
        triggers = [(e["utc"], e) for e in eng_msg if e["platform"] == plat and e.get("action") == "reply"]
        out_pairs = match_unique(bot_posts, triggers, -max_offset, window, key=k)
        outbound = [a[0] - b[0] for a, b in out_pairs]
        entry = {"inbound": stats(inbound), "inboundBot": stats(inbound_bot), "inboundViewer": stats(inbound_view),
                 "outbound": stats(outbound)}
        if inbound and outbound:
            lo_b, hi_b = -min(outbound), min(inbound)
            entry["offsetBoundsSec"] = [round(lo_b, 3), round(hi_b, 3)]
            entry["boundsConsistent"] = lo_b <= hi_b
        elif inbound:
            entry["offsetUpperBoundSec"] = round(min(inbound), 3)
        res[plat] = entry
    return res


# ---------------------------------------------------------------- aggregation

def overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def aggregate(sessions: list[Session], events: list[dict], vods: list[dict],
              sources: dict) -> list[dict]:
    rows = []
    by_session: dict[str, list[dict]] = {s.id: [] for s in sessions}
    for e in events:
        if e.get("session"):
            by_session[e["session"]].append(e)
    for s in sessions:
        evs = by_session[s.id]
        span_min = s.span_sec / 60.0

        def count(pred, in_clip=False):
            return sum(1 for e in evs if pred(e) and (not in_clip or e.get("clip")))

        tw_v = lambda e: e["source"] == "twitch" and e["role"] == "viewer"
        yt_v = lambda e: e["source"] == "youtube" and e["role"] == "viewer"
        yt_m = lambda e: e["source"] == "youtube" and e["role"] in ("moderator", "owner")
        en_v = lambda e: e["source"] == "engage" and e["type"] == "message" and e["role"] == "viewer"
        en_r = lambda e: e["source"] == "engage" and e["type"] == "message" and e.get("action") == "reply"
        en_s = lambda e: e["source"] == "engage" and e["type"] == "sent"

        vod_cov = {}
        for key, pred in (("twitch", lambda v: v["source"] == "twitch"),
                          ("youtubeH", lambda v: v["source"] == "youtube" and v["orientation"] == "H"),
                          ("youtubeV", lambda v: v["source"] == "youtube" and v["orientation"] == "V")):
            ov = sum(overlap(s.start, s.end, v["start"], v["end"]) for v in vods if pred(v))
            starts = [v["start"] for v in vods if pred(v) and overlap(s.start, s.end, v["start"], v["end"]) > 0]
            vod_cov[key] = {
                "overlapSec": round(ov, 1),
                "overlapPct": round(100.0 * ov / s.span_sec, 1) if s.span_sec > 0 else 0.0,
                "firstVodStartMinusSessionStartSec": round(min(starts) - s.start, 1) if starts else None,
            }
        eng_any = [e["utc"] for e in evs if e["source"] == "engage"]
        # Spread: 5-minute bins of the session holding at least one viewer message from
        # any source. Chat that comes in one burst scores low here even when its rate is high.
        bins = {int((e["utc"] - s.start) // 300) for e in evs if tw_v(e) or yt_v(e) or en_v(e)}
        n_bins = max(1, int(s.span_sec // 300) + 1)
        tw, yt, en = count(tw_v), count(yt_v), count(en_v)
        rows.append({
            "session": s.id,
            "startUtc": iso(s.start),
            "endUtc": iso(s.end),
            "clipCount": s.clip_count,
            "spanMin": round(span_min, 1),
            "coveredMin": round(s.covered_sec / 60.0, 1),
            "vodOverlap": vod_cov,
            "twitchViewer": tw,
            "twitchViewerInClips": count(tw_v, True),
            "twitchOwner": count(lambda e: e["source"] == "twitch" and e["role"] == "owner"),
            "youtubeViewer": yt,
            "youtubeViewerInClips": count(yt_v, True),
            "youtubeViewerH": count(lambda e: yt_v(e) and e.get("orientation") == "H"),
            "youtubeViewerV": count(lambda e: yt_v(e) and e.get("orientation") == "V"),
            "youtubeModeratorOrOwner": count(yt_m),
            "engageViewerMessages": en,
            "engageViewerInClips": count(en_v, True),
            # Engage saw these while no listed VOD of that platform was running: a stream
            # that is not in the VOD list, or a message from outside a broadcast.
            "engageViewerOutsideVods": count(lambda e: en_v(e) and not any(
                v["start"] <= e["utc"] <= v["end"] for v in vods if v["source"] == e["platform"])),
            "engageViewerTwitch": count(lambda e: en_v(e) and e["platform"] == "twitch"),
            "engageViewerYoutube": count(lambda e: en_v(e) and e["platform"] == "youtube"),
            "engageReplies": count(en_r),
            "engageSent": count(en_s),
            "engageActiveSpanMin": round((max(eng_any) - min(eng_any)) / 60.0, 1) if eng_any else 0.0,
            "viewerBins5Min": len(bins),
            "bins5Min": n_bins,
            "platformViewerPerMin":round((tw + yt) / span_min, 3) if span_min > 0 else 0.0,
            "engageViewerPerMin": round(en / span_min, 3) if span_min > 0 else 0.0,
        })
    return rows


def _inside(child: str, parent: str) -> bool:
    child, parent = os.path.normcase(os.path.abspath(child)), os.path.normcase(os.path.abspath(parent))
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def run(index: str, out: str, twitch_dir: str | None, youtube_dir: str | None,
        engage_dir: str | None, window: float = 20.0, max_offset: float = 5.0,
        repo_root: str = _REPO_ROOT) -> dict:
    if _inside(out, repo_root):
        raise SystemExit(f"refusing --out inside the repository ({repo_root}): per-event data stays outside it")
    sessions = load_sessions(index)
    events, vods = [], []
    clock = {}
    sources = {}
    if twitch_dir:
        ev, vd, dl = load_twitch(twitch_dir)
        events += ev
        vods += vd
        clock["twitchCommentCreatedMinusVodOffsetSec"] = stats(dl)
        sources["twitch"] = {"files": len(vd), "events": len(ev)}
    if youtube_dir:
        ev, vd, dl = load_youtube(youtube_dir)
        events += ev
        vods += vd
        clock["youtubeTimestampMinusVodOffsetSec"] = stats(dl)
        sources["youtube"] = {"files": len(vd), "events": len(ev)}
    if engage_dir:
        ev = load_engage(engage_dir)
        events += ev
        sources["engage"] = {"events": len(ev)}
    events.sort(key=lambda e: e["utc"])
    for e in events:
        s = find_session(sessions, e["utc"])
        e["session"] = s.id if s else None
        if s:
            e["wallOffsetSec"] = round(e["utc"] - s.start, 3)
            loc = s.locate(e["utc"])
            if loc:
                e.update(loc)
    clock["engageVsPlatform"] = clock_checks(events, window, max_offset)
    clock["maxOffsetAssumedSec"] = max_offset
    for name, info in sources.items():
        info["inSessions"] = sum(1 for e in events if e["source"] == name and e.get("session"))
    summary = {
        "tool": "chat_align", "toolVersion": TOOL_VERSION,
        "index": os.path.abspath(index),
        "matchWindowSec": window,
        "sources": sources,
        "clock": clock,
        "sessions": aggregate(sessions, events, vods, sources),
        "vods": [{"source": v["source"], "id": v["id"], "orientation": v["orientation"],
                  "startUtc": iso(v["start"]), "lengthSec": round(v["end"] - v["start"], 1)} for v in vods],
    }
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, EVENTS_FILE), "w", encoding="utf-8", newline="\n") as f:
        for e in events:
            row = {k: e[k] for k in ("source", "platform", "type", "role", "session") if k in e}
            row["utc"] = iso(e["utc"])
            for k in ("orientation", "action", "toChat", "toOverlay", "wallOffsetSec", "clip",
                      "clipTimeSec", "cacheTimeSec"):
                if k in e:
                    row[k] = e[k]
            f.write(json.dumps(row) + "\n")
    with open(os.path.join(out, SUMMARY_FILE), "w", encoding="utf-8", newline="\n") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")
    return summary


def print_table(summary: dict) -> None:
    print("| session | clips | span min | TW ovl % | YT H/V ovl % | TW viewer | YT viewer (H/V) | YT mod | "
          "engage viewer | engage replies | platform msg/min | engage msg/min | 5-min bins with chat |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in summary["sessions"]:
        v = r["vodOverlap"]
        print(f"| {r['session']} | {r['clipCount']} | {r['spanMin']} | {v['twitch']['overlapPct']} | "
              f"{v['youtubeH']['overlapPct']}/{v['youtubeV']['overlapPct']} | {r['twitchViewer']} | "
              f"{r['youtubeViewer']} ({r['youtubeViewerH']}/{r['youtubeViewerV']}) | {r['youtubeModeratorOrOwner']} | "
              f"{r['engageViewerMessages']} | {r['engageReplies']} | {r['platformViewerPerMin']} | "
              f"{r['engageViewerPerMin']} | {r['viewerBins5Min']}/{r['bins5Min']} |")
    print(json.dumps({"sources": summary["sources"], "clock": summary["clock"]}, indent=2))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--index", required=True, help="index.json from session_index.py")
    ap.add_argument("--out", required=True, help="output folder (outside the repository)")
    ap.add_argument("--twitch-dir")
    ap.add_argument("--youtube-dir")
    ap.add_argument("--engage-dir")
    ap.add_argument("--match-window", type=float, default=20.0,
                    help="clock check: a pair's latency is at most SEC and each side must be the "
                         "other's only candidate (default 20)")
    ap.add_argument("--max-clock-offset", type=float, default=5.0,
                    help="clock check: assumed |PC - platform| limit in SEC (default 5)")
    args = ap.parse_args(argv)
    if not (args.twitch_dir or args.youtube_dir or args.engage_dir):
        ap.error("give at least one of --twitch-dir, --youtube-dir, --engage-dir")
    summary = run(args.index, args.out, args.twitch_dir, args.youtube_dir, args.engage_dir,
                  args.match_window, args.max_clock_offset)
    print_table(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
