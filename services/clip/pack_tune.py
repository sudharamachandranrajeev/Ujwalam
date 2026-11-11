# SPDX-License-Identifier: GPL-3.0-or-later
"""LL4 (D342): after a stream, propose a new game pack version from the labels in the local learning store.

Runs only after a stream (the launcher's clip queue starts it as the last, below-normal job after a live clip job, flag
`learning-train`, off by default; the queue never starts a job while a stream is live and stops one when a stream
starts). Stdlib only: no model, no GPU, no OCR (the VRAM rule: nothing is loaded, live or not).

Inputs (services/learning/store.mjs D338, services/clip/learning_capture.py D340), per session folder of
<data>/learning-store/:
  review.jsonl   the low-confidence reads queued after the stream (LL3)
  labels.jsonl   the user's answers to them (action "confirmed", source "review"), and kept / deleted / posted /
                 renamed clips and feedback rows (LL2)
  evidence.jsonl the detector hits and OCR boxes of each OCR'd live frame with hits (LL1)

Only values the pack already has are tuned; no event name, weight, window, pattern or detector is added or changed:
  W1 banner.kinds y0/y1 (detectors.json): from "unclassified-banner" answers. The word box of the item (its OCR box
      whose text is the read label) gives the word centre y; an answer "round" / "match" says which range it belongs
      in, "not a banner" that it belongs in none. A range is widened only as far as the confirmed reads of the training
      sessions need, never over a read confirmed as something else, and never into the other kind's range.
  ocr.minConfidence (game.json): from "ocr-low" answers. A read confirmed as read is a correct read, "wrong read" or a
      typed correction a wrong one. The threshold is lowered only (the review holds reads below the current value
      only, so nothing is known above it). Null today in the CODM pack, so no ocr-low read exists and nothing is tuned.
Kept / deleted / posted / renamed clips, feedback rows and unknown-mode answers are counted in the report, but no
pack value is derived from them: no row links a clip or a feedback moment to the read that made it.

Held-out test (the existing rule, P2): sessions are split by session, never by item. For each value, the newest
HELD_OUT sessions (by start) that hold labels for it are held out; the older ones train. A change is offered only when
its held-out accuracy beats the current pack's (strictly), and, for the banner ranges, when no held-out evidence banner
the current pack placed changes kind. With too few labels or sessions nothing is proposed and the report says why.

Output: a candidate <pack>/local/candidates/<id>.json (gitignored, data/games/*/local/), with the changes, the held-out
score, the evidence (counts, dates) and status "unverified", plus a changelog entry draft. A candidate never applies
itself: `approve --candidate <id>` (flag learning-train) writes it into the pack, bumps the pack version (patch) and
adds the changelog entry, only while the pack files are the ones it was made from. The run report is
<pack>/local/candidates/last-run.json (and --report, when given).

Codex review of D342: propose and approve refuse while the live clipper is asked to watch (a stream or recording),
and propose checks again between its steps and before it writes anything, so a stream that starts meanwhile stops it
with nothing written. The base hashes are of the exact bytes parsed at the start. approve is a recoverable
transaction (a redo journal): every new file (game.json, detectors.json, CHANGELOG.md, the candidate marked approved)
is written next to its target as <name>.ll4-new first, then the journal <pack>/local/candidates/approve.journal.json
lists the renames, then each is renamed into place and the journal removed. A leftover journal is finished at the next
start of any command (every .ll4-new it lists is renamed); .ll4-new files without a journal are removed (the crash came
before the journal, so nothing was renamed). The changelog is never truncated in place.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:  # run isolated (python -I), like clipper.py
    sys.path.insert(0, _HERE)

from clip_common import (  # noqa: E402
    CLIP_DATA, EXIT_FLAG_OFF, REPO_ROOT, ClipError, eprint, end_tree_when_parent_gone, flag_on, load_json,
    lower_own_priority, resolve_data_dir, worker_wanted, write_json_atomic,
)

FLAG = "learning-train"
STORE_DIR = "learning-store"
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
CANDIDATE_RE = re.compile(r"^\d{8}-\d{6}-\d+\.\d+\.\d+$")
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
NOT_A_BANNER = "not a banner"  # learning_capture.NOT_A_BANNER
WRONG_READ = "wrong read"  # learning_capture.WRONG_READ
CANDIDATES = os.path.join("local", "candidates")
LAST_RUN = "last-run.json"
TOOL_VERSION = 1

# Agent settings (D342, proposed, not tuned): how much data a proposal needs. Not pack values.
HELD_OUT = 2  # held-out sessions per value (the existing rule: at least 2)
MIN_TRAIN = 10  # labels in the training sessions
MIN_HELD_OUT = 6  # labels in the held-out sessions
MAX_FILE_BYTES = 512 * 1024 ** 2  # per store file read; the rest of a larger file is not read
DECIMALS = 3  # proposed values are rounded outward to this many decimals

_SEP = re.compile(r"[^A-Z0-9]")


def now_iso(now=None):
    return (now or datetime.now(timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z")


def norm(text):
    return _SEP.sub("", str(text or "").upper())


# ---------------------------------------------------------------- store reading

def _real(p):
    return os.path.normcase(os.path.realpath(p))


def _inside(path, root):
    return (_real(path) + os.sep).startswith(_real(root) + os.sep)


def jsonl(path, root):
    """Rows of a JSON-lines file inside the store (torn lines skipped; at most MAX_FILE_BYTES read). A file that
    resolves outside the store (a link) is not read."""
    if not os.path.isfile(path) or not _inside(path, root):
        return
    n = 0
    with open(path, "rb") as f:
        for raw in f:
            n += len(raw)
            if n > MAX_FILE_BYTES:
                return
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if isinstance(row, dict):
                yield row


def _start(d, root):
    """A session's start: session.json createdAt, else its first label row, else ''."""
    p = os.path.join(d, "session.json")
    try:
        if _inside(p, root):
            with open(p, encoding="utf-8") as f:
                v = json.load(f).get("createdAt")
            if isinstance(v, str) and v:
                return v
    except (OSError, ValueError, AttributeError):
        pass
    for row in jsonl(os.path.join(d, "labels.jsonl"), root):
        return str(row.get("at") or "")
    return ""


