# SPDX-License-Identifier: GPL-3.0-or-later
"""Summary-screen mode header (C2) as game-mode evidence, and own kill-feed counting (match_gate). Synthetic OCR
boxes and hit sequences only (no images, no names), in game-area fractions; positions and timings follow the
2026-11-09 practice recording (docs/evidence/2026-11-10-lobby-mode-and-kill-dedup.md)."""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import detector_pass as dp  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402

PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))
CFG = mg.stats_config(PACK)
SETTINGS = {"nameMin": 0.8, "roiSlack": 0.02}
HEADER_G = [0.510, 0.022, 0.636, 0.055]   # mode name in the summary header, 2026-11-09 390 s
MATCH_G = [0.413, 0.374, 0.589, 0.476]    # VICTORY on a match-end banner


def hit(t, det, label=None, signal=True, t_end=None, why=None, **kw):
    return dict({"t": float(t), "tEnd": float(t if t_end is None else t_end), "detector": det, "label": label,
                 "signal": signal, "why": why or [], "mode": "mp"}, **kw)


def match_end(t, top3_mode=None):
    """Match-end banner at t, then IMPACT PLAY, MVP, top 3 (2026-11-09 order)."""
    return [hit(t, "W1", "VICTORY", banner="match", subtitle=None),
            hit(t + 6, "M2", "IMPACT PLAY", signal=False, t_end=t + 24, why=["no_name_in_roi"]),
            hit(t + 25, "M1", "MVP", t_end=t + 40), hit(t + 28, "S1", "TOP 3", t_end=t + 40)]


class SummaryHeaderTests(unittest.TestCase):
    def test_pack_c2(self):
        c2 = next(d for d in PACK["detectors"] if d["id"] == "C2")
        self.assertEqual((c2["role"], c2["nameRequired"], c2["screens"]), ("context", False, ["summary"]))
        self.assertEqual(c2["status"], "unverified")
        summary = next(s for s in PACK["screens"] if s["id"] == "summary")
        self.assertEqual(summary["detectors"], ["C2"])
        self.assertIn("SEARCH & DESTROY", [q["text"] for q in CFG["headerCues"]])
        self.assertGreater(CFG["headerAfterSec"], 0)

    def test_header_rows_pack_text_only(self):
        boxes = [{"text": "SEARCH & DESTROY", "score": 0.99, "g": HEADER_G},
                 {"text": "SOME MAP", "score": 0.99, "g": [0.51, 0.061, 0.625, 0.089]},
                 {"text": "DOMINATION", "score": 0.99, "g": [0.20, 0.50, 0.28, 0.53]}]
        rows = [r for r in dp.frame_hits(boxes, PACK, [], SETTINGS, "mp") if r["detector"] == "C2"]
        self.assertEqual(sorted((r["label"], r["signal"]) for r in rows),
                         [("DOMINATION", False), ("SEARCH & DESTROY", True)],
                         "the mode name outside the header box (a mode-select tile) is no signal")
        self.assertTrue(all(r["role"] == "context" and r["clipReason"] is False for r in rows))

    def test_header_alone_decides_with_high_confidence(self):
        mode, conf, ev, why = mg.game_mode([], [], [], None, CFG, [hit(2440, "C2", "DOMINATION")])
        self.assertEqual((mode, conf), ("domination", "high"))
        self.assertEqual(ev[0]["source"], "summary header")
        self.assertEqual(ev[0]["at"], 2440.0)

    def test_header_disagreeing_with_cues_gives_no_mode(self):
        cues = [hit(290, "C1", "DESTROY TARGET"), hit(400, "C1", "PLANTS")]
        mode, conf, ev, why = mg.game_mode([], cues, [], None, CFG, [hit(395, "C2", "DOMINATION")])
        self.assertEqual((mode, conf), (None, None))
        self.assertIn("evidence disagrees", why)
        self.assertEqual({e["source"] for e in ev}, {"mode cue", "summary header"})

    def test_header_agreeing_with_top3(self):
        tops = [{"t": 375.0, "gameMode": "search and destroy"}]
        mode, conf, ev, _ = mg.game_mode(tops, [], [], None, CFG, [hit(390, "C2", "SEARCH & DESTROY"),
                                                                 hit(395, "C2", "SEARCH & DESTROY")])
        self.assertEqual((mode, conf), ("search and destroy", "high"))
        self.assertEqual(len(ev), 2, "repeats of the same header are one item")

    def test_segment_header_belongs_to_the_match_that_ended(self):
        # match 1 ends at 354 (end screens to 394), header at 390 and 395; match 2 ends at 1091 with no header and
        # no other evidence. A header read later than headerAfterSec after the end screens counts for no match.
        after = CFG["headerAfterSec"]
        hs = match_end(354) + [hit(390, "C2", "SEARCH & DESTROY"), hit(395, "C2", "SEARCH & DESTROY")]
        hs += [hit(394 + after + 5, "C2", "DOMINATION")]        # too late for match 1, never evidence for match 2
        hs += match_end(1091)
        ms = mg.segment(hs, None, 1200.0, CFG)
        self.assertEqual(ms[0]["gameMode"], "search and destroy")
        self.assertEqual([e["at"] for e in ms[0]["modeEvidence"]], [390.0])
        self.assertIsNone(ms[1]["gameMode"])
        self.assertEqual(ms[1]["modeReason"], "no mode evidence")

    def test_header_hit_dated_to_the_summary_screen(self):
        # top-3 screen shows the mode name outside the header ROI (unsignalled), then the summary screen in the ROI
        rows = [dict(hit(t, "C2", "CONTROL", signal=False, why=["outside_roi"]), ocrScore=0.9) for t in range(3095, 3110)]
        rows += [dict(hit(t, "C2", "CONTROL"), ocrScore=0.9) for t in (3110, 3111, 3112)]
        _g, settings, _d = dp.load_settings("codm")
        self.assertIn("C2", settings["splitBySignal"])
        merged = dp.merge_hits(rows, float(settings["mergeGapSec"]), settings["splitBySignal"])
        self.assertEqual([(h["t"], h["signal"]) for h in merged], [(3095.0, False), (3110.0, True)])

    def test_segment_no_header_on_open_tail(self):
        hs = match_end(354) + [hit(1000, "C2", "DOMINATION")]
        ms = mg.segment(hs, None, 1100.0, CFG)
        self.assertFalse(ms[-1]["endSeen"])
        self.assertIsNone(ms[-1]["gameMode"])


