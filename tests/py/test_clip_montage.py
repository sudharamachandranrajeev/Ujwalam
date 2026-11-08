# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 kill montages (services/clip/clip_montage.py): all own kills with streaks first (user 2026-11-08), dead time
cut, deaths, 20-60 s bounds."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402

RANKING = cc.load_config("ranking")
CFG = cc.load_config("montage")


def kill(t):
    return {"t": float(t), "detector": "M5", "label": "MP kill feed", "signal": True, "role": "positive"}


def medal(t, label="Triple Kill"):
    return {"t": float(t), "detector": "M3", "label": label, "signal": True, "role": "positive"}


def death(t):
    return {"t": float(t), "tEnd": float(t) + 6, "detector": "N1", "label": "KILLCAM", "signal": False,
            "role": "negative"}


def streak(t0, n=3, step=5):
    """n own kills step seconds apart from t0, the Triple Kill medal 0.5 s after the third."""
    hs = [kill(t0 + i * step) for i in range(n)]
    return hs + [medal(t0 + 2 * step + 0.5)]


class MontageTests(unittest.TestCase):
    def test_config_user_values(self):
        self.assertEqual((CFG["preSec"], CFG["postSec"], CFG["audioFadeMs"]), (3.0, 1.5, 80))
        self.assertEqual((CFG["targetMinSec"], CFG["targetMaxSec"], CFG["minSec"], CFG["maxSec"]), (30, 45, 20, 60))

    def test_single_kills_make_a_montage_without_any_streak(self):
        # user 2026-11-08: "combine kills and make a montage" - every own kill counts, not only streaks
        hits = [kill(100 + 30 * i) for i in range(6)]  # 6 single kills, 4.5 s each = 27 s >= minSec 20
        ms = mont.plan_montages(hits, RANKING, CFG, 1000)
        self.assertEqual(len(ms), 1)
        self.assertEqual((ms[0]["kills"], ms[0]["streakKills"], ms[0]["singleKills"]), (6, 0, 6))
        self.assertAlmostEqual(ms[0]["seconds"], 27.0)

    def test_too_few_single_kills_give_nothing(self):
        hits = [kill(t) for t in (100, 200, 300)]  # 13.5 s < minSec 20
        self.assertEqual(mont.plan_montages(hits, RANKING, CFG, 1000), [])

    def test_streaks_come_first_then_single_kills_fill_the_target(self):
        singles = [kill(1000 + 40 * i) for i in range(12)]
        hits = singles + streak(100, n=3, step=10) + streak(400, n=4, step=10) + [medal(431, "Fury Kill")]
        ms = mont.plan_montages(hits, RANKING, CFG, 5000)
        m = ms[0]
        # best streak (4 kills, Triple + Fury) plays first, then the Triple Kill streak, then single kills in time order
        self.assertEqual(m["pieces"][0]["start"], 397.0)
        self.assertEqual([p["start"] for p in m["pieces"][4:7]], [97.0, 107.0, 117.0])
        self.assertEqual(m["streakKills"], 7)
        self.assertGreater(m["singleKills"], 0)
        self.assertLessEqual(m["seconds"], CFG["targetMaxSec"])
        self.assertGreaterEqual(m["seconds"], CFG["targetMinSec"])
        # more kills than fit: another montage instead of dropping them
        self.assertEqual(sum(x["kills"] for x in ms), 19)
        self.assertGreaterEqual(len(ms), 2)
        for x in ms:
            self.assertTrue(CFG["minSec"] <= x["seconds"] <= CFG["maxSec"], x["seconds"])

    def test_leftover_kills_top_up_other_montages_inside_max(self):
        # 9 single kills = 40.5 s fill montage 1; the 10th (4.5 s) cannot stand alone and joins it (45 s <= 60 s)
        hits = [kill(100 + 30 * i) for i in range(10)]
        ms = mont.plan_montages(hits, RANKING, CFG, 5000)
        self.assertEqual(len(ms), 1)
        self.assertEqual(ms[0]["kills"], 10)
        self.assertLessEqual(ms[0]["seconds"], CFG["maxSec"])

    def test_death_still_cuts_single_kills(self):
        hits = [kill(100 + 30 * i) for i in range(6)] + [death(161.0)]  # kill at 160, KILLCAM at 161
        ms = mont.plan_montages(hits, RANKING, CFG, 1000)
        for p in ms[0]["pieces"]:
            self.assertFalse(p["start"] < 161.0 + 6 and p["end"] > 161.0 - RANKING["death"]["endBeforeSec"] and p["start"] < 161.0,
                             f"piece {p} runs into the death")

    def test_streaks_alone_still_streak_only(self):
        hits = [kill(t) for t in (100, 200, 300)] + streak(500)
        sts, _ = mont.streaks(hits, RANKING, CFG)
        self.assertEqual(len(sts), 1, "short clips and the live clipper keep the streak-only rule")

    def test_dead_time_between_kills_is_cut(self):
        hits = streak(100, n=3, step=10) + streak(400, n=3, step=10) + streak(700, n=3, step=10)
        ms = mont.plan_montages(hits, RANKING, CFG, 1000)
        self.assertEqual(len(ms), 1)
        m = ms[0]
        # 9 kills, 10 s apart: each piece 3 + 1.5 = 4.5 s; 5.5 s gaps are > joinGapSec, so cut
        self.assertEqual(len(m["pieces"]), 9)
        self.assertAlmostEqual(m["seconds"], 9 * 4.5, places=3)
        self.assertTrue(CFG["targetMinSec"] <= m["seconds"] <= CFG["targetMaxSec"])
        self.assertEqual([p["start"] for p in m["pieces"]], sorted(p["start"] for p in m["pieces"]))

    def test_close_kills_join_into_one_piece(self):
        hits = streak(100, n=3, step=2)  # kills 2 s apart: pieces overlap -> one piece 97..105.5
        ps = mont._pieces(sorted(h["t"] for h in hits if h["detector"] == "M5"), [], RANKING, CFG)
        self.assertEqual(ps, [{"start": 97.0, "end": 105.5, "kills": 3}])

    def test_death_cuts_the_piece_and_splits_streaks(self):
        hits = streak(100, n=3, step=5) + [death(111.0)]
        sts, deaths = mont.streaks(hits, RANKING, CFG)
        ps = mont._pieces(sts[0]["kills"], deaths, RANKING, CFG)
        self.assertLessEqual(ps[-1]["end"], 111.0 - RANKING["death"]["endBeforeSec"])

    def test_too_short_total_gives_nothing(self):
        hits = streak(100, n=3, step=10)  # 13.5 s < minSec 20
        self.assertEqual(mont.plan_montages(hits, RANKING, CFG, 1000), [])

    def test_montages_stay_inside_the_bounds(self):
        hits = []
        for i in range(10):
            hits += streak(100 + 200 * i, n=4, step=10)
        ms = mont.plan_montages(hits, RANKING, CFG, 5000)
        self.assertGreaterEqual(len(ms), 2)
        for m in ms:
            self.assertTrue(CFG["minSec"] <= m["seconds"] <= CFG["maxSec"], m["seconds"])

    def test_medal_without_feed_line_becomes_a_kill(self):
        hits = [medal(500, "Fury Kill"), medal(505, "Frenzy Kill"), medal(510, "Mega Kill"), medal(515, "Nuclear")]
        sts, _ = mont.streaks(hits, RANKING, CFG)
        self.assertEqual(len(sts[0]["kills"]), 4)

    def test_render_argv_keeps_every_audio_track(self):
        pieces = [{"start": 10.0, "end": 14.5, "kills": 1}, {"start": 30.0, "end": 34.5, "kills": 1}]
        argv = mont.render_argv("ffmpeg", "v.mkv", pieces, {"width": 1080, "height": 1920}, ["-c:v", "x"],
                                ["-c:a", "aac"], 80, "o.mp4", audio_tracks=2)
        g = argv[argv.index("-filter_complex") + 1]
        self.assertIn("[v0][a0_0][a0_1][v1][a1_0][a1_1]concat=n=2:v=1:a=2[vout][aout0][aout1]", g)
        self.assertIn("[1:a:1]", g)
        maps = [argv[i + 1] for i, x in enumerate(argv) if x == "-map"]
        self.assertEqual(maps, ["[vout]", "[aout0]", "[aout1]"])

    def test_render_argv_concat_with_audio_fades(self):
        pieces = [{"start": 10.0, "end": 14.5, "kills": 1}, {"start": 30.0, "end": 34.5, "kills": 1}]
        argv = mont.render_argv("ffmpeg", "v.mkv", pieces, {"width": 1080, "height": 1920}, ["-c:v", "x"],
                                ["-c:a", "aac"], 80, "o.mp4")
        g = argv[argv.index("-filter_complex") + 1]
        self.assertIn("concat=n=2:v=1:a=1", g)
        self.assertEqual(g.count("afade=t=in:d=0.080"), 2)
        self.assertIn("afade=t=out:st=4.420:d=0.080", g)
        self.assertEqual(argv.count("-i"), 2)


