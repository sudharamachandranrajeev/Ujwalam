# SPDX-License-Identifier: GPL-3.0-or-later
"""Match gate (D286 proposed, services/clip/match_gate.py): S1 top-3 and scoreboard reading, own kill counting from
the kill feed, match segmentation by end screens, gate decisions, settings, progress lines and the clipper `gate`
step. OCR results are hand-written fixtures in game-area fractions with placeholder names (OWN_NAME, PLAYER_A ...);
the card positions follow the S1 ROIs measured on 2026-11-08 (docs/evidence/2026-11-08-match-gate.md)."""
import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_common as cc  # noqa: E402
import clipper  # noqa: E402
import detector_pass as dp  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402

PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))
S1 = mg.s1_detector(PACK)
CFG = mg.stats_config(PACK)
NAMES = ["OWN_NAME", "OWN-NAME-TTV"]
SETTINGS = {"nameMin": 0.8, "roiSlack": 0.02}
PRIVATE = ("OWN_NAME", "OWNNAME", "PLAYER_A", "PLAYER_B", "PLAYER_C", "PLAYER_D")


def box(text, g, score=0.99):
    return {"text": text, "score": score, "g": list(g)}


def top3_frame(own_card=1, own_text="OWN_NAME", scores=(4053, 4011, 3064)):
    """A top-3 screen as OCR returns it: positions from the 2026-11-08 frames, names replaced by placeholders."""
    names = {1: "PLAYER_A", 2: "PLAYER_B", 3: "PLAYER_C"}
    if own_card:
        names[own_card] = own_text
    return [
        box("HARDPOINT", (0.1785, 0.0417, 0.2467, 0.0786)),
        box("VICTORY", (0.4348, 0.031, 0.5659, 0.1077)),
        box("SUMMIT", (0.1794, 0.0709, 0.2389, 0.1031)),
        box(f"SCORE {scores[0]}", (0.4408, 0.7458, 0.5245, 0.7842)),
        box(f"SCORE {scores[1]}", (0.2009, 0.7842, 0.2829, 0.8225)),
        box(f"SCORE {scores[2]}", (0.6824, 0.7827, 0.7687, 0.8241)),
        box("MVP", (0.3994, 0.841, 0.427, 0.867)),
        box(names[1], (0.402, 0.8762, 0.4607, 0.91)),
        box("PLAYER_D", (0.5176, 0.8793, 0.5901, 0.9085)),
        box(names[2], (0.163, 0.9146, 0.213, 0.9468)),
        box(names[3], (0.6471, 0.9146, 0.717, 0.9468)),
    ]