import g1_text as gt  # noqa: E402

NAMES = ["OWN_NAME"]


def fbox(text, x0, y0, x1, y1, score=0.95):
    return {"text": text, "score": score, "g": [x0, y0, x1, y1]}


class KillFeedReadingTests(unittest.TestCase):
    """Own kill-feed lines as the ROI-band OCR returned them on the 2026-11-09 practice (texts are placeholders)."""

    def test_merged_line_box_with_own_name_at_the_end_is_a_death(self):
        # band OCR merged killer, icon gap and victim into one box and also read the victim as a second box
        line = [{"text": "PLAYER_A OWN_NAME", "x0": 0.35, "y0": 0.86, "x1": 0.53, "y1": 0.89},
                {"text": "OWN_NAME", "x0": 0.46, "y0": 0.86, "x1": 0.53, "y1": 0.89}]
        self.assertEqual(gt.killfeed_side(line, NAMES, 0.8)[0], "victim")
        kill = [{"text": "OWN_NAME PLAYER_A", "x0": 0.35, "y0": 0.86, "x1": 0.53, "y1": 0.89},
                {"text": "PLAYER_A", "x0": 0.46, "y0": 0.86, "x1": 0.53, "y1": 0.89}]
        self.assertEqual(gt.killfeed_side(kill, NAMES, 0.8)[0], "killer")

    def test_long_own_name_with_short_victim_in_one_box_is_a_kill(self):
        # Codex review: a long own name plus a short victim scores above 0.8 as a whole; it is still a merged line
        names = ["ABCDEFGHIJKLMN"]
        box = [{"text": "ABCDEFGHIJKLMN XYZ", "x0": 0.35, "y0": 0.86, "x1": 0.53, "y1": 0.89}]
        self.assertEqual(gt.killfeed_side(box, names, 0.8)[0], "killer")

    def test_victim_text_skips_counts_and_the_own_name(self):
        b = lambda text, x0: {"text": text, "x0": x0, "y0": 0.86, "x1": x0 + 0.05, "y1": 0.89}  # noqa: E731
        self.assertEqual(gt.victim_text([b("OWN_NAME", 0.35), b("KESTREL", 0.44), b("2", 0.50)], NAMES), "KESTREL")
        self.assertEqual(gt.victim_text([b("OWN_NAMEKESTREL", 0.35), b("OWN_NAME", 0.47)], NAMES), "KESTREL",
                         "a second own-name box is no victim; the merged box's tail is")
        self.assertEqual(gt.victim_text([b("OWN_NAMEKESTREL", 0.35)], NAMES), "KESTREL")
        self.assertEqual(gt.victim_text([b("OWN_NAME", 0.35)], NAMES), "", "no victim text: the key is None")

    def test_merged_box_and_two_box_reads_of_one_line_are_one_kill(self):
        k = mg.KillCounter(CFG["killLineHoldSec"], CFG["victimMatchMin"])
        frames = [[fbox("OWN_NAME", 0.35, 0.86, 0.42, 0.89), fbox("TOP", 0.44, 0.86, 0.47, 0.89)],
                  [fbox("OWN_NAMETOP", 0.35, 0.86, 0.47, 0.89)],
                  [fbox("OWN_NAME", 0.35, 0.86, 0.42, 0.89), fbox("TOP", 0.44, 0.86, 0.47, 0.89),
                   fbox("4", 0.49, 0.86, 0.50, 0.89)]]
        for t, boxes in enumerate(frames):
            keys = []
            dp.frame_hits(boxes, PACK, NAMES, SETTINGS, "mp", kill_keys=keys)
            k.feed(float(t), keys)
        self.assertEqual(len(k.times), 1)

    def test_name_variant_box_alone_is_no_line(self):
        self.assertEqual(gt.killfeed_side([{"text": "OWN-NAME-TTV", "x0": 0.35, "y0": 0.86, "x1": 0.45, "y1": 0.89}],
                                          ["OWN_NAME", "OWN-NAME-TTV"], 0.8)[0], None)

    def test_frame_hits_counts_no_kill_for_a_merged_death_line(self):
        boxes = [fbox("PLAYER_A OWN_NAME", 0.35, 0.86, 0.53, 0.89), fbox("OWN_NAME", 0.46, 0.86, 0.53, 0.89)]
        keys = []
        dp.frame_hits(boxes, PACK, NAMES, SETTINGS, "mp", kill_keys=keys)
        self.assertEqual(keys, [])

    def test_group_lines_does_not_creep_down_the_rows(self):
        # three feed rows 0.026 apart, boxes 0.025 high, with a stray box between rows 1 and 2
        rows = [{"text": "R1", "x0": 0.3, "y0": 0.860, "x1": 0.4, "y1": 0.885},
                {"text": "STRAY", "x0": 0.5, "y0": 0.871, "x1": 0.6, "y1": 0.896},
                {"text": "R2", "x0": 0.3, "y0": 0.886, "x1": 0.4, "y1": 0.911},
                {"text": "R3", "x0": 0.3, "y0": 0.912, "x1": 0.4, "y1": 0.937}]
        lines = gt.group_lines(rows)
        self.assertEqual(len(lines), 3)
        self.assertEqual([[b["text"] for b in ln] for ln in lines][-1], ["R3"])

    def test_stale_band_boxes_dropped_under_a_current_band(self):
        size = (1000, 1000)
        feed = {"px": (300, 800, 600, 1000)}          # kill-feed band, read every frame
        wide = {"px": (0, 400, 1000, 1000)}           # every-5th-frame band that also covers the feed
        old_row = {"text": "OWN_NAME PLAYER_B", "score": 0.9, "x0": 350, "y0": 460, "x1": 530, "y1": 490}
        cur_row = {"text": "OWN_NAME PLAYER_B", "score": 0.9, "x0": 50, "y0": 86, "x1": 230, "y1": 115}
        other = {"text": "TOP TEXT", "score": 0.9, "x0": 10, "y0": 10, "x1": 200, "y1": 40}
        out = dp.band_boxes([[cur_row], [old_row, other]], [feed, wide], size, stale=[False, True])
        self.assertEqual(sorted((b["text"], b["y0"]) for b in out), [("OWN_NAME PLAYER_B", 886), ("TOP TEXT", 410)],
                         "the held copy one row up is dropped; held text outside the current band stays")
        both = dp.band_boxes([[cur_row], [old_row, other]], [feed, wide], size)
        self.assertEqual(len(both), 3, "without the stale flag both copies are kept (the old behaviour)")


