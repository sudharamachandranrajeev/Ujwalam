# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 kill montages (services/clip/clip_montage.py): all own kills with streaks first (user 2026-11-08), dead time
cut, deaths, 20-60 s bounds."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402

RANKING = cc.load_config("ranking")
CFG = cc.load_config("montage")
PACK = game_pack.load_pack(os.path.join(os.path.dirname(__file__), "..", "..", "data", "games", "codm"))


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


def b2(t, label):
    return {"t": float(t), "detector": "B2", "label": label, "signal": True, "role": "positive", "mode": "br"}


def br_chain():
    """The BR hits of the 2026-11-11 session around its 3X short (triage F2), seconds into the recording."""
    return [b2(555, "KNOCKED DOWN"), b2(560, "ELIMINATED"), b2(561, "KNOCKED DOWN"), b2(580, "KNOCKED DOWN"),
            b2(581, "ELIMINATED"),
            {"t": 582.0, "detector": "X1", "label": "3X MULTI-KILL", "signal": True, "role": "positive", "mode": "br"}]


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

    def test_br_own_hud_kills_and_knocks_chain_into_one_group(self):
        # CL2 (triage F2): the 2026-11-11 BR short. B1 read no own kill; B2 (own HUD) read the knocks and kills; the
        # 3X medal's kills spanned 555-582 s, more than the 12 s MP chain gap
        gs, _ = mont.groups(br_chain(), RANKING, CFG)
        self.assertEqual(len(gs), 1)
        self.assertEqual(gs[0]["kills"], [560.0, 581.0], "ELIMINATED counts, the medal is covered by the 581 kill")
        self.assertEqual(gs[0]["actions"], [555.0, 561.0, 580.0], "knocks are shown, not counted")
        self.assertTrue(gs[0]["streak"])

    def test_br_gap_does_not_change_multiplayer(self):
        hits = [dict(kill(100), mode="mp"), dict(kill(120), mode="mp")]  # 20 s apart: two groups in MP
        self.assertEqual(len(mont.groups(hits, RANKING, CFG)[0]), 2)

    def test_a_knock_alone_is_no_kill_group(self):
        self.assertEqual(mont.groups([b2(300, "KNOCKED DOWN")], RANKING, CFG)[0], [])

    def test_live_clip_recut_keeps_the_earlier_kills_and_cuts_the_running(self):
        # the live window was 567-587 s (17 s before the medal): it missed 555-561 and kept 567-580 of running
        gs, deaths = mont.groups(br_chain(), RANKING, CFG)
        ps = mont.live_clip_pieces(mont.groups_in(gs, 567.0, 587.0), deaths, RANKING, CFG, 20.0, lo=538.0, hi=598.0)
        # knock 555 + kill 560 + knock 561 = 552-562.5; knock 580 + kill 581 = 577-582.5; 16 s, so 4 s earlier
        self.assertEqual([(p["start"], p["end"]) for p in ps], [(548.0, 562.5), (577.0, 582.5)])
        self.assertEqual(sum(p["kills"] for p in ps), 2)
        self.assertAlmostEqual(sum(p["end"] - p["start"] for p in ps), 20.0)

    def test_live_clip_recut_stays_inside_the_save_and_before_a_death(self):
        gs, deaths = mont.groups(br_chain() + [death(590.0)], RANKING, CFG)
        ps = mont.live_clip_pieces(mont.groups_in(gs, 567.0, 587.0), deaths, RANKING, CFG, 40.0, lo=552.0, hi=598.0)
        self.assertEqual(ps[0]["start"], 552.0, "never before the save file starts")
        self.assertLessEqual(ps[-1]["end"], 590.0 - RANKING["death"]["endBeforeSec"])

    def test_live_clip_without_a_group_keeps_its_window(self):
        gs, deaths = mont.groups(br_chain(), RANKING, CFG)
        self.assertEqual(mont.groups_in(gs, 900.0, 920.0), [])
        self.assertEqual(mont.live_clip_pieces([], deaths, RANKING, CFG, 20.0), [])

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
    return {"t": float(t), "tEnd": float(t), "detector": "W1", "label": word, "signal": True, "role": "context",
            "banner": "match"}


def reels(hits, places=None, duration=None):
    """match_reels with the D315 rules of the CODM pack; places: {result time: own place on the top-3 screen}."""
    readings = [{"t": float(t) + 0.5, "kind": "top3", "ownRank": r, "ownScore": 1000, "gameMode": "hardpoint"}
                for t, r in (places or {}).items()]
    ms = mg.segment(hits, {"readings": readings} if readings else None, duration or 2000.0, mg.stats_config(PACK))
    for m in ms:
        m["reel"] = mg.reel_decide(m, mg.reel_rules(PACK))
    return mont.match_reels(hits, RANKING, CFG, ms, duration)


