# SPDX-License-Identifier: GPL-2.0-or-later
"""Suggestions for the A6 labelling page, pass 2 (P2b). Stdlib only; run with `python -I`.

Turns `g1_scan analyse` output (hits.jsonl, times in clip seconds) for one session into the page's
suggestion file on the SESSION timeline, using the analysis cache manifest (cache time t of segment k
= sessionStartSec + (clip time - clipInSec)). The page never computes suggestions; it only reads this file.

Per session:
  python -I tools/label/suggestions.py --session s-2026-10-20-1214 --hits <hits.jsonl> [--hits ...]
      --manifest <cache>/<session>/manifest.json --pack data/games/codm
      [--out data/games/codm/local/labels-suggestions/<session>.json]

What it does
  - drops hits whose clip time is outside the trimmed part of the clip (no cache time) and counts them
  - keeps event detectors only (NAME is a support signal and is dropped; kill-feed lines M5/B1 are kept
    only when the profile name was on the line as killer or victim)
  - merges repeat sightings of the same event (same detector, medal and side within --merge-sec)
  - applies the pack's suppressionRules: a suppressed suggestion is KEPT, marked suppressed {rule, by},
    and shown greyed by the page (the user can still accept it)
  - shows the end-screen rule: every end screen (the rule's detectors) is listed; a screen is "named"
    when the profile name was on it; per match group the first named screen has counts=true, the other
    named screens counts=false ("counts once per match, every named screen is a reason")

Output fields per suggestion: id, detectorId, timeSec, endTimeSec, confidence, medal, medalClass, side,
mode, samples, suppressed, endScreen, ocrText. ocrText is LOCAL ONLY: it can hold other players' names,
so the page's export never copies it, and --out must resolve (real path) to a file inside
data/games/<game>/local/ of this repository, where <game> is the pack's game id. That folder is
gitignored and the tool also checks it with `git check-ignore`. Any other path (the corpus, the
analysis cache, another folder in or outside the repository) is refused. The corpus (--corpus, default
paths.clips_corpus in --profile data/profile.local.json) and the cache are compared by real path in both
directions; an unknown corpus is refused. The file is written atomically (temp file in the same
folder, then os.replace).

Defaults that are not measured (UNVERIFIED, set by flag): --merge-sec 4, --replay-before 2,
--replay-after 10 (how long after an Impact Play banner the replay repeats medals), --match-group-sec 120
(end screens closer than this belong to one match). The per-detector sample rates and the time each
event stays on screen come from docs/evidence/2026-10-28-p2b-ocr-timing.md.

Full-session pre-fill scan (HEAVY, one job at a time, OCR venv; not run by this tool):
  P=docs/evidence/private/prefill            # gitignored
  .venv/Scripts/python.exe -I services/clip/g1_scan.py --threads 4 scan --index <index.json> --corpus "<clips-corpus>" \\
      --layout docs/evidence/private/g1-corpus/layout-calibrate.json --out $P/scan --name <session> \\
      --sessions <session> --clips-per-session 100000 --fps 0.5
  .venv/Scripts/python.exe -I services/clip/g1_scan.py analyse --scan $P/scan/<session>.jsonl \\
      --pack data/games/codm --profile data/profile.local.json --out $P/analyse-<session>
  python -I tools/label/suggestions.py --session <session> --hits $P/analyse-<session>/hits.jsonl \\
      --manifest <cache>/<session>/manifest.json --pack data/games/codm
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "services", "clip"))
import game_pack  # noqa: E402

TOOL_VERSION = 1
SKIP_DETECTORS = {"NAME"}
KILLFEED = {"M5", "B1"}
DEFAULTS = {"mergeSec": 4.0, "replayBeforeSec": 2.0, "replayAfterSec": 10.0, "matchGroupSec": 120.0}


def segment_index(manifest):
    """clip name -> list of segments (a clip normally appears once)."""
    idx = {}
    for seg in manifest["segments"]:
        idx.setdefault(seg["clip"], []).append(seg)
    return idx


def to_session_time(idx, clip, t):
    """Clip time -> session time through the manifest, or None when t is outside the trimmed clip."""
    for seg in idx.get(clip, ()):
        if seg["clipInSec"] - 1e-6 <= t <= seg["clipOutSec"] + 1e-6:
            return seg["sessionStartSec"] + (t - seg["clipInSec"])
    return None


def _event_key(h):
    d = h["det"]
    medal = (h.get("medal") or {}).get("medal") if isinstance(h.get("medal"), dict) else None
    return (d, medal, h.get("side") if d in KILLFEED else None)


def _keep_hit(h):
    d = h["det"]
    if d in SKIP_DETECTORS:
        return False
    if d in KILLFEED and h.get("side") not in ("killer", "victim"):
        return False
    if d == "M3" and not isinstance(h.get("medal"), dict):
        return False
    return True


def _confidence(h):
    c = float(h.get("score") or 0.0)
    m = h.get("medal")
    if isinstance(m, dict) and m.get("score") is not None:
        c = min(c, float(m["score"]))
    return c


def _named(h):
    if h["det"] == "K1":
        return bool(h.get("signal"))
    return bool(h.get("nameOnFrame"))


def build(hits, manifest, pack, session, params=None):
    """hits: iterable of hits.jsonl rows -> suggestion document (dict)."""
    p = dict(DEFAULTS)
    p.update(params or {})
    idx = segment_index(manifest)
    stats = {"hitsIn": 0, "hitsOtherSession": 0, "hitsDroppedByType": 0, "hitsOutsideTrim": 0, "hitsMapped": 0}
    mapped = []
    for h in hits:
        stats["hitsIn"] += 1
        if h.get("session") != session:
            stats["hitsOtherSession"] += 1
            continue
        if not _keep_hit(h):
            stats["hitsDroppedByType"] += 1
            continue
        if h.get("src") != "clip" or not h.get("clip") or h.get("t") is None:
            stats["hitsDroppedByType"] += 1
            continue
        st = to_session_time(idx, h["clip"], float(h["t"]))
        if st is None:
            stats["hitsOutsideTrim"] += 1
            continue
        stats["hitsMapped"] += 1
        mapped.append((st, h))
    mapped.sort(key=lambda x: x[0])

    # merge repeat sightings of one event
    open_ = {}
    clusters = []
    for st, h in mapped:
        key = _event_key(h)
        c = open_.get(key)
        if c is not None and st - c["endTimeSec"] <= p["mergeSec"]:
            c["endTimeSec"] = st
            c["samples"] += 1
            c["named"] = c["named"] or _named(h)
            if _confidence(h) > c["confidence"]:
                c["confidence"] = _confidence(h)
                c["ocrText"] = h.get("text")
            continue
        m = h.get("medal") if isinstance(h.get("medal"), dict) else None
        c = {"detectorId": h["det"], "timeSec": st, "endTimeSec": st, "confidence": _confidence(h),
             "samples": 1, "named": _named(h), "ocrText": h.get("text"), "mode": h.get("frameMode")}
        if m:
            c["medal"] = m["medal"]
            if h.get("medalClass"):
                c["medalClass"] = h["medalClass"]
        if h["det"] in KILLFEED:
            c["side"] = h["side"]
        open_[key] = c
        clusters.append(c)
    clusters.sort(key=lambda c: c["timeSec"])
    for i, c in enumerate(clusters, 1):
        c["id"] = "sg-%04d" % i

    # suppression rules (kept, marked)
    n_supp = 0
    for rule in pack.get("suppressionRules", []):
        windows = [(c["timeSec"] - p["replayBeforeSec"], c["endTimeSec"] + p["replayAfterSec"], c["id"])
                   for c in clusters if c["detectorId"] == rule["while"]]
        for c in clusters:
            if c["detectorId"] not in rule["suppress"] or "suppressed" in c:
                continue
            for a, b, by in windows:
                if a <= c["timeSec"] <= b:
                    c["suppressed"] = {"rule": rule["id"], "by": by}
                    n_supp += 1
                    break

    # end-screen rule display
    n_end = 0
    esr = pack.get("endScreenRule")
    if esr:
        ends = [c for c in clusters if c["detectorId"] in esr["detectors"]]
        group = 0
        last_t = None
        counted = False
        for c in ends:
            if last_t is None or c["timeSec"] - last_t > p["matchGroupSec"]:
                group += 1
                counted = False
            last_t = c["endTimeSec"]
            named = bool(c["named"])
            counts = named and not counted
            counted = counted or named
            c["endScreen"] = {"rule": esr["id"], "group": group, "named": named, "counts": counts}
            n_end += 1
    for c in clusters:
        c.pop("named", None)

    by_det = {}
    for c in clusters:
        by_det[c["detectorId"]] = by_det.get(c["detectorId"], 0) + 1
    out = []
    for c in clusters:
        o = {k: c[k] for k in ("id", "detectorId", "timeSec", "endTimeSec", "confidence", "samples") if k in c}
        for k in ("medal", "medalClass", "side", "mode", "suppressed", "endScreen", "ocrText"):
            if c.get(k) is not None:
                o[k] = c[k]
        o["timeSec"] = round(o["timeSec"], 3)
        o["endTimeSec"] = round(o["endTimeSec"], 3)
        o["confidence"] = round(o["confidence"], 4)
        out.append(o)
    stats.update({"suggestions": len(out), "suppressed": n_supp, "endScreens": n_end, "byDetector": by_det})
    return {
        "version": 1,
        "sessionId": session,
        "gameId": pack["game"]["id"],
        "packVersion": pack.get("version"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "g1_scan analyse hits.jsonl",
        "toolVersion": TOOL_VERSION,
        "params": p,
        "paramsStatus": "unverified",
        "localOnlyFields": ["ocrText"],
        "stats": stats,
        "suggestions": out,
    }


def _real(p):
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def _under(child, root):
    return child.startswith(root.rstrip(os.sep) + os.sep)


def corpus_from_profile(profile_path):
    """paths.clips_corpus from the local profile, or None when the file, the key or a real value is missing
    (the committed example holds the placeholder "<clips-corpus>")."""
    try:
        with open(profile_path, encoding="utf-8") as f:
            v = (json.load(f).get("paths") or {}).get("clips_corpus")
    except (OSError, ValueError, AttributeError):
        return None
    return v if isinstance(v, str) and v and not v.startswith("<") else None


def check_out(path, manifest_path, game_id, repo=_REPO, corpus=None):
    """Output must resolve to a file inside <repo>/data/games/<game_id>/local/ (gitignored). The analysis
    cache and the corpus are read-only roots, compared by real path (junctions and symlinks resolved) in
    both directions: the output may not be inside either, and neither may be inside (or be) the output's
    folder. The corpus must be known (S3 2026-10-28): fail closed when it is not. Exits with a message otherwise."""
    if not isinstance(game_id, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", game_id):
        sys.exit("refusing: bad game id")
    if not corpus:
        sys.exit("refusing: corpus folder unknown (pass --corpus or set paths.clips_corpus in data/profile.local.json)")
    out = _real(path)
    local = _real(os.path.join(repo, "data", "games", game_id, "local"))
    if not _under(out, local):
        sys.exit("refusing: --out must be inside data/games/%s/local/ in the repository (ocrText can hold names): %s"
                 % (game_id, path))
    parent = os.path.dirname(out)
    cache_root = os.path.dirname(os.path.dirname(os.path.abspath(manifest_path)))
    for name, root in (("analysis cache", cache_root), ("corpus", corpus)):
        r = _real(root)
        if out == r or _under(out, r):
            sys.exit("refusing to write inside the %s: %s" % (name, path))
        if r == parent or _under(r, parent):
            sys.exit("refusing: the %s is inside the output folder: %s" % (name, path))
    # git gets the real path with its case kept (normcase lowercases it on Windows).
    r = subprocess.run(["git", "-C", repo, "check-ignore", "-q", os.path.realpath(os.path.abspath(path))], capture_output=True)
    if r.returncode != 0:
        sys.exit("refusing: %s is not gitignored (ocrText can hold names)" % path)


def write_atomic(path, doc):
    """JSON to path through a temp file in the same folder and os.replace: a reader never sees a partial file,
    and a failed write leaves the old file as it was."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--session", required=True)
    ap.add_argument("--hits", action="append", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--pack", required=True, help="game pack folder or its detectors.json")
    ap.add_argument("--out")
    ap.add_argument("--corpus", help="clips corpus folder (read-only); default paths.clips_corpus from --profile")
    ap.add_argument("--profile", default=os.path.join(_REPO, "data", "profile.local.json"))
    ap.add_argument("--merge-sec", type=float, default=DEFAULTS["mergeSec"])
    ap.add_argument("--replay-before", type=float, default=DEFAULTS["replayBeforeSec"])
    ap.add_argument("--replay-after", type=float, default=DEFAULTS["replayAfterSec"])
    ap.add_argument("--match-group-sec", type=float, default=DEFAULTS["matchGroupSec"])
    a = ap.parse_args(argv)
    with open(a.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    if manifest.get("session") != a.session:
        sys.exit("manifest is for %r, not %r" % (manifest.get("session"), a.session))
    pack = game_pack.load_pack(a.pack)
    rows = []
    for path in a.hits:
        with open(path, encoding="utf-8") as f:
            rows += [json.loads(line) for line in f if line.strip()]
    doc = build(rows, manifest, pack, a.session,
                {"mergeSec": a.merge_sec, "replayBeforeSec": a.replay_before, "replayAfterSec": a.replay_after,
                 "matchGroupSec": a.match_group_sec})
    out = a.out or os.path.join(_REPO, "data", "games", pack["game"]["id"], "local", "labels-suggestions", a.session + ".json")
    corpus = a.corpus or corpus_from_profile(a.profile)
    check_out(out, a.manifest, pack["game"]["id"], corpus=corpus)
    # Checked again after the folder exists: a junction created in between is caught.
    os.makedirs(os.path.dirname(out), exist_ok=True)
    check_out(out, a.manifest, pack["game"]["id"], corpus=corpus)
    write_atomic(out, doc)
    print(json.dumps(doc["stats"]))
    print("wrote", out)


if __name__ == "__main__":
    main()
