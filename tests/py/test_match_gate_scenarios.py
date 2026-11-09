# SPDX-License-Identifier: GPL-3.0-or-later
"""Match gate and W1 won-reel selection together, from synthetic OCR readings (2026-11-09). One recording of five
matches, one per case: top 3, DEFEAT, not top 3, unreadable (end seen, no top-3 reading) and no end screen. Locks
the current rules: gate = match_gate.segment + decide + gate_candidates; reels = match_gate.reel_decide (D315 rules
of the pack) + clip_montage.match_reels (a qualifying match with an own kill). Placeholders only; no names."""
import os
import sys
import unittest

_REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402

PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))
CFG = mg.stats_config(PACK)
RANKING = cc.load_config("ranking")
MONTAGE = cc.load_config("montage")
TOP3_ON = {"top3": True, "minKills": None}


def hit(t, det, label, signal=True, t_end=None):
    return {"t": float(t), "tEnd": float(t if t_end is None else t_end), "detector": det, "label": label,
            "signal": signal, "why": [], "mode": "mp", "role": "context"}


def top3(t, rank):
    return {"t": t, "kind": "top3", "ownRank": rank, "ownScore": 3000 if rank else None, "gameMode": "hardpoint",
            "cards": []}


# match 1 0-300 VICTORY top 3 | 2 300-600 DEFEAT top 3 | 3 600-900 VICTORY not top 3 |
# 4 900-1200 VICTORY unreadable | 5 1200-1300 no end screen
END = {1: (292, "VICTORY"), 2: (592, "DEFEAT"), 3: (892, "VICTORY"), 4: (1192, "VICTORY")}
KILLS = [20, 60, 100, 320, 360, 620, 660, 700, 920, 960, 1230]


def hits():
    out = [hit(t, "M5", "MP kill feed") for t in KILLS]
    for _, (t, word) in END.items():
        out.append(hit(t, "W1", word))
    return out


def stats(top3_ranks):
    rd = [top3(END[i][0] + 0.5, r) for i, r in top3_ranks.items()]
    return {"readings": rd, "ownKills": {"times": [float(t) for t in KILLS]}}


def matches(ranks):
    return mg.segment(hits(), stats(ranks), 1300.0, CFG)


class MatchGateScenarios(unittest.TestCase):
    RANKS = {1: 2, 2: 1, 3: None}  # match 4 has no top-3 reading at all

    def decisions(self, gate=TOP3_ON):
        return [mg.decide(m, gate) for m in matches(self.RANKS)]

    def test_segmentation(self):
        ms = matches(self.RANKS)
        self.assertEqual([(m["start"], m["end"], m["endSeen"], m["result"]) for m in ms],
                         [(0.0, 292.0, True, "VICTORY"), (292.0, 592.0, True, "DEFEAT"),
                          (592.0, 892.0, True, "VICTORY"), (892.0, 1192.0, True, "VICTORY"),
                          (1192.0, 1300.0, False, None)])
        self.assertEqual([m["ownRank"] for m in ms], [2, 1, None, None, None])
        self.assertEqual([m["top3Seen"] for m in ms], [True, True, True, False, False])
        self.assertEqual([m["ownKills"] for m in ms], [3, 2, 3, 2, 1])

    def test_top3_gate_per_case(self):
        d = self.decisions()
        self.assertEqual(d[0], (True, "in the top 3 (#2)"))
        self.assertEqual(d[1], (True, "in the top 3 (#1)"), "a DEFEAT in the top 3 passes: the gate ignores the result")
        self.assertEqual(d[2], (False, "not in the top 3"))
        self.assertTrue(d[3][0])
        self.assertIn("top-3 screen not read", d[3][1])
        self.assertTrue(d[4][0])
        self.assertIn("no end screen", d[4][1])

    def test_min_kills_alone_and_with_top3(self):
        ms = matches(self.RANKS)
        only = [mg.decide(m, {"top3": False, "minKills": 3})[0] for m in ms]
        self.assertEqual(only, [True, False, True, False, True], "kills 3,2,3,2,1; the open match is always kept")
        both = [mg.decide(m, {"top3": True, "minKills": 3})[0] for m in ms]
        self.assertEqual(both, [True, True, True, True, True], "top 3 OR kills; unread screens keep the clips")

    def test_gate_off_keeps_everything(self):
        self.assertTrue(all(p for p, _ in self.decisions({"top3": False, "minKills": None})))

    def test_only_the_not_top3_match_loses_its_clips(self):
        ms = matches(self.RANKS)
        cands = [{"id": f"C{i}", "anchor": float(t)} for i, t in enumerate(KILLS, 1)]
        kept, dropped = mg.gate_candidates(cands, ms, TOP3_ON)
        self.assertEqual({c["match"] for c in dropped}, {3})
        self.assertEqual([c["anchor"] for c in dropped], [620.0, 660.0, 700.0])
        self.assertEqual(len(kept), len(KILLS) - 3)
        self.assertTrue(all(c["gateReason"] == "not in the top 3" for c in dropped))

    def test_all_unreadable_keeps_every_clip(self):
        ms = mg.segment(hits(), None, 1300.0, CFG)  # no OCR readings at all
        cands = [{"id": f"C{i}", "anchor": float(t)} for i, t in enumerate(KILLS, 1)]
        kept, dropped = mg.gate_candidates(cands, ms, TOP3_ON)
        self.assertEqual((len(kept), dropped), (len(KILLS), []))

    def test_read_top3_screen_without_the_own_card_is_not_top3(self):
        # the screen was read (two scores) but the streamer's name was not found: rank None, top3Seen True -> dropped
        ms = matches({1: 2, 2: 1, 3: None, 4: None})
        self.assertEqual(mg.decide(ms[3], TOP3_ON), (False, "not in the top 3"))


