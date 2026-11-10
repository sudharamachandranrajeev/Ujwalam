# SPDX-License-Identifier: GPL-3.0-or-later
"""D326: match reels cut only the streamer's own counted kills (no loadout-panel reads, no spectated play), a Search
and Destroy reel that qualifies by a round multi-kill shows only that round, and the impact-play reel (MVP animation
to the results page). Synthetic OCR boxes and hit sequences only (no images, no names); timings follow the
2026-11-09 practice recording (docs/evidence/2026-11-10-reel-own-kills-impact-play.md)."""
import json
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_montage as mont  # noqa: E402
import clip_names as names  # noqa: E402
import clip_publish as pub  # noqa: E402
import detector_pass as dp  # noqa: E402
import g1_scan  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402


def _json(*p):
    with open(os.path.join(_REPO, *p), encoding="utf-8") as f:
        return json.load(f)


PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))
CFG = mg.stats_config(PACK)
RULES = mg.reel_rules(PACK)
RANKING = _json("data", "clip", "ranking.json")
MONTAGE = _json("data", "clip", "montage.json")
IMPACT = PACK["matchReels"]["impactPlay"]
SETTINGS = {"nameMin": 0.8, "roiSlack": 0.02}
BANNER_G = [0.39, 0.67, 0.61, 0.69]   # "YOU WILL RESPAWN NEXT ROUND!" text, 2026-11-09 1450 s


def hit(t, det, label=None, signal=True, t_end=None, why=None, mode="mp", **kw):
    return dict({"t": float(t), "tEnd": float(t if t_end is None else t_end), "detector": det, "label": label,
                 "signal": signal, "why": why or [], "mode": mode}, **kw)


def snd_match(result="DEFEAT"):
    """One Search and Destroy match of three rounds, as the third match of the 2026-11-09 practice: the BR feed (B1)
    reads the own name in a weapon's custom name on the MP loadout panel (pre-round and while dead), and the streamer
    spectates a teammate in round 2. Own kills: 40 s (round 1), 120 s (read while spectating), 250 and 255 s
    (round 3)."""
    hits = [
        hit(30, "C1", "DESTROY TARGET"),
        hit(40, "M5", "MP kill feed"),
        hit(100, "W1", result if result == "DEFEAT" else "VICTORY", banner="round", subtitle=None),
        hit(105, "B1", "BR kill feed"),                       # loadout panel at the round start
        hit(110, "N1", "KILLCAM", signal=False, t_end=113, why=["negative_role"]),
        hit(115, "N3", "YOU WILL RESPAWN NEXT ROUND", signal=False, t_end=190, why=["negative_role"]),
        hit(120, "M5", "MP kill feed"),                       # an own line read while spectating (guard)
        hit(140, "B1", "BR kill feed"),                       # loadout panel while dead
        hit(200, "W1", "DEFEAT", banner="round", subtitle=None),
        hit(205, "B1", "BR kill feed"),
        hit(250, "M5", "MP kill feed", t_end=254),
        hit(255, "M5", "MP kill feed", t_end=259),
        hit(300, "W1", result, t_end=301, banner="match", subtitle=None),
        hit(330, "C2", "SEARCH & DESTROY", t_end=333),
    ]
    stats = {"readings": [], "ownKills": {"times": [40.0, 105.0, 120.0, 140.0, 205.0, 250.0, 255.0],
                                          "feeds": ["M5", "B1", "M5", "B1", "B1", "M5", "M5"]}}
    return hits, stats


def decided(hits, stats, duration=400.0):
    ms = mg.segment(hits, stats, duration, CFG)
    for m in ms:
        m["reel"] = mg.reel_decide(m, RULES)
    return ms


