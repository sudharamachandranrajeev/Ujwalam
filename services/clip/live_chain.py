# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 live clipping (D226): kill-chain state machine for the live worker.

Fed once per sampled frame with that frame's detector hits (detector_pass.frame_hits rows). It decides when to save
the replay buffer. The rules are the post-stream ones (clip_rank.detector_weight with the approved ranking.json
weights, sumKinds, minScore, death detectors); the timing is live-only (data/clip/live-clips.json).

  medal      a hit with weight > 0. The same detector + label seen again within repeatSec is the same banner still on
             screen and counts once (post-stream merges these frames the same way).
  chain      opens on the first medal and stays open while medals keep coming (each extends it by quietSec).
  close      quiet:  quietSec after the last medal (+ postSec of play kept after it);
             death:  a death detector hit (KILLCAM): the clip ends death.endBeforeSec before it, at once (hard negative,
                     D225);
             force:  the chain has run so long that the replay buffer would lose its start: save now, keep counting
                     the same chain into the next save.
  length     a window shorter than minClipSec (live-clips.json, the user's minimum clip length) starts earlier, by the
             missing seconds, but never before the replay buffer's start (replaySec - forceMarginSec back from the save)
             and never inside the previous death's KILLCAM. A death can leave it short: the end is fixed then.
  save       only when the chain's score reaches minScore. The action carries the clip window in worker seconds;
             the worker turns it into a trim of the saved replay file (the file ends at the save moment).

Pure logic: no I/O, no clock. Time is the caller's monotonic seconds.
"""

from __future__ import annotations

import clip_rank as rank


class LiveChain:
    def __init__(self, ranking, live):
        self.w = ranking.get("detectorWeights", {})
        self.approved = ranking.get("detectorWeightsStatus") == "approved"
        self.sum_kinds = set(ranking.get("sumKinds", []))
        self.min_score = float(ranking.get("minScore", 0.0))
        death = ranking.get("death") or {}
        self.death_dets = set(death.get("detectors", []))
        self.end_before = float(death.get("endBeforeSec", 2.0))
        self.repeat = float(live["repeatSec"])
        self.quiet = float(live["quietSec"])
        self.pre = float(live["preSec"])
        self.post = float(live["postSec"])
        self.min_clip = float(live.get("minClipSec", 0.0))
        self.buffer = float(live["replaySec"]) - float(live["forceMarginSec"])
        if self.min_clip > self.buffer:
            raise ValueError("live-clips: minClipSec longer than the replay buffer allows (replaySec - forceMarginSec)")
        self.force_after = float(live["replaySec"]) - self.pre - float(live["forceMarginSec"])
        if self.force_after <= self.quiet:
            raise ValueError("live-clips: replaySec too short for preSec + forceMarginSec + quietSec")
        self.seen = {}       # (detector, label) -> last time seen (any frame), for repeatSec
        self.chain = None    # {"start", "last", "seg_start", "medals": [(t, kind, label, w)]}
        self.in_death = None  # time of the last death hit while its KILLCAM is still on screen
        self.last_death = None  # time of the last death hit ever seen: a clip never starts before it ends (+repeat)

    def _score(self, medals):
        per = {}
        for _, kind, _, w in medals:
            per[kind] = per.get(kind, 0.0) + w if kind in self.sum_kinds else max(w, per.get(kind, 0.0))
        return sum(per.values())

    def _action(self, reason, end, t):
        c = self.chain
        medals = [m for m in c["medals"] if m[0] >= c["seg_start"]]
        score = self._score(c["medals"])
        start = max(c["seg_start"] - self.pre, c["start"] - self.pre)
        if end - start < self.min_clip:
            floor = t - self.buffer
            if self.last_death is not None:
                floor = max(floor, self.last_death + self.repeat)
            start = min(start, max(end - self.min_clip, floor))
        if score < self.min_score or end <= start:
            return None
        return {"save": True, "reason": reason, "at": t, "start": round(start, 2), "end": round(end, 2),
                "anchor": round(max(medals, key=lambda m: m[3])[0] if medals else c["last"], 2),
                "score": round(score, 3), "labels": [m[2] for m in c["medals"]]}

    def step(self, t, hits):
        """One sampled frame at worker time t with its hits. Returns a save action dict or None."""
        died = any(h.get("detector") in self.death_dets for h in hits)
        if died:
            first = self.in_death is None or t - self.in_death > self.repeat
            self.in_death = t
            if self.chain and first:
                act = self._action("death", min(t - self.end_before, self.chain["last"] + self.post), t)
                self.chain = None
                self.last_death = t
                return act
            self.last_death = t
            return None
        out = None
        for h in hits:
            w, _ = rank.detector_weight(h, self.w, self.approved)
            if w <= 0:
                continue
            key = (h["detector"], h.get("label"))
            prev = self.seen.get(key)
            self.seen[key] = t
            if prev is not None and t - prev <= self.repeat:
                continue  # same banner, still on screen
            kind = f"detector.{h['detector']}"
            if self.chain is None:
                self.chain = {"start": t, "last": t, "seg_start": t, "medals": []}
            self.chain["medals"].append((t, kind, h.get("label"), w))
            self.chain["last"] = t
        c = self.chain
        if c is None:
            return None
        if t - c["last"] >= self.quiet:
            out = self._action("quiet", min(t, c["last"] + self.post), t)
            self.chain = None
        elif t - c["seg_start"] >= self.force_after:
            out = self._action("force", t, t)
            c["seg_start"] = t  # the chain goes on; the next save starts here (its preSec overlaps this one)
        return out
