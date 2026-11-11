# SPDX-License-Identifier: GPL-3.0-or-later
"""LL1 + LL3 (D340): the clip pipeline's evidence goes into the local learning store, and low-confidence reads are
queued for an optional review after the stream.

Store: the same one LL2 writes (services/learning/store.mjs, D338): <data>/learning-store/<session>/, one folder per
stream session, gitignored and refused by the private scan (LL5), capped at 5 GB in total (whole sessions removed
oldest first by the launcher's cap pass). This module adds three files to a session folder:

  evidence.jsonl  one row per OCR'd live frame that produced detector hits:
                  {v, at, t, mode, hits: [hit rows, detector_pass.frame_hits format], texts: [{text, score, g}]}
                  `texts` are the OCR texts of that frame (local store only; they can hold player names).
  review.jsonl    one row per low-confidence read (LL3), queued for the review in My clips:
                  {v, id, at, t, kind, detector, label, mode, ocrScore, threshold, value, choices, frame, texts, ...}
                  kind: unclassified-banner (a signalled W1 VICTORY/DEFEAT word whose position fits none of the pack's
                  banner.kinds), ocr-low (a signalled hit read with an OCR score below game.json ocr.minConfidence;
                  none while that value is null), unknown-mode (a match of the stream's recording whose game mode the
                  match gate could not tell, written by `clipper.py live-review`).
  frames/<id>.jpg the frame of a review item only (no other frame is ever kept).
  session.json    {v, createdAt}, written once with the first file (the cap's age order, as store.mjs).

Thresholds come from the data files only (game.json ocr.minConfidence, the W1 banner kinds, the pack's mode names);
none is invented here. Nothing here loads a model or touches the GPU: JPEG encoding (OpenCV, CPU) of a review frame
and appends to files, on a background thread behind a small bounded queue. The live clipper never waits for it: a
full queue, a failed write or the session's share of the cap drops the item and logs one line. LiveCapture.frame()
never raises.
"""

from __future__ import annotations

import json
import os
import queue
import re
import threading
from datetime import datetime, timezone

STORE_DIR = "learning-store"
CAP_BYTES = 5 * 1024 ** 3  # the store's cap (services/learning/store.mjs CAP_BYTES, user 2026-11-10)
SESSION_META = "session.json"
EVIDENCE = "evidence.jsonl"
REVIEW = "review.jsonl"
FRAMES = "frames"
KINDS = ("unclassified-banner", "ocr-low", "unknown-mode")
NOT_A_BANNER = "not a banner"
WRONG_READ = "wrong read"
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
ITEM_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
QUEUE_MAX = 8  # items waiting for the writer thread; more are dropped (never a wait in the live loop)
JPEG_QUALITY = 85


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def session_id(raw):
    """Safe session folder name, as store.mjs sessionId ('' when nothing usable is left)."""
    s = re.sub(r"[^A-Za-z0-9._-]", "_", str(raw or ""))
    s = re.sub(r"^[._-]+", "", s)[:100]
    return s if SESSION_RE.match(s) else ""


def ocr_threshold(pack):
    """game.json ocr.minConfidence as a number in (0, 1], else None (no ocr-low item is queued)."""
    v = (pack.get("ocr") or {}).get("minConfidence")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v <= 1:
        return None
    return float(v)


def banner_kinds(pack):
    """The W1 banner kinds of the pack ("round", "match"), in pack order."""
    w1 = next((d for d in pack.get("detectors", []) if d.get("id") == "W1"), None) or {}
    return [k["kind"] for k in (w1.get("banner") or {}).get("kinds") or [] if isinstance(k.get("kind"), str)]


def mode_choices(cfg):
    """Game modes the pack names (match_gate.stats_config: S1 modeNames, C1 cues, C2 header cues, banner subtitles),
    lower case, sorted. The review offers only these."""
    out = set()
    for n in cfg.get("modeNames") or []:
        out.add((n if isinstance(n, str) else n.get("mode") or "").lower())
    for q in list(cfg.get("modeCues") or []) + list(cfg.get("headerCues") or []) + \
            list((cfg.get("banner") or {}).get("subtitles") or []):
        out.update(x.lower() for x in q.get("modes") or [] if isinstance(x, str))
    out.discard("")
    return sorted(out)


