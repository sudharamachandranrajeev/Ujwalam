# SPDX-License-Identifier: GPL-3.0-or-later
"""Round end vs match end (services/clip/match_gate.py classify_banners, segment rounds, game_mode; detector_pass
banner fields). Synthetic hit sequences and OCR boxes only (no images), in game-area fractions; banner positions,
subtitles and timings follow the 2026-11-09 practice recording (docs/evidence/2026-11-10-round-vs-match-end.md)."""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import detector_pass as dp  # noqa: E402
import g1_scan  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402

PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))
CFG = mg.stats_config(PACK)
SETTINGS = {"nameMin": 0.8, "roiSlack": 0.02}
ROUND_G = [0.428, 0.313, 0.572, 0.374]   # VICTORY on a round banner, 2026-11-09 23 s
MATCH_G = [0.413, 0.374, 0.589, 0.476]   # VICTORY on a match-end banner, 2026-11-09 354 s
SUB_G = [0.452, 0.420, 0.548, 0.444]     # the subtitle line under a round banner


def hit(t, det, label=None, signal=True, t_end=None, why=None, **kw):
    return dict({"t": float(t), "tEnd": float(t if t_end is None else t_end), "detector": det, "label": label,
                 "signal": signal, "why": why or [], "mode": "mp"}, **kw)


def banner(t, word, kind=None, subtitle=None, t_end=None):
    h = hit(t, "W1", word, t_end=t_end)
    if kind is not None:
        h["banner"], h["subtitle"] = kind, subtitle
    return h


def post_screens(t):
    """Post-match screens after a match-end banner at t (2026-11-09 order: IMPACT PLAY, MVP, top 3)."""
    return [hit(t + 6, "M2", "IMPACT PLAY", signal=False, t_end=t + 24, why=["no_name_in_roi"]),
            hit(t + 25, "M1", "MVP", t_end=t + 40), hit(t + 28, "S1", "TOP 3", t_end=t + 40)]


def kills(*ts):
    return [hit(t, "M5", "MP kill feed") for t in ts]


class BannerKindTests(unittest.TestCase):
    def test_pack_banner_config(self):
        b = CFG["banner"]
        self.assertEqual([k["kind"] for k in b["kinds"]], ["round", "match"])
        self.assertTrue(all(k["status"] == "unverified" for k in b["kinds"]))
        self.assertEqual(b["status"], "unverified")
        self.assertIn("SCORE LIMIT REACHED", [s["text"] for s in b["subtitles"]])

    def test_kind_from_word_position(self):
        b = CFG["banner"]
        self.assertEqual(mg.banner_kind(ROUND_G, b), "round")
        self.assertEqual(mg.banner_kind(MATCH_G, b), "match")
        self.assertIsNone(mg.banner_kind([0.4, 0.05, 0.6, 0.10], b), "a word elsewhere is no banner kind")
        self.assertIsNone(mg.banner_kind(ROUND_G, {}), "no pack config, no kind")

    def test_subtitle_is_the_pack_text(self):
        b = CFG["banner"]
        boxes = [{"text": ">>BOMB DEFUSED<<", "g": SUB_G}, {"text": "Scorestreaks Refreshing", "g": [0.41, 0.78, 0.58, 0.82]}]
        self.assertEqual(mg.banner_subtitle(boxes, b), "BOMB DEFUSED")
        self.assertEqual(mg.banner_subtitle([{"text": ">>All Zones Captured<<", "g": SUB_G}], b), "ALL ZONES CAPTURED")
        self.assertIsNone(mg.banner_subtitle([{"text": ">>BOMB DEFUSED<<", "g": [0.45, 0.80, 0.55, 0.82]}], b),
                          "outside the subtitle ROI")

    def test_detector_pass_writes_kind_and_subtitle(self):
        rnd = [{"text": "VICTORY", "score": 0.99, "g": ROUND_G}, {"text": ">>ENEMIES ELIMINATED<<", "score": 0.99, "g": SUB_G}]
        rows = [r for r in dp.frame_hits(rnd, PACK, [], SETTINGS, "mp") if r["detector"] == "W1"]
        self.assertEqual([(r["signal"], r["banner"], r["subtitle"]) for r in rows], [(True, "round", "ENEMIES ELIMINATED")])
        end = [{"text": "VICTORY", "score": 0.99, "g": MATCH_G}]
        rows = [r for r in dp.frame_hits(end, PACK, [], SETTINGS, "mp") if r["detector"] == "W1"]
        self.assertEqual([(r["banner"], r["subtitle"]) for r in rows], [("match", None)])

    def test_merge_keeps_round_and_match_banners_apart(self):
        rows = [dict(banner(t, "VICTORY", "round", "ENEMIES ELIMINATED" if t == 11 else None), ocrScore=1.0)
                for t in (10, 11)] + [dict(banner(12, "VICTORY", "match"), ocrScore=1.0)]
        merged = dp.merge_hits(rows, 2.5)
        self.assertEqual([(h["t"], h["tEnd"], h["banner"], h["subtitle"]) for h in merged],
                         [(10.0, 11.0, "round", "ENEMIES ELIMINATED"), (12.0, 12.0, "match", None)])