def store_sessions(data_dir):
    """[(name, folder, start)] of the store, oldest start first. Links and junctions are skipped."""
    root = os.path.join(os.path.abspath(data_dir), STORE_DIR)
    out = []
    try:
        names = os.listdir(root)
    except OSError:
        return root, out
    for n in names:
        d = os.path.join(root, n)
        if not SESSION_RE.match(n) or os.path.islink(d) or not os.path.isdir(d) or not _inside(d, root):
            continue
        if getattr(os.path, "isjunction", None) and os.path.isjunction(d):
            continue
        out.append((n, d, _start(d, root)))
    out.sort(key=lambda x: (x[2], x[0]))
    return root, out


def word_y(texts, label):
    """Centre y of the item's word box: the OCR box whose text is the read label (highest score), or None."""
    want = norm(label)
    best = None
    for b in texts or []:
        g = b.get("g") if isinstance(b, dict) else None
        if not want or norm(b.get("text")) != want or not isinstance(g, list) or len(g) != 4:
            continue
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in g):
            continue
        s = b.get("score") if isinstance(b.get("score"), (int, float)) else 0.0
        if best is None or s > best[0]:
            best = (s, (g[1] + g[3]) / 2)
    return None if best is None else best[1]


def read_session(name, folder, root, kinds):
    """Labels of one session: {banner: [(y, expected kind or None)], ocr: [(score, correct)], evidence: [(y, kind)],
    counts: {...}}. kinds: the pack's W1 banner kind names."""
    items = {}
    for r in jsonl(os.path.join(folder, "review.jsonl"), root):
        if isinstance(r.get("id"), str) and r["id"] not in items:
            items[r["id"]] = r
    answers, counts = {}, {}
    for r in jsonl(os.path.join(folder, "labels.jsonl"), root):
        a = r.get("action")
        if not isinstance(a, str):
            continue
        counts[a] = counts.get(a, 0) + 1
        ref = r.get("ref") if isinstance(r.get("ref"), dict) else {}
        if a == "confirmed" and r.get("source") == "review" and isinstance(ref.get("item"), str):
            answers[ref["item"]] = ref  # the newest answer counts
    banner, ocr, unused = [], [], {}
    for item_id, ref in answers.items():
        it = items.get(item_id)
        v = ref.get("value")
        if not it or not isinstance(v, str):
            unused["no-item"] = unused.get("no-item", 0) + 1
            continue
        kind = it.get("kind")
        if kind == "unclassified-banner":
            y = word_y(it.get("texts"), it.get("label"))
            if y is None or (v not in kinds and v != NOT_A_BANNER):
                unused["banner-no-box"] = unused.get("banner-no-box", 0) + 1
                continue
            banner.append((y, v if v in kinds else None))
        elif kind == "ocr-low":
            s = it.get("ocrScore")
            if not isinstance(s, (int, float)) or isinstance(s, bool):
                unused["ocr-no-score"] = unused.get("ocr-no-score", 0) + 1
                continue
            ok = v == it.get("value") and v != WRONG_READ and not ref.get("corrected")
            ocr.append((float(s), bool(ok)))
        else:
            unused[str(kind)] = unused.get(str(kind), 0) + 1
    evidence = []
    for r in jsonl(os.path.join(folder, "evidence.jsonl"), root):
        for h in r.get("hits") or []:
            if isinstance(h, dict) and h.get("detector") == "W1" and h.get("signal") and h.get("banner") in kinds:
                y = word_y(r.get("texts"), h.get("label"))
                if y is not None:
                    evidence.append((y, h["banner"]))
    counts["unusedAnswers"] = unused
    return {"session": name, "banner": banner, "ocr": ocr, "evidence": evidence, "counts": counts}