class PackTests(unittest.TestCase):
    def test_n3_in_pack_and_death_rule(self):
        n3 = next(d for d in PACK["detectors"] if d["id"] == "N3")
        self.assertEqual((n3["role"], n3["status"], n3["nameRequired"], n3["weight"]), ("negative", "unverified", False, None))
        self.assertIn("N3", next(s for s in PACK["screens"] if s["id"] == "mp_gameplay")["detectors"])
        self.assertEqual(CFG["spectateDetectors"], ["N3"])
        self.assertIn("N3", RANKING["death"]["detectors"])

    def test_snd_round_rule_shows_qualifying_rounds(self):
        rule = next(r for r in RULES if r["id"] == "snd-round-multikill")
        self.assertEqual(rule["pieces"], "qualifying-rounds")

    def test_impact_play_flag_is_off_by_default(self):
        flags = {f["id"]: f for f in _json("data", "flags.json")["flags"]}
        self.assertIn(IMPACT["flag"], flags)
        self.assertIs(flags[IMPACT["flag"]]["default"], False)
        dets = {d["id"] for d in PACK["detectors"]}
        self.assertTrue({IMPACT["detector"], IMPACT["resultsDetector"]} <= dets)


class SpectateDetectorTests(unittest.TestCase):
    def test_banner_read_as_n3_negative(self):
        rows = [r for r in dp.frame_hits([{"text": "YOU WILL RESPAWN NEXT ROUND!", "score": 0.95, "g": BANNER_G}],
                                         PACK, [], SETTINGS, "mp") if r["detector"] == "N3"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["role"], rows[0]["signal"], rows[0]["why"]), ("negative", False, ["negative_role"]))

    def test_other_text_is_no_n3(self):
        for text in ("YOU WILL RESPAWN", "RESPAWN", "ROUND 4", "this line has many more words than the banner and you "
                     "will respawn next round inside it"):
            evs = g1_scan.find_events([{"text": text, "score": 0.9, "g": BANNER_G}], PACK, [], 0.8)
            self.assertNotIn("N3", [e["det"] for e in evs], text)


class OwnKillTests(unittest.TestCase):
    def test_segment_drops_br_feed_and_spectated_kills(self):
        hits, stats = snd_match()
        m = decided(hits, stats)[0]
        self.assertEqual((m["gameMode"], m["result"]), ("search and destroy", "DEFEAT"))
        self.assertEqual(m["ownKillTimes"], [40.0, 250.0, 255.0])
        self.assertEqual((m["ownKills"], m["spectateDropped"]), (3, 1))
        self.assertEqual(m["roundKills"], [1, 0, 2])
        self.assertEqual(m["roundKillTimes"], [[40.0], [], [250.0, 255.0]])

    def test_round_multikill_only_gives_that_round(self):
        hits, stats = snd_match()
        m = decided(hits, stats)[0]
        self.assertEqual([r["id"] for r in m["reel"]["rules"] if r["outcome"] == "pass"], ["snd-round-multikill"])
        self.assertEqual(m["reel"]["pieceRounds"], [2])
        reel = mont.match_reels(hits, RANKING, MONTAGE, [m], 400.0)[0]
        kill_pieces = [p for p in reel["pieces"] if p["kills"]]
        self.assertEqual(reel["kills"], 2)
        self.assertTrue(all(p["start"] >= 200 for p in reel["pieces"]), reel["pieces"])
        self.assertEqual(kill_pieces[0]["start"], 247.0)

    def test_won_match_shows_every_counted_kill_and_no_loadout_or_spectate(self):
        hits, stats = snd_match("VICTORY")
        m = decided(hits, stats)[0]
        self.assertIsNone(m["reel"]["pieceRounds"])  # snd-won passes too: the whole match
        reel = mont.match_reels(hits, RANKING, MONTAGE, [m], 400.0)[0]
        self.assertEqual(reel["kills"], 3)
        for p in reel["pieces"]:
            for bad in (105.0, 120.0, 140.0, 205.0):
                self.assertFalse(p["start"] <= bad <= p["end"], (bad, p))
            self.assertFalse(p["start"] < 190 and p["end"] > 115, ("piece overlaps the spectating span", p))

    def test_old_runs_without_counted_times_use_the_hits(self):
        hits, stats = snd_match("VICTORY")
        m = decided(hits, stats)[0]
        m.pop("ownKillTimes")  # a matches.json written before D326
        reel = mont.match_reels(hits, RANKING, MONTAGE, [m], 400.0)[0]
        self.assertTrue(any(p["start"] <= 205.0 <= p["end"] for p in reel["pieces"]), "the old hit-based kills")

    def test_kill_in_a_death_gives_no_piece(self):
        hits, stats = snd_match("VICTORY")
        m = decided(hits, stats)[0]
        m["ownKillTimes"] = [150.0]  # inside the spectating span: its piece is dropped
        m["reel"]["pieceRounds"] = None
        self.assertEqual(mont.match_reels(hits, RANKING, MONTAGE, [m], 400.0), [])
        self.assertIn("spectating", m["reel"]["noReel"])