class WonReelScenarios(unittest.TestCase):
    """D315 reel rules on the same five matches (Hardpoint, 2-3 own kills each): match 1 VICTORY #2 and match 2
    DEFEAT #1 qualify; match 3 VICTORY off the top-3 cards fails; match 4 (no top-3 reading) and match 5 (no end
    screen) stay without a reel."""

    def decided(self, ranks=None):
        ms = matches(ranks or {1: 2, 2: 1, 3: None})
        for m in ms:
            m["reel"] = mg.reel_decide(m, mg.reel_rules(PACK))
        return ms

    def reels(self):
        return mont.match_reels(hits(), RANKING, MONTAGE, self.decided(), 1300.0)

    def test_won_top3_and_defeat_first_give_a_reel(self):
        rs = self.reels()
        self.assertEqual([(r["matchStart"], r["result"], r["score"], r["rules"]) for r in rs],
                         [(0.0, 292.0, 3.0, ["won-top3"]), (292.0, 592.0, 2.0, ["defeat-top2"])])
        self.assertEqual([r["labels"][0] for r in rs], ["VICTORY", "DEFEAT"])

    def test_every_match_records_why(self):
        ms = self.decided()
        self.assertEqual([m["reel"]["qualifies"] for m in ms], [True, True, False, False, False])
        self.assertIn("won-top3 fail (not on the top-3 cards)", ms[2]["reel"]["reason"])
        self.assertIn("objective-kills fail (3 kills", ms[2]["reel"]["reason"])
        self.assertIn("won-top3 inert (top-3 screen not read)", ms[3]["reel"]["reason"])
        self.assertIn("no end screen", ms[4]["reel"]["reason"])

    def test_reel_pieces_stay_inside_their_match_and_end_with_the_result(self):
        for r in self.reels():
            self.assertGreaterEqual(r["pieces"][0]["start"], r["matchStart"] - MONTAGE["preSec"])
            self.assertGreaterEqual(r["pieces"][-1]["end"], r["result"])

    def test_reels_do_not_depend_on_the_match_gate_setting(self):
        # the reel rules are their own (D315); the clip gate (clips.matchGate) is unchanged and separate
        self.assertEqual(mg.decide(matches({1: 2, 2: 1, 3: None})[2], TOP3_ON)[0], False)
        self.assertNotIn(592.0, [r["matchStart"] for r in self.reels()])


if __name__ == "__main__":
    unittest.main()