class Top3Tests(unittest.TestCase):
    def test_pack_has_s1_with_measured_cards(self):
        self.assertIsNotNone(S1)
        ids = {r["id"]: r["status"] for r in S1["rois"]}
        self.assertEqual(ids["rank1_card"], "verified")
        self.assertEqual(ids["scoreboard_rows"], "unverified")
        self.assertEqual(S1["role"], "context")
        self.assertIsNone(S1["weight"])

    def test_own_card_rank_and_score(self):
        r = mg.parse_top3(top3_frame(1), S1, NAMES, 0.8, CFG)
        self.assertEqual(r["ownRank"], 1)
        self.assertEqual(r["ownScore"], 4053)
        self.assertEqual([c["rank"] for c in r["cards"]], [1, 2, 3])
        self.assertEqual([c["score"] for c in r["cards"]], [4053, 4011, 3064])
        self.assertEqual([c["own"] for c in r["cards"]], [True, False, False])
        self.assertTrue(r["orderOk"])

    def test_own_card_left_and_right(self):
        self.assertEqual(mg.parse_top3(top3_frame(2), S1, NAMES, 0.8, CFG)["ownRank"], 2)
        r = mg.parse_top3(top3_frame(3), S1, NAMES, 0.8, CFG)
        self.assertEqual((r["ownRank"], r["ownScore"]), (3, 3064))

    def test_ocr_noise_in_the_name_still_matches(self):
        # the real frames read a quote inside the name on 2 of 3 frames
        r = mg.parse_top3(top3_frame(1, own_text='OWN"NAME'), S1, NAMES, 0.8, CFG)
        self.assertEqual(r["ownRank"], 1)

    def test_streamer_not_on_the_top3(self):
        r = mg.parse_top3(top3_frame(None), S1, NAMES, 0.8, CFG)
        self.assertIsNotNone(r, "still a top-3 screen")
        self.assertIsNone(r["ownRank"])
        self.assertFalse(any(c["own"] for c in r["cards"]))

    def test_no_profile_names_means_no_own_card(self):
        self.assertIsNone(mg.parse_top3(top3_frame(1), S1, [], 0.8, CFG)["ownRank"])

    def test_not_a_top3_screen(self):
        gameplay = [box("SCORE 120", (0.44, 0.75, 0.52, 0.78)), box("OWN_NAME", (0.30, 0.88, 0.36, 0.91))]
        self.assertIsNone(mg.parse_top3(gameplay, S1, NAMES, 0.8, CFG), "one SCORE line is not the top-3 screen")
        self.assertIsNone(mg.parse_top3([], S1, NAMES, 0.8, CFG))

    def test_order_check_flags_scores_out_of_rank_order(self):
        r = mg.parse_top3(top3_frame(1, scores=(3000, 4011, 3064)), S1, NAMES, 0.8, CFG)
        self.assertFalse(r["orderOk"])

    def test_mode_label(self):
        self.assertEqual(mg.parse_mode_label(top3_frame(1), S1, CFG), "hardpoint")
        self.assertIsNone(mg.parse_mode_label([box("HARDPOINT", (0.6, 0.5, 0.7, 0.55))], S1, CFG), "outside the ROI")

    def test_frame_stats_rows_and_readings_carry_no_names(self):
        rows, readings = mg.frame_stats(top3_frame(2), PACK, NAMES, 0.8, "mp")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["detector"], "S1")
        self.assertEqual(rows[0]["label"], "TOP 3")
        self.assertTrue(rows[0]["signal"])
        self.assertFalse(rows[0]["clipReason"])
        self.assertEqual(readings[0]["kind"], "top3")
        self.assertEqual(readings[0]["ownRank"], 2)
        self.assertEqual(readings[0]["gameMode"], "hardpoint")
        text = json.dumps([rows, readings]).upper()
        for p in PRIVATE:
            self.assertNotIn(p, text)
        rows, _ = mg.frame_stats(top3_frame(None), PACK, NAMES, 0.8, "mp")
        self.assertEqual((rows[0]["signal"], rows[0]["why"]), (False, ["no_name_on_card"]))


class ScoreboardTests(unittest.TestCase):
    """UNVERIFIED layout (no real scoreboard frame): the header-column rule only."""

    def frame(self, header="K", kills="17"):
        return [
            box("SCORE", (0.40, 0.52, 0.46, 0.55)), box(header, (0.55, 0.52, 0.57, 0.55)),
            box("D", (0.62, 0.52, 0.64, 0.55)),
            box("OWN_NAME", (0.10, 0.62, 0.20, 0.66)), box("3120", (0.40, 0.62, 0.46, 0.66)),
            box(kills, (0.55, 0.62, 0.575, 0.66)), box("9", (0.62, 0.62, 0.635, 0.66)),
            box("PLAYER_A", (0.10, 0.68, 0.20, 0.72)), box("25", (0.55, 0.68, 0.575, 0.72)),
        ]

    def test_own_row_kills_under_the_header(self):
        self.assertEqual(mg.parse_scoreboard_kills(self.frame(), S1, NAMES, 0.8, CFG), 17)
        self.assertEqual(mg.parse_scoreboard_kills(self.frame(header="KILLS"), S1, NAMES, 0.8, CFG), 17)

    def test_no_header_or_no_own_row_reads_nothing(self):
        self.assertIsNone(mg.parse_scoreboard_kills(self.frame(header="X"), S1, NAMES, 0.8, CFG))
        self.assertIsNone(mg.parse_scoreboard_kills(self.frame(), S1, [], 0.8, CFG))
        self.assertIsNone(mg.parse_scoreboard_kills(top3_frame(1), S1, NAMES, 0.8, CFG))

    def test_frame_stats_scoreboard_row(self):
        rows, readings = mg.frame_stats(self.frame(), PACK, NAMES, 0.8, "mp")
        self.assertEqual([r["label"] for r in rows], ["SCOREBOARD"])
        self.assertEqual(readings, [{"kind": "scoreboard", "ownKills": 17}])