class MatchReelTests(unittest.TestCase):
    def test_won_top3_match_takes_every_own_kill_and_the_result_screen(self):
        hits = [kill(t) for t in (100, 200, 300)] + [result(358)] + [kill(t) for t in (500, 600)] + [result(942, "DEFEAT")]
        rs = reels(hits, {358: 2})
        self.assertEqual(len(rs), 1, "the lost match (place not read) gives no reel")
        r = rs[0]
        self.assertEqual([p["kills"] for p in r["pieces"]], [1, 1, 1, 0])
        self.assertEqual(r["pieces"][-1], {"start": 357.5, "end": 361.0, "kills": 0})
        self.assertAlmostEqual(r["seconds"], 3 * 4.5 + 3.5)
        self.assertEqual(r["rules"], ["won-top3"])

    def test_second_won_match_starts_after_the_first_result(self):
        hits = [kill(100), result(358, "DEFEAT"), kill(400), kill(402), result(700)]
        r = reels(hits, {700: 1})[0]
        self.assertEqual(r["matchStart"], 358.0)
        self.assertEqual(r["pieces"][0], {"start": 397.0, "end": 403.5, "kills": 2})

    def test_won_match_without_kills_and_unsignalled_results_give_nothing(self):
        self.assertEqual(reels([result(358)], {358: 1}), [])
        h = result(358)
        h["signal"] = False
        self.assertEqual(reels([kill(100), h], {358: 1}), [], "an unsignalled W1 box is not a read result")

    def test_victory_without_a_top3_reading_gives_no_reel(self):
        self.assertEqual(reels([kill(100), result(358)]), [], "won-top3 is inert without the top-3 screen")

    def test_reel_ends_at_the_recording_end(self):
        r = reels([kill(355), result(358)], {358: 1}, duration=359.0)[0]
        self.assertEqual(r["pieces"], [{"start": 352.0, "end": 356.5, "kills": 1}, {"start": 357.5, "end": 359.0, "kills": 0}])

class LiveRecutTests(unittest.TestCase):
    """CL2 in live-review (clipper._retime_live_clips): the recording's hits re-cut the live clips."""

    def test_live_clips_are_recut_and_two_clips_of_one_chain_become_one(self):
        import json
        import tempfile
        from types import SimpleNamespace
        import clipper
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "rec.mkv")
            open(rec, "wb").close()
            with open(os.path.join(d, "detector-hits.jsonl"), "w", encoding="utf-8") as f:
                f.write("".join(json.dumps(h) + "\n" for h in br_chain()))
            with open(os.path.join(d, "detector-pass.json"), "w", encoding="utf-8") as f:
                json.dump({"recording": "rec.mkv", "duration": 3000}, f)
            mpath = os.path.join(d, "matches.json")
            with open(mpath, "w", encoding="utf-8") as f:
                json.dump({"recordStartUtc": "2026-11-11T21:10:46.000Z", "duration": 3000, "matches": []}, f)
            t0 = 1794431446.0  # 2026-11-11T21:10:46Z
            clips = [  # the 3X save (window 567-587 s) and a later save whose window holds the same chain's end
                {"id": "L01", "file": "v1", "start": 29.23, "end": 49.23, "wallStart": t0 + 567.2, "labels": ["3X MULTI-KILL"],
                 "reasons": ["a"], "score": 5, "anchor": 44.0},
                {"id": "L02", "file": "v2", "start": 10.0, "end": 25.0, "wallStart": t0 + 575.0, "labels": ["Other"],
                 "reasons": ["b"], "score": 3},
            ]
            a = SimpleNamespace(recording=rec, out=d, ranking=None, montage_config=None)
            self.assertEqual(clipper._retime_live_clips(a, clips, mpath, {"v1": 60.0, "v2": 60.0}), 1)
            self.assertEqual([c["id"] for c in clips], ["L01"], "the same kills are not cut twice")
            (c,) = clips
            off = 567.2 - 29.23
            self.assertEqual([(round(p["start"] + off, 2), round(p["end"] + off, 2)) for p in c["pieces"]],
                             [(548.0, 562.5), (577.0, 582.5)])
            self.assertEqual(c["labels"], ["3X MULTI-KILL", "Other"])
            self.assertTrue(c["retimed"])
            self.assertTrue(c["start"] <= c["anchor"] <= c["end"])
            # the earlier save ends at 570 s (before the chain's last kill): the later save that holds it all wins
            clips = [
                {"id": "L01", "file": "v1", "start": 20.0, "end": 29.0, "wallStart": t0 + 560.0, "labels": ["A"],
                 "reasons": ["a"], "score": 5},
                {"id": "L02", "file": "v2", "start": 30.0, "end": 45.0, "wallStart": t0 + 575.0, "labels": ["B"],
                 "reasons": ["b"], "score": 3},
            ]
            self.assertEqual(clipper._retime_live_clips(a, clips, mpath, {"v1": 30.0, "v2": 60.0}), 1)
            (c,) = clips
            self.assertEqual((c["id"], c["labels"]), ("L02", ["B", "A"]))
            self.assertEqual([(round(p["start"] + 545.0, 2), round(p["end"] + 545.0, 2)) for p in c["pieces"]],
                             [(548.0, 562.5), (577.0, 582.5)])

