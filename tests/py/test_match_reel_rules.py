# SPDX-License-Identifier: GPL-3.0-or-later
"""Match reel rules (D315, data/games/codm/match-reels.json) from synthetic match-stats fixtures (2026-11-09).
Each case is one recording with one match: W1 result word, an S1 top-3 reading (place, mode name) and own kill-feed
times, as detector_pass writes them. Covers every rule, the kill boundaries (20/21, 7/8), and that a rule whose
signal is missing stays inert (never a reel on a guess). Placeholders only; no names."""
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
RULES = mg.reel_rules(PACK)
CFG = mg.stats_config(PACK)
END = 600.0


def fixture(result="VICTORY", place=None, mode="hardpoint", kills=0, top3=True, signal=True, end=True):
    """(hits, stats) for one match ending at END. place None with top3 True = screen read, own card not found."""
    times = [10.0 + 20.0 * i for i in range(kills)]
    hits = [{"t": t, "tEnd": t, "detector": "M5", "label": "MP kill feed", "signal": True, "mode": "mp"}
            for t in times]
    readings = []
    if end:
        if result:
            hits.append({"t": END, "tEnd": END + 2, "detector": "W1", "label": result, "signal": signal, "mode": "mp"})
        else:  # end seen through another end-screen detector only
            hits.append({"t": END, "tEnd": END + 2, "detector": "K1", "label": "FINAL KILLCAM", "signal": True})
        if top3:
            readings.append({"t": END + 1, "kind": "top3", "ownRank": place, "ownScore": 1000 if place else None,
                             "gameMode": mode, "cards": []})
    return hits, {"readings": readings, "ownKills": {"times": times}}


def decide(**kw):
    hits, stats = fixture(**kw)
    ms = mg.segment(hits, stats, END + 30.0, CFG)
    m = ms[0]
    m["reel"] = mg.reel_decide(m, RULES)
    return m


def outcomes(m):
    return {r["id"]: r["outcome"] for r in m["reel"]["rules"]}


class RulesAreData(unittest.TestCase):
    def test_pack_rules(self):
        by = {r["id"]: r for r in RULES}
        self.assertEqual(list(by), ["won-top3", "defeat-top2", "objective-kills", "tdm-kills", "snd-won",
                                    "snd-round-multikill"])
        self.assertEqual(by["won-top3"]["when"], {"result": "VICTORY", "maxPlace": 3})
        self.assertEqual(by["defeat-top2"]["when"], {"result": "DEFEAT", "maxPlace": 2})
        self.assertEqual(by["defeat-top2"]["status"], "approved", "user D315a: top 2")
        self.assertEqual(by["objective-kills"]["when"], {"modes": ["hardpoint", "domination", "control"],
                                                         "killsAbove": 20})
        self.assertEqual(by["tdm-kills"]["when"], {"modes": ["team deathmatch"], "killsAbove": 7})
        self.assertEqual(by["snd-won"]["when"], {"modes": ["search and destroy"], "result": "VICTORY"})
        self.assertEqual(by["snd-round-multikill"]["when"], {"modes": ["search and destroy"], "roundKillsAtLeast": 2})

    def test_no_rules_no_reel(self):
        hits, stats = fixture(place=1, kills=30)
        m = mg.segment(hits, stats, END + 30.0, CFG)[0]
        self.assertEqual(mg.reel_decide(m, [])["qualifies"], False)
        self.assertEqual(mg.reel_rules({}), [])


