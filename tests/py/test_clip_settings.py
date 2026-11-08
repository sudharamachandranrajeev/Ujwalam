# SPDX-License-Identifier: GPL-3.0-or-later
"""The user's clip choices on the Python side (D284): settings.json read with safe defaults, the clipper allowed
unless every choice is off, the live clipper on only while the launcher's request is fresh, and the saves of one
recording or stream picked by time."""
import json
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "clip"))
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import clip_common as cc  # noqa: E402
import clipper  # noqa: E402


def _write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


class ClipSettingsTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = self.td.name

    def tearDown(self):
        self.td.cleanup()

    def test_defaults_and_bad_values(self):
        self.assertEqual(cc.clip_settings(self.d), {"recording": "ask", "live": "ask"})
        self.assertEqual(cc.clip_settings(None), {"recording": "ask", "live": "ask"})
        _write(os.path.join(self.d, "settings.json"), json.dumps({"clips": {"recording": "while", "live": "sometimes"}}))
        self.assertEqual(cc.clip_settings(self.d), {"recording": "while", "live": "ask"})
        _write(os.path.join(self.d, "settings.json"), "{broken")
        self.assertEqual(cc.clip_settings(self.d), {"recording": "ask", "live": "ask"})

    def test_allowed_unless_all_off(self):
        self.assertTrue(cc.clips_allowed(self.d), "ask counts as allowed: the user said yes to that run")
        _write(os.path.join(self.d, "settings.json"), json.dumps({"clips": {"recording": "off", "live": "off"}}))
        self.assertFalse(cc.clips_allowed(self.d), "all off and the developer flag off (its committed default)")

    def test_worker_request_fresh_only(self):
        f = os.path.join(self.d, "clips", "live-worker.json")
        self.assertFalse(cc.worker_wanted(self.d))
        _write(f, json.dumps({"on": True, "atMs": 1_000_000}))
        self.assertTrue(cc.worker_wanted(self.d, now=1_010.0))
        self.assertFalse(cc.worker_wanted(self.d, now=1_031.0), "older than 30 s: the launcher is gone")
        _write(f, json.dumps({"on": False, "atMs": 1_000_000}))
        self.assertFalse(cc.worker_wanted(self.d, now=1_000.0))
        _write(f, json.dumps({"on": "yes", "atMs": 1_000_000}))
        self.assertFalse(cc.worker_wanted(self.d, now=1_000.0))


class SavesBetweenTests(unittest.TestCase):
    def test_window(self):
        rows = [{"at": "2026-11-08T09:59:59.999Z"}, {"at": "2026-11-08T10:00:00.000Z"}, {"at": "2026-11-08T10:30:00.000Z"},
                {"at": "2026-11-08T11:00:00.001Z"}, {}]
        got = clipper.saves_between(rows, "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z")
        self.assertEqual([r["at"] for r in got], ["2026-11-08T10:00:00.000Z", "2026-11-08T10:30:00.000Z"])
        self.assertEqual(len(clipper.saves_between(rows)), 5, "no window: every save")


if __name__ == "__main__":
    unittest.main()