def match(i, start, end, end_screen=None, qualifies=False, result=None, mode="mp"):
    return {"index": i, "start": float(start), "end": float(end), "mode": mode, "result": result,
            "endScreenAt": end_screen, "resultAt": end_screen if result else None, "reel": {"qualifies": qualifies}}


class StoryMontageTests(unittest.TestCase):
    """RP2 (D361) story montages and the end-screen fix (triage F1)."""

    def test_kills_read_on_end_screens_never_reach_a_montage(self):
        # 2026-11-11: kill-feed and medal reads after VICTORY put result screens of several matches into one montage
        ms = [match(1, 0, 400, end_screen=300, qualifies=True, result="VICTORY")]
        hits = [kill(100 + 25 * i) for i in range(8)] + [kill(305), kill(320), medal(321, "Fury Kill")]
        for m in mont.plan_montages(hits, RANKING, CFG, 1000, ms):
            for p in m["pieces"]:
                self.assertLessEqual(p["end"], 300.0, p)
        hits = [kill(299)] + [kill(100 + 25 * i) for i in range(7)]
        (m,) = mont.plan_montages(hits, RANKING, CFG, 1000, ms)
        self.assertEqual(max(p["end"] for p in m["pieces"]), 300.0, "the last kill's piece stops at the end screen")

    def test_one_match_told_in_order_after_a_fast_cut_then_its_own_result(self):
        ms = [match(1, 0, 400, end_screen=380, qualifies=True, result="VICTORY"), match(2, 400, 800, end_screen=780)]
        hits = [kill(50 + 40 * i) for i in range(8)] + streak(600, n=3, step=10)
        (m, *_rest) = mont.plan_story_montages(hits, RANKING, CFG, 1000, ms)
        st = m["story"]
        self.assertEqual(st["match"], 1)
        hook = [p for p in m["pieces"] if p.get("hook")]
        body = [p for p in m["pieces"] if not p.get("hook") and not p.get("result")]
        self.assertEqual(len(hook), CFG["story"]["hookCuts"])
        self.assertEqual(m["pieces"][:len(hook)], hook, "the fast cut comes first")
        self.assertAlmostEqual(st["titleAt"], sum(p["end"] - p["start"] for p in hook))
        self.assertLessEqual(st["titleAt"], CFG["story"]["hookMaxSec"])
        self.assertTrue(all(0 <= p["start"] < 400 for p in body), "the story is one match")
        self.assertEqual([p["start"] for p in body], sorted(p["start"] for p in body), "in time order")
        self.assertTrue(m["pieces"][-1].get("result"), "its own result screen ends it")
        self.assertEqual(st["result"], "VICTORY")
        self.assertEqual(st["topUps"], [])
        self.assertTrue(CFG["minSec"] <= m["seconds"] <= CFG["maxSec"])

    def test_a_short_match_is_topped_up_after_the_story_and_shows_no_result(self):
        ms = [match(1, 0, 400, end_screen=380, qualifies=True, result="VICTORY"), match(2, 400, 800, end_screen=780,
                                                                                   qualifies=True, result="VICTORY")]
        hits = [kill(50 + 40 * i) for i in range(4)] + [kill(450 + 40 * i) for i in range(3)]
        (m,) = mont.plan_story_montages(hits, RANKING, CFG, 1000, ms)
        self.assertEqual((m["story"]["match"], m["story"]["topUps"]), (1, [2]))
        body = [p for p in m["pieces"] if not p.get("hook")]
        self.assertFalse(any(p.get("result") for p in body), "no result screen when another match follows")
        first2 = next(i for i, p in enumerate(body) if p["start"] >= 400)
        self.assertTrue(all(p["start"] < 400 for p in body[:first2]) and all(p["start"] >= 400 for p in body[first2:]),
                        "the story match first, the top-up after it")

    def test_kills_in_live_clips_are_left_out_when_possible_and_no_kill_is_used_twice(self):
        ms = [match(1, 0, 400, end_screen=380), match(2, 400, 800, end_screen=780), match(3, 800, 1200, end_screen=1180)]
        hits = ([kill(50 + 40 * i) for i in range(7)] + [kill(450 + 40 * i) for i in range(7)]
                + [kill(850 + 40 * i) for i in range(7)])
        ms_out = mont.plan_story_montages(hits, RANKING, CFG, 2000, ms, avoid=[(0.0, 400.0)])
        self.assertEqual(sorted(m["story"]["match"] for m in ms_out[:2]), [2, 3], "the live-clip match is not a story first")
        seen = []
        for m in ms_out:
            for p in m["pieces"]:
                if not p.get("hook"):
                    self.assertNotIn((p["start"], p["end"]), seen)
                    seen.append((p["start"], p["end"]))
        opens = [t for m in ms_out for t in m["story"]["hookMoments"]]
        self.assertEqual(len(opens), len(set(opens)), "a moment opens one montage only")

    def test_story_needs_the_flag_and_is_off_by_default(self):
        import json
        with open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "flags.json"), encoding="utf-8") as f:
            flags = {x["id"]: x for x in json.load(f)["flags"]}
        self.assertIs(flags[CFG["story"]["flag"]]["default"], False)


if __name__ == "__main__":
    unittest.main()