class SearchAndDestroyTests(unittest.TestCase):
    """One Search and Destroy match: four round banners (one split into two hits by an OCR gap), the match-end
    banner, post-match screens, then the next match's first round."""

    def hits(self, geometry=True):
        k = (lambda kind: kind) if geometry else (lambda kind: None)
        hs = kills(40, 60, 130, 300, 310, 340)
        hs += [banner(23, "VICTORY", k("round"), "ENEMIES ELIMINATED"), banner(115, "VICTORY", k("round")),
               banner(187, "VICTORY", k("round")), banner(190, "VICTORY", k("round")),
               banner(282, "DEFEAT", k("round"), "BOMB DEFUSED"), banner(354, "VICTORY", k("match"), t_end=355)]
        hs += post_screens(355)
        hs += [banner(540, "DEFEAT", k("round"), "SQUAD ELIMINATED"), banner(640, "DEFEAT", k("match"))]
        hs += post_screens(641)
        return sorted(hs, key=lambda h: h["t"])

    def check(self, ms, source):
        self.assertEqual([(m["start"], m["end"], m["endSeen"], m["result"]) for m in ms],
                         [(0.0, 395.0, True, "VICTORY"), (395.0, 681.0, True, "DEFEAT"), (681.0, 700.0, False, None)])
        a = ms[0]
        self.assertEqual([(r["t"], r["result"]) for r in a["rounds"]],
                         [(23.0, "VICTORY"), (115.0, "VICTORY"), (187.0, "VICTORY"), (282.0, "DEFEAT")],
                         "187 s and 190 s are one banner")
        self.assertEqual(a["rounds"][2]["tEnd"], 190.0)
        self.assertTrue(all(r["source"] == source for r in a["rounds"]))
        self.assertEqual(a["roundKills"], [0, 2, 1, 0, 3], "kills per round; the last round ends at the match end")
        self.assertEqual(a["ownKills"], 6)
        self.assertEqual(a["endBanner"]["source"], source)
        self.assertEqual((a["resultAt"], a["resultEnd"]), (354.0, 355.0), "the reel's result screen is the match end")
        self.assertEqual([r["t"] for r in ms[1]["rounds"]], [540.0])

    def test_rounds_from_banner_geometry(self):
        ms = mg.segment(self.hits(), None, 700.0, CFG)
        self.check(ms, "geometry")
        self.assertEqual(ms[0]["rounds"][3]["subtitle"], "BOMB DEFUSED")
        self.assertEqual((ms[0]["gameMode"], ms[0]["modeConfidence"]), ("search and destroy", "low"),
                         "BOMB DEFUSED names Search and Destroy")
        self.assertEqual(ms[0]["modeEvidence"][0]["source"], "round subtitle")
        self.assertIsNone(ms[1]["gameMode"], "no evidence in match 2")
        self.assertEqual(ms[1]["modeReason"], "no mode evidence")

    def test_rounds_from_follow_on_without_geometry(self):
        ms = mg.segment(self.hits(geometry=False), None, 700.0, CFG)
        self.check(ms, "follow-on")

    def test_top3_mode_name_with_ampersand(self):
        stats = {"readings": [{"t": 383, "kind": "top3", "ownRank": 2, "ownScore": 416, "cards": [],
                               "gameMode": "search and destroy"}]}
        a = mg.segment(self.hits(), stats, 700.0, CFG)[0]
        self.assertEqual((a["gameMode"], a["modeConfidence"], a["mode"]), ("search and destroy", "high", "search and destroy"))
        self.assertEqual(len(a["modeEvidence"]), 2)
        s1 = mg.s1_detector(PACK)
        label = {"text": "SEARCH & DESTROY", "score": 0.99, "g": [0.184, 0.05, 0.279, 0.075]}
        self.assertEqual(mg.parse_mode_label([label], s1, CFG), "search and destroy")

    def test_snd_round_rule_reads_round_kills(self):
        stats = {"readings": [{"t": 383, "kind": "top3", "ownRank": 2, "ownScore": 416, "cards": [],
                               "gameMode": "search and destroy"}]}
        a = mg.segment(self.hits(), stats, 700.0, CFG)[0]
        rule = next(r for r in mg.reel_rules(PACK) if r["id"] == "snd-round-multikill")
        self.assertEqual(mg.reel_rule(a, rule)["outcome"], "pass", "2 own kills in round 2 and 3 in the last round")


