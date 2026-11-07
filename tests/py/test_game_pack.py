# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for the game pack loader (services/clip/game_pack.py, P2b W0).

Stdlib only; runs under the system Python (npm run test:py). Reads the committed CODM pack;
temp copies are used for the broken-pack cases. The pack's local/ folder is never read.
"""

import importlib.util
import json
import os
import shutil
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")
PACK_DIR = os.path.join(_HERE, "..", "..", "data", "games", "codm")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_CLIP, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gp = _load("game_pack")


def _read(name):
    with open(os.path.join(PACK_DIR, name), encoding="utf-8") as f:
        return json.load(f)


class LoaderTests(unittest.TestCase):
    def setUp(self):
        self.pack = gp.load_pack(PACK_DIR)

    def test_folder_and_detectors_json_give_the_same_pack(self):
        self.assertEqual(self.pack, gp.load_pack(os.path.join(PACK_DIR, "detectors.json")))

    def test_merged_shape(self):
        p = self.pack
        game = _read("game.json")
        self.assertEqual(p["version"], "0.4.0")
        self.assertEqual(p["game"], {"id": game["id"], "name": game["name"]})
        for k in ("modes", "taggingOnlyModes", "gameArea", "nameMatch", "ocr"):
            self.assertEqual(p[k], game[k], k)
        det = _read("detectors.json")
        self.assertEqual([d["id"] for d in p["detectors"]], [d["id"] for d in det["detectors"]])
        self.assertEqual(p["suppressionRules"], det["suppressionRules"])
        self.assertEqual(p["endScreenRule"], det["endScreenRule"])
        self.assertEqual([s["id"] for s in p["screens"]], [s["id"] for s in _read("screens.json")["screens"]])

    def test_m3_gets_the_medal_catalogue_in_order(self):
        m3 = next(d for d in self.pack["detectors"] if d["id"] == "M3")
        medals = _read("events.json")["catalogues"][0]["events"]
        self.assertEqual(m3["medals"], medals)
        self.assertEqual(m3["medals"][0]["text"], "Double Kill")
        for d in self.pack["detectors"]:
            if d["id"] != "M3":
                self.assertNotIn("medals", d, d["id"])
        status = {m["text"]: m["status"] for m in m3["medals"]}
        for n in ("Mega Kill", "Super Kill", "Ultra Kill"):
            self.assertEqual(status[n], "seen_g1", n)

    def test_merge_does_not_alias_the_catalogue(self):
        m3 = next(d for d in self.pack["detectors"] if d["id"] == "M3")
        m3["medals"][0]["text"] = "changed"
        again = next(d for d in gp.load_pack(PACK_DIR)["detectors"] if d["id"] == "M3")
        self.assertEqual(again["medals"][0]["text"], "Double Kill")

    def test_reference_dataset(self):
        self.assertEqual(gp.reference_dataset(self.pack), ("M3", "data/games/codm/local/medals-reference"))
        self.assertIsNone(gp.reference_dataset({"detectors": [{"id": "M1"}]}))

    def test_single_file_pack_is_returned_unchanged(self):
        legacy = {"version": "0.2.2", "game": {"id": "codm", "name": "x"}, "modes": ["mp"],
                  "nameMatch": {"profileKey": "codm"},
                  "detectors": [{"id": "M3", "medals": [{"text": "Fury Kill", "class": "positive"}]}]}
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "detectors-0.2.2.json")
            with open(f, "w", encoding="utf-8") as fh:
                json.dump(legacy, fh)
            self.assertEqual(gp.load_pack(f), legacy)


class BrokenPackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dir = os.path.join(self.tmp, "codm")
        os.makedirs(self.dir)
        for f in gp.PACK_FILES:
            shutil.copy(os.path.join(PACK_DIR, f), self.dir)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _edit(self, name, fn):
        p = os.path.join(self.dir, name)
        with open(p, encoding="utf-8") as f:
            doc = json.load(f)
        fn(doc)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(doc, f)

    def test_copy_loads(self):
        self.assertEqual(gp.load_pack(self.dir)["version"], "0.4.0")

    def test_unknown_catalogue_raises(self):
        self._edit("events.json", lambda d: d["catalogues"][0].update(id="awards"))
        with self.assertRaisesRegex(ValueError, "catalogue 'medals' not in events.json"):
            gp.load_pack(self.dir)

    def test_game_mismatch_raises(self):
        self._edit("screens.json", lambda d: d.update(game="other"))
        with self.assertRaisesRegex(ValueError, "screens.json: game 'other'"):
            gp.load_pack(self.dir)

    def test_missing_file_raises(self):
        os.remove(os.path.join(self.dir, "events.json"))
        with self.assertRaises(FileNotFoundError):
            gp.load_pack(self.dir)


if __name__ == "__main__":
    unittest.main()