def review_reads(rows, ocr_min, kinds):
    """Low-confidence reads among one frame's hit rows -> [{key, kind, detector, label, ocrScore, threshold, value,
    choices}]. Only signalled rows (the ones that would count for a clip or a match) are looked at."""
    out = []
    for r in rows:
        if not r.get("signal"):
            continue
        d, label, score = r.get("detector"), r.get("label"), r.get("ocrScore")
        if d == "W1" and "banner" in r and r.get("banner") is None and kinds:
            out.append({"key": ("unclassified-banner", d, label), "kind": "unclassified-banner", "detector": d,
                        "label": label, "ocrScore": score, "threshold": None, "value": None,
                        "choices": list(kinds) + [NOT_A_BANNER]})
        if ocr_min is not None and isinstance(score, (int, float)) and score < ocr_min:
            out.append({"key": ("ocr-low", d, label), "kind": "ocr-low", "detector": d, "label": label,
                        "ocrScore": score, "threshold": ocr_min, "value": label,
                        "choices": [label, WRONG_READ] if isinstance(label, str) and label else [WRONG_READ]})
    return out


def _dir_bytes(d):
    n = 0
    for root, _dirs, files in os.walk(d):
        for f in files:
            try:
                n += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return n


class SessionWriter:
    """Appends to one session folder of the store. Synchronous; raises OSError / ValueError on failure.
    budget: the most bytes this session may hold (the store's cap); a write that would pass it is refused."""

    def __init__(self, data_dir, session, budget=CAP_BYTES):
        s = session_id(session)
        if not s or not data_dir:
            raise ValueError("learning store: no data folder or bad session name")
        self.dir = os.path.join(os.path.abspath(data_dir), STORE_DIR, s)
        self.session, self.budget = s, budget
        self.used = _dir_bytes(self.dir) if os.path.isdir(self.dir) else 0

    def _ensure(self):
        os.makedirs(os.path.join(self.dir, FRAMES), exist_ok=True)
        try:  # written once ('x'): the session's start, the cap's age order (store.mjs)
            with open(os.path.join(self.dir, SESSION_META), "x", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps({"v": 1, "createdAt": now_iso()}) + "\n")
        except FileExistsError:
            pass

    def _room(self, n):
        if self.used + n > self.budget:
            raise ValueError("learning store: session over the store's cap")

    def append(self, name, row):
        line = (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8")
        self._room(len(line))
        self._ensure()
        with open(os.path.join(self.dir, name), "ab") as f:
            f.write(line)
        self.used += len(line)

    def frame(self, item_id, jpeg):
        if not ITEM_RE.match(item_id):
            raise ValueError("learning store: bad item id")
        self._room(len(jpeg))
        self._ensure()
        rel = f"{FRAMES}/{item_id}.jpg"
        with open(os.path.join(self.dir, FRAMES, f"{item_id}.jpg"), "wb") as f:
            f.write(jpeg)
        self.used += len(jpeg)
        return rel

    def item_ids(self):
        """Ids already in review.jsonl (a re-run adds no duplicate)."""
        ids = set()
        try:
            with open(os.path.join(self.dir, REVIEW), encoding="utf-8") as f:
                for line in f:
                    try:
                        ids.add(json.loads(line).get("id"))
                    except ValueError:
                        pass
        except OSError:
            pass
        return ids

    def add_item(self, item, jpeg=None):
        """Writes a review item (its frame first, when given). Returns the row written."""
        row = dict(item)
        row["frame"] = self.frame(row["id"], jpeg) if jpeg else None
        self.append(REVIEW, row)
        return row


def encode_jpeg(img):
    """BGR array -> JPEG bytes (OpenCV, CPU), or None when OpenCV is missing or the encode fails."""
    try:
        import cv2
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        return bytes(buf) if ok else None
    except Exception:  # noqa: BLE001  (never fails the caller)
        return None


class LiveCapture:
    """The live worker's side (LL1 + LL3). frame() is called once per sampled frame on the live loop: it only builds
    small dicts and puts them on a bounded queue (put_nowait); a daemon thread writes. Never raises."""

    def __init__(self, data_dir, session, pack, log, budget=CAP_BYTES, max_queue=QUEUE_MAX, encode=encode_jpeg):
        self.log, self.encode = log, encode
        self.writer = SessionWriter(data_dir, session, budget)
        self.ocr_min = ocr_threshold(pack)
        self.kinds = banner_kinds(pack)
        self.q = queue.Queue(maxsize=max_queue)
        self.active = set()  # review keys on the last OCR'd frame: one item per appearance, not one per frame
        self.taken = self.writer.item_ids()  # a session folder written before (same name) keeps its items
        self.n = 0
        self.stats = {"evidence": 0, "items": 0, "dropped": 0}
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, name="learning-capture", daemon=True)
        self.thread.start()

    def _drop(self, why):
        self.stats["dropped"] += 1
        if self.stats["dropped"] == 1 or self.stats["dropped"] % 100 == 0:
            self.log(f"learning: dropped {self.stats['dropped']} item(s) ({why})")

    def frame(self, t, img, rows, boxes, mode, fresh):
        """One sampled frame: rows = its hit rows; boxes = its OCR boxes; fresh = OCR ran on it (an unchanged frame
        repeats the last one and adds nothing)."""
        try:
            if not fresh:
                return
            at = now_iso()
            texts = [{"text": str(b.get("text", ""))[:200], "score": round(float(b.get("score", 0.0)), 4),
                      "g": b.get("g")} for b in boxes or []]
            hits = [{k: v for k, v in r.items() if k != "t"} for r in rows]
            reads = review_reads(rows, self.ocr_min, self.kinds)
            keys = {r["key"] for r in reads}
            new = [r for r in reads if r["key"] not in self.active]
            self.active = keys
            if hits:
                self._put(("evidence", {"v": 1, "at": at, "t": round(float(t), 3), "mode": mode, "hits": hits,
                                        "texts": texts}, None))
            for r in new:
                self.n += 1
                while f"live-{self.n:05d}" in self.taken:
                    self.n += 1
                item = {"v": 1, "id": f"live-{self.n:05d}", "at": at, "t": round(float(t), 3), "mode": mode,
                        **{k: v for k, v in r.items() if k != "key"}, "texts": texts}
                self._put(("item", item, img))
        except Exception as e:  # noqa: BLE001  (the live clipper never fails because of learning)
            self._drop(type(e).__name__)

    def _put(self, job):
        try:
            self.q.put_nowait(job)
        except queue.Full:
            self._drop("writer busy")

    def _run(self):
        while not (self._stop.is_set() and self.q.empty()):
            try:
                kind, row, img = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                if kind == "evidence":
                    self.writer.append(EVIDENCE, row)
                    self.stats["evidence"] += 1
                else:
                    self.writer.add_item(row, self.encode(img) if img is not None else None)
                    self.stats["items"] += 1
            except Exception as e:  # noqa: BLE001
                self._drop(f"{type(e).__name__}: {str(e)[:80]}")
            finally:
                self.q.task_done()

    def close(self, timeout=5.0):
        """Writes what is queued (up to timeout) and stops the thread."""
        self._stop.set()
        self.thread.join(timeout)