def impact_match(own=True, banner=True, results=True):
    """Match end of the 2026-11-09 Control match: banner 3062-3065, MVP animation, IMPACT PLAY 3070-3092, top 3 and
    MVP 3095-3108, results page 3110-3112."""
    hits = [hit(3000, "M5", "MP kill feed")]
    if banner:
        hits.append(hit(3062, "W1", "VICTORY", t_end=3065, banner="match", subtitle=None))
    hits.append(hit(3070, "M2", "IMPACT PLAY", signal=own, t_end=3092, why=[] if own else ["no_name_in_roi"]))
    hits += [hit(3095, "S1", "TOP 3", t_end=3108), hit(3095, "M1", "MVP", t_end=3108)]
    if results:
        hits.append(hit(3110, "C2", "CONTROL", t_end=3112))
    stats = {"readings": [], "ownKills": {"times": [3000.0], "feeds": ["M5"]}}
    return hits, mg.segment(hits, stats, 3147.5, CFG)


class ImpactPlayTests(unittest.TestCase):
    def test_own_impact_play_from_mvp_to_results_page(self):
        hits, ms = impact_match()
        reels = mont.impact_play_reels(hits, ms, IMPACT, 3147.5)
        self.assertEqual(len(reels), 1)
        self.assertEqual(reels[0]["pieces"], [{"start": 3066.0, "end": 3112.5, "kills": 0}])
        self.assertEqual((reels[0]["match"], reels[0]["labels"]), (1, ["VICTORY", "IMPACT PLAY"]))
        self.assertEqual(ms[0]["impactPlay"]["startRule"], "after the result banner")

    def test_other_players_impact_play_gives_no_reel(self):
        hits, ms = impact_match(own=False)
        self.assertEqual(mont.impact_play_reels(hits, ms, IMPACT, 3147.5), [])

    def test_no_banner_and_no_results_page(self):
        hits, ms = impact_match(banner=False, results=False)
        ms = [m for m in ms if m["endSeen"]]
        reels = mont.impact_play_reels(hits, ms, IMPACT, 3147.5)
        self.assertEqual(reels[0]["pieces"][0]["start"], 3070.0 - IMPACT["fallbackLeadSec"])
        self.assertEqual(reels[0]["pieces"][0]["end"], 3108.0 + IMPACT["endHoldSec"])

    def test_capped_and_cut_at_duration(self):
        hits, ms = impact_match()
        spec = dict(IMPACT, maxSec=20)
        self.assertEqual(mont.impact_play_reels(hits, ms, spec, 3147.5)[0]["pieces"][0]["end"], 3086.0)
        self.assertEqual(mont.impact_play_reels(hits, ms, IMPACT, 3100.0)[0]["pieces"][0]["end"], 3100.0)
        self.assertEqual(mont.impact_play_reels(hits, ms, IMPACT, 3070.0), [])  # shorter than minSec
        self.assertEqual(mont.impact_play_reels(hits, ms, None, 3147.5), [])


class NamingTests(unittest.TestCase):
    def test_impact_play_name(self):
        from datetime import datetime
        self.assertIn("impact-play", names.KINDS)
        label = names.label_for("impact-play", ["VICTORY", "IMPACT PLAY"])
        self.assertEqual(label, "victory")
        self.assertEqual(names.label_for("impact-play", []), "match")
        n = names.clip_name("codm", "impact-play", datetime(2026, 11, 10, 0, 32, 12), label, 1, "v")
        self.assertEqual(n, "codm_impact-play_20261110-003212_victory_01_v.mp4")
        self.assertRegex(n, names.NAME_RE)

    def test_publish_kind(self):
        self.assertEqual(pub.kind_of("I01", "clipper.montage"), "impact-play")
        self.assertEqual(pub.kind_of("W01", "clipper.montage"), "won-reel")
        self.assertEqual(pub.kind_of("I01", "clipper.review"), "short")


if __name__ == "__main__":
    unittest.main()