# ---------------------------------------------------------------- scoring

def classify(y, kinds):
    """match_gate.banner_kind on a centre y."""
    for k in kinds:
        if float(k["y0"]) <= y <= float(k["y1"]):
            return k["kind"]
    return None


def banner_accuracy(rows, kinds):
    return sum(1 for y, want in rows if classify(y, kinds) == want) / len(rows) if rows else None


def ocr_accuracy(rows, t):
    """A read is taken as right when its score is at or above t (None: no threshold, every read taken as right)."""
    if not rows:
        return None
    return sum(1 for s, ok in rows if (t is None or s >= t) == ok) / len(rows)


def split(per_session, key):
    """(train sessions, held-out sessions) for one value: sessions with labels for it, the newest HELD_OUT held out."""
    have = [s for s in per_session if s[key]]
    return have[:-HELD_OUT] if len(have) > HELD_OUT else [], have[-HELD_OUT:]


def _floor(v):
    return math.floor(v * 10 ** DECIMALS) / 10 ** DECIMALS


def _ceil(v):
    return math.ceil(v * 10 ** DECIMALS) / 10 ** DECIMALS


def tune_banner(train, kinds):
    """Proposed kinds (deep copy) from training rows, or (None, reason)."""
    out = copy.deepcopy(kinds)
    for k in out:
        ys = [y for y, want in train if want == k["kind"]]
        if not ys:
            continue
        lo = max(0.0, min(float(k["y0"]), _floor(min(ys))))
        hi = min(1.0, max(float(k["y1"]), _ceil(max(ys))))
        if any(lo <= y <= hi and want != k["kind"] for y, want in train):
            continue  # a read confirmed as another kind (or no banner) lies in the way: this range stays
        k["y0"], k["y1"] = lo, hi
    spans = sorted((float(k["y0"]), float(k["y1"])) for k in out)
    if any(a[1] >= b[0] for a, b in zip(spans, spans[1:])):
        return None, "the widened ranges would overlap"
    if [(k["y0"], k["y1"]) for k in out] == [(k["y0"], k["y1"]) for k in kinds]:
        return None, "the confirmed reads need no change of the ranges"
    return out, None