class KillCountTests(unittest.TestCase):
    def test_victim_key(self):
        self.assertEqual(mg.victim_key("OWN_NAME | PLAYER_A"), mg.victim_key("XX | PLAYER_A"))
        self.assertNotEqual(mg.victim_key("OWN_NAME | PLAYER_A"), mg.victim_key("OWN_NAME | PLAYER_B"))
        self.assertIsNone(mg.victim_key(""))

    def test_one_line_over_several_frames_is_one_kill(self):
        k = mg.KillCounter(hold_sec=6)
        for t in range(0, 5):
            k.feed(float(t), ["PLAYERA"])
        self.assertEqual(k.times, [0.0])

    def test_two_lines_at_once_are_two_kills(self):
        k = mg.KillCounter(hold_sec=6)
        k.feed(10.0, ["ALPHAONE"])
        k.feed(11.0, ["ALPHAONE", "ZULUTWO"])
        k.feed(12.0, ["ALPHAONE", "ZULUTWO"])
        self.assertEqual(k.times, [10.0, 11.0])

    def test_ocr_noise_on_the_victim_is_the_same_kill(self):
        k = mg.KillCounter(hold_sec=6, key_min=0.7)
        k.feed(1.0, ["PLAYERA"])
        k.feed(2.0, ["PIAYERA"])
        self.assertEqual(len(k.times), 1)

    def test_cut_reads_of_one_victim_are_one_kill(self):
        # OCR read one victim as the full name, its tail, a middle part and a short tail on consecutive frames
        k = mg.KillCounter(hold_sec=6, key_min=0.7)
        for t, key in enumerate(["XXPLAYERQWERTY", "AYERQWERTY", "PLAYERQW", "WERTY", "RQWE"]):
            k.feed(float(t), [key])
        self.assertEqual(len(k.times), 1)
        k.feed(5.0, ["ZULUFOXTROT"])
        self.assertEqual(len(k.times), 2, "a different victim is a new kill")

    def test_one_line_read_twice_in_a_frame_is_one_kill(self):
        k = mg.KillCounter(hold_sec=6)
        k.feed(1.0, ["BRAVOKILO", "BRAV0KILO"])
        k.feed(2.0, ["XXBRAVOKILO", "BRAVOKILO"])
        self.assertEqual(len(k.times), 1)

    def test_same_victim_after_the_hold_is_a_new_kill(self):
        k = mg.KillCounter(hold_sec=6)
        k.feed(1.0, ["PLAYERA"])
        k.feed(30.0, ["PLAYERA"])
        self.assertEqual(k.times, [1.0, 30.0])

    def test_unreadable_victims_count_by_line_number(self):
        k = mg.KillCounter(hold_sec=6)
        k.feed(1.0, [None])
        k.feed(2.0, [None, None])
        k.feed(3.0, [None])
        self.assertEqual(len(k.times), 2)

    def test_frame_hits_gives_one_key_per_own_line_and_rows_stay_clean(self):
        feed = [box("OWN_NAME", (0.30, 0.88, 0.36, 0.91)), box("PLAYER_A", (0.42, 0.88, 0.48, 0.91)),
                box("PLAYER_B", (0.30, 0.92, 0.36, 0.95)), box("OWN_NAME", (0.42, 0.92, 0.48, 0.95))]
        keys = []
        rows = dp.frame_hits([dict(b) for b in feed], PACK, NAMES, SETTINGS, "mp", kill_keys=keys)
        self.assertEqual(keys, [mg.victim_key("OWN_NAME | PLAYER_A")], "the line where the streamer is the victim is no kill")
        plain = dp.frame_hits([dict(b) for b in feed], PACK, NAMES, SETTINGS, "mp")
        self.assertEqual(rows, plain, "kill keys never change the hit rows")
        self.assertNotIn("PLAYER", json.dumps(rows).upper())
        keys = []
        dp.frame_hits([dict(b) for b in feed], PACK, NAMES, SETTINGS, "br", kill_keys=keys)
        self.assertEqual(keys, [], "the MP kill feed does not count in BR")