def result(t, word="VICTORY"):
    return {"t": float(t), "tEnd": float(t), "detector": "W1", "label": word, "signal": True, "role": "context"}


class MatchReelTests(unittest.TestCase):
    def test_won_match_takes_every_own_kill_and_the_result_screen(self):
        hits = [kill(t) for t in (100, 200, 300)] + [result(358)] + [kill(t) for t in (500, 600)] + [result(942, "DEFEAT")]
        rs = mont.match_reels(hits, RANKING, CFG)
        self.assertEqual(len(rs), 1, "the lost match gives no reel")
        r = rs[0]
        self.assertEqual([p["kills"] for p in r["pieces"]], [1, 1, 1, 0])
        self.assertEqual(r["pieces"][-1], {"start": 357.5, "end": 361.0, "kills": 0})
        self.assertAlmostEqual(r["seconds"], 3 * 4.5 + 3.5)

    def test_second_won_match_starts_after_the_first_result(self):
        hits = [kill(100), result(358, "DEFEAT"), kill(400), kill(402), result(700)]
        r = mont.match_reels(hits, RANKING, CFG)[0]
        self.assertEqual(r["matchStart"], 358.0)
        self.assertEqual(r["pieces"][0], {"start": 397.0, "end": 403.5, "kills": 2})

    def test_won_match_without_kills_and_unsignalled_results_give_nothing(self):
        self.assertEqual(mont.match_reels([result(358)], RANKING, CFG), [])
        h = result(358)
        h["signal"] = False
        self.assertEqual(mont.match_reels([kill(100), h], RANKING, CFG), [])

    def test_reel_ends_at_the_recording_end(self):
        r = mont.match_reels([kill(355), result(358)], RANKING, CFG, duration=359.0)[0]
        self.assertEqual(r["pieces"], [{"start": 352.0, "end": 356.5, "kills": 1}, {"start": 357.5, "end": 359.0, "kills": 0}])


if __name__ == "__main__":
    unittest.main()