def tune_ocr(train, current):
    """Proposed ocr.minConfidence (lower than current) from training rows, or (None, reason)."""
    if not any(ok for _, ok in train) or all(ok for _, ok in train):
        return None, "the training reads are all right or all wrong"
    scores = sorted({s for s, _ in train})
    cands = [_ceil((a + b) / 2) for a, b in zip(scores, scores[1:])] + [_ceil(scores[0]), _ceil(scores[-1] + 1e-9)]
    cands = sorted({c for c in cands if 0 < c < current})
    if not cands:
        return None, "no lower threshold fits the training reads"
    best = max(cands, key=lambda c: (ocr_accuracy(train, c), c))  # ties: the highest (queues the most for review)
    if ocr_accuracy(train, best) <= ocr_accuracy(train, current):
        return None, "no lower threshold reads the training reads better"
    return best, None


def _dates(sessions):
    return sorted({s["start"][:10] for s in sessions if s.get("start")})


def evaluate_value(per_session, key, tune, score, current, label, enough=None):
    """One pack value: split, tune, score. Returns {value, status, reason?, proposed?, score?, evidence}."""
    train, held = split(per_session, key)
    n_train = sum(len(s[key]) for s in train)
    n_held = sum(len(s[key]) for s in held)
    ev = {"trainSessions": len(train), "heldOutSessions": len(held), "trainLabels": n_train, "heldOutLabels": n_held,
          "trainDates": _dates(train), "heldOutDates": _dates(held)}
    res = {"value": label, "current": current, "evidence": ev}
    if len(held) < HELD_OUT or not train:
        return {**res, "status": "insufficient",
                "reason": f"labels in {len(train) + len(held)} session(s); {HELD_OUT + 1} or more are needed "
                          f"({HELD_OUT} held out, at least 1 to train)"}
    if n_train < MIN_TRAIN or n_held < MIN_HELD_OUT:
        return {**res, "status": "insufficient",
                "reason": f"{n_train} training and {n_held} held-out label(s); at least {MIN_TRAIN} and {MIN_HELD_OUT} "
                          "are needed"}
    if enough:
        why = enough(train, held)
        if why:
            return {**res, "status": "insufficient", "reason": why}
    rows_train = [r for s in train for r in s[key]]
    rows_held = [r for s in held for r in s[key]]
    proposed, why = tune(rows_train, current)
    if proposed is None:
        return {**res, "status": "no-change", "reason": why}
    cur_score, new_score = score(rows_held, current), score(rows_held, proposed)
    res.update(proposed=proposed, score={"metric": "held-out accuracy", "current": round(cur_score, 4),
                                         "proposed": round(new_score, 4)})
    if new_score <= cur_score:
        return {**res, "status": "not-better", "reason": "it does not beat the current pack on the held-out sessions"}
    return {**res, "status": "beats"}


# ---------------------------------------------------------------- pack files

def pack_paths(game=None, pack_dir=None):
    """(game id, pack folder) from data/clip/detector-pass.json (defaultGame, games.<id>.pack), or the given folder."""
    if pack_dir:
        gid = load_json(os.path.join(pack_dir, "game.json")).get("id")
        return gid, os.path.abspath(pack_dir)
    doc = load_json(os.path.join(CLIP_DATA, "detector-pass.json"))
    gid = game or doc.get("defaultGame")
    p = ((doc.get("games") or {}).get(gid) or {}).get("pack")
    if not isinstance(p, str) or not p:
        raise ClipError(f"no game pack for game {gid!r}")
    return gid, os.path.normpath(os.path.join(REPO_ROOT, p))


