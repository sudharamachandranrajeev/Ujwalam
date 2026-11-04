# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for services/clip/chat_align.py.

Synthetic fixtures only: invented sessions, invented chat files and invented engage
logs. No real chat, no viewer names. Run: python -I -m unittest discover -s tests/py -t tests/py
"""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_CLIP, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ca = _load("chat_align")

T0 = datetime(2026, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
SECRET_TEXT = "SYNTH-SECRET-TEXT-7731"
SECRET_AUTHOR = "SynthAuthorName9"
SECRET_ID = "UCsynthViewerId0000"


def z(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def at(sec: float) -> datetime:
    return T0 + timedelta(seconds=sec)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def make_index(path):
    """Session A: three clips 12:00:00-12:02:00 with a trimmed overlap and a gap.
    Session B: one clip at 14:00:00."""
    clips_a = [
        {"file": "c0.mp4", "startUtc": z(at(0)), "duration": 30.0, "trimInSec": 0.0, "sessionOffsetSec": 0.0},
        # starts 1 s before c0 ends; trimmed range starts at 12:00:30
        {"file": "c1.mp4", "startUtc": z(at(29)), "duration": 30.0, "trimInSec": 1.0, "sessionOffsetSec": 30.0},
        # 31 s gap after c1 (ends 12:00:59)
        {"file": "c2.mp4", "startUtc": z(at(90)), "duration": 30.0, "trimInSec": 0.0, "sessionOffsetSec": 59.0},
    ]
    clips_b = [{"file": "d0.mp4", "startUtc": z(at(7200)), "duration": 30.0, "trimInSec": 0.0,
                "sessionOffsetSec": 0.0}]
    write_json(path, {"nameTime": "end", "sessions": [
        {"id": "s-a", "startUtc": z(at(0)), "endUtc": z(at(120)), "clipCount": 3, "clips": clips_a},
        {"id": "s-b", "startUtc": z(at(7200)), "endUtc": z(at(7230)), "clipCount": 1, "clips": clips_b},
    ]})


def make_twitch(folder):
    v0 = at(-60)  # VOD starts one minute before session A

    def comment(off, author):
        return {"content_offset_seconds": off, "created_at": z(v0 + timedelta(seconds=off + 1.5)),
                "commenter": {"_id": author, "display_name": SECRET_AUTHOR},
                "message": {"body": SECRET_TEXT}}

    write_json(os.path.join(folder, "twitch-synth-1.json"), {
        "streamer": {"id": "100", "name": SECRET_AUTHOR},
        "video": {"id": "9", "created_at": z(v0), "length": 600, "title": SECRET_TEXT},
        "comments": [comment(65, "555"), comment(95, "100"), comment(200, "555")],
    })


def yt_text(ts: datetime, author_id, badges=(), renderer="liveChatTextMessageRenderer", voff=0):
    r = {"id": "x", "timestampUsec": str(int(ts.timestamp() * 1e6)), "authorExternalChannelId": author_id,
         "authorName": {"simpleText": SECRET_AUTHOR}, "message": {"runs": [{"text": SECRET_TEXT}]},
         "authorBadges": [{"liveChatAuthorBadgeRenderer": {"icon": {"iconType": b}}} for b in badges]}
    return {"replayChatItemAction": {"actions": [{"addChatItemAction": {"item": {renderer: r}}}],
                                     "videoOffsetTimeMsec": str(voff)}}


def make_youtube(folder):
    rel = at(-60)
    base = os.path.join(folder, "yt-synth-vid1")
    write_json(base + ".info.json", {"id": "vid1", "channel_id": "UCowner", "release_timestamp": int(rel.timestamp()),
                                     "duration": 600, "width": 1080, "height": 1920})
    lines = [
        yt_text(at(31), SECRET_ID, voff=91000),                       # viewer, clip c1
        yt_text(at(40), "UCbot", badges=("MODERATOR",), voff=100000),  # bot / moderator
        yt_text(at(45), "UCowner", voff=105000),                      # owner
        yt_text(at(100), SECRET_ID, renderer="liveChatPaidMessageRenderer", voff=160000),  # paid, clip c2
        {"replayChatItemAction": {"actions": [{"addChatItemAction": {"item": {
            "liveChatViewerEngagementMessageRenderer": {"timestampUsec": str(int(at(1).timestamp() * 1e6))}}}}],
            "videoOffsetTimeMsec": "61000"}},
    ]
    with open(base + ".live_chat.json", "w", encoding="utf-8") as f:
        for ln in lines:
            f.write(json.dumps(ln) + "\n")


def make_engage(folder):
    rows = [
        {"t": z(at(32.5)), "kind": "message", "platform": "youtube", "user": SECRET_AUTHOR, "text": SECRET_TEXT,
         "action": "reply", "reason": None},
        {"t": z(at(33)), "kind": "message", "platform": "youtube", "user": SECRET_AUTHOR, "text": SECRET_TEXT,
         "action": "drop", "reason": "duplicate"},
        {"t": z(at(41.5)), "kind": "message", "platform": "youtube", "user": SECRET_AUTHOR, "text": SECRET_TEXT,
         "action": "drop", "reason": "self-echo"},
        {"t": z(at(39)), "kind": "sent", "user": SECRET_AUTHOR, "text": SECRET_TEXT, "outputs": ["chat", "overlay"]},
        {"t": z(at(50)), "kind": "note", "level": "info", "text": SECRET_TEXT},
    ]
    with open(os.path.join(folder, "chat-2026-01-10.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
        f.write("{not json\n")


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.index = os.path.join(root, "index.json")
        self.tw = os.path.join(root, "tw")
        self.yt = os.path.join(root, "yt")
        self.en = os.path.join(root, "en")
        self.out = os.path.join(root, "out")
        for d in (self.tw, self.yt, self.en):
            os.makedirs(d)
        make_index(self.index)
        make_twitch(self.tw)
        make_youtube(self.yt)
        make_engage(self.en)

    def tearDown(self):
        self.tmp.cleanup()

    def run_all(self):
        return ca.run(self.index, self.out, self.tw, self.yt, self.en)

    def events(self):
        with open(os.path.join(self.out, ca.EVENTS_FILE), encoding="utf-8") as f:
            return [json.loads(x) for x in f]


class LocateTests(Fixture):
    def test_trimmed_ranges_and_cache_time(self):
        s = ca.load_sessions(self.index)[0]
        # 12:00:29.5 lies in c1's overlap, which is trimmed, so it belongs to c0
        loc = s.locate(at(29.5).timestamp())
        self.assertEqual(loc["clip"], "c0.mp4")
        self.assertAlmostEqual(loc["clipTimeSec"], 29.5, places=3)
        self.assertAlmostEqual(loc["cacheTimeSec"], 29.5, places=3)
        loc = s.locate(at(31).timestamp())
        self.assertEqual(loc["clip"], "c1.mp4")
        self.assertAlmostEqual(loc["clipTimeSec"], 2.0, places=3)
        self.assertAlmostEqual(loc["cacheTimeSec"], 31.0, places=3)
        loc = s.locate(at(100).timestamp())
        self.assertEqual(loc["clip"], "c2.mp4")
        self.assertAlmostEqual(loc["cacheTimeSec"], 69.0, places=3)
        self.assertIsNone(s.locate(at(70).timestamp()))  # in the gap
        self.assertAlmostEqual(s.covered_sec, 30 + 29 + 30, places=3)


class AlignTests(Fixture):
    def test_counts_per_session(self):
        summary = self.run_all()
        a = {r["session"]: r for r in summary["sessions"]}["s-a"]
        self.assertEqual(a["twitchViewer"], 1)        # offset 200 is outside the session
        self.assertEqual(a["twitchOwner"], 1)
        self.assertEqual(a["youtubeViewer"], 2)       # text + paid; engagement notice ignored
        self.assertEqual(a["youtubeViewerV"], 2)
        self.assertEqual(a["youtubeModeratorOrOwner"], 2)
        self.assertEqual(a["engageViewerMessages"], 1)  # duplicate and self-echo excluded
        self.assertEqual(a["engageReplies"], 1)
        self.assertEqual(a["engageSent"], 1)
        self.assertEqual(a["vodOverlap"]["twitch"]["overlapPct"], 100.0)
        self.assertEqual(a["vodOverlap"]["youtubeH"]["overlapPct"], 0.0)
        self.assertEqual(a["vodOverlap"]["youtubeV"]["overlapPct"], 100.0)
        self.assertEqual(a["vodOverlap"]["twitch"]["firstVodStartMinusSessionStartSec"], -60.0)
        self.assertEqual(a["engageViewerOutsideVods"], 0)
        self.assertGreaterEqual(a["viewerBins5Min"], 1)
        b = {r["session"]: r for r in summary["sessions"]}["s-b"]
        self.assertEqual(b["twitchViewer"] + b["youtubeViewer"] + b["engageViewerMessages"], 0)
        self.assertEqual(summary["sources"]["twitch"]["inSessions"], 2)

    def test_twitch_time_is_vod_start_plus_offset(self):
        self.run_all()
        tw = [e for e in self.events() if e["source"] == "twitch"]
        self.assertEqual(tw[0]["utc"], z(at(5)))     # created_at - 60 s + 65 s
        self.assertEqual(tw[0]["clip"], "c0.mp4")
        self.assertIsNone(tw[-1]["session"])

    def test_clock_deltas(self):
        summary = self.run_all()
        c = summary["clock"]
        self.assertAlmostEqual(c["twitchCommentCreatedMinusVodOffsetSec"]["median"], 1.5, places=3)
        self.assertAlmostEqual(c["youtubeTimestampMinusVodOffsetSec"]["median"], 0.0, places=3)

    def test_no_text_names_or_author_ids_written(self):
        self.run_all()
        for name in (ca.EVENTS_FILE, ca.SUMMARY_FILE):
            with open(os.path.join(self.out, name), encoding="utf-8") as f:
                body = f.read()
            for secret in (SECRET_TEXT, SECRET_AUTHOR, SECRET_ID, "UCbot", "\"555\""):
                self.assertNotIn(secret, body, f"{secret} leaked into {name}")

    def test_refuses_out_inside_repo(self):
        with self.assertRaises(SystemExit):
            ca.run(self.index, os.path.join(self.tmp.name, "repo", "x"), self.tw, None, None,
                   repo_root=os.path.join(self.tmp.name, "repo"))

    def test_cli_requires_a_source(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            ca.main(["--index", self.index, "--out", self.out])

    def test_cli_writes_outputs(self):
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            rc = ca.main(["--index", self.index, "--out", self.out, "--engage-dir", self.en])
        self.assertEqual(rc, 0)
        self.assertIn("| s-a |", buf.getvalue())
        self.assertTrue(os.path.exists(os.path.join(self.out, ca.SUMMARY_FILE)))


class ClockTests(unittest.TestCase):
    def test_match_unique_rejects_ambiguous(self):
        pairs = ca.match_unique([10.0], [9.0, 9.5], -1, 5)
        self.assertEqual(pairs, [])
        pairs = ca.match_unique([10.0, 30.0], [9.0, 29.0], -1, 5)
        self.assertEqual([round(a - b, 3) for a, b in pairs], [1.0, 1.0])
        # outside [lo, hi]: a post 2 s after the receive is not a match under lo = -1
        self.assertEqual(ca.match_unique([10.0], [12.0], -1, 5), [])

    def test_offset_bounds_bracket_true_offset(self):
        off = 1.0  # PC clock ahead of the platform by 1 s
        events = []
        for i in range(5):
            post = 1000.0 + 120 * i                   # viewer post, platform clock
            recv = post + off + 0.4                   # engage receive, PC clock
            reply = recv - off + 0.3                  # bot reply post, platform clock
            echo = reply + off + 0.4                  # bot reply comes back to engage
            events += [
                {"source": "youtube", "platform": "youtube", "utc": post, "type": "text", "role": "viewer",
                 "orientation": "H"},
                {"source": "youtube", "platform": "youtube", "utc": reply, "type": "text", "role": "moderator",
                 "orientation": "H"},
                {"source": "youtube", "platform": "youtube", "utc": reply + 0.2, "type": "text",
                 "role": "moderator", "orientation": "V"},  # same reply in the other broadcast
                {"source": "engage", "platform": "youtube", "utc": recv, "type": "message", "role": "viewer",
                 "action": "reply"},
                {"source": "engage", "platform": "youtube", "utc": echo, "type": "message", "role": "bot-self",
                 "action": "drop"},
            ]
        res = ca.clock_checks(events, window=20.0, max_offset=5.0)["youtube"]
        lo, hi = res["offsetBoundsSec"]
        self.assertTrue(res["boundsConsistent"])
        self.assertLessEqual(lo, off)
        self.assertGreaterEqual(hi, off)
        self.assertAlmostEqual(hi, 1.4, places=3)
        self.assertAlmostEqual(lo, 0.7, places=3)
        self.assertEqual(res["inbound"]["n"], 10)


if __name__ == "__main__":
    unittest.main()