class ScoreLimitAndZoneTests(unittest.TestCase):
    def test_score_limit_half_time_is_a_round(self):
        # 2026-11-09 1706-2444 s: thin-bar DEFEAT with SCORE LIMIT REACHED at 2184 s (SWITCHING SIDES follows), the
        # match ends at 2395 s (150 vs 130)
        hs = kills(1800, 2000, 2300) + [banner(2184, "DEFEAT", "round", "SCORE LIMIT REACHED", t_end=2185),
                                        banner(2395, "VICTORY", "match", t_end=2397)] + post_screens(2397)
        ms = mg.segment(sorted(hs, key=lambda h: h["t"]), None, 2500.0, CFG)
        self.assertEqual([(m["end"], m["endSeen"], m["result"]) for m in ms], [(2437.0, True, "VICTORY"), (2500.0, False, None)])
        self.assertEqual([(r["t"], r["subtitle"]) for r in ms[0]["rounds"]], [(2184.0, "SCORE LIMIT REACHED")])
        self.assertEqual(ms[0]["roundKills"], [2, 1])

    def test_score_limit_match_end_without_rounds(self):
        # a points mode ending on the score limit: one match-end banner, no round banner
        hs = kills(100, 200) + [banner(600, "DEFEAT", "match", t_end=602)] + post_screens(602)
        m = mg.segment(sorted(hs, key=lambda h: h["t"]), None, 700.0, CFG)[0]
        self.assertEqual((m["end"], m["result"], m["rounds"], m["roundKills"], m["ownKills"]),
                         (642.0, "DEFEAT", [], None, 2))

    def test_zone_mode_round(self):
        # 2026-11-09 2819-3112 s: ALL ZONES CAPTURED round banner at 2952 s, match end at 3062 s (2 vs 0)
        hs = kills(2900, 3000) + [banner(2952, "VICTORY", "round", "ALL ZONES CAPTURED"),
                                  banner(3062, "VICTORY", "match", t_end=3065)] + post_screens(3065)
        m = mg.segment(sorted(hs, key=lambda h: h["t"]), None, 3150.0, CFG)[0]
        self.assertEqual((m["endSeen"], [r["subtitle"] for r in m["rounds"]], m["roundKills"]),
                         (True, ["ALL ZONES CAPTURED"], [1, 1]))