def read_pack(pack_dir):
    """(game, detectors, W1, hashes): each file is read once; the hashes are of the bytes parsed."""
    docs, hashes = {}, {}
    for name in ("game.json", "detectors.json"):
        try:
            with open(os.path.join(pack_dir, name), "rb") as f:
                raw = f.read()
            docs[name] = json.loads(raw)
        except FileNotFoundError:
            raise ClipError(f"missing file: {name}") from None
        except ValueError:
            raise ClipError(f"not valid JSON: {name}") from None
        hashes[name] = hashlib.sha256(raw).hexdigest()
    game, det = docs["game.json"], docs["detectors.json"]
    w1 = next((d for d in det.get("detectors", []) if d.get("id") == "W1"), None) or {}
    return game, det, w1, hashes


class StreamStarted(ClipError):
    """A stream or recording started while the job ran; it stopped with nothing written."""


def _check(live, step):
    if live and live():
        raise StreamStarted(f"a stream or recording is being watched ({step}); the tuning runs after it, nothing written")


def bump(version):
    m = VERSION_RE.match(str(version or ""))
    if not m:
        raise ClipError(f"pack version {version!r} is not x.y.z")
    return f"{m.group(1)}.{m.group(2)}.{int(m.group(3)) + 1}"


def candidates_dir(pack_dir):
    return os.path.join(pack_dir, CANDIDATES)


# ---------------------------------------------------------------- propose

def propose(data_dir, pack_dir, game_id, now=None, live=None):
    """Reads the store, tunes and scores each value, writes a candidate when one beats the current pack. Returns the
    run report (also written to <pack>/local/candidates/last-run.json). live() -> True when a stream or recording is
    watched: checked between the steps and before any write (StreamStarted, nothing written)."""
    now = now or datetime.now(timezone.utc)
    _check(live, "before reading the pack")
    game, det, w1, hashes = read_pack(pack_dir)
    kinds = [k for k in ((w1.get("banner") or {}).get("kinds") or [])
             if isinstance(k.get("kind"), str) and isinstance(k.get("y0"), (int, float))
             and isinstance(k.get("y1"), (int, float))]
    names = [k["kind"] for k in kinds]
    root, sessions = store_sessions(data_dir)
    per = []
    for name, folder, start in sessions:
        s = read_session(name, folder, root, names)
        s["start"] = start
        per.append(s)
        _check(live, "reading the learning store")
    totals = {}
    for s in per:
        for k, v in s["counts"].items():
            if isinstance(v, int):
                totals[k] = totals.get(k, 0) + v
    report = {"v": TOOL_VERSION, "at": now_iso(now), "game": game_id, "packVersion": det.get("version"),
              "sessions": len(per), "labelCounts": totals,
              "settings": {"heldOut": HELD_OUT, "minTrain": MIN_TRAIN, "minHeldOut": MIN_HELD_OUT},
              "values": [], "candidate": None}

    # W1 banner kinds
    if kinds:
        def score_b(rows, ks):
            return banner_accuracy(rows, ks)

        r = evaluate_value(per, "banner", tune_banner, score_b, kinds, "detectors.json W1 banner.kinds")
        if r["status"] == "beats":
            held = split(per, "banner")[1]
            ev = [e for s in held for e in s["evidence"]]
            moved = sum(1 for y, k in ev if classify(y, r["proposed"]) != k)
            r["evidence"]["heldOutEvidenceBanners"] = len(ev)
            r["evidence"]["heldOutEvidenceChanged"] = moved
            if moved:
                r.update(status="not-better", reason=f"{moved} held-out banner(s) the current pack placed would change kind")
        report["values"].append(r)
    else:
        report["values"].append({"value": "detectors.json W1 banner.kinds", "status": "insufficient",
                                 "reason": "the pack has no W1 banner kinds"})

    # game.json ocr.minConfidence
    cur = (game.get("ocr") or {}).get("minConfidence")
    if isinstance(cur, bool) or not isinstance(cur, (int, float)) or not 0 < cur <= 1:
        report["values"].append({"value": "game.json ocr.minConfidence", "current": cur, "status": "insufficient",
                                 "reason": "the value is not set, so the review queues no OCR reads to learn from"})
    else:
        def both(train, held):
            rows = [x for s in train for x in s["ocr"]]
            if not any(ok for _, ok in rows) or all(ok for _, ok in rows):
                return "the training reads are all right or all wrong"
            return None

        report["values"].append(evaluate_value(per, "ocr", tune_ocr, ocr_accuracy, float(cur),
                                               "game.json ocr.minConfidence", both))

    wins = [v for v in report["values"] if v["status"] == "beats"]
    out_dir = candidates_dir(pack_dir)
    _check(live, "before writing")
    os.makedirs(out_dir, exist_ok=True)
    if wins:
        report["candidate"] = write_candidate(out_dir, hashes, game_id, det, wins, now)
    write_json_atomic(os.path.join(out_dir, LAST_RUN), report)
    return report