class KillCounterSequenceTests(unittest.TestCase):
    """Synthetic per-frame key sequences (1 fps) through KillCounter."""

    def setUp(self):
        self.k = mg.KillCounter(CFG["killLineHoldSec"], CFG["victimMatchMin"])

    def test_one_line_on_screen_for_five_seconds_is_one_kill(self):
        for t in range(5):
            self.k.feed(float(t), [mg.victim_key("OWN_NAME | PLAYER_A")])
        self.assertEqual(len(self.k.times), 1)

    def test_dense_kills_stay_separate(self):
        # keys are victim-name tails; distinct placeholder words (PLAYERA vs PLAYERB would be one similar key)
        seq = [["KESTREL"], ["KESTREL", "BADGER"], ["KESTREL", "BADGER", "MOONFOX"], ["BADGER", "MOONFOX"]]
        for t, keys in enumerate(seq):
            self.k.feed(float(t), keys)
        self.assertEqual(len(self.k.times), 3)

    def test_feeds_follow_the_counted_kills(self):
        self.k.feed(0.0, ["KESTREL", "KESTREL", "BADGER"], ["M5", "M5", "B1"])
        self.k.feed(1.0, ["KESTREL"], ["M5"])
        self.assertEqual((self.k.times, self.k.feeds), ([0.0, 0.0], ["M5", "B1"]))

    def test_segment_counts_only_the_feed_of_the_match_family(self):
        # an MP match (HUD rows mp) with 3 M5 kills and 2 B1 kills read on a loadout screen and an end card
        hs = [hit(t, "M5", "kill") for t in (20, 225, 316)] + match_end(354)
        stats = {"readings": [], "ownKills": {"times": [20.0, 28.0, 192.0, 225.0, 316.0],
                                              "feeds": ["M5", "B1", "B1", "M5", "M5"]}}
        ms = mg.segment(hs, stats, 400.0, CFG)
        self.assertEqual(ms[0]["ownKills"], 3)
        old = {"readings": [], "ownKills": {"times": [20.0, 28.0, 192.0, 225.0, 316.0]}}
        self.assertEqual(mg.segment(hs, old, 400.0, CFG)[0]["ownKills"], 5, "older runs without feeds: all count")

    def test_hits_only_run_counts_every_feed(self):
        # Codex review: with no match-stats the kill times come from the hits; a B1 kill on an MP match still counts
        hs = [hit(t, "M5", "kill") for t in (20, 225)] + [hit(100, "B1", "kill")] + match_end(354)
        no_stats = mg.segment(hs, None, 400.0, CFG)[0]["ownKills"]
        self.assertEqual(no_stats, len(mg.killfeed_instances(hs)))

    def test_frame_hits_reports_the_feed_of_each_key(self):
        keys, feeds = [], []
        boxes = [fbox("OWN_NAME", 0.30, 0.88, 0.36, 0.91), fbox("PLAYER_A", 0.42, 0.88, 0.48, 0.91)]
        dp.frame_hits(boxes, PACK, NAMES, SETTINGS, "mp", kill_keys=keys, kill_feeds=feeds)
        self.assertEqual((len(keys), feeds), (1, ["M5"]))

    def test_same_victim_again_after_the_hold_is_a_new_kill(self):
        self.k.feed(0.0, ["PLAYERA"])
        self.k.feed(CFG["killLineHoldSec"] + 5, ["PLAYERA"])
        self.assertEqual(len(self.k.times), 2)


if __name__ == "__main__":
    unittest.main()