class FollowOnTests(unittest.TestCase):
    # the signalled W1 hits of the 2026-11-09 recording (detected before banner kinds existed) and the post-match
    # screens that followed (K1, M2, M1, S1 starts)
    W1 = [(23, 23, "VICTORY"), (115, 115, "VICTORY"), (187, 187, "VICTORY"), (190, 190, "VICTORY"),
          (282, 283, "VICTORY"), (354, 355, "VICTORY"), (542, 542, "VICTORY"), (703, 705, "DEFEAT"),
          (754, 754, "DEFEAT"), (829, 830, "VICTORY"), (896, 900, "VICTORY"), (985, 990, "VICTORY"),
          (1091, 1093, "VICTORY"), (1360, 1364, "DEFEAT"), (1405, 1409, "DEFEAT"), (1451, 1455, "DEFEAT"),
          (1602, 1603, "DEFEAT"), (1659, 1660, "DEFEAT"), (2184, 2185, "DEFEAT"), (2395, 2397, "VICTORY"),
          (2769, 2770, "VICTORY"), (2952, 2952, "VICTORY"), (3062, 3065, "VICTORY")]
    POST = [(357, "K1"), (373, "M1"), (375, "S1"), (1095, "M1"), (1100, "M2"), (1120, "S1"), (1665, "M2"),
            (1686, "M1"), (2400, "M1"), (2402, "M2"), (2425, "S1"), (2776, "M2"), (2795, "M1"), (3070, "M2"),
            (3095, "M1"), (3095, "S1")]
    MATCH_ENDS = {354, 1091, 1659, 2395, 2769, 3062}

    def test_real_sequence(self):
        hs = [hit(t, "W1", w, t_end=e) for t, e, w in self.W1]
        hs += [hit(t, d, "x", signal=d != "K1", why=["no_name_as_killer"] if d == "K1" else None) for t, d in self.POST]
        hs.sort(key=lambda h: h["t"])
        kinds = mg.classify_banners(hs, CFG, 3147.52)
        got = {int(h["t"]): kinds[id(h)][0] for h in hs if id(h) in kinds}
        self.assertEqual({t for t, k in got.items() if k == "match"}, self.MATCH_ENDS)
        self.assertEqual(sum(1 for k in got.values() if k == "round"), 17)
        ms = mg.segment(hs, None, 3147.52, CFG)
        self.assertEqual(sum(1 for m in ms if m["endSeen"]), 6)
        self.assertEqual([len(m["rounds"]) for m in ms], [4, 6, 4, 1, 0, 1, 0])

    def test_banner_of_unknown_kind_at_the_end_never_closes_a_match(self):
        # Codex review: a recording cut right after a round banner must not yield a false completed match.
        hs = [banner(100, "VICTORY"), banner(590, "DEFEAT")]
        kinds = mg.classify_banners(hs, CFG, 600.0)
        self.assertEqual(kinds[id(hs[0])], ("round", "follow-on"))
        self.assertEqual(kinds[id(hs[1])][0], None, "too close to the end to tell")
        ms = mg.segment(hs, None, 600.0, CFG)
        self.assertEqual([(m["end"], m["endSeen"]) for m in ms], [(600.0, False)])

    def test_without_pack_banner_config_every_banner_ends_a_match(self):
        cfg = dict(CFG, banner={})
        hs = [banner(100, "VICTORY"), banner(300, "DEFEAT")]
        self.assertEqual(len(mg.end_clusters(hs, cfg)), 2)


