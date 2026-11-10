# SPDX-License-Identifier: GPL-3.0-or-later
"""G1 text matching helpers (P2a step A5). Stdlib only.

Pure functions used by g1_scan.py on OCR output:

  normalise(text)          upper case, separators and spaces removed
  fold(text)               normalise + common OCR confusions folded (0->O, 1->I, ...)
  ratio(a, b)              Levenshtein similarity 0..1
  partial_ratio(a, b)      best ratio of the shorter string against any window of the longer
  name_score(text, names)  best fuzzy score of a text against the profile names
  match_medal(text, medals, ignore)   exact / fuzzy medal-list match
  parse_points(text)       "+125" -> 125 (M4); None otherwise
  parse_kill_count(text)   "7 KILL(S)" -> 7 (B2); None otherwise
  group_lines(boxes)       OCR boxes -> lines (left to right) for kill-feed parsing
  killfeed_side(line, names, min_score)   "killer" / "victim" / None for one line

Names are never stored here. Callers pass them in from the gitignored profile.
"""

from __future__ import annotations

import re

_SEP = re.compile(r"[^0-9A-Z]+")
_FOLD = str.maketrans({"0": "O", "1": "I", "L": "I", "5": "S", "8": "B", "2": "Z", "6": "G", "Q": "O", "D": "O"})


def normalise(text: str) -> str:
    """Upper case and drop everything that is not A-Z or 0-9 (separators, spaces, glyphs)."""
    return _SEP.sub("", (text or "").upper())


def fold(text: str) -> str:
    """normalise() plus folding of common OCR confusions, applied to both sides of a compare."""
    return normalise(text).translate(_FOLD)


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def ratio(a: str, b: str) -> float:
    """1 - edit distance / longer length. 1.0 for two empty strings."""
    if not a and not b:
        return 1.0
    return 1.0 - levenshtein(a, b) / max(len(a), len(b))


def partial_ratio(needle: str, hay: str) -> float:
    """Best ratio of needle against windows of hay of length len(needle)-1 .. len(needle)+1.

    Used when the OCR line holds more than the name (clan tag, count, other words)."""
    if not needle or not hay:
        return 0.0
    if len(hay) <= len(needle):
        return ratio(needle, hay)
    best = 0.0
    n = len(needle)
    for w in (n - 1, n, n + 1):
        if w <= 0 or w > len(hay):
            continue
        for i in range(0, len(hay) - w + 1):
            r = ratio(needle, hay[i:i + w])
            if r > best:
                best = r
                if best == 1.0:
                    return best
    return best


def name_score(text: str, names) -> dict:
    """Best match of an OCR text against the profile names.

    Returns {"score", "exact", "index"}: index is the position in `names` that matched
    (0 = primary IGN), never the name itself. exact = the normalised name occurs verbatim.
    Compared on normalise() and on fold(); the higher score wins."""
    best = {"score": 0.0, "exact": False, "index": None}
    tn, tf = normalise(text), fold(text)
    for i, name in enumerate(names):
        nn, nf = normalise(name), fold(name)
        if not nn:
            continue
        exact = nn in tn
        s = 1.0 if exact else max(partial_ratio(nn, tn), partial_ratio(nf, tf))
        if s > best["score"] or (s == best["score"] and exact and not best["exact"]):
            best = {"score": round(s, 4), "exact": exact, "index": i}
    return best


def match_medal(text: str, medals, ignore=(), min_ratio: float = 0.8) -> dict | None:
    """Medal-list match for one OCR text. Returns {"medal", "exact", "score"} or None.

    `ignore` texts (e.g. Normal Kill) return {"medal": None, "ignored": text}. A text must
    be close to the whole medal name: partial matches inside longer text count only when
    the medal is at least 6 letters long (avoids short false hits)."""
    t = normalise(text)
    if not t:
        return None
    for ig in ignore:
        if ratio(normalise(ig), t) >= min_ratio:
            return {"medal": None, "ignored": ig, "score": round(ratio(normalise(ig), t), 4)}
    best = None
    for m in medals:
        mn = normalise(m)
        s = ratio(mn, t)
        if len(t) > len(mn) + 2 and len(mn) >= 6:
            s = max(s, partial_ratio(mn, t))
        if s >= min_ratio and (best is None or s > best["score"]):
            best = {"medal": m, "exact": mn == t, "score": round(s, 4)}
    return best


_POINTS = re.compile(r"^\+\s?(\d{1,4})$")


def parse_points(text: str):
    """M4: '+125' -> 125. Spaces inside are tolerated; anything else returns None."""
    m = _POINTS.match((text or "").strip())
    return int(m.group(1)) if m else None


_KILLS = re.compile(r"^(\d{1,2})\s*KILL(?:\(?S\)?)?$")


def parse_kill_count(text: str):
    """B2: '7 KILL(S)', '1 KILL' -> int; None otherwise."""
    m = _KILLS.match((text or "").strip().upper())
    return int(m.group(1)) if m else None


