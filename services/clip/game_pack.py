# SPDX-License-Identifier: GPL-2.0-or-later
"""Game pack loader (P2b W0). Stdlib only.

A pack is a folder data/games/<id>/ with game.json, detectors.json, events.json, screens.json
(and capture-plan.json, which the G1 tools do not read). load_pack() returns one merged dict
in the shape the G1 tools use:

  version, engineVersion, game {id, name}, modes, taggingOnlyModes, gameArea, nameMatch, ocr,
  detectors (a detector with `catalogue` also gets the catalogue's events as `medals`),
  suppressionRules, endScreenRule, screens, pairingRules

`path` may be the pack folder or its detectors.json. A single-file pack from before 0.3.0
(detectors.json with a `game` object and inline M3 `medals`) is returned unchanged, so older
pack versions can still be analysed for comparison. Schema and cross-file checks are done by
tools/game-validate.mjs; this loader only checks what it needs to merge. The pack's local/
folder is never read.
"""

from __future__ import annotations

import copy
import json
import os

PACK_FILES = ("game.json", "detectors.json", "events.json", "screens.json")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pack_dir(path):
    """The pack folder for a folder or detectors.json path."""
    return path if os.path.isdir(path) else os.path.dirname(os.path.abspath(path))


def load_pack(path):
    folder = pack_dir(path)
    det_path = os.path.join(folder, "detectors.json") if os.path.isdir(path) else path
    det = _read(det_path)
    if isinstance(det.get("game"), dict):
        return det  # single-file pack (< 0.3.0)
    game = _read(os.path.join(folder, "game.json"))
    events = _read(os.path.join(folder, "events.json"))
    screens = _read(os.path.join(folder, "screens.json"))
    for name, doc_game in (("detectors.json", det.get("game")), ("events.json", events.get("game")),
                           ("screens.json", screens.get("game"))):
        if doc_game != game["id"]:
            raise ValueError(f"{name}: game {doc_game!r} does not match game.json id {game['id']!r}")
    catalogues = {c["id"]: c["events"] for c in events["catalogues"]}
    detectors = []
    for d in det["detectors"]:
        d = copy.deepcopy(d)
        if "catalogue" in d:
            if d["catalogue"] not in catalogues:
                raise ValueError(f"detectors.json: {d['id']} catalogue {d['catalogue']!r} not in events.json")
            d["medals"] = copy.deepcopy(catalogues[d["catalogue"]])
        detectors.append(d)
    merged = {
        "version": det["version"],
        "engineVersion": det["engineVersion"],
        "game": {"id": game["id"], "name": game["name"]},
        "modes": game["modes"],
        "taggingOnlyModes": game.get("taggingOnlyModes", []),
        "gameArea": game.get("gameArea"),
        "nameMatch": game["nameMatch"],
        "ocr": game["ocr"],
        "detectors": detectors,
        "suppressionRules": det.get("suppressionRules", []),
        "screens": screens["screens"],
        "pairingRules": screens.get("pairingRules", []),
    }
    if "endScreenRule" in det:
        merged["endScreenRule"] = det["endScreenRule"]
    return merged


def reference_dataset(pack):
    """(detector id, repo-relative dataset path) of the first detector with a referenceDataset, or None."""
    for d in pack["detectors"]:
        if d.get("referenceDataset"):
            return d["id"], d["referenceDataset"]["path"]
    return None