class GameModeTests(unittest.TestCase):
    def ev(self, *items):
        return [{"source": s, "at": 1.0, "text": t, "modes": ms} for s, t, ms in items]

    def test_conflicting_evidence_is_unknown(self):
        tops = [{"t": 10, "kind": "top3", "gameMode": "hardpoint"}]
        rounds = [{"t": 5, "subtitle": "BOMB DEFUSED"}]
        mode, conf, ev, why = mg.game_mode(tops, [], rounds, None, CFG)
        self.assertEqual((mode, conf), (None, None))
        self.assertIn("evidence disagrees", why)
        self.assertEqual(len(ev), 2)

    def test_no_evidence(self):
        self.assertEqual(mg.game_mode([], [], [], None, CFG), (None, None, [], "no mode evidence"))

    def test_g1_scan_mode_cue_needs_the_c1_detector(self):
        pack = dict(PACK, detectors=[d for d in PACK["detectors"] if d["id"] != "C1"])
        rows = dp.frame_hits([{"text": "PLANTS", "score": 0.99, "g": [0.341, 0.284, 0.383, 0.314]}], pack, [], SETTINGS, "mp")
        self.assertEqual([r for r in rows if r["detector"] == "C1"], [])

    def test_c1_cue_rows_inside_and_outside_the_roi(self):
        boxes = [{"text": "PLANTS", "score": 0.99, "g": [0.341, 0.284, 0.383, 0.314]},
                 {"text": "DESTROY TARGET (A) OR (B)", "score": 0.98, "g": [0.431, 0.267, 0.567, 0.304]},
                 {"text": "DEFUSES", "score": 0.99, "g": [0.39, 0.60, 0.44, 0.63]},
                 {"text": "Attackers plant bomb or eliminate all enemies. Defenders", "score": 0.9,
                  "g": [0.378, 0.29, 0.596, 0.31]}]
        rows = [r for r in dp.frame_hits(boxes, PACK, [], SETTINGS, "mp") if r["detector"] == "C1"]
        self.assertEqual(sorted((r["label"], r["signal"]) for r in rows),
                         [("DEFUSES", False), ("DESTROY TARGET", True), ("PLANTS", True)],
                         "a long sentence holding a cue word is no cue; a cue outside the ROIs is no signal")
        self.assertIsNone(g1_scan._mode_cue("PLANTSDEFUSESKILLSDEATHSASSISTS", next(
            d for d in PACK["detectors"] if d["id"] == "C1")), "box more than twice the cue length")

    def test_mode_cue_hits_decide_the_mode(self):
        hs = [hit(290, "C1", "DESTROY TARGET"), hit(400, "C1", "PLANTS"), hit(401, "C1", "DEFUSES"),
              hit(500, "C1", "PLANTS", signal=False, why=["outside_roi"])]
        mode, conf, ev, why = mg.game_mode([], hs, [], None, CFG)
        self.assertEqual((mode, conf, len(ev)), ("search and destroy", "medium", 3))
        self.assertEqual(why, "3 evidence item(s) agree")

    def test_ranked_top3_cards_read_rating(self):
        s1 = mg.s1_detector(PACK)
        boxes = [{"text": "RATING 92", "score": 0.99, "g": [0.447, 0.747, 0.518, 0.783]},
                 {"text": "RATING 71", "score": 0.99, "g": [0.205, 0.785, 0.283, 0.822]},
                 {"text": "RATING 55", "score": 0.99, "g": [0.685, 0.784, 0.766, 0.823]},
                 {"text": "TEAM DEATHMATCH", "score": 0.99, "g": [0.181, 0.047, 0.279, 0.074]},
                 {"text": "CONTROL", "score": 0.99, "g": [0.18, 0.62, 0.234, 0.65]}]
        top = mg.parse_top3(boxes, s1, [], 0.8, CFG)
        self.assertEqual([c["score"] for c in top["cards"]], [92, 71, 55])
        self.assertEqual(mg.parse_mode_label(boxes, s1, CFG), "team deathmatch")
        label = [{"text": "CONTROL", "score": 0.99, "g": [0.18, 0.044, 0.234, 0.077]}]
        self.assertEqual(mg.parse_mode_label(label, s1, CFG), "control")


if __name__ == "__main__":
    unittest.main()