def hit(t, det, label=None, signal=True, mode="mp", t_end=None, why=None):
    return {"t": t, "tEnd": t if t_end is None else t_end, "detector": det, "label": label, "signal": signal,
            "why": why or [], "mode": mode}


class SegmentTests(unittest.TestCase):
    def hits(self):
        return [
            hit(20, "M5", "MP kill feed"), hit(300, "W1", "VICTORY"), hit(320, "M2", "IMPACT PLAY"),
            hit(331, "S1", "TOP 3", t_end=345), hit(346, "W1", "VICTORY", signal=False, why=["outside_roi"]),
            hit(400, "M5", "MP kill feed"), hit(700, "W1", "DEFEAT"), hit(735, "S1", "TOP 3", signal=False, t_end=748),
            hit(800, "M5", "MP kill feed"),
        ]

    def stats(self):
        return {"readings": [
            {"t": 335, "kind": "top3", "ownRank": 2, "ownScore": 3900, "gameMode": "hardpoint", "cards": []},
            {"t": 340, "kind": "top3", "ownRank": 2, "ownScore": 3900, "gameMode": "hardpoint", "cards": []},
            {"t": 740, "kind": "top3", "ownRank": None, "ownScore": None, "gameMode": "domination", "cards": []},
        ], "ownKills": {"times": [20, 50, 90, 310, 400, 410, 650, 720, 800]}}

    def test_matches_from_end_screens(self):
        ms = mg.segment(self.hits(), self.stats(), 900.0, CFG)
        self.assertEqual([(m["start"], m["end"], m["endSeen"]) for m in ms],
                         [(0.0, 346.0, True), (346.0, 748.0, True), (748.0, 900.0, False)])
        a, b, c = ms
        self.assertEqual((a["result"], a["mode"], a["ownRank"], a["ownScore"], a["top3Seen"]),
                         ("VICTORY", "hardpoint", 2, 3900, True))
        self.assertEqual((a["ownKills"], a["killsSource"]), (3, "killfeed"), "kills before the first end screen only")
        self.assertEqual((b["result"], b["mode"], b["ownRank"], b["top3Seen"]), ("DEFEAT", "domination", None, True))
        self.assertEqual(b["ownKills"], 3)
        self.assertEqual((c["result"], c["ownRank"], c["top3Seen"], c["ownKills"]), (None, None, False, 1))
        self.assertEqual(c["mode"], "mp", "HUD mode when no top-3 screen named the game mode")

    def test_scoreboard_kills_win_over_the_kill_feed(self):
        st = self.stats()
        st["readings"].append({"t": 342, "kind": "scoreboard", "ownKills": 21})
        a = mg.segment(self.hits(), st, 900.0, CFG)[0]
        self.assertEqual((a["ownKills"], a["killsSource"]), (21, "scoreboard"))

    def test_without_match_stats_the_kill_feed_hits_count(self):
        a = mg.segment(self.hits(), None, 900.0, CFG)[0]
        self.assertEqual((a["ownKills"], a["killsSource"], a["top3Seen"]), (1, "killfeed", False))

    def test_no_end_screen_is_one_open_match(self):
        ms = mg.segment([hit(20, "M5", "MP kill feed")], None, 120.0, CFG)
        self.assertEqual([(m["start"], m["end"], m["endSeen"]) for m in ms], [(0.0, 120.0, False)])
        self.assertEqual(mg.segment([], None, 60.0, CFG)[0]["killsSource"], None)

    def test_m1_outside_its_roi_is_no_end_screen(self):
        hs = [hit(100, "M1", "MVP", signal=False, why=["outside_roi"])]
        self.assertEqual(len(mg.end_clusters(hs, CFG)), 0)
        self.assertEqual(len(mg.end_clusters([hit(100, "M1", "MVP")], CFG)), 1)

    def test_end_screens_far_apart_are_two_matches(self):
        hs = [hit(100, "W1", "VICTORY"), hit(100 + CFG["endGapSec"] + 1, "W1", "DEFEAT")]
        self.assertEqual(len(mg.end_clusters(hs, CFG)), 2)


