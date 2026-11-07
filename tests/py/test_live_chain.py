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


if __name__ == "__main__":
    unittest.main()