def queue_unknown_modes(data_dir, session, matches, cfg, frame_of=None, log=None):
    """LL3 from `clipper.py live-review` (post-stream): one unknown-mode item per match of the stream's recording that
    showed an end screen but whose game mode the match gate could not tell (gameMode None). frame_of(match) -> JPEG
    bytes or None (one frame of the recording at the match's end screen). Returns the number of items written; any
    failure is logged and returns what was written (never raises)."""
    log = log or (lambda *_: None)
    n = 0
    try:
        choices = mode_choices(cfg)
        if not choices:
            return 0
        w = SessionWriter(data_dir, session)
        have = w.item_ids()
        for i, m in enumerate(matches, 1):
            if not m.get("endSeen") or m.get("gameMode"):
                continue
            item_id = f"mode-{i:03d}"
            if item_id in have:
                continue
            jpeg = None
            if frame_of:
                try:
                    jpeg = frame_of(m)
                except Exception:  # noqa: BLE001
                    jpeg = None
            w.add_item({"v": 1, "id": item_id, "at": now_iso(), "t": m.get("endScreenAt"), "kind": "unknown-mode",
                        "detector": None, "label": None, "mode": m.get("mode"), "ocrScore": None, "threshold": None,
                        "value": None, "choices": choices, "match": i, "matchStartUtc": m.get("startUtc"),
                        "matchEndUtc": m.get("endUtc"), "modeReason": m.get("modeReason"),
                        "modeEvidence": [{"source": e.get("source"), "text": e.get("text")}
                                         for e in m.get("modeEvidence") or []][:8],
                        "texts": []}, jpeg)
            n += 1
    except Exception as e:  # noqa: BLE001  (the clips are made either way)
        log(f"learning: review items not written ({type(e).__name__})")
    return n