def group_lines(boxes, y_tol: float = 0.5):
    """Group OCR boxes into text lines.

    boxes: iterable of dicts with "text", "x0", "y0", "x1", "y1" (any unit).
    Two boxes share a line when their vertical centres differ by less than
    y_tol x the smaller box height. A box is compared with the first box of a line (its anchor), never with the
    last one added: comparing with the last box let a line creep down through the kill-feed rows (rows 0.026 of the
    game height apart, boxes 0.025 high, plus stray boxes between rows), so one "line" held three rows and its
    victim was another row's victim (2026-11-09 practice, 1-fps re-detect). Lines are sorted top to bottom, boxes
    left to right."""
    items = sorted(boxes, key=lambda b: (b["y0"] + b["y1"]) / 2)
    lines = []
    for b in items:
        cy = (b["y0"] + b["y1"]) / 2
        h = b["y1"] - b["y0"]
        for line in lines:
            ref = line[0]
            rcy = (ref["y0"] + ref["y1"]) / 2
            if abs(cy - rcy) < y_tol * min(h, ref["y1"] - ref["y0"]):
                line.append(b)
                break
        else:
            lines.append([b])
    return [sorted(line, key=lambda b: b["x0"]) for line in lines]


_TRAIL_COUNT = re.compile(r"\d{1,2}$")


def _single_box_side(text, names, min_score):
    """One OCR box holding a whole line (killer and victim merged): the name at the
    start means killer, at the end (a trailing kill-count digit ignored) means victim."""
    t = normalise(text)
    best = (None, 0.0)
    # only a box no longer than a name plus a short suffix can be "the name on its own"; a longer box is a merged line
    # (a long own name + a short victim name scores above min_score as a whole too: Codex review 2026-11-10)
    whole = max((ratio(normalise(n), t) for n in names if normalise(n) and len(t) < len(normalise(n)) + 3),
                default=0.0)
    if whole >= min_score:
        # the box is one of the profile names on its own (a name variant such as NAME-TTV on a name tag, whose
        # suffix would otherwise read as a victim after the base name): no line
        return None, round(whole, 4)
    for name in names:
        n = normalise(name)
        if not n or len(t) < len(n) + 3:
            continue
        head = max(ratio(n, t[:len(n) + k]) for k in (-1, 0, 1))
        tail_t = _TRAIL_COUNT.sub("", t)
        tail = max(ratio(n, tail_t[-(len(n) + k):]) for k in (-1, 0, 1))
        for side, sc in (("killer", head), ("victim", tail)):
            if sc > best[1]:
                best = (side, sc)
    if best[1] >= min_score:
        return best[0], round(best[1], 4)
    return None, round(max(best[1], name_score(text, names)["score"]), 4)


def victim_text(line, names, min_score: float = 0.8):
    """The victim side of an own kill-feed line (killer side = the profile name): the right-most box that can be a
    name, or, when none is left, the normalised text after the name at the start of the first box (one box holding
    the whole line). Boxes that cannot be the victim are skipped: under 3 characters or digits only (a kill count or
    icon read as '2', '4') and the profile name itself (a second row merged into the line). Each of these gave a
    one-frame key that looked like another victim (2026-11-09 practice, Control match: 5 kills counted for 3 lines).
    A merged box keyed by its last 8 characters kept part of the own name in the key ('NAMETAIL' + a short victim),
    so the next frame's two-box read of the same line looked like another victim too."""
    if not line:
        return ""
    for b in reversed(line[1:]):
        t = normalise(b["text"])
        if len(t) >= 3 and not t.isdigit() and name_score(b["text"], names)["score"] < min_score:
            return b["text"]
    t = normalise(line[0]["text"])
    best, cut = 0.0, 0
    for name in names:
        n = normalise(name)
        for k in (-1, 0, 1):
            m = len(n) + k
            if 0 < m <= len(t) and ratio(n, t[:m]) > best:
                best, cut = ratio(n, t[:m]), m
    return t[cut:]


def killfeed_side(line, names, min_score: float):
    """Which side of a kill-feed line the name is on.

    The killer is the left-most text, the victim the right-most (weapon and kill icons
    are not text). Returns ("killer"|"victim"|None, score). When OCR returns the whole
    line as one box, the name's position in the text decides (see _single_box_side);
    a single box that holds only a name returns (None, score)."""
    if not line:
        return None, 0.0
    if len(line) == 1:
        return _single_box_side(line[0]["text"], names, min_score)
    # The left-most box can itself hold the whole line (ROI-band OCR merges killer, icon gap and victim into one
    # box and may add the victim again as a second box; 2026-11-09 practice, 1-fps re-detect): the name at the end
    # of that box, after other text, is the victim side. Without this, every own death read as an own kill.
    side, sc = _single_box_side(line[0]["text"], names, min_score)
    if side == "victim":
        return side, sc
    left = name_score(line[0]["text"], names)["score"]
    right = max(name_score(b["text"], names)["score"] for b in line[1:])
    if left >= min_score and left >= right:
        return "killer", left
    if right >= min_score:
        return "victim", right
    return None, max(left, right)