def _fmt_kinds(ks):
    return ", ".join(f"{k['kind']} y {k['y0']}-{k['y1']}" for k in ks)


def changelog_draft(new_version, wins, now, cid):
    lines = [f"## {new_version} — {now.strftime('%Y-%m-%d')} (LL4 tuning from the learning store, D342)", "",
             f"Evidence: local candidate `{cid}` (gitignored, `local/candidates/`): the held-out score and counts below. "
             "Method: `docs/evidence/2026-11-11-ll4-after-stream-train.md`.", ""]
    for w in wins:
        e = w["evidence"]
        if w["value"].endswith("banner.kinds"):
            what = f"W1 `banner.kinds` {_fmt_kinds(w['current'])} -> {_fmt_kinds(w['proposed'])}"
        else:
            what = f"`ocr.minConfidence` {w['current']} -> {w['proposed']}"
        lines.append(f"- {what} (status unverified): from {e['trainLabels']} confirmed reads of {e['trainSessions']} "
                     f"stream(s) ({', '.join(e['trainDates']) or 'no date'}); held-out accuracy "
                     f"{w['score']['current']} -> {w['score']['proposed']} on {e['heldOutLabels']} reads of "
                     f"{e['heldOutSessions']} held-out stream(s) ({', '.join(e['heldOutDates']) or 'no date'}).")
    lines += ["- No detector, pattern, event name, weight or window changed.", ""]
    return "\n".join(lines)


def write_candidate(out_dir, hashes, game_id, det, wins, now):
    new_version = bump(det.get("version"))
    cid = f"{now.strftime('%Y%m%d-%H%M%S')}-{new_version}"
    changes = []
    for w in wins:
        if w["value"].endswith("banner.kinds"):
            changes.append({"file": "detectors.json", "path": "detectors[W1].banner.kinds",
                            "from": [{"kind": k["kind"], "y0": k["y0"], "y1": k["y1"]} for k in w["current"]],
                            "to": [{"kind": k["kind"], "y0": k["y0"], "y1": k["y1"]} for k in w["proposed"]]})
        else:
            changes.append({"file": "game.json", "path": "ocr.minConfidence", "from": w["current"], "to": w["proposed"]})
    cand = {"v": TOOL_VERSION, "id": cid, "createdAt": now_iso(now), "game": game_id, "status": "unverified",
            "state": "proposed", "baseVersion": det.get("version"), "version": new_version,
            "baseHashes": dict(hashes),  # of the bytes parsed at the start of propose (Codex review)
            "changes": changes, "values": wins,
            "changelogDraft": changelog_draft(new_version, wins, now, cid)}
    write_json_atomic(os.path.join(out_dir, f"{cid}.json"), cand)
    return {"id": cid, "version": new_version, "file": os.path.join(CANDIDATES, f"{cid}.json").replace(os.sep, "/")}


# ---------------------------------------------------------------- list / approve