class WonTop3(unittest.TestCase):
    def test_places_1_to_3_qualify(self):
        for p in (1, 2, 3):
            m = decide(place=p, kills=2)
            self.assertTrue(m["reel"]["qualifies"], p)
            self.assertEqual(outcomes(m)["won-top3"], "pass")
            self.assertIn(f"won-top3 (VICTORY; placed #{p})", m["reel"]["reason"])

    def test_off_the_cards_fails(self):
        m = decide(place=None, kills=2)
        self.assertFalse(m["reel"]["qualifies"])
        self.assertEqual(outcomes(m)["won-top3"], "fail")
        self.assertIn("not on the top-3 cards", m["reel"]["reason"])

    def test_top3_screen_not_read_is_inert(self):
        m = decide(top3=False, kills=2)
        self.assertFalse(m["reel"]["qualifies"])
        self.assertEqual(outcomes(m)["won-top3"], "inert")
        self.assertIn("top-3 screen not read", m["reel"]["reason"])

    def test_unsignalled_result_is_inert(self):
        m = decide(place=1, kills=2, signal=False)
        self.assertEqual(outcomes(m)["won-top3"], "inert")
        self.assertFalse(m["reel"]["qualifies"])


class DefeatTop2(unittest.TestCase):
    def test_boundary_2_vs_3(self):
        for p in (1, 2):
            m = decide(result="DEFEAT", place=p, kills=1)
            self.assertEqual(outcomes(m)["defeat-top2"], "pass", p)
            self.assertTrue(m["reel"]["qualifies"], p)
            self.assertIn(f"defeat-top2 (DEFEAT; placed #{p})", m["reel"]["reason"])
        m = decide(result="DEFEAT", place=3, kills=1)
        self.assertEqual(outcomes(m)["defeat-top2"], "fail")
        self.assertEqual(outcomes(m)["won-top3"], "fail", "a defeat never passes the won rule")
        self.assertFalse(m["reel"]["qualifies"])


class ObjectiveKills(unittest.TestCase):
    def test_boundary_20_vs_21_in_each_mode(self):
        for mode in ("hardpoint", "domination", "control"):
            for result in ("VICTORY", "DEFEAT"):
                m20 = decide(result=result, place=None, mode=mode, kills=20)
                m21 = decide(result=result, place=None, mode=mode, kills=21)
                self.assertEqual(outcomes(m20)["objective-kills"], "fail", (mode, result))
                self.assertFalse(m20["reel"]["qualifies"], (mode, result))
                self.assertEqual(outcomes(m21)["objective-kills"], "pass", (mode, result))
                self.assertTrue(m21["reel"]["qualifies"], (mode, result))
                self.assertIn("21 kills (killfeed; needs more than 20)", m21["reel"]["reason"])

    def test_other_modes_do_not_use_it(self):
        m = decide(result="DEFEAT", place=None, mode="team deathmatch", kills=21)
        self.assertEqual(outcomes(m)["objective-kills"], "fail")

    def test_mode_not_read_is_inert(self):
        m = decide(result="DEFEAT", top3=False, kills=40)
        self.assertEqual(outcomes(m)["objective-kills"], "inert")
        self.assertEqual(outcomes(m)["tdm-kills"], "inert")
        self.assertFalse(m["reel"]["qualifies"], "40 kills but no mode read: never a reel on a guess")

    def test_kills_not_read_is_inert(self):
        hits, stats = fixture(result="DEFEAT", place=None, kills=0)
        hits = [h for h in hits if h["detector"] != "M5"]
        m = mg.segment(hits, {"readings": stats["readings"]}, END + 30.0, CFG)[0]  # no kill times, no kill feed
        self.assertIsNone(m["ownKills"])
        d = mg.reel_decide(m, RULES)
        self.assertEqual({r["id"]: r["outcome"] for r in d["rules"]}["objective-kills"], "inert")
        self.assertFalse(d["qualifies"])


class TdmKills(unittest.TestCase):
    def test_boundary_7_vs_8(self):
        for result in ("VICTORY", "DEFEAT"):
            m7 = decide(result=result, place=None, mode="team deathmatch", kills=7)
            m8 = decide(result=result, place=None, mode="team deathmatch", kills=8)
            self.assertEqual(outcomes(m7)["tdm-kills"], "fail")
            self.assertFalse(m7["reel"]["qualifies"])
            self.assertEqual(outcomes(m8)["tdm-kills"], "pass")
            self.assertTrue(m8["reel"]["qualifies"])

    def test_hardpoint_eight_kills_is_not_enough(self):
        self.assertFalse(decide(result="DEFEAT", place=None, mode="hardpoint", kills=8)["reel"]["qualifies"])


