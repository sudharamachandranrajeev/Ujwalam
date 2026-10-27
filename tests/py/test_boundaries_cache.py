# SPDX-License-Identifier: GPL-2.0-or-later
"""Unit tests for services/clip/boundary_xcorr.py and services/clip/build_cache.py.

Synthetic signals and synthetic session records only; no corpus access, no ffmpeg.
Run: python -I -m unittest discover -s tests/py -t tests/py
"""

import importlib.util
import math
import os
import random
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_CLIP, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bx = _load("boundary_xcorr")
bc = _load("build_cache")

RATE = 8000


def synthetic_audio(seconds: float, seed: int) -> list[int]:
    """Noise with a random loud/quiet amplitude envelope (50-300 ms segments) and a
    slow tone, so that both the energy envelope and the raw samples have structure."""
    rng = random.Random(seed)
    n = int(seconds * RATE)
    out = []
    amp = 0.0
    left = 0
    for i in range(n):
        if left <= 0:
            amp = rng.choice((300.0, 1500.0, 6000.0, 12000.0))
            left = rng.randint(int(0.05 * RATE), int(0.3 * RATE))
        left -= 1
        v = amp * (rng.random() * 2 - 1) * 0.6 + 2000.0 * math.sin(2 * math.pi * 220 * i / RATE)
        out.append(max(-32768, min(32767, int(v))))
    return out


class XcorrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signal = synthetic_audio(24.0, seed=11)

    def split(self, a_len: float, overlap: float, b_len: float = 8.0):
        """A = signal[0 : a_len]; B starts `overlap` seconds before A's end."""
        a_end = int(a_len * RATE)
        b0 = a_end - int(round(overlap * RATE))
        return self.signal[:a_end], self.signal[b0:b0 + int(b_len * RATE)]

    def test_envelope_xcorr_recovers_known_offsets_within_10ms(self):
        for overlap in (0.73, 1.5, 2.004, 4.25):
            a, b = self.split(12.0, overlap)
            env_a = bx.envelope(a, RATE, from_end=True)
            env_b = bx.envelope(b, RATE)
            curve = bx.coarse_overlap(env_a, env_b, 25, 600)
            n_best, r = max(curve, key=lambda t: t[1])
            self.assertLessEqual(abs(n_best * bx.FRAME_SEC - overlap), 0.010, overlap)
            self.assertGreater(r, 0.95)

    def test_measure_pcm_sample_level(self):
        for overlap in (0.6125, 1.9871, 3.3333):
            a, b = self.split(12.0, overlap)
            m = bx.measure_pcm(a, b)
            self.assertEqual(m["status"], "ok")
            self.assertLessEqual(abs(m["overlapSec"] - overlap), 0.010)
            self.assertLessEqual(abs(m["overlapSec"] - round(overlap * RATE) / RATE), 1 / RATE)
            self.assertGreater(m["confidence"], 0.99)

    def test_leading_fill_is_skipped(self):
        overlap = 0.9
        a, b = self.split(12.0, overlap)
        b = list(b)
        b[160:1200] = [0] * 1040  # 20 ms of audio, then 130 ms of async-fill silence
        self.assertEqual(bx.leading_fill(b), 1200)
        m = bx.measure_pcm(a, b)
        self.assertEqual(m["status"], "ok")
        self.assertLessEqual(abs(m["overlapSec"] - overlap), 0.010)
        self.assertAlmostEqual(m["headFillSec"], 0.15, places=3)

    def test_unrelated_audio_is_rejected(self):
        a = self.signal[:int(12 * RATE)]
        b = synthetic_audio(8.0, seed=99)
        m = bx.measure_pcm(a, b)
        self.assertEqual(m["status"], "rejected-low-confidence")

    def test_silence_is_rejected(self):
        a, b = self.split(12.0, 1.0)
        a = [v // 2000 for v in a]   # about -66 dB quieter
        b = [v // 2000 for v in b]
        self.assertEqual(bx.measure_pcm(a, b)["status"], "rejected-silent")

    def test_verdict(self):
        def rec(a_dur, b_dur, dn, trim):
            return {"status": "ok", "aDur": a_dur, "bDur": b_dur,
                    "residualEndHyp": trim - (b_dur - dn), "residualStartHyp": trim - (a_dur - dn)}
        # name = end: true end-to-end spacing 30.15 s, names floor()ed
        recs = []
        for a_dur, b_dur, s2s in ((31.0, 29.0, 32.0), (29.0, 31.0, 28.0), (24.0, 30.5, 24.0),
                                  (30.5, 30.6, 30.0), (28.4, 30.5, 28.0), (31.9, 30.0, 32.0)):
            trim = a_dur - s2s
            dn = math.floor(30.15 * len(recs) + 30.15) - math.floor(30.15 * len(recs))
            recs.append(rec(a_dur, b_dur, dn, trim))
        v = bx.verdict(recs)
        self.assertEqual(v["verdictEnd"], "fits")
        self.assertEqual(v["verdictStart"], "does not fit")
        self.assertEqual(bx.verdict(recs[:2])["verdictEnd"], "inconclusive")


SESSION = {
    "id": "s-2026-10-20-1214", "clipCount": 3, "trimmedDurationSec": 0.0,
    "clips": [
        {"file": "MeldStudio_Clip_Clipping_Output_2026-10-20_at_12.15.10pm.mp4", "duration": 30.0,
         "trimInSec": 0.0, "trimMethod": None, "startUtc": "2026-10-20T11:14:40Z"},
        {"file": "MeldStudio_Clip_Clipping_Output_2026-10-20_at_12.15.40pm.mp4", "duration": 30.5,
         "trimInSec": 0.4614, "trimMethod": "measured", "startUtc": "2026-10-20T11:15:09.5Z"},
        {"file": "it's odd.mp4", "duration": 29.0,
         "trimInSec": 0.0, "trimMethod": "name-time", "startUtc": "2026-10-20T11:15:41Z"},
    ],
}


class ConcatListTests(unittest.TestCase):
    def test_list_has_inpoints_only_where_trimmed(self):
        text = bc.concat_list(SESSION, "C:\\clips dir")
        lines = text.splitlines()
        self.assertEqual(lines[0], "ffconcat version 1.0")
        self.assertEqual(lines[1], "file 'C:/clips dir/MeldStudio_Clip_Clipping_Output_2026-10-20_at_12.15.10pm.mp4'")
        self.assertEqual(lines[2], "file 'C:/clips dir/MeldStudio_Clip_Clipping_Output_2026-10-20_at_12.15.40pm.mp4'")
        self.assertEqual(lines[3], "inpoint 0.4614")
        self.assertEqual(lines[4], "file 'C:/clips dir/it'\\''s odd.mp4'")  # quote escaped
        self.assertEqual(len(lines), 5)
        self.assertTrue(text.endswith("\n"))

    def test_manifest_maps_cache_time_to_clip(self):
        m = bc.build_manifest(SESSION, {"nameTime": "end"})
        segs = m["segments"]
        self.assertEqual([s["sessionStartSec"] for s in segs], [0.0, 30.0, round(30.0 + 30.5 - 0.4614, 4)])
        self.assertEqual(m["expectedDurationSec"], round(30.0 + 30.0386 + 29.0, 4))
        self.assertEqual(m["trimMethods"], {"measured": 1, "name-time": 1})
        clip, off, _ = bc.locate(m, 31.0)
        self.assertEqual(clip, SESSION["clips"][1]["file"])
        self.assertAlmostEqual(off, 0.4614 + 1.0, places=6)
        clip, off, _ = bc.locate(m, 10.0)
        self.assertEqual((clip, off), (SESSION["clips"][0]["file"], 10.0))
        self.assertEqual(segs[1]["wallStartUtc"], "2026-10-20T11:15:09.961Z")

    def test_cache_inside_corpus_refused(self):
        with tempfile.TemporaryDirectory() as d:
            rc = bc.main(["--index", os.path.join(d, "missing.json"), "--corpus", d,
                          "--cache", os.path.join(d, "cache"), "--session", "s-x"])
            self.assertEqual(rc, 2)
            self.assertFalse(os.path.exists(os.path.join(d, "cache")))

    def test_output_key_changes_with_list_and_ignores_temp_name(self):
        cmd1 = bc.audio_cmd("ffmpeg", "list.txt", "a.partial.flac")
        k1 = bc.output_key("x", cmd1, "a.partial.flac")
        self.assertEqual(k1, bc.output_key("x", bc.audio_cmd("ffmpeg", "list.txt", "b.flac"), "b.flac"))
        self.assertNotEqual(k1, bc.output_key("y", cmd1, "a.partial.flac"))


class DryRunTests(unittest.TestCase):
    def test_dry_run_keeps_output_checks_and_verify_of_last_build(self):
        import json
        from types import SimpleNamespace
        index = {"nameTime": "end", "timezoneAssumption": "BST"}
        with tempfile.TemporaryDirectory() as tmp:
            sdir = os.path.join(tmp, SESSION["id"])
            os.makedirs(sdir)
            old = {"outputs": {"audio": {"bytes": 123}}, "verify": {"points": [{"cacheSec": 1.0}]}}
            with open(os.path.join(sdir, bc.MANIFEST_FILE), "w", encoding="utf-8") as fh:
                json.dump(old, fh)
            args = SimpleNamespace(cache=tmp, corpus=os.path.join(tmp, "corpus"), ffmpeg="ffmpeg",
                                   ffprobe="ffprobe", only={"audio", "proxy"}, decode="cpu",
                                   force=False, dry_run=True, verify=0)
            report = bc.build_session(SESSION, index, args, "libx264")
            self.assertEqual({o["status"] for o in report["outputs"].values()}, {"dry-run"})
            with open(os.path.join(sdir, bc.MANIFEST_FILE), encoding="utf-8") as fh:
                new = json.load(fh)
            self.assertEqual(new["outputs"], old["outputs"])
            self.assertEqual(new["verify"], old["verify"])
            self.assertEqual(len(new["segments"]), 3)


if __name__ == "__main__":
    unittest.main()