class DecideTests(unittest.TestCase):
    def m(self, **kw):
        base = {"endSeen": True, "ownRank": None, "top3Seen": True, "ownKills": 5, "killsSource": "killfeed"}
        return {**base, **kw}

    def test_rules(self):
        on = {"top3": True, "minKills": None}
        self.assertEqual(mg.decide(self.m(ownRank=3), on), (True, "in the top 3 (#3)"))
        self.assertEqual(mg.decide(self.m(), on), (False, "not in the top 3"))
        both = {"top3": True, "minKills": 10}
        self.assertTrue(mg.decide(self.m(ownKills=10), both)[0])
        self.assertEqual(mg.decide(self.m(ownKills=9), both), (False, "not in the top 3; 9 kills (fewer than 10)"))
        kills_only = {"top3": False, "minKills": 4}
        self.assertTrue(mg.decide(self.m(ownRank=None, ownKills=4), kills_only)[0])
        self.assertFalse(mg.decide(self.m(ownRank=1, ownKills=3), kills_only)[0], "top3 off: rank does not count")

    def test_keeps_work_when_unsure(self):
        on = {"top3": True, "minKills": None}
        p, why = mg.decide(self.m(endSeen=False), on)
        self.assertTrue(p)
        self.assertIn("no end screen", why)
        p, why = mg.decide(self.m(top3Seen=False), on)
        self.assertTrue(p)
        self.assertIn("top-3 screen not read", why)
        p, why = mg.decide(self.m(top3Seen=True, ownKills=None, killsSource=None), {"top3": False, "minKills": 5})
        self.assertTrue(p)
        self.assertIn("kills not read", why)
        self.assertEqual(mg.decide(self.m(), {"top3": False, "minKills": None}), (True, "match gate off: clips kept"))

    def test_gate_candidates_by_anchor(self):
        matches = [{"index": 1, "start": 0.0, "end": 346.0, "endSeen": True, "ownRank": None, "top3Seen": True,
                    "ownKills": 2, "killsSource": "killfeed"},
                   {"index": 2, "start": 346.0, "end": 748.0, "endSeen": True, "ownRank": 1, "top3Seen": True,
                    "ownKills": 9, "killsSource": "killfeed"},
                   {"index": 3, "start": 748.0, "end": 900.0, "endSeen": False, "ownRank": None, "top3Seen": False,
                    "ownKills": 0, "killsSource": "killfeed"}]
        cands = [{"id": "c01", "start": 330, "end": 360, "anchor": 350}, {"id": "c02", "start": 10, "end": 40, "anchor": 20},
                 {"id": "c03", "start": 800, "end": 830, "anchor": 810}]
        kept, dropped = mg.gate_candidates(cands, matches, {"top3": True, "minKills": None})
        self.assertEqual([c["id"] for c in kept], ["c01", "c03"])
        self.assertEqual([(c["id"], c["match"], c["gateReason"]) for c in dropped], [("c02", 1, "not in the top 3")])
        self.assertEqual([m["passed"] for m in matches], [False, True, True])
        self.assertEqual(matches[1]["candidates"], ["c01"])

    def test_gate_saves_by_time(self):
        import clip_signals as sig
        matches = [{"index": 1, "startUtc": "2026-11-08T10:00:00.000Z", "endUtc": "2026-11-08T10:05:00.000Z",
                    "endSeen": True, "ownRank": None, "top3Seen": True, "ownKills": 1},
                   {"index": 2, "startUtc": "2026-11-08T10:05:00.000Z", "endUtc": "2026-11-08T10:10:00.000Z",
                    "endSeen": True, "ownRank": 2, "top3Seen": True, "ownKills": 1}]
        rows = [{"at": "2026-11-08T10:01:00.000Z", "startBack": 20, "endBack": 0},
                {"at": "2026-11-08T10:06:00.000Z", "startBack": 20, "endBack": 0},
                {"at": "2026-11-08T11:00:00.000Z", "startBack": 20, "endBack": 0},
                {"at": "bad"}]
        kept, dropped = mg.gate_saves(rows, matches, {"top3": True, "minKills": None}, sig.parse_iso)
        self.assertEqual([r["at"] for r in kept], ["2026-11-08T10:06:00.000Z", "2026-11-08T11:00:00.000Z", "bad"])
        self.assertEqual(dropped, [{"at": "2026-11-08T10:01:00.000Z", "match": 1, "reason": "not in the top 3"}])


class SettingsAndProgressTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = self.td.name

    def tearDown(self):
        self.td.cleanup()

    def put(self, obj):
        with open(os.path.join(self.d, "settings.json"), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def test_match_gate_settings(self):
        self.assertEqual(cc.match_gate_settings(None), {"top3": True, "minKills": None})
        self.assertEqual(cc.match_gate_settings(self.d), {"top3": True, "minKills": None})
        self.put({"clips": {"matchGate": {"top3": False, "minKills": 12}}})
        self.assertEqual(cc.match_gate_settings(self.d), {"top3": False, "minKills": 12})
        for bad in (0, 201, 2.5, "10", True):
            self.put({"clips": {"matchGate": {"minKills": bad}}})
            self.assertEqual(cc.match_gate_settings(self.d), {"top3": True, "minKills": None}, repr(bad))
        self.put({"clips": {"matchGate": {"top3": "no", "minKills": 200}}})
        self.assertEqual(cc.match_gate_settings(self.d), {"top3": True, "minKills": 200})
        self.put({"clips": {"matchGate": []}})
        self.assertEqual(cc.match_gate_settings(self.d), {"top3": True, "minKills": None})
        self.put({"clips": {"recording": "after"}})
        self.assertEqual(cc.clip_settings(self.d), {"recording": "after", "live": "ask"}, "clip modes unchanged")

    def test_progress_line_contract(self):
        err = io.StringIO()
        with redirect_stderr(err):
            line = cc.progress_line("detect", 12, 476, "reading   the game\nscreen")
        self.assertEqual(err.getvalue(), line + "\n")
        self.assertEqual(line, 'ujwalam-progress {"stage":"detect","done":12,"total":476,"note":"reading the game screen"}')
        pat = re.compile(r'^ujwalam-progress \{"stage":"(detect|candidates|render|validate|review|gate|publish|montage)",'
                         r'"done":\d+,"total":\d+,"note":"[^"\n]{0,120}"\}$')
        for st in cc.PROGRESS_STAGES:
            with redirect_stderr(io.StringIO()):
                self.assertRegex(cc.progress_line(st, 0, 0, "x" * 300), pat)
        with self.assertRaises(ValueError):
            cc.progress_line("upload", 0, 1)


class GateCommandTests(unittest.TestCase):
    """clipper.py gate on a run folder (no media: the gate reads only json files)."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.td.name, "out")
        self.data = os.path.join(self.td.name, "data")
        os.makedirs(self.out)
        os.makedirs(self.data)
        self.rec = os.path.join(self.td.name, "practice-h-20261108-132438.mkv")
        seg = SegmentTests()
        with open(os.path.join(self.out, "detector-hits.jsonl"), "w", encoding="utf-8") as f:
            for h in seg.hits():
                f.write(json.dumps(h) + "\n")
        self.w("detector-pass.json", {"recording": os.path.basename(self.rec), "game": "codm"})
        self.w("match-stats.json", {"recording": os.path.basename(self.rec), **seg.stats()})
        self.w("candidates.json", {
            "recording": os.path.basename(self.rec), "recordStartUtc": "2026-11-08T13:24:38Z", "duration": 900.0,
            "candidates": [{"id": "c01", "rank": 1, "start": 330, "end": 360, "anchor": 350},
                           {"id": "c02", "rank": 2, "start": 10, "end": 40, "anchor": 20},
                           {"id": "c03", "rank": 3, "start": 700, "end": 730, "anchor": 710},
                           {"id": "c04", "rank": 4, "start": 800, "end": 830, "anchor": 810}]})

    def tearDown(self):
        self.td.cleanup()

    def w(self, name, obj):
        with open(os.path.join(self.out, name), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def r(self, name):
        with open(os.path.join(self.out, name), encoding="utf-8") as f:
            return json.load(f)

    def gate(self):
        a = clipper.build_parser().parse_args(["--data-dir", self.data, "gate", "--recording", self.rec, "--out", self.out])
        a.out = os.path.abspath(a.out)
        err, out = io.StringIO(), io.StringIO()
        with redirect_stderr(err), redirect_stdout(out):
            self.assertEqual(clipper.cmd_gate(a), 0)
        return err.getvalue(), out.getvalue()

    def test_gate_writes_matches_and_moves_skipped_candidates(self):
        err, _out = self.gate()
        doc = self.r("candidates.json")
        # match 1: #2 on the top 3 -> kept; match 2: not on the top 3 -> skipped; match 3: no end seen -> kept
        self.assertEqual([c["id"] for c in doc["candidates"]], ["c02", "c04"])
        self.assertEqual([(c["id"], c["match"]) for c in doc["gatedOut"]], [("c01", 2), ("c03", 2)])
        self.assertEqual(doc["matchGate"]["kept"], 2)
        m = self.r("matches.json")
        self.assertEqual(m["gate"], {"top3": True, "minKills": None})
        self.assertEqual([x["passed"] for x in m["matches"]], [True, False, True])
        self.assertEqual(m["matches"][0]["startUtc"], "2026-11-08T13:24:38.000Z")
        self.assertEqual(set(m["matches"][0]) >= {"start", "end", "result", "mode", "ownRank", "ownScore", "ownKills",
                                                   "killsSource", "passed", "reason"}, True)
        lines = [l for l in err.splitlines() if l.startswith("ujwalam-progress ")]
        self.assertEqual(json.loads(lines[-1][len("ujwalam-progress "):])["stage"], "gate")
        self.assertEqual(json.loads(lines[-1][len("ujwalam-progress "):])["done"], 3)
        for name in ("candidates.json", "matches.json"):
            text = json.dumps(self.r(name)).upper()
            for p in PRIVATE:
                self.assertNotIn(p, text)

    def test_gate_again_with_new_settings_restores_candidates(self):
        self.gate()
        with open(os.path.join(self.data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"matchGate": {"top3": False}}}, f)
        self.gate()
        doc = self.r("candidates.json")
        self.assertEqual([c["id"] for c in doc["candidates"]], ["c01", "c02", "c03", "c04"], "gate off: all back, rank order")
        self.assertEqual(doc["gatedOut"], [])

    def test_no_hits_keeps_everything(self):
        os.remove(os.path.join(self.out, "detector-hits.jsonl"))
        os.remove(os.path.join(self.out, "match-stats.json"))
        self.gate()
        self.assertEqual(len(self.r("candidates.json")["candidates"]), 4)
        self.assertEqual([x["endSeen"] for x in self.r("matches.json")["matches"]], [False])


if __name__ == "__main__":
    unittest.main()