class SearchAndDestroy(unittest.TestCase):
    def test_won_qualifies_even_off_the_cards(self):
        m = decide(place=None, mode="search and destroy", kills=1)
        self.assertEqual(outcomes(m)["snd-won"], "pass")
        self.assertTrue(m["reel"]["qualifies"])

    def test_lost_without_round_kills_does_not(self):
        m = decide(result="DEFEAT", place=None, mode="search and destroy", kills=5)
        self.assertEqual(outcomes(m)["snd-won"], "fail")
        self.assertEqual(outcomes(m)["snd-round-multikill"], "inert", "no round detector: never fires")
        self.assertFalse(m["reel"]["qualifies"])

    def test_round_multikill_when_rounds_are_known(self):
        # roundKills is never filled by segment() today; a future round detector sets it. Boundary 1 vs 2.
        m = decide(result="DEFEAT", place=None, mode="search and destroy", kills=3)
        m["roundKills"] = [1, 1, 1]
        d = mg.reel_decide(m, RULES)
        self.assertFalse(d["qualifies"])
        m["roundKills"] = [0, 2, 1]
        d = mg.reel_decide(m, RULES)
        self.assertTrue(d["qualifies"])
        self.assertIn("snd-round-multikill (mode search and destroy; best round 2 kills (needs 2))", d["reason"])

    def test_snd_rules_ignore_other_modes(self):
        m = decide(place=None, mode="hardpoint", kills=1)
        self.assertEqual(outcomes(m)["snd-won"], "fail")


class MissingSignals(unittest.TestCase):
    def test_no_end_screen_never_qualifies(self):
        m = decide(place=1, kills=30, end=False)
        self.assertFalse(m["endSeen"])
        self.assertFalse(m["reel"]["qualifies"])
        self.assertIn("no end screen", m["reel"]["reason"])

    def test_end_seen_without_any_result_or_top3_reading_is_all_inert(self):
        m = decide(result=None, top3=False, kills=30)
        self.assertTrue(m["endSeen"])
        self.assertEqual(set(outcomes(m).values()), {"inert"})
        self.assertFalse(m["reel"]["qualifies"])

    def test_kill_rule_fires_without_a_result_word(self):
        # the kill rules do not need the result ("won or defeat"): end seen through K1, mode and kills read
        m = decide(result=None, place=None, mode="hardpoint", kills=21)
        self.assertTrue(m["reel"]["qualifies"])


class ReelsFollowTheDecision(unittest.TestCase):
    def test_qualifying_match_gets_a_reel_with_its_rule(self):
        hits, stats = fixture(result="DEFEAT", place=None, mode="team deathmatch", kills=8)
        ms = mg.segment(hits, stats, END + 30.0, CFG)
        for m in ms:
            m["reel"] = mg.reel_decide(m, RULES)
        rs = mont.match_reels(hits, cc.load_config("ranking"), cc.load_config("montage"), ms, END + 30.0)
        self.assertEqual(len(rs), 1)
        self.assertEqual((rs[0]["rules"], rs[0]["score"], rs[0]["labels"][0]), (["tdm-kills"], 8.0, "DEFEAT"))

    def test_qualifying_match_without_own_kill_records_why(self):
        hits, stats = fixture(place=1, kills=0)
        ms = mg.segment(hits, stats, END + 30.0, CFG)
        ms[0]["reel"] = mg.reel_decide(ms[0], RULES)
        self.assertTrue(ms[0]["reel"]["qualifies"])
        self.assertEqual(mont.match_reels(hits, cc.load_config("ranking"), cc.load_config("montage"), ms), [])
        self.assertEqual(ms[0]["reel"]["noReel"], "no own kill in the match")


if __name__ == "__main__":
    unittest.main()
