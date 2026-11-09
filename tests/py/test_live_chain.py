# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 live clipping: kill-chain state machine (services/clip/live_chain.py)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
from live_chain import LiveChain  # noqa: E402

RANKING = cc.load_config("ranking")
LIVE = cc.load_config("live-clips")


def medal(label):
    return {"detector": "M3", "label": label, "signal": True, "role": "positive"}


DEATH = {"detector": "N1", "label": "KILLCAM", "signal": False, "role": "negative"}


def run(chain, frames, until):
    """frames: {t: [hits]}; steps every second from 0 to until; returns the actions."""
    out = []
    for t in range(until + 1):
        a = chain.step(float(t), frames.get(t, []))
        if a:
            out.append(a)
    return out


class LiveChainTests(unittest.TestCase):
    def test_config_is_proposed_and_consistent(self):
        self.assertEqual(LIVE["status"], "proposed")
        LiveChain(RANKING, LIVE)  # raises when replaySec cannot hold the chain

    def test_chain_saves_after_quiet_with_banner_repeats_counted_once(self):
        frames = {t: [medal("Triple Kill")] for t in (100, 101, 102)}  # one banner over 3 frames
        frames.update({t: [medal("Fury Kill")] for t in (106, 107)})
        acts = run(LiveChain(RANKING, LIVE), frames, 130)
        self.assertEqual(len(acts), 1)
        a = acts[0]
        self.assertEqual((a["reason"], a["score"]), ("quiet", 3 + 4))
        self.assertEqual(a["labels"], ["Triple Kill", "Fury Kill"])
        self.assertEqual(a["at"], 106 + LIVE["quietSec"])
        self.assertEqual((a["start"], a["end"]), (100 - LIVE["preSec"], 106 + LIVE["postSec"]))

    def test_double_kill_alone_saves_nothing(self):
        self.assertEqual(run(LiveChain(RANKING, LIVE), {50: [medal("Double Kill")]}, 80), [])

    def test_death_closes_the_chain_before_the_killcam(self):
        frames = {100: [medal("Triple Kill")], 105: [DEATH], 106: [DEATH], 107: [DEATH]}
        acts = run(LiveChain(RANKING, LIVE), frames, 130)
        self.assertEqual(len(acts), 1)
        self.assertEqual(acts[0]["reason"], "death")
        self.assertEqual(acts[0]["at"], 105)
        self.assertEqual(acts[0]["end"], min(105 - RANKING["death"]["endBeforeSec"], 100 + LIVE["postSec"]))

    def test_long_chain_force_saves_before_the_replay_loses_its_start(self):
        labels = ["Triple Kill", "Fury Kill", "Frenzy Kill", "Super Kill", "Mega Kill", "Ultra Kill",
                  "Merciless", "Ruthless", "Relentless", "Brutal", "Nuclear", "Ultimate Terminator"]
        frames = {10 + 6 * i: [medal(lab)] for i, lab in enumerate(labels)}
        acts = run(LiveChain(RANKING, LIVE), frames, 120)
        self.assertGreaterEqual(len(acts), 2)
        self.assertEqual(acts[0]["reason"], "force")
        for a in acts:
            self.assertLessEqual(a["at"] - a["start"], LIVE["replaySec"], "window fits the replay buffer")
        self.assertEqual(acts[-1]["reason"], "quiet")

    def test_unapproved_weights_never_save(self):
        r = {**RANKING, "detectorWeightsStatus": "proposed"}
        frames = {t: [medal("Nuclear")] for t in range(10, 40, 5)}
        self.assertEqual(run(LiveChain(r, LIVE), frames, 80), [])