def list_candidates(pack_dir):
    d = candidates_dir(pack_dir)
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    for n in names:
        if n.endswith(".json") and CANDIDATE_RE.match(n[:-5]):
            try:
                c = load_json(os.path.join(d, n))
            except ClipError:
                continue
            out.append({"id": c.get("id"), "state": c.get("state"), "version": c.get("version"),
                        "baseVersion": c.get("baseVersion"), "changes": [x.get("path") for x in c.get("changes", [])]})
    return out


def _apply_note(note, text):
    return f"{note} {text}".strip() if isinstance(note, str) else text


JOURNAL = "approve.journal.json"
NEW = ".ll4-new"
TX_FILES = ("game.json", "detectors.json", "CHANGELOG.md")


def _write_new(path, data):
    """Writes bytes to a new file and flushes it to disk."""
    with open(path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def _json_bytes(obj):
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def recover(pack_dir):
    """Finishes a leftover approve journal (renames every .ll4-new it lists that is still there, then removes it) and
    removes .ll4-new files a crash before the journal left. Returns the finished candidate id, or None."""
    cdir = candidates_dir(pack_dir)
    jpath = os.path.join(cdir, JOURNAL)
    done = None
    if os.path.isfile(jpath):
        try:
            with open(jpath, encoding="utf-8") as f:
                j = json.load(f)
        except (OSError, ValueError):
            j = None  # torn journal: it was being written, so no rename had started
        if isinstance(j, dict) and isinstance(j.get("renames"), list):
            allowed = {os.path.normcase(os.path.join(pack_dir, n)) for n in TX_FILES}
            for name in j["renames"]:
                dst = os.path.join(pack_dir, name) if name in TX_FILES else os.path.join(cdir, os.path.basename(str(name)))
                if os.path.normcase(dst) not in allowed and not CANDIDATE_RE.match(os.path.basename(dst)[:-5]):
                    continue
                if os.path.isfile(dst + NEW):
                    os.replace(dst + NEW, dst)
            done = j.get("candidate")
        os.remove(jpath)
    for d in (pack_dir, cdir):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for n in names:
            if n.endswith(NEW):
                os.remove(os.path.join(d, n))
    return done


def approve(pack_dir, cid, now=None, live=None):
    """Writes an approved candidate into the pack as one recoverable transaction. Refuses a stale candidate (pack
    files changed since) and refuses while a stream or recording is watched (live())."""
    now = now or datetime.now(timezone.utc)
    if not isinstance(cid, str) or not CANDIDATE_RE.match(cid):
        raise ClipError("bad candidate id")
    _check(live, "before approving")
    finished = recover(pack_dir)
    path = os.path.join(candidates_dir(pack_dir), f"{cid}.json")
    if not os.path.isfile(path):
        raise ClipError(f"no candidate {cid}")
    cand = load_json(path)
    if finished == cid and cand.get("state") == "approved":
        return cand  # a retry after a crash: the journal finished it
    if cand.get("state") != "proposed":
        raise ClipError(f"candidate {cid} is {cand.get('state')}, not proposed")
    game, det, w1, hashes = read_pack(pack_dir)  # the stale check is on the bytes parsed here
    base = cand.get("baseHashes") or {}
    for f in ("game.json", "detectors.json"):
        if base.get(f) != hashes[f]:
            raise ClipError(f"the pack changed since candidate {cid} was made ({f}); run the tuning again")
    if det.get("version") != cand.get("baseVersion"):
        raise ClipError("the pack version changed since the candidate was made")
    day = now.strftime("%Y-%m-%d")
    for ch in cand.get("changes", []):
        if ch.get("path") == "ocr.minConfidence":
            v = ch.get("to")
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v <= 1:
                raise ClipError("bad ocr.minConfidence in the candidate")
            game["ocr"]["minConfidence"] = v
        elif ch.get("path") == "detectors[W1].banner.kinds":
            to = {k.get("kind"): k for k in ch.get("to") or []}
            for k in (w1.get("banner") or {}).get("kinds") or []:
                t = to.get(k.get("kind"))
                if not t or (t["y0"], t["y1"]) == (k["y0"], k["y1"]):
                    continue
                if not (0 <= t["y0"] < t["y1"] <= 1):
                    raise ClipError("bad banner range in the candidate")
                k["note"] = _apply_note(k.get("note"), f"LL4 (D342, approved {day}): y {k['y0']}-{k['y1']} -> "
                                                       f"{t['y0']}-{t['y1']} from confirmed reads, candidate {cid}.")
                k["y0"], k["y1"] = t["y0"], t["y1"]
                k["status"] = "unverified"
        else:
            raise ClipError(f"unknown change {ch.get('path')!r} in the candidate")
    det["version"] = cand["version"]
    cl = os.path.join(pack_dir, "CHANGELOG.md")
    try:
        with open(cl, encoding="utf-8", newline="") as f:
            text = f.read()
    except OSError:
        text = "# Pack changelog\n\n"
    i = text.find("\n## ")
    entry = cand.get("changelogDraft") or ""
    text = text[:i + 1] + entry + "\n" + text[i + 1:] if i >= 0 else text.rstrip("\n") + "\n\n" + entry
    cand.update(state="approved", approvedAt=now_iso(now))
    # 1. every new file next to its target; 2. the journal; 3. the renames (the candidate last); 4. no journal.
    new = [(os.path.join(pack_dir, "game.json"), _json_bytes(game)),
           (os.path.join(pack_dir, "detectors.json"), _json_bytes(det)),
           (cl, text.encode("utf-8")),
           (path, _json_bytes(cand))]
    for dst, data in new:
        _write_new(dst + NEW, data)
    _check(live, "before renaming")
    jpath = os.path.join(candidates_dir(pack_dir), JOURNAL)
    _write_new(jpath + NEW, _json_bytes({"v": 1, "candidate": cid, "at": now_iso(now),
                                         "renames": [*TX_FILES, os.path.basename(path)]}))
    os.replace(jpath + NEW, jpath)
    for dst, _ in new:
        os.replace(dst + NEW, dst)
    os.remove(jpath)
    return cand


# ---------------------------------------------------------------- CLI

def build_parser():
    p = argparse.ArgumentParser(prog="pack_tune.py", description=__doc__.split("\n")[0])
    p.add_argument("--data-dir")
    p.add_argument("--game")
    p.add_argument("--pack-dir", help="the pack folder (tests); default: data/clip/detector-pass.json")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("propose")
    s.add_argument("--report", help="also write the run report here")
    sub.add_parser("list")
    s = sub.add_parser("approve")
    s.add_argument("--candidate", required=True)
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        data_dir = resolve_data_dir(a.data_dir)
        if not data_dir:
            raise ClipError("no data folder (pass --data-dir)")
        if not flag_on(data_dir, FLAG):
            eprint(f"pack_tune: the flag {FLAG} is off")
            return EXIT_FLAG_OFF
        lower_own_priority()
        end_tree_when_parent_gone()  # started by Ujwalam: ends with it
        gid, pack_dir = pack_paths(a.game, a.pack_dir)

        def live():
            return worker_wanted(data_dir)

        if live():
            raise ClipError("a stream or recording is being watched; the tuning runs after it")
        if a.cmd != "approve" and os.path.isdir(candidates_dir(pack_dir)):
            recover(pack_dir)  # a leftover approve is finished first (approve does this itself)
        if a.cmd == "propose":
            rep = propose(data_dir, pack_dir, gid, live=live)
            if a.report:
                os.makedirs(os.path.dirname(os.path.abspath(a.report)), exist_ok=True)
                write_json_atomic(a.report, rep)
            print(json.dumps({"candidate": rep["candidate"], "values": [
                {"value": v["value"], "status": v["status"], "reason": v.get("reason")} for v in rep["values"]]}))
        elif a.cmd == "list":
            print(json.dumps(list_candidates(pack_dir), indent=2))
        else:
            c = approve(pack_dir, a.candidate, live=live)
            print(json.dumps({"approved": c["id"], "version": c["version"]}))
        return 0
    except ClipError as e:
        eprint(f"pack_tune: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