class MinimumClipLengthTests(unittest.TestCase):
    """The user's minimum clip length (live-clips.json minClipSec, 20 s) holds for live windows. Synthetic feed: one
    sampled frame per second; the worker derives startBack/endBack as (save moment - start/end), done here too."""

    def live(self, **kw):
        return {**LIVE, **kw}

    def windows(self, live, frames, until=200):
        out = []
        for a in run(LiveChain(RANKING, live), frames, until):
            out.append((a, a["end"] - a["start"], round(a["at"] - a["start"], 2), round(max(0.0, a["at"] - a["end"]), 2)))
        return out

    def test_config_minimum_is_the_users_20_s(self):
        self.assertEqual(LIVE["minClipSec"], 20.0)

    def test_single_card_window_is_at_least_the_minimum_with_shipped_config(self):
        [(a, length, back, _)] = self.windows(LIVE, {100: [medal("Triple Kill")]})
        self.assertGreaterEqual(length, LIVE["minClipSec"])
        self.assertLessEqual(back, LIVE["replaySec"], "start still inside the replay buffer")

    def test_short_pre_roll_is_extended_to_the_minimum_not_hardcoded(self):
        for pre, minimum in ((15.0, 20.0), (15.0, 25.0), (10.0, 30.0)):
            live = self.live(preSec=pre, minClipSec=minimum)
            [(a, length, _, _)] = self.windows(live, {100: [medal("Triple Kill")]})
            self.assertEqual(length, minimum, (pre, minimum))
            self.assertEqual(a["end"], 100 + live["postSec"])
            self.assertEqual(a["start"], a["end"] - minimum)

    def test_minimum_zero_keeps_the_plain_preroll(self):
        live = self.live(preSec=15.0, minClipSec=0.0)
        [(a, length, _, _)] = self.windows(live, {100: [medal("Triple Kill")]})
        self.assertEqual(length, 15.0 + live["postSec"])

    def test_long_window_is_untouched(self):
        frames = {100: [medal("Triple Kill")], 108: [medal("Fury Kill")]}
        [(a, length, _, _)] = self.windows(LIVE, frames)
        self.assertEqual(a["start"], 100 - LIVE["preSec"])
        self.assertEqual(length, 8 + LIVE["preSec"] + LIVE["postSec"])

    def test_death_close_extends_the_start_back(self):
        frames = {100: [medal("Triple Kill")], 103: [DEATH], 104: [DEATH]}
        [(a, length, _, _)] = self.windows(LIVE, frames)
        self.assertEqual(a["reason"], "death")
        self.assertEqual(a["end"], 101.0)  # death.endBeforeSec before the KILLCAM hit; unchanged
        self.assertEqual(length, LIVE["minClipSec"], "start moved earlier to reach the minimum")

    def test_extension_stops_at_the_previous_killcam(self):
        frames = {50: [DEATH], 51: [DEATH], 100: [medal("Triple Kill")], 103: [DEATH]}
        live = self.live(preSec=5.0)
        acts = [w for w in self.windows(live, frames) if w[0]["reason"] == "death"]
        a = acts[0][0]
        self.assertEqual(a["start"], a["end"] - LIVE["minClipSec"], "floor 55 is not reached: only the missing seconds")
        frames2 = {90: [DEATH], 100: [medal("Triple Kill")], 103: [DEATH]}
        a2 = [w for w in self.windows(self.live(preSec=5.0), frames2) if w[0]["reason"] == "death"][0][0]
        self.assertEqual(a2["start"], 90 + LIVE["repeatSec"], "never back into the earlier KILLCAM")

    def test_extension_stays_inside_the_replay_buffer(self):
        live = self.live(preSec=5.0, minClipSec=40.0, replaySec=60, forceMarginSec=5.0)
        [(a, _, back, _)] = self.windows(live, {100: [medal("Triple Kill")]})
        self.assertLessEqual(back, live["replaySec"] - live["forceMarginSec"])

    def test_minimum_longer_than_the_buffer_is_refused(self):
        with self.assertRaises(ValueError):
            LiveChain(RANKING, self.live(minClipSec=58.0))

    def test_force_save_windows_meet_the_minimum(self):
        labels = ["Triple Kill", "Fury Kill", "Frenzy Kill", "Super Kill", "Mega Kill", "Ultra Kill",
                  "Merciless", "Ruthless", "Relentless", "Brutal", "Nuclear", "Ultimate Terminator"]
        frames = {10 + 6 * i: [medal(lab)] for i, lab in enumerate(labels)}
        for a, length, _, _ in self.windows(LIVE, frames, 120):
            self.assertGreaterEqual(length, LIVE["minClipSec"], a["reason"])


if __name__ == "__main__":
    unittest.main()
